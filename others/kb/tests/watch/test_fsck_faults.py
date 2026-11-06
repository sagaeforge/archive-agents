"""고장 주입: 검사기가 각 고장을 잡는다. 정상 상태에서는 치명 0."""
import json
import sqlite3

import pytest

from kb.core import cas, ledger
from kb.guard import anchor, fsck, watchdog
from kb.project import current_gold_path, rebuild
from conftest import NOW, codes
from projhelp import E, claim, entity, snap_events

DAY_MS = 86_400_000


@pytest.fixture
def data(env):
    """이벤트 몇 개 + 투영된 gold + CAS 객체 하나를 가진 정상 상태. 쓰기 연결을 열어 둔다(WAL 유지)."""
    led = ledger.open_ledger()
    ledger.append(led, [E("source.registered", {"id": "src:a", "domain": ["A"]}, "src:a"), *snap_events(),
                        entity("e:tool:x"), claim("c1", "e:tool:x", "x는 위젯을 지원한다")])
    rebuild(led=led)
    sha = cas.put(b"watch-cas-object")
    yield type("D", (), {"led": led, "sha": sha})()
    led.close()


def settle(now=None):
    """검사를 전부 돌리고(CAS 전수) 상태 벡터를 계산한다."""
    r = fsck.run(force=True, cas_full=True, now=now)
    return r, watchdog.compute(now or watchdog.now_ms(), uptime=0, decisions=set())


def drop_triggers(c):
    for name in ledger.TRIGGERS:
        c.execute(f"DROP TRIGGER {name}")


def add_triggers(c):
    for ddl in ledger.TRIGGERS.values():
        c.execute(ddl)


def test_clean_state_has_no_critical(data):
    r, v = settle()
    assert r["ok"], r
    assert v["critical"] == [] and v["warnings"] == []


def test_chain_tamper(data):
    c = sqlite3.connect(ledger.ledger_path(), isolation_level=None)
    drop_triggers(c)
    c.execute("UPDATE event SET actor='collector:evil' WHERE seq=2")
    add_triggers(c)
    c.close()
    r, v = settle()
    assert not r["ok"] and "ledger_chain" in codes(v["critical"])
    assert any("hash" in e for e in next(x for x in v["critical"] if x["code"] == "ledger_chain")["errors"])


def test_record_head_tamper(data):
    ledger.append(data.led, [{"kind": "record.put", "actor": "user:sagae", "origin": "first_party",
                              "subject": "f-h1", "idem_key": "h1", "payload": {"a": 1}}])
    c = sqlite3.connect(ledger.ledger_path(), isolation_level=None)
    drop_triggers(c)
    c.execute("UPDATE record_head SET version=version+5 WHERE id='f-h1'")
    add_triggers(c)
    c.close()
    r, v = settle()
    chain = next(x for x in v["critical"] if x["code"] == "ledger_chain")
    assert any("record_head" in e for e in chain["errors"])


def test_cas_object_corruption(data):
    p = cas.path_of(data.sha)
    b = bytearray(p.read_bytes())
    b[0] ^= 0xFF
    p.write_bytes(bytes(b))
    r, v = settle()
    bad = next(x for x in v["critical"] if x["code"] == "cas_mismatch")
    assert any(data.sha in e for e in bad["errors"])


def test_cas_daily_slice_rotates(data):
    p = cas.path_of(data.sha)
    p.write_bytes(p.read_bytes()[:-3])
    s = fsck.cas_slice(data.sha)
    hit = fsck.run(["cas"], now=(s + 30 * 100) * DAY_MS)                  # 조각이 맞는 날
    miss = fsck.run(["cas"], now=((s + 1) % 30 + 30 * 100) * DAY_MS)      # 다른 날은 이 객체를 건너뛴다
    assert not hit["ok"] and hit["steps"][0]["slice"] == s
    assert miss["steps"][0]["bad"] == 0


def test_pass_clears_previous_failure(data):
    p = cas.path_of(data.sha)
    good = p.read_bytes()
    p.write_bytes(good[:-3])
    _, v = settle()
    assert "cas_mismatch" in codes(v["critical"])
    p.write_bytes(good)
    _, v = settle()
    assert "cas_mismatch" not in codes(v["critical"])


def gold_rw():
    return sqlite3.connect(current_gold_path(), isolation_level=None)


def test_projection_lag_is_warning_after_grace(data):
    ledger.append(data.led, [E("entity.put", {"id": "e:tool:y", "type": "Tool", "label": "y"}, "e:tool:y")])
    t0 = NOW
    v0 = watchdog.compute(t0, uptime=0, decisions=set())
    assert "projection_lag" not in codes(v0["warnings"])           # 방금 뒤처짐: 유예 안
    watchdog.write_vector(v0, t0)                                   # behind_since_ms 기록
    v1 = watchdog.compute(t0 + (watchdog.LAG_WARN_S + 5) * 1000, uptime=0, decisions=set())
    lag = next(x for x in v1["warnings"] if x["code"] == "projection_lag")
    assert lag["head"] > lag["applied_seq"]
    rebuild(led=data.led)                                           # 따라잡으면 사라진다
    v2 = watchdog.compute(t0 + 10 * DAY_MS, uptime=0, decisions=set())
    assert "projection_lag" not in codes(v2["warnings"])


def test_projection_quarantine_is_critical(data):
    g = gold_rw()
    g.execute("INSERT INTO quarantine(seq, reason, at) VALUES(3, 'x', 1)")
    g.close()
    v = watchdog.compute(NOW, uptime=0, decisions=set())
    q = next(x for x in v["critical"] if x["code"] == "projection_quarantine")
    assert q["seqs"] == [3]


def test_gold_ahead_of_head_is_critical(data):
    g = gold_rw()
    g.execute("UPDATE meta SET v='999999' WHERE k='applied_seq'")
    g.close()
    v = watchdog.compute(NOW, uptime=0, decisions=set())
    a = next(x for x in v["critical"] if x["code"] == "gold_ahead")
    assert a["applied_seq"] == 999999 and a["head"] < 999999


def test_wal_over_limit_warns(data, monkeypatch):
    v = watchdog.compute(NOW, uptime=0, decisions=set())
    assert "wal_size" not in codes(v["warnings"])
    monkeypatch.setitem(watchdog.WAL_LIMIT, "ledger", 1)
    v = watchdog.compute(NOW, uptime=0, decisions=set())
    w = next(x for x in v["warnings"] if x["code"] == "wal_size")
    assert w["db"] == "ledger" and w["bytes"] > 1


def test_anchor_ahead_of_local_head(data):
    a = anchor.append_anchor(data.led)
    assert a is not None
    p = anchor.anchors_path()
    line = json.dumps({**a, "seq": a["seq"] + 50, "head_hash": "0" * 64})
    p.write_text(p.read_text() + line + "\n")
    v = watchdog.compute(NOW, uptime=0, decisions=set())
    assert "anchor_behind" in codes(v["critical"])


def test_integrity_is_judged_with_chain(data):
    c = sqlite3.connect(ledger.ledger_path(), isolation_level=None)
    drop_triggers(c)
    c.execute("UPDATE event SET at=at+1 WHERE seq=1")               # integrity_check는 통과하는 논리 변조
    add_triggers(c)
    c.close()
    r = fsck.run(["integrity"])
    assert not r["ok"] and r["steps"][0]["chain"] is False
