"""OpenRouter 소진 정책과 일일 장부(ADR-0003 4장). 내부 장부가 잔액 기준이고 /credits는 대조용이다.
ops.db의 기존 tick_state, metric 표만 쓴다. 호출 전 예약, 호출 뒤 정산. 일일 경계는 KST 자정이다."""
from __future__ import annotations

import datetime as _dt
import math

from kb.extract import settings, state

BAL = "llm:or:balance"
DEFAULT_PRICE = 0.032337          # [실측] Sol 19창 평균
ORDER = ("extract", "support", "cross")   # 소진 순서: 추출 큐 -> 함의 판정 -> 교차 확인 확대


def day_key(day: str | None = None) -> str:
    return "llm:day:" + (day or settings.kst_day())


def day(day_s: str | None = None) -> dict:
    d = state.get(day_key(day_s)) or {}
    d.setdefault("spent", 0.0)
    d.setdefault("reserved", 0.0)
    d.setdefault("windows", {})
    d.setdefault("support", {})
    d.setdefault("valve_hits", 0)
    d.setdefault("openrouter_windows", 0)
    return d


def _save_day(d: dict, day_s: str | None = None) -> None:
    state.put(day_key(day_s), d)


# ------------------------------------------------------------------ 잔액
def balance() -> float | None:
    b = state.get(BAL)
    return None if b is None else float(b["usd"])


def set_balance(usd: float, source: str = "credits") -> None:
    state.put(BAL, {"usd": round(float(usd), 6), "at": settings.now_s(), "source": source})


def key_days_left(now_s: float | None = None) -> float | None:
    exp = settings.get("openrouter.key_expires_at")
    if not exp:
        return None
    t = _dt.datetime.fromisoformat(str(exp)).timestamp()
    return round(max(0.0, (t - (now_s if now_s is not None else settings.now_s())) / 86400.0), 2)


def spend_7d(now_s: float | None = None) -> tuple:
    """(7일 평균 일 지출, OpenRouter 추출 평균 단가 | None)."""
    now = now_s if now_s is not None else settings.now_s()
    tot, wins, dollars = 0.0, 0, 0.0
    for i in range(7):
        d = day(settings.kst_day(now - 86400 * i))
        tot += d["spent"]
        wins += d.get("openrouter_windows", 0)
        dollars += d.get("openrouter_extract_usd", 0.0)
    return tot / 7.0, (dollars / wins if wins else None)


def avg_price() -> float:
    return spend_7d()[1] or DEFAULT_PRICE


def daily_window_cap(now_s: float | None = None) -> int:
    """일일 창 수 = max(400, 잔액 / 남은 일수 / 7일 평균 단가). 위쪽은 일일 밸브가 막는다."""
    floor = int(settings.get("claude.daily_windows", 400))
    b, left = balance(), key_days_left(now_s)
    if b is None or not left:
        return floor
    want = math.floor(b / max(left, 1.0) / avg_price())
    return max(floor, want)


def llm_block() -> dict:
    """kb status --json의 llm 블록. 키 파일이 없거나 계산이 실패하면 값은 null이고 네 키는 항상 있다."""
    nul = {"balance_usd": None, "spend_7d_avg_usd": None, "projected_underspend_usd": None, "key_days_left": None}
    try:
        with state.readonly():
            return _llm_block(nul)
    except Exception:  # noqa: BLE001 llm 계산 실패가 kb status를 막지 않는다
        return nul


def _llm_block(nul: dict) -> dict:
    try:
        b = balance()
        if b is None:
            return nul
        avg, _ = spend_7d()
        left = key_days_left()
        under = None if left is None else round(max(0.0, b - avg * left), 4)
        return {"balance_usd": round(b, 4), "spend_7d_avg_usd": round(avg, 4), "projected_underspend_usd": under,
                "key_days_left": left}
    except Exception:  # noqa: BLE001 llm 계산 실패가 kb status를 막지 않는다
        return nul


# ------------------------------------------------------------------ 예약과 정산
class TooLarge(Exception):
    """요청의 입력 토큰 상한이 설정 상한을 넘는다. 보내지 않는다."""


def price_bound(model: str, input_tokens: int, output_tokens: int) -> float:
    """입력과 출력 토큰 상한에 모델 가격(백만 토큰당)을 곱한 호출당 비용 상한. 가격표에 없는 모델은 표의 최고가로 본다."""
    table = settings.get("openrouter.price_per_m") or {}
    pr = table.get(model)
    if not pr:
        pr = [max((v[0] for v in table.values()), default=5.0), max((v[1] for v in table.values()), default=25.0)]
    usd = (input_tokens * float(pr[0]) + output_tokens * float(pr[1])) / 1e6 * float(settings.get("openrouter.reserve_margin", 1.10))
    return math.ceil(usd * 1e6) / 1e6


def reservation_for(be, job) -> float:
    """호출 전 예약액. 어댑터가 요청의 토큰 상한을 알면 거기서 구하고, 모르면 설정의 바닥값이다. 너무 큰 요청은 TooLarge."""
    f = getattr(be, "reservation_usd", None)
    if f is None:
        return float(settings.get("openrouter.reserve_usd", 0.054))
    return f(job)


class Refused(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def reserve(usd: float, *, purpose: str = "extract") -> dict:
    """OpenRouter 호출 전 예약. 일일 밸브나 잔액을 넘으면 Refused('valve'|'balance')."""
    valve = float(settings.get("openrouter.daily_valve_usd", 30.0))
    d = day()
    if d["spent"] + d["reserved"] + usd > valve + 1e-9:
        d["valve_hits"] += 1
        _save_day(d)
        raise Refused("valve")
    b = balance()
    if b is None or b - d["reserved"] - usd < float(settings.get("openrouter.min_balance_usd", 0.10)):
        raise Refused("balance")
    d["reserved"] = round(d["reserved"] + usd, 6)
    _save_day(d)
    return {"usd": usd, "day": settings.kst_day(), "purpose": purpose}


def settle(res: dict, actual: float | None) -> bool:
    """정산. 반환: 실제 비용이 예약을 넘었으면 True(호출당 비용 초과, 호출자가 사고로 기록)."""
    d = day(res["day"])
    est = float(res["usd"])
    act = est if actual is None else float(actual)
    d["reserved"] = round(max(0.0, d["reserved"] - est), 6)
    d["spent"] = round(d["spent"] + act, 6)
    if res.get("purpose") == "extract":
        d["openrouter_windows"] = d.get("openrouter_windows", 0) + 1
        d["openrouter_extract_usd"] = round(d.get("openrouter_extract_usd", 0.0) + act, 6)
    _save_day(d, res["day"])
    b = balance()
    if b is not None:
        set_balance(max(0.0, b - act), "ledger")
    state.metric("llm.spend_usd", act, {"purpose": res.get("purpose")})
    return act > est + 1e-9


def release(res: dict) -> None:
    """호출하지 않고 예약을 돌려준다."""
    d = day(res["day"])
    d["reserved"] = round(max(0.0, d["reserved"] - float(res["usd"])), 6)
    _save_day(d, res["day"])


def count_window(backend: str, n: int = 1, *, support: bool = False) -> None:
    d = day()
    k = "support" if support else "windows"
    d[k][backend] = d[k].get(backend, 0) + n
    _save_day(d)


def windows_today(backend: str, *, support: bool = False) -> int:
    return int(day()["support" if support else "windows"].get(backend, 0))


def spent_today() -> float:
    return day()["spent"]


def exhausted() -> bool:
    b = balance()
    return b is not None and b < float(settings.get("openrouter.min_balance_usd", 0.10))
