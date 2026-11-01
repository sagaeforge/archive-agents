"""internal -> private 상향: 모든 읽기 경로에서 옛 버전까지 숨고 피드에는 본문 없는 visibility.revoked가 나온다."""
import pytest

from kb import read
from .rhelp import E, entity, record

H = 3_600_000
T1, T2, T3 = 1_800_000_000_000 + 10 * H, 1_800_000_000_000 + 20 * H, 1_800_000_000_000 + 30 * H


@pytest.fixture
def raised(w):
    w.add(entity("e:tool:x", "공개 도구", at=T1), record("f-b", "다른 메모", at=T1),
          record("f-a", "첫 메모", "internal", body="내부 본문", links=[{"rtype": "LINKS_TO", "dst": "e:tool:x"}], at=T1))
    with w.rd() as (con, c):
        w.cursor_before = read.meta(con, c)["changes_cursor"]
        assert [e["peer"]["id"] for e in read.get_node(con, c, "e:tool:x")["edges"]["in"]] == ["f-a"]
        assert [b["id"] for b in read.get_node(con, c, "e:tool:x", include="backlinks")["backlinks"]] == ["f-a"]
    w.add(record("f-a", "첫 메모", "private", body="비공개 본문", links=[{"rtype": "LINKS_TO", "dst": "e:tool:x"}], at=T3))
    return w


def test_all_read_paths_hide(raised):
    w = raised
    paths = [lambda con, c: read.get_node(con, c, "f-a"), lambda con, c: read.node_body(con, c, "f-a"),
             lambda con, c: read.get_node(con, c, "f-a", include="body"), lambda con, c: read.neighbors(con, c, "f-a"),
             lambda con, c: read.node_claims(con, c, "f-a"), lambda con, c: read.node_edges(con, c, "f-a")]
    for kw in ({}, {"as_of_observed": T2}, {"as_of_observed": T1 + H, "status": "all"}):
        with w.rd(**kw) as (con, c):
            for fn in paths + ([lambda con, c: read.history(con, c, "f-a")] if not kw else []):
                with pytest.raises(read.NotFound):
                    fn(con, c)
            assert "f-a" not in [x["id"] for x in read.list_nodes(con, c, type="Note")[0]["items"]]
            assert read.list_nodes(con, c, ids="f-a,f-b")[1]["total"] == 1
    with w.rd(max_sensitivity="private") as (con, c):
        assert read.get_node(con, c, "f-a")["label"] == "첫 메모"
        assert len(read.history(con, c, "f-a")["versions"]) == 2


def test_hidden_id_absent_from_edges_in_and_backlinks(raised):
    with raised.rd() as (con, c):
        d = read.get_node(con, c, "e:tool:x", include="claims,edges,backlinks")
        assert d["edges"]["in"] == [] and d["backlinks"] == []
        assert read.node_edges(con, c, "e:tool:x", direction="in")[0]["items"] == []
        assert read.neighbors(con, c, "e:tool:x")["edges"]["rows"] == []
        data, _ = read.overview(con, c)
        assert all("f-a" not in r[:3] for r in data["edges"]["rows"]) and "f-a" not in [r[0] for r in data["nodes"]["rows"]]
    with raised.rd(as_of_observed=T2) as (con, c):  # 옛 시점의 읽기도 같다
        assert read.get_node(con, c, "e:tool:x")["edges"]["in"] == []


def test_feed_has_revoked_without_body_and_never_splits_a_seq(raised):
    w = raised
    with w.rd() as (con, c):
        data, page = read.changes(con, c, cursor=w.cursor_before, limit=1)
        kinds = [(x["kind"], x["id"]) for x in data["items"]]
        # 원 이벤트(record.put, 이제 private)는 숨고, 같은 seq의 revoked 두 줄(노드, 엣지)이 한 쪽에 함께 나간다
        assert len(kinds) == 2 and {k for k, _ in kinds} == {"visibility.revoked"}
        assert "f-a" in {i for _, i in kinds} and len({x["seq"] for x in data["items"]}) == 1
        for x in data["items"]:
            assert set(x) == {"seq", "at", "kind", "id"}  # 본문, 버전, 타입 없음
        assert page["truncated"] is False and isinstance(page["next_cursor"], str)
        # kinds, origin 필터와 무관하게 revoked는 항상 나온다
        d2, _ = read.changes(con, c, cursor=w.cursor_before, kinds="claim.assert", origin="external")
        assert {x["kind"] for x in d2["items"]} == {"visibility.revoked"}
        # f-a의 옛 이벤트는 피드 전체에서 숨는다
        all_, _ = read.changes(con, c)
        assert "f-a" not in [x["id"] for x in all_["items"] if x["kind"] != "visibility.revoked"]
