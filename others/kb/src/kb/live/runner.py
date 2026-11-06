"""생존 판정 실행. 대상 선택 -> 신호 수집 -> 규칙 -> (상한 적용) -> verdict 쓰기 -> 효과(보류 해제, 의존 전파, 후속 재검사) -> 재확인 예약.
dry_run은 어떤 것도 쓰지 않는다(원장, 대기열, ops.db)."""
from __future__ import annotations

import time

from kb.core import opsdb
from kb.live import effects, gold as G, probe, reviewq, rules, schedule, verdict
from kb.live.model import AUTO_DEAD_CAP, TYPE_UNIT, Decision, Item

DECIDER = "live-rules@1"
QUEUE_KIND = "live"
SEED_EVERY_S = 6 * 3600
TRANSIENT = {"budget_exceeded", "circuit_open"}
RETRY_TRANSIENT_MS = 3600_000
TYPES = tuple(TYPE_UNIT)


def _now() -> int:
    return int(time.time() * 1000)


def unit_of(node_type: str) -> str:
    return TYPE_UNIT.get((node_type or "").lower(), (node_type or "").lower())


def seed(con, now: int | None = None, *, force: bool = False) -> int:
    """gold의 G 단위 노드를 live 큐에 넣는다(이미 있으면 그대로). 6시간에 한 번만 훑는다. 넣은 수."""
    now = now or _now()
    c = opsdb.connect()
    try:
        last = int(opsdb.tick_state_get(c, "live:seed_at", "0") or 0)
        if not force and now - last < SEED_EVERY_S * 1000:
            return 0
        n = 0
        for nd in G.g_nodes(con, [t for t in TYPES if t != "project"]):
            n += 1 if opsdb.queue_put(c, QUEUE_KIND, nd["id"], domain="G", priority=0) else 0
        opsdb.tick_state_set(c, "live:seed_at", now)
        return n
    finally:
        c.close()


def select_targets(con, limit: int, *, now: int | None = None) -> list:
    """live 큐에서 만기 항목을 꺼내 대상 dict로 만든다. gold에 없는 항목은 큐에서 지운다(R_LIVENESS_UNKNOWN 주어는 노드가 있다)."""
    out = []
    c = opsdb.connect()
    try:
        for it in opsdb.queue_take(c, QUEUE_KIND, limit):
            nd = G.node(con, it["ref"])
            if not nd:
                opsdb.queue_done(c, QUEUE_KIND, it["ref"])
                continue
            out.append(_target(nd))
    finally:
        c.close()
    return out


def _target(nd: dict) -> dict:
    return {"id": nd["id"], "type": unit_of(nd["type"]), "label": nd["label"], "props": nd.get("props") or {},
            "liveness": nd.get("liveness"), "recorded_at": nd.get("recorded_at")}


def evaluate(t: dict, fx, now: int, gh=None) -> tuple:
    pr = probe.gather(t, fx, now, gh=gh)
    cur = t.get("liveness")
    cur = "alive" if cur == "active" else cur
    if not pr.sigs:
        return None, pr
    d = rules.decide(t["id"], t["type"], pr.sigs, current=cur, now_ms=now)
    return d, pr


def apply_cap(decisions: list, cap: int = AUTO_DEAD_CAP) -> int:
    """자동 dead(removed로 바뀌는 자동 판정)를 실행당 cap건까지만 둔다. 초과분은 대기열로 보낸다. 넘긴 건수."""
    dead = sorted([d for d in decisions if d.liveness == "removed" and d.auto and d.changed], key=lambda d: d.target)
    over = dead[cap:]
    for d in over:
        d.queue.append(Item("H01", f"실행당 자동 dead {cap}건 상한 초과. 사람이 확정", "removed"))
        d.liveness, d.auto = (d.current or "alive"), False
    return len(over)


def run(targets: list, fx, *, now: int | None = None, dry_run: bool = False, con=None, gh=None,
        cap: int = AUTO_DEAD_CAP, schedule_next: bool = True, check_sources: bool = True) -> dict:
    now = now or _now()
    own = con is None and not dry_run
    if con is None:
        try:
            con = G.open_gold()
        except Exception:  # noqa: BLE001  gold가 아직 없다
            con = None
    s = {"targets": len(targets), "checked": 0, "unreachable": 0, "unreachable_reasons": {}, "changed": 0, "written": 0, "queued": 0, "capped": 0,
         "rejected": 0, "released": 0, "propagated": 0, "rechecks": 0, "errors": [], "dry_run": dry_run, "decisions": []}
    try:
        decs, probes = [], {}
        for t in targets:
            try:
                d, pr = evaluate(t, fx, now, gh)
            except Exception as e:  # noqa: BLE001  한 대상의 실패가 나머지를 막지 않는다
                s["errors"].append(f"{t['id']}: {type(e).__name__}: {e}"[:300])
                continue
            probes[t["id"]] = pr
            if d is None:
                s["unreachable"] += 1
                why = pr.reasons[0] if pr.reasons else "no_probe"       # no_probe: 확인할 URL이나 속성이 없다
                s["unreachable_reasons"][why] = s["unreachable_reasons"].get(why, 0) + 1
                continue
            s["checked"] += 1
            decs.append(d)
        s["capped"] = apply_cap(decs, cap)
        for d in decs:
            info = d.as_dict()
            if d.changed and d.auto:
                s["changed"] += 1
            if not dry_run:
                _apply(d, con, s, check_sources, now)
            else:
                s["queued"] += len(d.queue)
            s["decisions"].append(info)
        if not dry_run and schedule_next:
            c = opsdb.connect()
            try:
                for t in targets:
                    d = next((x for x in decs if x.target == t["id"]), None)
                    lv = d.liveness if d else t.get("liveness")
                    at = schedule.next_at_ms(t["id"], t["type"], lv, now if (d and d.changed) else t.get("recorded_at"), now)
                    pr = probes.get(t["id"])
                    if d is None and pr is not None and TRANSIENT & set(pr.reasons):
                        at = min(at, now + RETRY_TRANSIENT_MS)      # 예산, 회로 차단은 주기를 기다리지 않고 곧 다시 본다
                    opsdb.queue_put(c, QUEUE_KIND, t["id"], domain="G", priority=0, next_at=at)
                    opsdb.queue_done(c, QUEUE_KIND, t["id"], requeue_at=at)
            finally:
                c.close()
    finally:
        if own and con is not None:
            con.close()
    return s


def _apply(d: Decision, con, s: dict, check_sources: bool, now: int) -> None:
    for it in d.queue:
        reviewq.open_item(d.target, d.unit, it, d.signals)
        s["queued"] += 1
    wrote = False
    if d.changed and d.auto:
        try:
            p = verdict.build(d, DECIDER, con, check=check_sources)
            verdict.write(p)
            wrote = True
            s["written"] += 1
        except verdict.VerdictRejected as e:
            s["rejected"] += 1
            s["errors"].append(f"{d.target}: {e}"[:300])
            reviewq.open_item(d.target, d.unit, Item("H01", f"근거 거부({e.code}). 사람이 확인", d.liveness, d.successor), d.signals)
            s["queued"] += 1
    if wrote:
        _effects(d, s, now)
    for rc in d.recheck:
        _enqueue_recheck(rc, s)


def _effects(d: Decision, s: dict, now: int) -> None:
    con = G.open_gold()
    try:
        if con is None:
            return
        s["released"] += len(effects.release_held(d.target, con))
        if d.liveness in ("removed", "superseded"):
            snap = next((x for x in d.signals if x.snapshot), None)
            s["propagated"] += len(effects.propagate_dead(d.target, con, snapshot_sig=snap))
    finally:
        if con is not None:
            con.close()


def _enqueue_recheck(rc: dict, s: dict) -> None:
    try:
        eid = verdict.successor_entity("repo", rc["target"])
    except ValueError:
        return
    c = opsdb.connect()
    try:
        if opsdb.queue_put(c, QUEUE_KIND, eid, domain="G", priority=2):
            s["rechecks"] += 1
    finally:
        c.close()
