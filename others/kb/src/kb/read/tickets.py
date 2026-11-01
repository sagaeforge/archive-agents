"""요청 티켓 읽기(WP-04). Ticket 노드를 ops 목록 형태로 낸다. 쓰기는 kb.ticket(WP-12)이다."""
from __future__ import annotations

from kb.read.ctx import NotFound, ReadCtx, iso, row, rows, visibility_sql
from kb.read.envelope import clamp_limit, make_cursor, page_obj, read_cursor
from kb.read.nodes import _json, target_row

CLOSED = ("done", "unanswerable", "blocked_policy")


def _obj(con, r: dict) -> dict:
    props = _json(r["props"])
    first = row(con, "SELECT MIN(recorded_at) AS t FROM node WHERE id=?", (r["id"],))["t"]
    st = props.get("status") or "queued"
    pr = props.get("priority")
    return {"id": r["id"], "topic": r["label"], "status": st, "priority": "" if pr is None else str(pr),
            "opened_at": iso(first), "closed_at": iso(r["recorded_at"]) if st in CLOSED else None}


def get_ticket(con, ctx: ReadCtx, tid: str) -> dict:
    r = target_row(con, ctx, tid)
    if r["type"] != "Ticket":
        raise NotFound("티켓이 아님")
    return _obj(con, r)


def tickets(con, ctx: ReadCtx, *, status: str | None = None, cursor: str | None = None, limit=None):
    """/v1/ops/tickets -> (data, page). id 오름차순."""
    lim = clamp_limit(limit, 100, 500)
    c = ctx.with_(types=("Ticket",), exclude_types=())
    fh = ["tickets", status]
    last = read_cursor(con, ctx, cursor, fh)
    w, p = visibility_sql(c, "n")
    objs = [_obj(con, r) for r in rows(con, f"SELECT n.* FROM node n WHERE {w} ORDER BY n.id", p)]
    if status:
        objs = [o for o in objs if o["status"] == status]
    total = len(objs)
    if last is not None:
        objs = [o for o in objs if o["id"] > last]
    more = len(objs) > lim
    out = objs[:lim]
    nxt = make_cursor(con, ctx, k=out[-1]["id"], fh_parts=fh) if more else None
    return {"items": out}, page_obj(nxt, total, more)
