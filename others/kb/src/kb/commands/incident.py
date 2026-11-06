"""kb incident list [--all] | ack <id> --note <메모>: ops.db 사고 목록과 확인(WP-15).
미확인 사고는 kb status의 치명이다. 사용자에게 보고한 뒤 ack로 닫는다."""
from __future__ import annotations

import json
import sqlite3
import sys


def _rows(show_all: bool) -> list[dict]:
    from kb.core import opsdb
    from kb.guard import watchdog

    c = watchdog.ops_ro()
    if c is None:
        return []
    try:
        where = "" if show_all else "WHERE acked_at IS NULL"
        cur = c.execute(f"SELECT id, at, kind, detail, path, acked_at, ack_note FROM incident {where} ORDER BY id")
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]
    except sqlite3.Error:
        return []
    finally:
        c.close()


def cmd_list(args) -> int:
    rows = _rows(args.all)
    if args.json:
        print(json.dumps({"items": rows, "open": sum(1 for r in rows if r["acked_at"] is None)}, ensure_ascii=False, sort_keys=True))
    else:
        for r in rows:
            mark = "확인" if r["acked_at"] else "미확인"
            print(f"{r['id']}\t{mark}\t{r['kind']}\t{r['detail']}" + (f"\t노트: {r['ack_note']}" if r["ack_note"] else ""))
        if not rows:
            print("미확인 사고 없음" if not args.all else "사고 없음")
    return 0


def cmd_ack(args) -> int:
    from kb.core import opsdb

    note = (args.note or "").strip()
    if not note:
        print("오류: --note가 필요하다", file=sys.stderr)
        return 2
    ok = opsdb.ack_incident(args.id, note)
    if args.json:
        print(json.dumps({"id": args.id, "acked": ok}))
    else:
        print(f"사고 {args.id} 확인" if ok else f"사고 {args.id}가 없거나 이미 확인됨")
    return 0 if ok else 1


def register(sub) -> None:
    p = sub.add_parser("incident", help="사고 목록과 확인(미확인 사고는 status의 치명)")
    s = p.add_subparsers(dest="incident_cmd", metavar="<list|ack>")
    ls = s.add_parser("list", help="미확인 사고(--all이면 전부)")
    ls.add_argument("--all", action="store_true")
    ls.add_argument("--json", action="store_true")
    ls.set_defaults(func=cmd_list)
    ak = s.add_parser("ack", help="사용자 보고 뒤 사고를 닫는다")
    ak.add_argument("id", type=int)
    ak.add_argument("--note", required=True)
    ak.add_argument("--json", action="store_true")
    ak.set_defaults(func=cmd_ack)
    p.set_defaults(func=lambda a: (p.print_help(), 2)[1])
