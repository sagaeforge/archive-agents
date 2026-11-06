"""overlay 적용 뒤 P09c와 P04만 활성, host_allow는 두 경로의 호스트만 연다."""
import re

import pytest

from kb.collect import hostpolicy, registry

YT_GOOGLE_P = {"P01", "P02", "P03", "P04", "P05", "P06", "P07", "P08", "P09", "P11", "P12", "P13", "P14", "P15"}
ACTIVE_OK = {"P04", "P09"}      # P09는 Explore, 내부 API, RSS 셋을 묶은 항목이고 overlay는 RSS URL만 준다


def test_only_p04_and_p09c_active_among_p_series(env):
    srcs = {s.id: s for s in registry.load_registry()}
    active = {s.inventory_id for s in srcs.values() if s.enabled and s.inventory_id in YT_GOOGLE_P}
    assert active == ACTIVE_OK
    assert srcs["src:google-trends"].parser == "trends_rss@1" and srcs["src:yt-suggest"].parser == "google_suggest@1"
    for sid in ("src:yt-data-api", "src:yt-dlp", "src:innertube", "src:yt-channel-rss", "src:trends-api-alpha"):
        assert not srcs[sid].enabled


def test_p09_urls_are_only_the_rss_path(env):
    s = {x.id: x for x in registry.load_registry()}["src:google-trends"]
    for u in s.all_urls():
        assert u.startswith("https://trends.google.com/trending/rss?geo="), u      # Explore(/trends/explore), 내부 API 제외


def test_p04_urls_are_google_com_complete_search_only(env):
    s = {x.id: x for x in registry.load_registry()}["src:yt-suggest"]
    urls = s.all_urls()
    assert 40 <= len(urls) <= 100
    for u in urls:
        assert re.fullmatch(r"https://www\.google\.com/complete/search\?client=firefox&hl=(ko|en)&q=[^&\s]+", u), u
    assert {"A", "D"} <= set(s.domain) and s.fetch["interval_s"] >= 43200


def test_host_allow_opens_exactly_two_hosts(env):
    _, allow = registry.read_overlays()
    assert allow == {"trends.google.com", "www.google.com"}
    assert hostpolicy.host_allowed("trends.google.com") and hostpolicy.host_allowed("www.google.com")


@pytest.mark.parametrize("host", ["youtube.com", "www.youtube.com", "suggestqueries-clients6.youtube.com", "m.youtube.com",
                                  "youtu.be", "googlevideo.com", "suggestqueries.google.com", "i.ytimg.com", "youtube-nocookie.com"])
def test_other_hosts_stay_denied(env, host):
    assert not hostpolicy.host_allowed(host)


def test_sources_run_only_with_decision_1(env):
    s = {x.id: x for x in registry.load_registry()}
    assert registry.runnable(s["src:yt-suggest"]) == (True, None) and registry.runnable(s["src:google-trends"]) == (True, None)
    (env.cfg / "decisions.toml").write_text("approved = [2]\n")
    assert registry.runnable(s["src:yt-suggest"]) == (False, "decision_1_pending")
    assert registry.runnable(s["src:google-trends"]) == (False, "decision_1_pending")
