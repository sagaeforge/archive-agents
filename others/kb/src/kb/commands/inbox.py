"""kb inbox scan [--min-age 초] [--json]"""
from __future__ import annotations

from kb.write.cliutil import emit
from kb.write import inbox as _inbox


def cmd_inbox(args) -> int:
    r = _inbox.scan(min_age_s=args.min_age)
    emit(r.as_dict(), args.json)
    return 1 if r.failed or r.conflicts else 0


def register(sub) -> None:
    p = sub.add_parser("inbox", help="inbox/*.md를 지금 처리한다(tick이 같은 일을 한다)")
    p.add_argument("action", choices=["scan"])
    p.add_argument("--min-age", type=float, default=_inbox.MIN_AGE_S, help="수정 후 최소 경과 초(기본 30)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_inbox)
