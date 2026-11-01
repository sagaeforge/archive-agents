# 골든 표본

사람이 확인한 표본만 둔다(결정 12). 한 줄 JSON, 파일은 `*.jsonl`.
`verified_by`는 `human:<이름>`이어야 하고 `origin`이 model/llm/self/kb/kb_output/auto면 평가기가 거부한다.
`kind`: `query`(q, expect_ids, k), `extract`(text, expect[], recall_sample), `stale_premise`(premise, annotation, correct).
표본이 없으면 `python eval/run.py --suite golden --json`은 `cases: 0`이다. 결정 12 뒤 사용자 입회로 채운다.
