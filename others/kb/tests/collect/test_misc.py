"""tick 보조 동작: 경로 오류, 디스크 중지, --batch, ops.db 유실, 내부 작업, DLQ, 재사용."""
import json
import os

import pytest

from kb.collect import tick as T
from kb.collect.state import State
from kb.core import opsdb, paths

from .conftest import events, mk_source

DAY = 86400


@pytest.fixture
def two(world, set_registry):
    for h in ("a.example", "b.example"):
        world.add(h, "/robots.txt", 404)
        world.add(h, "/doc", 200, f"{h} doc".encode(), headers={"Content-Type": "text/plain", "ETag": f'"{h}"'})
    set_registry([mk_source("src:a", "https://a.example/doc"), mk_source("src:b", "https://b.example/doc")])
    return world


def test_path_error_stops_whole_tick(two, monkeypatch):
    def bad(p):
        raise OSError("tmpfs 거부")
    monkeypatch.setattr(paths, "check_fs", bad)
    rep, rc = T.run_tick()
    assert rc == 3 and rep["error"] == "E_PATH" and two.net_count() == 0


def test_low_disk_pauses_collection_keeps_other_stages(two, monkeypatch):
    monkeypatch.setattr(T, "MIN_FREE_BYTES", 1 << 60)
    rep, rc = T.run_tick()
    assert rep["collect_paused"] is True and rep["stages"]["fetch"] == "ok" and two.net_count() == 0
    assert rep["stages"]["recover"] in ("ok", "absent") and any("디스크" in w for w in rep["warnings"])


def test_batch_runs_listed_sources_in_order(two, tmp_path, capsys):
    from kb.cli import main
    f = tmp_path / "b.yaml"
    f.write_text("sources:\n  - src:b\n  - src:a\n")
    assert main(["tick", "--batch", str(f), "--json"]) in (0, 1)
    out = json.loads(capsys.readouterr().out)
    assert out["sources"] == 2
    order = [r["host"] for r in two.requests if r["path"] == "/doc"]
    assert order == ["b.example", "a.example"]


def test_only_runs_one_source(two):
    rep, _ = T.run_tick(only="src:a")
    assert rep["sources"] == 1 and two.count("b.example") == 0


def test_losing_ops_db_just_makes_everything_due(two, clk):
    T.run_tick()
    assert len(events("snapshot.captured")) == 2
    ops = paths.ops_dir() / "ops.db"
    for suf in ("", "-wal", "-shm"):
        try:
            os.unlink(str(ops) + suf)
        except FileNotFoundError:
            pass
    rep, _ = T.run_tick()
    assert rep["sources"] == 2
    assert len(events("snapshot.captured")) == 2            # 같은 (raw_sha, url)은 같은 스냅샷이다


def test_second_tick_not_due_no_requests(two):
    T.run_tick()
    n = two.net_count()
    rep, _ = T.run_tick()
    assert rep["sources"] == 0 and two.net_count() == n


def test_internal_job_prunes_fetch_log_after_30_days(two, clk, env, repo):
    (env.share / "sources" / "internal.d" / "collect.yaml").write_text((repo / "sources/internal.d/collect.yaml").read_text())
    T.run_tick()
    with State() as st:
        st.c.execute("UPDATE fetch_log SET at=at-?", (31 * DAY * 1000,))
        assert st.c.execute("SELECT count(*) FROM fetch_log").fetchone()[0] > 0
    clk.advance(2 * DAY)
    T.run_tick()
    with State() as st:
        assert st.c.execute("SELECT count(*) FROM fetch_log WHERE at<?", (clk.now_ms() - 30 * DAY * 1000,)).fetchone()[0] == 0


def test_dlq_list_and_retry(world, set_registry, capsys):
    from kb.cli import main
    world.add("x.example", "/robots.txt", 404)
    world.add("x.example", "/f", 200, b"<html/>", headers={"Content-Type": "text/html"})
    s = mk_source("src:x", "https://x.example/f")
    s["expect"] = {"content_type": "text/plain"}
    set_registry([s])
    T.run_tick()
    assert main(["dlq", "list", "--json"]) == 0
    items = json.loads(capsys.readouterr().out)["items"]
    assert len(items) == 1 and items[0]["kind"] == "broken_source" and items[0]["attempts"] == 1
    assert items[0]["next_at"] is not None
    assert main(["dlq", "retry", "--json"]) == 1            # 여전히 형식 불일치
    capsys.readouterr()
    world.add("x.example", "/f", 200, b"now text", headers={"Content-Type": "text/plain"})
    assert main(["dlq", "retry", "--json"]) == 0
    capsys.readouterr()
    assert main(["dlq", "list", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["count"] == 0


def test_dlq_moves_to_human_queue_after_three_attempts(env):
    with State() as st:
        for _ in range(4):
            st.dlq_put("x", "ref", "fetch", "e")
        assert st.dlq_list("x")[0]["next_at"] is None and st.dlq_list("x")[0]["attempts"] == 4


def test_reuse_within_window_makes_no_request(world, set_registry):
    from kb.collect import capture
    world.add("a.example", "/robots.txt", 404)
    world.add("a.example", "/x", 200, b"hi", headers={"Content-Type": "text/plain"})
    set_registry([])
    r1 = capture("src:adhoc", "https://a.example/x")
    n = world.net_count()
    r2 = capture("src:adhoc", "https://a.example/x", reuse_s=86400)
    assert r2.outcome == "reused" and r2.snapshot == r1.snapshot and world.net_count() == n


def test_adhoc_conditional_off_gives_200_each_time(world, set_registry, capsys):
    from kb.cli import main
    world.add("a.example", "/robots.txt", 404)
    world.add("a.example", "/x", 200, b"hi", headers={"Content-Type": "text/plain", "ETag": '"z"'})
    set_registry([])
    for _ in range(2):
        assert main(["fetch", "https://a.example/x", "--json"]) == 0
        out = json.loads(capsys.readouterr().out)
        assert out["status"] == 200 and out["snapshot"]
    assert len(events("snapshot.captured")) == 1            # 같은 내용은 같은 스냅샷
