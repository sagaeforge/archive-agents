"""노드 상세: 2.10 표의 모든 노드 ID와 ID별 필드, ids= 일괄 읽기, EdgeRef.peer, 묶음 상한."""
import json

import pytest

from kb import read
from kb.core import cas
from .rhelp import E, T0, claim, entity, record, snap, verdict


@pytest.fixture
def world(w):
    pts = cas.put(b"\n".join(json.dumps(p).encode() for p in (
        {"period_key": "2027-01-10", "period_start": T0 - 5 * 86400000, "value": "3", "unit": "rank"},
        {"period_key": "2027-01-11", "period_start": T0 - 4 * 86400000, "value": "2", "unit": "rank"})))
    w.add(E("source.registered", {"id": "src:a", "label": "출처A", "props": {"trust": "primary"}}, "src:a"),
          entity("e:tool:x", "X"), entity("e:tool:y", "Y"), snap(source="src:a"),
          claim("c-1", "e:tool:x", "x는 위젯을 지원한다"), claim("c-2", "e:tool:x", "x는 달을 지원한다"),
          E("edge.put", {"id": "r-xy", "src": "e:tool:x", "rtype": "USES", "dst": "e:tool:y"}),
          record("f-1", "메모", "internal", body="본문 내용입니다", links=[{"rtype": "LINKS_TO", "dst": "e:tool:x"}]),
          E("series.define", {"id": "s:kw", "label": "키워드 순위", "metric": "chart_rank", "unit": "rank", "subject": "e:tool:x"}, "s:kw"),
          E("series.batch", {"series_id": "s:kw", "snapshot": "n-1", "parser": "p@1", "points_sha": pts, "count": 2}, "s:kw"),
          E("ticket.open", {"id": "t-1", "topic": "위젯 조사", "reason": "필요", "priority": 2}, "t-1"))
    return w


def _get(w, nid, **kw):
    with w.rd() as (con, c):
        return read.get_node(con, c, nid, **kw)


def test_each_id_kind(world):
    w = world
    assert (_get(w, "e:tool:x")["type"], "snapshot" in _get(w, "e:tool:x")) == ("Tool", False)
    f = _get(w, "f-1", include="body")
    assert (f["type"], f["body"], f["body_chars"], f["body_format"], f["origin"], f["author"]) == ("Note", "본문 내용입니다", 8, "markdown", "first_party", "user:sagae")
    c = _get(w, "c-1")
    assert c["type"] == "Claim" and c["claim"]["id"] == "c-1" and c["claim"]["versions"][0]["version"] == 1
    assert c["claim"]["evidence"][0]["snapshot_id"] == "n-1" and c["subject"] == "e:tool:x"
    n = _get(w, "n-1")
    assert n["type"] == "Snapshot" and n["snapshot"]["source"] == {"id": "src:a", "label": "출처A", "trust": "primary"}
    assert sorted(x["id"] for x in n["snapshot"]["citing_claims"]) == ["c-1", "c-2"] and n["snapshot"]["text_chars"] > 0
    s = _get(w, "s:kw")
    assert s["type"] == "Series" and s["series"] == {"id": "s:kw", "metric": "chart_rank", "unit": "rank"}
    assert _get(w, "d-n-1")["type"] == "Document"
    assert _get(w, "src:a")["type"] == "Source"
    t = _get(w, "t-1")
    assert (t["type"], t["label"], t["sensitivity"]) == ("Ticket", "위젯 조사", "internal")
    for bad in ("r-xy", "ev-123", "zzz"):
        with pytest.raises(read.NotFound):
            _get(w, bad)


def test_edge_ref_peer_and_backlinks(world):
    d = _get(world, "e:tool:x", include="claims,edges,backlinks")
    out = [e for e in d["edges"]["out"] if e["rtype"] == "USES"]
    assert out[0]["peer"] == {"id": "e:tool:y", "type": "Tool", "label": "Y"} and out[0]["src"] == "e:tool:x"
    assert d["backlinks"] == [{"id": "f-1", "type": "Note", "label": "메모", "rtype": "LINKS_TO"}]
    ins = _get(world, "e:tool:y")["edges"]["in"]
    assert [(e["id"], e["peer"]["id"]) for e in ins] == [("r-xy", "e:tool:x")]


def test_limits_truncation_and_include(world):
    d = _get(world, "e:tool:x", claim_limit=1, edge_limit=1, include="claims,edges")
    assert d["claims_truncated"] is True and [x["id"] for x in d["claims"]] == ["c-1"]
    assert d["edges"]["truncated"] is True and len(d["edges"]["out"]) == 1
    assert "backlinks" not in d and "body" not in d
    with world.rd() as (con, c):
        with pytest.raises(read.LimitTooLarge):
            read.get_node(con, c, "e:tool:x", claim_limit=201)
        with pytest.raises(read.LimitTooLarge):
            read.get_node(con, c, "e:tool:x", backlink_limit=501)
        with pytest.raises(read.BadParam):
            read.get_node(con, c, "e:tool:x", include="claims,nope")


def test_status_all_applies_to_embedded_claims_and_status_is_eff(world):
    w = world
    w.add(E("claim.supersede", {"id": "c-2", "by": "c-1"}, "c-2"))
    assert [x["id"] for x in _get(w, "e:tool:x")["claims"]] == ["c-1"]
    with w.rd(status="all") as (con, c):
        d = read.get_node(con, c, "e:tool:x")
        assert {x["id"]: x["status"] for x in d["claims"]} == {"c-1": "active", "c-2": "superseded"}
        assert d["status"] == "active"  # 대상 노드는 직접 조회 규칙
    w.add(verdict("e:tool:x", "dead", "removed"))
    with w.rd(status="all") as (con, c):
        d = read.get_node(con, c, "e:tool:x")
        assert d["status"] == "dead"
        assert {x["id"]: (x["status"], x["own_status"]) for x in d["claims"]}["c-1"] == ("dead", "active")


def test_ids_bulk_read(world):
    w = world
    w.add(record("f-priv", "비공개", "private"), entity("e:tool:old", "옛"), E("entity.merge", {"from": "e:tool:old", "into": "e:tool:y"}))
    with w.rd() as (con, c):
        data, page = read.list_nodes(con, c, ids="e:tool:y,f-priv,nope,e:tool:x,e:tool:old,e:tool:y")
        assert [x["id"] for x in data["items"]] == ["e:tool:y", "e:tool:x", "e:tool:old"]  # 요청 순서, 숨김/없음 생략, 병합 ID 응답
        assert page == {"next_cursor": None, "total": 3, "truncated": False}
        with pytest.raises(read.LimitTooLarge):
            read.list_nodes(con, c, ids=",".join(f"e:tool:{i}" for i in range(101)))
        for kw in ({"type": "Tool"}, {"filter": "label:eq:X"}, {"sort": "label"}, {"limit": 5}, {"cursor": "x"}):
            with pytest.raises(read.BadParam):
                read.list_nodes(con, c, ids="e:tool:x", **kw)
    with w.rd(as_of_observed=T0) as (con, c):  # as_of_*와는 함께 쓴다
        assert read.list_nodes(con, c, ids="e:tool:x")[1]["total"] == 0
