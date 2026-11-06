"""이력: versions, 술어·슬롯별 체인, 두 시간축, predicate 인자(계약 4.7)."""
import pytest

from kb import read
from .rhelp import E, claim, entity, snap

H = 3_600_000
T1, T2, T3 = 1_800_000_000_000 + 10 * H, 1_800_000_000_000 + 20 * H, 1_800_000_000_000 + 30 * H


def _world(w):
    w.add(entity("e:policy:ypp", "YPP", at=T1), snap(at=T1))
    mk = lambda cid, val, vf, vt=None, at=T1: claim(cid, "e:policy:ypp", f"기준은 {val}시간이다", "state", predicate="entry_watch_hours", slot="a1",
                                                    value=val, unit="hour", valid={"from": vf, **({"to": vt} if vt else {})}, at=at)
    w.add(mk("c-3hd", "4000", "2024-06-01", at=T1))
    w.add(mk("c-8k2", "8000", "2027-02-01", at=T2), mk("c-3hd", "4000", "2024-06-01", "2027-02-01", at=T2))
    w.add(E("claim.supersede", {"id": "c-3hd", "by": "c-8k2", "valid_to": "2027-02-01"}, "c-3hd", at=T3))
    w.add(claim("c-other", "e:policy:ypp", "다른 술어", "state", predicate="other", value="1", at=T2))


def test_chains_versions_and_both_axes(w):
    _world(w)
    with w.rd() as (con, c):
        h = read.history(con, c, "e:policy:ypp")
        assert h["id"] == "e:policy:ypp" and [v["version"] for v in h["versions"]] == [1]
        chains = {(x["predicate"], x["slot"]): x["items"] for x in h["chains"]}
        items = chains[("entry_watch_hours", "a1")]
        got = [(i["id"], i["version"]) for i in items]
        assert got[0] == ("c-3hd", 1) and set(got) == {("c-3hd", 1), ("c-3hd", 2), ("c-3hd", 3), ("c-8k2", 1)}
        assert [i["recorded_at"] for i in items] == sorted(i["recorded_at"] for i in items)
        assert items[0]["valid"]["from"] == "2024-06-01" and items[0]["valid"]["to"] is None  # 유효축
        assert items[0]["recorded_at"] and items[0]["expired_at"]  # 관측축
        last = [i for i in items if i["id"] == "c-3hd"][-1]
        assert (last["status"], last["superseded_by"]) == ("superseded", "c-8k2")
        assert [i for i in items if i["id"] == "c-8k2"][0]["superseded_by"] is None
        assert [(e["rtype"], e["src"], e["dst"]) for e in h["edges"]] == [("SUPERSEDES", "c-8k2", "c-3hd")]
        assert {k[0] for k in chains} == {"entry_watch_hours", "other"}


def test_predicate_argument_and_claim_id(w):
    _world(w)
    with w.rd() as (con, c):
        only = read.history(con, c, "e:policy:ypp", predicate="other")
        assert [x["predicate"] for x in only["chains"]] == ["other"]
        byc = read.history(con, c, "c-8k2")  # 주장 ID는 그 주장이 든 체인 하나
        assert len(byc["chains"]) == 1 and byc["chains"][0]["predicate"] == "entry_watch_hours" and byc["versions"][0]["version"] == 1
        assert read.history(con, c, "c-3hd")["versions"][-1]["status"] == "superseded"  # 자기 상태


def test_as_of_is_400_and_unknown_404(w):
    _world(w)
    with w.rd(as_of_observed=T2) as (con, c):
        with pytest.raises(read.AsOfUnsupported):
            read.history(con, c, "e:policy:ypp")
    with w.rd() as (con, c):
        with pytest.raises(read.NotFound):
            read.history(con, c, "e:policy:none")
