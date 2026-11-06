"""tick 6.4 vector. 벡터 증분을 돈다. 파생물이라 실패해도 조회에 영향이 없다(어휘 경로). LLM과 외부 네트워크를 쓰지 않는다."""
from __future__ import annotations

from kb.collect.stage import StageResult


def run(ctx=None) -> StageResult:
    res = StageResult()
    try:
        from kb.commands.index import run_index
        r = run_index()
        res.detail.update({k: v for k, v in r.items() if k in ("build", "rows", "embedded", "reused", "skipped", "device")})
        if not r.get("ok"):
            res.ok = False
            res.errors.append(f"index: {r.get('error')} {r.get('detail', '')}"[:300])
    except Exception as e:  # noqa: BLE001
        res.ok = False
        res.errors.append(f"index: {type(e).__name__}: {e}"[:300])
    return res


def job_index(ctx=None) -> dict:
    """sources/internal.d/rank.yaml의 작업 진입점: 증분 빌드. 같은 gold 빌드면 즉시 건너뛴다."""
    from kb.commands.index import run_index
    r = run_index()
    return {k: v for k, v in r.items() if k in ("build", "rows", "embedded", "skipped", "ok")}


def job_prune(ctx=None) -> dict:
    from kb.rank import indexer
    return {"removed": indexer.prune()}


STAGES = [(6.4, "vector", run)]
