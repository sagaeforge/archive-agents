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
        if ctx.get("isUsingOverage") or ctx.get("rate_limit_type") == "overage":
            import logging
            logging.getLogger(__name__).warning("claude_sub overage: stop this manual execution")
            state.metric("claude.overage_seen", 1, {"engine": "claude_sub"})
            return Verdict(signal, "halt", "claude_sub", None, fallthrough=False,
                           detail="subscription_overage: stop this manual execution")
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


CANARY_FAIL_KEY = "claude:canary_fail"


def _canary_waiting() -> bool:
    """카나리아가 실패한 뒤 물러나 있는 중인가. 그 뒤로 성공한 카나리아가 있으면 끝난다."""
    f, c = state.get(CANARY_FAIL_KEY) or {}, state.get("claude:canary") or {}
    return settings.now_s() < float(f.get("until") or 0) and not (c.get("ok") and (c.get("at") or 0) > (f.get("at") or 0))


def _canary_failed() -> None:
    """실패 때마다 대기를 두 배로 늘린다. 시작은 rate_recheck_s, 상한은 canary_ttl_s다. 시간당 타이머가 매번 호출하지 않게 한다."""
    n, now = int((state.get(CANARY_FAIL_KEY) or {}).get("n") or 0) + 1, settings.now_s()
    wait = min(float(settings.get("claude.rate_recheck_s", 3600)) * 2 ** (n - 1), float(settings.get("claude.canary_ttl_s", 86400)))
    state.put(CANARY_FAIL_KEY, {"n": n, "at": now, "until": now + wait})


def claude_rate(pf, be) -> dict:
    """가장 새로운 활용률. 저장값이 낡고 카나리아도 그보다 오래되면 카나리아를 1회 다시 돈다. 실패한 뒤에는 물러나 있는 동안 값 없음으로 닫는다."""
    stored, canary = state.get("claude:rate") or {}, pf.info or {}
    newest = max(stored.get("at") or 0, canary.get("at") or 0)     # 저장값이 없어도 하루 묵은 카나리아 값을 그대로 쓰지 않는다
    if newest and settings.now_s() - newest > float(settings.get("claude.rate_recheck_s", 3600)):
        if _canary_waiting():
            return {}
        fresh = be.canary()
        rate = (fresh.info or {}).get("rate") or {}
        if not fresh.ok or not rate:
            _canary_failed()
            return {}
        state.delete(CANARY_FAIL_KEY)
        state.put("claude:rate", dict(rate, at=settings.now_s()))
        return rate
    if not stored or (canary.get("at") or 0) > (stored.get("at") or 0):
        return canary.get("rate") or {}
    return stored


def _rate_reason(r: dict, start: bool) -> str | None:
    """활용률 값 하나에 5시간, 7일 신호를 적용한다. 문턱을 넘거나 값이 없으면 사유 이름, 아니면 None.
    five_hour는 7일 경고 구간에 빠질 수 있지만 seven_day가 없으면 7일 문턱을 잴 수 없으므로 닫는다."""
    v1 = apply("claude_five_hour", five_hour=r.get("five_hour"), seven_day=r.get("seven_day"), start=start)
    v2 = apply("claude_seven_day", seven_day=r.get("seven_day"))
    if v1.action != "none":
        return "rate_unavailable" if r.get("five_hour") is None and r.get("seven_day") is None else "five_hour"
    if r.get("seven_day") is None:
        return "rate_unavailable"
    return "seven_day" if v2.action != "none" else None


def claude_gate(pf, be, *, start: bool = True) -> bool:
    """Claude 호출 전 활용률 검사. 추출과 함의 판정이 같은 문턱을 쓴다. 값이 없거나 문턱을 넘으면 False."""
    return _rate_reason(claude_rate(pf, be), start) is None


def claude_hold() -> str | None:
    """사람이 풀어야 하는 정지: llm:stop, HALT, 자동 복귀가 없는 llm:off:claude. 지금 활용률이 깨끗해도 Claude를 부르지 않는다."""
    st = stopped() or ("halted" if guard.halted() else None)
    if st:
        return st
    e = state.get(off_key("claude")) or {}
    if e and e.get("until") is None and e.get("retry") != "next_run":
        return e.get("reason") or "off"
    return None


def claude_job_gate(be=None, *, engine=None, model=None, job=None) -> str | None:
    """구독 활용률 카나리아를 호출하던 옛 자동 진입점은 항상 거부한다."""
    if engine in {"openrouter", "openai_api", "anthropic_api"}:
        return stopped() or ("halted" if guard.halted() else None)
    return "subscription_automatic_forbidden"


class Router:
    def __init__(self, backends: dict | None = None):
        self.backends = backends

    def _or_ok(self, model: str) -> tuple:
        if is_off("openrouter") or is_off(model):
            return False, (state.get(off_key("openrouter")) or {}).get("reason") or "model_off"
        if not settings.get("openrouter.enabled", True):
            return False, "disabled"
        b = budget.balance()
        if b is not None and b < float(settings.get("openrouter.min_balance_usd", .10)):
            return False, "balance_exhausted"
        d = budget.day()
        if d["spent"] + d["reserved"] + float(settings.get("openrouter.reserve_usd", .054)) > float(settings.get("openrouter.daily_valve_usd", 30.)) + 1e-9:
            return False, "daily_valve"
        return True, ""

    def _claude_ok(self, support: bool = False) -> tuple:
        return False, "subscription_automatic_forbidden"

    def plan(self, scope: str, purpose: str = "extract", *, extractor: str | None = None) -> Plan:
        from kb.extract import engines
        st = stopped() or ("halted" if guard.halted() else None)
        if st or scope == "excluded":
            return Plan([], st or "excluded")
        local = scope == "sensitive" or purpose in engines.LOCAL_TASKS
        if local:
            if scope == "sensitive" and purpose not in ("extract", "classify"):
                return Plan([], "sensitive_no_judge")
            if not settings.get("sllm.enabled", True) or is_off("sllm") or is_off("local"):
                return Plan([], "sllm_off")
            model = str(settings.get("sllm.model", "nemotron"))
            arm = engines.select(purpose, [engines.Arm(purpose, "local", model)], needs_external=False)
            return Plan([Cand("sllm", model, "local")]) if arm else Plan([], "local_unavailable")
        if purpose not in ("extract", "support", "cross"):
            return Plan([], "unknown_purpose")
        sol = str(settings.get("openrouter.extract_model", SOL))
        hk = str(settings.get("openrouter.extract_fallback_model", OR_HAIKU))
        models = [sol, hk] if purpose == "extract" else []
        if purpose == "support" and settings.get("openrouter.support_calibrated", False):
            models = [str(settings.get("openrouter.support_model", OR_SONNET))]
        if purpose == "cross":
            cm = settings.get("openrouter.cross_models") or {}
            models = [cm.get(extractor) or cm.get("default") or SOL]
        candidates = [engines.Arm(purpose, "openrouter", m) for m in models]
        # API Claude Code is executable now; O1/A1 add Python/Batch executors later.
        if self.backends and "anthropic_api" in self.backends:
            candidates.append(engines.Arm(purpose, "anthropic_api", str(settings.get("claude.model", "haiku")) if purpose != "cross" else "sonnet"))
        if purpose == "cross":
            def vendor(model):
                m = model.lower()
                if any(x in m for x in ("anthropic", "claude", "haiku", "sonnet")):
                    return "anthropic"
                if "openai" in m or "gpt" in m:
                    return "openai"
                return None
            extracted_vendor = vendor(extractor or "")
            candidates = [a for a in candidates if extracted_vendor and vendor(a.model)
                          and vendor(a.model) != extracted_vendor]
        reason = "all_blocked"
        def eligible(a):
            nonlocal reason
            if a.engine == "openrouter":
                ok, reason = self._or_ok(a.model)
                if not ok:
                    return False
            return engines.available(a, executable=self.backends is None or (a.engine in self.backends and self.backends[a.engine].name == a.engine),
                                     authenticate=self.backends is None)
        # A reached daily valve is a batch boundary, not a reason to move money.
        if models and self._or_ok(models[0])[1] == "daily_valve":
            return Plan([], "daily_valve")
        arm = engines.select(purpose, candidates, eligible=eligible)
        if arm is None:
            return Plan([], "week_gap" if purpose == "cross" else (reason or "all_blocked"))
        # Pin the selected arm for this task; do not execute an unscored fallback.
        return Plan([Cand(arm.engine, arm.model, "selector:" + purpose,
                          float(settings.get("claude.budget_usd", .02)) if arm.engine == "anthropic_api" else None)])



def kst_label(ts: float) -> str:
    return _dt.datetime.fromtimestamp(ts, _dt.timezone(_dt.timedelta(hours=9))).isoformat(timespec="seconds")
