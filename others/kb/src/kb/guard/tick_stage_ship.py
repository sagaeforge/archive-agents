"""tick 6.1 봉인과 7 전송(WP-13). 6.5 checkpoint, 8 watchdog은 WP-15다.

봉인은 내보내기 세그먼트와 앵커를 만들고 .tmp-* 잔재를 치운다. 전송은 dirty일 때만 돈다(--if-dirty).
한 단계의 실패가 다음 단계를 막지 않는다.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from kb.guard import drill, redact, ship


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


def _step(res: StageResult, name: str, fn) -> None:
    try:
        res.detail[name] = fn()
    except Exception as e:  # noqa: BLE001
        res.ok = False
        res.errors.append(f"{name}: {type(e).__name__}: {e}"[:300])


def run_seal(ctx=None) -> StageResult:
    res = StageResult()
    _step(res, "seal", ship.seal)
    _step(res, "tmp", lambda: {"swept": len(redact.sweep_tmp(min_age_s=3600.0))})
    return res


def run_ship(ctx=None) -> StageResult:
    res = StageResult()
    budget = getattr(ctx, "budget_s", None) if ctx is not None else None

    def go():
        r = ship.ship(if_dirty=True, timeout=budget or 600.0)
        if not r.get("ok"):
            raise RuntimeError("; ".join(r.get("errors") or [f"{x['id']}:{x.get('error')}" for x in r.get("targets", []) if x.get("result") == "failed"])[:250])
        return {k: r.get(k) for k in ("skipped", "targets", "critical", "notices") if k in r}

    _step(res, "ship", go)
    return res


# sources/internal.d/guard.yaml 의 작업 진입점
def job_sweep_tmp(ctx=None) -> dict:
    return {"swept": len(redact.sweep_tmp(min_age_s=3600.0))}


def job_drill_due(ctx=None) -> dict:
    return drill.run_due(budget_s=300.0)


def job_export_md(ctx=None) -> dict:
    from kb.guard import export_md
    return export_md.export_markdown()


STAGES = [(6.1, "seal", run_seal), (7, "ship", run_ship)]
