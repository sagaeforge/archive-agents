"""그래프 읽기(WP-04): 개요(전체 입력, 커서 이어받기)와 이웃(BFS 깊이 2). 코드 BFS이고 재귀 SQL을 쓰지 않는다."""
from __future__ import annotations

import json
from bisect import bisect_right

from kb.read.catalog import overview_types
from kb.read.ctx import (NEIGHBOR_EXCLUDED, BadParam, ReadCtx, chunks, finals, group_of, rows, touching_sql, tuples, visibility_sql)
from kb.read.envelope import clamp_limit, make_cursor, page_obj, read_cursor
from kb.read.nodes import target_row

NODE_COLS = ["id", "type", "label", "origin", "status"]
EDGE_COLS = ["id", "src", "dst", "rtype", "status"]
GRAPH = {"directed": True, "multi": True}


def _rtypes(rtypes):
    if isinstance(rtypes, str):
        return tuple(x for x in rtypes.split(",") if x)
    return tuple(rtypes or ())


def _edge_rows(con, ctx, rtypes, extra_where="", extra_args=()):
    """(id, src, dst, rtype, status) 튜플. EDGE_COLS 순서다."""
    w, p = visibility_sql(ctx, "e", kind="edge")
    sql = f"SELECT e.id, e.src, e.dst, e.rtype, e.status FROM edge e WHERE {w}"
    args = list(p)
    if rtypes:
        sql += f" AND e.rtype IN ({','.join('?' * len(rtypes))})"
        args += list(rtypes)
    if extra_where:
        sql += f" AND {extra_where}"
        args += list(extra_args)
    return tuples(con, sql, args)


def _closed(erows, fin, inset):
    """끝점을 최종 대상으로 바꾸고 양끝이 inset에 든 엣지만 남긴다. 병합이 만든 자기 고리는 뺀다."""
    out = []
    get = fin.get
    for e in erows:
        src, dst = e[1], e[2]
        s, d = get(src, src), get(dst, dst)
        if s == d and src != dst:
            continue
        if s in inset and d in inset:
            out.append((e, s, d))
    return out


def overview(con, ctx: ReadCtx, *, rtypes=None, limit=None, edge_limit=None, cursor: str | None = None):
    """/v1/overview -> (data, page). id 오름차순, 닫힌 부분 그래프, 커서로 끝까지 받으면 합집합이 전체 결과와 같다."""
    rt = _rtypes(rtypes)
    lim = clamp_limit(limit, 50_000, 100_000)
    elim = clamp_limit(edge_limit, 200_000, 400_000, "edge_limit")
    if not ctx.types:
        ctx = ctx.with_(types=tuple(overview_types(con, ctx)) or ("\0none",), exclude_types=())
    w, p = visibility_sql(ctx, "n")
    nrows = rows(con, f"SELECT n.id, n.type, n.label, n.origin, n.eff_status AS status FROM node n WHERE {w} ORDER BY n.id", p)
    pos = {r["id"]: i for i, r in enumerate(nrows)}
    fin = finals(con)
    # 닫힌 부분 그래프의 시작점은 노드 집합이나 그 병합 원본뿐이다. 나머지 엣지는 SQL에서 뺀다(엣지 150만에서 25만 행).
    srcs = [*pos, *(raw for raw, f in fin.items() if f in pos)]
    kept = _closed(_edge_rows(con, ctx, rt, "e.src IN (SELECT value FROM json_each(?))", (json.dumps(srcs),)), fin, pos)
    cnt = [0] * len(nrows)
    by_pos: dict[int, list] = {}
    for e, s, d in kept:
        m = max(pos[s], pos[d])
        cnt[m] += 1
        by_pos.setdefault(m, []).append((e, s, d))
    fh = ["overview", list(rt), lim, elim]
    last = read_cursor(con, ctx, cursor, fh)
    ids = [r["id"] for r in nrows]
    start = bisect_right(ids, last) if last is not None else 0
    end, cum = start, 0
    while end < len(nrows) and end - start < lim:
        if end > start and cum + cnt[end] > elim:
            break
        cum += cnt[end]
        end += 1
    truncated = end < len(nrows)
    page_nodes = nrows[start:end]
    page_edges = sorted((x for i in range(start, end) for x in by_pos.get(i, ())), key=lambda t: t[0][0])
    nxt = make_cursor(con, ctx, k=ids[end - 1], fh_parts=fh) if truncated and end > start else None
    data = {
        "meta": {"graph": dict(GRAPH), "order": "id_asc", "node_total": len(nrows), "edge_total": len(kept),
                 "truncated": truncated},
        "nodes": {"columns": list(NODE_COLS), "rows": [[r["id"], r["type"], r["label"], r["origin"], r["status"]] for r in page_nodes]},
        "edges": {"columns": list(EDGE_COLS), "rows": [[e[0], s, d, e[3], e[4]] for e, s, d in page_edges]},
    }
    return data, page_obj(nxt, len(nrows), truncated)


def neighbors(con, ctx: ReadCtx, nid: str, *, depth: int = 1, rtypes=None, direction: str = "both", limit=None,
              edge_limit=None) -> dict:
    """/v1/nodes/{id}/neighbors. 시작 노드는 필터와 무관하게 남는다.
    direction은 BFS가 따라가는 엣지의 방향만 정한다. 닫힌 부분 그래프의 엣지는 방향과 무관하게 양끝이 든 것 전부다."""
    try:
        depth = int(depth)
    except (TypeError, ValueError) as e:
        raise BadParam("depth 형식 오류", "depth") from e
    if depth not in (1, 2):
        raise BadParam("depth는 1~2", "depth")
    if direction not in ("out", "in", "both"):
        raise BadParam(f"direction 값 오류: {direction!r}", "direction")
    rt = _rtypes(rtypes)
    lim = clamp_limit(limit, 200, 500)
    elim = clamp_limit(edge_limit, 2000, 10_000, "edge_limit")
    start_row = target_row(con, ctx, nid)
    fin = finals(con)
    start = fin.get(nid, nid)
    if start != nid:
        start_row = target_row(con, ctx, start)
    if not ctx.types and not ctx.exclude_types:
        ctx = ctx.with_(exclude_types=NEIGHBOR_EXCLUDED)
    members: dict[str, list[str]] = {}
    for raw, f in fin.items():
        members.setdefault(f, []).append(raw)

    def raw_ids(node_id):
        return [node_id, *members.get(node_id, ())]

    nodes = {start: start_row}
    frontier = set(raw_ids(start))
    for _ in range(depth):
        if not frontier:
            break
        seen: dict[str, str] = {}
        for ch in chunks(sorted(frontier), 400):
            cond, ca = touching_sql(ctx, ch, direction)
            for e in _edge_rows(con, ctx, rt, cond, ca):
                for here, other in ((e[1], e[2]), (e[2], e[1])):
                    if here in frontier and (direction == "both" or (direction == "out") == (here == e[1])):
                        of = fin.get(other, other)
                        if of not in nodes:
                            seen[of] = of
        new: dict[str, dict] = {}
        w, p = visibility_sql(ctx, "n")
        for ch in chunks(sorted(seen), 500):
            for r in rows(con, f"SELECT n.* FROM node n WHERE n.id IN ({','.join('?' * len(ch))}) AND {w}", [*ch, *p]):
                new[r["id"]] = r
        nodes.update(new)
        frontier = {x for nid_ in new for x in raw_ids(nid_)}
    # 닫힌 부분 그래프
    inset = set(nodes)
    all_raw = [x for n_ in inset for x in raw_ids(n_)]
    got: dict[str, dict] = {}
    for ch in chunks(all_raw, 400):
        cond, ca = touching_sql(ctx, ch, "both")
        for e in _edge_rows(con, ctx, rt, cond, ca):
            got[e[0]] = e
    closed = _closed(list(got.values()), fin, inset)
    node_total, edge_total = len(nodes), len(closed)
    truncated = False
    keep = set(nodes)
    if len(nodes) > lim:
        truncated = True
        rest = sorted(k for k in nodes if k != start)[:max(lim - 1, 0)]
        keep = {start, *rest}
        closed = [t for t in closed if t[1] in keep and t[2] in keep]
    closed.sort(key=lambda t: t[0][0])
    if len(closed) > elim:
        truncated = True
        closed = closed[:elim]
    nrows = sorted((nodes[k] for k in keep), key=lambda r: r["id"])
    return {
        "nodes": {"columns": list(NODE_COLS), "rows": [[r["id"], r["type"], r["label"], r["origin"], r["eff_status"]] for r in nrows]},
        "edges": {"columns": list(EDGE_COLS), "rows": [[e[0], s, d, e[3], e[4]] for e, s, d in closed]},
        "truncated": truncated, "node_total": node_total, "edge_total": edge_total,
    }
