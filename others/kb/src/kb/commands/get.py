"""kb get <id>: 노드, 주장, 엣지 하나를 읽는다(WP-04). 읽기 코어를 그대로 쓰고 봉투째 JSON으로 낸다.
민감도는 internal 이하로 고정이다(옵션으로 올릴 수 없다)."""
from __future__ import annotations

import json
import sys


def _problem(e, instance: str) -> dict:
    d = {"type": f"https://kb.local/problems/{e.code.replace('_', '-')}", "title": e.code, "status": e.status,
         "detail": e.detail, "code": e.code, "instance": instance}
    if getattr(e, "param", None):
        d["param"] = e.param
    return d


def run(args) -> tuple[dict, int]:
    from kb import read
    from kb.read.envelope import read as read_env

    try:
        ctx = read.ReadCtx.build(status=args.status, as_of_valid=args.as_of_valid, as_of_observed=args.as_of_observed,
                                 include_unverified=args.include_unverified, db_path=getattr(args, "db", None))
        if args.cards:
            def fn(con, c, nid):
                return {"cards": read.render_cards(con, c, [nid], edges=True).text}
            return read_env(ctx, fn, args.id), 0
        if args.id.startswith("r-"):
            return read_env(ctx, read.get_edge, args.id), 0
        return read_env(ctx, read.get_node, args.id, include=args.include, claim_limit=args.claim_limit,
                        edge_limit=args.edge_limit, backlink_limit=args.backlink_limit), 0
    except read.ReadError as e:
        return _problem(e, "/v1/nodes/" + args.id), (1 if e.status == 404 else 2 if e.status == 400 else 3)


def _cmd(args) -> int:
    out, rc = run(args)
    if rc == 0 and args.cards:
        print(out["data"]["cards"])
        return 0
    print(json.dumps(out, ensure_ascii=False, indent=None if args.json else 2), file=sys.stdout if rc == 0 else sys.stderr)
    return rc


def register(sub) -> None:
    p = sub.add_parser("get", help="id 하나를 읽는다(노드, 주장, 엣지)")
    p.add_argument("id")
    p.add_argument("--include", default="claims,edges", help="claims,edges,backlinks,body 중 쉼표 목록")
    p.add_argument("--claim-limit", type=int)
    p.add_argument("--edge-limit", type=int)
    p.add_argument("--backlink-limit", type=int)
    p.add_argument("--status", default="active", choices=["active", "superseded", "dead", "all"])
    p.add_argument("--include-unverified", action="store_true")
    p.add_argument("--as-of-valid")
    p.add_argument("--as-of-observed")
    p.add_argument("--cards", action="store_true", help="봉투 대신 카드 한 장")
    p.add_argument("--json", action="store_true")
    p.add_argument("--db", help=argparse_suppress(), default=None)
    p.set_defaults(func=_cmd)


def argparse_suppress() -> str:
    import argparse
    return argparse.SUPPRESS
