"""kb ship [--if-dirty] [--timeout N] [--dry-run] [--json] | kb ship --init <대상>"""
from __future__ import annotations

import json

from kb.guard import ship as _ship


def _print(r: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(r, ensure_ascii=False, sort_keys=True, default=str))
        return
    for k, v in r.items():
        print(f"{k}: {v}")


def cmd_ship(args) -> int:
    try:
        if args.init:
            ts = {t.id: t for t in _ship.load_targets()}
            if args.init not in ts:
                print(f"오류: 대상 {args.init} 없음", flush=True)
                return 1
            _print(_ship.init_repo(ts[args.init], _ship.load_secrets()), args.json)
            return 0
        r = _ship.ship(if_dirty=args.if_dirty, timeout=args.timeout, dry_run=args.dry_run,
                       fingerprint=args.fingerprint, only=args.only or None, force=args.force)
    except _ship.ShipError as e:
        _print({"ok": False, "error": str(e)}, args.json)
        return 1
    _print(r, args.json)
    return 0 if r.get("ok", True) else 1


def register(sub) -> None:
    p = sub.add_parser("ship", help="봉인 + 원장 사본 + restic 전송(T0 dirty, T1/T3 1일)")
    p.add_argument("--if-dirty", action="store_true", help="바뀐 것이 없으면 건너뜀")
    p.add_argument("--timeout", type=float, help="전체 제한 시간(초)")
    p.add_argument("--dry-run", action="store_true", help="쓰지 않고 계획만")
    p.add_argument("--fingerprint", action="store_true", help="훈련 기준 gold 지문을 ship.json에 넣는다")
    p.add_argument("--only", action="append", help="이 대상만")
    p.add_argument("--force", action="store_true", help="모든 계층을 이번에 보낸다")
    p.add_argument("--init", metavar="대상", help="restic init(머신 밖 대상은 사용자 입회)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_ship)
