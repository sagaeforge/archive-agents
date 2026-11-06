"""kb status 본문. 값은 호출할 때 계산한다(마지막 tick 값이 아니다). 사실과 건수만 내고 점수, 비율, 순위를 내지 않는다.

필드는 build-plan 2.3의 CLI JSON 약속이다: ok, critical[], warnings[], notices[], counts{}, by_domain{A~G},
freshness{}, incidents{open, items[]}, data_as_of. llm 블록은 WP-19가 더한다.
읽기 전용이다. ops.db나 gold가 없으면 만들지 않고 0으로 낸다.
"""
from __future__ import annotations

import datetime
import sqlite3

from kb.guard import watchdog

DOMAINS = tuple("ABCDEFG")
OK_VERIFICATION = ("quote_found", "parser_derived", "first_party")
FAIL_STATES = watchdog.FAIL_STATES
INCIDENT_LIMIT = 50


def _world_types() -> list[str]:
    from kb.read.catalog import BUILTIN_GROUP
    return sorted(t for t, g in BUILTIN_GROUP.items() if g == "world")


def _iso(ms: int | None) -> str | None:
    if ms is None:
        return None
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat(timespec="seconds")


def gold_counts() -> tuple[dict, dict, str | None]:
    """(counts, 도메인별 {snapshots, claims_active}, data_as_of). gold가 없으면 0."""
    counts = dict(nodes=0, edges=0, entities=0, claims_active=0, claims_review=0, snapshots=0)
    dom: dict[str, dict] = {}
    g = watchdog.gold_ro()
    if g is None:
        return counts, dom, None
    try:
        q1 = lambda sql, a=(): g.execute(sql, a).fetchone()[0]  # noqa: E731
        counts["nodes"] = q1("SELECT count(*) FROM node WHERE expired_at IS NULL")
        counts["edges"] = q1("SELECT count(*) FROM edge WHERE expired_at IS NULL")
        wt = _world_types()
        counts["entities"] = q1(f"SELECT count(*) FROM node WHERE expired_at IS NULL AND status='active' "
                                f"AND type IN ({','.join('?' * len(wt))})", wt)
        ph = ",".join("?" * len(OK_VERIFICATION))
        counts["claims_active"] = q1(f"SELECT count(*) FROM node WHERE expired_at IS NULL AND type='Claim' "
                                     f"AND status='active' AND eff_status='active' AND verification IN ({ph})", OK_VERIFICATION)
        counts["claims_review"] = q1("SELECT count(*) FROM node WHERE expired_at IS NULL AND type='Claim' "
                                     "AND status='active' AND verification='needs_review'")
        counts["snapshots"] = q1("SELECT count(*) FROM node WHERE expired_at IS NULL AND type='Snapshot'")
        for d, n in g.execute("SELECT d.domain, count(*) FROM node n JOIN node_domain d ON d.node_id=n.id "
                              "WHERE n.expired_at IS NULL AND n.type='Snapshot' GROUP BY d.domain"):
            dom.setdefault(d, {})["snapshots"] = n
        for d, n in g.execute(f"SELECT d.domain, count(*) FROM node n JOIN node_domain d ON d.node_id=n.id "
                              f"WHERE n.expired_at IS NULL AND n.type='Claim' AND n.status='active' "
                              f"AND n.eff_status='active' AND n.verification IN ({ph}) GROUP BY d.domain", OK_VERIFICATION):
            dom.setdefault(d, {})["claims_active"] = n
        r = g.execute("SELECT v FROM meta WHERE k='applied_seq'").fetchone()
        seq = int(r[0]) if r else 0
        at = g.execute("SELECT at FROM change WHERE seq<=? ORDER BY seq DESC, sub ASC LIMIT 1", (seq,)).fetchone() if seq else None
        return counts, dom, _iso(at[0] if at else None)
    except sqlite3.Error:
        return counts, dom, None
    finally:
        g.close()


def by_domain(gold_dom: dict) -> dict:
    """도메인별 활성 소스, 실패 소스, 스냅샷, 활성 주장 건수. 다중 도메인 소스는 각 도메인에 센다(합이 전체보다 클 수 있다)."""
    from kb.collect import registry
    out = {d: dict(sources_active=0, sources_failed=0, snapshots=0, claims_active=0) for d in DOMAINS}
    ops = watchdog.ops_ro()
    w = watchdog.W(now=watchdog.now_ms(), uptime=0.0, decisions=set(), ops=ops)
    try:
        states = watchdog.source_states(w)
    finally:
        if ops is not None:
            ops.close()
    srcs, _ = watchdog._registry()
    for s in srcs:
        if not (s.enabled and registry.runnable(s)[0]):
            continue
        failed = bool(states.get(s.id, {}).get("states", set()) & set(FAIL_STATES))
        for d in s.domain:
            row = out.setdefault(d, dict(sources_active=0, sources_failed=0, snapshots=0, claims_active=0))
            row["sources_active"] += 1
            row["sources_failed"] += 1 if failed else 0
    for d, v in gold_dom.items():
        row = out.setdefault(d, dict(sources_active=0, sources_failed=0, snapshots=0, claims_active=0))
        row.update({k: n for k, n in v.items()})
    return dict(sorted(out.items()))


def incidents() -> dict:
    ops = watchdog.ops_ro()
    if ops is None:
        return {"open": 0, "items": []}
    try:
        rows = ops.execute("SELECT id, at, kind, detail, path FROM incident WHERE acked_at IS NULL ORDER BY id").fetchall()
    except sqlite3.Error:
        rows = []
    finally:
        ops.close()
    items = [{"id": r[0], "at": r[1], "kind": r[2], "detail": r[3], **({"path": r[4]} if r[4] else {})}
             for r in rows[:INCIDENT_LIMIT]]
    return {"open": len(rows), "items": items}


def llm_block():
    """WP-19 공유 예외: kb.extract.budget의 장부에서 읽는다. 계산이 실패해도 kb status의 나머지는 그대로이고 llm은 null이다."""
    try:
        from kb.extract import budget
        return budget.llm_block()
    except Exception:  # noqa: BLE001
        return None


def build(now: int | None = None, *, uptime: float | None = None, decisions: set | None = None) -> dict:
    v = watchdog.compute(now, uptime=uptime, decisions=decisions)
    counts, gold_dom, as_of = gold_counts()
    counts["queue_l2"] = v["vector"].get("queue_l2", 0)
    return {
        "ok": not v["critical"],
        "critical": v["critical"],
        "warnings": v["warnings"],
        "notices": v["notices"],
        "counts": counts,
        "by_domain": by_domain(gold_dom),
        "freshness": {"last_tick_at": v["freshness"]["last_tick_at"],
                      "last_tick_age_s": v["freshness"]["last_tick_age_s"],
                      "stale_sources": v["freshness"]["stale_sources"]},
        "incidents": incidents(),
        "data_as_of": as_of,
        "llm": llm_block(),
    }


def _line(x: dict) -> str:
    extra = ", ".join(f"{k}={v}" for k, v in x.items() if k != "code" and v not in (None, "", [], {}))
    return f"{x['code']}" + (f" ({extra})" if extra else "")


def critical_text(st: dict) -> str:
    """세션 훅의 additionalContext. 치명 항목 줄들과 경고 건수 1줄."""
    lines = [f"치명: {_line(x)}" for x in st["critical"]]
    lines.append(f"kb status: 치명 {len(st['critical'])}건, 경고 {len(st['warnings'])}건, 안내 {len(st['notices'])}건")
    return "\n".join(lines)


def render_text(st: dict) -> str:
    c = st["counts"]
    out = [f"ok: {str(st['ok']).lower()}  data_as_of: {st['data_as_of'] or '-'}",
           f"counts: nodes={c['nodes']} edges={c['edges']} entities={c['entities']} claims_active={c['claims_active']} "
           f"claims_review={c['claims_review']} snapshots={c['snapshots']} queue_l2={c['queue_l2']}",
           "freshness: last_tick_age_s={} stale_sources={}".format(st["freshness"]["last_tick_age_s"], st["freshness"]["stale_sources"]),
           "incidents: open={}".format(st["incidents"]["open"])]
    for d, r in st["by_domain"].items():
        out.append(f"  {d}: sources_active={r['sources_active']} sources_failed={r['sources_failed']} "
                   f"snapshots={r['snapshots']} claims_active={r['claims_active']}")
    for label, key in (("치명", "critical"), ("경고", "warnings"), ("안내", "notices")):
        for x in st[key]:
            out.append(f"{label}: {_line(x)}")
    return "\n".join(out)
