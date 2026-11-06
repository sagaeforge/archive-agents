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


@pytest.mark.parametrize("how", ["preflight", "engine_off", "no_backend"])
def test_every_path_blocked_keeps_queue_forever(ent, how):
    H.ingest_doc()
    n = runner.queue_left()
    budget.set_balance(100.0)
    f = H.Fake("anthropic_api", True, H.extract_all(ent), preflight_ok=how != "preflight")
    orf = H.Fake("openrouter", True, H.extract_all(ent), preflight_ok=False)
    if how == "engine_off":
        route.set_off("anthropic_api", "auth_signature", None)
    bk = {"openrouter": orf} if how == "no_backend" else {"openrouter": orf, "anthropic_api": f}
    for _ in range(5):
        out = runner.run_agent("public", backends=bk, do_support=False)
        assert out["windows"] == 0 and out["failed"] == 0 and out["is_error"] is False
    assert not f.calls and not orf.calls
    assert runner.queue_left() == n and _dlq_n() == 0 and max(_attempts()) == 0


def test_real_failure_still_goes_to_dlq_and_dlq_retry_requeues(ent):
    from kb.cli import main
    H.ingest_doc()
    n = runner.queue_left()
    f = H.Fake("anthropic_api", True, error="boom")
    with settings.override(**NO_OR):
        for _ in range(3):
            c = opsdb.connect()
            try:
                c.execute("UPDATE queue SET next_at=NULL WHERE kind='l2'")
            finally:
                c.close()
            runner.run_agent("public", backends={"anthropic_api": f}, do_support=False)
    assert _dlq_n() == n and runner.queue_left() == 0
    route.clear_off("claude:fake")
    assert main(["dlq", "retry", "--json"]) == 0
    good = H.Fake("anthropic_api", True, H.extract_all(ent))
    for k in state.keys("llm:off:"):
        state.delete(k)
    with settings.override(**NO_OR):
        out = runner.run_agent("public", backends={"anthropic_api": good}, do_support=False)
    assert out["windows"] >= 1 and _dlq_n() == 0                       # 복구된다


def test_subscription_rate_does_not_block_api(ent):
    H.ingest_doc()
    state.put("claude:rate", {"five_hour": 1., "seven_day": 1., "isUsingOverage": True})
    f = H.Fake("anthropic_api", True, H.extract_all(ent))
    with settings.override(**NO_OR):
        assert runner.run_agent("public", backends={"anthropic_api": f}, do_support=False)["windows"] >= 1
    assert f.calls and route.stopped() is None


def _claude_run(ent, model, idx=(0, 1, 2), **kw):
    f = H.Fake("anthropic_api", True, _resp(ent, idx))
    with settings.override(**NO_OR, **{"claude.model": model}):
        return runner.run_agent("public", backends={"anthropic_api": f}, do_support=False, **kw), f


def _retract(ex):
    from kb.cli import main
    assert main(["claim", "retract", "--extractor", ex, "--json"]) == 0


@pytest.mark.parametrize("second", ["haiku2", "haiku"])
def test_retract_then_reextract_revives(ent, second, capsys):
    H.ingest_doc(text=DOC)
    _claude_run(ent, "haiku")
    assert len(H.claims("n.status='active'")) == 3
    _retract("l2:anthropic_api:haiku:extract-2")
    assert not H.claims("n.status='active'")
    out, _ = _claude_run(ent, second, reextract=True)
    active = H.claims("n.status='active'")
    assert len(active) == 3 and out["claims"] == 3 and out["revived"] == 3
    assert all(r[5] == f"l2:anthropic_api:{second}:extract-2" for r in active)
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
    f = H.Fake("anthropic_api", True, H.extract_all(ent))
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
            runner.run_agent("public", backends={"anthropic_api": f}, do_support=False)
        c = opsdb.connect()
        try:
            c.execute("UPDATE queue SET next_at=NULL WHERE kind='l2'")
        finally:
            c.close()
        out = runner.run_agent("public", backends={"anthropic_api": f}, do_support=False)
    assert len(f.calls) >= 1 and sum(1 for j in f.calls if H.GOOD["quote"] in j.window.text) == 1   # 재호출 없음
    assert out["windows"] >= 1 and len(H.events("extract.run")) == len(f.calls)
    assert len(H.claims()) == 1


def test_second_process_is_refused_by_lock(ent):
    H.ingest_doc()
    fd = runner._lock("public")
    assert fd is not None
    try:
        f = H.Fake("anthropic_api", True, H.extract_all(ent))
        with settings.override(**NO_OR):
            out = runner.run_agent("public", backends={"anthropic_api": f}, do_support=False)
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
    f = H.Fake("anthropic_api", True, H.extract_all(ent))
    with settings.override(**NO_OR):
        out = runner.run_agent("public", backends={"anthropic_api": f}, do_support=False)
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
                      {"anthropic_api": H.Fake("anthropic_api", True, lambda j: {"supported": True})}, route.Router({"anthropic_api": H.Fake("anthropic_api", True)}))
    assert seen == ["앞Q뒤", "s"]                              # 문맥과 주장 문장을 따로 검사한다


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


def test_support_does_not_fallback_to_subscription(ent):
    from kb.extract import support
    sid = H.ingest_doc()
    f = H.Fake("claude", True, lambda j: {"supported": True})
    r = support.judge({"id": "c", "snapshot": sid, "quote": "Q", "context": "Q", "statement": "s"},
                      {"claude": f}, route.Router({"claude": f}))
    assert not r["ok"] and not f.calls


URL2 = "https://example.test/shift.md"
SHIFT = "# 안내\n\n새로 앞에 붙은 문단은 추출 대상이 아닌 설명이다.\n\n" + "\n\n".join(S) + "\n"


def _confirmed_second_snapshot(ent):
    from kb.extract import tick_stage
    H.ingest_doc(url=URL2, text=DOC, fetched_at=1_793_000_000_000)
    _claude_run(ent, "haiku")
    H.ingest_doc(url=URL2, text=SHIFT, fetched_at=1_793_000_100_000, enqueue=False)
    assert tick_stage.run().detail["reconfirm"]["confirmed"] == 3
    return H.ingest_doc(url=URL2, text=SHIFT, fetched_at=1_793_000_100_000)


def test_confirm_rows_keep_text_sha_and_revive_after_confirm(ent):
    """claim.confirm이 만든 근거 행도 text_sha를 가지며, 확인된 주장도 철회 뒤 재추출로 되살아난다."""
    sid = _confirmed_second_snapshot(ent)
    con = H.gold()
    try:
        assert con.execute("SELECT count(*) FROM evidence WHERE snapshot_id=? AND text_sha IS NULL", (sid,)).fetchone()[0] == 0
        assert con.execute("SELECT count(*) FROM evidence WHERE snapshot_id=?", (sid,)).fetchone()[0] == 3
    finally:
        con.close()
    _retract("l2:anthropic_api:haiku:extract-2")
    assert not H.claims("n.status='active'")
    out, _ = _claude_run(ent, "haiku", reextract=True)
    assert out["revived"] == 3 and len(H.claims("n.status='active'")) == 3


def test_reextract_multi_window_after_confirm_keeps_claims(ent):
    """확인으로 복사된 옛 오프셋 때문에 나중 창이 앞 창에서 방금 재추출된 주장을 철회하지 않는다."""
    _confirmed_second_snapshot(ent)
    with settings.override(**{"window_chars": 80}):
        out, _ = _claude_run(ent, "haiku2", reextract=True)
    assert out["windows"] >= 2
    act = H.claims("n.status='active'")
    assert len(act) == 3, act
    assert not out.get("retracted"), out


def test_llmhttp_does_not_follow_redirect_or_env_proxy(env, monkeypatch):
    """업스트림 리다이렉트로 Authorization이 다른 곳에 가지 않고, 루프백 본문이 환경변수 프록시로 나가지 않는다."""
    import http.server
    import threading
    import urllib.error

    from kb.extract import llmhttp
    hits = []

    class Target(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            hits.append(self.headers.get("Authorization"))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *a):
            pass

    target = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Target)

    class Redirect(Target):
        def do_POST(self):
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{target.server_port}/stolen")
            self.end_headers()

    redirect = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
    for srv in (target, redirect):
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        budget.set_balance(100.)
        admission = budget.admit("openrouter", "m", "extract", .1)
        with pytest.raises(urllib.error.HTTPError):
            llmhttp.request_json(f"http://127.0.0.1:{redirect.server_port}/x", body={"model": "m"}, headers={"Authorization": "Bearer t"},
                                 admission=admission, engine="openrouter", model="m")
        budget.settle(admission, None)
        assert hits == []
        monkeypatch.setenv("http_proxy", f"http://127.0.0.1:{redirect.server_port}")
        monkeypatch.setenv("no_proxy", "")
        assert llmhttp.request_json(f"http://127.0.0.1:{target.server_port}/y", body={}) == {}
        assert hits == [None]
    finally:
        target.shutdown()
        redirect.shutdown()


def test_alias_candidates_skip_sensitive_entities_for_public_windows(env, monkeypatch):
    """first_party 엔티티의 별칭이 공개 창 본문에 나와도 라벨이 외부 프롬프트 후보에 들어가지 않는다. 민감 범위에서는 쓴다."""
    import kb.write.engine as eng
    import kb.write.fpgate as fp
    from kb.extract import windows
    from kb.ingest.process import Processor
    from kb.write import commit
    from kb.write.engine import project_pending
    monkeypatch.setattr(fp, "is_open", lambda: True)
    monkeypatch.setattr(eng, "fp_is_open", lambda led: True)
    H.put_entity("e:tool:public-one", "공개도구", aliases=["공개도구"])
    commit([{"kind": "entity.put", "actor": "user:sagae", "origin": "first_party", "subject": "e:tool:inner-one",
             "idem_key": "t:ent:inner", "payload": {"id": "e:tool:inner-one", "type": "Tool", "label": "내부전용라벨",
                                                    "domain": ["G"], "aliases": ["사내도구"]}}], "user:sagae")
    project_pending()
    proc = Processor({"item": "bundle", "contract": "kb-ingest/1", "batch_id": "t", "producer": "agent:t"}, fetch=False, write=False)
    try:
        text = "공개도구와 사내도구를 비교한다."
        assert {c["id"] for c in windows.candidates_for(proc, text)} == {"e:tool:public-one"}
        assert {c["id"] for c in windows.candidates_for(proc, text, public=False)} == {"e:tool:public-one", "e:tool:inner-one"}
    finally:
        proc.gold.close()

