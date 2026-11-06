"""kb intake plan|run|status|verify|deny-build|purge-copy [--json] (WP-26).
세션 조사 자료 대장(docs/intake/session-research.yaml)을 first_party 기록과 URL 티켓으로 옮긴다."""
from __future__ import annotations

import json
import sys

from kb.write.cliutil import emit, fail


def cmd_intake(args) -> int:
    from kb import intake
    from kb.intake import deny
    from kb.intake.errors import IntakeError
    from kb.write.errors import WriteRejected
    try:
        if args.action == "deny-build":
            from kb.intake.manifest import default_copy_dir
            from pathlib import Path
            cd = Path(args.copy_dir).expanduser() if args.copy_dir else default_copy_dir()
            emit(deny.build(cd, deny.read_names(args.nodes)), args.json)
            return 0
        man = intake.load_manifest(args.manifest)
        if args.copy_dir:
            man["copy_dir"] = args.copy_dir
        if args.action == "plan":
            out = intake.plan(man, detail=args.detail)
        elif args.action == "run":
            out = intake.run(man, detail=args.detail)
        elif args.action == "status":
            out = intake.status(man, detail=args.detail)
        elif args.action == "verify":
            out = intake.verify(man)
        else:
            out = intake.purge_copy(man, apply=args.apply)
        emit(out, args.json)
        return 0
    except IntakeError as e:
        return fail(e.code, e.message, args.json)
    except WriteRejected as e:
        return fail(e.code, e.message, args.json)


def register(sub) -> None:
    p = sub.add_parser("intake", help="세션 조사 자료 대장을 기록과 URL 티켓으로 옮긴다")
    p.add_argument("action", choices=["plan", "run", "status", "verify", "deny-build", "purge-copy"])
    p.add_argument("--manifest", help="매니페스트 경로(기본 docs/intake/session-research.yaml)")
    p.add_argument("--copy-dir", help="접수 사본 폴더(기본 ~/.local/share/sagae-kb/intake)")
    p.add_argument("--nodes", metavar="FILE", help="deny-build: 노드 이름 파일(한 줄에 하나). -는 표준입력")
    p.add_argument("--apply", action="store_true", help="purge-copy: 실제 삭제(TTY, 결정 3, 전 항목 처리 뒤에만)")
    p.add_argument("--detail", action="store_true", help="항목별 상태를 detail에 더한다(본문 없음)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_intake)
