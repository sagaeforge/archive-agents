"""kb reparse --source <id> [--snapshot <id>] [--json]. 네트워크 없이 CAS의 원본을 새 파서로 다시 파싱해 새 이벤트를 쌓는다.
표시 본문은 다시 계산하지 않는다(저장된 text_sha를 쓴다)."""
from __future__ import annotations

import json
import sys


def _cmd(args) -> int:
    from kb.collect import registry
    from kb.collect.state import State
    from kb.core import ledger
    from kb.parse import pipeline
    src = registry.get_source(args.source)
    if src is None:
        print(f"kb reparse: 알 수 없는 소스: {args.source}", file=sys.stderr)
        return 2
    led = ledger.open_ledger()
    snaps: dict[str, dict] = {}
    try:
        after = 0
        while True:
            evs = ledger.iter_events(led, after, 500)
            if not evs:
                break
            for ev in evs:
                after = ev["seq"]
                p = ev.get("payload")
                if ev["kind"] == "snapshot.captured" and p and p.get("source") == args.source:
                    if not args.snapshot or p["id"] == args.snapshot:
                        snaps[p["id"]] = p
    finally:
        led.close()
    items = list(snaps.values())
    if args.latest and items:
        items = [max(items, key=lambda p: p.get("fetched_at", 0))]
    out = {"source": args.source, "snapshots": len(items), "ok": 0, "failed": 0, "claims": 0, "entities": 0, "details": []}
    with State() as st:
        for p in items:
            try:
                r = pipeline.parse_snapshot(p, src, state=st, reuse_text=True)
            except Exception as e:  # noqa: BLE001
                st.dlq_put("parse", p["id"], "parse", f"{type(e).__name__}: {e}"[:400], p.get("raw_sha"))
                out["failed"] += 1
                out["details"].append({"snapshot": p["id"], "error": f"{type(e).__name__}: {e}"[:200]})
                continue
            out["ok" if r["status"] == "ok" else "failed"] += 1
            out["claims"] += (r.get("stats") or {}).get("claims", 0)
            out["entities"] += (r.get("stats") or {}).get("entities", 0)
            out["details"].append({"snapshot": p["id"], "status": r["status"], "adapter": r["adapter"]})
    print(json.dumps(out, ensure_ascii=False, sort_keys=True) if args.json else
          f"reparse {args.source}: snapshots={out['snapshots']} ok={out['ok']} failed={out['failed']}")
    return 1 if out["failed"] else 0


def register(sub) -> None:
    p = sub.add_parser("reparse", help="CAS 원본을 새 파서로 다시 파싱(네트워크 없음)")
    p.add_argument("--source", required=True, metavar="SOURCE_ID")
    p.add_argument("--snapshot", metavar="SNAPSHOT_ID")
    p.add_argument("--latest", action="store_true", help="소스의 가장 최근 스냅샷만")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=_cmd)
