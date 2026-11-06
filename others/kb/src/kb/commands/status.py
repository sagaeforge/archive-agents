"""kb status [--json] [--critical]: 호출할 때 계산한 운영 상태(WP-15). 지식 데이터가 아니다.
--critical은 세션 훅의 additionalContext용 텍스트다(치명 항목 + 경고 건수 1줄). 종료 코드는 상태와 무관하게 0이다."""
from __future__ import annotations

import json


def cmd_status(args) -> int:
    from kb.guard import status as _st

    st = _st.build()
    from kb.serve.fpapi import token_usage
    st["api_tokens"] = token_usage()
    if args.json:
        print(json.dumps(st, ensure_ascii=False, sort_keys=True, default=str))
    elif args.critical:
        print(_st.critical_text(st))
    else:
        print(_st.render_text(st))
    return 0


def register(sub) -> None:
    p = sub.add_parser("status", help="운영 상태: 치명, 경고, 안내, 건수, 도메인별 건수(호출 시 계산)")
    p.add_argument("--json", action="store_true")
    p.add_argument("--critical", action="store_true", help="치명 항목과 경고 건수 1줄(세션 훅용)")
    p.set_defaults(func=cmd_status)
