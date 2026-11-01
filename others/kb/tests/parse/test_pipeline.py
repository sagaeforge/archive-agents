"""끝에서 끝까지: snapshot.captured -> tick 4단계 -> 표시 본문, 문단, 엔티티, 주장, 시계열. reparse. 레지스트리 동기화."""
import json
from types import SimpleNamespace

import yaml

from kb.core import cas
from kb.parse import pipeline, registry_sync, tick_stage, tick_stage_registry

from .conftest import capture, fx, gold, make_pdf, mk_source


def tctx():
    return SimpleNamespace(expired=lambda: False, counters={"parsed": 0}, warnings=[], errors=[], only=None)


def set_registry(env, sources):
    (env.share / "sources" / "domains" / "t.yaml").write_text(yaml.safe_dump({"sources": sources}, allow_unicode=True))


def src_raw(sid, parser, url, **kw):
    d = {"id": sid, "name": sid, "domain": ["G"], "class": "rel", "parser": parser, "fetch": {"kind": "https", "url": url},
         "policy": {"enabled": True, "tos": "allowed", "tos_ref": "https://t.example/tos", "robots": "enforce", "trust": "primary"}}
    d.update(kw)
    return d


def test_tick_stage_parses_changelog_into_gold(env):
    url = "https://raw.githubusercontent.com/o/r/main/CHANGELOG.md"
    set_registry(env, [src_raw("src:cl", "changelog_md@1", url, parse={"entity": {"slug": "claude-code", "label": "Claude Code", "type": "Tool"}},
                               expect={"entries_never_shrink": True})])
    snap = capture(url, fx("changelog.md"), "text/plain", source="src:cl")
    res = tick_stage.run(tctx())
    assert res.ok and res.detail["parsed"] == 1
    con = gold()
    row = con.execute("SELECT id, type, label FROM node WHERE id='e:tool:claude-code-2.1.316' AND expired_at IS NULL").fetchone()
    assert row == ("e:tool:claude-code-2.1.316", "Tool", "Claude Code 2.1.316")
    cl = con.execute("SELECT c.value, c.method, n.verification FROM node n JOIN claim c ON c.vid=n.vid WHERE c.predicate='latest_version' "
                     "AND n.expired_at IS NULL").fetchall()
    assert cl == [("2.1.316", "deterministic", "parser_derived")]
    ev = con.execute("SELECT selector_kind, start_cp, end_cp, text_sha FROM evidence").fetchone()
    assert ev[0] == "text_quote"
    node = con.execute("SELECT props FROM node WHERE id=? AND expired_at IS NULL", (snap["id"],)).fetchone()
    from kb.project.apply import jl
    props = jl(node[0])
    text = cas.get(props["text_sha"]).decode()
    assert text[ev[1]:ev[2]] == "## 2.1.316" and ev[3] == props["text_sha"]
    paras = json.loads(cas.get(props["paras_sha"]))
    assert paras and props["extractor"] == "passthrough-nfc@1" and props["text_format"] == "markdown"
    assert con.execute("SELECT count(*) FROM span WHERE snapshot_id=? AND ref_kind='document' AND rec_to IS NULL", (snap["id"],)).fetchone()[0] == len(paras)


def test_tick_stage_is_incremental(env):
    set_registry(env, [src_raw("src:cl", "changelog_md@1", "https://t.example/CHANGELOG.md")])
    capture("https://t.example/CHANGELOG.md", fx("changelog.md"), "text/plain", source="src:cl")
    assert tick_stage.run(tctx()).detail["parsed"] == 1
    assert tick_stage.run(tctx()).detail["parsed"] == 0
    capture("https://t.example/other.md", b"# Other\n\nbody text", "text/markdown", source="src:cl")
    r = tick_stage.run(tctx())
    assert r.detail["parsed"] == 1


def _events():
    from kb.core import ledger
    led = ledger.open_ledger()
    try:
        return led.execute("select count(*) from event").fetchone()[0]
    finally:
        led.close()


def test_only_reparses_latest_snapshot_without_new_events(env):
    url = "https://t.example/CHANGELOG.md"
    set_registry(env, [src_raw("src:cl", "changelog_md@1", url, parse={"entity": {"slug": "claude-code", "label": "Claude Code", "type": "Tool"}}),
                       src_raw("src:other", "page_md@1", "https://t.example/o.md")])
    snap = capture(url, fx("changelog.md"), "text/plain", source="src:cl")
    capture("https://t.example/o.md", b"# Other\n\nbody text", "text/markdown", source="src:other")
    assert tick_stage.run(tctx()).detail["parsed"] == 2
    n0 = _events()
    only = SimpleNamespace(**{**vars(tctx()), "only": "src:cl"})
    r = tick_stage.run(only)
    assert r.ok and r.detail["parsed"] == 1 and r.detail["reparsed_only"] == snap["id"]
    assert _events() == n0                      # 같은 파서 버전이면 원장이 늘지 않는다
    assert tick_stage.run(tctx()).detail["parsed"] == 0     # --only가 아니면 증분 그대로


def test_only_counts_new_snapshot_once_and_unknown_source_is_zero(env):
    url = "https://t.example/CHANGELOG.md"
    set_registry(env, [src_raw("src:cl", "changelog_md@1", url)])
    capture(url, fx("changelog.md"), "text/plain", source="src:cl")
    r = tick_stage.run(SimpleNamespace(**{**vars(tctx()), "only": "src:cl"}))
    assert r.detail["parsed"] == 1 and "reparsed_only" not in r.detail
    r = tick_stage.run(SimpleNamespace(**{**vars(tctx()), "only": "src:none"}))
    assert r.ok and r.detail["parsed"] == 0


def test_series_events_land_in_gold(env):
    url = "https://claude.com/sitemap.xml"
    set_registry(env, [src_raw("src:sm", "sitemap@1", url)])
    capture(url, fx("sitemap.xml"), "application/xml", source="src:sm")
    assert tick_stage.run(tctx()).ok
    con = gold()
    rows = con.execute("SELECT series_id, value, unit FROM series_obs WHERE expired_at IS NULL").fetchall()
    assert len(rows) == 1 and rows[0][1:] == ("25", "count") and rows[0][0].startswith("s:")
    assert con.execute("SELECT type FROM node WHERE id=? AND expired_at IS NULL", (rows[0][0],)).fetchone() == ("Series",)


def test_hidden_text_never_reaches_stored_display_text(env):
    url = "https://t.example/page"
    set_registry(env, [src_raw("src:pg", "page_md@1", url)])
    html = ("<html><head><title>t</title></head><body><article><h1>시험</h1>" + "".join(f"<p>보이는 문장 {i} 이다 충분히 길게 써서 본문으로 남게 한다.</p>" for i in range(6)) +
            "<p style='display:none'>SECRET_HIDDEN_X</p></article></body></html>")
    snap = capture(url, html.encode(), "text/html", source="src:pg")
    tick_stage.run(tctx())
    from kb.project.apply import jl
    props = jl(gold().execute("SELECT props FROM node WHERE id=? AND expired_at IS NULL", (snap["id"],)).fetchone()[0])
    t = cas.get(props["text_sha"]).decode()
    assert "SECRET_HIDDEN_X" not in t and "보이는 문장 3" in t and props["extractor"].startswith("trafilatura-2.3.1")
    assert snap["raw_sha"] != props["text_sha"] and b"SECRET_HIDDEN_X" in cas.get(snap["raw_sha"])      # 원본은 그대로 보존


def test_pdf_low_density_goes_to_dlq_needs_ocr(env):
    url = "https://t.example/r.pdf"
    set_registry(env, [src_raw("src:pdf", "pdf_doc@1", url, expect={"needs_pdf": True})])
    snap = capture(url, make_pdf(["x", "y"]), "application/pdf", source="src:pdf")
    res = tick_stage.run(tctx())
    assert res.detail.get("needs_ocr") == 1
    from kb.collect.state import State
    with State() as st:
        rows = st.dlq_list("needs_ocr")
    assert [r["ref"] for r in rows] == [snap["id"]]
    assert gold().execute("SELECT count(*) FROM span WHERE snapshot_id=?", (snap["id"],)).fetchone()[0] == 0


def test_pdf_with_text_makes_pdf_text_snapshot(env):
    url = "https://t.example/ok.pdf"
    set_registry(env, [src_raw("src:pdf", "pdf_doc@1", url, expect={"needs_pdf": True})])
    page = "\n".join(f"Row {i}: audience research figures reported for the year in this survey document." for i in range(1, 6))
    snap = capture(url, make_pdf([page, page]), "application/pdf", source="src:pdf")
    assert tick_stage.run(tctx()).ok
    from kb.project.apply import jl
    props = jl(gold().execute("SELECT props FROM node WHERE id=? AND expired_at IS NULL", (snap["id"],)).fetchone()[0])
    assert props["text_format"] == "pdf_text" and "Row 3:" in cas.get(props["text_sha"]).decode()


def test_structure_guard_blocks_shrinking_changelog(env):
    url = "https://t.example/CHANGELOG.md"
    set_registry(env, [src_raw("src:cl", "changelog_md@1", url, expect={"entries_never_shrink": True},
                               parse={"entity": {"slug": "p", "label": "P", "type": "Tool"}})])
    capture(url, fx("changelog.md"), "text/plain", source="src:cl")
    tick_stage.run(tctx())
    body = fx("changelog.md").decode()
    short = body[:body.index("## 2.1.312")]
    capture(url, short.encode(), "text/plain", source="src:cl")
    res = tick_stage.run(tctx())
    assert res.detail.get("guard") == 1
    from kb.collect.state import State
    with State() as st:
        assert [r["kind"] for r in st.dlq_list("parse")] == ["parse"] and "entries_shrank" in st.dlq_list("parse")[0]["error"]


def test_discovered_subpage_uses_page_md(env):
    index = "https://code.claude.com/docs/llms.txt"
    set_registry(env, [src_raw("src:docs", "llms_txt@1", index, fetch={"kind": "https", "url": index,
                               "discover": {"kind": "llms_txt", "max_pages": 10}})])
    s1 = capture(index, fx("llms.txt"), "text/plain", source="src:docs")
    s2 = capture("https://code.claude.com/docs/en/a.md", b"# Page A\n\nBody of the page.\n", "text/markdown", source="src:docs")
    res = tick_stage.run(tctx())
    assert res.detail["parsed"] == 2
    con = gold()
    assert con.execute("SELECT label FROM node WHERE type='Document' AND label='Page A' AND expired_at IS NULL").fetchone()
    assert con.execute("SELECT count(*) FROM edge WHERE rtype='LINKS_TO' AND expired_at IS NULL").fetchone()[0] > 5


def test_reparse_reuses_stored_text_and_is_idempotent(env):
    from kb.commands import reparse
    url = "https://api.github.com/repos/o/r/releases/latest"
    raw = src_raw("src:rel", "github_release@1", url)
    set_registry(env, [raw])
    snap = capture(url, json.dumps({"tag_name": "v1", "published_at": "2026-10-29T00:00:00Z"}).encode(), "application/json", source="src:rel")
    tick_stage.run(tctx())
    from kb.core import ledger
    led = ledger.open_ledger()
    n0 = led.execute("select count(*) from event").fetchone()[0]
    led.close()
    args = SimpleNamespace(source="src:rel", snapshot=None, latest=False, json=True)
    assert reparse._cmd(args) == 0
    led = ledger.open_ledger()
    n1 = led.execute("select count(*) from event").fetchone()[0]
    led.close()
    assert n1 == n0           # 같은 파서 버전이면 새 이벤트가 없다(멱등)
    assert reparse._cmd(SimpleNamespace(source="src:nope", snapshot=None, latest=False, json=True)) == 2


def test_reparse_with_new_parser_version_adds_events(env, monkeypatch):
    from kb.commands import reparse
    from kb.parse import adapters
    url = "https://api.github.com/repos/o/r/releases/latest"
    set_registry(env, [src_raw("src:rel", "github_release@1", url)])
    capture(url, json.dumps({"tag_name": "v1", "published_at": "2026-10-29T00:00:00Z"}).encode(), "application/json", source="src:rel")
    tick_stage.run(tctx())
    old = adapters.ADAPTERS["github_release"]
    monkeypatch.setitem(adapters.ADAPTERS, "github_release", adapters.Adapter("github_release", old.parse, old.hint, version=2))
    from kb.core import ledger
    led = ledger.open_ledger(); n0 = led.execute("select count(*) from event").fetchone()[0]; led.close()
    assert reparse._cmd(SimpleNamespace(source="src:rel", snapshot=None, latest=False, json=True)) == 0
    led = ledger.open_ledger(); n1 = led.execute("select count(*) from event").fetchone()[0]; led.close()
    assert n1 > n0


def test_registry_sync_registers_sources_and_gone_status(env):
    set_registry(env, [src_raw("src:a", "page_md@1", "https://t.example/a", inventory_id="C01"),
                       src_raw("src:b", "page_md@1", "https://t.example/b")])
    r = tick_stage_registry.run()
    assert r.ok and r.detail["registered"] == 2
    con = gold()
    row = con.execute("SELECT label, type FROM node WHERE id='src:a' AND expired_at IS NULL").fetchone()
    assert row == ("src:a", "Source")
    assert tick_stage_registry.run().detail["registered"] == 0          # 변경이 없으면 쓰지 않는다
    from kb.collect.state import State
    with State() as st:
        st.put("src:a", None, state="gone")
    r = tick_stage_registry.run()
    assert r.detail["gone"] == 1
    assert gold().execute("SELECT link_status FROM node WHERE id='src:a' AND expired_at IS NULL").fetchone() == ("gone",)
    assert tick_stage_registry.run().detail["gone"] == 0


def test_registry_sync_reflects_decision_changes(env):
    set_registry(env, [src_raw("src:d", "page_md@1", "https://t.example/d")])
    reg = yaml.safe_load((env.share / "sources" / "domains" / "t.yaml").read_text())
    reg["sources"][0]["policy"]["requires_decision"] = 9
    (env.share / "sources" / "domains" / "t.yaml").write_text(yaml.safe_dump(reg))
    assert registry_sync.sync()["registered"] == 1
    (env.cfg / "decisions.toml").write_text("approved = [9]\n")
    assert registry_sync.sync()["registered"] == 1         # 승인으로 실행 가능 판정이 바뀌면 다시 쓴다


def test_stage_modules_export_stages_for_tick_autodiscovery():
    assert tick_stage.STAGES[0][:2] == (4, "parse") and tick_stage_registry.STAGES[0][:2] == (2, "registry")
    from kb.collect.tick import discover_stages
    found, failed = discover_stages()
    assert (2, "registry") in found and (4, "parse") in found and not failed
