"""질의 계획: 별칭 확장, 토큰 AND 후 OR, 규모 게이트, 하이브리드 저하, CLI."""
import json
import subprocess
import sys

import jsonschema
import pytest

from kb.read import aliases
from kb.read import search as S
from kb.read.search import build_plan
from kb.read.snippet import make_snippet

from .shelp import entity, ids, record, snap


def test_alias_groups_and_prefix():
    segs = aliases.expand(["숏츠"])
    assert set(segs[0].alts) == {"쇼츠", "shorts"}
    # 접두 일치: 나머지를 붙인다
    assert aliases.expand(["8천시간"])[0].alts == ["8000시간"]
    # 여러 단어 형식, 띄어쓰기 무시
    assert "claude code" in aliases.expand(["클로드", "코드"])[0].alts
    assert "claude code" in aliases.expand(["클로드코드"])[0].alts
    # 라틴 단어의 중간에서 끊지 않는다
    assert aliases.expand(["shortsfoo"])[0].alts == []


def test_plan_expression_is_quoted_and_grouped():
    p = build_plan("숏츠 수익")
    assert p.and_expr() == '(("숏츠") OR ("쇼츠") OR ("shorts")) AND "수익"'
    assert build_plan("2.1.314").and_expr() == '"2_1_314" AND "2" AND "1" AND "314"'
    with pytest.raises(Exception) as e:
        build_plan("  ... ")
    assert getattr(e.value, "status", None) == 400


def test_custom_alias_file_via_share_dir(kb_home, monkeypatch):
    share = kb_home / "share"
    (share / "schemas" / "aliases").mkdir(parents=True)
    (share / "schemas" / "aliases" / "x.toml").write_text('[[group]]\nforms = ["오지알", "ogr"]\n', encoding="utf-8")
    monkeypatch.setenv("KB_SHARE", str(share))
    assert aliases.expand(["오지알"])[0].alts == ["ogr"]
    (share / "schemas" / "aliases" / "bad.toml").write_text("= not toml", encoding="utf-8")
    assert aliases.expand(["오지알"])[0].alts == ["ogr"]   # 깨진 파일은 건너뛴다


def test_alias_finds_variants_in_data(w):
    w.add(record("f-1", "쇼츠 알고리즘", body=""), record("f-2", "YouTube Shorts 수익", body=""), record("f-3", "롱폼 영상", body=""))
    got = ids(S.search("숏츠", w.ctx(), kinds="record"))
    assert set(got[:2]) == {"f-1", "f-2"}


def test_entity_alias_table_expands(w):
    w.add(entity("e:tool:claude-code", "Claude Code", aliases=["클코"]))
    w.add(record("f-1", "Claude Code 훅 설정", body=""), record("f-2", "다른 도구 메모", body=""))
    assert ids(S.search("클코", w.ctx(), kinds="record"))[0] == "f-1"


def test_or_follows_and_when_few(w):
    w.add(record("f-a", "알파 베타 감마", body=""), record("f-b", "알파 델타", body=""), record("f-c", "엡실론", body=""))
    got = ids(S.search("알파 베타", w.ctx(), kinds="record"))
    assert got[0] == "f-a" and "f-b" in got and "f-c" not in got   # AND 한 건 뒤에 OR 이음


def test_hybrid_without_rank_module_degrades(w):
    w.add(record("f-1", "알파", body=""))
    r = S.search("알파", w.ctx(), mode="hybrid", kinds="record")
    assert "lexical_only" in r["degraded"] and ids(r) == ["f-1"]
    assert "lexical_only" not in S.search("알파", w.ctx(), kinds="record")["degraded"]


def test_hybrid_uses_rank_client_order(w, monkeypatch):
    import types
    w.add(record("f-1", "알파 하나", body=""), record("f-2", "알파 둘", body=""))
    mod = types.ModuleType("kb.rank.client")
    mod.search = lambda q, ctx, *, kinds, limit: ["f-2", "f-1"]
    pkg = types.ModuleType("kb.rank")
    pkg.client = mod
    monkeypatch.setitem(sys.modules, "kb.rank", pkg)
    monkeypatch.setitem(sys.modules, "kb.rank.client", mod)
    r = S.search("알파", w.ctx(), mode="hybrid", kinds="record")
    assert ids(r) == ["f-2", "f-1"] and "lexical_only" not in r["degraded"]


def test_rare_only_gate(w, monkeypatch):
    w.add([record(f"f-{i}", f"흔한말 문서 {i}", body="") for i in range(30)] + [record("f-rare", "특이어 흔한말", body="")])
    from kb.core import config
    monkeypatch.setitem(config.DEFAULTS["lexical"], "rare_only", True)
    calls = []
    orig = S._rare_tokens
    monkeypatch.setattr(S, "_rare_tokens", lambda con, toks: calls.append(toks) or orig(con, toks))
    r = S.search("특이어 흔한말 없는말", w.ctx(), kinds="record")
    assert calls and ids(r)[0] == "f-rare"      # 희귀 토큰 OR로도 맨 앞
    with w.rd() as (con, _):                     # 읽기 전용 연결의 fts_vocab 문서 빈도 순
        assert S._rare_tokens(con, ["흔한", "특이", "없는"]) == ["특이", "흔한"]
    off = len(calls)
    monkeypatch.setitem(config.DEFAULTS["lexical"], "rare_only", False)
    S.search("특이어 흔한말 없는말", w.ctx(), kinds="record")
    assert len(calls) == off


def test_snippet_offsets_and_ellipsis():
    text = "앞부분 " * 30 + "8,000시간 기준" + " 뒷부분" * 30
    s = make_snippet(text, ["8000시간"], ["8000", "시간"])
    assert s["snippet"].startswith("…") and s["snippet"].endswith("…")
    h = s["highlights"][0]
    assert s["snippet"][h["start"]:h["end"]] == "8,000시간"
    short = make_snippet("Hello C++ world", ["c++"], ["cplusplus"])
    assert short["snippet"][short["highlights"][0]["start"]:short["highlights"][0]["end"]] == "C++"


def test_cli_json_matches_schema(w, repo, monkeypatch):
    w.add(record("f-1", "쇼츠 후킹 메모", body="본문"))
    schema = json.loads((repo / "schemas" / "cli" / "search.schema.json").read_text(encoding="utf-8"))
    out = subprocess.run([sys.executable, "-m", "kb", "search", "후킹", "--json", "--db", str(w.path)],
                         capture_output=True, text=True, cwd=repo)
    assert out.returncode == 0, out.stderr
    env = json.loads(out.stdout)
    jsonschema.Draft202012Validator(schema).validate(env)
    assert [i["id"] for i in env["data"]["items"]] == ["f-1"]
    bad = subprocess.run([sys.executable, "-m", "kb", "search", "...", "--json", "--db", str(w.path)], capture_output=True, text=True, cwd=repo)
    assert bad.returncode == 2 and json.loads(bad.stderr)["code"] == "bad_param"
    fac = subprocess.run([sys.executable, "-m", "kb", "search", "후킹", "--facets", "--db", str(w.path)], capture_output=True, text=True, cwd=repo)
    jsonschema.Draft202012Validator(schema).validate(json.loads(fac.stdout))


def test_rare_tokens_prefer_low_document_frequency(w):
    w.add([record(f"f-{i}", f"흔한말 문서 {i}", body="") for i in range(30)] + [record("f-rare", "특이어 흔한말", body="")])
    with w.rd() as (con, ctx):
        got = S._rare_tokens(con, ["특이", "이어", "흔한", "한말", "없는"])
    assert got[:2] == ["이어", "특이"] and "없는" not in got
    assert got.index("흔한") > got.index("특이")
