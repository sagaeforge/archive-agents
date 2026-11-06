"""kb review list|decide|propose. 사람 판단 대기열(H01~H11)."""
from __future__ import annotations

import json
import sys


def _list(args) -> int:
    from kb.live import reviewq
    items = reviewq.list_open(args.limit)
    if args.json:
        print(json.dumps({"items": items, "count": len(items)}, ensure_ascii=False, sort_keys=True))
    else:
        for i in items:
            print(f"{i['id']}\t{i['target']}\t{i['unit']}\t{i['question']}\t-> {i['proposed'].get('liveness')}")
    return 0


def _decide(args) -> int:
    # A TTY and a caller-supplied --by value are not human verification.
    # Manual decisions use the bound reviewer challenge/resolve path.
    print('kb review decide: review_unverified; use the reviewer confirmation flow', file=sys.stderr)
    return 2


def _propose(args) -> int:
    from kb.live import reviewq
    ok = reviewq.propose(args.id, args.liveness, args.by, successor=args.successor)
    print(json.dumps({"id": args.id, "proposed": ok}) if args.json else ("제안 기록" if ok else "열린 항목 아님"))
    return 0 if ok else 2


def register(sub) -> None:
    p = sub.add_parser("review", help="사람 판단 대기열")
    sp = p.add_subparsers(dest="review_cmd", metavar="<동작>")
    l = sp.add_parser("list", help="열린 항목")
    l.add_argument("--limit", type=int)
    l.add_argument("--json", action="store_true")
    l.set_defaults(func=_list)
    d = sp.add_parser("decide", help="사람이 상태를 확정한다")
    d.add_argument("id", type=int)
    d.add_argument("--liveness", choices=["alive", "renamed", "scheduled_removal", "removed", "superseded", "stale_suspect",
                                          "revived", "deprecated", "partial"])
    d.add_argument("--successor")
    d.add_argument("--keep", action="store_true", help="상태를 바꾸지 않고 닫는다")
    d.add_argument("--by", default="user")
    d.add_argument("--json", action="store_true")
    d.set_defaults(func=_decide)
    q = sp.add_parser("propose", help="에이전트 제안(후보로만 남는다)")
    q.add_argument("id", type=int)
    q.add_argument("--liveness", required=True)
    q.add_argument("--successor")
    q.add_argument("--by", required=True)
    q.add_argument("--json", action="store_true")
    q.set_defaults(func=_propose)
    p.set_defaults(func=lambda a: (p.print_help(), 2)[1])
