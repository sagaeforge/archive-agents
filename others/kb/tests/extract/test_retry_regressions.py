"""리뷰 재현 결함의 회귀 시험: 전 경로 차단의 큐 유지, 낡은 활용률, 철회 뒤 재추출, 재추출 상한 이월, 크래시 창, 잠금, 일시 오류."""
import json

import pytest

from kb.core import opsdb
from kb.extract import budget, guard, route, runner, settings, state
from kb.extract.backends.claude import Claude
from kb.extract.types import Preflight

from . import helpers as H

S = ["샘플도구는 하루 최대 500건의 요청을 지원한다고 밝힌다.", "샘플도구는 파일 크기 상한을 2GB로 둔다고 밝힌다.", "샘플도구는 동시 연결을 최대 8개까지 허용한다고 밝힌다."]
DOC = "# 안내\n\n" + "\n\n".join(S) + "\n"
NO_OR = {"openrouter.enabled": False}


def _resp(subject, idx=(0, 1, 2)):
    def f(job):
        return {"claims": [H.claim_obj(subject, S[i][:-3], S[i][:-3] + "고 한다.") for i in idx if S[i] in job.window.text]}
    return f


def _dlq_n() -> int:
    c = opsdb.connect()
    try:
        return c.execute("SELECT count(*) FROM dlq").fetchone()[0]
    finally:
        c.close()


def _attempts() -> list:
    c = opsdb.connect()
    try:
        return [r[0] for r in c.execute("SELECT attempts FROM queue WHERE kind='l2'")]
    finally:
        c.close()


@pytest.mark.parametrize("how", ["preflight", "rate", "no_backend"])
def test_every_path_blocked_keeps_queue_forever(ent, how):
    H.ingest_doc()
    n = runner.queue_left()
    budget.set_balance(100.0)
    f = H.Fake("claude", True, H.extract_all(ent), preflight_ok=how != "preflight")
    orf = H.Fake("openrouter", True, H.extract_all(ent), preflight_ok=False)
    if how == "rate":
        state.put("claude:rate", {"five_hour": 0.6, "seven_day": 0.1})
    bk = {"openrouter": orf} if how == "no_backend" else {"openrouter": orf, "claude": f}
    for _ in range(5):
        out = runner.run_agent("public", backends=bk, do_support=False)
        assert out["windows"] == 0 and out["failed"] == 0 and out["is_error"] is False
    assert not f.calls and not orf.calls
    assert runner.queue_left() == n and _dlq_n() == 0 and max(_attempts()) == 0


def test_real_failure_still_goes_to_dlq_and_dlq_retry_requeues(ent):
    from kb.cli import main
    H.ingest_doc()
    n = runner.queue_left()
    f = H.Fake("claude", True, error="boom")
    with settings.override(**NO_OR):
        for _ in range(3):
            c = opsdb.connect()
            try:
                c.execute("UPDATE queue SET next_at=NULL WHERE kind='l2'")
            finally:
                c.close()
            runner.run_agent("public", backends={"claude": f}, do_support=False)
    assert _dlq_n() == n and runner.queue_left() == 0
    route.clear_off("claude:fake")
    assert main(["dlq", "retry", "--json"]) == 0
    good = H.Fake("claude", True, H.extract_all(ent))
    for k in state.keys("llm:off:"):
        state.delete(k)
    with settings.override(**NO_OR):
        out = runner.run_agent("public", backends={"claude": good}, do_support=False)
    assert out["windows"] >= 1 and _dlq_n() == 0                       # 복구된다


def test_stale_rate_is_rechecked_by_canary(ent, monkeypatch, tmp_path):
    p = H.make_fake_claude(tmp_path / "fc", {"claims": [H.claim_obj(ent, H.GOOD["quote"], H.GOOD["statement"])]})
    monkeypatch.setenv("KB_CLAUDE_BIN", str(p))
    H.ingest_doc()
    with settings.override(**NO_OR):
        Claude().preflight()                                           # 카나리아 0.1
        state.put("claude:rate", {"five_hour": 0.6, "seven_day": 0.1, "at": settings.now_s() - 7200})
        canary = state.get("claude:canary")
        canary["at"] = settings.now_s() - 8000
        state.put("claude:canary", canary)
        out = runner.run_agent("public", backends={"claude": Claude()}, do_support=False)
    assert out["windows"] >= 1 and out["by_backend"] == {"claude": out["windows"]}


def test_newer_canary_beats_stored_rate(ent, monkeypatch, tmp_path):
    p = H.make_fake_claude(tmp_path / "fc", {"claims": []})
    monkeypatch.setenv("KB_CLAUDE_BIN", str(p))
    H.ingest_doc()
    state.put("claude:rate", {"five_hour": 0.6, "seven_day": 0.1, "at": settings.now_s() - 100})
    with settings.override(**NO_OR):
        out = runner.run_agent("public", backends={"claude": Claude()}, do_support=False)
    assert out["windows"] >= 1


def test_seven_day_warning_without_five_hour_starts(ent):
    H.ingest_doc()
    f = H.Fake("claude", True, H.extract_all(ent), rate={"five_hour": None, "seven_day": 0.75})
    with settings.override(**NO_OR):
        out = runner.run_agent("public", backends={"claude": f}, do_support=False)
    assert out["windows"] >= 1 and state.get("claude:rate")["seven_day"] == 0.75
    assert route.apply("claude_five_hour", five_hour=None, seven_day=0.75, start=True).action == "none"
    assert route.apply("claude_five_hour", five_hour=None, seven_day=None, start=True).action == "skip"
    assert route.apply("claude_seven_day", seven_day=0.85).action == "stop"


def _claude_run(ent, model, idx=(0, 1, 2), **kw):
    f = H.Fake("claude", True, _resp(ent, idx))
    with settings.override(**NO_OR, **{"claude.model": model}):
        return runner.run_agent("public", backends={"claude": f}, do_support=False, **kw), f


def _retract(ex):
    from kb.cli import main
    assert main(["claim", "retract", "--extractor", ex, "--json"]) == 0


@pytest.mark.parametrize("second", ["haiku2", "haiku"])
def test_retract_then_reextract_revives(ent, second, capsys):
    H.ingest_doc(text=DOC)
    _claude_run(ent, "haiku")
    assert len(H.claims("n.status='active'")) == 3
    _retract("l2:claude:haiku:extract-1")
    assert not H.claims("n.status='active'")
    out, _ = _claude_run(ent, second, reextract=True)
    active = H.claims("n.status='active'")
    assert len(active) == 3 and out["claims"] == 3 and out["revived"] == 3
    assert all(r[5] == f"l2:claude:{second}:extract-1" for r in active)
    con = H.gold()
    try:
        assert con.execute("SELECT count(*) FROM evidence").fetchone()[0] == 3
    finally:
        con.close()


def test_retract_twice_revives_twice(ent, capsys):
    H.ingest_doc(text=DOC)
    _claude_run(ent, "haiku")
    for m in ("haiku2", "haiku3"):
        _retract(H.claims()[0][5])
        _claude_run(ent, m, reextract=True)
        assert len(H.claims("n.status='active'")) == 3


def test_reextract_over_cap_keeps_retract_rule(ent):
    """--reextract가 상한을 넘겨 다음 일반 회차로 이월돼도 옛 주장을 철회한다."""
    docs = "# 안내\n\n" + "\n\n".join(S) + "\n"
    H.ingest_doc(text=docs)
    with settings.override(**{"window_chars": 80}):
        _claude_run(ent, "haiku", (0, 1))
        assert len(H.claims("n.status='active'")) == 2
        out, _ = _claude_run(ent, "haiku2", (2,), reextract=True, max_windows=1)
        assert out["windows"] == 1 and runner.queue_left() > 0
        assert state.keys(runner.REEXTRACT)
        _claude_run(ent, "haiku2", (2,))
    assert runner.queue_left() == 0 and not state.keys(runner.REEXTRACT)
    active = H.claims("n.status='active'")
    assert len(active) == 1 and "동시 연결" in active[0][4]


def test_crash_between_cache_and_commit_keeps_run_record(ent, monkeypatch):
    import kb.write as w
    H.ingest_doc()
    f = H.Fake("claude", True, H.extract_all(ent))
    real = w.commit
    boom = {"n": 0}

    def flaky(evs, *a, **k):
        if evs and evs[0]["kind"] == "extract.run" and not boom["n"]:
            boom["n"] = 1
            raise RuntimeError("crash")
        return real(evs, *a, **k)
    monkeypatch.setattr(w, "commit", flaky)
    with settings.override(**NO_OR):
        with pytest.raises(RuntimeError):
            runner.run_agent("public", backends={"claude": f}, do_support=False)
        c = opsdb.connect()
        try:
            c.execute("UPDATE queue SET next_at=NULL WHERE kind='l2'")
        finally:
            c.close()
        out = runner.run_agent("public", backends={"claude": f}, do_support=False)
    assert len(f.calls) >= 1 and sum(1 for j in f.calls if H.GOOD["quote"] in j.window.text) == 1   # 재호출 없음
    assert out["windows"] >= 1 and len(H.events("extract.run")) == len(f.calls)
    assert len(H.claims()) == 1


def test_second_process_is_refused_by_lock(ent):
    H.ingest_doc()
    fd = runner._lock("public")
    assert fd is not None
    try:
        f = H.Fake("claude", True, H.extract_all(ent))
        with settings.override(**NO_OR):
            out = runner.run_agent("public", backends={"claude": f}, do_support=False)
        assert out["reason"] == "busy" and out["windows"] == 0 and not f.calls and out["is_error"] is False
    finally:
        runner._lock_gate("public").release(fd)


def test_backend_exception_releases_reservation(ent):
    H.ingest_doc()
    budget.set_balance(100.0)

    class Boom(H.Fake):
        def extract(self, job, permit):
            raise RuntimeError("x")
    with pytest.raises(RuntimeError):
        runner.run_agent("public", backends={"openrouter": Boom("openrouter", True)}, do_support=False)
    assert budget.day()["reserved"] == 0


def test_transient_guard_error_is_retried_not_lost(ent, monkeypatch):
    H.ingest_doc()
    n = runner.queue_left()
    monkeypatch.setattr(guard, "inspect_snapshot", lambda sid, text, con=None: {"text": text, "error": "OperationalError"})
    f = H.Fake("claude", True, H.extract_all(ent))
    with settings.override(**NO_OR):
        out = runner.run_agent("public", backends={"claude": f}, do_support=False)
    assert out["guarded"] >= 1 and not f.calls and runner.queue_left() == n
    monkeypatch.undo()


def test_support_guard_checks_context_not_only_quote(ent):
    from kb.extract import support
    seen = []
    real = guard.inspect_snapshot

    def spy(sid, text, con=None):
        seen.append(text)
        return real(sid, text, con)
    import unittest.mock as m
    sid = H.ingest_doc()
    with m.patch.object(guard, "inspect_snapshot", spy):
        support.judge({"id": "c", "snapshot": sid, "quote": "Q", "context": "앞Q뒤", "statement": "s", "extractor": ""},
                      {"claude": H.Fake("claude", True, lambda j: {"supported": True})}, route.Router({}))
    assert seen == ["앞Q뒤"]


def test_watchdog_counts_sensitive_queue(env):
    from kb.guard import watchdog
    assert "l2" in watchdog.L2_KINDS and "l2s" in watchdog.L2_KINDS


def test_preflight_keeps_seven_day_only_rate(env, monkeypatch, tmp_path):
    p = H.make_fake_claude(tmp_path / "fc", {"claims": []})
    monkeypatch.setenv("KB_CLAUDE_BIN", str(p))
    state.put("claude:canary", {"bin": str(p), "ok": True, "at": settings.now_s(), "five_hour": None,
                                "rate": {"five_hour": None, "seven_day": 0.75}})
    pf = Claude().preflight()
    assert pf.ok and pf.info["rate"]["seven_day"] == 0.75 and len(H.fake_claude_calls(p)) == 0
    assert isinstance(pf, Preflight) and json.dumps(pf.info)


def test_support_fallback_respects_claude_limits(ent):
    """함의 판정의 Claude 대체도 활용률 문턱을 지난다. 막히면 호출 0이고 큐에 남는다."""
    from kb.extract import support
    sid = H.ingest_doc()
    c = opsdb.connect()
    try:
        opsdb.queue_put(c, support.QUEUE, "c-x")
    finally:
        c.close()
    state.put("claude:rate", {"five_hour": None, "seven_day": 0.83, "at": settings.now_s()})
    f = H.Fake("claude", True, lambda j: {"supported": True})
    r = support.judge({"id": "c", "snapshot": sid, "quote": "Q", "context": "앞Q뒤", "statement": "s", "extractor": ""}, {"claude": f}, route.Router({}))
    assert r == {"ok": False, "reason": "claude_limit", "called": False} and not f.calls
