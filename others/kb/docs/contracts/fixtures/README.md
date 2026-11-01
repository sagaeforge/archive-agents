# 계약 fixture (합성 데이터)

이 폴더의 모든 데이터는 합성이다. 실제 사실이 아니다. 이름, 수치, URL은 지어낸 것이고 `*.example.test`만 쓴다.
KB가 소유한다. sagae-tools는 복사해서 쓰고 고치지 않는다. 계약 원본은 `../openapi.yaml`이고 사례 목록은 계약 9장이다.

## 구성

| 경로 | 내용 |
|---|---|
| `ledger.ndjson` | 합성 원장 조각. 이벤트마다 `event_id`, `at`, `idem_key`가 고정이다. 마지막 `schema.epoch_bumped`로 epoch가 2다 |
| `cas/<sha256>` | CAS 객체의 원문 바이트(표시 본문, 문단 목록, 시계열 묶음, 원본 Markdown). 파일 이름이 내용의 SHA-256이다 |
| `requests.yaml` | 요청 목록. `meta`에 고정 시계(`now_ms`)와 export 게시 지점(`export_after_seq`), 태그 설명이 있다 |
| `responses/<id>.json` | 요청별 기대 응답 `{case, status, headers, body \| body_base64}`. 헤더는 `content-type`, `etag`, `cache-control`, `vary`, `content-range` 등 일부만 둔다 |
| `mcp/kb_put-held.json` | `held`. 원장에 없으므로 `kb_put` 응답으로 둔다 |

## 재생 규칙

1. `ledger.ndjson`을 빈 원장에 순서대로 넣고 `cas/`의 객체를 CAS에 넣는다.
2. `export_after_seq`번째 이벤트까지 넣고 gold를 만든 뒤 export를 게시한다(게시 시각은 `now_ms`). 나머지를 넣고 gold를 다시 만든다.
3. 시계를 `now_ms`로 고정하고 `requests.yaml`의 요청을 보낸다. 결과가 `responses/`와 같아야 한다.

`build_id`는 재생 입력(스키마 판, 마지막 seq, 마지막 해시)의 해시라 결정적이다. `/v1/ops/*`는 ops.db에 합성 실행 기록 둘, 지표 하나, 소스 상태 하나를 넣고 합성 소스 레지스트리(`src:a`, `src:b`)로 읽는다.
export의 zstd 바이트는 libzstd 판에 따라 달라질 수 있다. 판이 바뀌어 어긋나면 아래 명령으로 다시 만든다.

## 다시 만들기

```
source ops/bin/wp-env.sh WP-11
ops/bin/dev python tests/contract/gen_fixtures.py --write   # 기록
ops/bin/dev python tests/contract/gen_fixtures.py --check   # 디스크와 비교
```

파괴 변경은 계약 8장의 절차를 따른다. fixture를 고쳤으면 소비자(sagae-tools)에 알린다.
