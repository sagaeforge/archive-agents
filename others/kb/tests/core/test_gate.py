import fcntl
import os
import subprocess
import sys
import threading
import time
import types
from pathlib import Path

import pytest

from kb.core import gatelock
from kb.core.gatelock import Gate


def test_acquire_release(kb_home):
    g = Gate(kb_home / "gate.lock")
    fd = g.acquire(1)
    g.release(fd)
    g.release(g.acquire(1))


def test_timeout_when_owner_stuck(kb_home):
    path = kb_home / "gate.lock"
    holder = subprocess.Popen([sys.executable, "-c",
                               "import fcntl,os,sys,time;fd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR);"
                               "fcntl.flock(fd,fcntl.LOCK_EX);print('ok',flush=True);time.sleep(30)", str(path)],
                              stdout=subprocess.PIPE, text=True)
    try:
        assert holder.stdout.readline().strip() == "ok"
        t0 = time.monotonic()
        with pytest.raises(TimeoutError):
            Gate(path).acquire(0.5)
        assert 0.4 < time.monotonic() - t0 < 2
        holder.kill()
        holder.wait()
        Gate(path).release(Gate(path).acquire(2))  # 소유자가 죽으면 다시 얻는다
    finally:
        holder.kill()


def test_abandoned_waiter_releases_late_lock(kb_home):
    path = kb_home / "gate.lock"
    owner = Gate(path).acquire(1)
    with pytest.raises(TimeoutError):
        Gate(path).acquire(0.2)
    Gate(path).release(owner)
    time.sleep(0.3)  # 대기 스레드가 늦게 얻고 바로 풀어야 한다
    fd = Gate(path).acquire(1)
    Gate(path).release(fd)


def test_threads_mutually_exclusive(kb_home):
    g = Gate(kb_home / "gate.lock")
    inside, bad, n = [0], [], [0]

    def work():
        for _ in range(20):
            fd = g.acquire(10)
            try:
                inside[0] += 1
                if inside[0] != 1:
                    bad.append(1)
                n[0] += 1
                time.sleep(0.001)
                inside[0] -= 1
            finally:
                g.release(fd)

    ts = [threading.Thread(target=work) for _ in range(6)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not bad and n[0] == 120


def test_each_call_opens_new_fd(kb_home):
    g = Gate(kb_home / "gate.lock")
    a = g.acquire(1)
    g.release(a)
    b = g.acquire(1)
    g.release(b)
    with pytest.raises(OSError):
        os.fstat(b)


def test_abandoned_waiter_closes_fd_on_lock_error(kb_home, monkeypatch):
    fds = lambda: len(os.listdir("/proc/self/fd"))

    def slow_fail(fd, op):
        time.sleep(0.2)
        raise OSError("주입")

    before = fds()
    monkeypatch.setattr(gatelock.fcntl, "flock", slow_fail)
    with pytest.raises(TimeoutError):
        Gate(kb_home / "gate.lock").acquire(0.01)
    time.sleep(0.4)
    assert fds() == before


def test_no_nonblocking_retry_in_source(repo):
    needle = "LOCK_" + "NB"
    # rank/indexer.py는 재시도가 아니라 "이미 돌고 있으면 건너뜀" 단일 실행 잠금이다(skipped: locked)
    allow = {repo / "src/kb/rank/indexer.py"}
    hits = [str(p) for p in (repo / "src").rglob("*.py") if p not in allow and needle in p.read_text(encoding="utf-8")]
    assert hits == []


def _interrupted_wait(monkeypatch, before=lambda: None):
    class Ev(threading.Event):
        def wait(self, timeout=None):
            before()
            raise KeyboardInterrupt
    # threading.Event 자체를 바꾸면 Thread.start도 멈추므로 gatelock이 보는 이름만 바꾼다
    monkeypatch.setattr(gatelock, "threading", types.SimpleNamespace(
        Lock=threading.Lock, Thread=threading.Thread, Event=Ev))


def test_interrupted_acquire_abandons_waiter(kb_home, monkeypatch):
    """대기 중 호출자가 BaseException으로 떠나면 대기 스레드는 늦게 얻은 잠금을 바로 푼다."""
    path = kb_home / "gate.lock"
    owner = Gate(path).acquire(1)
    with monkeypatch.context() as m:
        _interrupted_wait(m)
        with pytest.raises(KeyboardInterrupt):
            Gate(path).acquire(5)
    Gate(path).release(owner)
    time.sleep(0.2)
    Gate(path).release(Gate(path).acquire(0.3))


def test_interrupted_after_grant_releases(kb_home, monkeypatch):
    """대기 스레드가 잠금을 얻은 직후 호출자가 떠나도 잠금과 fd를 돌려준다."""
    path = kb_home / "gate.lock"
    n = len(os.listdir("/proc/self/fd"))
    with monkeypatch.context() as m:
        _interrupted_wait(m, lambda: time.sleep(0.2))
        with pytest.raises(KeyboardInterrupt):
            Gate(path).acquire(5)
    Gate(path).release(Gate(path).acquire(0.3))
    assert len(os.listdir("/proc/self/fd")) == n
