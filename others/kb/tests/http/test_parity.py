"""같은 요청의 HTTP 본문 = `kb api` 출력(시각 필드 포함 바이트 일치)."""
import json

import pytest

from httphelp import Client, hdr
from kb import publish
from kb.cli import main
from kb.serve.http import ServeConfig, build_app, respond

TARGETS = [
    "/v1/meta", "/v1/schema", "/v1/overview", "/v1/nodes?types=Feature&sort=-label", "/v1/nodes/e:feature:history",
    "/v1/nodes/e:feature:history/claims", "/v1/nodes/e:feature:history/edges", "/v1/nodes/f-1/body",
    "/v1/nodes/e:product:p/neighbors?depth=2", "/v1/nodes/e:feature:history/history", "/v1/claims/c-1", "/v1/edges/r-01",
    "/v1/search?q=history", "/v1/facets", "/v1/facets?q=history", "/v1/counts?bucket=week", "/v1/series/s:rank",
    "/v1/snapshots/n-1", "/v1/snapshots/n-1/text", "/v1/changes", "/v1/export/graph/manifest",
    "/v1/ops/tickets", "/v1/ops/runs", "/v1/ops/metrics",
    # 오류도 같다
    "/v1/nodes?limit=999999", "/v1/nodes/e:nope:zzz", "/v1/nope", "/v1/meta?x=1",
]


@pytest.fixture
def published(world):
    publish.publish(force=True, db_path=world.path)


def test_http_equals_respond_bytes(world, client, published):
    cfg = ServeConfig(db_path=str(world.path))
    for t in TARGETS:
        h = client.get(t)
        r = respond(t, cfg=cfg)
        assert h.status == r.status, t
        assert h.body == r.body, t       # 시각 필드 포함 바이트 일치


def test_http_equals_kb_api_stdout(world, client, published, capsysbinary):
    for t in TARGETS:
        h = client.get(t)
        rc = main(["api", t, "--db", str(world.path)])
        out = capsysbinary.readouterr().out
        assert rc == (0 if h.status < 400 else 1), t
        assert out == h.body, t


def test_binary_parity_raw_and_export(world, client, published, capsysbinary):
    for t in ("/v1/snapshots/n-1/raw", "/v1/export/graph?profile=core", "/v1/export/graph?profile=full"):
        h = client.get(t)
        assert main(["api", t, "--db", str(world.path)]) == 0
        assert capsysbinary.readouterr().out == h.body, t


def test_api_scope_is_viewer(world, client, capsysbinary, cfgdir):
    (cfgdir / "decisions.toml").write_text("approved = [14]\n")
    assert main(["api", "/v1/nodes/f-priv", "--db", str(world.path)]) == 1
    assert json.loads(capsysbinary.readouterr().out)["code"] == "not_found"
