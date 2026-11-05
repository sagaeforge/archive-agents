"""FW2 순수 타입 계약. 저장·HTTP·외부 서비스 없이 ADR-0005를 검증한다."""
import copy
import hashlib
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from kb.write import types, validate
from kb.write.errors import WriteRejected

REPO = Path(__file__).resolve().parents[2]
RID = "f-aaaaaaaaaaaaaaaaaaaaaaaaaa"
TARGET = "c-8k2p4q7m1xab"
VALID = {
    "Page": {"tags": ["문서"], "order": "01", "icon": "📄", "title_locked": True},
    "Note": {"tags": ["메모"], "pinned": False, "title_locked": True},
    "TopicSpec": {"aliases": ["주제"], "domain": ["A", "G"], "exclude": ["제외"]},
    "Review": {"target": TARGET, "decision": "accept", "topic": "e:topic:sample"},
}


@pytest.fixture(autouse=True)
def isolated_schema_source(monkeypatch):
    monkeypatch.delenv("KB_LIVE", raising=False)
    monkeypatch.setenv("KB_SHARE", str(REPO))
    monkeypatch.setattr(types, "_CACHE", {"at": 0.0, "dir": None, "val": {}})


def schema(name):
    registered = types.load_type_files()
    assert (name, "node") in registered, f"missing defined node type: {name}"
    return registered[name, "node"]


def check(name, props):
    validate.validate_props(schema(name), props, name)


def reject(name, props):
    with pytest.raises(WriteRejected) as exc:
        check(name, props)
    assert exc.value.code == "schema_invalid"


def normalize(rec, *, existing_props=None):
    # FW2 owns this pure helper; FW3 must wire it into record.py separately.
    fn = getattr(types, "normalize_first_party", None)
    assert callable(fn), "FW2 must provide types.normalize_first_party(rec, rid, *, existing_props=None)"
    return fn(rec, RID, existing_props=existing_props)


@pytest.mark.parametrize("name", VALID)
def test_defined_types(name):
    s = schema(name)
    Draft202012Validator.check_schema(s)
    assert s["x-kb-kind"] == "node"
    assert s["x-kb-group"] == "user"
    assert types.in_overview(s, None) is (name in {"Page", "Note"})
    check(name, VALID[name])


@pytest.mark.parametrize("name", ["Page", "Note"])
def test_user_keys(name):
    props = dict(VALID[name], custom={"상태": ["초안", 1, True, None]})
    before = copy.deepcopy(props)
    check(name, props)
    assert props == before


@pytest.mark.parametrize("name", ["TopicSpec", "Review"])
def test_unknown_keys(name):
    reject(name, dict(VALID[name], unknown="사용자 입력"))


@pytest.mark.parametrize("name,field", [("Page", "title_locked"), ("Note", "pinned"),
                                     ("Note", "title_locked"), ("TopicSpec", "export_llm"),
                                     ("TopicSpec", "export_query")])
@pytest.mark.parametrize("value", [0, 1, "true", None, [], {}])
def test_booleans(name, field, value):
    reject(name, dict(VALID[name], **{field: value}))


@pytest.mark.parametrize("name,field", [("Page", "title_locked"), ("Note", "pinned"),
                                     ("Note", "title_locked"), ("TopicSpec", "export_llm"),
                                     ("TopicSpec", "export_query")])
@pytest.mark.parametrize("value", [True, False])
def test_boolean_values(name, field, value):
    check(name, dict(VALID[name], **{field: value}))


@pytest.mark.parametrize("props", [
    {"target": TARGET, "decision": "accept"},
    {"target": TARGET, "decision": "reject"},
    {"target": TARGET, "verdict": "reject", "note": "근거와 다릅니다"},
    {"target": TARGET, "decision": "reject", "verdict": "reject", "note": "근거와 다릅니다"},
    {"target": TARGET, "verdict": "reject", "note": "재확인", "source_url": "https://example.org/source"},
    {"target": TARGET, "verdict": "reject", "note": "재확인", "source_url": "http://example.org/source"},
])
def test_review_accepts(props):
    check("Review", props)


@pytest.mark.parametrize("props", [
    {"decision": "accept"}, {"target": TARGET},
    {"target": TARGET, "decision": "maybe"},
    {"target": TARGET, "verdict": "accept"},
    {"target": TARGET, "decision": "accept", "verdict": "reject", "note": "不一致"},
    {"target": TARGET, "verdict": "reject"},
    {"target": TARGET, "verdict": "reject", "note": ""},
    {"target": TARGET, "verdict": "reject", "note": " "},
    {"target": TARGET, "verdict": "reject", "note": "이" * 501},
    {"target": TARGET, "decision": "reject", "source_url": "https://example.org/source"},
])
def test_review_rejects(props):
    reject("Review", props)


@pytest.mark.parametrize("url", ["/relative", "ftp://example.org/source", "https://", "not a URL",
                                 "http://localhost/source", "http://127.0.0.1/source",
                                 "https://user:password@example.org/source"])
def test_review_urls(url):
    reject("Review", {"target": TARGET, "verdict": "reject", "note": "再確認", "source_url": url})


@pytest.mark.parametrize("name", ["TopicSpec", "Review"])
@pytest.mark.parametrize("key", ["source_path", "path", "file", "filename", "custom_path",
                                 "quarantine", "quarantine_from", "quarantine_rules", "quarantine_custom"])
def test_reserved_keys(name, key):
    reject(name, dict(VALID[name], **{key: "untrusted"}))


@pytest.mark.parametrize("name", ["Note", "Page"])
@pytest.mark.parametrize("key", ["source_path", "path", "file", "filename", "custom_path",
                                 "quarantine", "quarantine_from", "quarantine_rules", "quarantine_custom"])
def test_note_page_internal_keys_allowed(name, key):
    # 공유 스키마는 내부 파이프라인 키를 허용한다. HTTP 거절은 FW3 소유다.
    check(name, dict(VALID[name], **{key: "untrusted"}))


@pytest.mark.parametrize("name,extra", [
    ("Page", {"tags": ["x"] * 51}), ("Note", {"tags": ["x"] * 51}),
    ("Page", {"tags": [1]}), ("Note", {"tags": "tag"}),
    ("Page", {"order": 1.5}), ("Page", {"icon": "x" * 9}),
    ("TopicSpec", {"aliases": ["a"] * 21}), ("TopicSpec", {"aliases": ["a" * 101]}),
    ("TopicSpec", {"domain": ["H"]}), ("TopicSpec", {"exclude": ["x"] * 21}),
    ("TopicSpec", {"parent": "f-not-a-topic"}), ("TopicSpec", {"slug": "한글 제목"}),
])
def test_field_limits(name, extra):
    reject(name, dict(VALID[name], **extra))


@pytest.mark.parametrize("name,field,value", [
    ("TopicSpec", "slug", "abc\n"),
    ("TopicSpec", "parent", "e:topic:abc\n"),
    ("Review", "target", TARGET + "\n"),
])
def test_identifier_trailing_newline_rejected(name, field, value):
    reject(name, dict(VALID[name], **{field: value}))


@pytest.mark.parametrize("name", VALID)
def test_props_limits(name):
    reject(name, dict(VALID[name], **{"tags" if name in {"Note", "Page"} else "note" if name == "Review" else "exclude":
                                    ["가" * 6000] if name != "Review" else "가" * 6000}))


@pytest.mark.parametrize("name", ["Note", "Page"])
@pytest.mark.parametrize("value", [1.5, float("nan"), float("inf"), {1, 2}, b"bytes"])
def test_props_json(name, value):
    reject(name, dict(VALID[name], custom=value))


@pytest.mark.parametrize("name", ["PROMOTED_FROM", "DEFINES", "REVIEWS"])
def test_edges(name):
    registered = types.load_type_files()
    assert (name, "edge") in registered
    s = registered[name, "edge"]
    Draft202012Validator.check_schema(s)
    assert s["title"] == name and s["x-kb-kind"] == "edge"
    validate.validate_props(s, {}, name)


def test_cancelled():
    payload = {"id": "t-synthetic", "status": "cancelled", "note": "사용자 중지"}
    s = json.loads((REPO / "schemas/events/ticket.close.schema.json").read_text())
    Draft202012Validator(s).validate(payload)
    validate.validate_event({"kind": "ticket.close", "actor": "system:test", "origin": "system",
                             "idem_key": "fw2:cancelled", "subject": payload["id"], "payload": payload})


@pytest.mark.parametrize("name", VALID)
def test_private_default(name):
    rec = {"type": name, "title": "새 기록", "body": "", "props": copy.deepcopy(VALID[name])}
    before = copy.deepcopy(rec)
    result = normalize(rec)
    assert result["sensitivity"] == "private"
    assert rec == before


@pytest.mark.parametrize("sensitivity,query", [("private", False), ("internal", True), ("public", True)])
def test_export_defaults(sensitivity, query):
    result = normalize({"type": "TopicSpec", "title": "한글 주제", "body": "",
                        "sensitivity": sensitivity, "props": {}})
    assert result["props"]["export_llm"] is False
    assert result["props"]["export_query"] is query


@pytest.mark.parametrize("field", ["export_llm", "export_query"])
def test_private_export_rejected(field):
    with pytest.raises(WriteRejected) as exc:
        normalize({"type": "TopicSpec", "title": "비공개 주제", "body": "",
                   "sensitivity": "private", "props": {field: True}})
    assert exc.value.code == "schema_invalid"


def test_korean_slug():
    # 고정 ID가 기준이다. 제목 변경과 재시도는 slug를 바꾸지 않는다.
    expected = "t-" + hashlib.sha256(("kb-topic-slug-v1\0" + RID).encode("utf-8")).hexdigest()[:16]
    for title in ("한국어 연구 주제", "바뀐 한국어 제목", "English title", "한국어 연구 주제"):
        result = normalize({"type": "TopicSpec", "title": title, "body": "", "props": {}})
        assert result["title"] == title
        assert result["props"]["slug"] == expected
        assert result["props"]["slug"].isascii()


def test_slug_preserved():
    rec = {"type": "TopicSpec", "title": "제목 수정", "body": "", "props": {}}
    assert normalize(rec, existing_props={"slug": "kept-slug"})["props"]["slug"] == "kept-slug"
    rec["props"]["slug"] = "explicit-slug"
    assert normalize(rec, existing_props={"slug": "kept-slug"})["props"]["slug"] == "explicit-slug"
