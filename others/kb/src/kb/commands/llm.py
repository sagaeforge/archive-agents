"""kb llm reenable, kb llm correct-reenable-record. gate_pass_drop로 꺼진 모델을 사람이 켜는 유일한 경로(ADR-0003 5장).
둘 다 기본은 시험 실행이다(--apply 없이는 아무것도 쓰지 않는다)."""
from __future__ import annotations

import json
import os
import sys

REENABLE_LOG = "llm:reenable_log"
RECORD_KEY = "llm:human_reenable"
CORRECT_NOTE = "agent cleared llm:off on a relayed instruction; no direct user input; gatepass history was deleted, not archived"


def _live_home() -> bool:
    """KB_HOME이 운영 데이터 경로(또는 미지정)인가."""
    from pathlib import Path
    from kb.core import paths
    prod = Path(paths.DEFAULT_KB_HOME).resolve()
    home = paths.kb_home().resolve()
    return home == prod or prod in home.parents


def _guard_apply() -> str | None:
    if _live_home() and os.environ.get("KB_LIVE") != "1":
        return "운영 KB_HOME에는 KB_LIVE가 있어야 쓴다"
    return None


def _get(c, k):
    from kb.core import opsdb
    v = opsdb.tick_state_get(c, k, None)
    if v is None:
        return None
    try:
        return json.loads(v)
    except ValueError:
        return None


def _put(c, k, v) -> None:
    c.execute("INSERT INTO tick_state(k, v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
              (k, json.dumps(v, ensure_ascii=False, sort_keys=True)))


def _emit(args, out: dict, code: int = 0) -> int:
    print(json.dumps(out, ensure_ascii=False, sort_keys=True) if args.json else
          " ".join(f"{k}={v}" for k, v in out.items() if not isinstance(v, (dict, list))))
    return code


def _refuse(name: str, why: str) -> int:
    print(f"kb llm {name}: 거부: {why}", file=sys.stderr)
    return 2


def _reenable(args) -> int:
    from kb.core import opsdb
    from kb.extract import route, settings
    if args.by != "user":
        return _refuse("reenable", "--by는 user만 허용한다(사용자 본인의 해제만 받는다)")
    if not (args.basis or "").strip():
        return _refuse("reenable", "--basis가 비어 있다")
    key = args.model
    if args.apply and (why := _guard_apply()):
        return _refuse("reenable", why)
    c = opsdb.connect()
    try:
        c.execute("BEGIN IMMEDIATE")                       # 읽기와 쓰기를 한 트랜잭션으로 묶는다
        try:
            off = _get(c, route.off_key(key))
            if not off:
                c.execute("ROLLBACK")
                return _refuse("reenable", f"{route.off_key(key)}가 없다")
            if off.get("human") is not True:
                c.execute("ROLLBACK")
                return _refuse("reenable", f"{route.off_key(key)}에 human=true가 없다. 사람이 켜는 대상이 아니다")
            hist = _get(c, "llm:gatepass:" + key)
            yh = _get(c, "llm:yield:" + key)
            ts = int(settings.now_s() * 1000)                   # 밀리초: 같은 초의 두 번째 해제와 키가 겹치지 않는다
            arch = f"llm:gatepass:archive:{key}:{ts}"
            yarch = f"llm:yield:archive:{key}:{ts}"
            entry = {"at": ts, "model": key, "by": "user", "basis": args.basis,
                     "gatepass_archived": arch if hist is not None else None,
                     "yield_archived": yarch if yh is not None else None, "off_was": off}
            out = {"mode": "apply" if args.apply else "dry-run", "model": key, "archive_key": arch if hist is not None else None,
                   "yield_archive_key": yarch if yh is not None else None,
                   "gatepass_windows": len(hist or []), "yield_windows": len(yh or []), "off_was": off}
            if not args.apply:
                c.execute("ROLLBACK")
                return _emit(args, out)
            if hist is not None:
                if c.execute("SELECT 1 FROM tick_state WHERE k=?", (arch,)).fetchone():
                    c.execute("ROLLBACK")
                    return _refuse("reenable", f"{arch}가 이미 있다")
                _put(c, arch, hist)
                c.execute("DELETE FROM tick_state WHERE k=?", ("llm:gatepass:" + key,))   # 옮겼다(archive에 같은 값이 있다)
            if yh is not None:                                  # 옛 빈 창 이력을 두면 첫 창에서 다시 꺼진다
                if c.execute("SELECT 1 FROM tick_state WHERE k=?", (yarch,)).fetchone():
                    c.execute("ROLLBACK")
                    return _refuse("reenable", f"{yarch}가 이미 있다")
                _put(c, yarch, yh)
                c.execute("DELETE FROM tick_state WHERE k=?", ("llm:yield:" + key,))
            c.execute("DELETE FROM tick_state WHERE k=?", (route.off_key(key),))          # route.clear_off와 같은 효과
            _put(c, REENABLE_LOG, (_get(c, REENABLE_LOG) or []) + [entry])
            c.execute("COMMIT")
        except BaseException:
            if c.in_transaction:
                c.execute("ROLLBACK")
            raise
    finally:
        c.close()
    return _emit(args, out)


def _correct(args) -> int:
    from kb.core import opsdb
    from kb.extract import settings
    if args.apply and (why := _guard_apply()):
        return _refuse("correct-reenable-record", why)
    c = opsdb.connect()
    try:
        c.execute("BEGIN IMMEDIATE")
        try:
            rec = _get(c, RECORD_KEY)
            if rec is None:
                c.execute("ROLLBACK")
                return _refuse("correct-reenable-record", f"{RECORD_KEY}가 없다")
            if isinstance(rec, dict) and "original" in rec:
                c.execute("ROLLBACK")
                return _refuse("correct-reenable-record", "이미 고쳤다(original이 있다)")
            new = {"original": rec, "by": "agent", "approval": "relayed_unverified",
                   "corrected_at": int(settings.now_s()), "note": CORRECT_NOTE}
            out = {"mode": "apply" if args.apply else "dry-run", "key": RECORD_KEY, "record": new}
            if args.apply:
                _put(c, RECORD_KEY, new)
                c.execute("COMMIT")
            else:
                c.execute("ROLLBACK")
        except BaseException:
            if c.in_transaction:
                c.execute("ROLLBACK")
            raise
    finally:
        c.close()
    return _emit(args, out)


def register(sub) -> None:
    p = sub.add_parser("llm", help="L2 모델 스위치")
    sp = p.add_subparsers(dest="llm_cmd", metavar="<동작>")
    r = sp.add_parser("reenable", help="gate_pass_drop로 꺼진 모델을 사람이 켠다(기본 시험 실행, --apply로 쓴다)")
    r.add_argument("--model", required=True, help="모델 키(llm:off:<키>)")
    r.add_argument("--by", required=True, help="user만 허용")
    r.add_argument("--basis", required=True, help="회고 확인 근거")
    r.add_argument("--apply", action="store_true")
    r.add_argument("--json", action="store_true")
    r.set_defaults(func=_reenable)
    k = sp.add_parser("correct-reenable-record", help="llm:human_reenable 한 키를 사실대로 고친다(기본 시험 실행)")
    k.add_argument("--apply", action="store_true")
    k.add_argument("--json", action="store_true")
    k.set_defaults(func=_correct)
    p.set_defaults(func=lambda a: (p.print_help(), 2)[1])
