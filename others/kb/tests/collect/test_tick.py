"""tick 틀: 겹침, 단계 격리, SIGKILL 복구, 슬롯 밀림과 gap, 단계 자동 탐색, applied_seq > head, last_tick_at."""
import fcntl
import importlib
import importlib.util
import json
import os
import signal
import sqlite3
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from kb.collect import tick as T
from kb.collect.state import State
from kb.core import ledger, opsdb, paths

from .conftest import events, mk_source

H = 3600
HERE = Path(__file__).parent


def tick(**kw):
    return T.run_tick(**kw)


@pytest.fixture
def one(world, set_registry):
    world.add("t.example", "/robots.txt", 404)
    world.add("t.example", "/doc", 200, b"v1", headers={"Content-Type": "text/plain", "ETag": '"1"'})
    set_registry([mk_source("src:t", "https://t.example/doc", cls="rel")])
    return world


def test_overlapping_tick_exits_immediately(one):
    os.makedirs(paths.ops_dir(), exist_ok=True)
    fd = os.open(paths.ops_dir() / "tick.lock", os.O_CREAT | os.O_RDWR)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        rep, rc = tick()
    finally:
        os.close(fd)
    assert rc == 0 and rep["skipped"] == "locked" and one.net_count() == 0
    rep, rc = tick()
    assert "skipped" not in rep and one.count("t.example", "/doc") == 1


def test_last_tick_at_recorded(one, clk):
    t0 = clk.now_ms()
    rep, rc = tick()
    assert rep["at"] == t0
    assert opsdb.tick_state_get("last_tick_at") == str(rep["at"])
    assert opsdb.tick_state_get("lock_pid") == ""


def test_json_schema_fields(one):
    import jsonschema
    schema = json.loads((HERE.parents[1] / "schemas/cli/tick.schema.json").read_text())
    rep, _ = tick()
    jsonschema.validate(rep, schema)
    assert rep["sources"] == 1 and rep["stages"]["fetch"] == "ok"


def test_stage_failure_does_not_block_next_and_autodiscovery(one, monkeypatch, tmp_path):
    import kb
    pkg = tmp_path / "zz_fake"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    (pkg / "tick_stage.py").write_text(textwrap.dedent("""
        from dataclasses import dataclass, field
        CALLS = []
        def boom(ctx):
            raise RuntimeError("단계 폭발")
        def after(ctx):
            CALLS.append("after")
            return type("R", (), {"ok": True, "detail": {"parsed": 4}, "errors": []})()
        def notok(ctx):
            return type("R", (), {"ok": False, "detail": {}, "errors": ["일부 실패"]})()
        STAGES = [(3.5, "zz_boom", boom), (3.6, "zz_notok", notok), (3.7, "zz_after", after)]
    """))
    pkg2 = tmp_path / "zz_broken"
    pkg2.mkdir()
    (pkg2 / "__init__.py").write_text("")
    (pkg2 / "tick_stage.py").write_text("import not_a_real_module_xyz\nSTAGES=[]\n")
    monkeypatch.setattr(kb, "__path__", list(kb.__path__) + [str(tmp_path)])
    importlib.invalidate_caches()
    rep, rc = tick()
    st = rep["stages"]
    assert st["fetch"] == "ok" and st["zz_boom"] == "failed" and st["zz_notok"] == "failed" and st["zz_after"] == "ok"
    assert st["kb.zz_broken.tick_stage"] == "failed"
    assert rep["parsed"] == 4 + 1 and rc == 1                   # 가짜 단계 4건 + 4단계 parse가 이 시험의 스냅샷 1건
    assert one.count("t.example", "/doc") == 1                  # 앞 단계 실패와 무관하게 수집은 끝났다
    for n, name, mod in T.EXPECTED:
        if name in ("fetch", "live"):                           # live는 conftest가 뺀다
            continue
        try:
            present = importlib.util.find_spec(mod) is not None
        except ModuleNotFoundError:
            present = False
        assert (st[name] == "absent") == (not present), (name, st[name])
    sys.modules.pop("kb.zz_fake.tick_stage", None)


def test_72_slots_late_one_fetch_one_gap(world, set_registry, clk):
    world.add("g.example", "/robots.txt", 404)
    n = {"v": 0}

    def doc(headers):
        from .fakenet import Resp
        n["v"] += 1
        return Resp(200, f"short window {n['v']}".encode(), {"Content-Type": "text/plain"})

    world.route_fn("g.example", "/win", doc)
    set_registry([mk_source("src:g", "https://g.example/win", cls="short")])
    rep, _ = tick()
    assert rep["sources"] == 1 and n["v"] == 1 and rep["gaps"] == 0
    with State() as st:
        due = st.get("src:g")["next_check_at"]
    clk.advance(72 * 12 * H)                                  # 12시간 슬롯 72개를 놓쳤다
    rep, _ = tick()
    assert n["v"] == 2                                        # 놓친 슬롯만큼 돌리지 않는다
    gaps = events("gap.recorded")
    assert len(gaps) == 1 and rep["gaps"] == 1
    p = gaps[0]["payload"]
    assert p["source"] == "src:g" and p["from_at"] == due and p["to_at"] >= due + 71 * 12 * H * 1000
    rep, _ = tick()                                           # 제때 돌면 gap이 없다
    assert len(events("gap.recorded")) == 1 and n["v"] == 2


def test_retroactive_class_has_no_gap(one, clk):
    tick()
    clk.advance(72 * H)
    tick()
    assert events("gap.recorded") == []


def test_applied_seq_ahead_of_head_rebuilds_and_new_write_projects(one, clk, env):
    from kb.project import current_gold_path, open_gold
    from kb.project.db import meta_get
    from kb.write import commit

    def ev(i):
        return {"kind": "snapshot.captured", "actor": "collector", "origin": "external", "idem_key": f"snapshot:n-t{i}",
                "subject": f"n-t{i}", "payload": {"id": f"n-t{i}", "document_id": f"d-t{i}", "source": "src:t",
                                                   "url": f"https://t.example/{i}", "raw_sha": "a" * 64, "fetched_at": 1}}

    commit([ev(1)])
    backup = paths.ledger_dir() / "ledger.backup.db"
    src = sqlite3.connect(ledger.ledger_path())
    dst = sqlite3.connect(backup)
    src.backup(dst)
    dst.close()
    src.close()
    commit([ev(2), ev(3)])
    c = ledger.open_ledger()
    head_before = ledger.head(c)[0]
    c.close()
    lp = ledger.ledger_path()
    for suf in ("", "-wal", "-shm"):
        try:
            os.unlink(str(lp) + suf)
        except FileNotFoundError:
            pass
    os.replace(backup, lp)                                    # 원장만 되돌렸다
    c = ledger.open_ledger()
    head = ledger.head(c)[0]
    c.close()
    g = open_gold(current_gold_path())
    applied = int(meta_get(g, "applied_seq"))
    g.close()
    assert head < head_before and applied > head              # 전제: 앞선 gold
    rep, _ = tick()
    assert rep["rebuilt"] is True and any("앞섬" in w for w in rep["warnings"])
    g = open_gold(current_gold_path())
    try:
        c = ledger.open_ledger()
        new_head = ledger.head(c)[0]            # 1단계 recover가 스키마 이벤트를 더했을 수 있다
        c.close()
        assert int(meta_get(g, "applied_seq")) == new_head
        assert g.execute("SELECT count(*) FROM node WHERE id='n-t2'").fetchone()[0] == 0   # 되돌려진 쓰기는 gold에 없다
    finally:
        g.close()
    commit([ev(9)])                                           # 새 쓰기가 gold에 반영된다
    g = open_gold(current_gold_path())
    try:
        assert g.execute("SELECT count(*) FROM node WHERE id='n-t9'").fetchone()[0] >= 1
    finally:
        g.close()
    rep, _ = tick()
    assert rep["rebuilt"] is False


KILLS = ["fetch:2", "after_cas:1", "before_commit:1", "after_commit:1", "fetch:1", "before_commit:1"]


def test_sigkill_anywhere_next_tick_resumes(world, set_registry, env, clk, monkeypatch):
    from kb.collect import hostpolicy
    monkeypatch.setattr(hostpolicy, "DEFAULT_INTERVAL_S", 0.0)
    pages = [("k.example", f"/p{i}", f"page body {i}") for i in range(5)]
    set_registry([mk_source("src:k", urls=[f"https://k.example/p{i}" for i in range(5)], cls="feed")])
    penv = dict(os.environ, WORLD=json.dumps(pages))
    killed = 0
    for kill in KILLS:
        r = subprocess.run([sys.executable, str(HERE / "_tick_proc.py")], env=dict(penv, KILL=kill), capture_output=True, text=True)
        assert r.returncode in (-signal.SIGKILL, 0), (kill, r.returncode, r.stderr[-800:])
        killed += r.returncode == -signal.SIGKILL
    assert killed >= 5
    for host, path, body in pages:
        world.add(host, path, 200, body.encode(), headers={"Content-Type": "text/plain"})
    world.add("k.example", "/robots.txt", 404)
    monkeypatch.setattr(T, "DEFAULT_MAX_RUNTIME_S", 600)
    for _ in range(3):
        rep, rc = tick()
        assert "skipped" not in rep                           # 죽은 tick의 잠금은 풀렸다
    snaps = events("snapshot.captured")
    assert sorted(e["payload"]["url"] for e in snaps) == sorted(f"https://k.example/p{i}" for i in range(5))
    assert len({e["payload"]["id"] for e in snaps}) == 5      # URL마다 정확히 한 번
    with State() as st:
        assert st.page_count() == 0
        rows = st.list_urls("src:k")
    assert len(rows) == 5 and all(r["state"] == "ok" and r["last_sha"] for r in rows)
