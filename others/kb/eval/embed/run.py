"""Ko-StrategyQA 하이브리드 재현(WP-20): KURE-v3 1024 절단 int8 Dense + 어휘 + KURE-Reranker-nano.
venv-rank에서 돈다: "$KB_TOOLCHAIN/venv-rank/bin/python" -I eval/embed/run.py --dataset ko-strategyqa --json
데이터는 eval/lexical/README.md의 $KB_TOOLCHAIN/eval-data/<dataset>/{docs.json,queries.json}. 모델은 $KB_MODELS(디스크).
출력(--json): hybrid_ndcg10(통과선 0.80), dense_ndcg10, lexical_ndcg10, hybrid_wide_ndcg10(후보 25+10), p50_ms, p95_ms, docs_per_s,
device, contended(측정 중 GPU를 다른 프로세스가 쓰고 있었는가), gpu_before/gpu_after.
후보 수는 ADR 14.2 값이다(문단 10, 어휘 10). 이 데이터의 문서는 문단으로 센다. wide는 사실 15 + 문단 10에 문서를 둘 다로 센 진단값이다."""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

import sqlite3  # noqa: E402

from kb.core import paths  # noqa: E402
from kb.core.text import index_tokens  # noqa: E402
from kb.rank import conf, fusion, models, store  # noqa: E402
from kb.read.search import build_plan, lexical_ids  # noqa: E402


def gpu_state() -> dict:
    try:
        o = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"],
                           capture_output=True, text=True, timeout=10).stdout.strip().split(",")
        return {"used_mb": int(o[0]), "total_mb": int(o[1]), "util_pct": int(o[2])}
    except Exception:  # noqa: BLE001
        return {}


def ndcg(ranked: list[int], rel: set[int], k: int = 10) -> float:
    dcg = sum(1 / math.log2(i + 2) for i, x in enumerate(ranked[:k]) if x in rel)
    ideal = sum(1 / math.log2(i + 2) for i in range(min(len(rel), k)))
    return dcg / ideal if ideal else 0.0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="ko-strategyqa")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--limit-queries", type=int)
    ap.add_argument("--limit-docs", type=int)
    a = ap.parse_args(argv)
    d = Path(paths.toolchain_dir()) / "eval-data" / a.dataset
    try:
        docs = json.loads((d / "docs.json").read_text(encoding="utf-8"))
        qs = json.loads((d / "queries.json").read_text(encoding="utf-8"))
    except FileNotFoundError as e:
        print(f"데이터 없음: {e.filename}. eval/lexical/README.md의 변환 절차를 따른다.", file=sys.stderr)
        return 2
    if a.limit_docs:
        docs = docs[:a.limit_docs]
    if a.limit_queries:
        qs = qs[:a.limit_queries]
    ids = [x["id"] for x in docs]
    pos = {x: i for i, x in enumerate(ids)}
    gpu0 = gpu_state()
    device = models.pick_device()
    cache = paths.kb_home() / "derived" / "eval-embed" / f"{a.dataset}-{len(docs)}-{conf.MODELS['embed']['rev'][:8]}-d{conf.DIM}"
    emb = models.Embedder(conf.model_path("embed"), device)
    t0 = time.monotonic()
    if (cache / "meta.json").exists():
        ix, dps = store.Index(cache), None
    else:
        rows = emb.encode_q8([x["text"] for x in docs], "document")
        dps = len(docs) / (time.monotonic() - t0)
        cache.parent.mkdir(parents=True, exist_ok=True)
        store.write_index(cache, cache.name, ids, ["p"] * len(ids), ["-"] * len(ids), rows, {"model": "eval"})
        ix = store.Index(cache)
    rr = models.Reranker(conf.model_path("rerank"), device) if device == "cuda" else None
    con = sqlite3.connect(":memory:")
    con.execute("CREATE VIRTUAL TABLE fts USING fts5(tok, content='', contentless_delete=1, tokenize=\"unicode61 remove_diacritics 0\")")
    con.executemany("INSERT INTO fts(rowid,tok) VALUES(?,?)", ((i + 1, " ".join(index_tokens(x["text"]))) for i, x in enumerate(docs)))
    con.commit()
    sums = {"hybrid": 0.0, "dense": 0.0, "lexical": 0.0, "wide": 0.0, "c_route": 0.0}
    lat: list[float] = []

    def pipeline(q, dense_fact, dense_psg, lex):
        cands = fusion.pool(dense_fact, dense_psg, lex, [])
        if rr is None:
            return cands
        lg = rr.score(q["q"], [docs[pos[c]]["text"] for c in cands])
        return fusion.rerank_order(cands, lg)

    for q in qs:
        rel = {pos[r] for r in q["rel"] if r in pos}
        t = time.monotonic()
        qv = emb.encode_q8([q["q"]], "query")[0]
        lex = [ids[r - 1] for r in lexical_ids(con, build_plan(q["q"]), topk=conf.CAND_LEX)][:conf.CAND_LEX]
        dp = ix.topk(qv, conf.CAND_PASSAGE, "p")
        out = pipeline(q, [], dp, lex)
        lat.append((time.monotonic() - t) * 1e3)
        wide = pipeline(q, ix.topk(qv, conf.CAND_FACT + conf.CAND_PASSAGE, "p"), [], lex)
        sums["hybrid"] += ndcg([pos[i] for i in out], rel)
        sums["wide"] += ndcg([pos[i] for i in wide], rel)
        sums["dense"] += ndcg([pos[i] for i in ix.topk(qv, 10, "p")], rel)
        sums["lexical"] += ndcg([pos[i] for i in lex], rel)
        sums["c_route"] += ndcg([pos[i] for i in fusion.pool([], dp, lex, [])], rel)
    gpu1 = gpu_state()
    n = max(len(qs), 1)
    lat.sort()
    other_before = gpu0.get("used_mb", 0)
    res = {"dataset": a.dataset, "docs": len(docs), "queries": len(qs), "device": device,
           "hybrid_ndcg10": round(sums["hybrid"] / n, 4), "hybrid_wide_ndcg10": round(sums["wide"] / n, 4),
           "dense_ndcg10": round(sums["dense"] / n, 4), "lexical_ndcg10": round(sums["lexical"] / n, 4),
           "route_c_ndcg10": round(sums["c_route"] / n, 4), "reranker": rr is not None,
           "p50_ms": round(lat[len(lat) // 2], 1), "p95_ms": round(lat[int(len(lat) * 0.95)], 1),
           "docs_per_s": round(dps, 1) if dps else None, "embed_cached": dps is None,
           "gpu_before": gpu0, "gpu_after": gpu1,
           "contended": bool(gpu0 and (gpu0.get("util_pct", 0) > 15 or gpu0.get("used_mb", 0) > 3000 or gpu1.get("util_pct", 0) > 60)),
           "models": {k: v["rev"][:8] for k, v in conf.MODELS.items()}}
    print(json.dumps(res, ensure_ascii=False, sort_keys=True) if a.json else "\n".join(f"{k}: {v}" for k, v in res.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
