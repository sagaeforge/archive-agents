import asyncio
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.resources.templates import ResourceSecurity
s = MCPServer("t")
@s.resource("kb://node/{id}", security=ResourceSecurity(exempt_params={"id"}))
def node(id: str) -> str:
    return "node:" + id
async def main():
    for uri in ("kb://node/e:feature:claude-code-hooks","kb://node/e%3Afeature%3Aclaude-code-hooks","kb://node/s:netflix-top10-kr","kb://node/c-8k2p4q7m1xab"):
        try:
            r = await s.read_resource(uri)
            print("OK ", uri, list(r)[:1])
        except Exception as e:
            print("EXC", uri, type(e).__name__, str(e)[:100])
asyncio.run(main())
