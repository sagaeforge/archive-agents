"""stdin을 닫으면 2초 안에 서버가 끝나고 분리 프로세스가 1회 뜬다. 신호와 EOF가 겹쳐도 1회다."""
import os
import signal
import time

from mhelp import fake_kb_sid, lines, wait_for


def setup(kbenv, name):
    d = kbenv.home / "fake"
    d.mkdir(exist_ok=True)
    log = d / f"{name}.log"
    log.unlink(missing_ok=True)
    return fake_kb_sid(d, log), log


def test_eof_ends_within_2s_and_ships_once(factory, kbenv):
    fake, log = setup(kbenv, "eof")
    m = factory({"KB_SHIP_BIN": fake})
    m.call("kb_status")
    sid = os.getsid(m.p.pid)
    t0 = time.monotonic()
    m.close_stdin()
    assert m.wait(2.0) == 0
    assert time.monotonic() - t0 <= 2.0
    got = wait_for(lambda: lines(log), 2.0)
    time.sleep(0.3)
    got = lines(log)
    assert len(got) == 1 and got[0].split(" ", 2)[2] == "ship --if-dirty --timeout 12"
    assert int(got[0].split(" ")[1]) != sid


def test_signal_and_eof_together_ship_once(factory, kbenv):
    fake, log = setup(kbenv, "both")
    m = factory({"KB_SHIP_BIN": fake})
    os.kill(m.p.pid, signal.SIGTERM)
    try:
        m.close_stdin()
    except (BrokenPipeError, ValueError):
        pass
    m.wait(3.0)
    wait_for(lambda: lines(log), 2.0)
    time.sleep(0.4)
    assert len(lines(log)) == 1


def test_eof_with_no_requests_after_init(factory, kbenv):
    fake, log = setup(kbenv, "eof-idle")
    m = factory({"KB_SHIP_BIN": fake})
    m.close_stdin()
    assert m.wait(2.0) == 0
    assert len(wait_for(lambda: lines(log), 2.0)) == 1
