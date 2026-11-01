"""읽기가 쓰기를 막지 않는다: 5초 읽기 동안 쓰기 p99 150 ms 이하, 읽기 시간 상한, 체크포인트 RESTART 없음."""
import asyncio
import json
import re
import threading
import time
from pathlib import Path

from httphelp import asgi_call, entity, hdr
from kb import read
from kb.serve.http import ServeConfig, build_app

SRC = Path(__file__).resolve().parents[2] / "src/kb"


def test_no_checkpoint_restart_in_serving_or_publish_code():
    for d in ("serve", "publish", "commands/serve.py", "commands/api.py", "commands/publish.py", "commands/token.py"):
        p = SRC / d
        files = list(p.rglob("*.py")) if p.is_dir() else [p]
        for f in files:
            text = f.read_text(encoding="utf-8")
            assert not re.search(r"wal_checkpoint|RESTART|VACUUM\s+INTO|\bvacuum\b", text, re.I), f
            assert "connect_rw" not in text, f"{f}: 읽기 서비스는 쓰기 연결을 열지 않는다"


def test_write_p99_under_150ms_during_5s_reads(world, monkeypatch):
    hold = threading.Event()
    started = threading.Semaphore(0)

    def long_read(con, ctx, **kw):
        con.execute("SELECT count(*) FROM node").fetchone()       # 읽기 트랜잭션이 열린 채 5초 붙잡는다
        started.release()
        hold.wait(5.0)
        return {"contract": "v1", "kb_version": "t", "limits": {"concurrent": 16}, "changes_cursor": "x",
                "first_party_open": False, "counts": {"nodes": 0, "edges": 0, "claims": 0}}
    monkeypatch.setattr(read, "meta", long_read)
    app = build_app(ServeConfig(db_path=str(world.path)))
    res = []

    def reader():
        res.append(asyncio.run(asgi_call(app, "GET", "/v1/meta")))
    ths = [threading.Thread(target=reader) for _ in range(4)]
    for t in ths:
        t.start()
    for _ in range(4):
        assert started.acquire(timeout=5)
    lat, end, i = [], time.monotonic() + 5.0, 0
    while time.monotonic() < end:
        t0 = time.perf_counter()
        world.add(entity(f"e:tool:w{i}", f"W{i}"))
        lat.append(time.perf_counter() - t0)
        i += 1
        time.sleep(0.02)
    hold.set()
    for t in ths:
        t.join(10)
    lat.sort()
    p99 = lat[min(len(lat) - 1, int(len(lat) * 0.99))]
    assert len(lat) >= 50 and p99 <= 0.150, (len(lat), p99)
    assert all(r.status == 200 for r in res)


def test_read_timeout_503_and_server_stays_healthy(world, monkeypatch):
    cfg = ServeConfig(db_path=str(world.path), deadline_s=0.05)
    real = read.meta

    def spin(con, ctx, **kw):
        while True:
            con.execute("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<5000000) SELECT count(*) FROM c").fetchall()
    monkeypatch.setattr(read, "meta", spin)
    app = build_app(cfg)
    r = asyncio.run(asgi_call(app, "GET", "/v1/meta"))
    assert r.status == 503 and json.loads(r.body)["code"] == "read_timeout" and hdr(r, "retry-after")
    monkeypatch.setattr(read, "meta", real)
    assert asyncio.run(asgi_call(app, "GET", "/v1/meta")).status == 200      # 다음 요청은 정상


def test_publish_does_not_block_writes(world):
    from kb import publish
    world.add(*[entity(f"e:tool:b{i}", f"B{i}") for i in range(300)])
    done = threading.Event()
    th = threading.Thread(target=lambda: (publish.publish(db_path=world.path, force=True), done.set()))
    th.start()
    lat = []
    while not done.is_set():
        t0 = time.perf_counter()
        world.add(entity(f"e:tool:pw{len(lat)}", "PW"))
        lat.append(time.perf_counter() - t0)
        time.sleep(0.01)
    th.join()
    assert max(lat or [0]) < 1.0
