"""SIGINT, SIGTERM이 오면 100 ms 안에 분리 프로세스가 뜨고 서버가 종료한다. 가짜 kb가 호출을 기록한다(실제 전송 없음)."""
import os
import signal
import time

import pytest

from mhelp import fake_kb_sid, lines, wait_for


@pytest.mark.parametrize("sig", [signal.SIGINT, signal.SIGTERM])
def test_signal_spawns_detached_ship_and_exits(factory, tmp_path_factory, kbenv, sig):
    d = kbenv.home / "fake"
    d.mkdir(exist_ok=True)
    log = d / f"sig-{int(sig)}.log"
    log.unlink(missing_ok=True)
    m = factory({"KB_SHIP_BIN": fake_kb_sid(d, log)})
    sid = os.getsid(m.p.pid)
    t0 = time.monotonic()
    os.kill(m.p.pid, sig)
    code = m.wait(5)
    t_exit = time.monotonic() - t0
    got = wait_for(lambda: lines(log), 2.0)
    t_log = time.monotonic() - t0
    assert code == 0
    assert t_exit <= 0.1, t_exit
    assert t_log <= 0.1 or len(got) == 1      # 기록은 분리 프로세스의 일이라 서버 종료 직후여도 된다
    time.sleep(0.3)
    got = lines(log)
    assert len(got) == 1
    pid, fsid, args = got[0].split(" ", 2)
    assert args == "ship --if-dirty --timeout 12"
    assert int(fsid) != sid        # 새 세션(start_new_session)


def test_signal_during_tool_call_still_exits(factory, kbenv):
    d = kbenv.home / "fake"
    d.mkdir(exist_ok=True)
    log = d / "sig-busy.log"
    log.unlink(missing_ok=True)
    m = factory({"KB_SHIP_BIN": fake_kb_sid(d, log)})
    m.call("kb_search", q="hooks")
    os.kill(m.p.pid, signal.SIGTERM)
    assert m.wait(5) == 0
    assert len(wait_for(lambda: lines(log), 2.0)) == 1
