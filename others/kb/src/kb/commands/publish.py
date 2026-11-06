"""kb publish [--force]: export 게시 파일을 만든다(WP-10, 계약 5장). 변경이 있고 5분이 지났을 때만 새로 낸다."""
from __future__ import annotations

import json
import sys


def _cmd(args) -> int:
    from kb import publish
    from kb.read.ctx import NotReady
    try:
        r = publish.publish(force=args.force, min_interval_s=0 if args.force else publish.MIN_INTERVAL_S, db_path=getattr(args, "db", None))
    except NotReady as e:
        print(f"kb publish: graph.db가 아직 없다: {e}", file=sys.stderr)
        return 3
    if args.json:
        print(json.dumps(r, ensure_ascii=False, sort_keys=True))
    elif r["published"]:
        pr = r["profiles"]
        print(f"게시 {r['build_id']}: core 노드 {pr['core']['nodes']} 엣지 {pr['core']['edges']} {pr['core']['bytes']}B, "
              f"full 노드 {pr['full']['nodes']} 엣지 {pr['full']['edges']} {pr['full']['bytes']}B")
    else:
        print(f"게시 안 함: {r['reason']}")
    return 0


def register(sub) -> None:
    import argparse
    p = sub.add_parser("publish", help="스냅샷 export 게시(core, full)")
    p.add_argument("--force", action="store_true", help="변경 여부와 5분 간격을 무시한다")
    p.add_argument("--json", action="store_true")
    p.add_argument("--db", help=argparse.SUPPRESS)
    p.set_defaults(func=_cmd)
