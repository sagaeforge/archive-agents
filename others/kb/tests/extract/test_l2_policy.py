"""L2 적재 정책(ADR-0004 D1): none 소스는 새 L2 행 0, prose 소스는 산문만, all은 그대로. 기존 행은 skipped_policy(멱등, 삭제 없음)."""
import json

from kb.core import ledger, opsdb
from kb.extract import policy, tick_stage

from . import helpers as H

DOC = ("# 샘플 패키지\n\n"
       "샘플도구 2.0은 2026-10-01에 출시되었다. 이 버전부터 기본 제한은 10000건이다.\n\n"
       '{"name": "sample", "version": "2.0.0", "license": "MIT"}\n\n'
       "샘플도구는 하루 최대 500건의 요청을 지원한다고 공식 문서가 밝힌다.\n")


JSON_BODY = json.dumps({"info": {"name": "sample", "version": "2.0.0", "summary": "샘플도구는 하루 최대 500건의 요청을 지원한다고 공식 문서가 밝힌다."},
                        "releases": {"1.0.0": [], "2.0.0": []}}, ensure_ascii=False)


def body_for(src):
    return DOC if src in ("src:cc-docs-ko", "src:cc-docs-en", "src:adhoc", "src:mixed") else JSON_BODY


def states(kind="l2"):
    c = opsdb.connect()
    try:
        return dict(c.execute("SELECT state, count(*) FROM queue WHERE kind=? GROUP BY state", (kind,)).fetchall())
    finally:
        c.close()


def ledger_n():
    led = ledger.open_ledger()
    try:
        return led.execute("SELECT count(*) FROM event").fetchone()[0]
    finally:
        led.close()


def test_registry_policy_table_matches_adr_categories():
    from kb.collect import registry
    from kb.parse import adapters
    srcs = registry.load_registry(validate=False)
    assert policy.invalid(srcs) == []
    tab = policy.table(srcs)
    two = {k: v[:2] for k, v in tab.items()}
    assert two["src:pypi-meta"] == ("declared", "S")              # README(info.description)만 L2
    assert two["src:g4-npm-registry"] == ("declared", "S")        # raw_file@1에서 npm_meta@1로 옮겼다. packument readme만 L2
    assert two["src:awesome-claude-code"] == ("declared", "S") and tab["src:awesome-claude-code"][3]["prose"] == ["Description"]
    assert two["src:hn-algolia-g"] == ("declared", "S")
    assert two["src:hf-models"] == ("none", "S") and two["src:mcp-registry"] == ("none", "S")
    assert two["src:cc-docs-ko"] == ("none", "X")
    assert two["src:cc-docs-en"] == ("all", "P")
    assert two["src:adhoc"] == ("all", "U")
    assert two["src:cc-changelog-gh"][1] == "C" and two["src:cc-changelog-gh"][0] == "all"
    # S 범주는 none이거나 파서가 산문을 선언한 declared다. X는 none이다
    assert all(p in ("none", "declared") for p, c in two.values() if c == "S")
    assert all(p == "none" for p, c in two.values() if c == "X")
    for k, (p, _c, parser, _cfg) in tab.items():
        if p == "declared":
            assert adapters.get(parser).prose is not None, k
    assert {s.id: s.parser for s in srcs}["src:g4-npm-registry"] == "npm_meta@1"


def test_none_policy_sources_add_no_rows_but_all_sources_enqueue(env):
    for i, (src, dom) in enumerate([("src:pypi-meta", "F"), ("src:cc-docs-ko", "G"), ("src:g4-npm-registry", "G")]):
        H.ingest_doc(f"https://example.test/{i}.md", body_for(src), source=src, domain=(dom,))
    assert H.queue_n() == 0
    H.ingest_doc("https://example.test/en.md", DOC, source="src:cc-docs-en")
    H.ingest_doc("https://example.test/adhoc.md", DOC, source="src:adhoc")
    assert H.queue_n() > 0
    q = H.queue_n()
    # 같은 이벤트를 다시 훑어도(커서 0) none 소스는 늘지 않는다
    from kb.extract import state
    state.put(tick_stage.CURSOR, 0)
    out = tick_stage.enqueue_new()
    assert H.queue_n() == q and out["skipped_policy"] >= 3 * 2


def test_prose_policy_keeps_sentences_and_drops_structured_paragraphs(env, monkeypatch):
    tab = dict(policy.table())
    tab["src:mixed"] = ("prose", "P")
    monkeypatch.setattr(policy, "table", lambda srcs=None: tab)
    H.ingest_doc("https://example.test/mixed.md", DOC, source="src:mixed")
    H.ingest_doc("https://example.test/all.md", DOC, source="src:adhoc")
    c = opsdb.connect()
    try:
        by = {}
        for ref, in c.execute("SELECT ref FROM queue WHERE kind='l2'"):
            by.setdefault(ref.split("|")[0], 0)
            by[ref.split("|")[0]] += 1
    finally:
        c.close()
    counts = sorted(by.values())
    assert counts == [2, 4]          # prose 소스: 문장 2개만(짧은 제목 줄과 JSON 문단은 빠진다. 제목은 창의 heading_path로 따라간다). adhoc: 전부


def test_is_prose_is_conservative():
    assert policy.is_prose("샘플도구는 하루 최대 500건의 요청을 지원한다고 공식 문서가 밝힌다.")
    assert policy.is_prose("This release adds support for streaming responses in the SDK.")
    assert not policy.is_prose('{"name": "sample", "version": "2.0.0"}')
    assert not policy.is_prose('  "a": 1,\n  "b": 2,\n  "c": "x"')
    assert not policy.is_prose("[1, 2, 3, 4, 5]")
    assert not policy.is_prose("12345 67890 11 22 33 44")
    assert not policy.is_prose("")


def test_sweep_marks_existing_rows_skipped_policy_idempotently_without_deleting(env, monkeypatch):
    H.ingest_doc("https://example.test/a.md", JSON_BODY, source="src:pypi-meta", domain=("F",), enqueue=False)
    H.ingest_doc("https://example.test/b.md", DOC, source="src:cc-docs-en")
    # 옛 동작: 정책 없이 pypi-meta 문단도 큐에 있었다
    real = policy.table
    monkeypatch.setattr(policy, "table", lambda srcs=None: {**real(), "src:pypi-meta": ("all", "S")})
    from kb.extract import state
    state.put(tick_stage.CURSOR, 0)
    tick_stage.enqueue_new()
    monkeypatch.setattr(policy, "table", real)
    before = states()
    total = sum(before.values())
    assert before.get("queued", 0) == total and total > 0
    n_ledger = ledger_n()
    c = opsdb.connect()
    try:
        dry = policy.sweep(c, dry_run=True)
        assert states() == before and dry["skipped"] > 0
        out = policy.sweep(c)
        again = policy.sweep(c)
    finally:
        c.close()
    assert out["skipped"] == dry["skipped"] and out["by_category"] == {"S": out["skipped"]} and out["by_source"] == {"src:pypi-meta": out["skipped"]}
    assert again["skipped"] == 0                                   # 멱등
    after = states()
    assert sum(after.values()) == total                            # 행은 지우지 않는다
    assert after["skipped_policy"] == out["skipped"] and after["queued"] == total - out["skipped"] > 0
    assert ledger_n() == n_ledger                                  # 원장은 건드리지 않는다
    c = opsdb.connect()
    try:
        taken = opsdb.queue_take(c, "l2", 1000)
        assert taken and all("|" in t["ref"] for t in taken)
        assert states().get("skipped_policy") == out["skipped"]    # 꺼내기는 skipped_policy를 건드리지 않는다
        for t in taken:
            opsdb.queue_done(c, "l2", t["ref"], requeue_at=1)      # 되돌려도 skipped_policy는 되살아나지 않는다
        assert states().get("skipped_policy") == out["skipped"]    # 되돌려도 skipped_policy는 되살아나지 않는다
    finally:
        c.close()


def test_sweep_if_changed_runs_once_per_policy_signature(env, monkeypatch):
    H.ingest_doc("https://example.test/a.md", DOC, source="src:adhoc")
    n = H.queue_n()
    tab = dict(policy.table())
    monkeypatch.setattr(policy, "table", lambda srcs=None: tab)
    first = policy.sweep_if_changed()
    assert first["swept"] and first["skipped"] == 0
    assert policy.sweep_if_changed() == {"skipped": 0, "swept": False}
    tab["src:adhoc"] = ("none", "U")                                # 정책이 바뀌면 다시 훑는다
    third = policy.sweep_if_changed()
    assert third["swept"] and third["skipped"] == n
    assert states() == {"skipped_policy": n}
    res = tick_stage.run(None)
    assert res.ok and res.detail["policy_sweep"] == {"skipped": 0, "swept": False}


def test_queue_stats_reports_zero_queued_new_for_s_and_x_after_a_tick(env, monkeypatch, capsys):
    from kb import cli
    real = policy.table
    for i, src in enumerate(["src:pypi-meta", "src:cc-docs-ko", "src:g4-npm-registry"]):
        H.ingest_doc(f"https://example.test/old{i}.md", body_for(src), source=src, enqueue=False)
    H.ingest_doc("https://example.test/en.md", DOC, source="src:cc-docs-en", enqueue=False)
    monkeypatch.setattr(policy, "table", lambda srcs=None: {**real(), **{k: ("all", v[1]) for k, v in real().items()}})
    from kb.extract import state
    state.put(tick_stage.CURSOR, 0)
    tick_stage.enqueue_new()                                        # 옛 동작으로 S, X 행을 큐에 쌓아 둔다
    monkeypatch.setattr(policy, "table", real)
    assert cli.main(["queue", "stats", "--by-source", "--json"]) == 0
    pre = json.loads(capsys.readouterr().out)
    bad = lambda o: sum(s["queued_new"] for s in o["sources"] if s["category"] in ("S", "X"))      # noqa: E731
    assert bad(pre) > 0
    state.put(tick_stage.CURSOR, 0)
    assert tick_stage.run(None).ok                                  # 한 번의 tick: 새 행 0, 기존 행 sweep
    assert cli.main(["queue", "stats", "--by-source", "--json"]) == 0
    post = json.loads(capsys.readouterr().out)
    assert bad(post) == 0
    s = {x["source"]: x for x in post["sources"]}
    assert s["src:cc-docs-ko"]["category"] == "X" and s["src:cc-docs-ko"]["skipped_policy"] > 0 and s["src:cc-docs-ko"]["queued"] == 0
    assert s["src:cc-docs-en"]["queued"] > 0 and s["src:cc-docs-en"]["policy"] == "all"
    assert post["totals"]["rows"] == pre["totals"]["rows"]
    assert post["categories"]["S"]["skipped_policy"] == pre["categories"]["S"]["queued"]
    assert cli.main(["queue", "sweep", "--dry-run", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["skipped"] == 0


def test_queue_left_and_reextract_ignore_skipped_policy(env, monkeypatch):
    from kb.extract import runner
    H.ingest_doc("https://example.test/a.md", DOC, source="src:adhoc")
    n = runner.queue_left()
    tab = {**policy.table(), "src:adhoc": ("none", "U")}
    monkeypatch.setattr(policy, "table", lambda srcs=None: tab)
    c = opsdb.connect()
    try:
        assert policy.sweep(c)["skipped"] == n
    finally:
        c.close()
    assert runner.queue_left() == 0
    runner.unattempted(next(iter(_refs())))                         # 되돌리기도 skipped_policy를 살리지 않는다
    assert runner.queue_left() == 0


def _refs():
    c = opsdb.connect()
    try:
        return [r[0] for r in c.execute("SELECT ref FROM queue WHERE kind='l2'")]
    finally:
        c.close()


def test_take_never_hands_out_a_none_policy_row_even_if_it_was_requeued(env, monkeypatch):
    from kb.ingest.process import Processor
    from kb.extract import order
    H.ingest_doc("https://example.test/a.md", DOC, source="src:adhoc")
    n = H.queue_n()
    real = policy.table
    monkeypatch.setattr(policy, "table", lambda srcs=None: {**real(), "src:adhoc": ("none", "U")})
    proc = Processor({"item": "bundle", "contract": "kb-ingest/1", "batch_id": "t", "producer": "agent:t"}, fetch=False, write=True)
    c = opsdb.connect()
    try:
        assert order.take(proc, c, "l2", 100, {}) == []
    finally:
        c.close()
        proc.gold.close()
    assert states() == {"skipped_policy": n}


# ---------------------------------------------------------------- declared: 파서가 선언한 산문만(D1 재작업)

README = ("# Samplepkg\n\n"
          "Samplepkg는 영상 자막을 내려받아 문단으로 나누는 도구다. 2.0부터 YouTube Data API v3 키 없이도 공개 자막을 읽는다.\n\n"
          "## 사용법\n\n" + "명령 하나로 채널의 최근 영상 50개 자막을 받는다고 저장소 문서가 밝힌다. " * 12 + "\n\n"
          "## 제한\n\n하루 요청은 기본 10000건으로 제한된다고 README가 밝힌다.\n")


def _pypi_body() -> str:
    return json.dumps({"info": {"name": "samplepkg", "version": "2.0.0", "license_expression": "MIT", "summary": "자막 도구",
                                "classifiers": [f"Topic :: Multimedia :: Video :: Item {i}" for i in range(40)],
                                "description": README, "description_content_type": "text/markdown"},
                       "releases": {f"1.{i}.0": [{"filename": f"samplepkg-1.{i}.0.tar.gz", "size": 1000 + i, "yanked": False}]
                                    for i in range(25)}}, ensure_ascii=False)


def _expected(body: str, fmt_hint: str, spans_of):
    """독립 계산: 표시 본문, 문단, 선언 구간과 겹치는 문단의 ref 집합."""
    from kb.extract import windows
    from kb.parse import display, paragraphs as pg
    t = display.display_text(body.encode("utf-8"), None, hint=fmt_hint)
    paras = pg.paragraphs(t.text, t.fmt)
    spans = spans_of(t.text)
    keep = [x for x in paras if any(a < x.end_cp and b > x.start_cp for a, b in spans)]
    return t.text, paras, keep, windows


def _queued_refs(sid: str) -> set:
    c = opsdb.connect()
    try:
        return {r[0] for r in c.execute("SELECT ref FROM queue WHERE kind='l2' AND state IN ('queued','taken') AND ref LIKE ?",
                                        (sid + "|%",))}
    finally:
        c.close()


def _check_declared(src: str, url: str, body: str, field_values: list):
    def spans_of(text):
        out, cur = [], 0
        for v in field_values:
            enc = json.dumps(v, ensure_ascii=False) if not src.startswith("src:awesome") else v
            i = text.index(enc, cur)
            out.append((i, i + len(enc)))
            cur = i + len(enc)
        return out
    text, paras, keep, windows = _expected(body, "text" if src.startswith("src:awesome") else "json", spans_of)
    sid = H.ingest_doc(url, body, source=src, domain=("G",))
    got = _queued_refs(sid)
    want = {windows.ref_of(sid, x.para_sha, x.start_cp) for x in keep}
    assert want and got == want                                     # 선언 구간과 겹치는 문단만 큐에 있다
    assert len(paras) > len(keep)                                   # 메타데이터 문단은 빠진다
    return sid, text, paras, keep


def test_declared_pypi_readme_reaches_l2_and_metadata_does_not(env):
    sid, text, paras, keep = _check_declared("src:pypi-meta", "https://pypi.org/pypi/samplepkg/json", _pypi_body(), [README])
    assert len(keep) >= 2
    dropped = [text[x.start_cp:x.end_cp] for x in paras if x not in keep]
    assert all("Samplepkg는" not in t and "저장소 문서가" not in t for t in dropped)
    assert any('"classifiers"' in t for t in dropped) and any('"releases"' in t for t in dropped)


def test_declared_hn_story_text_only(env):
    hits = [{"objectID": str(i), "title": f"Show HN: tool {i}", "url": f"https://example.test/{i}", "points": i, "num_comments": i,
             "author": f"u{i}", "created_at": "2026-11-01T00:00:00Z", "_tags": ["story", f"author_u{i}"],
             "story_text": ("I built a local MCP server that indexes my notes and answers questions in Claude Code. " * 3 if i % 3 == 0 else None)}
            for i in range(12)]
    body = json.dumps({"hits": hits, "nbHits": 12, "query": "mcp server"}, ensure_ascii=False)
    _check_declared("src:hn-algolia-g", "https://hn.algolia.com/api/v1/search?query=mcp%20server&tags=story", body,
                    [h["story_text"] for h in hits if h["story_text"]])


def test_declared_npm_packument_readme_only(env):
    rd = "# sample-cli\n\nsample-cli는 터미널에서 영상 메타데이터를 받아 JSON으로 저장하는 도구다. Node 20 이상이 필요하다고 README가 밝힌다.\n"
    body = json.dumps({"name": "sample-cli", "dist-tags": {"latest": "1.9.0"}, "license": "MIT", "readme": rd,
                       "versions": {f"1.{i}.0": {"name": "sample-cli", "version": f"1.{i}.0", "dist": {"shasum": f"{i:040d}"}} for i in range(10)},
                       "time": {f"1.{i}.0": f"2026-10-{i + 1:02d}T00:00:00Z" for i in range(10)}}, ensure_ascii=False)
    _check_declared("src:g4-npm-registry", "https://registry.npmjs.org/sample-cli", body, [rd])


def test_declared_csv_description_column_only(env):
    import csv as _csv
    import io
    rows = [["ID", "Display Name", "Category", "Description", "Link", "Active"]]
    rows += [[f"r{i}", f"Tool {i}", "Hooks", f"Tool {i}는 Claude Code 훅으로 세션 기록을 저장하고 요약한다고 저장소가 밝힌다.", f"https://example.test/{i}", "TRUE"]
             for i in range(6)]
    buf = io.StringIO()
    _csv.writer(buf, lineterminator="\n").writerows(rows)
    meta = io.StringIO()
    _csv.writer(meta, lineterminator="\n").writerows([[f"m{i}", f"Meta {i}", "Misc", "", f"https://example.test/m{i}", "FALSE"]
                                                      for i in range(5)])
    body = buf.getvalue() + "\n" + meta.getvalue()                   # 설명 칸이 빈 행 묶음: 메타데이터 문단
    _check_declared("src:awesome-claude-code", "https://raw.githubusercontent.com/x/awesome/main/t.csv", body,
                    [r[3] for r in rows[1:]])


def test_declared_spans_fail_open_when_display_does_not_match():
    from kb.parse.adapters._common import csv_prose, json_string_spans
    assert json_string_spans('{"a": "x"}', ["/a"]) == [(6, 9)]         # 원본 JSON 그대로인 표시 본문(raw_file@1 시절 npm)
    assert json_string_spans('{"a": "x", ', ["/a"]) is None             # JSON이 아니면 판정 불가
    assert json_string_spans('{"a": [{"b": "y"}, {"b": ""}, {"c": "z"}]}', ["/a/*/b"]) == [(13, 16)]
    assert json_string_spans('{\n  "a": "x"\n}\n', ["/a"]) == [(9, 12)]
    assert csv_prose("a,Description\n1,hello world\n", "text", {}) == []
    assert csv_prose("a,Description\n1,hello world\n", "text", {"prose": ["description"]}) == [(16, 27)]


def test_declared_policy_keeps_paragraph_hashes_and_done_keys(env, monkeypatch):
    """선언 구간은 저장하지 않는다: 문단 색인(paras_sha), para_sha, done 키, 원장이 정책과 무관하다."""
    from kb.extract import cache
    from kb.parse import display, paragraphs as pg
    sid = H.ingest_doc("https://pypi.org/pypi/samplepkg/json", _pypi_body(), source="src:pypi-meta", domain=("F",))
    led = ledger.open_ledger()
    try:
        tp = policy._ledger_text(led, sid)
    finally:
        led.close()
    t = display.json_display(_pypi_body().encode("utf-8"))
    assert tp["paras_sha"] == pg.store(pg.paragraphs(t.text, t.fmt))   # 파서가 만든 그대로의 색인
    cache.mark_done([pg.paragraphs(t.text, t.fmt)[0].para_sha], "w-test")   # done 키가 하나는 있어야 비교가 뜻이 있다
    done_before = _done_keys()
    n_ledger = ledger_n()
    real = policy.table
    for pol in ("all", "none", "declared", "prose"):
        monkeypatch.setattr(policy, "table", lambda srcs=None, pol=pol: {**real(), "src:pypi-meta": (pol, "S", "pypi_meta", {})})
        assert policy.sweep_if_changed()["swept"]
    assert _done_keys() == done_before and ledger_n() == n_ledger


def _done_keys():
    c = opsdb.connect()
    try:
        return sorted(r[0] for r in c.execute("SELECT k FROM tick_state WHERE k LIKE 'ex:done:%'"))
    finally:
        c.close()


# ---------------------------------------------------------------- 되돌리기(D1 검토 B1 재현: src:pypi-meta)

def test_revert_policy_restores_skipped_rows_and_reextract_revives_them(env, monkeypatch):
    """검토 재현(B1): 옛 동작으로 쌓인 pypi-meta 행을 sweep으로 skipped_policy로 만든 뒤 `l2: all`로 되돌린다.
    다음 tick의 sweep이 전부 queued로 되돌리고(멱등), `kb reextract`도 skipped 행을 0이 아니게 되살린다."""
    from kb.extract import runner, state
    from kb.ingest.process import Processor
    sid = H.ingest_doc("https://pypi.org/pypi/samplepkg/json", _pypi_body(), source="src:pypi-meta", domain=("F",), enqueue=False)
    real = policy.table
    use = {"pol": "all"}
    monkeypatch.setattr(policy, "table", lambda srcs=None: {**real(), "src:pypi-meta": (use["pol"], "S", "pypi_meta", {})})
    state.put(tick_stage.CURSOR, 0)
    tick_stage.enqueue_new()                                        # 옛 동작(all): 문단 전부가 큐에 있다
    total = H.queue_n()
    assert total > 0 and states() == {"queued": total}
    assert policy.sweep_if_changed()["swept"]
    use["pol"] = "none"                                             # D1 배포: sweep이 전부 skipped_policy
    out = policy.sweep_if_changed()
    assert out["skipped"] == total and states() == {"skipped_policy": total}
    use["pol"] = "all"                                              # 되돌리기: 다음 tick의 sweep
    res = tick_stage.run(None)
    assert res.ok and res.detail["policy_sweep"]["restored"] == total
    assert states() == {"queued": total}
    c = opsdb.connect()
    try:
        assert policy.sweep(c)["restored"] == 0                     # 멱등
    finally:
        c.close()
    # 같은 상황에서 sweep 없이 kb reextract만 돌려도 skipped 행이 살아난다(INSERT OR IGNORE 충돌 처리)
    use["pol"] = "none"
    assert policy.sweep_if_changed()["skipped"] == total
    use["pol"] = "all"
    proc = Processor({"item": "bundle", "contract": "kb-ingest/1", "batch_id": "t", "producer": "agent:t"}, fetch=False, write=True)
    try:
        assert runner.reextract_enqueue(proc, sid) == total
    finally:
        proc.gold.close()
    assert states() == {"queued": total}
    runner._finish_reextract()
    assert state.get(runner.REEXTRACT + sid) is not None            # 남은 문단이 있으니 재추출 표식을 지우지 않는다
    # declared로 좁히면 README 문단만 남고, 다시 all이면 전부 돌아온다
    use["pol"] = "declared"
    out = policy.sweep_if_changed()
    keep = total - out["skipped"]
    assert 0 < keep < total and states() == {"queued": keep, "skipped_policy": total - keep}
    use["pol"] = "all"
    assert policy.sweep_if_changed()["restored"] == total - keep and states() == {"queued": total}


def test_revert_requeues_snapshots_held_at_enqueue(env, monkeypatch):
    """none·declared일 때 적재된 스냅샷은 행 없이 보류 표식만 남는다. 정책이 넓어지면 sweep이 그 스냅샷을 다시 적재한다."""
    real = policy.table
    use = {"pol": "none"}
    monkeypatch.setattr(policy, "table", lambda srcs=None: {**real(), "src:pypi-meta": (use["pol"], "S", "pypi_meta", {})})
    old = H.ingest_doc("https://pypi.org/pypi/samplepkg/json", _pypi_body(), source="src:pypi-meta", domain=("F",),
                       fetched_at=1_792_000_000_000)
    sid = H.ingest_doc("https://pypi.org/pypi/samplepkg/json", _pypi_body().replace("2.0.0", "2.0.1"), source="src:pypi-meta",
                       domain=("F",))
    assert H.queue_n() == 0
    assert policy.sweep_if_changed()["held_queued"] == 0            # none: 그대로
    held = [k for k in _keys(policy.HELD)]
    assert len(held) == 1                                           # URL마다 최신 스냅샷 하나
    use["pol"] = "declared"
    out = policy.sweep_if_changed()
    n_decl = out["held_queued"]
    assert n_decl > 0 and _queued_refs(sid) and not _queued_refs(old)
    use["pol"] = "all"
    out = policy.sweep_if_changed()
    assert out["held_queued"] > 0 and len(_queued_refs(sid)) == n_decl + out["held_queued"]
    assert _keys(policy.HELD) == []                                 # all이면 걸러 낸 문단이 없으니 표식을 지운다
    c = opsdb.connect()
    try:
        again = policy.sweep(c)
    finally:
        c.close()
    assert again["held_queued"] == 0 and again["restored"] == 0 and again["skipped"] == 0


def _keys(prefix):
    c = opsdb.connect()
    try:
        return [r[0] for r in c.execute("SELECT k FROM tick_state WHERE substr(k, 1, ?)=?", (len(prefix), prefix))]
    finally:
        c.close()


def test_declared_undecided_holds_instead_of_flooding(env, monkeypatch):
    """선언 구간을 계산하지 못하면(판정 불가) 하나도 넣지 않고 보류 표식을 남긴다. 고친 뒤 all로 넓히면 돌아온다."""
    import dataclasses
    from kb.parse import adapters
    a = adapters.ADAPTERS["pypi_meta"]
    monkeypatch.setitem(adapters.ADAPTERS, "pypi_meta", dataclasses.replace(a, prose=lambda text, fmt, cfg: None))
    sid = H.ingest_doc("https://pypi.org/pypi/samplepkg/json", _pypi_body(), source="src:pypi-meta", domain=("F",))
    assert H.queue_n() == 0 and len(_keys(policy.HELD)) == 1
    from kb.extract import state
    state.put(tick_stage.CURSOR, 0)
    assert tick_stage.enqueue_new()["policy_undecided"] == 1
    real = policy.table
    monkeypatch.setattr(policy, "table", lambda srcs=None: {**real(), "src:pypi-meta": ("all", "S", "pypi_meta", {})})
    assert policy.sweep_if_changed()["held_queued"] > 0 and _queued_refs(sid)


def test_csv_cells_accepts_crlf():
    from kb.parse.adapters._common import csv_cells
    for t in ('a,Description\r\nx,"hello world foo"\r\n', 'a,Description\r\nx,hello\r\n', 'a,b\r\nx,\r\ny,z'):
        rows = csv_cells(t)
        assert rows is not None
    assert [c[2] for c in csv_cells('a,Description\r\nx,"hello world foo"\r\n')[1]] == ["x", "hello world foo"]
    assert [c[2] for c in csv_cells('a,b\r\nx,\r\n')[1]] == ["x", ""]
