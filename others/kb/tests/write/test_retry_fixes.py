"""재시도 수정 4건의 재현 시험."""
import os
import time

from kb.core import paths, spool
from kb.core.gatelock import Gate
from kb.write import fpgate, inbox, put_record
from kb.write.engine import gate_path
from wrhelp import add_drill, count_events, events

SEC = "---\ntype: Note\ntitle: 비공개 메모\nsensitivity: private\n---\n본문 비밀\n"


def _put(name, data: bytes):
    d = paths.inbox_dir()
    d.mkdir(parents=True, exist_ok=True)
    f = d / name
    f.write_bytes(data)
    t = time.time() - 100
    os.utime(f, (t, t))
    return f


def test_crlf_and_bom_front_matter_is_parsed(fp_open):
    rec, _ = inbox.parse_file(SEC.replace("\n", "\r\n"), "x")
    assert rec["sensitivity"] == "private" and rec["title"] == "비공개 메모"
    rec, _ = inbox.parse_file("﻿" + SEC, "x")
    assert rec["sensitivity"] == "private"
    _put("crlf.md", SEC.replace("\n", "\r\n").encode())
    _put("bom.md", b"\xef\xbb\xbf" + SEC.replace("비공개 메모", "bom 메모").encode())
    r = inbox.scan()
    assert r.written == 2 and not r.failed
    ev = events("kind='record.put'")
    assert len(ev) == 2


def test_unclosed_front_matter_goes_failed(fp_open):
    f = _put("bad.md", b"---\r\ntitle: x\r\nsensitivity: private\r\n\r\n\xeb\xb3\xb8\xeb\xac\xb8\r\n")
    r = inbox.scan()
    assert r.written == 0 and r.failed == ["bad.md"] and not f.exists()
    assert count_events("record.put") == 0


def test_crlf_stale_base_version_conflicts(fp_open):
    a = SEC.replace("sensitivity: private", "id: n-crlf\nsensitivity: private")
    _put("a.md", a.encode())
    assert inbox.scan().written == 1
    _put("b.md", a.replace("본문 비밀", "수정1").replace("id: n-crlf", "id: n-crlf\nbase_version: 1").replace("\n", "\r\n").encode())
    assert inbox.scan().written == 1
    _put("c.md", a.replace("본문 비밀", "수정2").replace("id: n-crlf", "id: n-crlf\nbase_version: 1").replace("\n", "\r\n").encode())
    r = inbox.scan()
    assert r.written == 0 and (len(r.conflicts) == 1 or len(r.failed) == 1)


def test_open_fp_gate_timeout_keeps_held_and_fails(wk, monkeypatch):
    add_drill()
    r0 = put_record({"type": "Note", "title": "보류", "body": "b", "sensitivity": "internal"}, "ret-h1", "mcp", "s-a")
    assert r0.held
    monkeypatch.setattr(fpgate._commit, "GATE_TIMEOUT_S", 0.2)
    gate = Gate(gate_path())
    fd = gate.acquire(1)
    try:
        res = fpgate.open_fp()
    finally:
        gate.release(fd)
    assert not res.ok and res.error
    assert len(list(spool.dir_of("fp-held").glob("*.json"))) == 1
    res = fpgate.open_fp()
    assert res.ok and res.drained == 1
    assert list(spool.dir_of("fp-held").glob("*.json")) == []
    assert count_events("record.put") == 1


def test_drain_never_deletes_when_commit_holds(wk):
    r0 = put_record({"type": "Note", "title": "보류2", "body": "b", "sensitivity": "internal"}, "ret-h2", "mcp", "s-a")
    assert r0.held
    d = fpgate.drain("fp-held")
    assert d["loaded"] == 0 and d["left"] == 1
    assert len(list(spool.dir_of("fp-held").glob("*.json"))) == 1


def test_drain_ledger_error_goes_failed_and_continues(fp_open, monkeypatch):
    from kb.core.ledger import LedgerError
    spool.put("fp-held", {"events": [{"kind": "x", "origin": "first_party"}]}, "a" * 8)
    calls = []

    def boom(evs, *a, **k):
        calls.append(1)
        raise LedgerError("bad")
    monkeypatch.setattr(fpgate._commit, "commit", boom)
    d = fpgate.drain("fp-held")
    assert d["failed"] == 1 and d["left"] == 0
    assert list(spool.dir_of("fp-held").glob("*.json")) == []


def test_retry_create_with_explicit_id_same_key_replays(fp_open):
    rec = {"id": "n-explicit", "type": "Note", "title": "명시", "body": "b", "sensitivity": "internal"}
    a = put_record(rec, "idem-ex", "mcp", "s-a")
    b = put_record(rec, "idem-ex", "mcp", "s-a")
    assert b.replayed and b.version == a.version
    assert count_events("record.put") == 1
