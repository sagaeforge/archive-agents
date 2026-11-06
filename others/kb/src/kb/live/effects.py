"""판정 뒤 효과 두 가지.
1. release_held: 생존 상태가 없어 보류(R_LIVENESS_UNKNOWN)된 주장을 claim.review로 푼다. 다른 사유로도 걸린 주장은 푼지 않는다.
2. propagate_dead: 대상이 죽으면 DEPENDS_ON 역방향 howto 주장을 suspect(needs_review)로 올리고 H05 대기열에 넣는다.
eff_status 재계산은 투영(WP-02)이 한다. 여기서는 verdict 밖의 claim.review만 쓴다."""
from __future__ import annotations

from kb.core import cas, ledger
from kb.live import gold as G
from kb.live import reviewq
from kb.live.model import Item, Sig

ACTOR = "live"
HOLD_CODE = "R_LIVENESS_UNKNOWN"


def _gate_l1_held(cid: str) -> bool:
    led = ledger.open_ledger()
    try:
        return led.execute("SELECT 1 FROM event WHERE idem_key=?", (f"gate_l1:{cid}:{HOLD_CODE}",)).fetchone() is not None
    finally:
        led.close()


def _regate_passes(con, cid: str, subject: str) -> bool:
    """생존 입장만 빼고 게이트를 다시 돌려 통과하면 True. 다른 사유가 남은 주장은 False."""
    from kb.gate import GateCtx, check_claim
    from kb.parse.paragraphs import paragraphs
    c = con.execute("SELECT c.statement, c.kind, c.stance, c.speaker FROM claim c JOIN node n ON n.vid=c.vid "
                    "WHERE n.id=? AND n.expired_at IS NULL", (cid,)).fetchone()
    ev = con.execute("SELECT exact, prefix, suffix, text_sha FROM evidence WHERE claim_id=? ORDER BY id LIMIT 1", (cid,)).fetchone()
    if not c or not ev or not ev[0] or not ev[3]:
        return False
    try:
        text = cas.get(ev[3]).decode("utf-8")
    except (cas.CasError, OSError, UnicodeDecodeError):
        return False
    n = G.node(con, subject)
    aliases = [n["label"]] if n else []
    aliases += [r[0] for r in con.execute("SELECT norm FROM alias WHERE node_id=?", (subject,))]
    ctx = GateCtx(subject=subject, subject_aliases=tuple(aliases), liveness=None)
    res = check_claim({"statement": c[0], "kind": c[1], "stance": c[2], "speaker": c[3], "quote": ev[0],
                       "prefix": ev[1] or "", "suffix": ev[2] or ""}, text, paragraphs(text), ctx)
    return res.accepted


def release_held(target: str, con) -> list:
    """target의 보류 주장 중 생존 입장이 유일한 사유였던 것을 푼다. 푼 주장 ID 목록."""
    rows = con.execute("SELECT n.id, c.method FROM claim c JOIN node n ON n.vid=c.vid WHERE c.subject=? AND n.expired_at IS NULL "
                       "AND n.status='active' AND n.verification='needs_review' ORDER BY n.id", (target,)).fetchall()
    out, evs = [], []
    for cid, method in rows:
        if _gate_l1_held(cid) or (method != "deterministic" and _regate_passes(con, cid, target)):
            ver = "parser_derived" if method == "deterministic" else "quote_found"
            evs.append({"kind": "claim.review", "actor": ACTOR, "origin": "system", "subject": cid,
                        "idem_key": f"live:release:{cid}:{ver}",
                        "payload": {"id": cid, "verification": ver, "decided_by": ACTOR}})
            out.append(cid)
    if evs:
        from kb.write import commit
        commit(evs, ACTOR, timeout=60.0)
    return out


def dependents(con, target: str) -> list:
    """target에 DEPENDS_ON 하는 howto 주장 ID. 엣지 src가 주장이면 그 주장, 엔티티(기법)이면 그 엔티티의 howto 주장."""
    srcs = [r[0] for r in con.execute("SELECT src FROM edge WHERE rtype='DEPENDS_ON' AND dst=? AND expired_at IS NULL AND status='active'", (target,))]
    out = []
    for s in srcs:
        for (cid,) in con.execute("SELECT n.id FROM claim c JOIN node n ON n.vid=c.vid WHERE n.expired_at IS NULL AND n.status='active' "
                                  "AND c.kind='howto' AND (n.id=? OR c.subject=?) ORDER BY n.id", (s, s)):
            if cid not in out:
                out.append(cid)
    return out


def propagate_dead(target: str, con, *, snapshot_sig: Sig | None = None) -> list:
    """target이 죽었거나 대체되었을 때 의존하는 howto 주장을 suspect + 대기열로 올린다. 주장 ID 목록."""
    cids = dependents(con, target)
    evs = []
    for cid in cids:
        evs.append({"kind": "claim.review", "actor": ACTOR, "origin": "system", "subject": cid,
                    "idem_key": f"live:suspect:{cid}:{target}",
                    "payload": {"id": cid, "verification": "needs_review", "decided_by": ACTOR}})
    if evs:
        from kb.write import commit
        commit(evs, ACTOR, timeout=60.0)
    for cid in cids:
        reviewq.open_item(cid, "technique", Item("H05", f"의존 대상 {target}이 죽음. 기법이 현재 버전에서 통하는지 확인", "stale_suspect"),
                          [snapshot_sig] if snapshot_sig else [])
    return cids
