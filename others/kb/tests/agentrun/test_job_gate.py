"""kb jobs run: claude -p를 부르는 작업(agents.fulfill, agents.liveness_review, metrics.retro)은 작업마다 ADR-0003 5장 활용률 규칙과 사람의 정지를 지난다.
7일 >= 0.80, 초과 과금, 값 없음, llm:stop, HALT이면 사유를 남기고 건너뛴다(실패 아님, 만기 기록 없음). 0.5면 돈다. claude -p는 대역이다."""
import stat
import subprocess

import pytest
import yaml

from arhelp import REPO, approve

JOBS_YAML = """jobs:
  - {id: agents.fulfill, kind: agent, every_s: 86400, cmd: "kb-agent-run kb-fulfill"}
  - {id: agents.liveness_review, kind: agent, every_s: 604800, cmd: "kb-agent-run kb-liveness-review"}
  - {id: metrics.retro, kind: agent, every_s: 604800, cmd: "kb retro"}
  - {id: extract.l2, kind: agent, every_s: 3600, cmd: "kb agent run --scope public"}
"""
CLAUDE_JOBS = {"agents.fulfill", "agents.liveness_review", "metrics.retro"}


def script(path, body):
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


@pytest.fixture
def env(home, monkeypatch):
    from kb.extract.backends import claude as cb
    from kb.extract.types import Result
    share = home / "share"
    (share / "sources" / "internal.d").mkdir(parents=True)
    (share / "sources" / "internal.d" / "t.yaml").write_text(JOBS_YAML)
    cfg = yaml.safe_load((REPO / "sources/internal.d/extract.yaml").read_text())["settings"]       # 문턱은 저장소 것, 작업 목록은 뺀다
    (share / "sources" / "internal.d" / "extract.yaml").write_text(yaml.safe_dump({"settings": cfg}))
    for d in ("schemas", "prompts"):
        (share / d).symlink_to(REPO / d)
    monkeypatch.setenv("KB_SHARE", str(share))
    log = home / "calls.log"
    monkeypatch.setenv("KB_BIN", script(home / "fake-kb", f'echo "kb $*" >> "{log}"\n'))
    monkeypatch.setenv("KB_AGENT_RUN", script(home / "fake-agent-run", f'echo "agent-run $*" >> "{log}"\n'))
    fake_bin = home / "claude-bin"
    fake_bin.write_text("")
    monkeypatch.setenv("KB_CLAUDE_BIN", str(fake_bin))
    approve(home, 11)
    st = {"rate": {"five_hour": 0.1, "seven_day": 0.5, "status": "allowed", "isUsingOverage": False}, "canaries": 0}

    def fake_run_claude(model, system, user, schema_obj, budget_usd, window_id):
        st["canaries"] += 1
        r = Result(window_id, "claude", model)
        r.raw = "{}"
        r.error = st.get("error")
        r.extra["rate"] = dict(st["rate"])
        return r
    monkeypatch.setattr(cb, "run_claude", fake_run_claude)
    monkeypatch.setattr(cb.Claude, "_auth_ok", lambda self: True)
    st["log"] = log
    return st


def calls(st):
    return st["log"].read_text().splitlines() if st["log"].exists() else []


def test_skipped_at_seven_day_095(env):
    from kb.commands import jobs
    env["rate"]["seven_day"] = 0.95
    out = jobs.run_due()
    assert {k: v for k, v in out["skipped"].items() if k in CLAUDE_JOBS} == {j: "claude_seven_day" for j in CLAUDE_JOBS}
    assert out["failed"] == [] and out["calls"] == 1
    assert calls(env) == ["kb agent run --scope public"]          # claude 작업은 하나도 시작하지 않았다
    assert env["canaries"] == 1                                    # 검사 1회, 작업 셋이 공유한다
    from kb.extract import state
    recs = state.metrics("agentjob.skipped")
    assert sorted(d["job"] for _, d, _ in recs) == sorted(CLAUDE_JOBS) and {d["reason"] for _, d, _ in recs} == {"seven_day"}


def test_retried_next_cycle_when_utilization_drops(env):
    from kb.commands import jobs
    env["rate"]["seven_day"] = 0.95
    jobs.run_due()
    env["rate"]["seven_day"] = 0.5
    from kb.extract import state
    c = state.get("claude:canary")
    state.put("claude:canary", dict(c, at=c["at"] - 7200))        # 마지막 측정이 1시간보다 낡아 다시 잰다
    out = jobs.run_due()
    assert [j for j in out["ran"] if j["id"] in CLAUDE_JOBS] and not out["failed"]
    assert sorted(c for c in calls(env) if c.startswith(("agent-run", "kb retro"))) == [
        "agent-run kb-fulfill", "agent-run kb-liveness-review", "kb retro"]


def test_runs_at_seven_day_05(env):
    from kb.commands import jobs
    out = jobs.run_due()
    assert not out["failed"] and out["calls"] == 4
    assert {j["id"] for j in out["ran"]} == CLAUDE_JOBS | {"extract.l2"}
    assert calls(env) == ["kb agent run --scope public", "agent-run kb-fulfill", "agent-run kb-liveness-review", "kb retro"]


@pytest.mark.parametrize("rate,reason", [
    ({"five_hour": 0.1, "seven_day": 0.80}, "seven_day"),            # 문턱은 이상(>=)
    ({"five_hour": 0.6, "seven_day": 0.1}, "five_hour"),             # 시작 시 5시간 > 0.5
    ({"five_hour": 0.1, "seven_day": 0.1, "isUsingOverage": True}, "overage"),
    ({"five_hour": 0.1, "seven_day": None}, "rate_unavailable"),     # 7일 값이 없으면 문턱을 잴 수 없다
])
def test_other_stop_reasons(env, rate, reason):
    from kb.commands import jobs
    env["rate"] = dict(rate, status="allowed")
    out = jobs.run_due()
    allowed = {"claude_" + reason, "claude_hold_claude_overage"} if reason == "overage" else {"claude_" + reason}
    assert {out["skipped"][j] for j in CLAUDE_JOBS} <= allowed and not out["failed"]
    assert calls(env) == ["kb agent run --scope public"]


def _rate_rises_after(job, monkeypatch, env):
    """job이 끝나는 사이 다른 경로가 활용률 0.95를 저장한다."""
    from kb.commands import jobs
    from kb.extract import settings, state
    real = subprocess.run

    def wrapped(argv, *a, **k):
        r = real(argv, *a, **k)
        if job in " ".join(map(str, argv)):
            state.put("claude:rate", {"five_hour": 0.2, "seven_day": 0.95, "status": "allowed", "isUsingOverage": False, "at": settings.now_s()})
        return r
    monkeypatch.setattr(jobs.subprocess, "run", wrapped)


def test_rate_stored_after_first_job_skips_later_jobs(env, monkeypatch):
    """리뷰 M2: 검사는 작업마다다."""
    from kb.commands import jobs
    _rate_rises_after("kb-fulfill", monkeypatch, env)
    out = jobs.run_due()
    assert calls(env) == ["kb agent run --scope public", "agent-run kb-fulfill"]
    assert out["skipped"]["agents.liveness_review"] == out["skipped"]["metrics.retro"] == "claude_seven_day"


@pytest.mark.parametrize("hold,reason", [
    (lambda r, s, g: s.put(r.STOP_KEY, {"reason": "cost_exceeded", "at": 1}), "hold_cost_exceeded"),
    (lambda r, s, g: s.put(g.HALT_KEY, {"reason": "external_send", "backend": "x"}), "hold_halted"),
    (lambda r, s, g: r.apply("claude_overage", isUsingOverage=True), "hold_claude_overage"),
    (lambda r, s, g: r.set_off("claude", "overage", None), "hold_overage"),
], ids=["llm_stop", "halt", "overage_signal", "off_without_retry"])
def test_human_holds_block_jobs_with_clean_rate(env, hold, reason):
    """리뷰 M3: 지금 활용률이 깨끗해도 사람이 풀어야 하는 정지는 작업을 막고 카나리아도 쓰지 않는다."""
    from kb.commands import jobs
    from kb.extract import guard, route, state
    hold(route, state, guard)
    out = jobs.run_due()
    assert {out["skipped"][j] for j in CLAUDE_JOBS} == {"claude_" + reason} and not out["failed"]
    assert calls(env) == ["kb agent run --scope public"] and env["canaries"] == 0


def test_automatic_off_does_not_hold_jobs(env):
    """다음 회차에 재검사하는 끄기(5시간, 7일)는 지금 값으로 다시 판단한다."""
    from kb.commands import jobs
    from kb.extract import route
    route.set_off("claude", "seven_day", None, retry="next_run")
    route.set_off("claude", "daily_windows", route.settings.now_s() + 3600)
    assert {j["id"] for j in jobs.run_due()["ran"]} >= CLAUDE_JOBS


@pytest.mark.parametrize("fail", ["rate", "error"], ids=["no_rate_value", "canary_failed"])
def test_failing_canary_backs_off(env, fail):
    """리뷰 L2: 실패한 카나리아는 한 회차에 한 번이고, 물러나 있는 동안 다음 회차도 호출하지 않는다."""
    from kb.commands import jobs
    from kb.extract import route, settings, state
    if fail == "rate":
        env["rate"] = {"five_hour": None, "seven_day": None, "status": "allowed"}
    else:
        env["error"] = "boom"
    first = {"rate": "claude_preflight_no_rate_value", "error": "claude_preflight_canary_failed"}[fail]
    out = jobs.run_due()
    assert out["skipped"]["agents.fulfill"] == first and env["canaries"] == 1
    assert out["skipped"]["agents.liveness_review"] == out["skipped"]["metrics.retro"] == "claude_canary_backoff"
    assert jobs.run_due()["skipped"]["agents.fulfill"] == "claude_canary_backoff" and env["canaries"] == 1
    f = state.get(route.CANARY_FAIL_KEY)
    assert f["n"] == 1 and f["until"] - f["at"] == settings.get("claude.rate_recheck_s")

    state.put(route.CANARY_FAIL_KEY, dict(f, until=settings.now_s() - 1))       # 대기가 끝나면 다시 재고, 실패하면 두 배로 물러난다
    jobs.run_due()
    f = state.get(route.CANARY_FAIL_KEY)
    assert env["canaries"] == 2 and f["n"] == 2 and f["until"] - f["at"] == 2 * settings.get("claude.rate_recheck_s")

    env["rate"], env["error"] = {"five_hour": 0.1, "seven_day": 0.5, "status": "allowed", "isUsingOverage": False}, None
    state.put(route.CANARY_FAIL_KEY, dict(f, until=settings.now_s() - 1))
    assert {j["id"] for j in jobs.run_due()["ran"]} >= CLAUDE_JOBS and state.get(route.CANARY_FAIL_KEY) is None


def test_check_error_closes_the_gate(env, monkeypatch):
    from kb.commands import jobs
    from kb.extract import route

    def boom(be=None):
        raise RuntimeError("x")
    monkeypatch.setattr(route, "claude_job_gate", boom)
    out = jobs.run_due()
    assert {out["skipped"][j] for j in CLAUDE_JOBS} == {"claude_gate_error:RuntimeError"} and calls(env) == ["kb agent run --scope public"]


def test_dry_run_makes_no_check_and_no_claude_call(env):
    from kb.commands import jobs
    env["rate"]["seven_day"] = 0.95
    out = jobs.run_due(dry_run=True)
    assert env["canaries"] == 0 and len(out["ran"]) == 4 and calls(env) == []


def test_second_check_in_the_hour_costs_no_call(env):
    from kb.commands import jobs
    jobs.run_due()
    n = env["canaries"]
    from kb.core import opsdb
    c = opsdb.connect()
    try:
        for r in c.execute("SELECT k FROM tick_state WHERE k LIKE 'agentjob:%'").fetchall():
            c.execute("DELETE FROM tick_state WHERE k=?", (r[0],))
        c.commit()
    finally:
        c.close()
    jobs.run_due()
    assert env["canaries"] == n == 1
