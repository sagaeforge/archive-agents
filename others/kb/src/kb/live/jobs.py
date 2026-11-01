"""sources/internal.d/live.yaml이 부르는 작업. LLM을 부르지 않고 네트워크도 쓰지 않는다."""
from __future__ import annotations

from kb.live import gold as G, reviewq, runner


def seed(ctx=None) -> dict:
    """gold의 G 단위 노드를 live 큐에 넣는다(6시간 주기 판정은 runner.seed가 한다)."""
    con = G.open_gold()
    try:
        return {"seeded": runner.seed(con, force=True) if con is not None else 0}
    finally:
        if con is not None:
            con.close()


def review_cap(ctx=None) -> dict:
    """사람 판단 대기열 상한(30)을 맞춘다. 내린 항목의 판정 상태는 그대로다."""
    return {"demoted": len(reviewq.enforce_cap())}
