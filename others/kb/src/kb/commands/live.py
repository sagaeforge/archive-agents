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
    p.set_defaults(func=lambda a: (p.print_help(), 2)[1])
