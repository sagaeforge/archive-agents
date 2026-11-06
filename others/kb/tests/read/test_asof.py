"""as_of_observed: 라벨, 속성, 상태 변경을 되돌려 읽는다(RET-02). 소급 정정은 두 축이 어긋난 값을 재현한다. 엣지, 개요도 같은 술어."""
from kb import read
from .rhelp import DAY, E, T0, claim, entity, snap, verdict

H = 3_600_000
T1, T2, T3, T4 = T0 + 10 * H, T0 + 20 * H, T0 + 30 * H, T0 + 40 * H


def test_label_props_status_as_of_observed(w):
    w.add(entity("e:tool:x", "옛이름", props={"v": 1}, at=T1))
    w.add(entity("e:tool:x", "새이름", props={"v": 2}, at=T2))
    w.add(verdict("e:tool:x", "dead", "removed", at=T3))
    with w.rd(status="all") as (con, c):
        now = read.get_node(con, c, "e:tool:x")
        assert (now["label"], now["props"], now["status"]) == ("새이름", {"v": 2}, "dead")
    with w.rd(status="all", as_of_observed=T2 + H) as (con, c):
        d = read.get_node(con, c, "e:tool:x")
        assert (d["label"], d["props"], d["status"], d["version"]) == ("새이름", {"v": 2}, "active", 2)
    with w.rd(as_of_observed=T1 + H) as (con, c):
        d = read.get_node(con, c, "e:tool:x")
        assert (d["label"], d["props"], d["version"]) == ("옛이름", {"v": 1}, 1)
        env = read.envelope(con, c, d)
        assert env["as_of"]["observed"].endswith("Z") and env["as_of"]["valid"] is None
    with w.rd(as_of_observed=T1 - H) as (con, c):
        try:
            read.get_node(con, c, "e:tool:x")
            raise AssertionError("생기기 전 시점은 404여야 한다")
        except read.NotFound:
            pass


def test_retroactive_correction_diverges_axes(w):
    w.add(entity("e:policy:ypp", "YPP"), snap())
    mk = lambda val, at: claim("c-h", "e:policy:ypp", f"YPP 시청 시간 기준은 {val}시간이다", "state", predicate="entry_watch_hours",
                               value=val, unit="hour", valid={"from": "2024-06-01"}, at=at)
    w.add(mk("4000", T1))
    w.add(mk("3000", T3))  # 소급 정정: 과거 유효 구간의 값이 바뀐다
    with w.rd() as (con, c):
        assert read.get_node(con, c, "c-h")["value"] == "3000"
    with w.rd(as_of_observed=T2) as (con, c):
        assert read.get_node(con, c, "c-h")["value"] == "4000"  # 그때 KB가 알던 값
    # 같은 유효 시점이라도 관측 시점에 따라 값이 어긋난다
    for obs, want in ((T2, "4000"), (T4, "3000")):
        with w.rd(as_of_observed=obs, as_of_valid="2024-07-01") as (con, c):
            assert read.get_claim(con, c, "c-h")["value"] == want
    with w.rd(as_of_valid="2024-05-01") as (con, c):  # 유효 구간 시작 전
        try:
            read.get_claim(con, c, "c-h")
            raise AssertionError
        except read.NotFound:
            pass


def test_edges_and_overview_use_same_predicate(w):
    w.add(entity("e:tool:a", "A", at=T1), entity("e:tool:b", "B", at=T1), E("edge.put", {"id": "r-ab", "src": "e:tool:a", "rtype": "USES", "dst": "e:tool:b"}, at=T1))
    w.add(E("edge.expire", {"id": "r-ab"}, at=T3))
    with w.rd(as_of_observed=T2, edge_status="all") as (con, c):
        data, _ = read.overview(con, c)
        assert [r[0] for r in data["edges"]["rows"]] == ["r-ab"]
        n = read.neighbors(con, c, "e:tool:a")
        assert [r[0] for r in n["edges"]["rows"]] == ["r-ab"]
        assert [e["id"] for e in read.get_node(con, c, "e:tool:a")["edges"]["out"]] == ["r-ab"]
    with w.rd(edge_status="all") as (con, c):
        data, _ = read.overview(con, c)
        assert data["edges"]["rows"] == [] and data["meta"]["edge_total"] == 0
    with w.rd(as_of_observed=T2) as (con, c):
        assert read.get_edge(con, c, "r-ab")["id"] == "r-ab"


def test_subject_dead_in_2000_shows_state_claim_at_1500(w):
    """주어가 시점 2000에 dead가 되면 as-of 1500에서 그때 활성이던 state 주장이 나온다(감사 R6)."""
    w.add(entity("e:tool:x", "X", at=T1), snap(at=T1), claim("c-s", "e:tool:x", "x는 위젯을 지원한다", "state", at=T1))
    w.add(verdict("e:tool:x", "dead", "removed", at=T3))
    with w.rd() as (con, c):
        assert [x["id"] for x in read.node_claims(con, c, "e:tool:x")[0]["items"]] == []  # 지금은 기본 제외
    with w.rd(as_of_observed=T2) as (con, c):
        items = read.node_claims(con, c, "e:tool:x")[0]["items"]
        assert [(x["id"], x["status"]) for x in items] == [("c-s", "active")]
        d = read.get_node(con, c, "e:tool:x")
        assert [x["id"] for x in d["claims"]] == ["c-s"]
