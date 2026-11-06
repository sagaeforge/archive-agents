# sagae-tools 2차 회신 응답표

- 대상: `docs/contracts/consumers/sagae-tools-reply-2.md`. 회신은 계약 sha256 `49fb5365…`, KB ADR sha256 `2e810894…`를 대조했다.
- 응답 기준: 계약 0.3.0(`docs/contracts/data-interface-v0.md`), ADR, 빌드 계획. 절 번호는 0.3.0 기준이다. 파괴 변경 목록은 계약 머리의 변경 내역이다.
- 처리: **수용**은 요청대로, **변경**은 다른 형태로 충족, **거절**은 하지 않음이다. 합계는 42건이고 수용 40, 변경 2, 거절 0이다.
- 표시: `0.2.0 반영`은 회신 뒤 계약 0.2.0이 이미 처리한 항목이다. 이번 판은 남은 문구만 맞췄다.
- 측정값: 이 문서의 렌더, 페이로드, 프록시, 바이너리 읽기 값은 전부 sagae-tools 측 값이고 KB 재현값이 아니다. `KB 재현`이라고 적은 것만 KB가 돌렸다.

## 13장 답

| 번호 | 처리 | 계약 절 | 이유 |
|---|---|---|---|
| 13장 답 1 | 수용 | 1장, 13장 | Unix 소켓 기본, 소비자는 `loupe serve`, tower는 KB HTTP를 쓰지 않는다. TCP 8737은 v1에서 쓰지 않는다 |
| 13장 답 2 | 수용 | 4.13, 13장 | `/v1/ops/*`는 `[잠정]`으로 두고 loupe 때문에 앞당기지 않는다 |
| 13장 답 3 | 수용 | 2.4, 4.3, 4.6, 4.9 | `page.total`의 `null`은 검색 기본 경로와 피드뿐이다. `node_total`, `edge_total`, `/v1/facets`의 `total`은 스키마가 `integer`다 |
| 13장 답 4 | 수용 | 2.3, 4.1 | 동시 상한 기본 16, 하한 12(소비자 근거 2개 × 약 6개는 가정). 429에 `Retry-After`가 항상 있다. 값은 `limits.concurrent`로 읽는다 |
| 13장 답 5 | 수용 | 4.2, 4.3 | 초기안 + `Series` 16개를 `/v1/schema`의 `overview_types`로 내고 `/v1/overview` 기본값으로 쓴다. 1차 수집 뒤 실제 `count`로 조정하고 바뀌면 알린다. 이웃 기본값은 넓게 둔다 |
| 13장 답 6 | 수용 | 2.9, 5장 | 소비자는 `core`만 쓴다. 과거 시점 입력은 v1에 없다. `full`은 소비자 없이 남는다 |
| 13장 답 7 | 수용 | 6.3 | 블록 링크는 v1에 없다. `[잠정]` 표시를 지웠다 |
| 13장 답 8 | 수용 | 7장 | 소켓은 토큰 없음, TCP와 원격은 mode 600 파일 + `Authorization: Bearer`, loupe는 TCP일 때만 `viewer` 토큰이다 |
| 13장 답 9 | 수용 | 4장 | 웜 목표를 유지하고 콜드 목표를 따로 뒀다. 값은 공백 15다 |

## 공백

| 번호 | 처리 | 계약 절 | 이유 |
|---|---|---|---|
| 공백 1 | 수용 | 2.10, 3장, 4장 | 0.2.0 반영. 패턴 `^[A-Za-z0-9][A-Za-z0-9:._-]*$`를 더했다. 한 세그먼트 인코딩을 그대로 받는다 |
| 공백 2 | 수용 | 2.10, 4.1, 4.5, 4.14 | 두 경로의 절을 만들었다. `/v1/nodes/{id}`는 모든 노드 ID에 응답하고 ID별 필드는 2.10 표다. `r-`는 404다. `kb.read` 표는 빌드 계획 2.3에 이미 있다 |
| 공백 3 | 수용 | 4.5, 4.7 | `claim_limit` 최대 200, `id` 오름차순, `/claims` 커서로 끝까지 읽는다. `/history`와 `/claims`에 `predicate`가 있다 |
| 공백 4 | 수용 | 4.1, 4.12, 5장 | `changes_cursor`로 꼬리부터 읽고 `origin` 파라미터를 더했다. 피드 커서는 필터 해시가 없어 시작 커서를 어떤 필터로도 쓴다 |
| 공백 5 | 수용 | 4.3, 4.6, 5장 | 개요, 이웃, export 엣지 열에 `status`를 넣었다 |
| 공백 6 | 수용 | 2.9 | 0.2.0 반영. 기본은 관측축만 현재이고 `/history`의 `as_of_*`는 400이다 |
| 공백 7 | 변경 | 3장, 4.4, 4.8 | `kind`별 `oneOf`, `subject`, `passage`의 `snapshot_id`와 오프셋은 수용. 접두어 일치는 색인이 전체 토큰이라 검색에 넣지 않고 `/v1/nodes?filter=label:prefix:`로 낸다 |
| 공백 8 | 수용 | 4장 표 문법 | 연산자, 복수 필터 AND, 값 안의 `:`, `in` 이스케이프, 형별 비교, `sort` 방향, 동률, 기본 정렬을 적었다. `source`, `author`는 공통 필터다 |
| 공백 9 | 수용 | 2.5 | `"<epoch>-<applied_seq>-<build_id>"` 수용. schema와 스냅샷 메타데이터는 데이터 경로, meta는 `degraded` 해시 추가, export는 게시 파일 구분이다. 불변은 `/text`, `/raw`뿐이다 |
| 공백 10 | 수용 | 5장 | 포함 규칙에 `unverified`를 맞췄다. `sha256`은 전송 바이트, 첫 게시 전은 503 `not_ready`, `g-`와 `p-`는 `applied_seq`로 잇는다 |
| 공백 11 | 수용 | 3장, 4.5, 4.6, 4.11 | `include=body` 필드, `backlink_limit`, `EdgeRef.peer`, 이웃 열과 `data` 바로 아래의 `truncated`, 이웃 `edge_limit`, `/text`의 코드포인트 창을 적었다 |
| 공백 12 | 수용 | 2.7, 2.10, 3장 | 응답 `status`는 `eff_status`다. `status`는 내장 묶음에 적용된다. 닫힌 enum은 2.10 표 10종이다. `Evidence.id`는 결정적 해시라 재구축과 재확인에도 같다 |
| 공백 13 | 수용 | 2.8, 7장, 13장 | 결정 14 기본값 (c)로 처리한다. 사용자 결정 전까지 소켓은 `internal` 이하다. (b)는 4812로 `private`가 새므로 (c)를 바꾸려면 KB가 먼저 알린다. `kb api`는 ADR 7.9로 닫혔다 |
| 공백 14 | 수용 | 2.3, 4.5, 4.8, 7장, 10.1 | 0.2.0 반영. 자체 Host 미들웨어로 403(`TrustedHostMiddleware`의 400은 sagae-tools 측 값, N=1). 10.1, `{24,29}`, 주장 `label`, `EdgeRef`를 다시 확인했다 |
| 공백 15 | 수용 | 4장, 10.3 | WP-10 부하 시험은 노드 40만, 엣지 150만, 문단 15만, 개요 5만·20만이다. 콜드 초기 목표는 p95 1초, 개요 4초이고 측정 뒤 확정한다 |
| 공백 16 | 수용 | 6.1, 13장 | ADR 7.8: 귀속 단위는 세션이 아니라 서버 프로세스다. tower 뒤에서는 설정이 `KB_MCP_SESSION=tower`를 넣어 `f:agent:tower`로 드러내고 이 귀속을 받아들인다. 세션을 남기려면 `record.props.session`에 적고 자기 신고 표시값이라 작성자, 민감도, 멱등 판정에 쓰지 않는다 |
| 공백 17 | 수용 | 13장 | ADR 15.1: 세션 종료 전송은 한 함수가 프로세스당 1회 `kb ship --if-dirty --timeout 12`를 띄우고 신호 핸들러와 stdin EOF 뒤가 같은 함수를 부른다. tower 뒤에서는 세션 종료가 자식에게 보이지 않는다. 다른 프로젝트 세션의 T0 전송은 15분 tick이 맡고 `SessionEnd` 훅은 이 저장소 세션에만 둔다. 이것으로 된다. 결정 3 전에는 tick도 사람이 부른다 |
| 공백 18 | 수용 | 13장 | ADR 15.1: 자식은 DB 연결을 쥐지 않고 호출마다 `connect_ro`로 `current`를 열어 교체와 옛 빌드 삭제가 호출을 깨지 않는다. `KB_MCP_SUPERVISED=1`이면 60초마다 `runtime/venv`의 대상을 비교하고 바뀌었고 처리 중 호출이 없으면 종료 전송 뒤 끝난다. tower가 다시 띄운다. 시험은 WP-12 `test_long_lived`다 |
| 공백 19 | 수용 | 2.4, 13장 | ADR 15.2: `cur`는 계약 2.4 커서 그대로다. 불투명 base64url이고 순위 위치, 필터 해시, `epoch`을 담는다. 서버 상태가 없어 자식이 재시작해도 이어지고, 다른 필터면 `cursor_mismatch`, `epoch`이 바뀌면 `epoch_changed`다. 머리에 약 40자가 더 들고 예산 추정에 포함한다 |
| 공백 20 | 수용 | 13장 | ADR 7.9, 15.4: `print-gateway-config.sh`는 `upstreams.kb` 모양이고 `env`에 `KB_MCP_SESSION=tower`, `KB_MCP_SUPERVISED=1`, `autoApprove`는 읽기 도구 6개다. `kb-mcp`는 `internal` 이하만 읽고 올리는 옵션, 환경 변수, 도구 인자가 없다. `kb_put`, `kb_request`는 호출마다 확인, `-p`에서 거부다. 쓰기 도구는 확인을 받는 편이 맞으므로 이대로 둔다. `-p` 세션은 절대 경로 `kb request`를 쓴다. 도구 이름 `kb_kb_search`, `alwaysLoad` 제거도 15.4 B에 적었다. tower 동작은 sagae-tools 측 바이너리 읽기이고 KB가 재현하지 않았다 |

## 남은 요청

| 번호 | 처리 | 계약 절 | 이유 |
|---|---|---|---|
| 요청 1 | 수용 | 2.3, 4장 표 | 경로별 허용 목록 밖은 400 `bad_param`이고 `param`에 이름을 준다. 봉투 `as_of`가 시간 축만 덮으므로 오타를 무시하지 않는다 |
| 요청 2 | 수용 | 4.11, 7장 | `/raw`에 `Content-Disposition: attachment`와 `X-Content-Type-Options: nosniff`를 항상 붙이고 원 `Content-Type`을 유지한다 |
| 요청 3 | 수용 | 2.5 | `/v1/nodes/{id}`, `/body`, `/v1/search`, `/text`, `/raw`가 `no-store`다. 나머지 데이터 경로는 `no-cache`로 재검증한다 |
| 요청 4 | 수용 | 3장, 4장 표, 9장 | 변형 맨 위 `const`, 경로별 `examples`, 외부 `$ref` 없는 한 파일, WP-04, WP-05, WP-10 전의 초안(WP-23). `mapping`은 ajv 8.20.0이 거부해 `const`로 고른다(KB 재현). `operationId`는 loupe 표본 스펙과 같다 |
| 요청 5 | 변경 | ADR 15.2 | 카드 칸을 늘리지 않고 표시 기호 `internal`을 더했다. `public`은 표시가 없고 그 위는 MCP로 나가지 않는다 |
| 요청 6 | 수용 | 4.4 | `GET /v1/nodes?ids=a,b`. 최대 100개, 요청 순서, 숨긴 ID와 없는 ID는 오류 없이 빠진다 |

## 닫은 것과 수용한 것

| 번호 | 처리 | 계약 절 | 이유 |
|---|---|---|---|
| 닫음 1 오프셋 단위 | 수용 | 2.11 | 바꾸지 않는다 |
| 닫음 2 `/v1/counts` | 수용 | 4.9 | loupe v1은 부르지 않는다. 경로는 26개 안에 남고 앞당기지 않는다 |
| 닫음 3 export 전송 | 수용 | 5장 | `application/zstd`를 유지한다. 두 표기 통과는 sagae-tools 측 값(N=1)이다 |
| 닫음 4 정정 판정 | 수용 | 4.7 | 같은 체인에서 `value`가 다르고 `valid` 구간이 겹치고 `recorded_at`이 더 늦은 항목이 소급 정정이다. 응답에 판정 필드는 없다 |
| 닫음 5 `build_id` 신선도 | 수용 | 2.1, 2.6 | 신선도는 `applied_seq`, `epoch`으로 본다. `build_id`는 재생 입력의 함수다 |
| 닫음 6 필수 필터, 시간 제외 경로 | 수용 | 2.9, 4.3 | 그대로 둔다. 개요 커서는 남고 loupe가 쓰지 않는다 |
| 닫음 7 `kb api`, Orval | 수용 | 1장, 9장 | loupe는 `kb api`를 쓰지 않는다. 9장의 openapi-typescript를 Orval로 바꿨다. KB의 WP-23, WP-11도 같은 설정으로 생성 시험을 돈다 |

## 측정값의 쓰임

회신 5번의 근거는 sagae-tools 측 값(합성 그래프, RTX 4080 SUPER, DPR 1.5)이다. KB는 재현하지 않았고 기본 타입과 계약 11장의 사유로만 썼다.

| 값 | 쓰임 |
|---|---|
| 1만/5.1만은 렌더 예산 안 | `limit=10000&edge_limit=50000`을 `overview_types` 조정 기준으로 삼았다 |
| 2만/8만, 5만/20만은 예산 밖 | 기본 타입을 좁힌 이유다. 렌더 값은 GPU 경합이 의심돼 부풀었을 수 있으므로 재측정 값을 알려 달라 |
| 5만/20만 컬럼 JSON 19 MB, zstd 5.6 MB, 파싱 75 ms 이하 | 쓰지 않았다. 기본 상한을 바꾸지 않았다 |

## sagae-tools 확인 요청

| 항목 | 내용 |
|---|---|
| 0.3.0 파괴 변경 | 계약 머리의 **파괴.** 7건을 확인해 달라. `domain` 배열, 개요 기본 타입, 모르는 파라미터 거부, `SearchHit` `oneOf`, 응답 `status`, `core`의 `unverified`, `Envelope` 구조다 |
| 표본 스펙의 추정 | `x-guess`와 다른 곳은 하나다. `getNodeBody`는 `as_of_*`를 받는다. 추가는 `listChanges`의 `origin`, `getNodeNeighbors`의 `edge_limit`, `getNode`의 `backlink_limit`, `listNodes`의 `ids`다 |
| Orval 고정판 | `loupe.md`는 8.46.0이고 `tools-wip/loupe/package.json`은 8.44.0이다. npm 최신은 8.46.0이다(2026-10-31 확인). KB는 8.46.0으로 시험한다. 계약 초안에서 두 판 모두 생성과 `tsc`를 통과했다(KB 재현, 스크래치 조립본) |
| 트리거 T1 | WP-23이 `docs/contracts/openapi.yaml`을 내면 `contract:guard`가 실패한다. 설계대로다 |
