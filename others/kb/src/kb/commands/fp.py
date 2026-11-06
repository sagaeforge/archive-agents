"""kb fp status|list [--grep 어휘]|open [--accept-single-copy]"""
from __future__ import annotations

from kb.write.cliutil import emit
from kb.write import fpgate


def cmd_fp(args) -> int:
    if args.action == "status":
        emit(fpgate.status(), args.json)
        return 0
    if args.action == "list":
        items = fpgate.list_held(args.grep)
        if args.json:
            emit({"items": items}, True)
        else:
            for it in items:
                print(f"{it['id']}\t{it['type']}\t{it['title']}")
        return 0
    r = fpgate.open_fp(args.accept_single_copy)
    emit(r.as_dict(), args.json)
    return 0 if r.ok else 1


def register(sub) -> None:
    p = sub.add_parser("fp", help="first_party 게이트: 상태, 보관 목록, 개방")
    p.add_argument("action", choices=["status", "list", "open"])
    p.add_argument("--grep", help="list: 보관 본문에서 찾을 어휘")
    p.add_argument("--accept-single-copy", action="store_true", help="open: 단일 사본 위험 수용(TTY, 결정 2)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_fp)
