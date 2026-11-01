# KB 데이터 인터페이스 계약 v0

- 상태: 0.3.1. sagae-tools 3차 회신(`docs/contracts/consumers/sagae-tools-reply-3.md`)을 항목별로 처리했고(`sagae-tools-reply-3-response.md`) 13장이 합의 상태다. 0.3.1은 호환 변경만 담는다. 남은 `[잠정]`은 v1 소비자가 쓰지 않는 구간이다(1장의 TCP와 Proxmox 주소, 4.13의 `/v1/ops/*`).
- 날짜: 2026-10-31
- 기준: `docs/adr/0001-architecture.md`, `docs/contracts/consumers/sagae-tools.md`(잠정본), `docs/contracts/consumers/sagae-tools-reply-2.md`(2차 회신). 항목별 처리는 `docs/contracts/consumers/sagae-tools-reply-2-response.md`(이하 응답표)다.
- 계약 형식: OpenAPI 3.1.1 + JSON Schema 2020-12. 기계 판독 원본은 `docs/contracts/openapi.yaml`이다. WP-23이 WP-04, WP-05, WP-10 전에 이 문서에서 만든다. 그 뒤로 두 문서가 어긋나면 `openapi.yaml`이 이긴다.
- 성격: 저장소는 데이터 인터페이스만 제공한다. 가시화는 이 계약 밖이다. 점수와 추천을 내지 않는다.

## 변경 내역

0.x 안의 변경이고 전부 sagae-tools 세션에 알린다(8장). **파괴.** 표시가 파괴 변경이다. 결함 칸의 `13장 답`, `공백`, `요청`, `닫음`은 2차 응답표, `보완`, `확인`은 3차 응답표의 번호다.

| 버전 | 날짜 | 변경 | 결함 |
|---|---|---|---|
| 0.3.1 | 2026-11-01 | `domain` 필터를 any-of로 확정했다. 도메인 없는 노드는 `[]`이고 `domain=none`과 패싯 `none`이 이를 고른다 | 보완 1 |
| 0.3.1 | 2026-11-01 | `/v1/overview`, `/v1/nodes/{id}/neighbors`에 엣지 전용 `edge_status`를 더했다(복수 값). `status`는 단일 값 그대로다 | 확인 c |
| 0.3.1 | 2026-11-01 | `Claim`과 `ChainItem`에 `own_status`, `status_basis`를 더했다. `ChainItem.status`, `ClaimDetail.versions[].status`는 `eff_status`다 | 보완 5 |
| 0.3.1 | 2026-11-01 | `NodeType.in_overview`를 더했다. `overview_types` 갱신 절차를 정했다 | 보완 2 |
| 0.3.1 | 2026-11-01 | 4.7 정정 판정의 비교 대상을 뒤 항목의 `recorded_at`에 살아 있던 행으로 한정했다. 응답 필드는 그대로다 | 확인 a |
| 0.3.1 | 2026-11-01 | 경로별 기본 `types` 표를 2.7에 더했다 | 확인 d |
| 0.3.1 | 2026-11-01 | 문서 정정: `core`의 미검증 엣지 제외는 `needs_review`와 `unverified` 둘 다이고 개요, 이웃, `/edges`와 같다. 5장 표 `Series`는 `fact` 그룹의 타입이다. passage `id`는 노드 조회에 쓰지 않는다 | 보완 6, 보완 4, 확인 e |
| 0.3.0 | 2026-10-31 | **파괴.** `domain`을 문자열에서 배열로 바꿨다. 필터는 포함 일치이고 패싯은 값마다 세고 export `domain` 열도 배열이다 | RC-03 |
| 0.3.0 | 2026-10-31 | **파괴.** `/v1/overview`의 기본 `types`를 `/v1/schema`의 `overview_types`로 좁혔다. `Repo Package Person Channel Video Keyword Metric`이 기본에서 빠진다. 이웃 기본값은 그대로다 | 13장 답 5 |
| 0.3.0 | 2026-10-31 | **파괴.** 허용 목록 밖의 쿼리 파라미터는 400 `bad_param`이다 | 요청 1 |
| 0.3.0 | 2026-10-31 | **파괴.** `SearchHit`을 `kind` `const`의 `oneOf`로 바꿨다. `kind`는 닫힌 enum이고 `claim`에 `subject`가 필수이고 `passage`의 `id`는 노드 ID가 아니다 | 공백 7, 요청 4 |
| 0.3.0 | 2026-10-31 | **파괴.** 응답 `status`는 `eff_status`다. `status`, `include_unverified`, `as_of_*`는 상세의 내장 `claims`, `edges`, `backlinks`에도 적용된다 | 공백 12 |
| 0.3.0 | 2026-10-31 | **파괴.** `core`는 `unverified` 주장의 사실 투영 엣지도 뺀다 | 공백 10 |
| 0.3.0 | 2026-10-31 | **파괴.** `Envelope`에서 `data` 선언을 빼고 경로별 `<이름>Envelope`으로 옮겼다. `Page.total`이 필수가 됐다. `data_as_of`는 빈 원장에서 `null`이다 | 요청 4 |
| 0.3.0 | 2026-10-31 | 확정: 동시 상한 기본 16, 하한 12, 429의 `Retry-After` 필수. `node_total`, `edge_total`, `/v1/facets`의 `total`은 항상 정수다. `/v1/schema`에 `overview_types`와 닫힌 enum 전체를 낸다. 소켓 범위는 `internal` 이하다(결정 14 기본값 (c)) | 13장 답 3~5, 공백 12, 13 |
| 0.3.0 | 2026-10-31 | 추가: `/v1/claims/{id}`, `/v1/edges/{id}` 절(4.14), `/v1/nodes/{id}`의 ID 종류별 응답, `/v1/nodes?ids=`, `/claims`의 `predicate`, `/v1/changes`의 `origin`, 개요·이웃·export 엣지 열 `status`, 이웃 `edge_limit`, `EdgeRef.peer`, `backlink_limit`, `Problem.param`, `source.trust=unknown`, 문서 ID `d-`, 근거 ID `ev-` | 공백 2~5, 11, 12, 요청 6, RC-04 |
| 0.3.0 | 2026-10-31 | 캐시: 2.5를 경로 구분 표로 다시 썼다. `Cache-Control`을 넣고 본문 경로는 `no-store`다. manifest에 `ETag`를 줬다. `/raw`에 `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`를 넣었다 | 공백 9, 요청 2, 3, RC-12 |
| 0.3.0 | 2026-10-31 | 문법과 의미: `filter`, `sort` 세부, 경로별 파라미터 표, 정정 판정 규칙, `g-`와 `p-`의 관계, `/v1/changes` 커서의 필터 해시 예외, `build_id` 정의, 같은 `seq` 피드 행을 적었다. `HEAD`를 허용한다 | 공백 4, 8, 10, 닫음 4, RC-11, RC-13 |
| 0.3.0 | 2026-10-31 | 소비자 타입 생성 도구를 Orval 8.46.0으로 바꿨다. 콜드 지연 행과 부하 규모를 넣었다 | 닫음 7, 공백 15 |
| 0.2.0 | 2026-10-31 | **파괴.** 엔티티 ID를 `e:<type>/<slug>`에서 `e:<type>:<slug>`로 바꿨다. 공개 ID에 `/`, `?`, `#`, 공백이 없다 | CTR-01 |
| 0.2.0 | 2026-10-31 | **파괴.** 기본 읽기는 관측축만 현재이고 유효축은 `as_of_valid`를 줄 때만 건다. `as_of_valid`가 `YYYY-MM-DD`를 받는다. 미래 발효 대체는 효력일까지 두 주장이 `active`다 | CTR-05, CTR-27 |
| 0.2.0 | 2026-10-31 | **파괴.** 데이터 경로 `ETag`를 `"<epoch>-<applied_seq>-<build_id>"`로 통일했다. 불변 `ETag`는 `/text`, `/raw`만이다 | CTR-08 |
| 0.2.0 | 2026-10-31 | **파괴.** `/v1/changes` 커서에 `epoch`이 들어가고 꼬리에서도 문자열이다. `/v1/meta`, manifest에 `changes_cursor`를 넣었다. 생략은 seq 0부터다 | CTR-09 |
| 0.2.0 | 2026-10-31 | **파괴.** export는 `Content-Type: application/zstd`이고 `Content-Encoding`이 없다. 프로필을 `group`으로 다시 정의하고 `merged_into`, 포함 규칙, 미게시 503을 넣었다 | CTR-12 |
| 0.2.0 | 2026-10-31 | **파괴.** `/history` 응답을 `versions`, `chains`로 바꾸고 `predicate`를 넣었다 | CTR-15 |
| 0.2.0 | 2026-10-31 | **파괴.** `kb_put`에서 `record.source_url`, `record.quote`를 뺐다. 외부 사실은 `kb_request`의 `url`로 보낸다. 응답에 `warnings`, `reason`을 넣었다 | BLK-18, CTR-23 |
| 0.2.0 | 2026-10-31 | **파괴.** 개요 기본 상한을 5만 노드·20만 엣지로 올리고 커서를 넣었다. `meta.limits`가 바뀐다 | CTR-11 |
| 0.2.0 | 2026-10-31 | **파괴.** 기본 필터: 주어가 `superseded`인 `state`, `howto`도 빠진다. 민감도는 최신 버전 기준이다. 피드에 `visibility.revoked`가 나온다 | RULE-06, CTR-06 |
| 0.2.0 | 2026-10-31 | **파괴.** 페이지네이션 보장을 `sort=id`로 좁혔다. 검색 커서는 순위 위치이고 소비자가 `id`로 중복을 제거한다. `/v1/nodes` 기본 정렬은 `id`다 | CTR-10 |
| 0.2.0 | 2026-10-31 | 추가: `/v1/nodes/{id}/claims`, `/edges`, `/body`, `merged_into_final`, `link_status`, `evidence_state`, `support_check`, `source`, `author` 필터, `EdgeRef`, `Backlink`, 경로별 `data` 표, 패싯 자기 축 규칙, 검색 `kind`별 필드 | CTR-04, CTR-14, CTR-16, CTR-17, CTR-23, CTR-28 |
| 0.2.0 | 2026-10-31 | 오류 표에 401 `token_invalid`, 405, 410 `content_removed`, 416, 500과 미게시 503을 넣었다. 커서가 머리보다 앞서면 410이다 | CTR-25, BLK-08 |
| 0.2.0 | 2026-10-31 | 엣지 민감도를 양끝과 주장의 최댓값으로 정하고 개수에 숨김을 적용했다. enum 규칙과 값 목록을 맞췄다. 상위 N 후처리를 필터 없는 검색으로 한정하고 `total` 뜻을 확정했다 | CTR-26, CTR-22, BLK-07 |
| 0.2.0 | 2026-10-31 | TCP는 원격 이전 때 켜는 선택 유닛이다. HTTP 소비자는 `loupe serve`, tower는 MCP stdio다. Host 검사는 자체 미들웨어이고 허용 목록은 설정값이다 | CTR-24, CTR-02 |

## 1. 경계

| 항목 | 값 |
|---|---|
| 1순위 경로 | HTTP JSON `/v1` |
| 보조 경로 | 스냅샷 export(5장) |
| 대체 경로 | `kb api <path>?<query>` CLI. HTTP와 같은 JSON을 stdout으로 낸다. 오류는 RFC 9457 본문 + exit 1. loupe는 쓰지 않는다 |
| 쓰기 | 도구는 읽기 전용이다. 쓰기 경로는 6장. HTTP 쓰기는 v1에 없다 |
| MCP | 에이전트용이다. UI 경로로 쓰지 않는다. HTTP와 조회 코어를 공유한다 |
| 파일 직접 접근 | 제공하지 않는다. SQLite 사본을 게시하지 않는다 |

**주소.**

| 전송 | 주소 | 인증 |
|---|---|---|
| Unix 소켓(기본) | `/home/user/sagae-kb-data/run/read.sock`, 0600 | 소켓 파일 권한. 토큰 없음. 범위는 `internal` 이하(2.8) |
| 루프백 TCP(원격 이전 때 켜는 선택 유닛) `[잠정]` | `http://127.0.0.1:8737` | Bearer 필수 |
| Proxmox 이전 시 `[잠정]` | `https://<호스트>:<포트>` | Bearer 필수 |

도구는 기준 URL 설정만 바꾼다. `/v1` 아래 경로와 본문은 전송과 무관하게 같다. 기동은 systemd 소켓 활성화이고 유휴 600초 뒤 프로세스가 내려간다. 첫 요청은 콜드 p50 150 ms, 웜 p50 2.3 ms다(KB `general-db.md` M9, 프로토타입). 유닛 설치는 사용자 승인 뒤이고 그 전에는 CLI나 수동 `kb serve`를 쓴다.

**소비자.** HTTP 소비자는 `loupe serve`(Node 26, 같은 사용자)이고 Unix 소켓을 쓴다. 관제 서버 tower는 KB HTTP를 쓰지 않고 KB MCP를 stdio 자식으로 띄운다. TCP 8737은 v1에서 쓰지 않는다.

**런타임 조합.** 뷰어 백엔드는 Node 26이다. KB는 Python 3.14이고 프로세스 안 라이브러리를 내지 않는다. 호출은 HTTP나 CLI다. 소켓 호출 예시다.

```ts
import http from "node:http";
http.get({ socketPath: "/home/user/sagae-kb-data/run/read.sock", path: "/v1/meta" }, (res) => { /* ... */ });
```

## 2. 공통 규칙

### 2.1 봉투

모든 성공 응답은 이 봉투다. 예외는 `/v1/export/graph` 파일과 `/v1/snapshots/{id}/raw`다.

```json
{
  "schema_version": "0.3.1",
  "epoch": 1,
  "build_id": "g-000183422-a1b2",
  "data_as_of": "2026-10-31T09:12:03Z",
  "applied_seq": 183422,
  "as_of": {"valid": null, "observed": null},
  "degraded": [],
  "data": {},
  "page": {"next_cursor": null, "total": 1234, "truncated": false}
}
```

| 필드 | 뜻 |
|---|---|
| `schema_version` | 계약 버전(SemVer). 8장. KB 내부 저장 스키마 버전과 다르다 |
| `epoch` | 원장 세대. 복원할 때마다 오른다. 값이 바뀌면 소비자는 재동기화한다 |
| `build_id` | 그래프 빌드 ID `g-<마지막 seq 9자리>-<해시 4자리>`. 재구축이 끝날 때 정해지고 같은 재생 입력이면 같은 값이다. 증분 투영은 바꾸지 않는다. 신선도는 `applied_seq`로 보고 이 값에 기대지 않는다 |
| `data_as_of` | `applied_seq` 이벤트의 시각. 빈 원장이면 `null` |
| `applied_seq` | 이 응답이 반영한 원장 번호. 재구축을 넘어 유지되고 줄지 않는다 |
| `as_of` | 요청의 시점 지정을 RFC 3339로 정규화한 값. `valid: null`은 유효축 미적용, `observed: null`은 관측축 현재다(2.9). 시간 축만 덮고 다른 파라미터는 돌려주지 않는다 |
| `degraded` | 저하 표시 문자열 배열. `lexical_only`, `vector_offline`, `stale_build`, `boot_path_unverified` 등. 알 수 없는 값을 무시한다 |
| `page` | 4장 표에서 `page`가 있는 경로에만 있다 |

요청당 읽기 트랜잭션 1개로 봉투와 본문이 같은 시점이다.

### 2.2 시각과 문자열

- 시각은 RFC 3339 UTC, `Z` 접미다. 밀리초는 있으면 3자리다.
- 유효 시점은 정밀도를 함께 준다. `{"from":"2026-07-01","to":null,"precision":"quarter","label":"2026-Q3"}`. `precision`은 `instant`, `day`, `month`, `quarter`, `year`다. `from`은 그 기간의 첫날이고 `to: null`은 끝이 정해지지 않은 열린 구간이다.
- 본문은 NFC로 고정한다. UTF-8이다.

### 2.3 오류

RFC 9457 `application/problem+json`이다. 404, 405, 500을 포함해 오류 응답은 전부 이 형식이다. `code`는 기계 판독용 안정 값이다. `bad_param`이면 `param`에 파라미터 이름을 준다.

```json
{"type":"https://kb.local/problems/cursor-mismatch","title":"cursor does not match filters","status":400,"detail":"cursor는 다른 필터로 만들어졌다","code":"cursor_mismatch","instance":"/v1/nodes"}
```

| status | code | 뜻 |
|---|---|---|
| 400 | `bad_param`, `limit_too_large`, `cursor_mismatch`, `as_of_unsupported` | 파라미터 오류. 경로별 허용 목록(4장 표) 밖의 쿼리 파라미터, 형식이 틀린 값, 정규화 뒤 토큰이 하나도 없는 `q`는 `bad_param`이다. 봉투 `as_of`가 시간 축만 덮으므로 오타를 무시하지 않는다. `limit` 상한 초과는 잘라 쓰지 않고 `limit_too_large`다 |
| 401 | `token_required`, `token_invalid` | TCP에서 토큰 없음, 토큰이 맞지 않음 |
| 403 | `host_rejected` | Host 헤더 불일치 |
| 404 | `not_found` | 없음. 민감도로 숨긴 레코드와 형식이 틀린 ID도 같은 응답이다 |
| 405 | `method_not_allowed` | `GET`, `HEAD` 외 메서드 |
| 410 | `epoch_changed`, `content_removed` | 커서의 `epoch`이 현재와 다르거나 커서가 현재 `applied_seq`보다 앞선다. export로 재동기화한다. `content_removed`는 `record.redact`나 `ttl30`으로 본문이 지워졌다는 뜻이고 메타데이터는 계속 읽힌다 |
| 416 | `range_not_satisfiable` | `/raw`의 `Range`가 범위 밖이다 |
| 429 | `too_many_requests` | 동시 처리 요청이 상한을 넘었다. 상한은 설정 `read.max_concurrent`이고 기본 16, 하한 12다. 값은 `/v1/meta`의 `limits.concurrent`다. `Retry-After`(초)를 항상 준다 |
| 500 | `internal` | 처리 중 예외 |
| 503 | `read_timeout`, `not_ready` | 읽기 시간 상한 초과, 시작 중, export 첫 게시 전. `Retry-After`를 준다 |

`record.tombstone`으로 지운 레코드는 `status=dead`이고 id 직접 조회는 200으로 응답한다.

### 2.4 페이지네이션

- 커서 방식만 쓴다. 불투명 base64url이고 정렬 키 또는 순위 위치, 필터 해시, `epoch`을 담는다. 소비자가 만들거나 해석하지 않는다. `/v1/changes`의 커서는 필터 해시가 없다(4.12).
- `sort=id`만 안정이다. `id`는 불변이라 페이지 사이 변경에도 중복과 누락이 없다(KB `general-db.md` M20은 이 경우다).
- 가변 키(`label`, `recorded_at` 등) 정렬은 페이지 사이 변경에서 중복과 누락이 날 수 있다.
- 검색 커서는 순위 위치다. 페이지 사이 변경으로 순위가 움직이므로 같은 `id`가 두 페이지에 나올 수 있다. 소비자가 `id`로 중복을 제거한다.
- 다른 필터로 쓴 커서와 해석할 수 없는 커서는 400 `cursor_mismatch`다.
- `page.total`은 필터 적용 전체 개수다. `null`은 세지 않았다는 뜻이고 두 곳에만 나온다. `/v1/search`는 기본 필터만 있고 as-of가 없으면 `null`이고 다른 필터나 as-of가 있으면 정확한 개수다. `/v1/changes`는 항상 `null`이다. `node_total`, `edge_total`(4.3, 4.6)과 `/v1/facets`의 `total`(4.9)은 `null`이 없다.
- `truncated=true`는 이 응답이 전체가 아니라는 뜻이다. `next_cursor`가 있으면 이어 받는다. `next_cursor`가 `null`이면 후보 상한에 닿은 것이고 필터로 좁힌다.

### 2.5 조건부 GET과 캐시

| 구분 | 경로 | `ETag` | `Cache-Control` |
|---|---|---|---|
| 데이터 | `/v1/schema`, `/v1/overview`, `/v1/nodes`, `/v1/nodes/{id}/claims`, `/edges`, `/neighbors`, `/history`, `/v1/claims/{id}`, `/v1/edges/{id}`, `/v1/facets`, `/v1/counts`, `/v1/series/{id}`, `/v1/snapshots/{id}`, `/v1/changes` | `"<epoch>-<applied_seq>-<build_id>"` | `no-cache` |
| 본문 조각 | `/v1/nodes/{id}`, `/v1/nodes/{id}/body`, `/v1/search` | 데이터와 같다 | `no-store` |
| 메타 | `/v1/meta` | `"<epoch>-<applied_seq>-<build_id>-<degraded 해시>"` | `no-cache` |
| 불변 본문 | `/v1/snapshots/{id}/text`, `/raw` | `"<snapshot id>"` | `no-store` |
| 게시 파일 | `/v1/export/graph/manifest` | `"<게시 ID>"`(5장의 `p-`) | `no-cache` |
| 게시 파일 | `/v1/export/graph` | manifest의 `sha256` | `no-cache` |
| 운영 | `/v1/ops/*` | 없음 | `no-store` |

`If-None-Match`가 맞으면 304다. 변경 피드 폴링은 304가 가장 싸다. `no-store`는 민감도 라벨이 붙는 본문이 디스크 캐시에 남지 않게 한다. `ETag`는 메모리에 사본을 쥔 호출자의 재검증에 그대로 쓴다.

- 스키마와 스냅샷 메타데이터는 데이터 경로다. `citing_claims`가 늘면 `applied_seq`가 함께 올라 304가 나지 않는다.
- 불변은 `/text`, `/raw`뿐이다. 삭제 여부를 먼저 보고 본문이 삭제됐으면 `If-None-Match`가 맞아도 410 `content_removed`다.
- 봉투의 `data`는 `applied_seq`와 `build_id`만의 함수이고 시계를 읽지 않는다(2.9). `degraded`는 운영 값이라 바뀌어도 데이터 경로는 304일 수 있다. 저하 상태는 `/v1/meta`로 본다.
- 토큰 범위에 따라 응답이 다르므로 `Vary: Authorization`을 준다.

### 2.6 재구축과 게시 중 읽기

재구축은 소비자에게 보이지 않는다. 열린 요청은 옛 빌드를 끝까지 읽고 새 요청은 새 빌드를 읽는다. 논리 상태는 `applied_seq`로 같다. 교체 중 오류와 역행이 없다. KB 프로토타입에서 쓰기 중 교체 3회, 읽기 2,087회 불일치 0, 오류 0이었다(ADR F3). 재구축을 알 필요가 없다.

### 2.7 기본 필터

읽기 기본값에서 다음이 빠진다.

| 항목 | 기본 | 바꾸는 법 |
|---|---|---|
| `status` | `active`만. 주어의 `status`가 `dead` 또는 `superseded`인 `state`, `howto` 주장은 그 값으로 계산한다. 주어가 병합으로 `superseded`가 된 경우는 제외한다. `event` 주장은 영향이 없다 | `status=superseded`, `status=dead`, `status=all` |
| 주장 검증 | `quote_found`, `parser_derived`, `first_party` | `include_unverified=true`는 `needs_review`, `unverified`를 더한다. id 직접 조회는 항상 응답하고 `verification`을 준다 |
| 민감도 | `internal` 이하. 그 ID의 최신 버전 민감도로 판단한다. as-of와 이력도 같다 | Bearer 토큰 범위로만. 쿼리 파라미터로 올릴 수 없다 |
| 병합 노드 | 목록에서 제외. 상세, 이웃, 개요는 `merged_into_final` 대상 아래에 병합된 ID의 주장과 엣지를 함께 낸다 | id 직접 조회는 항상 응답하고 `merged_into`, `merged_into_final`을 준다 |
| `superseded`, `dead`의 직접 조회 | 항상 응답 | id를 아는 딥링크가 깨지지 않게 한다 |
| 민감도 초과 직접 조회 | 404 | 존재를 드러내지 않는다 |

`meta.counts`, `schema.count`, `/v1/facets`, `/v1/counts`, `page.total`도 같은 필터를 지난다. 엣지 민감도는 양끝 노드와 근거 주장 민감도의 최댓값이고 숨긴 노드의 ID는 `edges.in`에 나오지 않는다.

**응답 `status`.** 응답의 `status`는 버전 행의 `eff_status`다. 주어 판정으로 바뀐 주장은 바뀐 값으로 나오고 `status` 필터도 같은 값을 본다.

**자기 상태와 주어 유래 상태.** `Claim`은 `own_status`(버전 행에 저장된 자기 상태)와 `status_basis`(`own` 또는 `subject`. 열린 값)를 함께 준다. `status_basis=subject`면 `status`는 주어 판정이 바꾼 값이다. 주어가 병합이 아닌 이유로 `superseded`가 된 `state`, `howto` 주장은 `status=superseded`, `own_status=active`, `status_basis=subject`다. 소비자가 주장 자체의 철회나 대체를 표시하려면 `status_basis=own`일 때의 `status`를 쓴다. `/v1/nodes/{id}/history`의 `ChainItem.status`와 `ClaimDetail.versions[].status`는 `eff_status`이고 같은 두 필드가 따른다. 주어 판정은 현재 시각 기준이며 `as_of_*`로 달라지지 않는다. `history.versions[]`(`VersionRow`)와 엔티티, 엣지, 사용자 기록의 `status`는 저장된 자기 상태다.

**`status`와 `edge_status`.** `status`는 단일 값이다. 복수 값은 두지 않는다. 대체 엣지는 `/v1/overview`와 `/v1/nodes/{id}/neighbors`의 `edge_status`로 본다. 쉼표로 `active`, `superseded`, `dead`, `all` 여럿을 받고 생략하면 `status`와 같다. 엣지에만 걸리므로 노드 집합과 `node_total`은 `status`만 따른다. `edge_total`은 `edge_status` 적용 뒤 개수이고 닫힌 부분 그래프 규칙은 그대로다. 허용 밖 값은 400 `bad_param`이다.

**도메인.** `domain`은 응답에서 항상 배열이다. 도메인이 없는 노드는 `[]`이고 `null`도 생략도 아니다. 필터 `domain=G,K`는 any-of다. 노드의 `domain`이 나열한 값 중 하나라도 담으면 맞는다. all-of 필터는 없다. `domain=none`은 `[]`인 노드와 맞고 `domain=G,none`처럼 섞는다. 패싯 `domain` 축은 `[]`인 노드를 `value: "none"`으로 센다. export `domain` 셀도 `[]`다.

**검증 전 엣지.** 사실 투영 엣지는 근거 주장의 검증이 기본 허용값(`quote_found`, `parser_derived`, `first_party`)일 때만 나온다. `needs_review`와 `unverified`는 둘 다 빠진다. 개요, 이웃, `/edges`, 5장 `core`가 같다. `include_unverified=true`는 `core`에 적용되지 않는다. 0.3.0 변경 내역의 `unverified`는 이 두 값을 뜻했다.

**기본 `types`.** `types`(`/v1/nodes`는 `type`도)를 생략했을 때다. 명시하면 기본을 대체한다. `Claim`, `Snapshot`, `Source`, `Document`, `Ticket`도 명시하면 나온다.

| 경로 | 생략 시 |
|---|---|
| `/v1/overview` | `/v1/schema`의 `overview_types` |
| `/v1/nodes`, `/v1/nodes/{id}/neighbors` | `Claim`, `Snapshot`, `Source`, `Document`, `Ticket`을 뺀 전부. `ids` 일괄 읽기는 `types`를 보지 않는다 |
| `/v1/facets` | `q`가 없으면 `/v1/nodes`와 같다. `q`가 있으면 `kinds`가 정하는 검색 후보 전부 |
| `/v1/search` | 제한 없음. `kinds`(기본 `claim,record,entity,passage`)가 종류를 정한다 |
| `/v1/counts` | 제한 없음. `Claim`을 포함한 전부 |

**내장 묶음.** `/v1/nodes/{id}`의 `status`, `include_unverified`, `as_of_*`는 내장 `claims`, `edges`, `backlinks`에 적용된다. 대상 노드 자체는 위 직접 조회 규칙을 따른다.

### 2.8 민감도

`sensitivity`는 닫힌 enum이다.

| 값 | 기본 읽기(소켓, `kb api`, MCP) | `viewer` 토큰 | `owner` 토큰 |
|---|---|---:|---:|
| `public` | 포함 | 포함 | 포함 |
| `internal` | 포함 | 포함 | 포함 |
| `private` | 제외 | 제외 | 포함 |
| `secret` | 제외 | 제외 | 제외. HTTP로 나가지 않는다 |

`owner` 토큰은 TCP에서만 쓰고 v1 소비자는 소켓을 쓴다. `private` 읽기 경로는 ADR 결정 14이고 기본값 (c)는 v1 뷰어가 `private`를 보지 않는 것이다. 결정 전까지 소켓은 `internal` 이하로 고정한다. `kb api`, `kb-mcp`의 범위도 같다(ADR 7.9). (b) 소켓을 `owner`로 취급하면 `loupe serve`가 소켓을 무인증 4812로 다시 내므로 `private`가 샌다. (c)를 바꾸려면 KB가 먼저 sagae-tools에 알린다.

### 2.9 시점 지정

`as_of_valid`, `as_of_observed`는 공통 파라미터다. **기본 읽기는 관측축만 현재이고 유효축은 걸지 않는다.** `as_of_valid`를 줄 때만 유효축을 적용한다. 두 축에 현재를 쓰면 닫힌 구간의 `event`, `dead` 노드, 미래 발효 값이 사라지고 같은 `applied_seq`에서 시계만으로 결과가 바뀐다. 값은 RFC 3339이고 `as_of_valid`는 `YYYY-MM-DD`(그날 00:00Z)도 받는다.

**미래 발효 대체.** `valid.from`이 미래인 값이 옛 값을 대체하면 옛 주장은 `valid.to`가 닫힌 새 버전으로 남는다. 효력일 전에는 두 주장 모두 `active`이고 `as_of_valid`를 주면 그 시점의 값 하나가 나온다. 효력일이 지나면 옛 주장이 `superseded`가 된다.

| 대상 | `as_of_observed` | `as_of_valid` |
|---|---|---|
| 노드, 엣지, 주장 | `[recorded_at, expired_at)`가 덮는 버전. `status`도 그 시점의 값이다. 주어 판정 전의 시점은 판정 전 상태를 돌려준다 | `[valid_from, valid_to)`가 덮는 버전. `null`은 무한 |
| 검색, 패싯, 개수, 개요, 이웃, 표 | 위와 같은 술어 | 위와 같은 술어 |
| 문서 전문 검색 | 그때 문서에 있던 문단 | 문서 문단에는 세계 시간이 없어 관측 구간과 같다 |
| 시계열 | 그때까지 알려진 값 | 해당 기간의 점 |

**적용하지 않는 곳과 이유.**

| 경로 | 이유 | 동작 |
|---|---|---|
| `/v1/changes` | 그 자체가 시간순 피드다 | `as_of_*`가 있으면 400 `as_of_unsupported` |
| `/v1/snapshots/{id}`, `/text`, `/raw` | 원본이 불변이다 | 무시하지 않고 400 |
| `/v1/meta`, `/v1/schema` | 현재 빌드의 사실이다. 타입 카탈로그의 과거 판 경로는 v1에 없다 | 400 |
| `/v1/nodes/{id}/history` | 전 버전을 이미 준다 | 400 |
| `/v1/export/*` | 게시 시점 파일이다. 소비자는 과거 시점 입력이 필요 없다고 답했다 | 400 |
| `/v1/ops/*` | 운영 현재값이다 | 400 |

KB 측정: 문단 7.6만에서 as-of 검색 p95 39.7 ms, 38.4만에서 195~213 ms(ADR F6), 44,310노드·180,045엣지 as-of 개요 p50 145.5 ms(Plat P4, HTTP 직렬화 제외). 프로토타입 값이다.

### 2.10 불변 ID와 enum

- 엔티티, 관계, 주장, 스냅샷, 사용자 기록은 불변 ID를 갖는다. 재구축해도 같다.
- **공개 ID는 `/`, `?`, `#`, `,`, 공백, 제어 문자를 포함하지 않는다.** 패턴은 `^[A-Za-z0-9][A-Za-z0-9:._-]*$`다. 경로에 그대로 넣어도 되고 퍼센트 인코딩해도 같다. 값 하나를 한 세그먼트로 보낸다.
- 병합은 `merged_into`로 잇는다. 옛 ID는 계속 해석되고 `status=superseded`다. `merged_into_final`은 연쇄 병합의 끝이다. 주장 ID와 엣지 ID는 병합 뒤에도 바뀌지 않는다.

| 대상 | 형식 | `/v1/nodes/{id}`의 `type` | 상세에 더해지는 필드 |
|---|---|---|---|
| 엔티티 | `e:<type>:<slug>` | 세계 타입 | 없음 |
| 사용자 기록 | `f-...` | 사용자 타입 | 없음. `include=body`로 본문 |
| 주장 | `c-...` | `Claim` | `claim`: `ClaimDetail` |
| 스냅샷 | `n-...` | `Snapshot` | `snapshot`: `Snapshot` |
| 시계열 | `s:<slug>` | `Series` | `series`: `SeriesInfo`. 점은 `/v1/series/{id}` |
| 문서 | `d-...` | `Document` | 없음 |
| 소스 | `src:<slug>` | `Source` | 없음 |
| 티켓 | `t-...` | `Ticket` | 없음 |
| 엣지 | `r-...` | 노드가 아니라 404 | `/v1/edges/{id}`로 읽는다 |
| 근거 | `ev-...` | 노드가 아니라 404 | `Evidence.id`. 주장 ID, 스냅샷 ID, 선택자의 해시라 재구축과 재확인에도 같다 |

닫힌 enum은 아래가 전부이고 `/v1/schema`의 `enums`가 같은 값을 낸다. 값이 늘면 파괴 변경이다.

| `enums` 키 | 필드 | 값 |
|---|---|---|
| `origin` | `origin` | `external`, `first_party`. `/v1/changes`의 `origin`에는 `system`이 더 있다 |
| `sensitivity` | `sensitivity` | `public`, `internal`, `private`, `secret` |
| `status` | `status` | `active`, `superseded`, `dead` |
| `selector_kind` | `Evidence.selector_kind` | `text_quote`, `jsonpointer` |
| `claim_kind` | `Claim.kind` | `event`, `state`, `howto` |
| `hit_kind` | `SearchHit.kind` | `claim`, `record`, `entity`, `passage` |
| `stance` | `Claim.stance` | `stated`, `attributed` |
| `method` | `Claim.method` | `deterministic`, `llm`, `human` |
| `precision` | `ValidTime.precision` | `instant`, `day`, `month`, `quarter`, `year` |
| `evidence_state` | `Evidence.evidence_state` | `live`, `archived_only` |

나머지는 열린 문자열이다. `/v1/schema`로 구동하고 모르는 값을 오류로 다루지 않는다.

| 열린 필드 | 현재 값 |
|---|---|
| `type`, `rtype`, `value_kind`, `degraded` | `/v1/schema`, 2.1 |
| `verification` | `unverified`, `needs_review`, `quote_found`, `parser_derived`, `first_party` |
| `liveness` | `active`, `renamed`, `scheduled_removal`, `deprecated`, `partial`, `superseded`, `removed`, `stale_suspect`, `revived` |
| `link_status` | `gone`, `null` |
| `support_check` | `supported`, `unsupported`, `null` |
| `text_format` | `markdown`, `text`, `json`, `pdf_text` |
| `source.trust` | `primary`, `secondary`, `unknown` |
| `gaps.reason` | `machine_off`, `blocked`, `object_missing` |
| 노드 `group` | `world`, `evidence`, `fact`, `user`, `ops` |
| 엣지 `group` | `claim`, `source`, `change`, `structure`, `user`, `request`, `fact` |
| 피드 `kind` | ADR 7.1의 이벤트 종류와 `visibility.revoked` |

### 2.11 인용 위치

| 항목 | 값 |
|---|---|
| 기준 | 표시 본문(`/v1/snapshots/{id}/text`). 토큰화된 색인 텍스트가 아니다. 텍스트 근거는 항상 `selector_kind=text_quote`이고 파서 주장도 같다 |
| 단위 | 유니코드 코드포인트. `start` 포함, `end` 미포함 |
| 병기 | W3C TextQuoteSelector `exact`, `prefix`, `suffix` |
| 정형 소스 | `selector_kind=jsonpointer`, RFC 6901 경로. 기준 문서는 `text_format=json`인 표시 본문을 파싱한 값이다 |
| JS 변환 | 코드포인트 → UTF-16: `[...text].slice(0, cp).join("").length` |

### 2.12 그래프 표기

방향 멀티그래프다. 평행 엣지가 있다. 엣지는 항상 `id`를 갖는다. 개요와 이웃은 양끝이 응답에 포함된 엣지만 낸다(닫힌 부분 그래프). 개요를 커서로 이어 받으면 닫힘은 페이지 합집합 기준이다. 개요, 이웃, export의 끝점은 `merged_into_final`로 바꿔 낸다. 상세의 `edges`는 `EdgeRef`이고 이 규칙이 적용되지 않는다. `src`, `dst`는 저장값이고 `peer`가 반대쪽 노드의 최종 대상이다. 좌표를 내지 않는다. `meta.graph = {"directed": true, "multi": true}`.

## 3. 공통 객체

`components/schemas`의 초안이다. WP-23이 `openapi.yaml`로 그대로 옮긴다. `additionalProperties`는 `true`이고 소비자는 모르는 필드를 무시한다.

| 규칙 | 내용 |
|---|---|
| 경로별 응답 | 4장 표의 `data`, `page` 열이다. 봉투가 있는 `200`은 `<이름>Envelope`이고 `allOf: [Envelope, {required: [data], properties: {data: <이름>}}]`이다. `page` 경로는 `page`도 `required`이고 같은 `allOf` 항목에 넣는다 |
| `Envelope` | `data`를 선언하지 않는다. 선언하면 생성 타입에 `data: unknown`이 남는다 |
| `oneOf` | 변형마다 맨 위 `properties`에 판별 필드의 `const`를 두고 맨 위 `required`에 넣는다. `allOf` 안에 두면 ajv `discriminator`가 컴파일을 거부한다. `discriminator.mapping`은 ajv 8.20.0이 거부하므로 쓰지 않는다. Orval 8.46.0은 이 형식에서 `switch (hit.kind)`가 좁혀지고 나머지가 `never`다(KB 재현) |
| 번들 | `openapi.yaml`은 한 파일이고 외부 `$ref`가 없다 |
| `examples` | 경로의 `id` 파라미터와 `200` 응답마다 둔다. 값은 이 문서의 예시이고 같은 ID가 fixture에 있다 |

```yaml
# 공통 값
Origin: {type: string, enum: [external, first_party]}
Status: {type: string, enum: [active, superseded, dead]}
Sensitivity: {type: string, enum: [public, internal, private, secret]}
SelectorKind: {type: string, enum: [text_quote, jsonpointer]}
EvidenceState: {type: string, enum: [live, archived_only]}
Problem:
  type: object
  required: [type, title, status, code]
  properties:
    type: {type: string}
    title: {type: string}
    status: {type: integer}
    detail: {type: string}
    code: {type: string}
    instance: {type: string}
    param: {type: string, description: "bad_param의 파라미터 이름"}
Envelope:
  type: object
  required: [schema_version, epoch, build_id, data_as_of, applied_seq, as_of, degraded]
  properties:
    schema_version: {type: string}
    epoch: {type: integer, minimum: 1}
    build_id: {type: string}
    data_as_of: {type: [string, "null"], format: date-time}
    applied_seq: {type: integer, minimum: 0}
    as_of:
      type: object
      required: [valid, observed]
      properties:
        valid: {type: [string, "null"], format: date-time}
        observed: {type: [string, "null"], format: date-time}
    degraded: {type: array, items: {type: string}}
Page:
  type: object
  required: [next_cursor, total, truncated]
  properties:
    next_cursor: {type: [string, "null"]}
    total: {type: [integer, "null"], minimum: 0}
    truncated: {type: boolean}
ValidTime:
  type: object
  properties:
    from: {type: [string, "null"]}
    to: {type: [string, "null"]}
    precision: {type: [string, "null"], enum: [instant, day, month, quarter, year, null]}
    label: {type: [string, "null"]}
SourceRef:
  type: object
  required: [id, label]
  properties:
    id: {type: string}
    label: {type: string}
    trust: {type: string}

# 노드와 엣지
Node:
  type: object
  required: [id, type, label, origin, status, sensitivity, version, recorded_at]
  properties:
    id: {type: string}
    type: {type: string}
    label: {type: string}
    origin: {$ref: "#/components/schemas/Origin"}
    status: {$ref: "#/components/schemas/Status"}
    liveness: {type: [string, "null"]}
    verification: {type: [string, "null"]}
    link_status: {type: [string, "null"]}
    sensitivity: {$ref: "#/components/schemas/Sensitivity"}
    domain: {type: array, items: {type: string}}
    version: {type: integer}
    merged_into: {type: [string, "null"]}
    merged_into_final: {type: [string, "null"]}
    valid: {$ref: "#/components/schemas/ValidTime"}
    recorded_at: {type: string, format: date-time}
    expired_at: {type: [string, "null"], format: date-time}
    author: {type: [string, "null"]}
    generated_by: {type: [string, "null"]}
    on_behalf_of: {type: [string, "null"]}
    body_format: {type: [string, "null"]}
    body: {type: [string, "null"]}
    body_chars: {type: [integer, "null"]}
    props: {type: object}
NodeList:
  type: object
  required: [items]
  properties:
    items: {type: array, items: {$ref: "#/components/schemas/Node"}}
Edge:
  type: object
  required: [id, src, dst, rtype, status, sensitivity, version]
  properties:
    id: {type: string}
    src: {type: string}
    dst: {type: string}
    rtype: {type: string}
    status: {$ref: "#/components/schemas/Status"}
    sensitivity: {$ref: "#/components/schemas/Sensitivity"}
    version: {type: integer}
    claim_id: {type: [string, "null"]}
    valid: {$ref: "#/components/schemas/ValidTime"}
    recorded_at: {type: string, format: date-time}
    expired_at: {type: [string, "null"], format: date-time}
    props: {type: object}
NodeRef:
  type: object
  required: [id, type, label]
  properties:
    id: {type: string}
    type: {type: string}
    label: {type: string}
EdgeRef:
  type: object
  required: [id, rtype, src, dst, status]
  properties:
    id: {type: string}
    rtype: {type: string}
    src: {type: string}
    dst: {type: string}
    status: {$ref: "#/components/schemas/Status"}
    claim_id: {type: [string, "null"]}
    peer: {$ref: "#/components/schemas/NodeRef"}
EdgeRefList:
  type: object
  required: [items]
  properties:
    items: {type: array, items: {$ref: "#/components/schemas/EdgeRef"}}
EdgeGroups:
  type: object
  required: [out, in, truncated]
  properties:
    out: {type: array, items: {$ref: "#/components/schemas/EdgeRef"}}
    in: {type: array, items: {$ref: "#/components/schemas/EdgeRef"}}
    truncated: {type: boolean}
Backlink:
  type: object
  required: [id, type, label, rtype]
  properties:
    id: {type: string}
    type: {type: string}
    label: {type: string}
    rtype: {type: string}
Evidence:
  type: object
  required: [id, snapshot_id, selector_kind, evidence_state]
  properties:
    id: {type: string}
    snapshot_id: {type: string}
    selector_kind: {$ref: "#/components/schemas/SelectorKind"}
    exact: {type: [string, "null"]}
    prefix: {type: [string, "null"]}
    suffix: {type: [string, "null"]}
    start: {type: [integer, "null"], description: "표시 본문 코드포인트, 포함"}
    end: {type: [integer, "null"], description: "표시 본문 코드포인트, 미포함"}
    json_pointer: {type: [string, "null"]}
    evidence_state: {$ref: "#/components/schemas/EvidenceState"}
    support_check: {type: [string, "null"]}
    last_confirmed_at: {type: [string, "null"], format: date-time}
Claim:
  allOf:
    - $ref: "#/components/schemas/Node"
    - type: object
      required: [subject, statement, kind, stance, method]
      properties:
        subject: {type: string}
        predicate: {type: [string, "null"]}
        object: {type: [string, "null"]}
        value: {type: [string, "null"]}
        unit: {type: [string, "null"]}
        qualifiers: {type: object}
        statement: {type: string}
        own_status: {$ref: "#/components/schemas/Status", description: "버전 행에 저장된 자기 상태. 2.7"}
        status_basis: {type: string, description: "status의 출처. own 또는 subject(열린 값). 2.7"}
        kind: {type: string, enum: [event, state, howto]}
        stance: {type: string, enum: [stated, attributed]}
        speaker: {type: [string, "null"]}
        method: {type: string, enum: [deterministic, llm, human]}
        conflict_group: {type: [string, "null"]}
        evidence: {type: array, items: {$ref: "#/components/schemas/Evidence"}}
ClaimList:
  type: object
  required: [items]
  properties:
    items: {type: array, items: {$ref: "#/components/schemas/Claim"}}
ClaimDetail:
  allOf:
    - $ref: "#/components/schemas/Claim"
    - type: object
      required: [versions]
      properties:
        versions: {type: array, items: {$ref: "#/components/schemas/Claim"}}
EdgeDetail:
  allOf:
    - $ref: "#/components/schemas/Edge"
    - type: object
      required: [versions, claim]
      properties:
        versions: {type: array, items: {$ref: "#/components/schemas/Edge"}}
        claim:
          oneOf:
            - $ref: "#/components/schemas/Claim"
            - type: "null"
NodeDetail:
  allOf:
    - $ref: "#/components/schemas/Node"
    - type: object
      properties:
        claims: {type: array, items: {$ref: "#/components/schemas/Claim"}}
        claims_truncated: {type: boolean}
        edges: {$ref: "#/components/schemas/EdgeGroups"}
        backlinks: {type: array, items: {$ref: "#/components/schemas/Backlink"}}
        backlinks_truncated: {type: boolean}
        claim: {$ref: "#/components/schemas/ClaimDetail"}
        snapshot: {$ref: "#/components/schemas/Snapshot"}
        series: {$ref: "#/components/schemas/SeriesInfo"}

# 본문 창
TextWindow:
  type: object
  required: [text, start, end, total_chars]
  properties:
    text: {type: string}
    start: {type: integer, description: "코드포인트, 포함"}
    end: {type: integer, description: "코드포인트, 미포함"}
    total_chars: {type: integer}
NodeBody:
  allOf:
    - $ref: "#/components/schemas/TextWindow"
    - type: object
      required: [body_format]
      properties:
        body_format: {type: string}
SnapshotText:
  allOf:
    - $ref: "#/components/schemas/TextWindow"
    - type: object
      required: [text_format]
      properties:
        text_format: {type: string}

# 그래프
GraphFlags:
  type: object
  required: [directed, multi]
  properties:
    directed: {type: boolean}
    multi: {type: boolean}
ColumnTable:
  type: object
  required: [columns, rows]
  properties:
    columns: {type: array, items: {type: string}}
    rows:
      type: array
      items:
        type: array
        items:
          type: [string, "null", array]
          items: {type: string}
OverviewMeta:
  type: object
  required: [graph, order, node_total, edge_total, truncated]
  properties:
    graph: {$ref: "#/components/schemas/GraphFlags"}
    order: {type: string}
    node_total: {type: integer, minimum: 0}
    edge_total: {type: integer, minimum: 0}
    truncated: {type: boolean}
Overview:
  type: object
  required: [meta, nodes, edges]
  properties:
    meta: {$ref: "#/components/schemas/OverviewMeta"}
    nodes: {$ref: "#/components/schemas/ColumnTable"}
    edges: {$ref: "#/components/schemas/ColumnTable"}
Neighbors:
  type: object
  required: [nodes, edges, truncated, node_total, edge_total]
  properties:
    nodes: {$ref: "#/components/schemas/ColumnTable"}
    edges: {$ref: "#/components/schemas/ColumnTable"}
    truncated: {type: boolean}
    node_total: {type: integer, minimum: 0}
    edge_total: {type: integer, minimum: 0}

# 이력
VersionRow:
  type: object
  required: [version, status, recorded_at]
  properties:
    version: {type: integer}
    label: {type: string}
    status: {$ref: "#/components/schemas/Status"}
    recorded_at: {type: string, format: date-time}
    expired_at: {type: [string, "null"], format: date-time}
ChainItem:
  type: object
  required: [id, version, status, valid, recorded_at]
  properties:
    id: {type: string}
    version: {type: integer}
    status: {$ref: "#/components/schemas/Status"}
    own_status: {$ref: "#/components/schemas/Status", description: "버전 행에 저장된 자기 상태. 2.7"}
    status_basis: {type: string, description: "status의 출처. own 또는 subject(열린 값). 2.7"}
    value: {type: [string, "null"]}
    unit: {type: [string, "null"]}
    valid: {$ref: "#/components/schemas/ValidTime"}
    recorded_at: {type: string, format: date-time}
    expired_at: {type: [string, "null"], format: date-time}
    superseded_by: {type: [string, "null"]}
Chain:
  type: object
  required: [predicate, slot, items]
  properties:
    predicate: {type: [string, "null"]}
    slot: {type: [string, "null"]}
    items: {type: array, items: {$ref: "#/components/schemas/ChainItem"}}
History:
  type: object
  required: [id, versions, chains, edges]
  properties:
    id: {type: string}
    versions: {type: array, items: {$ref: "#/components/schemas/VersionRow"}}
    chains: {type: array, items: {$ref: "#/components/schemas/Chain"}}
    edges: {type: array, items: {$ref: "#/components/schemas/EdgeRef"}}

# 검색. kind별 변형
Highlight:
  type: object
  required: [start, end]
  properties:
    start: {type: integer}
    end: {type: integer}
SearchHitBase:
  type: object
  required: [id, type, title, snippet, highlights, highlight_unit, origin, status]
  properties:
    id: {type: string}
    type: {type: string}
    title: {type: string}
    snippet: {type: string}
    highlights: {type: array, items: {$ref: "#/components/schemas/Highlight"}}
    highlight_unit: {type: string, const: codepoint}
    origin: {$ref: "#/components/schemas/Origin"}
    status: {$ref: "#/components/schemas/Status"}
SearchHitClaim:
  allOf:
    - $ref: "#/components/schemas/SearchHitBase"
  required: [kind, subject, source, verification, recorded_at]
  properties:
    kind: {type: string, const: claim}
    subject: {type: string}
    source: {$ref: "#/components/schemas/SourceRef"}
    verification: {type: string}
    recorded_at: {type: string, format: date-time}
SearchHitRecord:
  allOf:
    - $ref: "#/components/schemas/SearchHitBase"
  required: [kind, author, sensitivity, recorded_at]
  properties:
    kind: {type: string, const: record}
    author: {type: [string, "null"]}
    sensitivity: {$ref: "#/components/schemas/Sensitivity"}
    recorded_at: {type: string, format: date-time}
SearchHitEntity:
  allOf:
    - $ref: "#/components/schemas/SearchHitBase"
  required: [kind]
  properties:
    kind: {type: string, const: entity}
    liveness: {type: [string, "null"]}
SearchHitPassage:
  allOf:
    - $ref: "#/components/schemas/SearchHitBase"
  required: [kind, snapshot_id, start, end, source]
  properties:
    kind: {type: string, const: passage}
    id: {type: string, description: "snapshot_id:start. 노드 ID가 아니다. 노드 조회에 쓰지 않는다(4.8)"}
    snapshot_id: {type: string}
    start: {type: integer, description: "표시 본문 코드포인트, 포함"}
    end: {type: integer, description: "표시 본문 코드포인트, 미포함"}
    source: {$ref: "#/components/schemas/SourceRef"}
SearchHit:
  oneOf:
    - $ref: "#/components/schemas/SearchHitClaim"
    - $ref: "#/components/schemas/SearchHitRecord"
    - $ref: "#/components/schemas/SearchHitEntity"
    - $ref: "#/components/schemas/SearchHitPassage"
  discriminator: {propertyName: kind}
SearchResult:
  type: object
  required: [items]
  properties:
    items: {type: array, items: {$ref: "#/components/schemas/SearchHit"}}

# 집계
FacetValue:
  type: object
  required: [value, count]
  properties:
    value: {type: string}
    label: {type: string}
    count: {type: integer, minimum: 0}
Facets:
  type: object
  required: [total, facets]
  properties:
    total: {type: integer, minimum: 0}
    facets:
      type: object
      required: [type, origin, status, source, domain]
      properties:
        type: {type: array, items: {$ref: "#/components/schemas/FacetValue"}}
        origin: {type: array, items: {$ref: "#/components/schemas/FacetValue"}}
        status: {type: array, items: {$ref: "#/components/schemas/FacetValue"}}
        source: {type: array, items: {$ref: "#/components/schemas/FacetValue"}}
        domain: {type: array, items: {$ref: "#/components/schemas/FacetValue"}}
Counts:
  type: object
  required: [bucket, field, series]
  properties:
    bucket: {type: string, enum: [day, week, month]}
    field: {type: string, enum: [recorded_at, valid_from]}
    series:
      type: array
      items:
        type: object
        required: [start, count]
        properties:
          start: {type: string, format: date-time}
          count: {type: integer, minimum: 0}

# 시계열
SeriesInfo:
  type: object
  required: [id, metric, unit]
  properties:
    id: {type: string}
    metric: {type: string}
    unit: {type: [string, "null"]}
SeriesPoint:
  type: object
  required: [period, start, value, observed_at, last_seen_at]
  properties:
    period: {type: string}
    start: {type: string, format: date-time}
    end: {type: [string, "null"], format: date-time}
    value: {type: string}
    observed_at: {type: string, format: date-time}
    last_seen_at: {type: string, format: date-time}
    snapshot_id: {type: [string, "null"]}
Gap:
  type: object
  required: [from, to, reason]
  properties:
    from: {type: string, format: date-time}
    to: {type: string, format: date-time}
    reason: {type: string}
Series:
  allOf:
    - $ref: "#/components/schemas/SeriesInfo"
    - type: object
      required: [points, gaps]
      properties:
        points: {type: array, items: {$ref: "#/components/schemas/SeriesPoint"}}
        gaps: {type: array, items: {$ref: "#/components/schemas/Gap"}}

# 스냅샷, 피드
Snapshot:
  type: object
  required: [id, url, source, fetched_at, http_status, content_type, raw_sha256, text_chars, citing_claims]
  properties:
    id: {type: string}
    url: {type: string}
    final_url: {type: [string, "null"]}
    source: {$ref: "#/components/schemas/SourceRef"}
    fetched_at: {type: string, format: date-time}
    http_status: {type: integer}
    content_type: {type: string}
    raw_sha256: {type: string}
    text_sha256: {type: [string, "null"]}
    text_format: {type: [string, "null"]}
    text_chars: {type: integer}
    extractor: {type: [string, "null"]}
    citing_claims:
      type: array
      items:
        type: object
        required: [id]
        properties:
          id: {type: string}
          start: {type: [integer, "null"]}
          end: {type: [integer, "null"]}
Change:
  type: object
  required: [seq, at, kind, id]
  properties:
    seq: {type: integer}
    at: {type: string, format: date-time}
    kind: {type: string}
    id: {type: [string, "null"]}
    version: {type: [integer, "null"]}
    type: {type: [string, "null"]}
    origin: {type: [string, "null"], enum: [external, first_party, system, null]}
ChangeList:
  type: object
  required: [items]
  properties:
    items: {type: array, items: {$ref: "#/components/schemas/Change"}}

# 메타, 스키마
Meta:
  type: object
  required: [contract, kb_version, limits, changes_cursor, first_party_open, counts]
  properties:
    contract: {type: string}
    kb_version: {type: string}
    limits:
      type: object
      required: [overview_nodes, overview_edges, page, concurrent]
      properties:
        overview_nodes: {type: integer}
        overview_edges: {type: integer}
        page: {type: integer}
        concurrent: {type: integer, minimum: 12}
    changes_cursor: {type: string}
    first_party_open: {type: boolean}
    counts:
      type: object
      required: [nodes, edges, claims]
      properties:
        nodes: {type: integer}
        edges: {type: integer}
        claims: {type: integer}
SchemaProperty:
  type: object
  required: [name, type, filterable, sortable]
  properties:
    name: {type: string}
    type: {type: string}
    filterable: {type: boolean}
    sortable: {type: boolean}
NodeType:
  type: object
  required: [name, group, count, status]
  properties:
    name: {type: string}
    group: {type: string}
    count: {type: integer, minimum: 0}
    status: {type: string}
    in_overview: {type: boolean, description: "overview_types에 든다. 4.2"}
    properties: {type: array, items: {$ref: "#/components/schemas/SchemaProperty"}}
    json_schema: {type: object}
EdgeType:
  type: object
  required: [name, group, count]
  properties:
    name: {type: string}
    group: {type: string}
    count: {type: integer, minimum: 0}
    from: {type: array, items: {type: string}}
    to: {type: array, items: {type: string}}
Predicate:
  type: object
  required: [id, functional]
  properties:
    id: {type: string}
    functional: {type: boolean}
    value_kind: {type: [string, "null"]}
    labels: {type: object, additionalProperties: {type: string}}
SchemaCatalog:
  type: object
  required: [node_types, edge_types, predicates, overview_types, enums, sort_keys, filter_keys]
  properties:
    node_types: {type: array, items: {$ref: "#/components/schemas/NodeType"}}
    edge_types: {type: array, items: {$ref: "#/components/schemas/EdgeType"}}
    predicates: {type: array, items: {$ref: "#/components/schemas/Predicate"}}
    overview_types: {type: array, items: {type: string}}
    enums: {type: object, additionalProperties: {type: array, items: {type: string}}}
    sort_keys: {type: object, additionalProperties: {type: array, items: {type: string}}}
    filter_keys: {type: array, items: {type: string}}

# export
ExportProfile:
  type: object
  required: [path, bytes, sha256, nodes, edges]
  properties:
    path: {type: string}
    bytes: {type: integer}
    sha256: {type: string}
    nodes: {type: integer}
    edges: {type: integer}
Manifest:
  type: object
  required: [build_id, applied_seq, epoch, generated_at, changes_cursor, profiles]
  properties:
    build_id: {type: string, description: "게시 ID p-<applied_seq 9자리>"}
    applied_seq: {type: integer}
    epoch: {type: integer}
    generated_at: {type: string, format: date-time}
    changes_cursor: {type: string}
    profiles:
      type: object
      required: [core, full]
      properties:
        core: {$ref: "#/components/schemas/ExportProfile"}
        full: {$ref: "#/components/schemas/ExportProfile"}
ExportFile:
  type: object
  required: [schema_version, build_id, applied_seq, epoch, data_as_of, graph, nodes, edges]
  properties:
    schema_version: {type: string}
    build_id: {type: string, description: "게시 ID p-<applied_seq 9자리>"}
    applied_seq: {type: integer}
    epoch: {type: integer}
    data_as_of: {type: [string, "null"], format: date-time}
    graph: {$ref: "#/components/schemas/GraphFlags"}
    nodes: {$ref: "#/components/schemas/ColumnTable"}
    edges: {$ref: "#/components/schemas/ColumnTable"}

# 운영 [잠정]
OpsFreshness:
  type: object
  required: [classes, sources, gaps]
  properties:
    classes:
      type: array
      items:
        type: object
        required: [class, total, stale]
        properties:
          class: {type: string}
          total: {type: integer}
          stale: {type: integer}
    sources:
      type: array
      items:
        type: object
        required: [source_id, class, state, stale]
        properties:
          source_id: {type: string}
          class: {type: string}
          last_ok_at: {type: [string, "null"], format: date-time}
          state: {type: string}
          stale: {type: boolean}
    gaps:
      type: array
      items:
        allOf:
          - $ref: "#/components/schemas/Gap"
          - type: object
            required: [source_id]
            properties:
              source_id: {type: string}
OpsTicketList:
  type: object
  required: [items]
  properties:
    items:
      type: array
      items:
        type: object
        required: [id, topic, status, priority, opened_at]
        properties:
          id: {type: string}
          topic: {type: string}
          status: {type: string}
          priority: {type: string}
          opened_at: {type: string, format: date-time}
          closed_at: {type: [string, "null"], format: date-time}
OpsRunList:
  type: object
  required: [items]
  properties:
    items:
      type: array
      items:
        type: object
        required: [job, started_at, outcome]
        properties:
          job: {type: string}
          started_at: {type: string, format: date-time}
          ended_at: {type: [string, "null"], format: date-time}
          outcome: {type: [string, "null"]}
OpsMetrics:
  type: object
  required: [items]
  properties:
    items:
      type: array
      items:
        type: object
        required: [name, value, at]
        properties:
          name: {type: string}
          dims: {type: [object, "null"]}
          value: {type: number}
          at: {type: string, format: date-time}
```

`quote_found`는 인용구가 스냅샷에서 기계로 확인됐다는 뜻이지 주장이 참이라는 뜻이 아니다. `evidence_state=archived_only`는 인용구가 최신 스냅샷에서 사라졌고 옛 스냅샷에만 있다는 뜻이다. `support_check`는 함의 판정 결과다. `link_status=gone`은 문서 URL이 서로 다른 시간대 3회 404라는 뜻이다.

## 4. 읽기 엔드포인트

모든 경로는 `GET`이고 `HEAD`도 받는다. 아래 표가 경로, `operationId`, 응답, 허용 쿼리 파라미터의 전부다. 표에 없는 파라미터는 400 `bad_param`이다(2.3). `F`는 공통 필터 `types`, `origin`, `status`, `domain`, `source`, `author`, `include_unverified`이고 `T`는 시점 파라미터 `as_of_valid`, `as_of_observed`다.

| 경로 | `operationId` | `data` | `page` | 파라미터 |
|---|---|---|---|---|
| `/v1/meta` | `getMeta` | `Meta` | | 없음 |
| `/v1/schema` | `getSchema` | `SchemaCatalog` | | 없음 |
| `/v1/overview` | `getOverview` | `Overview` | 있음 | F, T, `edge_status`, `rtypes`, `limit`, `edge_limit`, `cursor` |
| `/v1/nodes` | `listNodes` | `NodeList` | 있음 | F, T, `type`, `ids`, `filter`, `sort`, `cursor`, `limit` |
| `/v1/nodes/{id}` | `getNode` | `NodeDetail` | | `status`, `include_unverified`, T, `include`, `claim_limit`, `edge_limit`, `backlink_limit` |
| `/v1/nodes/{id}/claims` | `listNodeClaims` | `ClaimList` | 있음 | F, T, `predicate`, `cursor`, `limit` |
| `/v1/nodes/{id}/edges` | `listNodeEdges` | `EdgeRefList` | 있음 | F, T, `direction`, `rtypes`, `cursor`, `limit` |
| `/v1/nodes/{id}/body` | `getNodeBody` | `NodeBody` | | T, `start`, `max_chars` |
| `/v1/nodes/{id}/neighbors` | `getNodeNeighbors` | `Neighbors` | | F, T, `edge_status`, `depth`, `rtypes`, `direction`, `limit`, `edge_limit` |
| `/v1/nodes/{id}/history` | `getNodeHistory` | `History` | | `predicate` |
| `/v1/claims/{id}` | `getClaim` | `ClaimDetail` | | T |
| `/v1/edges/{id}` | `getEdge` | `EdgeDetail` | | T |
| `/v1/search` | `search` | `SearchResult` | 있음 | F, T, `q`, `mode`, `kinds`, `cursor`, `limit` |
| `/v1/facets` | `getFacets` | `Facets` | | F, T, `q`, `kinds`, `filter` |
| `/v1/counts` | `getCounts` | `Counts` | | F, T, `bucket`, `field` |
| `/v1/series/{id}` | `getSeries` | `Series` | | T, `from`, `to`, `bucket` |
| `/v1/snapshots/{id}` | `getSnapshot` | `Snapshot` | | 없음 |
| `/v1/snapshots/{id}/text` | `getSnapshotText` | `SnapshotText` | | `start`, `max_chars` |
| `/v1/snapshots/{id}/raw` | `getSnapshotRaw` | 봉투 없음. 원본 바이트 | | 없음. `Range` 헤더 |
| `/v1/changes` | `listChanges` | `ChangeList` | 있음 | `cursor`, `limit`, `kinds`, `origin` |
| `/v1/export/graph/manifest` | `getExportManifest` | `Manifest` | | 없음 |
| `/v1/export/graph` | `getExportGraph` | 봉투 없음. `ExportFile`의 zstd | | `profile` |
| `/v1/ops/freshness` | `getOpsFreshness` | `OpsFreshness` | | 없음 |
| `/v1/ops/tickets` | `listOpsTickets` | `OpsTicketList` | 있음 | `status`, `cursor`, `limit` |
| `/v1/ops/runs` | `listOpsRuns` | `OpsRunList` | 있음 | `cursor`, `limit` |
| `/v1/ops/metrics` | `getOpsMetrics` | `OpsMetrics` | | 없음 |

**지연 목표.** 소비자 문서의 값이고 웜은 p95 200 ms다. `/v1/overview`는 2초, `/raw`는 크기 비례, export는 파일 전송이다. 콜드는 유휴 종료 뒤 소켓 활성화 기동을 포함한 첫 요청이고 초기 목표는 p95 1초, 개요 4초다. 재부팅 직후 값은 WP-14 입회 시험에서 기록만 한다. WP-10 부하 시험이 추정 규모 상단(노드 40만, 엣지 150만, 문단 15만, 개요 5만·20만)에서 웜과 콜드를 실제로 잰다.

**표 문법.** `/v1/nodes`와 `/v1/facets`의 `filter`, `/v1/nodes`의 `sort`다.

| 항목 | 규칙 |
|---|---|
| 값 여럿 | 공통 필터와 `kinds`, `rtypes`는 쉼표로 여러 값을 주면 OR이고 서로 다른 파라미터는 AND다. `domain`은 포함 일치다. `type`은 `/v1/nodes`에서 값 하나의 `types`이고 둘을 함께 주면 `bad_param`이다. `/edges`의 `types`는 반대쪽 노드 타입이다 |
| `filter` | `name:op:value`. 반복하면 AND다. 첫 두 `:`만 구분자이고 값 안의 `:`는 그대로 쓴다. URL에서는 퍼센트 인코딩한다 |
| `name` | 공통 열 `label`, `recorded_at`과 `/v1/schema`에서 `filterable=true`인 속성이다. 그 밖의 이름은 `bad_param`이다 |
| `op` | `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `prefix`. 속성 형에 맞지 않는 연산자는 `bad_param`이다 |
| `in` | 값을 쉼표로 나누고 OR이다. 값 안의 쉼표는 `\,`, 역슬래시는 `\\`다. 최대 100개다 |
| `prefix` | 문자열 전용이다. NFC로 맞춘 뒤 ASCII 대소문자를 무시한다 |
| 비교 | 속성의 `type`을 따른다. `string`은 코드포인트 순서, `integer`, `decimal`은 수 비교, `date-time`은 시각 비교다. 배열 속성은 원소 하나가 맞으면 참이다. `null`은 어떤 연산자에도 거짓이다 |
| `sort` | `key` 또는 `-key`(내림차순). 키는 하나다. 허용 키는 `/v1/schema`의 `sort_keys`이고 `types`가 여럿이면 `*` 항목의 키만 된다. 기본은 `id` 오름차순이다. 동률은 `id` 오름차순으로 끊고 `null`은 방향과 무관하게 끝에 온다 |
| `cursor`, `limit` | 2.4 |

### 4.1 `GET /v1/meta`

```json
{"schema_version":"0.3.1","epoch":1,"build_id":"g-000183422-a1b2","data_as_of":"2026-10-31T09:12:03Z","applied_seq":183422,"as_of":{"valid":null,"observed":null},"degraded":[],
 "data":{"contract":"v1","kb_version":"0.1.0","limits":{"overview_nodes":100000,"overview_edges":400000,"page":500,"concurrent":16},
         "changes_cursor":"eyJlIjoxLCJzIjoxODM0MjJ9","first_party_open":false,"counts":{"nodes":48213,"edges":812004,"claims":153201}}}
```

`first_party_open=false`이면 first_party 노드가 아직 없다. `changes_cursor`는 현재 머리의 피드 커서다. "지금부터" 받으려면 이 값으로 시작한다. `counts`는 숨김이 적용된 값이다. `limits.concurrent`는 2.3의 동시 상한이다.

### 4.2 `GET /v1/schema`

```json
{"data":{
  "node_types":[{"name":"Feature","group":"world","count":3120,"status":"stable",
    "properties":[{"name":"product","type":"string","filterable":true,"sortable":false}],
    "json_schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":true}}],
  "edge_types":[{"name":"PART_OF","group":"structure","count":21004,"from":["Feature"],"to":["Product"]}],
  "predicates":[{"id":"removed_in","functional":false,"value_kind":"version","labels":{"ko":"제거 버전","en":"removed in"}}],
  "overview_types":["Platform","Product","Feature","Tool","Model","Org","Concept","Technique","Policy","Note","Decision","Artifact","Learning","Project","Record","Series"],
  "enums":{"origin":["external","first_party"],"sensitivity":["public","internal","private","secret"],"status":["active","superseded","dead"],"selector_kind":["text_quote","jsonpointer"],"claim_kind":["event","state","howto"],"hit_kind":["claim","record","entity","passage"],"stance":["stated","attributed"],"method":["deterministic","llm","human"],"precision":["instant","day","month","quarter","year"],"evidence_state":["live","archived_only"]},
  "sort_keys":{"*":["id","label","recorded_at"],"Feature":["id","label","recorded_at"]},
  "filter_keys":["types","origin","status","domain","source","author"]
}}
```

타입을 하드코딩하지 않고 이 응답으로 UI를 구동한다. `sort_keys`의 `*`는 모든 타입의 공통 키다.

`overview_types`는 `/v1/overview`의 기본 `types`다. 타입 파일의 `x-kb-overview`에서 오고 초기값은 위 16개다. 세계 타입의 `Repo Package Person Channel Video Keyword Metric`과 `Claim`, `Snapshot`, `Source`, `Document`, `Ticket`이 빠진다. `Series`는 `MEASURES` 닫힘을 위해 남긴다(ADR 7.3). KB는 1차 수집 뒤 실제 `count`로 이 목록을 조정한다. 기준은 `limit=10000&edge_limit=50000`에서 `truncated=false`다. 목록이 바뀌면 sagae-tools에 알린다. 소비자는 목록을 복사하지 않고 이 값을 읽는다.

**갱신 절차.** 목록은 타입 파일의 `x-kb-overview`가 정하고 키가 없으면 `group=user` 타입은 `true`, 그 밖은 `false`로 본다. 새 사용자 타입은 임시 등록(`provisional`) 때부터 목록에 들어가므로 별도 계약 변경이 필요 없다. 세계 타입은 파일에서 `true`로 바꿀 때만 들어간다. 바뀌면 `kb schema sync` 뒤 `applied_seq`가 올라 `/v1/schema`의 `ETag`가 바뀌고 각 `NodeType.in_overview`도 같은 값을 준다. 소비자는 개요를 열 때마다 `/v1/schema`를 조건부로 읽는다. 사용자 타입의 자동 포함은 통지하지 않고, 세계 타입을 더하거나 빼는 조정은 sagae-tools에 알린다. 자동 포함으로 노드가 늘어 `truncated=true`가 되면 소비자는 `types`로 좁힌다.

### 4.3 `GET /v1/overview`

| 파라미터 | 기본 | 뜻 |
|---|---|---|
| `types` | `/v1/schema`의 `overview_types` | 기본을 넓히거나 좁힌다 |
| `edge_status` | `status`와 같다 | 엣지에만 거는 상태. 쉼표로 여럿(2.7) |
| `rtypes` | 전체 | 관계 필터 |
| `limit` | 50,000 | 페이지당 노드 상한. 최대 100,000 |
| `edge_limit` | 200,000 | 페이지당 엣지 상한. 최대 400,000 |
| `cursor` | | 이어 받기 |

필수 필터는 없고 `types`, `domain`으로 좁힐 수 있다. 정렬은 `id` 오름차순이고 재구축에도 같다. 기본 상한은 추정 규모 상단이다(44,349노드·178,897엣지에서 546~574 ms, 10.9 MB, `general-db.md` 5.2, 프로토타입). 넘으면 `truncated=true`, `page.next_cursor`로 끝까지 받는다. 이어 받은 페이지의 합집합은 전체 필터 결과와 같고 닫힘 규칙도 합집합 기준이다. `id` 순 절단이라 잘린 응답 하나만 쓰면 타입 이름 뒤쪽과 `f-` 기록이 빠진다.

`data.meta.node_total`, `edge_total`은 필터 적용 전체 개수이고 항상 정수다. `limit`, `edge_limit`, `cursor`와 무관하다. `page.total`은 `node_total`과 같고 `data.meta.truncated`는 `page.truncated`와 같다. 엣지 열 `status`는 `edge_status`에 여러 값을 줄 때 대체 엣지를 가른다. 대체 엣지는 `edge_status=active,superseded`로 받는다. `status=all`은 죽은 노드까지 받아 `node_total`을 키우므로 이 용도에 쓰지 않는다. loupe는 `limit=10000&edge_limit=50000`과 `overview_types`를 보내고 `truncated=false`가 되게 타입을 줄인다. 전체 입력은 5장 `core`로 받으므로 개요 커서를 쓰지 않는다.

```json
{"data":{
  "meta":{"graph":{"directed":true,"multi":true},"order":"id_asc","node_total":48213,"edge_total":176402,"truncated":false},
  "nodes":{"columns":["id","type","label","origin","status"],
           "rows":[["e:feature:claude-code-hooks","Feature","Hooks","external","active"]]},
  "edges":{"columns":["id","src","dst","rtype","status"],
           "rows":[["r-1a2b3c4d5e6f","e:feature:claude-code-hooks","e:product:claude-code","PART_OF","active"]]}},
 "page":{"next_cursor":null,"total":48213,"truncated":false}}
```

사실 투영 엣지는 `rtype`이 술어 이름이고 `/v1/edges/{id}`의 `claim_id`, `claim`으로 근거를 찾는다(4.14).

### 4.4 `GET /v1/nodes`

`type`, 공통 필터, `filter`, `sort`, `cursor`, `limit`(기본 100, 최대 500). 기본 정렬은 `id` 오름차순이다.

**일괄 읽기.** `ids`는 쉼표로 최대 100개를 받는다. 넘으면 `limit_too_large`다. id 직접 조회 규칙을 따르므로 기본 필터가 걸리지 않고 병합 ID도 응답한다. 숨긴 ID와 없는 ID는 오류 없이 빠진다. 순서는 요청 순서이고 `page.total`은 찾은 개수, `next_cursor`는 `null`이다. `as_of_*`와만 함께 쓰고 다른 파라미터가 있으면 `bad_param`이다.

**접두어 찾기.** 입력 중인 이름은 `filter=label:prefix:<입력>`으로 찾는다. 검색에는 접두어 일치가 없다(4.8).

```json
{"data":{"items":[{"id":"e:repo:anthropics-claude-code","type":"Repo","label":"anthropics/claude-code","origin":"external","status":"active","liveness":"active","sensitivity":"public","domain":["G"],"version":4,"merged_into":null,"recorded_at":"2026-10-31T01:00:00Z","props":{"stars":"..."}}]},
 "page":{"next_cursor":"eyJrIjpb...","total":142,"truncated":false}}
```

### 4.5 `GET /v1/nodes/{id}`

이 경로는 2.10 표의 모든 노드 ID에 응답한다. 응답 `type`으로 화면을 나누고 ID 종류별 필드는 그 표다.

`include`는 `claims`, `edges`, `backlinks`, `body`를 쉼표로 고른다. 기본은 `claims,edges`다. `claim_limit` 기본 50, 최대 200, `edge_limit`, `backlink_limit` 기본 100, 최대 500이다. 전부 `id` 오름차순으로 자른다. 넘으면 묶음별 `claims_truncated`, `edges.truncated`, `backlinks_truncated`가 `true`이고 `/v1/nodes/{id}/claims`, `/edges`로 이어 받는다. 허브 노드의 기본 응답이 커지지 않게 하기 위해서다. 주장이 많은 엔티티는 `/claims`의 커서로 끝까지 읽는다.

`include=body`는 `body`, `body_chars`, `body_format`을 준다. `body`는 앞 200,000자까지이고 `body_chars`가 더 크면 `/v1/nodes/{id}/body?start=&max_chars=`로 나눠 읽는다. 단위는 코드포인트이고 `max_chars`는 기본 20,000, 최대 200,000이다. 본문이 없으면 `/body`는 404, 삭제됐으면 410 `content_removed`이고 상세의 `body`는 `null`이다. `backlinks` 항목은 `Backlink`이고 이 노드를 가리키는 `LINKS_TO`, `MENTIONS`의 출발 노드다. `edges.in`과 달리 사용자 링크만 담고 `backlinks_truncated`면 `/edges?direction=in&rtypes=LINKS_TO,MENTIONS`로 잇는다. `edges`의 `EdgeRef`는 `peer`로 반대쪽 노드의 `id`, `type`, `label`을 준다.

```json
{"data":{
  "id":"e:feature:claude-code-ultraplan","type":"Feature","label":"/ultraplan","origin":"external",
  "status":"dead","liveness":"removed","sensitivity":"public","domain":["G"],"version":3,"merged_into":null,"merged_into_final":null,
  "valid":{"from":null,"to":"2026-08-02","precision":"day","label":null},
  "recorded_at":"2026-10-31T01:02:03Z","expired_at":null,"author":null,
  "props":{"product":"claude-code"},
  "claims":[{"id":"c-8k2p4q7m1xab","type":"Claim","label":"Claude Code의 /ultraplan 명령은 2.1.222에서 제거됐다.","statement":"Claude Code의 /ultraplan 명령은 2.1.222에서 제거됐다.","subject":"e:feature:claude-code-ultraplan","predicate":"removed_in","value":"2.1.222","unit":"version","kind":"event","stance":"stated","method":"llm","status":"active","verification":"quote_found","origin":"external","sensitivity":"public","version":1,"recorded_at":"2026-10-31T01:02:03Z",
    "valid":{"from":"2026-08-02","to":null,"precision":"day","label":null},
    "evidence":[{"id":"ev-2m9x4k7q1cab","snapshot_id":"n-3fa9c01b77aa12ef","selector_kind":"text_quote","exact":"/ultraplan Removed in v2.1.222","prefix":"| ","suffix":" |","start":1204,"end":1234,"json_pointer":null,"evidence_state":"live","support_check":null,"last_confirmed_at":"2026-10-31T01:02:03Z"}]}],
  "claims_truncated":false,
  "edges":{"out":[{"id":"r-1a2b3c4d5e6f","rtype":"PART_OF","src":"e:feature:claude-code-ultraplan","dst":"e:product:claude-code","status":"active","claim_id":null,"peer":{"id":"e:product:claude-code","type":"Product","label":"Claude Code"}}],"in":[],"truncated":false},
  "backlinks":[{"id":"f-01JC8ZQ3T9XYZ","type":"Note","label":"쇼츠 후킹 메모","rtype":"LINKS_TO"}],
  "backlinks_truncated":false
}}
```

병합된 노드는 `status=superseded`, `merged_into`, `merged_into_final`이 채워진 채로 같은 형식이다. 최종 대상의 상세는 병합된 ID의 주장과 엣지를 함께 낸다.

`/v1/nodes/{id}/claims`, `/v1/nodes/{id}/edges`는 `cursor`, `limit`(기본 100, 최대 500), 공통 필터를 받고 `id` 오름차순이다. `/claims`는 `predicate`, `/edges`는 `direction`(`out`, `in`, `both`, 기본 `both`), `rtypes`도 받는다.

### 4.6 `GET /v1/nodes/{id}/neighbors`

`depth`(1~2, 기본 1), `rtypes`, `direction`(`out`, `in`, `both`, 기본 `both`), `limit`(노드 수, 기본 200, 최대 500), `edge_limit`(기본 2,000, 최대 10,000), 공통 필터. `edge_status`는 4.3과 같다. `types` 기본값은 `Claim`, `Snapshot`, `Source`, `Document`, `Ticket`을 뺀 전부다(2.7). `overview_types`보다 넓어서 개요에 없는 타입으로 확장할 수 있다.

`nodes`, `edges`의 열은 개요와 같다. `truncated`, `node_total`, `edge_total`은 `data` 바로 아래에 있고 `page`와 커서가 없다. 두 total은 자르기 전 개수이고 항상 정수다. 노드가 `limit`을 넘으면 시작 노드를 남기고 `id` 오름차순으로 자른다. 엣지는 남은 노드 사이의 것만 내고(닫힌 부분 그래프) `edge_limit`을 넘으면 `id` 오름차순으로 자른다. 어느 쪽이든 잘리면 `truncated=true`이고 `types`, `rtypes`로 좁히거나 `/edges`로 잇는다.

```json
{"data":{
  "nodes":{"columns":["id","type","label","origin","status"],
           "rows":[["e:feature:claude-code-hooks","Feature","Hooks","external","active"],["e:product:claude-code","Product","Claude Code","external","active"]]},
  "edges":{"columns":["id","src","dst","rtype","status"],
           "rows":[["r-1a2b3c4d5e6f","e:feature:claude-code-hooks","e:product:claude-code","PART_OF","active"]]},
  "truncated":false,"node_total":2,"edge_total":1}}
```

### 4.7 `GET /v1/nodes/{id}/history`

`id`는 엔티티, 주장, 사용자 기록 어느 것이든 된다. `predicate`를 주면 그 술어의 체인만 줘서 엔티티·속성별 체인을 읽는다. `as_of_*`는 400이다(2.9). `versions`는 그 ID의 버전 행이고 `chains`는 술어·슬롯별 대체 체인이다. 주장 ID를 주면 그 주장이 든 체인 하나다. `slot`이 없는 LLM 주장은 술어별로 `slot=null` 체인 하나에 모인다. 민감도가 오른 ID의 옛 버전은 숨긴다.

**정정 판정.** 판정 대상은 체인의 항목 L이고 기준 시각 t는 L의 `recorded_at`이다. 비교 대상은 t에 살아 있던 같은 체인의 다른 행으로 한정한다. 살아 있다는 것은 `recorded_at <= t`이고 `expired_at`이 `null`이거나 `t < expired_at`이라는 뜻이다. 같은 `id`의 직전 버전은 이미 만료됐어도 비교 대상에 더한다(제자리 정정). 비교 대상 중 하나와 `value`가 다르고 `valid` 구간이 겹치면 L은 소급 정정이다. 구간은 `from` 포함, `to` 미포함이고 `null`은 열림이다. 구간이 겹치지 않고 이어지면 세계의 변화다. 소비자가 이 규칙으로 판정하고 응답에 판정 필드는 없다. 값 표시는 `value`, `unit`과 `/v1/schema` `predicates`의 `value_kind`로 한다. 아래 예시에서 `c-8k2p4q7m1xab` v1(t=2026-11-15)이 만나는 행은 그 시각에 살아 있는 `c-3hd9x0w2raab` v2뿐이고 구간이 겹치지 않으므로 미래 발효 대체이고 소급 정정이 아니다. `c-3hd9x0w2raab` v1은 t에 이미 만료돼 비교 대상이 아니다. `ChainItem.status`는 `eff_status`다(2.7).

```json
{"data":{"id":"e:policy:ypp",
 "versions":[{"version":2,"label":"YouTube 파트너 프로그램","status":"active","recorded_at":"2026-10-31T01:00:00Z","expired_at":null}],
 "chains":[{"predicate":"entry_watch_hours","slot":"a1b2c3","items":[
   {"id":"c-3hd9x0w2raab","version":1,"status":"active","value":"4000","unit":"hour","valid":{"from":"2024-06-01","to":null,"precision":"day","label":null},"recorded_at":"2026-10-31T01:00:00Z","expired_at":"2026-11-15T00:00:00Z","superseded_by":null},
   {"id":"c-3hd9x0w2raab","version":2,"status":"active","value":"4000","unit":"hour","valid":{"from":"2024-06-01","to":"2027-02-01","precision":"day","label":null},"recorded_at":"2026-11-15T00:00:00Z","expired_at":null,"superseded_by":"c-8k2p4q7m1xab"},
   {"id":"c-8k2p4q7m1xab","version":1,"status":"active","value":"8000","unit":"hour","valid":{"from":"2027-02-01","to":null,"precision":"day","label":null},"recorded_at":"2026-11-15T00:00:00Z","expired_at":null,"superseded_by":null}]}],
 "edges":[{"id":"r-7c8d9e0f1a2b","rtype":"SUPERSEDES","src":"c-8k2p4q7m1xab","dst":"c-3hd9x0w2raab","status":"active","claim_id":null}]}}
```

### 4.8 `GET /v1/search`

| 파라미터 | 기본 | 뜻 |
|---|---|---|
| `q` | 필수 | NFC 정규화 후 KB 안에서 토크나이징한다. 도구가 대신 구현하지 않는다 |
| `mode` | `lexical` | `lexical`, `hybrid`. `hybrid`가 불가능하면 `degraded`에 `lexical_only` |
| `kinds` | `claim,record,entity,passage` | 결과 종류 |
| `F`, `T` | | 공통 필터, 시점 |
| `cursor`, `limit` | 기본 50, 최대 200 | 커서는 순위 위치다(2.4) |

`lexical`의 순서는 재현 가능하다. 응답에 점수가 없다. 순서가 곧 순위다. 정규화 뒤 토큰이 하나도 없는 `q`는 400 `bad_param`이다.

기본 필터만 있고 as-of가 없으면 상위 400 후보 안에서 순위를 매기고 `total=null`이다. 후보가 모자라면 `truncated=true`이고 필터로 좁힌다. 다른 필터나 as-of가 있으면 전체 일치에서 필터 후 순위를 매기고 `total`이 정확하다. 그래서 좁은 필터의 0건은 실제로 없다는 뜻이다.

```json
{"data":{"items":[
  {"id":"c-8k2p4q7m1xab","kind":"claim","type":"Claim","title":"YPP 신규 진입 기준은 2027-02-01부터 8,000시간/365일 또는 Shorts 2,000만/90일이다.",
   "snippet":"…신규 진입 기준은 2027-02-01부터 8,000시간/365일…","highlights":[{"start":1,"end":3},{"start":24,"end":29}],"highlight_unit":"codepoint",
   "origin":"external","status":"active","subject":"e:policy:ypp","verification":"quote_found","source":{"id":"src:yt-help","label":"YouTube 고객센터"},"recorded_at":"2026-10-31T01:00:00Z"},
  {"id":"f-01JC8ZQ3T9XYZ","kind":"record","type":"Note","title":"쇼츠 후킹 메모","snippet":"…첫 3초의 후킹…","highlights":[{"start":7,"end":9}],"highlight_unit":"codepoint",
   "origin":"first_party","status":"active","author":"user:sagae","sensitivity":"internal","recorded_at":"2026-10-31T02:00:00Z"},
  {"id":"e:platform:youtube-shorts","kind":"entity","type":"Platform","title":"YouTube Shorts","snippet":"YouTube Shorts","highlights":[{"start":8,"end":14}],"highlight_unit":"codepoint",
   "origin":"external","status":"active","liveness":"active"},
  {"id":"n-3fa9c01b77aa12ef:1204","kind":"passage","type":"Snapshot","title":"Commands","snippet":"…/ultraplan Removed in v2.1.222…","highlights":[{"start":1,"end":11}],"highlight_unit":"codepoint",
   "origin":"external","status":"active","snapshot_id":"n-3fa9c01b77aa12ef","start":1204,"end":1234,"source":{"id":"src:cc-docs","label":"Claude Code 문서"}}]},
 "page":{"next_cursor":null,"total":12,"truncated":false}}
```

항목은 `SearchHit`이고 `kind` 값마다 3장의 변형이다. `claim`은 `subject`로 주어를 준다. `passage`는 `snapshot_id`, `start`, `end`(표시 본문 코드포인트)로 원문에 바로 이동한다. 이 항목의 `id`는 `<snapshot_id>:<start>`이고 노드 ID가 아니며 중복 제거에만 쓴다. 공개 ID 패턴(2.10)에도 맞지만 `/v1/nodes/{id}`, `/v1/claims/{id}`, `/v1/snapshots/{id}`에 넣지 않는다. 넣으면 404다. 원문으로 가는 값은 `snapshot_id`, `start`, `end`다. 다른 `kind`의 `id`는 노드 ID다.

**접두어 일치는 없다.** 토큰 전체 일치다. 한글은 bigram 색인이라 두 글자 이상이면 어절 앞부분도 맞지만 라틴 이름은 단어 전체를 입력해야 맞는다. 입력 중인 이름은 4.4의 `filter=label:prefix:`로 찾는다.

`highlights`는 `snippet` 문자열 기준 코드포인트 오프셋이다. 어휘 경로의 처리: 한글 문자 bigram, 3음절 이하 어절의 첫 음절, 숫자 구분 기호 제거, 식별자 결합형, 별칭 확장, AND 후 OR. 두 글자 단어(`채널`, `광고`), 3음절 이하 어절의 한 음절 단어(`훅`, `앱`, `훅을`), 숫자 표기(`8,000`과 `8000`), 표기 변이(`숏츠`, `쇼츠`)를 찾는다(ADR F5). `훅에서는`처럼 4음절 이상 어절 속의 한 음절 단어는 찾지 못한다. Ko-StrategyQA nDCG@10 0.592, 빈 결과 0이다.

### 4.9 `GET /v1/facets`, `GET /v1/counts`

`/v1/facets`는 검색·필터와 같은 인자를 받고 필터 적용 상태의 개수를 준다. `q`가 있으면 전체 일치에서 센다. `total`은 모든 필터를 건 개수이고 항상 정수다. 각 축의 값별 개수는 그 축의 필터만 뺀 나머지 필터로 센다. 그래서 축 합이 `total`과 다를 수 있고 다중 선택 UI를 바로 구동한다. `domain` 축은 값마다 세므로 합이 `total`보다 클 수 있고 도메인 없는 노드는 `none`으로 센다. `source` 축의 값은 필터 `source`에 그대로 넣는다.

```json
{"data":{"total":1834,"facets":{"type":[{"value":"Feature","count":812}],"origin":[{"value":"external","count":1800}],"status":[{"value":"active","count":1700}],"source":[{"value":"src:cc-docs","label":"Claude Code 문서","count":420}],"domain":[{"value":"G","count":1500}]}}}
```

`/v1/counts`는 `bucket`(`day`, `week`, `month`), `field`(`recorded_at`, `valid_from`), 공통 필터를 받는다. loupe v1은 부르지 않는다.

```json
{"data":{"bucket":"week","field":"recorded_at","series":[{"start":"2026-10-26T00:00:00Z","count":812}]}}
```

KB가 내는 집계는 개수와 분포까지다. 레이아웃, 커뮤니티, 중심성은 도구가 계산한다.

### 4.10 `GET /v1/series/{id}`

`from`, `to`(RFC 3339 또는 `YYYY-MM-DD`), `bucket`(`day`, `week`, `month`), `as_of_*`. `bucket`을 주면 버킷마다 마지막 점 하나를 주고 평균이나 합을 내지 않는다. 공백 구간을 함께 준다.

```json
{"data":{"id":"s:kworb-yt-daily-kr","metric":"chart_rank","unit":"rank",
  "points":[{"period":"2026-10-26","start":"2026-10-26T00:00:00Z","end":"2026-10-27T00:00:00Z","value":"1","observed_at":"2026-10-27T03:00:00Z","last_seen_at":"2026-10-30T03:00:00Z","snapshot_id":"n-..."}],
  "gaps":[{"from":"2026-09-01T00:00:00Z","to":"2026-09-03T00:00:00Z","reason":"machine_off"}]}}
```

### 4.11 `GET /v1/snapshots/{id}`

```json
{"data":{"id":"n-3fa9c01b77aa12ef","url":"https://code.claude.com/docs/en/commands.md","final_url":"https://code.claude.com/docs/en/commands.md",
  "source":{"id":"src:cc-docs","label":"Claude Code 문서","trust":"primary"},
  "fetched_at":"2026-10-31T01:00:00Z","http_status":200,"content_type":"text/markdown; charset=utf-8",
  "raw_sha256":"ab12...","text_sha256":"cd34...","text_format":"markdown","text_chars":48211,"extractor":"passthrough-nfc@1",
  "citing_claims":[{"id":"c-8k2p4q7m1xab","start":1204,"end":1234}]}}
```

`/text`는 봉투 안 `data`로 `SnapshotText`를 주고 `start`, `max_chars`(기본 20,000, 최대 200,000)로 나눈다. 단위는 코드포인트다. `end`가 `total_chars`보다 작으면 이어 읽는다. `/raw`는 원본 바이트와 원 `Content-Type`을 그대로 주고 봉투가 없고 `Range`를 지원한다. 캡처 HTML이 열린 출처에서 돌지 않게 `Content-Disposition: attachment; filename="<id>"`, `X-Content-Type-Options: nosniff`를 항상 붙인다. 본문이 삭제되면 둘 다 410 `content_removed`다. `citing_claims`는 시간이 지나며 늘 수 있다.

**본문 형식.** 원본은 받은 바이트 그대로다. 표시 본문은 NFC로 고정하고 `text_format`으로 구분한다. `markdown`, `text`, JSON 소스의 정규화 JSON은 `json`, PDF 추출 텍스트는 `pdf_text`다. 이미지 위주 PDF는 표시 본문이 없어 `text_chars=0`이고 `/text`는 404 `not_found`다. `raw`를 표시할 때 도구는 비신뢰 HTML로 다룬다.

### 4.12 `GET /v1/changes`

`cursor`, `limit`(기본 500, 최대 5,000), `kinds`, `origin`(`external`, `first_party`, `system`). `cursor`를 생략하면 seq 0부터 준다. 꼬리부터 받으려면 `/v1/meta`의 `changes_cursor`로, export 뒤에는 manifest의 `changes_cursor`로 시작한다.

```json
{"data":{"items":[{"seq":183421,"at":"2026-10-31T09:12:02Z","kind":"visibility.revoked","id":"f-01JC8ZQ3T9XYZ"},
  {"seq":183422,"at":"2026-10-31T09:12:03Z","kind":"claim.assert","id":"c-8k2p4q7m1xab","version":1,"type":"Claim","origin":"external"}]},
 "page":{"next_cursor":"eyJlIjoxLCJzIjoxODM0MjJ9","total":null,"truncated":false}}
```

- 커서는 불투명이고 `epoch`과 원장 `seq`만 담는다. 필터 해시가 없어 `/v1/meta`, manifest의 커서를 어떤 `kinds`, `origin`과도 쓸 수 있고 필터를 바꿔도 `cursor_mismatch`가 아니다. 단조 증가하고 재구축으로 깨지지 않는다. 기한 만료가 없다.
- `next_cursor`는 꼬리에서도 항상 문자열이다. 새 항목이 없으면 같은 커서를 돌려준다.
- 본문을 싣지 않는다. 필요하면 단건 조회를 한다.
- 민감도로 숨긴 이벤트는 건너뛴다. `seq`에 구멍이 있어도 정상이다.
- 민감도가 오르면 모든 범위에 본문 없는 `visibility.revoked` 항목이 원 이벤트와 같은 `seq`로 나온다. `kinds`, `origin` 필터와 무관하게 항상 나온다. 같은 `seq`의 행은 한 쪽에 함께 나가므로 `limit`을 1행 넘을 수 있다. 소비자는 그 ID의 사본을 지운다. export 사본은 다음 게시에서 빠진다.
- 주어 판정으로 `status`가 바뀐 주장은 개별 항목이 없다. `survival.verdict` 항목의 `id`로 다시 읽는다.
- 시계열은 묶음 단위(`series.batch`)로 나타난다.
- `epoch`이 바뀌었거나 커서의 `seq`가 현재 `applied_seq`보다 크면 410 `epoch_changed`이고 export로 재동기화한다. 30~60초 폴링을 가정한다. 푸시는 없다.

### 4.13 `GET /v1/ops/*`

추가 요구 9의 답이다. 읽기 범위에 넣고 지식 검색과 분리한다. 값만 내고 판단을 내지 않는다. `[잠정]`

| 경로 | 내용 |
|---|---|
| `/v1/ops/freshness` | 클래스별, 소스별 마지막 성공, stale 여부, 공백 |
| `/v1/ops/tickets` | 요청 큐. `status`, `cursor` |
| `/v1/ops/runs` | 실행 기록. 작업, 시각, 결과 |
| `/v1/ops/metrics` | 수율, 토큰, 실패, 신선도 지표 |

이 경로들은 `ETag`가 없고 `as_of_*`를 받지 않는다. `ops.db`가 없으면 빈 값과 `degraded`를 준다. 목록의 `limit`은 기본 100, 최대 500이다. loupe v1은 부르지 않고 loupe 때문에 앞당기지 않는다.

### 4.14 `GET /v1/claims/{id}`, `GET /v1/edges/{id}`

출처 화면과 선택한 엣지의 근거에 쓴다. 다른 종류의 ID는 404다. `versions`는 그 ID의 버전 행을 `version` 오름차순으로 주고 민감도가 오른 ID의 옛 버전은 숨긴다. id 직접 조회라서 `superseded`, `dead`, 검증 전 주장도 응답한다(2.7).

```json
{"data":{"id":"c-8k2p4q7m1xab","type":"Claim","label":"/ultraplan은 2.1.222에서 제거됐다.","statement":"/ultraplan은 2.1.222에서 제거됐다.","subject":"e:feature:claude-code-ultraplan","predicate":"removed_in","value":"2.1.222","unit":"version","kind":"event","stance":"stated","method":"llm","status":"active","verification":"quote_found","origin":"external","sensitivity":"public","version":1,"recorded_at":"2026-10-31T01:02:03Z",
  "evidence":[{"id":"ev-2m9x4k7q1cab","snapshot_id":"n-3fa9c01b77aa12ef","selector_kind":"text_quote","exact":"/ultraplan Removed in v2.1.222","prefix":"| ","suffix":" |","start":1204,"end":1234,"json_pointer":null,"evidence_state":"live","support_check":null,"last_confirmed_at":"2026-10-31T01:02:03Z"}],
  "versions":[{"id":"c-8k2p4q7m1xab","type":"Claim","label":"/ultraplan은 2.1.222에서 제거됐다.","statement":"/ultraplan은 2.1.222에서 제거됐다.","subject":"e:feature:claude-code-ultraplan","kind":"event","stance":"stated","method":"llm","status":"active","origin":"external","sensitivity":"public","version":1,"recorded_at":"2026-10-31T01:02:03Z"}]}}
```

`/v1/edges/{id}`의 `claim_id`는 사실 투영 엣지의 근거 주장이고 `claim`은 그 `Claim`이다. 구조 엣지는 둘 다 `null`이다. 엣지 민감도는 근거 주장 민감도를 포함하므로 보이는 엣지의 `claim`은 숨겨지지 않는다.

```json
{"data":{"id":"r-1a2b3c4d5e6f","src":"e:feature:claude-code-hooks","dst":"e:product:claude-code","rtype":"PART_OF","status":"active","sensitivity":"public","version":1,"claim_id":null,"recorded_at":"2026-10-31T01:00:00Z","expired_at":null,
  "versions":[{"id":"r-1a2b3c4d5e6f","src":"e:feature:claude-code-hooks","dst":"e:product:claude-code","rtype":"PART_OF","status":"active","sensitivity":"public","version":1}],
  "claim":null}}
```

## 5. 스냅샷 export

전체 그래프 입력이다. 중심성과 커뮤니티 계산에 쓴다. 민감도 `internal` 이하 필터가 적용된 파일이고, 라이브 DB가 아니라 게시 파일에서 나가므로 적재를 막지 않는다. loupe는 `core`만 쓰고 레이아웃의 유일한 전체 입력이다. 과거 시점 입력은 v1에 없다.

`GET /v1/export/graph/manifest`:

```json
{"data":{"build_id":"p-000183422","applied_seq":183422,"epoch":1,"generated_at":"2026-10-31T09:15:00Z",
  "changes_cursor":"eyJlIjoxLCJzIjoxODM0MjJ9",
  "profiles":{"core":{"path":"/v1/export/graph?profile=core","bytes":612345,"sha256":"...","nodes":48213,"edges":176402},
              "full":{"path":"/v1/export/graph?profile=full","bytes":3212345,"sha256":"...","nodes":240000,"edges":812004}}}}
```

`GET /v1/export/graph?profile=core`는 `Content-Type: application/zstd`인 파일이고 봉투와 `Content-Encoding`이 없다. `fetch`의 자동 해제가 걸리지 않으므로 소비자가 `zlib.zstdDecompress`로 푼다(Node v26.13에서 확인). 소비자 프록시를 지나는 전송은 sagae-tools 측 값으로 두 표기 모두 통과했다(N=1). manifest의 `sha256`, `bytes`는 전송 바이트(압축본) 기준이다. 첫 게시 전에는 manifest와 파일 모두 503 `not_ready`이고 `Retry-After`를 준다.

**`g-`와 `p-`.** 봉투의 `build_id`(`g-`)는 gold 빌드이고 manifest와 파일의 `build_id`(`p-<applied_seq 9자리>`)는 게시 판이다. 둘은 `applied_seq`로 잇는다. 게시는 최소 5분 간격이라 manifest의 `applied_seq`가 봉투 값보다 낮을 수 있다. 소비자는 manifest의 `applied_seq`, `changes_cursor`로 잇고 두 ID를 문자열로 비교하지 않는다.

```json
{"schema_version":"0.3.1","build_id":"p-000183422","applied_seq":183422,"epoch":1,"data_as_of":"2026-10-31T09:12:03Z","graph":{"directed":true,"multi":true},
 "nodes":{"columns":["id","type","label","origin","status","domain","merged_into"],"rows":[["e:product:claude-code","Product","Claude Code","external","active",["G"],null]]},
 "edges":{"columns":["id","src","dst","rtype","status"],"rows":[["r-1a2b3c4d5e6f","e:feature:claude-code-hooks","e:product:claude-code","PART_OF","active"]]}}
```

| 프로필 | 노드 `group` | 엣지 `group` | 포함 규칙 |
|---|---|---|---|
| `core` | `world`, `user`, 그리고 `fact`의 `Series` 타입만 | `structure`, `user`, `change`, `fact` | `status=active`만. 유효축을 걸지 않는다. 병합 노드를 빼고 엣지 끝점을 `merged_into_final`로 바꾼다. `needs_review`, `unverified` 주장의 사실 투영 엣지를 뺀다 |
| `full` | 전부 | 전부 | 세 상태 전부. 병합 노드 포함(`merged_into` 컬럼). `needs_review`, `unverified` 주장을 뺀다. v1 소비자는 쓰지 않는다 |

`Series`는 타입이고 그룹은 `fact`다. `Claim`은 `core`에 없다. 양끝이 프로필 안에 없는 엣지는 뺀다. 허공 엣지가 없다. 노드 `group`, 엣지 `group`은 `/v1/schema`와 같은 값이다. `domain` 셀은 배열이고 엣지 `status` 열은 대체 엣지를 가른다.

`core`는 `overview_types` 밖의 세계 타입(`Repo`, `Keyword` 등)도 담는다. Keyword 경로를 켜면 `Keyword` 5만~10만 노드가 늘어 `core`의 전송량이 커진다. 이번 판은 `profile` 값을 `core`, `full`로 두고, WP-24가 그 전에 `types` 파라미터나 별도 프로필을 검토한다(둘 다 호환 변경이다).

게시는 변경이 있을 때 최소 5분 간격이다. manifest의 `changes_cursor`로 `/v1/changes`를 이어 받아 증분으로 맞춘다.

## 6. 쓰기 경로

가시화 도구는 읽기 전용이다. first_party 입력 창구는 KB 쪽에서 설계했다.

| 통로 | 대상 | 형식 |
|---|---|---|
| MCP `kb_put` | Claude Code 세션 | 6.1 |
| MCP `kb_request`, CLI `kb request` | 없는 정보 요청, 외부 사실 제보 | `{topic, reason, priority, url?}` → `{ticket, status, duplicates}` |
| `kb put -f record.json` | 스크립트, 사람 | 6.1과 같은 JSON |
| `~/sagae-kb-data/inbox/*.md` | 사람 | Markdown + YAML 머리말. 6.2 |
| `kb ingest submit`, `kb-collect` MCP | 수집 에이전트, 스크립트 | 적재 계약 `kb-ingest/1`(ADR 9장). `record`는 사람 경로만 |
| HTTP 쓰기 | 없음 | v1에 없다. 도구가 쓰기가 필요해지면 협의한다 |

### 6.1 `kb_put`

```json
{"record":{"type":"Decision","title":"채널 첫 시리즈 주제","body":"...","body_format":"markdown","sensitivity":"internal",
           "props":{"status":"accepted"},"links":[{"rtype":"LINKS_TO","dst":"e:product:claude-code"}]},
 "idempotency_key":"sess-7f3a-0001"}
```

| 필드 | 규칙 |
|---|---|
| `idempotency_key` | 필수. 같은 키의 재시도는 첫 응답을 돌려준다. 기한이 없다. 키가 같고 내용이 다르면 거부한다 |
| `record.type` | 선택. 없으면 `Record`. 모르는 타입도 받는다 |
| `record.id` + `record.expected_version` | 기존 레코드 갱신. `expected_version` 필수. 다르면 `version_conflict`와 현재 버전 |
| `record.sensitivity` | 기본 `internal`. 비밀 패턴이 탐지되면 서버가 `secret`으로 올리고 알린다 |
| 외부 사실 | `kb_put`은 first_party 전용이다. `source_url`, `quote`는 스키마 오류다. 외부 사실은 `kb_request`의 `url`로 제보한다. 티켓이 되고 수집 경로의 게이트를 지난다 |
| `author` | 입력에 없다. 서버가 전송 계층에서 정한다. MCP의 귀속 단위는 세션이 아니라 서버 프로세스이고 tower 뒤에서는 `agent:tower`다(ADR 7.8) |
| `record.props.session` | 선택. 세션 자기 신고 표시값이다. 작성자, 민감도, 멱등 판정에 쓰지 않는다 |
| 세션 조사 자료 | 타입 `Artifact`로 낸다. 내부 주소, 호스트·노드 이름, 토큰 권한 목록을 뺀 뒤 낸다. 문서의 외부 사실은 `kb_request`의 `url`로 보낸다. 세션 서술은 주장이 되지 않는다(ADR 7.8) |

```json
{"id":"f-01JC8ZQ3T9XYZ","version":1,"seq":183423,"replayed":false,"projected":true,"spooled":false,"held":false,"warnings":[],"reason":null}
```

| 응답 필드 | 뜻 |
|---|---|
| `held: true` | 머신 밖 경로(외장 SSD E: 전송과 복원 훈련) 완료 전이다. E:가 마운트돼 있지 않아도 같다. 내구 스풀에 보관했고 개방되면 적재된다. 아직 조회되지 않는다 |
| `spooled: true` | 원장을 잠시 못 열었다. 내구 스풀에 남겼고 다음 tick이 적재한다 |
| `projected: false` | 원장에는 커밋됐고 조회 반영만 늦다 |
| `warnings` | 호출자 경고. 비밀 탐지로 `secret`이 됐을 때 등 |
| `reason` | `held`, `spooled`의 이유. 예: `offsite_path_missing` |

### 6.2 inbox 파일

```markdown
---
id: f-01JC8ZQ3T9XYZ        # 갱신일 때만. 새 기록은 생략
base_version: 3            # 갱신일 때
type: Note
title: 쇼츠 후킹 메모
sensitivity: internal
links: [e:platform:youtube-shorts]
---
본문은 Markdown이다. [[e:product:claude-code]]는 LINKS_TO 엣지가 된다.
```

30초 이상 수정이 없는 파일만 읽는다. 처리 후 `inbox/.done/<날짜>/`로 옮긴다. 파일을 지워도 레코드가 지워지지 않는다. `base_version`이 어긋나면 덮어쓰지 않고 충돌 기록을 남긴다. 작성자는 `user:sagae`다.

### 6.3 first_party 표시

| 항목 | 계약 |
|---|---|
| 본문 형식 | `body_format=markdown`. `include=body`로 받고 긴 본문은 `/v1/nodes/{id}/body`로 나눠 읽는다 |
| 작성자 | `author`: `user:sagae` 또는 `agent:<세션>`. `on_behalf_of`, `generated_by` |
| 버전 | `version`, `/history` |
| 노트 링크 | `[[...]]`와 `links`는 `LINKS_TO` 엣지다. `include=backlinks`로 역방향을 `Backlink` 항목으로 받는다 |
| Notion식 페이지 | 페이지 수준 링크와 백링크가 된다. 블록 수준 링크는 v1에 없고 소비자도 필요 없다고 답했다 |

### 6.4 멱등과 버전 이력

- 모든 쓰기는 원장 이벤트다. 이력은 버전 행으로 남고 물리 삭제는 `record.redact`뿐이다.
- 타입 미정 레코드는 나중에 타입을 정의하면 된다. 옛 레코드는 그대로 유효하다.
- first_party 쓰기가 열리기 전에도 계약과 검증은 그대로 동작한다.

## 7. 보안

| 항목 | 규칙 |
|---|---|
| Host | 자체 ASGI 미들웨어. 허용 목록은 설정값이고 기본은 `127.0.0.1`, `localhost`다. 원격 이전 때 호스트를 더한다. 불일치는 403 `host_rejected` problem+json이다 |
| CORS | 없다. 와일드카드 금지. 뷰어 백엔드가 호출한다 |
| 인증 | Unix 소켓은 파일 권한이고 토큰이 없다. 범위는 `internal` 이하다(2.8). TCP는 Bearer 필수. `.wslconfig`의 `networkingMode=Mirrored`로 Windows에서 루프백이 보일 수 있어 로컬이라도 토큰을 요구한다 |
| 토큰 범위 | `viewer`(`internal` 이하), `owner`(`private` 이하). `kb token create`로 만들고 파일은 `~/.config/sagae-kb/api-tokens`(0600)다. 전달은 `Authorization: Bearer`다. loupe는 TCP일 때만 `viewer` 토큰을 쓴다. 쓰기 범위는 쓰기 경로를 열 때 정한다 |
| 쓰기 메서드 | 기본 없음 |
| 비신뢰 내용 | 본문과 `raw`는 외부 데이터다. 표시할 때 실행하지 않는다. `/raw`는 내려받기로만 나간다(4.11) |

## 8. 버전 정책

| 항목 | 규칙 |
|---|---|
| URL | `/v1`. 호환이 깨지면 `/v2`를 열고 `/v1`을 유예 기간 유지한다 |
| `schema_version` | `0.x`. 0.x 안에서는 변경 전에 sagae-tools 세션에 알리고 깨질 수 있다. WP-11 양쪽 계약 시험이 통과하면 `1.0.0` |
| 호환 변경 | 필드 추가, 새 엔드포인트, 새 쿼리 파라미터, 새 열, 새 열린 값, 새 `degraded` 값 |
| 파괴 변경 | 필드 삭제·이름 변경, 형 변경, `required` 완화, 닫힌 enum 변경, 정렬·기본 필터 변경, 쿼리 파라미터 제거, 오프셋 단위 변경 |
| 파괴 변경 절차 | major 올림, `docs/contracts/CHANGELOG.md`, sagae-tools 세션 통지 |
| 소비자 의무 | 모르는 필드와 열린 값을 무시한다 |
| 호환성 검사 | `docs/contracts/baseline/openapi.yaml`을 기준으로 `oasdiff breaking --fail-on ERR`, Schemathesis, fixture 왕복. 기준선이 없으면 실패이고 조용히 건너뛰지 않는다. 기준선을 올리는 것은 소비자 통지 뒤의 명시 절차다. 저장소 커밋에 기대지 않는다 |

## 9. fixture와 계약 테스트

**fixture.** KB가 소유하고 `docs/contracts/fixtures/`에 둔다. 저널 조각(`ledger.ndjson`)과 CAS 객체(`cas/`의 표시 본문, 문단 목록, 시계열 묶음)에서 생성해 fixture 자체가 재생 시험이 된다. 요청별 응답 JSON을 함께 둔다. `build_id`는 재생 입력의 해시이고 시각과 as-of는 요청에 고정해 결정적이다. `held`는 원장에 없으므로 `mcp/`의 `kb_put` 응답으로 둔다. 규칙: 4장의 경로마다 성공 1건, 오류 1건 이상이고 `openapi.yaml`의 `examples` ID가 fixture에 있다.

| 사례 | 내용 |
|---|---|
| 대체 체인 | 결정적 주장 3세대 |
| 소급 정정 | 유효 시점과 관측 시점이 어긋나는 행 |
| 미래 발효 대체 | 효력일 전 두 주장 `active`, `as_of_valid`로 값 하나 |
| dead, superseded | 주어 판정으로 `status`가 바뀐 `state`, 유지되는 `event`, 판정 전 as-of |
| 번복 | `revived` |
| 병합 | `merged_into`, 연쇄 병합의 `merged_into_final`, 옛 id 조회, 최종 대상의 묶음 |
| 한글 본문 | 조사, 한 음절 단어, 숫자 표기 |
| 인용 위치 | 이모지 뒤 코드포인트 오프셋, NFD 입력 |
| 숨김 | `private`, `secret` 레코드의 404, 민감도 상향과 `visibility.revoked` |
| 평행 엣지 | 같은 양끝의 두 관계 |
| 빈 검색 결과 | |
| 커서 | `cursor_mismatch`, `epoch_changed`, export 뒤 `changes_cursor`로 이어 받기, 꼬리의 문자열 커서 |
| 조건부 GET과 경계 | 304, 경로 구분별 `Cache-Control`, `as_of_unsupported`, `truncated=true`, `total=null`, 개요 커서 |
| 파라미터 | 모르는 파라미터 400 `bad_param`, `filter` 복수 AND, 값 안의 `:`, `in` 이스케이프, `sort` 내림차순과 동률 |
| 노드 ID 종류 | `/v1/nodes/{id}`에 `e:`, `c-`, `n-`, `f-`, `s:`, `src:`, `t-`, `d-`, `r-` 404. `ids=`의 숨김, 없는 ID, 병합 ID |
| 검색 항목 | `kind` 네 종류, `passage`의 `id` |
| 집계와 메타 | `/v1/facets`, `/v1/counts`, `/v1/schema`, `/v1/meta`, `/v1/ops/*` |
| 시계열 | 재공시, 공백 구간 |
| first_party | Markdown, 작성자, 버전, 백링크. `held`는 `mcp/` fixture |

**양쪽 시험.**

| 쪽 | 시험 | 도구 |
|---|---|---|
| KB | 응답을 스키마로 검증 | Schemathesis 4.32.7, `tests/contract/` |
| KB | 파괴 변경 차단 | oasdiff 1.35.0 |
| KB | fixture 왕복. 저널 조각 + CAS 재생 결과 = 저장된 응답 | pytest |
| 도구 | fixture로 어댑터 검증 | `docs/contracts/consumer-kit/`의 Node 26 패키지(ajv, yaml 고정) + 생성 타입 |
| 도구 | 타입 생성 | Orval 8.46.0. KB도 WP-23, WP-11에서 같은 판으로 생성 시험을 돈다 |

## 10. 소비자 요구 매핑

`docs/contracts/consumers/sagae-tools.md`의 항목을 하나씩 대응시켰다. 2차 회신의 항목별 처리는 응답표다.

### 10.1 런타임과 접근

| 요구 | 계약 | 상태 |
|---|---|---|
| 서버 런타임 TypeScript + Node 26 | 1장. KB는 HTTP로 경계를 둔다. `bun:sqlite` 의존 없음 | 충족 |
| 로컬과 원격에서 도구를 고치지 않는 경계 | 1장 기준 URL | 충족 |
| 1순위 버전 붙은 HTTP JSON | `/v1` | 충족 |
| 보조 스냅샷 export | 5장 | 충족 |
| 대안 같은 JSON의 CLI | `kb api` | 충족. loupe는 쓰지 않는다 |
| MCP를 UI 경로로 쓰지 않음, 코어 공유 | `kb.read` 하나 | 충족 |
| 읽기 전용 DB 파일 직접 접근 원치 않음 | 제공 안 함 | 충족 |
| 독립 관제 서버 선택지 | tower는 KB HTTP를 쓰지 않고 KB MCP를 stdio 자식으로 띄운다. HTTP 소비자는 `loupe serve`이고 KB가 소켓 활성화 HTTP를 직접 낸다 | 충족 |

### 10.2 화면별 조회

| 조회 | 경로 | 상태 |
|---|---|---|
| 그래프 개요 | `/v1/overview` | 충족. 기본 타입은 `overview_types`, 기본 상한 5만·20만, 넘으면 커서 |
| 이웃 확장(깊이 1~2, 타입 필터, limit) | `/v1/nodes/{id}/neighbors` | 충족 |
| 엔티티 상세(현재 주장, 관계, 역방향) | `/v1/nodes/{id}`, `/claims`, `/edges` | 충족. 허브는 묶음별 `truncated`와 커서로 이어 받는다 |
| 표 보기(서버측 정렬·필터·커서) | `/v1/nodes` | 충족. 정렬·필터 키는 허용 목록 |
| 전문검색(필터, 스니펫, 하이라이트, 한국어) | `/v1/search` | 충족. 접두어 일치는 4.4 `filter` |
| 필터·패싯 | `/v1/facets` | 충족 |
| 시점 지정 공통 파라미터 | 2.9 | 부분 충족. 적용하지 않는 경로와 이유를 2.9에 적었다 |
| 시계열(엔티티·속성별 대체 체인, 두 시간축) | `/history`의 `versions`, `chains`, `predicate`, `/v1/series/{id}` | 충족 |
| 출처 원문(본문, 메타, 인용 위치) | `/v1/snapshots/{id}`, `/text`, `/raw` | 충족 |
| 변경 내역 | `/v1/changes` | 충족 |
| 스키마 자기기술 | `/v1/schema` | 충족 |

### 10.3 규모와 지연, 쓰기, 집계, 계약 관리

| 요구 | 계약 | 상태 |
|---|---|---|
| 개요 1만·5만, 이웃 200 | `limit` 기본 50,000/200,000, 커서로 끝까지, 이웃 기본 200 | 충족. loupe가 `limit`, `edge_limit`, `types`를 직접 보낸다. 11장 |
| 상세·이웃·검색 p95 200 ms, 개요 2초 | 4장 웜 목표와 콜드 목표 | 프로토타입 근거 있음. WP-10 부하 시험이 추정 규모 상단과 콜드로 확정 |
| 폴링 30~60초 | `/v1/meta` 또는 `/v1/changes` + 304, 유휴 600초 | 충족 |
| 도구는 읽기 전용 | 6장 | 충족 |
| first_party 창구를 KB가 설계 | 6장 | 충족 |
| 쓰기가 필요해지면 KB 쓰기 API로 | v1에 없고 그때 협의한다 | 충족 |
| KB 제공: 개수·분포, 시간 구간 | `/v1/facets`, `/v1/counts` | 충족 |
| 도구 계산: 레이아웃, 커뮤니티, 중심성 | KB가 내지 않는다 | 충족 |
| 계약 원본, OpenAPI 3.1, fixture | `docs/contracts/`, 9장 | 충족 |
| 양쪽 계약 테스트, major 올림과 통지 | 8, 9장 | 충족 |
| 불변 ID, `merged_into` | 2.10 | 충족 |
| 커서 방식 | 2.4. 안정 보장은 `sort=id` | 충족 |

### 10.4 추가 요구 9건

| # | 요구 | 계약 | 상태 |
|---|---|---|---|
| 1 | `sensitivity`, 기본 숨김, superseded·dead 기본 제외 | 2.7, 2.8 | 충족 |
| 2 | 오프셋 기준과 단위, 코드포인트 + TextQuoteSelector | 2.11 | 충족 |
| 3 | 개요 `total`, `truncated`, 안정 정렬, 필수 필터 | 4.3. 필수 필터는 없고 `truncated`, 커서, 필터로 다룬다 | 충족 |
| 4 | 전체 그래프 입력 형식 | 5장 | 충족 |
| 5 | 봉투, 재빌드 중 읽기, 조건부 GET, RFC 9457, RFC 3339 | 2.1, 2.2, 2.3, 2.5, 2.6 | 충족 |
| 6 | 읽기와 적재 격리, 파일 대체 경로는 게시 사본 | 코어는 스레드풀, 요청당 `mode=ro`, 읽기 상한 5초, 체크포인트는 `PASSIVE`. 파일 경로 자체를 제공하지 않고 export가 대신한다. KB 재확인: WAL DB는 읽기 전용 폴더의 `mode=ro`에서 실패, `immutable=1`은 라이브 DB에서 오류 없이 낡은 값(`general-db.md` M11). DuckDB는 쓰지 않는다. 3초 긴 읽기 중 쓰기 p99 87 ms(ADR F3) | 충족 |
| 7 | 한국어 검색은 KB 안에서 | 4.8. trigram을 쓰지 않는다 | 충족 |
| 8 | Host 검사, 와일드카드 CORS 금지, 인증 자리 | 7장 | 충족 |
| 9 | first_party 표시, 수집 신선도, 실행 지표, 요청 큐 | 6.3, 4.5, 4.13 | 충족. `body`, `backlinks` 형식이 있어 백링크와 페이지 수준 Notion식 구성이 된다. `/v1/ops/*`는 `[잠정]`. `private`은 11장 |

### 10.5 KB ADR 참고 실측 5건

모두 sagae-tools 측 실측이고 KB가 재현한 값으로 쓰지 않는다. 설계 반영만 적는다.

| # | 내용 | 반영 |
|---|---|---|
| 1 | 언어 제약 | Python stdio MCP 서버 하나를 쓴다. 관제 서버는 같은 명령을 자식 프로세스로 띄운다 |
| 2 | `resource_link` 의존 금지 | 스냅샷 본문은 `kb_source(id)` 도구로 읽는다. 도구 결과에 `resource_link`를 넣지 않는다 |
| 3 | 리소스 URI 스킴 | `kb://snapshot/{id}`, `kb://node/{id}` |
| 4 | 기동 속도 | KB 측정 콜드 `initialize` 0.32초(ADR F10). 2초 이내를 시험으로 지킨다 |
| 5 | 동기 쿼리 격리 | MCP 도구는 동기 `def`로 스레드풀에서 돈다. HTTP 엔드포인트도 스레드풀이다. 프로세스 안 라이브러리를 내지 않는다. KB 측정: 400 ms 동기 도구 중 ping 1.5 ms, `async def` 안 블로킹은 352 ms(ADR F10) |

## 11. 맞추지 못한 항목과 사유

| 항목 | 사유 | 대안 |
|---|---|---|
| "모든 읽기"의 `as_of_*` | 불변 객체, 시간순 피드, 현재 운영값에는 의미가 없고, export는 게시 시점 파일이다 | 2.9의 표. 소비자가 수용했다 |
| 프로세스 안 라이브러리 | 코어가 Python이고 서버 런타임은 Node 26이다 | HTTP over Unix 소켓. 웜 p50 약 2 ms(프로토타입) |
| 실시간 푸시 | 소비자가 요구하지 않았다 | 폴링 |
| 개요 1만 노드 가정 | 추정 규모가 2만~5만이다. sagae-tools 측 값(합성 그래프, RTX 4080 SUPER, KB 재현 아님): 1만/5.1만은 렌더 예산 안, 2만/8만과 5만/20만은 예산 밖이고 렌더 값은 GPU 경합이 의심돼 재측정 예정이다 | `overview_types`로 좁힌 기본값, 소비자가 보내는 `limit=10000&edge_limit=50000`, 5장 `core`. 2만은 소비자가 고르는 보기다 |
| 검색 접두어 일치 | 색인이 전체 토큰이다(ADR 14.1) | 4.4의 `filter=label:prefix:` |
| v1 뷰어의 `private` 읽기 | `owner` 토큰은 TCP 전용이고 소비자는 소켓을 쓴다 | 결정 14 기본값 (c). 결정 전까지 소켓은 `internal` 이하다(2.8) |
| 도메인 A 키워드 데이터 | 결정 1의 답(Trends RSS, google.com 자동완성)을 WP-24가 구현하기 전까지 수집하지 않는다 | 스키마는 준비돼 있다. 구현 뒤 `Keyword`, `Series`가 늘어난다 |
| first_party 데이터 | 외장 SSD E: 전송과 복원 훈련 통과 전까지 그래프에 없다 | `/v1/meta.first_party_open`. fixture에는 있다 |

## 12. sagae-tools 질문의 답

| 질문 | 답 |
|---|---|
| 1. 예상 규모 | 추정이다. 1년차 엔티티 2만~5만, 주장 10만~30만(운영 상한 50만), 고유 스냅샷 2만~5만, 고유 문단 5만~15만, 엣지 50만~150만(근거 포함). 개요 기본 프로필 노드 2만~5만, 엣지 5만~20만. 키워드 경로를 켜면 `Keyword` 5만~10만, 시계열 점 연 200만이 더해진다. 산식은 ADR 부록 A다 |
| 2. 실행 위치, HTTP 제공 | 로컬 WSL2 ext4. 소켓 활성화 HTTP를 KB가 낸다. 상주 프로세스 0, 유휴 600초 종료. 유닛 설치는 사용자 승인 대상이다. 설치 전에는 `kb api` CLI. Proxmox로 옮기면 KB 전체를 옮기고 같은 계약을 TCP + Bearer로 낸다 |
| 3. 스냅샷 본문 형식 | 원본은 받은 바이트(HTML, Markdown, JSON, XML, PDF). 표시 본문은 NFC 고정이고 `text_format`이 `markdown`, `text`, `json`, `pdf_text`다. 인용 오프셋의 기준이다. 이미지 위주 PDF는 표시 본문이 없다. first_party는 Markdown이다 |
| 4. 구현 언어, 동시 읽기 | Python 3.14, 코어는 표준 라이브러리. 게이트웨이 프로세스 안에서 호출할 수 없다. HTTP 또는 CLI로 붙는다. 같은 호스트 다중 프로세스 동시 읽기는 안전하다. 네트워크 파일시스템과 읽기 전용 디렉터리는 지원하지 않고 파일 경로를 제공하지 않는다 |

## 13. 합의 상태

2차 회신의 13장 답 9건과 공백 16~20의 결과다. 번호는 회신 번호이고 항목별 이유는 응답표다.

| # | 항목 | 합의 | 절 |
|---|---|---|---|
| 1 | 소켓과 TCP | Unix 소켓 기본. HTTP 소비자는 `loupe serve`이고 tower는 KB HTTP를 쓰지 않는다. TCP 8737은 v1에서 쓰지 않는다 | 1장 |
| 2 | `/v1/ops/*` | `[잠정]` 유지. loupe v1은 부르지 않고 앞당기지 않는다. 프록시가 무인증 4812로 내지 않는다 | 4.13 |
| 3 | `total` | `page.total`의 `null`은 `/v1/search` 기본 경로와 `/v1/changes`뿐이다. `node_total`, `edge_total`, `/v1/facets`의 `total`은 `null`이 없다 | 2.4, 4.3, 4.6, 4.9 |
| 4 | 동시 상한과 429 | 기본 16, 하한 12. 429에 `Retry-After`가 항상 있다. loupe는 일괄 확인을 동시 4개로 묶는다 | 2.3 |
| 5 | 개요 기본 타입 | 목록을 `/v1/schema`의 `overview_types`로 낸다. `Series`는 기본에 남는다. KB가 1차 수집 뒤 실제 `count`로 조정한다 | 4.2, 4.3 |
| 6 | export 프로필, 과거 입력 | loupe는 `core`만 쓴다. 과거 시점 입력은 v1에 없다 | 2.9, 5장 |
| 7 | 블록 링크 | v1에 없다. 페이지 수준이면 된다 | 6.3 |
| 8 | 토큰 | 소켓은 토큰 없음. TCP와 원격은 mode 600 파일 + `Authorization: Bearer`. loupe는 TCP일 때만 `viewer` 토큰을 쓴다 | 7장 |
| 9 | 지연 목표 | 웜 p95 200 ms, 개요 2초를 유지하고 콜드 행을 따로 둔다. WP-10이 추정 규모로 잰다 | 4장 |
| 공백 13 | 민감도 범위 | 결정 14 기본값 (c). 결정 전까지 소켓은 `internal` 이하다. (c)를 바꾸려면 KB가 먼저 알린다 | 2.8 |
| 공백 16~20 | tower와 MCP | ADR의 결정대로다. 귀속은 서버 프로세스이고 `f:agent:tower`다. 종료 전송은 신호와 EOF가 같은 함수를 부르고 다른 세션은 15분 tick이다. 자식은 호출마다 `current`를 연다. `cur`는 2.4 커서다. `kb-mcp` 상한은 `internal`이고 `kb_put`, `kb_request`는 호출마다 확인이다. 항목별 문장은 응답표다 | 6.1, 2.4, ADR 7.8, 7.9, 15.1, 15.2, 15.4 |

남은 일은 둘이다. WP-23이 `openapi.yaml` 초안을 WP-04, WP-05, WP-10 전에 낸다. 메인 세션이 0.3.0의 파괴 변경과 응답표를 sagae-tools 세션에 전달하고 확인을 받는다.

**3차 회신(0.3.1).** 파괴 변경 7건은 수용됐다. 보완 7건과 확인 a~f는 파괴 변경 없이 처리했고 항목별 처리는 `docs/contracts/consumers/sagae-tools-reply-3-response.md`다. `docs/contracts/baseline/openapi.yaml`은 0.3.0 그대로이고 0.3.1은 호환 변경이라 기준선을 올리는 것은 소비자 통지 뒤의 명시 절차다.
