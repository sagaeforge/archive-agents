"""kb ingest validate|submit <bundle.jsonl|-> [--no-fetch] [--json]. 종료 코드: 0 거부 없음, 1 거부 있음, 2 계약 오류(아무것도 쓰지 않음)."""
from __future__ import annotations

import json
import sys


def _print(rep, as_json: bool) -> None:
    if as_json:
        for r in rep.ndjson():
            print(json.dumps(r, ensure_ascii=False, sort_keys=True))
        return
    for r in rep.lines:
        extra = f" {r['code']}: {r.get('detail', '')}" if r.get("code") else ""
        print(f"{r['line']:>5} {r.get('ref') or '-':<10} {r['result']}{extra}")
    s = rep.summary()
    print(f"요약 accepted={s['accepted']} needs_review={s['needs_review']} held={s['held']} rejected={s['rejected']} "
          f"새 이벤트={s['new_events']} batch={s['batch_id']}")


def cmd(args) -> int:
    from kb import ingest
    try:
        header, rows = ingest.read_path(args.bundle)
        fn = ingest.validate if args.action == "validate" else ingest.submit
        rep = fn((header, rows), fetch=not args.no_fetch, profile=args.profile)
    except ingest.ContractError as e:
        print(json.dumps({"error": "contract", "message": str(e)}, ensure_ascii=False) if args.json else f"계약 오류: {e}",
              file=sys.stderr)
        return 2
    _print(rep, args.json)
    return rep.exit_code


def register(sub) -> None:
    p = sub.add_parser("ingest", help="적재 계약 kb-ingest/1 묶음을 검증하거나 제출한다")
    p.add_argument("action", choices=["validate", "submit"])
    p.add_argument("bundle", help="JSON Lines 파일. -는 표준입력")
    p.add_argument("--no-fetch", action="store_true", help="네트워크 없이 24시간 안의 기존 스냅샷만 쓴다")
    p.add_argument("--profile", default=None, help="호출 프로필(collector면 record 거부)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd)
