import time
try:
    from mcp.server.mcpserver import MCPServer as App
except ImportError:
    from mcp.server.fastmcp import FastMCP as App
mcp = App("kb", instructions="사실 조회는 kb_search.")
@mcp.tool()
def kb_search(q: str, k: int = 8) -> str:
    """사실 카드를 찾는다."""
    return "#kb v1"
@mcp.tool()
def kb_slow(ms: int = 300) -> str:
    """동기"""
    time.sleep(ms/1000); return "done"
@mcp.tool()
async def kb_slow_async_blocking(ms: int = 300) -> str:
    """대조군"""
    time.sleep(ms/1000); return "done"
@mcp.resource("kb://snapshot/{sid}")
def snap(sid: str) -> str:
    return "본문 "+sid
mcp.run()
