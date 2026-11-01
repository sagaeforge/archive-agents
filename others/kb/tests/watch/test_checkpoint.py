"""WAL 임계 초과 시 게이트 밖 전용 연결, busy_timeout=100으로 RESTART를 한 번 시도한다. 실패해도 쓰기를 막지 않는다."""
import sqlite3
import time

import pytest

from kb.core import conn as _conn
from kb.core import ledger
from kb.guard import tick_stage_watch, watchdog
from kb.project import rebuild
from conftest import codes
from projhelp import E, entity


@pytest.fixture
def led(env):
    c = ledger.open_ledger()
    ledger.append(c, [entity("e:tool:x"), entity("e:tool:y")])
    rebuild(led=c)
    yield c
    c.close()


def wal(path):
    return path.parent / (path.name + "-wal")


def test_below_limit_does_nothing(led):
    assert watchdog.checkpoint_if_needed() == {}


def test_over_limit_restarts_with_100ms_busy_timeout(led, monkeypatch):
    monkeypatch.setitem(watchdog.WAL_LIMIT, "ledger", 1)
    seen = []

    def spy(path, sync="FULL"):
        c = _conn.connect_rw(path, sync)
        seen.append(str(path))
        return c
    out = watchdog.checkpoint_if_needed(connect=spy)
    assert out["ledger"]["busy_timeout"] == 100 and out["ledger"]["ok"] is True
    assert seen == [str(ledger.ledger_path())]          # 임계를 넘은 DB 하나, 연결 하나
    assert wal(ledger.ledger_path()).stat().st_size < 4096 or out["ledger"]["wal_bytes"] > 1


def test_gold_over_limit_is_checkpointed_too(led, monkeypatch):
    from kb.project import current_gold_path
    g = sqlite3.connect(current_gold_path(), isolation_level=None)     # 열린 연결이 WAL을 유지한다
    g.execute("INSERT OR REPLACE INTO meta(k, v) VALUES('probe', '1')")
    monkeypatch.setitem(watchdog.WAL_LIMIT, "gold", 1)
    out = watchdog.checkpoint_if_needed()
    g.close()
    assert "gold" in out and out["gold"]["busy_timeout"] == 100 and out["gold"]["ok"] is True


def test_blocked_by_reader_fails_fast_and_never_blocks_writes(led, monkeypatch):
    monkeypatch.setitem(watchdog.WAL_LIMIT, "ledger", 1)
    # 오래 열린 읽기 트랜잭션이 RESTART를 막는다
    reader = sqlite3.connect(ledger.ledger_path(), isolation_level=None)
    reader.execute("BEGIN")
    reader.execute("SELECT count(*) FROM event").fetchone()
    ledger.append(led, [entity("e:tool:z")])            # 읽기 시점 이후의 WAL 프레임을 만든다
    t0 = time.monotonic()
    out = watchdog.checkpoint_if_needed()
    took = time.monotonic() - t0
    assert out["ledger"]["ok"] is False and out["ledger"]["busy"] == 1
    assert took < 2.0, "busy_timeout=100이라 길게 기다리지 않는다"
    # 실패해도 쓰기는 막히지 않는다
    t1 = time.monotonic()
    ledger.append(led, [entity("e:tool:w")])
    assert time.monotonic() - t1 < 2.0
    reader.execute("ROLLBACK")
    reader.close()
    assert watchdog.checkpoint_if_needed()["ledger"]["ok"] is True      # 다음 tick에 성공


def test_stage_reports_ok_even_when_checkpoint_fails(led, monkeypatch):
    monkeypatch.setitem(watchdog.WAL_LIMIT, "ledger", 1)
    reader = sqlite3.connect(ledger.ledger_path(), isolation_level=None)
    reader.execute("BEGIN")
    reader.execute("SELECT count(*) FROM event").fetchone()
    ledger.append(led, [entity("e:tool:q")])
    r = tick_stage_watch.run_checkpoint()
    reader.execute("ROLLBACK")
    reader.close()
    assert r.ok and r.detail["checkpoint"]["ledger"]["ok"] is False


def test_does_not_take_the_write_gate(led, monkeypatch):
    from kb.core.gatelock import Gate
    from kb.project import gate_path
    monkeypatch.setitem(watchdog.WAL_LIMIT, "ledger", 1)
    g = Gate(gate_path())
    fd = g.acquire(1.0)                                  # 쓰기 게이트를 쥔 채로도 체크포인트가 돈다
    try:
        t0 = time.monotonic()
        out = watchdog.checkpoint_if_needed()
        assert time.monotonic() - t0 < 2.0 and "ledger" in out
    finally:
        g.release(fd)
