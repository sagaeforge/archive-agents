"""침묵 시험: tick이 안 돌아도 kb status가 호출할 때 치명으로 올린다."""
import json
import os

from kb.cli import main
from kb.guard import watchdog
from conftest import H, NOW, codes, mk_source


def status_json(capsys):
    assert main(["status", "--json"]) == 0
    return json.loads(capsys.readouterr().out)


def test_stalled_tick_and_held_lock_are_critical_on_call(env, approve, tick_state, capsys, monkeypatch):
    approve(3)
    import time
    now = int(time.time() * 1000)
    tick_state(last_tick_at=now - 3 * H, lock_pid=os.getpid(), lock_since=now - 30 * 60_000)
    st = status_json(capsys)
    assert st["ok"] is False
    cs = {x["code"]: x for x in st["critical"]}
    assert cs["tick_stalled"]["age_s"] >= 3 * 3600 - 5
    assert cs["tick_lock_held"]["held_s"] >= 30 * 60 - 5
    assert st["freshness"]["last_tick_age_s"] >= 3 * 3600 - 5
    assert "schedule_missing" not in codes(st["notices"])


def test_never_ticked_after_decision_3_is_critical(env, approve):
    approve(3)
    v = watchdog.compute(NOW, uptime=0)
    assert next(x for x in v["critical"] if x["code"] == "tick_stalled")["age_s"] is None


def test_before_decision_3_is_notice_not_critical(env, tick_state):
    tick_state(last_tick_at=NOW - 10 * H, lock_pid=os.getpid(), lock_since=NOW - 3 * H)
    v = watchdog.compute(NOW, uptime=0)
    assert "tick_stalled" not in codes(v["critical"]) and "tick_lock_held" not in codes(v["critical"])
    assert "schedule_missing" in codes(v["notices"])
    assert v["freshness"]["last_tick_age_s"] == 10 * 3600           # 값은 그래도 보고한다


def test_dead_lock_pid_is_not_a_held_lock(env, approve, tick_state):
    approve(3)
    tick_state(last_tick_at=NOW - 60_000, lock_pid=2 ** 22 + 12345, lock_since=NOW - 3 * H)
    v = watchdog.compute(NOW, uptime=0)
    assert v["critical"] == []


def test_healthy_tick_has_no_tick_critical(env, approve, tick_state):
    approve(3)
    tick_state(last_tick_at=NOW - 30 * 60_000, lock_pid="")
    assert watchdog.compute(NOW, uptime=0)["critical"] == []


def seed_sources(ops, rows):
    for sid, state, last_ok in rows:
        ops.execute("INSERT INTO source_state(source_id, state, last_ok_at, fail_count) VALUES(?,?,?,0)", (sid, state, last_ok))


def test_source_faults_stay_in_warnings(env, ops, set_registry):
    set_registry([mk_source("src:ok"), mk_source("src:broken"), mk_source("src:denied"), mk_source("src:old", cls="rel"),
                  mk_source("src:off", enabled=False)])
    seed_sources(ops, [("src:ok", "ok", NOW - H), ("src:broken", "broken", NOW - H), ("src:denied", "robots_denied", NOW - H),
                       ("src:old", "ok", NOW - 3 * 86_400_000), ("src:off", "broken", NOW)])
    ops.execute("INSERT INTO circuit(host, state, opened_at, until_at, reason, trips) VALUES('h.example','open',?,?, 'x', 2)",
                (NOW - H, NOW - H + 7 * 86_400_000))
    ops.execute("INSERT INTO circuit(host, state, opened_at, until_at, reason, trips) VALUES('short.example','open',?,?, 'x', 1)",
                (NOW - H, NOW + H))
    v = watchdog.compute(NOW, uptime=0)
    w = {x["code"]: x for x in v["warnings"]}
    assert w["source_broken"]["sources"] == ["src:broken"]          # 비활성 소스는 세지 않는다
    assert w["source_robots_denied"]["sources"] == ["src:denied"]
    assert w["source_stale"]["sources"] == ["src:old"]
    assert w["circuit_7d"]["hosts"] == ["h.example"]
    assert v["freshness"]["stale_sources"] == 1
    assert v["critical"] == []


def test_collect_silence_needs_24h_uptime(env, ops, set_registry):
    set_registry([mk_source("src:a")])
    seed_sources(ops, [("src:a", "ok", NOW - 30 * H)])
    assert "collect_silence" in codes(watchdog.compute(NOW, uptime=48 * 3600)["critical"])
    assert "collect_silence" not in codes(watchdog.compute(NOW, uptime=10 * 3600)["critical"])   # PC가 방금 켜짐
    ops.execute("UPDATE source_state SET last_ok_at=?", (NOW - H,))
    assert "collect_silence" not in codes(watchdog.compute(NOW, uptime=48 * 3600)["critical"])


def test_critical_text_for_session_hook(env, approve, capsys):
    approve(3)
    assert main(["status", "--critical"]) == 0
    out = capsys.readouterr().out.splitlines()
    assert out[0].startswith("치명: tick_stalled")
    assert out[-1].startswith("kb status: 치명 1건, 경고 0건")
