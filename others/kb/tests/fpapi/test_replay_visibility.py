"""재생도 잠금 안에서 지금 가시성을 다시 검사한다."""
import pytest

from kb.core import ledger
from kb.core.gatelock import Gate
from kb.write import record
from test_write_core import REC, core, put, snapshot
from test_target_checks import assert_hidden


@pytest.mark.parametrize("hidden", ["secret", "quarantine", "redacted"])
def test_replay_rechecks_current_visibility(core, hidden):
    first = put()
    if hidden == "redacted":
        c = ledger.open_ledger()
        try:
            ledger.redact(c, first.id, "합성 삭제", "user:sagae", "fw3:replay-redact")
        finally:
            c.close()
    else:
        rec = dict(REC, id=first.id, expected_version=1, sensitivity="secret")
        if hidden == "quarantine":
            rec.update(sensitivity="internal", body="-----BEGIN PRIVATE KEY-----")
        record.put_record(rec, "fw3:hide", "cli", tty=True)
    before = snapshot(core)
    assert_hidden(lambda: put())
    assert snapshot(core) == before


def test_quarantined_create_replay_is_hidden(core):
    rec = dict(REC, body="-----BEGIN PRIVATE KEY-----")
    put(rec, on_secret="quarantine")
    before = snapshot(core)
    assert_hidden(lambda: put(rec, on_secret="quarantine"))
    assert snapshot(core) == before


def test_visible_replay_returns_first_response_without_append(core):
    first = put()
    before = snapshot(core)
    replay = put()
    expected = dict(first.as_dict(), replayed=True)
    assert replay.as_dict() == expected
    assert snapshot(core) == before


def test_visibility_uses_head_changed_while_waiting_for_gate(core, monkeypatch):
    first = put()
    original = Gate.acquire
    changed = False

    def acquire(gate, *args, **kw):
        nonlocal changed
        fd = original(gate, *args, **kw)
        if not changed:
            changed = True
            # 잠금 획득 직전 다른 작성기가 확정한 머리를 결정적으로 재현한다.
            c = ledger.open_ledger()
            try:
                ledger.append(c, [{"kind": "record.put", "origin": "first_party", "actor": "user:sagae",
                                   "subject": first.id, "idem_key": "fw3:gate-hide",
                                   "payload": dict(REC, id=first.id, sensitivity="secret"), "expected_version": 1}])
            finally:
                c.close()
        return fd

    monkeypatch.setattr(Gate, "acquire", acquire)
    assert_hidden(lambda: put(dict(REC, id=first.id, expected_version=1), "loupe:e:gate-race"))
    assert changed
