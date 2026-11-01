"""kb export markdown [--commit]"""
from __future__ import annotations

import json

from kb.guard import export_md


def cmd_export(args) -> int:
    r = export_md.export_markdown(commit=True if args.commit else None)
    if args.json:
        print(json.dumps(r, ensure_ascii=False, sort_keys=True))
    else:
        for k, v in r.items():
            print(f"{k}: {v}")
    return 0


def register(sub) -> None:
    p = sub.add_parser("export", help="first_party Markdown 내보내기(작업 트리까지)")
    p.add_argument("what", choices=["markdown"])
    p.add_argument("--commit", action="store_true", help="로컬 커밋(설정 export.local_commit과 무관하게 이번만)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_export)
