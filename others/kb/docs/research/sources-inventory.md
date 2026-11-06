# 유튜브·영상 플랫폼 데이터 소스 인벤토리

3단계 수집의 소스 지도다. 사실만 기록하고 순위·점수·제언은 넣지 않는다(운영 지침 5).

- 확인일: 2026-10-31. 실측 구간은 같은 날 06:15~07:23 UTC다. 주석마다 확인일을 적었다.
- 근거 표기: **[실측]** 이 환경(WSL2, 로컬 IP)에서 호출한 결과, **[1차]** 공급자 원문을 받아 문구를 확인한 것, **[2차]** 제3자 보도·검색 요약으로 1차 원문을 확인하지 못한 것.
- `수집 주기` 열은 소스 자체의 갱신 주기를 옮긴 값이다. 판단이 아니다. 제3자 권고는 "출처가 주장"으로 귀속해 적었다.
- 실측 원본은 보존하지 않았다. 재현 명령과 수치는 §11에 있다.

## 1. 핵심 사실

1. Data API 쿼터가 2026-06-01에 세분화됐다. `search.list`는 별도 버킷 기본 100회/일(호출당 1), `videos.insert`도 별도 버킷 100회/일, 나머지는 합산 10,000유닛/일이다. 호출당 100유닛이라는 구 서술은 현행 문서와 다르다.[^quota][^revs]
2. 개정 이력에 따르면 `mostPopular`는 2025-07-21부터 Trending Now 대신 Trending Music·Movies·Gaming 차트 영상을 담는다. 키가 없어 응답으로 확인하지는 못했다. Trending 페이지도 폐지됐고, 비로그인 `/feed/trending`은 영상 0개인 홈 응답을 준다.[^revs] [실측 M-7]
3. Developer Policies는 비인증 통계의 30일 초과 저장, 파생 지표 생성, YouTube 사업 통찰 목적의 집계, API 클라이언트의 스크래핑 데이터 취득을 금지한다. 2026-06-01부터 감사를 통과한 분석 용도에 한해 통계·파생 지표 36개월 저장 예외가 생겼다. 제목·설명·댓글 본문은 예외가 아니다.[^policy][^derived]
4. 채널 RSS(`/feeds/videos.xml`)는 시간대에 따라 응답이 갈렸다. 같은 URL이 06:58 UTC까지 404였고 07:06 UTC부터 200이었다(§3.2 P07). Umbraco 이슈가 보고한 실패 시간대 22:00~07:00 UTC와 맞고, 포럼 보고의 09:00~12:00 UTC와는 다르다. 2025-12부터 간헐 404 보고가 이어진다.[^rss-forum][^rss-umbraco]
5. 키 없이 구조화 응답을 받은 경로: suggest, 채널 RSS(07:06 UTC 이후), yt-dlp, youtubei.js, youtube-transcript-api, pytrends, Trends RSS, Kworb, YouTube Charts 내부 API, 치지직·SOOP 내부 API, Netflix Top 10 TSV, EDGAR, arXiv, HN Algolia. [실측]
6. Playboard·Social Blade·YouTube·네이버 약관은 자동화 수집을 금지하거나 제한한다. `robots.txt` 허용과 약관 금지가 다른 소스가 있다(§3.1).
7. YPP 진입 기준이 2027-02-01부터 신규 채널에 한해 8,000시간/365일 또는 Shorts 2,000만/90일로 오른다. 구독자 1,000명은 유지된다.[^ypp-changes]
8. 공개 조회수 정의가 2026-08-24부터 전 포맷에서 재생 시작 시점으로 통일됐다. 수익·YPP 판정은 engaged·qualified 지표를 쓴다.[^views-help][^arevs]
9. 발행 일정이 달라진 문서형 소스가 있다. Nielsen은 미국 9·10월 Gauge를 합본 발행하고, Netflix 참여도 리포트는 2027년 1분기부터 연 1회가 되며, DataReportal은 Digital 2027 총괄판을 2026-10-21에 냈다.[^nielsen-aug][^nflx-h1][^dr-reports]

## 2. 실측 제약

| 제약 | 내용 | 근거 |
|---|---|---|
| API 데이터 보존 | 비인증 데이터·통계는 30일을 넘길 수 없고, 30일 후 삭제 또는 갱신 | [^policy] III.E.4.c·d |
| 저장 예외 | 감사 통과 + Analytics & Reporting 용도 신청 시 통계·파생 지표 최대 36개월. 그 외 데이터는 30일 규칙 유지 | [^derived] |
| 파생 지표 | 비승인 클라이언트는 API 데이터로 "new or derived data or metrics" 생성 금지 | [^policy] III.E.4.h |
| 시장 분석 | "gain insights into YouTube's usage, revenue, or any other aspects of YouTube's business" 목적의 집계·사용 금지 | [^policy] III.E.2 |
| 스크래핑 | API 클라이언트는 YouTube를 스크래핑하거나 "obtain scraped YouTube data or content"를 하면 안 됨 | [^policy] III.E Scraping |
| 영상 사본 | "download, import, backup, cache, or store copies of YouTube audiovisual content" 사전 서면 승인 없이 금지 | [^policy] III.E |
| YouTube 약관 | 공개 검색엔진 외 자동화 수단 접근은 사전 서면 허가 필요 | [^yt-tos] |
| YouTube robots | `/feeds/videos.xml`, `/youtubei/`, `/results`, `/api/`, `/comment` Disallow. `charts.youtube.com`도 같은 파일 | [실측 M-7] |
| RSS 가용성 | 표본에서 06:15~06:58 UTC 404, 07:06~07:22 UTC 200. 채널·재생목록당 최신 15건 | [실측 M-5] |
| Owner 전용 지표 | 유입 경로·리텐션·노출·CTR·수익은 채널 소유자 OAuth 필요. 처리 지연 48~72시간, 수익 지표는 비수익 채널에 `403` | [^arevs][^reporting] |
| 공개 리텐션 근사 | 공개 경로에서 확인한 것은 yt-dlp `heatmap`뿐. 조회 수가 적은 영상은 비어 있음(1,217회 영상 0포인트) | [실측 M-3] |
| Trends 공식 API | 신청제 알파. 공개 문서에서 YouTube 검색 속성 언급 미확인 | [^trends-page][^trends-blog] |
| 브라우저 부재 | Chrome 없음. trendspyg의 CSV·Explore 경로 사용 불가 | [실측 M-8] |
| JS 런타임 | yt-dlp 기본 런타임은 Deno인데 이 환경에 없음. Node 26은 `--js-runtimes node`로 동작 | [실측 M-3] |
| ffmpeg | 없음. `imageio-ffmpeg`로 7.0.2 정적 바이너리 확보 가능하나 `nvenc` 인코더 없음 | [실측 M-12] |
| 차단 소스 | Ofcom·FlixPatrol은 로컬과 WebFetch 모두 403, eMarketer 주제 페이지 403, WiseApp은 AWS WAF 챌린지 | [실측 M-10] |
| 경로별 접근 차이 | Social Blade는 WebFetch 403·로컬 200, Streams Charts는 로컬 403·WebFetch 200 | [실측 M-6, M-10] |
| 연구자 프로그램 | YouTube Researcher Program은 인가 고등교육기관 소속만 가능. TikTok Research는 한국 미포함, Meta Content Library는 기관 소속 필요 | [^yt-research][^tiktok-research][^mcl] |
| 키 미보유 | YouTube Data API 키 없음. 키 없는 호출은 `403 forbidden` | [실측 M-1] |

## 3. 프로그램 접근 소스

### 3.1 소스 표

도메인: A 키워드맵, B 시장, C 트래픽, D 채널 설계, E 마케팅, F 개발.

| ID | 소스 | 키 | 갱신 주기 | 비용 | ToS·법적 주의 | 도메인 | 수집 주기 | 접근 상태 |
|---|---|---|---|---|---|---|---|---|
| P01 | YouTube Data API v3 | API 키 | 문서가 `videos.list`를 실시간 통계 용도로 지칭. 쿼터는 PT 자정 초기화 | 요금표 없음. 쿼터 초과분은 감사 후 증설 | 30일 보존, 파생 지표·시장 통찰 금지 | A D F, 일부 B C | 호출 시점 값. 쿼터 일 단위 | 키 없어 미사용. 무키 `403` |
| P02 | YouTube Analytics API | 채널 소유자 OAuth | 처리 지연 48~72시간 | 요금표 없음 | Authorized Data는 장기 저장 가능, 30일마다 권한 재확인 | C D | 일 1회 | 채널·OAuth 없어 미사용 |
| P03 | YouTube Reporting API | 채널 소유자 OAuth | 일 1회 CSV. 파일 60일, 과거 데이터 30일 제공 | 요금표 없음 | P02와 동일 | C D | 일 1회 | 채널·OAuth 없어 미사용 |
| P04 | suggest 엔드포인트 | 없음 | 비공개. `client=youtube`는 `max-age=3600` | 무료 | 비공식. Google ToS의 자동화 조항. 호스트 `robots.txt` 404 | A | 응답 캐시 1시간 | 가능. 35회 전부 200 |
| P05 | yt-dlp | 없음 | 호출 시점 값 | 무료 | YouTube 약관의 자동화 조항. 게스트 ~300영상/시 | A C D F | 호출 시점 값 | 가능. 메타·자막·댓글 성공 |
| P06 | InnerTube (youtubei.js) | 없음 | 호출 시점 값 | 무료 | `/youtubei/` Disallow, YouTube 약관 | A C D F | 호출 시점 값 | 가능. 일부 기능 실패 |
| P07 | 채널 RSS / WebSub | 없음 | 신규 업로드 시, 최신 15건 | 무료 | `/feeds/videos.xml` Disallow. WebSub는 공식 문서 있음 | D F | 이벤트 기반 | 시간대 의존. 404 후 07:06 UTC부터 200. WebSub는 공개 콜백 필요 |
| P08 | Google Trends API 알파 | 알파 승인 | 2일 전까지, 5년 롤링 | 공개 요금 없음 | 신청제 | A B | 일 1회 | 미승인 |
| P09 | Trends 비공식 경로 | 없음 | 구간별 시·일·주 단위. RSS는 10~20분 간격 | 무료 | Google ToS, robots는 `/explore?`·`/trends/explore?` Disallow | A B | 시~일 | 가능. pytrends 5/5, RSS 정상 |
| P10 | Kworb | 없음 | 트렌딩 30분 간격, 메인 2시간 간격, 일·주 차트 | 무료 | robots `Allow: /`. 약관 페이지 미발견 | A B | 30분~주 | 가능 |
| P11 | Playboard | 없음(유료 플랜 안내 존재) | 일 10:00, 월요일 12:00, 매월 1일 13:00 | 미확인(`/en/pricing` 404) | 약관이 로봇·스크립트와 상업적 사용 금지 | B E | 일·주·월 | 가능하나 약관 금지 |
| P12 | Social Blade | 없음 / Business API 크레딧 | 일 1회 이력 | 플랜 $5.99~$149.99/월, API $0.50/크레딧부터 | 대량 복제·크롤링 금지. Business API는 허용 경로 | B D | 일 1회 | 웹 가능, API 키 없음 |
| P13 | YouTube Charts 내부 API | 없음 | 주간 | 무료 | 비공식. `/youtubei/` Disallow | B | 주 1회 | 가능. 100건 응답 |
| P14 | youtube-transcript-api | 없음 | 영상 단위 | 무료 | YouTube 약관 | C D F | 영상 단위 | 가능 |
| P15 | YouTube Studio Research 탭 | 채널 로그인 | 최근 28일 창 | 무료 | 프로그램 접근 경로 미확인 | A | 28일 창 | 채널 없어 미사용 |

주석: P01[^quota][^revs][^videos-list][^policy], P02[^arevs], P03[^reporting], P04[^google-tos][^suggest-2015], P05[^ytdlp-ext][^yt-tos], P07[^push][^rss-forum], P08[^trends-page][^trends-blog], P09[^google-tos], P11[^pb-terms][^pb-about], P12[^sb-terms][^sb-dev], P15[^research-tab].

### 3.2 소스별 세부

**P01 YouTube Data API v3**

- 쿼터: `videos.list` 1, `channels.list` 1, `playlistItems.list` 1, `commentThreads.list` 1, `captions.list` 50, `captions.insert` 400, `captions.update` 450. 잘못된 요청도 최소 1 차감.[^quota]
- `videos.batchGetStats`(2026-06-03): 호출당 1유닛, 자체 버킷 기본 10,000유닛/일. 반환은 `snippet.publishTime`, `statistics`, `contentDetails`, `summary.failedVideoIds[]`. 문서에 ID 개수 상한 표기 없음.[^revs][^batch]
- `chart=mostPopular`: `regionCode`, `videoCategoryId`, `maxResults` 1~50.[^videos-list]
- 2026-07-07 `brandPartner` 파트 추가(`videos.insert`·`update`·`list`), 영상에 연결된 브랜드 파트너 정보.[^revs]
- Analytics 문서는 실시간 영상 통계용으로 `videos.list`를 지목한다.[^arevs]
- 증설은 API Compliance Audit을 거친다. 승인된 용도에만 쓸 수 있다.[^policy]

**P02·P03 Analytics / Reporting**

- 트래픽 차원: `insightTrafficSourceType`(`ADVERTISING`, `RELATED_VIDEO`, `SHORTS`, `YT_SEARCH` 등), `insightTrafficSourceDetail`.[^a-dims]
- 포맷 차원: `creatorContentType`(`SHORTS`, `LIVE_STREAM`, `VIDEO_ON_DEMAND`, `STORY`).[^a-dims]
- 지표: `views`, `engagedViews`, `estimatedMinutesWatched`, `averageViewDuration`, `averageViewPercentage`, `audienceWatchRatio`, `relativeRetentionPerformance`, `estimatedRevenue`, `cpm`, `playbackBasedCpm`.[^a-metrics]
- 2026-01-15 Reporting에 `channel_reach_basic_a1`, `channel_reach_combined_a1` 추가. `video_thumbnail_impressions`, `video_thumbnail_impressions_ctr` 제공.[^arevs]
- 2026-03-09 `ageGroup`에 YouTube가 18세 미만으로 추정하는 사용자 포함.[^arevs]

**P04 suggest** [실측 M-2]

- `client=firefox`: 순수 JSON, 10건, `google:suggestsubtypes` 포함.
- `client=youtube`: JSONP(`window.google.ac.h(...)`), 14건.
- `client=chrome`: 15건, `google:suggestrelevance` 값이 601, 600, 562, 561처럼 순위를 따라 감소, `google:verbatimrelevance` 1300. 검색량 값이 아니다.
- `client=toolbar`: XML. `psy-ab`, `gws-wiz`: 강조 태그 포함.
- `ds=yt` 유무 차이: 질의 "브이로그"에서 겹침 4/10.
- 지역·언어 민감도: 질의 "vlog", ko/KR 기준 겹침 en/US 1/10, ja/JP 3/10, en/KR 3/10.
- 접두 확장: "유튜브 " + 자음 14개, 1.2초 간격, 14회 전부 200, 지연 155~179ms, 140건 중 고유 139건.
- 동일 질의 3회 반복 응답 동일.
- 응답에 검색량·시계열은 없다.

**P05 yt-dlp** [실측 M-3]

- `-J`로 받는 최상위 키 78~86개. `view_count`, `like_count`, `comment_count`, `channel_follower_count`, `categories`, `tags`, `chapters`, `heatmap`, `subtitles`, `automatic_captions`, `formats` 포함.
- `heatmap`: 구간별 정규화 값(최대 1.0). jNQXAC9IVRw 100포인트, SUW5c8RZ8WY(1,217회) 0포인트.
- `--flat-playlist` 채널 목록: 5건 574ms. `timestamp`는 None, `view_count`는 None이거나 반올림값(11000, 13000).
- `ytsearch5:`: 5건, 정확한 `view_count`, 설명 스니펫, `channel_id` 포함.
- 런타임 비교(같은 영상): 런타임 없음 33포맷 1,714ms, Node 40포맷 6,965ms. 자동자막 언어 160개는 동일.
- 자막: `--write-auto-subs --sub-format json3`, 한국어 62,543바이트, 210이벤트, 2,030자.
- 댓글: `--write-comments`, 6/6건, 필드 `author_id`, `like_count`, `parent`, `timestamp`, `is_pinned` 등.
- 자동자막 URL이 JSON의 대부분을 차지한다(1,694,415바이트 중 1,583,871바이트).
- yt-dlp 위키 주장: 게스트 세션 ~300영상/시(~1,000 웹·플레이어 요청/시), 계정 ~2,000영상/시, 다운로드 사이 5~10초 지연 권고, 계정 사용 시 차단 위험.[^ytdlp-ext]
- 위키 주장: 2026-07 기준 PO Token은 "Only GVS and Subs require PO Tokens for some clients". 이번 메타데이터 호출은 토큰 없이 성공.[^ytdlp-pot]
- 2026.10.21 릴리스는 구 실행 파일의 중간자 공격 취약 경고와 수동 다운로드 안내를 담았다. 2026.10.26은 Python 3.10 지원을 제거했다.[^ytdlp-rel]
- 위키 기준 런타임: Deno 2.3.0+, Node 22.0.0+, Bun 1.2.11+(지원 중단 예정), QuickJS. 기본 활성은 Deno만.[^ytdlp-ejs]

**P06 InnerTube / youtubei.js 18.3.0** [실측 M-4]

- `getSearchSuggestions`: 14건이나 한국어가 깨진다. 원인 확인: 라이브러리가 붙이는 `gs_ri=youtube`가 있으면 서버가 `charset=EUC-KR`로 응답하고, 라이브러리는 UTF-8로 읽는다. 해당 파라미터가 없으면 UTF-8이다.
- `search`: 394ms, 20건, `estimated_results` 870, 이어받기 가능, 조회수는 "조회수 7,705회" 형식 문자열.
- `getBasicInfo`: 123ms, 키워드·카테고리·`view_count`. `like_count`는 비어 있음.
- `getChannel().getAbout()`: "구독자 268만명", "조회수 371,631,057회", "동영상 6,125개", 국가, 가입일.
- `getComments`: 359ms, 페이지당 20건, 헤더 "댓글 10,645,411개". 같은 영상의 yt-dlp `comment_count`는 10,000,000.
- `getTrending`: 메서드 없음.
- `getInfo().getTranscript()`: `get_transcript` 400(jNQXAC9IVRw, `retrieve_player:false`, 1회).

**P07 채널 RSS / WebSub** [실측 M-5]

- 06:15:40~06:58:44 UTC: 실제 피드 요청 21회 전부 404. 채널 5종, `playlist_id`(UU·UULF·UUSH), `user`, 무-www, 모바일 호스트, HTTP/2, 브라우저 UA를 시험했다. 404 응답의 `Server` 헤더는 `YouTube RSS Feeds server`다.
- 07:06:46~07:22:51 UTC: 실제 피드 요청 10회 전부 200. 앞서 404였던 URL과 `playlist_id`·`user` 변형도 200이다.
- 응답: Atom, entry 15건. `yt:videoId`, `yt:channelId`, `published`, `updated`, `media:description`, `media:thumbnail`, `media:statistics@views`, `media:starRating@count`.
- 플레이리스트 접두어: `UU` 제목 `Uploads from ...`, `UULF` 제목 `Videos`, `UUSH` 제목 `Short videos`. 각 15건이라 Shorts와 롱폼을 나눠 받을 수 있다.
- 표본은 하루 약 1시간이다. 일별 재현성과 하루 가용률은 측정하지 않았다.
- `/xml/feeds/videos.xml?channel_id=...`는 200이지만 463바이트 정적 파일이다. 항목이 없고 WebSub 토픽 용도다.
- 외부 보고: Google AI 포럼 글쓴이는 2025-12-27부터 09:00~12:00 UTC 404를 보고했고 2026-05까지 이어졌다. 공식 답변 없음.[^rss-forum]
- 외부 보고: Umbraco 이슈는 2026-10-11~17 실행 30회 중 10회 실패, 실패는 22:00~07:00 UTC에 몰렸고 주간 16회는 성공.[^rss-umbraco]
- 외부 보고: newsboat 이슈(2026-02-14), web-boris 이슈(2026-10-19, 12회 연속 요청에서 200·404·500 혼재).[^rss-newsboat][^rss-boris]
- 공식 WebSub: 콜백 서버를 두고 허브에 `https://www.youtube.com/xml/feeds/videos.xml?channel_id=CHANNEL_ID`를 구독한다. 공개 콜백 서버가 필요하다.[^push]

**P08 Google Trends API 알파** [1차]

- 2025-07-24 발표. 1800일 롤링, 일·주·월·연 집계, 지역·하위 지역, "up to just 2 days ago".[^trends-blog]
- 0~100 재조정이 아닌 일관 스케일. 절대량은 아니다("don't reflect absolute numbers"). 여러 요청의 값을 합칠 수 있다.[^trends-blog]
- "limited set of developers", 지원서 제출.[^trends-page]
- 2026년에도 알파 유지, 응답 지연 보고가 있다.[^trends-2nd]

**P09 Trends 비공식 경로** [실측 M-8]

- pytrends 4.9.2(archived): `gprop="youtube"` 포함 5/5 성공. `today 3-m` 93행(일), `today 12-m` 53행(주), `now 7-d` 169행(시), `today 5-y` 261행(주). `related_queries` top·rising 반환.
- 값은 요청 내 0~100 상대값이다. "유튜브 쇼츠"와 "브이로그"를 같이 넣으면 앞쪽이 0~1로 눌린다.
- `/trending/rss?geo=KR`: 10건, `ht:approx_traffic`, `ht:news_item` 19건, `pubDate` 간격 10~20분, 시간대는 -0700.
- trendspyg 1.9.0 RSS 경로 성공, `traffic_min` 정수 필드 제공. CSV·Explore는 Chrome 필요.[^trendspyg]
- `/trends/api/dailytrends`, `/trends/trendingsearches/daily/rss`: 404.
- 소표본 성공은 안정성 근거가 아니다. trendspyg README는 Explore 경로의 429 차단을 경고한다.[^trendspyg]

**P10 Kworb** [실측 M-6]

| 경로 | 내용 | 행 수 | 마지막 수정 표본 |
|---|---|---|---|
| `/youtube/` | 24시간 조회수 상위 뮤직비디오, 조회수·좋아요 | 500 | 05:16 → 07:16 GMT |
| `/youtube/trending_overall.html` | 세계 트렌딩, 국가 하이라이트 | 310 | 06:10 → 07:10 GMT |
| `/youtube/trending/kr.html` | 한국 음악 트렌딩 | 81 | 06:10 → 06:40 → 07:10 GMT |
| `/youtube/insights/kr.html` | 한국 주간 차트, 스트림 | 100 | 10-30 12:17 GMT |
| `/youtube/insights/kr_daily.html` | 한국 일간 차트 | 20 | 03:37 GMT |
| `/youtube/archive.html` | 아티스트 누적 | 1,732 | 06:20 GMT |

음악 한정이다. `/youtube/realtime.html`은 404다.

**P11 Playboard** [실측 M-6]

- `/en/youtube-ranking/most-popular-all-channels-in-south-korea-daily`, `/en/chart/video/most-viewed-all-videos-in-south-korea-daily`, `/en/chart/ad/most-viewed-all-videos-in-south-korea-daily` 200. HTML 안 `window.__NUXT__`에 `subscriberCount`, `channelId`, `videoId`, 슈퍼챗 필드.
- 공개 산식: "Popularity score = number of views + ( number of likes * 10 )".[^pb-about]
- 수집 주기: 구독자 일 1회, 7일 내 영상과 5,000회 초과 영상 일 1회, 그 외 2~365일 간격.[^pb-about]
- 약관(2024-04-24 시행): "Reselling information obtained through the Service or otherwise using it for commercial purposes" 금지, "Creating, distributing, or installing agents, robots, scripts, spiders" 금지.[^pb-terms]
- robots는 `User-agent: *`에 `Allow: /`이고, 약관은 위와 같이 금지한다. 공개 API 문서는 미확인.

**P12 Social Blade** [실측 M-6]

- Next.js `__NEXT_DATA__` 안 tRPC 캐시: `youtube.top`(limit 100, KR 100건), `youtube.user`(구독자·조회수·`ranks`), `youtube.history`(최근 15일 일별).
- 약관(2026-07-07 갱신): "Mass copying of data from Social Blade's website — including botting, crawling, and scraping — is not allowed". 대량 데이터 경로로 custom reports와 Business API를 명시.[^sb-terms]
- Business API: "up to 3 years of Daily Historical Performance Data for YouTube creators", 100크레딧 구간 $0.50/크레딧, 최저 표기 $0.06/크레딧.[^sb-dev]
- 플랜: Bronze $5.99, Silver $14.99, Gold $59.99, Platinum $149.99/월, 이력 30·60·180·365일(페이지 내장 데이터).
- 자체 공시: YouTube API Services를 사용한다.[^sb-terms]

**P13 YouTube Charts 내부 API** [실측 M-9]

- `POST charts.youtube.com/youtubei/v1/browse`, 클라이언트 `WEB_MUSIC_ANALYTICS`, `browseId=FEmusic_analytics_charts_home`.
- 응답: `TOP_VIEWS_CHART`, `CHART_PERIOD_TYPE_WEEKLY`, `endDate` 2026-10-22, 100건. 항목에 `viewCount`, `chartEntryMetadata`, `externalChannelId`.
- 음악 한정이다.

**P14 youtube-transcript-api 1.2.4** [실측 M-9]

- SUW5c8RZ8WY: 트랙 en-US·id·ko(모두 자동 생성), 한국어 105스니펫, 987ms.

### 3.3 도구 후보

버전·날짜는 PyPI, npm, GitHub API 기준이다. 유지보수 상태는 2026-10-31 조회값이다.

| 도구 | 최신 버전 | 릴리스 | 유지보수 상태 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|---|
| yt-dlp | 2026.10.26 | 2026-10-26 | 활성. push 10-29, 별 204,048 | Unlicense | venv 설치·실행 성공. Python 3.11+ 필요 | 약관, 시간당 한도, ffmpeg 없음 |
| yt-dlp-ejs | 0.8.0 | 2026-03-17 | `yt-dlp[default]`에 포함 | PyPI 표기 없음 | 설치 성공 | 없음 |
| Deno | v2.9.8 | 2026-10-21 | 활성. push 10-29 | MIT | 미설치. yt-dlp 기본 런타임 | 설치 필요, Node로 대체 가능 |
| youtubei.js | 18.3.0 | 2026-10-23 | 활성. push 10-31, 별 5,403 | MIT | Node 26 동작 | 한국어 suggest 깨짐, `get_transcript` 400, `getTrending` 없음 |
| youtube-transcript-api | 1.2.4 | 2026-01-29 | 활성. push 10-30, 별 8,537 | MIT | 성공. Python <3.15 | 약관 |
| pytrends | 4.9.2 | 2023-04-13 | **archived**. push 2024-08-10 | Apache-2.0(PyPI) | 5/5 성공 | 유지보수 종료, 429 위험 |
| trendspyg | 1.9.0 | 2026-10-01 | 활성. push 10-01, 별 61 | MIT | RSS 성공 | CSV·Explore는 Chrome 필요 |
| scrapetube | 2.6.0 | 2025-09-16 | 미조사 | MIT | 미실측 | 미실측 |
| innertube(PyPI) | 2.1.19 | 2025-07-01 | 미조사 | MIT | 미실측 | 미실측 |
| ytmusicapi | 1.12.3 | 2026-09-16 | 활성. push 10-12, 별 3,091 | MIT | 미실측 | 미실측 |
| google-api-python-client | 2.201.0 | 2026-09-30 | 활성. push 10-27, 별 8,961 | Apache-2.0 | 미실측 | API 키 없음 |
| google-auth-oauthlib | 1.5.0 | 2026-09-29 | 활성 | 미조사 | 미실측 | OAuth 대상 채널 없음 |
| imageio-ffmpeg | 0.7.0 | 2026-10-28 | 활성 | 미조사 | 설치 성공. ffmpeg 7.0.2 정적, `libx264` 있음 | `nvenc` 없음 |
| BtbN/FFmpeg-Builds | latest | 2026-10-30 | 활성. 별 11,905 | MIT(저장소) | 미실측 | 바이너리 내려받기 필요 |
| faster-whisper | 1.2.1 | 2025-10-31 | push 10-30, 별 26,343 | MIT | 미실측. RTX 4080 SUPER 16GB 보유 | 미실측 |
| whisperX | v3.8.6 | 2026-05-25 | push 10-22, 별 24,963 | BSD-2-Clause | 미실측 | 미실측 |
| PySceneDetect | v0.7.2 | 2026-10-12 | 활성. 별 5,307 | BSD-3-Clause | 미실측 | ffmpeg 또는 OpenCV 필요 여부 미확인 |
| Remotion | v4.0.539 | 2026-10-26 | 활성. 별 69,200 | 자체 라이선스. 개인·영리 3인 이하 무료 구간 | 미실측 | 라이선스 조건 |

## 4. 플랫폼 확장 소스

| ID | 소스 | 키 | 갱신 주기 | 비용 | ToS·법적 주의 | 도메인 | 수집 주기 | 접근 상태 |
|---|---|---|---|---|---|---|---|---|
| X01 | 치지직 내부 `api.chzzk.naver.com/service/v1/lives` | 없음 | 실시간 | 무료 | 비공식. 네이버 약관의 자동화 수집 금지 | B | 호출 시점 값 | 200. `concurrentUserCount`, 태그, 카테고리 |
| X02 | 치지직 Open API | 앱 등록 + Client 인증(`clientId`, `clientSecret`) | 실시간 | 미확인 | 약관 페이지 미확인 | B F | 호출 시점 값 | 미등록 |
| X03 | SOOP 내부 `main_broad_list_api.php` | 없음 | 실시간 | 무료 | 비공식. 약관 원문 미확인 | B | 호출 시점 값 | 200. `total_cnt` 2,185, 페이지당 60 |
| X04 | SOOP Open API | `client_id` | 실시간 | 미확인 | 약관 미확인 | B F | 호출 시점 값 | 빈 ID는 `-1100` 오류 |
| X05 | Twitch Helix | OAuth | 실시간 | 요금표 미확인 | 포인트 버킷 제한(예시 `Ratelimit-Limit: 800`) | B F | 호출 시점 값 | 무키 401 |
| X06 | TwitchTracker | 없음 | 미확인 | 미확인 | 미확인 | B | 미확인 | 200이나 본문 0바이트 |
| X07 | Streams Charts | 웹 공개 / API v2 크레딧 | 분기 리포트, API는 호출 시점 값 | API 요청별 크레딧, 무료 시작 예시. PRO·Team 요금 별도 | 미확인 | B | 분기 | 로컬 Cloudflare 403, WebFetch 200 |
| X08 | TikTok Research Tools | 기관 승인 | 미확인 | 미확인 | 대상 지역 미국·유럽·캐나다·브라질. 한국 미포함 | B | 미확인 | 지역 미해당 |
| X09 | TikTok Creative Center | 로그인 범위 미확인 | 미확인 | 미확인 | `tiktok.com` robots는 검색·AI 봇 목록을 전면 Disallow | A B E | 미확인 | 200, SPA 21KB. `/creative/creativeCenter/trends`로 이동 |
| X10 | Meta Content Library | 기관 소속 승인 | 미확인 | 수수료 없음[2차] | 심사 4~6주, 연 1회 재인증[2차] | B | 미확인 | 자격 미해당 |
| X11 | Netflix Top 10 TSV | 없음 | 주간 | 무료 | 약관 미확인 | B | 주 1회 | 200. 국가별 32.8MB, 세계 0.9MB |
| X12 | FlixPatrol | 미확인 | 미확인 | 미확인 | 미확인 | B | 미확인 | Cloudflare 403 |
| X13 | 키노라이츠 | 없음 | 미확인 | 미확인 | 미확인 | B | 미확인 | 200, 앱 소개 페이지 |
| X14 | SEC EDGAR | 없음, UA 선언 | 공시 시 | 무료 | 10 req/s, 연락처 포함 UA | B | 분기 | 200 |
| X15 | arXiv API | 없음 | 수시 | 무료 | 3초당 1회, 단일 연결. 메타데이터 CC0 | C F | 수시 | 200 |
| X16 | HN Algolia | 없음 | 실시간 | 무료 | 미확인 | F | 호출 시점 값 | 200. "youtube api" 1,323건 |
| X17 | GitHub·PyPI·npm 메타 | `gh` 로그인 | 릴리스 시 | 무료 | 각 API 제한 | F | 릴리스 단위 | 가능 |
| X18 | DART OpenAPI | 인증키 | 공시 시 | 무료[미확인] | 미확인 | B | 분기 | 사이트 200, 키 없음 |
| X19 | KOSIS OpenAPI, data.go.kr | 인증키 | 통계별 | 무료[미확인] | 미확인 | B | 통계별 | 사이트 200, 키 없음 |
| X20 | Google Ads API | Google Cloud 프로젝트 + Ads 계정 | 호출 시점 값 | 미확인 | Test 15,000 ops, Explorer 2,880 ops(운영 계정). Explorer는 키워드 플래닝 제한 | A E | 호출 시점 값 | 계정 없음 |
| X21 | vidIQ, TubeBuddy, Ahrefs YouTube | 유료 계정 | 미확인 | 출처별 가격 상충[2차] | 미확인 | A | 미확인 | 미실측 |

세부:

- X01 응답: `content.data[]`에 `liveId`, `liveTitle`, `concurrentUserCount`, `accumulateCount`, `openDate`, `tags`, `categoryType`, `liveCategoryValue`, `channel{...}`. 커서는 `page.next{concurrentUserCount, liveId}`. [실측 M-9]
- X01 약관: "네이버의 사전 허락 없이 자동화된 수단(예: 매크로 프로그램, 로봇(봇), 스파이더, 스크래퍼 등)을 이용하여 ... 네이버 서비스에 게재된 회원의 아이디(ID), 게시물 등을 수집"하는 행위를 금지한다(2026-10-01 시행).[^naver-tos] 치지직 전용 약관은 찾지 못했다. `chzzk.naver.com/robots.txt`는 `Allow: /`다.
- X02 문서 범주: User, Channel, Category, Live, Chat, Drops, Session, Tips, Restriction. `GET /open/v1/lives`는 "애플리케이션 등록 후 Client 인증이 필요"하고 응답에 `concurrentUserCount`가 있다. 호출 제한 수치는 확인한 쪽에 없다.[^chzzk-docs][^chzzk-live]
- X03 응답: `broad[]`에 `broad_title`, `user_nick`, `total_view_cnt`, `pc_view_cnt`, `mobile_view_cnt`, `broad_cate_no`, `broad_start`, `hash_tags`, `category_tags`, `auto_hashtags`. [실측 M-9] `www.sooplive.co.kr/robots.txt`는 `www.sooplive.com`으로 리다이렉트되고 내용은 `Allow: /`다. API 호스트는 `.co.kr`에서 응답했다.
- X07: API v2는 "channels, individual broadcasts, games, user lists, and live statistics across nine livestreaming platforms"를 다룬다. 플랫폼 표시는 Twitch, Kick, YouTube, Rumble, NimoTV, Bigo LIVE, SOOP Korea, CHZZK, SteamTV. 방송별 채팅 로그도 제공한다.[^sc-api]
- X11 데이터: 국가별 515,920행, 277주(2021-07-04~2026-10-18), 94개국, KR 5,540행, 열은 `country_iso2`, `week`, `category`, `weekly_rank`, `show_title`, `season_title`, `cumulative_weeks_in_top_10`. 세계 파일 11,080행, `weekly_hours_viewed`, `runtime`, `weekly_views` 포함. [실측 M-9]
- X20: 개발자 토큰은 2026-09-09 종료, 액세스 레벨은 Cloud 프로젝트 단위. Standard는 수동 감사 약 10영업일.[^gads-levels] `KeywordPlanNetwork` 값은 `GOOGLE_SEARCH`, `GOOGLE_SEARCH_AND_PARTNERS`, `UNSPECIFIED`, `UNKNOWN`뿐이고 YouTube 값이 없다.[^gads-kpn]

주석: X02[^chzzk-docs], X05[^twitch], X07[^sc-q3][^sc-api], X08[^tiktok-research], X10[^mcl], X11[^nflx-h1], X14[^sec-access], X15[^arxiv-tou], X20[^gads-levels], X21[^kw-tools].

## 5. 문서형 소스

### 5.1 소스 표

| ID | 소스 | 키 | 갱신 주기 | 비용 | ToS·법적 주의 | 도메인 | 수집 주기 | 접근 상태 |
|---|---|---|---|---|---|---|---|---|
| D01 | DataReportal | 없음 | 총괄판 2026-10-21, 중간판 2026-04-22, 국가판 2025-11-08 | 무료 열람 | 저작권 보호, 재사용은 허가 절차 | B C | 반기 | 200 |
| D02 | 와이즈앱 | 없음 | 비정기[2차] | 미확인 | 약관 미확인 | B | 비정기 | AWS WAF 챌린지. 언론 경유만 확인 |
| D03 | 모바일인덱스 | 없음 / 앱은 계정 | 월간 순위 글(2026-10-07 게시) | 글 공개, 홈에 요금 미표기 | 약관 미확인 | B | 월 1회 | 홈·블로그 200. `hd.mobileindex.com/report/`는 본문 0바이트 |
| D04 | Nielsen The Gauge | 없음 | 월간. 2026-09·10월은 합본 예고 | 무료 열람 | robots `Disallow: /*.pdf$` | B C | 월 1회 | 200 |
| D05 | Pew Research | 없음 | 비정기, 소셜 팩트시트는 연 1회 내외 | 무료 | 무단 스크래핑 금지 문구, 인용 조건. `.md` 판 제공 | B C | 연 1회 | 200 |
| D06 | Ofcom | 없음 | Media Nations 연 1회(7월) | 무료 | 미확인 | B C | 연 1회 | Cloudflare 403, PDF도 403 |
| D07 | eMarketer | 구독 | 미확인 | 구독제, 공개 가격 없음. 제3자 추정 연 $12,000~$142,866[2차] | 미확인 | B E | 미확인 | robots 200, 주제 페이지 403 |
| D08 | Alphabet 실적 | 없음 | 분기 | 무료 | EDGAR 규칙 적용 | B | 분기 | 200 |
| D09 | 방송미디어통신위원회 | 없음 | 방송매체 이용행태조사 연 1회. 2025판 2025-12-30 | 무료 | 공공저작물 조건 미확인 | B | 연 1회 | 200 |
| D10 | KISDI 미디어통계포털, 방송통계포털 | 없음 | 패널조사 연 1회 | 무료 | 미확인 | B | 연 1회 | 200 |
| D11 | KOBACO 방송통신광고비조사 | 없음 | 연 1회(1월) | 무료 | 미확인 | B E | 연 1회 | 200 |
| D12 | 오픈서베이 트렌드 리포트 | 양식 입력[미확인] | 주제별 연 1회 내외 | 무료[미확인] | 미확인 | B | 연 1회 | 블로그 200 |
| D13 | YouTube 공식 블로그 | 없음 | 비정기, 2주 표본 6건 | 무료 | 저작권 | C D E | RSS 폴링 | RSS 200, 20건 |
| D14 | Creator Insider | 없음 | 비정기 | 무료 | P05·P14 경로의 약관 조건 적용 | C D | 신규 업로드 | yt-dlp로 목록 확인 |
| D15 | YouTube 고객센터 | 없음 | 비정기, 본문 갱신일 표기 없음 | 무료 | 저작권 | C D E | 변경 감지 | 200 |
| D16 | arXiv 감사 연구 | 없음 | 수시 | 무료 | X15 참고. 본문 라이선스는 논문별 | C | X15 | 200 |
| D17 | KT나스미디어 NPR | 요약 PDF는 불필요 | 연 1회. 2026판 2026-03-26 | 요약 PDF 공개, 전체본 미확인 | 미확인 | B E | 연 1회 | 200. 요약 PDF는 이미지 위주 |
| D18 | YouTube Culture & Trends | 없음 | 비정기 | 무료 | 저작권 | B D | 비정기 | 200 |
| D19 | How YouTube Works | 없음 | 비정기 | 무료 | 저작권 | C D | 변경 감지 | 200 |
| D20 | Ahrefs AI 인용 분석 | 없음 | 월간(글 내 명시) | 무료 글 | 미확인 | C | 월 1회 | 200 |
| D21 | Stack Overflow 설문, Octoverse | 없음 | 연 1회 | 무료 | 미확인 | F | 연 1회 | 200 |
| D22 | Google Ads 고객센터 | 없음 | 비정기 | 무료 | 저작권 | E | 변경 감지 | 200[WebFetch] |
| D23 | KOCCA 콘텐츠 이용행태 조사 | 없음 | 연 1회[2차] | 무료[미확인] | 미확인 | B | 연 1회 | 사이트 200 |

주석: D01[^dr-legal][^dr-reports], D03[^iga-blog], D04[^nielsen-aug][^nielsen-robots], D05[^pew-fact][^pew-terms][^pew-llms], D06[^ofcom-2nd], D07[^em-2nd], D08[^goog-8k], D09[^kmcc-press], D10[^kisdi], D11[^kobaco], D12[^os-blog], D13[^yt-blog], D14[^ci], D15[^ypp][^ypp-changes][^views-help], D16[^arxiv-tou], D17[^npr-2nd], D18[^yt-trends], D19[^yt-reco], D20[^ahrefs], D21[^so-2nd][^octoverse], D22[^ad-formats].

### 5.2 최신 판 수치

출처 귀속 형태의 사실이다.

| 소스 | 판 | 수치 | 근거 |
|---|---|---|---|
| Alphabet | Q3 2026, 8-K 2026-10-28 | YouTube ads $11,207M, 전년 동기 $10,261M. YouTube Music·Premium 구독 1억 5,000만 초과(체험 포함) | [1차] [^goog-8k] |
| Nielsen | 미국 2026-08 구간(07/27~08/30) | YouTube TV 시청 15.8%, 스트리밍 49.6% | [1차] [^nielsen-aug] |
| Pew | 2026-01-30~06-18 조사, 2026-10-19 게시 | 미국 성인 YouTube 이용 84%, Facebook 70% | [1차] [^pew-fact] |
| DataReportal | Digital 2026: South Korea | YouTube 광고 도달 4,290만, 인구 대비 83.1%, 인터넷 이용자 대비 84.8%. 도달은 MAU와 다르다고 명시 | [1차] [^dr-kr] |
| Ofcom | Media Nations 2026(2026-07-29) | VSP 51분/일, YouTube 41분/일 | [2차] [^ofcom-2nd] |
| 와이즈앱 | 2026-01~05 | 유튜브 월평균 1,136억 분, 넷플릭스 56.1억 분 | [2차] [^wa-2nd] |
| 방미통위 | 2025 방송매체 이용행태조사(2025-12-30), 5,566가구 8,320명 | OTT 이용률 81.8%(2023 77.0, 2024 79.2), 유료 OTT 65.5%, OTT 프로그램 중 숏폼 78.9%. 숏폼 플랫폼 유튜브 숏츠 76.1%, 인스타그램 릴스 18.6%, 틱톡 9.4% | [1차] [^kmcc-press] |
| 방미통위·KOBACO | 2025 방송통신광고비조사(2026-01-08) | 2024년 총 17조 1,263억 원(+3.5%), 온라인 10조 1,011억 원(+7.9%, 59.0%), 방송 3조 2,191억 원(-5.0%, 18.8%). 2025 추정 온라인 10조 7,204억 원, 방송 2조 7,744억 원 | [1차] [^kmcc-ad-press] |
| KT나스미디어 | 2026 NPR(2026-03-26) | TV로 유튜브 시청 33.7%, 10대 50.9% | [2차] [^npr-2nd] |
| Streams Charts | Q3 2026(2026-10-13) | 31.698B 시청시간. YouTube 13.62B(43%), TikTok LIVE 10.6B(33.5%), Twitch 4.51B(14.2%), Kick 2.04B(6.4%). CHZZK 335.2M이 SOOP 333M을 처음 앞섬 | [1차] [^sc-q3] |
| SOOP | 2026 Q2 | 매출 1,038억 원, 영업이익 126억 원. 3분기부터 주요 지표 공개 예고 | [2차] [^soop-2nd] |
| Ahrefs | 2026-09 | Google AI Overviews 상위 인용 중 youtube.com 22.9%(미국) | [1차] [^ahrefs] |
| Pew | 2025-07-22 | AI 요약 표시 시 링크 클릭 8%, 미표시 15%. 요약 내 링크 1%. 검색의 18%에 AI 요약 | [1차] [^pew-ai] |
| Stack Overflow | 2026(2026-10-06) | 커뮤니티 자료로 YouTube 58% | [2차] [^so-2nd] |

### 5.3 채널 설계·마케팅 원문 사실

- 현행 YPP: 구독자 1,000명 + 12개월 4,000시간 또는 90일 Shorts 1,000만.[^ypp]
- 2027-02-01 변경: 신규 진입 8,000시간/365일 또는 Shorts 2,000만/90일. 기존 파트너 상태 유지.[^ypp-changes]
- Shorts Creator Pool 수익: 90일 qualified Shorts views 1,000만 유지 조건. 미달해도 YPP 제외는 아님.[^ypp-changes]
- Premium Lite 풀 순구독 수익의 60%, Premium 뷰 풀 30%. 소수 채널 타깃 Shorts 광고는 45% 직접 배분.[^ypp-changes]
- 500명 구간 유지: 팬 펀딩, Creator Partnerships, 쇼핑은 구독자 500명 + 3,000시간/연 또는 Shorts 300만/90일.[^ypp-changes]
- 활성 기준(2027-02-01): 1,000시간/365일, Shorts 100만/90일, 또는 90일마다 롱폼 2개·Shorts 5개 중 하나.[^ypp-changes]
- 약관 수락 기한 2027-01-31. 미수락 시 해당 수익 기능 중단.[^ypp-changes]
- 추천 시스템: "over 80 billion pieces of information we call signals". 시청 이력, 구독, 비추천, "관심 없음", 만족도 설문을 신호로 나열. "Videos that are made with AI can be recommended as broadly as videos made without AI".[^yt-reco]
- 유입 경로 정의 문서: YouTube search, Suggested videos, Browse features, Notifications, External, Playlists, Channel pages, YouTube advertising 등.[^traffic-help]
- Ask YouTube: 2026-05-19 공식 블로그가 "new conversational search experience"로 발표. 롱폼과 Shorts를 모아 구조화 응답을 준다. 2026-07 미국 웹 확대는 보도 기준이다.[^ask-yt][^ask-yt-2nd]
- Studio Research 탭: 최근 28일 기준 상위 검색어, 시청자 관심도는 "very low to very high" 등급이다. 페이지는 수치 검색량을 언급하지 않는다.[^research-tab]
- 쇼핑 제휴: 한국 포함 18개국, YPP 구독자 기준 충족, 음악 채널·아동용 제외. 페이지에 한국 전용 성과 보너스 언급.[^shopping]
- Creator Partnerships: BrandConnect 개명·통합(2026-03). 공식 원문 미확인.[^cp-2nd]
- 광고 포맷: 건너뛸 수 있는 인스트림, 인피드, 건너뛸 수 없는 인스트림, 범퍼, Shorts, Masthead. 2025-10 "Views"가 "TrueView views"로 개명.[^ad-formats]
- 독립 벤치마크: 유입 비중·리텐션의 독립 데이터셋은 찾지 못했다. 검색 결과는 벤더 블로그였고 수치가 상충했다.[^bench-2nd]

### 5.4 학술 감사 연구 표본

arXiv API 결과의 일부다. 검색식은 §11 M-11이다.

| arXiv ID | 게재일 | 제목 |
|---|---|---|
| 2606.03173 | 2026-06-02 | Auditing Engagement Incentives in the Kidfluencer Ecosystem |
| 2604.00944 | 2026-04-01 | Auditing the Reliability of Multimodal Generative Search |
| 2603.25302 | 2026-03-26 | Auditing the Impact of Cross-Site Web Tracking on YouTube Political and Misinformation Recommendations |
| 2509.02543 | 2025-09-02 | A Keyframe-Based Approach for Auditing Bias in YouTube Shorts Recommendations |
| 2507.21467 | 2025-07-29 | Efficient Data Retrieval and Comparative Bias Analysis of Recommendation Algorithms for YouTube Shorts and Long-form |
| 2507.12571 | 2025-07-16 | Catching Dark Signals in Algorithms |
| 2507.04605 | 2025-07-07 | Investigating Algorithmic Bias in YouTube Shorts |
| 2507.04534 | 2025-07-06 | Simulating User Watch-Time to Investigate Bias in YouTube Shorts Recommendations |

## 6. 도메인 매핑

| 도메인 | 공개·무키 | 키·승인 필요 | 문서형 |
|---|---|---|---|
| A 키워드맵 | P04, P05, P06, P09, P10 | P01, P08, P15, X09, X20, X21 | D13, D14 |
| B 시장 | P09, P10, P11, P12, P13, X01, X03, X11, X14 | P08, X02, X04, X05, X07, X08, X10, X18, X19 | D01~D12, D17, D18, D23 |
| C 트래픽 | P05(heatmap), P14 | P02, P03 | D04, D05, D06, D13, D14, D15, D16, D19, D20 |
| D 채널 설계 | P05, P06, P12, P14 | P02, P03 | D13, D14, D15, D18, D19 |
| E 마케팅 | P11(`/chart/ad/`), X09 | P01(`brandPartner`), X20 | D07, D11, D13, D15, D17, D22 |
| F 개발 | X15, X16, X17 | P01, X02, X04, X05 | D21, Data API 개정 이력, yt-dlp 릴리스 |

## 7. 갱신 주기별 묶음

| 주기 | 소스 |
|---|---|
| 호출 시점 값 | P01, P05, P06, P14, X01~X05, X16, X20 |
| 신규 업로드 시 | P07, D14 |
| 분~시 | P09(RSS 10~20분, 7일 구간 시간별), P10(트렌딩 30분, 메인 2시간), P04(캐시 1시간) |
| 일 | P02, P03, P08, P11, P12 |
| 주 | P13, P10(주간 차트), P11(주간 차트), X11 |
| 월 | D03, D04, D20, P11(월간 차트) |
| 분기 | D08, X07, X14, X18 |
| 반기 | D01(2026년 4월·10월 발행) |
| 연 | D05, D06, D09, D10, D11, D12, D17, D21, D23 |
| 비정기·수시 | D13, D14, D15, D16, D18, D19, D22, X15, X17 |

## 8. 정의 변경 타임라인

시계열 소스를 해석할 때 끊기는 지점이다.

| 날짜 | 사건 | 근거 |
|---|---|---|
| 2025-03-31 | Shorts 조회수가 재생 시작·재시작 기준으로 변경 | [^revs] |
| 2025-04-30 / 06-30 | Analytics Targeted Queries / Bulk Reports에 반영, `engagedViews` 추가 | [^arevs] |
| 2025-07-21 | `mostPopular` 구성 변경, Trending 페이지 폐지 | [^revs] |
| 2025-07-24 | Google Trends API 알파 발표 | [^trends-blog] |
| 2025-10-01 | 방송통신위원회 폐지, 방송미디어통신위원회 출범 | [^kmcc-rename] |
| 2025-12-04 | 업로드 쿼터 약 1,600 → 약 100 | [^revs] |
| 2025-12-27 | RSS 404 최초 공개 보고 | [^rss-forum] |
| 2026-01-15 | Reporting API reach 리포트 | [^arevs] |
| 2026-03-09 | `ageGroup`에 18세 미만 추정 사용자 포함 | [^arevs] |
| 2026-05-19 | Ask YouTube 발표 | [^ask-yt] |
| 2026-06-01 | 쿼터 세분화, Policies III.L 시행 | [^revs][^policy] |
| 2026-06-03 | `videos.batchGetStats` | [^revs] |
| 2026-07-07 | `brandPartner` 파트 | [^revs] |
| 2026-08-24 | 공개 조회수 재생 시작 기준 통일(개정 이력 기재일 08-27) | [^views-help][^arevs] |
| 2026-09 | Nielsen Gauge 일회성 방법론 조정 시작 | [^nielsen-aug] |
| 2026-09-09 | Google Ads API 개발자 토큰 종료 | [^gads-levels] |
| 2027-01-31 | YPP 갱신 약관 수락 기한 | [^ypp-changes] |
| 2027-02-01 | YPP 진입·활성 기준 변경 | [^ypp-changes] |
| 2027 Q1 | Netflix 참여도 리포트 연 1회 전환 | [^nflx-h1] |
| 2027-03-09 | 개인정보 보호법 AI 특례 시행 예정[2차] | [^pipa-2nd] |

## 9. 죽은 데이터 후보

`CLAUDE.md` 정의에 해당할 수 있는 항목이다. 적재 전 확인 대상으로 남긴다.

| 항목 | 상태 | 근거 |
|---|---|---|
| YouTube Trending 페이지 | 폐지. `/feed/trending`은 `FEwhat_to_watch` 홈, 영상 0 | [실측 M-7], [^revs] |
| `mostPopular` = Trending Now | 2025-07-21 정의 변경 | [^revs] |
| `search.list` 100유닛 | 2026-06-01 대체 | [^quota] |
| `videos.insert` 1,600유닛 | 대체 | [^revs] |
| Shorts 조회수 구 정의, "valid public watch hours" | 대체 | [^revs][^arevs] |
| Trends `dailytrends`, `/trends/trendingsearches/daily/rss` | 404 | [실측 M-8] |
| pytrends | archived. 측정 시 동작 | [실측 M-8] |
| youtubei.js `getTrending` | 18.3.0에 메서드 없음 | [실측 M-4] |
| `youtube/api-samples`, `tokland/youtube-upload` | 앞은 archived(마지막 push 2024-06-09), 뒤는 마지막 push 2024-04-25 | [실측 M-12] |
| Google Ads 개발자 토큰 | 2026-09-09 종료 | [^gads-levels] |
| `kcc.go.kr` | `kmcc.go.kr`로 이동 | [실측 M-10] |
| `opensurvey.co.kr/trendreport/` | `opensurvey.io`로 이동 후 404. 리포트는 블로그 | [실측 M-10] |
| BrandConnect 명칭 | Creator Partnerships로 통합[2차] | [^cp-2nd] |

## 10. 법적 참고

법률 해석이 아니라 공개된 사실이다. 전부 [2차]다.

- 대법원 2022. 5. 12. 선고 2021도1533: 크롤링 사건에서 정보통신망법·저작권법(데이터베이스제작자 권리)·업무방해 공소사실 무죄 확정. 서울고법 2021나2034740 민사 판결은 같은 행위를 부정경쟁행위로 보고 손해배상 책임을 인정했다고 보도됐다.[^crawl-2nd]
- 개인정보보호위원회 「AI 개발·서비스를 위한 공개된 개인정보 처리 안내서」(2024-07)는 공개 데이터 스크래핑을 다룬다. 2026-08 국회 통과 개인정보 보호법 개정으로 AI 특례가 신설됐고 2027-03-09 시행으로 보도됐다.[^pipa-2nd]
- 댓글 작성자 ID 등 개인 식별 가능 필드가 P05 응답에 포함된다. [실측 M-3]

## 11. 실측 로그

호출 기간 2026-10-31 06:15~07:23 UTC. 호출 로그 기준 278회이고, 공식 문서 페이지 수신과 WebFetch·WebSearch는 뺀 값이다. HTTP 프로브는 Python urllib 또는 curl, 브라우저 UA, 소스별 1.2~3초 간격이다. 소스당 호출: suggest 35(clients6 포함), RSS 32, gtrends 13, playboard 12, kworb 27(HEAD 포함), socialblade 9, innertube 9, ytdlp 8.

**운영 사고.** SEC EDGAR 호출 3회의 User-Agent에 사용자 이메일 주소가 들어갔다. 사용자가 요청하지 않은 전송이고 되돌릴 수 없다. 이후 호출과 스크립트에서 제거했다. EDGAR는 연락처가 포함된 UA 선언을 요구하므로[^sec-access], 3단계 수집에서 쓸 연락처는 사용자 결정 사항이다.

M-1 Data API 무키

```bash
curl -s "https://www.googleapis.com/youtube/v3/videos?part=id&chart=mostPopular&regionCode=KR"
# 403 "Method doesn't allow unregistered callers"
```

M-2 suggest

```bash
curl "https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=ko&gl=KR&q=<질의>"
# client: firefox, youtube, chrome, toolbar, psy-ab, gws-wiz. 간격 1.2초
# 결과: 200 전부. 응답 250~736자. 지연 155~239ms
```

M-3 yt-dlp 2026.10.26 + yt-dlp-ejs 0.8.0, Python 3.13.18

```bash
python -I -m yt_dlp --no-config -J --skip-download "https://www.youtube.com/watch?v=jNQXAC9IVRw"
# 2,719ms, 91,712바이트, formats 24, heatmap 100
python -I -m yt_dlp --no-config -J --flat-playlist --playlist-end 5 "https://www.youtube.com/@GoogleDevelopers/videos"
# 574ms, 7,342바이트
python -I -m yt_dlp --no-config -J --flat-playlist "ytsearch5:유튜브 수익창출 조건"
# 2,489ms, 8,432바이트
python -I -m yt_dlp --no-config --js-runtimes node -J --skip-download "https://www.youtube.com/watch?v=SUW5c8RZ8WY"
# 6,965ms, 1,694,415바이트, formats 40. 런타임 없음은 1,714ms, formats 33
python -I -m yt_dlp --no-config --js-runtimes node --skip-download --write-auto-subs --write-subs --sub-langs "ko,ko-orig" --sub-format json3 -o "subs/%(id)s.%(ext)s" "<URL>"
# 7,230ms, 파일 2개
python -I -m yt_dlp --no-config --js-runtimes node -J --skip-download --write-comments --extractor-args "youtube:max_comments=20,all,20,0;comment_sort=top" "<URL>"
# 8,845ms, 댓글 6건
```

M-4 youtubei.js 18.3.0, Node 26.13.0

```js
const yt = await Innertube.create({ lang: 'ko', location: 'KR', retrieve_player: false });
await yt.getSearchSuggestions('유튜브 키워드');   // 208ms, 14건, 문자 깨짐
await yt.search('유튜브 쇼츠 알고리즘', { type: 'video', sort_by: 'relevance', upload_date: 'month' }); // 394ms, 20건
await yt.getBasicInfo('jNQXAC9IVRw');             // 123ms
await yt.getChannel('UC_x5XG1OV2P6uZZ5FSM9Ttw');  // 291ms, getAbout 88ms
await (await yt.getInfo('jNQXAC9IVRw')).getTranscript(); // get_transcript 400
await yt.getComments('jNQXAC9IVRw');              // 359ms, 20건
```

```bash
curl -D - "https://suggestqueries-clients6.youtube.com/complete/search?client=youtube&gs_ri=youtube&gs_id=0&cp=0&ds=yt&hl=ko&gl=KR&q=%EC%9C%A0%ED%8A%9C%EB%B8%8C"
# content-type: text/javascript; charset=EUC-KR
# gs_ri 없이 호출하면 charset=UTF-8, 603바이트
```

M-5 RSS

```bash
curl "https://www.youtube.com/feeds/videos.xml?channel_id=UC_x5XG1OV2P6uZZ5FSM9Ttw"
# 06:58 UTC까지 404, 1,613바이트, text/html, Server: YouTube RSS Feeds server
# 07:06 UTC부터 200, 27,012바이트, Atom, entry 15건
curl "https://www.youtube.com/xml/feeds/videos.xml?channel_id=UC_x5XG1OV2P6uZZ5FSM9Ttw"
# 200, 463바이트, text/xml, 주석 "This is a static file."
```

시계열 표본(8분 간격):

| UTC | RSS | 바이트 | Kworb `trending/kr` 마지막 수정(GMT) | Kworb `kr_daily` 마지막 수정(GMT) |
|---|---|---|---|---|
| 06:42:37 | 404 | 1,613 | 06:40:08 | 03:37:25 |
| 06:50:39 | 404 | 1,613 | 06:40:08 | 03:37:25 |
| 06:58:41 | 404 | 1,613 | 06:40:08 | 03:37:25 |
| 07:06:44 | 200 | 27,012 | 06:40:08 | 03:37:25 |
| 07:14:46 | 200 | 27,012 | 07:10:34 | 03:37:25 |
| 07:22:48 | 200 | 27,012 | 07:10:34 | 03:37:25 |

07:13 UTC 변형 측정:

| 요청 | 상태 | 바이트 | 지연 | entry |
|---|---|---|---|---|
| `channel_id=UC_x5XG1OV2P6uZZ5FSM9Ttw` | 200 | 27,012 | 120ms | 15 |
| `channel_id=UCGg-UqjRgzhYDPJMr-9HXCg` | 200 | 24,548 | 111ms | 15 |
| `channel_id=UCBR8-60-B28hp2BmDPdntcQ` | 200 | 18,489 | 108ms | 15 |
| `playlist_id=UU_x5XG1OV2P6uZZ5FSM9Ttw` | 200 | 26,999 | 784ms | 15 |
| `playlist_id=UULF_x5XG1OV2P6uZZ5FSM9Ttw` | 200 | 28,912 | 1,063ms | 15 |
| `playlist_id=UUSH_x5XG1OV2P6uZZ5FSM9Ttw` | 200 | 22,914 | 746ms | 15 |
| `user=GoogleDevelopers` | 200 | 26,998 | 252ms | 15 |

M-6 사이트 구조

```bash
curl "https://kworb.net/youtube/trending/kr.html"            # 200, 17,809바이트
curl "https://playboard.co/en/youtube-ranking/most-popular-all-channels-in-south-korea-daily"  # 200, 474,187바이트
curl "https://socialblade.com/youtube/lists/top/100/subscribers/all/KR"  # 200, 308,212바이트
curl "https://socialblade.com/youtube/handle/googledevelopers"           # 200, 90,854바이트
# socialblade.com 은 WebFetch 도구로는 403
```

M-7 YouTube 웹

```bash
curl "https://www.youtube.com/feed/trending"   # 200, 966,810바이트, browseId FEwhat_to_watch, videoRenderer 0
curl "https://www.youtube.com/robots.txt"      # Last-Modified 2026-07-22
curl "https://www.youtube.com/t/terms?hl=en&gl=KR"
```

M-8 Trends

```python
pt = TrendReq(hl="ko-KR", tz=-540, timeout=(5, 20), retries=0)
pt.build_payload(["유튜브 쇼츠", "브이로그"], timeframe="today 3-m", geo="KR", gprop="youtube")
pt.interest_over_time()   # (93, 3)
pt.related_queries()      # top (10, 2), rising (10, 2)
# 추가 4회, 20초 간격: 1,376~1,597ms, 전부 성공
```

```bash
curl "https://trends.google.com/trending/rss?geo=KR"                                # 200, 14,251바이트
curl "https://trends.google.com/trends/api/dailytrends?hl=ko&tz=-540&geo=KR&ns=15"  # 404
curl "https://trends.google.com/trends/trendingsearches/daily/rss?geo=KR"           # 404
```

M-9 플랫폼

```bash
curl "https://api.chzzk.naver.com/service/v1/lives?size=20&sortType=POPULAR"  # 200, 22,595바이트
curl "https://live.sooplive.co.kr/api/main_broad_list_api.php?selectType=action&orderType=view_cnt&pageNo=1&lang=ko_kr"  # 200, 74,802바이트
curl "https://openapi.sooplive.co.kr/broad/list?client_id=&order_type=view_cnt&page_no=1"  # {"result":-1100,...}
curl "https://api.twitch.tv/helix/streams?first=5"                            # 401
curl "https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv"       # 200, 32,805,445바이트
curl "https://www.netflix.com/tudum/top10/data/all-weeks-global.tsv"          # 200, 911,132바이트
curl -X POST "https://charts.youtube.com/youtubei/v1/browse?alt=json" -H 'Content-Type: application/json' -d '{"context":{"client":{"clientName":"WEB_MUSIC_ANALYTICS","clientVersion":"2.0","hl":"en","gl":"KR"}},"browseId":"FEmusic_analytics_charts_home","query":"perspective=CHART_DETAILS&chart_params_country_code=kr&chart_params_chart_type=VIDEOS&chart_params_period_type=WEEKLY"}'
# 200, 416,371바이트, 100건
```

```python
api = YouTubeTranscriptApi()
api.list("SUW5c8RZ8WY")                    # 987ms
api.fetch("SUW5c8RZ8WY", languages=["ko"]) # 105 스니펫
```

M-10 문서형 접근 상태

| 대상 | 상태 | 비고 |
|---|---|---|
| `www.wiseapp.co.kr/insight/` | 202 | `x-amzn-waf-action: challenge` |
| `www.ofcom.org.uk/` | 403 | 제목 "Just a moment..." |
| `www.emarketer.com/topics/topic/youtube` | 403 | robots.txt는 200 |
| `streamscharts.com/` | 403 | 제목 "Just a moment...". WebFetch로는 `/news/` 글 200 |
| `flixpatrol.com/` | 403 | 제목 "Just a moment...". WebFetch도 403 |
| `twitchtracker.com/statistics` | 200 | 본문 0바이트 |
| `www.kcc.go.kr/` | 200 | `www.kmcc.go.kr/`로 이동 |
| `opensurvey.co.kr/trendreport/` | 404 | `opensurvey.io:443`으로 이동 후 404 |
| `blog.youtube/rss/` | 200 | 27,751바이트, 20건 |
| `data.sec.gov/submissions/CIK0001652044.json` | 200 | 23,193바이트 |

M-11 arXiv

```bash
curl 'https://export.arxiv.org/api/query?search_query=abs:%22YouTube%22+AND+abs:%22audit%22&sortBy=submittedDate&sortOrder=descending&max_results=25'
# 200, totalResults 37
curl 'https://export.arxiv.org/api/query?search_query=abs:%22YouTube%20Shorts%22&sortBy=submittedDate&sortOrder=descending&max_results=15'
# 200, totalResults 29
```

M-12 환경 적합성

```bash
uv pip install imageio-ffmpeg
ffmpeg -hide_banner -encoders | rg -i 'nvenc|libx264|libsvtav1'
# ffmpeg 7.0.2-static. libx264, libx264rgb 만 표시. nvenc 없음
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
# NVIDIA GeForce RTX 4080 SUPER, 610.88, 16376 MiB
gh api repos/GeneralMills/pytrends --jq '{archived, pushed:.pushed_at}'
# archived true, pushed 2024-08-10
gh api repos/youtube/api-samples --jq .archived   # true
```

M-13 공공 문서 원문

```bash
curl -sSL "https://www.kmcc.go.kr/download.do?fileSeq=62354" -o press.pdf     # 200, 1,416,786바이트, 21쪽
curl -sSL "https://www.kmcc.go.kr/download.do?fileSeq=62433" -o ad.pdf        # 200, 464,215바이트, 9쪽
curl -sSL "https://www.nasmedia.co.kr/wp-content/uploads/2026/03/2026_NPR_요약보고서_주요발견점_f.pdf" -o npr.pdf  # 200, 1,666,628바이트, 14쪽, 추출 텍스트 1,173자
# 첫 시도는 tmpfs 쓰기 실패로 잘렸다. 크기 검증 후 재수신한 값이다
```

## 12. 미확인 사항

- YouTube Data API 실호출: 키가 없어 응답 구조는 문서 기준이다.
- `videos.batchGetStats`의 요청당 ID 상한.
- Data API `search.list` 100회 버킷이 무과금 증설 가능한 범위.
- RSS 실패 시간대의 일별 재현성과 원인. 이번 표본은 06:15~07:23 UTC 한 구간이다.
- suggest·yt-dlp·InnerTube의 실제 차단 임계. 소스당 수십 회 내에서 차단을 보지 않았다.
- pytrends의 지속 가능 호출량. 5회 성공은 소표본이다.
- Trends 알파 API의 YouTube 검색 속성 지원과 승인 소요.
- vidIQ·TubeBuddy·Ahrefs의 API 유무와 현행가.
- Playboard 요금, 공개 API 유무, 비로그인 표시 행 수, Chart 시각의 시간대.
- 치지직·SOOP 전용 약관과 Open API 요금·호출 제한. `api.chzzk.naver.com`의 robots.
- WiseApp·모바일인덱스·오픈서베이·NPR의 재사용 조건. NPR 2026 수치는 요약 PDF가 이미지 위주라 보도로만 확인했다.
- Ofcom 원문 수치. 이 환경에서 403이라 검색 스니펫으로만 봤다.
- 방송산업실태조사의 현재 발행 주체(과기정통부·방미통위). OTT 소관도 2025 개편 때 보류로 보도됐다.
- TikTok Creative Center의 무로그인 데이터 범위.
- FFmpeg 최신 안정 버전. GitHub 태그 정렬로 식별하지 못했다.
- 독립 리텐션·유입 벤치마크 데이터셋 존재 여부.
- 공공저작물 이용 조건(KMCC, KISDI, KOBACO).
- Studio Research 탭의 프로그램 접근 경로 유무.

[^quota]: YouTube Data API Quota Calculator, https://developers.google.com/youtube/v3/determine_quota_cost (문서 갱신 2026-10-15, 확인 2026-10-31, 1차)
[^revs]: YouTube Data API Revision History, https://developers.google.com/youtube/v3/revision_history (확인 2026-10-31, 1차)
[^videos-list]: Videos: list, https://developers.google.com/youtube/v3/docs/videos/list (문서 갱신 2026-10-15, 확인 2026-10-31, 1차)
[^batch]: Videos: batchGetStats, https://developers.google.com/youtube/v3/docs/videos/batchGetStats (확인 2026-10-31, 1차)
[^policy]: YouTube API Services Developer Policies, https://developers.google.com/youtube/terms/developer-policies (문서 갱신 2026-10-15, 확인 2026-10-31, 1차)
[^derived]: Additional policies for derived metrics and data storage, https://developers.google.com/youtube/terms/derived-metrics-policy (문서 갱신 2026-09-14, 확인 2026-10-31, 1차)
[^yt-tos]: YouTube Terms of Service, https://www.youtube.com/t/terms (Effective as of January 5, 2022 표기, 확인 2026-10-31, 1차)
[^google-tos]: Google Terms of Service, https://policies.google.com/terms (Effective July 30, 2026, 확인 2026-10-31, 1차)
[^arevs]: YouTube Analytics and Reporting API Revision History, https://developers.google.com/youtube/analytics/revision_history (확인 2026-10-31, 1차)
[^reporting]: YouTube Reporting API Reports, https://developers.google.com/youtube/reporting/v1/reports (문서 갱신 2026-10-15, 확인 2026-10-31, 1차)
[^a-dims]: Analytics API Dimensions, https://developers.google.com/youtube/analytics/dimensions (확인 2026-10-31, 1차)
[^a-metrics]: Analytics API Metrics, https://developers.google.com/youtube/analytics/metrics (확인 2026-10-31, 1차)
[^push]: Subscribe to Push Notifications, https://developers.google.com/youtube/v3/guides/push_notifications (문서 갱신 2026-10-15, 확인 2026-10-31, 1차)
[^yt-research]: YouTube Researcher Program, https://research.youtube/how-it-works/ (확인 2026-10-31, 1차)
[^suggest-2015]: Google to Stop Unofficial Autocomplete API, https://www.searchenginewatch.com/2015/07/27/google-to-stop-unofficial-autocomplete-api/ (확인 2026-10-31, 2차)
[^ytdlp-ext]: yt-dlp wiki Extractors, https://github.com/yt-dlp/yt-dlp/wiki/Extractors (확인 2026-10-31, 1차)
[^ytdlp-pot]: yt-dlp wiki PO Token Guide, https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide (마지막 편집 2026-07-12, 확인 2026-10-31, 1차)
[^ytdlp-ejs]: yt-dlp wiki EJS, https://github.com/yt-dlp/yt-dlp/wiki/EJS (확인 2026-10-31, 1차)
[^ytdlp-rel]: yt-dlp Releases, https://github.com/yt-dlp/yt-dlp/releases (확인 2026-10-31, 1차)
[^rss-forum]: YouTube RSS feed endpoint returns 404 errors, https://discuss.ai.google.dev/t/youtube-rss-feed-endpoint-returns-404-errors/113379 (확인 2026-10-31, 2차)
[^rss-umbraco]: Umbraco.Community.UmbraDesktop #147, https://github.com/Luuk1983/Umbraco.Community.UmbraDesktop/issues/147 (확인 2026-10-31, 2차)
[^rss-newsboat]: newsboat #3269, https://github.com/newsboat/newsboat/issues/3269 (확인 2026-10-31, 2차)
[^rss-boris]: web-boris #61, https://github.com/nelsonmarro/web-boris/issues/61 (확인 2026-10-31, 2차)
[^trends-page]: Google Trends API Alpha, https://developers.google.com/search/apis/trends (확인 2026-10-31, 1차)
[^trends-blog]: Introducing the Google Trends API (alpha), https://developers.google.com/search/blog/2025/07/trends-api (2025-07-24, 확인 2026-10-31, 1차)
[^trends-2nd]: Google Trends API in 2026, https://medium.com/@wordstotech/google-trends-api-95d50970cd46 (확인 2026-10-31, 2차)
[^trendspyg]: trendspyg, https://github.com/flack0x/trendspyg (확인 2026-10-31, 1차)
[^pb-about]: About PLAYBOARD, https://playboard.co/en/about (확인 2026-10-31, 1차)
[^pb-terms]: PLAYBOARD Terms, https://playboard.co/en/policies/terms (2024-04-24 시행, 확인 2026-10-31, 1차)
[^sb-terms]: Social Blade Terms of Service, https://socialblade.com/info/terms (2026-07-07 갱신, 확인 2026-10-31, 1차)
[^sb-dev]: Social Blade Business API, https://socialblade.com/developers (확인 2026-10-31, 1차)
[^naver-tos]: 네이버 이용약관, https://policy.naver.com/rules/service.html (2026-10-01 시행, 확인 2026-10-31, 1차)
[^chzzk-docs]: CHZZK Developers, https://chzzk.gitbook.io/chzzk , 인증 https://chzzk.gitbook.io/chzzk/chzzk-api/authorization (확인 2026-10-31, 1차)
[^chzzk-live]: CHZZK Live API, https://chzzk.gitbook.io/chzzk/chzzk-api/live (확인 2026-10-31, 1차)
[^twitch]: Twitch API Guide, https://dev.twitch.tv/docs/api/guide/ (확인 2026-10-31, 1차)
[^sc-q3]: Global livestreaming landscape hits 31.7B Hours Watched, https://streamscharts.com/news/q3-2026-global-livestreaming-landscape (2026-10-13, WebFetch로 확인, 확인 2026-10-31, 1차)
[^sc-api]: Streams Charts Q3 2026 Updates, https://streamscharts.com/news/streams-charts-q3-2026-product-updates (2026-10-30, WebFetch로 확인, 확인 2026-10-31, 1차)
[^tiktok-research]: TikTok Research API, https://developers.tiktok.com/products/research-api/ (확인 2026-10-31, 1차)
[^mcl]: Meta Content Library, https://transparency.meta.com/researchtools/meta-content-library/ (확인 2026-10-31, 2차)
[^nflx-h1]: What We Watched the First Half of 2026, https://about.netflix.com/en/news/what-we-watched-the-first-half-of-2026 , Top 10 https://www.netflix.com/tudum/top10 (확인 2026-10-31, 1차)
[^sec-access]: Accessing EDGAR Data, https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data (확인 2026-10-31, 1차)
[^arxiv-tou]: arXiv API Terms of Use, https://info.arxiv.org/help/api/tou.html (확인 2026-10-31, 1차)
[^gads-levels]: Google Ads API Access Levels, https://developers.google.com/google-ads/api/docs/api-policy/access-levels (문서 갱신 2026-10-30, 확인 2026-10-31, 1차)
[^gads-kpn]: KeywordPlanNetworkEnum, https://developers.google.com/google-ads/api/reference/rpc/latest/KeywordPlanNetworkEnum.KeywordPlanNetwork (확인 2026-10-31, 1차)
[^research-tab]: YouTube Help Research 탭, https://support.google.com/youtube/answer/11962757 (확인 2026-10-31, 1차)
[^ask-yt]: YouTube launches interactive search and AI video remixing for creators, https://blog.youtube/news-and-events/youtube-news-google-io-2026/ (2026-05-19, 확인 2026-10-31, 1차)
[^ask-yt-2nd]: YouTube's AI-powered search is rolling out in the US, https://www.digitaltrends.com/computing/youtubes-ai-powered-search-is-rolling-out-in-the-us-to-find-videos-based-on-situations-you-describe/ (확인 2026-10-31, 2차)
[^kw-tools]: YouTube 키워드 도구 비교 글 모음, https://wyzowl.com/youtube-keyword-tools , https://1of10.com/blog/vidiq-vs-tubebuddy/ (확인 2026-10-31, 2차)
[^dr-legal]: DataReportal Legal, https://datareportal.com/legal (확인 2026-10-31, 1차)
[^dr-reports]: DataReportal Reports, https://datareportal.com/reports (확인 2026-10-31, 1차)
[^dr-kr]: Digital 2026: South Korea, https://datareportal.com/reports/digital-2026-south-korea (2025-11-08, 확인 2026-10-31, 1차)
[^iga-blog]: 모바일인덱스 블로그, https://www.igaworks.com/blog/mobileindex (확인 2026-10-31, 1차)
[^nielsen-aug]: TV Viewing Cools Off in Nielsen's August Gauge Reports, https://www.nielsen.com/news-center/2026/tv-viewing-cools-off-in-nielsens-august-gauge-reports-as-sports-take-a-breather-and-school-resumes/ (2026-10, 확인 2026-10-31, 1차)
[^nielsen-robots]: Nielsen robots, https://www.nielsen.com/robots.txt (확인 2026-10-31, 1차)
[^pew-fact]: Social Media Fact Sheet, https://www.pewresearch.org/internet/fact-sheet/social-media/ (2026-10-19, 확인 2026-10-31, 1차)
[^pew-terms]: Pew Terms and Conditions, https://www.pewresearch.org/about/terms-and-conditions/ (확인 2026-10-31, 1차)
[^pew-llms]: Pew llms.txt, https://www.pewresearch.org/llms.txt (확인 2026-10-31, 1차)
[^pew-ai]: Google users are less likely to click on links when an AI summary appears in the results, https://www.pewresearch.org/short-reads/2025/07/22/google-users-are-less-likely-to-click-on-links-when-an-ai-summary-appears-in-the-results/ (2025-07-22, 확인 2026-10-31, 1차)
[^ofcom-2nd]: Media Nations 2026, https://www.ofcom.org.uk/media-use-and-attitudes/media-habits-adults/media-nations-2026 , PDF https://www.ofcom.org.uk/siteassets/resources/documents/research-and-data/multi-sector/media-nations/2026/media-nations-2026-uk-report.pdf (이 환경 403, 검색 요약 기준, 확인 2026-10-31, 2차)
[^em-2nd]: EMARKETER PRO+, https://www.emarketer.com/pro-plus/ , Vendr 추정 https://vendr.com/marketplace/emarketer (확인 2026-10-31, 2차)
[^goog-8k]: Alphabet 8-K Exhibit 99.1 Q3 2026, https://www.sec.gov/Archives/edgar/data/1652044/000165204426000080/googexhibit991q32026.htm (2026-10-28, 확인 2026-10-31, 1차)
[^kmcc-press]: 방미통위 2025 방송매체 이용행태조사 보도자료, https://www.kmcc.go.kr/download.do?fileSeq=62354 (2025-12-30, 확인 2026-10-31, 1차)
[^kmcc-rename]: 방통위 폐지·방미통위 출범 보도, https://www.ddaily.co.kr/page/view/2025092721144306464 (확인 2026-10-31, 2차)
[^kisdi]: KISDI 미디어통계포털, https://stat.kisdi.re.kr/ , 방송통계포털 https://www.mediastat.or.kr/ (확인 2026-10-31, 1차)
[^kobaco]: KOBACO 방송통신광고비조사 보고서 게시판, https://www.kobaco.co.kr/site/adstat/board/broadcastprice/list (확인 2026-10-31, 1차)
[^kmcc-ad-press]: 온라인광고 7.9% 증가, 방송광고 5% 감소 보도자료, https://www.kmcc.go.kr/download.do?fileSeq=62433 , https://www.korea.kr/briefing/pressReleaseView.do?newsId=156738893 (2026-01-08, 확인 2026-10-31, 1차)
[^os-blog]: 오픈서베이 트렌드 리포트, https://blog.opensurvey.co.kr/category/trendreport/ (확인 2026-10-31, 1차)
[^yt-blog]: YouTube Official Blog RSS, https://blog.youtube/rss/ (최신 항목 2026-10-28, 확인 2026-10-31, 1차)
[^ci]: Creator Insider, https://www.youtube.com/@creatorinsider (채널 ID UCGg-UqjRgzhYDPJMr-9HXCg, 구독 932,000, 확인 2026-10-31, 실측)
[^ypp]: YouTube Partner Program overview & eligibility, https://support.google.com/youtube/answer/72851 (확인 2026-10-31, 1차)
[^ypp-changes]: Changes to the YouTube Partner Program, https://support.google.com/youtube/answer/12843009 (확인 2026-10-31, 1차)
[^views-help]: How engagement metrics are counted, https://support.google.com/youtube/answer/2991785 (확인 2026-10-31, 1차)
[^traffic-help]: Understand your YouTube video reach, https://support.google.com/youtube/answer/9314355 (확인 2026-10-31, 1차)
[^shopping]: YouTube Shopping affiliate program overview & eligibility, https://support.google.com/youtube/answer/13376398 (확인 2026-10-31, 1차)
[^yt-reco]: How YouTube recommendations work, https://support.google.com/youtube/answer/16089387 , https://www.youtube.com/howyoutubeworks/recommendations/ (확인 2026-10-31, 1차)
[^yt-trends]: YouTube Culture & Trends, https://www.youtube.com/trends/ (확인 2026-10-31, 1차)
[^ahrefs]: The 50 Most-Cited Websites in Google AI Overviews, https://ahrefs.com/blog/most-cited-domains-ai-overviews/ (2026-09-02 갱신, 확인 2026-10-31, 1차)
[^so-2nd]: The results of the 2026 Developer Survey, https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/ (확인 2026-10-31, 2차)
[^octoverse]: Octoverse 2026, https://octoverse.github.com/ (확인 2026-10-31, 1차)
[^ad-formats]: YouTube ad formats, https://support.google.com/google-ads/answer/2375464 (확인 2026-10-31, 1차)
[^npr-2nd]: 2026 NPR 보도, https://www.newsis.com/view/NISX20260326_0003564605 , 페이지 https://www.nasmedia.co.kr/나스리포트/npr/ , 요약 PDF https://www.nasmedia.co.kr/wp-content/uploads/2026/03/2026_NPR_요약보고서_주요발견점_f.pdf (2026-03-26, 확인 2026-10-31, 2차)
[^wa-2nd]: 유튜브 없이 못 사는 한국인들, https://www.hankyung.com/article/202606171070g (2026-06-17, 확인 2026-10-31, 2차)
[^soop-2nd]: SOOP 2026 2분기 실적 보도, https://byline.network/2026/07/31-323/ , IR https://corp.sooplive.com/ir.php (확인 2026-10-31, 2차)
[^cp-2nd]: YouTube Is Making It Easier for Advertisers to Connect to Creators, https://www.thewrap.com/industry-news/tech/youtube-creator-partnerships-brands-ai-newfronts (확인 2026-10-31, 2차)
[^bench-2nd]: 벤더 글 표본, https://www.bytecap.io/research/youtube-shorts-retention-benchmarks , https://miraflow.ai/blog/youtube-traffic-sources-2026-browse-search-suggested-system (확인 2026-10-31, 2차)
[^crawl-2nd]: 크롤링 판결 해설, https://www.shinkim.com/kor/media/newsletter/1843 , 대법원 자료 https://www.scourt.go.kr/sjudge/1652779958317_183238.pdf , 민사 보도 https://www.lawfact.co.kr/news_proc/news_contents.jsp?ncd=2977 (확인 2026-10-31, 2차)
[^pipa-2nd]: 공개된 개인정보 처리 안내서 보도, https://m.boannews.com/html/detail.html?idx=131406 , 법 개정 해설 https://www.daeryunlaw.com/newsletter/news/156 (확인 2026-10-31, 2차)
