from kb.collect import registry
from kb.live.probe import CaptureFetcher


def test_owns_patterns_cover_live_urls():
    fx = CaptureFetcher(registry.load_registry())
    want = {
        "https://raw.githubusercontent.com/a/b/HEAD/README.md": "src:g4-gh-readme",
        "https://registry.npmjs.org/@scope/x": "src:g4-npm-registry",
        "https://pypi.org/pypi/foo/json": "src:g4-pypi-registry",
        "https://ollama.com/blog/x": "src:g4-feed-items-official",
        "https://status.openai.com/incidents/abc": "src:g4-feed-items-official",
        "https://news.hada.io/topic?id=1": "src:g4-feed-items-geeknews",
    }
    for url, sid in want.items():
        o = fx.owner(url)
        assert o is not None and o.id == sid, url


def test_codex_docs_accepts_octet_stream_manual():
    s = registry.get_source("src:codex-docs")
    assert "application/octet-stream" in s.expect["content_type"]
    assert "application/octet-stream" not in registry.get_source("src:codex-changelog").expect["content_type"]
