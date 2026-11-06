"""kb dlq list|retry. DLQ는 ops.db의 dlq 표다(ADR 12장). 항목이 CAS를 가리키므로 네트워크 없이 재처리한다."""
from __future__ import annotations

import json


def cmd_dlq(args) -> int:
    from kb.collect import clock
    from kb.collect.state import State
    with State() as st:
        if args.action == "list":
            rows = st.dlq_list(args.kind)
            if args.json:
                print(json.dumps({"items": rows, "count": len(rows)}, ensure_ascii=False, sort_keys=True))
            else:
                for r in rows:
                    print(f"{r['id']}\t{r['kind']}\t{r['stage']}\t{r['ref']}\tattempts={r['attempts']}\t{r['error']}")
            return 0
        rows = [r for r in st.dlq_list(args.kind) if args.id is None or r["id"] == args.id]
        done, failed = [], []
        for r in rows:
            if r["kind"] == "broken_source":
                from kb.collect import capturer as capture
                sid, _, url = r["ref"].partition("|")
                ref = capture.capture(sid, url, conditional=False)
                if ref.ok:
                    st.c.execute("DELETE FROM dlq WHERE id=?", (r["id"],))
                    done.append(r["id"])
                else:
                    failed.append({"id": r["id"], "outcome": ref.outcome, "error": ref.error})
            else:
                # 파서 등 다른 패키지의 항목은 다음 재시도 시각을 지금으로 당긴다. 처리는 그 패키지의 단계가 한다
                st.c.execute("UPDATE dlq SET next_at=? WHERE id=?", (clock.now_ms(), r["id"]))
                done.append(r["id"])
        out = {"retried": done, "failed": failed}
        print(json.dumps(out, ensure_ascii=False, sort_keys=True) if args.json else f"재시도 {len(done)}건, 실패 {len(failed)}건")
        return 1 if failed else 0


def register(sub) -> None:
    p = sub.add_parser("dlq", help="DLQ 목록과 재시도")
    p.add_argument("action", choices=["list", "retry"])
    p.add_argument("--kind")
    p.add_argument("--id", type=int)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_dlq)
