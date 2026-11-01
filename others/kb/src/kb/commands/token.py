"""kb token create --scope viewer|owner: TCP용 API 토큰(WP-10, 계약 7장). 파일은 $KB_CONFIG_DIR/api-tokens(0600), sha256만 저장한다."""
from __future__ import annotations

import sys


def _create(args) -> int:
    from kb.serve.http import create_token, tokens_path
    tok = create_token(args.scope, args.label or "")
    print(tok)
    print(f"저장: {tokens_path()} (sha256만 기록. 이 토큰은 다시 볼 수 없다)", file=sys.stderr)
    return 0


def register(sub) -> None:
    p = sub.add_parser("token", help="API 토큰 관리")
    ts = p.add_subparsers(dest="token_cmd", metavar="<하위명령>")
    c = ts.add_parser("create", help="토큰을 만든다")
    c.add_argument("--scope", required=True, choices=["viewer", "owner"])
    c.add_argument("--label", default="")
    c.set_defaults(func=_create)
    p.set_defaults(func=lambda a: (p.print_help(), 2)[1])
