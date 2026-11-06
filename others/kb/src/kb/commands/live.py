"""kb live run. 생존 판정을 돌린다(WP-09). --dry-run은 원장, 대기열, ops.db에 아무것도 쓰지 않고 네트워크도 쓰지 않는다."""
from __future__ import annotations

import json
import sys


def _load_fixture(path: str):
    """--sources 파일: 표준 레지스트리(sources:) + live: {targets, responses}."""
    from kb.collect import registry
    doc = registry.read_yaml(__import__("pathlib").Path(path)) or {}
    srcs = [registry._build(e) for e in (doc.get("sources") or [])]
    live = doc.get("live") or {}
    return srcs, live.get("targets") or [], live.get("responses") or {}


def _run(args) -> int:
    from kb.live import gold as G, ghgraphql, probe, runner
    try:
        if args.sources:
            srcs, ftargets, responses = _load_fixture(args.sources)
        else:
            srcs, ftargets, responses = None, [], {}
        con = None
        try:
            con = G.open_gold()
        except Exception:  # noqa: BLE001
            con = None
        if args.sources:
            targets = [runner._target(dict(t, type=t.get("type", "document"), props=t.get("props") or {}, label=t.get("label", t["id"])))
                       for t in ftargets]
            targets = [dict(t, type=runner.unit_of(t["type"])) for t in targets]
        elif args.target:
            targets = [runner._target(n) for n in (G.node(con, t) for t in args.target) if n]
        elif args.dry_run:
            targets = [runner._target(n) for n in G.g_nodes(con, [t for t in runner.TYPES if t != "project"])][:args.limit]
        else:
            runner.seed(con)
            targets = runner.select_targets(con, args.limit)
        if args.limit:
            targets = targets[:args.limit]
        if args.dry_run:
            fx = probe.OfflineFetcher(responses)
        else:
            fx = probe.CaptureFetcher(srcs)
        gh = None
        if not args.dry_run and ghgraphql.enabled():
            names = [t["label"] for t in targets if t["type"] == "repo" and "/" in str(t["label"])]
            own = fx.owner("https://api.github.com/repos/x/y")
            gh = ghgraphql.GhBatch(names, source=own.id if own else None) if names else None
        out = runner.run(targets, fx, dry_run=args.dry_run, con=con, gh=gh, check_sources=not args.dry_run)
    except Exception as e:  # noqa: BLE001
        print(f"kb live run: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(out, ensure_ascii=False, sort_keys=True))
    else:
        print(" ".join(f"{k}={out[k]}" for k in ("targets", "checked", "unreachable", "changed", "written", "queued", "capped", "rejected")))
        for d in out["decisions"]:
            print(f"  {d['target']}\t{d['unit']}\t{d['current'] or '-'} -> {d['liveness']}\t{'auto' if d['auto'] else 'human'}")
    return 0


HOLD_PREFIX = "gate_l1:{cid}:R_LIVENESS_UNKNOWN"


def _latest_verdict(led, cid: str, subject: str | None = None):
    """원장에서 주장의 마지막 verification 이벤트. (seq, actor, idem_key, verification) 또는 None.
    claim.review의 subject는 주장 ID이고 claim.assert의 subject는 주어 엔티티라 payload id로 찾는다."""
    from kb.core import ledger
    best = None
    for seq, actor, idem, sha in led.execute("SELECT seq, actor, idem_key, payload_sha FROM event WHERE subject=? "
                                             "AND kind='claim.review' ORDER BY seq DESC", (cid,)):
        p = ledger.get_payload(led, sha) or {}
        if p.get("verification"):
            best = (seq, actor, idem, p["verification"])
            break
    if subject:
        for seq, actor, idem, sha in led.execute("SELECT seq, actor, idem_key, payload_sha FROM event WHERE subject=? "
                                                 "AND kind='claim.assert' AND seq>? ORDER BY seq DESC", (subject, best[0] if best else 0)):
            p = ledger.get_payload(led, sha) or {}
            if p.get("id") == cid and p.get("verification"):
                return seq, actor, idem, p["verification"]
    return best


def release_events_plan(con, led) -> list:
    """kind=event이고 현재 needs_review이며 마지막 verification 이벤트가 gate_l1의 R_LIVENESS_UNKNOWN 보류인 주장.
    그 뒤에 다른 사유의 검토(live:suspect, LLM 재주장 등)가 있으면 뺀다. [{id, subject, type, domains, seq, ver}]"""
    from kb.gate.liveness import type_of
    rows = con.execute("SELECT n.id, c.subject, c.method FROM claim c JOIN node n ON n.vid=c.vid WHERE n.expired_at IS NULL "
                       "AND n.status='active' AND n.verification='needs_review' AND c.kind='event' ORDER BY n.id").fetchall()
    out = []
    for cid, subj, method in rows:
        last = _latest_verdict(led, cid, subj)
        if not last or last[3] != "needs_review" or last[1] != "gate_l1" or not last[2].startswith(HOLD_PREFIX.format(cid=cid)):
            continue
        doms = [r[0] for r in con.execute("SELECT domain FROM node_domain WHERE node_id=? ORDER BY domain", (cid,))]
        out.append({"id": cid, "subject": subj, "type": type_of(subj), "domains": doms, "seq": last[0],
                    "ver": "parser_derived" if method == "deterministic" else "quote_found"})
    return out


def _release_events(args) -> int:
    from kb.commands.llm import _guard_apply
    from kb.core import ledger
    from kb.core.conn import connect_ro
    from kb.project import current_gold_path
    from kb.write import commit
    if args.apply:
        why = _guard_apply()
        if why:
            print(f"kb live release-events: {why}", file=sys.stderr)
            return 2
    gp = current_gold_path()
    if gp is None:
        print("kb live release-events: gold가 없다", file=sys.stderr)
        return 2
    con, led = connect_ro(gp, 60.0), ledger.open_ledger()
    try:
        plan = release_events_plan(con, led)
    finally:
        con.close()
        led.close()
    by_type: dict = {}
    for r in plan:
        by_type[r["type"]] = by_type.get(r["type"], 0) + 1
    out = {"candidates": len(plan), "by_type": by_type, "domain_G": sum(1 for r in plan if "G" in r["domains"]),
           "applied": 0, "dry_run": not args.apply}
    if args.apply:
        n = 0
        for i in range(0, len(plan), 200):
            r = commit([{"kind": "claim.review", "actor": "live", "origin": "system", "subject": x["id"],
                         "idem_key": f"live:release-event:{x['id']}:{x['seq']}",           # 보류가 다시 걸리면 seq가 달라져 실제로 쓴다
                         "payload": {"id": x["id"], "verification": x["ver"], "decided_by": "live"}} for x in plan[i:i + 200]],
                       "live", timeout=60.0)
            n += sum(1 for e in r.events if not e["replayed"])
        out["applied"] = n
    print(json.dumps(out, ensure_ascii=False, sort_keys=True) if args.json else
          " ".join(f"{k}={v}" for k, v in out.items()))
    return 0


def register(sub) -> None:
    p = sub.add_parser("live", help="생존 판정")
    sp = p.add_subparsers(dest="live_cmd", metavar="<동작>")
    r = sp.add_parser("run", help="만기 대상의 신호를 모아 판정한다")
    r.add_argument("--dry-run", action="store_true", help="아무것도 쓰지 않고 네트워크도 쓰지 않는다")
    r.add_argument("--sources", help="시험 레지스트리 파일(sources:, live.targets, live.responses)")
    r.add_argument("--target", action="append", help="대상 엔티티 ID(여러 번)")
    r.add_argument("--limit", type=int, default=20)
    r.add_argument("--json", action="store_true")
    r.set_defaults(func=_run)
    e = sp.add_parser("release-events", help="생존 미상으로 보류된 event 주장을 푼다(기본은 dry-run)")
    e.add_argument("--apply", action="store_true", help="쓴다. 없으면 개수만 센다")
    e.add_argument("--json", action="store_true")
    e.set_defaults(func=_release_events)
    p.set_defaults(func=lambda a: (p.print_help(), 2)[1])
