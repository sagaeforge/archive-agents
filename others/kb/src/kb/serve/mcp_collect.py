"""kb-mcp --profile collector: 수집 에이전트용 도구 8개(WP-12, ADR 15.1, ADR-0003 3장).

kb_fetch, kb_source, kb_get, kb_ingest_validate, kb_ingest_submit, kb_search, kb_ticket_list, kb_ticket_close.
읽기 도구(kb_search, kb_get, kb_source)는 공개 범위만 돌려준다: origin=external, sensitivity=public(0)으로 고정이다.
이 도구의 결과가 Claude로 가기 때문이다. 고정 값은 이 모듈의 상수(PUBLIC_KW)이고 인자, 환경 변수로 풀 수 없다.
first_party 레코드와 sensitivity 1 이상 레코드는 없는 것과 같게 응답한다(숨긴 레코드는 404, 검색 결과에서 빠짐).
이 모듈은 `from __future__ import annotations`를 쓰지 않는다(도구 서명을 pydantic이 그대로 읽는다).
"""
import json
import time

from mcp.server.mcpserver.exceptions import ToolError

from kb.serve import mcp as core

PUBLIC_KW = {"max_sensitivity": "public", "origin": "external"}
DEFAULT_BUDGET = {"kb_search": 900, "kb_get": 1500, "kb_source": 1500, "kb_fetch": 200, "kb_ingest_validate": 1500,
                  "kb_ingest_submit": 1500, "kb_ticket_list": 900, "kb_ticket_close": 60}


def public_ctx(**filters):
    """수집 프로필의 읽기 문맥. 민감도와 origin은 호출자가 줄 수 없다."""
    from kb import read
    filters = {k: v for k, v in filters.items() if k not in PUBLIC_KW}
    return read.ReadCtx.build(**PUBLIC_KW, **filters)


def _bud(tool: str, budget) -> int:
    if budget is None:
        return DEFAULT_BUDGET[tool]
    return core._clamp(budget, 40, core.MAX_BUDGET, "budget")


def _report_text(rep, budget: int) -> str:
    s = rep.summary()
    lines = [core.one_line("#ingest", *[f"{k}={s[k]}" for k in ("accepted", "needs_review", "held", "rejected", "new_events", "replayed")],
                           f"batch={s['batch_id']}")]
    for r in rep.lines:
        lines.append(core.one_line(r["line"], r.get("ref") or "", r["result"], r.get("code") or "", r.get("detail") or ""))
    return core.fit_lines(lines, budget, "항목을 나누어 다시 호출한다")


def _bundle(bundle):
    from kb import ingest
    if not isinstance(bundle, list) or not bundle:
        raise ToolError("bad_param: bundle은 첫 객체가 item=bundle 머리인 객체 배열. 다음 행동: 계약 kb-ingest/1 형식으로 다시 낸다.")
    try:
        ingest.check_call_limit(bundle)
        return ingest.from_objects(bundle)
    except ingest.ContractError as e:
        raise ToolError(f"contract: {str(e)[:200]}. 다음 행동: 묶음을 고치거나 {ingest.MAX_CALL_ITEMS}항목 이하로 나눈다.") from None


def register(mcp) -> None:
    tracked = core.tracked

    @mcp.tool(structured_output=False)
    @tracked
    def kb_fetch(url: str, source: str = "src:adhoc") -> str:
        """URL 하나를 수집 층(거부 호스트, robots, 서킷 적용)으로 받아 스냅샷을 만든다. 본문은 kb_source로 읽는다."""
        t0 = time.monotonic()
        from kb.collect import capturer, registry
        from kb.collect.errors import CollectError
        try:
            src = registry.get_source(source)
            if src is None:
                raise ToolError(f"E_POLICY: 등록되지 않은 소스 {source}. 다음 행동: src:adhoc로 받는다.")
            ref = capturer.capture(src, url, conditional=src.id != registry.ADHOC_ID)
        except CollectError as e:
            raise ToolError(f"{e.code}: {str(e)[:200]}. 다음 행동: 다른 출처를 고른다.") from None
        if not ref.ok:
            raise ToolError(f"{ref.code}: {ref.outcome} {ref.error or ''}. 다음 행동: 다른 출처를 고르거나 kb_ticket_close로 닫는다.")
        text = core.one_line(ref.snapshot or "", ref.outcome, ref.status or "", ref.bytes or "", ref.content_type or "", ref.url)
        core.log_query("kb_fetch", text, t0)
        return text

    @mcp.tool(structured_output=False)
    @tracked
    def kb_source(id: str, start: int | None = None, max_chars: int | None = None, budget: int | None = None) -> str:
        """스냅샷 id(또는 주장 id의 첫 근거)의 표시 본문 일부를 읽는다. 공개 범위만 읽힌다."""
        t0 = time.monotonic()
        text = core.source_text(public_ctx(), id, start, max_chars, _bud("kb_source", budget), external=True)
        core.log_query("kb_source", text, t0)
        return text

    @mcp.tool(structured_output=False)
    @tracked
    def kb_get(ids: str | list[str] | None = None, name: str | None = None, view: str = "quote", budget: int | None = None) -> str:
        """id(최대 10개) 또는 이름으로 공개 노드를 읽는다. view는 quote 또는 full. 공개 범위만 읽힌다."""
        t0 = time.monotonic()
        if view not in ("quote", "full"):
            raise ToolError("bad_param: 이 프로필의 view는 quote 또는 full. 다음 행동: 값을 고쳐 다시 호출한다.")
        text, n = core.get_text(public_ctx(), ids, name, view, _bud("kb_get", budget), external=True)
        core.log_query("kb_get", text, t0, cards=n)
        return text

    @mcp.tool(structured_output=False)
    @tracked
    def kb_search(q: str | list[str], k: int | None = None, budget: int | None = None, domain: str | None = None,
                  type: str | None = None, cursor: str | None = None) -> str:
        """공개 범위의 출처 붙은 사실 카드를 찾는다. 한영 표현을 배열로 주면 둘 다 찾는다."""
        t0 = time.monotonic()
        text, n, route = core.search_cards(public_ctx(domain=domain, types=type), q, k, _bud("kb_search", budget), cursor)
        core.log_query("kb_search", text, t0, cards=n, route=route, zero=(n == 0))
        return text

    @mcp.tool(structured_output=False)
    @tracked
    def kb_ingest_validate(bundle: list[dict], fetch: bool = True) -> str:
        """kb-ingest/1 묶음(첫 객체는 item=bundle 머리, 최대 100항목)을 게이트로 검증한다. 쓰지 않는다. record 항목은 거부된다."""
        t0 = time.monotonic()
        from kb import ingest
        rep = ingest.validate(_bundle(bundle), fetch=bool(fetch), profile="collector")
        text = _report_text(rep, DEFAULT_BUDGET["kb_ingest_validate"])
        core.log_query("kb_ingest_validate", text, t0)
        return text

    @mcp.tool(structured_output=False)
    @tracked
    def kb_ingest_submit(bundle: list[dict], fetch: bool = True) -> str:
        """kb-ingest/1 묶음을 게이트를 지나 적재한다. 같은 묶음을 다시 내도 새 이벤트가 0건이다. record 항목은 거부된다."""
        t0 = time.monotonic()
        from kb import ingest
        rep = ingest.submit(_bundle(bundle), fetch=bool(fetch), profile="collector")
        text = _report_text(rep, DEFAULT_BUDGET["kb_ingest_submit"])
        core.log_query("kb_ingest_submit", text, t0)
        return text

    @mcp.tool(structured_output=False)
    @tracked
    def kb_ticket_list(status: str | None = None, cursor: str | None = None, limit: int | None = None) -> str:
        """요청 티켓 목록(id 오름차순). status는 queued, in_progress, done, unanswerable, blocked_policy."""
        t0 = time.monotonic()
        from kb import ticket
        r = ticket.list_tickets(status, cursor, limit if limit is not None else 25)
        lines = [core.one_line(t["id"], t["status"], t["priority"], t["topic"]) for t in r["items"]]
        if r["next_cursor"]:
            lines.append(core.one_line("cur", r["next_cursor"]))
        text = core.fit_lines(lines, DEFAULT_BUDGET["kb_ticket_list"], "limit을 줄이거나 cursor로 잇는다")
        core.log_query("kb_ticket_list", text, t0)
        return text

    @mcp.tool(structured_output=False)
    @tracked
    def kb_ticket_close(id: str, status: str, note: str | None = None) -> str:
        """티켓을 닫는다. status는 done, unanswerable, blocked_policy."""
        t0 = time.monotonic()
        from kb import ticket
        text = json.dumps(ticket.close_ticket(id, status, note, transport="mcp"), ensure_ascii=False, separators=(",", ":"))
        core.log_query("kb_ticket_close", text, t0)
        return text
