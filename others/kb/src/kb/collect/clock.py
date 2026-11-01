"""시간 함수 모음. 시험이 이 모듈의 함수를 바꿔 시계와 대기를 제어한다."""
from __future__ import annotations

import time


def now_ms() -> int:
    return int(time.time() * 1000)


def mono() -> float:
    return time.monotonic()


def sleep(s: float) -> None:
    if s > 0:
        time.sleep(s)
