"""kb rebuild gold [--allow-missing] | kb rebuild quarantine list|release <seq>."""
from __future__ import annotations

import json
import sys

from kb.core import ledger, opsdb
from kb.core import conn as _conn
from kb.project import (MissingObject, RebuildError, SchemaMismatch, current_gold_path, open_gold, rebuild)

HASH_KEYS = ("raw_sha", "text_sha", "paras_sha", "points_sha")


def _out(args, obj: dict) -> None:
    if getattr(args, "json", False):
        print(json.dumps(obj, ensure_ascii=False, sort_keys=True))
    else:
        for k, v in obj.items():
            print(f"{k}: {v}")


def record_missing(led, missing: list[str]) -> dict:
    """없는 CAS 객체마다 gap.recorded를 원장에 쓰고 recapture 큐에 넣는다. 원본이 없으면 다시 가져올 수 있게 한다."""
    gaps, queued = 0, 0
    ops = opsdb.connect()
    try:
        for sha in missing:
            src, snap, at = None, None, None
            for kind, subject, ev_at, body in led.execute(
                    "SELECT e.kind, e.subject, e.at, p.body FROM event e LEFT JOIN payload p ON p.sha=e.payload_sha "
                    "WHERE p.body LIKE ? ORDER BY e.seq", (f"%{sha}%",)):
                pl = json.loads(body)
                snap = pl.get("snapshot") or (pl.get("id") if kind == "snapshot.captured" else snap)
                src = pl.get("source") or src
                at = ev_at
                if snap and not src:
                    r = led.execute("SELECT p.body FROM event e JOIN payload p ON p.sha=e.payload_sha "
                                    "WHERE e.kind='snapshot.captured' AND e.subject=?", (snap,)).fetchone()
                    src = json.loads(r[0]).get("source") if r else None
            src = src or "src:unknown"
            ledger.append(led, [{"kind": "gap.recorded", "actor": "system", "origin": "system",
                                 "idem_key": f"gap-missing:{sha}", "subject": src,
                                 "payload": {"source": src, "from_at": at or 0, "to_at": at or 0,
                                             "reason": f"cas_missing:{sha}"}}])
            gaps += 1
            if opsdb.queue_put(ops, "recapture", snap or sha):
                queued += 1
    finally:
        ops.close()
    return {"gaps": gaps, "queued": queued}


def cmd_gold(args) -> int:
    try:
        r = rebuild(allow_missing=args.allow_missing)
    except MissingObject as e:
        _out(args, {"ok": False, "code": "cas_missing", "missing": e.shas, "error": str(e)})
        return 1
    except (RebuildError, SchemaMismatch) as e:
        _out(args, {"ok": False, "code": "rebuild_failed", "error": str(e)})
        return 1
    d = r.as_dict()
    d["ok"] = r.fingerprint_ok and not r.rolled_back
    if r.missing:
        led = ledger.open_ledger()
        try:
            d.update(record_missing(led, r.missing))
        finally:
            led.close()
    _out(args, d)
    return 0 if d["ok"] else 1


def _quarantine_rows() -> list[dict]:
    p = current_gold_path()
    if p is None:
        return []
    ro = _conn.connect_ro(p)
    try:
        return [{"seq": a, "reason": b, "at": c} for a, b, c in ro.execute("SELECT seq,reason,at FROM quarantine ORDER BY seq")]
    finally:
        ro.close()


def cmd_quarantine(args) -> int:
    if args.action == "list":
        _out(args, {"ok": True, "quarantine": _quarantine_rows()})
        return 0
    if args.seq is None:
        print("release에는 seq가 필요하다", file=sys.stderr)
        return 2
    if args.seq not in {r["seq"] for r in _quarantine_rows()}:
        _out(args, {"ok": False, "code": "not_quarantined", "seq": args.seq})
        return 1
    led = ledger.open_ledger()
    try:
        ledger.append(led, [{"kind": "system.projection_released", "actor": "user:sagae" if sys.stdin.isatty() else "agent:cli",
                             "origin": "system", "idem_key": f"projection-release:{args.seq}:{len(_quarantine_rows())}",
                             "subject": str(args.seq), "payload": {"seq": args.seq}}])
    finally:
        led.close()
    return cmd_gold(args)


def register(sub) -> None:
    p = sub.add_parser("rebuild", help="gold 재구축과 격리 관리")
    ps = p.add_subparsers(dest="rebuild_cmd", metavar="<대상>")
    g = ps.add_parser("gold", help="gold 그래프를 무중단으로 재구축")
    g.add_argument("--allow-missing", action="store_true", help="없는 CAS 객체를 건너뛰고 gap·recapture에 기록")
    g.add_argument("--json", action="store_true")
    g.set_defaults(func=cmd_gold)
    q = ps.add_parser("quarantine", help="격리된 이벤트")
    q.add_argument("action", choices=["list", "release"])
    q.add_argument("seq", nargs="?", type=int)
    q.add_argument("--allow-missing", action="store_true")
    q.add_argument("--json", action="store_true")
    q.set_defaults(func=cmd_quarantine)
    p.set_defaults(func=lambda a: (p.print_help(), 2)[1])
