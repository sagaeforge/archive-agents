import json

from kb.core import opsdb
from kb.metrics import llm
from kb.metrics.snapshot import snapshot

from .conftest import NOW, call

DAY = 86400_000


def strings(o):
    if isinstance(o, str):
        yield o
    elif isinstance(o, dict):
        for k, v in o.items():
            yield from strings(k)
            yield from strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from strings(v)


def test_empty_has_seven_groups_zero(ops):
    r = llm.llm_metrics(ops, NOW - 7 * DAY, NOW)
    assert set(r) == set(llm.GROUPS)
    assert r["quality"]["calls"] == 0 and r["cost"]["usd_total"] == 0 and r["exhaustion"]["balance_usd"] == 0
    assert r["sllm"]["skipped_runs"] == 0 and r["boundary"]["external_send_incidents"] == 0


def test_synthetic_values(ops):
    t = NOW - DAY
    call(ops, t, cost=0.02, balance=100.0, five_hour=0.3, seven_day=0.1, tokens_in=1000, tokens_out=200,
         gate_pass=3, gate_hold=1, gate_reject=2, windows=1)
    call(ops, t + 10, cost=0.04, balance=99.0, five_hour=0.6, seven_day=0.2, tokens_in=500, tokens_out=100,
         gate_pass=1, windows=1, finish="length", error=True, reason="fallback")
    call(ops, t + 20, backend="claude", model="haiku", cost=0.0, elapsed_s=5.0, codex_used_percent=0)
    opsdb.record_metric(ops, "llm.spend_usd", 0.06, {"purpose": "extract"}, at=t)
    opsdb.record_metric(ops, "llm.cross_check", 1, {"backend": "claude"}, at=t)
    opsdb.record_metric(ops, "llm.cross_check", 0, {"backend": "claude"}, at=t)
    opsdb.record_metric(ops, "llm.guard_denied", 1, {"scope": "sensitive", "why": "x"}, at=t)
    opsdb.record_metric(ops, "llm.external_send_incident", 1, {"backend": "openrouter"}, at=t)
    opsdb.record_metric(ops, "llm.preflight_fail", 1, {"backend": "claude", "reason": "r"}, at=t)
    opsdb.record_metric(ops, "llm.sllm_load_s", 12.5, None, at=t)
    opsdb.record_metric(ops, "llm.sllm_load_s", 7.5, None, at=t)
    opsdb.record_metric(ops, "llm.sllm_vram_free_mib", 9000, None, at=t)
    opsdb.record_metric(ops, "llm.sllm_vram_free_mib", 5000, None, at=t)
    opsdb.record_metric(ops, "llm.sllm_skipped", 1, {"why": "vram"}, at=t)
    r = llm.llm_metrics(ops, NOW - 7 * DAY, NOW)
    q = r["quality"]
    assert q["calls"] == 3 and q["truncated"] == 1
    assert q["error_rate"] == round(1 / 3, 4)
    assert q["gate"] == {"pass": 4, "hold": 1, "reject": 2}
    assert q["cross_check_n"] == 2 and q["cross_distortion_rate"] == 0.5
    assert set(q["by_model"]) == {"openrouter:sol", "claude:haiku"}
    assert r["cost"]["tokens_in"] == 1500 and r["cost"]["tokens_out"] == 300
    assert r["cost"]["usd_total"] == 0.06
    assert r["cost"]["usd_per_passed_claim"] == round(0.06 / 4, 6)
    assert r["exhaustion"]["balance_usd"] == 99.0 or r["exhaustion"]["balance_usd"] == 100.0
    assert r["exhaustion"]["spend_7d_avg_usd"] == round(0.06 / 7, 6)
    assert r["limits"]["five_hour_max"] == 0.6 and r["limits"]["seven_day_max"] == 0.2 and r["limits"]["stops"] == 1
    assert r["boundary"] == {"guard_denied": 1, "sensitive_windows": 1, "external_send_incidents": 1}
    assert r["routes"]["switches_by_reason"] == {"fallback": 1, "primary": 2}
    assert r["routes"]["dwell_s_by_backend"] == {"claude": 5.0, "openrouter": 4.0}
    assert r["sllm"]["load_s_max"] == 12.5 and r["sllm"]["load_s_avg"] == 10.0
    assert r["sllm"]["vram_free_min_mib"] == 5000 and r["sllm"]["skipped_runs"] == 1


def test_no_text_or_url_leaks(ops):
    t = NOW - DAY
    secret = "https://example.com/private?q=SECRETWINDOWTEXT " + "x" * 200
    call(ops, t, window_text=secret, url=secret, query=secret, balance=5.0)
    opsdb.record_metric(ops, "llm.guard_denied", 1, {"scope": secret, "why": secret}, at=t)
    r = llm.llm_metrics(ops, NOW - 7 * DAY, NOW)
    blob = json.dumps(r)
    assert "SECRETWINDOWTEXT" not in blob and "example.com" not in blob
    assert [s for s in strings(r) if len(s) > 64] == []
    snap = snapshot(ops, now_ms=NOW)
    assert [s for s in strings(snap["llm"]) if len(s) > 64] == []
