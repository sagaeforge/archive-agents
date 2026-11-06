"""확인 주기와 백오프. 클래스 표는 sources/classes.yaml(ADR 11장)."""
from __future__ import annotations

import hashlib

from kb.collect import registry
from kb.collect.state import backoff_ms


def class_info(src) -> dict:
    return ((registry.load_classes().get("classes") or {}).get(src.class_ or "")) or {}


def interval_ms(src) -> int:
    v = src.fetch.get("interval_s") or class_info(src).get("interval_s") or 86400
    return int(float(v) * 1000)


def retroactive(src) -> bool:
    return bool(class_info(src).get("retroactive", True))


def jittered(src, base_ms: int, seed: int) -> int:
    j = float(registry.load_classes().get("jitter", 0.1))
    h = int(hashlib.sha256(f"{src.id}:{seed}".encode()).hexdigest()[:8], 16) / 0xFFFFFFFF   # 0..1, 결정적
    return int(base_ms * (1 + j * (2 * h - 1)))


def next_ok(src, now_ms: int) -> int:
    return now_ms + jittered(src, interval_ms(src), now_ms // 1000)


def next_fail(now_ms: int, fail_count: int, retry_after_s: float | None = None) -> int:
    d = backoff_ms(fail_count)
    if retry_after_s:
        d = max(d, int(retry_after_s * 1000))
    return now_ms + d
