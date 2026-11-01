"""인용구 재확인과 효력일 대체 완결(ADR 10.7, 7.6). 결정적 문자열 대조뿐이고 LLM을 부르지 않는다.
이 일이 LLM 슬롯에 기대지 않는 신선도 장치다. LLM 주장에 자동 대체를 넣지 않는다."""
from __future__ import annotations

import json
import time

from kb.core import cas, ledger
from kb.extract import settings, state
from kb.gate.textmatch import QuoteError, locate

CURSOR = "extract:rc:seq"
CONTEXT = 24                                              # prefix, suffix 길이. kb.ingest와 같다


def _src_class(source_id: str | None) -> str | None:
    if not source_id:
        return None
    try:
        from kb.collect import registry
        s = registry.get_source(source_id)
        return s.class_ if s else None
    except Exception:  # noqa: BLE001
        return None


def _snap_source(led, sid: str) -> str | None:
    r = led.execute("SELECT p.body FROM event e JOIN payload p ON p.sha=e.payload_sha WHERE e.kind='snapshot.captured' "
                    "AND e.subject=? ORDER BY e.seq LIMIT 1", (sid,)).fetchone()
    return (json.loads(r[0]).get("source") if r and r[0] else None)


def _selector(text: str, ev: tuple) -> dict | None:
    """새 본문에서 찾은 인용구의 선택자. 없으면 None. 여러 곳에 있어 위치를 못 정하면 빈 dict(있지만 위치 미확정)다."""
    exact, prefix, suffix = ev
    try:
        loc = locate(text, exact, prefix or "", suffix or "")
    except QuoteError as e:
        return None if e.code == "E_QUOTE_NOT_FOUND" else {}
    a, b = loc.start, loc.end
    return {"exact": text[a:b], "prefix": text[max(0, a - CONTEXT):a], "suffix": text[b:b + CONTEXT], "start_cp": a, "end_cp": b}


def reconfirm_snapshot(con, led, sid: str, text: str, url: str, source: str | None, moving: set) -> dict:
    """새 스냅샷 sid의 본문에서 같은 URL의 이전 스냅샷을 근거로 하는 활성 주장의 인용구를 찾는다."""
    from kb.ingest.store import Gold
    from kb.write import commit
    g = Gold()
    try:
        prev = [p["id"] for p in g.snapshots_of_url(url) if p["id"] != sid]
    finally:
        g.close()
    res = {"confirmed": 0, "withdrawn": 0, "kept_event": 0, "degraded": False, "claims": 0}
    if not prev:
        return res
    ph = ",".join("?" * len(prev))
    rows = con.execute(
        f"SELECT n.id, c.kind, e.id, e.exact, e.prefix, e.suffix FROM evidence e JOIN node n ON n.id=e.claim_id AND n.expired_at IS NULL "
        f"JOIN claim c ON c.vid=n.vid WHERE e.snapshot_id IN ({ph}) AND n.status='active' AND e.exact IS NOT NULL "
        f"AND e.selector_kind='text_quote' ORDER BY n.id, e.seq, e.id", prev).fetchall()
    # 주장마다 가장 먼저 쓰인 근거 행을 기준으로 삼는다. 뒤 스냅샷이 처리된 뒤 재시작해도 같은 행이라 같은 페이로드가 나온다
    seen, claims = set(), []
    for cid, kind, evid, ex, pre, suf in rows:
        if cid in seen:
            continue
        seen.add(cid)
        claims.append((cid, kind, evid, (ex, pre, suf)))
    res["claims"] = len(claims)
    if not claims:
        return res
    ok, gone = [], []
    for cid, kind, evid, ev in claims:
        sel = _selector(text, ev)
        if sel is None:
            gone.append((cid, kind))
        else:
            ok.append((cid, evid, sel))
    evs = [{"kind": "claim.confirm", "actor": "l2", "origin": "system", "subject": cid, "idem_key": f"confirm:{cid}:{sid}",
            "payload": {"id": cid, "snapshot": sid, "evidence_id": evid, **sel}} for cid, evid, sel in ok]
    res["confirmed"] = len(ok)
    ratio = len(gone) / len(claims)
    if _src_class(source) in moving:
        pass                                              # feed, short는 창이 움직인다. 소실이 정상이라 철회도 degraded도 없다
    elif gone and ratio > float(settings.get("reconfirm.vanish_ratio", 0.30)):
        res["degraded"] = True
        if source:
            evs.append({"kind": "source.status", "actor": "l2", "origin": "system", "subject": source,
                        "idem_key": f"degraded:{source}:{sid}",
                        "payload": {"id": source, "state": "degraded", "reason": f"인용구 {len(gone)}/{len(claims)}건 소실: 구조 변경 의심"}})
        state.metric("llm.reconfirm_degraded", 1, {"source": source})
    else:
        for cid, kind in gone:
            if kind in ("state", "howto"):
                evs.append({"kind": "claim.withdraw", "actor": "l2", "origin": "system", "subject": cid,
                            "idem_key": f"withdraw:{cid}:{sid}",
                            "payload": {"id": cid, "reason": "새 스냅샷에서 인용구가 사라짐", "snapshot": sid}})
                res["withdrawn"] += 1
            else:
                res["kept_event"] += 1                    # event는 유지한다(archived_only)
    if evs:
        commit(evs, "l2", timeout=60.0)
    return res


def complete_supersedes(con, now_ms: int) -> int:
    """효력일이 지난 미래 발효 대체를 claim.supersede로 완결한다. 결정적 주장만(같은 슬롯)이다."""
    from kb.write import commit
    rows = con.execute(
        "SELECT a.id, b.id, b.valid_from FROM node a JOIN claim ca ON ca.vid=a.vid JOIN node b ON b.type='Claim' "
        "AND b.expired_at IS NULL AND b.status='active' JOIN claim cb ON cb.vid=b.vid AND cb.slot=ca.slot "
        "WHERE a.type='Claim' AND a.expired_at IS NULL AND a.status='active' AND a.id<>b.id AND ca.slot IS NOT NULL "
        "AND ca.method='deterministic' AND cb.method='deterministic' AND a.valid_to IS NULL AND a.valid_from IS NOT NULL "
        "AND b.valid_from IS NOT NULL AND b.valid_from>a.valid_from AND b.valid_from<=?", (now_ms,)).fetchall()
    best: dict = {}
    for a, b, vf in rows:
        if a not in best or vf < best[a][1]:
            best[a] = (b, vf)
    evs = []
    for a, (b, vf) in sorted(best.items()):
        iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(vf / 1000))
        evs.append({"kind": "claim.supersede", "actor": "l2", "origin": "system", "subject": a,
                    "idem_key": f"supersede_due:{a}:{b}", "payload": {"id": a, "by": b, "reason": "효력일 도래", "valid_to": iso}})
    if evs:
        commit(evs, "l2", timeout=60.0)
    return len(evs)


def run_new_snapshots(limit: int = 500) -> dict:
    from kb.core.conn import connect_ro
    from kb.project import current_gold_path
    after = int(state.get(CURSOR, 0) or 0)
    led = ledger.open_ledger()
    try:
        evs = ledger.iter_events(led, after, limit)
        gp = current_gold_path()
        con = connect_ro(gp, 60.0) if gp else None
        tot = {"snapshots": 0, "confirmed": 0, "withdrawn": 0, "degraded": 0, "kept_event": 0}
        last = after
        moving = set(settings.get("reconfirm.moving_classes") or [])
        try:
            for e in evs:
                last = max(last, e["seq"])
                if e["kind"] != "snapshot.text" or not e.get("payload") or con is None:
                    continue
                p = e["payload"]
                sid = p["snapshot"]
                node = con.execute("SELECT props FROM node WHERE id=? AND type='Snapshot' AND expired_at IS NULL", (sid,)).fetchone()
                if not node:
                    last = min(last, e["seq"] - 1)         # 투영이 아직 못 따라왔다. 다음 tick에 다시 본다
                    break
                url = (json.loads(node[0]) if node[0] else {}).get("url") or ""
                text = cas.get(p["text_sha"]).decode("utf-8")
                r = reconfirm_snapshot(con, led, sid, text, url, _snap_source(led, sid), moving)
                tot["snapshots"] += 1
                tot["confirmed"] += r["confirmed"]
                tot["withdrawn"] += r["withdrawn"]
                tot["kept_event"] += r["kept_event"]
                tot["degraded"] += 1 if r["degraded"] else 0
            if con is not None:
                tot["superseded"] = complete_supersedes(con, int(settings.now_s() * 1000))
        finally:
            if con is not None:
                con.close()
    finally:
        led.close()
    state.put(CURSOR, last)
    return tot
