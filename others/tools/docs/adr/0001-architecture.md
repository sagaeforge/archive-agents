# ADR 0001: tower와 loupe 두 도구 구조

- 상태: 채택. tower는 구현과 검증을 마쳤고 설치되어 127.0.0.1:4800에서 돈다(`docs/design/tower.md`). proxmox 업스트림은 전용 체크아웃에서 실행되고 병합 경유로 확인했다. 플러그인의 proxmox `.mcp.json` 제거는 플러그인 저장소의 통합이 들어올 때까지 미룬다. 그때까지 proxmox 등록이 둘 공존한다. loupe(`docs/design/loupe.md`)는 Phase 0과 1이 구현되어 헤드리스로 검증됐고 사용자의 IA 판단을 기다린다. 실제 Orca 탭에서 돈 적은 없다. KB 계약은 0.3.1이다(`data-interface-v0.md` sha256 `c9acda54…`, `openapi.yaml` `335908db…`). `openapi.yaml`이 나와 loupe의 표본 스펙은 지웠다. 세션 구분, 세션 종료 전송, 며칠 사는 자식, 커서, 민감도 상한, `tools/list` 새로고침은 KB의 답으로 닫혔다(5절). 실제 KB로 돌린 것은 없다. loupe는 kb-mock만 읽었다.
- 기준일: 2026-11-01.
- 근거 표기: `spike-results.md`의 S1~S5는 이 머신에서 잰 스파이크, "적대적 리뷰"는 그 재현과 반박이다. 둘이 다르면 리뷰가 우선한다. S5는 리뷰를 거치지 않았다. 번호 X1~X14는 `brief.md`의 충돌 목록이다.

## 1. 맥락

사용자는 sagae-knowloge-base(KB)를 조회해 보여 주는 가시화 도구를 원했고, 그 설계 중에 "MCP 서버들과 gateway 역할을 하는 서버도 필요하다"고 요청했다(`brief.md` 머리말의 사용자 원문). `CLAUDE.md`의 구조 원칙이 설계를 묶는다.

- 도구끼리 종속되지 않는다. 관제 서버는 뷰어 없이 돈다.
- Claude Code에는 관제 서버의 병합 MCP 엔드포인트 하나만 등록한다. 서버를 추가해도 Claude Code 설정이 바뀌지 않는다.
- KB는 계약으로만 읽는다. DB 파일 직접 접근과 파생값 되쓰기를 금지하고 뷰어는 읽기 전용이다.

환경은 WSL2 미러 네트워킹의 사용자 1명 머신이다. 가용성은 지금 WSL 세션이 있는 동안뿐이고 나중에 Proxmox LXC로 옮길 수 있어야 한다. 조사 보고서 8건, 검증 2건, 스파이크 5건, 적대적 리뷰 1건이 `docs/research/`에 있다.

## 2. 결정과 근거

| # | 결정 | 근거 |
|---|---|---|
| 1 | 독립 도구 둘: **tower**(관제 서버)와 **loupe**(KB 읽기 전용 뷰어). 서로 의존하지 않는다. tower에는 뷰어와 KB에 특화된 것이 없고 필요한 것은 전부 설정이다 | `CLAUDE.md` 구조 원칙. X5: 한 프로세스로 합치면 크래시 도메인을 공유하고 `/api/viewer`류가 필수 구성이 된다(`brief.md` §2). 설계 문서가 이를 설정 항목(proxy 라우트 하나)으로 풀었다 |
| 2 | Claude Code 등록은 tower의 병합 `/mcp` 하나. 업스트림 추가는 Claude Code 설정을 바꾸지 않는다 | `CLAUDE.md`. X1은 사용자 의향으로 닫혔다. 병합이 있어야 "등록 하나"가 성립한다(`brief.md` §2 X1, X2). 실행 중 세션에 새 업스트림이 바로 반영됨 [S1] |
| 3 | 병합 `/mcp`는 공식 MCP SDK v2의 client와 server를 조합해 tower 안에서 만든다. tower는 라우팅과 업스트림 수명만 맡는다. 스파이크 `c5-baseline`을 이식하고 그 harness를 회귀 스위트로 쓴다. **사용자의 결정이다** | S1: 제품 4종 모두 리소스 URI를 바꾸지만 `resource_link`는 안 바꿔서 도구 결과의 링크를 되읽지 못한다. SDK 조합만 URI 유지, 안정된 stdio 자식 1개, 재기동 약 1.13 s, 실행 중 세션의 즉시 반영을 통과했다 [S1, 207줄]. 리뷰가 결함 4건(오타로 게이트웨이 사망, 중복 URI의 오답, 첫 `tools/list` 부분 결과, 기존 항목 수정 무시)을 찾았고 설계로 없앴다(`tower.md` 1절) |
| 4 | Node 26, npm workspaces, TypeScript ~5.9.3. 서버는 Hono 4.13.x | Bun은 소켓 활성화가 넘긴 fd를 무시하고 Node는 `listen({fd:3})`로 동작한다 [S2, `http-gateway.md` §4]. TypeScript 7은 생성기와 shadcn을 깨뜨린다(`verify-viewer.md` C2) |
| 5 | 수명주기는 systemd user 소켓 + 서비스. 첫 연결에 기동해 상주하고 idle exit가 없다. `StartLimitIntervalSec=0`, `KillMode=mixed`, 절대 node 경로 | S2: 기본 시작 제한이면 크래시 루프에서 소켓 유닛이 실패해 포트를 놓는다. 제한을 풀면 소켓이 유지되고 대기하던 클라이언트가 복구 뒤 응답을 받았다. listen 스트림이 세션 내내 열려 idle exit는 효과가 없다. 기본 `KillMode`는 정지 때 stdio 자식에게 tower와 동시에 SIGTERM을 보내 진행 중 호출을 먼저 끊으므로 `mixed`로 둔다 [측정] |
| 6 | 127.0.0.1 바인딩, 모든 경로에 Host/Origin/`sec-fetch-*` 검사, `/mcp`는 정적 bearer. 토큰이 없으면 503으로 닫는다. `sec-fetch`는 문서 내비게이션(`navigate` + `dest: document`)만 통과시킨다 | `CLAUDE.md` 관례. 소비자 문서 요구 8. 위협 검토: 교차 사이트 `no-cors` 요청이 Origin 없이 도착함, Windows 같은 사용자는 경계 밖 [T, `tower.md` 5절] |
| 7 | 업스트림 리소스 소유는 `uriPrefixes`로 정적으로 정한다. 도구 동의는 `autoApprove`가 쥐고, 나머지 도구는 매번 확인한다 | 리뷰: 중복 URI가 다른 업스트림의 본문을 돌려줌 [R]. 도구 이름을 미리 알아야 막는 구조는 새 쓰기 도구를 와일드카드 허용에 태운다(위협 검토) |
| 8 | Docker에 의존하지 않는다 | 사용자 지시. 브리프는 Docker가 같은 날 설치된 사실을 기록했지만 설계 기본값은 비의존이다(`brief.md` §4) |
| 9 | loupe는 클라이언트 SPA다. Vite 8, React 19, TanStack Router/Query/Table/Virtual, shadcn(Base UI), Tailwind 4 | 기성 앱은 외부 읽기 전용 소스, 이중 시간축, 인용구 출처, 1만/5만 그래프를 함께 다루지 못한다(`oss-viewers.md` §1, `verify-viewer.md`) |
| 10 | 그래프는 sigma 4.0.4 + graphology와 자체 Canvas 2D 라벨 오버레이 | sigma 4 라벨은 아틀라스 첫 페이지 뒤의 한글을 틀린 글자로 그린다(`verify-viewer.md` C1). S3: 오버레이 조합이 실제 GPU에서 165 fps, 20 ms 초과 프레임 0 |
| 11 | 타입 생성은 Orval, `kbFetch` mutator가 어댑터 경계, 개발은 Hono 기반 kb-mock과 fixture. 설치본은 8.44.0이다. 7일 릴리스 대기 규칙이 8.46.0을 막았다 | S4: openapi-typescript는 스캐폴드가 설치하는 TS 7에서 깨지고(`verify-viewer.md` C2) 9-19 이후 보안 패치가 멈췄다(X8). 모르는 파라미터 거부(계약 0.3.0이 `bad_param`으로 확정)와 `satisfies`로 시간 축 누락을 잡는다 |
| 12 | 본문 렌더는 unified + rehype-sanitize + Shiki, 인용은 W3C 모양의 selector, 팔레트는 cmdk + 서버 검색, 차트는 ECharts 6의 escape 포매터 | 수집 원문은 신뢰하지 않는 입력이다(`understand-kb-contract.md` §6). ECharts 툴팁에 XSS 수정 이력(`brief.md` §1). 한국어 검색과 민감도 필터링은 KB 소관(소비자 문서 요구 1, 7) |
| 13 | loupe는 읽기 전용이다. KB 읽기는 계약을 통해서만, DB 파일 직접 접근은 금지. 레이아웃은 브라우저에서 계산해 브라우저에만 남긴다 | `CLAUDE.md`. X7: 좌표는 도구 계산이고 KB에 되쓰지 않는다 |
| 14 | MCP Apps는 보류한다. 딥링크는 `loupe open`과 경로 표로 만든다 | Claude Code는 MCP Apps를 렌더하지 않는다(`brief.md` §1). KB 카드에는 링크 칸이 없다(KB ADR 15.2) |
| 15 | 저장소 구성: `tools/tower`, `tools/loupe`, `ops/systemd`, `docs/adr`, `docs/design`. 공유 패키지는 실제 중복이 생길 때만 | X11: `packages/kb-contract`는 계약 사본을 원본처럼 두는 일이라 만들지 않는다 |
| 16 | 포트는 4800~4899. tower 4800, loupe dev 4810, kb-mock 4811 (설치본 loupe는 설계 문서가 4812를 잡았다) | 사용자 지시 |

## 3. 기각한 대안

| 대안 | 이유 | 근거 |
|---|---|---|
| agentgateway + mcp-proxy | 병합 경로에서 URI가 바뀌고 `resource_link`를 되읽지 못한다. 현대 요청마다 이중 세대 stdio 대상을 spawn한다(25/25). 레거시 대상이 하나 있으면 백엔드 전체가 레거시로 내려가고 자식이 죽어도 세션 안에서 살지 않는다. 실행 중 세션이 새 업스트림을 못 본다. `failOpen`은 Python stdio 대상에서 도구를 조용히 잃는다. stdio는 서버마다 프로세스 하나가 더 든다 | S1, 적대적 리뷰. 운영 면(RSS 42.8 MB, 콜드 125 ms, 강화 설정, `input_required` 중계)은 가장 좋았다 |
| 1MCP | URI 재작성과 `resource_link` 불가. 레거시 stdio 서버를 호출마다 spawn한다(20/20). RSS 318.8 MB, 콜드 1.2 s. 정적 bearer가 없고 60 s 호출 제한이 설정으로 안 바뀐다. 멈춘 업스트림이 건강한 업스트림을 막았다. SDK 1.30.0 고정 | S1 |
| fastmcp-ts | `outputSchema`, annotations, `_meta`, instructions를 버리고 URI를 자기 문서의 불변식에 반해 다시 쓴다. progress와 cancel을 중계하지 않는다. 업스트림이 내려가 있으면 시작 때 죽는다. 죽은 자식이 재시작 전까지 죽은 채다. Claude Code 경유는 시험하지 못했다 | S1 |
| mcp-use `proxy()` | URI 재작성, `_meta`와 instructions 탈락, 세션형 업스트림 재시작 뒤 영구 고장, 시작 때 내려간 업스트림은 재시도하지 않음, 나쁜 Origin에 200, 텔레메트리 기본 켜짐 | S1 |
| 기성 뷰어 앱 채택(Obsidian, Quartz, Datasette, Gephi Lite 등) | 외부 읽기 전용 소스, 이중 시간축, 인용구 출처, 1만/5만 그래프를 함께 다루는 앱이 없다. 반쯤 덮는 앱도 없다. Datasette는 DB 파일 직접 접근이 필요해 `CLAUDE.md`와 충돌한다(X9). Gephi Lite는 내보내기 대상으로만 남는다 | `oss-viewers.md` §1, §3, `verify-viewer.md` C5, C8 |
| Bun 런타임 | 소켓 활성화가 넘긴 fd를 무시한다(재현, 관련 PR 미병합). 유휴 10초 스트림 종료. SDK v2 지원은 README 수준. `bun:sqlite`는 Node에서 안 돈다 | `brief.md` X6, S2, `http-gateway.md` §4 |
| tower와 loupe를 한 프로세스로 | 크래시 도메인 공유, 폴링 탭이 idle exit를 막음, 뷰어 백엔드가 필수 구성이 됨 | X5 |
| 구조에서 정적 파일 서빙을 tower에 둠 | 소비자가 없다. 뷰어가 자기 서버를 갖고 tower는 proxy 라우트 하나로 마운트한다 | `tower.md` 검토 반영 |

기각이 영구하지는 않다. 제품 쪽 약점이 고쳐지면 같은 회귀 스위트로 다시 평가한다(5절).

## 4. 결과

**얻는 것**

- 도구 사이에 코드 의존이 없다. 한쪽을 빼도 다른 쪽이 돈다.
- Claude Code 설정은 tower 등록 하나로 고정되고, 업스트림 추가·수정이 설정 파일 한 곳(`tower.json`)에 모인다.
- 프로토콜 전송은 SDK가 따라간다. 스펙 개정의 부담을 직접 지지 않는다.

**치르는 비용. 솔직하게 적는다**

- **우리가 작은 커스텀 게이트웨이를 소유한다.** SDK 조합은 JSON-RPC를 직접 파싱하지 않지만 세대 사이 연결(stdio 2025 고정, HTTP 협상, `input_required`와 progress 중계)을 tower가 쥔다. 적대적 리뷰는 이를 "SDK 두 개 위의 커스텀 MCP 게이트웨이"라고 불렀고 `CLAUDE.md`의 "바퀴를 재발명하지 않는다"를 통과하는지는 명시적 결정이 필요하다고 했다. 사용자가 이를 알고 결정했다(결정 3).
- **코어가 줄 상한에 닿았다.** 첫 추정은 약 300줄(리뷰, 건강 검사와 로그 포함), 목표는 310줄, 상한은 400줄이었다. 구현은 코어 400줄, 전체 500줄이고 둘 다 상한이다. 여유가 0이고, 맞추려고 한 줄 getter 둘과 쉼표 식 셋을 썼다. 경고 표 다섯 행을 예산 때문에 잘랐다. 다음 변경은 줄을 더하려면 다른 줄을 먼저 지워야 한다. 지울 수 있는 것은 stderr 링 버퍼, `tower restart`, 이미 줄인 `tools_changed`뿐이다. 그 뒤에도 모자라면 6절의 조건이 발동한다. 회귀 스위트도 유지 비용이다(`tower.md` 11절).
- 업스트림 연결을 모든 세션이 공유하므로 세션별 상태를 갖는 서버는 tower 뒤에 맞지 않다.
- SDK 업그레이드마다 회귀, conformance 기준선, 실제 Claude Code 스모크를 돌려야 한다.
- Claude Code가 자동 갱신되어 고정할 수 없다. `requiresUserInteraction` 게이트와 알림 수신 등은 바이너리와 문서를 읽었을 뿐 실행하지 않았다.
- 가용성은 WSL 세션이 있는 동안뿐이다. 멈춘 WSL을 localhost 연결이 깨운다는 근거가 없다.
- 미러 네트워킹 때문에 Windows 같은 사용자는 경계 밖이다. 무인증 라우트와 읽기 API의 기밀성은 대상의 기본 응답에 달렸다.
- 레이아웃 계산이 브라우저에 있어 출처마다 처음 한 번 콜드 계산이 든다.

## 5. KB ADR과 계약에 달린 것

KB ADR(`sagae-knowloge-base/docs/adr/0001-architecture.md`)과 계약 v0 초안(`docs/contracts/data-interface-v0.md`)이 나왔다. 아래는 그 판 기준의 결과다. 계약은 이후 0.3.0, 0.3.1이 되었고 KB가 우리의 두 번째와 세 번째 답에 응답했다. 아래 행은 0.3.1 기준으로 고쳤다. 남은 `[잠정]`은 `/v1/ops/*`, TCP 8737, 소켓 민감도 사용자 결정이다. 달린 항목은 `loupe.md` 부록 C 끝의 표에 모았다. 소비자 문서의 게이트웨이 라이브러리 전제는 정정됐다(L11, L33).

| 항목 | 결과 | 영향 |
|---|---|---|
| KB HTTP를 누가 여는가(질문 2, X12) | 닫힘. KB가 소켓 활성화 HTTP `/v1`을 직접 낸다. 라이브러리는 없다 | tower는 KB HTTP를 쓰지 않는다. 소비자는 `loupe serve`다. 어댑터 서비스는 없다 |
| 읽기 API의 포트, 경로, 인증(X14) | Unix 소켓 기본, 0600. TCP 8737은 `[잠정]`이고 v1에서 쓰지 않는다 | `KB_URL` 한 곳. 소켓 HTTP는 KB 사용자 결정 3 뒤에 설치된다. `kb api` 대체 경로는 쓰지 않는다 |
| KB MCP의 소유와 전송(X3) | stdio, `runtime/bin/kb-mcp`, tower 업스트림 하나. 계약 0.3.0 기준으로 닫힘: 세션 구분은 `KB_MCP_SESSION="tower"`로 귀속을 받아들였고(작성자 `agent:tower` 하나), 세션 종료는 신호와 stdin EOF가 같은 함수를 한 번 부르며, `KB_MCP_SUPERVISED=1`이면 KB 자식이 새 배포를 감지해 유휴 때 종료하고 tower가 backoff로 다시 띄운다. `cur=`는 계약 2.4의 커서이고 서버 상태가 없다. 민감도 상한은 `internal` 고정이다 | 항목은 `tower.md` 9절, 닫은 내용은 12절. tower 코드는 바뀌지 않는다. 열린 질문이던 tower의 60 s `tools/list` refresh는 닫혔다. KB의 유휴 판정은 `tools/call`, `resources/read` 처리 중 개수만 세므로 refresh가 유휴를 깨지 않는다(3차 응답 확인 f) |
| 리소스 URI 스킴 | `kb://snapshot/{id}`, `kb://node/{id}`. `resource_link`는 쓰지 않는다 | `uriPrefixes: ["kb://"]` |
| 스냅샷 본문 형식(질문 3), 원본 바이트 | 표시 본문은 NFC Markdown 또는 평문. `/raw`는 원 `Content-Type`을 그대로 내고 `Content-Disposition: attachment`와 `nosniff`를 항상 붙인다(0.3.0) | loupe의 `text/html` 경로를 뺐다. `/kb/*`의 sandbox 헤더는 여전히 필수다. 구현에서 `%2F`가 `attachment` 헤더를 건너뛰는 경로가 나와 프록시가 막았다 |
| 실제 규모(질문 1) | KB 추정은 개요 노드 2만~5만, 엣지 5만~20만이다. S5(`spike-results.md` Spike 5)가 그 규모를 쟀다 | 레이아웃은 브라우저 worker로 충분하다. 기본 개요는 노드 1만, 엣지 5만 이하다. 결정 13은 그대로다 |
| 민감도 기본값과 MCP 결과의 라벨 위치, 인용 경계 표시, 숨김 해제 인자 없음 | 기본 읽기는 `internal` 이하. 쿼리로 올릴 수 없다. 카드에 `quote`와 민감도 칸이 없다 | `first_party_open=true` 전에 4812 노출을 사용자가 다시 정한다 |
| 계약 파일 자체(OpenAPI), fixture, 커서·캐시·`merged_into`·시간 해석 규칙 | 규칙은 산문에 있고 `openapi.yaml`이 0.3.0에 나와 0.3.1까지 올랐다. fixture는 아직 없다 | T1은 끝났다. loupe는 `openapi.yaml`을 제자리에서 읽어 생성하고 표본 스펙은 지웠다. 표본 fixture와 kb-mock만 남는다. 남은 전환은 T2(KB fixture), T3(실제 KB)다(`loupe.md` 8절) |
| first_party 본문 형식, 링크, 작성자(요구 9) | Markdown, `author`, 페이지 수준 링크. `include=body` 필드는 0.3.0이 적었다 | Notion식 페이지의 깊이. 실제 first_party 본문은 아직 본 적이 없다 |
| 계약 공백 | 주장 페이지, 변경 피드 시작점, 엣지 상태, `/` ID, 기본 유효축을 0.3.0이 모두 닫았다. 남은 요청은 소켓 민감도 범위(사용자 결정 전), 추정 규모 부하와 콜드 p95, `as_of_valid` 형식과 `/v1/facets`의 `q` 질문이다 | `loupe.md` 부록 B |

## 6. 다시 볼 조건

| 조건 | 볼 대상 |
|---|---|
| tower에 머리말의 세 가지 밖의 세대 분기나 JSON-RPC 파싱이 필요해진다 | 즉시 재검토. 이 ADR의 결정 위반이다 |
| 코어가 삭제 뒤에도 400줄을 넘는다. **지금 코어는 400줄로 상한에 닿았다**(첫 추정 약 300줄, 목표 310줄). 다음 변경은 삭제 없이는 못 들어간다 | 제품 도입 또는 범위 축소. 다음에 줄을 더해야 하는 변경에서 먼저 따진다 |
| SDK 업그레이드 두 번 연속으로 코드 수정이 필요하거나 conformance 기준선이 늘어난다 | agentgateway, 1MCP |
| 어떤 제품이 `resource_link` 되읽기와 안정된 자식·재기동·`list_changed`를 통과한다 | 그 제품을 같은 회귀로 재평가 |
| 모든 업스트림이 HTTP이고 도구 결과에 URI가 없고 실행 중 추가가 필요 없다 | agentgateway 대상 경로 |
| 원격 노출, OAuth, 다중 사용자, 정책 기능이 필요하다 | agentgateway |
| `core`가 5만 노드를 넘거나, 소프트 미스가 안 되는 콜드가 잦거나, 출처와 프로필이 늘어 콜드 반복이 불편하다 | loupe의 `loupe layout` 출구와 결정 13 |
| S5 렌더 재측정에서 예산 안의 규모가 달라진다 | loupe 기본 개요 상한과 KB에 보낸 기본 타입 답 |
| KB MCP를 tower로 옮긴다(KB ADR 23장 결정 7) | `alwaysLoad`(`tower.md` 12절 #10). 60 s refresh, 세션 구분, 세션 종료 전송은 닫혔다 |
| `first_party_open=true`가 된다 | 4812와 tower 마운트의 무인증 노출, KB MCP 결과의 first_party(`tower.md` 12절 #5, #6) |
| KB 계약이 `1.0.0`이 된다 (`openapi.yaml`은 0.3.0에 나왔고 표본 스펙 삭제는 끝났다) | `0.x` 경고 규칙 |
| LXC 이전 | 유닛을 system 유닛으로, `allowedHosts`와 `ListenStream`을 설정으로, 무인증 라우트의 노출 재판단 |
| Docker 제약이 풀린다 | Docker MCP Gateway, ToolHive, Obot만 다시 본다(`brief.md` §4) |
| 변경 시 | 새 ADR로 대체하고 이 문서의 상태를 바꾼다 |
