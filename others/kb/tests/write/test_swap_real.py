"""kb.write 경로 쓰기 중 rebuild 교체 2회 이상: 유실 0, 읽기 오류 0."""
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from kb.core import ledger
from kb.core import conn as _conn
from kb.project import current_gold_path, open_gold, rebuild, verify_projection
from kb.write.engine import project_pending

HERE = Path(__file__).parent


def _read_once(path):
    ro = _conn.connect_ro(path)
    try:
        ro.execute("BEGIN")
        applied = int(ro.execute("SELECT v FROM meta WHERE k='applied_seq'").fetchone()[0])
        top = ro.execute("SELECT coalesce(max(seq),0) FROM change").fetchone()[0]
        orphan = ro.execute("SELECT count(*) FROM claim c LEFT JOIN node n ON n.vid=c.vid WHERE n.vid IS NULL").fetchone()[0]
        return [] if top <= applied and not orphan else [f"top {top} applied {applied} orphan {orphan}"]
    finally:
        ro.close()


def test_write_during_two_swaps(fp_open):
    out = fp_open / "swap-out"
    out.mkdir()
    procs = [subprocess.Popen([sys.executable, str(HERE / "_swap_proc.py"), f"w{i}", "30", str(out)],
                              env=os.environ.copy(), stderr=subprocess.PIPE) for i in range(3)]
    stop = threading.Event()
    bad, errs, reads = [], [], [0]

    def reader():
        while not stop.is_set():
            p = current_gold_path()
            try:
                bad.extend(_read_once(p))
                reads[0] += 1
            except Exception as e:  # noqa: BLE001
                errs.append(repr(e))
            time.sleep(0.002)
    rt = threading.Thread(target=reader)
    rt.start()
    led = ledger.open_ledger()
    (out / "go").write_text("1")
    swaps = []
    while any(p.poll() is None for p in procs) or len(swaps) < 2:
        alive = any(p.poll() is None for p in procs)
        swaps.append((rebuild(led=led), alive))
        if len(swaps) > 40:
            break
    for p in procs:
        assert p.wait(60) == 0, p.stderr.read().decode()
    stop.set()
    rt.join()
    assert not list(out.glob("err-*.txt")), [f.read_text() for f in out.glob("err-*.txt")]
    assert len([1 for _, alive in swaps if alive]) >= 2, "쓰기 중 교체가 2회 이상이어야 한다"
    assert all(r.swapped and r.fingerprint_ok and not r.rolled_back for r, _ in swaps)
    assert not errs and not bad and reads[0] > 10, (errs[:2], bad[:2], reads)
    acks = [ln.split() for f in out.glob("ack-*.txt") for ln in f.read_text().splitlines()]
    assert len(acks) == 3 * 2 * 30
    keys = {r[0] for r in led.execute("SELECT idem_key FROM event")}
    assert not [a for a in acks if a[1] not in keys]  # 응답한 쓰기는 원장에 있다
    project_pending()
    g = open_gold(current_gold_path())
    have = {r[0] for r in g.execute("SELECT id FROM node")}
    g.close()
    led.close()
    assert not [a for a in acks if a[0] not in have]
    assert verify_projection()["ok"]
