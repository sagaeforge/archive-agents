# Real Python SDK server with a slow start, as a server launched through npx, uvx or a large import would have.
import os, time, sys
time.sleep(float(os.environ.get("SLOW_S", "3")))
try:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP
except ImportError:  # mcp 2.x renamed FastMCP to MCPServer
    from mcp.server.mcpserver import MCPServer as FastMCP
mcp = FastMCP("slowpy")
@mcp.tool()
def slow_echo(text: str) -> str:
    """SLOWPY echoes text"""
    return f"slowpy-echo:{text}"
if __name__ == "__main__":
    mcp.run()
