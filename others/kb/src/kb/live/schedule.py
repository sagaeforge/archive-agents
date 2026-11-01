"""재확인 주기(ADR 11장 생존 표). 지터는 ±10%이고 대상 ID에서 결정적으로 정한다."""
from __future__ import annotations

import hashlib

DAY_S = 86400
EVERY = {"repo": 7 * DAY_S, "package": 7 * DAY_S, "feature": 7 * DAY_S, "model": DAY_S, "document": 7 * DAY_S,
         "feed": DAY_S, "technique": 90 * DAY_S, "project": 7 * DAY_S}


def interval_s(unit: str, liveness: str | None, decided_at_ms: int | None, now_ms: int) -> int:
    if liveness in ("removed", "superseded"):
        # 판정 뒤 14일간 주 1회, 이후 월 1회(번복 간격 5일, 184일 관측)
        if decided_at_ms and now_ms - decided_at_ms < 14 * DAY_S * 1000:
            return 7 * DAY_S
        return 30 * DAY_S
    if liveness == "stale_suspect":
        return 30 * DAY_S
    if liveness == "scheduled_removal" and unit == "model":
        return DAY_S
    return EVERY.get(unit, 7 * DAY_S)


def jitter(target: str, base_s: int) -> int:
    h = int(hashlib.sha1(target.encode()).hexdigest()[:6], 16) / 0xFFFFFF       # 0..1
    return int(base_s * (0.9 + 0.2 * h))


def next_at_ms(target: str, unit: str, liveness: str | None, decided_at_ms: int | None, now_ms: int) -> int:
    return now_ms + jitter(target, interval_s(unit, liveness, decided_at_ms, now_ms)) * 1000
