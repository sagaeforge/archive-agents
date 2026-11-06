"""수확 본문의 공개 URL을 재확인 티켓으로 넘긴다. 세션 서술은 사실이 아니므로 URL만 가고, 사실 확인은 수집 경로가 한다.

kb intake와 같은 방식이다: 후보 거름(_candidates), 열린 티켓 사본(Book)과 병합 판정, kb.ticket.open_ticket.
여기서 더한 것은 두 가지다.
- 한 번이라도 티켓에 올랐던 URL(닫힌 티켓 포함)은 다시 올리지 않는다. 수확은 매시간 돌기 때문이다.
- 실행당, 원본당 URL 상한. 넘은 URL은 버리지 않고 센다(다음 실행이 잇는다).
이 모듈은 네트워크를 쓰지 않는다.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlsplit

from kb.harvest.config import Config
from kb.intake import core as _ic
from kb.intake import urls as _urls

TOPIC_PREFIX = "세션 수확 출처 재확인: "
# 질의 문자열에 @나 %40이 든 URL은 이메일 같은 개인 정보를 실을 수 있다. 티켓에 오른 URL은 나중에 수집기가 요청하므로
# 외부 요청에 개인 정보를 넣지 않는다는 규칙에 따라 올리지 않는다. 경로의 @(npm @scope/pkg)는 괜찮다
_PII_QUERY = re.compile(r"@|%40", re.I)


def _personal_query(u: str) -> bool:
    try:
        return bool(_PII_QUERY.search(urlsplit(u).query))
    except ValueError:
        return True


@dataclass
class UrlStats:
    extracted: int = 0       # 정규화 뒤 중복을 없앤 https URL(전체 원본 기준)
    skipped: int = 0         # 내부 주소, userinfo, 비밀 쿼리, 활성 소스 URL, 차단 목록
    denied: int = 0          # host_allowed가 거부한 호스트
    known: int = 0           # 이미 티켓에 올랐던 URL
    capped_source: int = 0   # 원본당 상한
    capped_run: int = 0      # 실행당 상한
    capped_ticket: int = 0   # 티켓당 URL 상한(kb.ticket.MAX_URLS)
    registered: int = 0      # 이번에 티켓에 올렸거나 올릴 URL
    errors: int = 0
    tickets: int = 0
    new_events: int = 0
    aborted: str | None = None   # 티켓 이력을 못 읽어 이번 실행은 URL을 올리지 않았다(예외 이름)

    def as_dict(self) -> dict:
        d = {"extracted": self.extracted, "registered": self.registered, "skipped": self.skipped,
             "denied": self.denied, "known": self.known,
             "capped": self.capped_source + self.capped_run + self.capped_ticket,
             "capped_source": self.capped_source, "capped_run": self.capped_run,
             "capped_ticket": self.capped_ticket, "errors": self.errors}
        if self.aborted:
            d["aborted"] = self.aborted
        return d


def ticketed_urls() -> set[str]:
    """티켓에 한 번이라도 오른 URL의 정규형(열린 것과 닫힌 것 모두). gold의 Ticket 노드를 읽는다. 읽기 전용."""
    from kb import read
    from kb.read.ctx import rows, visibility_sql
    from kb.read.nodes import _json
    ctx = read.ReadCtx.build(max_sensitivity="internal", types="Ticket")
    out: set[str] = set()
    try:
        with read.reading(ctx) as con:
            w, p = visibility_sql(ctx, "n")
            for r in rows(con, f"SELECT n.props FROM node n WHERE {w}", p):
                for u in _json(r["props"]).get("urls") or []:
                    n = _urls.normalize(u)
                    if n:
                        out.add(n)
    except read.NotReady:
        pass
    return out


def _material(b) -> "_ic.Material":
    item = {"id": b.rid, "treat": "full", "topic": b.title, "session": b.props.get("session") or "harvest",
            "researched_on": b.props.get("source_date")}
    urls = [u for u in b.urls if not _personal_query(u)]
    return _ic.Material(item=item, resolved=True, body=b.body, urls=urls, source_path=b.props.get("source_path", ""))


def plan_urls(builts: list, deny_names: list[str], cfg: Config, *, apply: bool, should_stop=None) -> UrlStats:
    """builts의 URL을 티켓으로. apply=False면 쓰지 않고 같은 판정을 시뮬레이션한다."""
    from kb import ticket
    from kb.write.errors import WriteRejected
    st = UrlStats()
    try:
        ever = ticketed_urls()
    except Exception as e:  # noqa: BLE001 이력을 못 읽으면 중복을 가릴 수 없다. 닫힌 티켓의 URL을 다시 올리지 않도록 이번엔 올리지 않는다
        st.errors += 1
        st.aborted = type(e).__name__
        return st
    mats = [_material(b) for b in builts]
    by_id = {m.item["id"]: b for m, b in zip(mats, builts)}
    agg, per = _ic._candidates(mats, deny_names)
    dropped = len({u for b in builts for u in b.urls if _personal_query(u)})
    st.extracted, st.skipped, st.denied = agg["extracted"] + dropped, agg["skipped"] + dropped, agg["denied"]
    book = _ic.Book(_ic._open_rows())
    remaining = cfg.max_urls
    touched: set[int] = set()
    for m, cand in per:
        b = by_id[m.item["id"]]
        fresh = []
        for u in cand:
            if u in ever:
                st.known += 1
            else:
                fresh.append(u)
        if len(fresh) > cfg.max_urls_per_source:
            st.capped_source += len(fresh) - cfg.max_urls_per_source
            fresh = fresh[:cfg.max_urls_per_source]
        topic = TOPIC_PREFIX + b.src.project
        reason = (f"자동 수확이 {b.src.project}의 세션 자료({b.src.kind})에서 찾은 공개 URL이다. "
                  "수집 경로의 게이트를 지나기 전에는 사실이 아니다")
        for u in fresh:
            if remaining <= 0 or (should_stop is not None and should_stop()):
                st.capped_run += 1
                continue
            act, ent = book.place(topic, u)
            if act == "cap":
                st.capped_ticket += 1
                continue
            if act == "add":
                if apply:
                    try:
                        r = ticket.open_ticket(topic, reason, "low", u, transport="intake", session=cfg.session)
                    except WriteRejected:
                        st.errors += 1
                        ent["urls"].remove(u)
                        continue
                    ent = book.settle(ent, topic, u, r["ticket"])
                    st.new_events += 1
                remaining -= 1
                st.registered += 1
            touched.add(id(ent))
    st.tickets = len(touched)
    return st
