"""llm 키(ADR-0003 10장): quality, cost, exhaustion, limits, boundary, routes, sllm 7묶음. ops.db metric 표의 llm.* 행에서 모은다.
수치만 낸다. 창 본문, URL, 질의 원문은 읽지도 않는다. 기록이 없으면 전부 0이다.
llm.call 행: value=cost_usd, dims={backend, model, error, elapsed_s, reason, finish, balance, five_hour, seven_day,
선택: tokens_in, tokens_out, gate_pass, gate_hold, gate_reject, schema_fail, windows, passed_claims, codex_used_percent}."""
from __future__ import annotations

import datetime

from kb.metrics.snapshot import _metric_rows, dims_of

GROUPS = ("quality", "cost", "exhaustion", "limits", "boundary", "routes", "sllm")


def _s(x, n=48) -> str:
    return str(x if x not in (None, "") else "none")[:n]


def _num(d: dict, k: str) -> float:
    v = d.get(k)
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0.0


def _key_days_left(now_ms: int) -> float:
    try:
        from kb.extract import settings
        exp = settings.get("openrouter.key_expires_at")
        if exp:
            t = datetime.datetime.fromisoformat(str(exp)).timestamp() * 1000
            return round(max(0.0, (t - now_ms) / 86400_000), 2)
    except Exception:  # noqa: BLE001
        pass
    return 0.0


def _valve() -> float:
    try:
        from kb.extract import settings
        return float(settings.get("openrouter.daily_valve_usd") or 0.0)
    except Exception:  # noqa: BLE001
        return 0.0


def llm_metrics(c, t0: int, t1: int) -> dict:
    days = max((t1 - t0) / 86400_000, 1e-9)
    models: dict[str, dict] = {}
    routes_by_reason: dict[str, int] = {}
    dwell: dict[str, float] = {}
    last_balance, last_balance_at = 0.0, -1
    five_max = seven_max = codex_max = 0.0
    daily_spend: dict[str, float] = {}
    for at, name, dims, v in _metric_rows(c, t0, t1, "llm."):
        d = dims_of(dims)
        if name == "llm.call":
            m = models.setdefault(f"{_s(d.get('backend'), 16)}:{_s(d.get('model'), 40)}",
                                  dict(calls=0, errors=0, truncated=0, schema_fail=0, gate_pass=0, gate_hold=0, gate_reject=0,
                                       windows=0, passed_claims=0, tokens_in=0, tokens_out=0, cost_usd=0.0))
            m["calls"] += 1
            m["errors"] += 1 if d.get("error") else 0
            m["truncated"] += 1 if d.get("finish") == "length" else 0
            for k in ("schema_fail", "gate_pass", "gate_hold", "gate_reject", "windows", "passed_claims", "tokens_in", "tokens_out"):
                m[k] += int(_num(d, k))
            m["cost_usd"] += v
            r = _s(d.get("reason"), 32)
            routes_by_reason[r] = routes_by_reason.get(r, 0) + 1
            be = _s(d.get("backend"), 16)
            dwell[be] = dwell.get(be, 0.0) + _num(d, "elapsed_s")
            if d.get("balance") is not None and at >= last_balance_at:
                last_balance, last_balance_at = _num(d, "balance"), at
            five_max = max(five_max, _num(d, "five_hour"))
            seven_max = max(seven_max, _num(d, "seven_day"))
            codex_max = max(codex_max, _num(d, "codex_used_percent"))
        elif name == "llm.spend_usd":
            day = datetime.datetime.fromtimestamp(at / 1000, datetime.timezone.utc).strftime("%Y-%m-%d")
            daily_spend[day] = daily_spend.get(day, 0.0) + v
    names = lambda n: [(at, dims_of(dims), v) for at, _, dims, v in _metric_rows(c, t0, t1, name=n)]  # noqa: E731
    cross = names("llm.cross_check")
    cross_n = len(cross)
    cross_bad = sum(1 for _, _, v in cross if v == 0)
    for m in models.values():
        if m["windows"] == 0:
            m["windows"] = m["calls"] - m["errors"]  # windows 차원이 없으면 성공 호출 1건을 창 1개로 센다
    calls = sum(m["calls"] for m in models.values())
    windows = sum(m["windows"] for m in models.values())
    passed = sum(m["passed_claims"] or m["gate_pass"] for m in models.values())
    total_cost = sum(m["cost_usd"] for m in models.values())
    spend7 = sum(daily_spend.values())
    avg7 = spend7 / days
    key_days = _key_days_left(t1)
    valve = _valve()
    valve_hits = sum(1 for x in daily_spend.values() if valve and x >= valve)
    stops = len(names("llm.preflight_fail"))
    sl = {n: names(n) for n in ("llm.sllm_load_s", "llm.sllm_vram_free_mib", "llm.sllm_skipped", "llm.sllm_residual_procs")}
    vram_free = [v for _, _, v in sl["llm.sllm_vram_free_mib"] if v >= 0]
    return {
        "quality": {"calls": calls, "windows": windows,
                    "error_rate": round(sum(m["errors"] for m in models.values()) / calls, 4) if calls else 0.0,
                    "truncated": sum(m["truncated"] for m in models.values()),
                    "schema_fail": sum(m["schema_fail"] for m in models.values()),
                    "gate": {"pass": sum(m["gate_pass"] for m in models.values()), "hold": sum(m["gate_hold"] for m in models.values()),
                             "reject": sum(m["gate_reject"] for m in models.values())},
                    "passed_per_window": round(passed / windows, 4) if windows else 0.0,
                    "cross_check_n": cross_n, "cross_distortion_rate": round(cross_bad / cross_n, 4) if cross_n else 0.0,
                    "by_model": {k: {kk: (round(vv, 6) if isinstance(vv, float) else vv) for kk, vv in m.items()} for k, m in sorted(models.items())}},
        "cost": {"tokens_in": sum(m["tokens_in"] for m in models.values()), "tokens_out": sum(m["tokens_out"] for m in models.values()),
                 "usd_total": round(total_cost, 6), "usd_per_window": round(total_cost / windows, 6) if windows else 0.0,
                 "usd_per_passed_claim": round(total_cost / passed, 6) if passed else 0.0,
                 "daily_spend_usd": {k: round(v, 6) for k, v in sorted(daily_spend.items())}, "valve_hits": valve_hits},
        "exhaustion": {"balance_usd": round(last_balance, 4), "spend_7d_avg_usd": round(avg7, 6),
                       "projected_underspend_usd": round(max(0.0, last_balance - avg7 * key_days), 4) if last_balance else 0.0,
                       "key_days_left": key_days},
        "limits": {"five_hour_max": five_max, "seven_day_max": seven_max, "codex_used_percent_max": codex_max, "stops": stops},
        "boundary": {"guard_denied": len(names("llm.guard_denied")), "sensitive_windows": sum(
                         1 for _, d, _ in names("llm.guard_denied") if d.get("scope") == "sensitive") + sum(
                         int(_num(d, "sensitive")) for _, d, _ in names("llm.sensitive_processed")),
                     "external_send_incidents": len(names("llm.external_send_incident"))},
        "routes": {"switches_by_reason": dict(sorted(routes_by_reason.items())),
                   "dwell_s_by_backend": {k: round(v, 2) for k, v in sorted(dwell.items())}},
        "sllm": {"load_s_max": max([v for _, _, v in sl["llm.sllm_load_s"]], default=0.0),
                 "load_s_avg": round(sum(v for _, _, v in sl["llm.sllm_load_s"]) / len(sl["llm.sllm_load_s"]), 2) if sl["llm.sllm_load_s"] else 0.0,
                 "vram_free_min_mib": min(vram_free, default=0.0), "contention": len(sl["llm.sllm_skipped"]) + int(sum(v for _, _, v in sl["llm.sllm_residual_procs"])),
                 "skipped_runs": len(sl["llm.sllm_skipped"])},
    }
