"""생존 판정 값 객체(ADR 13장, sources-inventory-g 3장). 점수를 두지 않는다: 근거(Sig)가 붙은 상태값만 남는다."""
from __future__ import annotations

from dataclasses import dataclass, field

# survival.verdict.liveness 값. 상태 이름 active는 verdict에서 alive다(ingest.process.VERDICT와 같다).
LIVENESS = ("alive", "renamed", "scheduled_removal", "removed", "superseded", "stale_suspect", "revived", "deprecated", "partial")
STATUS_OF = {"removed": "dead", "superseded": "superseded"}
DEAD_LIVENESS = ("removed", "superseded")
UNITS = ("repo", "project", "package", "feature", "model", "document", "feed", "technique")
TYPE_UNIT = {"repo": "repo", "package": "package", "feature": "feature", "model": "model", "document": "document",
             "feed": "feed", "technique": "technique", "project": "project"}
AUTO_DEAD_CAP = 5          # 실행당 자동 dead 상한(ADR 13장)
REVIEW_CAP = 30            # 사람 판단 대기열 상한(ADR 13장)


def status_of(liveness: str) -> str:
    return STATUS_OF.get(liveness, "active")


@dataclass(frozen=True)
class Sig:
    """기계 신호 하나. id는 M01~M24. kind는 규칙이 읽는 분류다.
    kind: archive | move | decl | removed | deprecated | date | cond | suspect | candidate | revive | info | alive"""
    id: str
    kind: str
    snapshot: str | None = None
    quote: str | None = None
    data: dict = field(default_factory=dict, compare=False, hash=False)

    def event(self) -> dict:
        d = {"id": self.id}
        if self.snapshot:
            d["snapshot"] = self.snapshot
        if self.quote:
            d["quote"] = self.quote
        return d

    def with_snapshot(self, snapshot: str | None) -> "Sig":
        return Sig(self.id, self.kind, snapshot, self.quote, self.data)


@dataclass
class Item:
    """사람 판단 대기열 항목. question은 H01~H11 코드."""
    question: str
    text: str
    proposed: str | None = None
    successor: str | None = None


@dataclass
class Decision:
    target: str
    unit: str
    liveness: str
    signals: list = field(default_factory=list)
    successor: str | None = None
    conditions: list = field(default_factory=list)
    removal_date: str | None = None
    canonical: str | None = None
    auto: bool = True
    current: str | None = None
    recheck: list = field(default_factory=list)     # [{unit, target, why}] 재검사할 다른 단위
    queue: list = field(default_factory=list)       # [Item]
    notes: list = field(default_factory=list)

    @property
    def status(self) -> str:
        return status_of(self.liveness)

    @property
    def changed(self) -> bool:
        return self.liveness != (self.current or "alive") or self.current is None

    def as_dict(self) -> dict:
        return {"target": self.target, "unit": self.unit, "liveness": self.liveness, "status": self.status,
                "signals": [s.event() for s in self.signals], "successor": self.successor,
                "conditions": self.conditions, "removal_date": self.removal_date, "canonical": self.canonical,
                "auto": self.auto, "current": self.current, "changed": self.changed,
                "recheck": self.recheck, "queue": [i.__dict__ for i in self.queue], "notes": self.notes}
