"""시계열 읽기(WP-04): 점과 공백. as-of는 series_obs의 두 시간축을 visibility_sql로 거른다."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from kb.read.ctx import BadParam, NotFound, ReadCtx, chunks, iso, parse_ts, rows, visibility_sql
from kb.read.nodes import _json, target_row


def _bucket_start(ms: int, bucket: str) -> int:
    d = datetime.fromtimestamp(ms // 1000, tz=timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    if bucket == "week":
        d -= timedelta(days=d.weekday())
    elif bucket == "month":
        d = d.replace(day=1)
    return int(d.timestamp() * 1000)


def series_info(r: dict) -> dict:
    props = _json(r["props"])
    return {"id": r["id"], "metric": props.get("metric") or "", "unit": props.get("unit")}


def series(con, ctx: ReadCtx, sid: str, *, from_=None, to=None, bucket: str | None = None) -> dict:
    """/v1/series/{id}. bucket을 주면 버킷마다 마지막 점 하나(평균, 합 없음). 공백 구간을 함께 준다."""
    if bucket is not None and bucket not in ("day", "week", "month"):
        raise BadParam(f"bucket 값 오류: {bucket!r}", "bucket")
    r = target_row(con, ctx, sid)
    if r["type"] != "Series":
        raise NotFound("시계열이 아님")
    t0, t1 = parse_ts(from_, "from"), parse_ts(to, "to")
    w, p = visibility_sql(ctx, "o", kind="series_obs")
    sql = f"SELECT o.* FROM series_obs o WHERE o.series_id=? AND {w}"
    args = [sid, *p]
    if t0 is not None:
        sql += " AND o.period_start >= ?"
        args.append(t0)
    if t1 is not None:
        sql += " AND o.period_start < ?"
        args.append(t1)
    pts = rows(con, sql + " ORDER BY o.period_start, o.period_key", args)
    if bucket:
        last: dict[int, dict] = {}
        for x in pts:
            last[_bucket_start(x["period_start"], bucket)] = x
        pts = [last[k] for k in sorted(last)]
    points = [{"period": x["period_key"], "start": iso(x["period_start"]), "end": iso(x["period_end"]), "value": x["value"],
               "observed_at": iso(x["observed_at"]), "last_seen_at": iso(x["last_seen_at"]), "snapshot_id": x["snapshot_id"]}
              for x in pts]
    # 공백: 이 시계열 점을 낸 스냅샷의 소스에 기록된 gap
    sids = {x["snapshot_id"] for x in rows(con, "SELECT DISTINCT snapshot_id FROM series_obs WHERE series_id=? AND snapshot_id IS NOT NULL", (sid,))}
    sources = set()
    for ch in chunks(sorted(sids)):
        for x in rows(con, f"SELECT props FROM node WHERE id IN ({','.join('?' * len(ch))}) AND expired_at IS NULL", ch):
            s = _json(x["props"]).get("source")
            if s:
                sources.add(s)
    gaps = []
    if sources:
        g = rows(con, f"SELECT source_id, from_at, to_at, reason FROM gap WHERE source_id IN ({','.join('?' * len(sources))}) "
                      f"ORDER BY from_at, to_at", sorted(sources))
        for x in g:
            if t0 is not None and x["to_at"] <= t0:
                continue
            if t1 is not None and x["from_at"] >= t1:
                continue
            gaps.append({"from": iso(x["from_at"]), "to": iso(x["to_at"]), "reason": x["reason"]})
    return {**series_info(r), "points": points, "gaps": gaps}
