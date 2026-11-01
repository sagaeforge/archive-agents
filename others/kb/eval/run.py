"""python eval/run.py --suite golden [--json]: 사람이 확인한 표본만 평가한다(WP-18). 표본이 없으면 cases=0이다.
평가에서 패치를 실행해야 하면 샌드박스에서 돈다(이 실행기는 코드를 실행하지 않는다)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))


def _search_fn():
    from kb.read.ctx import ReadCtx
    from kb.read.search import search

    def f(q: str) -> list[str]:
        env = search(q, ReadCtx())
        items = (env.get("data") or {}).get("items") or []
        return [str(i.get("id")) for i in items if isinstance(i, dict)]
    return f


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="eval/run.py")
    ap.add_argument("--suite", default="golden")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--root", default=str(HERE))
    ns = ap.parse_args(argv)
    from kb.metrics import evalrun
    cases, _ = evalrun.load_cases(Path(ns.root) / ns.suite) if (Path(ns.root) / ns.suite).exists() else ([], [])
    fns = {}
    if any(c["kind"] == "query" for c in cases):
        fns["search_fn"] = _search_fn()
    out = evalrun.run_suite(ns.suite, Path(ns.root), **fns)
    if any(c["kind"] in ("extract", "stale_premise") for c in cases):
        out["note"] = "extract/stale_premise 표본은 추출기·주석기 실행 함수가 필요하다(eval.run 미연결). 점수에 넣지 않았다"
    print(json.dumps(out, ensure_ascii=False, sort_keys=True) if ns.json else out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
