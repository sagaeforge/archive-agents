"""공통 값 형식(ADR-0003 8장). 어댑터는 호출과 응답 변환만 한다."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

EXTERNAL = ("claude", "claude_sub", "codex", "openrouter", "openai_api", "anthropic_api")


@dataclass
class Window:
    """추출 창. paras는 (para_sha, text) 목록, text는 모델에 보내는 본문."""
    window_id: str
    snapshot: str
    text: str
    paras: list
    candidates: list = field(default_factory=list)   # [{"id", "label", "aliases"}]
    title: str = ""
    publisher: str = ""
    domain: str = ""
    url: str = ""
    items: list = field(default_factory=list)      # 이 창을 만든 큐 항목
    sha: str = ""                                  # 창 본문 sha256
    spans: list = field(default_factory=list)      # 문단 (start_cp, end_cp)

    @property
    def para_shas(self) -> list:
        return [p[0] for p in self.paras]


@dataclass
class Job:
    window: Window
    purpose: str = "extract"       # extract | support | cross | classify
    scope: str = "public"
    system: str = ""
    user: str = ""
    schema: dict | None = None     # full 정본
    model: str = ""
    budget_usd: float | None = None
    admission: object | None = field(default=None, repr=False)


@dataclass
class Preflight:
    ok: bool
    reason: str = ""
    warn: str = ""
    info: dict = field(default_factory=dict)


@dataclass
class Result:
    window_id: str
    backend: str
    model: str
    served_model: str | None = None
    provider: str | None = None
    raw: str | None = None
    usage: dict | None = None
    finish_reason: str | None = None
    elapsed_s: float | None = None
    cost_usd: float | None = None
    error: str | None = None
    extra: dict = field(default_factory=dict)     # rate, used_percent, tool_items 등 백엔드별 부가 값

    def as_dict(self) -> dict:
        return {"window_id": self.window_id, "backend": self.backend, "model": self.model,
                "served_model": self.served_model, "provider": self.provider, "raw": self.raw, "usage": self.usage,
                "finish_reason": self.finish_reason, "elapsed_s": self.elapsed_s, "cost_usd": self.cost_usd,
                "error": self.error}


class Backend(Protocol):
    name: str
    external: bool

    def preflight(self) -> Preflight: ...
    def extract(self, job: Job, permit) -> Result: ...
