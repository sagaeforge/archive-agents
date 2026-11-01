"""정책: 비활성, 연락처, 미승인 결정, 거부 호스트, User-Agent, 대체 소스 tos, overlay host_allow."""
import json

import pytest

from kb.collect import capture, host_allowed
from kb.collect.errors import RegistryError
from kb.collect.registry import load_registry
from kb.collect.state import State

from .conftest import events, mk_source


def logs(host=None):
    with State() as st:
        q = "SELECT host, outcome, status FROM fetch_log" + (" WHERE host=?" if host else "")
        return st.c.execute(q, (host,) if host else ()).fetchall()


def test_disabled_needs_contact_requires_decision_zero_calls(world, set_registry):
    world.add("d.example", "/x", 200, b"hi")
    world.add("c.example", "/x", 200, b"hi")
    world.add("r.example", "/x", 200, b"hi")
    set_registry([mk_source("src:dis", "https://d.example/x", enabled=False, tos="forbidden"),
                  mk_source("src:con", "https://c.example/x", needs_contact=True),
                  mk_source("src:dec", "https://r.example/x", requires_decision=5)])
    for sid, url in (("src:dis", "https://d.example/x"), ("src:con", "https://c.example/x"), ("src:dec", "https://r.example/x")):
        r = capture(sid, url)
        # 비활성 소스는 자기 호스트가 비활성 호스트 목록에 있어 host_denied로 먼저 막힌다. 어느 쪽이든 정책이고 네트워크 0회
        assert r.outcome in ("policy_skip", "host_denied") and r.code == "E_POLICY", (sid, r)
    assert world.net_count() == 0


def test_requires_decision_approved_runs(world, set_registry, approve):
    world.add("r.example", "/x", 200, b"hi", headers={"Content-Type": "text/plain"})
    world.add("r.example", "/robots.txt", 404)
    set_registry([mk_source("src:dec", "https://r.example/x", requires_decision=5)])
    approve(5)
    assert capture("src:dec", "https://r.example/x").outcome == "captured"


def test_official_api_needs_decision_8(world, set_registry, approve):
    world.add("api.example", "/v", 200, b"{}", headers={"Content-Type": "application/json"})
    set_registry([mk_source("src:api", "https://api.example/v", robots="official_api")])
    assert capture("src:api", "https://api.example/v").outcome == "policy_skip"
    assert world.net_count() == 0
    approve(8)
    r = capture("src:api", "https://api.example/v")
    assert r.outcome == "captured"
    assert world.count(path="/robots.txt") == 0          # official_api는 robots를 보지 않는다


def test_url_level_requires_decision(world, set_registry, approve):
    world.add("u.example", "/a", 200, b"a", headers={"Content-Type": "text/plain"})
    world.add("u.example", "/b", 200, b"b", headers={"Content-Type": "text/plain"})
    set_registry([mk_source("src:u", urls=["https://u.example/a", {"url": "https://u.example/b", "requires_decision": 9}])])
    assert capture("src:u", "https://u.example/b").outcome == "policy_skip"
    assert capture("src:u", "https://u.example/a").outcome == "captured"
    approve(9)
    assert capture("src:u", "https://u.example/b").outcome == "captured"


def test_denied_host_direct_call(world, set_registry):
    world.add("www.youtube.com", "/watch", 200, b"x")
    set_registry([])
    r = capture("src:adhoc", "https://www.youtube.com/watch")
    assert r.outcome == "host_denied" and r.code == "E_POLICY"
    assert world.net_count() == 0
    assert ("www.youtube.com", "host_denied", None) in logs()
    assert not host_allowed("sub.trends.google.com") and host_allowed("code.claude.com")


def test_denied_host_via_cli(world, set_registry, capsys):
    from kb.cli import main
    world.add("sec.gov", "/", 200, b"x")
    set_registry([])
    rc = main(["fetch", "https://www.sec.gov/", "--json"])
    out = json.loads(capsys.readouterr().out)
    assert rc == 1 and out["error"] == "E_POLICY" and out["outcome"] == "host_denied"
    assert world.net_count() == 0


def test_redirect_to_denied_host(world, set_registry):
    world.add("ok.example", "/robots.txt", 404)
    world.add("ok.example", "/r", 302, headers={"Location": "https://www.netflix.com/title"})
    world.add("www.netflix.com", "/title", 200, b"x")
    set_registry([])
    r = capture("src:adhoc", "https://ok.example/r")
    assert r.outcome == "host_denied"
    assert world.count("www.netflix.com") == 0
    assert any(o == "host_denied" and h == "www.netflix.com" for h, o, _ in logs())


def test_inactive_source_host_denied_unless_active_uses_it(world, set_registry):
    world.add("off.example", "/", 200, b"x")
    world.add("shared.example", "/", 200, b"x", headers={"Content-Type": "text/plain"})
    world.add("shared.example", "/robots.txt", 404)
    set_registry([mk_source("src:off", "https://off.example/", enabled=False, tos="unverified"),
                  mk_source("src:off2", "https://shared.example/x", enabled=False),
                  mk_source("src:on", "https://shared.example/", enabled=True)])
    assert not host_allowed("off.example")
    assert host_allowed("shared.example")          # 활성 소스가 같은 호스트를 쓰면 목록에서 뺀다
    assert capture("src:adhoc", "https://off.example/").outcome == "host_denied"


def test_user_agent_no_at_and_contact_only_for_needs_contact(world, set_registry, env):
    world.add("c.example", "/x", 200, b"hi", headers={"Content-Type": "text/plain"})
    world.add("c.example", "/robots.txt", 404)
    world.add("n.example", "/x", 200, b"hi", headers={"Content-Type": "text/plain"})
    world.add("n.example", "/robots.txt", 404)
    set_registry([mk_source("src:con", "https://c.example/x", needs_contact=True),
                  mk_source("src:non", "https://n.example/x")])
    (env.cfg / "contact").write_text("mailto:ops@contact.test\n")
    assert capture("src:con", "https://c.example/x").outcome == "captured"
    assert capture("src:non", "https://n.example/x").outcome == "captured"
    uas = {r["host"]: r["headers"]["User-Agent"] for r in world.requests}
    assert "ops@contact.test" in uas["c.example"] and uas["c.example"].startswith("kb-collector/")
    assert "@" not in uas["n.example"]


def test_needs_contact_without_file_never_starts(world, set_registry):
    world.add("c.example", "/x", 200, b"hi")
    set_registry([mk_source("src:con", "https://c.example/x", needs_contact=True)])
    r = capture("src:con", "https://c.example/x")
    assert r.outcome == "policy_skip" and r.error == "contact_missing" and world.net_count() == 0


def test_fallback_cannot_raise_tos(set_registry):
    set_registry([mk_source("src:a", "https://a.example/", tos="allowed"),
                  mk_source("src:b", "https://b.example/", tos="unverified")])
    load_registry()
    set_registry([mk_source("src:a", "https://a.example/", tos="allowed", ),
                  mk_source("src:b", "https://b.example/", tos="unverified")])
    bad = [mk_source("src:a", "https://a.example/", tos="allowed"), mk_source("src:b", "https://b.example/", tos="unverified")]
    bad[0]["fallbacks"] = ["src:b"]
    set_registry(bad)
    with pytest.raises(RegistryError, match="tos"):
        load_registry()
    ok = [mk_source("src:a", "https://a.example/", tos="unverified"), mk_source("src:b", "https://b.example/", tos="allowed")]
    ok[0]["fallbacks"] = ["src:b"]
    set_registry(ok)
    load_registry()


def test_registry_rules(set_registry):
    for src, msg in (
        (mk_source("src:x", "https://x.example/", robots="official_api", tos_ref=None), "tos_ref"),
        (mk_source("src:x", "https://x.example/", tos="forbidden"), "forbidden"),
        (mk_source("src:x", "https://x.example/", cls=None), "클래스"),
        (mk_source("src:x", "https://x.example/", discover={"kind": "sitemap"}), "max_pages"),
    ):
        set_registry([src])
        with pytest.raises(RegistryError, match=msg):
            load_registry()


def test_overlay_host_allow_opens_only_that_host(world, set_registry):
    world.add("trends.google.com", "/rss", 200, b"<rss/>", headers={"Content-Type": "application/xml"})
    world.add("trends.google.com", "/robots.txt", 404)
    set_registry([], overlay={"host_allow": ["trends.google.com"]})
    assert host_allowed("trends.google.com")
    assert not host_allowed("sub.trends.google.com")        # 그 호스트만
    assert not host_allowed("suggestqueries.google.com") and not host_allowed("sec.gov")
    assert capture("src:adhoc", "https://trends.google.com/rss").outcome == "captured"


def test_overlay_overrides_source_fields(set_registry):
    set_registry([mk_source("src:a", "https://a.example/", cls="rel")],
                 overlay={"sources": [{"id": "src:a", "policy": {"enabled": False, "tos": "unverified"}}]})
    s = load_registry()[0]
    assert not s.enabled and s.policy["tos"] == "unverified" and s.policy["robots"] == "enforce"


def test_adhoc_recorded_unverified_unknown(world, set_registry):
    world.add("a.example", "/x", 200, b"hi", headers={"Content-Type": "text/plain"})
    world.add("a.example", "/robots.txt", 404)
    set_registry([])
    r = capture("src:adhoc", "https://a.example/x")
    assert r.outcome == "captured"
    reg = [e for e in events("source.registered") if e["payload"]["id"] == "src:adhoc"]
    assert reg and reg[0]["payload"]["props"] == {"tos": "unverified", "trust": "unknown"}
    snap = events("snapshot.captured")[0]["payload"]
    assert snap["source"] == "src:adhoc" and snap["http_status"] == 200


def test_registered_source_rejects_foreign_url(world, set_registry):
    world.add("a.example", "/x", 200, b"hi")
    set_registry([mk_source("src:a", "https://a.example/x")])
    r = capture("src:a", "https://other.example/y")
    assert r.outcome == "policy_skip" and r.error == "url_not_in_source"
