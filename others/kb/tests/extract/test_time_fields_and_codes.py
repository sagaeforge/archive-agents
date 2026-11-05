"""L2 항목 변환은 읽을 수 없는 선택 시각 필드만 빼고 주장을 남긴다(에이전트 묶음은 E_SCHEMA 그대로).
kb agent run --json은 사유별 건수(codes)와 정규화한 필드 수(normalized_fields)를 보인다."""
import json

import jsonschema

from kb import ingest
from kb.cli import main
from kb.extract import items as itm, runner, settings
from kb.extract.types import Window

from . import helpers as H

SCHEMA = json.load(open(H.REPO / "schemas" / "cli" / "agent-run.schema.json"))
BADTIME = "25년"


def _win():
    return Window("w", "n-x", "t", [], [], "", "", "", "")


QUOTE = "샘플도구 이용률 : 79.2%(24년) → 81.8%(25년)"
DOC25 = f"# 안내\n\n{QUOTE} 이다.\n"


def _claim(quote=QUOTE, **kw):
    return H.claim_obj("e:tool:sample", quote, "25년 샘플도구 이용률은 81.8%다.", **kw)


def _items(valid_from=None, quote=QUOTE, year_max=2026, changed_on=None):
    n = {}
    its = itm.to_items(_win(), [_claim(quote, valid_from=valid_from, changed_on=changed_on)], "x", None, year_max=year_max, normalized=n)
    return its[0], n


def test_allowlist_normalises_paren_year_and_nyeondo():
    it, n = _items("25년")
    assert it["valid"] == {"from": "2025"} and n == {"valid_from": 1}
    it, n = _items(changed_on="25년도", quote="샘플도구 25년도 보유율은 81.8%다.")
    assert it["changed_on"] == "2025" and n == {"changed_on": 1}
    it, n = _items("25년도", quote="샘플도구 이용률 : 81.8%(25년)")                    # 값 '25년도'도 (25년) 토큰과 맞는다
    assert it["valid"] == {"from": "2025"}


def test_everything_else_is_untouched_so_ingest_gives_e_schema():
    cases = [("25년", "경력 25년의 베테랑이 81.8%를 답했다"), ("25년", "약 25년 된 회사의 이용률 81.8%"), ("25년", "창립 25년 기념 81.8%"),
             ("25년", "25년 뒤 81.8%로 오른다"), ("10년", "지난 10년 동안 81.8%"), ("25년", "81.8%(25년간)"), ("25년", "81.8% 25년 전 조사"),
             ("25년", "81.8%(125년 기준)"), ("25년", "근속 기간(25년)이 81.8%"), ("10년", "국고채(10년) 금리 81.8%"),
             ("20년", "만기(20년) 81.8%"), ("25년", "81.8%(24년)"),                      # 인용구에 토큰 없음
             ("30년", "81.8%(30년)"), ("30년", "30년도 81.8%"),                          # 스냅샷 연도(2026)보다 뒤
             ("2025년", "81.8%(2025년)"), ("25년", "81.8% (25년"), ("25년", "81.8%25년")]
    for v, q in cases:
        it, n = _items(v, q)
        assert it["valid"] == {"from": v} and n == {}, (v, q)                      # 값 그대로
    it, n = _items("25년", year_max=None)
    assert it["valid"] == {"from": "25년"} and n == {}


def test_parseable_time_fields_are_kept():
    it, n = _items("2026-10-01", changed_on="2026-10-02")
    assert it["valid"] == {"from": "2026-10-01"} and it["changed_on"] == "2026-10-02" and n == {}


def test_agent_bundle_with_bad_time_is_still_e_schema(ent):
    sid = H.ingest_doc()
    it = {"item": "claim", "ref": "c0", "subject": ent, "statement": "샘플도구는 하루 최대 500건의 요청을 지원한다.", "kind": "state",
          "stance": "stated", "method": "llm", "evidence": {"snapshot": sid, "quote": H.GOOD["quote"]}, "valid": {"from": BADTIME}}
    rep = ingest.validate(({"item": "bundle", "contract": "kb-ingest/1", "batch_id": "a", "producer": "agent:t"}, [(2, it)]), fetch=False)
    assert rep.lines[0]["result"] == "rejected" and rep.lines[0]["code"] == "E_SCHEMA"


def _run_with(monkeypatch, capsys, valid_from, quote=QUOTE, doc=DOC25):
    H.ingest_doc(text=doc)
    f = H.Fake("anthropic_api", True, lambda job: {"claims": [_claim(quote, valid_from=valid_from, value="81.8", unit="%")]})
    monkeypatch.setattr(runner, "default_backends", lambda: {"anthropic_api": f})
    with settings.override(**{"openrouter.enabled": False}):
        rc = main(["agent", "run", "--max-windows", "1", "--json"])
    return rc, json.loads(capsys.readouterr().out.strip().splitlines()[-1])


def test_run_allowlisted_year_gives_quote_found_with_time(ent, capsys, monkeypatch):
    rc, out = _run_with(monkeypatch, capsys, "25년")
    assert rc == 0 and out["claims"] == 1 and out["normalized_fields"] == {"valid_from": 1} and out["codes"] == {}
    jsonschema.validate(out, SCHEMA)
    (row,) = H.claims()
    assert row[2] == "quote_found"
    con = H.gold()
    try:
        assert con.execute("SELECT valid_from FROM node WHERE id=?", (row[0],)).fetchone()[0] is not None
    finally:
        con.close()


def test_run_mis_dating_inputs_stay_e_schema_and_nothing_is_stored(ent, capsys, monkeypatch):
    q = "샘플도구 이용률 : 경력 25년의 베테랑 81.8%"
    rc, out = _run_with(monkeypatch, capsys, "25년", quote=q, doc=f"# 안내\n\n{q} 이다.\n")
    assert rc == 0 and out["claims"] == 0 and out["rejected"] == 1 and out["codes"] == {"E_SCHEMA": 1} and out["normalized_fields"] == {}
    assert H.claims() == []


def test_run_json_counts_reject_and_review_codes(ent, capsys, monkeypatch):
    H.ingest_doc()
    bad = H.claim_obj(ent, H.GOOD["quote"], H.GOOD["statement"].replace("500건", "900건"), predicate="quota", value="900", unit="건")
    f = H.Fake("anthropic_api", True, lambda job: {"claims": [bad]})
    monkeypatch.setattr(runner, "default_backends", lambda: {"anthropic_api": f})
    with settings.override(**{"openrouter.enabled": False}):
        main(["agent", "run", "--max-windows", "1", "--json"])
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["codes"] == {"R_VALUE_MISMATCH": 1} and out["needs_review"] == 1 and out["rejected"] == 0
    jsonschema.validate(out, SCHEMA)
