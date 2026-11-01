"""kb metrics [--week] [--days N] [--json]: ops.db 지표 묶음(WP-18). 읽기 전용이고 지식 데이터가 아니다.
--etl은 전사 ETL(~/.claude/projects 읽기 전용, 수치만 ops.db에 적재)을 먼저 돈다."""
from __future__ import annotations

import json


def cmd_metrics(args) -> int:
    from kb.core import opsdb
    from kb.metrics import snapshot, transcript
    c = opsdb.connect()
    try:
        etl = transcript.etl(c) if args.etl else None
        snap = snapshot(c, days=7 if args.week else args.days)
    finally:
        c.close()
    if etl is not None:
        snap["etl"] = etl
    if args.json:
        print(json.dumps(snap, ensure_ascii=False, sort_keys=True))
    else:
        print(f"주 {snap['week']}: 수집 {snap['yield']['fetch']['total']}건, 호출 {snap['tokens']['llm_calls']}건, "
              f"DLQ {snap['failures']['dlq']['open']}건, stale {snap['freshness']['stale_total']}건")
    return 0


def register(sub) -> None:
    p = sub.add_parser("metrics", help="자가 개선 지표(ops.db)")
    p.add_argument("--week", action="store_true", help="최근 7일")
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--etl", action="store_true", help="전사 ETL을 먼저 돈다(읽기 전용)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_metrics)
