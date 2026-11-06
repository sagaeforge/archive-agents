"""Host, CORS, 토큰, 민감도, 메서드, 오류 형식(계약 7장, 2.3, 2.8)."""
import json
import os
import stat

import pytest

from httphelp import Client, hdr, write_config
from kb import read
from kb.serve import http as H
from kb.serve.http import ServeConfig, build_app, create_token

PROBLEM = "application/problem+json"


def test_wrong_host_403_problem(client):
    for host in ("evil.example", "127.0.0.1.evil.example", "localhost.evil:80"):
        r = client.get("/v1/meta", {"Host": host})
        assert r.status == 403 and hdr(r, "content-type") == PROBLEM, host
        assert json.loads(r.body)["code"] == "host_rejected"
    for host in ("localhost", "127.0.0.1:8737", "LOCALHOST"):
        assert client.get("/v1/meta", {"Host": host}).status == 200, host


def test_allowed_hosts_from_config(world, cfgdir):
    write_config(cfgdir, '[read]\nallowed_hosts = ["kb.internal.example", "[::1]"]\n')
    c = Client(build_app(ServeConfig.load(world.path)))
    assert c.get("/v1/meta", {"Host": "kb.internal.example:9"}).status == 200
    assert c.get("/v1/meta", {"Host": "[::1]:8737"}).status == 200
    r = c.get("/v1/meta", {"Host": "localhost"})
    assert r.status == 403 and json.loads(r.body)["code"] == "host_rejected"


def test_no_cors_headers(client):
    r = client.get("/v1/meta", {"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert r.status == 200 and not [k for k, _ in r.headers if k.lower().startswith("access-control-")]
    o = client.get("/v1/meta", {"Origin": "https://evil.example"}, method="OPTIONS")
    assert o.status == 405 and not [k for k, _ in o.headers if k.lower().startswith("access-control-")]


def test_tcp_requires_bearer(tcp_client, client):
    r = tcp_client.get("/v1/meta")
    assert r.status == 401 and json.loads(r.body)["code"] == "token_required" and hdr(r, "content-type") == PROBLEM
    assert hdr(r, "www-authenticate") == "Bearer"
    bad = tcp_client.get("/v1/meta", {"Authorization": "Bearer nope"})
    assert bad.status == 401 and json.loads(bad.body)["code"] == "token_invalid"
    assert tcp_client.get("/v1/meta", {"Authorization": "Basic abc"}).status == 401
    # 존재하지 않는 경로도 인증 뒤에 판단된다
    assert tcp_client.get("/v1/nope").status == 401
    tok = create_token("viewer", "t")
    ok = tcp_client.get("/v1/meta", {"Authorization": f"Bearer {tok}"})
    assert ok.status == 200
    assert client.get("/v1/meta").status == 200          # Unix 소켓은 토큰 없이 200


def test_token_file_mode_and_only_hash_stored(cfgdir):
    tok = create_token("owner", "x")
    p = H.tokens_path()
    assert stat.S_IMODE(os.stat(p).st_mode) == 0o600
    text = p.read_text()
    assert tok not in text and "owner" in text
    assert H.token_scope(tok) == "owner" and H.token_scope(tok + "x") is None
    with pytest.raises(ValueError):
        create_token("admin")


def test_kb_token_create_cli(cfgdir, capsys):
    from kb.cli import main
    assert main(["token", "create", "--scope", "viewer", "--label", "loupe"]) == 0
    out = capsys.readouterr().out.strip()
    assert out.startswith("kbt_v_") and H.token_scope(out) == "viewer"
    assert stat.S_IMODE(os.stat(H.tokens_path()).st_mode) == 0o600


def test_secret_never_over_http_and_private_gated(world, tcp_client, client, cfgdir):
    owner = create_token("owner")
    viewer = create_token("viewer")
    A = lambda t: {"Authorization": f"Bearer {t}"}                      # noqa: E731
    probe = ["/v1/nodes/f-sec", "/v1/nodes/f-sec/body", "/v1/nodes?types=Note", "/v1/search?q=SECRET-BODY-XYZ",
             "/v1/search?q=%EB%B9%84%EB%B0%80", "/v1/changes", "/v1/overview", "/v1/facets", "/v1/nodes?ids=f-sec,f-priv"]
    for who in (None, viewer, owner):
        for t in probe:
            r = (client if who is None else tcp_client).get(t, A(who) if who else None)
            assert b"SECRET-BODY-XYZ" not in r.body and b'"f-sec"' not in r.body, (who, t)
    # ADR-0005: 인증된 editor 소켓은 private를 읽고, viewer·무토큰은 못 읽는다.
    editor = create_token("editor", "private-reader")
    assert client.get("/v1/nodes/f-priv", A(editor)).status == 200
    assert client.get("/v1/nodes/f-priv", A(viewer)).status == 404
    assert client.get("/v1/nodes/f-priv").status == 404
    for who in (viewer, owner):
        for t in probe:
            r = tcp_client.get(t, A(who))
            assert b"SECRET-BODY-XYZ" not in r.body and b'"f-sec"' not in r.body


@pytest.mark.parametrize("m", ["POST", "PUT", "DELETE", "PATCH"])
def test_write_methods_405_problem(client, m):
    r = client.get("/v1/nodes", method=m)
    assert r.status == 405 and hdr(r, "content-type") == PROBLEM
    assert json.loads(r.body)["code"] == "method_not_allowed" and "GET" in hdr(r, "allow")
    assert client.get("/v1/commands", method="POST").status == 404       # POST /v1/commands는 없다


def test_head_ok_and_404_problem(client):
    assert client.get("/v1/meta", method="HEAD").status == 200
    r = client.get("/v1/no-such-path")
    assert r.status == 404 and hdr(r, "content-type") == PROBLEM and json.loads(r.body)["code"] == "not_found"
    assert client.get("/v1/meta/").status == 404       # 슬래시 리다이렉트 없음


def test_exception_500_problem(client, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("내부 비밀 경로 /home/x")
    monkeypatch.setattr(read, "meta", boom)
    r = client.get("/v1/meta")
    p = json.loads(r.body)
    assert r.status == 500 and hdr(r, "content-type") == PROBLEM and p["code"] == "internal"
    assert "/home/x" not in r.body.decode()


def test_unhandled_error_in_endpoint_goes_to_exception_handler(world, monkeypatch):
    """execute 밖에서 터져도 예외 핸들러가 problem+json 500을 낸다."""
    app = build_app(ServeConfig(db_path=str(world.path)))

    def boom(*a, **k):
        raise RuntimeError("x")
    monkeypatch.setattr(H, "execute", boom)
    r = Client(app).get("/v1/meta")
    assert r.status == 500 and hdr(r, "content-type") == PROBLEM


def test_raw_headers(client):
    r = client.get("/v1/snapshots/n-1/raw")
    assert r.status == 200
    assert hdr(r, "content-disposition") == 'attachment; filename="n-1"'
    assert hdr(r, "x-content-type-options") == "nosniff"
    assert hdr(r, "content-type") == "text/plain"       # 원 Content-Type 유지
    assert hdr(r, "cache-control") == "no-store"
