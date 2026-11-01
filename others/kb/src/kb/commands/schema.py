"""kb schema sync [--json]"""
from __future__ import annotations

from kb.write.cliutil import emit, guarded
from kb.write import schema_sync


def cmd_schema(args) -> int:
    def run() -> int:
        emit(schema_sync.sync_schema(), args.json)
        return 0
    return guarded(run, args.json)


def register(sub) -> None:
    p = sub.add_parser("schema", help="타입과 술어 정의를 원장에 동기화")
    p.add_argument("action", choices=["sync"])
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_schema)
