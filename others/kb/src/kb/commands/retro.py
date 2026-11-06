"""kb retro [--dry-run] [--proposals-file F] [--json]: kb metrics --week의 수치만 kb-retro에 넘겨 회고를 쓴다(WP-18).
결정 11 승인 전에는 에이전트를 부르지 않는다. 제안은 코드에 적용하지 않는다."""
from __future__ import annotations

import json



def cmd_retro(args) -> int:
    from kb.core import opsdb
    from kb.metrics import retro, snapshot
    props = None
    if args.proposals_file:
        props = (json.load(open(args.proposals_file, encoding="utf-8")) or {}).get("proposals", [])
    c = opsdb.connect()
    try:
        snap = snapshot(c, days=7)
    finally:
        c.close()
    out = retro.run(snap, dry_run=args.dry_run, proposals=props, engine=args.engine)
    if args.json:
        print(json.dumps(out, ensure_ascii=False, sort_keys=True))
    else:
        print(f"회고 {out['week']}: 제안 {out['proposals']}건, 버림 {out['dropped']}건, 건너뜀 {out['skipped']}, 파일 {out['path']}")
    return 0


def register(sub) -> None:
    p = sub.add_parser("retro", help="주간 회고(수치만 입력, 제안은 적용하지 않음)")
    p.add_argument("--engine", choices=("openrouter", "anthropic_api"), default=None)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--proposals-file", default=None, help="에이전트 대신 이 제안 JSON을 거른다")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_retro)
