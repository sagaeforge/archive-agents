"""8/Q11: 휴지통은 마지막 편집자가 아니라 최초 created_app의 범위다."""
import pytest

from kb.core import ledger
from test_http_write import api, data, problem  # noqa: F401
from test_write_core import REC, core  # noqa: F401

TRASH = "/v1/nodes?origin=first_party&status=dead&types=Page,Note,TopicSpec,Review"


def delete_record(api, token, rid, version=1):
    response = api.call("POST", f"/v1/records/{rid}/tombstone", token,
                        {"idempotency_key": f"loupe:t:{rid}", "expected_version": version,
                         "change": "save", "reason": "합성 삭제"})
    assert response.status == 200, response.body


def ids(response):
    assert response.status == 200, response.body
    return [row["id"] for row in data(response)["data"]["items"]]


def test_trash_created_app_survives_other_app_last_write_and_token_rotation(api, terminal, capsys):
    from kb.cli import main
    from test_token_lifecycle import issue
    first = issue(capsys)
    other = api.token("other")
    mine = api.create(first)
    theirs = api.create(other, key="other:c:trash")
    assert mine.status == theirs.status == 201
    rid, other_id = data(mine)["id"], data(theirs)["id"]
    # Another editor can tombstone, but cannot take ownership of the trash row.
    delete_record(api, other, rid)
    delete_record(api, other, other_id)
    assert ids(api.call("GET", TRASH, first)) == [rid]
    assert ids(api.call("GET", TRASH, other)) == [other_id]
    assert main(["token", "rotate", "--label", "loupe"]) == 0
    rotated = capsys.readouterr().out.strip()
    assert ids(api.call("GET", TRASH, rotated)) == [rid]
    assert rid not in ids(api.call("GET", "/v1/nodes?origin=first_party", rotated))


from test_token_lifecycle import terminal  # noqa: E402,F401


@pytest.mark.parametrize("role", [None, "viewer", "owner"])
def test_trash_filter_requires_editor(api, role):
    token = None if role is None else api.token(role, role)
    problem(api.call("GET", TRASH, token), 403, "scope_denied")


@pytest.mark.parametrize("hidden", ["secret", "quarantine", "redacted"])
def test_trash_uses_last_put_visibility_not_tombstone_payload(api, hidden):
    token = api.token()
    first = api.create(token)
    assert first.status == 201
    rid = data(first)["id"]
    payload = dict(REC, id=rid, sensitivity="secret" if hidden == "secret" else "internal")
    if hidden == "quarantine":
        payload["props"] = {"quarantine": True}
    ledger.append(api.world.led, [{"kind": "record.put", "actor": "app:loupe", "origin": "first_party",
                                  "subject": rid, "idem_key": "fw4:hidden", "payload": payload},
                                 {"kind": "record.tombstone", "actor": "app:loupe", "origin": "first_party",
                                  "subject": rid, "idem_key": "fw4:dead", "payload": {"id": rid, "reason": "합성"}}])
    if hidden == "redacted":
        ledger.redact(api.world.led, rid, "합성 삭제", "user:sagae", "fw4:redact")
    response = api.call("GET", TRASH, token)
    assert ids(response) == []
    assert rid.encode() not in response.body
    assert data(response)["page"]["total"] in (None, 0)


def test_caller_cannot_widen_trash_created_app(api):
    token = api.token()
    response = api.call("GET", TRASH + "&created_app=app:other", token)
    problem(response, 400, "bad_param")
