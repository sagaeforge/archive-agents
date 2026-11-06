"""kb search <질의>: 어휘 검색(WP-05). --json은 /v1/search와 같은 봉투다. 결과는 .data.items."""
from __future__ import annotations

import argparse
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
    from kb.read import search as S

    try:
        ctx = read.ReadCtx.build(status=args.status, as_of_valid=args.as_of_valid, as_of_observed=args.as_of_observed,
                                 include_unverified=args.include_unverified, types=args.type, origin=args.origin,
                                 domain=args.domain, source=args.source, author=args.author, db_path=getattr(args, "db", None))
        if args.facets:
            return S.search_facets(args.q, ctx, kinds=args.kinds), 0
        return S.search(args.q, ctx, mode=args.mode, kinds=args.kinds, limit=args.limit, cursor=args.cursor), 0
    except read.ReadError as e:
        return _problem(e, "/v1/search"), (1 if e.status == 404 else 2 if e.status == 400 else 3)


def _text(out: dict) -> str:
    lines = []
    for it in out["data"].get("items", []):
        lines.append(f"[{it['kind']}] {it['id']}  {it['title']}")
        lines.append(f"    {it['snippet']}")
    pg = out.get("page") or {}
    if pg.get("next_cursor"):
        lines.append(f"(다음: --cursor {pg['next_cursor']})")
    return "\n".join(lines)


def _cmd(args) -> int:
    out, rc = run(args)
    if rc != 0:
        print(json.dumps(out, ensure_ascii=False), file=sys.stderr)
        return rc
    if args.json or args.facets:
        print(json.dumps(out, ensure_ascii=False))
    else:
        print(_text(out))
    return 0


def register(sub) -> None:
    p = sub.add_parser("search", help="어휘 검색(한국어, 영어)")
    p.add_argument("q")
    p.add_argument("--mode", default="lexical", choices=["lexical", "hybrid"])
    p.add_argument("--kinds", help="claim,record,entity,passage 중 쉼표 목록")
    p.add_argument("--type", help="타입 쉼표 목록")
    p.add_argument("--origin", help="external,first_party")
    p.add_argument("--domain")
    p.add_argument("--source")
    p.add_argument("--author")
    p.add_argument("--status", default="active", choices=["active", "superseded", "dead", "all"])
    p.add_argument("--include-unverified", action="store_true")
    p.add_argument("--as-of-valid")
    p.add_argument("--as-of-observed")
    p.add_argument("--cursor")
    p.add_argument("--limit", type=int)
    p.add_argument("--facets", action="store_true", help="결과 대신 q의 패싯 개수")
    p.add_argument("--json", action="store_true")
    p.add_argument("--db", help=argparse.SUPPRESS, default=None)
    p.set_defaults(func=_cmd)
