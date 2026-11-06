"""개요(커서 이어받기, 닫힌 부분 그래프)와 이웃(BFS 깊이 2, 자르기)."""
import pytest

from kb import read
from .rhelp import E, claim, entity, snap, verdict

N = 30


@pytest.fixture
def chain(w):
    w.add(*[entity(f"e:tool:n{i:02d}", f"N{i:02d}") for i in range(N)], snap(), claim("c-1", "e:tool:n00", "n00은 위젯을 지원한다"),
          *[E("edge.put", {"id": f"r-{i:02d}", "src": f"e:tool:n{i:02d}", "rtype": "USES", "dst": f"e:tool:n{i + 1:02d}"}) for i in range(N - 1)],
          E("edge.put", {"id": "r-skip", "src": "e:tool:n00", "rtype": "PART_OF", "dst": "e:tool:n29"}))
    return w


def _walk(w, **kw):
    nodes, edges, cur, pages = [], [], None, 0
    while True:
        with w.rd() as (con, c):
            data, page = read.overview(con, c, cursor=cur, **kw)
        nodes += [r[0] for r in data["nodes"]["rows"]]
        edges += [r[0] for r in data["edges"]["rows"]]
        pages += 1
        assert data["meta"]["node_total"] == N and page["total"] == N and data["meta"]["truncated"] == page["truncated"]
        # 각 페이지는 자기 노드 안에서 닫힌다: 페이지 합집합 기준 닫힘
        assert set(r[1] for r in data["edges"]["rows"]) <= set(nodes) and set(r[2] for r in data["edges"]["rows"]) <= set(nodes)
        cur = page["next_cursor"]
        if not cur:
            return nodes, edges, pages, data


def test_overview_default_and_union_of_pages(chain):
    with chain.rd() as (con, c):
        data, page = read.overview(con, c)
    assert data["nodes"]["columns"] == ["id", "type", "label", "origin", "status"] and data["edges"]["columns"] == ["id", "src", "dst", "rtype", "status"]
    assert data["meta"] == {"graph": {"directed": True, "multi": True}, "order": "id_asc", "node_total": N, "edge_total": N, "truncated": False}
    assert [r[0] for r in data["nodes"]["rows"]] == sorted(r[0] for r in data["nodes"]["rows"]) and "c-1" not in [r[0] for r in data["nodes"]["rows"]]
    assert page == {"next_cursor": None, "total": N, "truncated": False}
    full_edges = [r[0] for r in data["edges"]["rows"]]
    assert full_edges == sorted(full_edges) and len(full_edges) == N  # 29 + r-skip
    for kw in ({"limit": 7}, {"limit": 100, "edge_limit": 5}, {"limit": 1}):
        nodes, edges, pages, _ = _walk(chain, **kw)
        assert pages > 1 and nodes == [r[0] for r in data["nodes"]["rows"]]
        assert sorted(edges) == full_edges and len(edges) == len(set(edges))


def test_overview_filters_and_status(chain):
    chain.add(verdict("e:tool:n10", "dead", "removed"))
    with chain.rd(types="Tool") as (con, c):
        data, _ = read.overview(con, c, rtypes="USES")
        assert data["meta"]["node_total"] == N - 1 and all(r[3] == "USES" for r in data["edges"]["rows"])
        assert "r-09" not in [r[0] for r in data["edges"]["rows"]]  # 닫히지 않는 엣지는 빠진다
    with chain.rd(status="all") as (con, c):
        assert read.overview(con, c)[0]["meta"]["node_total"] == N
    with chain.rd(types="Claim") as (con, c):  # 명시하면 기본을 대체한다
        assert [r[0] for r in read.overview(con, c)[0]["nodes"]["rows"]] == ["c-1"]
    with chain.rd() as (con, c):
        with pytest.raises(read.LimitTooLarge):
            read.overview(con, c, limit=100_001)


def test_neighbors_depth_totals_and_truncation(chain):
    with chain.rd() as (con, c):
        d1 = read.neighbors(con, c, "e:tool:n05")
        assert [r[0] for r in d1["nodes"]["rows"]] == ["e:tool:n04", "e:tool:n05", "e:tool:n06"]
        assert (d1["node_total"], d1["edge_total"], d1["truncated"]) == (3, 2, False)
        d2 = read.neighbors(con, c, "e:tool:n05", depth=2)
        assert len(d2["nodes"]["rows"]) == 5 and d2["edge_total"] == 4
        out = read.neighbors(con, c, "e:tool:n05", direction="out", depth=2)
        assert [r[0] for r in out["nodes"]["rows"]] == ["e:tool:n05", "e:tool:n06", "e:tool:n07"]
        only = read.neighbors(con, c, "e:tool:n05", rtypes="PART_OF")
        assert [r[0] for r in only["nodes"]["rows"]] == ["e:tool:n05"] and only["edges"]["rows"] == []
        hub = read.neighbors(con, c, "e:tool:n00")  # r-skip 때문에 n29도 이웃
        assert [r[0] for r in hub["nodes"]["rows"]] == ["e:tool:n00", "e:tool:n01", "e:tool:n29"]
        t = read.neighbors(con, c, "e:tool:n05", depth=2, limit=3)  # 시작 노드를 남기고 id 오름차순으로 자른다
        assert t["truncated"] and t["node_total"] == 5 and [r[0] for r in t["nodes"]["rows"]] == ["e:tool:n03", "e:tool:n04", "e:tool:n05"]
        assert all(e[1] in {r[0] for r in t["nodes"]["rows"]} and e[2] in {r[0] for r in t["nodes"]["rows"]} for e in t["edges"]["rows"])
        e_ = read.neighbors(con, c, "e:tool:n05", depth=2, edge_limit=1)
        assert e_["truncated"] and e_["edge_total"] == 4 and len(e_["edges"]["rows"]) == 1
        for bad in ({"depth": 3}, {"direction": "up"}):
            with pytest.raises(read.BadParam):
                read.neighbors(con, c, "e:tool:n05", **bad)
        with pytest.raises(read.LimitTooLarge):
            read.neighbors(con, c, "e:tool:n05", limit=501)


def test_neighbors_exclude_five_types_by_default(chain):
    with chain.rd() as (con, c):
        n = read.neighbors(con, c, "e:tool:n00")
        assert "c-1" not in [r[0] for r in n["nodes"]["rows"]]
        n2 = read.neighbors(con, c.with_(types=("Claim", "Tool")), "e:tool:n00")  # 명시하면 나온다
        assert all(r[1] in ("Tool", "Claim") for r in n2["nodes"]["rows"])
        s = read.neighbors(con, c, "c-1")  # 시작 노드는 필터와 무관하게 남는다
        assert [r[0] for r in s["nodes"]["rows"]][0:1] == ["c-1"]
