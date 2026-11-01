"""ADR-0003 5장 전환 표 12행: 신호 -> 판정과 조치 -> 복귀. 일일 밸브 도달 뒤 다른 경로 호출 0. 호출당 비용 초과는 배치 정지와 사고 기록. 전 경로 동시 하락은 전환 없이 L2 정지."""
import datetime as dt

from kb.core import opsdb
from kb.extract import budget, guard, route, runner, settings, state

from . import helpers as H

SOL, ORH = "openai/gpt-6.1-sol", "anthropic/claude-haiku-5.5"


def plan_names(scope="public", purpose="extract"):
    return [(c.backend, c.model) for c in route.Router().plan(scope, purpose).cands]


def incidents():
    c = opsdb.connect()
    try:
        return [r[0] for r in c.execute("SELECT kind FROM incident")]
    finally:
        c.close()


def test_table_has_12_rows():
    assert len(route.SWITCH_TABLE) == 12 and len(set(route.SWITCH_TABLE)) == 12


def test_01_balance_exhausted(env):
    budget.set_balance(100.0)
    assert plan_names()[0][0] == "openrouter"
    v = route.apply("balance_exhausted", balance=0.05)
    assert v.action == "off" and plan_names() == [("claude", "haiku")]
    route.clear_off("openrouter")                                   # 복귀: 충전 또는 새 키
    budget.set_balance(50.0)
    assert plan_names()[0][0] == "openrouter"
    assert route.apply("balance_exhausted", http=402).action == "off"      # HTTP 402도 같다


def test_02_key_missing_expired_401(envk):
    budget.set_balance(100.0)
    for kw in ({"missing": True}, {"expired": True}, {"http": 401}):
        route.clear_off("openrouter")
        assert route.apply("key_invalid", **kw).action == "off"
        assert plan_names() == [("claude", "haiku")]
    route.clear_off("openrouter")
    assert plan_names()[0][0] == "openrouter"                       # 새 키


def test_03_daily_valve_no_fallthrough(ent, monkeypatch):
    budget.set_balance(500.0)
    H.ingest_doc()
    v = route.apply("daily_valve", spent=29.99, reserve=0.054)
    assert v.action == "off" and v.fallthrough is False
    p = route.Router().plan("public", "extract")
    assert p.cands == [] and p.stop == "daily_valve"                 # 대체 경로로 넘기지 않는다
    f = {"openrouter": H.Fake("openrouter", True, H.extract_all(ent), cost=0.03), "claude": H.Fake("claude", True, H.extract_all(ent))}
    out = runner.run_agent("public", backends=f, do_support=False)
    assert out["windows"] == 0 and not f["openrouter"].calls and not f["claude"].calls      # 구독으로 번지지 않는다
    monkeypatch.setenv("KB_EXTRACT_NOW", str(settings.next_kst_midnight_s() + 60))        # 복귀: 다음 KST 0시
    assert plan_names()[0][0] == "openrouter"


def test_03b_valve_reached_by_spend(ent):
    budget.set_balance(500.0)
    H.ingest_doc()
    r = budget.reserve(29.97)
    budget.settle(r, 29.97)
    f = {"openrouter": H.Fake("openrouter", True, H.extract_all(ent), cost=0.03), "claude": H.Fake("claude", True, H.extract_all(ent))}
    out = runner.run_agent("public", backends=f, do_support=False)
    assert out["windows"] == 0 and not f["claude"].calls and not f["openrouter"].calls


def test_04_cost_exceeded_stops_batch_and_incident(ent):
    budget.set_balance(100.0)
    for i in range(3):
        H.ingest_doc(url=f"https://example.test/c{i}.md", text=f"# 문서 {i}\n\n샘플도구는 하루 최대 500건의 요청을 지원한다 {i}번째.\n")
    f = H.Fake("openrouter", True, H.extract_all(ent), cost=0.20)          # 예약 0.054 < 실제 0.20
    out = runner.run_agent("public", backends={"openrouter": f, "claude": H.Fake("claude", True)}, do_support=False)
    assert len(f.calls) == 1 and out["reason"] == "cost_exceeded"           # 그 배치 정지
    assert "other" in incidents() and route.stopped() == "cost_exceeded"    # 사고 기록, 사람이 확인할 때까지


def test_05_claude_five_hour(env):
    budget.set_balance(0.0)
    assert route.apply("claude_five_hour", five_hour=0.6, start=True).action == "skip"
    route.clear_off("claude")
    assert route.apply("claude_five_hour", five_hour=0.5, start=True).action == "none"      # 0.5는 시작 가능
    assert route.apply("claude_five_hour", five_hour=0.7, start=False).action == "stop"
    assert route.apply("claude_five_hour", five_hour=None, start=True).action == "skip"      # 값 없음
    assert plan_names()[0][0] == "claude"                           # 다음 회차에 재검사하므로 후보에는 남는다


def test_06_claude_seven_day(env):
    assert route.apply("claude_seven_day", seven_day=0.79).action == "none"
    assert route.apply("claude_seven_day", seven_day=0.80).action == "stop"


def test_07_claude_overage_incident(env):
    v = route.apply("claude_overage", isUsingOverage=True)
    assert v.action == "halt" and v.incident and "other" in incidents()
    assert route.Router().plan("public", "extract").cands == []      # 사람이 확인할 때까지 정지


def test_08_claude_daily_windows(env):
    budget.set_balance(0.0)
    budget.count_window("claude", 399)
    assert route.apply("claude_daily_windows").action == "none"
    budget.count_window("claude", 1)
    assert route.apply("claude_daily_windows").action == "off"
    assert plan_names() == []
    assert route.is_off("claude", settings.next_kst_midnight_s() + 1) is False        # 다음 KST 0시에 풀린다


def test_09_codex_limit_no_credits(env):
    with settings.override(**{"codex.enabled": True}):
        assert route.apply("codex_limit", ordinaryUsageAllowed=True, usedPercent=49).action == "none"
        v = route.apply("codex_limit", ordinaryUsageAllowed=True, usedPercent=50, resetsAt=settings.now_s() + 100)
        assert v.action == "off"
        assert ("codex", "gpt-6.1-sol") not in plan_names()
        assert route.is_off("codex", settings.now_s() + 200) is False       # resetsAt 뒤 재검사
        route.clear_off("codex")
        assert route.apply("codex_limit", ordinaryUsageAllowed=False, usedPercent=1).action == "off"


def test_10_error_rate(env):
    budget.set_balance(100.0)
    for i in range(4):
        assert route.apply("error_rate", key=SOL, error=True).action == "none"
    v = route.apply("error_rate", key=SOL, error=True)                    # 연속 5회
    assert v.action == "off" and (SOL, ) is not None
    assert ("openrouter", SOL) not in plan_names() and ("openrouter", ORH) in plan_names()
    assert route.is_off(SOL, settings.now_s() + 3601) is False            # 1시간 뒤 카나리아 통과로 복귀
    state.delete("llm:health:" + ORH)
    for i in range(50):                                                   # 50호출 중 20%
        v = route.apply("error_rate", key=ORH, error=(i % 5 == 0))
    assert route.is_off(ORH)


def test_11_gate_pass_drop(env):
    budget.set_balance(100.0)
    key = SOL
    v = None
    for i in range(20):
        v = route.apply("gate_pass_drop", key=key, passed=5, total=10)     # 0.5 < 0.823 * 0.85
    assert v.action == "off" and ("openrouter", SOL) not in plan_names()
    assert route.is_off(key, settings.now_s() + 10**7)                    # 사람이 켤 때까지 꺼져 있다
    route.clear_off(key)
    state.delete("llm:gatepass:" + key)
    for i in range(20):
        v = route.apply("gate_pass_drop", key=key, passed=7, total=10)     # 0.7 >= 0.70 문턱
    assert v.action == "none"


def test_12_all_paths_down_stops_without_switching(ent):
    budget.set_balance(100.0)
    H.ingest_doc()
    for _ in range(5):
        route.apply("error_rate", key=SOL, error=True)
    assert route.stopped() is None
    for _ in range(5):
        route.apply("error_rate", key="claude:haiku", error=True)             # 같은 날 두 번째 경로 하락
    assert route.stopped() == "all_paths_down"
    f = {"openrouter": H.Fake("openrouter", True, H.extract_all(ent), cost=0.03), "claude": H.Fake("claude", True, H.extract_all(ent))}
    out = runner.run_agent("public", backends=f, do_support=False)
    assert out["windows"] == 0 and out["reason"] == "all_paths_down"
    assert not f["openrouter"].calls and not f["claude"].calls                 # 전환하지 않고 L2 정지
