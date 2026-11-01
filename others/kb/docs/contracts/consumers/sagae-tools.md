# sagae-tools 소비자 요구사항 — 확정본

> 인용 표기: `LM:n` = `docs/design/loupe.md` 줄, `KB:n` = KB `docs/contracts/consumers/sagae-tools.md` 줄, `P:` = 2026-11-01 라이브 KB 프로브.

- 상태: 확정본. 사용자가 2026-11-01에 Phase 1 화면 배치를 수락했다. 이 문서가 KB:3이 약속한 "조사와 설계를 마친 뒤의 확정본"이다.
- 도구: **loupe**, KB 읽기 전용 뷰어(`tools/loupe`). 관제 서버 tower와 서로 의존하지 않는다(LM:4).
- 계약 기준: 0.3.1(LM:3). loupe는 KB의 `openapi.yaml`을 제자리에서 읽어 클라이언트를 생성하고 사본을 두지 않는다(LM:500-510).
- 실제 KB 실행 결과: 26개 GET 엔드포인트 중 JSON 22개가 스키마 통과, `snapshots/{id}/raw`와 `export/graph` 200, `nodes/{id}/body` 404(`first_party_open=false`), `series/{id}` 시험함, 결과 200(P).

## 런타임과 접근 (KB:7-33 대체)

- 브라우저는 같은 출처의 `kb/`만 호출한다. `loupe serve`(Node 26)가 KB Unix 소켓에 붙는다(LM:5). 소켓에는 토큰이 없고 TCP 8737은 v1에서 쓰지 않는다(LM:847).
- tower는 KB HTTP를 쓰지 않는다. KB MCP만 stdio 자식으로 띄운다(KB:33).
- 포트: dev 4810, kb-mock 4811, 설치본 4812(LM:28).
- 민감도: KB 기본값을 넓히지 않는다. loupe v1은 `private`를 읽지 않는다(LM:846).

## 엔드포인트 사용 (KB:35-49 대체)

### Phase 1에서 실제로 호출한다 (구현됨, kb-mock과 실제 KB에서 검증. LM:3, LM:717)

| 엔드포인트 | 용도 | 근거 |
|---|---|---|
| `GET /v1/meta` | 상태, `data_as_of`, `applied_seq`, `degraded`, `first_party_open`, 45 s 폴링 | LM:101, LM:461 |
| `GET /v1/schema` | 타입·술어 라벨, `sort_keys`, 카드 값 표시 | LM:108, LM:116 |
| `GET /v1/search?q=&kinds=entity,record&limit=12` | 팔레트. 150 ms 디바운스, NFC | LM:85 |
| `GET /v1/nodes?types=&limit=&sort=` | 시작 화면의 최근 기록 엔티티 | LM:100 |
| `GET /v1/nodes/{id}?include=claims,edges,backlinks,body&claim_limit=50&edge_limit=200` | 엔티티 페이지 | LM:98 |
| `GET /v1/nodes/{id}/claims`, `/edges` (커서 이어 읽기) | 주장·엣지 전체 | LM:98 |
| `GET /v1/nodes/{id}/neighbors` | `peer` 없는 엣지의 대비책 | LM:754 |
| `GET /v1/nodes/{id}/history` | 후속 주장 링크(`superseded_by`) | LM:117 |
| `GET /v1/nodes/{id}/body` | first_party 본문 창 읽기. **현재 404이므로 화면은 본문 없음으로 처리해야 한다** | LM:76, LM:835, P |
| `GET /v1/claims/{id}` | 근거와 버전 | LM:99 |
| `GET /v1/snapshots/{id}`, `/text?start=&max_chars=` | 출처 화면, 인용 확인 | LM:106 |
| `GET /v1/snapshots/{id}/raw` | 링크로만 연다(화면에 렌더하지 않음) | LM:545, P 200 |
| 조건부 GET (`ETag`, 304) | 개요·스키마·`/v1/meta` 재검증 | LM:120 |

공통: 시간을 받는 오퍼레이션에만 `as_of_valid`, `as_of_observed`를 싣는다. `/history`는 `as_of_*`를 400으로 거절한다(LM:104).

### Phase 2~4에서 호출한다 (미착수)

| 엔드포인트 | Phase | 근거 |
|---|---|---|
| `GET /v1/overview?limit=10000&edge_limit=50000` (+ `types`, `rtypes`, `domain`, `edge_status`) | 2 | LM:96, LM:124, LM:300 |
| `GET /v1/export/graph/manifest`, `GET /v1/export/graph?profile=core` | 2 (레이아웃 입력. 좌표는 브라우저에만 남고 KB에 쓰지 않는다) | LM:96, LM:6.2절(LM:306-387) |
| `GET /v1/nodes/{id}/neighbors?depth=&rtypes=&direction=&limit=&edge_limit=&edge_status=` | 2 | LM:97 |
| `GET /v1/nodes?type=&filter=&sort=&cursor=&limit=`, `GET /v1/facets` | 3 | LM:102 |
| `GET /v1/search` 전문검색 화면 | 3 | LM:103 |
| `GET /v1/series/{id}?from=&to=&bucket=` | 4 | LM:105, P 200 |
| `GET /v1/changes?cursor=&limit=&kinds=&origin=` | 4 (폴링은 `/v1/meta`의 `changes_cursor`) | LM:107, LM:461 |

### 쓰지 않는다
`/v1/ops/*`(`[잠정]`), `POST /v1/commands`, `GET /v1/nodes?ids=`와 `filter=label:prefix:`(계약에 있으나 코드가 쓰지 않음), TCP 8737(LM:845-849, LM:815, LM:88).

## 규모 (KB:51-57 대체. 목표치 → 측정치)

| 항목 | 값 | 근거 |
|---|---|---|
| 기본 개요 | 노드 1만, 엣지 5만 이하. loupe가 항상 명시해 보낸다 | LM:300 |
| 사용자 선택 보기 | 2만/10만. 경고 후 | LM:301 |
| 전체 그리기 불가 | 5만/20만 | LM:302 |
| 렌더 근거 | S5 렌더 행은 GPU 경합 의심으로 재측정 대기. 천장 15k/60k는 외삽이며 재지 않았다 | LM:303-304 |
| 지금 KB | `counts` 노드 1036, 엣지 2011, 주장 296. export `core` 1036/436, 22,761 B. `full` 3744/1848, 114,324 B (applied_seq 7934) | P |
| 폴링 | 45 s, 사용자 1명, 푸시 없음 | LM:461 |

지금 KB 규모는 기본 개요 상한의 약 1/10이므로 실제 데이터에서는 상한에 닿지 않는다(P). 개수는 15분 tick마다 움직이므로 위 값은 2026-11-01 시점 값이다(P).

## 읽기 전용·집계 (KB:59-69 유지)
쓰기 없음. KB는 개수·분포를, 도구는 레이아웃·커뮤니티 같은 파생값을 계산한다. 파생값은 KB에 되쓰지 않는다(LM:46, LM:6.2절 결정 문단).

## 열린 요청 (KB:130-136 대체)

| # | 요청 | 막는가 | 근거 |
|---|---|---|---|
| 1 | `as_of_valid` 형식을 `format`/`pattern`으로 확정. 지금은 제약 없는 문자열이라 빈 값이 유효 **완료(0.3.2)** | 아니오. Schemathesis 설정이 우회 | LM:822, KB:134 |
| 2 | `/v1/facets`의 `q`: 스펙은 필수, 산문 4.9는 선택 **완료(0.3.2)** | 아니오. loupe는 항상 보냄 | LM:823, KB:135 |
| 3 | 계약 12장 예상 주장 규모 갱신(29만~37만) **완료(0.3.2)** | 아니오 | KB:136 |
| 4 | S5 렌더 재측정 값. **Phase 2 착수 전에 별도 전달** **완료(2026-11-01 수신)** | Phase 2 | LM:824, LM:832 |
| 5 | 추정 규모 부하와 콜드 p95 시험 목표 | 아니오 | LM:811 |
| 6 | 소켓 민감도 범위(KB ADR 결정 14)와 `first_party_open=true` 전환 시 무인증 노출 결정 | 아니오(KB·사용자 결정) | LM:810, LM:834 |

KB 답으로 정한 항목: `/v1/meta` 개수를 규모의 기준으로 쓴다. `boot_path_unverified`는 참석 재부팅 시험 전까지 알림으로만 보인다(리드 전달 KB 확인. loupe 쪽은 LM:453).

## 확인 대기 (loupe 쪽)
- 실제 Orca 탭에서 돈 적이 없고 한글 IME, `target="_blank"`, 맑은 고딕, 클립보드는 손으로 확인해야 한다(LM:738, LM:768).
- loupe는 지금까지 kb-mock만으로 검증했다(LM:741). 실제 KB 26개 GET 프로브(P)는 계약 형태 확인이다. 화면 단위 검증이 아니다.

회신 기록: `docs/contracts/consumers/sagae-tools-reply-2.md`, `docs/contracts/consumers/sagae-tools-reply-3.md`.
