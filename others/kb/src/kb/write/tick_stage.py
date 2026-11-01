"""tick 1단계 recover. 스키마 동기화, fp-held 적재(개방 뒤), spool/in 재적재, inbox 스캔, 투영 따라잡기."""
from __future__ import annotations

from dataclasses import dataclass, field

from kb.write import engine as _commit
from kb.write import fpgate, inbox, schema_sync


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
    except Exception as e:  # noqa: BLE001 한 단계의 실패가 다음 단계를 막지 않는다
        res.ok = False
        res.errors.append(f"{name}: {type(e).__name__}: {e}"[:300])


def run(ctx=None) -> StageResult:
    res = StageResult()
    _step(res, "schema", schema_sync.sync_if_changed)
    # first_party의 spool/in 항목은 개방 뒤에만 생기므로 보관 항목이 먼저다
    _step(res, "held", lambda: fpgate.drain("fp-held") if fpgate.is_open() else {"skipped": "fp_closed"})
    _step(res, "reload", lambda: fpgate.drain("in"))
    _step(res, "inbox", lambda: inbox.scan().as_dict())
    _step(res, "project", _commit.project_pending)
    return res


STAGES = [(1, "recover", run)]
