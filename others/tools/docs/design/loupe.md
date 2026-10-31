# loupe 설계

- 상태: 설계안, 기준일 2026-10-31. 코드는 아직 없다. KB 계약 v0 초안과 대조했고 실제 KB로 돌린 것은 없다.
- 대상: `tools/loupe`, KB 읽기 전용 뷰어. tower와 서로 의존하지 않는다.
- 스택 버전은 `docs/research/brief.md` 1절을 따른다. 타입 생성기만 Orval 8.46.0으로 바뀌었다(S4).

| 표기 | 뜻 |
|---|---|
| [측정] | 이 머신에서 잰 값. 출처는 `docs/research/spike-results.md`의 S1~S5와 적대적 검토 |
| [측정·본문] | 이 문서를 쓰며 Node 26.13.0에서 잰 값. 시나리오당 N=1~2. 스크립트는 `docs/research/spikes/design-probes/`(`warm.cjs`, `sched.cjs`, `loupe-check-ts`, `kb-contract/`). `kb-contract/`는 KB 코드가 아니라 Starlette 1.10.0, uvicorn 0.54.0, Unix 소켓으로 만든 스탠드인이다. 처리기는 ID를 돌려줄 뿐 조회하지 않는다 |
| [T] | 위협 검토의 프로브. 원시 소켓, 헤드리스 Windows Edge, 라우터 1.170.46, Orval 8.46.0. N=1 |
| [소스] | 패키지 소스나 타입 선언을 읽어 확인한 사실 |
| [가정] | 재지 않은 판단 |
| [계약] | KB 계약 v0 초안의 이름과 규칙. 초안이므로 `openapi.yaml`이 나오면 그 파일이 이긴다 |
| C n, C:Ln | KB `docs/contracts/data-interface-v0.md`의 절과 줄. sha256 `49fb5365290a76d3…`로 고정한다. KB `docs/`가 아직 커밋되지 않았다 |
| `[잠정]` | 계약이 협의 전이라고 표시한 항목. 여기에 달린 것은 부록 C 끝의 표에 모았다 |

**핵심 결정**

| 항목 | 결정 |
|---|---|
| 먼저 만들 기능 | Obsidian식 탐색: 팔레트, 엔티티 페이지, 주장 카드, 출처 확인. Notion식 표는 그다음이다 |
| 라우팅 | hash history. 자산은 어떤 정적 서버, 어떤 마운트 경로에서도 다시 빌드 없이 돈다. 실제 KB 데이터는 `loupe serve`를 거쳐야 한다 |
| KB 접근 | 브라우저는 같은 출처의 상대 경로 `kb/`만 호출한다. 뒤에서는 `loupe serve`가 KB Unix 소켓에 붙는다(C 1). 브라우저는 소켓에 닿지 못한다 |
| X7 | 레이아웃과 커뮤니티는 브라우저 자체 worker에서 계산하고 IndexedDB에 둔다. 입력은 export `core`, 키는 위상 해시다. `build_id`를 키로 쓰지 않는다. KB와 tower에는 쓰지 않는다 |
| 그래프 규모 | 기본 개요는 노드 1만, 엣지 5만 이하다. 2만은 사용자가 고르는 보기이고, 5만은 전체를 그리지 않는다 [측정: S5] |
| X11 | `tools/loupe/contract-sample/`의 임시 표본. 계약 v0 2~5장에서 옮겨 적는다. 공유 패키지는 없다. KB의 `openapi.yaml`이 나오면 삭제한다 |
| 포트 | dev 4810, kb-mock 4811, 설치본 4812. 4812는 이 문서가 새로 잡는다 |

## 1. 목적과 비범위

KB를 계약으로만 읽어 엔티티, 주장, 출처, 시간을 탐색하는 로컬 웹앱이다. Obsidian처럼 링크를 따라 이동하고 Notion처럼 타입별 표로 훑되, 모든 값이 인용 원문까지 이어지고 어느 시점으로든 돌아갈 수 있어야 한다. 기성 앱은 외부 읽기 전용 소스, 이중 시간축, 인용구 출처를 함께 다루지 못한다(`oss-viewers.md`, VV 5절).

**완료 기준**

1. 어떤 주장이든 클릭 두 번 안에 원문의 인용 위치에 닿는다.
2. 화면 상태(엔티티, 시간 기준, 필터, 강조할 인용)가 URL 하나로 재현된다.
3. 과거 보기를 현재로 착각할 수 없다.
4. 기본 개요(노드 1만, 엣지 5만 이하)에서 11절 예산을 지킨다.
5. tower 없이 동작하고, KB가 내려가도 앱이 깨지지 않는다.

| 비범위 | 이유 |
|---|---|
| 쓰기, 댓글, 주석, 사용자 태그 | 뷰어는 읽기 전용이다. first_party 입력은 KB 쪽 설계다(소비자 문서 L62, C 6) |
| 파생값 되쓰기 | `CLAUDE.md`가 금지한다. 레이아웃은 브라우저 안에만 남는다 |
| DB 파일 직접 접근, MCP를 데이터 경로로 쓰기, Datasette | 계약으로만 읽는다(L22, L23). KB는 SQLite 사본을 게시하지 않는다(C 1) |
| 한국어 검색 구현, 초성 타입어헤드, 민감도 필터링 | KB 소관이다. 도구는 입력을 NFC로 정규화만 한다(X10) |
| 점수, 추천, 대시보드 | 소비자 문서 L69. 크기와 색은 시각화용 파생값일 뿐이다 |
| 실시간 푸시, 다중 사용자 | 폴링 30~60초, 사용자 1명(L57) |
| MCP Apps, SSR, 데스크톱 패키징 | 도구 결과의 딥링크로 충분하다. Orca 탭이 셸이다 |
| 첫 판의 PDF 렌더, 원본 HTML 충실 재현, 계층 커뮤니티 지도 | 형식이 미정이거나 측정이 없다. 12절의 나중 항목이다 |

## 2. 정보 구조

**첫 기능 세트는 Obsidian식 탐색이다.** 이유는 셋이다.

1. KB 모델이 엔티티, 관계, 주장이라 어떤 경로든 엔티티 페이지로 모인다.
2. 표는 `filter` 문법에 기대고 그 문법은 아직 열려 있다(C 4.4, 부록 B). 탐색은 계약 v0의 경로로 돈다.
3. 이 도구의 차별점은 인용 확인이고, 그것은 엔티티 페이지와 출처 화면에 있다(`trends.md` 요지 4).

**허브는 엔티티 페이지다.** 그래프, 표, 검색, 변경 피드, 팔레트, MCP 딥링크가 모두 여기로 들어오고 여기서 다시 관계, 이력, 출처로 나간다.

| 구역 | 내용 |
|---|---|
| 왼쪽 레일 | 그래프, 표, 검색, 변경, 스키마. 표 메뉴는 스키마 카탈로그로 구동하고 타입을 코드에 적지 않는다 |
| 상단 | 시간 띠(과거 보기일 때), 시간 칩, 팔레트 버튼, 연결 상태와 `data_as_of` |
| 본문 | 라우트 화면 |
| 오른쪽 패널 | 그래프 노드나 표 행을 고르면 엔티티 요약. 경로를 바꾸지 않고 훑는다 |

| 사용 방식 | loupe 대응 | 비고 |
|---|---|---|
| Quick switcher | 팔레트에서 엔티티로 이동 | 서버 검색 |
| 노트 | 엔티티 페이지: 주장 카드를 술어별로 묶은 것 | first_party 본문은 `include=body`로 받아 위에 표시한다. `first_party_open=false`면 없다(C 4.1, 6.3) |
| 백링크 | 관계 패널의 들어오는 링크 | 노트 간 링크는 `LINKS_TO`와 `include=backlinks`다(C 6.3). 페이지 수준까지다 |
| Graph, Local graph | `/graph`, `/graph?focus=<id>` | 같은 캔버스 |
| Bases, Notion DB | `/table/<type>` | 열은 카탈로그가 정한다 |
| 필터, 저장된 뷰 | URL 검색 파라미터 | URL이 원본이다. 이름 붙인 목록은 두지 않는다 |
| Notion 페이지 편집 | 없음 | 읽기 전용 |

**팔레트.** cmdk(shadcn `Command`), `Ctrl+K`와 `/`로 연다.

- `shouldFilter={false}`. 정렬과 토큰화는 KB 검색이 맡는다. 호출은 `/v1/search?q=&kinds=entity,record&limit=`다. 입력 중인 라틴 이름의 접두어 일치는 계약에 없다(KB ADR 14.1은 전체 토큰을 색인한다, 부록 B).
- cmdk는 IME 조합 중에도 search를 발화하므로 150 ms 디바운스하고 앞선 요청은 취소한다(VV-C9). 값은 보내기 전에 NFC로 바꾼다.
- 묶음은 셋이다: 엔티티(서버 검색), 이동(화면, 최근 항목), 시간(현재로, 날짜로 이동).
- 최근 항목은 ID만 `localStorage`에 둔다. 라벨은 팔레트를 열 때 최대 8개만 `/v1/nodes/{id}`로 읽는다 [가정]. 일괄 읽기가 없다(부록 B).

## 3. 화면 표

경로는 URL의 `#` 뒤 값이다. 화면 경로는 모두 `as_of_valid`, `as_of_observed`를 받는다. KB 호출에 싣는지는 오퍼레이션마다 다르다(4절). L은 소비자 문서 줄 번호이고 2026-10-31 21:06 판 기준이다. 상태 열은 계약 v0와 대조한 결과다. 충족은 계약 문장만으로 구현할 수 있다는 뜻이고, 부분은 `[가정]`이 하나 이상 필요하다는 뜻이다. 공백은 계약에 길이 없다는 뜻이다.

| 화면 | 경로 | KB 호출과 필드 | 상태 | 남은 공백 |
|---|---|---|---|---|
| 그래프 개요 | `/graph?types=&rtypes=&domain=` | `GET /v1/overview`: `data.meta.{node_total,edge_total,truncated,order,graph}`, `nodes`, `edges`(`columns`, `rows`). 좌표 입력은 `GET /v1/export/graph/manifest`, `GET /v1/export/graph?profile=core` | 부분 | 기본 타입(13장). 두 상한에 `truncated` 하나. 엣지 `status` 없음. 4.3 표에 `domain` 파라미터 행이 없다(필수 필터 행과 4장 공통 필터에만 있다) |
| 이웃 확장 | `/graph?focus=<id>&depth=&rtypes=` | `GET /v1/nodes/{id}/neighbors?depth=&rtypes=&direction=&limit=` | 부분 | 예시가 없다. 열, `truncated` 위치, 절단 순서, 엣지 상한이 미정이다 |
| 노드 상세 | `/node/<id>` | `GET /v1/nodes/{id}?include=claims,edges,backlinks,body&claim_limit=`: Node 필드, `claims[]`, `edges.{out,in}`, `merged_into` | 부분 | 주장 커서, 최대값, 정렬이 없다. `edges` 항목에 반대쪽 라벨이 없다. `backlinks` 모양과 본문 필드 이름이 미정이다 |
| 표, 패싯 | `/table/<type>?f=&sort=&cols=` | `GET /v1/nodes?type=&filter=name:op:value&sort=&cursor=&limit=`: `data.items[]`, `page`. `GET /v1/facets`: `total`, `facets`. `GET /v1/schema`: `properties[]`, `sort_keys` | 부분 | 연산자, 정렬 방향, 복수 필터 문법이 미정이다. `source`는 `filter_keys`에 있고 공통 필터에 없다 |
| 전문검색 | `/search?q=&types=&origin=&status=&domain=&kinds=` | `GET /v1/search`: `items[].{id,kind,type,title,snippet,highlights,highlight_unit}`, `page` | 부분 | `kind=claim` 모양만 있다. `subject`, 문단의 `snapshot_id`와 오프셋이 없다 |
| 시점 지정 | 모든 화면의 `?as_of_valid=&as_of_observed=` | 시간을 받는 오퍼레이션에만 싣는다. 확인은 봉투 `as_of`다 | 부분 | `/history`의 동작이 미정이다 |
| 이력 | `/node/<id>/history?predicate=` | `GET /v1/nodes/{claim_id}/history`: `chain[].{id,version,status,value,unit,valid,recorded_at,expired_at,superseded_by}`. 시계열은 `GET /v1/series/{id}?from=&to=&bucket=`: `points[]`, `gaps[]`(충족, `value`는 문자열) | 부분 | 엔티티·술어별 체인이 없다. `chain`에 `statement`가 없다 |
| 출처, 인용 강조 | `/source/<snapshot_id>?claim=<claim_id>&ev=<evidence_id>` | `GET /v1/snapshots/{id}`, `/text?start=&max_chars=`, `GET /v1/claims/{id}` | 부분 | `/v1/claims/{id}`는 표 행만 있고 절이 없다. `/text`의 단위와 창 메타데이터가 미정이다 |
| 변경 피드 | `/changes?origin=` | `GET /v1/changes?cursor=&limit=&kinds=`: `items[].{seq,at,kind,id,version,type,origin}` | 부분 | 꼬리 읽기와 `origin` 파라미터가 없다. `origin`은 항목 필드로만 있다 |
| 스키마 | `/schema` | `GET /v1/schema`: `node_types`, `edge_types`, `predicates`, `enums`, `sort_keys`, `filter_keys` | 부분 | 표시 이름이 `predicates`에만 있다 |

| 화면 안의 호출 | KB 호출 | 상태 | 남은 공백 |
|---|---|---|---|
| 왼쪽 레일, 표 메뉴 | `/v1/schema`의 `node_types[].{name,group,count,status}` | 충족 | |
| 상단 상태, 새 데이터 칩, 폴링 | 봉투, `/v1/meta`의 `data_as_of`, `applied_seq`, `epoch`, `degraded` | 충족 | 7.3절 |
| 오른쪽 패널 | `/v1/nodes/{id}?include=claims&claim_limit=` | 충족 | |
| 팔레트, 최근 항목 | 2절 | 부분 | 접두어 일치, 일괄 읽기 |
| 카드 값 | `claims[]`, `/v1/schema`의 `predicates[]` | 부분 | 5절. 값 표시는 `value_kind`로 고른다 |
| 후속 주장 링크 | `/v1/nodes/{claim_id}/history`의 `superseded_by` | 부분 | `Claim`에 없어 카드를 펼칠 때 1회 더 부른다 |
| 갱신과 정정의 구분 | 없음 | 공백 | C:L410의 시간축 추론뿐이다 |
| 엣지 상태 | `/v1/edges/{id}`뿐 | 공백 | 개요, 이웃, export 열에 없다. 그 경로의 절도 없다 |
| 조건부 GET | `ETag`, 304 | 부분 | 개요, export, 스키마 중 개요만 C 2.5 행이 있다. KB ADR 1.3이 정의를 바꿨고 C 2.5 대기 |

화면 메모:

- **그래프 개요.** 필수 필터가 없다(C 4.3). `limit=10000&edge_limit=50000`을 실은 기본 호출을 먼저 그린다. `truncated`면 "N / total" 띠와 좁히기 안내를 띄우고, 타입 선택은 `/v1/facets` 개수로 만든다. 노드와 엣지 중 무엇이 잘렸는지는 `node_total`, `edge_total`을 받은 행 수와 비교해 안다. 2만 보기는 사용자가 고르고 `limit=20000&edge_limit=100000`을 보내기 전에 경고한다(6.1절).
- **표.** TanStack Table v9 manual 모드, Virtual로 행 창을 관리하고 끝에서 20행 전에 다음 페이지를 읽는다. 필터 컨트롤은 카탈로그가 필터 가능하다고 한 속성에만 그린다. 값 렌더는 주장 카드와 같은 컴포넌트를 쓴다. `page.total`은 `null`일 수 있다 `[잠정]`. 그때는 받은 행 수에 `+`를 붙인다.
- **저장된 뷰.** URL이 원본이다. 필터, 정렬, 열만 담고 커서는 담지 않는다.
- **이력.** ECharts custom series로 구간을, step line으로 숫자 값을 그린다. 브러시는 시간 기준을 URL에 쓴다.

## 4. 시간 여행

시간 기준은 전역 하나다. URL 파라미터 `as_of_valid`, `as_of_observed`가 원본이고 화면 상태에 복사본을 두지 않는다.

| `as_of_valid` | `as_of_observed` | 뜻 | 띠 문구 |
|---|---|---|---|
| 없음 | 없음 | 지금 아는 전체(유효 종료, 발효 전 포함) | 띠 없음 |
| T | 없음 | T의 사실을 지금 아는 대로 | 유효 T |
| 없음 | T | 현재 사실을 T까지 알던 대로 | 관측 T |
| T1 | T2 | T1의 사실을 T2까지 알던 대로 | 유효 T1, 관측 T2 |

해석 규칙의 소유자는 KB다(C 2.9). S4 fixture로 보면 유효 시점을 2025-06-01로 고정해도 관측이 2025-06-01이면 120명, 2026-06-01이면 150명이다. 소급 정정이 보이는 것이 이 표의 존재 이유다.

**기본 유효축.** KB ADR 7.4가 정했다. 기본 읽기는 관측축만 현재로 고정하고 유효축은 `as_of_valid`를 줄 때만 건다. 표 1행은 지금 아는 전체이고 발효 전 주장과 유효 종료 주장이 기본 화면에 나온다. 카드는 `valid`로 상태를 표시한다(5절). C 2.9 문장은 아직 '기본값은 현재'다(부록 B).

**적용 규칙**

| 규칙 | 방식 |
|---|---|
| 파싱 | 루트 라우트 `validateSearch`가 RFC 3339 `Z` 형식만 받는다. 날짜만 있는 `valid.from`으로 옮길 때는 `T00:00:00Z`를 붙인다 |
| 잘못된 값 | 오류 화면을 낸다. 현재 데이터로 조용히 떨어지지 않는다 |
| 전파 | 루트 라우트 `retainSearchParams(['as_of_valid','as_of_observed'])`로 모든 `Link`가 유지한다 [소스: react-router 1.170.46 내보내기] |
| 데이터 층 | 생성 훅은 `src/data/` 밖에서 import 금지(ESLint). 래퍼가 오퍼레이션별 허용 목록을 보고 `asOf(useTimeBasis())`를 넣는다. `/v1/changes`, `/v1/snapshots/{id}` 계열, `/v1/meta`, `/v1/schema`, `/v1/export/*`에는 넣지 않는다. 넣으면 400 `as_of_unsupported`다(C 2.9). `/history`는 C 2.9의 두 표 어디에도 없어 KB 답이 올 때까지 넣지 않는다 [가정] |
| 캐시 | Orval 쿼리 키에 파라미터가 들어가 두 축이 키로 갈린다 [측정: S4] |
| 페이지네이션 | 시간 기준이 바뀌면 쿼리 키가 바뀌어 커서가 버려진다 |
| 표시 | 시각은 UTC로 저장하고 KST로 표시하며 `title`에 UTC 원문을 둔다. `valid.from`, `valid.to`는 날짜일 수 있다(C 2.2). `label`이 있으면 `label`을, 없으면 `precision`에 맞춰 그대로 보인다. 날짜 값은 시간대를 옮기지 않는다 |

**`asOf` 도우미.** 축 이름을 적는 곳은 여기 하나뿐이다.

```ts
// tools/loupe/src/time/asOf.ts
import type { GetNodeParams, ListNodesParams, GetOverviewParams, SearchParams } from '../client/model'; // 이름은 `openapi.yaml`의 operationId를 따른다 [가정]

export type TimeBasis = { valid?: string; observed?: string };

export const asOf = (t: TimeBasis) =>
  ({ as_of_valid: t.valid, as_of_observed: t.observed }) satisfies
    GetNodeParams & ListNodesParams & GetOverviewParams & SearchParams;
```

- `satisfies`가 필요한 이유: 저장된 객체는 초과 속성 검사를 건너뛰어 축 이름이 바뀌어도 tsc가 0건이다 [측정: S4].
- **객체 리터럴에 키를 직접 적는다.** 조건부 스프레드(`...(t.valid ? {...} : {})`)로 쓰면 축 이름을 바꿔도 tsc가 조용히 통과한다. 리터럴 형태는 TS2353으로 잡힌다 [측정·본문: S4 생성물에 tsc 5.9.3].
- `undefined`는 생성 코드가 쿼리 문자열에서 뺀다 [소스]. 즉 "현재"는 파라미터를 보내지 않는 것이다.
- 런타임 보강: kb-mock은 모르는 쿼리 파라미터를 400으로 거부한다. KB는 아직 약속하지 않았다(부록 B). 실제 KB에서의 런타임 확인은 봉투 `as_of`와 요청값의 대조다. 문자열이 아니라 파싱한 시각으로 비교한다.
- 스펙 점검 스크립트가 시간 축이 없는 읽기 오퍼레이션을 목록으로 내고, 그 목록이 C 2.9의 제외 집합과 같은지 단언한다. `satisfies`는 빠진 오퍼레이션을 잡지 못한다.

**과거 보기 표시.** 닫을 수 없고, 넷을 함께 쓴다.

| 장치 | 내용 |
|---|---|
| 시간 띠 | 헤더 아래 고정 호박색 띠: "과거 보기 · 유효 … · 관측 … · 현재로". 스크롤해도 남는다 |
| 화면 테두리 | 앱 전체에 호박색 안쪽 테두리. 그래프 전체 화면에서도 보인다 |
| 탭 제목 | `document.title` 앞에 `[과거]`. Orca 탭에서 보인다 |
| 카드와 캔버스 | 주장 카드 묶음과 그래프 좌하단에 시간 표식(DOM). 스크린샷에도 남는다 |

- 과거 보기에서는 폴링 결과가 화면을 바꾸지 않는다. `applied_seq`가 늘면 "새 데이터 있음" 칩만 띄운다.
- 링크 복사는 시간 기준을 항상 포함한다. "지금으로 고정" 명령은 `as_of_observed`에 현재 `data_as_of`를 넣어 재현 가능한 링크를 만든다.
- 주장 카드의 "이 주장이 관측된 시점으로"는 `as_of_observed`를 그 주장의 `recorded_at`으로 옮긴다.
- 과거 보기의 출처 화면은 `citing_claims`를 "현재 기준" 표시와 함께 접어 둔다. 스냅샷 경로는 시간 축을 받지 않고 이 목록은 현재 값이다(C 2.9, 4.11).

## 5. 주장 단위 출처

**주장 카드.** 엔티티 페이지의 기본 단위다. 본문은 `statement`다(KB ADR 7.6). 술어별로 묶고 라벨은 `/v1/schema`의 `predicates[].labels`에서 읽는다. `predicate`가 `null`인 주장은 "분류 전" 묶음에 둔다.

**현재 값을 고르지 않는다.** 자동 대체는 결정적 주장에만 있고 LLM 주장은 공존한다. `conflict_group`에는 승자가 없다(KB ADR 7.6, C 머리말). 같은 술어의 `active` 주장은 `recorded_at` 내림차순으로 보이고, `conflict_group`이 같은 주장은 나란히 둔다. 묶음이 5개를 넘으면 뒤를 "n개 더"로 접는다 [가정]. 접는 기준은 순서일 뿐 우열이 아니다(`trends.md` M5).

| 요소 | 내용 |
|---|---|
| 값 | `value`는 문자열이다. `unit`, `object`, `qualifiers`를 곁에 둔다. 표시는 `predicates[].value_kind`로 고르고 모르는 값은 기본 분기로 `value`를 그대로 보인다. 열린 값은 오류가 아니므로(C 2.10, 8장) `never` 분기를 쓰지 않는다 |
| 시간 | 유효 구간(`valid`), 관측 시각(`recorded_at`), 마지막 재확인(`evidence[].last_confirmed_at`) |
| 귀속 | `stance=attributed`면 `speaker`를 앞세워 귀속 주장으로 적는다. `kind`, `method`는 칩이다 |
| 출처 알약 | `evidence[]` 하나에 번호 알약 하나. 호버하면 `exact`, 클릭하면 원문 위치로 이동한다. 링크에는 `ev=<evidence.id>`를 싣는다 |
| 확인 상태 | KB `verification`과 뷰어의 인용 확인 결과. `quote_found`는 "인용 위치 확인됨"으로 적는다. 주장이 참이라는 뜻이 아니다(C 3) |
| 칩 | `origin`, `sensitivity`, `status`, `liveness`. 값 이름은 카탈로그에서 읽고 하드코딩하지 않는다 |

**출처 화면.** 머리에 `fetched_at`, `content_type`, `url`, `final_url`, `raw_sha256`, `text_sha256`, `extractor`를 둔다. 본문은 **표시 본문**(`/text`)을 기본으로 보여 주고 인용 강조는 여기서만 정확하다. 오프셋 기준이 표시 본문이기 때문이다(C 2.11). 본문 경로는 `text_format`으로 고른다(9절).

`/text`는 창으로 나뉜다(기본 2만, 최대 20만, C 4.11). 단위는 코드포인트로 본다 [가정]. 1단계 확인은 `start` 주변 창만 읽고 2단계는 `text_chars`까지 이어 읽는다. 오프셋은 절대값이므로 창 시작을 뺀다. `/text` 쿼리만 `staleTime: Infinity`다. `/v1/snapshots/{id}`는 `citing_claims`가 늘 수 있어 불변으로 다루지 않는다.

**인용 확인.** 위치 정보는 W3C `TextQuoteSelector`(`exact`, `prefix`, `suffix`)와 `TextPositionSelector`(`start`, `end`) 모양이다(C 2.11). 확인은 뷰어가 화면에서 하는 기계 확인이다. KB 판정을 대신하지 않고 되쓰지도 않는다. 둘이 어긋나면 둘 다 보여 준다. 엔티티 페이지는 알약을 열 때 지연 실행하고 "전체 확인" 명령을 따로 둔다. 카드마다 스냅샷을 받지 않기 위해서다. "전체 확인"은 동시 요청을 4개로 묶는다.

| 순서 | 판정 | 조건 | 강조 | 카드 표시 |
|---|---|---|---|---|
| 1 | 일치 | `start`, `end`가 있고 코드포인트 구간이 `exact`와 같다 | 오프셋 위치 | 원문 일치 |
| 2 | 위치 보정 | NFC 비교로 `exact`를 찾았고 `prefix`, `suffix`로 하나로 정해진다 | 찾은 위치 | 위치 보정 |
| 3 | 찾지 못함 | 1, 2단계가 모두 실패 | **없음** | 인용 찾지 못함 |
| - | 인용 없음 | 주장에 인용이 없다 | 없음 | 인용 없음 |
| - | 원문 없음 | 스냅샷 404 또는 숨김 | 없음 | 원문 접근 불가 |
| - | 경로 인용 | `selector_kind=jsonpointer` | 없음 | `json_pointer` 경로를 표시한다. 기준 문서는 `text_format=json` 표시 본문을 파싱한 값이다(KB ADR 7.7). v1은 확인하지 않는다 |

- 유사 일치(`approx-string-match`, `match-quote` 벤더링, 품질 임계값)는 v1에 없다. 스냅샷이 불변이고 오프셋이 표시용 본문 기준이라 1, 2단계가 올바른 인용을 가린다. 임계값은 같은 저자의 fixture로는 보정되지 않는다(12절 나중).
- **찾지 못했으면 틀린 곳을 강조하지 않는다.** 본문은 위치 이동 없이 열고, 주장에 기록된 `exact`를 "기록된 인용"으로 따로 보여 준다.
- 코드포인트에서 UTF-16으로 바꾸는 표는 astral 문자가 있을 때만 만든다. 단위는 코드포인트다(C 2.11). 검색 `highlights`는 스니펫 기준 코드포인트 오프셋이므로 스니펫을 UTF-16 인덱스로 자르지 않는다(C 4.8).
- 강조는 CSS Custom Highlight API를 쓴다. DOM을 바꾸지 않아 React와 충돌하지 않는다. 의미 정보가 없으므로 인용 위치에 시각 외 안내를 함께 둔다.
- Markdown 렌더 탭은 원문과 텍스트가 달라 강조하지 않는다. 인용 위치는 본문 탭에서 보여 준다.

**상태 표시**

| 상태 | 판정 | 주장 카드 | 그래프 엣지 | 기본 노출 |
|---|---|---|---|---|
| 현재 | `status=active`, 유효 구간 안 | 기본 | 실선 | 보임 |
| 유효 종료(그때는 맞았다) | `status=active`, `valid.to`가 지남 | 기본 색, 유효 구간 강조 | 실선 | 보임(KB ADR 7.4) |
| 발효 전 | `status=active`, `valid.from`이 미래 | "발효 예정" 칩 | 실선 | 보임(KB ADR 7.4) |
| 대체 | `status=superseded`, `/history`의 `superseded_by` 있음 | 흐리게, 후속 주장 링크 | 점선 | KB 기본 규칙 |
| 철회 | `status=superseded`, 후속 없음, `merged_into` 없음(KB ADR 7.6) | 흐리게, "철회" 칩 | 점선 | KB 기본 규칙 |
| 병합 | `merged_into` 있음 | 아래 `merged_into` 절 | 숨김 | 목록에서 제외(C 2.7) |
| dead | `status=dead` | 회색, "죽은 데이터" 칩 | 숨김 | KB 기본 규칙 |
| 미검증 | `verification`이 `needs_review` 또는 `unverified` | "미검증" 칩 | 해당 없음 | `include_unverified=true`일 때만 |

- 대체 사유 필드는 없고 요청을 철회했다. 소급 정정은 `valid`와 `recorded_at`이 어긋나는 행으로 나타난다(C 4.7). KB가 판정 규칙을 확인하면 "대체" 카드에 "정정" 칩을 더한다. 그 전에는 갱신과 정정을 나누어 적지 않는다.
- superseded, dead, 미검증의 포함 토글은 KB 파라미터(`status`, `include_unverified`)만 켠다. 클라이언트에서 다시 거르지 않는다(C 2.7). 주어가 `dead`이거나 병합이 아닌 이유로 `superseded`이면 `state`, `howto` 주장이 기본에서 빠진다(KB ADR 7.2. C 2.7은 아직 `dead`만 적었다). 그래서 죽은 엔티티의 기본 응답에는 주장이 비어 있을 수 있다. 그 페이지는 포함 토글을 먼저 보인다. 내장 주장에 이 파라미터가 적용되는지와 응답 `status`가 `eff_status`인지는 KB에 묻는다(부록 B).
- 이력 화면은 대체 체인을 전부 보여 주고 대체된 항목도 원문으로 갈 수 있다.

**`merged_into`.** 딥링크가 깨지지 않게 하는 장치다.

1. 응답의 `merged_into`가 비어 있지 않으면 생존 ID로 `replace` 이동하고 시간 기준을 유지한다. "A는 B로 병합됨" 띠를 띄운다.
2. 최대 5홉을 따라가고 순환이면 오류 화면을 낸다.
3. 생존 엔티티가 숨김이나 404면 "병합됨, 대상 접근 불가" 묘비 화면을 낸다.
4. 과거 시점의 병합 여부는 KB 응답을 따른다. 뷰어가 판단하지 않는다.
5. 그래프의 `focus=`도 같은 경로를 탄다.

**민감도.** KB 기본값을 넓히지 않는다.

- 숨김 해제 토글을 두지 않는다. 계약이 파라미터를 정해도 설계를 다시 본다.
- 클라이언트 필터링을 하지 않는다. 받은 것의 라벨만 보여 준다.
- 없는 항목과 숨긴 항목을 구분하지 않는다. 화면은 "없거나 볼 수 없음"이라고 쓴다.
- 레이아웃 캐시에는 ID와 좌표만 둔다. 라벨과 본문을 디스크에 저장하지 않는다. `e:<type>:<slug>`에는 이름이 들어 있으므로 ID도 이름에 가깝다. `core`가 `internal` 이하이고 브라우저 프로필 안이라 받아들인다. `record.redact`로 지운 ID는 캐시가 밀려날 때까지 남는다. 캐시는 최근 5개만 둔다.
- `loupe serve`의 프록시에 민감도를 넓히는 토큰을 넣지 않는다. Unix 소켓에는 토큰이 없다. TCP로 옮기면 `viewer` 토큰만 mode 600 파일에서 읽는다(10절). `owner` 토큰은 넣지 않는다.
- 무인증 읽기 API(4812의 `/kb/*`, tower 마운트)에는 숨김 해제 파라미터가 없다. 쿼리 파라미터로는 민감도를 올릴 수 없다(C 2.7). 노출 범위는 10절.

## 6. 그래프

### 6.1 S3 설정

S3 권장 조합을 그대로 쓴다. 전체 규모 측정값은 RTX 4080 SUPER, DPR 1.5, 165 Hz 기준이다 [측정: 검토의 재현]: 165 fps, 20 ms 초과 프레임 0, CPU+GPU 3.8/5.3과 3.5/5.0 ms, 오버레이 0.4/0.7 ms, 첫 프레임 621, 478 ms, 호버 7.9/26.4, 8.6/20.5 ms.

| 항목 | 값 | 이유 |
|---|---|---|
| 구동 | sigma 4.0.4, graphology 0.26.0. React 19 effect에서 직접 생성 | 이 경로만 쟀다. `@react-sigma/core` + 오버레이는 미검증 |
| sigma 설정 | `renderLabels:false`, `renderEdgeLabels:false`, `enableCameraRotation:false` | sigma 4 라벨은 첫 아틀라스 페이지 뒤의 한글을 틀린 글자로 그린다 [측정] |
| 라벨 속성 | graphology `label`에 넣지 않는다. 문자열은 `l` 속성 | 첫 프레임 1.9 s → 0.5 s, heap 165 → 63 MB [측정] |
| 라벨 예산 | `K = min(400, round(w × h / 15000))`, CSS px | 2279x1281에서 약 200. K=200 0.6/0.9 ms, K=400 0.9/1.4 ms [측정] |
| 오버레이 | Canvas 2D 한 장, `pointer-events:none`, `afterRender`마다 다시 그림 | |
| 글꼴 | `500 12px "Malgun Gothic","Noto Sans KR",sans-serif` | 시스템 글꼴. 원격 글꼴 없음 |
| 글자 | `fillRect` 배경 `rgba(255,255,255,.82)` 뒤 `fillText`. `strokeText`와 sprite 금지 | `strokeText`는 56~60 fps로 떨어지는데 JS 타이머에는 안 보인다 [측정] |
| 라벨 선택 | size 내림차순 typed array, 프레임마다 `graphToViewport` 세 점으로 affine, 24x16 px 충돌 격자, K에서 중단 | S3 `overlay.js` 이식 |
| 운영 보정 | 라벨 오프셋은 `sigma.scaleSize()`, 선택에 hysteresis 추가 | S3가 남긴 수정 |
| 점선 | `layerDashed({dashSize:{attribute:'dashLen',default:5,mode:'pixels'},gapSize:{value:5,mode:'pixels'}})`, `dashLen = superseded ? 5 : 1e6`, 스타일에 `dashLen:{attribute:'dashLen'}` | `gapSize` 0은 실선 엣지를 투명하게 만든다 [측정]. 개요와 export에 엣지 `status` 열이 생길 때까지 전부 실선이다 |
| 호버 | `refresh({partialGraph:{nodes,edges},skipIndexation:true})`, 이웃만, dim 없음 | 호버 동안 호버 노드와 이웃이 라벨 우선권을 갖는다 |
| 클릭 | dim-all은 클릭에만 | 281/323 ms [측정]. state-based style은 미검증 |
| 엣지 색 | 배경에 가까운 단색 `#d3d7de`, size 0.5 | rgba 회피 |
| 노드 크기 | `2 + min(10, sqrt(degree) × 0.9)` | S3 데이터와 같은 식. 라벨 우선순위도 이 값이다 |
| 라벨 클릭 | 필요해지면 pooled DOM | 164.9 fps, 0.4/0.7 ms [측정] |

엣지 라벨은 캔버스에 그리지 않고 선택 패널의 관계 목록으로 보여 준다. KB는 방향 멀티그래프다(C 2.12). graphology는 `MultiDirectedGraph`로 만들고 엣지 키는 엣지 `id`다. 평행 엣지는 그릴 때만 합친다. 개요와 export의 `edges`에는 `status`가 없어 엣지가 대체됐는지 알 수 없다(부록 B). S3와 S5 측정은 undirected 단순 그래프였다. 방향·다중 엣지를 넣은 비용은 Phase 2에서 다시 잰다.

**규모 경계.** 같은 조합을 KB 추정 규모로 다시 쟀다 [측정: S5]. 값은 실행별 범위다.

| 규모 | 첫 프레임 | CPU+GPU p95 | 호버 p95 | heap | 판정 |
|---|---|---|---|---|---|
| 10k/51k (S3) | 478, 621 ms | 5.0, 5.3 ms | 20.5, 26.4 ms | 63 MB + 18 MB, gc | 예산 안 |
| 10.5k/26.9k | 493~791 ms | 4.9, 5.4, 10.1 ms | 11.1~13.1 ms | 상한 50 MB | 3회 중 1회 CPU+GPU 초과 |
| 20k/80k | 924~1,244 ms | 8.3~12.0 ms | 18.3~32.7 ms | 상한 155~165 MB | 첫 프레임, CPU+GPU 초과. heap 상한도 예산 위이고 gc 값은 없다 |
| 50k/200k | 2,436, 2,722 ms | 19.4, 23.8 ms | 63.3, 66.7 ms | 상한 355, 361 MB | 첫 프레임, CPU+GPU, 호버 초과. heap 상한도 예산 위이고 gc 값은 없다. 오버레이는 통과 |

- 페이로드는 병목이 아니다. 50k/200k도 컬럼 JSON 19 MB, zstd 5.6 MB, 브라우저 파싱 75 ms 이하다 [측정: S5]. 막는 것은 렌더와 heap이다.
- **기본 개요는 노드 1만, 엣지 5만 이하다.** KB 기본 상한에 기대지 않고 `limit=10000&edge_limit=50000`을 항상 보낸다. KB ADR 16은 기본을 5만/20만으로 올렸고 C 4.3은 아직 10,000/50,000이다. S3가 이 범위를 통과했다.
- **2만은 사용자가 고른다.** 첫 프레임이 약 1 s임을 경고한 뒤 `limit=20000&edge_limit=100000`을 보낸다.
- **5만은 전체를 그리지 않는다.** 타입으로 좁히거나 이웃 확장으로 본다.
- S5 렌더 행은 GPU 경합이 의심되는 환경이다. fps, rAF, 20 ms 초과 프레임은 무효이고 GPU를 기다리는 값은 부풀었을 수 있다. 20k/80k 초과는 확정이 아니다. 재측정 전까지는 낮은 쪽을 기본값으로 둔다.
- 첫 프레임과 CPU+GPU가 노드 + 엣지에 거의 선형이라 천장은 15k/60k 근처로 본다 [가정]. 재지 않았다.

### 6.2 X7 해소: 레이아웃과 커뮤니티

**결정.** 브라우저 자체 worker에서 계산하고 IndexedDB에 둔다. 전체 그래프 입력은 export `core` 하나다. 키는 `(위상 해시, LAYOUT_VERSION)`이다. KB, tower, 어떤 서버에도 쓰지 않는다.

- **`build_id`를 쓰지 않는다.** `build_id`는 재구축 때 바뀌고 재구축은 논리 상태를 바꾸지 않는다(C 2.1, 2.6). 적재는 같은 빌드에 투영되어 `applied_seq`만 움직인다(KB ADR 1.2). 이 값을 키로 쓰면 아무것도 안 바뀐 재구축에 캐시를 버리고 실제 변경에는 낡은 좌표를 낸다. 봉투의 `g-…`와 manifest의 `p-…`도 다른 값이다.
- **브라우저로 충분하다.** 자체 worker는 Node보다 8~9% 느리고 메인 스레드 rAF는 p50 6.06 ms를 유지했다 [측정: S5]. 서버로 옮겨 줄어드는 시간이 작다.
- **좌표는 KB에서 오지 않는다.** S3는 Node에서 미리 계산해 개요에 `x`, `y`를 실어 보내라고 했다. 개요는 계약 응답이고 좌표를 내지 않는다(C 2.12, 소비자 문서 L68, X7).

| | A 브라우저, `core` (채택) | B 브라우저, 좁힌 개요 | C `loupe serve`, `core` |
|---|---|---|---|
| 전체 그래프가 브라우저에 든다 | 예. 50k/200k도 worker에서 돌았다 [측정: S5] | 아니요 | 아니요 |
| 필터를 바꿔도 좌표 유지 | 예 | 아니요 | 예 |
| 콜드를 치르는 단위 | 출처 × 프로필 | 범위 × 출처 × 프로필 | 위상 1회 |
| 새 서버 코드 | 프록시의 zstd 해제 몇 줄 | 없음 | 작업 실행기, API, 디스크 약 150~250줄 [추정] |
| 함께 바뀌는 결정 | 없음 | 없음 | ADR 결정 13, 4절 |

C를 고르지 않은 이유는 셋이다. 20k/80k 이상에서 Node가 줄이는 시간은 8~9%다. 소프트 미스가 게시마다 드는 재계산을 없앤다(아래). 라이브 탭에서 부르는 서버 작업은 비동기여야 한다. tower는 응답 헤더를 30 s 기다리고 `kbFetch`도 30 s다.

**계산 경로의 시간**

| 경로 | 규모 | 시간 | 근거 |
|---|---|---|---|
| Node `assign` 300회 | 10k/51k | 9.6 s, 재현 9.2 s | [측정] |
| Node `assign` 300회 | 20k/80k, 50k/200k | 17.5~18.3 s, 52.4~55.5 s, 3회씩 | [측정: S5] |
| 자체 worker의 `assign` 300회 | 20k/80k, 50k/200k | 18.9~20.2 s, 57.1~59.2 s, 3회씩 | [측정: S5] 보이는 탭, 벽시계 시간 |
| 패키지 worker `FA2Layout` 300회 | 1k / 5k / 10k/51k | 1.65~1.98 / 9.7~10.4 / 20.6~21.7 s, 13.8~14.5 it/s | [측정] 숨긴 탭, 메인 스레드 영향은 무효 |
| 웜 스타트 2% 변경, 50회(v1 미사용) | 10k/51k | Node 1.9 s, 비율 0.0682. 기존 노드 이동 p50 0.16%, p95 0.56% | [측정·본문] |
| 웜 스타트 10% 변경, 100회 | 10k/51k | Node 4.7 s, 비율 0.0714. 이동 p50 0.49%, p95 1.7% | [측정·본문] |
| 국소 재배치 | 311노드 100회 | Node 52 ms | [측정·본문] |
| Louvain | 10k/51k, 20k/80k, 50k/200k | Node 20~55, 62, 172 ms | [측정], [측정: S5] |
| 좌표 적용 | 20k/80k, 50k/200k | graphology 3~9 ms | [측정: S5] |

이동은 전체 대각선 대비 비율이다. 비율 값은 S3 지표(평균 엣지 길이 / 대각선)다. 300회는 20k, 50k에서도 충분했다. 800회와의 비율 차가 0.0005 이하다 [측정: S5].

**구현**

- 패키지 `FA2Layout` 대신 **Vite 모듈 worker 하나**에서 `forceAtlas2.assign`을 부른다. 패키지 supervisor는 반복마다 메인 스레드를 왕복하며 전체 좌표를 graphology에 쓴다 [소스]. 자체 worker는 끝에서만 좌표를 넘기고 `worker-src blob:`도 필요 없다.
- 300회를 한 번에 돌리고 끝에서 한 번 넘긴다. 시드는 품질을 바꾼다(0.0685 대 0.0762) [측정·본문, N=2 시드]. ID 정렬과 고정 시드로 결정적으로 만든다.
- 설정은 S3 그대로다: `inferSettings` + `barnesHutOptimize:true`(2,000노드 초과), `barnesHutTheta:0.6`, `adjustSizes:false`, 300회.
- Louvain은 같은 worker에서 레이아웃 뒤에 돈다. 동기 호출이고 `rng`를 고정한다. Leiden은 npm에 없다.

**입력과 흐름.** 그래프 화면을 열면 manifest를 읽고 `profiles.core.sha256`이 마지막 값과 같으면 내려받지 않는다. 다르면 `core`를 받아 위상 해시를 계산한다.

| 경우 | 판정 | 동작 | 사용자가 보는 것 |
|---|---|---|---|
| 적중 | 위상 해시가 캐시와 같다 | 좌표를 읽어 바로 렌더 | 첫 프레임 예산 안 |
| 소프트 미스 | 위상이 다르고 최근 좌표가 현재 노드의 90% 이상을 덮는다 [가정] | 최근 좌표를 재사용하고 새 노드만 국소 배치한다. 기존 노드는 `fixed`다 | 기존 노드가 움직이지 않는다 |
| 콜드 | 좌표가 없거나 덮는 비율이 모자란다 | 시드 배치로 렌더, 300회에서 한 번 교체 | 진행 막대, 2만 약 19 s, 5만 약 57 s. 나머지 화면은 계속 사용 |

- 위상 해시는 정렬한 노드 ID와 엣지 `(src, dst)` 쌍의 sha256이다. 라벨과 상태만 바뀐 게시는 적중이다. `sha256`은 같은지만 보므로 그 값이 압축본 기준이어도 된다.
- 입력은 `core`의 ID와 엣지 양끝만 쓴다. 라벨이 필요 없다. 게시 전이라 `core`가 없으면 개요 응답을 입력으로 쓰고 필터 해시를 키에 더한다.
- 표시는 언제나 개요 응답이고 좌표만 캐시에서 온다. 그래서 필터를 바꿔도 노드가 움직이지 않는다. 개요에 있고 `core`에 없는 노드는 국소 재배치로 놓는다.
- **브라우저는 zstd를 풀지 않는다.** `loupe serve`가 풀어서 넘긴다(10절). 계약 문구가 바뀌어도 이 경로는 같다.
- **백그라운드 레이아웃은 없다.** 그래프 화면을 열 때만 돈다.
- **시점을 바꿔도 좌표는 그대로다.** 레이아웃은 시간 기준을 키에 넣지 않는다. 시점 이동은 보임과 색만 바꾼다(`trends.md` M2). 현재 좌표가 없는 과거 노드는 국소 재배치로 놓는다.
- 이웃 확장도 같다. 기준 노드, 이웃, 새 노드로 부분 그래프를 만들고 기존 노드는 `fixed`로 묶어 worker에서 돌린다.
- 저장은 ID, x, y, community뿐이고 최근 5개만 남긴다. IndexedDB가 실패하면 다시 계산한다. 소프트 미스의 새 노드는 이웃의 다수 community를 받고 Louvain은 콜드에서만 돈다 [가정].
- 출처마다 IndexedDB가 따로라 tower 마운트로 처음 열면 한 번 다시 계산한다. 브라우저 프로필도 마찬가지다.

v1은 적중, 소프트 미스, 콜드 셋이다. 소프트 미스는 웜 스타트가 아니다. 기존 좌표를 움직이지 않는다. 임계값 90%는 변경 10%까지 기존 노드 이동이 작았다는 두 점에 기댄 판단이고 실제 게시로 다시 본다. 웜 스타트, 단계별 교체, 게시 간 색 유지는 12절 나중 항목이다.

**출구.** `loupe layout`은 아래 중 하나가 실제로 일어날 때 더한다. 같은 worker 모듈을 Node 26에서 돌려 결과를 loupe의 사용자 캐시 폴더에 쓰고 `loupe serve`가 정적 파일로 내주며, SPA는 IndexedDB를 보기 전에 그것을 확인한다. 손으로 부르는 명령으로 둔다. 라이브 탭 요청으로 서버 작업을 돌리지 않는다. 계약은 바뀌지 않는다. 디스크에 이름이 든 ID가 남으므로 ADR 결정 13을 고친다.

| 조건 | 왜 |
|---|---|
| 소프트 미스가 안 되는 콜드가 하루 1회를 넘는다 [가정] | 게시 빈도와 위상 변화율은 실제 KB에서만 안다 |
| `core`가 5만 노드를 넘는다 | 측정 범위 밖이다 |
| 출처와 프로필이 늘어 콜드 반복이 실제로 불편하다 | Node는 위상당 한 번만 계산한다 |

**Phase 2 착수 전 확인**

| 항목 | 상태 |
|---|---|
| 자체 worker 시간과 메인 스레드 rAF 영향 | 측정함 [측정: S5]. 실행마다 한 번 188~970 ms 끊김이 있다. 50k에서는 3회 모두 약 9.3 s 지점이고 원인은 미확인이다 |
| 좌표 교체 1회의 메인 스레드 비용 | graphology 적용 3~9 ms [측정: S5]. sigma 재인덱싱과 재렌더는 미측정이다. dim-all 281 ms 규모로 본다 [가정] |
| 렌더 재측정 | GPU가 조용할 때 `s5-scale/run-all.sh`로 fps, 20 ms 초과 프레임을 다시 잰다. gc 켠 heap을 함께 잰다 |
| 멀티그래프 렌더 | 평행 엣지와 방향을 넣은 예산. 미측정 |
| 소프트 미스 임계값 | 실제 게시의 위상 변화율. 미측정 |
| sigma 4 state-based style의 dim-all | 미검증 |
| `@react-sigma/core` 6.0.0 + 오버레이 | 미검증. 쓰지 않아도 된다 |

## 7. 데이터 층

### 7.1 Orval

```js
// tools/loupe/orval.config.mjs
export default { kb: {
  input: { target: process.env.KB_CONTRACT ?? './contract-sample/openapi.sample.yaml' },
  output: {
    mode: 'split', target: 'src/client/kb.ts', schemas: 'src/client/model', clean: true,
    client: 'react-query', httpClient: 'fetch', urlEncodeParameters: true,
    override: {
      mutator: { path: 'src/data/kbFetch.ts', name: 'kbFetch' },
      fetch: { includeHttpResponseReturnType: false },
      query: { useQuery: true, version: 5, useInfinite: true, useInfiniteQueryParam: 'cursor' },
    },
  },
} };
```

- `orval@8.46.0`을 정확히 고정한다. mutator는 필수다. 기본 클라이언트는 404를 성공으로 넘기고 선언된 오류 타입이 거짓이 된다 [측정].
- **경로 값 인코딩.** `urlEncodeParameters: true`가 경로 값을 `encodeURIComponent(String(id))`로 감싼다 [T: 8.46.0 생성물 확인]. 기본 생성물은 `/v1/nodes/${id}`이고 라우터가 `%2F` `%3F` `%23`을 풀어 주므로, 딥링크 하나가 KB 요청의 경로와 쿼리를 바꾼다. 측정 당시 `#/entity/ent_a%3Fas_of_valid%3D2020-01-01T00%3A00%3A00Z%23`은 시간 축 없이 과거 데이터를 그려 호박색 띠를 건너뛰고(완료 기준 3), `#/entity/..%2F..%2F..%2Fadmin%2Fstatus`는 `/admin/status`를 요청했다 [T: router 1.170.46, `new URL`로 계산한 최종 URL].
- **ID 모양.** KB ADR 7.5는 엔티티 ID를 `e:<type>:<slug>`로 정하고 공개 ID에 `/`, `?`, `#`, 공백, 제어 문자가 없다고 한다. 계약 예시는 아직 `e:<type>/<slug>`다. 다른 ID는 `c-`, `n-`, `r-`, `f-`, `s:`, `src:`, `t-`다. `:`가 들어 있고 패턴과 인코딩 규칙은 계약에 없다. 계약이 따라올 때까지 라우트 `params.parse`는 `/`와 `:`를 받고, `/`로 나눈 세그먼트 중 하나라도 `.`나 `..`이면 거부한다. 노드, 출처, `focus` 파라미터가 모두 이 규칙을 쓴다. `encodeURIComponent`는 `..`를 남기기 때문이다.
- **`/` ID는 경로 라우팅을 깼다(닫힘).** 처리기가 ID를 돌려주기만 하는 스탠드인에서 `{id}`는 `e:feature/hooks`에 404였고 `{id}`와 `{id:path}` 모두 `e:concept/history`를 `id=e:concept`의 history로 보냈다. 조회 처리기(`kbprobe_lookup.py`)로는 `e:concept`가 없어 404다 [측정·본문]. KB ADR 7.5가 `/`를 없애 닫았다. `raw_path` 라우팅은 다섯 사례가 모두 맞았다. Hono는 전부 맞으므로 kb-mock으로는 잡지 못한다 [측정·본문: `kb-contract/`]. loupe는 값을 한 세그먼트로 인코딩해 보낸다.
- **경로 이름.** 상세 경로는 `/node/<id>`다. 주장, 스냅샷, 기록, 시계열도 노드 타입이다(KB ADR 7.3). `/v1/nodes/{id}`가 그 ID에 모두 응답한다는 문장은 계약에 없다 [가정]. C 4장은 `/v1/claims/{id}`, `/v1/snapshots/{id}`, `/v1/series/{id}`를 따로 둔다(부록 B 2). 화면은 응답 `type`으로 나눈다. 스냅샷이면 `/source/<id>`로 `replace`한다. 화면 문구는 "엔티티"를 유지한다. 링크 소비자가 아직 없어 지금 바꾼다.
- X8의 출구는 Orval `schemas` 전용 모드나 Kubb `pluginTs`다. 검토가 S4의 "Orval에 타입 전용 모드 없음"을 뒤집었다.

### 7.2 `kbFetch`와 어댑터 경계

브라우저는 언제나 같은 출처의 상대 경로 `kb/`로 간다. KB에 CORS가 없고(C 7) 브라우저는 Unix 소켓에 닿지 못하므로 다른 길이 없다. 실제 KB 데이터에는 `loupe serve`가 필수다. 그 뒤가 무엇인지는 서버 쪽 `KB_URL` 하나로 정해지고 SPA는 바뀌지 않는다.

| 대상 | 서버 쪽 설정 | 비고 |
|---|---|---|
| KB Unix 소켓(기본) | `KB_URL=unix:/home/user/sagae-kb-data/run/read.sock` | 토큰 없음. 파일 권한으로 막는다 |
| kb-mock | `KB_URL=http://127.0.0.1:4811` | 소켓 경로 시험은 kb-mock을 Unix 소켓에 띄운다 |
| 나중에 TCP, Proxmox `[잠정]` | `KB_URL=http(s)://…`, `KB_TOKEN_FILE=…` | `viewer` 토큰 파일. `api-tokens`는 `owner`도 담으므로 읽지 않는다 |

X12는 닫혔다. KB가 소켓 활성화 HTTP를 직접 내고(C 1, KB ADR 16) 어댑터 서비스는 없다.

**`kb api` 대체 경로는 쓰지 않는다.** KB가 없으면 "KB 사용 불가"를 보인다.

- CLI만 되는 구간이 없다. `kb api`와 `kb serve`가 같은 패키지이고 유닛 없이 `kb serve --http --unix <경로>`가 돈다(KB 빌드 계획 WP-10). loupe는 코드를 바꾸지 않고 그 소켓에 붙는다.
- CLI는 `ETag`, `Retry-After`, `Content-Type`을 잃고 304를 쓸 수 없다. `/raw`와 export의 stdout 동작도 미정이다.
- URL에서 온 입력이 argv로 들어간다. 7.1절의 위협에 새 파서가 하나 더 생긴다.

| `kbFetch` 책임 | 내용 |
|---|---|
| 기준 경로 | `new URL('kb', document.baseURI).pathname` + 생성 경로를 **문자열로 잇는다**. S4 구현의 `new URL(url, base)`는 `/v1`로 시작하는 경로에서 마운트 접두어를 버린다 [측정·본문] |
| 2xx | 본문을 풀고 봉투(`schema_version`, `epoch`, `build_id`, `data_as_of`, `applied_seq`, `as_of`, `degraded`)를 메타 저장소에 넘긴다. `page`는 `data` 옆에 있다. 개요에는 `page`가 없고 `/raw`와 export에는 봉투가 없다 |
| 계약 오류 | RFC 9457 → `KbProblem`. `code`로 나눈다(C 2.3, 7.4절). 본문이 problem+json이 아니어도 깨지지 않는다. Starlette 기본 응답은 `text/plain`이다 [측정·본문] |
| 장애 | 네트워크 오류, 시간 초과, 502, 504 → `KbUnavailable`. 503은 KB의 응답이므로 `KbProblem`이다 |
| 시간 제한 | `AbortSignal.any`로 호출 측 signal과 합친다. 일반 8 s, 개요·export 30 s [가정]. 이 호스트의 닫힌 loopback 포트는 거절 대신 매달린다 [측정]. `mode=hybrid`는 쓰지 않는다. KB가 8 s까지 기다려(KB ADR 14.2) 이 제한과 같아진다 |
| 캐시 | 본문 호출(스냅샷 본문, 노드 상세)은 `cache: 'no-store'`. 개요와 변경 피드는 `cache: 'no-cache'`로 ETag를 재검증한다(C 2.5). KB ADR 1.3이 데이터 경로 `ETag`를 하나로 정했다. C 2.5가 따라오면 스키마와 `/v1/meta`에도 같은 재검증을 쓴다 |
| 인증 자리 | 브라우저는 토큰을 갖지 않는다. TCP일 때만 프록시가 넣는다 |
| 시험 | `transport` 교체로 kb-mock `app.request()`를 직접 부른다 |

### 7.3 봉투, 커서, 폴링

| 신호 | 동작 |
|---|---|
| `schema_version` major가 생성본과 다름 | 전체 차단 화면 |
| `schema_version` `0.x`의 minor가 다름 | 경고 칩. `0.x` 안에서는 깨질 수 있지만 필드 추가도 호환 변경이라(C 8) 차단하지 않는다 |
| `applied_seq` 증가 | 두 축이 고정되지 않은 쿼리를 무효화한다. 그래프는 자동 교체 없이 "새 데이터" 칩을 띄운다 |
| `epoch` 변경 | 쿼리 캐시와 피드 위치를 버린다. 피드는 처음부터 다시 읽는다 |
| `build_id` 변경 | 아무것도 하지 않는다. 재구축은 논리 상태를 바꾸지 않는다(C 2.6) |
| `data_as_of` | 상단 상태 표시, "지금으로 고정"의 값 |
| `degraded` | 아는 값만 칩으로 보인다. 모르는 값은 무시한다(C 2.1). `boot_path_unverified`는 KB WP-14 전까지 계속 뜬다(KB ADR 3장) |
| 400 `cursor_mismatch` | 1페이지부터 다시 읽고 알린다. 커서에 만료는 없다(C 4.12) |
| 410 `epoch_changed` | `epoch` 변경과 같다 |

- 커서는 불투명 문자열이다. 파싱하지 않고 URL에 넣지 않는다.
- 끝은 `page.next_cursor`가 `null`일 때다. S4 표본의 `has_more`는 없다.
- 무한 스크롤은 Orval `useInfinite`를 쓴다. 문자열 커서가 캐스트 없이 동작한다 [측정: S4]. 페이지를 합칠 때 `id`로 중복을 지운다.
- **컬럼 응답.** 개요, 이웃, export는 `columns`, `rows`다. 생성 타입이 도움이 적어 손으로 쓴 디코더가 열 이름으로 값을 찾는다. 열 순서를 가정하지 않고 모르는 열을 무시한다.
- **폴링.** `/v1/meta`를 45초마다 읽는다(L57의 30~60초). 숨긴 탭에서는 멈춘다. 이 호출이 연결 상태 확인도 겸한다. `/v1/changes`는 시작 위치가 없어 폴링에 쓰지 않는다(C 4.12, 부록 B). 폴링은 브라우저에서만 돈다. 서버 쪽 폴러는 KB 유휴 종료를 막는다. 보이는 탭 하나는 KB를 유휴 600 s 안쪽에 붙잡는다. KB가 예상한 동작이다(KB ADR 16). 콜드는 첫 열기와 탭을 600 s 넘게 숨긴 뒤에 든다.
- **조건부 GET.** 개요와 변경 피드는 `cache: 'no-cache'`로 브라우저 HTTP 캐시에 맡긴다. 클라이언트는 `If-None-Match`를 직접 넣지 않는다. 수동 304는 조사한 클라이언트가 모두 잘못 처리했다 [측정: S4]. 스크립트에 200으로 보인다는 것은 Fetch 표준을 읽은 내용이고 실제 브라우저로는 미검증이라 Phase 1 Playwright에 넣는다.

| TanStack Query 기본값 | 값 | 이유 |
|---|---|---|
| `networkMode` | `'always'` | `navigator.onLine`이 false여도 127.0.0.1은 닿는다 |
| `retry` | `KbProblem`은 0, `KbUnavailable`은 1. 503 `not_ready`는 `Retry-After`만큼 기다려 1회, 429는 `Retry-After`가 있으면 그만큼, 없으면 backoff | 이후는 연결 재시도가 맡는다 |
| `refetchOnWindowFocus` | false | 폴링이 맡는다 |
| 캐시 | 메모리 + HTTP 캐시. 본문 호출은 `no-store` | 민감도 라벨이 붙는 본문은 디스크 캐시에 남지 않는다. HTTP 캐시는 개요와 변경 피드만 쓴다 |

### 7.4 오프라인 상태

| 상태 | 판정 | 화면 | 회복 |
|---|---|---|---|
| KB 끊김 | `KbUnavailable` 연속 2회 | 빨간 띠: 마지막 성공 시각, 마지막 `data_as_of`. 캐시된 화면과 그래프 조작은 유지, 새 조회는 오류 카드 | 30초 재시도, 성공하면 무효화하고 띠를 내린다 |
| loupe 서버, WSL 정지 | 위와 구분되지 않는다 | 같은 띠에 "WSL이 멈췄을 수 있음"을 더한다. 새로고침하면 브라우저 오류 페이지다 | 같다 |
| 계약 불일치 | major 불일치 | 차단 화면에 받은 값과 지원 값 | 재생성 |
| 잘못된 URL | 시간 파싱 실패, 없는 경로 | 오류 화면 | 사용자 |

재구축은 소비자에게 보이지 않으므로(C 2.6) 별도 상태를 두지 않는다.

| 원인 | `loupe serve`가 보는 것 | 응답 | SPA 상태 |
|---|---|---|---|
| 유닛 미설치, KB 미기동 | `ENOENT` [측정·본문] | 502 `kb_socket_missing` | KB 사용 불가, 조치 안내 |
| 파일만 남고 리스너 없음 | `ECONNREFUSED` [측정·본문] | 502 `kb_socket_refused` | KB 멈춤 |
| 다른 UID(같은 UID의 mode 0000으로 대신 쟀다) | `EACCES` [측정·본문] | 502 `kb_socket_denied` | 설정 오류, 재시도 없음 |
| 유휴 종료 경합 | `ECONNRESET` [측정·본문] | 1회 재시도 | 없음 |
| 헤더 대기 초과 | 타이머 | 504 `kb_timeout` | 끊김으로 센다 |
| 시작 중 | 503 `not_ready` | 통과 | `Retry-After`만큼 대기, 띠 없음 |
| 읽기 상한 초과 | 503 `read_timeout` | 통과 | 카드 오류. 끊김이 아니다 |
| 혼잡 | 429 | 통과 | backoff |
| 토큰, Host | 401, 403 | 통과 | 설정 오류 |
| `degraded` 있음 | 200 | 통과 | 칩만 |
| `epoch` 변경 | 봉투 또는 410 | 통과 | 캐시 버림, 피드 초기화 |

v1은 service worker를 두지 않는다. 가용성이 WSL 세션 동안뿐이라는 결정과 맞고, 배포 캐시 문제를 만들지 않는다. 멈춘 WSL을 localhost 연결이 깨우지 않는다고 가정한다 [가정: brief 3절].

## 8. KB 게시 전 계약 처리 (X11)

KB `docs/contracts/`에는 산문 초안 `data-interface-v0.md`와 소비자 문서가 있고 `openapi.yaml`과 fixture는 아직 없다. `CLAUDE.md`는 사본을 원본처럼 두는 것을 금지한다.

**결정.** `packages/kb-contract`를 만들지 않는다. 임시 스키마의 소유자는 loupe이고 위치는 도구 안이며 이름에 표본임을 적는다. 표본의 출처는 S4 표본이 아니라 계약 v0 2~5장이다.

| 산출물 | 위치 | 소유 | 수명 |
|---|---|---|---|
| 표본 스펙 | `tools/loupe/contract-sample/openapi.sample.yaml` | loupe | T1에서 삭제 |
| 표본 fixture | `tools/loupe/contract-sample/fixtures/` | loupe | T2에서 KB fixture로 교체 |
| kb-mock | `tools/loupe/dev/kb-mock/` (Hono, 4811) | loupe, dev 전용 | 유지. Phase 0부터 C 2.3, 2.4, 2.5, 2.7, 2.9를 강제한다 |
| 생성 클라이언트 | `tools/loupe/src/client/` | 생성물 | 커밋한다. 입력 경로, 버전, sha256을 찍는다 |
| 계약 원본 | KB `docs/contracts/` | KB | 복사하지 않는다 |

**임시임을 드러내는 장치**

- `info.title`은 "KB read API (SAMPLE, not the KB contract)", 버전은 `0.0.0-sample`이다.
- `x-source`에 계약 파일 sha256을 적는다. 커밋이 없다.
- `[잠정]` 항목은 `x-provisional`을 단다. 계약이 말하지 않아 지어낸 값(`/v1/claims/{id}`, 이웃 열, `filter` 연산자, ID 인코딩)은 `x-guess`에 부록 B 번호를 적는다. 추측마다 질문이 하나 있다.
- 봉투의 `schema_version`이 표본이면 앱이 "표본 데이터" 배지를 고정 표시한다. 목 데이터를 실제로 오인하지 않게 한다.
- `npm run contract:guard`는 KB `docs/contracts/`에 OpenAPI 파일이 생기면 실패한다. 표본이 남아 있을 수 없게 한다.
- 표본은 Phase 0부터 계약의 경로를 모두 담는다. 계약 이름은 버릴 이름이 아니다. 버리는 것은 `x-guess`뿐이다.

**전환 트리거.** `openapi.yaml`과 서버 코드는 KB WP-10(파동 5), fixture는 WP-11(파동 6), 소켓 유닛은 WP-14(파동 6, 사용자 결정 3 뒤), 실제 데이터는 WP-21(파동 9)이다. 한 번의 게시가 아니라 세 사건이다.

| 트리거 | 할 일 |
|---|---|
| T1 `openapi.yaml`이 나온다 | `contract:guard`가 실패한다. `KB_CONTRACT`를 그 파일로 지정하고 표본 스펙과 폴백을 지운다. 다시 생성하고 표본과의 diff를 읽는다. 표본 fixture는 남겨 KB 스펙으로 검증한다. 생성물에 계약 버전과 해시를 찍는다 |
| T2 fixture가 나온다 | 우리 fixture를 KB 것으로 바꾼다. `consumer-kit/verify.mjs`는 복사하지 않고 제자리에서 돌린다(`CLAUDE.md`). `validate-fixtures`의 코드포인트 검사와 커버리지 검사는 유지한다 |
| T3 실제 KB가 뜬다 | 같은 Schemathesis 명령을 `http://127.0.0.1:4812/kb`로 돌린다. 프록시까지 덮는다. `/v1/ops/*`는 프록시가 막으므로 실행에서 제외한다. Host 검사는 프록시가 가리므로 `curl --unix-socket`으로 따로 본다. `/` ID와 `history` slug 사례를 돌린다 |

- `0.x`의 모든 변경마다 다시 생성하고 tsc를 돌리고 스펙 diff를 읽는다. `required` 완화는 tsc가 잡지 못한다 [측정: S4].
- KB가 표본보다 먼저 `openapi.yaml`을 내면 표본 스펙을 건너뛰고 Phase 0을 T1에서 시작한다. kb-mock과 표본 fixture만 임시로 남고 `x-guess`는 그때도 미정인 것만 남는다.
- 계약 9장은 타입 생성에 openapi-typescript를 적었다. loupe는 Orval을 유지한다(S4).

**다시 도는 S4 흐름.** fixture 검증(ajv 8.20.0) → Orval 생성 → tsc → 타입 클라이언트 → Schemathesis 4.32.7 시드 5개. 표본 위의 0 실패는 KB에 대해 아무것도 말하지 않는다. 스펙, fixture, mock의 저자가 같았다(검토). 도구 선택만 닫혔고 이 흐름은 T1부터 처음부터 다시 돈다. 다중 파일 `$ref`는 미검증이므로 단일 번들 파일을 요청한다. S4의 ajv discriminator 처방은 계약 3장에 `oneOf`가 없어 지금은 쓰지 않는다.

## 9. 수집 원문의 안전한 렌더링

KB의 수집 텍스트는 신뢰하지 않는 입력이다(`understand-kb-contract.md` 6절, C 7). 표시 본문은 NFC 고정 Markdown 또는 평문이고 HTML이 없다(C 4.11). 경로를 `text_format`으로 나눈다.

| 형식 | 기본 보기 | 인용 강조 | 처리 |
|---|---|---|---|
| `text_format=text`, `pdf_text`, `json` | `<pre>` 텍스트 노드 | 오프셋 정확 | React 텍스트 자식으로만 넣는다 |
| `text_format=markdown` | 본문 탭 + 렌더 탭 | 본문 탭 정확, 렌더 탭 없음 | `remark-parse` → `remark-gfm` → `remark-rehype`(raw HTML 끔) → `rehype-sanitize` → Shiki → `hast-util-to-jsx-runtime` |
| 모르는 `text_format` | 평문과 같다 | 평문과 같다 | KB ADR 7.7의 네 값(`markdown`, `text`, `json`, `pdf_text`) 밖은 열린 값으로 다룬다 [가정] |
| 원본(`/raw`) | 메타데이터와 내려받기만 | 없음 | 화면에 렌더하지 않는다. PDF도 첫 판은 렌더하지 않는다 |

**sanitize 규칙**

- GitHub 스키마에서 시작해 좁힌다. `img`, `picture`, `video`, `audio`, `iframe`, `object`, `embed`, `link`, `style`, `script`, `form`, `base`, `meta`와 `style` 속성을 지운다.
- `href` 프로토콜은 `http`, `https`만 허용한다.
- `id`, `name`의 `user-content-` 접두어를 유지해 DOM clobbering을 막는다.
- 이미지는 `[이미지: alt, host]` 글자로 바꾼다. 원격 요청이 나가지 않는다.
- sanitize 뒤에는 신뢰하는 변환만 둔다. Shiki는 `shiki/core` + JS 정규식 엔진, 지연 언어 로드, worker로 돌린다. WASM이 없어 CSP를 넓히지 않는다.

**iframe은 첫 판에 없다.** 위 경로가 스크립트 없는 React 트리를 만들므로 필요가 없다. 원본 모양이 꼭 필요해지면 다음 조건으로만 넣는다.

- `<iframe sandbox="" srcdoc=…>`. `allow-scripts`와 `allow-same-origin`을 주지 않는다.
- 내용은 같은 파서와 sanitize를 거치고 `style`만 더 허용한다.
- `srcdoc` 머리에 `default-src 'none'; style-src 'unsafe-inline'; img-src data:` CSP를 넣는다.
- 강조는 하지 않는다. `frame-src` 설정은 그때 실측한다. WARC 재생은 계획에 없다.

**다른 출력 경로**

| 경로 | 규칙 |
|---|---|
| React 전체 | `dangerouslySetInnerHTML`, `innerHTML` 금지(ESLint). 예외 없음 |
| 그래프 라벨 | Canvas `fillText`라 HTML이 아니다 |
| ECharts | 툴팁은 `format.encodeHTML`을 거치는 함수 포매터만 쓴다. 기본 포매터 금지. 옵션은 빌더 하나로만 만든다 |
| 검색 스니펫 | 코드포인트 오프셋(`highlight_unit`)으로 React `<mark>`를 만든다. KB의 HTML 조각을 받지 않는다 |
| 외부 링크 | `http`, `https`만. `target="_blank"`, `rel="noopener noreferrer"`, `referrerPolicy="no-referrer"`. 호스트를 글자로 보여 주고 미리보기를 가져오지 않는다 |

**원격 자원 금지.** 시스템 글꼴만 쓰고 CDN이 없다. 빌드 때 `index.html`에 meta CSP를 넣으므로 어떤 정적 서버에서도 적용된다.

```text
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self';
base-uri 'none'; form-action 'none'
```

- `connect-src 'self'`는 `kb/` 동일 출처 구조 덕분에 가능하다. `fetch`를 통한 유출은 막지만 `location` 이동은 막지 못한다. 방어선은 sanitize다.
- **문서 단위 보호.** meta CSP는 `index.html`에만 있다. 캡처된 `text/html`이 `/kb/*` 응답으로 내비게이션에 열리면 이 출처에서 스크립트가 돌고 `fetch('/kb/…')`로 본문을 읽었다 [T: 헤드리스 Windows Edge, 다른 사이트가 `location`을 `/kb/rawhtml`로 보냄. 내비게이션에는 Origin이 없어 Host와 Origin 검사를 통과했다]. `Content-Security-Policy: default-src 'none'; sandbox`를 붙이면 로드는 되지만 스크립트가 돌지 않고 읽히는 것도 없었다. `/raw`가 원 `Content-Type`을 그대로 내므로(C 4.11) 이 헤더는 예방이 아니라 필수다. `loupe serve`가 `/kb/*`에 이 헤더와 `nosniff`를 붙인다(10절). `fetch`는 둘 다 무시하므로 SPA는 영향이 없다.
- 스타일의 `'unsafe-inline'`은 일부 UI 라이브러리의 `<style>` 때문에 허용한다. 실행 경로가 아니고 `img-src`가 외부 전송을 막는다.
- dev 서버는 Vite 인라인 때문에 CSP를 넣지 않는다. Playwright는 빌드 산출물로 돈다.
- `frame-ancestors`는 meta로 안 되므로 `loupe serve`가 헤더로 보낸다.

## 10. 전달

**pixel-wt 선례를 따른다.** 127.0.0.1 서버, systemd user 유닛, Orca 탭이다. Windows 쪽 브라우저에서 미러 네트워킹으로 닿는 것은 확인됐다(`understand-verification.md`). 단 뷰어는 worktree당이 아니라 전역 하나다.

| 방식 | 제공자 | URL | 용도 |
|---|---|---|---|
| 개발 | Vite 4810(`/kb`를 4811로 프록시), kb-mock 4811, 둘 다 127.0.0.1 | `http://127.0.0.1:4810/` | 개발, Phase 1 |
| 설치본 | `loupe.socket`, `loupe.service` | `http://127.0.0.1:4812/` | 기본 사용 |
| tower 마운트 | tower proxy 라우트 → 4812 | `http://127.0.0.1:4800/loupe/` | 선택 |

4812를 따로 두는 이유는 설치본의 소켓이 포트를 쥐고 있어도 dev 서버를 띄울 수 있어야 해서다. 개발 중 실제 KB를 볼 때는 Vite의 `/kb`를 kb-mock 대신 `loupe serve`로 돌린다.

**마운트 무관 빌드.** Vite `base: './'`와 TanStack Router `createHashHistory`를 쓴다 [소스]. 문서 URL이 마운트 루트 하나뿐이므로 상대 자산 경로가 깨지지 않고, SPA 폴백도 `<base>` 재작성도 경로별 재빌드도 필요 없다. path 라우팅이면 깊은 경로에서 상대 자산이 깨져 마운트마다 빌드가 갈린다. 비용은 URL의 `#`과 본문 안 앵커 링크를 직접 처리하는 것이다. 앵커는 클릭을 가로채 `scrollIntoView`로 이동한다.

**`loupe` CLI** (`tools/loupe/bin/loupe.mjs`)

| 명령 | 동작 |
|---|---|
| `loupe open [경로]` | `orca-ide tab list --worktree all`로 같은 URL을 찾고, 없으면 `tab create --url <url> --worktree active` |
| `loupe serve` | 포그라운드 서버. 유닛의 `ExecStart`와 같은 코드 |
| `loupe status` | 소켓 파일을 확인하고 `/v1/meta`를 읽어 `schema_version`, `epoch`, `applied_seq`, `data_as_of`, `degraded`를 출력한다. 손으로 부르는 명령이라 KB를 깨워도 된다 |

- `ORCA_CLI_COMMAND`를 따르고 기본값은 `orca-ide`다. stdin은 닫는다. `orca-ide`가 stdin을 삼킨다(`understand-ecosystem.md` 2절).
- `--worktree`를 항상 넘긴다. 생략하면 다른 worktree에 열린 사례가 있다(S3).
- Orca가 없으면 URL만 출력한다. `#`, `&`가 든 딥링크가 PowerShell 브리지를 통과하는지는 Phase 5에서 확인한다.

**`loupe serve`.** Hono와 `@hono/node-server`로 만든 약 120줄 서버다 [추정]. 실제 KB 데이터에 필수다(7.2절). 유닛 설치는 `ops/systemd/`의 파일을 사용자가 직접 `systemctl --user link`로 건다(전역 설정 변경). `node tools/loupe/server/serve.ts`로 빌드 없이 돈다.

| 경로 | 동작 |
|---|---|
| 전체 | 127.0.0.1 바인딩. 아래 검사를 SDK 없이 직접 쓴다(약 8줄). Host나 Origin의 hostname이 `localhost` `127.0.0.1` `[::1]`이 아니면 403. `sec-fetch-site`가 `cross-site`나 `same-site`이고 `sec-fetch-mode`가 `navigate`가 아니면 403 [T: 교차 사이트 `no-cors` 요청은 Origin 없이 도착했다]. `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `frame-ancestors 'none'`. 요청 경로와 쿼리를 기록하지 않는다(`?q=`에 검색어가 있다) |
| `/` | `dist/` 정적 파일. `index.html`은 `no-cache`, 해시 자산은 `immutable`. 점(`.`)으로 시작하는 세그먼트는 404 |
| `/kb/*` | `KB_URL`로 프록시. **GET, HEAD만** 통과한다. 경로는 loupe가 부르는 `/kb/v1/…` 허용 목록만 받는다. `/v1/ops/*`는 막는다. 요청 헤더는 허용 목록(`Accept`, `Accept-Encoding`, `If-None-Match`)이고 브라우저의 `Host`는 넘기지 않는다. 응답 헤더는 `ETag`, `Retry-After`, `Cache-Control`, `Content-Type`, `Content-Encoding`, `Content-Length`만 통과시키고 **`Content-Security-Policy: default-src 'none'; sandbox`와 `X-Content-Type-Options: nosniff`를 붙인다**. `/raw`에는 `Content-Disposition: attachment`를 더한다. 실패는 502 problem+json이다(7.4절) |
| `/healthz` | 프로세스 생존만 본다. KB를 건드리지 않는다 |

| 프록시 항목 | 규칙 | 근거 |
|---|---|---|
| 클라이언트 | `node:http`. Unix 소켓은 `socketPath`로 붙는다 | C 1 예시. `unix:` 문자열은 `URL`로 파싱된다 [측정·본문] |
| 대상 경로 | `c.req.raw.url`에서 잘라 문자열로 잇는다 | `c.req.path`는 한글을 풀고 `node:http`가 `ERR_UNESCAPED_CHARACTERS`를 던진다 [측정·본문] |
| `Host` | 지정하지 않는다 | Node 기본값 `localhost`가 KB 허용 목록을 통과한다 [측정·본문] |
| 연결 풀 | `agent: false`. GET, HEAD는 끊기면 1회 재시도한다 | 서버가 끊은 풀 연결은 `ECONNRESET`, `reusedSocket=true`다 [측정·본문]. uvicorn keep-alive와 유휴 종료가 둘 다 만든다 |
| 시간 제한 | TCP 연결 1 s. 소켓에는 해당 없다. 첫 바이트 7 s [가정], 본문 제한 없음, 클라이언트 중단 전파 | KB 읽기 상한 5 s 위, `kbFetch` 8 s 아래 |
| export | `/v1/export/graph`는 `zlib.createZstdDecompress()`로 풀어 `application/json`으로 낸다. `Content-Encoding`, `Content-Length`를 지운다 | 브라우저 `DecompressionStream`에 zstd가 없다 [측정: S5]. 계약의 `Content-Encoding: zstd`나 `Content-Type: application/zstd` 어느 쪽이든 `node:http`로 받아 같은 바이트를 냈다 [측정·본문: `zstdproxy.mjs`] |

S2 규칙을 따른다: `createAdaptorServer` + `listen({fd:3})`, `LISTEN_FDS`와 `LISTEN_PID` 확인, 소켓이 없으면 `127.0.0.1:4812`로 폴백. TCP 연결 시간 제한은 검토의 "모든 설계는 짧은 connect timeout이 필요하다"에서 왔다.

**유닛** (`ops/systemd/`, 내용은 S2 값)

| 파일 | 값 |
|---|---|
| `loupe.socket` | `ListenStream=127.0.0.1:4812`, `NoDelay=true`, `WantedBy=sockets.target` |
| `loupe.service` | `Requires=loupe.socket`, `After=loupe.socket`, `StartLimitIntervalSec=0`, `Type=simple`, `WorkingDirectory=`와 `ExecStart=`는 절대 경로(node를 직접 exec), `Environment=KB_URL=unix:/home/user/sagae-kb-data/run/read.sock`, `Environment=NODE_COMPILE_CACHE=%C/loupe/compile-cache`, `Restart=always`, `RestartSec=1`, `TimeoutStopSec=8` |

idle exit는 없다. 정확한 유닛 파일은 아직 실행하지 않았다. nvm을 올리면 `ExecStart` 경로가 바뀐다. TCP로 옮겨 토큰이 필요해지면 `Environment=`에 적지 않는다. 유닛 파일이 저장소에 있으므로 `KB_TOKEN_FILE`이 가리키는 mode 600 파일에서 `viewer` 토큰을 읽는다.

**노출 범위.** 4812의 `/kb/*`는 무인증 읽기다. Windows 같은 사용자는 WSL root와 같아 막지 않는다 [T: mode 600 파일을 읽었고 `wsl.exe -u root -- id -u`가 0]. 다른 Windows 계정과 host network 컨테이너가 닿는지는 측정하지 않았다 [가정]. KB는 소켓을 0600으로 막고 루프백 TCP에는 토큰을 요구한다. 미러 네트워킹에서 Windows에 루프백이 보이기 때문이다(C 7). `loupe serve`는 그 소켓을 토큰 없는 4812로 다시 연다. 지금은 `first_party_open=false`라 외부 데이터만 지나간다. `first_party_open=true`가 되면 `sensitivity` 기본값 `internal`의 기록이 기본 읽기로 흐른다(C 6.1, 2.7). 그 전에 사용자가 정한다(tower 12절 #5). `/v1/ops/*`는 허용 목록에서 빠져 있다. 브라우저용 토큰이나 쿠키는 두지 않는다. 로컬 프로세스가 `/`에서 그대로 가져간다.

**tower 선택 마운트.** 코드 의존이 없다.

- loupe는 tower를 import하지 않고 `dist/`는 tower를 모른다. tower 설정에도 loupe 코드가 없다.
- tower 쪽 일반 설정 한 항목으로 표현한다: `{ "path": "/loupe", "proxy": "http://127.0.0.1:4812" }`. tower는 `/loupe` 접두어를 떼고 전달하고 `/loupe`를 `/loupe/`로 301한다(tower 2절). 상대 경로 해석이 이 리디렉션에 기댄다.
- `kbFetch`의 `/loupe/kb/…`는 접두어가 떨어져 `loupe serve`의 `/kb/…`에 닿는다. 정적 파일, `kb/` 프록시, 보안 헤더는 전부 `loupe serve`가 맡는다. tower가 지나보내는 응답 헤더를 지우지 않는다.
- loupe 소켓이 포트를 쥐고 있어 tower 쪽 첫 요청이 loupe를 깨운다. loupe가 없으면 그 라우트만 502이고 tower는 영향이 없다. 설치본은 tower와 무관하다.
- loupe는 마운트 경로를 모른다. 자산과 `kb/`는 `document.baseURI`로 푼다(7.2절).

**딥링크.** 경로 표(3절)가 공개 인터페이스다. `${LOUPE_URL}/#/node/<id>?as_of_valid=…` 모양이고 `loupe open`이 같은 경로를 연다. KB 카드에는 링크 칸이 없으므로(KB ADR 15.2) 카드의 ID로 만든다. 경로를 바꾸면 옛 경로의 리디렉션을 남긴다. ID 쪽 변경은 `merged_into`가 흡수한다. 도구 결과나 수집된 페이지의 링크도 이 인터페이스로 들어오므로 ID는 신뢰하지 않는 입력이다. 라우트가 세그먼트의 `.`와 `..`를 거부하고 `kbFetch`가 인코딩한다(7.1절). 링크를 만드는 쪽은 `encodeURIComponent`로 ID를 넣는다.

## 11. 시험

| 층 | 도구 | 검사 |
|---|---|---|
| 타입 | tsc 5.9.3, Vitest `expectTypeOf`, S4 `assertions.ts` 이식 | `asOf` 축 이름 변경, 커서, 오류 타입 |
| 단위 | Vitest | 시간 파싱, 시간 제외 집합, 인용 확인 1, 2단계, 코드포인트↔UTF-16, 창 오프셋, NFC, 라벨 선택과 K, URL 왕복, 병합 추적, 열 디코더, 위상 해시, 딥링크 ID(`%3F` `%23` `%2F` 인코딩, `/`와 `:` 허용, 세그먼트의 `.`와 `..` 거부) |
| 통합 | Vitest + kb-mock `app.request()` | 봉투 처리, 무한 페이지, `cursor_mismatch`, `epoch_changed`, 404, 502, 503, 429, 시간 초과, `applied_seq` 변경 무효화. `loupe serve`는 Unix 소켓 kb-mock으로 소켓 없음, 거절, 권한 거부, 재사용 연결 끊김, 한글 경로, zstd 해제를 본다 |
| 계약 | 8절 흐름 | 고의 버그 대조군(`KB_MOCK_BUG`)을 유지한다. 시드별 케이스 수를 단언하지 않는다. 시드가 고정해 주지 않는다 [측정] |
| 화면 | Playwright 1.64.1, headless, 빌드 산출물 | 아래 표 |
| 성능 | Orca 실제 GPU, S3 벤치 이식 | 아래 표. 수동 실행 |

**fixture 커버리지.** 소비자 문서 L75의 대체 체인, 소급 정정, dead, 병합, 한글 본문, 인용 위치에 다음을 더한다: 인용 앞의 astral 문자, 찾지 못하는 인용, 병합 순환, `truncated: true`, 악성 HTML과 Markdown, ECharts 툴팁 페이로드, `/kb/*`가 `text/html`로 돌려주는 캡처 응답, 양방향 관계, `/`가 든 ID, slug가 `history`와 `neighbors`인 엔티티, `jsonpointer` 근거, 창을 넘는 인용, C 2.9 제외 경로의 400, `epoch_changed`, `first_party_open` 양쪽 값, `predicate=null` 주장, 평행 엣지.

| Playwright 검사 | 판정 |
|---|---|
| 시간 전파 | 딥링크로 시작한 여정에서 시간을 받는 오퍼레이션의 KB 요청 전부에 두 축이 있고, C 2.9 제외 경로에는 없다. 새로고침 뒤에도 띠가 남는다 |
| 인용 강조 | `CSS.highlights`의 Range 문자열이 `exact`와 같다. 찾지 못함이면 강조 0건 |
| 악성 원문 | 스크립트 미실행, 대화상자 없음 |
| 원격 자원 | 모든 요청이 동일 출처다. CSP 위반 이벤트 0건 |
| 병합 | URL이 생존 ID로 바뀌고 시간 기준이 남는다 |
| 조건부 GET | 개요 재요청에 서버가 304를 내고 스크립트는 본문을 받는다. 본문 호출은 `no-store`이고 디스크 캐시 항목이 없다 |
| 딥링크 주입 | `#/node/e%3Afeature%2Fa%3Fas_of_valid%3D2020-01-01T00%3A00%3A00Z%23`, `#/source/n-1%2F..%2F..%2Fnodes%2Fe%3Afeature%2Fb`, `#/node/..%2F..%2F..%2Fv1%2Fops%2Fmetrics`가 오류 화면이나 "없거나 볼 수 없음"을 내고 KB 요청의 경로와 쿼리를 바꾸지 않는다 |
| 문서 내비게이션 | `/kb/*`의 HTML fixture로 이동해도 스크립트가 실행되지 않는다. 응답 헤더에 CSP `sandbox`와 `nosniff`가 있다 |
| 교차 사이트 요청 | `sec-fetch-site: cross-site`의 `no-cors` 요청과 `Host: evil.example`은 403. 링크 이동(`navigate`)은 통과한다 |
| 오프라인 | kb-mock을 내리면 시간 제한 안에 띠가 뜨고 되살리면 내려간다 |

WSL에는 Playwright 브라우저와 한글 글꼴이 없다. 브라우저는 스파이크처럼 설치하고 `@fontsource/noto-sans-kr`를 시험에서만 쓴다. SwiftShader는 기능 확인 전용이고 성능 수치로 쓰지 않는다. 한글 IME는 Orca에서 손으로 확인한다.

**성능 예산.** 기본 개요 상한(10k/51k), 기준 환경은 S3 주 환경이다. 2만 보기와 5만은 예산 밖이다(6.1절). fps는 vsync 천장에 붙어 순위를 못 가리므로(검토) 프레임 시간과 초과 프레임으로 본다. `strokeText` 손실은 rAF 간격에서만 드러나므로 JS 타이머를 예산으로 쓰지 않는다.

| 지표 | 측정 | 예산 |
|---|---|---|
| 10초 경로 20 ms 초과 프레임 | 0 | 0 |
| rAF p95 | 6.1 ms(null rAF와 같다) | null rAF + 1 ms |
| CPU+GPU p50/p95 | 3.8/5.3, 3.5/5.0 ms | p95 8 ms 이하 |
| 오버레이 JS p95 | 0.7 ms | K=200에서 1.5 ms 이하 |
| 첫 프레임, 재방문 | 621, 478 ms | 800 ms 이하 |
| 호버 p95 | 26.4, 20.5 ms | 30 ms 이하 |
| 클릭 dim-all p95 | 323 ms | 350 ms 이하 |
| heap, 로드 후 | 63 MB + 점선 18 MB, 합산 추정 | 100 MB 이하 |
| 번들, sigma + graphology | 118.6 KB gz | 130 KB gz 이하, 그래프 경로로 지연 로드 |
| 상세·이웃·검색 p95, 개요(웜) | 측정 없음. 소비자 문서 목표 200 ms, 2 s | 같은 값. 실제 KB에서만 판정 |
| 콜드, KB 유휴 종료 뒤 첫 요청 | 웜 + p50 약 150 ms(C 1, 프로토타입). p95 미상 | 별도 행. 이때 상세가 200 ms를 넘을 수 있다 |
| 프록시 오버헤드, tower 경유 | 측정 없음 | 실제 KB에서 잰다 |

**미측정으로 남는 것**

- **처음 여는 페이지 로드.** S3 값은 셰이더 캐시가 데워진 뒤의 것이다. 빈 프로필의 첫 로드는 재지 않았다. Phase 2에서 새 프로필로 잰다.
- S5 렌더 행의 fps, rAF, 20 ms 초과 프레임, gc 켠 heap(6.2절). 레이아웃 시간과 메인 스레드 영향은 S5가 쟀다.
- readPixels는 WebGL만 비우므로 오버레이 래스터 비용은 CPU+GPU 값 밖이다(검토).
- 실제 KB 규모와 페이로드. KB 추정은 1년차 개요 기본 프로필 노드 2만~5만, 엣지 5만~20만이다(C 12). 실측은 1차 수집 뒤다.
- Orca 자동화에서 탐색 직후 첫 rAF가 11~100초 넘게 멈춘 현상(S3). 실제 사용에서 나는지 Phase 2에서 본다. 벤치는 탭을 보이게 두고 iframe 방식을 쓴다.

## 12. 구축 순서

| Phase | 내용 | 완료 조건 | KB 필요 |
|---|---|---|---|
| 사전 | 부록 B를 KB 세션에 보낸다. `openapi.yaml` 전이 가장 싸다 | 회신 수신 | 세션 |
| 0 뼈대 | `tools/loupe` 워크스페이스, Vite, Router(hash), Query, shadcn. 계약 v0 모양의 표본 스펙, fixture, kb-mock, Orval, `kbFetch`, `asOf`와 시간 제외 목록, 계약 형식 ID, 계약 흐름 이식. 최소 `loupe serve` `/kb/*`(Phase 5에서 당겼다) | S4 흐름 통과, 빈 앱이 Unix 소켓 kb-mock을 `loupe serve` 너머로 읽는다 | 없음 |
| 1 탐색 | 팔레트, 엔티티 페이지, 관계 패널(나가는 링크, 들어오는 링크), 주장 카드, 출처 화면, 인용 확인(일치, 위치 보정), 시간 띠, 병합 리디렉션, 조건부 GET 확인, `/v1/meta` 폴링과 오류 상태, `/v1/schema` 라벨 | 아래 참조 | 없음 |
| 2 그래프 | 6.2절 확인 항목, 개요, 오버레이, worker, IndexedDB, 소프트 미스, 이웃 확장 | 합성 10k/51k 멀티그래프에서 11절 예산 통과, 첫 로드 측정. 착수 전에 S5 렌더를 다시 잰다 | 없음 |
| 3 표와 검색 | 스키마 구동 표, 패싯, URL 저장 뷰, 전문검색 화면, 스키마 화면 | 표본 카탈로그로 타입 추가가 코드 변경 없이 된다. `filter` UI는 KB 답을 기다린다 | `filter` 문법 |
| 4 시간 깊이 | 이력(ECharts), 변경 피드 | 11절 Playwright 전체 통과. 변경 화면은 꼬리 읽기를 기다린다 | 꼬리 읽기 |
| 5 설치 | 유닛, CLI, 딥링크, tower 마운트 확인 | 소켓 기동으로 Orca 탭 열림, tower 없이 동작 | 없음 |
| 전환 | 8절 T1, T2, T3. KB 사건이 트리거이고 Phase와 무관하다 | 실제 서버에 Schemathesis 통과, 표본 삭제 | 계약 |
| 나중 | 건강 프리셋, 시간 지도, 계층 커뮤니티, HTML iframe, PDF, Gephi Lite 내보내기, `loupe layout` | 요구가 생기면. `loupe layout`은 6.2절 출구 조건 | 일부 |
| 나중 | 인용 유사 일치: 실제 KB에서 "찾지 못함" 비율을 잰 뒤 | 그 비율이 높을 때 | 실제 데이터 |
| 나중 | 레이아웃 웜 스타트, 단계별 교체, 게시 간 색 유지(6.2절 근거 두 점) | 콜드가 실제로 불편할 때 | 게시 빈도 |

**Phase 1은 kb-mock만으로 쓸모가 있어야 한다.** S4 fixture(엔티티 5, 주장 7, 스냅샷 1)는 작다. 이 저장소 `docs/research/*.md`를 스냅샷으로 넣어 도구, 버전, 측정을 엔티티와 주장으로 옮긴 fixture를 만든다(규모 약 50 엔티티, 200 주장, 20 스냅샷, 양방향 관계). 실제 한글 본문과 실제 인용구가 생기고 지금까지의 조사를 주장과 원문으로 탐색할 수 있다. 소급 정정 사례도 있다. 검증 보고서가 조사 보고서를 뒤집은 항목이다.

Phase 1 완료 조건은 다음과 같다.

1. Orca 탭에서 팔레트 → 엔티티 → 관계로 다른 엔티티 → 들어오는 링크로 복귀 → 주장 → 인용 원문 → 과거 시점 왕복이 끊김 없이 된다.
2. 그 경로의 모든 URL이 새 탭에서 같은 화면을 재현한다.
3. 사용자가 IA를 판단할 수 있고, 그 결과로 소비자 문서 확정본을 KB에 보낼 수 있다. 계약 질문은 이 시점을 기다리지 않고 사전 단계에서 보낸다.

## 부록 A. 브리프 충돌의 처리

| # | 결론 |
|---|---|
| X5 | tower에 뷰어 전용 백엔드도 정적 서빙도 없다. 마운트는 `loupe serve`로 가는 일반 proxy 라우트 하나이고 선택이다 |
| X7 | 6.2절 |
| X8 | Orval 8.46.0 유지. 도구 선택만 닫혔고 흐름은 게시 때 다시 돈다. 경쟁 도구의 TS 7 충돌은 현재 실패가 아니라 앞으로의 위험이다(검토) |
| X9 | 닫힘. Datasette를 두지 않는다. KB는 SQLite 사본을 게시하지 않는다(C 1) |
| X10 | NFC 정규화만. 초성 타입어헤드 없음 |
| X11 | 8절 |
| X12 | 닫힘. KB가 소켓 활성화 HTTP를 직접 낸다. 어댑터는 없다(7.2절) |
| X14 | 포트는 결정됐다. KB 경로는 Unix 소켓이 기본이고 `kb/` 접두어와 `KB_URL` 한 곳에서 흡수한다 |

## 부록 B. KB 계약에 넣을 요청

계약 v0 대조로 다시 썼다. 모두 요청이고 어느 것도 결정이 아니다. 막는 순서로 적었다. 이전 판의 2(적용 시간 되돌림), 3(커서 오류), 5(오프셋 단위와 한글 fixture)는 계약이 충족했다. 8(브라우저 직독 export), 12(시간 구간 개수 미사용), 대체 사유, `value_type`은 이 문서 안의 부록 B 항목이었고 KB가 받은 요청이 아니다. 계약 초안을 그대로 받아들인다.

| # | 요청 | 계약 | 왜 |
|---|---|---|---|
| 1 | 공개 ID 형식을 계약에 옮긴다 | 2.10, 4장, KB ADR 7.5 | ADR이 닫았고 계약 예시가 남았다 |
| 2 | `/v1/claims/{id}`, `/v1/edges/{id}`의 절. 두 경로와 `/v1/meta`를 빌드 계획 2.3의 `kb.read` 표에 올린다. `/v1/nodes/{id}`가 `c-`, `n-`, `f-`, `s:` ID에도 응답하는지와 그 모양을 적는다 | 4장 표, 4.1 | meta는 폴링, claims는 출처 화면, edges는 선택한 사실 투영 엣지의 `claim_id`(4.3)에 쓴다. `/node/<id>` 경로가 `/v1/nodes/{id}`의 응답에 기댄다 |
| 3 | 엔티티별 주장 페이지, 엔티티·술어별 이력 | 4.5, 4.7 | `claim_limit`은 기본 50만 있고 최대값, 정렬, 커서가 없어 주장이 많은 엔티티를 끝까지 읽는 방법이 정해져 있지 않다. `/history`는 객체 단위다 |
| 4 | 변경 피드 꼬리 읽기, `origin` 파라미터, manifest 이어받기 커서 | 4.12, 5장 | 처음부터만 읽힌다. 5장의 증분 이어받기가 시작할 수 없다 |
| 5 | 엣지 `status`를 개요, 이웃, export 열에 더한다 | 4.3, 4.6, 5장 | 대체 엣지 점선과 dead 숨김 |
| 6 | `/history`의 as-of 동작, 2.9 문장 정합 | 2.9, KB ADR 7.4 | ADR이 기본 유효축을 정했다. 계약 문장과 `/history`가 남았다 |
| 7 | 검색 항목의 `kind`별 모양, `subject`, `passage`의 `snapshot_id`와 오프셋, 접두어 일치 여부 | 4.8 | 팔레트와 검색 화면 |
| 8 | `filter` 연산자, 복수 필터, `sort` 방향, 기본 정렬, `source`, `author` 파라미터 | 4.2, 4.4, 4장 | 표 화면 |
| 9 | `/raw`의 `Content-Disposition: attachment`, 본문 응답의 `Cache-Control: no-store`, schema·meta·export의 ETag | 2.5, 4.11 | 원본 HTML은 열린 출처에서 실행될 수 있다(9절). 민감도 라벨이 붙는 본문이 디스크 캐시에 남지 않게 한다 |
| 10 | `citing_claims`와 스냅샷 ETag. ADR 정의로 풀린다. 스냅샷 메타데이터가 데이터 경로인지만 확인한다 | 2.5, 4.11, KB ADR 1.3 | 늘어나는 필드가 불변 경로에 있다 |
| 11 | `core` 구성: 상태·병합 포함 규칙, `Series`, `sha256` 기준, `g-`와 `p-`의 관계, 첫 게시 전 응답 | 5장 | 레이아웃의 유일한 전체 입력이다 |
| 12 | `include=body` 필드, `backlinks` 모양, `edges`의 반대쪽 라벨과 상한, 이웃의 열과 `truncated` 위치, `/text` 단위와 창 메타데이터 | 4.5, 4.6, 4.11, 6.3 | 노드 상세, 이웃, 출처 화면 |
| 13 | 응답 `status`가 `eff_status`인지, 닫힌 enum 목록, `Evidence.id` 안정성 | 2.7, 2.10, 3장 | 모르는 값 처리와 `ev=` 링크 |
| 14 | 소켓 민감도 범위를 `internal` 이하로 고정, Host 거부 400 대 403 | 1장, 2.3, 2.8, 7장 | 소켓을 `owner`로 보면 4812로 `private`가 샌다. `TrustedHostMiddleware`는 400 `text/plain`이다 [측정·본문] |
| 15 | `load.py`를 추정 규모로 올리고 콜드 p95를 낸다 | 4장, WP-10 | 11절 지연 예산 |
| 16 | 모르는 쿼리 파라미터 거부 | 2.3 | 봉투 `as_of`는 시간 축만 덮는다 |
| 17 | `oneOf`마다 `const` 또는 전체 mapping, examples, 단일 번들 파일, 구현 전 `openapi.yaml` 초안 | 3장, 9장 | S4 스트레스 결과. 소비자 문서 L124 |
| 18 | KB MCP 카드의 `origin`, `sensitivity` 표시 | KB ADR 15.2 | 카드에 민감도 칸이 없다. 숨김 해제 인자가 없는 것은 충족이다 |
| 19 | 일괄 읽기 `ids=` | 4.5 | 최근 항목 라벨. 없으면 개수를 줄인다 |
| 20 | 예시 정정: 4.8 `{21,26}`, 4.5 주장의 `label`, `edges.out` 항목 | 3장, 4.5, 4.8 | 표본을 예시에서 옮긴다 |

## 부록 C. 미결

| 항목 | 영향 | 다음 행동 |
|---|---|---|
| 실제 규모 | 6.1절 규모 경계, `core` 크기 | KB 추정은 2만~5만이다. 1차 수집 뒤 실측한다 |
| 게시 빈도, 위상 변화율 | 소프트 미스 임계값, `loupe layout` 필요 여부 | KB 적재가 돌면 측정 |
| S5 렌더 재측정 | 기본 개요 상한, 2만 보기 | GPU가 조용할 때 `s5-scale/run-all.sh` |
| KB 소켓 유닛 | 실제 데이터 경로. KB ADR 23장 결정 3에 달렸다 | 승인 전에는 `kb serve --http --unix`로 시험한다 |
| 무인증 읽기로 first_party 본문이 나가도 되는가 | 4812와 tower 마운트의 노출(10절) | 사용자 결정(tower 12절 #5). `first_party_open=true` 전에 정한다. LXC 이전 때 다시 본다 |
| first_party 표시 | Notion식 페이지의 깊이 | 페이지 수준 링크는 C 6.3으로 정해졌다. `include=body` 필드를 기다린다 |
| 수집 원문의 보존 조건(YouTube 정책, 개인 식별 필드) | 표시 범위 | 실제 출처가 정해지면 확인 |
| Orca에서 `target="_blank"` 동작 | 외부 링크 경험 | Phase 1에서 확인 |
| 다크 테마 | 오버레이 배경색 | 라이트 먼저. 토큰만 열어 둔다 |

**계약 초안과 KB 감사에 달린 것.** KB ADR은 최종 감사를 반영해 갱신 중이고 계약은 아직 따라오지 않았다. 아래는 지금 이름대로 설계했지만 바뀔 수 있다. `KB ADR`로 적은 행은 ADR이 정했고 계약 반영이 남은 것이다. 나머지 감사 항목은 `sagae-knowloge-base/docs/design/audit-final-contract.md`의 제안이고 결정이 아니다. 계약이 바뀌면 그때 반영한다.

| 항목 | 출처 | 바뀌면 손댈 곳 |
|---|---|---|
| 엔티티 ID 형식 | KB ADR 7.5가 `e:<type>:<slug>`로 정했다. 계약 예시는 아직 `/`다 | `params.parse`, fixture, 레이아웃 캐시 무효화. 인코딩은 그대로다 |
| 개요 상한과 기본 타입 | 13장 협의 중. KB ADR 16이 기본 상한을 5만/20만과 커서로 올렸다 | 6.1절. loupe는 `limit`, `edge_limit`을 명시한다 |
| export 전송과 `core` 구성 | 5장 협의 중. CTR-12 | 위상 해시 입력. 프록시 해제는 두 표기 모두 처리한다 |
| 기본 유효축 | KB ADR 7.4가 닫았다. 계약 반영 대기 | 4절 표, 5절 상태 표 |
| ETag 정의 | KB ADR 1.3이 CTR-08을 반영했다. 계약 대기 | 7.2, 7.3절 |
| 변경 피드 커서 | CTR-09 | 머리 커서가 생기면 폴링을 `/v1/changes`로 옮길 수 있다 |
| 페이지 사이 중복 | CTR-10 | 7.3절의 `id` 중복 제거를 유지한다 |
| 소켓 민감도와 `private` 읽기 | KB ADR 23장 결정 14. 기본은 (c)이고 사용자 결정 전이다 | 5절 민감도, 10절 노출. loupe v1은 `private`를 보지 않는다 |
| 429 상한 | 2.3 `[잠정]` | `retry`, "전체 확인" 동시성 |
| `total=null` | 2.4 `[잠정]` | 3절 표 메모 |
| TCP 8737, Proxmox 주소 | 1장 `[잠정]` | 7.2절 표 |
| `/v1/ops/*` | 4.13 `[잠정]` | 프록시 허용 목록. v1은 쓰지 않는다 |
| 블록 수준 링크, `POST /v1/commands`, 과거 시점 전체 입력 | 6장, 2.9 `[잠정]` | 없음. v1은 쓰지 않는다 |

## 검토 반영

위협 검토 15건, 요구사항 검토 17건, KB 계약 v0 대조, S5 측정 중 이 문서에 해당하는 것을 반영했다. 받아들이지 않은 것과 형태를 바꾼 것만 적는다.

| 검토 | 처리 | 이유 |
|---|---|---|
| 위협, `/kb/*` 응답 헤더를 tower `responseHeaders`에도 주입 | 형태 변경 | tower에서 `static`과 `responseHeaders`를 지웠다(요구사항 검토). 헤더는 `loupe serve`가 붙이고 tower 프록시가 통과시킨다. tower 마운트 경로에서도 같은 응답이 나간다 |
| 위협, tower 라우트 깊이를 두 세그먼트로 | 거절 | 요구사항 검토의 해법(마운트 = 프록시 라우트 하나)으로 같은 문제를 푼다 |
| 요구사항, 서버 쪽 `kb/` 라우트를 tower가 맡는 표현 삭제 | 수용 | 10절 마운트 항목을 한 항목으로 고쳤다 |
| 요구사항, 유사 일치와 웜 스타트 삭제 | 수용 | 측정 근거는 남기고 12절 나중 항목으로 옮겼다 |
| 위협 검토가 기각한 브라우저 토큰과 쿠키 | 도입하지 않음 | 로컬 프로세스가 `/`에서 가져갈 수 있어 경계가 아니다 |
| S5, `core`가 2만 노드를 넘으면 Node `loupe layout`을 쓴다 | 형태 변경 | 권고의 근거는 `(build_id, scope)` 키와 "5분마다 빌드"였다. 계약에서 5분은 게시 간격이고 봉투의 `build_id`는 그때 바뀌지 않는다. 키를 위상 해시로 바꾸고 소프트 미스를 넣으면 남는 콜드는 출처·프로필당 한 번이고 Node 이득은 8~9%다. 6.2절의 출구 조건으로 옮겼다 |
| 계약 대조, 레이아웃을 `loupe serve`로(C안) | 채택하지 않음 | 위와 같다. 비용 표는 6.2절이다 |
| 계약 대조, 브라우저의 zstd 해제를 측정 항목으로 | 불필요 | 프록시가 풀어 준다 [측정·본문]. 브라우저 동작에 기대지 않는다 |
| 계약 대조, `/v1/edges/{id}`로 엣지 상태를 메운다 | 거절 | 엣지마다 호출할 수 없다. 열을 요청한다 |
