"""병합: 연쇄 병합의 merged_into_final, 상세·이웃·개요의 묶음, 옛 ID 직접 조회, 주장 ID와 엣지 ID 불변."""
from kb import read
from .rhelp import E, claim, entity, snap


def _world(w):
    w.add(entity("e:tool:a", "A"), entity("e:tool:b", "B"), entity("e:tool:c", "C"), entity("e:tool:x", "X"), snap(),
          claim("c-a", "e:tool:a", "a는 위젯을 지원한다", "state"), claim("c-b", "e:tool:b", "b는 달을 지원한다", "state"),
          E("edge.put", {"id": "r-a-x", "src": "e:tool:a", "rtype": "USES", "dst": "e:tool:x"}))
    w.add(E("entity.merge", {"from": "e:tool:a", "into": "e:tool:b"}))
    w.add(E("entity.merge", {"from": "e:tool:b", "into": "e:tool:c"}))


def test_chain_final_and_direct_lookup(w):
    _world(w)
    with w.rd() as (con, c):
        for old in ("e:tool:a", "e:tool:b"):
            d = read.get_node(con, c, old)
            assert d["status"] == "superseded" and d["merged_into_final"] == "e:tool:c"
        assert read.get_node(con, c, "e:tool:a")["merged_into"] == "e:tool:b"
        assert read.get_node(con, c, "e:tool:c")["merged_into"] is None
        ids = [x["id"] for x in read.list_nodes(con, c)[0]["items"]]
        assert "e:tool:a" not in ids and "e:tool:b" not in ids
        bulk = read.list_nodes(con, c, ids="e:tool:a,e:tool:c")[0]["items"]
        assert [x["id"] for x in bulk] == ["e:tool:a", "e:tool:c"]  # 병합 ID도 응답


def test_detail_neighbors_overview_group_under_final(w):
    _world(w)
    with w.rd() as (con, c):
        d = read.get_node(con, c, "e:tool:c")
        assert sorted(x["id"] for x in d["claims"]) == ["c-a", "c-b"]
        out = [e for e in d["edges"]["out"] if e["rtype"] == "USES"]
        assert [(e["id"], e["src"], e["peer"]["id"]) for e in out] == [("r-a-x", "e:tool:a", "e:tool:x")]  # 저장값 + peer는 최종 대상
        n = read.neighbors(con, c, "e:tool:c")
        assert [r[0] for r in n["nodes"]["rows"]] == ["e:tool:c", "e:tool:x"]
        assert n["edges"]["rows"] == [["r-a-x", "e:tool:c", "e:tool:x", "USES", "active"]]  # 끝점을 최종 대상으로 바꿔 낸다
        assert (n["node_total"], n["edge_total"]) == (2, 1)
        data, _ = read.overview(con, c)
        assert [r[0] for r in data["nodes"]["rows"]] == ["e:tool:c", "e:tool:x"]
        assert data["edges"]["rows"] == [["r-a-x", "e:tool:c", "e:tool:x", "USES", "active"]]  # MERGED_INTO 자기 고리는 빠진다
        # 병합 ID의 이웃은 최종 대상으로 묶는다
        assert read.neighbors(con, c, "e:tool:a")["edges"]["rows"] == n["edges"]["rows"]


def test_claim_and_edge_ids_unchanged(w):
    _world(w)
    with w.rd() as (con, c):
        cl = read.get_claim(con, c, "c-a")
        assert cl["subject"] == "e:tool:a" and cl["version"] == 1 and cl["status"] == "active"
        e = read.get_edge(con, c, "r-a-x")
        assert (e["src"], e["dst"], e["version"]) == ("e:tool:a", "e:tool:x", 1)
