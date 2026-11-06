# 어휘 검색 평가 (WP-05)

Ko-StrategyQA(9,251 문서, 592 질의)로 어휘 경로의 nDCG@10과 빈 결과 수를 잰다.

```
ops/bin/dev python eval/lexical/run.py --dataset ko-strategyqa --json
```

출력 필드: `ndcg10`, `hit10`, `empty`, `p95_ms`, `fts_mb`, `docs`, `queries`. 통과선은 `ndcg10 >= 0.585`, `empty == 0`이다.
색인은 `kb.core.text.index_tokens`, 질의는 `kb.read.search.build_plan`(별칭 확장, AND 후 OR)과 `lexical_ids`를 그대로 쓴다.
span, 필터, 스니펫은 거치지 않는다(rowid 순위만 잰다).

## 데이터

`$KB_TOOLCHAIN/eval-data/ko-strategyqa/{docs.json,queries.json}`을 읽는다(WP-22가 둔 변환본, 저장소 밖). 이 데이터는 라이선스를 확인하지 못해 저장소에 넣지 않는다
(데이터셋 카드에 라이선스 항목이 없다. 2026-11-01 확인).

없으면 아래로 만든다. 출처는 Hugging Face `mteb/Ko-StrategyQA` 개정 `315b000dfa35ba4713d2a266d204e68f8ac80687`(2025-05-06)이다.
큰 파일이므로 디스크의 `$KB_TMP`에 둔다(`/tmp` 금지).

```
src="$KB_TMP/sqa-src"; mkdir -p "$src"
rev=315b000dfa35ba4713d2a266d204e68f8ac80687
for f in corpus qrels queries; do
  curl -sL -o "$src/$f.parquet" "https://huggingface.co/datasets/mteb/Ko-StrategyQA/resolve/$rev/$f/dev-00000-of-00001.parquet"
done
uv run --no-project --with pyarrow==26.0.0 python -I eval/lexical/convert.py --src "$src" --out "$KB_TOOLCHAIN/eval-data/ko-strategyqa"
```

`pyarrow==26.0.0`(PyPI 2026-10-09 공개)은 `uv run --with`로만 쓰고 `uv.lock`에 넣지 않는다.
2026-11-01에 이 절차로 만든 파일이 WP-22의 변환본과 바이트 단위 JSON 동치임을 확인했다(docs 9,251건, queries 592건, 정답 있는 질의 592건).

## 측정 기록

| 날짜 | 색인 토큰 | ndcg10 | hit10 | empty |
|---|---|---|---|---|
| 2026-11-01 | `index_tokens` 옛 판(문서 안 중복 제거) | 0.5312 | 0.782 | 0 |
| 2026-11-01 | `index_tokens` 현재(중복 유지, gold_schema 2) | 0.5902 | 0.809 | 0 |

문서 안 중복 제거는 TF를 1로 만들어 bm25 순위를 깎는다. 그래서 색인 토큰의 중복을 남긴다. 프로토타입(`docs/design/prototypes/adr-scripts/tok_eval.py`, 확정안 0.5917)은 색인 토큰을 중복 제거하지 않고 질의 토큰만 중복 제거한다.
