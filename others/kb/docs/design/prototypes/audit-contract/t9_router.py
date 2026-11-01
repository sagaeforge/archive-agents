import asyncio, json, sqlite3
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import JSONResponse
from starlette.routing import Route
def meta(req):
    c = sqlite3.connect(":memory:")
    c.execute("create table t(a)"); c.execute("insert into t values(1)")
    return JSONResponse({"schema_version":"0.1.0","data":c.execute("select a from t").fetchall()})
app = Starlette(routes=[Route("/v1/meta", meta)], middleware=[Middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1","localhost"])])
async def call(path):
    body = []
    scope = {"type":"http","http_version":"1.1","method":"GET","path":path,"raw_path":path.encode(),"query_string":b"","headers":[(b"host",b"localhost")],"scheme":"http","server":("localhost",80),"client":None,"root_path":""}
    async def receive(): return {"type":"http.request","body":b"","more_body":False}
    async def send(m):
        if m["type"]=="http.response.body": body.append(m.get("body",b""))
    await app(scope, receive, send)
    print(b"".join(body).decode())
asyncio.run(call("/v1/meta"))
