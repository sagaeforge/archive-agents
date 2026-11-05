"""3.6: 네 타입 기본 private, 하향은 사람 검토를 요구한다."""
import pytest

from test_http_write import api, data, problem  # noqa: F401
from test_write_core import REC, core  # noqa: F401


@pytest.mark.parametrize("typ", ["Page", "Note", "TopicSpec", "Review"])
def test_all_editor_types_default_private(api, typ):
    record = {"type": typ, "title": "합성 제목", "body": "합성 본문"}
    if typ == "Review":
        record["props"] = {"target": "c-" + "a" * 12, "decision": "accept"}
    token = api.token()
    response = api.create(token, record=record)
    assert response.status == 201, response.body
    c = api.world.led
    events = ledger_events(c)
    stored = next(e["payload"] for e in events if e["subject"] == data(response)["id"])
    assert stored["sensitivity"] == "private"


def ledger_events(connection):
    from kb.core import ledger
    return ledger.iter_events(connection, 0, 10000)


@pytest.mark.parametrize("before,after", [("private", "internal"), ("private", "public"), ("internal", "public")])
def test_editor_cannot_downgrade_sensitivity(api, before, after):
    token = api.token()
    first = api.create(token, record=dict(REC, sensitivity=before))
    assert first.status == 201
    response = api.call("PUT", f'/v1/records/{data(first)["id"]}', token,
                        {"idempotency_key": "loupe:e:downgrade", "change": "save",
                         "record": dict(REC, sensitivity=after, expected_version=1)})
    problem(response, 403, "declassify_requires_review")


def test_private_open_stays_false_until_fw5(api):
    response = api.call("GET", "/v1/meta")
    assert response.status == 200
    assert data(response)["data"]["write"]["private_open"] is False
