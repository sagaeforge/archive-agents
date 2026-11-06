"""Schemathesis 4.32.7: fixture를 재생한 임시 서버(실제 `kb serve --http`, 루프백 TCP + Bearer)를 openapi.yaml로 시험한다.

26개 경로 전부에 요청을 만들어 응답을 스키마로 검증한다. 건너뛰는 경로가 없는지도 본다.
"""
import os
import socket
import subprocess
import sys
import time
import urllib.request

import pytest
import schemathesis
from schemathesis.checks import not_a_server_error
from schemathesis.specs.openapi.checks import (content_type_conformance, response_headers_conformance, response_schema_conformance,
                                               status_code_conformance)
from hypothesis import HealthCheck, settings

import cfx_run as R

SPEC = R.REPO / "docs" / "contracts" / "openapi.yaml"
# 응답이 계약과 어긋나는지만 본다: 서버 오류 없음, 선언된 상태 코드, 선언된 Content-Type, 선언된 헤더, 본문 스키마.
# 기본 검사 중 positive_data_acceptance(ST202)와 negative_data_rejection(ST201)은 뺐다. 이 둘은 요청 스키마가 서버 검증보다
# 느슨하거나 서버가 잘못된 값을 무시하는 틈을 잡는다. 틈은 tests/contract/README.md에 적었다.
CHECKS = (not_a_server_error, status_code_conformance, content_type_conformance, response_headers_conformance, response_schema_conformance)


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


@pytest.fixture(scope="module")
def server(replayed_session, session_home, request):
    from kb.serve.http import create_token
    token = create_token("viewer", "contract")
    port = _free_port()
    env = dict(os.environ, KB_HOME=str(session_home), KB_CONFIG_DIR=str(session_home / "config"))
    env.pop("KB_SHARE", None)
    from pathlib import Path
    from tempfile import TemporaryDirectory
    socket_dir = TemporaryDirectory(prefix="kbs-", dir="/run/user/1000")
    request.addfinalizer(socket_dir.cleanup)
    sock = Path(socket_dir.name) / "read.sock"
    p = subprocess.Popen([sys.executable, "-m", "kb", "serve", "--http", "--unix", str(sock), "--tcp", f"127.0.0.1:{port}",
                          "--db", str(replayed_session.path), "--idle-s", "3600"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    base = f"http://127.0.0.1:{port}"
    ok = False
    for _ in range(100):
        if p.poll() is not None:
            break
        try:
            rq = urllib.request.Request(base + "/v1/meta", headers={"Authorization": f"Bearer {token}"})
            with urllib.request.urlopen(rq, timeout=2) as r:
                ok = r.status == 200
            break
        except Exception:
            time.sleep(0.1)
    if not ok:
        p.kill()
        raise RuntimeError("임시 서버가 뜨지 않았다: " + (p.stderr.read().decode()[:500] if p.stderr else ""))
    yield {"base": base, "token": token}
    p.terminate()
    try:
        p.wait(10)
    except subprocess.TimeoutExpired:
        p.kill()


@pytest.fixture(scope="module")
def api_schema(server):
    schema = schemathesis.openapi.from_path(SPEC)
    schema.config.update(base_url=server["base"])
    return schema


schema = schemathesis.pytest.from_fixture("api_schema")
SEEN: set = set()


@schema.parametrize()
@settings(max_examples=25, deadline=None, derandomize=True, suppress_health_check=list(HealthCheck))
def test_responses_conform_to_contract(case, server):
    if case.method.upper() == case.operation.method.upper(): SEEN.add(f"{case.method} {case.operation.path}")
    kw = {"headers": {"Authorization": f"Bearer {server['token']}"}}
    case.call_and_validate(checks=CHECKS, **kw)


def test_all_contract_operations_were_exercised():
    """위 시험이 같은 프로세스에서 먼저 돌았을 때만 의미가 있다(파일 순서). 단독 실행이면 건너뛴다."""
    if not SEEN:
        pytest.skip("앞 시험이 돌지 않았다")
    operations = {f"{method.upper()} {path}" for path, item in __import__("yaml").safe_load(SPEC.read_text(encoding="utf-8"))["paths"].items() for method in item if method in ("get", "post", "put", "patch", "delete", "head", "options", "trace")}
    assert SEEN == operations, {"missing": sorted(operations - SEEN), "unexpected": sorted(SEEN - operations)}
