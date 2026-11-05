"""5.8/5.9: tok_id 소유, in-flight DELETE, 만들기 참조의 비노출 계약."""
import json

import pytest

from kb.core import ledger, spool
from kb.write import engine
from test_http_write import api, data, header, problem  # noqa: F401
from test_token_lifecycle import issue, terminal, token_id  # noqa: F401
from test_write_core import REC, core  # noqa: F401


def held(api, monkeypatch, token, key="loupe:c:held", record=None):
    monkeypatch.setattr(engine, "fp_is_open", lambda _: False)
    response = api.create(token, key=key, record=record)
    assert response.status == 202, response.body
    value = data(response)
    assert value["held"] is True and value["version"] is None and value["seq"] is None
    assert isinstance(value["write_ref"], str) and value["write_ref"]
    assert header(response, "cache-control") == "no-store"
    path = api.home / "spool" / "refs" / (value["write_ref"] + ".json")
    reservation = json.loads(path.read_text())
    assert reservation["tok_id"] == token_id(token)
    assert reservation["actor"] == "app:loupe"
    assert reservation["subject"] == value["id"]
    assert reservation["state"] in ("pending", "held")
    assert reservation["bytes"] > 0
    assert {"kind", "idem_keys", "created_at"} <= reservation.keys()
    return value, path


def fail_held(api, monkeypatch, token, *, key="loupe:c:held", record=None):
    value, path = held(api, monkeypatch, token, key, record)
    # On-disk fixture of reload failure; no fabricated return from the system under test.
    files = list((api.home / "spool" / "fp-held").glob("*.json"))
    matching = next(p for p in files if value["id"] in p.read_text())
    failed = spool.mark_failed(matching)
    reservation = json.loads(path.read_text())
    reservation.update(state="failed", code="create_conflict")
    path.write_text(json.dumps(reservation))
    return value, path, failed


@pytest.mark.parametrize("caller", ["none", "viewer", "other", "rotated"])
@pytest.mark.parametrize("method", ["GET", "DELETE"])
def test_write_ref_only_issuing_tok_id(api, monkeypatch, terminal, capsys, caller, method):
    original = issue(capsys)
    value, _ = held(api, monkeypatch, original)
    if caller == "none":
        token = None
    elif caller == "rotated":
        from kb.cli import main
        assert main(["token", "rotate", "--label", "loupe"]) == 0
        token = capsys.readouterr().out.strip()
        assert token_id(token) != token_id(original)
    else:
        token = api.token(caller, "viewer" if caller == "viewer" else "editor")
    response = api.call(method, f'/v1/writes/{value["write_ref"]}', token)
    missing = api.call(method, "/v1/writes/nonexistent", token)
    problem(response, 404, "not_found")
    problem(missing, 404, "not_found")
    assert data(response)["detail"] == data(missing)["detail"]
    assert not ({"id", "version", "payload_sha", "record"} & data(response).keys())


@pytest.mark.parametrize("state", ["pending", "held"])
def test_in_flight_delete_is_409(api, monkeypatch, state):
    token = api.token()
    value, path = held(api, monkeypatch, token)
    reservation = json.loads(path.read_text())
    reservation["state"] = state
    path.write_text(json.dumps(reservation))
    before = path.read_bytes()
    problem(api.call("DELETE", f'/v1/writes/{value["write_ref"]}', token), 409, "write_in_flight")
    assert path.read_bytes() == before


@pytest.mark.parametrize("state", ["pending", "held", "failed", "purged"])
def test_uncommitted_create_ref_does_not_read_target_head(api, monkeypatch, state):
    token = api.token()
    value, path = held(api, monkeypatch, token)
    reservation = json.loads(path.read_text())
    reservation.update(state=state, code="create_conflict" if state in ("failed", "purged") else None)
    path.write_text(json.dumps(reservation))

    def forbidden(*args, **kwargs):
        pytest.fail("확정 전 create ref는 대상 머리를 읽으면 안 된다")

    monkeypatch.setattr(ledger, "record_head", forbidden)
    response = api.call("GET", f'/v1/writes/{value["write_ref"]}', token)
    assert response.status == 200
    result = data(response)["data"]
    assert result["id"] == value["id"] and result["state"] == state
    assert "record" not in result and "current" not in result


def test_failed_delete_purges_and_repeated_delete_is_idempotent(api, monkeypatch):
    token = api.token()
    value, path, body = fail_held(api, monkeypatch, token)
    route = f'/v1/writes/{value["write_ref"]}'
    for _ in range(2):
        response = api.call("DELETE", route, token)
        assert response.status == 200 and data(response) == {"state": "purged"}
    assert not body.exists() and json.loads(path.read_text())["state"] == "purged"
    response = api.call("GET", route, token)
    assert response.status == 200 and data(response)["data"]["state"] == "purged"
    problem(api.call("GET", route + "?include=body", token), 410, "content_removed")
