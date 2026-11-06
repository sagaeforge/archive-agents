"""Ko-StrategyQA 어휘 검색 재현(WP-05). kb.core.text 색인 토큰과 kb.read.search의 질의 계획(별칭, AND 후 OR)을 그대로 쓴다.

데이터: $KB_TOOLCHAIN/eval-data/<dataset>/{docs.json,queries.json}. 없으면 eval/lexical/README.md의 변환 절차를 따른다.
출력(--json): ndcg10, hit10, empty, p95_ms, docs, queries, fts_mb.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from kb.core.text import index_tokens  # noqa: E402
from kb.read.search import build_plan, lexical_ids  # noqa: E402


def data_dir(dataset: str) -> Path:
    tc = os.environ.get("KB_TOOLCHAIN") or "/home/user/sagae-kb-data/runtime"
    return Path(tc) / "eval-data" / dataset


def ndcg(ranked: list[int], rel: set[int], k: int = 10) -> float:
    dcg = sum(1 / math.log2(i + 2) for i, x in enumerate(ranked[:k]) if x in rel)
    ideal = sum(1 / math.log2(i + 2) for i in range(min(len(rel), k)))
    return dcg / ideal if ideal else 0.0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="ko-strategyqa")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--limit-queries", type=int)
    a = ap.parse_args(argv)
    d = data_dir(a.dataset)
    try:
        docs = json.loads((d / "docs.json").read_text(encoding="utf-8"))
        qs = json.loads((d / "queries.json").read_text(encoding="utf-8"))
    except FileNotFoundError as e:
        print(f"데이터 없음: {e.filename}. eval/lexical/README.md의 변환 절차를 따른다.", file=sys.stderr)
        return 2
    if a.limit_queries:
        qs = qs[:a.limit_queries]
    pos = {x["id"]: i + 1 for i, x in enumerate(docs)}
    con = sqlite3.connect(":memory:")
    con.execute("CREATE VIRTUAL TABLE fts USING fts5(tok, content='', contentless_delete=1, tokenize=\"unicode61 remove_diacritics 0\")")
    con.executemany("INSERT INTO fts(rowid,tok) VALUES(?,?)", ((i + 1, " ".join(index_tokens(x["text"]))) for i, x in enumerate(docs)))
    con.commit()
    size = sum(len(r[0]) for r in con.execute("SELECT block FROM fts_data"))
    total, hit, empty, lat = 0.0, 0, 0, []
    for q in qs:
        t = time.perf_counter()
        ranked = lexical_ids(con, build_plan(q["q"]))
        lat.append((time.perf_counter() - t) * 1e3)
        rel = {pos[r] for r in q["rel"] if r in pos}
        total += ndcg(ranked, rel)
        hit += bool(rel & set(ranked[:10]))
        empty += not ranked
    lat.sort()
    out = {"dataset": a.dataset, "docs": len(docs), "queries": len(qs), "ndcg10": round(total / len(qs), 4),
           "hit10": round(hit / len(qs), 3), "empty": empty, "p95_ms": round(lat[int(len(lat) * 0.95)], 2),
           "fts_mb": round(size / 1e6, 2)}
    print(json.dumps(out, ensure_ascii=False) if a.json else "\n".join(f"{k}: {v}" for k, v in out.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
