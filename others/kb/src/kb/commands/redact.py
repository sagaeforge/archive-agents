"""kb redact <id> --reason 사유 (TTY 전용)"""
from __future__ import annotations

import json

from kb.guard import redact as _r
from kb.write import tty as _tty


def cmd_redact(args) -> int:
    def out(o):
        print(json.dumps(o, ensure_ascii=False, sort_keys=True, default=str) if args.json else
              "\n".join(f"{k}: {v}" for k, v in o.items()))

    if not _tty.is_tty():
        out({"ok": False, "error": "kb redact는 TTY에서만 동작한다"})
        return 1
    try:
        res: dict = {}
        if args.reason:
            res = _r.redact_record(args.id, args.reason, rebuild_gold=not args.no_rebuild)
        if args.purge_git:
            res["git"] = _r.purge_git(args.purge_git, args.git_path or [])
        if args.purge_restic:
            res["restic"] = _r.purge_restic(args.target or None, rid=args.id)
        if not res:
            out({"ok": False, "error": "--reason 또는 --purge-* 가 필요하다"})
            return 1
    except (_r.RedactError, Exception) as e:  # noqa: BLE001
        out({"ok": False, "error": f"{type(e).__name__}: {e}"})
        return 1
    res.setdefault("ok", True)
    out(res)
    return 0 if res.get("ok") else 1


def register(sub) -> None:
    p = sub.add_parser("redact", help="레코드 삭제(record.redact + 파생 정리, TTY 전용)")
    p.add_argument("id")
    p.add_argument("--reason", help="사유(필수, 첫 실행)")
    p.add_argument("--no-rebuild", action="store_true", help="gold 재구축을 건너뜀")
    p.add_argument("--purge-restic", action="store_true", help="restic 과거 세대에서 지움(rewrite + prune)")
    p.add_argument("--target", action="append", help="restic 대상 id")
    p.add_argument("--purge-git", metavar="저장소", help="내보내기 git 이력에서 --git-path 파일을 지움")
    p.add_argument("--git-path", action="append", help="저장소 안의 상대 경로")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_redact)
