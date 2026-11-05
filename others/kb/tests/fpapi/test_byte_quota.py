"""5.8: MB=10^6 bytes. 실제 원장 payload로 한도를 채운다."""
import time

import pytest

from kb.core import ledger, opsdb
from kb.core.canon import canon_json
from test_http_write import api, data, header, problem  # noqa: F401
from test_write_core import REC, core  # noqa: F401

TOKEN_BYTES = 32_000_000
RECORD_BYTES = 8_000_000
DAY_MS = 86_400_000


def fill_ledger(api, size, *, actor="app:loupe", rid=None, at=None):
    """총 payload 바이트를 정확히 size로 만든 fixture. quota 함수는 대역하지 않는다."""
    remaining, index = size, 0
    while remaining:
        subject = rid or f"f-quota-{index}"
        payload = dict(REC, id=subject, body="", authored_at=1)
        overhead = len(canon_json(payload))
        amount = min(1_000_000, remaining)
        assert amount >= overhead
        payload["body"] = "x" * (amount - overhead)
        assert len(canon_json(payload)) == amount
        ledger.append(api.world.led, [{"kind": "record.put", "actor": actor, "origin": "first_party",
                                      "subject": subject, "idem_key": f"fw4:quota:{actor}:{subject}:{index}",
                                      "at": at if at is not None else int(time.time() * 1000), "payload": payload}])
        remaining -= amount
        index += 1


@pytest.mark.parametrize("restart", [False, True])
def test_save_token_bytes_quota_survives_restart_and_ops_loss(api, restart):
    token = api.token()
    fill_ledger(api, TOKEN_BYTES)
    if restart:
        # Close all ops handles before deleting the disposable metrics store.
        connection = opsdb.connect()
        connection.close()
        for path in api.home.rglob("ops.db*"):
            path.unlink()
        api.restart()
    response = api.create(token, record=dict(REC, body="새 저장"))
    problem(response, 429, "byte_quota_exceeded")
    assert header(response, "retry-after")


def test_record_bytes_limit_is_separate_from_actor_limit(api):
    token = api.token()
    first = api.create(token)
    assert first.status == 201
    rid = data(first)["id"]
    fill_ledger(api, RECORD_BYTES, actor="app:other", rid=rid)
    head = ledger.record_head(api.world.led, rid)
    response = api.call("PUT", f"/v1/records/{rid}", token,
                        {"idempotency_key": "loupe:e:quota", "change": "save",
                         "record": dict(REC, body="새 저장", expected_version=head[0])})
    problem(response, 429, "byte_quota_exceeded")


def test_idempotent_replay_precedes_quota_and_consumes_no_more_bytes(api):
    token = api.token()
    first = api.create(token)
    assert first.status == 201
    fill_ledger(api, TOKEN_BYTES)
    before = ledger.head(api.world.led)
    replay = api.create(token)
    assert replay.status in (200, 201)
    assert data(replay)["replayed"] is True
    assert data(replay)["id"] == data(first)["id"]
    assert data(replay)["payload_sha"] == data(first)["payload_sha"]
    assert ledger.head(api.world.led) == before
    problem(api.create(token, key="loupe:c:over-limit"), 429, "byte_quota_exceeded")


def test_bytes_older_than_24_hours_do_not_block_save(request, monkeypatch):
    past = time.time() - 2 * DAY_MS / 1000
    with monkeypatch.context() as clock:
        clock.setattr(ledger.time, "time", lambda: past)
        # Initialize core's first event under the same past clock as the payloads.
        api = request.getfixturevalue("api")
        fill_ledger(api, TOKEN_BYTES, at=int(time.time() * 1000))
    token = api.token()
    assert api.create(token).status == 201
