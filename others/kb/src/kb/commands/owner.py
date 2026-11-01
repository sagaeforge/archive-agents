"""kb owner read <id> (TTY 전용)"""
from __future__ import annotations

from kb.write.cliutil import emit, guarded
from kb.write import owner


def cmd_owner(args) -> int:
    def run() -> int:
        emit(owner.read_record(args.id), True)
        return 0
    return guarded(run, True)


def register(sub) -> None:
    p = sub.add_parser("owner", help="소유자 읽기(private, secret 본문 포함, TTY 전용)")
    p.add_argument("action", choices=["read"])
    p.add_argument("id")
    p.set_defaults(func=cmd_owner)
