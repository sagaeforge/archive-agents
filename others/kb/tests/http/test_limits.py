"""동시 처리 상한(계약 2.3 429)과 읽기 시간 상한."""
import asyncio
import json
import threading
import time

import pytest

from httphelp import asgi_call, hdr, write_config
from kb import read
from kb.serve.http import ServeConfig, build_app
from kb.serve.limits import ConfigError, check_max_concurrent


class Slow:
    """meta를 붙잡아 두고 몇 개가 들어왔는지 센다."""

    def __init__(self):
        self.release = threading.Event()
        self.entered = 0
        self.lock = threading.Lock()

    def __call__(self, con, ctx, **kw):
        with self.lock:
            self.entered += 1
        self.release.wait(10)
        return {"contract": "v1", "kb_version": "t", "limits": {"concurrent": 0}, "changes_cursor": "x", "first_party_open": False,
                "counts": {"nodes": 0, "edges": 0, "claims": 0}}


async def _burst(app, slow, n):
    tasks = [asyncio.create_task(asgi_call(app, "GET", "/v1/meta")) for _ in range(n)]
    for _ in range(200):
        if slow.entered >= n:
            break
        await asyncio.sleep(0.02)
    assert slow.entered == n, slow.entered
    extra = await asgi_call(app, "GET", "/v1/meta")
    slow.release.set()
    return extra, await asyncio.gather(*tasks)


def test_over_limit_429_with_retry_after(world, monkeypatch):
    slow = Slow()
    monkeypatch.setattr(read, "meta", slow)
    app = build_app(ServeConfig(db_path=str(world.path), max_concurrent=12))
    extra, done = asyncio.run(_burst(app, slow, 12))
    assert extra.status == 429 and hdr(extra, "content-type") == "application/problem+json"
    assert json.loads(extra.body)["code"] == "too_many_requests" and int(hdr(extra, "retry-after")) >= 1
    assert all(r.status == 200 for r in done)       # 처리 중이던 12개는 정상


def test_twelve_concurrent_no_429_with_default(world, monkeypatch):
    slow = Slow()
    monkeypatch.setattr(read, "meta", slow)
    app = build_app(ServeConfig(db_path=str(world.path)))     # 기본 16
    extra, done = asyncio.run(_burst(app, slow, 12))
    assert extra.status == 200 and all(r.status == 200 for r in done)


def test_limit_from_config_and_meta_reflects(world, cfgdir):
    write_config(cfgdir, "[read]\nmax_concurrent = 20\n")
    cfg = ServeConfig.load(world.path)
    assert cfg.max_concurrent == 20
    r = asyncio.run(asgi_call(build_app(cfg), "GET", "/v1/meta"))
    assert json.loads(r.body)["data"]["limits"]["concurrent"] == 20
    default = asyncio.run(asgi_call(build_app(ServeConfig(db_path=str(world.path))), "GET", "/v1/meta"))
    assert json.loads(default.body)["data"]["limits"]["concurrent"] == 16


@pytest.mark.parametrize("n", [0, 1, 11, -3])
def test_below_12_fails_startup(world, cfgdir, n, capsys):
    with pytest.raises(ConfigError):
        check_max_concurrent(n)
    with pytest.raises(ConfigError):
        build_app(ServeConfig(db_path=str(world.path), max_concurrent=n))
    write_config(cfgdir, f"[read]\nmax_concurrent = {n}\n")
    with pytest.raises(ConfigError):
        ServeConfig.load(world.path)
    from kb.cli import main
    assert main(["serve", "--http", "--unix", str(cfgdir / "s.sock")]) == 2     # 소켓을 열기 전에 실패
    assert not (cfgdir / "s.sock").exists()
    assert "max_concurrent" in capsys.readouterr().err


def test_read_timeout_503_with_retry_after(world, monkeypatch):
    cfg = ServeConfig(db_path=str(world.path), deadline_s=0.05)

    def spin(con, ctx, **kw):
        end = time.monotonic() + 3
        while time.monotonic() < end:     # 진행 핸들러가 중단하는 긴 질의
            con.execute("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<2000000) SELECT count(*) FROM c").fetchall()
        return {}
    monkeypatch.setattr(read, "meta", spin)
    t0 = time.monotonic()
    r = asyncio.run(asgi_call(build_app(cfg), "GET", "/v1/meta"))
    assert r.status == 503 and json.loads(r.body)["code"] == "read_timeout" and hdr(r, "retry-after")
    assert time.monotonic() - t0 < 2.5
