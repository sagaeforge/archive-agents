"""라우팅과 전환 규칙(ADR-0003 2, 5장). 라우터는 후보 순서만 정한다. 호출, 재시도, 지출 판단은 하지 않는다.
전환 신호는 SWITCH_TABLE 13행이고 apply()가 상태(tick_state의 llm:off:*, llm:stop)에 반영한다.
일일 밸브 도달 뒤에는 다른 경로로 넘기지 않는다(버그가 구독으로 번지면 안 된다)."""
from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass, field

from kb.extract import budget, guard, settings, state

STOP_KEY = "llm:stop"
SOL, OR_HAIKU, OR_SONNET = "openai/gpt-6.1-sol", "anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5"


@dataclass
class Cand:
    backend: str
    model: str
    reason: str
    budget_usd: float | None = None
    same_vendor: bool = False


@dataclass
class Plan:
    cands: list = field(default_factory=list)
    stop: str | None = None           # 후보가 없을 때 사유(큐에 남긴다)


@dataclass
class Verdict:
    signal: str
    action: str                       # off | stop | halt | skip | none
    target: str | None = None
    until: float | None = None
    incident: bool = False
    fallthrough: bool = True          # False면 대체 경로로 넘기지 않는다
    detail: str = ""


# 신호 -> (판정 설명, 조치, 복귀). 시험은 이 13행을 전부 돈다.
SWITCH_TABLE = ("balance_exhausted", "key_invalid", "daily_valve", "cost_exceeded", "claude_five_hour", "claude_seven_day",
                "claude_overage", "claude_daily_windows", "codex_limit", "error_rate", "gate_pass_drop", "low_yield", "all_down")


def off_key(target: str) -> str:
    return "llm:off:" + target


def is_off(target: str, now: float | None = None) -> bool:
    e = state.get(off_key(target))
    if not e:
        return False
    until = e.get("until")
    if until is not None and (now if now is not None else settings.now_s()) >= until:
        return False
    return True


def set_off(target: str, reason: str, until: float | None, **kw) -> None:
    state.put(off_key(target), {"reason": reason, "until": until, "at": settings.now_s(), **kw})


def clear_off(target: str) -> None:
    state.delete(off_key(target))


def stopped() -> str | None:
    s = state.get(STOP_KEY)
    return s.get("reason") if s else None


def clear_stop() -> None:
    state.delete(STOP_KEY)


def _record_drop(backend: str, why: str) -> bool:
    """같은 KST 날에 두 경로 이상이 하락하면 전환하지 않고 L2를 정지한다. 반환: 정지했는가."""
    k = "llm:drops:" + settings.kst_day()
    d = state.get(k) or {}
    d[backend] = why
    state.put(k, d)
    if len(d) >= 2:
        state.put(STOP_KEY, {"reason": "all_paths_down", "drops": d, "at": settings.now_s()})
        return True
    return False


def apply(signal: str, **ctx) -> Verdict:
    """신호 하나를 판정하고 상태에 반영한다."""
    now = settings.now_s()
    midnight = settings.next_kst_midnight_s(now)
    S = settings.get
    if signal == "balance_exhausted":
        b = ctx.get("balance", budget.balance())
        if ctx.get("http") == 402 or (b is not None and b < float(S("openrouter.min_balance_usd", 0.10))):
            set_off("openrouter", "balance_exhausted", None)
            return Verdict(signal, "off", "openrouter", None, detail="소진 뒤 표로 간다")
    elif signal == "key_invalid":
        if ctx.get("http") == 401 or ctx.get("missing") or ctx.get("expired"):
            set_off("openrouter", "key_invalid", None)
            return Verdict(signal, "off", "openrouter", None)
    elif signal == "daily_valve":
        valve = float(S("openrouter.daily_valve_usd", 30.0))
        if ctx.get("spent", 0.0) + ctx.get("reserve", 0.0) > valve + 1e-9:
            set_off("openrouter", "daily_valve", midnight)
            return Verdict(signal, "off", "openrouter", midnight, fallthrough=False, detail="그날 OpenRouter 정지, 대체로 넘기지 않음")
    elif signal == "cost_exceeded":
        if ctx.get("actual", 0.0) > ctx.get("reserved", 0.0) + 1e-9:
            state.put(STOP_KEY, {"reason": "cost_exceeded", "at": now})
            state.incident("other", f"OpenRouter 호출당 비용 초과: 실제 {ctx.get('actual')} > 예약 {ctx.get('reserved')}")
            return Verdict(signal, "stop", "batch", None, incident=True, fallthrough=False)
    elif signal == "claude_five_hour":
        v = ctx.get("five_hour")
        start = ctx.get("start", True)
        if v is None and ctx.get("seven_day") is not None:     # 7일 창 경고 구간에는 five_hour 키가 없다(ADR 10.5)
            state.metric("llm.preflight_warn", 1, {"backend": "claude", "warn": "five_hour_absent"})
            return Verdict(signal, "none")
        if v is None or (start and v > float(S("claude.start_max_five_hour", 0.5))) or (not start and v >= float(S("claude.stop_five_hour", 0.7))):
            set_off("claude", "five_hour", None, retry="next_run")
            return Verdict(signal, "skip" if start else "stop", "claude", None, detail="다음 회차에 재검사")
    elif signal == "claude_seven_day":
        v = ctx.get("seven_day")
        if v is not None and v >= float(S("claude.stop_seven_day", 0.80)):
            set_off("claude", "seven_day", None, retry="next_run")
            return Verdict(signal, "stop", "claude")
    elif signal == "claude_overage":
        if ctx.get("isUsingOverage"):
            set_off("claude", "overage", None)
            state.put(STOP_KEY, {"reason": "claude_overage", "at": now})
            state.incident("other", "Claude isUsingOverage=true: 초과 과금 정지")
            return Verdict(signal, "halt", "claude", None, incident=True, fallthrough=False)
    elif signal == "claude_daily_windows":
        if budget.windows_today("claude") >= int(S("claude.daily_windows", 400)):
            set_off("claude", "daily_windows", midnight)
            return Verdict(signal, "off", "claude", midnight)
    elif signal == "codex_limit":
        used = ctx.get("usedPercent")
        if ctx.get("ordinaryUsageAllowed") is not True or used is None or used >= float(S("codex.max_used_percent", 50)):
            set_off("codex", "limit", ctx.get("resetsAt"))
            return Verdict(signal, "off", "codex", ctx.get("resetsAt"), detail="크레딧을 쓰지 않는다")
    elif signal == "error_rate":
        key = ctx["key"]
        h = state.get("llm:health:" + key) or []
        h = (h + [1 if ctx.get("error") else 0])[-int(S("switch.error_window", 50)):]
        state.put("llm:health:" + key, h)
        tail = 0
        for x in reversed(h):
            if not x:
                break
            tail += 1
        rate = sum(h) / len(h)
        if tail >= int(S("switch.error_consecutive", 5)) or (len(h) >= 10 and rate >= float(S("switch.error_rate", 0.20))):
            until = now + float(S("switch.off_s", 3600))
            set_off(key, "error_rate", until, canary=True)
            _record_drop(backend_of(key), "error_rate")
            return Verdict(signal, "off", key, until, detail="1시간 끄고 카나리아 통과로 복귀")
    elif signal == "gate_pass_drop":
        key, passed, total = ctx["key"], ctx["passed"], ctx["total"]
        h = (state.get("llm:gatepass:" + key) or []) + [[passed, total]]
        h = h[-int(S("switch.gate_window", 20)):]
        state.put("llm:gatepass:" + key, h)
        base = (S("switch.baselines") or {}).get(key)
        tot = sum(t for _, t in h)
        if base and len(h) >= int(S("switch.gate_window", 20)) and tot and sum(p for p, _ in h) / tot < base * float(S("switch.gate_ratio", 0.85)):
            set_off(key, "gate_pass_drop", None, human=True)
            _record_drop(backend_of(key), "gate_pass_drop")
            return Verdict(signal, "off", key, None, detail="회고 확인 뒤 사람이 켠다")
    elif signal == "low_yield":
        # 주장이 없는 창은 gate_pass_drop에 넣지 않으므로(통과율 분모가 아니다) 빈 응답만 내는 모델은 여기서 잡는다.
        key, n = ctx["key"], int(S("switch.yield_window", 50))
        h = ((state.get("llm:yield:" + key) or []) + [1 if ctx["empty"] else 0])[-n:]
        state.put("llm:yield:" + key, h)
        if len(h) >= n and sum(h) / len(h) >= float(S("switch.yield_empty_ratio", 0.6)):
            set_off(key, "low_yield", None, human=True)
            _record_drop(backend_of(key), "low_yield")
            return Verdict(signal, "off", key, None, detail="회고 확인 뒤 사람이 켠다")
    elif signal == "all_down":
        if _record_drop(ctx["backend"], ctx.get("why", "down")):
            return Verdict(signal, "stop", "l2", None, fallthrough=False, detail="전환하지 않고 L2 정지")
    return Verdict(signal, "none")


def backend_of(key: str) -> str:
    return key.split(":")[0] if ":" in key else "openrouter"


def model_key(backend: str, model: str) -> str:
    return model if backend == "openrouter" else f"{backend}:{model}"


def claude_rate(pf, be) -> dict:
    """가장 새로운 활용률. 저장값이 낡고 카나리아도 그보다 오래되면 카나리아를 1회 다시 돈다."""
    stored, canary = state.get("claude:rate") or {}, pf.info or {}
    if stored.get("at") and settings.now_s() - stored["at"] > float(settings.get("claude.rate_recheck_s", 3600)) \
            and (canary.get("at") or 0) <= stored["at"]:
        fresh = be.canary()
        rate = (fresh.info or {}).get("rate") or {}
        if not fresh.ok or not rate:
            return {}
        state.put("claude:rate", dict(rate, at=settings.now_s()))
        return rate
    if not stored or (canary.get("at") or 0) > (stored.get("at") or 0):
        return canary.get("rate") or {}
    return stored


def claude_gate(pf, be, *, start: bool = True) -> bool:
    """Claude 호출 전 활용률 검사. 추출과 함의 판정이 같은 문턱을 쓴다. 값이 없거나 문턱을 넘으면 False."""
    r = claude_rate(pf, be)
    v1 = apply("claude_five_hour", five_hour=r.get("five_hour"), seven_day=r.get("seven_day"), start=start)
    v2 = apply("claude_seven_day", seven_day=r.get("seven_day"))
    return v1.action == "none" and v2.action == "none"


class Router:
    def __init__(self, backends: dict | None = None):
        self.backends = backends or {}

    # --------------------------------------------------------------- 가용성
    def _or_ok(self, model: str) -> tuple:
        if is_off("openrouter") or is_off(model):
            return False, (state.get(off_key("openrouter")) or {}).get("reason") or "model_off"
        if not settings.get("openrouter.enabled", True):
            return False, "disabled"
        b = budget.balance()
        if b is not None and b < float(settings.get("openrouter.min_balance_usd", 0.10)):
            return False, "balance_exhausted"
        d = budget.day()
        if d["spent"] + d["reserved"] + float(settings.get("openrouter.reserve_usd", 0.054)) > float(settings.get("openrouter.daily_valve_usd", 30.0)) + 1e-9:
            return False, "daily_valve"
        return True, ""

    def _claude_ok(self, support: bool = False) -> tuple:
        for t in ("claude", model_key("claude", str(settings.get("claude.model", "haiku")))):   # gate_pass_drop, low_yield는 claude:<모델> 키에 쓴다
            if is_off(t):
                e = state.get(off_key(t)) or {}
                if e.get("retry") != "next_run":
                    return False, e.get("reason") or "off"
        if support:
            if budget.windows_today("claude", support=True) >= int(settings.get("claude.support_daily", 100)):
                return False, "support_daily"
        elif budget.windows_today("claude") >= int(settings.get("claude.daily_windows", 400)):
            return False, "daily_windows"
        return True, ""

    def _codex_ok(self) -> tuple:
        if not settings.get("codex.enabled", False):
            return False, "disabled"
        if is_off("codex"):
            return False, "limit"
        return True, ""

    # --------------------------------------------------------------- 계획
    def plan(self, scope: str, purpose: str = "extract", *, extractor: str | None = None) -> Plan:
        st = stopped() or ("halted" if state.get(guard.HALT_KEY) else None)
        if st:
            return Plan([], st)
        if scope == "excluded":
            return Plan([], "excluded")
        if scope == "sensitive":
            if purpose == "classify":
                return Plan([Cand("sllm", str(settings.get("sllm.model", "nemotron")), "sensitive:classify")])
            if purpose != "extract":
                return Plan([], "sensitive_no_judge")
            if not settings.get("sllm.enabled", True) or is_off("sllm"):
                return Plan([], "sllm_off")
            return Plan([Cand("sllm", str(settings.get("sllm.model", "nemotron")), "sensitive:sllm")])
        if purpose == "extract":
            return self._plan_extract()
        if purpose == "support":
            return self._plan_support()
        if purpose == "cross":
            return self._plan_cross(extractor or "")
        return Plan([], "unknown_purpose")

    def _plan_extract(self) -> Plan:
        c: list = []
        reasons: list = []
        sol, hk = str(settings.get("openrouter.extract_model", SOL)), str(settings.get("openrouter.extract_fallback_model", OR_HAIKU))
        for model, reason in ((sol, "or:balance"), (hk, "or:fallback_haiku")):
            ok, w = self._or_ok(model)
            if ok:
                c.append(Cand("openrouter", model, reason))
            else:
                reasons.append(w)
        why = reasons[0] if reasons else ""
        if not c and why == "daily_valve":
            return Plan([], "daily_valve")              # 구독으로 번지지 않는다
        post = "or:fallback_claude" if c else ("claude:post_exhaustion" if why in ("balance_exhausted", "key_invalid", "no_key", "disabled", "") else f"claude:or_{why}")
        cl, w2 = self._claude_ok()
        if cl:
            c.append(Cand("claude", str(settings.get("claude.model", "haiku")), post, float(settings.get("claude.budget_usd", 0.02))))
        cx, _ = self._codex_ok()
        if cx:
            c.append(Cand("codex", str(settings.get("codex.model", "gpt-6.1-sol")), "codex:fallback"))
        return Plan(c, None if c else (w2 or why or "all_blocked"))

    def _plan_support(self) -> Plan:
        c: list = []
        sm = str(settings.get("openrouter.support_model", OR_SONNET))
        if settings.get("openrouter.support_calibrated", False):
            ok, why = self._or_ok(sm)
            if not ok and why == "daily_valve":
                return Plan([], "daily_valve")              # 밸브 도달 뒤에는 Claude, Codex로 번지지 않는다
            if ok and budget.windows_today("openrouter", support=True) < int(settings.get("openrouter.support_daily", 1000)):
                c.append(Cand("openrouter", sm, "support:or_sonnet"))
        cl, w = self._claude_ok(support=True)
        if cl:
            c.append(Cand("claude", "haiku", "support:claude_haiku", float(settings.get("claude.budget_usd", 0.02))))
        return Plan(c, None if c else (w or "needs_review"))

    def _plan_cross(self, extractor: str) -> Plan:
        """추출과 다른 벤더. Sol 추출분은 OR Sonnet, Haiku 추출분은 OR Sol. 대체: Codex -> claude sonnet(같은 벤더 표시)."""
        m = settings.get("openrouter.cross_models") or {}
        model = m.get(extractor) or m.get("default") or SOL
        c: list = []
        ok, why = self._or_ok(model)
        if not ok and why == "daily_valve":
            return Plan([], "daily_valve")                  # 밸브 도달 뒤에는 Codex, Claude로 번지지 않는다
        if ok:
            c.append(Cand("openrouter", model, "cross:other_vendor"))
        cx, _ = self._codex_ok()
        if cx:
            c.append(Cand("codex", str(settings.get("codex.model", "gpt-6.1-sol")), "cross:codex"))
        cl, _ = self._claude_ok(support=True)
        if cl:
            c.append(Cand("claude", "sonnet", "cross:claude_sonnet", float(settings.get("claude.cross_budget_usd", 0.05)), same_vendor=True))
        return Plan(c, None if c else "week_gap")


def kst_label(ts: float) -> str:
    return _dt.datetime.fromtimestamp(ts, _dt.timezone(_dt.timedelta(hours=9))).isoformat(timespec="seconds")
