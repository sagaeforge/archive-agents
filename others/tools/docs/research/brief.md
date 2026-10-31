# 설계 패널 브리프: sagae-tools 뷰어와 관제 서버

기준일 2026-10-31. 조사 6건과 검증 2건을 합치고, 완결성 점검에서 확인한 사실을 더했다. 세부 근거는 같은 폴더의 각 보고서에 있다. VG-Cn은 `verify-gateway.md`, VV-Cn은 `verify-viewer.md`의 정정 번호다. 날짜의 연도는 모두 2026이다.

- **판단 우선순위:** 사용자 요청, `sagae-tools/CLAUDE.md`와 KB 소비자 문서, 검증 보고서, 조사 보고서 순이다.
- **증거 수준:** 제3자 코드는 아직 실행하지 않았다. 동작 서술은 소스와 문서 기준이고, "실측"이라고 쓴 것만 이 머신에서 잰 값이다.
- **사용자 원문:** "tools에 mcp 서버들이 있을 것 같은데, 이거 mcp뿐만 아니라 gateway 역할을 할 수 있는 서버도 필요할 듯, 가시화 도구 설계하면서, 같이 진행해줘." MCP 집계, HTTP 라우팅, 인증과 로그, 단일 상시 프로세스는 이 문장의 작업 해석이다.

**이번 점검에서 전제가 바뀐 세 가지**

1. **`CLAUDE.md` 구조 원칙이 조사에 반영되지 않았다.** 보고서 8건 어디에도 "관제"라는 말이 없다. VG-C3의 Hono 우선 재순위도 "Claude Code는 관제 서버 하나에 연결"(L14) 규칙을 다루지 않았다. 그 재순위를 결론으로 받지 말고 X1부터 푼다.
2. **"Docker 없음"은 사실이 아니다.** Docker Engine 29.9.2가 오늘 16:26 설치되어 데몬이 동작 중이다(`/var/log/dpkg.log`, 조사 시작 직전). `sagae`는 `docker` 그룹 구성원이지만 실행 중인 프로세스에 그룹이 적용되지 않아 `docker ps`는 권한 오류다. 누가 왜 설치했는지는 모른다.
3. **TS 프로세스 안 집계기를 어느 트랙도 평가하지 않았다.** `fastmcp-ts`와 `mcp-use`가 이 기능을 제공한다. "병합 `/mcp`면 곧 agentgateway"라는 구도는 성립하지 않는다(X2, 3절).

## 1. 증거로 결정된 것

아래는 검증 정정을 반영한 값이고, 어느 구조를 고르든 유효하다.

### 뷰어

기성 앱을 뷰어로 쓰지 않는다. 외부 읽기 전용 소스, 이중 시간축, 인용구 출처를 함께 다루는 앱을 찾지 못했다(`oss-viewers.md` §1, 검증 통과). 계약 위의 얇은 클라이언트 SPA를 만든다.

| 층 | 채택 | 확인된 사실과 조건 |
|---|---|---|
| 그래프 | sigma 4.0.4(10-27), graphology 0.26.0, @react-sigma/core 6.0.0, 모두 MIT | sigma 4 라벨은 아틀라스 첫 페이지만 그린다. 글리프 한도는 DPR 1에서 약 576, DPR 2에서 약 196이고 KS X 1001 한글만 2,350자다. `renderLabels:false`와 자체 오버레이가 계획이다(VV-C1). 비교 대상은 sigma 3.0.3. 점선은 `layerDashed` 내장. 10k/50k FPS와 오버레이 비용은 미측정 |
| 표 | TanStack Table 9.3.1, Virtual 3.14.24, MIT | 서버측 필터, 정렬, 패싯 |
| 시계열 | ECharts 6.1.0, Apache-2.0 | 툴팁 XSS 수정 이력이 있어 escape 포매터 필수 |
| 본문, 인용 | unified 11.0.5, rehype-sanitize 6.0.0, Shiki 4.5.0, approx-string-match 2.0.1, Hypothesis `match-quote` 벤더링, CSS Custom Highlight API | 벤더링 때 품질 임계값을 추가한다. 스냅샷 형식이 미정이라 HTML, PDF 경로가 열려 있다 |
| 팔레트 | cmdk 1.1.1(shadcn `Command`), MIT | 휴면 상태. `shouldFilter={false}`, 서버 호출 디바운스 |
| 앱 | Vite 8.3.5, React 19.3.1, TanStack Router 1.170.46, Query 5.105.0, shadcn 4.23.0, Base UI 1.9.0, Tailwind 4.3.3 | `typescript@~5.9.3` 고정. 스캐폴드 기본값 7.0.2는 API가 없어 생성기가 깨지고 shadcn의 `baseUrl`도 막힌다(VV-C2) |
| 계약 시험 | 자체 `kb-mock`(Hono + KB fixture), Schemathesis 4.32.7, ajv 8.20.0 | Prism 5.16.0은 day 0 한정, `SCARF_ANALYTICS=false`, `--multiprocess=false` |
| 선택 | Gephi Lite 1.1.0, GPL-3.0 | `?file=` 내보내기만. 상한 1만 노드 또는 2만 엣지, 소스 빌드 |
| 보류 | MCP Apps(ext-apps 2.0.4, 2.1.0 금지), Embedding Atlas 0.26.0(WebGPU 필수), Mosaic, Toponymy | Claude Code는 MCP Apps를 렌더하지 않는다. 지금은 도구 결과에 뷰어 딥링크를 넣는다 |

### 게이트웨이와 MCP

| 항목 | 결론 | 확인된 사실과 조건 |
|---|---|---|
| MCP 서버 작성 | 공식 TS SDK v2 | `@modelcontextprotocol/server` 2.4.0(10-23), `@modelcontextprotocol/hono` 2.0.2(10-02). `createMcpHandler` 기본 `legacy:'stateless'`가 두 세대를 응대한다. `@hono/mcp`와 npm `fastmcp`는 SDK v1 계열이라 제외 |
| 프로토콜 번역 | 직접 구현하지 않는다 | 스펙 2026-07-28이 표면을 크게 바꿨고 추가 변화가 예고됐다(`mcp-gateways.md` §7) |
| 앱 서버 | Hono 4.13.14, @hono/node-server 2.1.5, MIT | `^4` 유지(5.0은 RC, 어댑터 peer `^4.11.4`). `listen({fd:3})`와 SSE 프록시는 Hono로 실행해 보지 않았다 |
| MCP 제품 | agentgateway v1.7.0(10-27), Apache-2.0, 96 MB 바이너리 | HTTP와 MCP를 한 포트에 둔다. 정적 서빙, 소켓 활성화, KB 코드 호스팅은 없고 OpenAPI는 3.0만 읽는다. 쓴다면 VG §2의 강화 설정만 유효(VG-C4~C10) |
| 차선 제품 | 1MCP v0.39.7, Apache-2.0 | MCP 전용. stdio 상시 유지, SDK 1.30.0 고정으로 취약 범위 안, 유지보수자 1인. HTTP는 Caddy v2.11.7이 따로 필요 |
| 프로세스 관리 | systemd user unit + linger | Node `listen({fd:3})` 재현 성공. `Bun.serve({fd:3})`는 fd 무시(재현), PR #44013은 오늘도 open. pm2 기각 |
| 접근 | 127.0.0.1, Host와 Origin 검사, MCP 정적 bearer | `createMcpHonoApp` 또는 SDK의 `hostHeaderValidationResponse`, `originValidationResponse`. Tailscale Serve는 필요할 때. oauth2-proxy, Pomerium 기각 |
| KB 읽기 경로 | 지연은 결정 요인이 아니다 | 합성 SQLite 1만/5만 실측 p95: 프로세스 안 1.7 ms, CLI spawn Bun 11 ms, Node 29 ms, Python 41 ms. 콜드 스타트 55~81 ms. FTS, 시간 필터, 계약 검증, SDK import 제외 |
| 시험 | Inspector 2.13.0, conformance `0.2.0-alpha.12` + `--requirements 2026-07-28` | npm `latest` 0.1.16은 현행 스펙을 시험하지 못한다(VG-C2) |
| 도구 설계 | 서버당 8개 이하, 결과 크기 예산, 첫날 `structuredContent` 프로브 | 비용의 중심은 정의가 아니라 결과다(`mcp-servers.md` §6) |

## 2. 트랙 간 충돌

| # | 충돌 | 확인된 사실 | 남은 결정 |
|---|---|---|---|
| X1 | **"관제 서버 하나에 연결"의 뜻.** `CLAUDE.md` L14, 소비자 문서 L28 대 `/mcp/<name>`별 등록(`mcp-servers.md` §3, `http-gateway.md`, VG-C3) | 포트 하나에 URL N개면 Claude Code 등록은 N개다. 규칙이 "서버 하나"면 충족, "등록 하나"면 병합 `/mcp`가 필요하다. L28의 사용자 의향은 세션 전달이다 | 사용자 |
| X2 | **병합 구현.** agentgateway의 안전한 형태는 라우트당 target 1개라 병합이 없다. 병합하면 URI가 `<target>+<uri>`로 바뀌고 `resource_link`는 안 바뀌며 instructions가 합쳐진다(VG-C10) | 대안: 저장소 안 op 테이블의 코드 합성(추론), fastmcp-ts `mount`, mcp-use `proxy()`. 어느 쪽이든 서버별 `alwaysLoad`와 권한 접두어를 잃는다 | X1이 "등록 하나"일 때 선택 |
| X3 | **KB MCP 소유.** `servers/kb` 마운트 대 KB 자체 플러그인(`mcp-servers.md` §7.5) 대 "관제 서버에 등록"(소비자 문서 L29) | KB가 소유하면 프로세스 안 마운트가 안 되고 상류 프록시가 필요하다. VG-C3의 Hono 우선 논거가 여기에 기댄다 | KB 세션과 사용자 |
| X4 | **전면 프로세스.** agentgateway(`mcp-gateways.md`) 대 Hono(`http-gateway.md`, `mcp-servers.md`) | agentgateway를 써도 앱 프로세스는 필요하므로 최소 2개이고 전면은 상시다. VG-C3은 KB 원칙에 어긋난다고 봤지만, 작업 해석은 상시 1개를 허용한다 | 5절 |
| X5 | **한 프로세스로 뷰어와 게이트웨이를 다 맡을 수 있는가** | 지연상 가능(실측). 다만 동기 SQLite가 MCP 스트림까지 막고, 30~60초 폴링 탭이 열려 있으면 idle exit가 안 일어나며, 크래시 도메인을 공유한다. `CLAUDE.md` L13상 `/api/viewer`류는 필수 구성이 될 수 없다 | 뷰어 정적 파일을 선택적 마운트로 둘지, 뷰어 전용 백엔드가 필요한지 |
| X6 | **런타임.** Bun(소비자 문서 L9, `ui-blocks.md`, `mcp-servers.md`) 대 Node 26(`http-gateway.md`) | Bun은 fd 무시, 유휴 10초 스트림 종료, SDK v2는 README 기준뿐. `bun:sqlite`는 Node에서 안 돈다. `node:sqlite`는 Node 26에서 FTS5 포함 동작(실측), RC, 동기 전용 | `bun test`와 운영 런타임 불일치, KB가 TS일 때의 결합 |
| X7 | **레이아웃, 커뮤니티 계산.** 브라우저(`ui-blocks.md`) 대 KB 배치 산출물(trends M1, M2, C9) | 소비자 문서 L68이 "도구 계산"으로 정했고 `CLAUDE.md` L15가 되쓰기를 금지한다. trends C9 요청은 철회. 입력은 스냅샷 export(요구 4) | 브라우저인가 도구 측 배치인가. 배치면 저장 위치와 Python(graspologic-native) |
| X8 | **타입 생성기.** VV-C2는 TS 고정 후 유지, Hey API 배제. VG-C1은 채택 취소, Hey API 후보 | [#2874](https://github.com/openapi-ts/openapi-typescript/issues/2874): 9-19부터 보안 패치 포함 업데이트 없음. js-yaml은 새 설치 시 4.3.2라 수정판(4.3.0) 이후이므로 VG-C1의 해당 항목은 오래된 lock에만 해당. Hey API는 #4235 open, `latest`는 6-22의 0.99.0. Orval 8.46.0(10-30), Kubb 5.15.3(10-29, MIT, 미평가) | 선정. 임시로 동결 도구를 쓸지, KB가 타입을 낼지 |
| X9 | **Datasette.** VV-C5는 SQL 콘솔로 유지 | `CLAUDE.md` L15와 소비자 문서 L21이 DB 파일 직접 접근을 금지한다. 요구 6이 허용하는 것은 게시된 사본뿐이다 | 게시본이 계약에 들어올 때만 유지, 아니면 제거 |
| X10 | **한국어 검색 경계.** trends M10의 bigram, Kiwi, 초성 타입어헤드 | 요구 7: "도구 쪽에서 대신 구현하지 않는다". 색인 설계는 KB로 넘긴다 | NFC 정규화 외에 초성 타입어헤드를 도구에 둘지 |
| X11 | **계약 사본.** `packages/kb-contract`, 임시 스키마(`mcp-servers.md` §9) | `CLAUDE.md` L16이 사본을 원본처럼 두는 것을 금지한다. KB `docs/contracts/`에는 소비자 문서 외 계약 파일이 아직 없다 | 임시 스키마의 소유자 |
| X12 | **HTTP 동작 소유.** KB가 라이브러리나 CLI만 내는 경우 | `/v1`의 조건부 GET, RFC 9457 오류, 커서, 인증을 관제 서버가 구현하게 되고 Schemathesis 대상도 관제 서버가 된다. 어떤 보고서도 다루지 않았다 | 계약의 어느 부분이 KB 책임인가 |
| X13 | **플러그인.** `mcp-servers.md` §7.3 B(단일 파일 stdio 번들) | `CLAUDE.md` L14와 충돌한다. 규칙에 맞는 것은 A(얇은 HTTP 플러그인)다 | 기존 proxmox 플러그인 처리 |
| X14 | **이름과 수치** | 정리됨: `as_of_valid`, `as_of_observed`(L45), 상세·이웃·검색 p95 200 ms와 개요 2초(L56). 개요 JSON은 추정 4 MB, 합성 실측 2.1 MB | 포트 8787 대 7410, 경로 `/v1` 대 `/api/kb/v1` |

## 3. 빠진 것

**이번 점검으로 닫은 것**

- **Python 경로.** `python3 -m venv`는 ensurepip 부재로 실패한다(실측, `ui-blocks.md` 정정). `python3 -m venv --without-pip X` 뒤 `python3 -m pip --python X/bin/python`은 동작한다(`list`까지 실측). sudo 없이 Schemathesis를 넣을 경로가 있다. 실제 설치는 하지 않았다.
- **SQLite 내장 모듈.** Node 26.13.0의 `node:sqlite`는 경고 없이 로드되고 SQLite 3.54.0, FTS5 포함이다(실측). [문서](https://nodejs.org/api/sqlite.html)상 Stability 1.2 Release candidate, `readOnly` 지원, 동기 전용이다. `bun:sqlite`도 FTS5 포함(실측).
- **fastmcp-ts 1.9.0.** [composition 문서](https://github.com/PrefectHQ/fastmcp-ts/blob/main/docs/servers/composition.mdx)상 `mount()`와 `createProxy()`가 stdio, HTTP 상류를 받고 리소스 URI를 유지한다. 소스의 public `fetch(Request)`가 두 세대를 무상태로 처리하므로 Hono 마운트가 가능해 보인다(추론). 상류당 장수명 클라이언트 하나를 쓰고 재연결 코드는 찾지 못했다. npm 표기는 Apache-2.0이나 저장소에 LICENSE가 없고, Express 의존, 별 81개다.
- **mcp-use 2.12.2.** [`server.proxy()`](https://docs.mcp-use.com/typescript/server/proxy.md)는 HTTP 상류를 받고 URI를 `mcp-use-proxy`로 바꾼다. 상류 목록 변경 재동기화가 없고 stdio는 문서에 없다. SDK 2.3.1 고정. SDK v2.4.0 `docs/serving`에는 집계 문서가 없다.
- **재확인.** sigma는 10-27 이후 커밋이 없고 아틀라스 관련 open issue는 0건이다. Docker MCP Gateway는 v0.44.3(10-26, MIT)이다.

**실행하지 않은 modality**

| modality | 상태 | 막혀 있는 판단 |
|---|---|---|
| 실행 스파이크 | 이 단계 규칙상 없음. Windows 브라우저 실측도 없음 | sigma + 한글 오버레이 FPS, Hono와 fd, SDK v2 on Bun, 집계 경유 Claude Code, idle RSS, 실제 import 포함 콜드 스타트 |
| 위협 모델 | 조각만 있고 통합되지 않음 | localhost 무인증 읽기 API를 미러 모드의 Windows 프로세스가 읽는 경로, first_party 민감도, external 인용구의 프롬프트 인젝션 |
| 요구사항 정의 | "관제"의 범위(등록, 헬스, 로그, 재시작) 조사 없음 | 관제 서버의 기능 범위 |
| 한국어권 자료 | 1회 검색. 한국어 특화 구현 없음, [`sqlite-cjk-fts`](https://pypi.org/project/sqlite-cjk-fts/0.1.0/) 단서만(미검증, KB 전달용) | KB 소관 |
| 사용 경험 보고 | 1회 검색. 벤더 블로그뿐, 재연결 문제 보고 없음 | 제품 운영 위험 |

**읽지 않은 출처와 미반영 항목**

- KB `docs/research/{graph-store,retrieval-serving,etl-orchestration}.md`는 인용 0건이다. `CLAUDE.md` L23에 따라 소유 세션에 먼저 물어야 하고 서브에이전트의 메시지 회신은 메인 세션으로 가므로 읽지 않았다. KB `CLAUDE.md`는 16:49 수정으로 소비자 문서(16:30)보다 새롭다.
- 뷰어 트랙이 반영하지 않은 소비자 문서 항목: `sensitivity`, `merged_into`, 스키마 자기기술 구동(L49), 공통 봉투(요구 5), `truncated`와 필수 필터(요구 3), first_party 백링크와 Notion식 페이지(요구 9).
- Proxmox 클러스터 상태는 조회하지 않았다. 지금 결정에 영향이 없다.

**남은 미검증**

- 멈춘 WSL을 localhost 연결이 깨우는지는 1차 출처를 찾지 못했고 깨우지 않는다고 가정한다. Windows 절전 영향은 미조사다.
- KB 쪽 의미 문제: `superseded` 사유 분리(trends M4), observed와 recorded가 다른지(M3). 확정 요구에 넣어 보낸다.
- Tailscale 배치, `dnsRebindingProtection`과 Tailscale의 호환, agentgateway의 `_meta` 전달 등은 VG §4, VV §6에 있다.

**물어야 할 것**

- 사용자: X1의 뜻, 관제 범위, Docker 설치 의도, WSL 터미널 없이도 뷰어가 필요한지, 외부 MCP 서버 목록, 클라우드 커넥터 필요 여부.
- KB 세션(메인 경유): 구현 언어, 저장 엔진과 동시 읽기, 실행 위치와 데몬 ADR, 규모 예측, 스냅샷 본문 형식, X3, X12.

## 4. 설계가 지켜야 할 제약

**사용자 규칙(`sagae-tools/CLAUDE.md`)**

- 도구끼리 종속되지 않는다. 관제 서버는 뷰어 없이 동작하고 뷰어는 소비자 중 하나다(L13).
- MCP 서버를 Claude Code 확장에 직접 넣지 않는다. Claude Code는 관제 서버 하나에 연결한다(L14).
- KB는 계약으로만 읽는다. DB 파일 직접 접근과 파생값 되쓰기를 금지하고 뷰어는 읽기 전용이다(L15). 계약 원본은 KB `docs/contracts/`다(L16).
- 127.0.0.1 바인딩이 기본이다. 미러 네트워킹이라 eth0이 LAN 주소다(L21). systemd 유닛은 런타임 절대 경로를 쓴다(L22).
- 바퀴를 재발명하지 않고 토큰을 아낀다(L8, L9). 문서는 한국어, 코드와 커밋은 영어다(L20).

**KB 경계(소비자 문서, 잠정안)**

- 상시 프로세스 최소화. HTTP 데몬 여부는 ADR 미결이다. KB가 HTTP, 라이브러리, CLI 중 무엇을 내도 어댑터 교체로 흡수해야 한다.
- 읽기가 적재를 막으면 안 된다(요구 6). DuckDB 2.0.0 읽기 연결은 쓰기를 막고, SQLite WAL은 `mode=ro`에서도 `-shm`, `-wal`을 만든다. 파일 경로는 게시된 사본만 읽는다.
- 한국어 검색은 KB가 제공한다(요구 7). 민감도 기본 숨김을 넓히지 않고 MCP에 숨김 해제 인자를 두지 않는다(요구 1).
- HTTP를 열면 Host 검사, 와일드카드 CORS 금지, 인증 자리가 필수다(요구 8). MCP는 UI 데이터 경로가 아니다(L20).
- 불변 ID와 `merged_into`, 커서 페이지네이션, 공통 봉투를 따르고 타입을 하드코딩하지 않는다.
- 목표치(측정 아님): 1만 노드, 5만 엣지, 이웃 약 200노드, 상세·이웃·검색 p95 200 ms, 개요 2초, 폴링 30~60초, 사용자 1명.

**플랫폼(검증됨)**

- systemd 서비스는 WSL을 붙잡아 두지 않는다. 마지막 클라이언트 종료 약 15초 뒤 배포판이 멈춘다. 이 호스트는 `Linger=no`다.
- 소켓 활성화를 쓰면 운영 런타임은 Node다. Bun PR이 합쳐지기 전까지 Bun은 shim이 필요하다.
- WAL은 네트워크 파일시스템에서 동작하지 않는다. 관제 서버를 LXC로 옮기면 KB 데이터도 옮기거나 네트워크 읽기 경로가 필요하다.
- Claude Code는 시작 시 내려가 있던 서버를 재시도하지 않고, 세션 중 재시도는 약 10~13분 뒤 끝난다(VG-C19). 소켓 활성화는 이 문제를 줄인다. instructions 4,096자, 결과 25,000토큰 제한이 있다.
- 버전 범위: hono ≥ 4.13.11 < 5, node-server ≥ 2.1.3, TS SDK ≥ 2.3.0, agentgateway ≥ 1.7.0, Zod ≥ 4.2, Datasette ≥ 0.65.5, Kiwi > 0.23.2.
- **Docker.** 작업 지시의 제약이므로 설계 기본값은 비의존으로 둔다. 다만 전제는 낡았다. Docker가 주된 기각 사유였던 MCP 후보는 Docker MCP Gateway, ToolHive(v0.59.0), Obot이고, 이 제약이 풀리면 이들만 다시 본다. 셋의 세대 호환과 HTTP 라우팅은 평가된 적이 없다.

## 5. 비교할 구조

승자를 정하지 않는다. 넷은 프로세스 경계가 다른 구조이고, 배치는 아래의 교차 축으로 따로 고른다.

| 항목 | A. 단일 앱 관제 서버 | B. 제품 게이트웨이 + 앱 | C. 얇은 라우터 + 도구별 서비스 | D. 게시본 우선 |
|---|---|---|---|---|
| 구성 | Node 26 위 Hono 한 프로세스가 `/v1`, MCP, 선택적 뷰어 정적 파일을 맡는다. KB는 `KbReader`로 호출 | agentgateway가 포트를 갖고 Hono 앱을 `host:` 백엔드로 둔다. MCP는 HTTP target | 라우터는 경로와 인증만 맡고 도구 코드가 없다. KB 읽기, 각 MCP 서버, 뷰어가 각자 socket-activated 유닛 | KB가 계약으로 정의한 게시본을 빌드 ID별로 낸다. 서버는 파일과 소수의 동적 조회만, 질의는 브라우저에서 |
| 유휴/사용 중 프로세스 | 0 / 1 | 1(상시) / 2 | 0~1 / 2+N | 0 / 1 + 요청당 CLI |
| 등록 하나로 병합 | 코드 합성 또는 fastmcp-ts | target 2개 이상과 VG-C10 감수 | 집계기를 추가해야 한다 | MCP는 A~C 중 하나를 그대로 쓴다 |
| 외부 MCP 서버 | 프록시 라이브러리 또는 별도 등록 | 설정으로 등록. stdio는 VG-C4, C6 주의 | 유닛 추가 | A~C에 따름 |
| KB 언어 영향 | 같은 런타임이면 라이브러리, 아니면 stdio 자식 | A와 같음 | 없음 | 없음, 게시본 형식에 의존 |
| L13 독립성 | 관제 서버가 MCP 패키지를 import한다 | MCP 등록은 YAML, 앱 내부는 A와 같다 | 가장 잘 맞는다 | 뷰어가 계약 파일에만 의존 |
| 주된 위험 | 크래시 도메인 공유, 이벤트 루프 블로킹, Node와 Bun 분리 | 상시 프로세스, 강화 설정 의존, 잦은 동작 변경, Claude Code 경유 미검증 | 유닛 쌍 증가, 콜드 스타트 연쇄, 설정 분산 | 소비자 문서의 HTTP 1순위와 어긋남. 민감도를 게시 단계에서 걸러야 함. 검색은 동적 경로 필요 |
| 먼저 검증 | Hono `listen({fd})`, 실제 import 콜드 스타트, 동기 쿼리 영향 | Claude Code 스모크, 자식 수, RSS, Origin | 2개 유닛 왕복 지연, 라우터 fd 활성화 | 시점 데이터 크기, WASM 엔진(sqlite-wasm 3.54.1, duckdb-wasm `latest`가 dev 빌드, 미평가) |

**교차 축**

- **MCP 노출:** 병합 `/mcp` 하나, 또는 포트 하나에 서버별 경로(X1).
- **KB MCP 소유:** sagae-tools 또는 KB(X3).
- **가용성:** L0 WSL 세션 동안만, L1 VM 상시(`instanceIdleTimeout=-1`, `vmIdleTimeout=-1`, 로그온 작업), L2 Proxmox LXC(`http-gateway.md` §4).
- **뷰어 데이터 파생값:** 브라우저 또는 도구 측 배치(X7).

**구조 판단을 바꾸는 사실**

| 이렇게 확인되면 | 영향 |
|---|---|
| 외부 MCP 서버가 당분간 없다 | B의 주된 이점이 줄어든다 |
| "등록 하나"로 확정된다 | B는 VG-C10을 감수하거나 스냅샷 본문을 리소스 대신 도구로 전달해야 한다. A는 코드 합성, C는 집계기가 필요하다 |
| KB MCP가 KB 소유이고 TS가 아니다 | A의 프로세스 안 마운트 이점이 줄어든다 |
| KB가 HTTP를 직접 연다 | X12가 사라지고 `KbReader`는 http 어댑터가 된다. A~C의 차이가 줄어든다 |
| 시점 조회 데이터가 브라우저에 들어가지 않는다 | D는 개요 전용으로 축소된다 |
| PC가 꺼져도 써야 한다 | L2가 필요하고 WAL 제약 때문에 KB 위치와 묶인다 |
