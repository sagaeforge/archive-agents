import asyncio, sys
from mcp.server.mcpserver import MCPServer
s = MCPServer("t")
@s.resource("kb://node/{id}")
def node(id: str) -> str:
    return "node:" + id
async def main():
    for uri in ("kb://node/c-8k2p4q7m1xab","kb://node/e:feature","kb://node/a:b","kb://node/e.feature.claude-code-hooks","kb://node/e-feature-claude-code-hooks","kb://node/e_feature_x","kb://node/e~feature~x","kb://node/e%3Afeature%3Ax","kb://node/n-3fa9c01b77aa12ef","kb://node/s:netflix","kb://node/src:cc-docs","kb://node/f-01JC8ZQ3"):
        try:
            r = await s.read_resource(uri)
            print("OK ", uri, list(r)[:1] if hasattr(r,'__iter__') else r)
        except Exception as e:
            print("EXC", uri, type(e).__name__, str(e)[:100])
asyncio.run(main())
