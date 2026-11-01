# 최종 감사: 사실 확인

- 날짜와 확인일: 2026-10-31. 아래 모든 URL의 확인일이다.
- 범위: 사용자 결정과 고정 버전을 떠받치는 사실. 대상 문서는 ADR-0001, 빌드 계획, 데이터 계약, 소비자 요구다.
- 성격: 시스템 설계 문서다(CLAUDE.md 지침 5의 예외). 약관 항목은 공개 문구의 대조이고 법률 자문이 아니다.
- 표기: **[재현]** 이번 감사에서 직접 실행한 결과, **[원문]** 1차 출처 원문을 받아 대조한 것, **[추론]** 재현하지 않은 판단. `[T번호]`는 8장의 출처다.

## 0. 결론

결함 15건이다. blocker 1, major 7, minor 7이다.

1. **구축 전에 반드시 고칠 것은 1건이다.** 활성 소스 D18, D19가 `www.youtube.com`에 있다. WP-21은 "YouTube에 요청하지 않는다"고 지시하고 `youtube.com` 호스트 요청 0건을 인수 조건으로 둔다. ADR 23장은 YouTube 경로가 "전부 꺼짐"이라고 적는다. 셋이 함께 성립하지 않는다(FACT-01).
2. **ADR 23장 결정 1의 문장은 사용자 판단에 그대로 쓰면 안 된다.** "공개 경로와 Data API 키는 함께 쓸 수 없다"는 yt-dlp, InnerTube, 자동완성, Trends 비공식 경로에는 문구상 맞다. 그러나 근거 셋 중 배타의 근거는 하나뿐이고, RSS는 불명확하고, WebSub은 함께 쓸 수 있다. 더 중요한 것은 yt-dlp·InnerTube는 키가 없어도 YouTube 약관 문구로 금지된다는 점이다. 양자택일로 읽으면 틀린다. 시장 통찰 금지 조항(III.E.2)과 Google 계정 종료 가능성도 빠져 있다(FACT-02).
3. **"키가 생기면 `enabled`만 켠다. 코드 변경 없음"은 사실이 아니다.** 어댑터가 없고, 30일 삭제는 원시 객체에만 걸려 있으며, 이 문장은 결정 1을 우회한다(FACT-03).
4. **활성 소스 56개 URL 표본 중 3건이 robots에서 `*` 전체 차단이고 1건은 404다.** X11(Netflix)은 약관도 자동 접근을 금지한다. 약관 문구로 금지된 활성 소스가 더 있다(D20 Ahrefs, OpenAI 계열)(FACT-04, 05).
5. **세션 종료 시 `kb ship`은 Linux에서 실행되지 않는다.** Claude Code는 stdin을 닫지 않고 신호를 보낸다. 공식 SDK 서버는 `finally`까지 가지 못하고 죽었다(FACT-07, 재현).
6. **고정 버전은 전부 실재하고 유지보수 중이다.** 80개 패키지 잠금, 설치 해시, 지정 API가 재현됐다. 결함은 환경 변수 하나다(FACT-08).

## 1. 사용자 결정 1 사실표

### 1.1 경로별 판정

판정은 공개 문구 기준이다. **허용**은 문구가 허용한다, **금지**는 문구가 금지한다, **불명확**은 문구만으로 갈리지 않는다는 뜻이다. "키 보유"는 Data API 키 또는 OAuth 자격 증명을 만들어 API 약관에 동의한 상태다.

| 경로 | 소스 | 키 없음 | 키 보유 | 근거 문구 | 붙는 조건과 사실 |
|---|---|---|---|---|---|
| Data API 키 단독 | P01 | 해당 없음 | **허용, 조건부** | "temporarily store limited amounts of Non-Authorized Data ... not longer than 30 calendar days" (III.E.4.d)[T3]. "gain insights into YouTube's usage, revenue, or any other aspects of YouTube's business" (III.E.2)[T3]. "create new or derived data or metrics" (III.E.4.h)[T3] | 장기 그래프 저장 불가. 시장 집계 불가. 쿼터는 `search.list` 100회/일, 그 외 합산 10,000단위/일[T10]. 감사 예외는 1.3 참고 |
| 채널 RSS 폴링 | P07 `/feeds/videos.xml` | **불명확**(문구는 금지 쪽) | **불명확** | "access the Service using any automated means"[T1]. robots `Disallow: /feeds/videos.xml`[T7]. 키 보유 시 "use any technology other than YouTube API Services to access or retrieve API Data" (III.I.14)[T3] | 반대 근거는 기계 판독용 공개 Atom이라는 점이다. 폴링 경로는 공식 문서에서 찾지 못했다[T9] |
| WebSub 구독 | P07 `/xml/feeds/videos.xml` | **허용** | **허용** | "The YouTube Data API (v3) supports push notifications via PubSubHubbub"[T9] | 공개 콜백 서버가 필요하다[T9]. ADR의 상주 프로세스 0과 충돌한다. 문서 경로라 III.D에 걸리지 않는다 [추론]. 다만 Data API 안내에 있는 기능이라 키가 없어도 쓰는 순간 API 약관에 묶인다고 읽을 수 있다 [추론] |
| 자동완성 | P04 | **불명확** | **금지** | Google 약관 자동화 조항은 "in violation of the machine-readable instructions"에 한정된다[T2]. 키 보유 시 "scrape YouTube Applications or Google Applications" (III.E.6), "You must not use undocumented APIs without express permission" (III.D)[T3] | 호스트 robots 404는 인벤토리 기록이고 이번 감사는 호출하지 않았다. `suggestqueries-clients6.youtube.com` 변형은 YouTube 약관 문구 대상이다 [추론]. 응답에 검색량이 없다 |
| yt-dlp·InnerTube | P05 P06 P13 P14 D14 | **금지** | **금지** | "access the Service using any automated means (such as robots, botnets or scrapers)", "access, reproduce, download ... any part of the Service or any Content except"[T1]. robots `Disallow: /youtubei/`[T7]. 키 보유 시 III.E.6, III.D, III.I.14, "download, import, backup, cache, or store copies of YouTube audiovisual content" (III.E.1)[T3] | 예외는 공개 검색엔진과 사전 서면 승인뿐이다[T1]. 개인 비상업 사용 예외가 없다. 댓글 작성자는 "collect or harvest any information that might identify a person"[T1] |
| Trends 공식 API 알파 | P08 | **허용, 승인제** | 같음 | "gather feedback from a limited set of developers"[T11] | 페이지에 약관과 사용 제한이 없다. YouTube 검색 속성 언급이 없다[T11]. 승인 미보유 |
| Trends Explore, 내부 API | P09 | Explore **금지**, 내부 API **불명확** | **금지** | `trends.google.com` robots `Disallow: /explore?`, `/trends/explore?`[T8] + Google 자동화 조항[T2]. `www.google.com`은 `/trends/api`도 Disallow지만 `trends.google.com`에는 없다[T8] | pytrends가 `/trends/api/*`를 쓴다는 것은 코드로 확인하지 않은 [추론]이다 |
| Trends RSS | P09 `/trending/rss` | **금지 문구 없음** | **불명확** | robots 미차단[T8]. "You can use any information from Google Trends, subject to the Google Terms of Service."[T12]. 키 보유 시 III.E.6 | 인용 시 Google 귀속이 필요하다[T12]. 트렌딩 검색어이고 YouTube 검색량이 아니다 |
| 본인 채널 Analytics·Reporting API | P02 P03 | 해당 없음 | **허용, 조건부** | "data retrieved through the YouTube Analytics API service" (III.E.4.b), "must still ensure every 30 days that it is still authorized"[T3] | 철회 시 7일 안에 삭제[T3]. "delete API Data associated with users whose authorization tokens cannot be refreshed"[T3]. OAuth Testing 상태는 "refresh token expiring in 7 days"[T13]. 채널이 있어야 한다. **같은 계약이므로 III.E.6, III.I.14가 그대로 붙는다** |
| 사람이 직접 가져온 수치 | first_party, P15 | Studio 화면·내보내기 **허용 쪽**, 공개 페이지 수치 **불명확** | 같음 | 자동화 조항은 "automated means"만 본다[T1]. 다만 Content 정의에 "metrics"가 들어 있고 "reproduce ... any Content except" 제한이 남는다[T1] | 스크립트, 브라우저 확장 보조는 자동화다 [추론]. 저장은 `user:sagae` 작성자 귀속 |

### 1.2 조항이 누구를 묶는가

| 조항 | 주체 | 대상 | 키 없이 적용 |
|---|---|---|---|
| YouTube 약관, 자동화[T1] | 모든 이용자 | Service 접근 | 예 |
| Google 약관, 자동화[T2] | 모든 이용자 | Google 서비스 콘텐츠. 기계 판독 지시 위반일 때만 | 예 |
| III.E.6 Scraping[T3] | "You and your API Clients" | 행위 "scrape", 취득 "obtain scraped YouTube data or content", 대상 YouTube Applications와 Google Applications | 아니오 |
| III.I.14[T3] | "You and your API Clients" | API Data를 다른 기술로 취득 | 아니오 |
| III.D Undocumented Services[T3] | "You" | 문서화되지 않은 API | 아니오 |
| III.E.2[T3] | 명령문, 사실상 개발자 | API Data 집계, 사업 통찰 | 아니오 |
| III.E.4.d, h[T3] | API Client | 저장된 Non-Authorized Data, 파생 | 아니오 |
| III.E.4.b[T3] | API Client | Authorized Data 저장 | 아니오 |
| III.I.15[T3] | "You and your API Clients" | "offer an API service that allows users to access any data ... provided by the YouTube API Services" | 아니오 |

세 가지가 중요하다.

- **주체는 프로그램이 아니라 사람이다.** III.E.6은 API Client만이 아니라 "You"를 묶고 "directly or indirectly"를 쓴다. 인벤토리의 "API 클라이언트는"이라는 요약은 좁다.
- **YouTube 약관은 API 계약의 일부다.** API ToS 2.1이 구성 문서에 "the YouTube Terms"를 넣는다[T5]. 키 보유자의 자동 접근은 YouTube 약관 위반이면서 API 계약 위반이다. 위반의 결과는 API ToS 3.1의 접근 중단과 계약 종료[T5], 그리고 가이드의 "including termination of the Google account associated with the API service found to be in violation"이다[T6]. 사용자는 채널 개설을 준비 중이다.
- **남는 해석 여지가 있다.** 정책 머리말은 "when accessing or using YouTube API Services in your service, product, or application"이고[T3], ToS 3.1도 같은 범위를 쓴다[T5]. API를 쓰지 않는 별도 프로그램의 행위까지 닿는지는 문구만으로 갈리지 않는다. 다만 이 저장소는 한 프로그램이 한 원장에 적재하므로 API Client 자체가 스크래핑 데이터를 취득하는 구조다. 이 여지를 쓸 수 없다 [추론].

### 1.3 ADR 23장 결정 1 문장 대조

| ADR 서술 | 대조 결과 |
|---|---|
| 공개 경로는 "약관의 자동화 조항"에 걸린다 | YouTube는 맞다. 공개 검색엔진과 서면 승인 외 예외가 없다[T1]. Google은 다르다. robots 등 기계 판독 지시 위반일 때만이다[T2]. 두 조항을 한 사유로 묶으면 안 된다 |
| Data API 키는 "스크래핑 데이터 취득 금지" | 부분만 맞다. 취득뿐 아니라 스크래핑 행위 자체를, Google Applications까지 금지한다[T3] |
| "30일 보존" | 부분만 맞다. "limited amounts"가 빠졌고, 삭제 또는 갱신 의무이며, Non-Authorized Data에 한정된다. Authorized 통계는 더 오래 저장할 수 있다[T3] |
| "파생 지표 금지" | 맞다. 예외가 빠졌다. III.L은 "audited developers with analytics use cases that have explicitly applied"에만 적용된다[T3]. 표준 쿼터 증설 양식으로 신청하고, 통계와 파생 지표는 최대 36개월, 제목·채널명·설명·댓글은 30일 규칙 유지다[T4]. 개정 이력상 2026-05-04 추가, 2026-06-01 저장 조항 추가다[T14] |
| "함께 쓸 수 없다" | yt-dlp, InnerTube, 자동완성, Trends 비공식은 문구상 맞다. 근거는 III.E.6, III.I.14, III.D이고, ADR이 든 30일과 파생 지표는 배타의 근거가 아니라 API Data 취급 조건이다. RSS는 불명확, WebSub은 함께 쓸 수 있다 |
| (없음) | **III.E.2가 빠졌다.** 시장 조사 목적에 직접 걸리는 조항이다. 파생 정책은 "Policy III E.4.b, E.4.c, and E.4.d are amended"라고만 적어 III.E.2를 고치지 않는다[T4]. 다만 같은 문서가 순위표와 수익 추정을 허용 예시로 드는 점과의 관계는 불명확하다 |
| (없음) | **III.E.4.h와 가이드의 결합 금지가 빠졌다.** 가이드는 "Merge or combine YouTube API data with any other data."를 금지 예시로 든다[T6]. 범용 그래프의 전제와 충돌한다. 가이드는 조항을 대체하지 않지만 집행 해석을 보여 준다고 스스로 적는다[T3] |
| 막히는 것: "도메인 A의 주 소스, C·D의 정량 자료" | 키로 풀린다는 인상을 준다. A는 `search.list` 100회/일에 30일 저장이라 축적이 안 된다. C의 유입·리텐션은 소유자 전용이라 타 채널 값을 얻지 못한다. B·C의 시장 집계는 III.E.2가 막는다 |

감사 예외의 실효성은 미확인이다. 양식 선택지는 "Section 5: Use Cases, API Integration, and Feature Implementation" 아래 "Analytics & Reporting"이고[T4], "Your API Service must reflect an analytics use case on YouTube"다[T4]. 개인용 내부 지식 저장소가 이 조건을 통과하는지는 문구에 없다. 파생 정책의 허용 예시는 대부분 자체 점수인데, 지침 5가 이를 금지하므로 이 저장소가 쓸 수 있는 것은 36개월 통계 저장뿐이다 [추론].

### 1.4 선택지별 결과

| 선택 | 얻는 것 | 문구상 남는 것 |
|---|---|---|
| 전부 끔(현 기본값) | 약관 쟁점 없음. 단 FACT-01을 고쳐야 참이 된다 | 도메인 A 키워드 데이터 없음 |
| 키 없이 Trends RSS | 트렌딩 검색어 | 금지 문구 없음. 귀속 필요 |
| 키 없이 채널 RSS | 신규 업로드 메타데이터 | 불명확, 시간대 의존 404(인벤토리) |
| 키 없이 yt-dlp, InnerTube | 공개 메타데이터, 자막 | 금지. 키 유무와 무관 |
| Data API 키 | 호출 시점 값 | 30일, 제한량, 시장 통찰 금지, 파생 금지, 결합 금지, 공개 경로 전체 포기, 활성 문서형 소스 재검토(FACT-06) |
| 본인 채널 OAuth만 | 본인 채널 유입·리텐션 장기 저장 | 같은 계약에 묶임, 30일 재확인, 토큰 실패 시 삭제, 프로덕션 게시 필요 가능성 |
| 사람 입력 | 본인이 본 수치 | 공개 페이지 수치의 복제 제한 문구 |

## 2. 소스 약관과 robots 표본

### 2.1 초기 비활성 사유 표본

| 소스 | ADR 사유 | 원문 | 판정 |
|---|---|---|---|
| D05 Pew | 무단 스크래핑 금지 문구 | "engage in unauthorized spidering, “scraping,” or harvesting of content"(Effective 05/25/2018)[T20] | 사유는 맞다. 다만 `llms.txt`와 robots 둘 다 `Content-Signal: ai-train=yes, search=yes, ai-input=yes`이고 `.md` 경로를 Allow한다[T20]. "unauthorized"의 범위가 불명확해 금지가 아니라 **불명확**에 가깝다(FACT-10) |
| P11 Playboard | 약관 금지 | "Creating, distributing, or installing agents, robots, scripts, spiders"[T21] | 맞다 |
| P12 Social Blade | 약관 금지 | "Mass copying of data from Social Blade’s website — including botting, crawling, and scraping — is not allowed"(2026-07-07 갱신)[T22] | 맞다 |
| X01 치지직 | 약관 금지 | "자동화된 수단(...)을 이용하여 ... 네이버 서비스에 게재된 회원의 아이디(ID), 게시물 등을 수집"(2026-10-01 시행)[T23] | 맞다. 치지직 전용 약관은 찾지 못했다 |
| D08, X14 EDGAR | 연락처 요구 | 5장 | 맞다 |
| P04 P09 | "자동화 조항, robots" | 1.1 | 일괄 사유가 부정확하다(FACT-09) |

### 2.2 초기 활성 소스 판정

| 소스 | 문구 | 판정 | 처리 |
|---|---|---|---|
| **X11** Netflix TSV | robots `User-agent: *` `Disallow: /`[T24]. "use any robot, spider, scraper or other automated means to access the Netflix service", "use any data mining, data gathering or extraction method"[T24] | **금지.** 페이지에 사람용 내려받기 링크는 있다[T24]. 국가별 파일 32.8 MB는 `safe_fetch` 기본 20 MB도 넘는다 | 비활성 |
| **D20** Ahrefs | "except through the software or search agents provided by Ahrefs Services, search, crawl, scrape or harvest data", "except through Ahrefs API, use Ahrefs Services through an automated means"(2026-09-14)[T25] | **금지.** robots는 허용 | 비활성 |
| **D18 D19** YouTube 페이지 | YouTube 자동화 조항[T1]. robots 미차단[T7] | **금지 쪽.** 이 페이지가 "Service"인지는 불명확 | FACT-01 |
| **D11** KOBACO | robots `user-agent: *` `disallow: /`, 이름 지정 봇만 허용[T26] | **robots 금지.** 약관은 미확인 | 비활성 또는 D09 보도자료로 대체 |
| **X15** arXiv API | `export.arxiv.org` robots `User-agent: *` `Disallow: /`[T27]. API ToU는 "no more than one request every three seconds"로 허용[T27] | **허용**, robots와 어긋남 | 예외 규칙 필요 |
| **O02~O06 O09 O12 O13 U03 U16** OpenAI | "Automatically or programmatically extract data or Output"(2026-01-01). 범위 "associated software applications and websites"[T28] | **불명확.** 문구는 넓고 `llms.txt`, `.md`, RSS, robots Allow가 반대 신호다 | 등급 명시와 사용자 고지 |
| **D21** Stack Overflow | 자동 수집 금지는 경쟁 서비스, 생성형 AI "indexing" 목적과 과부하에 한정[T29] | **불명확** | 등급 명시 |
| C 계열 Anthropic | "To crawl, scrape, or otherwise harvest data or information from our Services other than as permitted under these Terms."[T30]. 문서가 `llms.txt` 사용을 직접 안내[T31] | 허용 쪽 | 유지 |
| U06 X16 HN Algolia | YC 약관에 "scrape"가 있으나 범위는 YC 사이트와 하위 도메인이고 `hn.algolia.com`은 아니다[T32] | 허용 쪽 [추론] | 유지 |
| C01 등 GitHub | "Scraping does not refer to the collection of information through our API."[T33] | 허용 쪽. 스팸 목적만 금지 문구 | 유지 |
| L01 Hugging Face | 자동 수집 금지 문구를 찾지 못했다[T34] | 문구 없음 | 유지 |
| P10 Kworb | 약관 페이지 없음, robots `Allow: /` | 문구 없음. 데이터 취득 방식 미공개 | 키 선택 시 재검토(FACT-06) |
| D01 DataReportal | 저작권과 재사용 허가 안내뿐, 약관 본문 링크는 찾지 못했다[T35] | 자동화 문구 없음, 재사용 조건 미확인 | 유지, 미확인 표시 |
| D04 Nielsen, D03, U10 | 약관 본문이 서버 응답에 없거나 경로를 찾지 못했다 | **미확인** | 미확인 표시 |

### 2.3 실제 UA 표본 [재현]

ADR 10.3의 `User-Agent: kb-collector/0.1`로 활성 소스 URL 56개를 RFC 9309 최장 일치로 판정하고 GET 1회씩 했다. A~F 인벤토리의 200은 브라우저 UA 값이고(§11), G 인벤토리는 UA를 적지 않았다. 이 UA로 잰 값은 이번이 처음이다.

| 결과 | 건수 | 소스 |
|---|---:|---|
| robots 허용, GET 200 | 52 | 나머지 전부. 봇 차단 응답 없음 |
| robots `*` 전체 차단 | 3 | D11, X11, X15 |
| GET 404 | 1 | U03. 브라우저 UA도 404. O02의 `llms.txt`에는 등재돼 있다 |

D09, D10b 첫 페이지는 200이지만 445, 437바이트 JavaScript 이동 껍데기다. `safe_fetch`는 HTTP 리다이렉트만 따른다. 등록 URL은 하위 경로로 잡아야 한다.

## 3. 고정 버전

| 항목 | 고정값 | 실재 | 배포일 | 최신 | 유지보수 | 재현 |
|---|---|---|---:|---|---|---|
| uv | 0.13.6 | 예 | 2026-10-27 | 최신 | push 10-31 | 설치 스크립트 sha256 일치, 격리 설치 가짜 HOME 0파일 [재현] |
| CPython | 3.14.10 | 예 | 2026-10-25 | 3.14 최신. 3.15.2 별도 존재 | python-build-standalone 20261026 | SQLite 3.53.1, zstd 1.5.7, FTS5 `contentless_delete`, JSONB, `--no-bin` 동작 [재현] |
| mcp | 2.3.0 | 예 | 2026-10-02 | 최신 | push 10-27 | `mcp.server.mcpserver.MCPServer`, `structured_output`, `meta`, `tools/list`의 `_meta` [재현] |
| Starlette | 1.10.0 | 예 | 2026-10-24 | 최신 | push 10-29 | `TrustedHostMiddleware` [재현] |
| uvicorn | 0.54.0 | 예 | 2026-09-25 | 최신 | push 10-25 | `Server.serve(sockets=)` [재현] |
| Trafilatura | 2.3.1 | 예 | 2026-10-06 | 최신 | push 10-30 | 3.14에서 추출 동작 [재현] |
| feedparser | 6.0.14 | 예 | 2026-07-30 | 최신 | push 10-06 | 3.14에서 파싱 동작 [재현] |
| Schemathesis | 4.32.7 | 예 | 2026-10-27 | 최신 | push 10-31 | CLI 동작 [재현] |
| openapi-spec-validator | 0.9.0 | 예 | 2026-05-20 | 최신 | | 3.1.1 스펙 통과 [재현] |
| oasdiff | 1.35.0 | 예 | 2026-10-28 | 최신 | push 10-30 | `checksums.txt` 일치, `breaking` 동작 [재현] |
| openapi-typescript | 7.13.0 | 예 | 2026-02-11 | `latest` | 저장소 push 09-25, 릴리스 8.5개월 없음 | `npx`로 생성 성공, typescript 5.9.3 자동 설치 [재현] |
| restic | 0.19.1 | 예 | 2026-07-05 | 최신 | push 10-18 | `SHA256SUMS` 일치, `--retry-lock`, `--read-data-subset`, `--from-repo` [재현] |
| KURE-v3 | 리비전 `c74871cd` | 예 | 2026-10-21 수정 | | 2026-10-15 공개 | Apache-2.0, 가중치 2.28 GB, `auto_map` 없음, 카드에 1024 절단 명시 [원문] |
| KURE-Reranker-nano | 리비전 `8514b9e1` | 예 | 2026-10-21 수정 | | 2026-09-09 공개 | Apache-2.0, 가중치 0.60 GB, `auto_map` 없음 [원문] |
| lxml, PyYAML, jsonschema | 6.1.3, 6.0.3, 4.26.0 | 예 | | 최신 | | 3.14 휠 또는 순수 휠 [재현] |
| torch | 2.15.0 | 예 | 2026-10-28 | 최신 | | `cp314` manylinux 휠, sentence-transformers 6.2.0·transformers 5.22.1과 해석 성공 [재현] |
| FastMCP(기각안) | 4.1.4 | 예 | 2026-10-26 | 최신 | | |
| rtk | v1.1.0 | 예 | 2026-10-25 | 최신 | | 실행하지 않았다 |
| SQLite | 3.53.1, 가드 3.51.3 | 예 | | 최신 3.54.1(10-16) | | WAL-reset 범위 3.7.0~3.51.2 [원문] |

**전체 잠금 [재현].** WP-00의 세 그룹을 한 `pyproject.toml`에 넣어 3.14.10으로 `uv lock`과 `uv sync --all-extras --frozen`을 돌렸다. 80개 패키지가 충돌 없이 해석되고 설치됐다. 지정 API 불일치는 없다. 유일한 결함은 FACT-08이다.

## 4. Claude Code 동작

설치판은 2.1.316이다. 실행은 전부 가짜 HOME이고 로그인이 없어 모델 호출이 없다. 그래서 `structured_output` 실제 생성은 재현하지 않았다.

| 주장 | 공식 문서 | 설치판 [재현] | 판정 |
|---|---|---|---|
| `--tools ""` | "Use `""` to disable all". MCP 도구에는 영향 없음[T31] | `init.tools`가 `['StructuredOutput']`뿐 | 통과. `--strict-mcp-config`가 함께 있어야 도구 0개다 |
| `--json-schema` | `structured_output` 필드. 없을 수 있으니 확인하라고 적음[T31] | 잘못된 JSON은 시작 전 오류 | 통과. ADR의 판정 규칙이 문서와 맞다 |
| `--setting-sources ""` | 값 목록만 있고 빈 값은 문서에 없다[T31] | 허용됨. 사용자·프로젝트 훅 실행 0, `.mcp.json` 연결 0. 대조군은 둘 다 실행 | 통과. 재귀 방지 주장 확인 |
| ADR 10.5 전체 플래그 | 각 플래그 존재 | 함께 파싱, `Not logged in`으로 종료 | 파싱 통과. 전체 조합의 응답은 미재현(FACT-14) |
| ADR 20.3 전체 플래그 | 각 플래그 존재 | `tools`가 `WebFetch, WebSearch, Workflow`, `dontAsk` | 통과 |
| `--permission-prompts none` | v2.1.259 이상[T31] | 동작 | 통과 |
| `--max-budget-usd` 사후 검사 | "Spend can pass the cap"[T31] | | 통과 |
| `--bare` 기본화 예고 | "will become the default for `-p` in a future release"[T31] | | 통과 |
| `--bare`는 구독 불가 | "never reads OAuth credentials"[T31] | | 통과 |
| `stream-json` | `--verbose`와 함께 쓰는 예시[T31] | 동작 | 통과 |
| `rate_limit_event` | `SDKRateLimitEvent` 공개 타입[T31] | 스키마 문자열 확인 | 이벤트는 통과, 필드 경로는 FACT-12 |
| `anthropic/alwaysLoad` | `_meta`, `true`면 upfront, "Startup doesn't wait for your server because of this value"[T31] | SDK가 `_meta`에 실음 | 통과. 서버 설정 `alwaysLoad`(5초 대기)와 다르다 |
| 지침 4,096자, 출력 10,000/25,000 | 일치[T31] | | 통과 |
| `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` | "set it to `0` to wait without one"[T31] | | 통과 |
| `SessionEnd` 1.5초 | 일치, 훅 `timeout`으로 최대 60초[T31] | | 통과 |
| `omitClaudeMd`, `maxTurns` | 일치[T31] | | 통과 |
| 프로젝트 `permissions.allow`는 trust 없으면 무시 | `-p`에서 "Not used"[T31] | | 통과 |
| `-p`는 프로젝트 훅을 신뢰 없이 실행 | 일치[T31] | 대조군에서 실행 확인 | 통과 |
| 전사 30일 삭제 | `cleanupPeriodDays` 기본 30[T31] | | 통과 |
| 구독 `claude -p` | 2026-06-15 "We’ve paused the previously-announced changes ... still draw from your subscription limits"[T36] | | 통과. FACT-15 참고 |
| 15초 유휴 종료 | WSL `instanceIdleTimeout` 기본 15000, "-1 to disable"[T37] | | 통과. 기본값이고 설정 가능하다 |
| **세션 종료 시 stdin EOF** | Linux는 `SIGINT`, 100 ms 뒤 `SIGTERM`, 400 ms 뒤 `SIGKILL`[T31] | SIGINT, 101 ms 뒤 SIGTERM. stdin EOF 기록 없음 | **실패.** FACT-07 |

"MCP 유휴 종료"라는 표현에 대해 정리한다. ADR 15.1의 15초는 MCP가 아니라 WSL 인스턴스 값이다. Claude Code 문서의 MCP 유휴 값은 도구 호출 유휴 시간 제한(stdio 30분)이고 서버 종료가 아니다[T31]. 세션 도중 stdio 서버가 죽으면 대화형 세션은 실패 표시 후 수동 재연결, `-p`는 다음 호출 때 재시작한다[T31].

**FACT-07 재현 수치.**

| 시험 | 결과 |
|---|---|
| 신호 기록 서버 + 실제 `claude -p` | `SIGINT` .115, `SIGTERM` .216. `stdin EOF` 없음, 8초 뒤 기록 없음. 강제 종료된 것으로 보인다 |
| 공식 SDK, `run()` 복귀 뒤 분리 실행(WP-12 그대로) | `start` 뒤 기록 없음. 실행 안 됨 |
| 공식 SDK, `finally`에서 분리 실행 | `start` 뒤 기록 없음. 실행 안 됨 |
| 대조: SDK에 SIGINT만 전송 | 1.5초 뒤에도 생존 |
| 대조: SDK의 stdin을 닫음 | 0.164초에 종료, 분리 실행 성공 |
| SIGINT 핸들러에서 분리 실행 + `os._exit` | 즉시 실행, 3초 뒤 분리 프로세스 생존 |

## 5. 외부 서비스

| 서비스 | 원문 | ADR 대조 |
|---|---|---|
| healthchecks.io 무료 | Hobbyist $0, "Monitor 20 jobs", "100 log entries per job", 한도 초과 시 "the oldest log entries are removed"[T38] | 체크 3개는 충분하다. tick 15분이면 약 25시간분만 남는다 [추론]. 복원은 앵커 대조가 tick 재개보다 앞이라(ADR 17.4) 문제 없다 |
| healthchecks.io 응답 | "200 OK (not found)", "200 OK (rate limited)", 본문 "the first 100 kB", 5회/분 초과 시 제한[T38] | WP-15의 "응답이 정확히 OK" 검사가 맞다 |
| Cloudflare R2 무료 | "10 GB-month / month", Class A 100만, Class B 1,000만, 이그레스 무료, "only applies to Standard storage"(2026-10-30 갱신)[T39] | ADR은 무료를 전제하지 않고 Durability만 "10 GB 무료로 시작"이라 적었다. 그 뒤 T1에 모델과 휠이 들어갔다. 가중치 2.88 GB + rank 휠 3.08 GB + CAS 1~2 GB/년 + 원장 0.3 GB/년으로 1년차 약 7 GB다 [추론]. 초과분은 사용량 과금이다 |
| R2 결제 수단 | 공식 요금 문서에는 없다. 커뮤니티 답변은 구독 추가 때 카드 등록을 요구하고 사용량 상한이 없다고 적는다[T39, 2차] | 결정 2에 고지가 없다(FACT-13) |
| SEC EDGAR | "Current max request rate: 10 requests/second", 표본 UA `Sample Company Name AdminContact@<sample company domain>.com`, "does not allow botnets or automated tools to crawl the site"[T40] | 연락처 요구가 맞다. 인벤토리의 10 req/s도 맞다. 직접 내려받기는 403이고 WebFetch로 확인했다. 정책 범위 안의 프로그램 접근은 허용되는 것으로 읽힌다 [추론] |

## 6. 결함 목록

### blocker

**FACT-01. D18, D19가 YouTube 호스트인데 초기 활성이다.**

- 위치: ADR 10.4, 11장, 23장 결정 1. 빌드 계획 WP-21.
- 내용: ADR 10.4 활성 목록 "D17~D23"에 D18, D19가 있고 11장 `feed`, `docs` 주기표에도 있다. URL은 `https://www.youtube.com/trends/`, `https://www.youtube.com/howyoutubeworks/recommendations/`다(인벤토리 주석). 반면 ADR 23은 "전부 꺼짐", WP-21 지시는 "EDGAR, YouTube, suggest에 요청하지 않는다", 인수 조건은 "ops.db fetch_log에 youtube.com ... 호스트 요청 0건"이다.
- 영향: `test_hosts.py`가 실패하거나, 시험을 느슨하게 해 YouTube 자동화 조항[T1] 대상을 기본 활성으로 두게 된다. 이 소스를 끈 P07과 같은 조항이다.
- 수정: D18, D19를 `enabled:false`로 옮기고 결정 1에 넣는다. D19는 `support.google.com/youtube/answer/16089387` 판으로 대체한다. D18은 대체가 없으면 사람 입력 경로로 둔다.

### major

**FACT-02. ADR 23 결정 1의 문장이 잘못된 결정을 유도한다.**

- 위치: ADR 23장 결정 1, 10.4 비활성 표.
- 내용: 1.3절. 양자택일 틀, RSS 일괄 처리, 배타 근거 오인, III.E.2·III.I.14·III.D·limited amounts·III.L 누락, Google 계정 종료 누락, "막히는 것"의 과대 서술.
- 수정: 결정 1을 1.1 표로 바꾼다. 키가 없어도 yt-dlp·InnerTube는 문구상 금지라고 명시한다.

**FACT-03. "키가 생기면 `enabled`만 켠다. 코드 변경 없음"이 사실이 아니다.**

- 위치: ADR 10.4 표, 7.9 `ttl30`. 빌드 계획 WP-07.
- 내용: 세 가지다. (1) P01~P03은 동의 순간 API 계약에 묶여 결정 1을 우회한다. (2) WP-07 어댑터 목록에 Data API, Analytics, Reporting 어댑터가 없고 `safe_fetch`에 자격 증명 경로가 없다. (3) `ttl30`은 `raw/ttl` 객체만 지운다. 그 응답에서 나온 주장과 `series.batch`는 수정 불가 원장, CAS, 머신 밖 백업에 남는다. 정책은 "must either delete or refresh the stored data"다[T3]. L2 추출은 "new or derived data"에도 걸린다.
- 추가: P15는 프로그램 접근 경로가 없어 키로 켤 수 없다. P02는 OAuth Testing 7일 만료[T13]와 토큰 실패 시 삭제 의무[T3]가 있다. HTTP `/v1`과 MCP로 내보내는 것이 III.I.15에 닿는지는 불명확하다.
- 수정: P01~P03, P08을 결정 1 행으로 옮긴다. 별도 패키지로 어댑터, OAuth, 갱신·삭제를 설계한다. API Data를 원장 밖에 두거나 `ttl30`을 파생 이벤트까지 넓힌다. ADR 7.9의 `ttl30` 행을 함께 고친다.

**FACT-04. 활성 소스 3건이 robots 전체 차단이고 실패가 가려진다.**

- 위치: ADR 10.4, 10.2 3단계. 빌드 계획 WP-06, WP-07, WP-21.
- 내용: WP-06은 "robots.txt 캐시와 준수"인데 X11, D11, X15가 `*` 전체 차단이다[재현]. `netflix_tsv`, `arxiv` 어댑터를 만들어도 수집되지 않는다. 레지스트리 `policy`에 예외 필드가 없다. WP-21의 `.failed_sources <= (.sources * 0.1)`이 이를 통과시킨다.
- 수정: X11, D11을 비활성으로 옮긴다. X15는 API 약관 URL을 근거로 하는 명시적 예외 필드를 둔다. robots 차단을 일시 실패와 다른 상태로 집계한다. WP-07 시험에 활성 소스 robots 고정 대조를 넣는다.

**FACT-05. 약관이 자동 수집을 금지하는 소스가 활성이고 기준이 일관되지 않다.**

- 위치: ADR 3장, 10.4. 인벤토리 ToS 열.
- 내용: ADR은 약관 문구로 P11, P12, D05를 껐다. 같은 기준이면 D20, X11도 꺼야 한다. OpenAI 계열은 문구가 넓고 허용 신호가 있어 D05와 같은 부류인데 D05만 꺼져 있다. 인벤토리는 X11, D20, D21을 "미확인"으로 뒀다. ADR 10.4 예시는 `tos: ok`뿐이고 등급 정의가 없다.
- 수정: `tos` 등급을 정의한다. 예: `forbidden`, `signals_conflict`, `no_clause`, `unverified`. `forbidden`은 기본 비활성, `signals_conflict`는 사용자 고지 뒤 활성으로 통일한다.

**FACT-06. 키를 고르면 활성 문서형 소스도 같은 조항 아래로 들어온다.**

- 위치: ADR 23장 결정 1, 10.4.
- 내용: "Google Applications"의 정의는 "Google websites, applications, services, products, pages, and other properties"다[T3]. "YouTube Applications"도 "YouTube websites, ... pages, and other properties"다[T3]. 키 보유 시 D13(YouTube 공식 블로그), D15, D22(Google 도움말), D18, D19를 자동 수집하는 것이 "scrape"인지가 쟁점이 된다. RSS와 공개 문서 읽기까지 이 낱말에 드는지는 문구에 없다. P10은 YouTube 유래 수치이고 취득 방식이 미공개라 "obtain scraped YouTube data or content"가 쟁점이다. ADR에 없다.
- 수정: 결정 1 표에 "키 선택 시 재검토 소스"를 적는다. 판단은 사용자 몫이다.

**FACT-07. 세션 종료 전송이 Linux에서 동작하지 않는다.**

- 위치: 빌드 계획 WP-12 "세션 종료(stdin EOF) 때". ADR 15.1, 4장 T0 "세션 종료 시 즉시 시도".
- 근거: 4장 표. 문서[T31]와 설치판이 일치한다. 원인이 SDK의 stdin 읽기 차단이라는 것은 [추론]이다.
- 영향: 인수 조건에 이 경로가 없어 시험은 녹색이고 전송은 일어나지 않는다. WSL이 15초 뒤 내려가면 다음 기동까지 T0가 머신 밖으로 나가지 않는다.
- 수정: `kb-mcp`가 SIGINT, SIGTERM 핸들러에서 100 ms 안에 `start_new_session=True`로 `kb ship`을 띄우고 `os._exit(0)`한다. 인수 조건에 실제 `claude -p` 종료 시험을 넣는다. 이 저장소 세션은 `timeout` 있는 `SessionEnd` 훅을 병행할 수 있다.

**FACT-08. 계획의 환경 변수로는 관리형 Python이 HOME에 또 깔린다.**

- 위치: 빌드 계획 WP-00. ADR 2장 F2, 결정 6.
- 재현: `uv python install --no-bin --install-dir $KB_HOME/runtime/python` 뒤 계획의 변수만으로 `uv lock`을 돌리자 Python을 다시 받아 가짜 HOME에 3,528파일이 생겼다. `venv`의 인터프리터가 `~/.local/share/uv/python/...`를 가리켰다. `UV_PYTHON_INSTALL_DIR=$KB_HOME/runtime/python`을 더하면 가짜 HOME 0파일이고 인터프리터가 `KB_HOME` 아래로 온다.
- 영향: 첫 패키지부터 전역 쓰기 사고가 난다. F2의 "HOME 0파일"은 설치 단계까지만 참이다. 오프라인 복원에서 런타임을 찾지 못할 수 있다 [추론].
- 수정: `ops/bin/env.sh`에 `UV_PYTHON_INSTALL_DIR`를 넣는다. WP-00 인수 조건에 `ops/bin/dev` 실행 뒤 HOME 파일 0을 더한다.

### minor

| ID | 위치 | 내용 | 수정 |
|---|---|---|---|
| FACT-09 | ADR 10.4 | P04, P09의 사유 "자동화 조항, robots"가 부정확하다. Google 조항은 robots 조건부다. P09는 Explore, 내부 API, RSS의 판정이 다르다 | P09를 세 행으로 나눈다 |
| FACT-10 | ADR 10.4 | D05 사유가 반대 신호를 뺐다. `Content-Signal: ai-train=yes, search=yes, ai-input=yes`[T20] | 사유에 병기한다 |
| FACT-11 | ADR 10.4, 11장 | U03 URL이 404다(두 UA) [재현]. U16은 "미조사"인 채 활성이다 | 경로 확인 뒤 활성화 |
| FACT-12 | ADR 10.5, WP-19 | `five_hour.utilization`은 공개 타입에 없다. 공개 타입은 `rate_limit_info.utilization?`이고, 설치판 스키마에 `unifiedWindows.five_hour`가 있다. 문서는 "Emitted when the session encounters a rate limit"이다[T31]. 값이 없을 때 동작이 정의되지 않았다 | 경로를 고정하고 값 없음을 시작 안 함으로 처리한다 |
| FACT-13 | ADR 23 결정 2, 17.1 | R2의 카드 등록, 사용량 무상한, T1 확대가 고지되지 않았다 | 결정 2에 적는다 |
| FACT-14 | WP-19 "실측 F11로 확인된 조합" | F11 표의 플래그는 일부이고 `adr/l2/e.txt`는 빈 파일이라 전체 조합의 실제 응답 증거가 없다 | WP-19 카나리아가 전체 플래그로 1회 돈다 |
| FACT-15 | ADR 24 구독 정책 | "Advertised usage limits ... assume ordinary, individual usage"[T31]와 "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it"[T30]가 빠졌다. `claude -p` 구독 사용은 문서가 안내하므로 허용 쪽이다[T31][T36]. 일일 400창 무인 실행이 이 전제에 맞는지는 정의가 없다 | 위험 표에 병기한다 |

사실 오류를 찾지 못한 항목은 통과로 둔다. 조사 중 의심했던 "CLAUDE.md 작업 규칙 인용 오류"는 디스크의 CLAUDE.md 61~62행에 규칙이 있어 결함이 아니다.

## 7. 재현 사양과 부수 효과

**재현 사양.** 스크립트는 scratchpad `audit/scripts/`에 있고 tmpfs라 재부팅하면 사라진다.

| 시험 | 사양 |
|---|---|
| uv, CPython | `install.sh` 해시 대조, `UV_UNMANAGED_INSTALL`, `uv python install 3.14.10 --no-bin --install-dir`. 전부 `env -i` 가짜 HOME |
| 잠금 | WP-00 그룹 그대로 `pyproject.toml`, `requires-python = ">=3.14,<3.15"`, `uv lock`, `uv sync --all-extras --frozen` |
| HOME 오염 | 위를 `UV_PYTHON_INSTALL_DIR` 유무로 비교 |
| stdio 종료 | `env -i HOME=<가짜> ... claude-2.1.316 -p hi --tools "" --setting-sources "" --strict-mcp-config --mcp-config <서버> ...`. 서버는 신호 기록용, 공식 SDK 2종, 핸들러형 |
| L2 차단 | 가짜 HOME과 프로젝트에 훅, `.mcp.json`을 심고 `--setting-sources ""` 유무 비교 |
| 활성 소스 | `active_probe.py`. UA `kb-collector/0.1`, 호스트 robots 1회, URL GET 1회, 간격 1초 |

**부수 효과.**

| 대상 | 내용 |
|---|---|
| 호출하지 않은 것 | 자동완성, InnerTube, yt-dlp, 채널 RSS, D18, D19 본문, EDGAR 데이터 경로 0건 |
| 약관 페이지 읽기 | `www.youtube.com/t/terms`, `/static?template=terms`, `robots.txt`. 과제가 허용한 범위이고 `/t/terms`는 robots Disallow다 |
| 외부 요청 | PyPI, npm, GitHub(`gh` 로그인 토큰 사용), Hugging Face, 공식 문서, 약관 페이지, web.archive.org(OpenAI, Nielsen 약관). 개인 정보를 넣지 않았다 |
| robots 차단 경로 GET | **`www.netflix.com/tudum/top10/data/all-weeks-global.tsv`(앞 300 KB), `www.kobaco.co.kr/site/adstat/board/broadcastprice/list`, `export.arxiv.org/api/query` 1회씩.** 프로브가 판정 뒤 건너뛰지 않고 GET까지 했다. `incidents`에 적었다 |
| 전역 파일 | `~/.claude`, `~/.claude.json`, 셸 프로필, crontab, systemd, rtk·trail 상태 변경 없음. rtk, trail 실행 0회. `claude`는 가짜 HOME에서만 실행했다. `npm view`가 `~/.npm` 캐시와 로그를 썼다 |
| 디스크 | `~/.cache/sagae-kb/scratch/audit/` 아래 시험 디렉터리를 만들고 끝난 뒤 지웠다 |
| 커밋 | 없음 |

## 8. 출처

확인일은 전부 2026-10-31이다.

| 번호 | 출처 |
|---|---|
| T1 | YouTube Terms of Service, 한국판 https://www.youtube.com/t/terms?hl=en&gl=KR (Dated January 5, 2022, English Courtesy Translation), 한국어 https://www.youtube.com/static?template=terms&hl=ko&gl=KR . 한국어 자동화 조항: "자동화된 수단(로봇, 봇넷 또는 스크래퍼 등)을 사용해 서비스에 액세스하면 안 됩니다." 미국판은 December 15, 2023 |
| T2 | Google Terms of Service, https://policies.google.com/terms (Effective July 30, 2026). 서비스별 추가 약관에 Trends 항목 없음 https://policies.google.com/terms/service-specific |
| T3 | YouTube API Services Developer Policies, https://developers.google.com/youtube/terms/developer-policies (Last updated 2026-10-15). 정의 IV 포함 |
| T4 | Additional policies for derived metrics and data storage, https://developers.google.com/youtube/terms/derived-metrics-policy (2026-09-14) |
| T5 | YouTube API Services Terms of Service, https://developers.google.com/youtube/terms/api-services-terms-of-service , APAC판 https://developers.google.com/youtube/terms/api-services-terms-of-service-apac (둘 다 2026-09-14, 2~3절 동일) |
| T6 | Complying with YouTube's Developer Policies, https://developers.google.com/youtube/terms/developer-policies-guide (2026-09-14) |
| T7 | https://www.youtube.com/robots.txt |
| T8 | https://trends.google.com/robots.txt , https://www.google.com/robots.txt |
| T9 | Subscribe to Push Notifications, https://developers.google.com/youtube/v3/guides/push_notifications (2026-10-15). 고객센터 검색에서 폴링 경로 문서를 찾지 못했다 |
| T10 | Quota Calculator, https://developers.google.com/youtube/v3/determine_quota_cost (2026-10-15) |
| T11 | Google Trends API Alpha, https://developers.google.com/search/apis/trends |
| T12 | Export, embed, and cite Trends data, https://support.google.com/trends/answer/4365538 |
| T13 | Using OAuth 2.0, https://developers.google.com/identity/protocols/oauth2 (2026-10-29) |
| T14 | Terms revision history, https://developers.google.com/youtube/terms/revision-history |
| T20 | Pew, https://www.pewresearch.org/about/terms-and-conditions/ , https://www.pewresearch.org/llms.txt , https://www.pewresearch.org/robots.txt |
| T21 | Playboard Terms, https://playboard.co/en/policies/terms |
| T22 | Social Blade Terms, https://socialblade.com/info/terms |
| T23 | 네이버 이용약관, https://policy.naver.com/rules/service.html |
| T24 | https://www.netflix.com/robots.txt , https://help.netflix.com/legal/termsofuse (Last Updated April 10, 2026) 1.8절, https://www.netflix.com/tudum/top10 |
| T25 | Ahrefs Terms, https://ahrefs.com/legal/terms 1.1, 4.4절 |
| T26 | https://www.kobaco.co.kr/robots.txt |
| T27 | https://export.arxiv.org/robots.txt , https://info.arxiv.org/help/api/tou.html |
| T28 | OpenAI Terms of Use(Effective January 1, 2026), https://openai.com/policies/row-terms-of-use/ . 직접 요청은 403이어서 web.archive.org 2026-10-23, 10-31 사본으로 읽었다 |
| T29 | Stack Overflow Acceptable Use Policy, https://stackoverflow.com/legal/acceptable-use-policy |
| T30 | Anthropic Consumer Terms, https://www.anthropic.com/legal/consumer-terms (Effective Oct 8, 2025) |
| T31 | Claude Code 문서 https://code.claude.com/docs/en/ 의 `cli-reference`, `headless`, `mcp`, `hooks`, `env-vars`, `sub-agents`, `permissions`, `settings-reference`, `legal-and-compliance`, `authentication`, `agent-sdk/typescript`, `workflows` |
| T32 | Y Combinator Terms of Use, https://www.ycombinator.com/legal/ |
| T33 | GitHub Acceptable Use Policies, https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies |
| T34 | Hugging Face Terms, https://huggingface.co/terms-of-service |
| T35 | DataReportal Legal, https://datareportal.com/legal |
| T36 | Use the Claude Agent SDK with your Claude plan, https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan |
| T37 | Advanced settings configuration in WSL, https://learn.microsoft.com/en-us/windows/wsl/wsl-config (2026-10-16) |
| T38 | https://healthchecks.io/pricing/ , https://healthchecks.io/docs/http_api/ |
| T39 | R2 pricing, https://developers.cloudflare.com/r2/pricing/ (2026-10-30). 2차: https://community.cloudflare.com/t/why-using-r2-free-tier-involves-giving-card-info/945179 |
| T40 | Accessing EDGAR Data, https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data |
