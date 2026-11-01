"""WP-10 지시대로 만든 최소 서버. Starlette 1.10 + uvicorn 0.54, TrustedHostMiddleware, {id} 경로."""
import json
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import JSONResponse
from starlette.routing import Route


def node(req):
    return JSONResponse({"route": "node", "id": req.path_params["id"]})


def neighbors(req):
    return JSONResponse({"route": "neighbors", "id": req.path_params["id"]})


def history(req):
    return JSONResponse({"route": "history", "id": req.path_params["id"]})


def meta(req):
    return JSONResponse({"route": "meta", "host": req.headers.get("host")})


plain = Starlette(
    routes=[
        Route("/v1/meta", meta),
        Route("/v1/nodes/{id}", node),
        Route("/v1/nodes/{id}/neighbors", neighbors),
        Route("/v1/nodes/{id}/history", history),
    ],
    middleware=[Middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])],
)

# 경로 변환기를 쓰는 대안. 순서 의존을 함께 본다.
pathconv = Starlette(
    routes=[
        Route("/v1/meta", meta),
        Route("/v1/nodes/{id:path}/neighbors", neighbors),
        Route("/v1/nodes/{id:path}/history", history),
        Route("/v1/nodes/{id:path}", node),
    ],
    middleware=[Middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])],
)
