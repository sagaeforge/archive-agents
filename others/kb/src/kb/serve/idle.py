"""유휴 종료(계약 1장 소켓 활성화). 마지막 요청이 끝난 뒤 idle_s초가 지나면 서버를 정상 종료한다."""
from __future__ import annotations

import asyncio
import time

DEFAULT_IDLE_S = 600.0


class IdleTracker:
    """ASGI 미들웨어이자 감시자. 처리 중인 요청이 있으면 유휴가 아니다."""

    def __init__(self, app, idle_s: float = DEFAULT_IDLE_S, clock=time.monotonic):
        self.app = app
        self.idle_s = float(idle_s)
        self.clock = clock
        self.last = clock()
        self.inflight = 0

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        self.inflight += 1
        try:
            return await self.app(scope, receive, send)
        finally:
            self.inflight -= 1
            self.last = self.clock()

    def idle(self) -> bool:
        return self.inflight == 0 and self.clock() - self.last >= self.idle_s

    async def watch(self, server) -> None:
        """idle_s가 지나면 server.should_exit를 켠다. uvicorn.Server와 같이 돌린다."""
        step = max(0.05, min(1.0, self.idle_s / 4))
        self.last = self.clock()
        while not server.should_exit:
            await asyncio.sleep(step)
            if self.idle():
                server.should_exit = True
