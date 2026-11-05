"""FW4 RED: 실제 ASGI 앱, 합성 토큰/원장. 소켓을 열지 않는다."""
import asyncio
import json
import sys
from pathlib import Path
from urllib.parse import unquote

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from read.rhelp import World  # noqa: E402
from kb.core import ledger  # noqa: E402
from kb.project import project_tail  # noqa: E402
from kb.serve import http as H  # noqa: E402
from kb.write import engine  # noqa: E402
from test_write_core import REC, core  # noqa: E402,F401


def header(response, name):
    return next((v for k, v in response.headers if k.lower() == name.lower()), None)


def data(response):
    return json.loads(response.body)


def problem(response, status, code):
    assert response.status == status, response.body
    assert data(response)["code"] == code
    assert header(response, "content-type").startswith("application/problem+json")
    return data(response)


class API:
    def __init__(self, home):
        self.home = home
        self.world = World(home, "fw4")
        self.app = H.build_app(H.ServeConfig(db_path=str(self.world.path)))

    def restart(self):
        self.app = H.build_app(H.ServeConfig(db_path=str(self.world.path)))

    def token(self, label="loupe", scope="editor"):
        return H.create_token(scope, label)

    def call(self, method, target, token=None, body=None, *, tcp=False):
        # core는 투영을 생략한다. 읽기 전에 실제 projector를 따라잡는다.
        project_tail(self.world.led, self.world.gold, None, 10 ** 6)
        path, _, query = target.partition("?")
        raw = body if isinstance(body, bytes) else (b"" if body is None else json.dumps(body, ensure_ascii=False).encode())
        headers = [(b"host", b"localhost"), (b"content-type", b"application/json"),
                   (b"content-length", str(len(raw)).encode())]
        if token is not None:
            headers.append((b"authorization", f"Bearer {token}".encode()))
        scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                 "method": method, "scheme": "http", "path": unquote(path),
                 "raw_path": path.encode(), "query_string": query.encode(), "headers": headers,
                 "server": ("127.0.0.1", 8737) if tcp else ("synthetic.sock", None),
                 "client": ("127.0.0.1", 1), "root_path": ""}
        sent = []

        async def invoke():
            delivered = False

            async def receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": raw, "more_body": False}
                return {"type": "http.disconnect"}

            async def send(message):
                sent.append(message)

            await self.app(scope, receive, send)

        asyncio.run(invoke())
        start = next(m for m in sent if m["type"] == "http.response.start")
        return H.Resp(start["status"], [(k.decode(), v.decode()) for k, v in start["headers"]],
                      b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body"))

    def create(self, token, key="loupe:c:fw4", record=None, **kw):
        return self.call("POST", "/v1/records", token,
                         {"idempotency_key": key, "change": "save", "record": dict(REC if record is None else record)}, **kw)


@pytest.fixture
def api(core):
    client = API(core)
    yield client
    client.world.close()


@pytest.mark.parametrize("tcp", [False, True])
def test_write_requires_bearer_on_both_transports(api, tcp):
    response = api.create(None, tcp=tcp)
    problem(response, 401, "token_required")
    assert header(response, "www-authenticate") == "Bearer"
    assert header(response, "cache-control") == "no-store"


def test_viewer_cannot_write(api):
    problem(api.create(api.token("viewer", "viewer")), 403, "scope_denied")


@pytest.mark.parametrize("method,path", [("POST", "/v1/records"), ("PUT", "/v1/records/f-missing")])
def test_bad_bearer_is_401_before_route_or_body(api, method, path):
    response = api.call(method, path, "synthetic-invalid-token", {})
    problem(response, 401, "token_invalid")
    assert header(response, "cache-control") == "no-store"


def test_create_edit_dry_run_and_errors_are_no_store(api):
    token = api.token()
    created = api.create(token)
    assert created.status == 201
    rid = data(created)["id"]
    updated = api.call("PUT", f"/v1/records/{rid}", token,
                       {"idempotency_key": "loupe:e:fw4:r1", "change": "save",
                        "record": dict(REC, body="수정", expected_version=1)})
    assert updated.status == 200
    dry = api.call("POST", "/v1/records?dry_run=1", token,
                   {"idempotency_key": "loupe:c:dry", "change": "save", "record": REC})
    assert dry.status == 200 and data(dry)["would_reject"] is False
    invalid = api.call("POST", "/v1/records", token, {})
    problem(invalid, 400, "schema_invalid")
    for response in (created, updated, dry, invalid):
        assert header(response, "cache-control") == "no-store"


def test_no_token_body_or_exception_text_echoed_to_logs(api, monkeypatch, capsys, caplog):
    token = api.token()
    marker = "FW4-SYNTHETIC-DRAFT-DO-NOT-LOG"
    exception_marker = "FW4-SYNTHETIC-EXCEPTION-DO-NOT-LOG"

    def fail(*args, **kwargs):
        raise RuntimeError(exception_marker)

    from kb.write import record
    monkeypatch.setattr(record, "put_record", fail)
    # ServerErrorMiddleware may rethrow after emitting the 500 response.
    try:
        response = api.create(token, record=dict(REC, body=marker))
    except RuntimeError:
        pass
    else:
        assert response.status == 500
    output = capsys.readouterr()
    logs = output.out + output.err + caplog.text
    assert all(value not in logs for value in (token, marker, exception_marker))


def test_request_limit_is_two_mib_independent_of_record_body_limit(api):
    token = api.token()
    raw = json.dumps({"idempotency_key": "loupe:c:request-size", "change": "save", "record": REC}).encode()
    # Valid JSON plus whitespace crosses the request cap while the record body stays tiny.
    raw += b" " * (2 * 1024 * 1024 + 1 - len(raw))
    problem(api.call("POST", "/v1/records", token, raw), 413, "body_too_large")
