"""소스 하나가 URL 여럿을 받는 경로: discover(가짜 discoverer)와 urls."""
import json

import pytest

from kb.collect import tick as T
from kb.collect import tick_stage
from kb.collect.state import State

from .conftest import events, mk_source

H = 3600


def fake_sitemap(body, base_url, cfg):
    """색인 본문이 줄마다 URL인 가짜 discoverer(네트워크 없음)."""
    return [x.strip() for x in body.decode().splitlines() if x.strip()]


@pytest.fixture(autouse=True)
def _discoverers(monkeypatch):
    monkeypatch.setattr(tick_stage, "load_discoverers", lambda: ({"sitemap": fake_sitemap, "llms_txt": fake_sitemap}, None))


def run(**kw):
    rep, rc = T.run_tick(**kw)
    return rep


def page_world(world, host="d.example", n=5, extra_index=()):
    world.add(host, "/robots.txt", 404)
    subs = [f"https://{host}/p{i}" for i in range(n)]
    idx = "\n".join(subs + list(extra_index)).encode()
    world.add(host, "/index.txt", 200, idx, headers={"Content-Type": "text/plain", "ETag": '"idx1"'})
    for i in range(n):
        world.add(host, f"/p{i}", 200, f"body {i}".encode(), headers={"Content-Type": "text/plain", "ETag": f'"e{i}"'})
    return subs


def disc_src(sid="src:d", host="d.example", **kw):
    return mk_source(sid, f"https://{host}/index.txt", discover={"kind": "sitemap", "max_pages": 5, "include": [r"/p\d+$"]}, **kw)


def snaps():
    return events("snapshot.captured")


def test_discover_every_page_through_capture(world, set_registry):
    subs = page_world(world, extra_index=("https://other.example/x", "https://d.example/skipped"))
    set_registry([disc_src()])
    rep = run()
    urls = sorted(e["payload"]["url"] for e in snaps())
    assert urls == sorted(subs + ["https://d.example/index.txt"])      # 색인 1 + 하위 5, 다른 호스트와 include 밖은 제외
    assert rep["pages_fetched"] == 5 and rep["pages_queued"] == 5 and rep["pages_capped"] == 0 and rep["sources"] == 1
    with State() as st:
        rows = {r["url"]: r for r in st.list_urls("src:d")}
        assert {u: rows[u]["etag"] for u in subs} == {u: f'"e{i}"' for i, u in enumerate(subs)}
        assert all(r["discovered_from"] == "https://d.example/index.txt" for r in rows.values())
        assert st.get("src:d")["etag"] == '"idx1"'                      # 색인은 source_state
        assert st.page_count() == 0


def test_rerun_same_index_no_new_snapshot_not_modified(world, set_registry):
    page_world(world)
    set_registry([disc_src()])
    run()
    n = len(snaps())
    rep = run(only="src:d")                                              # 강제: 색인과 하위 페이지를 조건부 GET으로 다시 본다
    assert len(snaps()) == n == 6
    with State() as st:
        outs = [r[0] for r in st.c.execute("SELECT outcome FROM fetch_log WHERE outcome IN ('ok','not_modified')")]
    assert outs.count("ok") == 6 and outs.count("not_modified") == 6
    assert rep["pages_fetched"] == 5


def test_unlisted_url_kept_not_deleted(world, set_registry):
    subs = page_world(world)
    set_registry([disc_src()])
    run()
    world.add("d.example", "/index.txt", 200, "\n".join(subs[:4]).encode(), headers={"Content-Type": "text/plain", "ETag": '"idx2"'})
    run(only="src:d")
    with State() as st:
        rows = {r["url"]: r for r in st.list_urls("src:d")}
    assert rows[subs[4]]["state"] == "unlisted" and rows[subs[4]]["last_sha"]
    assert all(rows[u]["state"] == "ok" for u in subs[:4])
    assert len(snaps()) == 7                                             # 삭제 0건. 색인이 바뀌어 색인 스냅샷만 1건 더
    world.add("d.example", "/index.txt", 200, "\n".join(subs).encode(), headers={"Content-Type": "text/plain", "ETag": '"idx3"'})
    run(only="src:d")
    with State() as st:
        assert {r["url"]: r["state"] for r in st.list_urls("src:d")}[subs[4]] == "ok"       # 돌아오면 되살린다


def test_max_pages_capped_counted_not_silent(world, set_registry):
    page_world(world, n=8)
    set_registry([disc_src()])
    rep = run()
    assert rep["pages_capped"] == 3 and rep["pages_fetched"] == 5
    assert len(snaps()) == 6
    rep = run(only="src:d")
    assert rep["pages_capped"] == 3                                      # 매 tick 센다


def test_denied_host_subpage_zero_network(world, set_registry):
    world.add("u.example", "/robots.txt", 404)
    world.add("u.example", "/ok", 200, b"ok", headers={"Content-Type": "text/plain"})
    world.add("www.youtube.com", "/watch", 200, b"x")
    set_registry([mk_source("src:u", urls=["https://u.example/ok", "https://www.youtube.com/watch", "https://u.example/missing"])])
    rep = run()
    assert world.count("www.youtube.com") == 0
    with State() as st:
        assert ("www.youtube.com", "host_denied") in st.c.execute("SELECT host, outcome FROM fetch_log").fetchall()
    assert [e["payload"]["url"] for e in snaps()] == ["https://u.example/ok"]
    assert rep["failed_sources"] == 0


def test_urls_source_each_url_has_state_and_snapshot(world, set_registry):
    world.add("f.example", "/robots.txt", 404)
    for i in range(3):
        world.add("f.example", f"/f{i}", 200, f"feed {i}".encode(), headers={"Content-Type": "text/plain", "ETag": f'"f{i}"'})
    set_registry([mk_source("src:f", urls=[f"https://f.example/f{i}" for i in range(3)])])
    rep = run()
    assert rep["pages_fetched"] == 3 and len(snaps()) == 3
    with State() as st:
        assert st.get("src:f") is None                                   # urls만 있는 소스는 source_state가 없다
        assert {r["etag"] for r in st.list_urls("src:f")} == {'"f0"', '"f1"', '"f2"'}


def test_queue_domain_round_robin_and_AF_before_G(world, set_registry, monkeypatch):
    for host in ("a.example", "b.example", "g.example"):
        world.add(host, "/robots.txt", 404)
        for i in range(3):
            world.add(host, f"/x{i}", 200, f"{host}{i}".encode(), headers={"Content-Type": "text/plain"})
    set_registry([mk_source("src:g", urls=[f"https://g.example/x{i}" for i in range(3)], domain=["G"]),
                  mk_source("src:a", urls=[f"https://a.example/x{i}" for i in range(3)], domain=["A"]),
                  mk_source("src:b", urls=[f"https://b.example/x{i}" for i in range(3)], domain=["B"])])
    run()
    order = [r["host"] for r in world.requests if r["path"] != "/robots.txt"]
    assert len(order) == 9
    first_g = order.index("g.example")
    assert set(order[:first_g]) == {"a.example", "b.example"} and first_g == 6      # A~F가 G보다 먼저
    assert order[:4].count("a.example") == 2 and order[:4].count("b.example") == 2   # 도메인 순환


def test_max_pages_per_tick_leaves_rest_in_queue_next_tick_continues(world, set_registry):
    world.add("m.example", "/robots.txt", 404)
    urls = [f"https://m.example/m{i}" for i in range(5)]
    for i, u in enumerate(urls):
        world.add("m.example", f"/m{i}", 200, f"m{i}".encode(), headers={"Content-Type": "text/plain"})
    s = mk_source("src:m", urls=urls)
    s["fetch"]["max_pages_per_tick"] = 2
    set_registry([s])
    got = []
    for _ in range(3):
        rep = run()
        got.append(rep["pages_fetched"])
        with State() as st:
            left = st.page_count()
        if left:
            assert rep["pages_fetched"] == 2
    assert got == [2, 2, 1]
    assert len(snaps()) == 5 and len({e["payload"]["id"] for e in snaps()}) == 5     # 중복 snapshot 0
    assert run()["pages_fetched"] == 0


def test_until_idle_drains_queue(world, set_registry):
    world.add("m.example", "/robots.txt", 404)
    urls = [f"https://m.example/m{i}" for i in range(5)]
    for i in range(5):
        world.add("m.example", f"/m{i}", 200, f"m{i}".encode(), headers={"Content-Type": "text/plain"})
    s = mk_source("src:m", urls=urls)
    s["fetch"]["max_pages_per_tick"] = 2
    set_registry([s])
    rep = run(until_idle=True)
    assert rep["pages_fetched"] == 5 and len(snaps()) == 5


def test_subpage_404_does_not_touch_source_fail_count_or_circuit(world, set_registry, clk):
    page_world(world)
    set_registry([disc_src()])
    run()
    world.add("d.example", "/p2", 404, b"gone", headers={"Content-Type": "text/plain"})
    for _ in range(2):
        run(only="src:d")
        clk.advance(7 * H)
    with State() as st:
        src = st.get("src:d")
        row = {r["url"]: r for r in st.list_urls("src:d")}["https://d.example/p2"]
        circ = st.c.execute("SELECT count(*) FROM circuit").fetchone()[0]
    assert src["fail_count"] == 0 and src["state"] == "ok" and circ == 0
    assert row["fail_count"] == 2 and row["state"] == "suspect"
    run(only="src:d")
    with State() as st:
        row = {r["url"]: r for r in st.list_urls("src:d")}["https://d.example/p2"]
    assert row["state"] == "gone"
    assert events("source.status") == []                                  # 하위 페이지 gone은 소스 상태를 바꾸지 않는다


def test_no_discoverer_module_still_gets_index_and_urls(world, set_registry, monkeypatch):
    monkeypatch.setattr(tick_stage, "load_discoverers", lambda: ({}, None))
    page_world(world)
    s = disc_src()
    s["fetch"]["urls"] = ["https://d.example/p0"]
    set_registry([s])
    rep = run()
    assert sorted(e["payload"]["url"] for e in snaps()) == ["https://d.example/index.txt", "https://d.example/p0"]


def test_expect_violation_keeps_raw_skips_parse(world, set_registry):
    world.add("x.example", "/robots.txt", 404)
    world.add("x.example", "/feed.xml", 200, b"<html>login</html>", headers={"Content-Type": "text/html"})
    s = mk_source("src:x", "https://x.example/feed.xml")
    s["expect"] = {"content_type": "application/xml", "min_bytes": 5}
    set_registry([s])
    rep = run()
    assert snaps() == []                                                  # 파싱 대상 스냅샷을 만들지 않는다
    with State() as st:
        d = st.dlq_list("broken_source")
        assert len(d) == 1 and d[0]["payload_sha"] and st.get("src:x")["state"] == "broken"
    from kb.core import cas
    assert cas.get(d[0]["payload_sha"]) == b"<html>login</html>"          # 원본은 보존
    assert rep["failed_sources"] == 1
