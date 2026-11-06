"""kb fetch <url> [--source src:...] [--json]. capture 층을 지나 스냅샷을 만든다(거부 호스트, robots, 서킷 적용)."""
from __future__ import annotations

import json
import sys


def _out(obj: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(obj, ensure_ascii=False, sort_keys=True))
    else:
        for k, v in obj.items():
            print(f"{k}: {v}")


def cmd_fetch(args) -> int:
    from kb.collect import capturer as capture, registry
    from kb.collect.errors import CollectError
    try:
        src = registry.get_source(args.source)
        if src is None:
            _out({"error": "E_POLICY", "message": f"등록되지 않은 소스: {args.source}. 미등록 URL은 src:adhoc로만 받는다"}, args.json)
            return 1
        # 미등록 URL은 항상 새 요청이다(조건부 GET 없음). 등록 소스는 조건부 GET으로 돈다
        ref = capture.capture(src, args.url, conditional=src.id != registry.ADHOC_ID,
                              reuse_s=args.reuse_s)
    except CollectError as e:
        _out({"error": e.code, "message": str(e)}, args.json)
        return 1
    d = ref.as_dict()
    if ref.ok:
        _out(d, args.json)
        return 0
    d["error"] = ref.code
    d["message"] = ref.error
    _out(d, args.json)
    if not args.json:
        print(f"오류 {ref.code}: {ref.outcome} {ref.error or ''}", file=sys.stderr)
    return 1


def register(sub) -> None:
    p = sub.add_parser("fetch", help="URL 하나를 capture 층으로 받아 스냅샷을 만든다")
    p.add_argument("url")
    p.add_argument("--source", default="src:adhoc", help="소스 id(기본 src:adhoc: tos=unverified, trust=unknown)")
    p.add_argument("--reuse-s", type=float, default=None, help="이 초 안에 받은 같은 URL 스냅샷이 있으면 재사용")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_fetch)
