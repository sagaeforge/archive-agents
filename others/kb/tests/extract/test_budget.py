"""ADR-0003 4장: 일일 창 수, 일일 밸브와 KST 자정 초기화, 예약과 정산, 내부 장부가 기준, 소진 순서, kb status의 llm 블록."""
import datetime as dt

import pytest

from kb.extract import budget, runner, settings, state
from kb.extract.backends.openrouter import OpenRouter

from . import helpers as H

KST = dt.timezone(dt.timedelta(hours=9))


def at(s: str) -> str:
    return str(dt.datetime.fromisoformat(s).timestamp())


def test_daily_windows_formula(env, monkeypatch):
    budget.set_balance(145.24)
    monkeypatch.setenv("KB_EXTRACT_NOW", at("2026-11-01T00:00:00+09:00"))
    assert budget.daily_window_cap() == 400                          # 잔액 / 남은 일수 / 단가가 400 미만이면 400
    monkeypatch.setenv("KB_EXTRACT_NOW", at("2026-11-25T19:41:00+09:00"))
    left = budget.key_days_left()
    want = int(145.24 / left / budget.avg_price())
    assert budget.daily_window_cap() == max(400, want) and want > 400


def test_avg_price_follows_actual_spend(env):
    budget.set_balance(100.0)
    for _ in range(4):
        r = budget.reserve(0.054)
        budget.settle(r, 0.04)
    assert abs(budget.avg_price() - 0.04) < 1e-9


def test_valve_and_kst_midnight_reset(env, monkeypatch):
    budget.set_balance(500.0)
    monkeypatch.setenv("KB_EXTRACT_NOW", at("2026-11-02T23:30:00+09:00"))
    r = budget.reserve(29.9)
    budget.settle(r, 29.9)
    with pytest.raises(budget.Refused) as e:
        budget.reserve(0.2)                                          # 29.9 + 0.2 > 30
    assert e.value.reason == "valve"
    monkeypatch.setenv("KB_EXTRACT_NOW", at("2026-11-03T00:05:00+09:00"))   # KST 자정 뒤
    budget.reserve(0.2)                                              # 초기화됐다


def test_reserve_then_settle_and_internal_ledger(envk):
    budget.set_balance(10.0)
    r = budget.reserve(0.054)
    assert abs(budget.day()["reserved"] - 0.054) < 1e-9
    over = budget.settle(r, 0.03)
    assert over is False and abs(budget.balance() - 9.97) < 1e-9 and budget.day()["reserved"] == 0
    r = budget.reserve(0.054)
    assert budget.settle(r, 0.06) is True                            # 실제 > 예약


def test_credits_failure_only_warns(envk, monkeypatch):
    from kb.extract.backends import openrouter as orb
    budget.set_balance(50.0)
    monkeypatch.setattr(orb, "fetch_credits", lambda k: None)
    p = OpenRouter().preflight()
    assert p.ok and p.warn == "credits_check_failed" and budget.balance() == 50.0   # 장부가 기준, /credits 실패는 경고만


def test_initial_balance_from_credits(envk):
    srv = H.OrServer(balance=77.5)
    try:
        with settings.override(**{"openrouter.base_url": srv.url}):
            p = OpenRouter().preflight()
    finally:
        srv.close()
    assert p.ok and abs(budget.balance() - 77.5) < 1e-6


def test_exhaustion_order_extract_then_support_then_cross(envk, ent):
    """소진 순서: 추출 큐 -> 함의 판정 -> 교차 확인 확대."""
    assert budget.ORDER == ("extract", "support", "cross")
    budget.set_balance(100.0)
    H.ingest_doc()
    seq = []

    def resp(job):
        seq.append(job.purpose)
        if job.purpose in ("support", "cross"):
            return {"supported": True}
        return {"claims": [H.claim_obj(ent, H.GOOD["quote"], "샘플도구는 하루 최대 600건의 요청을 지원한다.", value="600")]}
    f = H.Fake("openrouter", True, resp, cost=0.03)
    cl = H.Fake("claude", True, resp)
    with settings.override(**{"openrouter.support_calibrated": True}):
        out = runner.run_agent("public", backends={"openrouter": f, "claude": cl}, do_cross=True)
    assert seq[0] == "extract" and "support" in seq
    assert seq.index("support") > seq.index("extract")
    assert out["support"]["supported"] == 1
    assert out["cross"]["sampled"] >= 1 and "cross" in seq and seq.index("cross") > seq.index("support")
    assert all(r[2] == "quote_found" for r in H.claims())             # 뒷받침되어 올라갔다
    assert len(H.events("claim.assert")) == 1


def test_status_llm_block_same_ledger(envk, monkeypatch):
    from kb.guard import status
    monkeypatch.setenv("KB_EXTRACT_NOW", at("2026-11-20T12:00:00+09:00"))
    budget.set_balance(100.0)
    r = budget.reserve(0.054)
    budget.settle(r, 7.0)
    blk = budget.llm_block()
    st = status.build()["llm"]
    assert st == blk and set(st) == {"balance_usd", "spend_7d_avg_usd", "projected_underspend_usd", "key_days_left"}
    assert st["balance_usd"] == 93.0 and abs(st["spend_7d_avg_usd"] - 1.0) < 1e-3
    left = st["key_days_left"]
    assert abs(st["projected_underspend_usd"] - round(93.0 - 1.0 * left, 4)) < 0.01 and 10.0 < left < 11.0


def test_status_llm_block_null_without_ledger(env):
    from kb.guard import status
    st = status.build()["llm"]
    assert st == {"balance_usd": None, "spend_7d_avg_usd": None, "projected_underspend_usd": None, "key_days_left": None}


def test_status_llm_failure_does_not_break_status(env, monkeypatch):
    from kb.guard import status
    monkeypatch.setattr(budget, "llm_block", lambda: (_ for _ in ()).throw(RuntimeError("x")))
    s = status.build()
    assert s["llm"] is None and "counts" in s
