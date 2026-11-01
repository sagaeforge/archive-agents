"""활성 URL의 robots 판정이 고정 표본(2026-11-01 실측)과 일치한다. 네트워크 없음."""
import json
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from kb.collect import registry, robots

from .conftest import base_sources

REPO = Path(__file__).resolve().parents[2]
SAMPLE = json.loads((Path(__file__).resolve().parent / "fixtures" / "robots_samples.json").read_text(encoding="utf-8"))["hosts"]


def allowed(url: str) -> bool:
    h = urlsplit(url).hostname
    s = SAMPLE[h]
    if s["status"] != 200:
        return True            # robots.txt가 없으면 허용(RFC 9309)
    return robots.Robots.parse(s["body"]).allowed(robots.path_query(url))


@pytest.fixture(scope="module")
def srcs(tmp_path_factory):
    """overlay 호스트의 robots는 WP-24가 잰다. 이 표본은 기본 레지스트리 범위다."""
    return registry.load_registry(base_sources(tmp_path_factory.mktemp("base-sources")))


def test_every_enforce_source_url_is_allowed(srcs):
    seen = 0
    for s in srcs:
        if s.enabled and s.policy["robots"] == "enforce":
            for u in s.all_urls():
                assert allowed(u), f"{s.id}: robots 거부 {u}"
                seen += 1
    assert seen > 100


def test_official_api_sources_are_robots_denied_and_documented(srcs):
    ofc = [s for s in srcs if s.enabled and s.policy["robots"] == "official_api"]
    # ADR 23장 결정 8: X15, D16, X17의 PyPI와 M07~M09(PyPI JSON API). 뒤의 것은 생존 판정용 소유 소스다.
    assert {s.inventory_id or s.id for s in ofc} == {"X15", "D16", "X17", "src:g4-pypi-registry"}
    for s in ofc:
        assert s.policy["tos_ref"]
        for u in s.all_urls():
            assert not allowed(u), f"{s.id}: robots가 허용하면 official_api가 필요 없다 {u}"


def test_known_denied_samples():
    assert not allowed("https://github.com/anthropics/claude-code/releases.atom")
    assert not allowed("https://github.com/anthropics/claude-code/commits/main/CHANGELOG.md.atom") if "github.com" in SAMPLE else True
    assert not allowed("https://pypi.org/pypi/pyyaml/json")
    assert not allowed("https://export.arxiv.org/api/query?search_query=all:x")
    assert allowed("https://api.github.com/repos/anthropics/claude-code/releases/latest")
    assert allowed("https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md")


def test_sample_covers_every_registry_host(srcs):
    hosts = {urlsplit(u).hostname for s in srcs if s.enabled for u in s.all_urls()}
    assert hosts <= set(SAMPLE)
