"""tick 2단계 registry. 레지스트리 변경 동기화(source.registered, source.status)."""
from __future__ import annotations

from kb.collect.stage import StageResult


def run(ctx=None) -> StageResult:
    res = StageResult()
    try:
        from kb.parse import registry_sync
        res.detail.update(registry_sync.sync())
    except Exception as e:  # noqa: BLE001 레지스트리 오류는 단계 실패로 알리고 다음 단계는 잇는다
        res.ok = False
        res.errors.append(f"{type(e).__name__}: {e}"[:300])
    return res


STAGES = [(2, "registry", run)]
