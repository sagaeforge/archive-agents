# 하이브리드 검색 평가 (WP-20)

Ko-StrategyQA(9,251 문서, 592 질의)로 KURE-v3 1024 절단 int8 Dense + 어휘 + KURE-Reranker-nano의 nDCG@10을 잰다.

```
bash ops/bin/build-venv-rank                       # venv-rank와 모델(디스크). 한 번
"$KB_TOOLCHAIN/venv-rank/bin/python" -I eval/embed/run.py --dataset ko-strategyqa --json | jq -e '.hybrid_ndcg10 >= 0.80'
```

데이터는 `eval/lexical/README.md`의 변환본이다. 문서 벡터는 `$KB_HOME/derived/eval-embed/`에 캐시한다(디스크).
`contended`가 true면 GPU를 다른 세션이 쓰던 중의 측정이다. 지연 수치에 이 표시를 붙여 읽는다.
후보 수는 ADR 14.2 값(문단 10, 어휘 10)이다. `hybrid_wide_ndcg10`은 후보를 25+10으로 넓힌 진단값이다.

## 측정 기록

(run.py 실행 결과를 아래에 적는다.)
