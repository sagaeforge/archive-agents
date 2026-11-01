"""robots: RFC 9309 매처(*, $), robots_denied는 GET 0회, official_api는 tos_ref 필수, 시간당 예산, 모든 경로에 같은 규칙."""
import json

import pytest

from kb.collect import capture
from kb.collect.errors import RegistryError
from kb.collect.registry import load_registry
from kb.collect.robots import Robots
from kb.collect.state import State

from .conftest import events, mk_source

TXT = """
User-agent: *
Disallow: /private/
Disallow: /*.json$
Allow: /private/ok.html
Disallow: /tmp*

User-agent: kb-collector
Disallow: /only-us/
"""


def test_matcher_wildcards_and_anchor():
    r = Robots.parse("User-agent: *\nDisallow: /private/\nDisallow: /*.json$\nAllow: /private/ok.html\nDisallow: /tmp*\n")
    assert r.allowed("/index.html")
    assert not r.allowed("/private/a.html")
    assert r.allowed("/private/ok.html")                 # 더 긴 Allow가 이긴다
    assert not r.allowed("/data/x.json")
    assert r.allowed("/data/x.json.txt")                 # $는 끝 고정
    assert not r.allowed("/tmpfile")
    assert r.allowed("/robots.txt")


def test_matcher_ties_allow_wins_and_specific_group():
    r = Robots.parse(TXT)
    assert r.allowed("/private/a.html")                  # kb-collector 전용 그룹이 *를 대체한다
    assert not r.allowed("/only-us/x")
    r2 = Robots.parse("User-agent: *\nAllow: /a\nDisallow: /a\n")
    assert r2.allowed("/a")
    r3 = Robots.parse("User-agent: *\nDisallow: /\n")
    assert not r3.allowed("/x") and r3.allowed("/robots.txt")
    assert Robots.parse("").allowed("/x")
    assert Robots.parse("User-agent: *\nDisallow:\n").allowed("/x")


def test_matcher_percent_encoding_normalized():
    r = Robots.parse("User-agent: *\nDisallow: /a%2fb\n")
    assert not r.allowed("/a%2Fb")


@pytest.fixture
def site(world, set_registry):
    world.add("r.example", "/robots.txt", 200, b"User-agent: *\nDisallow: /secret/\nDisallow: /*.json$\n",
              headers={"Content-Type": "text/plain"})
    world.add("r.example", "/open", 200, b"hello", headers={"Content-Type": "text/plain"})
    world.add("r.example", "/secret/x", 200, b"nope", headers={"Content-Type": "text/plain"})
    world.add("r.example", "/d.json", 200, b"{}", headers={"Content-Type": "application/json"})
    set_registry([mk_source("src:r", urls=["https://r.example/open", "https://r.example/secret/x", "https://r.example/d.json"])])
    return world


def test_robots_denied_no_get_and_counted_separately(site):
    assert capture("src:r", "https://r.example/open").outcome == "captured"
    for u in ("https://r.example/secret/x", "https://r.example/d.json"):
        r = capture("src:r", u)
        assert r.outcome == "robots_denied" and r.code == "E_POLICY"
    assert site.count("r.example", "/secret/x") == 0 and site.count("r.example", "/d.json") == 0
    assert site.count("r.example", "/robots.txt") == 1          # 캐시한다
    with State() as st:
        row = st.get("src:r", "https://r.example/secret/x")
        outs = [r[0] for r in st.c.execute("SELECT outcome FROM fetch_log WHERE host='r.example'")]
    assert row["state"] == "robots_denied" and row["fail_count"] == 0       # 실패로 세지 않는다
    assert outs.count("robots_denied") == 2


def test_robots_denied_counted_in_tick(site, capsys, clk, approve):
    from kb.cli import main
    rc = main(["tick", "--only", "src:r", "--json"])
    out = json.loads(capsys.readouterr().out)
    assert rc in (0, 1)
    assert out["robots_denied"] == 2 and out["failed_sources"] == 0 and out["pages_fetched"] == 1


def test_robots_applies_to_every_path_into_capture(site):
    """kb fetch, 묶음, 호출자 전부 capture를 지난다. 미등록 URL(src:adhoc)에도 같은 규칙."""
    from kb.cli import main
    assert main(["fetch", "https://r.example/secret/x", "--json"]) == 1
    assert site.count("r.example", "/secret/x") == 0


def test_robots_4xx_means_allow_all_and_5xx_unavailable(world, set_registry):
    set_registry([])
    world.add("a.example", "/robots.txt", 404)
    world.add("a.example", "/x", 200, b"hi", headers={"Content-Type": "text/plain"})
    assert capture("src:adhoc", "https://a.example/x").outcome == "captured"
    world.add("b.example", "/robots.txt", 503, b"down")
    world.add("b.example", "/x", 200, b"hi", headers={"Content-Type": "text/plain"})
    r = capture("src:adhoc", "https://b.example/x")
    assert r.outcome == "error" and "robots_unavailable" in r.error
    assert world.count("b.example", "/x") == 0            # 확인하지 못했으면 받지 않는다


def test_official_api_requires_tos_ref(set_registry):
    set_registry([mk_source("src:api", "https://api.example/v", robots="official_api", tos_ref=None)])
    with pytest.raises(RegistryError, match="tos_ref"):
        load_registry()


def test_hourly_host_budget(world, set_registry, clk):
    world.add("budget.example", "/robots.txt", 404)
    for i in range(5):
        world.add("budget.example", f"/p{i}", 200, f"page {i}".encode(), headers={"Content-Type": "text/plain"})
    set_registry([mk_source("src:b", urls=[f"https://budget.example/p{i}" for i in range(5)])])
    outs = [capture("src:b", f"https://budget.example/p{i}").outcome for i in range(5)]
    # 예산 3: robots.txt 1건 + 페이지 2건에서 소진
    assert outs == ["captured", "captured", "budget_exceeded", "budget_exceeded", "budget_exceeded"]
    assert world.net_count() == 3
    clk.advance(3601)
    assert capture("src:b", "https://budget.example/p2").outcome == "captured"
