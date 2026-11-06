# 계약 시험 (tests/contract)

`ops/bin/contract-check`가 전체를 돈다. 개별 실행: `source ops/bin/wp-env.sh WP-11 && ops/bin/dev pytest tests/contract -q`.

| 파일 | 내용 |
|---|---|
| `cfx_world.py` | 합성 원장과 CAS 객체의 원천(결정적) |
| `cfx_run.py` | 재생 도우미: gold 재구축, export 게시, 시계 고정, 합성 소스 레지스트리, ops.db 시드 |
| `gen_fixtures.py` | 사례 목록과 fixture 생성기. `--write`, `--check` |
| `test_fixture_roundtrip.py` | 디스크 fixture 재생 = 저장된 응답, 생성기 출력 = 디스크 |
| `test_fixture_cases.py` | 사례 태그, 26개 경로별 성공/오류, examples ID, 응답의 OpenAPI 스키마 통과 |
| `test_schemathesis.py` | Schemathesis 4.32.7로 실제 `kb serve --http`(루프백 TCP, Bearer)를 시험 |
| `test_oasdiff.py` | oasdiff 1.35.0, 기준선 대비 파괴 변경 0건. 기준선이 없으면 실패 |
| `oasdiff.sha256` | oasdiff 릴리스 압축 파일의 SHA-256(릴리스의 checksums.txt와 같다) |

## Schemathesis 검사 범위와 알려진 틈

응답 쪽 검사 다섯 개를 건다: `not_a_server_error`, `status_code_conformance`, `content_type_conformance`,
`response_headers_conformance`, `response_schema_conformance`. 전 경로 위반 0이다.
기본 검사 중 두 개는 뺐다. 요청 스키마와 서버 검증 사이의 틈을 잡는 검사라서다.

- `negative_data_rejection`(ST201): 서버가 형이 틀린 쿼리 값을 400으로 막지 않고 무시하는 경로가 있다(예: `include_unverified=AAA`).
- `positive_data_acceptance`(ST202): 스키마는 통과하지만 서버가 400으로 막는 값이 있다(빈 문자열 쿼리 값, `as_of_*`에 형식 없는 문자열, 아주 큰 정수 등). `as_of_*`의 `format`, 빈 문자열 금지(`minLength`)를 계약에 더하면 좁혀진다.

계약 쪽 틈 하나: `/v1/snapshots/{id}/raw`는 원 Content-Type을 그대로 주는데 `content`에 `application/octet-stream`만 선언돼 있다.
