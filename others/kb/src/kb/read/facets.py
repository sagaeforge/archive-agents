"""패싯과 개수(WP-04). 모두 visibility_sql을 지난다. 패싯 축의 값별 개수는 그 축의 필터만 뺀 나머지로 센다."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from kb.read.ctx import NEIGHBOR_EXCLUDED, BadParam, ReadCtx, chunks, fact_groups, iso, row, rows, visibility_sql
from kb.read.nodes import parse_filters

DAY_MS = 86_400_000
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
SRC_EXPR = ("COALESCE((SELECT s.source_id FROM span s WHERE s.ref_id=n.id AND s.rec_to IS NULL AND s.source_id IS NOT NULL LIMIT 1),"
            " json_extract(CAST(n.props AS TEXT),'$.source'))")


def _base(ctx: ReadCtx) -> ReadCtx:
    if not ctx.types and not ctx.exclude_types:
        return ctx.with_(exclude_types=NEIGHBOR_EXCLUDED)
    return ctx


def _axis_ctx(ctx: ReadCtx, axis: str) -> ReadCtx:
    if axis == "type":
        return ctx.with_(types=None, exclude_types=NEIGHBOR_EXCLUDED)
    if axis == "origin":
        return ctx.with_(origin=None)
    if axis == "status":
        return ctx.with_(status="all")
    if axis == "source":
        return ctx.with_(sources=None)
    return ctx.with_(domains=None)


def _fact_facets(con, ctx: ReadCtx) -> tuple[int, dict, dict, dict, dict, dict] | None:
    """node_fact 한 번으로 다섯 축을 센다. 주장이 안 들고 as-of, 작성자 필터가 없는 요청만 탄다. 그 밖은 None(축별 스캔)."""
    no_claim = "Claim" not in ctx.types if ctx.types else "Claim" in ctx.exclude_types
    if not no_claim or ctx.as_of_observed is not None or ctx.as_of_valid is not None or ctx.authors:
        return None
    every = fact_groups(con, ctx)
    if every is None:
        return None
    matched = fact_groups(con, ctx, match_sources=True) if ctx.sources else every
    total = 0
    f_type: dict = {}
    f_origin: dict = {}
    f_status: dict = {}
    f_src: dict = {}
    f_dom: dict = {}

    def keep(g):
        doms = g["dom"].split(",") if g["dom"] else ["none"]
        return ((not ctx.types or g["type"] in ctx.types) and g["type"] not in ctx.exclude_types,
                not ctx.origin or g["origin"] in ctx.origin, ctx.status == "all" or g["eff_status"] == ctx.status,
                not ctx.domains or any(d in ctx.domains for d in doms), doms)

    for g in matched:                                   # 소스 축 밖은 소스 필터를 지난 노드로 센다
        ok_t, ok_o, ok_s, ok_d, doms = keep(g)
        t, o, s, c = g["type"], g["origin"], g["eff_status"], g["c"]
        if ok_t and ok_o and ok_s and ok_d:
            total += c
        if t not in NEIGHBOR_EXCLUDED and ok_o and ok_s and ok_d:
            f_type[t] = f_type.get(t, 0) + c
        if ok_t and ok_s and ok_d:
            f_origin[o] = f_origin.get(o, 0) + c
        if ok_t and ok_o and ok_d:
            f_status[s] = f_status.get(s, 0) + c
        if ok_t and ok_o and ok_s:
            for d in doms:
                f_dom[d] = f_dom.get(d, 0) + c
    for g in every:
        ok_t, ok_o, ok_s, ok_d, _ = keep(g)
        if ok_t and ok_o and ok_s and ok_d and g["src"] is not None:
            f_src[g["src"]] = f_src.get(g["src"], 0) + g["c"]
    return total, f_type, f_origin, f_status, f_src, f_dom


def _labels(con, f_src: dict) -> dict:
    labels = {}
    for ch in chunks(list(f_src), 500):
        for r in rows(con, f"SELECT id, label FROM node WHERE id IN ({','.join('?' * len(ch))}) AND expired_at IS NULL", ch):
            labels[r["id"]] = r["label"]
    return labels


def _shape(total, f_type, f_origin, f_status, f_src, f_dom, labels) -> dict:
    def lst(d, with_label=False):
        out = []
        for k in sorted(d, key=lambda k: (-d[k], str(k))):
            it = {"value": k, "count": d[k]}
            if with_label and k in labels:
                it["label"] = labels[k]
            out.append(it)
        return out

    return {"total": total, "facets": {"type": lst(f_type), "origin": lst(f_origin), "status": lst(f_status),
                                       "source": lst(f_src, True), "domain": lst(f_dom)}}


def facets(con, ctx: ReadCtx, *, filter=None, restrict_ids=None) -> dict:
    """/v1/facets. restrict_ids는 검색(q) 후보 집합이다(kb.read.search가 넘긴다). q를 직접 받지 않는다."""
    ctx = _base(ctx)
    fl = [filter] if isinstance(filter, str) else list(filter or ())
    if not fl and restrict_ids is None:
        fast = _fact_facets(con, ctx)
        if fast is not None:
            return _shape(*fast, _labels(con, fast[4]))
    return _scan_facets(con, ctx, fl, restrict_ids)


def _scan_facets(con, ctx: ReadCtx, fl: list, restrict_ids) -> dict:
    """축마다 node를 스캔한다. 모든 필터 조합에 맞는 기준 경로다."""
    rid = sorted(set(restrict_ids)) if restrict_ids is not None else None
    parts = list(chunks(rid, 20_000)) if rid is not None else [None]

    def run(c: ReadCtx, select: str, group: str | None, extra: str = ""):
        """chunk마다 돌려 (값 -> 개수)를 합친다."""
        out: dict = {}
        for ch in parts:
            w, p = visibility_sql(c, "n")
            fw, fp = parse_filters(con, c, fl, c.types)
            where = " AND ".join([w, *fw] + ([f"n.id IN ({','.join('?' * len(ch))})"] if ch is not None else []) + ([extra] if extra else []))
            args = [*p, *fp, *(ch or [])]
            sql = f"SELECT {select} AS v, COUNT(*) AS c FROM node n WHERE {where}" + (f" GROUP BY {group}" if group else "")
            for r in rows(con, sql, args):
                out[r["v"]] = out.get(r["v"], 0) + r["c"]
        return out

    total = sum(run(ctx, "1", None).values())
    f_type = run(_axis_ctx(ctx, "type"), "n.type", "n.type")
    f_origin = run(_axis_ctx(ctx, "origin"), "n.origin", "n.origin")
    f_status = run(_axis_ctx(ctx, "status"), "n.eff_status", "n.eff_status")
    f_src = run(_axis_ctx(ctx, "source"), SRC_EXPR, SRC_EXPR)
    f_src.pop(None, None)
    dctx = _axis_ctx(ctx, "domain")
    f_dom: dict = {}
    for ch in parts:
        w, p = visibility_sql(dctx, "n")
        fw, fp = parse_filters(con, dctx, fl, dctx.types)
        where = " AND ".join([w, *fw] + ([f"n.id IN ({','.join('?' * len(ch))})"] if ch is not None else []))
        args = [*p, *fp, *(ch or [])]
        for r in rows(con, f"SELECT d.domain AS v, COUNT(*) AS c FROM node n JOIN node_domain d ON d.node_id=n.id WHERE {where} GROUP BY d.domain", args):
            f_dom[r["v"]] = f_dom.get(r["v"], 0) + r["c"]
        none = row(con, f"SELECT COUNT(*) AS c FROM node n WHERE {where} AND NOT EXISTS(SELECT 1 FROM node_domain d WHERE d.node_id=n.id)", args)["c"]
        if none:
            f_dom["none"] = f_dom.get("none", 0) + none
    return _shape(total, f_type, f_origin, f_status, f_src, f_dom, _labels(con, f_src))


def counts(con, ctx: ReadCtx, *, bucket: str = "day", field: str = "recorded_at") -> dict:
    """/v1/counts. 타입 제한이 없다(Claim 포함)."""
    if bucket not in ("day", "week", "month"):
        raise BadParam(f"bucket 값 오류: {bucket!r}", "bucket")
    if field not in ("recorded_at", "valid_from"):
        raise BadParam(f"field 값 오류: {field!r}", "field")
    w, p = visibility_sql(ctx, "n")
    t = f"n.{field}"
    day = f"({t} - (({t} % {DAY_MS}) + {DAY_MS}) % {DAY_MS})"      # 1970 이전 값도 아래로 내린다. SQLite %는 피제수 부호를 따른다
    acc: dict[int, int] = {}
    for r in rows(con, f"SELECT {day} AS d, COUNT(*) AS c FROM node n WHERE {w} AND {t} IS NOT NULL GROUP BY 1", p):
        d = EPOCH + timedelta(milliseconds=r["d"])
        if bucket == "week":
            d -= timedelta(days=d.weekday())
        elif bucket == "month":
            d = d.replace(day=1)
        k = int(d.timestamp() * 1000)
        acc[k] = acc.get(k, 0) + r["c"]
    return {"bucket": bucket, "field": field, "series": [{"start": iso(k), "count": acc[k]} for k in sorted(acc)]}
