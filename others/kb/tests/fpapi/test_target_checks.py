"""가시성 → 판 확인 → 무연산 → CAS 순서와 죽은 머리의 계약."""
import pytest

from kb.core import ledger
from kb.write import engine, record
from kb.write.errors import VersionConflict
from test_write_core import REC, core, events, put, rejected, snapshot


def tombstone(rid, version, key="loupe:t:synthetic", **kw):
    return record.tombstone_record(rid, "합성 삭제", key, "http", token_label="loupe",
                                   change="save", expected_version=version, **kw)


def assert_hidden(call):
    exc = rejected(call, "not_found", 404)
    for field in ("current", "id", "version", "payload_sha", "seq"):
        assert getattr(exc, field, None) is None
    return exc


@pytest.mark.parametrize("hidden", ["missing", "secret", "quarantine", "wrong_type", "external", "redacted"])
def test_hidden_targets_are_value_free_404_before_cas(core, monkeypatch, hidden):
    rid = "f-" + "a" * 26
    if hidden != "missing":
        p = dict(REC, id=rid)
        if hidden == "secret":
            p["sensitivity"] = "secret"
        if hidden == "quarantine":
            p["props"] = {"quarantine": True}
        if hidden == "wrong_type":
            p["type"] = "Learning"
        c = ledger.open_ledger()
        try:
            ledger.append(c, [{"kind": "record.put", "origin": "external" if hidden == "external" else "first_party",
                               "actor": "system:test", "subject": rid, "idem_key": "fw3:seed", "payload": p}])
            if hidden == "redacted":
                ledger.redact(c, rid, "합성 삭제", "user:sagae", "fw3:redact")
        finally:
            c.close()
    before = snapshot(core)
    calls = []
    monkeypatch.setattr(engine.cas, "put", lambda *a, **kw: calls.append(a) or "a" * 64)
    exc = assert_hidden(lambda: put(dict(REC, id=rid, body="x" * 70000, expected_version=0), key="loupe:e:hidden"))
    assert rid not in str(exc) and REC["title"] not in str(exc)
    assert_hidden(lambda: tombstone(rid, 0))
    assert calls == []
    assert snapshot(core) == before


def test_stale_version_checked_before_large_body_cas(core, monkeypatch):
    first = put()
    before = snapshot(core)
    calls = []
    monkeypatch.setattr(engine.cas, "put", lambda *a, **kw: calls.append(a) or "a" * 64)
    with pytest.raises(VersionConflict):
        put(dict(REC, id=first.id, expected_version=0, body="x" * 70000), "loupe:e:large-stale")
    assert calls == [] and snapshot(core) == before


def test_current_same_content_is_unchanged_without_append(core):
    first = put()
    before = snapshot(core)
    result = put(dict(REC, id=first.id, expected_version=1), "loupe:e:same")
    assert result.version == 1 and result.as_dict()["unchanged"] is True
    assert snapshot(core) == before


def test_dry_run_checks_hidden_target_without_persistence(core):
    first = record.put_record(dict(REC, sensitivity="secret"), "fw3:dry-hidden", "cli", tty=True)
    before = snapshot(core)
    assert_hidden(lambda: put(dict(REC, id=first.id, expected_version=1), "loupe:e:dry-hidden", dry_run=True))
    assert snapshot(core) == before


def test_stale_same_content_conflicts_with_structured_current(core):
    created = put()
    rec = dict(REC, id=created.id, expected_version=1, body="둘째 본문")
    current = put(rec, "loupe:e:v1")
    before = snapshot(core)
    with pytest.raises(VersionConflict) as exc:
        put(rec, "loupe:e:stale")
    now = exc.value.current
    assert now["version"] == 2 and now["status"] == "active"
    assert now["body"] == rec["body"] and now["title"] == REC["title"]
    assert now["payload_sha"] == current.as_dict()["payload_sha"]
    assert now["actor"] == "app:loupe" and now["claimed_author"] == "user:sagae"
    assert now["generated_by"] == "app:loupe:save" and now["body_truncated"] is False
    assert "recorded_at" in now and "props" in now and "links" in now
    assert snapshot(core) == before


@pytest.mark.parametrize("transport", ["mcp", "inbox", "cli"])
def test_legacy_stale_same_content_conflicts(core, transport):
    first = record.put_record(REC, "fw3:legacy-create", transport, "fw3", tty=True)
    second = dict(REC, id=first.id, body="둘째", expected_version=1)
    record.put_record(second, "fw3:legacy-update", transport, "fw3", tty=True)
    with pytest.raises(VersionConflict):
        record.put_record(second, "fw3:legacy-stale", transport, "fw3", tty=True)


def test_visible_tombstone_conflict_has_only_version_status_and_restore_is_active(core):
    first = put()
    dead = tombstone(first.id, 1)
    with pytest.raises(VersionConflict) as exc:
        put(dict(REC, id=first.id, expected_version=1), "loupe:e:dead-stale")
    assert exc.value.current == {"version": dead.version, "status": "dead"}
    restored = put(dict(REC, id=first.id, expected_version=dead.version), "loupe:e:restore")
    assert restored.version == dead.version + 1
    with pytest.raises(VersionConflict) as exc:
        put(dict(REC, id=first.id, expected_version=dead.version), "loupe:e:restore-stale")
    assert exc.value.current["status"] == "active"
    assert [e["kind"] for e in events() if e["subject"] == first.id] == [
        "record.put", "record.tombstone", "record.put"]


@pytest.mark.parametrize("hidden", ["secret", "quarantine"])
def test_tombstone_checks_last_put_sensitivity(core, hidden):
    rec = dict(REC, sensitivity="secret") if hidden == "secret" else dict(REC, body="-----BEGIN PRIVATE KEY-----")
    first = record.put_record(rec, "fw3:hidden-create", "cli", tty=True)
    record.tombstone_record(first.id, "합성 삭제", "fw3:hidden-delete", "cli", tty=True)
    before = snapshot(core)
    assert_hidden(lambda: put(dict(REC, id=first.id, expected_version=1), "loupe:e:hidden-dead"))
    assert_hidden(lambda: tombstone(first.id, 2))
    assert snapshot(core) == before


def test_editor_update_and_tombstone_require_expected_version(core):
    first = put()
    rejected(lambda: put(dict(REC, id=first.id), "loupe:e:no-version"), "expected_version_required", 428)
    rejected(lambda: record.tombstone_record(first.id, "삭제", "loupe:t:no-version", "http",
                                             token_label="loupe", change="save"), "expected_version_required", 428)
