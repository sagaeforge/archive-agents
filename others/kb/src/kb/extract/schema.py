"""창마다 만드는 출력 스키마(ADR 10.5). full이 검증 정본이고 전송용은 어댑터별 변환이다. 잘림은 실패다."""
from __future__ import annotations

import copy
import json

from kb.core import paths

WORLD_TYPES = ["Platform", "Product", "Feature", "Tool", "Repo", "Package", "Model", "Org", "Person", "Channel", "Video",
               "Keyword", "Metric", "Concept", "Technique", "Policy"]
NULLSTR = {"type": ["string", "null"]}
FIELDS = ["subject", "subject_new", "predicate", "statement", "quote", "kind", "stance", "speaker", "value", "unit",
          "valid_from", "qualifier", "prior_value", "changed_on", "depends_on"]
SUPPORT_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["supported"],
                  "properties": {"supported": {"type": "boolean"}}}


def predicate_ids() -> list:
    from kb.collect import registry
    doc = registry.read_yaml(paths.share_dir() / "schemas" / "predicates.yaml") or {}
    return [p["id"] for p in doc.get("predicates", [])]


def extract_schema(candidate_ids: list, predicates: list | None = None, profile: str = "full") -> dict:
    preds = predicates if predicates is not None else predicate_ids()
    subj = list(dict.fromkeys(list(candidate_ids) + ["__new__"]))
    item = {"type": "object", "additionalProperties": False, "required": list(FIELDS),
            "properties": {
                "subject": {"type": "string", "enum": subj},
                "subject_new": {"anyOf": [{"type": "null"},
                                          {"type": "object", "additionalProperties": False,
                                           "required": ["label", "type", "aliases"],
                                           "properties": {"label": {"type": "string"},
                                                          "type": {"type": "string", "enum": WORLD_TYPES},
                                                          "aliases": {"type": "array", "items": {"type": "string"}}}}]},
                "predicate": {"type": ["string", "null"], "enum": list(preds) + [None]},
                "statement": {"type": "string"}, "quote": {"type": "string"},
                "kind": {"type": "string", "enum": ["event", "state", "howto"]},
                "stance": {"type": "string", "enum": ["stated", "attributed"]},
                **{k: dict(NULLSTR) for k in ("speaker", "value", "unit", "valid_from", "qualifier", "prior_value",
                                              "changed_on", "depends_on")}}}
    claims = {"type": "array", "items": item}
    if profile == "full":
        item["properties"]["statement"]["maxLength"] = 200
        item["properties"]["quote"]["maxLength"] = 260
        claims["maxItems"] = 12
    return {"type": "object", "additionalProperties": False, "required": ["claims"], "properties": {"claims": claims}}


def to_anyof(node):
    """type 배열 + enum 조합을 거부하는 공급자용 전송 변환. 의미는 같고 검증은 full 정본으로 한다."""
    if isinstance(node, list):
        return [to_anyof(x) for x in node]
    if not isinstance(node, dict):
        return node
    out = {k: to_anyof(v) for k, v in node.items()}
    t = out.get("type")
    if isinstance(t, list) and "null" in t:
        rest = [x for x in t if x != "null"]
        base = {k: v for k, v in out.items() if k not in ("type", "enum")}
        one = {"type": rest[0]}
        if "enum" in out:
            one["enum"] = [x for x in out["enum"] if x is not None]
        return {**base, "anyOf": [one, {"type": "null"}]}
    return out


def send_schema(candidate_ids: list, profile: str, predicates: list | None = None) -> dict:
    if profile == "strict-min+anyof":
        return to_anyof(extract_schema(candidate_ids, predicates, "strict-min"))
    return extract_schema(candidate_ids, predicates, profile)


def validate(schema: dict, value) -> list:
    import jsonschema
    cls = jsonschema.validators.validator_for(schema)
    return [f"{'/'.join(str(x) for x in e.path) or '.'}: {e.message[:100]}"
            for e in sorted(cls(schema).iter_errors(value), key=lambda e: [str(x) for x in e.path])][:5]


def parse_raw(raw: str | None):
    """원응답 문자열 -> 객체. 코드 펜스 제거 같은 후처리를 하지 않는다."""
    if raw is None:
        raise ValueError("빈 응답")
    return json.loads(raw)


def copy_schema(s: dict) -> dict:
    return copy.deepcopy(s)
