# 결정 1 구현 (WP-24, 2026-11-01)

사용자 답(ADR-0002 결정 1, 2026-10-31): 키 없는 두 경로만 쓴다.

| 경로 | 소스 id | 호출 | 파서 |
|---|---|---|---|
| Trends RSS (P09c) | `src:google-trends` | `https://trends.google.com/trending/rss?geo=KR`, `geo=US` | `trends_rss@1` |
| google.com 자동완성 (P04의 google.com 호스트) | `src:yt-suggest` | `https://www.google.com/complete/search?client=firefox&hl=ko\|en&q=<시드>` | `google_suggest@1` |

쓰지 않는다: `suggestqueries-clients6.youtube.com` 변형, yt-dlp, InnerTube, 채널 RSS 폴링, WebSub, YouTube Data API 키, OAuth(`kb auth google`), 키·계정 소스(X02, X04, X05, X07~X10, X18~X21), Trends Explore(P09a)와 내부 API(P09b). 결정 1 답이 키를 만들면 자동완성을 끊는다(ADR 23.1)고 했으므로 키를 만들지 않는다. 그래서 `auth.py`는 없고 ttl30, III.I.15 재확인, ADR 23.4 재검토는 이 범위에 없다.

## 구성

- 어댑터: `src/kb/ytpath/adapters.py`. `kb.parse.ADAPTERS`가 `kb.ytpath.adapters`를 탐색한다.
- 소스 정의와 호스트 해제: `sources/overlays/ytpath.yaml`. `host_allow`는 `trends.google.com`, `www.google.com` 둘뿐이다. youtube.com 계열과 `suggestqueries.google.com`은 host-policy 거부 그대로다.
- 내부 작업: 없음(`sources/internal.d/ytpath.yaml`은 빈 목록). `kb tick` 3단계(fetch), 4단계(parse)가 돈다.
- 시드: 도메인 A(키워드맵)와 D(채널 설계)의 한국어 24개, 영어 22개. 자동완성은 시드당 1요청, 12시간 간격(`interval_s: 43200`)이라 하루 약 90요청이다. Trends RSS는 지역당 1요청이다.
- robots(2026-11-01 재측정): `www.google.com/robots.txt`에 `/complete` 규칙이 없다. `trends.google.com/robots.txt`는 `/explore?`, `/trends/explore?`만 막고 `/trending/rss`는 막지 않는다. 수집기는 `robots: enforce`로 매 호출 확인한다.

## 저장 형태

- 응답에 검색량이 없다(자동완성). Trends RSS의 `approx_traffic`은 Google이 준 구간 값이고 YouTube 검색량이 아니다.
- 점수, 순위, 응답 안 순서를 저장하지 않는다. 제안마다 Keyword 노드와 "질의 Q에 Google 자동완성이 T를 제안했다(날짜 관측)" 주장 하나를 낸다. 사실 투영이 `(제안)-[autocomplete_suggested_for]->(질의)` 엣지를 만든다.
- Trends는 "Google Trends 일별 급상승 검색어(지역)에 T가 날짜에 올랐다"와 "대략 검색량 구간을 X로 표시했다" 두 주장이다. 귀속 표기는 `qualifiers.attribution`에 Google Trends, Google 자동완성이다.

공개 문구: "Google 자동완성이 제안한 문구와 Google Trends 일별 급상승 검색어를 출처 귀속으로 기록한다. 검색량, 순위, 점수는 아니다. YouTube 검색량이 아니다."

## 실측 (2026-11-01, KB_LIVE=1, 실운영 KB_HOME, `kb tick --only` 각 1회)

- 호출: Trends RSS 2회(KR, US), 자동완성 46회. 둘 다 `failed_sources=0`, `robots_denied=0`.
- gold(applied_seq 18593) Keyword 노드 475개(한글 포함 221개). 엣지 `autocomplete_suggested_for` 407개. 주장 `trending_search` 20개(KR 10, US 10), `google_trends_approx_traffic` 20개, `autocomplete_suggested_for` 407개.
- 표본 3개: "유튜브 조회수 1위"(`e:keyword:1`, 자동완성), "youtube watch time for monetization", "김지민"(Trends KR 2026-11-01).

## core 전송량 검토 (계약 5장, 3차 회신 확인 b)

측정 입력: 게시 판 `p-000018571`의 `core.json.zst`(노드 2253, 엣지 1125, 압축 61,105 B, 풀면 368,259 B).

| 항목 | 값 |
|---|---|
| core 안 Keyword 노드 | 474 |
| Keyword에 닿는 core 엣지 | 407 |
| core 압축 바이트, Keyword 포함 | 61,458 B (재압축 기준) |
| core 압축 바이트, Keyword 제외 | 44,779 B |
| Keyword 몫 | 16,679 B = 노드 1개당 약 35 B (엣지 포함) |
| Keyword 몫 풀면 | 103,991 B = 노드 1개당 약 219 B |

외삽(표본 474개라 압축률이 낮게 잡힌 상한 쪽 추정, 5만~10만 노드는 아직 없다): Keyword 5만개 core 약 1.8 MB, 10만개 약 3.6 MB 압축. 풀면 11~22 MB JSON이다. Keyword 제외 core는 현재 규모에서 45 KB 수준이라 Keyword가 core 크기를 지배한다.

비교한 안:

| 안 | 평가 |
|---|---|
| 유지 | 계약 변경 없음. 5만 노드를 넘으면 loupe 전송과 풀기 비용이 Keyword 하나로 결정된다 |
| `types` 파라미터 | 호환 변경이지만 게시 파일은 판마다 미리 만든 `.json.zst`라 요청별 제외는 요청 때 다시 만들고 압축해야 한다. 파일 서빙 모델과 sha256/bytes manifest와 맞지 않는다 |
| 별도 프로필 | 호환 변경(프로필 값 추가). 게시 때 Keyword를 뺀 파일을 같이 만들고 manifest `profiles`에 항목을 더한다. 파일 서빙, sha256, bytes 모델 그대로다 |

선택: **별도 프로필**. `core`는 지금 계약대로 Keyword를 담고(바꾸면 파괴 변경), Keyword를 뺀 프로필 `lite`를 추가한다. loupe는 `type` 열로 이미 거르므로 `lite`로 옮기면 된다. 이 패키지 소유 경로 밖이라 코드와 계약은 고치지 않았고 변경 요청으로 반환했다(`src/kb/publish/__init__.py`의 `_write_profile`/`publish`, `docs/contracts/data-interface-v0.md` 5장, `openapi.yaml`의 `profile` enum과 manifest). 적용 전까지 `core`가 Keyword를 담는다.

Keyword 5만 노드까지는 시드 확장이 필요하다. 지금 시드 46개로는 반복 수집해도 수백~수천 개에서 머문다.

## 인수 시험

`ops/bin/dev pytest tests/ytpath -q`: 어댑터 고정 픽스처, 키·OAuth 없음, 쓰지 않는 경로 호출 0회, overlay 적용 뒤 P04와 P09c만 활성.
