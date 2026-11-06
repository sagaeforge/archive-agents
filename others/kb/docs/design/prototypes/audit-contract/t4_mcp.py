"""mcp 2.3.0 리소스 템플릿이 슬래시 든 id를 받는가."""
import asyncio, inspect
import mcp
from mcp.server.mcpserver import MCPServer
s = MCPServer("t")
@s.resource("kb://snapshot/{id}")
def snap(id: str) -> str:
    return "snap:" + id
@s.resource("kb://node/{id}")
def node(id: str) -> str:
    return "node:" + id
async def main():
    for uri in ("kb://snapshot/n-3fa9c01b77aa12ef", "kb://node/c-8k2p4q7m1xab", "kb://node/e:feature/claude-code-hooks", "kb://node/e%3Afeature%2Fclaude-code-hooks"):
        try:
            r = await s.read_resource(uri)
            print(uri, "->", r if not hasattr(r,'__iter__') else list(r)[:1])
        except Exception as e:
            print(uri, "-> EXC", type(e).__name__, str(e)[:120])
asyncio.run(main())
