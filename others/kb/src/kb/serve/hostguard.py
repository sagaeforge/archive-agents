"""Host 헤더 검사 ASGI 미들웨어(계약 7장). 불일치는 403 host_rejected problem+json이다.

TrustedHostMiddleware는 400 text/plain을 고정으로 내므로 쓰지 않는다.
"""
from __future__ import annotations

from kb.serve.http import send_problem


def host_of(value: str) -> str:
    v = value.strip().lower()
    if v.startswith("["):
        end = v.find("]")
        return v[1:end] if end > 0 else v
    return v.rsplit(":", 1)[0] if v.count(":") == 1 else v


class HostGuard:
    def __init__(self, app, allowed_hosts):
        self.app = app
        self.allowed = {host_of(h) for h in allowed_hosts}

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        host = None
        for k, v in scope.get("headers") or []:
            if k == b"host":
                host = v.decode("latin-1")
                break
        if host is None or host_of(host) not in self.allowed:
            return await send_problem(send, 403, "host_rejected", "허용되지 않은 Host", scope.get("path", "/"))
        return await self.app(scope, receive, send)
