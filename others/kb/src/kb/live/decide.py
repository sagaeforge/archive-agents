"""사람 판단 대기열의 결정. 에이전트(decided_by가 agent로 시작)는 상태를 확정하지 못하고 제안만 한다."""
from __future__ import annotations

from kb.live import effects, gold as G, reviewq, verdict
from kb.live.model import DEAD_LIVENESS, Decision, Sig


class DecideError(Exception):
    pass


def _sigs(item: dict) -> list:
    return [Sig(s["id"], "human", s.get("snapshot"), s.get("quote")) for s in item["signals"]]


def decide(rid: int, liveness: str, *, by: str = "user", successor: str | None = None, keep: bool = False) -> dict:
    """대기열 항목을 사람이 결정한다. keep=True면 상태를 바꾸지 않고 닫는다. 결과 요약을 돌려준다."""
    if not by or by.lower().startswith(("agent", "live", "rules", "gate")):
        raise DecideError("에이전트와 규칙은 상태를 확정하지 못한다. 제안만 가능하다(kb review propose)")
    it = reviewq.get(rid)
    if it is None:
        raise DecideError(f"열린 항목이 아니다: {rid}")
    if keep:
        reviewq.close(rid, "kept", by)
        return {"id": rid, "target": it["target"], "kept": True}
    sigs = _sigs(it)
    d = Decision(target=it["target"], unit=it["unit"] or "document", liveness=liveness, signals=sigs, successor=successor)
    con = G.open_gold()
    try:
        try:
            p = verdict.build(d, by, con, liveness=liveness, successor=successor)
        except verdict.VerdictRejected as e:
            raise DecideError(str(e)) from None
        verdict.write(p, actor="review", origin="system")
        released, propagated = [], []
    finally:
        if con is not None:
            con.close()
    con = G.open_gold()
    try:
        if con is not None:
            released = effects.release_held(d.target, con)
            if liveness in DEAD_LIVENESS:
                propagated = effects.propagate_dead(d.target, con, snapshot_sig=next((s for s in sigs if s.snapshot), None))
    finally:
        if con is not None:
            con.close()
    reviewq.close(rid, "decided", by)
    return {"id": rid, "target": d.target, "liveness": liveness, "status": p["status"], "released": len(released),
            "propagated": len(propagated)}
