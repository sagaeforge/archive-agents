"""kb metrics --week --json 본체. ops.db를 읽기만 한다. 키: yield, tokens, failures, freshness, retrieval, recovery, llm, transcript.
원문, URL, 질의 문자열을 담지 않는다(소스 id와 도구 이름 같은 짧은 식별자만)."""
from __future__ import annotations

import datetime
import json
import sqlite3
import time
from pathlib import Path

WEEK_MS = 7 * 86400_000
OK_OUTCOMES = ("captured", "not_modified", "reused")
NO_NET = ("host_denied", "circuit_open", "robots_denied", "budget_exceeded", "policy_skip", "disabled")


def week_window(now_ms: int | None = None, days: int = 7) -> tuple[int, int]:
    t1 = now_ms if now_ms is not None else int(time.time() * 1000)
    return t1 - days * 86400_000, t1


def week_label(now_ms: int) -> str:
    d = datetime.datetime.fromtimestamp(now_ms / 1000, datetime.timezone.utc).isocalendar()
    return f"{d[0]}-W{d[1]:02d}"


def _q(c: sqlite3.Connection, sql: str, *a) -> list[tuple]:
    try:
        return c.execute(sql, a).fetchall()
    except sqlite3.DatabaseError:
        return []


def _one(c, sql, *a, default=0):
    r = _q(c, sql, *a)
    return r[0][0] if r and r[0][0] is not None else default


def _metric_rows(c, t0, t1, prefix: str | None = None, name: str | None = None) -> list[tuple]:
    if name:
        return _q(c, "SELECT at, name, dims, value FROM metric WHERE at>=? AND at<? AND name=?", t0, t1, name)
    return _q(c, "SELECT at, name, dims, value FROM metric WHERE at>=? AND at<? AND name LIKE ?", t0, t1, (prefix or "") + "%")


def dims_of(raw) -> dict:
    if not raw:
        return {}
    try:
        d = json.loads(raw) if isinstance(raw, str) else raw
        return d if isinstance(d, dict) else {}
    except ValueError:
        return {}


def _msum(c, t0, t1, name) -> float:
    return float(_one(c, "SELECT sum(value) FROM metric WHERE at>=? AND at<? AND name=?", t0, t1, name, default=0.0))


def _mmax(c, t0, t1, name) -> float:
    return float(_one(c, "SELECT max(value) FROM metric WHERE at>=? AND at<? AND name=?", t0, t1, name, default=0.0))


def yield_(c, t0, t1) -> dict:
    by_outcome = dict(_q(c, "SELECT outcome, count(*) FROM fetch_log WHERE at>=? AND at<? GROUP BY outcome", t0, t1))
    by_source: dict[str, dict] = {}
    for sid, oc, n in _q(c, "SELECT coalesce(source_id,''), outcome, count(*) FROM fetch_log WHERE at>=? AND at<? GROUP BY 1,2", t0, t1):
        s = by_source.setdefault(sid[:64], {"ok": 0, "not_modified": 0, "changed": 0, "failed": 0})
        if oc == "not_modified":
            s["not_modified"] += n
        elif oc in ("captured", "reused"):
            s["ok"] += n
            if oc == "captured":
                s["changed"] += n
        elif oc not in NO_NET:
            s["failed"] += n
    gate = {}
    for _, name, dims, v in _metric_rows(c, t0, t1, "gate."):
        gate[name[5:]] = gate.get(name[5:], 0) + v
    claims = {}
    for _, name, dims, v in _metric_rows(c, t0, t1, "claims."):
        claims[name[7:]] = claims.get(name[7:], 0) + v
    return {
        "fetch": {"total": sum(by_outcome.values()), "ok": sum(by_outcome.get(k, 0) for k in OK_OUTCOMES),
                  "not_modified": by_outcome.get("not_modified", 0), "changed": by_outcome.get("captured", 0),
                  "quarantined": sum(n for k, n in by_outcome.items() if k.startswith("quarant")),
                  "by_outcome": by_outcome},
        "by_source": by_source,
        "claims": claims,
        "gate_results": gate,
    }


def tokens(c, t0, t1) -> dict:
    tr: dict[str, float] = {}
    for _, name, dims, v in _metric_rows(c, t0, t1, "transcript.tokens"):
        k = dims_of(dims).get("kind", "other")
        tr[k] = tr.get(k, 0) + v
    util = {}
    for _, name, dims, v in _metric_rows(c, t0, t1, "claude.utilization."):
        util[name.rsplit(".", 1)[1]] = max(util.get(name.rsplit(".", 1)[1], 0.0), v)
    calls = _q(c, "SELECT count(*), coalesce(sum(value),0) FROM metric WHERE at>=? AND at<? AND name='llm.call'", t0, t1)
    return {"transcript": {k: int(v) for k, v in tr.items()}, "rate_limit_max_utilization": util,
            "llm_calls": int(calls[0][0]) if calls else 0, "cost_estimate_usd": round(float(calls[0][1]) if calls else 0.0, 6)}


def failures(c, t0, t1) -> dict:
    by_oc = dict(_q(c, "SELECT outcome, count(*) FROM fetch_log WHERE at>=? AND at<? GROUP BY outcome", t0, t1))
    runs = dict(_q(c, "SELECT coalesce(outcome,'running'), count(*) FROM run WHERE started_at>=? AND started_at<? GROUP BY 1", t0, t1))
    return {
        "fetch_errors": by_oc.get("error", 0),
        "retries": int(_one(c, "SELECT count(*) FROM queue WHERE attempts>1")),
        "dlq": {"open": int(_one(c, "SELECT count(*) FROM dlq")),
                "by_stage": dict(_q(c, "SELECT stage, count(*) FROM dlq GROUP BY stage"))},
        "circuit": {"open": int(_one(c, "SELECT count(*) FROM circuit WHERE state!='closed'")),
                    "trips": int(_one(c, "SELECT coalesce(sum(trips),0) FROM circuit"))},
        "runs_failed": runs.get("failed", 0), "runs_total": sum(runs.values()),
        "incidents": {"new": int(_one(c, "SELECT count(*) FROM incident WHERE at>=? AND at<?", t0, t1)),
                      "open": int(_one(c, "SELECT count(*) FROM incident WHERE acked_at IS NULL"))},
    }


def freshness(c, t0, t1, now_ms: int, registry=None) -> dict:
    states = dict(_q(c, "SELECT state, count(*) FROM source_state GROUP BY state"))
    stale_by_class: dict[str, int] = {}
    cls = {}
    try:
        reg = registry if registry is not None else __import__("kb.collect.registry", fromlist=["x"]).load_registry(validate=False)
        cls = {s.id: (s.class_ or "none") for s in reg}
    except Exception:  # noqa: BLE001 레지스트리를 못 읽어도 지표는 나온다
        pass
    for sid, nxt, ok in _q(c, "SELECT source_id, next_check_at, last_ok_at FROM source_state WHERE state!='disabled'"):
        if nxt is not None and nxt < now_ms - 3600_000 and (ok is None or ok < now_ms - 86400_000):
            k = cls.get(sid, "unknown")
            stale_by_class[k] = stale_by_class.get(k, 0) + 1
    lt = _one(c, "SELECT v FROM tick_state WHERE k='last_tick_at'", default=None)
    return {"sources_by_state": states, "stale_by_class": stale_by_class, "stale_total": sum(stale_by_class.values()),
            "last_tick_age_s": int((now_ms - int(lt)) / 1000) if lt and str(lt).isdigit() else None,
            "gaps": int(_msum(c, t0, t1, "gap"))}


def retrieval(c, t0, t1) -> dict:
    rows = _q(c, "SELECT tool, count(*), coalesce(sum(cards),0), coalesce(sum(tokens),0), coalesce(avg(ms),0), coalesce(max(ms),0), "
                 "coalesce(sum(zero),0) FROM query_log WHERE at>=? AND at<? GROUP BY tool", t0, t1)
    tools = {t[:48]: {"calls": n, "cards": int(cd), "est_tokens": int(tk), "avg_ms": round(a, 1), "max_ms": int(mx), "zero": int(z)}
             for t, n, cd, tk, a, mx, z in rows}
    total = sum(v["calls"] for v in tools.values())
    zero = sum(v["zero"] for v in tools.values())
    routes = dict(_q(c, "SELECT coalesce(route,'none'), count(*) FROM query_log WHERE at>=? AND at<? GROUP BY 1", t0, t1))
    get_n = tools.get("kb_get", {}).get("calls", 0)
    search_n = tools.get("kb_search", {}).get("calls", 0)
    return {"calls": total, "tools": tools, "zero_rate": round(zero / total, 4) if total else 0.0, "route_dist": routes,
            "get_followup_rate": round(min(get_n / search_n, 1.0), 4) if search_n else 0.0,
            "trail_mcp_calls": int(_msum(c, t0, t1, "transcript.trail_calls")),
            "kb_mcp_calls": int(_msum(c, t0, t1, "transcript.kb_calls"))}


def recovery(c, t0, t1, state_dir: Path | None = None) -> dict:
    def last(name):
        r = _q(c, "SELECT value FROM metric WHERE at>=? AND at<? AND name=? ORDER BY at DESC LIMIT 1", t0, t1, name)
        return float(r[0][0]) if r else 0.0
    drills = _q(c, "SELECT count(*), coalesce(sum(ok),0) FROM drill WHERE at>=? AND at<?", t0, t1)
    rtk_rows = 0
    p = (state_dir or Path.cwd() / ".state" / "rtk") / "history.db"
    if p.is_file():
        try:
            rc = sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=2)
            try:
                rtk_rows = int(rc.execute("SELECT count(*) FROM commands").fetchone()[0])
            finally:
                rc.close()
        except sqlite3.DatabaseError:
            rtk_rows = -1
    return {"rebuild_s": last("rebuild_s"), "fingerprint_checks": int(_msum(c, t0, t1, "fingerprint_check")),
            "backup_bytes": int(last("backup_bytes")), "train_s": last("train_s"),
            "drills": {"total": int(drills[0][0]) if drills else 0, "ok": int(drills[0][1]) if drills else 0},
            "ship_ok": int(_msum(c, t0, t1, "ship_ok")), "ship_fail": int(_msum(c, t0, t1, "ship_fail")),
            "rtk_history_rows": rtk_rows}


def transcript(c, t0, t1) -> dict:
    files = _msum(c, t0, t1, "transcript.files")
    lines = _msum(c, t0, t1, "transcript.lines")
    bad = _msum(c, t0, t1, "transcript.parse_fail")
    return {"files": int(files), "lines": int(lines), "parse_fail": int(bad),
            "parse_fail_rate": round(bad / lines, 6) if lines else 0.0}


def snapshot(c: sqlite3.Connection, *, now_ms: int | None = None, days: int = 7, registry=None,
             state_dir: Path | None = None) -> dict:
    from kb.metrics import llm
    t0, t1 = week_window(now_ms, days)
    return {
        "week": week_label(t1), "window": {"from": t0, "to": t1, "days": days},
        "yield": yield_(c, t0, t1), "tokens": tokens(c, t0, t1), "failures": failures(c, t0, t1),
        "freshness": freshness(c, t0, t1, t1, registry), "retrieval": retrieval(c, t0, t1),
        "recovery": recovery(c, t0, t1, state_dir), "transcript": transcript(c, t0, t1),
        "llm": llm.llm_metrics(c, t0, t1),
    }
