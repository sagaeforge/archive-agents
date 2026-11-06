"""backup 중 SIGKILL이 남긴 잠금: 다음 주기 작업이 unlock + --retry-lock으로 이어 간다."""
import os
import signal
import subprocess
import time

from bkhelp import local_spec, open_fp, put
from kb.guard import ship


def test_sigkill_during_backup_then_next_beat_succeeds(bk, monkeypatch):
    h = bk.home
    bk.write_config([local_spec(h)])
    bk.init()
    open_fp()
    put("a", "본문")
    monkeypatch.setenv("KB_RESTIC_BIN", bk.wrapper())
    t, sec = ship.load_targets()[0], ship.load_secrets()
    locks = h / "repos" / "local-c" / "locks"
    # stdin을 열어 둔 채 멈춰 있는 backup: 잠금을 쥐고 있다
    p = subprocess.Popen([bk.restic, "backup", "--stdin", "--stdin-filename", "x", "--host", "kb", "--tag", "t0"],
                         stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         env=ship.restic_env(t, sec), start_new_session=True)
    try:
        end = time.monotonic() + 60
        while time.monotonic() < end and not (locks.exists() and any(locks.iterdir())):
            time.sleep(0.2)
        assert any(locks.iterdir()), "잠금이 잡히지 않았다"
    finally:
        os.killpg(p.pid, signal.SIGKILL)
        p.wait()
    assert any(locks.iterdir()), "SIGKILL은 잠금을 남긴다"
    r = ship.ship()
    assert r["ok"] and r["targets"][0]["result"] == "ok"
    calls = [c for c in bk.calls() if " backup " in c or " unlock " in c]
    assert any(" unlock --retry-lock 2m" in c for c in calls)
    assert any(" backup " in c and "--retry-lock 2m" in c for c in calls)
    assert not any(locks.iterdir()), "낡은 잠금은 치워졌다"
    assert bk.snapshots("local-c", "t0")
