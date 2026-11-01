"""kb api <경로>?<쿼리>: HTTP 읽기 API와 같은 처리기를 프로세스 안에서 불러 같은 JSON을 낸다(계약 1장, WP-10).

범위는 viewer(internal 이하)로 고정이다. 오류는 RFC 9457 본문을 stdout에 내고 exit 1이다.
"""
from __future__ import annotations

import sys


def _cmd(args) -> int:
    from kb.serve.http import ServeConfig, respond
    from kb.serve.limits import ConfigError
    target = args.path if args.path.startswith("/") else "/" + args.path
    try:
        cfg = ServeConfig.load(getattr(args, "db", None))
    except ConfigError as e:
        print(f"kb api: 설정 오류: {e}", file=sys.stderr)
        return 2
    r = respond(target, cfg=cfg, max_sens="internal")
    out = sys.stdout.buffer
    out.write(r.body)
    if sys.stdout.isatty() and r.body[-1:] != b"\n" and any(k == "content-type" and v.startswith("application/") and "zstd" not in v
                                                           for k, v in r.headers):
        out.write(b"\n")
    out.flush()
    return 0 if r.status < 400 else 1


def register(sub) -> None:
    p = sub.add_parser("api", help="HTTP 읽기 API와 같은 JSON을 낸다(예: kb api '/v1/meta')")
    p.add_argument("path", help="/v1/... 경로와 쿼리")
    p.add_argument("--db", help=argparse_suppress())
    p.set_defaults(func=_cmd)


def argparse_suppress():
    import argparse
    return argparse.SUPPRESS
