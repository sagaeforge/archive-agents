"""tick 단계 결과. 다른 패키지의 StageResult와 같은 모양(ok, detail, errors)이다."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class StageResult:
    ok: bool = True
    detail: dict = field(default_factory=dict)
    errors: list = field(default_factory=list)

    @property
    def status(self) -> str:
        return "ok" if self.ok else "failed"

    def as_dict(self) -> dict:
        return {"status": self.status, "ok": self.ok, "detail": self.detail, "errors": self.errors}
