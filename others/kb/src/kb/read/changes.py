"""/v1/changes (WP-04): 변경 피드. 커서는 epoch + seq이고 필터 해시가 없다."""
from __future__ import annotations

from kb.read.ctx import BadParam, EpochChanged, CursorMismatch, ReadCtx, iso, rows, visibility_sql
from kb.read.envelope import (applied_seq, clamp_limit, decode_cursor, encode_cursor, epoch_of, page_obj)

ORIGINS = ("external", "first_party", "system")


def _parse_cursor(con, cursor: str | None) -> int:
    if not cursor:
        return 0
    d = decode_cursor(cursor)
    if not isinstance(d.get("e"), int) or not isinstance(d.get("s"), int) or d["s"] < 0:
        raise CursorMismatch("해석할 수 없는 커서")
    if d["e"] != epoch_of(con) or d["s"] > applied_seq(con):
        raise EpochChanged("epoch이 바뀌었거나 커서가 현재 applied_seq보다 앞선다")
    return d["s"]


def _item(r: dict) -> dict:
    if r["kind"] == "visibility.revoked":
        return {"seq": r["seq"], "at": iso(r["at"]), "kind": r["kind"], "id": r["id"]}
    return {"seq": r["seq"], "at": iso(r["at"]), "kind": r["kind"], "id": r["id"], "version": r["version"],
            "type": r["type"], "origin": r["origin"]}


def changes(con, ctx: ReadCtx, *, cursor: str | None = None, limit=None, kinds=None, origin=None):
    """-> (data, page). 같은 seq의 행은 한 쪽에 함께 나가므로 limit을 넘을 수 있다.
    visibility.revoked는 kinds, origin과 무관하게 항상 나온다. as_of_*는 AsOfUnsupported(호출자가 400)."""
    if ctx.as_of_valid is not None or ctx.as_of_observed is not None:
        from kb.read.ctx import AsOfUnsupported
        raise AsOfUnsupported("changes는 as_of_*를 받지 않는다")
    lim = clamp_limit(limit, 500, 5000)
    after = _parse_cursor(con, cursor)
    kl = tuple(x for x in kinds.split(",") if x) if isinstance(kinds, str) else tuple(kinds or ())
    ol = tuple(x for x in origin.split(",") if x) if isinstance(origin, str) else tuple(origin or ())
    for o in ol:
        if o not in ORIGINS:
            raise BadParam(f"origin 값 오류: {o!r}", "origin")
    w, p = visibility_sql(ctx, "c", kind="change")
    where, args = [w], list(p)
    if kl or ol:
        sub, sa = [], []
        if kl:
            sub.append(f"c.kind IN ({','.join('?' * len(kl))})")
            sa += list(kl)
        if ol:
            sub.append(f"c.origin IN ({','.join('?' * len(ol))})")
            sa += list(ol)
        where.append("(c.kind='visibility.revoked' OR (" + " AND ".join(sub) + "))")
        args += sa
    base = " AND ".join(where)
    rr = rows(con, f"SELECT c.* FROM change c WHERE c.seq > ? AND {base} ORDER BY c.seq, c.sub LIMIT ?", [after, *args, lim + 1])
    more = len(rr) > lim
    out = rr[:lim]
    if more:
        last_seq = out[-1]["seq"]
        # 같은 seq의 나머지 행을 함께 낸다
        have = {(r["seq"], r["sub"]) for r in out}
        extra = rows(con, f"SELECT c.* FROM change c WHERE c.seq = ? AND {base} ORDER BY c.sub", [last_seq, *args])
        out += [r for r in extra if (r["seq"], r["sub"]) not in have]
        more = bool(rows(con, f"SELECT 1 FROM change c WHERE c.seq > ? AND {base} LIMIT 1", [last_seq, *args]))
    # 꼬리에 닿으면 applied_seq까지 본 것이다. 숨긴 행만 남았어도 다음 폴링이 다시 훑지 않는다.
    nxt_seq = out[-1]["seq"] if more else applied_seq(con)
    nxt = encode_cursor({"e": epoch_of(con), "s": nxt_seq})
    return {"items": [_item(r) for r in out]}, page_obj(nxt, None, more)
