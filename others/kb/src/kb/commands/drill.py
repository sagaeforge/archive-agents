"""kb drill restore [--ledger 사본 | --from-export] | restore --offsite | check | run"""
from __future__ import annotations

import json

from kb.guard import drill as _drill
from kb.guard import ship as _ship


def _print(r: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(r, ensure_ascii=False, sort_keys=True, default=str))
    else:
        for k, v in r.items():
            print(f"{k}: {v}")


def _targets(args):
    ts = _ship.load_targets()
    if args.target:
        ts = [t for t in ts if t.id == args.target]
    if args.offsite:
        ts = [t for t in ts if t.offsite]
    return ts


def cmd_drill(args) -> int:
    try:
        if args.action == "restore" and (args.ledger or args.from_export):
            r = _drill.restore_ledger(args.ledger, from_export=args.from_export, anchors=args.anchors)
            _print(r, args.json)
            return 0 if r.get("ok") else 1
        secrets = _ship.load_secrets()
        if args.action == "run":
            r = _drill.run_due()
            _print(r, args.json)
            return 0 if all(x.get("ok") for x in r.get("ran", [])) else 1
        ts = _targets(args)
        if not ts:
            _print({"ok": False, "ran": False, "error": "맞는 대상이 없다(targets.yaml)"}, args.json)
            return 1
        rs = []
        for t in ts:
            if args.action == "check":
                rs.append(_drill.check_target(t, secrets))
            else:
                rs.append(_drill.drill_target(t, secrets, level=args.level, offsite=args.offsite, keep=args.keep))
        _print({"results": rs, "ok": all(x.get("ok") for x in rs)}, args.json)
        return 0 if all(x.get("ok") for x in rs) else 1
    except (_ship.ShipError, _drill.DrillError) as e:
        _print({"ok": False, "error": str(e)}, args.json)
        return 1


def register(sub) -> None:
    p = sub.add_parser("drill", help="복원 훈련과 원장 복원")
    p.add_argument("action", choices=["restore", "check", "run"])
    p.add_argument("--ledger", help="restore: 원장 사본 경로(ship/ledger.db)")
    p.add_argument("--from-export", action="store_true", help="restore: 원장 사본 없이 ledger/export/에서 재구성")
    p.add_argument("--anchors", action="append", help="restore: 대조할 앵커 파일(여러 번)")
    p.add_argument("--offsite", action="store_true", help="머신 밖 대상에서 복원(통과하면 kb fp open이 열린다)")
    p.add_argument("--target", help="대상 id")
    p.add_argument("--level", choices=["ledger", "full"], default="full")
    p.add_argument("--keep", action="store_true", help="훈련 홈을 남긴다")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_drill)
