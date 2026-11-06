"""시계열(점, 공백, as-of, bucket)과 티켓 읽기."""
import json

import pytest

from kb import read
from kb.core import cas
from .rhelp import DAY, E, T0, entity, snap

H = 3_600_000


def _points(vals, base):
    return cas.put(b"\n".join(json.dumps({"period_key": k, "period_start": base + i * DAY, "period_end": base + (i + 1) * DAY, "value": v, "unit": "rank"}).encode()
                              for i, (k, v) in enumerate(vals)))


def _world(w):
    base = T0 - 10 * DAY
    w.add(E("source.registered", {"id": "src:a", "label": "A"}, "src:a"), entity("e:video:v", "영상"), snap(source="src:a"),
          E("series.define", {"id": "s:rank", "label": "순위", "metric": "chart_rank", "unit": "rank", "subject": "e:video:v"}, "s:rank", at=T0 + 1 * H),
          E("series.batch", {"series_id": "s:rank", "snapshot": "n-1", "parser": "p@1", "count": 3,
                             "points_sha": _points([("d1", "5"), ("d2", "4"), ("d3", "3")], base)}, "s:rank", at=T0 + 2 * H),
          E("gap.recorded", {"source": "src:a", "from_at": base + 3 * DAY, "to_at": base + 5 * DAY, "reason": "machine_off"}, "src:a"))
    w.add(E("series.batch", {"series_id": "s:rank", "snapshot": "n-1", "parser": "p@1", "count": 1,
                             "points_sha": _points([("d2", "2")], base + DAY)}, "s:rank", at=T0 + 5 * H))
    return base


def test_points_gaps_asof_bucket(w):
    base = _world(w)
    with w.rd() as (con, c):
        s = read.series(con, c, "s:rank")
        assert (s["id"], s["metric"], s["unit"]) == ("s:rank", "chart_rank", "rank")
        assert [(p["period"], p["value"]) for p in s["points"]] == [("d1", "5"), ("d2", "2"), ("d3", "3")]
        assert s["points"][0]["start"].endswith("Z") and s["points"][0]["snapshot_id"] == "n-1"
        assert s["gaps"] == [{"from": "2027-01-08T08:00:00Z", "to": "2027-01-10T08:00:00Z", "reason": "machine_off"}]
        assert [p["period"] for p in read.series(con, c, "s:rank", from_="2027-01-07")["points"]] == ["d3"]
        assert read.series(con, c, "s:rank", from_="2027-01-12")["gaps"] == []
        b = read.series(con, c, "s:rank", bucket="month")  # 버킷마다 마지막 점 하나, 평균이나 합 없음
        assert [(p["period"], p["value"]) for p in b["points"]] == [("d3", "3")]
        assert len(read.series(con, c, "s:rank", bucket="day")["points"]) == 3
        with pytest.raises(read.BadParam):
            read.series(con, c, "s:rank", bucket="year")
        with pytest.raises(read.NotFound):
            read.series(con, c, "e:video:v")
    with w.rd(as_of_observed=T0 + 3 * H) as (con, c):  # 그때까지 알려진 값
        assert [(p["period"], p["value"]) for p in read.series(con, c, "s:rank")["points"]] == [("d1", "5"), ("d2", "4"), ("d3", "3")]
    with w.rd(as_of_valid="2027-01-07") as (con, c):  # 해당 기간의 점
        assert [(p["period"], p["value"]) for p in read.series(con, c, "s:rank")["points"]] == [("d2", "2")]


def test_tickets(w):
    w.add(E("ticket.open", {"id": "t-1", "topic": "위젯 조사", "reason": "필요", "priority": 2}, "t-1"),
          E("ticket.open", {"id": "t-2", "topic": "달 조사", "reason": "필요"}, "t-2"))
    w.add(E("ticket.close", {"id": "t-1", "status": "done"}, "t-1"))
    with w.rd() as (con, c):
        data, page = read.tickets(con, c)
        got = {t["id"]: t for t in data["items"]}
        assert got["t-1"]["status"] == "done" and got["t-1"]["closed_at"] and got["t-1"]["priority"] == "2"
        assert got["t-2"]["status"] == "queued" and got["t-2"]["closed_at"] is None and got["t-2"]["opened_at"]
        assert page["total"] == 2
        assert [t["id"] for t in read.tickets(con, c, status="queued")[0]["items"]] == ["t-2"]
        d1, p1 = read.tickets(con, c, limit=1)
        assert len(d1["items"]) == 1 and p1["truncated"] and read.tickets(con, c, limit=1, cursor=p1["next_cursor"])[0]["items"][0]["id"] == "t-2"
        assert read.get_ticket(con, c, "t-2")["topic"] == "달 조사"
