"""실패 초안: 발급 editor만 회수, 가시성 검사가 410보다 먼저다."""
import json

import pytest

from test_http_write import api, data, problem  # noqa: F401
from test_write_core import REC, core  # noqa: F401
from test_write_ref import fail_held


def test_failed_body_requires_include_and_returns_own_record_and_hash(api, monkeypatch):
    token = api.token()
    record = dict(REC, title="회수 제목", body="회수 초안", props={"memo": "속성"}, links=[])
    value, _, _ = fail_held(api, monkeypatch, token, record=record)
    route = f'/v1/writes/{value["write_ref"]}'
    plain = api.call("GET", route, token)
    assert plain.status == 200
    assert "record" not in data(plain)["data"] and "payload_sha" not in data(plain)["data"]
    response = api.call("GET", route + "?include=body", token)
    assert response.status == 200
    result = data(response)["data"]
    assert result["state"] == "failed" and result["code"] == "create_conflict"
    assert {key: result["record"][key] for key in record} == record
    assert result["payload_sha"] == value["payload_sha"]
    hidden = api.call("GET", route + "?include=body", api.token("other"))
    problem(hidden, 404, "not_found")
    assert all(marker.encode() not in hidden.body for marker in ("회수 제목", "회수 초안", value["payload_sha"]))


@pytest.mark.parametrize("state", ["pending", "held", "committed"])
def test_body_include_invalid_for_nonfailed_states(api, monkeypatch, state):
    token = api.token()
    value, path, _ = fail_held(api, monkeypatch, token)
    reservation = json.loads(path.read_text())
    reservation["state"] = state
    path.write_text(json.dumps(reservation))
    # committed create must have a visible head before parameter validation.
    if state == "committed":
        from read.rhelp import record
        api.world.add(record(value["id"], "합성 머리", "internal"))
    problem(api.call("GET", f'/v1/writes/{value["write_ref"]}?include=body', token), 400, "bad_param")


@pytest.mark.parametrize("hidden", ["secret", "quarantine"])
def test_failed_stored_secret_or_quarantine_is_404_even_for_owner(api, monkeypatch, hidden):
    token = api.token()
    value, _, body = fail_held(api, monkeypatch, token)
    stored = json.loads(body.read_text())
    payload = stored["events"][0]["payload"]
    if hidden == "secret":
        payload["sensitivity"] = "secret"
    else:
        payload.setdefault("props", {})["quarantine"] = True
    body.write_text(json.dumps(stored))
    response = api.call("GET", f'/v1/writes/{value["write_ref"]}?include=body', token)
    problem(response, 404, "not_found")
    assert "record" not in data(response) and "payload_sha" not in data(response)


def test_hidden_edit_target_returns_404_before_purged_body_410(api, monkeypatch):
    from kb.write import engine
    from read.rhelp import record
    token = api.token()
    first = api.create(token)
    assert first.status == 201
    rid = data(first)["id"]
    monkeypatch.setattr(engine, "fp_is_open", lambda _: False)
    response = api.call("PUT", f"/v1/records/{rid}", token,
                        {"idempotency_key": "loupe:e:hidden-draft", "change": "save",
                         "record": dict(REC, expected_version=1, body="소유 초안")})
    assert response.status == 202
    value = data(response)
    path = api.home / "spool" / "refs" / (value["write_ref"] + ".json")
    reservation = json.loads(path.read_text())
    reservation.update(state="purged")
    path.write_text(json.dumps(reservation))
    api.world.add(record(rid, "숨은 대상", "secret"))
    response = api.call("GET", f'/v1/writes/{value["write_ref"]}?include=body', token)
    problem(response, 404, "not_found")
    assert all(key not in data(response) for key in ("id", "version", "record", "payload_sha"))
