"""FW5: raw/fp 큰 본문을 읽기·문단 검색에 투영한다. 합성 KB만 사용한다."""
import pytest

from test_http_write import api, data, problem  # noqa: F401
from test_write_core import REC, core  # noqa: F401
from read.rhelp import E
from kb.core import cas, ledger
from kb.project import create_gold
from kb.project.build import replay
from kb.project.fingerprint import fingerprint_conn
from kb.write import engine

REAL_PROJECT = engine._project
MARKER = "FW5BIGBODYNEEDLE"
BODY = "a" * (100 * 1024 - len(MARKER) - 4) + "\n\n" + MARKER + "\n\n"


def test_100_kib_page_body_search_and_replay(api):
    assert len(BODY.encode()) == 100 * 1024
    token = api.token()
    created = api.create(token, record=dict(REC, type="Page", body=BODY))
    assert created.status == 201, created.body
    rid = data(created)["id"]
    response = api.call("GET", f"/v1/nodes/{rid}/body?max_chars=200000", token)
    assert response.status == 200, response.body
    assert data(response)["data"]["text"] == BODY
    found = api.call("GET", f"/v1/search?q={MARKER}", token)
    assert found.status == 200 and rid.encode() in found.body
    stored = [e["payload"] for e in ledger.iter_events(api.world.led, 0, 1000)
              if e["kind"] == "record.put" and e["subject"] == rid][-1]
    assert "body" not in stored and cas.get(stored["body_sha"], "fp").decode() == BODY
    rebuilt = create_gold(api.home / "scratch" / "fw5-big-replay.db")
    try:
        _, missing, quarantined = replay(api.world.led, rebuilt)
        assert not missing and not quarantined
        assert fingerprint_conn(rebuilt) == fingerprint_conn(api.world.gold)
    finally:
        rebuilt.close()


@pytest.mark.parametrize("size", [100 * 1024, 210000])
def test_large_conflict_current_uses_cas_and_codepoint_cutoff(api, size):
    token = api.token()
    body = "가" * size
    created = api.create(token, record=dict(REC, type="Page", body=body))
    assert created.status == 201, created.body
    rid = data(created)["id"]
    response = api.call("PUT", f"/v1/records/{rid}", token,
                        {"idempotency_key": "loupe:e:fw5-conflict", "change": "save",
                         "record": dict(REC, type="Page", body="stale", expected_version=0)})
    current = problem(response, 409, "version_conflict")["current"]
    assert current["body"] == body[:200000]
    assert current["body_truncated"] is (size > 200000)


@pytest.mark.parametrize("damage", ["missing", "corrupt"])
def test_fp_cas_failure_is_unprojected_without_quarantine(api, monkeypatch, damage):
    sha = cas.put(BODY.encode(), "fp")
    obj = cas.path_of(sha, "fp")
    if damage == "missing":
        obj.unlink()  # 이 시험의 임시 KB_HOME에 방금 쓴 합성 객체만 지운다.
    else:
        obj.write_bytes(b"synthetic corrupt CAS")
    ledger.append(api.world.led, [E("record.put", dict(REC, id="f-fw5-broken", type="Page",
                                                      body_sha=sha, body=None),
                                     "f-fw5-broken", origin="first_party", actor="user:sagae")])
    monkeypatch.setattr(engine, "current_gold_path", lambda: api.world.path)
    projected, _ = REAL_PROJECT(api.world.led)
    assert projected is False
    assert api.world.gold.execute("SELECT COUNT(*) FROM quarantine").fetchone()[0] == 0
    assert not [e for e in ledger.iter_events(api.world.led, 0, 1000)
                if e["kind"] == "system.projection_quarantined"]


def test_secret_cas_body_never_enters_content_or_search(api):
    from read.rhelp import record
    sha = cas.put(BODY.encode(), "fp")
    api.world.add(record("f-fw5-secret", "FW5SECRET", "secret", body=None, body_sha=sha))
    assert api.world.gold.execute("SELECT body FROM content WHERE sha=?", (sha,)).fetchone() is None
    for token in (None, api.token()):
        response = api.call("GET", f"/v1/search?q={MARKER}", token)
        assert response.status == 200 and MARKER.encode() not in response.body
        problem(api.call("GET", "/v1/nodes/f-fw5-secret/body", token), 404, "not_found")
