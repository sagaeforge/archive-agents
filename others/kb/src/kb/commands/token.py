"""API 토큰 발급·회전·폐기(ADR-0005 §3.3). 토큰 값은 발급 때만 출력한다."""
from __future__ import annotations

import sys


def _create(args) -> int:
    from kb.serve.http import create_token, tokens_path
    from kb.write.tty import is_tty
    if args.scope in ("editor", "reviewer") and not is_tty():
        print("토큰 발급에는 TTY가 필요하다", file=sys.stderr)
        return 2
    try:
        tok = create_token(args.scope, args.label or "", args.expires)
    except ValueError:
        print("토큰 발급을 거절했습니다", file=sys.stderr)
        return 2
    print(tok)
    print(f"저장: {tokens_path()} (sha256만 기록. 이 토큰은 다시 볼 수 없다)", file=sys.stderr)
    return 0


def _change(args) -> int:
    from kb.write.tty import is_tty
    from kb.serve.http import change_token
    if not is_tty():
        print("토큰 관리에는 TTY가 필요하다", file=sys.stderr)
        return 2
    try:
        token = change_token(args.label, rotate=args.token_cmd == "rotate")
    except ValueError:
        print("토큰 변경을 거절했습니다", file=sys.stderr)
        return 2
    if token:
        print(token)
    return 0


def register(sub) -> None:
    p = sub.add_parser("token", help="API 토큰 관리")
    ts = p.add_subparsers(dest="token_cmd", metavar="<하위명령>")
    c = ts.add_parser("create", help="토큰을 만든다")
    c.add_argument("--scope", required=True, choices=["viewer", "owner", "editor", "reviewer"])
    c.add_argument("--label", default="")
    c.add_argument("--expires", help="시간대가 있는 ISO 8601 만료 시각(기본 180일)")
    c.set_defaults(func=_create)
    for name in ("rotate", "revoke"):
        change = ts.add_parser(name, help="토큰 회전" if name == "rotate" else "토큰 폐기")
        change.add_argument("--label", required=True)
        change.set_defaults(func=_change)
    p.set_defaults(func=lambda a: (p.print_help(), 2)[1])
