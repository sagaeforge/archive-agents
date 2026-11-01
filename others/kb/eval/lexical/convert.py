"""mteb/Ko-StrategyQA parquet 3개를 docs.json, queries.json으로 바꾼다. pyarrow는 잠금에 넣지 않고 아래처럼 쓴다.

  uv run --no-project --with pyarrow==26.0.0 python -I eval/lexical/convert.py --src <parquet 폴더> --out <출력 폴더>

--src 폴더에 corpus.parquet, qrels.parquet, queries.parquet이 있어야 한다. README.md에 내려받는 절차가 있다.
"""
import argparse
import json
from pathlib import Path

import pyarrow.parquet as pq


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    src, out = Path(a.src), Path(a.out)
    corpus = pq.read_table(src / "corpus.parquet").to_pylist()
    queries = pq.read_table(src / "queries.parquet").to_pylist()
    qrels = pq.read_table(src / "qrels.parquet").to_pylist()
    docs = [{"id": r["_id"], "group": "x", "text": f"{r['title']} {r['text']}".strip()} for r in corpus]
    rel: dict[str, list[str]] = {}
    for r in qrels:
        if r["score"] > 0:
            rel.setdefault(r["query-id"], []).append(r["corpus-id"])
    qs = [{"qid": i, "cat": "ext", "q": q["text"], "rel": rel.get(q["_id"], [])} for i, q in enumerate(queries)]
    out.mkdir(parents=True, exist_ok=True)
    (out / "docs.json").write_text(json.dumps(docs, ensure_ascii=False), encoding="utf-8")
    (out / "queries.json").write_text(json.dumps(qs, ensure_ascii=False), encoding="utf-8")
    print(f"docs={len(docs)} queries={len(qs)} with_rel={sum(1 for q in qs if q['rel'])}")


if __name__ == "__main__":
    main()
