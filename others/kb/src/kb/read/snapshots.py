"""스냅샷 읽기(WP-04): 메타데이터, 표시 본문 창, 원본. 본문은 CAS에서 읽는다. 삭제된 본문은 ContentRemoved(410)."""
from __future__ import annotations

import re

from kb.core import cas
from kb.read.ctx import (AsOfUnsupported, BadParam, ContentRemoved, NotFound, ReadCtx, ReadError, iso, rows, visibility_sql)
from kb.read.envelope import clamp_limit
from kb.read.nodes import _json, current_nodes, target_row


class RangeNotSatisfiable(ReadError):
    status, code = 416, "range_not_satisfiable"


def _no_asof(ctx: ReadCtx):
    if ctx.as_of_valid is not None or ctx.as_of_observed is not None:
        raise AsOfUnsupported("스냅샷은 as_of_*를 받지 않는다")


def _snap_row(con, ctx, sid: str) -> dict:
    r = target_row(con, ctx, sid)
    if r["type"] != "Snapshot":
        raise NotFound("스냅샷이 아님")
    return r


def source_ref(con, source_id: str | None) -> dict:
    if not source_id:
        return {"id": "", "label": ""}
    n = current_nodes(con, [source_id]).get(source_id)
    out = {"id": source_id, "label": n["label"] if n else source_id}
    if n:
        r = rows(con, "SELECT props FROM node WHERE id=? AND expired_at IS NULL", (source_id,))
        out["trust"] = _json(r[0]["props"]).get("trust") or "unknown" if r else "unknown"
    return out


def _text_len(props: dict) -> int:
    sha = props.get("text_sha")
    if not sha:
        return 0
    try:
        return len(cas.get(sha).decode("utf-8"))
    except (cas.CasError, OSError):
        return 0


def snapshot_obj(con, ctx: ReadCtx, r: dict) -> dict:
    props = _json(r["props"])
    w, p = visibility_sql(ctx.with_(status="all", types=None, exclude_types=(), origin=None, domains=None, sources=None, authors=None),
                          "n")
    cit = rows(con, f"SELECT ev.claim_id AS id, MIN(ev.start_cp) AS start, MAX(ev.end_cp) AS end FROM evidence ev "
                    f"JOIN node n ON n.id=ev.claim_id WHERE ev.snapshot_id=? AND {w} GROUP BY ev.claim_id ORDER BY ev.claim_id",
               [r["id"], *p])
    return {"id": r["id"], "url": props.get("url") or r["label"], "final_url": props.get("final_url"),
            "source": source_ref(con, props.get("source")), "fetched_at": iso(props.get("fetched_at")),
            "http_status": props.get("http_status") or 0, "content_type": props.get("content_type") or "",
            "raw_sha256": props.get("raw_sha") or "", "text_sha256": props.get("text_sha"),
            "text_format": props.get("text_format"), "text_chars": _text_len(props), "extractor": props.get("extractor"),
            "citing_claims": [{"id": c["id"], "start": c["start"], "end": c["end"]} for c in cit]}


def snapshot_meta(con, ctx: ReadCtx, sid: str) -> dict:
    """/v1/snapshots/{id}. as_of_*는 400."""
    _no_asof(ctx)
    return snapshot_obj(con, ctx, _snap_row(con, ctx, sid))


def _int(v, name, default=0) -> int:
    try:
        n = int(default if v is None else v)
    except (TypeError, ValueError) as e:
        raise BadParam(f"{name} 형식 오류", name) from e
    if n < 0:
        raise BadParam(f"{name}는 0 이상", name)
    return n


def snapshot_text(con, ctx: ReadCtx, sid: str, *, start=0, max_chars=None) -> dict:
    """/v1/snapshots/{id}/text. 단위는 코드포인트. 표시 본문이 없으면 404, CAS에서 지워졌으면 410."""
    _no_asof(ctx)
    mc = clamp_limit(max_chars, 20_000, 200_000, "max_chars")
    st = _int(start, "start")
    props = _json(_snap_row(con, ctx, sid)["props"])
    sha = props.get("text_sha")
    if not sha:
        raise NotFound("표시 본문 없음")
    try:
        text = cas.get(sha).decode("utf-8")
    except (cas.CasMissing, FileNotFoundError) as e:
        raise ContentRemoved("본문이 지워졌다") from e
    if not text:
        raise NotFound("표시 본문 없음")
    return {"text": text[st:st + mc], "start": st, "end": min(len(text), st + mc), "total_chars": len(text),
            "text_format": props.get("text_format") or "text"}


_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")


def snapshot_raw(con, ctx: ReadCtx, sid: str, *, range_header: str | None = None):
    """/v1/snapshots/{id}/raw -> (바이트, 헤더 dict, HTTP 상태). 봉투가 없다."""
    _no_asof(ctx)
    props = _json(_snap_row(con, ctx, sid)["props"])
    sha = props.get("raw_sha")
    if not sha:
        raise NotFound("원본 없음")
    try:
        data = cas.get(sha, "ttl" if props.get("tier") == "ttl" else "objects")
    except (cas.CasMissing, FileNotFoundError) as e:
        raise ContentRemoved("원본이 지워졌다") from e
    headers = {"Content-Type": props.get("content_type") or "application/octet-stream",
               "Content-Disposition": f'attachment; filename="{sid}"', "X-Content-Type-Options": "nosniff",
               "ETag": f'"{sid}"', "Accept-Ranges": "bytes"}
    n = len(data)
    if not range_header:
        return data, headers, 200
    m = _RANGE.match(range_header.strip())
    if not m or (m.group(1) == "" and m.group(2) == ""):
        raise RangeNotSatisfiable("Range 형식 오류")
    a, b = m.group(1), m.group(2)
    if a == "":
        k = int(b)
        s, e = max(n - k, 0), n - 1
    else:
        s, e = int(a), (int(b) if b else n - 1)
        e = min(e, n - 1)
    if s >= n or s > e:
        raise RangeNotSatisfiable("범위 밖")
    headers["Content-Range"] = f"bytes {s}-{e}/{n}"
    return data[s:e + 1], headers, 206
