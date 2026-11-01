"""kb-mcp 서버를 프로세스 안에서 부르는 도우미(collector, default 프로필)."""
import asyncio


def caller(profile):
    from kb.serve.mcp import build_server
    srv = build_server(profile)

    def call(name, **a):
        res = asyncio.run(srv.call_tool(name, a))
        blocks = res.content if hasattr(res, "content") else res
        return "\n".join(getattr(b, "text", "") for b in blocks)
    call.server = srv
    return call
