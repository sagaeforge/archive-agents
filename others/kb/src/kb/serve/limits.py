"""동시 처리 상한 ASGI 미들웨어(계약 2.3 429).

처리 중인 요청 수가 상한을 넘으면 스레드풀에 넣기 전에 429 too_many_requests + Retry-After를 낸다.
uvicorn limit_concurrency는 연결까지 세고 503 text/plain을 내므로 쓰지 않는다.
"""
from __future__ import annotations

from kb.serve.http import send_problem

MIN_CONCURRENT = 12
DEFAULT_CONCURRENT = 16


class ConfigError(ValueError):
    pass


def check_max_concurrent(n) -> int:
    try:
        v = int(n)
    except (TypeError, ValueError) as e:
        raise ConfigError(f"read.max_concurrent 형식 오류: {n!r}") from e
    if v < MIN_CONCURRENT:
        raise ConfigError(f"read.max_concurrent는 {MIN_CONCURRENT} 이상이어야 한다(받은 값 {v})")
    return v


class ConcurrencyLimit:
    def __init__(self, app, max_concurrent: int = DEFAULT_CONCURRENT):
        self.app = app
        self.max = check_max_concurrent(max_concurrent)
        self.inflight = 0

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        if self.inflight >= self.max:
            return await send_problem(send, 429, "too_many_requests", f"동시 처리 상한 {self.max} 초과",
                                      scope.get("path", "/"))
        self.inflight += 1
        try:
            return await self.app(scope, receive, send)
        finally:
            self.inflight -= 1
