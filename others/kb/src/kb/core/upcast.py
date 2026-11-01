"""이벤트 v별 변환 등록부. 재생은 항상 upcast를 지나 현재 v의 페이로드를 본다."""
from __future__ import annotations

from typing import Callable

CURRENT_V = 1

_REG: dict[tuple[str, int], Callable[[dict], dict]] = {}


def register(kind: str, from_v: int):
    """@register("claim.assert", 1) def up(payload) -> payload(v+1)"""
    def deco(fn: Callable[[dict], dict]):
        _REG[(kind, from_v)] = fn
        return fn
    return deco


def current_v(kind: str) -> int:
    n = CURRENT_V
    v = 1
    while (kind, v) in _REG:
        v += 1
        n = v
    return n


def upcast(kind: str, v: int, payload: dict | None) -> tuple[int, dict | None]:
    """payload를 현재 v까지 올린다. 변환기가 없는 v 차이는 ValueError."""
    if payload is None:
        return current_v(kind), None
    target = current_v(kind)
    if v > target:
        raise ValueError(f"미래 v: {kind} v{v} > v{target}")
    while v < target:
        fn = _REG.get((kind, v))
        if fn is None:
            raise ValueError(f"업캐스터 없음: {kind} v{v}")
        payload = fn(dict(payload))
        v += 1
    return v, payload
