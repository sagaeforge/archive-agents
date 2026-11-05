"""편집기 비밀 거절·dry-run은 모든 영속 저장소에서 입력 잔여가 없어야 한다."""
import hashlib
import json
from pathlib import Path

import pytest

from kb.write import record
from test_write_core import REC, assert_absent, core, events, payload, put, rejected, snapshot

SECRET = "-----BEGIN PRIVATE KEY-----"


@pytest.mark.parametrize("choice", ["reject", "quarantine"])
@pytest.mark.parametrize("field", ["key", "id", "type", "prop_name", "nested_name", "slug", "reason"])
def test_identifier_secrets_always_422(core, caplog, choice, field):
    rec, key = dict(REC), "loupe:c:identifier"
    if field == "key":
        key = SECRET
    elif field in {"id", "type"}:
        rec[field] = SECRET
    elif field == "prop_name":
        rec["props"] = {SECRET: "value"}
    elif field == "nested_name":
        rec["props"] = {"custom": [{SECRET: "value"}]}
    elif field == "slug":
        rec.update(type="TopicSpec", props={"slug": SECRET})
    if field == "reason":
        created = put(key="loupe:c:reason-target")
        call = lambda: record.tombstone_record(created.id, SECRET, key, "http", token_label="loupe",
                                               change="save", on_secret=choice, expected_version=1)
    else:
        call = lambda: put(rec, key, on_secret=choice)
    before = snapshot(core)
    exc = rejected(call, "secret_detected", 422)
    assert snapshot(core) == before
    assert_absent(core, SECRET)
    assert SECRET not in str(exc) + repr(vars(exc)) + caplog.text


@pytest.mark.parametrize("key", ["source_path", "path", "file", "filename", "custom_path"])
def test_editor_path_hints_rejected_before_scanning(core, caplog, key):
    before = snapshot(core)
    exc = rejected(lambda: put(dict(REC, props={key: SECRET})), "schema_invalid", 400)
    assert snapshot(core) == before
    assert_absent(core, SECRET)
    assert SECRET not in str(exc) + caplog.text


@pytest.mark.parametrize("field", ["title", "body", "props", "links"])
def test_content_secret_defaults_to_reject_without_residue(core, caplog, field):
    rec = dict(REC)
    rec[field] = {"props": {"memo": SECRET}, "links": [{"rtype": "LINKS_TO", "dst": SECRET}]}.get(field, SECRET)
    before = snapshot(core)
    exc = rejected(lambda: put(rec), "secret_detected", 422)
    assert snapshot(core) == before
    assert_absent(core, SECRET)
    assert SECRET not in str(exc) + repr(vars(exc)) + caplog.text


def test_explicit_save_quarantines_content(core):
    result = put(dict(REC, body=SECRET), on_secret="quarantine")
    p = payload(result.id)
    assert p["sensitivity"] == "secret"
    assert p["props"]["quarantine"] is True
    assert p["props"]["quarantine_from"] == "internal"
    assert result.as_dict()["quarantined"] is True
    assert sum(e["kind"] == "record.put" for e in events()) == 1


@pytest.mark.parametrize("change", ["autosave", "auto"])
def test_quarantine_requires_explicit_save(core, change):
    before = snapshot(core)
    rejected(lambda: put(dict(REC, body=SECRET), change=change, on_secret="quarantine"), "schema_invalid", 400)
    assert snapshot(core) == before


@pytest.mark.parametrize("secret", [False, True])
@pytest.mark.parametrize("choice", ["reject", "quarantine"])
def test_large_dry_run_leaves_no_residue_or_echo(core, caplog, secret, choice):
    marker = "FW3-DRY-RUN-UNIQUE-CANARY"
    text = marker + "가" * 30000 + (SECRET if secret else "")
    before = snapshot(core)
    result = put(dict(REC, body=text), dry_run=True, on_secret=choice)
    assert result["would_reject"] is (secret and choice == "reject")
    assert bool(result["hits"]) is secret
    artifact = json.loads((Path(__file__).resolve().parents[2] / "docs/contracts/first-party-secret-rules-v1.json").read_text())
    sha = hashlib.sha256(json.dumps(artifact, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert result["secret_rules"] == {"version": artifact["version"], "sha": sha}
    assert snapshot(core) == before
    assert_absent(core, marker, SECRET)
    assert marker not in json.dumps(result) + caplog.text
    assert SECRET not in json.dumps(result) + caplog.text


def test_secret_diagnostics_use_ordinals_and_codepoint_utf16_ranges(core):
    text = "한글😀" + SECRET
    result = put(dict(REC, body=text, props={"custom": "safe"}), dry_run=True)
    hit = next(h for h in result["hits"] if h["rule"] == "kb-private-key-header")
    assert hit == {"field": "record.body", "rule": "kb-private-key-header", "start": 3, "end": 30,
                   "start_u16": 4, "end_u16": 31}
    result = put(dict(REC, props={"not_for_echo": SECRET}), dry_run=True)
    assert any(h["field"] == "record.props[0].value" for h in result["hits"])
    assert "not_for_echo" not in json.dumps(result)


def test_large_secret_rejection_never_creates_cas_spool_or_hold(core, caplog):
    text = "FW3-REJECT-CANARY" + "가" * 30000 + SECRET
    before = snapshot(core)
    exc = rejected(lambda: put(dict(REC, body=text)), "secret_detected", 422)
    assert snapshot(core) == before
    assert_absent(core, SECRET, "FW3-REJECT-CANARY")
    assert SECRET not in str(exc) + caplog.text
