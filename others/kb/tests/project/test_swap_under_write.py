"""쓰기 중 무중단 교체: 쓰기 프로세스 4 x 스레드 2 + 승격 + 읽기 + 교체."""
import os
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from kb.core import ledger
from kb.core import conn as _conn
from kb.project import (build as bld, current_build, current_gold_path, fingerprint_conn, open_gold, project_tail,
                        rebuild, verify_projection)

HERE = Path(__file__).parent
GATE_MAX_MS = 300


def _read_once(path):
    ro = _conn.connect_ro(path)
    try:
        ro.execute("BEGIN")
        applied = int(ro.execute("SELECT v FROM meta WHERE k='applied_seq'").fetchone()[0])
        top = ro.execute("SELECT coalesce(max(seq),0) FROM change").fetchone()[0]
        nodes = ro.execute("SELECT count(*) FROM node WHERE type='Concept' AND expired_at IS NULL").fetchone()[0]
        puts = ro.execute("SELECT count(*) FROM change WHERE kind='entity.put'").fetchone()[0]
        aliases = ro.execute("SELECT count(*) FROM alias").fetchone()[0]
        orphan = ro.execute("SELECT count(*) FROM claim c LEFT JOIN node n ON n.vid=c.vid WHERE n.vid IS NULL").fetchone()[0]
        dangling = ro.execute("SELECT count(*) FROM evidence e WHERE NOT EXISTS(SELECT 1 FROM node n WHERE n.id=e.claim_id)").fetchone()[0]
        bad = []
        if top > applied:
            bad.append(f"change {top} > applied {applied}")
        if nodes != puts:
            bad.append(f"nodes {nodes} != entity.put {puts}")
        if aliases != nodes:
            bad.append(f"alias {aliases} != nodes {nodes}")
        if orphan or dangling:
            bad.append(f"orphan {orphan} dangling {dangling}")
        return bad
    finally:
        ro.close()


def _spawn(mode, tag, n, outdir):
    return subprocess.Popen([sys.executable, str(HERE / "swapwriter.py"), mode, tag, str(n), str(outdir)], env=os.environ.copy(),
                            stderr=subprocess.PIPE)


def test_swap_under_write(led, kb_home):
    out = kb_home / "swap-out"
    out.mkdir()
    first = rebuild(led=led)
    assert first.swapped
    procs = [_spawn("write", f"w{i}", 40, out) for i in range(4)] + [_spawn("promote", "p", 8, out)]
    stop = threading.Event()
    read_bad, read_err, reads = [], [], [0]

    def reader():
        while not stop.is_set():
            p = current_gold_path()
            try:
                read_bad.extend(_read_once(p))
                reads[0] += 1
            except Exception as e:  # noqa: BLE001
                read_err.append(repr(e))
            time.sleep(0.002)
    rt = threading.Thread(target=reader)
    rt.start()
    (out / "go").write_text("1")
    swaps = []
    while any(p.poll() is None for p in procs) or len(swaps) < 2:
        alive = any(p.poll() is None for p in procs)
        r = rebuild(led=led)
        swaps.append((r, alive))
        if len(swaps) > 40:
            break
    for p in procs:
        assert p.wait(60) == 0, p.stderr.read().decode()
    stop.set()
    rt.join()
    assert not list(out.glob("err-*.txt")), [f.read_text() for f in out.glob("err-*.txt")]

    during = [r for r, alive in swaps if alive]
    print(f"\n교체 {len(swaps)}회(쓰기 중 {len(during)}회), 게이트 보유 ms={[round(r.gate_held_ms) for r, _ in swaps]}, 읽기 {reads[0]}회")
    assert len(during) >= 2, "쓰기가 도는 동안 교체가 2회 이상이어야 한다"
    assert all(r.swapped and r.fingerprint_ok and r.fingerprint_compared and not r.rolled_back for r, _ in swaps)
    assert max(r.gate_held_ms for r, _ in swaps) <= GATE_MAX_MS, [round(r.gate_held_ms) for r, _ in swaps]
    assert not read_err, read_err[:3]
    assert not read_bad, read_bad[:3]
    assert reads[0] > 20

    # 확인 응답 유실 0: 응답한 쓰기는 원장과 현재 gold에 모두 있다
    acks = [ln.split() for f in out.glob("ack-*.txt") for ln in f.read_text().splitlines()]
    assert len(acks) == 4 * 2 * 40 + 2 * 8
    keys = {r[0] for r in led.execute("SELECT idem_key FROM event")}
    lost = [a for a in acks if a[2] not in keys]
    assert not lost, lost[:3]
    g = open_gold(current_gold_path())
    have = {r[0] for r in g.execute("SELECT id FROM node WHERE type='Concept'")}
    g.close()
    assert not [a for a in acks if a[0] not in have]
    # 증분 지문 = 전체 재구축 지문
    v = verify_projection()
    assert v["ok"], v


def test_fingerprint_mismatch_rolls_back_to_old_build(led, kb_home, monkeypatch):
    ledger.append(led, [{"kind": "entity.put", "actor": "c", "origin": "external", "idem_key": f"fm{i}",
                         "subject": f"e:concept:m{i}", "payload": {"id": f"e:concept:m{i}", "type": "Concept", "label": f"m{i}"}}
                        for i in range(5)])
    old = rebuild(led=led)
    assert current_build() == old.build
    real = bld.fingerprint_conn
    calls = []

    def lying(con):
        calls.append(1)
        fp = real(con)
        return fp if len(calls) % 2 == 0 else "0" * 64  # 새 빌드(첫 호출)의 지문만 어긋난다
    monkeypatch.setattr(bld, "fingerprint_conn", lying)
    r = rebuild(led=led)
    assert r.swapped and r.rolled_back and not r.fingerprint_ok
    assert current_build() == old.build, "옛 빌드로 되돌아가야 한다"
    assert (bld.gold_root() / r.build / "BAD").exists()
    monkeypatch.setattr(bld, "fingerprint_conn", real)
    # 되돌린 뒤 꼬리를 따라잡은 상태이고 이어서 쓸 수 있다
    ledger.append(led, [{"kind": "entity.put", "actor": "c", "origin": "external", "idem_key": "fm-last",
                         "subject": "e:concept:last", "payload": {"id": "e:concept:last", "type": "Concept", "label": "last"}}])
    g = open_gold(current_gold_path())
    assert project_tail(led, g).caught_up
    assert g.execute("SELECT count(*) FROM node WHERE type='Concept'").fetchone()[0] == 6
    g.close()
    ok = rebuild(led=led)
    assert ok.fingerprint_ok and not ok.rolled_back
