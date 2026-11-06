"""공개 규칙과 서버 정의의 대응. 합성 입력만 사용하며 저장 동작은 시험하지 않는다."""
import hashlib
import json
from pathlib import Path

import pytest

from kb.write import secrets_scan as scan

REPO = Path(__file__).resolve().parents[2]
ARTIFACT = REPO / "docs/contracts/first-party-secret-rules-v1.json"
HEADER = "-----BEGIN PRIVATE KEY-----"
HEX = "0123456789abcdef" * 2
# 필드 이름 대신 순번을 사용한다. 비밀값 자체는 응답에 내지 않는다.
VECTORS = [
    {"id": "identifier", "field": "idempotency_key", "text": HEADER,
     "on_secret": "quarantine", "action": "reject"},
    {"id": "content-reject", "field": "record.body", "text": HEADER,
     "on_secret": "reject", "action": "reject"},
    {"id": "content-quarantine", "field": "record.body", "text": HEADER,
     "on_secret": "quarantine", "action": "quarantine"},
    {"id": "attribute-name", "field": "record.props[0].name", "text": HEADER,
     "on_secret": "quarantine", "action": "reject"},
    {"id": "digest", "field": "idempotency_key", "text": "save:" + HEX,
     "on_secret": "reject", "action": "allow"},
    {"id": "credential-digest", "field": "idempotency_key", "text": "api_key:" + HEX,
     "on_secret": "reject", "action": "reject"},
    {"id": "writer-digest-tail", "field": "idempotency_key", "text": "api_key:" + HEX,
     "digest_tail": True, "on_secret": "reject", "action": "allow"},
    {"id": "hangul-astral", "field": "record.body", "text": "한글😀" + HEADER,
     "on_secret": "reject", "action": "reject",
     "hit": {"rule": "kb-private-key-header", "start": 3, "end": 30,
             "start_u16": 4, "end_u16": 31}},
]


def artifact():
    return json.loads(ARTIFACT.read_text(encoding="utf-8"))


def test_public_rule_definition_matches_server():
    public = artifact()
    assert public["version"] == "fp-secret-rules-v1"
    expected = [{"id": r.id, "pattern": r.regex.pattern, "flags": r.regex.flags,
                 "keywords": list(r.keywords), "entropy": r.entropy,
                 "secret_group": r.group,
                 "path": r.path.pattern if r.path else None}
                for r in scan.load_rules().rules]
    assert public["rules"] == expected
    assert public["extra_rules"] == [
        {"id": scan.EXTRA_PRIVATE_KEY, "pattern": scan._PRIVATE_KEY.pattern,
         "flags": scan._PRIVATE_KEY.flags},
        {"id": scan.EXTRA_ENV_LINE, "pattern": scan._ENV_LINE.pattern,
         "flags": scan._ENV_LINE.flags, "entropy": scan.ENV_MIN_ENTROPY}]
    assert public["digest_exception"] == {
        "pattern": scan._DIGEST.pattern, "credential_word": scan._CRED_WORD.pattern,
        "word_split": scan._WORD_SPLIT.pattern, "writer_tail_only": True}
    assert public["offsets"] == {"start": "codepoint-inclusive", "end": "codepoint-exclusive",
                                 "start_u16": "utf16-inclusive", "end_u16": "utf16-exclusive"}
    assert "allowlist" not in json.dumps(public).lower()
    assert "stopwords" not in json.dumps(public).lower()
    assert public["vectors"] == VECTORS


@pytest.mark.parametrize("vector", VECTORS, ids=lambda v: v["id"])
def test_synthetic_vectors(vector):
    assert vector in artifact()["vectors"]
    text = vector["text"]
    identifier = vector["field"] == "idempotency_key" or vector["field"].endswith(".name")
    hits = (scan.scan_key(text, digest_tail=vector.get("digest_tail", False))
            if identifier else scan.scan_text(text))
    action = ("allow" if not hits else "reject" if identifier or vector["on_secret"] == "reject"
              else "quarantine")
    assert action == vector["action"]
    if "hit" in vector:
        hit = next(h for h in hits if h.rule == vector["hit"]["rule"])
        assert {"rule": hit.rule, "start": hit.start, "end": hit.end,
                "start_u16": len(text[:hit.start].encode("utf-16-le")) // 2,
                "end_u16": len(text[:hit.end].encode("utf-16-le")) // 2} == vector["hit"]


def test_readiness_rule_version_and_canonical_hash():
    public = artifact()
    sha = hashlib.sha256(json.dumps(public, ensure_ascii=False, sort_keys=True,
                                   separators=(",", ":")).encode("utf-8")).hexdigest()
    fixtures = json.loads((REPO / "docs/contracts/fixtures/first-party.json").read_text())
    assert fixtures["meta_ready"]["secret_rules"] == {"version": public["version"], "sha": sha}
