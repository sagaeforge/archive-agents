"""형식별 표시 본문과 어댑터: PDF, 정규화 JSON과 jsonpointer, sitemap, csv, html_index, raw_file, 선택자 종류."""
import json

import pytest

from kb.parse import adapters
from kb.parse.display import PDF_MIN_AVG_CHARS, display_text
from kb.parse.events import resolve_pointer
from kb.parse.model import Ctx

from .conftest import fx, make_pdf, mk_source


def ctx_for(name, parser, body, ctype="text/plain", url="https://t.example/x", hint=None, cfg=None, source=None):
    ad = adapters.ADAPTERS[parser]
    txt = display_text(body, ctype, hint=ad.hint, url=url)
    snap = {"id": "n-test", "url": url, "source": "src:t", "raw_sha": "0" * 64, "fetched_at": 1_790_000_000_000, "content_type": ctype}
    return ad, Ctx(snapshot=snap, raw=body, text=txt, source=source or mk_source(parser=parser + "@1"), cfg=cfg or {})


def test_pdf_text_extracted_per_page():
    page = "\n".join(f"Line {i} of the PDF page with enough words to pass the density check easily." for i in range(1, 6))
    t = display_text(make_pdf([page, page.replace("Line", "Row")]), "application/pdf")
    assert t.fmt == "pdf_text" and not t.needs_ocr and t.pages == 2
    assert "Line 3 of the PDF page" in t.text and "Row 5 of the PDF page" in t.text


def test_pdf_low_density_is_needs_ocr():
    t = display_text(make_pdf(["a", "b", "c"]), "application/pdf")
    assert t.needs_ocr and t.text == "" and PDF_MIN_AVG_CHARS == 200


def test_json_display_is_sorted_two_space_indent():
    t = display_text(b'{"b": 1, "a": {"z": [1, 2], "y": "\\ud55c"}}', "application/json")
    assert t.fmt == "json" and t.extractor == "json-canon@1"
    assert t.text == '{\n  "a": {\n    "y": "한",\n    "z": [\n      1,\n      2\n    ]\n  },\n  "b": 1\n}\n'


def test_github_release_uses_jsonpointer_resolving_in_display_doc():
    ad, c = ctx_for("r", "github_release", fx("gh_release.json"), "application/json",
                    url="https://api.github.com/repos/openai/codex/releases/latest")
    res = ad.parse(c)
    assert {cl.predicate for cl in res.claims} == {"latest_version", "released_on"}
    doc = json.loads(c.text.text)
    for cl in res.claims:
        assert cl.selector["selector_kind"] == "jsonpointer"
        assert resolve_pointer(doc, cl.selector["json_pointer"]) is not None
    lv = next(cl for cl in res.claims if cl.predicate == "latest_version")
    assert lv.value == doc["tag_name"] and lv.subject == "e:repo:openai-codex"


def test_github_release_error_body_gives_no_claims():
    ad, c = ctx_for("r", "github_release", b'{"message": "Not Found", "documentation_url": "x"}', "application/json",
                    url="https://api.github.com/repos/a/b/releases/latest")
    assert ad.parse(c).claims == []


def test_npm_and_repo_meta_and_hn_and_hf_and_mcp():
    ad, c = ctx_for("n", "npm_meta", fx("npm.json"), "application/json")
    r = ad.parse(c)
    assert next(x for x in r.claims if x.predicate == "latest_version").value == json.loads(fx("npm.json"))["version"]
    ad, c = ctx_for("g", "github_repo_meta", fx("gh_repo.json"), "application/json", url="https://api.github.com/repos/ggml-org/llama.cpp")
    r = ad.parse(c)
    assert r.entities[0].id == "e:repo:ggml-org-llama-cpp" and any(s.metric == "stars" for s in r.series)
    assert any(x.predicate == "license" for x in r.claims)
    ad, c = ctx_for("h", "hn_algolia", fx("hn.json"), "application/json")
    r = ad.parse(c)
    assert r.series[0].slug == "hn-hits-claude-code" and r.series[0].points[0]["value"].isdigit()
    ad, c = ctx_for("f", "hf_models", fx("hf.json"), "application/json")
    assert len(ad.parse(c).entities) == 3
    ad, c = ctx_for("m", "mcp_registry", fx("mcp.json"), "application/json")
    r = ad.parse(c)
    assert all(x.selector["json_pointer"].startswith("/servers/") for x in r.claims)


def test_sitemap_adapter_counts_urls_as_series():
    ad, c = ctx_for("s", "sitemap", fx("sitemap.xml"), "application/xml", url="https://claude.com/sitemap.xml")
    r = ad.parse(c)
    assert r.count == 25 and r.series[0].points[0]["value"] == "25" and r.series[0].points[0]["unit"] == "count"


def test_csv_adapter_rows_to_entities():
    ad, c = ctx_for("c", "csv", fx("awesome.csv"), "text/plain",
                    cfg={"label": "Display Name", "link": "Link", "type": "Tool", "prefix": "awesome-cc", "active": "Active"})
    r = ad.parse(c)
    assert r.count == len(r.entities) >= 8
    assert all(e.type == "Tool" and e.props.get("url", "").startswith("http") for e in r.entities)
    assert r.series[0].points[0]["value"] == str(r.count)


def test_html_index_adapter_links_from_selector():
    html = (b"<html><body><a href='/eng/a'>A post</a><a href='/eng/b'>B post</a><a href='/other'>x</a>"
            b"<a href='https://t.example/eng/a'>dup</a></body></html>")
    ad, c = ctx_for("i", "html_index", html, "text/html", url="https://t.example/eng", cfg={"selector": "a[href^='/eng/']"})
    r = ad.parse(c)
    assert r.count == 2 and {e.label for e in r.entities if e.label.endswith("post")} == {"A post", "B post"}
    assert {e.rtype for e in r.edges} == {"LINKS_TO"} and len(r.edges) == 2


def test_raw_file_adapter_makes_document_only():
    ad, c = ctx_for("r", "raw_file", b"fn main() {}\n// x\n", "text/plain", url="https://t.example/lib.rs")
    r = ad.parse(c)
    assert len(r.entities) == 1 and r.claims == [] and r.entities[0].props["lines"] == 3


def test_changelog_md_latest_and_release_entities():
    ad, c = ctx_for("cl", "changelog_md", fx("changelog.md"), "text/plain", url="https://raw.githubusercontent.com/o/r/main/CHANGELOG.md",
                    cfg={"entity": {"slug": "claude-code", "label": "Claude Code", "type": "Tool"}})
    r = ad.parse(c)
    assert r.count == 3
    lv = [x for x in r.claims if x.predicate == "latest_version"]
    assert len(lv) == 1 and lv[0].value == "2.1.316" and lv[0].subject == "e:tool:claude-code"
    assert c.text.text[lv[0].selector["start_cp"]:lv[0].selector["end_cp"]] == "## 2.1.316"
    assert any(e.id == "e:tool:claude-code-2.1.316" for e in r.entities)


def test_changelog_dated_headings_make_event_claims():
    body = b"# Changelog\n\n## [1.2.0] - 2026-10-01\n\n- a\n\n## [1.1.0] - 2026-09-01\n\n- b\n"
    ad, c = ctx_for("cl", "changelog_md", body, "text/plain", cfg={"entity": {"slug": "x", "label": "X", "type": "Tool"}})
    ev = [x for x in ad.parse(c).claims if x.predicate == "released_on"]
    assert {(x.value, x.kind) for x in ev} == {("2026-10-01", "event"), ("2026-09-01", "event")}


def test_feed_entries_become_event_claims_with_text_quote():
    ad, c = ctx_for("f", "rss_atom", fx("changelog_rss.xml"), "application/rss+xml")
    r = ad.parse(c)
    assert len(r.entities) == 3 and len(r.claims) == 3
    for cl in r.claims:
        assert cl.kind == "event" and cl.valid_from.startswith("20")
        assert c.text.text[cl.selector["start_cp"]:cl.selector["end_cp"]] == cl.selector["exact"]
    ad, c = ctx_for("a", "rss_atom", fx("blog_atom.xml"), "application/xml")
    assert len(ad.parse(c).claims) == 3


def test_llms_txt_and_kworb_and_codex_features():
    ad, c = ctx_for("l", "llms_txt", fx("llms.txt"), "text/plain", url="https://code.claude.com/docs/llms.txt")
    r = ad.parse(c)
    assert r.count > 10 and all(e.rtype == "LINKS_TO" for e in r.edges)
    ad, c = ctx_for("k", "kworb", fx("kworb.html"), "text/html", url="https://kworb.net/youtube/trending/kr.html")
    r = ad.parse(c)
    assert len(r.entities) == 10 and all(x.predicate == "chart_rank" and x.qualifiers == {"chart": "youtube-trending-kr-html"} for x in r.claims)
    ad, c = ctx_for("x", "codex_features", fx("codex_features.txt"), "text/plain", url="local://codex/features-list")
    r = ad.parse(c)
    assert {x.value for x in r.claims} == {"under_development", "stable", "removed", "experimental"}


def test_selector_kind_is_only_text_quote_or_jsonpointer():
    seen = set()
    cases = [("github_release", "gh_release.json", "application/json", {}), ("npm_meta", "npm.json", "application/json", {}),
             ("rss_atom", "changelog_rss.xml", "application/rss+xml", {}), ("changelog_md", "changelog.md", "text/plain", {}),
             ("kworb", "kworb.html", "text/html", {}), ("mcp_registry", "mcp.json", "application/json", {}),
             ("github_repo_meta", "gh_repo.json", "application/json", {}), ("codex_features", "codex_features.txt", "text/plain", {})]
    for parser, name, ct, cfg in cases:
        ad, c = ctx_for("z", parser, fx(name), ct, url="https://api.github.com/repos/a/b/releases/latest", cfg=cfg)
        for cl in ad.parse(c).claims:
            seen.add(cl.selector["selector_kind"])
    assert seen == {"text_quote", "jsonpointer"}


def test_adapters_autodiscovered_and_complete():
    want = {"changelog_md", "rss_atom", "llms_txt", "page_md", "raw_file", "sitemap", "csv", "html_index", "pdf_doc", "github_release",
            "github_repo_meta", "npm_meta", "pypi_meta", "hn_algolia", "hf_models", "mcp_registry", "arxiv", "kworb", "codex_features"}
    assert want <= set(adapters.ADAPTERS)
    from kb.parse import ADAPTERS
    assert ADAPTERS is adapters.ADAPTERS


def test_other_packages_adapters_module_is_autodiscovered(monkeypatch, tmp_path):
    import importlib
    import sys
    import textwrap
    import kb
    pkg = tmp_path / "zz_adapt"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    (pkg / "adapters.py").write_text(textwrap.dedent("""
        from kb.parse.adapters import adapter
        from kb.parse.model import Result
        @adapter("zz_custom")
        def zz(ctx):
            return Result()
    """))
    broken = tmp_path / "zz_adapt_broken"
    broken.mkdir()
    (broken / "__init__.py").write_text("")
    (broken / "adapters.py").write_text("import not_a_real_module_xyz\n")
    monkeypatch.setattr(kb, "__path__", list(kb.__path__) + [str(tmp_path)])
    importlib.invalidate_caches()
    try:
        adapters._discover()
        assert "zz_custom" in adapters.ADAPTERS and "changelog_md" in adapters.ADAPTERS
    finally:
        adapters.ADAPTERS.pop("zz_custom", None)
        sys.modules.pop("kb.zz_adapt.adapters", None)
