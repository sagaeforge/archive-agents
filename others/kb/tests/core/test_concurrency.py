"""쓰기가 겹친 상황: 쓰는 중 검증, 빈 KB_HOME의 첫 기동 경합."""
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from kb.core import ledger, opsdb

HERE = Path(__file__).parent


def test_verify_during_writes_has_no_false_alarm(kb_home):
    w = subprocess.Popen([sys.executable, str(HERE / "_kill_writer.py"), "w"], stdout=subprocess.DEVNULL,
                         env=os.environ.copy())
    c = ledger.open_ledger()
    try:
        seen, runs = set(), 0
        end = time.monotonic() + 30
        while (runs < 60 or len(seen) < 20) and time.monotonic() < end:
            v = ledger.verify_chain(c)
            assert v.ok, v.errors
            assert not c.in_transaction
            seen.add(v.head_seq)
            runs += 1
    finally:
        w.kill()
        w.wait()
    assert len(seen) >= 20, "검증 사이에 쓰기가 끼지 않았다"
    c.close()


def test_first_start_race(kb_home):
    for rnd in range(12):
        home = kb_home / f"r{rnd}"
        home.mkdir()
        env = dict(os.environ, KB_HOME=str(home))
        at = time.time() + 0.6
        ps = [subprocess.Popen([sys.executable, str(HERE / "_open_race.py"), str(at), f"p{i}"], env=env,
                               stderr=subprocess.PIPE, text=True) for i in range(6)]
        errs = [p.communicate(timeout=60)[1] for p in ps]
        assert [p.returncode for p in ps] == [0] * 6, errs
        assert not list((home / "ops").glob("ops.db.old-*"))
        os.environ["KB_HOME"] = str(home)  # monkeypatch가 복원한다
        c = opsdb.connect()
        assert c.execute("SELECT count(*) FROM metric").fetchone()[0] == 6
        c.close()
        c = ledger.open_ledger()
        assert ledger.verify_chain(c).events == 6
        c.close()
        shutil.rmtree(home)
