"""tick 6.5 checkpoint와 8 watchdog(WP-15). 6.1 봉인과 7 전송은 tick_stage_ship.py다.

checkpoint: WAL이 임계(원장 64 MB, gold 256 MB)를 넘으면 게이트 밖 전용 연결로 RESTART를 한 번 시도한다.
watchdog: 상태 벡터를 계산해 ops.db에 남기고, healthchecks 핑 URL이 있으면 보낸다.
한 단계의 경보가 단계 실패는 아니다. 코드가 예외를 던질 때만 failed다.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from kb.guard import fsck, watchdog


@dataclass
class StageResult:
    ok: bool = True
    detail: dict = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)

    @property
    def status(self) -> str:
        return "ok" if self.ok else "failed"

    def as_dict(self) -> dict:
        return {"status": self.status, "ok": self.ok, "detail": self.detail, "errors": self.errors}


def run_checkpoint(ctx=None) -> StageResult:
    res = StageResult()
    try:
        res.detail["checkpoint"] = watchdog.checkpoint_if_needed()
    except Exception as e:  # noqa: BLE001
        res.ok = False
        res.errors.append(f"checkpoint: {type(e).__name__}: {e}"[:300])
    return res


def run_watchdog(ctx=None) -> StageResult:
    res = StageResult()
    try:
        v = watchdog.write_vector()
        res.detail.update(critical=len(v["critical"]), warnings=len(v["warnings"]), notices=len(v["notices"]))
    except Exception as e:  # noqa: BLE001
        res.ok = False
        res.errors.append(f"vector: {type(e).__name__}: {e}"[:300])
        return res
    try:
        res.detail["ping"] = watchdog.ping(v, "tick")
    except Exception as e:  # noqa: BLE001
        res.detail["ping"] = {"sent": True, "ok": False, "error": f"{type(e).__name__}: {e}"[:200]}
    return res


# sources/internal.d/watch.yaml 의 작업 진입점
def job_fsck_due(ctx=None) -> dict:
    r = fsck.run()
    return {"ok": r["ok"], "steps": [{"step": s["step"], "ok": s["ok"]} for s in r["steps"]]}


STAGES = [(6.5, "checkpoint", run_checkpoint), (8, "watchdog", run_watchdog)]
