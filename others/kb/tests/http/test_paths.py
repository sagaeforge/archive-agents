"""계약 4장 26개 경로: 경로마다 성공 1건과 오류 1건, openapi.yaml 스키마 통과."""
import json

import pytest

from httphelp import hdr
from openapi_check import declared_params, validate
from kb import publish
from kb.serve import http as H

# (템플릿, 성공 요청, 오류 요청, 오류 status, 오류 code)
CASES = [
    ("/v1/meta", "/v1/meta", "/v1/meta?x=1", 400, "bad_param"),
    ("/v1/schema", "/v1/schema", "/v1/schema?as_of_valid=2027-01-01", 400, "as_of_unsupported"),
    ("/v1/overview", "/v1/overview", "/v1/overview?limit=abc", 400, "bad_param"),
    ("/v1/nodes", "/v1/nodes?types=Feature", "/v1/nodes?limit=999999", 400, "limit_too_large"),
    ("/v1/nodes/{id}", "/v1/nodes/e:feature:history", "/v1/nodes/e:nope:zzz", 404, "not_found"),
    ("/v1/nodes/{id}/claims", "/v1/nodes/e:feature:history/claims", "/v1/nodes/e:nope:zzz/claims", 404, "not_found"),
    ("/v1/nodes/{id}/edges", "/v1/nodes/e:feature:history/edges", "/v1/nodes/e:feature:history/edges?direction=up", 400, "bad_param"),
    ("/v1/nodes/{id}/body", "/v1/nodes/f-1/body", "/v1/nodes/f-1/body?start=-1", 400, "bad_param"),
    ("/v1/nodes/{id}/neighbors", "/v1/nodes/e:product:p/neighbors", "/v1/nodes/e:product:p/neighbors?depth=9", 400, "bad_param"),
    ("/v1/nodes/{id}/history", "/v1/nodes/e:feature:history/history", "/v1/nodes/e:feature:history/history?as_of_valid=2027-01-01", 400, "as_of_unsupported"),
    ("/v1/claims/{id}", "/v1/claims/c-1", "/v1/claims/e:feature:history", 404, "not_found"),
    ("/v1/edges/{id}", "/v1/edges/r-01", "/v1/edges/c-1", 404, "not_found"),
    ("/v1/search", "/v1/search?q=위젯", "/v1/search", 400, "bad_param"),
    ("/v1/facets", "/v1/facets", "/v1/facets?filter=nonesuch:eq:1", 400, "bad_param"),
    ("/v1/counts", "/v1/counts", "/v1/counts?bucket=year", 400, "bad_param"),
    ("/v1/series/{id}", "/v1/series/s:rank", "/v1/series/e:feature:history", 404, "not_found"),
    ("/v1/snapshots/{id}", "/v1/snapshots/n-1", "/v1/snapshots/n-zzz", 404, "not_found"),
    ("/v1/snapshots/{id}/text", "/v1/snapshots/n-1/text", "/v1/snapshots/n-1/text?start=x", 400, "bad_param"),
    ("/v1/snapshots/{id}/raw", "/v1/snapshots/n-1/raw", "/v1/snapshots/n-zzz/raw", 404, "not_found"),
    ("/v1/changes", "/v1/changes", "/v1/changes?cursor=zzz", 400, "cursor_mismatch"),
    ("/v1/export/graph/manifest", "/v1/export/graph/manifest", "/v1/export/graph/manifest?x=1", 400, "bad_param"),
    ("/v1/export/graph", "/v1/export/graph?profile=core", "/v1/export/graph?profile=x", 400, "bad_param"),
    ("/v1/ops/freshness", "/v1/ops/freshness", "/v1/ops/freshness?x=1", 400, "bad_param"),
    ("/v1/ops/tickets", "/v1/ops/tickets", "/v1/ops/tickets?limit=0", 400, "bad_param"),
    ("/v1/ops/runs", "/v1/ops/runs", "/v1/ops/runs?limit=9999", 400, "limit_too_large"),
    ("/v1/ops/metrics", "/v1/ops/metrics", "/v1/ops/metrics?x=1", 400, "bad_param"),
]


def test_26_routes_declared():
    assert len(H.ROUTES) == 26 and [c[0] for c in CASES] == [r.template for r in H.ROUTES]


def test_param_table_matches_openapi():
    decl = declared_params()
    for r in H.ROUTES:
        assert set(r.params) == decl[r.template], (r.template, set(r.params) ^ decl[r.template])


@pytest.fixture
def published(world):
    publish.publish(force=True, db_path=world.path)


@pytest.mark.parametrize("tpl,ok,bad,st,code", CASES)
def test_route(client, published, tpl, ok, bad, st, code):
    r = client.get(ok)
    assert r.status == 200, (ok, r.status, r.body[:300])
    if tpl.endswith("/raw"):
        assert r.body == "<html>원본 바이트 0123456789</html>".encode()
    elif tpl == "/v1/export/graph":
        assert hdr(r, "content-type") == "application/zstd"
    else:
        body = json.loads(r.body)
        validate(tpl, body)
        assert body["schema_version"] == "0.3.1"
    e = client.get(bad)
    assert e.status == st, (bad, e.status, e.body[:300])
    p = json.loads(e.body)
    assert hdr(e, "content-type") == "application/problem+json" and p["code"] == code and p["status"] == st
    assert p["instance"] == bad.split("?")[0]
    if code in ("bad_param", "as_of_unsupported"):
        assert p.get("param")
    from openapi_check import DOC
    if str(st) in DOC["paths"][tpl]["get"]["responses"]:
        validate(tpl, p, str(st), "application/problem+json")


def test_entity_id_with_colons_everywhere(client):
    for sub in ("", "/claims", "/edges", "/neighbors", "/history"):
        assert client.json(f"/v1/nodes/e:feature:history{sub}")["data"] is not None
    assert client.get("/v1/nodes/e:feature:history/body").status == 404


def test_node_detail_id_kinds(client):
    for nid in ("c-1", "n-1", "f-1", "s:rank", "e:product:p"):
        assert client.get(f"/v1/nodes/{nid}").status == 200, nid
    assert client.get("/v1/nodes/r-01").status == 404     # 엣지 ID는 노드가 아니다
    assert client.get("/v1/nodes/f-sec").status == 404    # 숨긴 레코드와 같은 응답
    assert client.get("/v1/nodes/f-priv").status == 404


def test_error_cases(client, world):
    # as_of_unsupported, limit_too_large, cursor_mismatch, truncated
    assert json.loads(client.get("/v1/changes?as_of_valid=2027-01-01").body)["code"] == "as_of_unsupported"
    assert json.loads(client.get("/v1/snapshots/n-1?as_of_observed=2027-01-01").body)["code"] == "as_of_unsupported"
    assert json.loads(client.get("/v1/nodes?limit=501").body)["code"] == "limit_too_large"
    d = client.json("/v1/nodes?limit=2&sort=label")
    assert d["page"]["truncated"] is True and d["page"]["next_cursor"]
    e = client.get("/v1/nodes?limit=2&sort=id&cursor=" + d["page"]["next_cursor"])
    assert e.status == 400 and json.loads(e.body)["code"] == "cursor_mismatch"
    # 410 epoch_changed: epoch이 다른 커서
    from kb.read.envelope import encode_cursor
    old = encode_cursor({"e": 99, "s": 1})
    g = client.get("/v1/changes?cursor=" + old)
    assert g.status == 410 and json.loads(g.body)["code"] == "epoch_changed"


def test_410_content_removed(client, world):
    from kb.core import cas
    props = json.loads(world.gold.execute("SELECT props FROM node WHERE id='n-1' AND expired_at IS NULL").fetchone()[0])
    cas.delete(props["raw_sha"])
    r = client.get("/v1/snapshots/n-1/raw")
    assert r.status == 410 and json.loads(r.body)["code"] == "content_removed"
    cas.delete(props["text_sha"])
    t = client.get("/v1/snapshots/n-1/text")
    assert t.status == 410 and json.loads(t.body)["code"] == "content_removed"


def test_range_416_and_206(client):
    r = client.get("/v1/snapshots/n-1/raw", {"Range": "bytes=0-5"})
    assert r.status == 206 and r.body == "<html>".encode() and hdr(r, "content-range").startswith("bytes 0-5/")
    e = client.get("/v1/snapshots/n-1/raw", {"Range": "bytes=99999-"})
    assert e.status == 416 and json.loads(e.body)["code"] == "range_not_satisfiable"


def test_facets_with_q_and_ops_tickets_and_backlinks(client):
    f = client.json("/v1/facets?q=위젯")
    validate("/v1/facets", f)
    assert client.json("/v1/search?q=history&kinds=claim")["data"]["items"]
    t = client.json("/v1/ops/tickets")
    assert [x["id"] for x in t["data"]["items"]] == ["t-1"]
    n = client.json("/v1/nodes/e:product:p?include=claims,edges,backlinks")
    assert "backlinks" in n["data"]
    assert n["data"]["backlinks"] or n["data"]["edges"]["in"]


def test_hybrid_mode_passes_through(client):
    d = client.json("/v1/search?q=위젯&mode=hybrid")
    assert d["data"]["items"] is not None


def test_ops_degraded_without_ops_db(client):
    for p in ("freshness", "runs", "metrics"):
        d = client.json(f"/v1/ops/{p}")
        assert "ops_db_missing" in d["degraded"]
    assert client.json("/v1/ops/runs")["data"]["items"] == []


def test_ops_with_data(client):
    from kb.core import opsdb
    c = opsdb.connect()
    try:
        rid = opsdb.record_run(c, "tick", 1_800_000_000_000)
        opsdb.record_run(c, "tick", run_id=rid, ended_at=1_800_000_001_000, outcome="ok")
        opsdb.record_metric(c, "yield", 3, {"d": "A"}, at=1_800_000_000_500)
    finally:
        c.close()
    runs = client.json("/v1/ops/runs")
    validate("/v1/ops/runs", runs)
    assert runs["data"]["items"][0]["outcome"] == "ok" and runs["degraded"] == []
    m = client.json("/v1/ops/metrics")
    validate("/v1/ops/metrics", m)
    assert m["data"]["items"][0]["dims"] == {"d": "A"}
    validate("/v1/ops/freshness", client.json("/v1/ops/freshness"))
