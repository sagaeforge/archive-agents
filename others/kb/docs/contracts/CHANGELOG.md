# 계약 변경 기록

`docs/contracts/openapi.yaml`의 변경 기록이다. 파괴 변경은 major(0.x 동안은 minor)를 올리고 여기에 적은 뒤 sagae-tools 세션에 알린다(계약 8장). 기준선은 `docs/contracts/baseline/openapi.yaml`이고 올리는 것은 소비자 통지 뒤의 명시 절차다.

## 0.5.0 (2026-11-06) ADR-0005 FW9 호환 추가

- reviewer/HITL/사용자 동작 경로 9개와 상태·엔진·비용·시간·외부 전송 계획 스키마를 추가했다. publish 준비는 202/action_id, release/declassify 준비는 201이다. 상태 조회는 발급 tok_id만 허용한다.
- publish_external_refine과 publish는 서로 대체할 수 없는 action_sha/증명이다. 120초 1회용 도전·UV·증가 카운터·정확한 RP/origin, 현재 판/결과 재검사, 403 review_unverified·409 review_stale·503 review_trust_unavailable을 명시했다. 기존 HitlReadiness의 안전한 meta 표현을 재사용한다.
- 결정 9에 따라 새 FW9 POST 성공은 평면 객체를 유지한다(ADR-0005 628행, test_publish_async.py:226–228). GET 성공은 전체 Envelope와 RFC 3339 UTC 시각을 쓴다. POST에 대한 결정 7의 봉투 요구를 정정했다.
- 기존 0.4.0 응답 모양은 하나도 바꾸지 않았다. 기존 경로·컴포넌트·x-first-party-paths·기존 응답 fixture를 보존하는 **호환 추가**다. 기준선은 올리지 않는다. 새 경로 선언은 운영 배포·실물 인증기 확인 완료를 뜻하지 않는다.
- 기존 fixture 재생과 분리한 reviewer 합성 패킷과 operation별 성공/오류 예제를 추가했다. 생성기 패킷 버전과 소비자 검사기의 메서드별 조회를 갱신한다. 정적 스키마 검사는 동작 검증을 대신하지 않는다.

## 0.4.0 (2026-11-06) ADR-0005 FW1 승인 계약

- `x-first-party-paths`에 편집·승격·연구·쓰기 참조·주장별 리뷰 Path Item 10개 operation을 고정했다. 미배포(`x-implemented:false`)이며 기존 `paths`의 읽기 GET 26개와 실서버 기준선을 유지한다. 일반 생성기는 확장 경로를 자동 생성하지 않는다. 후속 HTTP 배포에서 Path Item을 승격한다.
- 기록 쓰기의 평면 결과, 읽기의 봉투 결과, dry-run·전체 오류 코드/고정 문구(ADR 7.5), 단일 WriteReadiness(ADR 8.1)를 추가했다. history VersionRow의 provenance/해시와 Meta.write는 선택 필드다. reviewer/HITL/사용자 동작 경로와 HTTP 구현은 포함하지 않는다.
- 공개 `first-party-secret-rules-v1.json`: Gitleaks v8.30.1(MIT), 221개 규칙과 KB 추가 규칙·다이제스트 예외·코드포인트/UTF-16 합성 벡터. 실제 비밀·설치별 예외는 없다. 브라우저 검사는 안내이며 서버가 최종 판정한다.
- 11종 승인 계약 fixture와 label-prefix 읽기 재생 사례를 생성기에 추가했다. 생성기는 기존 사용자·동료 파일을 삭제하지 않는다.
- info.version·예시·생성기 CONTRACT_VERSION·requests.meta.contract_version을 0.4.0으로 맞췄다. 기준선에서 소비자 검사를 막던 `0.3.1 !== 0.3.2`의 상수 불일치를 수정한다. 실제 기존 서버의 schema_version 응답은 수정하지 않는다. 계약 검사 통과 여부는 task-1-report.md에 기록한다.
- 기존 읽기 기준선 파일은 변경하지 않았다. 합성 계약의 스키마 통과가 HTTP 저장·거절·준비 상태 동작을 입증하지 않는다.

## 0.3.2 (2026-11-01) 소비자 확정본 요청 3건, 호환 변경만

입력은 `docs/contracts/consumers/sagae-tools.md` 확정본의 열린 요청 1~3이다. 파괴 변경은 없다.

- 정정(스키마): `as_of_valid`에 `minLength: 1`과 `pattern`(RFC 3339 또는 `YYYY-MM-DD`)을 선언했다. 빈 값은 무효(400 `bad_param`). `as_of_observed`는 `format: date-time`이 이미 있다.
- 정정(스키마): `/v1/facets`의 `q`를 선택으로 했다(`QOptional` 파라미터 추가). `/v1/search`의 `q`는 필수 그대로다. 4.9 산문과 일치한다. 소비자는 항상 보내므로 호환이다.
- 정정(문서): 12장 예상 규모의 주장 수를 29만~37만으로 고쳤다(측정 창당 7.2~9.53건 통과, ADR 부록 A).
- 버전: `info.version`과 예시의 `schema_version`을 0.3.2로 올렸다. 기준선(`baseline/`)은 sagae-tools가 2026-11-01에 0.3.2를 수용한 뒤 0.3.2로 올렸다.

## 0.3.1 (2026-11-01) 3차 회신 처리, 호환 변경만

입력은 `docs/contracts/consumers/sagae-tools-reply-3.md`이고 항목별 처리는 `sagae-tools-reply-3-response.md`다. 파괴 변경은 없다. `docs/contracts/baseline/openapi.yaml`은 sagae-tools 수용 회신(2026-11-01) 뒤 0.3.1로 올렸다. 호환 변경이라 기준선을 올리는 것은 소비자 통지 뒤의 명시 절차다. `test_baseline_in_sync`가 같은 판이면 바이트 일치, 더 높은 판이면 경로, 파라미터, 속성, `required`, 닫힌 enum을 줄이지 않았는지 본다.

- 추가(쿼리 파라미터): `/v1/overview`, `/v1/nodes/{id}/neighbors`의 `edge_status`. 엣지에만 걸리고 쉼표로 여러 값을 받으며 생략하면 `status`와 같다.
- 추가(필드): `Claim`과 `ChainItem`의 `own_status`, `status_basis`. `NodeType.in_overview`. 모두 선택 필드다.
- 추가(값): 필터 `domain=none`과 `/v1/facets` `domain` 축의 `none`. 도메인 없는 노드의 `domain`은 `[]`다.
- 확정(문서): `domain` 복수 값은 any-of. `overview_types` 갱신 절차(사용자 타입 자동 포함). `ChainItem.status`와 `ClaimDetail.versions[].status`는 `eff_status`. 4.7 정정 판정의 비교 대상은 뒤 항목의 `recorded_at`에 살아 있던 행과 같은 `id`의 직전 버전. 경로별 기본 `types` 표(2.7). `status`는 단일 값 유지.
- 정정(문서): `core`의 미검증 엣지 제외는 `needs_review`와 `unverified` 둘 다이고 개요, 이웃, `/edges`와 같다(0.3.0 변경 내역의 `unverified`도 두 값). 5장 표의 `Series`는 `fact` 그룹의 타입이다. passage `id`는 노드 조회에 쓰지 않는다(404).
- 버전: `info.version`과 예시의 `schema_version`을 0.3.1로 올렸다.

## 0.3.0 (2026-11-01) 기계 판독 원본 초안

- `docs/contracts/data-interface-v0.md` 0.3.0을 OpenAPI 3.1.1 + JSON Schema 2020-12로 옮겼다. 3장 YAML은 `components/schemas`에 그대로 쓰고 `PublicId`(계약 2.10 패턴)만 더했다.
- 4장 표의 26개 경로를 `operationId`, 응답, 허용 파라미터까지 표대로 옮겼다. 봉투 경로의 200은 `<이름>Envelope`이고 `Envelope`에 `data`를 선언하지 않는다.
- 공통 파라미터는 `components/parameters`, 오류 응답은 `components/responses`의 `Problem`이다. 429, 503에 `Retry-After`를 선언했다.
- 문서에 값이 없는 선택은 이 초안이 정했고 다음과 같다. 문서와 어긋나면 이 파일이 이긴다.
  - `GET /v1/export/graph`의 `profile`은 선택이고 기본 `core`다.
  - `GET /v1/counts`의 `bucket`, `field`는 선택이고 기본값을 선언하지 않는다.
  - 서버 주소(`servers`)를 선언하지 않는다. 생성 클라이언트가 주소를 박지 않게 한다.
  - `If-None-Match`, `Range` 헤더는 파라미터가 아니라 설명에만 둔다.
- `/v1/ops/*`와 `Ops*` 스키마에 `x-provisional`을 달았다.
- 기준선을 `docs/contracts/baseline/openapi.yaml`에 고정했다.
