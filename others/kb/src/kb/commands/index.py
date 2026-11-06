"""kb index [--incremental|--full] [--dry-run] [--json]: 벡터 색인을 만든다(WP-20). 기본은 증분이다.
임베딩은 venv-rank의 파이썬이 돈다(코어 venv에 torch가 없다). venv-rank가 없으면 건너뛴다: 조회는 어휘로 계속 동작한다."""
from __future__ import annotations

import json
import subprocess
import sys

from kb.rank import conf


def run_index(*, full: bool = False, dry_run: bool = False, timeout: int = 3600) -> dict:
    from kb.rank import indexer
    if dry_run:
        return {k: v for k, v in indexer.plan(full=full).items() if not k.startswith("_")} | {"dry_run": True}
    if conf.stub():
        return indexer.build(full=full)
    py = conf.venv_rank_python()
    if not py.exists():
        return {"ok": True, "skipped": "venv_rank_missing"}
    cmd = [str(py), "-I", str(indexer.__file__), "--json", *(["--full"] if full else [])]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "timeout"}
    try:
        return json.loads(p.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError):
        return {"ok": False, "error": "indexer_failed", "detail": (p.stderr or "")[-300:]}


def cmd_index(args) -> int:
    out = run_index(full=args.full, dry_run=args.dry_run)
    if args.json:
        print(json.dumps(out, ensure_ascii=False, sort_keys=True))
    else:
        print(" ".join(f"{k}={v}" for k, v in sorted(out.items())))
    return 0 if out.get("ok") else 1


def register(sub) -> None:
    p = sub.add_parser("index", help="벡터 색인 증분 빌드(파생물, venv-rank)")
    p.add_argument("--incremental", action="store_true", help="증분(기본)")
    p.add_argument("--full", action="store_true", help="처음부터 다시 임베딩")
    p.add_argument("--dry-run", action="store_true", help="계획만 센다. 모델 적재와 쓰기 없음")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_index)
