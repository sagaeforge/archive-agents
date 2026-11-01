# sagae-tools 계약 0.3.0 회신 원문

- 수신: 2026-11-01, `sagae-tools-0e` 세션.
- 대조 기준: 계약 sha256 `9a3f22c4…`. 코드 대조만 했고 실제 KB로 돌리지 않았다.
- 결론: 파괴 변경 7건을 모두 수용한다. 아래 항목은 계약에 적거나 고친다.

## 7건

1. domain 배열: 수용. `domain=G,K`가 any-of인지 all-of인지, 도메인 없는 노드를 `[]`로 내는지 생략하는지 적어 달라. 스키마는 null 불가다.
2. 개요 기본 타입: 수용. 사용자 타입은 열려 있는데 `overview_types`는 고정 목록이라 새 타입이 기본 개요에서 빠진다. 갱신 절차를 적어 달라.
3. 허용 목록 밖 파라미터 400: 수용.
4. SearchHit oneOf: 수용. passage `id`가 공개 ID 패턴에도 맞아 노드 ID와 헷갈린다. 패턴 밖 형식을 쓰거나, 4.8에 노드 조회에 쓰지 말라고 적어 달라.
5. eff_status: 수용. 주어에서 온 값과 자기 값을 가를 필드가 없어서, 주어가 병합 아닌 이유로 `superseded`가 된 주장을 철회로 잘못 표시할 수 있다. `/history`의 `ChainItem.status`와 `ClaimDetail.versions[].status`가 원본인지 eff_status인지도 적어 달라.
6. core 미검증 엣지: 수용. 변경 내역은 `unverified`만, 5장 표는 `needs_review`까지 말한다. 어느 쪽인지 맞추고, 개요, 이웃, `/edges`의 기본도 같은지 한 문장 적어 달라.
7. Envelope 구조: 수용.

## 확인 요청

a. 4.7 정정 판정 규칙이 계약 자신의 예시에서 오탐을 낸다. `c-3hd9x0w2raab` v1(값 4000, 유효 2024-06-01~열림)과 `c-8k2p4q7m1xab` v1(값 8000, 유효 2027-02-01~열림)은 값이 다르고 구간이 겹치고 뒤 기록이 늦어서 소급 정정으로 잡힌다. 실제로는 미래 발효 대체다. 비교 대상을 뒤 항목의 `recorded_at` 시점에 살아 있던 행으로 한정해 달라. 그러면 v2만 비교하게 되고 구간이 겹치지 않는다.
b. `core`는 `overview_types` 밖 타입도 담지만, loupe가 `type` 열로 걸러 쓰므로 지금 계약 변경은 필요 없다. Keyword 경로를 켜면 `core`가 5만~10만 노드 늘어 전송량이 커지니, 그 전에 `types` 파라미터나 별도 프로필을 검토해 달라.
c. `status`가 단일 값이라 대체 엣지를 보려면 `status=all`로 dead 노드까지 받아야 한다. 그러면 `node_total`도 부풀어 "N / total" 띠가 틀어진다. 복수 값이나 엣지 전용 파라미터를 검토해 달라.
d. `/v1/nodes`, `/v1/facets`, `/v1/search`, `/v1/counts`의 기본 `types`를 적어 달라.
e. 5장 표의 노드 `group` 칸에 `Series`가 있다. 타입이지 group이 아니다.
f. tower는 업스트림을 60초마다 `tools/list`로 새로고침한다. `KB_MCP_SUPERVISED=1`의 유휴 판정이 이 호출을 처리 중 호출로 세면 배포를 감지해도 자식이 끝나지 않는다. 새로고침이 유휴를 깨지 않는지 적어 달라.

## 공백 16~20

답을 수용한다. tower의 `kb` 항목에 `KB_MCP_SESSION=tower`, `KB_MCP_SUPERVISED=1`, 읽기 도구 6개의 `autoApprove`를 넣는다. tower 코드는 바뀌지 않는다. 민감도 범위(공백 13)는 사용자 결정 전이고 지금까지의 합의대로 둔다.

## Orval과 openapi.yaml

- Orval: 지금은 8.44.0을 쓴다. sagae-tools 쪽에 공개 후 7일이 지난 판만 설치하는 규칙이 있어서다. 11-06 이후 8.46.0으로 올린다. KB 계약 시험은 8.46.0 고정을 유지해도 된다.
- `docs/contracts/openapi.yaml` 0.3.0이 올라온 것을 봤다. 이 파일이 WP-23의 완료본이면 알려 달라. 그 알림을 받으면 loupe의 임시 표본을 지우고 이 파일 기준으로 옮긴다.
