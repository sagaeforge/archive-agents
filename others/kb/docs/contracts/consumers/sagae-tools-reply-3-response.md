# sagae-tools 3차 회신 응답표

- 대상: `docs/contracts/consumers/sagae-tools-reply-3.md`(수신 2026-11-01, 계약 sha256 `9a3f22c4…` 대조).
- 응답 기준: 계약 0.3.1(`docs/contracts/data-interface-v0.md`, `docs/contracts/openapi.yaml`). 절 번호는 0.3.1 기준이다. 변경 기록은 `docs/contracts/CHANGELOG.md` 0.3.1이다.
- 처리: **수용**은 요청대로, **변경**은 다른 형태로 충족, **거절**은 하지 않음이다. 합계는 16건이고 수용 11, 변경 5, 거절 0이다.
- 이번 판은 호환 변경만 담는다(필드, 쿼리 파라미터, 값 추가와 문서 확정). 파괴 변경은 없고 `not_resolved`도 없다. `docs/contracts/baseline/openapi.yaml`은 0.3.0 그대로이며 올리는 것은 소비자 통지 뒤의 명시 절차다.
- 기본값은 결정으로 바꿨다. 아래 "결정" 표가 한 줄 요약이다.

## 7건

| 번호 | 처리 | 계약 절 | 이유 |
|---|---|---|---|
| 보완 1 | 변경 | 2.7, 4.9, 5장 | `domain=G,K`는 any-of로 확정했다. 도메인 없는 노드는 `[]`이고 `null`도 생략도 아니다. 그 노드를 고르려고 `domain=none`과 패싯 `none`을 더했다(호환 추가) |
| 보완 2 | 변경 | 4.2 | `x-kb-overview` 키가 없으면 사용자 타입은 `true`다. 새 사용자 타입은 임시 등록 때부터 목록에 든다. `/v1/schema`의 `ETag`와 `NodeType.in_overview`(추가)로 갱신을 읽는다. 세계 타입 조정은 통지한다 |
| 보완 3 | 수용 | 4장 | 변경 없음. 허용 밖 파라미터는 400 `bad_param`이다. `edge_status`는 표에 더해 두 경로에서만 허용한다 |
| 보완 4 | 수용 | 4.8, 3장 | passage `id`의 형식은 바꾸지 않는다. 응답 값 변경을 피하려고 4.8에 노드 조회에 쓰지 말라고 적었다. 넣으면 404이고 `SearchHitPassage.id`에 설명을 달았다 |
| 보완 5 | 변경 | 2.7, 4.7, 3장 | `Claim`과 `ChainItem`에 `own_status`, `status_basis`를 더했다(선택 필드). `ChainItem.status`, `ClaimDetail.versions[].status`는 `eff_status`이고 `history.versions[]`는 자기 상태다 |
| 보완 6 | 수용 | 2.7, 5장 | 5장 표가 맞다. `core`는 `needs_review`, `unverified` 둘 다 뺀다. 0.3.0 변경 내역의 `unverified`도 두 값이다. 개요, 이웃, `/edges`, `core`가 같다 |
| 보완 7 | 수용 | 3장, 4장 | 변경 없음 |

## 확인 요청

| 번호 | 처리 | 계약 절 | 이유 |
|---|---|---|---|
| a | 수용 | 4.7 | 비교 대상을 뒤 항목의 `recorded_at`에 살아 있던 행으로 한정했다. 제자리 정정을 놓치지 않으려고 같은 `id`의 직전 버전은 더한다(요청에 없던 보강). 계약 예시는 정정이 아니다. 시험으로 고정했다 |
| b | 수용 | 5장, 빌드 계획 WP-24 | 계약은 바꾸지 않았다. Keyword 경로를 구현하는 WP-24의 검토 항목과 인수 조건에 `types` 파라미터와 별도 프로필 검토를 넣었다 |
| c | 변경 | 2.7, 4.3, 4.6 | `status` 복수 값은 두지 않고 엣지 전용 `edge_status`(복수 값)를 `/v1/overview`, `/v1/nodes/{id}/neighbors`에 더했다. 노드 집합과 `node_total`이 변하지 않는다 |
| d | 수용 | 2.7 | 경로별 기본 `types` 표를 더했다. 개요는 `overview_types`, `/v1/nodes`, 이웃, `q` 없는 `/v1/facets`는 5종을 뺀 전부, 검색과 `q` 있는 패싯은 `kinds`, `/v1/counts`는 제한 없음 |
| e | 수용 | 5장 | `Series`는 타입이다. 노드 `group` 칸을 `world`, `user`, 그리고 `fact`의 `Series` 타입만으로 고쳤다 |
| f | 수용 | ADR 15.1, 빌드 계획 WP-12 | 유휴 판정은 `tools/call`, `resources/read` 처리 중 개수만 센다. `tools/list`는 세지 않으므로 60초 새로고침이 유휴를 깨지 않는다. `test_long_lived`에 시험을 더했다 |

## 공백 16~20, Orval, openapi.yaml

| 항목 | 처리 | 계약 절 | 이유 |
|---|---|---|---|
| 공백 16~20 | 수용 | 13장, ADR 15.1 | tower 설정(`KB_MCP_SESSION=tower`, `KB_MCP_SUPERVISED=1`, 읽기 도구 6개 `autoApprove`)은 ADR과 `print-gateway-config.sh`가 같은 모양으로 낸다. 민감도 범위(공백 13)는 사용자 결정 전이며 합의대로 둔다 |
| Orval | 수용 | 빌드 계획 WP-23 | KB 시험은 8.46.0 고정을 유지한다. 0.3.1 `openapi.yaml`로 생성, `tsc`, `narrow.ts`를 통과했다 |
| openapi.yaml 완료본 여부 | 변경 | 머리, CHANGELOG | 0.3.1이 WP-23의 계약 형태 완료본이다. 이전 판과 호환이라 loupe는 0.3.1 기준으로 옮겨도 된다. 단 `baseline/`은 소비자 통지 뒤 올리므로 이 응답을 메인 세션이 전달해야 확정이다 |

## 결정

| 주제 | 결정 | 계약 절 |
|---|---|---|
| `domain` 복수 값 | any-of. all-of 없음. `none`은 도메인 없는 노드 | 2.7 |
| 도메인 없는 노드 | `domain: []` | 2.7, 5장 |
| `overview_types` 갱신 | 사용자 타입 자동 포함, 세계 타입은 파일에서 올림 | 4.2 |
| passage `id` | 형식 유지. 노드 조회 금지, 404 | 4.8 |
| 구분 필드 | `own_status`, `status_basis` | 2.7 |
| 정정 판정 | 뒤 항목의 `recorded_at`에 살아 있던 행과 같은 `id` 직전 버전 | 4.7 |
| 복수 상태 | `status` 단일 유지, 엣지 전용 `edge_status` | 2.7, 4.3 |
| 기본 `types` | 경로별 표 | 2.7 |
