# A real server on the official Python SDK, shaped like a typical external tool server: tools only, no resources.
import os, sys, json, time
try:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP
except ImportError:  # mcp 2.x renamed FastMCP to MCPServer
    from mcp.server.mcpserver import MCPServer as FastMCP
LOG = os.environ.get("SPAWN_LOG", "")
def stamp(ev):
    if LOG:
        with open(LOG, "a") as f:
            f.write(json.dumps({"ev": ev, "pid": os.getpid(), "t": time.time()}) + "\n")
stamp("spawn")
import atexit
atexit.register(lambda: stamp("exit"))
mcp = FastMCP("realpy")
@mcp.tool()
def status() -> dict:
    """REALPY status, returns a dict"""
    return {"source": "realpy", "pid": os.getpid()}
@mcp.tool()
def echo(text: str) -> str:
    """REALPY echoes text"""
    return f"realpy-echo:{text} pid={os.getpid()}"
if __name__ == "__main__":
    mcp.run()
