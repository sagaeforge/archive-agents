"""다중 도메인 노드: domain 필터는 포함 일치(any-of), 응답 domain은 항상 배열, 패싯은 값마다 센다."""
from kb import read
from .rhelp import entity, snap


def _world(w):
    w.add(entity("e:tool:multi", "다중", domain=["C", "D", "E"]), entity("e:tool:onlyc", "C만", domain=["C"]),
          entity("e:tool:none", "무소속"), entity("e:tool:g", "지", domain=["G"]))


def _ids(w, **kw):
    with w.rd(**kw) as (con, c):
        return [x["id"] for x in read.list_nodes(con, c)[0]["items"]]


def test_domain_filter_any_of_and_none(w):
    _world(w)
    for d in "CDE":
        assert "e:tool:multi" in _ids(w, domain=d)
    assert _ids(w, domain="C") == ["e:tool:multi", "e:tool:onlyc"]
    assert _ids(w, domain="D,G") == ["e:tool:g", "e:tool:multi"]
    assert _ids(w, domain="none") == ["e:tool:none"]
    assert _ids(w, domain="G,none") == ["e:tool:g", "e:tool:none"]


def test_domain_always_array(w):
    _world(w)
    with w.rd() as (con, c):
        items = {x["id"]: x for x in read.list_nodes(con, c)[0]["items"]}
        assert items["e:tool:multi"]["domain"] == ["C", "D", "E"] and items["e:tool:none"]["domain"] == []
        assert read.get_node(con, c, "e:tool:none")["domain"] == []


def test_facet_counts_per_domain_and_filter_goes_through_visibility(w):
    _world(w)
    with w.rd() as (con, c):
        f = read.facets(con, c)
        dom = {x["value"]: x["count"] for x in f["facets"]["domain"]}
        assert dom == {"C": 2, "D": 1, "E": 1, "G": 1, "none": 1} and f["total"] == 4
    with w.rd(domain="D") as (con, c):
        f = read.facets(con, c)
        assert f["total"] == 1
        assert {x["value"]: x["count"] for x in f["facets"]["domain"]}["C"] == 2  # 자기 축 필터는 뺀다
        assert {x["value"] for x in f["facets"]["type"]} == {"Tool"}
        sql, args = read.visibility_sql(c, "n")
        assert "node_domain" in sql and "D" in args
