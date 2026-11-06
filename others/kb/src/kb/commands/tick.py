"""kb tick [--until-idle] [--max-runtime 12m] [--only <source>] [--batch <yaml>] [--json] (ADR 10.2)"""
from __future__ import annotations

import json
import sys


def _batch(path: str) -> tuple[list[str], dict]:
    from kb.collect.registry import read_yaml
    doc = read_yaml(__import__("pathlib").Path(path))
    if isinstance(doc, dict):
        doc = doc.get("sources", doc.get("batch", []))
    out, caps = [], {}
    for it in doc or []:
        if isinstance(it, dict):
            out.append(it["id"])
            if it.get("max_pages") is not None:
                caps[it["id"]] = int(it["max_pages"])
        else:
            out.append(str(it))
    return out, caps


def cmd_tick(args) -> int:
    from kb.collect.tick import run_tick
    try:
        batch, caps = _batch(args.batch) if args.batch else (None, {})
    except Exception as e:  # noqa: BLE001
        print(f"kb tick: --batch 읽기 실패: {e}", file=sys.stderr)
        return 2
    report, rc = run_tick(until_idle=args.until_idle, max_runtime=args.max_runtime, only=args.only, batch=batch, batch_caps=caps)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    else:
        st = report.get("stages", {})
        print(f"tick: sources={report.get('sources')} failed={report.get('failed_sources')} "
              f"robots_denied={report.get('robots_denied')} pages={report.get('pages_fetched', 0)} "
              f"stages={' '.join(f'{k}={v}' for k, v in st.items())}"
              + (f" skipped={report['skipped']}" if report.get("skipped") else ""))
        for w in report.get("warnings", []):
            print(f"경고: {w}", file=sys.stderr)
        for e in report.get("errors", []):
            print(f"오류: {e}", file=sys.stderr)
    return rc


def register(sub) -> None:
    p = sub.add_parser("tick", help="수집 박동 한 번(0 preflight, 1~8 단계)")
    p.add_argument("--until-idle", action="store_true", help="더 할 일이 없을 때까지 반복")
    p.add_argument("--max-runtime", default="12m", help="최대 실행 시간(예: 90s, 12m, 1h)")
    p.add_argument("--only", metavar="SOURCE", help="이 소스만 지금 수집")
    p.add_argument("--batch", metavar="YAML", help="목록의 소스만 순서대로 수집")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_tick)
