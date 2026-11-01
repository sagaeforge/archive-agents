"""Claude 경로의 값: 호출 플래그, 일일 400창, 함의 판정 대체 100건, 활용률 문턱, stream-json, 큐 도메인 순환."""
import pytest

from kb.extract import budget, runner, settings
from kb.extract.backends.claude import Claude

from . import helpers as H

NO_OR = {"openrouter.enabled": False}


def _claude(tmp, monkeypatch, out, **cfg):
    p = H.make_fake_claude(tmp / "fc", out, **cfg)
    monkeypatch.setenv("KB_CLAUDE_BIN", str(p))
    return p


def test_flags_every_call(ent, monkeypatch, tmp_path):
    out = {"claims": [H.claim_obj(ent, H.GOOD["quote"], H.GOOD["statement"])]}
    p = _claude(tmp_path, monkeypatch, out)
    H.ingest_doc()
    with settings.override(**NO_OR):
        r = runner.run_agent("public", backends={"claude": Claude()}, do_support=False)
    assert r["windows"] == 1 and r["by_backend"] == {"claude": 1}
    calls = H.fake_claude_calls(p)
    assert len(calls) == 2                                   # 카나리아 1회 + 실제 1회
    for c in calls:
        a = c["argv"]
        assert a[a.index("--max-turns") + 1] == "3"
        assert a[a.index("--max-budget-usd") + 1] == "0.02"
        assert "--effort" not in a
        assert a[a.index("--output-format") + 1] == "stream-json" and "--verbose" in a
        assert a[a.index("--tools") + 1] == "" and a[a.index("--setting-sources") + 1] == ""
        assert "--strict-mcp-config" in a and "--no-session-persistence" in a and a[a.index("--permission-prompts") + 1] == "none"
        assert "--model" in a and a[a.index("--model") + 1] == "haiku"
        assert set(c["env"]) <= {"HOME", "PATH", "LANG", "DISABLE_AUTOUPDATER", "RTK_DISABLED"} | {"LC_CTYPE"}   # env -i
        assert "<document>" in c["stdin"]                    # 입력은 stdin


def test_daily_window_cap(ent):
    for i in range(3):
        H.ingest_doc(url=f"https://example.test/d{i}.md", text=f"# 문서 {i}\n\n샘플도구는 하루 최대 500건의 요청을 지원한다 {i}번째.\n")
    f = H.Fake("claude", True, H.extract_all(ent))
    with settings.override(**NO_OR, **{"claude.daily_windows": 2}):
        out = runner.run_agent("public", backends={"claude": f}, do_support=False, max_windows=10)
    assert out["windows"] == 2 and len(f.calls) == 2
    assert out["reason"] in ("daily_windows", "off")
    assert runner.queue_left() >= 1                          # 나머지는 큐에 남는다


def test_support_daily_cap_100(ent):
    from kb.extract import route
    assert settings.get("claude.support_daily") == 100
    for _ in range(100):
        budget.count_window("claude", support=True)
    plan = route.Router().plan("public", "support")
    assert plan.cands == [] and plan.stop == "support_daily"


def test_start_threshold(ent):
    H.ingest_doc()
    f = H.Fake("claude", True, H.extract_all(ent))
    from kb.extract import state
    state.put("claude:rate", {"five_hour": 0.6, "seven_day": 0.1})
    with settings.override(**NO_OR):
        out = runner.run_agent("public", backends={"claude": f}, do_support=False)
    assert out["windows"] == 0 and not f.calls               # 시작 시 > 0.5


def test_stop_at_070_midrun(ent):
    for i in range(3):
        H.ingest_doc(url=f"https://example.test/m{i}.md", text=f"# 문서 {i}\n\n샘플도구는 하루 최대 500건의 요청을 지원한다 {i}번째.\n")
    f = H.Fake("claude", True, H.extract_all(ent), rate={"five_hour": 0.71, "seven_day": 0.1})
    with settings.override(**NO_OR):
        out = runner.run_agent("public", backends={"claude": f}, do_support=False, max_windows=10)
    assert out["windows"] == 1 and len(f.calls) == 1         # 0.7 이상이면 멈춘다
    assert runner.queue_left() == 4


def test_no_rate_value_does_not_start(ent, monkeypatch, tmp_path):
    p = _claude(tmp_path, monkeypatch, {"claims": []}, no_rate=True)
    H.ingest_doc()
    with settings.override(**NO_OR):
        out = runner.run_agent("public", backends={"claude": Claude()}, do_support=False)
    assert out["windows"] == 0
    assert len(H.fake_claude_calls(p)) == 1                  # 카나리아만, 실제 호출 0
    assert runner.queue_left() == 4


def test_seven_day_stops(ent):
    H.ingest_doc()
    f = H.Fake("claude", True, H.extract_all(ent))
    from kb.extract import state
    state.put("claude:rate", {"five_hour": 0.1, "seven_day": 0.85})
    with settings.override(**NO_OR):
        out = runner.run_agent("public", backends={"claude": f}, do_support=False)
    assert out["windows"] == 0 and not f.calls


def test_queue_domain_round_robin(ent):
    docs = [("G", 0), ("G", 1), ("A", 0), ("A", 1)]
    for dom, i in docs:
        H.ingest_doc(url=f"https://example.test/{dom}{i}.md", text=f"샘플도구는 하루 최대 500건의 요청을 지원한다 {dom}{i}.\n", domain=(dom,))
    f = H.Fake("claude", True, H.extract_all(ent))
    with settings.override(**NO_OR, take_batch=2):
        out = runner.run_agent("public", backends={"claude": f}, do_support=False, max_windows=2)
    assert out["windows"] == 2
    seen = [c.window.url for c in f.calls]
    assert any("/G" in u for u in seen) and any("/A" in u for u in seen)    # 한 도메인이 큐를 독점하지 않는다
