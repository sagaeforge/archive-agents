"""검색 항목 네 종류(claim, record, entity, passage)가 계약 스키마를 통과한다."""
import jsonschema
import pytest
import yaml

from kb.read import search as S

from .shelp import ids, claim, entity, record, snap

OPENAPI = None


def _validator(name):
    global OPENAPI
    if OPENAPI is None:
        from pathlib import Path
        OPENAPI = yaml.safe_load((Path(__file__).resolve().parents[2] / "docs/contracts/openapi.yaml").read_text(encoding="utf-8"))
    schema = {"$ref": f"#/components/schemas/{name}", "components": OPENAPI["components"]}
    return jsonschema.Draft202012Validator(schema)


@pytest.fixture
def world(w):
    w.add(entity("e:platform:youtube", "YouTube Shorts"))
    w.add(snap("n-1", paras=("YPP 신규 진입 기준은 8,000시간으로 올라간다.", "쇼츠 수익 배분은 45%다.")))
    w.add(claim("c-8k2p4q7m1xab", "e:platform:youtube", "YPP 신규 진입 기준은 8,000시간으로 올라간다.", snap_id="n-1"))
    w.add(record("f-01JC8ZQ3T9XYZ", "쇼츠 후킹 메모", body="첫 3초의 후킹이 중요하다"))
    return w


def test_all_four_kinds_pass_contract(world):
    from kb.read.search import search
    seen = {}
    for q in ["8000시간", "후킹", "youtube shorts", "쇼츠 수익"]:
        res = search(q, world.ctx())
        _validator("SearchResultEnvelope").validate(res)
        for it in res["data"]["items"]:
            _validator("SearchHit").validate(it)
            seen[it["kind"]] = it
    assert set(seen) == {"claim", "record", "entity", "passage"}


def test_claim_has_subject_and_source(world):
    res = S.search("8000시간", world.ctx(), kinds="claim")
    (it,) = res["data"]["items"]
    assert it["subject"] == "e:platform:youtube"
    assert it["id"] == "c-8k2p4q7m1xab" and it["verification"] == "quote_found"
    assert it["source"]["id"] == "src:a"


def test_passage_id_start_end(world):
    res = S.search("8000시간", world.ctx(), kinds="passage")
    (it,) = res["data"]["items"]
    assert it["id"] == f"{it['snapshot_id']}:{it['start']}"
    assert (it["snapshot_id"], it["start"], it["end"]) == ("n-1", 0, len("YPP 신규 진입 기준은 8,000시간으로 올라간다."))
    assert it["highlight_unit"] == "codepoint"


def test_highlight_offsets_point_into_snippet(world):
    res = S.search("8000시간", world.ctx())
    for it in res["data"]["items"]:
        for h in it["highlights"]:
            assert it["snippet"][h["start"]:h["end"]].replace(",", "") == "8000시간"


def test_no_score_in_response(world):
    res = S.search("쇼츠", world.ctx())
    for it in res["data"]["items"]:
        assert not {"score", "rank", "bm25"} & set(it)
    assert "bm25" not in str(res["page"])
