"""FW4 editor/reviewer parity; FW5 파생물/큰 본문 구현은 여기서 요구하지 않는다."""
import pytest

from test_http_write import api, data, problem  # noqa: F401
from read.rhelp import E, T0, record
from test_write_core import core  # noqa: F401

ROUTES = ["/v1/nodes/f-private?include=body,backlinks,edges",
          "/v1/nodes/f-private/body", "/v1/nodes/f-private/history",
          "/v1/nodes/f-private/body?as_of_observed=2027-01-15T08:00:01Z",
          "/v1/nodes/f-private?as_of_observed=2027-01-15T08:00:01Z",
          "/v1/nodes/f-private/edges", "/v1/nodes/f-private/neighbors",
          "/v1/nodes?origin=first_party", "/v1/search?q=FW4PRIVATE",
          "/v1/changes?origin=first_party"]


@pytest.fixture
def private_api(api):
    api.world.add(record("f-private", "FW4PRIVATE", "private", body="FW4PRIVATE body", at=T0),
                  record("f-secret", "FW4SECRET", "secret", body="FW4SECRET body", at=T0),
                  record("f-neighbor", "FW4NEIGHBOR", "private", at=T0),
                  E("edge.put", {"id": "r-private", "src": "f-private", "dst": "f-neighbor",
                                 "rtype": "LINKS_TO"}, at=T0))
    return api


@pytest.mark.parametrize("tcp", [False, True])
@pytest.mark.parametrize("route", ROUTES)
def test_editor_reviewer_private_route_parity(private_api, route, tcp):
    api = private_api
    editor, reviewer = api.token(), api.token("loupe-review", "reviewer")
    left = api.call("GET", route, editor, tcp=tcp)
    right = api.call("GET", route, reviewer, tcp=tcp)
    assert left.status == right.status == 200, (left.body, right.body)
    assert data(left)["data"] == data(right)["data"]
    # Equality alone could pass if both roles silently received empty results.
    assert any(marker in left.body for marker in (b"f-private", b"FW4PRIVATE", b"r-private", b"f-neighbor")), route
    assert b"FW4SECRET" not in left.body and b"f-secret" not in left.body


@pytest.mark.parametrize("role", [None, "viewer", "owner"])
def test_ordinary_http_cannot_read_private(private_api, role):
    api = private_api
    token = None if role is None else api.token(role, role)
    for route in ROUTES:
        response = api.call("GET", route, token)
        if route.startswith("/v1/nodes/f-private"):
            problem(response, 404, "not_found")
        else:
            assert response.status == 200
        assert all(value not in response.body for value in (b"f-private", b"FW4PRIVATE", b"r-private"))


def test_mcp_read_context_never_inherits_editor_private_scope(private_api):
    from kb import read
    from kb.read import ReadCtx, NotFound, reading
    ctx = ReadCtx(db_path=str(private_api.world.path))
    assert ctx.max_sens == 1
    with reading(ctx) as con, pytest.raises(NotFound):
        read.get_node(con, ctx, "f-private")


def test_bad_socket_read_bearer_does_not_fall_back_to_anonymous(private_api):
    problem(private_api.call("GET", "/v1/meta", "synthetic-bad"), 401, "token_invalid")


def test_private_conflict_current_matches_reviewer_body_visibility(api):
    token = api.token()
    reviewer = api.token("loupe-review", "reviewer")
    from test_write_core import REC
    first = api.create(token, record=dict(REC, sensitivity="private"))
    assert first.status == 201
    rid = data(first)["id"]
    response = api.call("PUT", f"/v1/records/{rid}", token,
                        {"idempotency_key": "loupe:e:stale-private", "change": "save",
                         "record": dict(REC, sensitivity="private", expected_version=0)})
    current = problem(response, 409, "version_conflict")["current"]
    assert current["body"] == REC["body"] and current["title"] == REC["title"]
    body = api.call("GET", f"/v1/nodes/{rid}/body", reviewer)
    assert body.status == 200 and REC["body"].encode() in body.body
