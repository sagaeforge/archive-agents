"""tick 6.2 publish(WP-10). 변경이 있고 마지막 게시 뒤 5분이 지났을 때만 export를 새로 낸다. LLM과 네트워크를 쓰지 않는다."""
from __future__ import annotations

from kb.collect.stage import StageResult


def run(ctx=None) -> StageResult:
    res = StageResult()
    try:
        from kb import publish
        r = publish.publish()
        res.detail.update({k: v for k, v in r.items() if k in ("published", "reason", "build_id")})
    except Exception as e:  # noqa: BLE001 gold가 아직 없으면 실패가 아니라 건너뜀이다
        from kb.read.ctx import NotReady
        if isinstance(e, NotReady):
            res.detail.update(published=False, reason="not_ready")
        else:
            res.ok = False
            res.errors.append(f"publish: {type(e).__name__}: {e}"[:300])
    return res


def job_prune(ctx=None) -> dict:
    """sources/internal.d/publish.yaml 의 작업 진입점: 오래된 게시 폴더 정리."""
    from kb import publish
    return {"removed": publish.prune()}


STAGES = [(6.2, "publish", run)]
