"""tick 4.5 gate_l1. 4단계 parse가 새로 쓴 결정적 주장(parser_derived)에 9단계 생존 입장만 적용한다.
G 단위 주어의 liveness가 없으면(kind=event 주장은 제외) claim.review로 needs_review에 묶고 queue(kind=live)에 넣는다.
커서(tick_state gate_l1:seq)는 원장 seq이다. 파서가 새 스냅샷에서 같은 주장을 다시 내면 parser_derived 새 버전이 되므로
assert마다 다시 묶는다(_hold_key). 같은 assert를 두 번 보면(커서 저장 전 중단) 키가 같아 이벤트가 늘지 않는다."""
from __future__ import annotations

from kb.collect.stage import StageResult
from kb.core import ledger, opsdb
from kb.gate.liveness import CODE, liveness_stance, _gold

CURSOR = "gate_l1:seq"
ACTOR = "gate_l1"
BATCH = 2000


def _hold_key(led, cid: str, seq: int) -> str:
    """첫 보류는 `gate_l1:<주장>:<코드>`이고 kb.live.effects가 이 키로 보류 이력을 찾는다. 그 뒤에 온 assert만 seq를 붙인다."""
    base = f"gate_l1:{cid}:{CODE}"
    row = led.execute("SELECT seq FROM event WHERE idem_key=?", (base,)).fetchone()
    return base if row is None or row[0] > seq else f"{base}:{seq}"


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
    last, scanned, held, subjects = after, 0, {}, {}
    for e in evs:
        last = max(last, e["seq"])
        p = e.get("payload")
        if e["kind"] != "claim.assert" or not p or p.get("method") != "deterministic" or p.get("verification") != "parser_derived":
            continue
        if p.get("kind") == "event":         # event는 생존 보류에서 뺀다(ADR 9.2). 이미 묶인 것은 kb live release-events가 푼다
            continue
        scanned += 1
        subjects.setdefault(p["subject"], {})[p["id"]] = e["seq"]     # 같은 주장은 마지막 assert 하나만 묶는다
    con = _gold()
    try:
        for subj, asserts in subjects.items():
            if liveness_stance(subj, con=con) == CODE:
                held.update(asserts)
    finally:
        if con is not None:
            con.close()
    if held:
        from kb.write import commit
        led = ledger.open_ledger()
        try:
            keys = {cid: _hold_key(led, cid, seq) for cid, seq in held.items()}
        finally:
            led.close()
        commit([{"kind": "claim.review", "actor": ACTOR, "origin": "system", "subject": cid, "idem_key": keys[cid],
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
