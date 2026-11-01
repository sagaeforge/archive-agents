"""kb request <주제> --reason <이유> [--priority N] [--url U] [--json]: 없는 정보 요청, 외부 사실 제보(WP-12).
MCP kb_request와 같은 kb.ticket.open_ticket을 부른다. 반환 {ticket, status, duplicates}."""
from __future__ import annotations

import json
import sys


def cmd_request(args) -> int:
    from kb import ticket
    from kb.write.errors import WriteRejected
    try:
        r = ticket.open_ticket(args.topic, args.reason, args.priority, args.url, transport="cli")
    except WriteRejected as e:
        print(json.dumps({"error": e.code, "message": e.message}, ensure_ascii=False) if args.json
              else f"오류 {e.code}: {e.message}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(r, ensure_ascii=False, sort_keys=True))
    else:
        print(f"{r['ticket']}  {r['status']}  duplicates={r['duplicates']}")
    return 0


def register(sub) -> None:
    p = sub.add_parser("request", help="없는 정보를 요청하거나 외부 사실 URL을 제보한다(티켓)")
    p.add_argument("topic")
    p.add_argument("--reason", required=True)
    p.add_argument("--priority", default=None, help="정수 또는 low, normal, high")
    p.add_argument("--url", default=None, help="근거 후보 URL(게이트를 지나기 전에는 사실이 아니다)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_request)
