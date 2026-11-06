"""CTR-01 수정안 재현: e:<type>:<slug> 가 Starlette 경로와 mcp 리소스 템플릿을 통과하는가."""
import asyncio, sys, urllib.parse
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient
from mcp.server.mcpserver import MCPServer

def h(name):
    def f(req):
        return JSONResponse({"route": name, "id": req.path_params["id"]})
    return f
app = Starlette(routes=[Route("/v1/nodes/{id}", h("node")), Route("/v1/nodes/{id}/neighbors", h("neighbors")), Route("/v1/nodes/{id}/history", h("history")), Route("/v1/nodes/{id}/claims", h("claims")), Route("/v1/nodes/{id}/edges", h("edges"))])
c = TestClient(app)
ids = ["e:feature:claude-code-hooks", "e:feature:history", "e:repo:anthropics.claude-code", "s:netflix-top10-kr", "src:cc-docs"]
for i in ids:
    for suffix in ("", "/neighbors", "/history"):
        raw = c.get(f"/v1/nodes/{i}{suffix}")
        enc = c.get(f"/v1/nodes/{urllib.parse.quote(i, safe='')}{suffix}")
        print(i, suffix or "(node)", raw.status_code, raw.json() if raw.status_code==200 else raw.text[:40], "| enc", enc.status_code, enc.json().get("id") if enc.status_code==200 else "")
s = MCPServer("t")
@s.resource("kb://node/{id}")
def node(id: str) -> str:
    return "node:" + id
async def main():
    for uri in ("kb://node/e:feature:claude-code-hooks", "kb://node/e%3Afeature%3Aclaude-code-hooks", "kb://node/e:repo:anthropics.claude-code"):
        try:
            r = await s.read_resource(uri)
            print(uri, "->", list(r)[:1] if hasattr(r,'__iter__') else r)
        except Exception as e:
            print(uri, "-> EXC", type(e).__name__, str(e)[:120])
asyncio.run(main())
