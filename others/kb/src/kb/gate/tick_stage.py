"""tick 4.5 gate_l1. 4단계 parse가 새로 쓴 결정적 주장(parser_derived)에 9단계 생존 입장만 적용한다.
G 단위 주어의 liveness가 없으면 claim.review로 needs_review에 묶고 queue(kind=live)에 넣는다.
커서(tick_state gate_l1:seq)는 원장 seq이고, 같은 주장을 두 번 묶어도 idem_key가 같아 이벤트가 늘지 않는다."""
from __future__ import annotations

from kb.collect.stage import StageResult
from kb.core import ledger, opsdb
from kb.gate.liveness import CODE, liveness_stance, _gold

CURSOR = "gate_l1:seq"
ACTOR = "gate_l1"
BATCH = 2000


def run(ctx=None) -> StageResult:
    res = StageResult()
    c = opsdb.connect()
    try:
        after = int(opsdb.tick_state_get(c, CURSOR, "0") or 0)
    finally:
        c.close()
    led = ledger.open_ledger()
    try:
        evs = ledger.iter_events(led, after, BATCH)
    finally:
        led.close()
    last, scanned, held, subjects = after, 0, [], {}
    for e in evs:
        last = max(last, e["seq"])
        p = e.get("payload")
        if e["kind"] != "claim.assert" or not p or p.get("method") != "deterministic" or p.get("verification") != "parser_derived":
            continue
        scanned += 1
        subjects.setdefault(p["subject"], []).append(p["id"])
    con = _gold()
    try:
        for subj, cids in subjects.items():
            if liveness_stance(subj, con=con) == CODE:
                held += cids
    finally:
        if con is not None:
            con.close()
    if held:
        from kb.write import commit
        commit([{"kind": "claim.review", "actor": ACTOR, "origin": "system", "subject": cid,
                 "idem_key": f"gate_l1:{cid}:{CODE}",
                 "payload": {"id": cid, "verification": "needs_review", "decided_by": ACTOR}} for cid in held], ACTOR,
               timeout=60.0)
    c = opsdb.connect()
    try:
        opsdb.tick_state_set(c, CURSOR, last)
    finally:
        c.close()
    res.detail = {"scanned": scanned, "subjects": len(subjects), "held": len(held), "cursor": last}
    return res


STAGES = [(4.5, "gate_l1", run)]
