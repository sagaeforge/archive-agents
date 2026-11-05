"""HTTP actor별 실효 키와 복구 가능한 결정적 ID. 기존 통로 규칙은 유지한다."""
import base64
import hashlib

import pytest

from kb.core import ledger
from kb.write import record, secrets_scan
from kb.write.errors import IdemConflict, VersionConflict
from test_write_core import REC, core, events, put, rejected, snapshot


def editor_id(actor, key):
    digest = hashlib.sha256(b"kb-record-id-editor-v1\0" + actor.encode() + b"\0" + key.encode()).digest()[:16]
    return "f-" + base64.b32encode(digest).decode().lower().rstrip("=")


def test_same_key_other_actor_creates_separate_record(core):
    key = "loupe:c:same-draft"
    a = put(key=key)
    b = put(key=key, label="other")
    assert a.id == editor_id("app:loupe", key)
    assert b.id == editor_id("app:other", key) and b.id != a.id
    evs = [e for e in events() if e["kind"] == "record.put"]
    assert [e["idem_key"] for e in evs] == [f"h\0app:loupe\0{key}", f"h\0app:other\0{key}"]
    c = ledger.open_ledger()
    try:
        assert not c.execute("SELECT k FROM meta WHERE k LIKE '%salt%'").fetchall()
    finally:
        c.close()


@pytest.mark.parametrize("transport", ["http", "mcp", "inbox", "cli", "intake"])
@pytest.mark.parametrize("operation", ["put", "tombstone"])
def test_client_nul_key_rejected_all_transports(core, transport, operation):
    kw = {"token_label": "loupe", "change": "save"} if transport == "http" else {"session": "fw3"}
    if operation == "tombstone":
        target = record.put_record(REC, "fw3:nul-target", "cli", tty=True)
        call = lambda: record.tombstone_record(target.id, "삭제", "x\0y", transport, **kw)
    else:
        call = lambda: record.put_record(REC, "x\0y", transport, **kw)
    before = snapshot(core)
    rejected(call, "schema_invalid", 400)
    assert snapshot(core) == before


def test_response_loss_autosave_to_save_same_id_conflict_no_duplicate(core):
    key = "loupe:c:lost-response"
    first = put(key=key, change="autosave")
    before = snapshot(core)
    with pytest.raises(VersionConflict) as exc:
        put(key=key, change="save")
    assert exc.value.current["version"] == 1
    assert exc.value.current["payload_sha"] == first.as_dict()["payload_sha"]
    assert first.id == editor_id("app:loupe", key)
    assert len([e for e in events() if e["kind"] == "record.put"]) == 1
    assert snapshot(core) == before
    updated = put(dict(REC, id=first.id, expected_version=1, body="최종 본문"), "loupe:e:follow-up")
    assert updated.id == first.id and updated.version == 2


def test_changed_create_content_is_version_conflict(core):
    first = put()
    with pytest.raises(VersionConflict) as exc:
        put(dict(REC, body="바뀐 초안"))
    assert exc.value.current["version"] == first.version


def test_changed_update_same_key_is_idem_conflict(core):
    first = put()
    rec = dict(REC, id=first.id, expected_version=1, body="둘째")
    put(rec, "loupe:e:one-key")
    with pytest.raises(IdemConflict):
        put(dict(rec, body="셋째"), "loupe:e:one-key")


def test_segment_recovery_preserves_namespace_and_replay(core, monkeypatch):
    first = put()
    c = ledger.open_ledger()
    try:
        segments = ledger.export_segment(c)
    finally:
        c.close()
    recovered = ledger.open_ledger(core / "recovered.db")
    try:
        for segment in segments:
            ledger.append(recovered, ledger.read_segment(segment["file"]))
        assert ledger.verify_chain(recovered)
        original_open = ledger.open_ledger
        monkeypatch.setattr(ledger, "open_ledger", lambda *a, **kw: original_open(core / "recovered.db"))
        replay = put()
        assert (replay.id, replay.version, replay.seq, replay.replayed) == (first.id, first.version, first.seq, True)
        assert recovered.execute("SELECT count(*) FROM event WHERE kind='record.put'").fetchone()[0] == 1
        assert not recovered.execute("SELECT k FROM meta WHERE k LIKE '%salt%'").fetchall()
    finally:
        recovered.close()


def test_legacy_id_and_global_replay_unchanged(core):
    key = "fw3:legacy-global"
    digest = hashlib.sha256(b"kb-record-id\0" + key.encode()).digest()[:16]
    expected = "f-" + base64.b32encode(digest).decode().lower().rstrip("=")
    first = record.put_record(REC, key, "cli", tty=True)
    replay = record.put_record(REC, key, "inbox")
    assert first.id == expected and replay.id == expected and replay.replayed
    assert next(e for e in events() if e["kind"] == "record.put")["idem_key"] == key


def test_writer_digest_tail_exception_preserved(core):
    key = "inbox:api_key:" + "0123456789abcdef" * 2
    assert secrets_scan.scan_key(key)
    assert secrets_scan.scan_key(key, digest_tail=True) == []
    result = record.put_record(REC, key, "inbox", key_digest_tail=True)
    assert result.version == 1
    rejected(lambda: put(key=key), "secret_detected", 422)
