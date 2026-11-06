"""valid_precision 값별 응답(ValidTime)과 as_of_valid 날짜 입력."""
import pytest

from kb import read
from .rhelp import claim, entity, snap


@pytest.fixture
def world(w):
    w.add(entity("e:policy:p", "P"), snap())
    mk = lambda cid, v: claim(cid, "e:policy:p", f"{cid}는 기간이 있다", "event", valid=v)
    w.add(mk("c-inst", {"from": "2026-07-01T09:30:00Z", "precision": "instant"}),
          mk("c-day", {"from": "2026-07-01"}),
          mk("c-month", {"from": "2026-07", "to": "2026-08"}),
          mk("c-quarter", {"from": "2026-Q3", "to": "2026-Q4"}),
          mk("c-year", {"from": "2026", "to": "2027"}),
          mk("c-none", {}))
    return w


def _v(w, cid):
    with w.rd() as (con, c):
        return read.get_claim(con, c, cid)["valid"]


def test_valid_by_precision(world):
    assert _v(world, "c-inst") == {"from": "2026-07-01T09:30:00Z", "to": None, "precision": "instant", "label": None}
    assert _v(world, "c-day") == {"from": "2026-07-01", "to": None, "precision": "day", "label": None}
    assert _v(world, "c-month") == {"from": "2026-07-01", "to": "2026-08-01", "precision": "month", "label": "2026-07"}
    assert _v(world, "c-quarter") == {"from": "2026-07-01", "to": "2026-10-01", "precision": "quarter", "label": "2026-Q3"}
    assert _v(world, "c-year") == {"from": "2026-01-01", "to": "2027-01-01", "precision": "year", "label": "2026"}
    assert _v(world, "c-none") == {"from": None, "to": None, "precision": None, "label": None}


def test_as_of_valid_date_input(world):
    ids = lambda **kw: _ids(world, **kw)
    assert "c-month" in ids(as_of_valid="2026-07-15") and "c-month" not in ids(as_of_valid="2026-08-01")  # to 미포함
    assert "c-day" in ids(as_of_valid="2026-07-01") and "c-day" not in ids(as_of_valid="2026-06-30")
    assert "c-inst" in ids(as_of_valid="2026-07-01T09:30:00Z") and "c-inst" not in ids(as_of_valid="2026-07-01T09:29:59Z")
    with world.rd(as_of_valid="2026-07-01") as (con, c):
        env = read.envelope(con, c, {})
        assert env["as_of"]["valid"] == "2026-07-01T00:00:00Z" and env["as_of"]["observed"] is None
    with pytest.raises(read.BadParam):
        world.ctx(as_of_valid="어제")


def _ids(w, **kw):
    with w.rd(**kw) as (con, c):
        return {x["id"] for x in read.node_claims(con, c, "e:policy:p")[0]["items"]}
