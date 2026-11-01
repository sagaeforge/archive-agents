"""ADR-0003 2장 표 전 행: 범위와 잔액 상태별 1순위와 대체 순서. 전부 막히면 큐에 남기고 외부 호출 0. 추출 제외 자료 호출 0. codex.enabled=false면 후보에서 빠진다."""
from kb.extract import budget, guard, route, runner, settings

from . import helpers as H

SOL, ORH, SONNET = "openai/gpt-6.1-sol", "anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5"


def names(plan):
    return [(c.backend, c.model) for c in plan.cands]


def test_public_with_balance(env):
    budget.set_balance(100.0)
    p = route.Router().plan("public", "extract")
    assert names(p) == [("openrouter", SOL), ("openrouter", ORH), ("claude", "haiku")]      # Codex는 꺼져 있다
    assert p.cands[0].reason == "or:balance"
    with settings.override(**{"codex.enabled": True}):
        assert names(route.Router().plan("public", "extract"))[-1] == ("codex", "gpt-6.1-sol")


def test_public_after_exhaustion(env):
    budget.set_balance(0.05)
    p = route.Router().plan("public", "extract")
    assert names(p) == [("claude", "haiku")] and p.cands[0].reason == "claude:post_exhaustion"
    with settings.override(**{"codex.enabled": True}):
        assert names(route.Router().plan("public", "extract")) == [("claude", "haiku"), ("codex", "gpt-6.1-sol")]


def test_sensitive_extract_sllm_only(env):
    p = route.Router().plan("sensitive", "extract")
    assert names(p) == [("sllm", settings.get("sllm.model"))]
    assert all(c.backend == "sllm" for c in p.cands)               # 대체 없음, 외부로 넘기지 않는다


def test_excluded_no_route(env):
    p = route.Router().plan("excluded", "extract")
    assert p.cands == [] and p.stop == "excluded"


def test_sensitive_classify_sllm(env):
    assert names(route.Router().plan("sensitive", "classify")) == [("sllm", settings.get("sllm.model"))]


def test_sensitive_recheck_none(env):
    p = route.Router().plan("sensitive", "support")
    assert p.cands == [] and p.stop == "sensitive_no_judge"        # 민감 범위 주장은 needs_review 유지


def test_support_routes(env):
    budget.set_balance(100.0)
    assert names(route.Router().plan("public", "support")) == [("claude", "haiku")]      # 보정 전
    with settings.override(**{"openrouter.support_calibrated": True}):
        assert names(route.Router().plan("public", "support")) == [("openrouter", SONNET), ("claude", "haiku")]
    budget.set_balance(0.01)
    with settings.override(**{"openrouter.support_calibrated": True}):
        assert names(route.Router().plan("public", "support")) == [("claude", "haiku")]


def test_cross_check_other_vendor(env):
    budget.set_balance(100.0)
    p = route.Router().plan("public", "cross", extractor=SOL)
    assert names(p)[0] == ("openrouter", SONNET) and names(p)[-1] == ("claude", "sonnet") and p.cands[-1].same_vendor
    assert p.cands[-1].budget_usd == 0.05
    p = route.Router().plan("public", "cross", extractor="haiku")
    assert names(p)[0] == ("openrouter", SOL)
    with settings.override(**{"codex.enabled": True}):
        assert [c.backend for c in route.Router().plan("public", "cross", extractor=SOL).cands] == ["openrouter", "codex", "claude"]


def test_quote_recheck_has_no_llm_route(env):
    assert route.Router().plan("public", "reconfirm").cands == []


def test_all_blocked_leaves_queue_zero_external_calls(ent):
    H.ingest_doc()
    f = {"claude": H.Fake("claude", True, H.extract_all(ent)), "openrouter": H.Fake("openrouter", True, H.extract_all(ent)),
         "codex": H.Fake("codex", True, H.extract_all(ent))}
    route.set_off("claude", "manual", None)
    budget.set_balance(0.0)
    with settings.override(**{"codex.enabled": False}):
        out = runner.run_agent("public", backends=f, do_support=False)
    assert out["windows"] == 0 and all(not b.calls for b in f.values())
    assert runner.queue_left() == 4                               # 큐에 남는다
    assert out["reason"] is not None


def test_excluded_material_zero_calls(ent, monkeypatch):
    H.ingest_doc()
    f = H.Fake("claude", True, H.extract_all(ent))
    monkeypatch.setattr(guard, "inspect_snapshot", lambda sid, text, con=None: {"text": text, "origin": "first_party", "sensitivity": 0, "display": "f:agent:s1"})
    with settings.override(**{"openrouter.enabled": False}):
        out = runner.run_agent("public", backends={"claude": f}, do_support=False)
    assert not f.calls and out["windows"] == 0


def test_codex_disabled_zero_calls(ent):
    H.ingest_doc()
    cx = H.Fake("codex", True, H.extract_all(ent))
    route.set_off("claude", "manual", None)
    with settings.override(**{"openrouter.enabled": False}):
        out = runner.run_agent("public", backends={"codex": cx}, do_support=False)
    assert not cx.calls and out["windows"] == 0
