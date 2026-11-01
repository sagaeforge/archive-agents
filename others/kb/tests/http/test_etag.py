"""조건부 GET(계약 2.5): 경로별 ETag 형식, Cache-Control 구분, 304, 불변 ETag의 410."""
import json

import pytest

from httphelp import claim, entity, hdr, verdict
from kb import publish
from kb.core import cas
from kb.serve import http as H

NO_STORE = {"getNode", "getNodeBody", "search", "getSnapshotText", "getSnapshotRaw", "getOpsFreshness", "listOpsTickets",
            "listOpsRuns", "getOpsMetrics"}
DATA_PATHS = {"/v1/schema": "no-cache", "/v1/overview": "no-cache", "/v1/nodes": "no-cache",
              "/v1/nodes/e:feature:history/claims": "no-cache", "/v1/nodes/e:feature:history/edges": "no-cache",
              "/v1/nodes/e:product:p/neighbors": "no-cache", "/v1/nodes/e:feature:history/history": "no-cache",
              "/v1/claims/c-1": "no-cache", "/v1/edges/r-01": "no-cache", "/v1/facets": "no-cache", "/v1/counts": "no-cache",
              "/v1/series/s:rank": "no-cache", "/v1/snapshots/n-1": "no-cache", "/v1/changes": "no-cache",
              "/v1/nodes/e:feature:history": "no-store", "/v1/nodes/f-1/body": "no-store", "/v1/search?q=history": "no-store"}


def test_cache_control_table_matches_contract():
    for r in H.ROUTES:
        want = "no-store" if r.op in NO_STORE else "no-cache"
        assert r.cache == want, r.op


@pytest.mark.parametrize("target,cc", DATA_PATHS.items())
def test_data_paths_etag_and_304(client, target, cc):
    r = client.get(target)
    assert r.status == 200
    et = hdr(r, "etag")
    env = json.loads(r.body)
    assert et == f'"{env["epoch"]}-{env["applied_seq"]}-{env["build_id"]}"'
    assert hdr(r, "cache-control") == cc and hdr(r, "vary") == "Authorization"
    n = client.get(target, {"If-None-Match": et})
    assert n.status == 304 and n.body == b"" and hdr(n, "etag") == et and hdr(n, "cache-control") == cc
    assert client.get(target, {"If-None-Match": f'W/{et}, "x"'}).status == 304
    assert client.get(target, {"If-None-Match": '"other"'}).status == 200
    assert client.get(target, {"If-None-Match": et}, method="HEAD").status == 304


def test_head_same_headers_as_get(client):
    g = client.get("/v1/nodes/e:feature:history")
    h = client.get("/v1/nodes/e:feature:history", method="HEAD")
    assert h.status == 200 and h.body == b"" and dict(h.headers) == dict(g.headers)


def test_meta_etag_includes_degraded_hash(client, world):
    r = client.get("/v1/meta")
    et = hdr(r, "etag")
    env = json.loads(r.body)
    assert et.startswith(f'"{env["epoch"]}-{env["applied_seq"]}-{env["build_id"]}-') and hdr(r, "cache-control") == "no-cache"
    assert client.get("/v1/meta", {"If-None-Match": et}).status == 304
    # degraded가 바뀌면(boot_path_unverified) 데이터 경로는 304이고 meta는 304가 아니다
    from kb.core import opsdb
    d = client.get("/v1/schema")
    c = opsdb.connect()
    try:
        opsdb.tick_state_set(c, "boot_path_unverified", "1")
    finally:
        c.close()
    r2 = client.get("/v1/meta", {"If-None-Match": et})
    assert r2.status == 200 and "boot_path_unverified" in json.loads(r2.body)["degraded"] and hdr(r2, "etag") != et
    assert client.get("/v1/schema", {"If-None-Match": hdr(d, "etag")}).status == 304


def test_data_etag_changes_with_claim_verdict_citing_and_build(client, world):
    targets = ["/v1/nodes", "/v1/nodes/e:feature:history", "/v1/claims/c-1", "/v1/snapshots/n-1", "/v1/search?q=history", "/v1/changes"]
    base = {t: hdr(client.get(t), "etag") for t in targets}
    # 주장 추가
    world.add(claim("c-2", "e:feature:history", "둘째 문단입니다."))
    after = {t: client.get(t, {"If-None-Match": base[t]}) for t in targets}
    assert all(r.status == 200 for r in after.values()), {t: r.status for t, r in after.items()}   # 304가 나지 않는다
    # 주어 판정
    cur = {t: hdr(r, "etag") for t, r in after.items()}
    world.add(verdict("e:tool:x", "active", "alive"))
    assert all(client.get(t, {"If-None-Match": cur[t]}).status == 200 for t in targets)
    # citing_claims 증가: 같은 스냅샷 위 주장이 늘면 /v1/snapshots/n-1 본문이 달라지고 ETag가 바뀐다
    s1 = client.get("/v1/snapshots/n-1")
    n1 = len(json.loads(s1.body)["data"]["citing_claims"])
    world.add(claim("c-3", "e:feature:history", "history 기능은 위젯을 지원한다", snap_id="n-1", predicate="supports2", value="y"))
    s2 = client.get("/v1/snapshots/n-1", {"If-None-Match": hdr(s1, "etag")})
    assert s2.status == 200 and len(json.loads(s2.body)["data"]["citing_claims"]) >= n1
    # build_id 변화(재구축)
    e0 = hdr(client.get("/v1/schema"), "etag")
    world.gold.execute("UPDATE meta SET v='g-000000099-zzzz' WHERE k='build_id'") if world.gold.execute(
        "SELECT 1 FROM meta WHERE k='build_id'").fetchone() else world.gold.execute("INSERT INTO meta(k,v) VALUES('build_id','g-000000099-zzzz')")
    world.gold.commit()
    r = client.get("/v1/schema", {"If-None-Match": e0})
    assert r.status == 200 and "g-000000099-zzzz" in hdr(r, "etag")


def test_immutable_etag_text_raw_and_410_after_removal(client, world):
    for t in ("/v1/snapshots/n-1/text", "/v1/snapshots/n-1/raw"):
        r = client.get(t)
        assert hdr(r, "etag") == '"n-1"' and hdr(r, "cache-control") == "no-store"
        assert client.get(t, {"If-None-Match": '"n-1"'}).status == 304
        world.add(entity("e:tool:bump", "범프"))      # 데이터가 바뀌어도 불변 ETag는 304
        assert client.get(t, {"If-None-Match": '"n-1"'}).status == 304
    props = json.loads(world.gold.execute("SELECT props FROM node WHERE id='n-1' AND expired_at IS NULL").fetchone()[0])
    cas.delete(props["raw_sha"])
    cas.delete(props["text_sha"])
    for t in ("/v1/snapshots/n-1/text", "/v1/snapshots/n-1/raw"):
        r = client.get(t, {"If-None-Match": '"n-1"'})
        assert r.status == 410 and json.loads(r.body)["code"] == "content_removed"


def test_manifest_and_export_etags(client, world):
    publish.publish(force=True, db_path=world.path)
    m = client.get("/v1/export/graph/manifest")
    man = json.loads(m.body)["data"]
    assert hdr(m, "etag") == f'"{man["build_id"]}"' and man["build_id"].startswith("p-") and hdr(m, "cache-control") == "no-cache"
    assert client.get("/v1/export/graph/manifest", {"If-None-Match": hdr(m, "etag")}).status == 304
    g = client.get("/v1/export/graph?profile=core")
    assert hdr(g, "etag") == f'"{man["profiles"]["core"]["sha256"]}"' and hdr(g, "cache-control") == "no-cache"
    assert client.get("/v1/export/graph?profile=core", {"If-None-Match": hdr(g, "etag")}).status == 304


def test_ops_have_no_etag(client):
    r = client.get("/v1/ops/runs")
    assert hdr(r, "etag") is None and hdr(r, "cache-control") == "no-store"
    assert client.get("/v1/ops/runs", {"If-None-Match": "*"}).status == 200
