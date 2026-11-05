"""FW4 독립 검토 회귀: 종료된 참조, 재생, 휴지통 우회, 인증 오류의 ID."""
import json
import time

import pytest

from kb.core import ledger
from kb.serve import fpapi, http as H
from kb.write import engine, fpquota as Q
from test_http_write import api, data, problem  # noqa: F401
from test_trash import delete_record, ids
from test_write_core import REC, core  # noqa: F401
from test_write_ref import fail_held, held


@pytest.mark.parametrize("state", ["purged", "failed", "committed"])
def test_terminal_reference_retry_cannot_recreate_spool_body(api, monkeypatch, state):
    token = api.token()
    value, path, body = fail_held(api, monkeypatch, token)
    if state == "purged":
        response = api.call("DELETE", f'/v1/writes/{value["write_ref"]}', token)
        assert response.status == 200
    else:
        reservation = json.loads(path.read_bytes())
        reservation["state"] = state
        path.write_text(json.dumps(reservation))
    before = {str(p.relative_to(api.home)): p.read_bytes() for p in (api.home / "spool").rglob("*") if p.is_file()}
    problem(api.create(token, key="loupe:c:held"), 410, "content_removed")
    after = {str(p.relative_to(api.home)): p.read_bytes() for p in (api.home / "spool").rglob("*") if p.is_file()}
    assert after == before


@pytest.mark.parametrize("state", ["pending", "held"])
def test_pending_reference_retry_preserves_body_hash_and_reserved_bytes(api, monkeypatch, state):
    token = api.token()
    original, path = held(api, monkeypatch, token)
    reservation = json.loads(path.read_bytes())
    reservation["state"] = state
    path.write_text(json.dumps(reservation))
    before = {str(p.relative_to(api.home)): p.read_bytes() for p in (api.home / "spool").rglob("*") if p.is_file()}
    retry = api.create(token, key="loupe:c:held")
    assert retry.status == 202
    assert data(retry)["write_ref"] == original["write_ref"]
    assert data(retry)["payload_sha"] == original["payload_sha"]
    after = {str(p.relative_to(api.home)): p.read_bytes() for p in (api.home / "spool").rglob("*") if p.is_file()}
    assert after == before


def test_gate_timeout_of_committed_key_is_replay_without_reservation(api, monkeypatch):
    token = api.token()
    first = api.create(token)
    assert first.status == 201
    before = ledger.head(api.world.led)

    def busy(*args, **kwargs):
        raise TimeoutError("synthetic occupied gate")

    monkeypatch.setattr(engine.Gate, "acquire", busy)
    replay = api.create(token)
    assert replay.status in (200, 201)
    assert data(replay)["replayed"] is True
    assert data(replay)["spooled"] is False and data(replay)["held"] is False
    assert data(replay)["write_ref"] is None
    for field in ("id", "version", "seq", "payload_sha"):
        assert data(replay)[field] == data(first)[field]
    assert ledger.head(api.world.led) == before
    assert list(Q.refs_dir().glob("*.json")) == []
    assert list((api.home / "spool" / "in").glob("*.json")) == []


def test_receiving_replay_does_not_authorize_a_new_reservation(api):
    token = api.token()
    first = api.create(token)
    assert first.status == 201
    event = next(e for e in ledger.iter_events(api.world.led, 0, 1000) if e["subject"] == data(first)["id"])
    context = Q.identity.set(H.token_info(token))
    try:
        with Q.lock():
            assert Q.receiving(api.world.led, [event]) == []
            assert Q.reserve(api.world.led, [event], {"v": 1, "events": [event]},
                             "committed-replay", "in") is None
    finally:
        Q.identity.reset(context)
    assert list(Q.refs_dir().glob("*.json")) == []
    assert list((api.home / "spool" / "in").glob("*.json")) == []


@pytest.mark.parametrize("case,status,code", [("changed", 409, "version_conflict"), ("secret", 404, "not_found")])
def test_timeout_replay_still_checks_content_and_current_visibility(api, monkeypatch, case, status, code):
    token = api.token()
    first = api.create(token)
    assert first.status == 201
    if case == "secret":
        rid = data(first)["id"]
        ledger.append(api.world.led, [{"kind": "record.put", "actor": "app:loupe", "origin": "first_party",
                                      "subject": rid, "idem_key": "review:secret",
                                      "payload": dict(REC, id=rid, sensitivity="secret")}])
    before = ledger.head(api.world.led)

    def busy(*args, **kwargs):
        raise TimeoutError("synthetic occupied gate")

    monkeypatch.setattr(engine.Gate, "acquire", busy)
    response = api.create(token, record=dict(REC, body="다른 내용") if case == "changed" else REC)
    problem(response, status, code)
    assert ledger.head(api.world.led) == before
    assert list(Q.refs_dir().glob("*.json")) == []
    assert list((api.home / "spool" / "in").glob("*.json")) == []


def test_pending_ref_whose_key_committed_does_not_double_count_daily_usage(api):
    token = api.token()
    first = api.create(token)
    assert first.status == 201
    event = next(e for e in ledger.iter_events(api.world.led, 0, 1000) if e["subject"] == data(first)["id"])
    info = H.token_info(token)
    with Q.lock():
        Q.save(Q.refs_dir() / "awaiting-reconciliation.json",
               {"state": "pending", "tok_id": info["tok_id"], "actor": event["actor"],
                "subject": event["subject"], "kind": "create", "bytes": 32_000_000,
                "idem_keys": [event["idem_key"]], "created_at": int(time.time() * 1000)})
    assert api.create(token, key="loupe:c:after-replay").status == 201


@pytest.mark.parametrize("lookup", ["list", "ids"])
def test_status_all_retains_created_app_and_last_put_visibility(api, lookup):
    token, other = api.token(), api.token("other")
    mine = api.create(token)
    theirs = api.create(other, key="other:c:dead")
    hidden = api.create(token, key="loupe:c:hidden")
    active = api.create(token, key="loupe:c:active")
    assert all(r.status == 201 for r in (mine, theirs, hidden, active))
    mine_id, other_id, hidden_id, active_id = (data(r)["id"] for r in (mine, theirs, hidden, active))
    for rid in (mine_id, other_id):
        delete_record(api, other, rid)
    ledger.append(api.world.led, [
        {"kind": "record.put", "actor": "app:loupe", "origin": "first_party", "subject": hidden_id,
         "idem_key": "review:hidden", "payload": dict(REC, id=hidden_id, props={"quarantine": True})},
        {"kind": "record.tombstone", "actor": "app:loupe", "origin": "first_party", "subject": hidden_id,
         "idem_key": "review:hidden:dead", "payload": {"id": hidden_id, "reason": "합성 삭제"}},
    ])
    route = "/v1/nodes?status=all"
    if lookup == "ids":
        route += "&ids=" + ",".join((mine_id, other_id, hidden_id, active_id))
    else:
        route += "&origin=first_party&types=Page,Note,TopicSpec,Review"
    response = api.call("GET", route, token)
    assert set(ids(response)) == {mine_id, active_id}
    assert data(response)["page"]["total"] == 2
    assert other_id.encode() not in response.body and hidden_id.encode() not in response.body


@pytest.mark.parametrize("failure", ["bad_bearer", "missing_tcp_bearer", "rate", "concurrency"])
def test_read_auth_and_rate_errors_mask_private_id_but_keep_missing_path(api, monkeypatch, failure):
    editor = api.token()
    first = api.create(editor, record=dict(REC, sensitivity="private"))
    assert first.status == 201
    rid = data(first)["id"]
    if failure == "rate":
        token = api.token("viewer", "viewer")
        monkeypatch.setattr(fpapi.Adapter, "allow", lambda *args: False)
        status, code = 429, "too_many_requests"
    elif failure == "concurrency":
        from kb.serve.limits import ConcurrencyLimit

        async def limited(self, scope, receive, send):
            return await H.send_problem(send, 429, "too_many_requests", "합성 동시 처리 상한", scope["path"])

        monkeypatch.setattr(ConcurrencyLimit, "__call__", limited)
        token, status, code = editor, 429, "too_many_requests"
    elif failure == "bad_bearer":
        token, status, code = "synthetic-invalid", 401, "token_invalid"
    else:
        token, status, code = None, 401, "token_required"
    response = api.call("GET", f"/v1/nodes/{rid}", token, tcp=True)
    assert problem(response, status, code)["instance"] == "/v1/nodes/{id}"
    assert rid.encode() not in response.body
    missing = "/v1/nodes/f-missing-review-target"
    response = api.call("GET", missing, token, tcp=True)
    assert problem(response, status, code)["instance"] == missing
