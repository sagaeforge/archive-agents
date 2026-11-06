"""스냅샷 하나를 파싱한다(ADR 10.2 4단계): 구조 가드 -> 어댑터 -> 표시 본문 -> 문단 -> 이벤트.
입력은 CAS 원본뿐이고 네트워크에 가지 않는다."""
from __future__ import annotations

import json
import time

from kb.core import cas, ledger
from kb.parse import adapters, display, events
from kb.parse import paragraphs as _pg
from kb.parse.model import Ctx, Result
from kb.write.errors import IdemConflict, WriteRejected

DEFAULT_ADAPTER = "page_md"
NEEDS_BROWSER_CHARS = 200


class ParseError(Exception):
    pass


def _prior_text(led, sid: str) -> dict | None:
    r = led.execute("SELECT p.body FROM event e JOIN payload p ON p.sha=e.payload_sha WHERE e.kind='snapshot.text' AND e.subject=? "
                    "ORDER BY e.seq DESC LIMIT 1", (sid,)).fetchone()
    return json.loads(r[0]) if r and r[0] else None


def pick_adapter(snap: dict, src) -> adapters.Adapter:
    a = adapters.get(src.parser) if src is not None else None
    if a is not None:
        # 색인 문서는 색인 어댑터, 색인이 안내한 하위 페이지는 page_md가 파싱한다(ADR 10.4)
        if src.discover and snap.get("url") != src.index_url and a.name in ("llms_txt", "sitemap", "html_index"):
            return adapters.ADAPTERS[DEFAULT_ADAPTER]
        return a
    ct = (snap.get("content_type") or "").split(";")[0].strip().lower()
    return adapters.ADAPTERS["raw_file"] if ct and not (ct.startswith("text/") or ct in ("application/pdf", "application/xhtml+xml")) \
        and "json" not in ct else adapters.ADAPTERS[DEFAULT_ADAPTER]


def _commit(evs: list[dict]) -> dict:
    """한 번에 쓰고, 입력 검증이 거부하면 이벤트별로 나눠 쓴다. (쓴 수, 거부 수, 거부 사유)."""
    from kb.write import commit
    if not evs:
        return {"written": 0, "rejected": 0, "reasons": []}
    try:
        commit(evs, events.ACTOR, timeout=60.0)
        return {"written": len(evs), "rejected": 0, "reasons": []}
    except (WriteRejected, IdemConflict) as e:
        first = str(e)[:160]
    out = {"written": 0, "rejected": 0, "reasons": [first]}
    for ev in evs:
        try:
            commit([ev], events.ACTOR, timeout=60.0)
            out["written"] += 1
        except IdemConflict:
            out["written"] += 1         # 같은 이벤트가 이미 있다
        except WriteRejected as e:
            out["rejected"] += 1
            out["reasons"].append(f"{ev['kind']}:{str(e)[:120]}")
    return out


def guard(res: Result, src, prev_count) -> str | None:
    """구조 가드. 위반 사유 또는 None."""
    ex = (src.expect if src is not None else None) or {}
    if ex.get("min_entries") and (res.count or 0) < int(ex["min_entries"]):
        return f"min_entries:{res.count}<{ex['min_entries']}"
    if ex.get("entries_never_shrink") and prev_count is not None and res.count is not None and res.count < prev_count:
        return f"entries_shrank:{res.count}<{prev_count}"
    return None


def parse_snapshot(snap: dict, src, *, state=None, reuse_text: bool = False, now_ms: int | None = None) -> dict:
    """snap: snapshot.captured payload. 결과: {status, snapshot, adapter, text_sha, paras, stats, written, rejected, notes}.
    status: ok | needs_ocr | guard | error. reuse_text=True(kb reparse)면 저장된 표시 본문을 다시 계산하지 않는다."""
    sid, url = snap["id"], snap["url"]
    ad = pick_adapter(snap, src)
    ref = ad.ref
    raw = cas.get(snap["raw_sha"], snap.get("tier") or "objects")
    out: dict = {"status": "ok", "snapshot": sid, "adapter": ref, "notes": []}
    led = ledger.open_ledger()
    try:
        prior = _prior_text(led, sid) if reuse_text else None
    finally:
        led.close()
    if prior:
        txt = display.Text(cas.get(prior["text_sha"]).decode("utf-8"), prior["text_format"], prior["extractor"])
        text_sha, paras_sha = prior["text_sha"], prior["paras_sha"]
        out["reused_text"] = True
    else:
        needs_pdf = bool(src is not None and (src.expect or {}).get("needs_pdf"))
        txt = display.display_text(raw, snap.get("content_type"), hint=ad.hint, url=url, needs_pdf=needs_pdf)
        if txt.needs_ocr:
            if state is not None:
                state.dlq_put("needs_ocr", sid, "parse", f"pdf avg chars < {display.PDF_MIN_AVG_CHARS}", snap["raw_sha"])
            out.update(status="needs_ocr")
            return out
        text_sha = cas.put(txt.text.encode("utf-8"))
        ct = (snap.get("content_type") or "").split(";")[0].strip().lower()
        if state is not None and ct in ("text/html", "application/xhtml+xml") and len(txt.text.strip()) < NEEDS_BROWSER_CHARS:
            state.dlq_put("needs_browser", sid, "parse", f"정적 추출 본문 {len(txt.text.strip())}자: JS 렌더링 의심", snap["raw_sha"])
            out["notes"].append("needs_browser")
        paras = _pg.paragraphs(txt.text, txt.fmt)
        paras_sha = _pg.store(paras)
        out["paras"] = len(paras)
        w = _commit([{"kind": "snapshot.text", "actor": events.ACTOR, "origin": "system", "subject": sid,
                      "idem_key": f"snaptext:{sid}:{txt.extractor}",
                      "payload": {"snapshot": sid, "text_sha": text_sha, "text_format": txt.fmt, "extractor": txt.extractor,
                                  "paras_sha": paras_sha}}])
        out["text_event"] = w
    out["text_sha"] = text_sha
    cfg = dict((src.raw.get("parse") if src is not None else None) or {})
    res = ad.parse(Ctx(snapshot=snap, raw=raw, text=txt, source=src, cfg=cfg))
    out["notes"] += res.notes
    ckey = f"parse:count:{snap.get('source')}:{url}"
    prev = state.kv_get(ckey) if state is not None else None
    why = guard(res, src, int(prev) if prev is not None else None)
    if why:
        if state is not None:
            state.dlq_put("parse", sid, "parse", f"guard:{why}", snap["raw_sha"])
        out.update(status="guard", guard=why)
        return out
    from kb.parse.conflicts import functional_predicates
    evs, stats = events.build(snap, res, txt, text_sha, ref, source=snap.get("source"), functional=functional_predicates(),
                              now_ms=now_ms or int(time.time() * 1000))
    w = _commit(evs)
    out.update(stats=stats, written=w["written"], rejected=w["rejected"])
    if w["reasons"]:
        out["notes"] += w["reasons"][:5]
    if state is not None and res.count is not None:
        state.kv_set(ckey, res.count)
    return out
