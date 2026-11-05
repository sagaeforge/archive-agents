"""Automatic subscription paths are absent, including canaries."""
from kb.extract import runner, route, settings
from . import helpers as H
NO_OR = {"openrouter.enabled": False}


def test_no_automatic_subscription_or_canary(ent, monkeypatch, tmp_path):
    from kb.extract.backends.claude import Claude
    p = H.make_fake_claude(tmp_path / "fc", {"claims": []})
    monkeypatch.setenv("KB_CLAUDE_BIN", str(p))
    H.ingest_doc()
    with settings.override(**NO_OR):
        out = runner.run_agent("public", backends={"claude": Claude()}, do_support=False)
    assert out["windows"] == 0 and H.fake_claude_calls(p) == []
    assert route.claude_job_gate() == "subscription_automatic_forbidden"
    assert runner.queue_left() == 4


def test_queue_af_before_g(ent):
    docs = [("G", 0), ("G", 1), ("A", 0), ("A", 1)]
    for dom, i in docs:
        H.ingest_doc(url=f"https://example.test/{dom}{i}.md", text=f"샘플도구는 하루 최대 500건의 요청을 지원한다 {dom}{i}.\n", domain=(dom,))
    f = H.Fake("anthropic_api", True, H.extract_all(ent))
    with settings.override(**NO_OR, take_batch=2):
        out = runner.run_agent("public", backends={"anthropic_api": f}, do_support=False, max_windows=2)
    assert out["windows"] == 2
    seen = [c.window.url for c in f.calls]
    assert all("/A" in u for u in seen)    # A~F가 G보다 먼저(리드 판정 2026-11-01, test_order.py)
