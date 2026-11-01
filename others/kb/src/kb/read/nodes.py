"""노드 읽기(WP-04): 상세, 주장, 엣지, 본문, 주장·엣지 단건, 표 보기(filter, sort, ids)."""
from __future__ import annotations

import json
import unicodedata

from kb.core import ids as _ids
from kb.read.catalog import type_properties
from kb.read.ctx import (NEIGHBOR_EXCLUDED, SENS_NAME, BadParam, ContentRemoved, LimitTooLarge, NotFound, ReadCtx,
                         chunks, finals, group_of, iso, row, rows, touching_sql, visibility_sql)
from kb.read.envelope import clamp_limit, make_cursor, page_obj, read_cursor

INCLUDE_ALL = ("claims", "edges", "backlinks", "body")
BACKLINK_RTYPES = ("LINKS_TO", "MENTIONS")
BODY_DETAIL_CHARS = 200_000
NOT_NODE_PREFIXES = ("r-", "ev-")


# ------------------------------------------------------------------ 객체 변환

def valid_obj(r: dict) -> dict:
    prec, vf, vt = r.get("valid_precision"), r.get("valid_from"), r.get("valid_to")
    if vf is None and vt is None and prec is None:
        return {"from": None, "to": None, "precision": None, "label": None}

    def fmt(ms):
        if ms is None:
            return None
        s = iso(ms)
        return s if prec == "instant" or prec is None else s[:10]

    label = None
    if vf is not None and prec in ("month", "quarter", "year"):
        y, m = int(iso(vf)[:4]), int(iso(vf)[5:7])
        label = {"year": f"{y}", "month": f"{y}-{m:02d}", "quarter": f"{y}-Q{(m - 1) // 3 + 1}"}[prec]
    return {"from": fmt(vf), "to": fmt(vt), "precision": prec, "label": label}


def _json(b):
    if b is None:
        return {}
    try:
        v = json.loads(b)
    except (ValueError, TypeError):
        return {}
    return v if isinstance(v, dict) else {}


def domains_for(con, id_list) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {i: [] for i in id_list}
    for ch in chunks(set(id_list)):
        for r in rows(con, f"SELECT node_id, domain FROM node_domain WHERE node_id IN ({','.join('?' * len(ch))}) ORDER BY domain", ch):
            out[r["node_id"]].append(r["domain"])
    return out


def evidence_for(con, claim_ids) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {c: [] for c in claim_ids}
    for ch in chunks(set(claim_ids)):
        for r in rows(con, f"SELECT * FROM evidence WHERE claim_id IN ({','.join('?' * len(ch))}) ORDER BY claim_id, id", ch):
            out[r["claim_id"]].append({
                "id": r["id"], "snapshot_id": r["snapshot_id"], "selector_kind": r["selector_kind"], "exact": r["exact"],
                "prefix": r["prefix"], "suffix": r["suffix"], "start": r["start_cp"], "end": r["end_cp"],
                "json_pointer": r["json_pointer"], "evidence_state": r["evidence_state"], "support_check": r["support_check"],
                "last_confirmed_at": iso(r["last_confirmed_at"])})
    return out


def node_objs(con, noderows: list[dict], *, evidence: bool = True, fin: dict | None = None) -> list[dict]:
    """노드 행들을 Node 객체로 바꾼다. Claim 행은 Claim 필드를 더한다. 도메인, 주장 열, 근거는 일괄 조회한다."""
    if not noderows:
        return []
    fin = finals(con) if fin is None else fin
    doms = domains_for(con, [r["id"] for r in noderows])
    claim_vids = [r["vid"] for r in noderows if r["type"] == "Claim"]
    crow: dict[int, dict] = {}
    for ch in chunks(claim_vids):
        for r in rows(con, f"SELECT * FROM claim WHERE vid IN ({','.join('?' * len(ch))})", ch):
            crow[r["vid"]] = r
    ev = evidence_for(con, [r["id"] for r in noderows if r["type"] == "Claim"]) if evidence else {}
    out = []
    for r in noderows:
        d = {"id": r["id"], "type": r["type"], "label": r["label"], "origin": r["origin"], "status": r["eff_status"],
             "liveness": r["liveness"], "verification": r["verification"], "link_status": r["link_status"],
             "sensitivity": SENS_NAME[r["sensitivity"]], "domain": doms[r["id"]], "version": r["version"],
             "merged_into": r["merged_into"], "merged_into_final": fin.get(r["id"]) if r["merged_into"] else None,
             "valid": valid_obj(r), "recorded_at": iso(r["recorded_at"]), "expired_at": iso(r["expired_at"]),
             "author": r["author"], "generated_by": r["generated_by"], "on_behalf_of": r["on_behalf_of"],
             "body_format": r["body_format"], "props": _json(r["props"])}
        c = crow.get(r["vid"])
        if c is not None:
            d.update(subject=c["subject"], predicate=c["predicate"], object=c["object"], value=c["value"], unit=c["unit"],
                     qualifiers=_json(c["qualifiers"]), statement=c["statement"], own_status=r["status"],
                     status_basis="own" if r["status"] == r["eff_status"] else "subject", kind=c["kind"],
                     stance=c["stance"], speaker=c["speaker"], method=c["method"], conflict_group=c["conflict_group"])
            if evidence:
                d["evidence"] = ev.get(r["id"], [])
        out.append(d)
    return out


def current_nodes(con, ids_) -> dict[str, dict]:
    """ID -> 현재 노드 행(표시용 라벨, 타입 조회). 필터를 걸지 않는다."""
    out: dict[str, dict] = {}
    for ch in chunks(set(ids_)):
        for r in rows(con, f"SELECT id, type, label FROM node WHERE id IN ({','.join('?' * len(ch))}) AND expired_at IS NULL", ch):
            out[r["id"]] = r
    return out


# ------------------------------------------------------------------ 대상 조회

def _check_id(nid: str, *, prefix: str | None = None) -> str:
    try:
        _ids.check_public_id(nid)
    except ValueError as e:
        raise NotFound("없음") from e
    if prefix is not None and not nid.startswith(prefix):
        raise NotFound("없음")
    return nid


def target_row(con, ctx: ReadCtx, nid: str, *, mode: str = "target") -> dict:
    _check_id(nid)
    if nid.startswith(NOT_NODE_PREFIXES):
        raise NotFound("노드가 아님")
    w, p = visibility_sql(ctx, "n", mode=mode)
    r = row(con, f"SELECT n.* FROM node n WHERE n.id=? AND {w} ORDER BY n.version DESC LIMIT 1", [nid, *p])
    if r is None:
        raise NotFound("없음")
    return r


def _free(ctx: ReadCtx, **kw) -> ReadCtx:
    """묶음 조회용 문맥: 타입 필터를 비운다. 상태, 검증, 시점은 유지한다."""
    return ctx.with_(types=None, exclude_types=(), **kw)


# ------------------------------------------------------------------ 주장, 엣지 묶음

def _claim_page(con, ctx, group, predicate, after, limit):
    w, p = visibility_sql(_free(ctx), "n")
    ph = ",".join("?" * len(group))
    sql = f"SELECT n.* FROM node n JOIN claim c ON c.vid=n.vid WHERE c.subject IN ({ph}) AND {w}"
    args = [*group, *p]
    if predicate:
        sql += " AND c.predicate=?"
        args.append(predicate)
    if after is not None:
        sql += " AND n.id > ?"
        args.append(after)
    sql += " ORDER BY n.id LIMIT ?"
    return rows(con, sql, [*args, limit + 1])


def _edge_q(ctx, group, direction, rtypes, peer_types=None):
    w, p = visibility_sql(ctx, "e", kind="edge")
    ph = ",".join("?" * len(group))
    side, args = touching_sql(ctx, group, direction)
    where = f"{side} AND NOT (e.src IN ({ph}) AND e.dst IN ({ph}) AND e.src<>e.dst) AND {w}"
    args += [*group, *group, *p]
    if rtypes:
        where += f" AND e.rtype IN ({','.join('?' * len(rtypes))})"
        args += list(rtypes)
    if peer_types:
        where += (f" AND (SELECT pn.type FROM node pn WHERE pn.id=(CASE WHEN e.src IN ({ph}) THEN e.dst ELSE e.src END) "
                  f"AND pn.expired_at IS NULL) IN ({','.join('?' * len(peer_types))})")
        args += [*group, *peer_types]
    return where, args


def _edge_page(con, ctx, group, direction, rtypes, after, limit, peer_types=None):
    where, args = _edge_q(ctx, group, direction, rtypes, peer_types)
    if after is not None:
        where += " AND e.id > ?"
        args.append(after)
    return rows(con, f"SELECT e.* FROM edge e WHERE {where} ORDER BY e.id LIMIT ?", [*args, limit + 1])


def _edge_count(con, ctx, group, direction, rtypes, peer_types=None):
    where, args = _edge_q(ctx, group, direction, rtypes, peer_types)
    return row(con, f"SELECT COUNT(*) c FROM edge e WHERE {where}", args)["c"]


def edge_refs(con, erows: list[dict], group, fin: dict) -> list[dict]:
    """EdgeRef. peer는 group 밖 끝점의 최종 대상(group 밖이 없으면 반대쪽)."""
    gs = set(group)
    peers = {}
    for e in erows:
        pid = e["dst"] if e["src"] in gs else e["src"]
        peers[e["id"]] = fin.get(pid, pid)
    cn = current_nodes(con, peers.values())
    out = []
    for e in erows:
        pr = cn.get(peers[e["id"]])
        d = {"id": e["id"], "rtype": e["rtype"], "src": e["src"], "dst": e["dst"], "status": e["status"],
             "claim_id": e["claim_id"],
             "peer": {"id": peers[e["id"]], "type": pr["type"] if pr else "", "label": pr["label"] if pr else ""}}
        out.append(d)
    return out


def _backlinks(con, ctx, group, limit):
    w, p = visibility_sql(ctx, "e", kind="edge")
    ph = ",".join("?" * len(group))
    rr = rows(con, f"SELECT e.src, e.rtype, e.id FROM edge e WHERE e.dst IN ({ph}) AND e.rtype IN ('LINKS_TO','MENTIONS') AND {w} "
                   f"ORDER BY e.src, e.rtype, e.id LIMIT ?", [*group, *p, limit + 1])
    cn = current_nodes(con, [r["src"] for r in rr])
    out = [{"id": r["src"], "type": cn[r["src"]]["type"], "label": cn[r["src"]]["label"], "rtype": r["rtype"]}
           for r in rr if r["src"] in cn]
    return out[:limit], len(rr) > limit


def _body(con, r: dict) -> str | None:
    if not r.get("content_sha"):
        return None
    b = row(con, "SELECT body FROM content WHERE sha=?", (r["content_sha"],))
    return b["body"] if b else None


# ------------------------------------------------------------------ 상세

def get_node(con, ctx: ReadCtx, nid: str, *, include=("claims", "edges"), claim_limit=None, edge_limit=None,
             backlink_limit=None) -> dict:
    """/v1/nodes/{id}. include 묶음은 id 오름차순으로 자르고 묶음별 truncated를 준다."""
    if isinstance(include, str):
        include = tuple(x for x in include.split(",") if x)
    for x in include:
        if x not in INCLUDE_ALL:
            raise BadParam(f"include 값 오류: {x!r}", "include")
    cl = clamp_limit(claim_limit, 50, 200, "claim_limit")
    el = clamp_limit(edge_limit, 100, 500, "edge_limit")
    bl = clamp_limit(backlink_limit, 100, 500, "backlink_limit")
    r = target_row(con, ctx, nid)
    fin = finals(con)
    d = node_objs(con, [r], fin=fin)[0]
    group = group_of(con, nid)
    if "claims" in include:
        cr = _claim_page(con, ctx, group, None, None, cl)
        d["claims"] = node_objs(con, cr[:cl], fin=fin)
        d["claims_truncated"] = len(cr) > cl
    if "edges" in include:
        out_ = _edge_page(con, ctx, group, "out", None, None, el)
        in_ = _edge_page(con, ctx, group, "in", None, None, el)
        d["edges"] = {"out": edge_refs(con, out_[:el], group, fin), "in": edge_refs(con, in_[:el], group, fin),
                      "truncated": len(out_) > el or len(in_) > el}
    if "backlinks" in include:
        d["backlinks"], d["backlinks_truncated"] = _backlinks(con, ctx, group, bl)
    if "body" in include:
        body = _body(con, r)
        d["body_chars"] = len(body) if body is not None else None
        d["body"] = body[:BODY_DETAIL_CHARS] if body is not None else None
    t = r["type"]
    if t == "Claim":
        d["claim"] = claim_detail(con, ctx, r, fin=fin)
    elif t == "Snapshot":
        from kb.read.snapshots import snapshot_obj
        d["snapshot"] = snapshot_obj(con, ctx, r)
    elif t == "Series":
        props = _json(r["props"])
        d["series"] = {"id": r["id"], "metric": props.get("metric") or "", "unit": props.get("unit")}
    return d


def claim_detail(con, ctx, r: dict, *, fin=None) -> dict:
    d = node_objs(con, [r], fin=fin)[0]
    w, p = visibility_sql(ctx, "n", mode="history")
    vr = rows(con, f"SELECT n.* FROM node n WHERE n.id=? AND {w} ORDER BY n.version", [r["id"], *p])
    d["versions"] = node_objs(con, vr, evidence=False, fin=fin)
    return d


def get_claim(con, ctx: ReadCtx, cid: str) -> dict:
    r = target_row(con, ctx, cid, mode="direct")
    if r["type"] != "Claim":
        raise NotFound("주장이 아님")
    return claim_detail(con, ctx, r)


def _edge_obj(e: dict) -> dict:
    return {"id": e["id"], "src": e["src"], "dst": e["dst"], "rtype": e["rtype"], "status": e["status"],
            "sensitivity": SENS_NAME[e["sensitivity"]], "version": e["version"], "claim_id": e["claim_id"],
            "valid": valid_obj({"valid_from": e["valid_from"], "valid_to": e["valid_to"], "valid_precision": None}),
            "recorded_at": iso(e["recorded_at"]), "expired_at": iso(e["expired_at"]), "props": _json(e["props"])}


def get_edge(con, ctx: ReadCtx, eid: str) -> dict:
    _check_id(eid, prefix="r-")
    w, p = visibility_sql(ctx, "e", kind="edge", mode="direct")
    e = row(con, f"SELECT e.* FROM edge e WHERE e.id=? AND {w} ORDER BY e.version DESC LIMIT 1", [eid, *p])
    if e is None:
        raise NotFound("없음")
    hw, hp = visibility_sql(ctx, "e", kind="edge", mode="history")
    vers = rows(con, f"SELECT e.* FROM edge e WHERE e.id=? AND {hw} ORDER BY e.version", [eid, *hp])
    d = _edge_obj(e)
    d["versions"] = [_edge_obj(v) for v in vers]
    d["claim"] = None
    if e["claim_id"]:
        try:
            d["claim"] = get_claim(con, ctx.with_(as_of_valid=None), e["claim_id"])
        except NotFound:
            d["claim"] = None
    return d


# ------------------------------------------------------------------ 주장/엣지 목록(커서)

def _require_visible(con, ctx, nid):
    return target_row(con, ctx, nid)


def node_claims(con, ctx: ReadCtx, nid: str, *, predicate: str | None = None, cursor: str | None = None, limit=None):
    """/v1/nodes/{id}/claims -> (data, page)."""
    lim = clamp_limit(limit, 100, 500)
    _require_visible(con, ctx, nid)
    fh = ["claims", nid, predicate]
    after = read_cursor(con, ctx, cursor, fh)
    group = group_of(con, nid)
    cr = _claim_page(con, ctx, group, predicate, after, lim)
    page_rows = cr[:lim]
    more = len(cr) > lim
    w, p = visibility_sql(_free(ctx), "n")
    ph = ",".join("?" * len(group))
    total = row(con, f"SELECT COUNT(*) c FROM node n JOIN claim c ON c.vid=n.vid WHERE c.subject IN ({ph}) AND {w}"
                + (" AND c.predicate=?" if predicate else ""), [*group, *p] + ([predicate] if predicate else []))["c"]
    nxt = make_cursor(con, ctx, k=page_rows[-1]["id"], fh_parts=fh) if more else None
    return {"items": node_objs(con, page_rows)}, page_obj(nxt, total, more)


def node_edges(con, ctx: ReadCtx, nid: str, *, direction: str = "both", rtypes=None, cursor: str | None = None, limit=None):
    """/v1/nodes/{id}/edges -> (data, page). ctx.types는 반대쪽 노드 타입이다."""
    if direction not in ("out", "in", "both"):
        raise BadParam(f"direction 값 오류: {direction!r}", "direction")
    if isinstance(rtypes, str):
        rtypes = tuple(x for x in rtypes.split(",") if x)
    lim = clamp_limit(limit, 100, 500)
    _require_visible(con, ctx, nid)
    fh = ["edges", nid, direction, list(rtypes or ()), list(ctx.types or ())]
    after = read_cursor(con, ctx, cursor, fh)
    group = group_of(con, nid)
    er = _edge_page(con, ctx, group, direction, rtypes, after, lim, ctx.types)
    page_rows = er[:lim]
    more = len(er) > lim
    nxt = make_cursor(con, ctx, k=page_rows[-1]["id"], fh_parts=fh) if more else None
    total = _edge_count(con, ctx, group, direction, rtypes, ctx.types)
    return {"items": edge_refs(con, page_rows, group, finals(con))}, page_obj(nxt, total, more)


def node_body(con, ctx: ReadCtx, nid: str, *, start: int = 0, max_chars=None) -> dict:
    """/v1/nodes/{id}/body. 단위는 코드포인트."""
    mc = clamp_limit(max_chars, 20_000, 200_000, "max_chars")
    try:
        start = int(start or 0)
    except (TypeError, ValueError) as e:
        raise BadParam("start 형식 오류", "start") from e
    if start < 0:
        raise BadParam("start는 0 이상", "start")
    r = target_row(con, ctx, nid)
    if r["content_sha"] is None:
        if r["label"] == "[redacted]":
            raise ContentRemoved("본문이 지워졌다")
        raise NotFound("본문 없음")
    body = _body(con, r)
    if body is None:
        raise ContentRemoved("본문이 지워졌다")
    return {"text": body[start:start + mc], "start": start, "end": min(len(body), start + mc),
            "total_chars": len(body), "body_format": r["body_format"] or "text"}


# ------------------------------------------------------------------ 표 문법(filter, sort)

OPS = {"eq": "=", "ne": "<>", "lt": "<", "lte": "<=", "gt": ">", "gte": ">="}
OPS_BY_TYPE = {
    "string": {"eq", "ne", "lt", "lte", "gt", "gte", "in", "prefix"},
    "integer": {"eq", "ne", "lt", "lte", "gt", "gte", "in"},
    "decimal": {"eq", "ne", "lt", "lte", "gt", "gte", "in"},
    "date-time": {"eq", "ne", "lt", "lte", "gt", "gte", "in"},
    "boolean": {"eq", "ne"},
}
MAX_IN = 100
HI = "\U0010ffff"


def _split_in(v: str) -> list[str]:
    out, cur, i = [], [], 0
    while i < len(v):
        ch = v[i]
        if ch == "\\" and i + 1 < len(v) and v[i + 1] in ",\\":
            cur.append(v[i + 1])
            i += 2
            continue
        if ch == ",":
            out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
        i += 1
    out.append("".join(cur))
    return out


def _coerce(t: str, v: str, name: str):
    try:
        if t == "string":
            return unicodedata.normalize("NFC", v)
        if t == "integer":
            return int(v)
        if t == "decimal":
            return float(v)
        if t == "boolean":
            if v.lower() not in ("true", "false", "1", "0"):
                raise ValueError(v)
            return 1 if v.lower() in ("true", "1") else 0
        if t == "date-time":
            from kb.read.ctx import parse_ts
            return parse_ts(v, "filter")
    except ValueError as e:
        raise BadParam(f"filter 값 형식 오류: {name}:{v}", "filter") from e
    raise BadParam(f"filter 형 오류: {t}", "filter")


def _schema_props(con, types: tuple | None):
    allp = type_properties(con)
    if types:
        merged = {}
        for t in types:
            merged.update(allp.get(t, {}))
        return merged
    merged: dict = {}
    for ps in allp.values():
        for k, v in ps.items():
            merged.setdefault(k, v)
    return merged


def _prop_expr(name: str) -> str:
    return f"json_extract(CAST(n.props AS TEXT), '$.\"{name}\"')"


def parse_filters(con, ctx: ReadCtx, filters, types) -> tuple[list[str], list]:
    """filter 목록 -> (AND 조각들, 파라미터). 오류는 BadParam(filter)."""
    if isinstance(filters, str):
        filters = [filters]
    props = _schema_props(con, types)
    w: list[str] = []
    p: list = []

    def typed(t: str, base: str, col: bool) -> str:
        if col:
            return base
        if t in ("integer", "decimal"):
            return f"CAST({base} AS NUMERIC)"
        if t == "date-time":
            return f"(unixepoch({base},'subsec')*1000)"
        return base

    for f in filters or ():
        parts = f.split(":", 2)
        if len(parts) != 3:
            raise BadParam(f"filter 형식 오류: {f!r}", "filter")
        name, op, val = parts
        arr = False
        if name == "label":
            t, base, col = "string", "n.label", True
        elif name == "recorded_at":
            t, base, col = "date-time", "n.recorded_at", True
        elif name in props and props[name]["filterable"]:
            t, arr = props[name]["type"], props[name]["array"]
            base, col = _prop_expr(name), False
        else:
            raise BadParam(f"filter에 쓸 수 없는 이름: {name!r}", "filter")
        if op not in OPS_BY_TYPE[t]:
            raise BadParam(f"{name}({t})에 쓸 수 없는 연산자: {op!r}", "filter")
        if op == "in":
            vals = _split_in(val)
            if len(vals) > MAX_IN:
                raise BadParam(f"in은 최대 {MAX_IN}개", "filter")
            args = [_coerce(t, x, name) for x in vals]
            cond = lambda e, n=len(args): f"{e} IN ({','.join('?' * n)})"
        elif op == "prefix":
            pv = _coerce("string", val, name)
            args = [pv, pv + HI]
            cond = lambda e: f"({e} COLLATE NOCASE >= ? AND {e} COLLATE NOCASE < ?)"
        else:
            args = [_coerce(t, val, name)]
            cond = lambda e, o=OPS[op]: f"{e} {o} ?"
        if arr:
            inner = cond(typed(t, "j.value", False))
            w.append(f"EXISTS(SELECT 1 FROM json_each(CAST(n.props AS TEXT), '$.\"{name}\"') j WHERE {inner})")
        else:
            w.append(f"({base} IS NOT NULL AND {cond(typed(t, base, col))})")
        p += args
    return w, p


def parse_sort(con, types: tuple | None, sort: str | None):
    """(sql 표현식, 방향 asc|desc, 키 이름, 타입). 키는 하나다."""
    if not sort:
        return "n.id", "asc", "id", "string"
    desc = sort.startswith("-")
    key = sort[1:] if desc else sort
    base = {"id": ("n.id", "string"), "label": ("n.label", "string"), "recorded_at": ("n.recorded_at", "date-time")}
    if key in base:
        expr, t = base[key]
    else:
        if not types or len(types) != 1:
            raise BadParam(f"sort 키 {key!r}는 type 하나를 줄 때만 쓴다", "sort")
        ps = type_properties(con).get(types[0], {})
        if key not in ps or not ps[key]["sortable"]:
            raise BadParam(f"sort에 쓸 수 없는 키: {key!r}", "sort")
        t = ps[key]["type"]
        expr = _prop_expr(key)
        if t in ("integer", "decimal"):
            expr = f"CAST({expr} AS NUMERIC)"
        elif t == "date-time":
            expr = f"unixepoch({expr},'subsec')"
    return expr, ("desc" if desc else "asc"), key, t


def build_list_query(con, ctx: ReadCtx, *, filters=(), sort: str | None = None, after=None, limit: int | None = None,
                     count: bool = False):
    """/v1/nodes 목록 질의 하나. (sql, params). after는 (정렬 값, id) 또는 None."""
    w, p = visibility_sql(ctx, "n")
    fw, fp = parse_filters(con, ctx, filters, ctx.types)
    where = [w, *fw]
    params = [*p, *fp]
    use_idx = (ctx.as_of_observed is None and any(x.startswith("label:prefix:") for x in (filters or ())))
    frm = "node AS n INDEXED BY node_label" if use_idx else "node AS n"
    if count:
        return f"SELECT COUNT(*) c FROM {frm} WHERE {' AND '.join(where)}", params
    expr, direction, key, _t = parse_sort(con, ctx.types, sort)
    if after is not None:
        lv, lid = after
        if lv is None:
            where.append(f"({expr} IS NULL AND n.id > ?)")
            params.append(lid)
        else:
            cmp_ = ">" if direction == "asc" else "<"
            where.append(f"({expr} {cmp_} ? OR ({expr} = ? AND n.id > ?) OR {expr} IS NULL)")
            params += [lv, lv, lid]
    order = ("n.id ASC" if key == "id" and direction == "asc" else
             f"({expr}) IS NULL, ({expr}) {direction.upper()}, n.id ASC")
    sql = f"SELECT n.*, ({expr}) AS _k FROM {frm} WHERE {' AND '.join(where)} ORDER BY {order}"
    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)
    return sql, params


def list_nodes(con, ctx: ReadCtx, *, type: str | None = None, ids=None, filter=None, sort: str | None = None,
               cursor: str | None = None, limit=None):
    """/v1/nodes -> (data, page). 기본 types는 Claim, Snapshot, Source, Document, Ticket을 뺀 전부."""
    if ids is not None:
        if any(x is not None for x in (type, filter, sort, cursor, limit)) or ctx.types or ctx.origin or ctx.domains \
                or ctx.sources or ctx.authors:
            raise BadParam("ids는 as_of_*와만 함께 쓴다", "ids")
        id_list = [x for x in (ids.split(",") if isinstance(ids, str) else list(ids)) if x]
        if len(id_list) > 100:
            raise LimitTooLarge("ids는 최대 100개", "ids")
        found, seen = [], set()
        for i in id_list:
            if i in seen:
                continue
            seen.add(i)
            try:
                found.append(target_row(con, ctx, i))
            except NotFound:
                continue
        return {"items": node_objs(con, found)}, page_obj(None, len(found), False)
    if type is not None:
        if ctx.types:
            raise BadParam("type과 types를 함께 줄 수 없다", "type")
        ctx = ctx.with_(types=(type,))
    if not ctx.types and not ctx.exclude_types:
        ctx = ctx.with_(exclude_types=NEIGHBOR_EXCLUDED)
    lim = clamp_limit(limit, 100, 500)
    fl = [filter] if isinstance(filter, str) else list(filter or ())
    fh = ["nodes", fl, sort]
    k = read_cursor(con, ctx, cursor, fh)
    after = (k[0], k[1]) if k else None
    sql, params = build_list_query(con, ctx, filters=fl, sort=sort, after=after, limit=lim + 1)
    rr = rows(con, sql, params)
    more = len(rr) > lim
    rr = rr[:lim]
    csql, cparams = build_list_query(con, ctx, filters=fl, count=True)
    total = row(con, csql, cparams)["c"]
    nxt = make_cursor(con, ctx, k=[rr[-1]["_k"], rr[-1]["id"]], fh_parts=fh) if more else None
    for r in rr:
        r.pop("_k", None)
    return {"items": node_objs(con, rr)}, page_obj(nxt, total, more)
