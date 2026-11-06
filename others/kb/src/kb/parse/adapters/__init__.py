"""파서 어댑터 등록. ADAPTERS는 이 패키지와 kb.<패키지>.adapters 모듈을 자동 탐색해 채운다.

어댑터는 parse(ctx) -> Result 순수 함수다. 입력은 CAS 원본과 표시 본문이고 네트워크에 가지 않는다.
hint는 표시 본문 방식(markdown|html|json|pdf|text), None이면 content-type과 URL로 정한다.
prose는 표시 본문에서 산문 구간을 찾는 순수 함수다(ADR-0004 D1의 `l2: declared`). prose(text, fmt, cfg) -> [(start_cp, end_cp)] | None.
None은 "판정 불가"(정책이 문단을 버리지 않는다), 빈 목록은 "산문 없음"이다. 저장하지 않고 쓸 때마다 계산하므로
문단 색인(paras_sha), para_sha, done 키는 그대로다.
"""
from __future__ import annotations

import importlib
import pkgutil
from dataclasses import dataclass
from typing import Callable

ADAPTERS: dict[str, "Adapter"] = {}


@dataclass(frozen=True)
class Adapter:
    name: str
    parse: Callable
    hint: str | None = None
    version: int = 1
    prose: Callable | None = None

    @property
    def ref(self) -> str:
        return f"{self.name}@{self.version}"


def adapter(name: str, *, hint: str | None = None, version: int = 1, prose: Callable | None = None):
    def deco(fn):
        ADAPTERS[name] = Adapter(name, fn, hint, version, prose)
        return fn
    return deco


def _discover() -> None:
    here = importlib.import_module(__name__)
    for m in pkgutil.iter_modules(here.__path__):
        if not m.name.startswith("_"):
            importlib.import_module(f"{__name__}.{m.name}")
    import kb
    for m in pkgutil.iter_modules(kb.__path__):
        if not m.ispkg or m.name == "parse":
            continue
        try:
            importlib.import_module(f"kb.{m.name}.adapters")
        except Exception:  # noqa: BLE001 어댑터 모듈이 없거나 옆 패키지가 쓰는 중이어도 다른 어댑터는 쓴다
            continue


def get(parser_ref: str | None) -> Adapter | None:
    """'name@1' 또는 'name'."""
    if not parser_ref:
        return None
    return ADAPTERS.get(str(parser_ref).split("@", 1)[0])


_discover()
