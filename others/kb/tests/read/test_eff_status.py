"""주어 판정이 state·howto 주장의 응답 status를 바꾼다(eff_status). event는 영향이 없다. 병합 주어는 묶는다."""
from kb import read
from .rhelp import E, claim, entity, snap, verdict


def _setup(w):
    w.add(entity("e:tool:x", "X"), snap(), claim("c-state", "e:tool:x", "x는 위젯을 지원한다", "state"),
          claim("c-how", "e:tool:x", "x에서 위젯을 켜는 방법은 설정이다", "howto"),
          claim("c-ev", "e:tool:x", "x는 2026년에 출시됐다", "event", valid={"from": "2026-01-01"}))


def _claims(w, nid="e:tool:x", **kw):
    with w.rd(**kw) as (con, c):
        return {x["id"]: x for x in read.node_claims(con, c, nid)[0]["items"]}


def test_dead_subject_hides_state_and_howto_keeps_event(w):
    _setup(w)
    assert sorted(_claims(w)) == ["c-ev", "c-how", "c-state"]
    w.add(verdict("e:tool:x", "dead", "removed"))
    assert sorted(_claims(w)) == ["c-ev"]
    dead = _claims(w, status="dead")
    assert sorted(dead) == ["c-how", "c-state"]
    s = dead["c-state"]
    assert (s["status"], s["own_status"], s["status_basis"]) == ("dead", "active", "subject")
    with w.rd() as (con, c):
        d = read.get_node(con, c, "e:tool:x")
        assert [x["id"] for x in d["claims"]] == ["c-ev"]
        g = read.get_claim(con, c, "c-state")  # 직접 조회는 응답하고 eff_status를 준다
        assert g["status"] == "dead" and g["own_status"] == "active"
        assert [x["id"] for x in read.list_nodes(con, c, type="Claim")[0]["items"]] == ["c-ev"]


def test_superseded_subject_and_revived(w):
    _setup(w)
    w.add(entity("e:tool:y", "Y"), verdict("e:tool:x", "superseded", "superseded", successor="e:tool:y"))
    assert sorted(_claims(w)) == ["c-ev"]
    assert sorted(_claims(w, status="superseded")) == ["c-how", "c-state"]
    w.add(verdict("e:tool:x", "active", "revived"))
    assert sorted(_claims(w)) == ["c-ev", "c-how", "c-state"]
    own = _claims(w)["c-state"]
    assert (own["status"], own["status_basis"]) == ("active", "own")
    with w.rd() as (con, c):
        assert [x["status"] for x in read.history(con, c, "c-state")["chains"][0]["items"]][-1] == "active"


def test_merged_subject_claims_stay_and_group_under_final(w):
    w.add(entity("e:tool:old", "옛"), entity("e:tool:new", "새"), snap(), claim("c-m", "e:tool:old", "old는 위젯을 지원한다", "state"))
    w.add(E("entity.merge", {"from": "e:tool:old", "into": "e:tool:new"}))
    w.add(verdict("e:tool:old", "superseded", "superseded", successor="e:tool:new"))
    assert sorted(_claims(w, "e:tool:new")) == ["c-m"]  # 제외되지 않고 최종 대상 아래에 묶인다
    assert _claims(w, "e:tool:new")["c-m"]["status"] == "active"
    with w.rd() as (con, c):
        assert [x["id"] for x in read.get_node(con, c, "e:tool:new")["claims"]] == ["c-m"]
        assert [x["id"] for x in read.get_node(con, c, "e:tool:old")["claims"]] == ["c-m"]
