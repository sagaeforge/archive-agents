"""13번째 전환 신호 low_yield: 빈 응답({"claims": []})만 내는 모델은 gate_pass_drop에 잡히지 않으므로(빈 창은 이력에 안 쌓인다)
최근 switch.yield_window 창 중 빈 창 비율이 switch.yield_empty_ratio 이상이면 human=true로 끈다."""
import json

import pytest

from kb.cli import main
from kb.extract import budget, route, runner, settings, state

from . import helpers as H

SOL, ORH = "openai/gpt-6.1-sol", "anthropic/claude-haiku-5.5"
N = 10                                                   # 시험은 창을 10으로 줄인다. 기본값은 50, 0.6
PARAS = "# 안내\n\n" + "\n\n".join(f"문단 {i}번은 사실로 뽑을 내용이 없는 안내 문구다." for i in range(60)) + "\n"


def _empty_run(ent, **kw):
    fk = H.Fake("openrouter", True, lambda job: {"claims": []}, cost=0.01)
    with settings.override(**{"window_chars": 40, "switch.yield_window": N}):
        out = runner.run_agent("public", backends={"openrouter": fk}, do_support=False, **kw)
    return fk, out


def test_default_settings():
    assert settings.get("switch.yield_window") == 50 and settings.get("switch.yield_empty_ratio") == 0.6


def test_empty_responses_turn_model_off_with_human_and_stop_calls(ent):
    budget.set_balance(100.0)
    H.ingest_doc(text=PARAS)
    fk, out = _empty_run(ent)
    off = state.get(route.off_key(SOL))
    assert off and off["reason"] == "low_yield" and off["human"] is True and off["until"] is None
    assert len(state.get("llm:yield:" + SOL)) == N
    assert len(fk.calls) == 2 * N                         # Sol N창, 꺼진 뒤 Haiku N창
    assert state.get(route.off_key(ORH))["reason"] == "low_yield"
    assert "openrouter" not in [c.backend for c in route.Router().plan("public", "extract").cands]   # 두 모델 모두 계획에서 빠진다
    fk.calls.clear()
    runner.run_agent("public", backends={"openrouter": fk}, do_support=False)
    assert fk.calls == []                                 # 꺼진 뒤 더 부르지 않는다
    assert state.get("llm:gatepass:" + SOL) is None       # 빈 창은 gate_pass_drop 이력에 안 쌓인다


@pytest.fixture
def gate20():
    """gate_window의 운영값은 50이다(2026-11-01). 이 시험은 20창 동작을 단언하므로 시험에서만 20으로 덮는다."""
    with settings.override(**{"switch.gate_window": 20}):
        yield


def test_normal_mix_never_trips_and_gate_pass_drop_unchanged(env, gate20):
    budget.set_balance(100.0)
    with settings.override(**{"switch.yield_window": 50}):
        for cycle in range(6):                            # 50창 중 7개 빈 창(14%)을 여러 바퀴
            for i in range(50):
                v = route.apply("low_yield", key=SOL, empty=(i % 7 == 0 and i < 49))
                assert v.action == "none"
    assert not route.is_off(SOL, settings.now_s() + 10**7)
    # 경계: 빈 창 비율 0.6 이상이면 창이 가득 찬 때에만 끈다
    state.delete("llm:yield:" + SOL)
    with settings.override(**{"switch.yield_window": 50}):
        for i in range(49):
            assert route.apply("low_yield", key=SOL, empty=True).action == "none"       # 가득 차기 전에는 판정하지 않는다
        assert route.apply("low_yield", key=SOL, empty=True).action == "off"
    route.clear_off(SOL)
    state.delete("llm:yield:" + SOL)
    with settings.override(**{"switch.yield_window": 50}):
        for i in range(50):
            v = route.apply("low_yield", key=SOL, empty=(i < 29))                       # 29/50 = 0.58
        assert v.action == "none"
    # gate_pass_drop은 그대로: 낮은 20창이면 꺼진다, 좋은 창이면 안 꺼진다
    state.delete("llm:gatepass:" + SOL)
    for _ in range(19):
        assert route.apply("gate_pass_drop", key=SOL, passed=5, total=10).action == "none"
    assert route.apply("gate_pass_drop", key=SOL, passed=5, total=10).action == "off"


def test_reenable_archives_yield_and_does_not_retrip(env, monkeypatch, capsys):
    monkeypatch.delenv("KB_LIVE", raising=False)
    with settings.override(**{"switch.yield_window": N}):
        for _ in range(N):
            v = route.apply("low_yield", key=SOL, empty=True)
        assert v.action == "off"
        old = state.get("llm:yield:" + SOL)
        rc = main(["llm", "reenable", "--model", SOL, "--by", "user", "--basis", "retro ok", "--apply", "--json"])
        out = json.loads(capsys.readouterr().out)
        assert rc == 0 and not route.is_off(SOL, settings.now_s() + 10**7)
        arch = out["yield_archive_key"]
        assert arch.startswith(f"llm:yield:archive:{SOL}:") and state.get(arch) == old
        assert state.get("llm:yield:" + SOL) is None
        assert state.get("llm:reenable_log")[-1]["yield_archived"] == arch
        assert route.apply("low_yield", key=SOL, empty=True).action == "none"          # 다음 창에서 바로 다시 꺼지지 않는다
        assert not route.is_off(SOL, settings.now_s() + 10**7)
        for _ in range(N - 1):
            v = route.apply("low_yield", key=SOL, empty=True)
        assert v.action == "off"                                                       # 빈 창이 계속되면 다시 꺼진다


def test_kb_live_must_be_exactly_1(env, monkeypatch, capsys):
    from kb.commands import llm
    route.set_off(SOL, "low_yield", None, human=True)
    monkeypatch.setattr(llm, "_live_home", lambda: True)
    monkeypatch.setenv("KB_LIVE", "yes")
    rc = main(["llm", "reenable", "--model", SOL, "--by", "user", "--basis", "x", "--apply"])
    capsys.readouterr()
    assert rc == 2 and route.is_off(SOL, settings.now_s() + 10**7)


def test_gate_pass_drop_off_on_claude_model_key_stops_claude(env):
    """anthropic_api:haiku 키에 쓴 끔이 계획에서 Claude를 빼지 않던 결함(_claude_ok가 'anthropic_api'만 봤다)."""
    budget.set_balance(100.0)
    with settings.override(**{"openrouter.enabled": False}):
        assert [c.backend for c in route.Router({"anthropic_api": H.Fake("anthropic_api", True)}).plan("public", "extract").cands][:1] == ["anthropic_api"]
        route.set_off("anthropic_api:haiku", "gate_pass_drop", None, human=True)
        assert "anthropic_api" not in [c.backend for c in route.Router({"anthropic_api": H.Fake("anthropic_api", True)}).plan("public", "extract").cands]
