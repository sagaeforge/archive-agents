"""kb fsck [--step 이름] [--all] [--cas-full] [--json]: 무결성 검사(ADR 17.3). 기본은 만기 단계만 돈다.
실패 결과는 ops.db에 남아 kb status의 치명으로 올라간다. 종료 코드 1은 실패 단계가 있다는 뜻이다."""
from __future__ import annotations

import json


def cmd_fsck(args) -> int:
    from kb.guard import fsck

    r = fsck.run(args.step or None, force=args.all, cas_full=args.cas_full)
    if args.json:
        print(json.dumps(r, ensure_ascii=False, sort_keys=True, default=str))
    else:
        for s in r["steps"]:
            print(f"{s['step']}: {'ok' if s['ok'] else 'FAIL'}" + ("" if s["ok"] else " " + "; ".join(s["errors"][:3])))
        if not r["steps"]:
            print("만기 단계 없음")
    return 0 if r["ok"] else 1


def register(sub) -> None:
    from kb.guard import fsck

    p = sub.add_parser("fsck", help="무결성 검사: 체인, 앵커, CAS 1/30, integrity_check, gold 지문")
    p.add_argument("--step", action="append", choices=fsck.STEPS, help="이 단계만")
    p.add_argument("--all", action="store_true", help="만기와 무관하게 전 단계")
    p.add_argument("--cas-full", action="store_true", help="CAS 전수 검증(1/30 순환 대신)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_fsck)
