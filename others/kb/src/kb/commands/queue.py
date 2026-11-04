"""kb queue stats|sweep. L2 큐의 소스별 현황과 정책 표시(ADR-0004 D1).
stats는 읽기 전용이다. sweep만 ops.db 큐 행을 지금 정책에 맞춘다: 거르는 행은 'skipped_policy', 정책이 넓어진 행은 'queued'로
되돌리고 보류 표식의 스냅샷을 다시 적재한다(행과 원장은 지우지 않는다)."""
from __future__ import annotations

import json


def stats(since: int | None = None) -> dict:
    """소스별 {rows, queued, taken, skipped_policy, queued_new}. queued_new는 since 이후 큐에 들어온 queued·taken 행이다.
    since 기본값은 마지막 정책 sweep 시각(없으면 0)이다."""
    from kb.core import ledger, opsdb
    from kb.core.conn import connect_ro
    from kb.extract import policy, state
    if since is None:
        with state.readonly():
            since = int(state.get(policy.AT_KEY, 0) or 0)
    tab = policy.table()
    c = connect_ro(opsdb.ops_path(), 900.0)
    try:
        per_snap = c.execute("SELECT substr(ref, 1, instr(ref, '|') - 1), state, count(*), sum(enqueued_at > ?) FROM queue "
                             "WHERE kind=? GROUP BY 1, 2", (since, policy.QUEUE)).fetchall()
    finally:
        c.close()
    led = connect_ro(ledger.ledger_path(), 900.0)
    try:
        src_of = policy.sources_of(led, {r[0] for r in per_snap})
    finally:
        led.close()
    by: dict = {}
    for sid, st, n, new in per_snap:
        src = src_of.get(sid, "?")
        row = by.setdefault(src, {"source": src, "rows": 0, "queued": 0, "taken": 0, "skipped_policy": 0, "queued_new": 0})
        row["rows"] += n
        if st in row:
            row[st] += n
        if st in ("queued", "taken"):
            row["queued_new"] += int(new or 0)
    for src, row in by.items():
        pol, cat = policy.entry(tab, src)[:2] if src in tab else ("all", "?")
        row["policy"], row["category"] = pol, cat
    srcs = sorted(by.values(), key=lambda r: (-r["rows"], r["source"]))
    cats: dict = {}
    for r in srcs:
        a = cats.setdefault(r["category"], {"rows": 0, "queued": 0, "taken": 0, "skipped_policy": 0, "queued_new": 0})
        for k in a:
            a[k] += r[k]
    tot = {k: sum(r[k] for r in srcs) for k in ("rows", "queued", "taken", "skipped_policy", "queued_new")}
    return {"kind": policy.QUEUE, "since": since, "totals": tot, "categories": cats, "sources": srcs}


def cmd_queue(args) -> int:
    if args.action == "stats":
        out = stats(args.since)
        if args.json:
            print(json.dumps(out, ensure_ascii=False, sort_keys=True))
        else:
            t = out["totals"]
            print(f"l2 rows={t['rows']} queued={t['queued']} taken={t['taken']} skipped_policy={t['skipped_policy']} queued_new={t['queued_new']}")
            if args.by_source:
                for r in out["sources"]:
                    print(f"{r['source']}\t{r['category']}\t{r['policy']}\trows={r['rows']}\tqueued={r['queued']}\t"
                          f"skipped_policy={r['skipped_policy']}\tqueued_new={r['queued_new']}")
        return 0
    from kb.core import opsdb
    from kb.core.conn import connect_ro
    from kb.extract import policy, state
    c = connect_ro(opsdb.ops_path(), 900.0) if args.dry_run else opsdb.connect()
    try:
        out = policy.sweep(c, dry_run=args.dry_run)
    finally:
        c.close()
    if not args.dry_run:
        state.put(policy.SIG_KEY, policy.signature(policy.table()))
        state.put(policy.AT_KEY, opsdb._now())
    print(json.dumps(out, ensure_ascii=False, sort_keys=True) if args.json
          else f"skipped_policy {out['skipped']}행, 되돌림 {out['restored']}행, 보류 재적재 {out['held_queued']}행"
               f"{' (dry-run)' if args.dry_run else ''}")
    return 0


def register(sub) -> None:
    p = sub.add_parser("queue", help="L2 큐 현황(stats)과 정책 적용(sweep)")
    p.add_argument("action", choices=["stats", "sweep"])
    p.add_argument("--by-source", action="store_true", dest="by_source")
    p.add_argument("--json", action="store_true")
    p.add_argument("--since", type=int, default=None, help="queued_new 기준 시각(ms). 기본은 마지막 sweep")
    p.add_argument("--dry-run", action="store_true", dest="dry_run")
    p.set_defaults(func=cmd_queue)
