# Probe only: same routes as kbprobe.py, but the handler looks the id up in a store that holds
# e:concept/history and no e:concept, so a mis-routed id answers 404 instead of echoing.
import sys, urllib.parse
deps, mode, sock = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.insert(0, deps)
import uvicorn
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import JSONResponse
from starlette.routing import Route

STORE = {"e:concept/history"}

def h(name):
    def inner(request):
        i = request.path_params["id"]
        i = urllib.parse.unquote(i)
        if i not in STORE:
            return JSONResponse({"code": "not_found", "id": i, "handler": name}, status_code=404)
        return JSONResponse({"handler": name, "id": i})
    return inner

if mode == "plain":
    routes = [Route("/v1/nodes/{id}/neighbors", h("neighbors")), Route("/v1/nodes/{id}/history", h("history")), Route("/v1/nodes/{id}", h("node"))]
elif mode == "pathconv":
    routes = [Route("/v1/nodes/{id:path}/neighbors", h("neighbors")), Route("/v1/nodes/{id:path}/history", h("history")), Route("/v1/nodes/{id:path}", h("node"))]
else:  # rawpath: route on the undecoded path so %2F stays inside one segment
    routes = [Route("/v1/nodes/{id}/neighbors", h("neighbors")), Route("/v1/nodes/{id}/history", h("history")), Route("/v1/nodes/{id}", h("node"))]

app = Starlette(routes=routes, middleware=[Middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])])

class RawPath:
    def __init__(self, inner): self.inner = inner
    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope.get("raw_path"):
            scope = dict(scope, path=scope["raw_path"].decode("ascii"))
        await self.inner(scope, receive, send)

target = RawPath(app) if mode == "rawpath" else app
uvicorn.run(target, uds=sock, log_level="warning", access_log=False)
