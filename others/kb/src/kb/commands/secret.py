"""kb secret release <id> (TTY 전용) | kb secret scan [파일|-]"""
from __future__ import annotations

import sys

from kb.write.cliutil import emit, guarded
from kb.write import secrets_scan


def cmd_secret(args) -> int:
    def run() -> int:
        if args.action == "release":
            from kb.write.errors import WriteRejected
            error = WriteRejected('review_unverified', 'Use the reviewer confirmation flow')
            error.status = 403
            raise error
        text = sys.stdin.read() if args.target in (None, "-") else open(args.target, encoding="utf-8").read()
        rules = sorted({h.rule for h in secrets_scan.scan_text(text)})
        emit({"hits": rules}, args.json)
        return 1 if rules else 0
    return guarded(run, args.json)


def register(sub) -> None:
    p = sub.add_parser("secret", help="비밀 탐지: 오탐 해제(release, TTY), 텍스트 검사(scan)")
    p.add_argument("action", choices=["release", "scan"])
    p.add_argument("target", nargs="?", help="release: 레코드 ID. scan: 파일(-는 표준입력)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_secret)
