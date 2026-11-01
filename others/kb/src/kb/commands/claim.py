"""kb claim retract --extractor <id> [--reason ...] [--json]. 한 extractor가 낸 활성 주장을 한 번에 철회한다(claim.retract)."""
from __future__ import annotations

import json


def cmd_retract(args) -> int:
    from kb.core.conn import connect_ro
    from kb.project import current_gold_path
    from kb.write import commit
    gp = current_gold_path()
    ids: list = []
    if gp is not None:
        con = connect_ro(gp, 60.0)
        try:
            ids = [r[0] for r in con.execute(
                "SELECT n.id FROM node n JOIN claim c ON c.vid=n.vid WHERE n.type='Claim' AND n.expired_at IS NULL "
                "AND n.status='active' AND c.extractor=? ORDER BY n.id", (args.extractor,))]
        finally:
            con.close()
    n = 0
    reason = args.reason or f"extractor {args.extractor} 대량 철회"
    for i in range(0, len(ids), 200):
        chunk = ids[i:i + 200]
        r = commit([{"kind": "claim.retract", "actor": "l2", "origin": "system", "subject": cid,
                     "idem_key": f"retract-ext:{args.extractor}:{cid}",
                     "payload": {"id": cid, "extractor": args.extractor, "reason": reason}} for cid in chunk], "l2", timeout=60.0)
        n += sum(1 for e in r.events if not e["replayed"])
    out = {"extractor": args.extractor, "matched": len(ids), "retracted": n}
    print(json.dumps(out, ensure_ascii=False) if args.json else f"철회 {n}건 (대상 {len(ids)}건)")
    return 0


def register(sub) -> None:
    p = sub.add_parser("claim", help="주장 관리")
    s = p.add_subparsers(dest="claim_cmd", metavar="<하위>")
    r = s.add_parser("retract", help="extractor별 대량 철회")
    r.add_argument("--extractor", required=True)
    r.add_argument("--reason", default=None)
    r.add_argument("--json", action="store_true")
    r.set_defaults(func=cmd_retract)
    p.set_defaults(func=lambda a: (p.print_help(), 2)[1])
