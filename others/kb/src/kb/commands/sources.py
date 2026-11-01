"""kb sources sync|list. 레지스트리(sources/domains/*.yaml + overlays)를 읽고 원장에 source.registered로 동기화한다(WP-07)."""
from __future__ import annotations

import json
import sys


def _list(args) -> int:
    from kb.collect import registry
    rows = []
    for s in registry.load_registry():
        ok, why = registry.runnable(s)
        rows.append({"id": s.id, "inventory_id": s.inventory_id, "enabled": s.enabled, "runnable": ok, "why": why,
                     "tos": s.tos, "class": s.class_, "domain": s.domain, "parser": s.parser,
                     "requires_decision": s.policy.get("requires_decision"), "reason": s.policy.get("reason")})
    if args.only_active:
        rows = [r for r in rows if r["runnable"]]
    if args.json:
        print(json.dumps({"items": rows, "count": len(rows)}, ensure_ascii=False, sort_keys=True))
    else:
        for r in rows:
            flag = "on " if r["runnable"] else "off"
            print(f"{flag}\t{r['id']}\t{r['inventory_id'] or '-'}\t{r['tos']}\t{r['why'] or r['reason'] or ''}")
    return 0


def _sync(args) -> int:
    from kb.parse import registry_sync
    try:
        out = registry_sync.sync(dry_run=args.dry_run)
    except Exception as e:  # noqa: BLE001
        print(f"kb sources sync: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    print(json.dumps(out, ensure_ascii=False, sort_keys=True) if args.json else
          f"sources={out['sources']} registered={out['registered']} gone={out['gone']} unchanged={out['unchanged']}")
    return 0


def register(sub) -> None:
    p = sub.add_parser("sources", help="소스 레지스트리 동기화와 목록")
    sp = p.add_subparsers(dest="sources_cmd", metavar="<동작>")
    s = sp.add_parser("sync", help="레지스트리 변경을 source.registered, source.status로 쓴다")
    s.add_argument("--dry-run", action="store_true")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=_sync)
    l = sp.add_parser("list", help="소스 목록과 실행 가능 여부")
    l.add_argument("--only-active", action="store_true")
    l.add_argument("--json", action="store_true")
    l.set_defaults(func=_list)
    p.set_defaults(func=lambda a: (p.print_help(), 2)[1])
