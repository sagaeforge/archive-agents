"""discover: 순수 함수, 결정적, 같은 호스트만, 프래그먼트와 중복 제거, include/exclude, 네트워크 0회."""
import socket

import pytest

from kb.collect.discover import load_discoverers
from kb.parse import discover

from .conftest import fx

BASE = "https://code.claude.com/docs/llms.txt"


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("네트워크 호출")
    monkeypatch.setattr(socket, "socket", boom)
    monkeypatch.setattr(socket, "create_connection", boom)
    monkeypatch.setattr(socket, "getaddrinfo", boom)


def test_discoverers_autodiscovered_by_collect():
    d, warn = load_discoverers()
    assert warn is None and set(d) == {"llms_txt", "sitemap", "html_index"} == set(discover.DISCOVERERS)


def test_llms_txt_same_host_fragment_dedup_order():
    body = (b"# Docs\n\n- [A](https://code.claude.com/docs/en/a.md): x\n- [B](/docs/en/b.md#sec)\n- [A again](https://code.claude.com/docs/en/a.md)\n"
            b"- [Other](https://example.com/docs/c.md)\nhttps://code.claude.com/docs/en/bare.md\n")
    out = discover.llms_txt(body, BASE, {})
    assert out == ["https://code.claude.com/docs/en/a.md", "https://code.claude.com/docs/en/b.md", "https://code.claude.com/docs/en/bare.md"]
    assert discover.llms_txt(body, BASE, {}) == out


def test_llms_txt_fixture_deterministic_and_filtered():
    a = discover.llms_txt(fx("llms.txt"), BASE, {})
    assert a and a == discover.llms_txt(fx("llms.txt"), BASE, {})
    assert all(u.startswith("https://code.claude.com/") and "#" not in u for u in a) and len(a) == len(set(a))
    only = discover.llms_txt(fx("llms.txt"), BASE, {"include": r"/docs/en/"})
    assert only and set(only) <= set(a)
    none = discover.llms_txt(fx("llms.txt"), BASE, {"exclude": [r"/docs/"]})
    assert none == []


def test_sitemap_urlset_and_index():
    urlset = (b'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://claude.com/a</loc></url>'
              b'<url><loc>https://claude.com/b#x</loc></url><url><loc>https://claude.com/a</loc></url><url><loc>https://other.example/c</loc></url></urlset>')
    assert discover.sitemap(urlset, "https://claude.com/sitemap.xml", {}) == ["https://claude.com/a", "https://claude.com/b"]
    index = (b'<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://claude.com/s1.xml</loc></sitemap>'
             b'<sitemap><loc>https://claude.com/s2.xml</loc></sitemap></sitemapindex>')
    assert discover.sitemap(index, "https://claude.com/sitemap.xml", {}) == ["https://claude.com/s1.xml", "https://claude.com/s2.xml"]
    assert discover.sitemap(fx("sitemap.xml"), "https://claude.com/sitemap.xml", {"include": "check-files"}) == ["https://claude.com/check-files"]
    assert discover.sitemap(b"<not xml", "https://claude.com/s.xml", {}) is not None


def test_sitemap_ignores_external_entities():
    evil = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><urlset><url><loc>https://claude.com/&e;</loc></url></urlset>'
    out = discover.sitemap(evil, "https://claude.com/s.xml", {})
    assert all("root:" not in u for u in out)


def test_html_index_selector_and_relative():
    html = (b"<html><body><nav><a href='/home'>h</a></nav><ul class='posts'><li><a href='/engineering/a'>A</a></li>"
            b"<li><a href='https://www.anthropic.com/engineering/b?x=1#f'>B</a></li><li><a href='https://evil.example/c'>C</a></li>"
            b"<li><a href='mailto:x@y'>m</a></li></ul></body></html>")
    base = "https://www.anthropic.com/engineering"
    assert discover.html_index(html, base, {"selector": "ul.posts a[href]"}) == [
        "https://www.anthropic.com/engineering/a", "https://www.anthropic.com/engineering/b?x=1"]
    assert discover.html_index(html, base, {"selector": "ul.posts a[href]", "exclude": "/a$"}) == [
        "https://www.anthropic.com/engineering/b?x=1"]
    assert "https://www.anthropic.com/home" in discover.html_index(html, base, {})
