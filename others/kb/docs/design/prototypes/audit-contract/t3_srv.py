"""WP-10 지시 형태: LISTEN_FDS를 읽어 fd 3부터 소켓을 만들고 Server.serve(sockets=...)로 넘긴다. 유휴 종료."""
import asyncio, os, socket, sys, time
import uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
last = [time.monotonic()]
def meta(req):
    last[0] = time.monotonic()
    return JSONResponse({"pid": os.getpid(), "client": str(req.client)})
app = Starlette(routes=[Route("/v1/meta", meta)])
n = int(os.environ.get("LISTEN_FDS", "0"))
socks = [socket.socket(fileno=3 + i) for i in range(n)]
print("fds", n, [(s.family.name, s.getsockname()) for s in socks], flush=True)
cfg = uvicorn.Config(app, log_level="warning", lifespan="off")
srv = uvicorn.Server(cfg)
async def idle():
    while not srv.should_exit:
        await asyncio.sleep(0.2)
        if time.monotonic() - last[0] > float(os.environ.get("IDLE", "2")):
            srv.should_exit = True
async def main():
    t = asyncio.create_task(idle())
    await srv.serve(sockets=socks)
    t.cancel()
asyncio.run(main())
print("exited", flush=True)
