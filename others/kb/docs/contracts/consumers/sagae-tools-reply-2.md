# sagae-tools 계약 v0 2차 회신 원문

- 수신: 2026-10-31, `sagae-tools-0e` 세션.
- 대조 기준: 계약 sha256 `49fb5365…`, KB ADR sha256 `2e810894…`.
- 실제 KB로 돌린 것은 없다. 아래 측정과 재현은 모두 sagae-tools 측 값이고 KB 재현값이 아니다.

## 13장 답

1. 소켓과 TCP: 1차 회신 유지. Unix 소켓 기본이고 tower는 KB HTTP를 쓰지 않는다. 소비자는 `loupe serve`다. TCP 8737은 v1에서 쓰지 않는다.
2. `/v1/ops/*`: loupe v1은 부르지 않는다. `[잠정]`으로 두고 loupe 때문에 앞당기지 않아도 된다. 무인증 4812로 나가지 않게 프록시에서 막는다.
3. `total` null: `page.total`은 수용한다. `node_total`, `edge_total`은 null이면 안 된다. "N / total" 띠가 쓴다. `/v1/facets.total`도 null이면 안 된다. 패싯 화면이 쓴다.
4. 동시 상한과 429: 수용한다. 상한 12 이상(출처 2개 × 브라우저 연결 약 6개, 가정)과 429의 `Retry-After`를 요청한다. loupe는 일괄 확인을 동시 4개로 묶는다.
5. 개요 기본 타입: ADR 16은 개요 기본 상한을 5만 노드, 20만 엣지로 올리고 커서를 둔다. loupe는 그 기본값에 기대지 않는다. `limit=10000&edge_limit=50000`과 좁힌 `types`를 항상 보내고 `truncated=false`가 되게 타입을 줄인다. 초기안은 `Platform Product Feature Tool Model Org Concept Technique Policy`와 사용자 타입 전부다. `Repo Package Person Channel Video Keyword Metric`은 뺀다. `Series`는 ADR 7.3대로 KB 기본에 둔다. 실제 `count`로 조정하고 목록을 `/v1/schema`에 내 달라.
6. export 프로필, 과거 입력: `core`만 쓴다. `full`과 과거 시점 입력은 필요 없다. 좌표는 시점을 따라 움직이지 않는다.
7. 블록 링크: 필요 없다. 페이지 수준이면 된다.
8. 토큰: 1차 회신 유지. 소켓은 토큰 없음, TCP와 원격은 mode 600 파일 + `Authorization: Bearer`다. loupe는 TCP일 때만 `viewer` 토큰을 쓴다.
9. 지연 목표: 200 ms, 2초를 웜 목표로 유지하고 콜드 행을 따로 둔다. 추정 규모로 다시 재 달라(공백 15).

## 5번의 근거 (합성 그래프, RTX 4080 SUPER, DPR 1.5)

- 10k/51k는 S3 값이고 예산 안이다. 첫 프레임 478, 621 ms, CPU+GPU p95 5.0, 5.3 ms, 20 ms 초과 프레임 0. 이번 배치(S5)의 통제군 10.5k/26.9k는 첫 프레임 493~791 ms, CPU+GPU p95 4.9, 5.4, 10.1 ms로 3회 중 1회 8 ms를 넘었다. 이번 배치의 fps와 20 ms 초과 프레임은 무효다.
- 20k/80k는 첫 프레임 924~1,244 ms, CPU+GPU p95 8.3~12.0 ms, 50k/200k는 2.4~2.7초, 19~24 ms로 예산(800 ms, 8 ms)을 넘는다. 이번 렌더는 GPU 경합이 의심돼 값이 부풀었을 수 있고 재측정하면 알린다.
- 페이로드는 병목이 아니다. 50k/200k도 컬럼 JSON 19 MB, zstd 5.6 MB, 브라우저 파싱 75 ms 이하다. 개요 기본값을 올려도 loupe는 예산 안에 그리지 못한다. 2만은 사용자가 고르는 보기로 쓰고 5만은 전체를 그리지 않는다. 전체 입력은 `core`로 받으므로 개요 커서는 쓰지 않는다.

## 채울 공백 (막는 순서)

번호는 loupe 부록 B와 다르다. 9=B9·B10, 10=B11, 11=B12, 12=B13, 13과 14=B14·B20, 15=B15, 16~20=tower 12절이다.

1. 공개 ID(2.10, 4장, ADR 7.5): ADR이 `e:<type>:<slug>`와 공개 ID 불변식으로 닫았다. 수용한다. 계약 2.10과 예시의 `e:feature/…`를 같은 형식으로 고쳐 달라. loupe는 값을 한 세그먼트로 인코딩해 보낸다.
2. `/v1/meta`, `/v1/claims/{id}`, `/v1/edges/{id}`(4장 표, 빌드 계획 2.3): 뒤 둘은 절이 없고 셋 다 `kb.read` 표에 없다. meta는 폴링, claims는 출처 화면이 쓰고 edges는 선택한 사실 투영 엣지의 `claim_id`(4.3)에 쓴다. `/v1/nodes/{id}`가 `c-`, `n-`, `f-`, `s:` ID에도 응답하는지와 그 모양도 적어 달라. loupe의 `/node/<id>` 경로가 여기에 기댄다.
3. 주장 페이지와 이력(4.5, 4.7): `claim_limit`은 기본 50만 있고 최대값, 정렬, 커서가 없어 주장이 많은 엔티티를 끝까지 읽는 방법이 정해져 있지 않다. `/history`는 객체 단위라 소비자 문서 L46의 엔티티·속성별 체인이 안 된다. `predicate` 파라미터가 필요하다.
4. 변경 피드 시작점(4.12, 5장): 꼬리 읽기, `origin` 파라미터, manifest의 이어받기 커서가 없다. 처음부터 모든 쪽을 읽어야 최신 변경에 닿고 5장의 증분을 시작할 커서가 없다. 그래서 폴링은 `/v1/meta`로 간다.
5. 엣지 `status`(4.3, 5장 열에 없고 4.6은 열이 미정이다): 대체 엣지를 표시하지 못한다. 엣지마다 `/v1/edges/{id}`를 부를 수는 없다.
6. 기본 유효축과 `/history` as-of(2.9, ADR 7.4): ADR이 기본은 관측축만 현재, 유효축은 `as_of_valid`를 줄 때만으로 정했다. 수용한다. 계약 2.9 문장을 맞춰 달라. `/history`는 2.9의 두 표에 없다.
7. 검색 항목(4.8): `kind=claim` 모양만 있다. `kind`별 모양과 접두어 일치 여부는 팔레트가, `subject`와 `passage`의 `snapshot_id`, 오프셋은 검색 화면이 쓴다.
8. 표 문법(4.2, 4.4, 4장): `filter` 연산자, 복수 필터, `sort` 방향, 기본 정렬이 없고 `source`, `author`가 공통 파라미터에 없다. 표 화면이 여기서 멈춘다.
9. 캐시(2.5, ADR 1.3): ADR이 데이터 경로 `ETag`를 `"<epoch>-<applied_seq>-<build_id>"` 하나로 정했다. 수용한다. 계약 2.5를 맞추고 schema, meta, export, 스냅샷 메타데이터가 데이터 경로에 드는지, `/text`, `/raw`만 불변인지 적어 달라.
10. `core`(5장): 상태·병합 포함 규칙, `sha256` 기준, `g-`와 `p-`의 관계, 첫 게시 전 응답이 없다. 레이아웃의 유일한 전체 입력이다.
11. 상세 필드(4.5, 4.6, 4.11, 6.3): `include=body` 필드, `backlinks` 모양, `edges`의 반대쪽 라벨과 상한, 이웃의 열과 `truncated` 위치, `/text`의 단위와 창 메타데이터가 없다.
12. 의미(2.7, 2.10, 3장): 응답 `status`가 `eff_status`인지, 내장 주장에 `status`가 먹는지, 닫힌 enum 목록(2.10은 셋, 3장은 더 많다), `Evidence.id` 안정성을 적어 달라.
13. 민감도 범위(1장, 2.8, 7장, ADR 23장 결정 14): sagae-tools 안은 기본값 (c)다. 사용자 확인 전이다. 결정 전까지 소켓은 `internal` 이하로 둬 달라. (b)를 고르면 `loupe serve`가 소켓을 무인증 4812로 다시 내므로 `private`가 샌다. 그때는 먼저 알려 달라. `kb api` 범위는 ADR 7.9로 닫혔다.
14. 문서 정합: `TrustedHostMiddleware`는 400 `text/plain`이라 2.3의 403과 다르다(N=1). 10.1 8행의 게이트웨이 프록시 문구를 소비자 문서 L33에 맞춰 달라. 4.8 `{21,26}`은 `부터 8,`이고, 4.5 주장에 `label`이 없고, `edges.out`이 `Edge`와 다르다.
15. 부하 시험(4장, WP-10): `load.py`는 1만/5만이다. 추정 규모와 콜드 p95를 내 달라.
16. MCP 세션 구분(6.3, ADR 7.8): ADR대로면 tower 뒤 자식 하나는 프로세스마다 `s-<UUIDv7>` 하나이고 모든 세션이 그 값을 공유한다. tower는 세션별 `KB_MCP_SESSION`을 넣지 못한다. 이 귀속을 받아들이는지 답해 달라.
17. 세션 종료 전송(ADR 15.1, WP-12, WP-16): tower 뒤에서는 세션이 끝나도 자식에게 신호가 가지 않는다. `tower restart`와 tower 종료는 stdin EOF가 먼저라 자식이 2 s 안에 끝나면 SIGTERM도 없다. EOF 경로에서도 `kb ship`을 남겨 달라. 다른 프로젝트 세션에는 15분 tick만 남고 `SessionEnd` 훅은 KB 저장소 세션에만 있다. 이것으로 되는지 답해 달라.
18. 며칠 사는 자식(WP-12, ADR 15.4 B): 살아 있는 `kb-mcp`로 `current` 교체, 옛 빌드 정리, 배포 뒤 호출 시험을 더해 달라. 배포를 감지해 종료하면 tower가 다시 띄운다.
19. `cur=`(ADR 15.2, 계약 2.4): 카드의 `cur`가 계약 2.4 커서인지 서버 상태인지 적어 달라. 예시 `Ab3k` 길이로는 정렬 키, 필터 해시, `epoch`을 담지 못하고 서버 상태라면 자식 재시작에 사라진다.
20. tower 연동(WP-12, ADR 15.1): `print-gateway-config.sh`는 `upstreams.kb` 모양이어야 한다. `kb_search`의 `alwaysLoad`는 tower가 지운다. 도구 이름은 `kb_kb_search`가 된다. `kb-mcp`의 민감도 상한을 적어 달라. `kb_put`, `kb_request`는 `autoApprove` 밖이라 호출마다 사용자 확인을 받고 `-p`에서는 거부된다(바이너리 읽기, 미실행). 문제가 되면 알려 달라.

## 남은 요청 (loupe 부록 B)

- 모르는 쿼리 파라미터 거부(2.3): 봉투 `as_of`는 시간 축만 덮는다.
- `/raw`의 `Content-Disposition: attachment`(4.11): 원 `Content-Type`을 그대로 내면 캡처 HTML이 열린 출처에서 돈다. 프록시도 막지만 KB에도 넣어 달라.
- 본문 응답의 `Cache-Control: no-store`(2.5): 민감도 라벨이 붙는 본문이 디스크에 남지 않게 한다.
- `oneOf`의 `const`, examples, 단일 번들(3장, 9장), 그리고 구현 전 `openapi.yaml` 초안: 없으면 수기 사본이 생긴다.
- MCP 카드의 `sensitivity` 표시(ADR 15.2): 칸이 없다. 숨김 해제 인자가 없는 것은 충족이다.
- 일괄 읽기 `ids=`(4.5): 최근 항목 라벨. 없으면 개수를 줄인다.

## 닫은 것과 수용한 것

- 오프셋 단위(2.11) 요청은 충족으로 닫는다.
- 소비자 문서 L67의 시간 구간별 개수: loupe v1은 `/v1/counts`를 부르지 않는다. 우선순위를 낮춰도 된다.
- export 전송: `Content-Encoding: zstd`든 `application/zstd`든 스탠드인 프록시가 풀어 넘겼다(N=1). 어느 쪽이든 된다.
- 값 표시는 4.7의 시간축과 `value`, `unit`, `value_kind`로 쓴다. 정정 판정 규칙만 확인해 달라.
- `build_id` 신선도: 수용. `applied_seq`, `epoch`을 쓰고 `build_id`에 기대지 않는다.
- 개요에 필수 필터가 없는 것, 2.9의 시간 제외 경로: 수용한다. 개요 커서는 있어도 loupe가 쓰지 않는다.
- `kb api` 대체 경로: 쓰지 않는다. 소켓이 없으면 loupe는 KB 사용 불가로 보인다. 타입 생성은 Orval을 유지하고 계약 9장의 openapi-typescript는 쓰지 않는다.
