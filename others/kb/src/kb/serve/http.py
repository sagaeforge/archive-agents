"""HTTP 읽기 API `/v1`(WP-10). 계약 4장 표의 26개 경로를 kb.read 함수에 1:1로 잇는다.

규칙
- 응답 본문은 kb.read가 낸 값을 그대로 쓴다. 서빙 층은 필터를 만들지 않는다.
- 핵심 로직은 `execute()` 하나다. Starlette 엔드포인트(동기 def, 스레드풀)와 `kb api`(프로세스 안 호출)가 같은 함수를 부른다.
- 이 모듈의 최상위는 starlette, uvicorn을 임포트하지 않는다(`kb api`가 가볍게 뜬다). `build_app()`이 안에서 임포트한다.
- 쓰기 메서드는 없다. ops.db는 mode=ro로만 연다.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import parse_qsl

from kb import read as R
from kb.core import config as _config
from kb.core import paths as _paths
from kb.read import ctx as RC
import importlib
RE = importlib.import_module("kb.read.envelope")  # kb.read.envelope는 함수 이름이 하위 모듈을 가린다

# ------------------------------------------------------------------ RFC 9457 오류 본문

CT_PROBLEM = "application/problem+json"
RETRY_AFTER = {"read_timeout": "2", "not_ready": "5", "too_many_requests": "1"}


def problem_dict(status: int, code: str, detail: str, instance: str, param: str | None = None, title: str | None = None) -> dict:
    d = {"type": "https://kb.local/problems/" + code.replace("_", "-"), "title": title or code.replace("_", " "),
         "status": status, "detail": detail, "code": code, "instance": instance}
    if param:
        d["param"] = param
    return d


def dumps(obj) -> bytes:
    """HTTP 본문과 `kb api` 출력이 같은 바이트가 되도록 직렬화는 이 함수 하나만 쓴다."""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def problem_response(status: int, code: str, detail: str, instance: str, param: str | None = None,
                     extra_headers: list[tuple[str, str]] | None = None) -> tuple[int, list[tuple[str, str]], bytes]:
    body = dumps(problem_dict(status, code, detail, instance, param))
    hdr = [("content-type", CT_PROBLEM), ("cache-control", "no-store")]
    if code in RETRY_AFTER:
        hdr.append(("retry-after", RETRY_AFTER[code]))
    hdr += extra_headers or []
    return status, hdr, body


async def send_problem(send, status: int, code: str, detail: str, instance: str, extra_headers=None) -> None:
    """ASGI 미들웨어용 problem+json 응답."""
    st, hdr, body = problem_response(status, code, detail, instance, extra_headers=extra_headers)
    hdr = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in hdr] + [(b"content-length", str(len(body)).encode())]
    await send({"type": "http.response.start", "status": st, "headers": hdr})
    await send({"type": "http.response.body", "body": body})


# ------------------------------------------------------------------ 경로와 파라미터 허용 표(계약 4장)

F = ("types", "origin", "status", "domain", "source", "author", "include_unverified")
T = ("as_of_valid", "as_of_observed")


@dataclass(frozen=True)
class Route:
    op: str
    template: str
    params: tuple
    cache: str = "no-cache"      # Cache-Control
    etag: str = "data"           # data | meta | snapshot | manifest | export | none


ROUTES: tuple[Route, ...] = (
    Route("getMeta", "/v1/meta", (), etag="meta"),
    Route("getSchema", "/v1/schema", ()),
    Route("getOverview", "/v1/overview", F + T + ("edge_status", "rtypes", "limit", "edge_limit", "cursor")),
    Route("listNodes", "/v1/nodes", F + T + ("type", "ids", "filter", "sort", "cursor", "limit")),
    Route("getNode", "/v1/nodes/{id}", ("status", "include_unverified") + T + ("include", "claim_limit", "edge_limit", "backlink_limit"),
          cache="no-store"),
    Route("listNodeClaims", "/v1/nodes/{id}/claims", F + T + ("predicate", "cursor", "limit")),
    Route("listNodeEdges", "/v1/nodes/{id}/edges", F + T + ("direction", "rtypes", "cursor", "limit")),
    Route("getNodeBody", "/v1/nodes/{id}/body", T + ("start", "max_chars"), cache="no-store"),
    Route("getNodeNeighbors", "/v1/nodes/{id}/neighbors", F + T + ("edge_status", "depth", "rtypes", "direction", "limit", "edge_limit")),
    Route("getNodeHistory", "/v1/nodes/{id}/history", ("predicate",)),
    Route("getClaim", "/v1/claims/{id}", T),
    Route("getEdge", "/v1/edges/{id}", T),
    Route("search", "/v1/search", F + T + ("q", "mode", "kinds", "cursor", "limit"), cache="no-store"),
    Route("getFacets", "/v1/facets", F + T + ("q", "kinds", "filter")),
    Route("getCounts", "/v1/counts", F + T + ("bucket", "field")),
    Route("getSeries", "/v1/series/{id}", T + ("from", "to", "bucket")),
    Route("getSnapshot", "/v1/snapshots/{id}", ()),
    Route("getSnapshotText", "/v1/snapshots/{id}/text", ("start", "max_chars"), cache="no-store", etag="snapshot"),
    Route("getSnapshotRaw", "/v1/snapshots/{id}/raw", (), cache="no-store", etag="snapshot"),
    Route("listChanges", "/v1/changes", ("cursor", "limit", "kinds", "origin")),
    Route("getExportManifest", "/v1/export/graph/manifest", (), etag="manifest"),
    Route("getExportGraph", "/v1/export/graph", ("profile",), etag="export"),
    Route("getOpsFreshness", "/v1/ops/freshness", (), cache="no-store", etag="none"),
    Route("listOpsTickets", "/v1/ops/tickets", ("status", "cursor", "limit"), cache="no-store", etag="none"),
    Route("listOpsRuns", "/v1/ops/runs", ("cursor", "limit"), cache="no-store", etag="none"),
    Route("getOpsMetrics", "/v1/ops/metrics", (), cache="no-store", etag="none"),
)
BY_OP = {r.op: r for r in ROUTES}
PARAMS = {r.op: frozenset(r.params) for r in ROUTES}
_PATTERNS = [(re.compile("^" + re.sub(r"\{id\}", "([^/]+)", r.template) + "$"), r) for r in ROUTES]
# 최상위 경로 접두 순서가 모호하지 않도록 긴 템플릿부터 맞춘다.
_PATTERNS.sort(key=lambda x: -len(x[1].template))

MULTI = {"filter"}                      # 반복할 수 있는 파라미터
CTX_KEYS = {"types": "types", "origin": "origin", "status": "status", "domain": "domain", "source": "source",
            "author": "author", "include_unverified": "include_unverified", "as_of_valid": "as_of_valid",
            "as_of_observed": "as_of_observed", "edge_status": "edge_status"}
LIMIT_DEFAULTS = {"timeout_s": 5.0}


# ------------------------------------------------------------------ 설정

@dataclass
class ServeConfig:
    db_path: str | None = None
    deadline_s: float = 5.0
    max_concurrent: int = 16
    allowed_hosts: tuple = ("127.0.0.1", "localhost")
    idle_s: float = 600.0

    @classmethod
    def load(cls, db_path=None) -> "ServeConfig":
        from kb.serve.limits import check_max_concurrent
        hosts = _config.get("read.allowed_hosts") or ["127.0.0.1", "localhost"]
        return cls(db_path=str(db_path) if db_path else None,
                   deadline_s=float(_config.get("read.timeout_s", 5.0)),
                   max_concurrent=check_max_concurrent(_config.get("read.max_concurrent", 16)),
                   allowed_hosts=tuple(str(h) for h in hosts), idle_s=float(_config.get("read.idle_s", 600.0)))


@dataclass
class Resp:
    status: int
    headers: list = field(default_factory=list)
    body: bytes = b""


# ------------------------------------------------------------------ 토큰(계약 7장)

def tokens_path():
    return _paths.config_dir() / "api-tokens"


SCOPES = ("viewer", "owner")


def create_token(scope: str, label: str = "") -> str:
    """토큰 문자열은 이 호출의 반환값으로만 보인다. 파일에는 sha256만 쓴다(0600)."""
    if scope not in SCOPES:
        raise ValueError(f"scope는 {SCOPES} 중 하나")
    tok = f"kbt_{scope[0]}_" + secrets.token_urlsafe(32)
    p = tokens_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    line = f"{scope}\t{hashlib.sha256(tok.encode()).hexdigest()}\t{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}\t{label.replace(chr(9), ' ')}\n"
    fd = os.open(p, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, line.encode())
    finally:
        os.close(fd)
    os.chmod(p, 0o600)
    return tok


def token_scope(token: str) -> str | None:
    try:
        text = tokens_path().read_text(encoding="utf-8")
    except OSError:
        return None
    h = hashlib.sha256(token.encode()).hexdigest()
    found = None
    for ln in text.splitlines():
        parts = ln.split("\t")
        if len(parts) >= 2 and hmac.compare_digest(parts[1], h):
            found = parts[0]
    return found


def scope_sensitivity(scope: str) -> str:
    """viewer는 internal, owner는 private. secret은 어떤 토큰으로도 HTTP로 나가지 않는다.
    private 읽기 경로는 결정 14가 승인된 뒤에만 연다(기본 (c): 뷰어가 private를 보지 않는다)."""
    if scope == "owner" and _config.decision_ok(14):
        return "private"
    return "internal"


# ------------------------------------------------------------------ 보조

def _inm_match(header: str | None, etag: str) -> bool:
    if not header:
        return False
    for tok in header.split(","):
        t = tok.strip()
        if t == "*":
            return True
        if t.startswith("W/"):
            t = t[2:]
        if t == etag:
            return True
    return False


def _lower(h) -> dict:
    return {str(k).lower(): v for k, v in (h.items() if hasattr(h, "items") else h)}


def _problem(e_status: int, code: str, detail: str, path: str, param: str | None = None, extra=None) -> Resp:
    st, hdr, body = problem_response(e_status, code, detail, path, param, extra)
    hdr.append(("vary", "Authorization"))
    return Resp(st, hdr, body)


def _csv_hash(items) -> str:
    return hashlib.sha256(dumps(items)).hexdigest()[:8]


def _build_ctx(route: Route, p: dict, cfg: ServeConfig, max_sens: str) -> RC.ReadCtx:
    kw = {CTX_KEYS[k]: v for k, v in p.items() if k in CTX_KEYS and k in route.params}
    return RC.ReadCtx.build(max_sensitivity=max_sens, deadline_s=cfg.deadline_s, db_path=cfg.db_path, **kw)


def parse_query(route: Route, items) -> dict:
    """허용 목록 밖은 400 bad_param(param). 반복은 filter만 된다."""
    allowed = PARAMS[route.op]
    out: dict = {}
    for k, v in items:
        if k not in allowed:
            if k in T:    # 시점을 받지 않는 경로(2.9)는 무시하지 않고 400 as_of_unsupported다
                raise RC.AsOfUnsupported(f"{route.template}는 {k}를 받지 않는다", k)
            raise RC.BadParam(f"허용되지 않은 파라미터: {k}", k)
        if k in MULTI:
            out.setdefault(k, []).append(v)
        elif k in out:
            raise RC.BadParam(f"파라미터 중복: {k}", k)
        else:
            out[k] = v
    return out


def _gold_state(ctx: RC.ReadCtx) -> tuple[int, int, str, int]:
    """(epoch, applied_seq, build_id, seq). 가벼운 읽기 하나로 ETag를 만든다."""
    with RC.reading(ctx) as con:
        gm = RE.gold_meta(con)
        seq = int(gm.get("applied_seq") or 0)
        return int(gm.get("epoch") or 0) + 1, seq, gm.get("build_id") or "", seq


def _etag_data(ctx) -> str:
    e, s, b, _ = _gold_state(ctx)
    return f'"{e}-{s}-{b}"'


def _etag_meta(ctx) -> str:
    e, s, b, seq = _gold_state(ctx)
    return f'"{e}-{s}-{b}-{_csv_hash(RE._resolve_degraded(RE.degraded(), seq))}"'


# ------------------------------------------------------------------ ops.db 읽기(mode=ro)

def _ops_ro():
    from kb.core import opsdb
    p = opsdb.ops_path()
    if not p.exists():
        return None
    c = sqlite3.connect(p.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.5)
    c.row_factory = sqlite3.Row
    return c


def _iso(ms):
    return RC.iso(ms) if ms is not None else None


def _ops_runs_fn(con, ctx, cursor=None, limit=None):
    lim = RE.clamp_limit(limit, 100, 500)
    last = RE.read_cursor(con, ctx, cursor, ["ops_runs"])
    oc = _ops_ro()
    if oc is None:
        return {"items": []}, RE.page_obj(None, 0, False), ["ops_db_missing"]
    try:
        total = oc.execute("SELECT COUNT(*) FROM run").fetchone()[0]
        if last is None:
            rr = oc.execute("SELECT id, job, started_at, ended_at, outcome FROM run ORDER BY id DESC LIMIT ?", (lim + 1,)).fetchall()
        else:
            rr = oc.execute("SELECT id, job, started_at, ended_at, outcome FROM run WHERE id < ? ORDER BY id DESC LIMIT ?",
                            (int(last), lim + 1)).fetchall()
    except sqlite3.Error:
        return {"items": []}, RE.page_obj(None, 0, False), ["ops_db_unreadable"]
    finally:
        oc.close()
    more = len(rr) > lim
    rr = rr[:lim]
    items = [{"job": r["job"], "started_at": _iso(r["started_at"]), "ended_at": _iso(r["ended_at"]), "outcome": r["outcome"]} for r in rr]
    nxt = RE.make_cursor(con, ctx, k=rr[-1]["id"], fh_parts=["ops_runs"]) if more else None
    return {"items": items}, RE.page_obj(nxt, total, more), []


def _ops_metrics_fn(con, ctx):
    oc = _ops_ro()
    if oc is None:
        return {"items": []}, None, ["ops_db_missing"]
    try:
        rr = oc.execute("SELECT m.at, m.name, m.dims, m.value FROM metric m WHERE m.at = (SELECT MAX(x.at) FROM metric x "
                        "WHERE x.name=m.name AND COALESCE(x.dims,'')=COALESCE(m.dims,'')) ORDER BY m.name, COALESCE(m.dims,'') LIMIT 2000").fetchall()
    except sqlite3.Error:
        return {"items": []}, None, ["ops_db_unreadable"]
    finally:
        oc.close()
    items = []
    for r in rr:
        try:
            dims = json.loads(r["dims"]) if r["dims"] else None
        except ValueError:
            dims = None
        items.append({"name": r["name"], "dims": dims if isinstance(dims, dict) else None, "value": float(r["value"]), "at": _iso(r["at"])})
    return {"items": items}, None, []


def _ops_freshness_fn(con, ctx):
    oc = _ops_ro()
    deg: list = []
    states: dict = {}
    if oc is None:
        deg.append("ops_db_missing")
    else:
        try:
            for r in oc.execute("SELECT source_id, last_ok_at, state FROM source_state"):
                states[r["source_id"]] = (r["last_ok_at"], r["state"])
        except sqlite3.Error:
            deg.append("ops_db_unreadable")
        finally:
            oc.close()
    srcs, classes = [], {}
    try:
        from kb.collect import registry
        srcs = [s for s in registry.load_registry(validate=False) if s.enabled]
        classes = registry.load_classes().get("classes") or {}
    except Exception:  # noqa: BLE001 레지스트리가 깨져도 읽기는 산다
        deg.append("registry_unreadable")
    now = int(time.time() * 1000)
    by_class: dict = {}
    out = []
    for s in sorted(srcs, key=lambda x: x.id):
        cls = s.class_ or "none"
        last_ok, state = states.get(s.id, (None, "pending"))
        lim = (classes.get(cls) or {}).get("stale_s")
        stale = bool(lim and last_ok and now - last_ok > float(lim) * 1000)
        out.append({"source_id": s.id, "class": cls, "last_ok_at": _iso(last_ok), "state": state, "stale": stale})
        c = by_class.setdefault(cls, [0, 0])
        c[0] += 1
        c[1] += 1 if stale else 0
    data = {"classes": [{"class": k, "total": v[0], "stale": v[1]} for k, v in sorted(by_class.items())],
            "sources": out, "gaps": []}
    return data, None, deg


# ------------------------------------------------------------------ 핸들러: (route, ctx, id, p, hdr) -> Resp 조각

def _envelope_call(ctx, fn, *a, extra_degraded=None, **kw) -> dict:
    with RC.reading(ctx) as con:
        out = fn(con, ctx, *a, **kw)
        page = None
        extra = list(extra_degraded or [])
        if isinstance(out, tuple):
            data, page = out[0], out[1]
            if len(out) > 2:
                extra += out[2]
        else:
            data = out
        return RE.envelope(con, ctx, data, page=page, extra_degraded=extra)


def _call(route: Route, ctx, nid, p, cfg) -> dict:
    op = route.op
    g = p.get
    if op == "getMeta":
        return _envelope_call(ctx, R.meta, concurrent=cfg.max_concurrent)
    if op == "getSchema":
        return _envelope_call(ctx, R.catalog)
    if op == "getOverview":
        return _envelope_call(ctx, R.overview, rtypes=g("rtypes"), limit=g("limit"), edge_limit=g("edge_limit"), cursor=g("cursor"))
    if op == "listNodes":
        return _envelope_call(ctx, R.list_nodes, type=g("type"), ids=g("ids"), filter=g("filter") or None, sort=g("sort"),
                              cursor=g("cursor"), limit=g("limit"))
    if op == "getNode":
        kw = {"include": g("include")} if "include" in p else {}
        return _envelope_call(ctx, R.get_node, nid, claim_limit=g("claim_limit"), edge_limit=g("edge_limit"),
                              backlink_limit=g("backlink_limit"), **kw)
    if op == "listNodeClaims":
        return _envelope_call(ctx, R.node_claims, nid, predicate=g("predicate"), cursor=g("cursor"), limit=g("limit"))
    if op == "listNodeEdges":
        return _envelope_call(ctx, R.node_edges, nid, direction=g("direction", "both"), rtypes=g("rtypes"), cursor=g("cursor"),
                              limit=g("limit"))
    if op == "getNodeBody":
        return _envelope_call(ctx, R.node_body, nid, start=g("start", 0), max_chars=g("max_chars"))
    if op == "getNodeNeighbors":
        return _envelope_call(ctx, R.neighbors, nid, depth=g("depth", 1), rtypes=g("rtypes"), direction=g("direction", "both"),
                              limit=g("limit"), edge_limit=g("edge_limit"))
    if op == "getNodeHistory":
        return _envelope_call(ctx, R.history, nid, predicate=g("predicate"))
    if op == "getClaim":
        return _envelope_call(ctx, R.get_claim, nid)
    if op == "getEdge":
        return _envelope_call(ctx, R.get_edge, nid)
    if op == "search":
        from kb.read import search as S
        if not g("q"):
            raise RC.BadParam("q가 필요하다", "q")
        return S.search(g("q"), ctx, mode=g("mode", "lexical"), kinds=g("kinds"), limit=g("limit"), cursor=g("cursor"))
    if op == "getFacets":
        if g("q"):
            from kb.read import search as S
            return S.search_facets(g("q"), ctx, kinds=g("kinds"), filter=g("filter") or None)
        return _envelope_call(ctx, R.facets, filter=g("filter") or None)
    if op == "getCounts":
        return _envelope_call(ctx, R.counts, bucket=g("bucket", "day"), field=g("field", "recorded_at"))
    if op == "getSeries":
        return _envelope_call(ctx, R.series, nid, from_=g("from"), to=g("to"), bucket=g("bucket"))
    if op == "getSnapshot":
        return _envelope_call(ctx, R.snapshot_meta, nid)
    if op == "getSnapshotText":
        return _envelope_call(ctx, R.snapshot_text, nid, start=g("start", 0), max_chars=g("max_chars"))
    if op == "listChanges":
        return _envelope_call(ctx, R.changes, cursor=g("cursor"), limit=g("limit"), kinds=g("kinds"), origin=g("origin"))
    if op == "listOpsTickets":
        return _envelope_call(ctx, R.tickets, status=g("status"), cursor=g("cursor"), limit=g("limit"))
    if op == "listOpsRuns":
        return _envelope_call(ctx, _ops_runs_fn, cursor=g("cursor"), limit=g("limit"))
    if op == "getOpsMetrics":
        return _envelope_call(ctx, _ops_metrics_fn)
    if op == "getOpsFreshness":
        return _envelope_call(ctx, _ops_freshness_fn)
    raise RuntimeError(f"처리기 없음: {op}")


def _ops_without_gold(route: Route, ctx, p) -> dict:
    """graph.db가 아직 없어도 ops 경로는 빈 값과 degraded를 준다."""
    from kb.read.ctx import iso
    deg = ["graph_not_ready"]
    if route.op == "getOpsFreshness":
        data, _, d = _ops_freshness_fn(None, ctx)
    elif route.op == "getOpsMetrics":
        data, _, d = _ops_metrics_fn(None, ctx)
    elif route.op == "listOpsRuns":
        data, d = {"items": []}, ["ops_db_unavailable"]
    else:
        data, d = {"items": []}, []
    env = {"schema_version": RE.SCHEMA_VERSION, "epoch": 1, "build_id": "", "data_as_of": None, "applied_seq": 0,
           "as_of": {"valid": iso(ctx.as_of_valid), "observed": iso(ctx.as_of_observed)}, "degraded": deg + d, "data": data}
    if route.op in ("listOpsRuns", "listOpsTickets"):
        env["page"] = RE.page_obj(None, 0, False)
    return env


def _published():
    from kb import publish
    return publish.current()


def _headers(route: Route, etag: str | None, extra=()) -> list:
    h = [("cache-control", route.cache), ("vary", "Authorization")]
    if etag and route.etag != "none":
        h.append(("etag", etag))
    return h + list(extra)


def _not_modified(route, etag) -> Resp:
    return Resp(304, _headers(route, etag))


def execute(route: Route, nid: str | None, query_items, headers, cfg: ServeConfig, max_sens: str = "internal",
            method: str = "GET", path: str | None = None) -> Resp:
    """한 요청을 처리한다. 예외는 전부 problem+json으로 바꿔 돌려준다."""
    path = path or route.template.replace("{id}", nid or "")
    h = _lower(headers)
    try:
        if method not in ("GET", "HEAD"):
            return _problem(405, "method_not_allowed", "GET, HEAD만 받는다", path, extra=[("allow", "GET, HEAD")])
        p = parse_query(route, query_items)
        ctx = _build_ctx(route, p, cfg, max_sens)
        inm = h.get("if-none-match")
        op = route.op
        # --- 불변, 게시 경로는 본문 전에 판단한다(304는 가장 싸다)
        if op in ("getSnapshotText", "getSnapshotRaw"):
            return _snapshot_binary(route, ctx, nid, p, h, path)
        if op in ("getExportManifest", "getExportGraph"):
            return _export(route, ctx, p, inm, path)
        if inm and route.etag in ("data", "meta"):
            et = _etag_meta(ctx) if route.etag == "meta" else _etag_data(ctx)
            if _inm_match(inm, et):
                return _not_modified(route, et)
        try:
            env = _call(route, ctx, nid, p, cfg)
        except RC.NotReady:
            if route.etag != "none":
                raise
            env = _ops_without_gold(route, ctx, p)
        et = None
        if route.etag == "data":
            et = RE.etag(env)
        elif route.etag == "meta":
            et = RE.etag(env)[:-1] + f'-{_csv_hash(env["degraded"])}"'
        return Resp(200, [("content-type", "application/json")] + _headers(route, et), dumps(env))
    except RC.ReadError as e:
        return _problem(e.status, e.code, e.detail, path, getattr(e, "param", None))
    except Exception as e:  # noqa: BLE001
        print(f"kb serve: 처리 중 예외 {path}: {type(e).__name__}: {e}", file=sys.stderr)
        return _problem(500, "internal", "처리 중 예외", path)


def _snapshot_binary(route, ctx, sid, p, h, path) -> Resp:
    """/text, /raw. ETag는 스냅샷 ID이고 불변이다. 삭제 여부를 먼저 본다(삭제됐으면 If-None-Match가 맞아도 410)."""
    et = f'"{sid}"'
    inm = h.get("if-none-match")
    if route.op == "getSnapshotRaw":
        match = _inm_match(inm, et)
        with RC.reading(ctx) as con:
            data, hdr, st = R.snapshot_raw(con, ctx, sid, range_header=None if match else h.get("range"))
        if match:
            return _not_modified(route, et)
        out = [(k.lower(), v) for k, v in hdr.items()] + [("cache-control", route.cache), ("vary", "Authorization")]
        return Resp(st, out, data)
    # text: 본문이 지워졌는지 확인하려면 읽어야 한다
    with RC.reading(ctx) as con:
        data = R.snapshot_text(con, ctx, sid, start=p.get("start", 0), max_chars=p.get("max_chars"))
        if _inm_match(inm, et):
            return _not_modified(route, et)
        env = RE.envelope(con, ctx, data)
    return Resp(200, [("content-type", "application/json")] + _headers(route, et), dumps(env))


def _export(route, ctx, p, inm, path) -> Resp:
    pub = _published()
    if pub is None:
        raise RC.NotReady("첫 게시 전")
    if route.op == "getExportManifest":
        et = f'"{pub.manifest["build_id"]}"'
        if _inm_match(inm, et):
            return _not_modified(route, et)
        env = _envelope_call(ctx, lambda con, c: pub.manifest)
        return Resp(200, [("content-type", "application/json")] + _headers(route, et), dumps(env))
    prof = p.get("profile", "core")
    if prof not in ("core", "full"):
        raise RC.BadParam(f"profile 값 오류: {prof!r}", "profile")
    et = f'"{pub.manifest["profiles"][prof]["sha256"]}"'
    if _inm_match(inm, et):
        return _not_modified(route, et)
    data = pub.read(prof)
    return Resp(200, [("content-type", "application/zstd")] + _headers(route, et), data)


# ------------------------------------------------------------------ 프로세스 안 호출(kb api, 시험)

def match_route(path: str):
    for pat, r in _PATTERNS:
        m = pat.match(path)
        if m:
            return r, (m.group(1) if m.groups() else None)
    return None, None


def respond(target: str, headers=None, cfg: ServeConfig | None = None, max_sens: str = "internal", method: str = "GET") -> Resp:
    """`/v1/...?query` 문자열을 같은 처리기로 돌린다. `kb api`가 쓴다."""
    cfg = cfg or ServeConfig.load()
    path, _, qs = target.partition("?")
    route, nid = match_route(path)
    if route is None:
        return _problem(404, "not_found", "없는 경로", path)
    from urllib.parse import unquote
    return execute(route, unquote(nid) if nid else None, parse_qsl(qs, keep_blank_values=True), headers or {}, cfg, max_sens, method, path)


# ------------------------------------------------------------------ ASGI 앱

class TokenAuth:
    """TCP는 Bearer 필수. Unix 소켓은 파일 권한이 인증이고 범위는 internal 이하다."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        srv = scope.get("server")
        unix = srv is None or srv[1] is None
        if unix:
            scope["kb_max_sens"] = "internal"
            return await self.app(scope, receive, send)
        auth = None
        for k, v in scope.get("headers") or []:
            if k == b"authorization":
                auth = v.decode("latin-1")
                break
        if not auth or not auth.lower().startswith("bearer "):
            return await send_problem(send, 401, "token_required", "Bearer 토큰이 필요하다", scope["path"],
                                      extra_headers=[("www-authenticate", "Bearer")])
        sc = token_scope(auth[7:].strip())
        if sc is None:
            return await send_problem(send, 401, "token_invalid", "토큰이 맞지 않는다", scope["path"],
                                      extra_headers=[("www-authenticate", "Bearer")])
        scope["kb_max_sens"] = scope_sensitivity(sc)
        return await self.app(scope, receive, send)


def build_app(cfg: ServeConfig | None = None, *, idle=None):
    """미들웨어 순서: IdleTracker > HostGuard > ConcurrencyLimit > TokenAuth > Starlette."""
    from starlette.applications import Starlette
    from starlette.exceptions import HTTPException
    from starlette.responses import Response
    from starlette.routing import Route as SRoute

    from kb.serve.hostguard import HostGuard
    from kb.serve.idle import IdleTracker
    from kb.serve.limits import ConcurrencyLimit

    cfg = cfg or ServeConfig.load()
    from kb.serve.limits import check_max_concurrent
    check_max_concurrent(cfg.max_concurrent)

    def make(route: Route):
        def endpoint(request):
            r = execute(route, request.path_params.get("id"), request.query_params.multi_items(), request.headers, cfg,
                        request.scope.get("kb_max_sens", "internal"), request.method, request.url.path)
            return Response(r.body, r.status, headers=_dedupe(r.headers))
        return endpoint

    def _dedupe(hs):
        d: dict = {}
        for k, v in hs:
            d[k] = v
        return d

    async def on_http_exc(request, exc):
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "internal")
        extra = [(k, v) for k, v in (exc.headers or {}).items()]
        if exc.status_code == 405 and not extra:
            extra = [("allow", "GET, HEAD")]
        r = _problem(exc.status_code, code, "없는 경로" if exc.status_code == 404 else "GET, HEAD만 받는다", request.url.path, extra=extra)
        return Response(r.body, r.status, headers=_dedupe(r.headers))

    async def on_error(request, exc):
        print(f"kb serve: 처리 중 예외 {request.url.path}: {type(exc).__name__}: {exc}", file=sys.stderr)
        r = _problem(500, "internal", "처리 중 예외", request.url.path)
        return Response(r.body, r.status, headers=_dedupe(r.headers))

    routes = [SRoute(r.template, make(r), methods=["GET", "HEAD"], name=r.op) for r in ROUTES]
    star = Starlette(routes=routes, exception_handlers={404: on_http_exc, 405: on_http_exc, HTTPException: on_http_exc, Exception: on_error})
    star.router.redirect_slashes = False
    app = TokenAuth(star)
    app = ConcurrencyLimit(app, cfg.max_concurrent)
    app = HostGuard(app, cfg.allowed_hosts)
    tracker = idle if idle is not None else IdleTracker(None, cfg.idle_s)
    tracker.app = app
    return tracker


# ------------------------------------------------------------------ ASGI 직접 호출(시험, 부하)

async def asgi_call(app, method: str, target: str, headers=None, server=("/run/kb.sock", None), client=None) -> Resp:
    """서버 없이 ASGI 앱을 한 번 부른다. server=(host, port)로 전송을 흉내 낸다(port=None이면 Unix 소켓)."""
    path, _, qs = target.partition("?")
    hs = [(b"host", b"localhost")] if not headers or "host" not in _lower(headers) else []
    for k, v in (headers or {}).items():
        hs.append((k.lower().encode(), str(v).encode("latin-1")))
    from urllib.parse import unquote
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method, "scheme": "http",
             "path": unquote(path), "raw_path": path.encode(), "query_string": qs.encode(), "root_path": "",
             "headers": hs, "client": client, "server": server}
    sent: list = []
    body_done = False

    async def receive():
        nonlocal body_done
        if not body_done:
            body_done = True
            return {"type": "http.request", "body": b"", "more_body": False}
        return {"type": "http.disconnect"}

    async def send(msg):
        sent.append(msg)

    try:
        await app(scope, receive, send)
    except Exception:    # ServerErrorMiddleware는 응답을 보낸 뒤 예외를 다시 던진다(uvicorn은 로그만 남긴다)
        if not any(m["type"] == "http.response.start" for m in sent):
            raise
    status, hdr, body = 500, [], b""
    for m in sent:
        if m["type"] == "http.response.start":
            status = m["status"]
            hdr = [(k.decode("latin-1"), v.decode("latin-1")) for k, v in m["headers"]]
        elif m["type"] == "http.response.body":
            body += m.get("body", b"")
    return Resp(status, hdr, b"" if method == "HEAD" else body)
