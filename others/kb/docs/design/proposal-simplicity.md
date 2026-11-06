# 정보 저장소 전체 설계안: 단순성·운영성 관점

- 작성일: 2026-10-31
- 관점: 움직이는 부품이 가장 적고, 혼자 운영해도 무너지지 않는 구성. 같은 입력으로 다른 관점의 안이 함께 작성되고 있으므로 이 관점을 끝까지 밀었다.
- 성격: 시스템 설계 문서다(CLAUDE.md "지침 5 적용 기준"의 설계 문서 예외). 지식 데이터가 아니다.
- 표기: `[P번호]`는 이 설계를 위해 잰 값이고 부록 A에 있다. 그 밖의 근거는 `docs/research/` 보고서 이름과 그 안의 실측 ID로 적었다. `추정`과 `미측정`은 그렇게 표시했다.
- 측정 한계: `[P]` 수치는 전부 공용 16 GB tmpfs 위 값이고 fsync 비용이 빠져 있다. 측정 시 부하 평균은 약 40까지 올랐다.

## 0. 요약

**파일 트리 하나, SQLite 파일 하나, 쓰기 함수 하나, 타이머 두 개, 상주 프로세스 0개.**

이 안을 다른 안과 가르는 결정은 여섯 가지다.

1. **진실은 `raw/` 하나뿐이다.** 원본 바이트, 파서 산출물, LLM 추출 결과, 사용자 기록을 모두 내용 주소 파일과 추가 전용 저널로 둔다. SQLite는 언제든 버리고 저널 재생으로 다시 만드는 캐시다. 9.4만 행 재구축 1.25초, 46.8만 행 9.88초였고 내용 지문이 일치했다 [P1].
2. **모든 쓰기는 `changeset` 한 형식, `apply_changeset` 한 함수를 지난다.** 결정적 파서, LLM 추출, 세션 쓰기, 파일 입력이 같은 경로다. 덕분에 버전 표, 변경 로그, 멱등 키 표가 저널 하나와 양시간 버전 행으로 합쳐진다.
3. **타이머는 심장 박동이고 스케줄은 데이터다.** systemd 타이머는 15분 박동 하나뿐이고, 무엇이 밀렸는지는 `source.next_check_at`이 정한다. 꺼져 있던 시간이 얼마든 다음 박동이 그대로 따라잡는다. `Persistent=` 스탬프에 기대지 않는다 [P9].
4. **상주 프로세스가 없다.** 조회는 호출마다 뜨는 CLI, 세션마다 뜨는 MCP stdio, 소켓 활성화 HTTP로 처리한다. 셋 다 표준 라이브러리 코어 하나를 공유한다.
5. **LLM은 도구 없는 순수 함수로만 부른다.** 스케줄 추출 에이전트는 도구가 0개이고, 저장 워크플로우도 0개다. 오케스트레이션은 Python 반복문이 맡는다. 이 한 결정으로 rtk 권한 충돌과 10분 대기 상한은 스케줄 경로에서 사라지고, 프롬프트 주입 면적과 exit 코드 오판 여지는 크게 준다.
6. **순위를 섞지 않는다.** 검색은 RRF 없이 `hits`, `lexical`, `related` 슬롯으로 나눠 돌려준다. 강한 Dense에 BM25를 섞으면 유의하게 나빠진다는 실측(`retrieval-serving.md` 5.3)을 구조로 받은 결과다. 튜닝할 값 자체가 없다.

| 부품 | 수 |
|---|---:|
| 상주 프로세스 | 0 |
| 저장 엔진 | SQLite 1개 + 파일 CAS |
| 쓰기 경로 | 1 |
| 파이썬 런타임 | 1(3단계에 ML용 1개 추가) |
| systemd 유닛 | 6(타이머 2, oneshot 2, 소켓·서비스 2). 3단계에 2 추가 |
| 필수 외부 서비스 | 0(권장 2: healthchecks.io, 머신 밖 백업 대상) |
| 저장 워크플로우 | 0 |
| 에이전트 정의 | 4 |
| MCP 도구 | 7 |
| 직접 작성 코드 | 약 3,100줄(19장) |

이 안이 치르는 대가는 22장에 숨기지 않고 적었다. dlt와 WARC를 쓰지 않으므로 어댑터 코드를 직접 소유한다. 머신이 꺼진 동안의 공백은 막지 않고 기록만 한다. 깊은 그래프 순회는 API에서 깊이 2로 자른다. 각 항목에 전환 조건을 숫자로 두었다.

## 1. 단순성 규칙

설계 전체에 적용한 규칙이다. 뒤의 모든 선택은 여기서 나온다.

| # | 규칙 | 적용 |
|---|---|---|
| S1 | 재구축할 수 있는 것은 백업하지 않는다 | DB와 색인은 백업 대상이 아니다. 백업 대상은 `raw/` 하나다 |
| S2 | 한 가지 일을 두 경로로 하지 않는다 | 쓰기 1경로, 스케줄 1표, 판정 1규칙표 |
| S3 | 마이그레이션 코드를 쓰지 않는다 | 스키마 변경은 새 DDL로 재구축 후 세대 교체다 [P3] |
| S4 | 상태를 프로세스 메모리에 두지 않는다 | 연결은 호출마다 연다. 큐, 재시도, 스케줄은 전부 DB 행이다 |
| S5 | 실패는 데이터로 남기고 다음 박동이 처리한다 | 재시도 데몬 없음. 백오프는 `next_check_at`의 값이다 |
| S6 | 기능보다 탈출구를 먼저 둔다 | 모든 생략에 재도입 조건을 숫자로 적는다(22장) |
| S7 | 도구를 뺄 수 있으면 뺀다 | 에이전트에 도구를 주지 않는 것이 가장 강한 권한 설계다 |
| S8 | 한 가지 검증으로 두 요구를 잡는다 | 재구축 지문 비교가 R2와 R16의 복원 훈련을 함께 검증한다 |

## 2. 전체 구성

```
                        sources/*.yaml (소스 선언, git)
                                 │ 동기화
 ┌─ kb-tick.timer 15분 ─────────▼──────────────────────────────┐
 │ kb tick (LLM 비용 0)                                          │
 │  due 계산 → fetch → CAS 저장 → 구조 가드 → L1 파서 → changeset ─┐
 └───────────────────────────────────────────────────────────────┘ │
 ┌─ kb-agent.timer 1시간 ──────────────────────────────────────┐ │
 │ kb agent (claude -p, 도구 0개, 예산 상한)                      │ │
 │  queue → 구간 분할 → 구조화 출력 → 인용 게이트 → changeset ────┤
 └───────────────────────────────────────────────────────────────┘ │
   MCP kb_write ─┐                                                 │
   CLI kb write ─┼─ first_party changeset ──────────────────────────┤
   inbox/*.md  ──┘                                                 ▼
                                                     apply_changeset()
                        ┌──────────────────────────────────────────┴────┐
                        ▼ ①                                          ▼ ②
          raw/ (진실. 불변)                         db/gen-N/kb.sqlite (캐시)
          objects/<sha256>.zst                      journal + node + edge + obs + fts
          journal/YYYY-MM.ndjson                            │
                  │                                         │ WAL 읽기
                  ├─ restic → /mnt/c, 머신 밖               ├─ kb CLI (호출마다)
                  └─ first_party Markdown → git push        ├─ MCP stdio (세션마다)
                                                            ├─ HTTP /v1 (소켓 활성화)
                                                            └─ 벡터 서비스(소켓 활성화, 선택)
```

쓰기 순서는 항상 ① CAS에 changeset을 쓴다, ② 한 SQLite 트랜잭션에서 저널 행과 상태를 함께 커밋한다, ③ 저널 줄을 `raw/journal/`에 덧붙인다. ②와 ③ 사이에 죽으면 다음 박동이 `seq`를 비교해 메운다. ①과 ② 사이에 죽으면 고아 객체가 남을 뿐이고 재시도는 같은 키로 멱등하다.

## 3. 계층별 기술 선택과 근거

| 층 | 선택 | 근거 |
|---|---|---|
| 원시 보존 | 파일 CAS(sha256, zstd-3) + 추가 전용 저널 NDJSON | 객체 CAS + zstd로 시뮬레이션 675 MB → 10.3 MB, 파일별 zstd는 105 MB (`compression.md` 8.4) |
| 그래프 저장 | SQLite ≥ 3.51.3, WAL, 단일 파일 | 시험한 임베디드 엔진 5종 중 두 번째 쓰기 프로세스를 기본 설정에서 받은 것은 SQLite뿐이다. 293,241건 무손실 (`general-db.md` M3) |
| 런타임 | uv 관리형 CPython 3.14.x, venv 1개 | SQLite 3.53.1, `compression.zstd` 표준 포함, 137 MB, 전 의존성 휠 설치 성공 [P5] |
| 전문검색 | FTS5 무콘텐츠 + 문자 bigram + 앱 스니펫 | Kiwi와 통계적으로 구분되지 않음(0.470/0.923/0.595 대 0.487/0.932/0.593), RSS 14 MB 대 523 MB (`retrieval-serving.md` 5.1) |
| 벡터 | NumPy 메모리 맵 전수 스캔, 필요할 때 뜨는 서비스 | NumPy 2만 건 1.0 ms, 10만 건 6.4 ms 대 sqlite-vec 36.3 ms, 90.3 ms (`retrieval-serving.md` 5.6) |
| 그래프 순회 | 코드 BFS, 깊이 ≤ 2 | 계약의 이웃은 깊이 1~2다. 허브 깊이 2 p95 0.77 ms [P1] |
| 스케줄 | systemd user timer 2개 + DB의 `next_check_at` | 추가 상주 0. 오케스트레이터 유휴 PSS 179~951 MB (`etl-orchestration.md` 3.3) |
| 사망 감지 | healthchecks.io 체크 3개(tick, agent, verify), 본문 `OK` 확인 | 머신 밖에서 침묵 감지. 존재하지 않는 UUID에도 200을 주므로 본문을 본다 (`etl-orchestration.md` 5.5) |
| LLM 추출 | `claude -p --tools "" --json-schema` | 호출당 5~7초, 인용구 원문 일치 5/5 (`prior-art.md` T7. 문서 1개 표본) |
| 다른 세션 반환 | 플러그인 + MCP stdio(FastMCP) | 데몬 없음. 콜드 0.68~0.89초, PSS 86 MB, 도구 7개 `tools/list` 5,463 B [P6] |
| 소비자 API | Starlette + uvicorn, systemd 소켓 활성화 | 콜드 p50 150 ms, 웜 2.3 ms, 유휴 메모리 0 (`general-db.md` M9). 의존성은 FastMCP가 이미 포함한다 |
| 수집 HTTP | 표준 `urllib` + 조건부 GET | 실제 피드 6개 CPU 1.0초, RSS 60 MB, 재실행 CPU 0.08초 [P8] |
| 본문 추출 | Trafilatura, feedparser, yt-dlp | 정적 추출 0.05~0.68초 (`etl-orchestration.md` 4.2) |
| 백업 | restic(`raw/` 전체) + git(first_party Markdown) | 복원·변조 탐지 실측 (`general-db.md` M21, M23) |
| 계약 | OpenAPI 3.1 + JSON Schema 2020-12, Schemathesis, oasdiff | Schemathesis가 프로토타입의 실제 버그 1건과 계약 불일치 3건을 찾았다 (`general-db.md` M18) |
| 압축 | rtk(허용 목록 훅), trail(코드맵만), zstd | 17장 |

**런타임을 시스템 Python으로 두지 않는 이유.** 시스템 Python 3.14.4에도 FTS5, JSONB, zstd가 다 있어서 처음에는 무의존 실행을 노렸다. 그러나 번들 SQLite가 3.46.1이다. SQLite 공식 문서는 WAL-reset 버그가 3.7.0부터 3.51.2까지 있고 3.51.3(및 백포트 3.44.6, 3.50.7)에서 고쳐졌다고 적는다. 조건은 "두 연결이 별도 스레드나 프로세스에서 같은 순간 쓰기 또는 체크포인트"다. 문서는 재현이 어렵고 긴급하지 않다고 적지만, 이 설계는 그 조건을 매일 만든다. 따라서 `connect()`는 `sqlite_version_info >= (3, 51, 3)`이 아니면 쓰기 연결을 거부한다. 경로를 잘못 잡은 스크립트가 낡은 SQLite로 쓰는 사고를 한 줄로 막는다. 설치된 `libsqlite3-0 3.46.1-9ubuntu0.3`의 패키지 변경 이력에는 WAL 관련 수정 항목이 없다.

## 4. 일부러 쓰지 않는 것

조사 보고서가 후보로 올린 것 중 뺀 항목이다. 뺀 이유와 다시 넣을 조건을 함께 적는다. 조건의 숫자는 판단 기준을 고정하기 위한 초기값이고 측정값이 아니다.

| 도구 | 뺀 이유 | 재도입 조건 |
|---|---|---|
| **dlt** | 이 설계의 적재 대상은 소스별 표가 아니라 범용 그래프다. dlt가 주는 멱등 병합, 커서, 재개를 `INSERT`, 소스 표, 저널이 이미 준다. 반면 SQLite 목적지는 `upsert` 미지원에 `merge`가 delete-insert이고, poison 패키지가 무관한 리소스를 막으며, pending이 있으면 새 추출을 건너뛰고, 리소스 하나의 실패가 소스 전체를 멈춘다 (`etl-orchestration.md` 7.2). dlt 단독 실행은 소스 11개, 2,631행 작업에 CPU 1.5초, RSS 160 MB였다. 이 안의 tick은 소스 6개에 1회차 CPU 1.0초, RSS 60 MB, 재실행 CPU 0.08초, RSS 31 MB였다 [P8]. 작업이 달라 직접 비교는 아니다 | 표 형태 API 소스가 15개를 넘고 어댑터 스키마 변경이 월 2회를 넘을 때 해당 소스만 |
| **WARC, wacz** | 재수집 중복 제거에 revisit 레코드와 CDX 색인이 필요하다. CAS는 `open(path)` 하나로 원본 보기가 끝난다. `capture_http`의 import 순서 함정도 없다 | 외부 아카이브와 교환이 필요할 때 CAS와 저널에서 내보낸다 |
| **DuckDB, Parquet** | 쓰기 중 타 프로세스 읽기 거부, 읽기 연결이 쓰기를 막음, dlt 버전 묶임 (`etl-orchestration.md` 7.3). 시계열은 `obs` 표로 충분하다 | `obs`가 1억 행을 넘거나 분석 질의 p95가 1초를 넘을 때 파생 Parquet 추가 |
| **LadybugDB, FalkorDB** | 다중 프로세스 미지원, 저장 안정성 이슈, 기본값 유실 (`graph-store.md` 7장) | 22장. 재구축 가능한 읽기 투영으로만 |
| **임베디드 PostgreSQL** | 다중 쓰기가 필요한 부하가 아니다. 8세션 10쌍/s에서 SQLite p99 25.9 ms (`general-db.md` M2) | 22장 |
| **GitHub Actions** | 두 번째 실행 환경, 두 번째 비밀 값, 합치기 경로가 생긴다. 러너 IP 응답도 미확인이다 | 핵심 소스 공백이 월 2회 이상 복구 불가로 기록될 때 |
| **Kiwi** | 읽기 경로에 523 MB. 품질 이득이 통계적으로 없다 | 평가 집합에서 nDCG 0.03 이상 이득이 재현될 때 |
| **sqlite-vec** | 코드 푸시가 5개월 정체, v1 이전, 전수 검색에서 NumPy보다 10배 이상 느림 | 벡터가 DB 트랜잭션과 묶여야 할 이유가 생길 때 |
| **재순위화** | 상승폭 +0.03에 VRAM 0.5~1 GB, CPU 1.2초, `max_length` 함정(0.974 → 0.929) | 평가 집합에서 +0.05 이상이고 GPU가 상시 가능할 때 |
| **저장 워크플로우** | 15장. Python 반복문으로 충분하고 대기 상한, 허용 규칙, exit 판정, 에이전트당 토큰 16,883~29,787이 따라온다 (`harness.md` 3.7) | 에이전트끼리 결과를 교차 검증해야 하는 작업이 생길 때 |
| **Playwright, Crawl4AI** | Chromium 라이브러리에 sudo가 필요하고, Crawl4AI는 679 MB에 CVE 이력이 있다 | 브라우저 필요 표시가 붙은 핵심 소스가 5개를 넘을 때 |
| **Docling** | torch 전제, PDF 경로 미측정 | PDF 소스가 주요 공백이 될 때 |
| **Litestream** | 상주 프로세스 PSS 34.8 MB. R13과 충돌 | 허용 RPO가 1분 미만으로 정해질 때 |
| **GBrain, Graphiti, Basic Memory 등 프레임워크** | 통째로 맞는 후보가 없다 (`prior-art.md` 1장). 쓰기마다 LLM을 부르거나 표면이 크다 | 없음. 스키마와 대체 규칙만 참고했다 |
| **Windows 작업 스케줄러** | 기본 구성에서는 불필요. WSL을 쓰는 동안 타이머가 돈다 | 사용자가 "PC는 켜졌고 WSL은 닫힌 시간"의 수집을 원할 때(23장) |

## 5. 디렉터리 구조

코드와 데이터를 분리한다. `git clean -fdx` 한 번이 데이터를 지우는 사고를 구조로 막기 위해서다.

```
sagae-knowloge-base/                 git. 코드, 선언, 문서
├── CLAUDE.md
├── pyproject.toml, uv.lock
├── kb/
│   ├── core/        store.py gate.py read.py rebuild.py   # 표준 라이브러리만
│   ├── ingest/      tick.py inbox.py adapters/*.py
│   ├── agent/       run.py
│   ├── live/        signals.py rules.py
│   ├── ops/         backup.py metrics.py retro.py
│   ├── embed/       service.py build.py                   # 3단계
│   ├── cli.py  mcp_server.py  http_api.py
├── schema/
│   ├── ddl.sql  changeset.schema.json  predicates.yaml
│   ├── types/*.json                                       # JSON Schema 2020-12
│   └── agent/*.json                                       # 에이전트 출력 스키마
├── sources/         a-keywords.yaml … f-dev.yaml g-*.yaml internal.yaml
├── agents/          extract.md research.md review.md retro.md
├── .claude/
│   └── settings.json                                      # rtk 훅, env, deny
├── .mcp.json                                              # trail 코드맵만
├── ops/
│   ├── systemd/     kb-tick.{timer,service} kb-agent.{timer,service} kb-read.{socket,service}
│   ├── hooks/       rtk-guard.sh
│   ├── job-settings.json  install.sh
│   └── windows/     kb-wake.xml                           # 선택
├── plugin/          .claude-plugin/plugin.json .mcp.json skills/kb/SKILL.md
├── tests/           golden/ contract/ fixtures/
└── docs/            research/ design/ contracts/ adr/ retro/

~/kb-data/                           ext4. KB_HOME. git 밖. /tmp, /mnt/c 금지
├── raw/                             진실. 백업 대상은 여기뿐
│   ├── objects/ab/cd/<sha256>.zst
│   └── journal/2026-10.ndjson
├── db/
│   ├── CURRENT                      세대 포인터
│   ├── gen-0003/kb.sqlite           재구축 가능
│   └── ops.sqlite                   운영 상태. 잃어도 재생성
├── index/                           벡터. 버려도 됨
├── publish/                         스냅샷 export
├── inbox/                           사람이 쓰는 Markdown 입력
├── export/first_party/              결정적 Markdown, 별도 git 저장소
├── runtime/                         python, uv, restic
└── run/                             잠금, 마지막 실행 스트림
```

런타임 설치는 `uv python install 3.14 --no-bin --install-dir ~/kb-data/runtime/python`로 한다. `--no-bin`이 없으면 `~/.local/bin`에 링크가 생긴다. 이번 실측에서 실제로 생겨 지웠다(부록 B).

`.gitignore`에는 `/graft/`, `/.state/`, `/.venv/`를 미리 넣는다.

## 6. 데이터 모델

### 6.1 물리 표

표는 지식 쪽 8개, 운영 쪽 4개다.

```sql
-- db/gen-N/kb.sqlite : 전부 저널 재생으로 재구축된다
CREATE TABLE journal(seq INTEGER PRIMARY KEY, at INT NOT NULL, actor TEXT NOT NULL,
  on_behalf_of TEXT, generated_by TEXT, kind TEXT NOT NULL,
  idem_key TEXT UNIQUE NOT NULL, sha TEXT NOT NULL, n INT NOT NULL);

CREATE TABLE node(vid INTEGER PRIMARY KEY, id TEXT NOT NULL, version INT NOT NULL,
  type TEXT NOT NULL, origin TEXT NOT NULL,          -- external | first_party
  status TEXT NOT NULL,                              -- active | superseded | dead
  status_detail TEXT,                                -- renamed, deprecated, partial 등
  verification TEXT,                                 -- verified | unverified | first_party | derived
  sensitivity INT NOT NULL,                          -- 0 public 1 internal 2 private 3 secret
  label TEXT NOT NULL, body TEXT, body_format TEXT, lang TEXT, props BLOB,  -- JSONB
  content_sha TEXT NOT NULL, author TEXT, merged_into TEXT,
  valid_from INT, valid_to INT, recorded_at INT NOT NULL, expired_at INT,
  seq INT NOT NULL, UNIQUE(id, version));
CREATE INDEX node_cur  ON node(id) WHERE expired_at IS NULL;
CREATE INDEX node_type ON node(type, status, vid) WHERE expired_at IS NULL;
CREATE INDEX node_seq  ON node(seq);

CREATE TABLE edge(vid INTEGER PRIMARY KEY, id TEXT NOT NULL, version INT NOT NULL,
  src TEXT NOT NULL, rtype TEXT NOT NULL, dst TEXT NOT NULL, props BLOB,
  status TEXT NOT NULL, sensitivity INT NOT NULL,
  valid_from INT, valid_to INT, recorded_at INT NOT NULL, expired_at INT,
  seq INT NOT NULL, UNIQUE(id, version));
CREATE INDEX edge_src ON edge(src, rtype) WHERE expired_at IS NULL;
CREATE INDEX edge_dst ON edge(dst, rtype) WHERE expired_at IS NULL;
CREATE INDEX edge_seq ON edge(seq);

CREATE TABLE obs(subject TEXT, metric TEXT, observed_at INT, value_num REAL, value_text TEXT,
  unit TEXT, snapshot TEXT, seq INT, PRIMARY KEY(subject, metric, observed_at, snapshot)) WITHOUT ROWID;
CREATE TABLE chunk(rid INTEGER PRIMARY KEY, node_id TEXT, text_sha TEXT, start_cp INT, end_cp INT);
CREATE VIRTUAL TABLE fts USING fts5(tok, content='', contentless_delete=1,
  tokenize="unicode61 remove_diacritics 0");   -- rowid는 node.vid 또는 chunk.rid + 2^40
CREATE TABLE alias(norm TEXT PRIMARY KEY, node_id TEXT NOT NULL) WITHOUT ROWID;  -- 이름 해석
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;                     -- 펜스, 스키마 버전

-- db/ops.sqlite : 운영 상태. 세대 교체 대상이 아니다
source(id, class, kind, url, enabled, tos, trust, cadence_s, max_age_s, next_check_at, last_ok_at,
       last_change_at, fail_count, state, etag, last_modified, last_sha, shape, fallback)
queue(id, kind, ref, state, attempts, not_before, lease_until, last_error, created_at)  -- state=dead가 DLQ
run(id, job, started_at, ended_at, status, detail_json)
metric(run_id, key, value)
```

`general-db.md` 프로토타입의 `node + node_version + change_log + idem` 네 표가 여기서는 `journal + node` 두 표가 된다.

| 프로토타입의 구성 | 이 안 |
|---|---|
| 현재 표 + 버전 표 | 한 표의 버전 행. 현재는 `expired_at IS NULL` 부분 색인 |
| 변경 로그 + 트리거 | `WHERE seq > ?`. 버전 행 자체가 피드다. 커서 만료와 압축이 없다 |
| 멱등 키 표 | `journal.idem_key` |
| 검색 as-of 별도 구현 | FTS가 짧은 타입의 전 버전을 색인하고, 시간 조건은 조인 술어 하나로 처리 |

이 통합으로 `general-db.md`가 미해결로 남긴 "검색과 개요의 as-of"가 풀린다. 현재 검색과 as-of 검색의 p95가 9.6 ms, 9.5 ms로 같았다 [P1]. 패싯 병목이던 출처 호스트 집계(같은 보고서 5.2)는 `props`의 VIRTUAL 생성 열과 색인으로 둔다(미측정).

SQLite는 작성자가 한 번에 하나이므로 `seq` 순서가 곧 커밋 순서다. PostgreSQL에서 재현된 "낮은 번호가 늦게 커밋되어 피드가 행을 놓치는" 문제(`general-db.md` M4)가 여기서는 생기지 않는다.

### 6.2 노드와 엣지

타입은 열린 문자열이다. `schema/types/*.json`은 아는 속성만 검증하고 `additionalProperties: true`를 유지한다.

| 묶음 | 노드 타입 | 비고 |
|---|---|---|
| 엔티티 | `Tool Repo Package Feature Model Org Platform Channel Video Keyword Metric Topic` | id는 `e:<type>/<slug>` |
| 출처 | `Source Snapshot Item` | `Source`는 URL 정체성, `Snapshot`은 불변 내용, `Item`은 피드 항목 |
| 주장 | `Claim` | 사실 한 건. id는 `c:<12hex>` |
| 사용자 생산 | `Note Decision Artifact` | `origin=first_party`. 타입 없는 입력의 기본값은 `Note` |
| 운영 | `Request Review` | 요청 티켓과 사람 판단 대기 |

주장을 엣지 속성이 아니라 노드로 둔다. 관계 하나에 불변 ID, 상태, 버전, 대체 체인, 근거 여러 개, 전문검색이 모두 필요하기 때문이다. 노드로 올리면 그 코드를 한 벌만 쓰면 된다. `graph-store.md` 6장의 관찰과도 맞는다. 개요 응답은 기본적으로 `Claim`을 뺀다.

| 엣지 타입 | 방향 | 뜻 |
|---|---|---|
| `ABOUT`, `OBJECT` | Claim → 엔티티 | 주어, 목적어 |
| `EVIDENCED_BY` | Claim → Snapshot | 근거. `props`에 인용구와 위치 |
| `SNAPSHOT_OF`, `PUBLISHED_BY` | Snapshot → Source → Org | 출처 사슬 |
| `SUPERSEDES` | 새것 → 옛것 | 대체 체인 |
| `DEPENDS_ON` | 기법 주장 → Feature | 기능이 죽으면 재검사 대상을 찾는 끈 |
| `RENAMED_TO`, `MERGED_INTO` | 옛것 → 새것 | 이동, 병합 |
| `LINKS_TO`, `PART_OF`, `MENTIONS`, `SUGGESTS` | | 구조 관계 |
| `RESOLVED_BY`, `REQUESTED_BY` | Request → | 티켓 연결 |

술어 어휘는 `schema/predicates.yaml`에서 관리한다. 어휘에 없는 주장은 `states` 술어로 받고 자동 대체 대상에서 뺀다.

이름 해석은 사전이나 형태소 분석 없이 처리한다. NFKC, casefold, 공백 제거로 만든 정규형을 `alias` 표에서 찾고, 없으면 새 엔티티를 만든다. `extract`에는 해당 구간의 FTS 상위 후보 이름을 함께 주어 기존 이름을 쓰게 한다. 중복이 남으면 `Review`를 거쳐 `merged_into`로 합친다.

### 6.3 시간축

| 필드 | 뜻 | 값의 출처 |
|---|---|---|
| `valid_from`, `valid_to` | 세계에서 참인 구간 | 출처 문구, 없으면 게시일 |
| `recorded_at`, `expired_at` | KB가 그 값을 알고 있던 구간. 계약의 관측 시점 | 저널 시각 |
| `Snapshot.props.fetched_at` | 원문을 본 시각 | 수집기 |

모든 읽기는 술어 하나를 공유한다.

```sql
valid_from <= :v AND (valid_to IS NULL OR valid_to > :v)
AND recorded_at <= :o AND (expired_at IS NULL OR expired_at > :o)
```

수정은 옛 행의 `expired_at`만 닫고 새 행을 넣는다. 소급 정정은 `valid_from`이 과거인 새 버전이다. 행의 다른 필드는 불변이고 물리 삭제는 없다.

**한계를 계약에 적는다.** 긴 문서 본문은 CAS에만 두고 현재 판의 청크만 FTS에 넣는다. 따라서 `as_of` 전문검색은 노드와 주장, 짧은 본문에 대해 동작하고, 옛 판 문서 전문은 검색되지 않는다. 옛 판 본문 조회(`kb_source`)는 된다. 모든 판 본문을 색인하면 추정 연 수 GB의 색인이 필요하다.

### 6.4 출처 모델

```
Claim ─ABOUT→ 엔티티
  │  EVIDENCED_BY {quote, start, end, prefix, suffix, text_sha}
  ▼
Snapshot {sha256, text_sha, url, fetched_at, http_status, etag, content_type, extractor}
  │  SNAPSHOT_OF
  ▼
Source {url, publisher, trust: primary|secondary|community, tos}
```

- 오프셋은 **표시 본문의 코드포인트**이고 `end`는 미포함이다. W3C TextQuoteSelector 형식의 `exact`, `prefix`, `suffix`를 함께 둔다 (`general-db.md` 9.2).
- 표시 본문은 적재 시 NFC로 고정해 CAS에 넣고 `text_sha`로 고정한다. 추출기가 바뀌어도 기존 근거의 오프셋은 깨지지 않는다.
- `first_party`는 인용구 대신 `author`, `generated_by`, `on_behalf_of`, 버전 이력이 출처다(R15). 사용자의 판단은 `author=user:sagae`로 저장한다.
- 제3자의 권고는 `Claim`의 `predicate=recommends`로만 저장한다. 시스템 산출물이 아니라 "출처 X가 Y라고 주장"이다.

### 6.5 changeset

쓰기의 유일한 단위다.

```json
{"key":"tick:C02:ab12cd34:0","actor":"system:tick","kind":"ingest","at":1793450000,
 "items":[
  {"op":"node","id":"s:9f3a…","type":"Snapshot","label":"Claude Code changelog 2026-10-31",
   "props":{"sha256":"…","text_sha":"…","url":"…","fetched_at":"…"}},
  {"op":"edge","id":"…","src":"s:9f3a…","rtype":"SNAPSHOT_OF","dst":"src:C02"},
  {"op":"obs","subject":"e:Package/rtk","metric":"latest_version","value_text":"1.1.0","observed_at":1793450000},
  {"op":"status","id":"e:Repo/continuedev-continue","status":"dead","detail":"removed","evidence":{…}}
 ]}
```

| 규칙 | 이유 |
|---|---|
| 적용 전에 canonical JSON으로 고정하고, 첫 적용도 그 바이트를 다시 읽어 쓴다 | 첫 시험에서 입력 dict 순서와 재생의 정렬 순서가 달라 지문이 어긋났다. 이 규칙으로 고쳤다 [P2] |
| 시각, id, 게이트 결과는 전부 changeset 안에 확정해 넣는다 | 재생이 현재 시각, 게이트 코드, 네트워크에 의존하지 않는다 |
| 한 changeset은 2,000 항목 이하 | 쓰기 잠금을 약 100 ms 안에 둔다. 2만 행이 635~718 ms였다 (`general-db.md` M2. 2,000은 그 값에서 외삽한 추정) |
| 키가 같고 내용이 다르면 거부한다 | IETF Idempotency-Key 초안의 422 동작과 같다 |
| `expected_version` 불일치는 저널에 남기지 않는다 | 실패는 상태가 아니다 |

### 6.6 대체 슬롯

한국어 자동 대체가 실패한 사례(`prior-art.md` T2)를 파서가 아닌 키로 푼다. 주장마다 `slot = sha(주어 id | 술어 | 한정자)`를 계산한다. 같은 슬롯에 값이 다른 새 검증 주장이 오면 다음을 한 changeset에서 처리한다.

1. 옛 주장 `status=superseded`, `valid_to = 새 valid_from`
2. `SUPERSEDES` 엣지 추가

자동 대체는 두 주장의 출처가 같거나 새 주장이 `trust=primary`일 때만 일어난다. 그 밖에는 둘 다 살려 두고 `Review`를 만든다. 충돌하는 주장이 출처별로 공존하는 것은 중립 저장소의 정상 상태다. 깨끗한 원자 전이가 실제 이력의 약 18%뿐이라는 보고(`prior-art.md` P6, 저자 자체 보고)를 감안한 범위다.

## 7. 파이프라인 흐름

### 7.1 층 분리

| 층 | 실행 | 비용 | 입력 | 출력 |
|---|---|---|---|---|
| L0 수집 | `kb tick` | 0 | 네트워크 | CAS, `Snapshot` |
| L1 결정적 추출 | `kb tick` 안 | 0 | CAS | changeset(`Item`, 엔티티, `obs`, 청크) |
| L2 에이전트 추출 | `kb agent` | 구독 | CAS의 표시 본문 | changeset(`Claim`) |

L2 입력은 항상 CAS이고 네트워크에 가지 않는다. L2가 멈춰도 L0과 L1은 계속 돈다. 인증이 만료돼도 수집은 죽지 않는다.

### 7.2 tick

```
kb tick --budget 780s
  flock run/tick.lock, 실패하면 종료
  sources/*.yaml → source 동기화
  디스크 가드(여유 < 10 GB면 수집 중지, 경고)
  내부 작업 처리(저널 꼬리 내보내기, 체크포인트, 백업, 게시 등 due인 것)
  due 소스를 지연 큰 순으로:
      호스트 간격 준수(기본 3초, 소스별 지정)
      조건부 GET → 304면 last_ok_at만 갱신
      본문 sha → CAS → 같으면 끝
      구조 가드 → 어긋나면 quarantine, 적용 없이 종료
      어댑터 parse → changeset → apply
      성공: next_check_at = now + cadence ± 10%
      실패: fail_count++, next_check_at = now + min(cadence, 15분·2^fail)
  L2 큐 적재, 인용구 재확인, 재검사 큐 처리
  헬스체크 핑(본문 OK 확인)
```

소스 하나의 예외는 그 소스의 행만 바꾸고 다음 소스로 넘어간다. 실제 공개 피드 6개로 돌린 결과다 [P8].

| 회차 | 결과 | wall | CPU | RSS |
|---|---|---:|---:|---:|
| 1 | 5개 적재, 항목 298건, 1개 격리 | 3.38초 | 1.0초 | 60 MB |
| 2 | 304 4건, 해시 동일 1건, 격리 1건, 신규 0 | 2.14초 | 0.08초 | 31 MB |

격리된 1건은 `platform.claude.com` release notes `rss.xml`이다. HTTP 200이지만 내용이 HTML이어서 항목 0으로 가드에 걸렸다(`sources-inventory-g.md` M23의 함정이 실제로 잡혔다).

### 7.3 타이머

```ini
# kb-tick.timer
[Timer]
OnStartupSec=90s
OnUnitInactiveSec=15min
AccuracySec=30s
```

비공개 매니저에서 잰 값이다 [P9].

- 작업이 끝난 뒤 3초 쉬고 재발화했다(시작 2.3, 6.4, 10.6, 14.7초). 겹치지 않는다.
- `OnStartupSec` 시각이 지난 뒤 타이머를 켜자 0.1초 만에 발화했다. `Persistent=true`의 "스탬프가 없으면 최초 발화 안 함"(`etl-orchestration.md` 5.1 B)을 겪지 않는다.
- 작업이 주기보다 길어도 겹치지 않았다.

놓친 슬롯 수는 의미가 없다. 지연은 `next_check_at`에 있으므로 다음 박동이 소스별로 필요한 만큼만 따라잡는다. `Persistent=`는 쓰지 않는다. systemd 문서상 `OnCalendar=` 전용이기도 하다.

**WSL 조건.** 타이머는 distro가 살아 있을 때만 돈다. WSL은 클라이언트가 없으면 15초 뒤 내려간다(`etl-orchestration.md` 5.2). 이 안의 답은 "사용자가 WSL을 쓰는 동안 돌고, 끊겨도 멱등이며, 다음에 이어받는다"이다. 부팅을 일으킨 단발 명령이 곧 끝나면 tick이 끊길 수 있지만 잃는 것은 없다. PC가 켜진 동안 WSL을 닫아 둬도 수집을 원하면 23장의 선택 부품을 켠다.

### 7.4 L2 실행

`kb agent`는 다음 순서로 돈다.

1. 사전 점검: `claude auth status`, 직전 `rate_limit_event`의 `five_hour.utilization < 0.5`, 일일 호출 상한.
2. `claude --version`이 마지막 성공 버전과 다르면 연기 시험 1회. 실패하면 `agent_paused`를 켜고 핑을 실패로 보낸다. L0은 영향을 받지 않는다. `--bare` 기본화가 와도 이 지점에서 멈춘다.
3. 큐에서 문서를 꺼내 **아직 추출하지 않은 문단만** 구간으로 나눈다(≤ 6,000자). 문단 해시로 판별하므로 문서가 바뀌어도 바뀐 문단만 비용이 든다.
4. 구간마다 호출한다.

```sh
env -i HOME="$HOME" PATH="<고정 경로>" LANG=C.UTF-8 DISABLE_AUTOUPDATER=1 \
  claude -p --model haiku --system-prompt "$(cat agents/extract.md)" \
    --tools "" --setting-sources "" --strict-mcp-config \
    --json-schema "$(cat schema/agent/extract.json)" \
    --max-turns 3 --max-budget-usd 0.02 --no-session-persistence \
    --output-format json < section.txt
```

5. 판정: `is_error=false`, `permission_denials` 비어 있음, `structured_output` 존재. exit 코드는 보지 않는다 (`harness.md` 3.3).
6. 결과를 CAS에 저장하고 인용 게이트를 지나 changeset으로 만든다. 재시도 2회 뒤에는 DLQ로 보낸다.

`--tools ""`, `--setting-sources ""`, `--strict-mcp-config` 조합은 훅 재귀를 막는 조합이기도 하다 (`prior-art.md` 6.3).

### 7.5 인용 게이트 (R5)

게이트는 LLM을 쓰지 않는다. `apply` 전 `prepare` 단계에서 돌고 결과는 changeset에 고정된다.

| 검사 | 통과 | 실패 |
|---|---|---|
| 스냅샷 존재, `text_sha` 일치 | 다음 검사 | `unverified` |
| 인용구가 NFC 표시 본문에 그대로 있음(공백 차이만 허용) | 오프셋 기록 | `unverified` |
| 주장의 숫자가 인용구에 있음 | `verified` | `unverified` |

시험 결과다 [P4].

| 입력 | 결과 |
|---|---|
| 원문 그대로 | 통과 |
| 줄바꿈이 공백으로 바뀐 인용 | 통과, 원문 오프셋 복원 |
| NFD 인용 | 통과 |
| 45%를 55%로 바꾼 인용 | 거부 |
| 이모지를 뺀 재서술 | 거부 |

`unverified`는 저장하되 기본 검색에서 뺀다. 게이트는 "인용구가 원문에 있다"까지만 보장하고 "주장이 인용구에 함의된다"는 보장하지 않는다. 인용 링크가 유효해도 사실 정확도는 39~77%라는 보고(`prior-art.md` P10, 저자 자체 보고)가 그 간격이다. 숫자 검사는 그 간격 중 기계로 닫을 수 있는 부분이다.

### 7.6 인용구 재확인

같은 URL의 새 스냅샷이 오면 그 출처를 근거로 하는 활성 주장의 인용구를 새 본문에서 찾는다. 있으면 `last_confirmed_at`을 갱신하고, 없으면 `recheck` 큐에 넣는다. 문자열 검색이라 비용이 0이다. R5, R7, R19를 한 검사로 잡는다.

## 8. 갱신 주기표

소스의 등록 단위는 `sources/*.yaml`의 항목이고, 아래 클래스가 기본값을 준다. 값은 인벤토리의 소스 갱신 주기에서 유도한 초기값이고 측정값이 아니다. 조건부 GET이라 잦은 확인의 비용은 작다(304 4건 합계 약 0.5초 [P8]).

### 8.1 수집 클래스

ID는 `sources-inventory.md`, `sources-inventory-g.md`의 것이다.

| 클래스 | 소스 | 확인 주기 | max_age | 대체 소스 |
|---|---|---:|---:|---|
| R1 릴리스 피드 | C01 C02 C13 C14 C16 O01 O03 O10 L02 | 3시간 | 1일 | C02↔C01, O03↔O01·O10 |
| R2 일 단위 피드 | C11 C12 C15 O12 U04 U05 U08 U09 U10 U14 L01 L03 X16 X17 | 12시간 | 3일 | U06으로 보완 |
| R3 주 단위 피드 | C05 O06 U11 U15 L04 | 1일 | 14일 | C05→C02 |
| D1 공식 문서 | C03 C04 C08 C09 O02 O11 U01 U02 U03 U16 | 1일. 색인 해시가 바뀐 페이지만 수집 | 7일 | 페이지별 `.md` |
| D2 수명·정책 문서 | C06 C07 C10 O04 O05 O09, Data API 쿼터·개정 이력·정책 | 1일 | 7일 | 없음. 공백 시 경고 |
| D3 플랫폼 도움말 | D15 D18 D19 D22 | 7일 | 30일 | 없음 |
| D4 공식 블로그 | D13 | 12시간(RSS) | 7일 | D15 |
| S1 시점 스냅샷 | P04 | 1일 | 3일 | 없음. 공백은 복구 불가, 기록만 |
| S2 차트 | P10 P13 X11 | 1일, 7일, 7일 | 14일 | 없음 |
| V1 채널·영상 | P05 P07 P14 | 채널 1일. 영상은 게시 후 30일간 7일 | 7일 | P07→P05 |
| M1 월간 발행 | D03 D04 D20 | 7일 | 45일 | 보도를 2차 출처로 귀속 |
| M2 분기·반기 | D01 D08 X07 X14 X18 | 14일 | 120일 | 없음 |
| M3 연간 | D05 D06 D09 D10 D11 D12 D17 D21 D23 | 30일 | 400일 | 없음 |

소스마다 `tos` 값을 선언한다.

| `tos` | 소스 | 처리 |
|---|---|---|
| `ok` | 공식 문서, 공개 피드, GitHub·레지스트리 API, arXiv, HN Algolia 등 | 기본 켜짐 |
| `gray` | P04 P05 P06 P07 P09 P10 P13 P14, 치지직·SOOP 내부 API 등 약관·robots가 불명확하거나 자동화를 제한하는 소스 | 기본 꺼짐. 사용자 승인이 있어야 켠다(23장) |
| `blocked` | P11 Playboard, P12 Social Blade 웹, 네이버 자동화 수집 대상 | 약관이 금지한다. 등록만 하고 수집하지 않는다 |

키나 승인이 필요한 소스(P01~P03, P08, P15, X02, X04, X05, X07~X10, X18~X21)는 키를 얻기 전까지 등록하지 않는다. 프로그램 경로가 미확인인 U12, U13과 429가 관측된 U07, L06도 v1에서 뺀다. 여기서 `gray`, `blocked`는 저장소 운영 설정이고 법률 판단이 아니다.

`max_age` 초과는 `source.state=late`로 표시되고 `kb_status`와 회고 지표에 나온다. ChurnBench가 "캐시 나이는 예측 변수가 아니고 갱신 정책이 신선도를 좌우한다"고 보고한 것(`prior-art.md` P7, 저자 자체 보고)과 같은 방향으로, 소스별 정책을 선언에 둔다.

### 8.2 생존 재확인 주기 (도메인 G)

| 단위 | 신호(`sources-inventory-g.md` 3.2) | 재확인 |
|---|---|---:|
| 저장소 | M01 M02 M03 M04 M05 | 7일. GraphQL 일괄 |
| 패키지 | M06 M07 M09 | 7일. 릴리스 피드가 있으면 즉시 |
| 제품 기능 | M14 M16 M17 M18 | 릴리스 단위(변경 이력 변경 시) |
| 문서 URL | M10 M11 M12 M13 | 7일 |
| 모델 | M20 | 1일. `scheduled_removal`은 날짜 도래 시 |
| 피드 | M23 | 매 수집 |
| MCP 레지스트리 | M21 | 7일 |
| 기법 주장 | H05, `DEPENDS_ON` | 의존 기능 변경 시 + 90일 |
| `superseded`, `dead` 복귀 | M17 | 릴리스 단위 + 30일. 번복 간격 5일, 184일 관측 |
| `stale_suspect` | M04 M09 | 30일 |

도메인 A~F의 주장은 출처 새 스냅샷 때 인용구 재확인(7.6), 그 외 180일이다.

### 8.3 내부 작업

내부 작업도 `sources/internal.yaml`의 항목이다. 스케줄 표가 하나로 유지된다.

| 작업 | 주기 | 비고 |
|---|---:|---|
| 저널 꼬리 내보내기, WAL `RESTART` 체크포인트 | 매 박동 | 체크포인트는 `general-db.md` M2 기준 `RESTART` |
| first_party Markdown 커밋과 푸시 | 변경 시 다음 박동 | RPO 약 15분 |
| restic `raw/` 백업 | 6시간 | 18장 |
| 스냅샷 게시 | 1일 | `VACUUM INTO` + 컬럼 배열 JSON |
| 벡터 증분 | 1일 | 3단계 |
| `kb verify` | 7일 | 재구축 지문, 표본 해시, restic check |
| 전사 지표 ETL | 7일 | 30일 삭제 전 |
| 회고 | 7일 | L2 쪽 |

## 9. 실패 처리

| 실패 | 감지 | 동작 | 사람에게 보이는 것 |
|---|---|---|---|
| 네트워크, 5xx | 예외 | 지수 백오프, 다음 박동에 재시도 | `fail_count` |
| 429, `Retry-After` | 응답 | 호스트 단위로 정지 | 없음. 3회 반복 시 경고 |
| 404, 410 | 응답 | 3회 연속이면 `suspect`, 대체 소스 활성화. G 단위는 생존 판정으로 | `kb_status` |
| 200인데 내용 이상 | 구조 가드 | 원본 보존, 적용 없이 `quarantine`, 대체 소스 활성화 | 알림 1회 |
| 파서 예외 | 예외 | `queue.state=dead`. 다른 소스 영향 없음 | `kb dlq list` |
| 추출 결과 없음 | 판정 규칙 | 재시도 2회 후 DLQ | `kb dlq list` |
| 게이트 통과율 급락 | 실행 지표 | 해당 소스 L2 일시 중지 | 회고 |
| 로그인 만료, `--bare` 기본화 | 사전 점검 | `agent_paused`, L0 계속 | 체크 실패 알림 |
| 구독 창 포화 | `rate_limit_event` | 다음 실행으로 연기 | 없음 |
| tick 도중 WSL 종료 | 다음 박동 | 멱등 재실행. 임대 만료 항목 회수 | 없음 |
| 심장 박동 정지 | healthchecks 미수신 | 머신 밖에서 알림 | 메일 |
| 동시 실행 | `flock` | 나중 프로세스 종료 | 없음 |
| 디스크 부족 | 시작 가드 | 수집 중지, 조회 유지 | 체크 실패 |
| DB 손상 | `quick_check`, 지문 불일치 | `kb rebuild`, 세대 교체 | 실행 기록 |
| `ops.sqlite` 손실 | 시작 시 | YAML에서 재생성. 전 소스 due. 큐는 저널에서 복원 | 지표 이력 손실 |
| CAS 객체 손상 | 해시 불일치 | 백업에서 복원 | 체크 실패 |
| 세대 교체 중 크래시 | 펜스 시각 | 60초 지난 펜스를 다음 실행이 해제 | 실행 기록 |

**워치독 주기.** `tick` 체크는 주기 24시간, 유예 12시간으로 둔다. PC를 끈 밤에는 울리지 않고, 하루 반 동안 박동이 없으면 울린다. 핑 응답은 HTTP 코드가 아니라 본문 `OK`를 확인한다.

**구조 가드**는 약 40줄이고 세 가지를 본다. 형식(`Content-Type`, 항목 수 0), 형태(파서 출력 키 집합의 지문이 지난번과 다름), 양(행 수와 본문 길이 하한). dlt의 `schema_update`가 잡지 못하는 값 품질 저하(`etl-orchestration.md` 7장)도 여기서 잡는다. 정적 추출이 짧으면(`blog.youtube` 772자 사례) `needs_browser`를 표시하고 DLQ로 보낸다. 브라우저 경로는 이 안에 없다.

**DLQ의 재처리.** 원본이 CAS에 있으므로 재처리는 네트워크 없이 `kb reparse --source X`다. 새 파서의 결과는 새 changeset으로 들어간다. 과거를 고치지 않고 새 관측으로 쌓인다.

**수집 내용은 비신뢰 입력이다.** 지속 수집이 기억 오염 경로라는 보고(`prior-art.md` P14)에 대한 대응은 네 겹이다. 추출 에이전트에 도구가 없다, 인용구가 원문에 있어야 한다, 상태 변경은 `primary` 출처만 자동이다, 응답 본문은 데이터 필드로만 나간다.

## 10. 생존 판정 흐름

### 10.1 상태

`status`는 R19의 세 값이고, 세부 9개 상태(`sources-inventory-g.md` 3.1)는 `status_detail`로 둔다.

| `status` | `status_detail` | 기본 검색 |
|---|---|---|
| `active` | `active`, `renamed`, `scheduled_removal`, `deprecated`, `partial`, `stale_suspect`, `revived` | 포함, 세부 값 표시 |
| `superseded` | `superseded` | 제외 |
| `dead` | `removed` | 제외 |

단위는 저장소, 프로젝트, 패키지, 기능, 모델, 문서 URL, 피드, 기법으로 나눈다. 같은 프로젝트라도 단위마다 상태가 다르다.

### 10.2 적재 전

```
새 changeset의 대상
  ├─ 엔티티(Repo, Package, Model)와 Source(문서 URL): 기계 신호 조회 → 규칙표 → status 결정 후 적재
  ├─ 주장: 주어 또는 DEPENDS_ON 대상이 dead/superseded면
  │        ├─ valid_to가 있거나 kind=historical → 시점을 붙여 active 유지(역사적 사실)
  │        └─ 그 외 → status=dead로 적재, 기본 검색 제외
  └─ 통과 → active
```

죽은 데이터를 활성으로 넣지 않는다는 규칙이 `prepare` 한 곳에 있다. 경로가 하나이므로 파서, 에이전트, 세션 쓰기 모두에 적용된다.

### 10.3 적재 후

```
신호 수집(8.2) → obs에 사실로 기록 → 규칙표를 순서대로 평가
  1. 이동(M02, M11) → RENAMED_TO, status_detail=renamed. 이후 canonical로 재검사
  2. 명시 선언(M01 M05 M06 M07 M12 M14 M20 M21) → 후보
  3. 단위 분리: 후속이 README에 있으면 저장소만 superseded, 프로젝트는 후속 재검사
  4. 조건 추출: 모델, 인증, 플랫폼, 버전이 문구에 있으면 partial
  5. 날짜: 미래면 scheduled_removal, 도래 시 재검사
  6. 침묵: M04, M09만이면 stale_suspect까지. 자동으로 dead가 되지 않는다
  7. 교차 확인: 기능은 변경 이력과 현행 문서를 둘 다 본다
  8. 재검사: dead, superseded도 M17로 계속 본다
  9. 파급: 대상이 죽으면 DEPENDS_ON 역방향 주장을 Review로 올린다
```

규칙표는 `sources-inventory-g.md` 3.4를 그대로 코드로 옮긴 약 40줄이다. 자동 적용 조건은 "확정력이 강한 신호 + 근거 스냅샷 있음"이고, 나머지는 `Review` 노드가 된다. 단일 신호로 판정하지 않는 이유는 그 보고서의 표본이 말한다. `archived`는 수명 종료 17개 중 10개만 잡았고(표본은 비무작위, 재현율은 상한값), 양방향으로 틀린다.

상태 변경은 `status` 연산으로 새 버전을 만들 뿐 삭제하지 않는다. 근거는 일반 주장과 같은 인용 게이트를 지난다. 시스템의 판단이 아니라 "출처 스냅샷의 문구에 근거한 상태"다.

`Review`는 `review` 에이전트가 근거를 모아 제안을 달 수 있지만(15장), 제안만으로 상태가 바뀌지는 않는다. H01~H11의 사람 판단 항목이 여기에 해당한다.

## 11. 다른 세션용 인터페이스

### 11.1 배포

플러그인 하나로 MCP와 스킬을 함께 준다(`harness.md` 6장).

```json
{"mcpServers":{"kb":{
  "command":"/home/user/sagae-knowloge-base/.venv/bin/python",
  "args":["-I","-m","kb.mcp_server"],
  "env":{"KB_HOME":"/home/user/kb-data","KB_MAX_SENSITIVITY":"internal"}}}}
```

`command`는 절대 경로다. PATH에 기대면 `env -i` 환경에서 기동이 실패하고 그 실패가 15분 캐시된다 (`harness.md` 6장). 관제 서버(게이트웨이)가 생기면 같은 stdio 서버를 그 뒤에 등록할 수 있다. 코드 변경은 없다.

stdio 서버 8개의 메모리 합은 PSS 약 690 MB다(계산값, 86 MB × 8 [P6]). 보고서의 4,794 MB는 프로세스마다 Kiwi를 올린 값이고 이 안에는 해당하지 않는다. 벡터 모델도 MCP 프로세스에 올리지 않는다.

### 11.2 도구

| 도구 | 입력 요지 | 응답 | 기본 상한 |
|---|---|---|---:|
| `kb_search` | `q, k=8, types, origin, include, as_of_valid, as_of_observed, cursor` | 슬롯별 id, 타입, 제목, 스니펫, 출처, 상태 | 3,000자 |
| `kb_get` | `ids(≤5), parts, as_of_*, max_chars` | 노드 상세, 주장, 근거, 이력 | 4,000자(최대 8,000) |
| `kb_neighbors` | `id, depth(≤2), rtypes, limit` | 닫힌 부분 그래프 | 200노드 |
| `kb_source` | `snapshot, start, max_chars` | 표시 본문 일부, 메타데이터 | 4,000자(최대 8,000) |
| `kb_write` | `idempotency_key, type, title, body, id, expected_version, props, links, sensitivity, author` | `{id, version, replayed}` | |
| `kb_request` | `topic, reason, requester` | `{ticket, status, merged}` | |
| `kb_status` | `ticket` | 데이터 시점, 신선도 초과 소스 수, 열린 티켓 | 1,500자 |

표면 크기는 GBrain starter(8도구, 5,105 B)와 같은 수준이고 Basic Memory(12도구, 32,801 B)의 6분의 1이다 [P6][`prior-art.md`].

### 11.3 응답 규칙

| 규칙 | 근거 |
|---|---|
| id 우선. 본문은 `kb_get`으로 필요한 것만 | 800자 문서 10건 10,232 토큰 대 1,048 토큰 (`retrieval-serving.md` 4.2) |
| 도구마다 `output_schema=None`으로 텍스트 블록만 낸다 | FastMCP는 `-> str`에도 `{"result": ...}` 구조화 결과를 붙인다 [P6]. Claude Code는 구조화 결과가 있으면 텍스트 블록을 버리므로(`compression.md` M9) 이스케이프된 문자열이 모델에 간다 |
| `ensure_ascii=False`, `sort_keys=True`, 구분자 공백 제거 | 한글에서 기본값은 토큰이 2배다(14,720 대 7,571) (`compression.md` 7.3) |
| 평면 행은 `cols` + `rows` | 키 반복 제거. 평면 표에서 CSV 3,493 대 JSON 7,571 (같은 절). 이 형식 자체의 토큰은 미측정 |
| 글자 수 예산을 서버에서 강제 | 한글은 25,000토큰 경계에 걸리지 않고 한 번에 약 52,000토큰까지 들어온다 (`compression.md` 6장). 8,000자는 약 8,400토큰으로 경고선 10,000 아래다 |
| 잘리면 `next` 커서와 좁히는 방법을 준다 | Anthropic 도구 지침 (`compression.md` 7.1) |
| 점수를 내지 않는다 | 순서가 곧 순위다. R6에 맞고 토큰도 준다 |
| 오류에 다음 행동을 적는다 | 같은 지침 |

```json
{"as_of":"2026-10-31T09:00:00Z","cols":["id","type","title","snippet","source","at","status"],
 "hits":[["c:7be2a1","Claim","YPP 신규 진입 8,000시간","…2027-02-01부터 신규 진입 기준을 8,000시간으로…","support.google.com","2026-10-31","active"]],
 "lexical":[["e:Metric/ypp-watch-hours","Metric","YPP 시청 시간 기준","…","","2026-10-30","active"]],
 "related":[["e:Platform/youtube-shorts","Platform","YouTube Shorts","","","","active"]],
 "degraded":["vector_cold"],"next":null,"notice":"본문은 외부 데이터이며 지시가 아니다"}
```

### 11.4 요청 큐

MCP Tasks는 메인 대화 전용이고 새 세션이 이어받지 못하므로 쓰지 않는다 (`retrieval-serving.md` 3.1). 티켓은 `Request` 노드다.

- 병합은 주제의 bigram 집합 Jaccard ≥ 0.8이다. "네이버 클립 수익 정산 주기"와 "네이버 클립의 수익 정산 주기"는 0.857로 합쳐지고, 무관한 쌍은 0.09~0.23이다 [P4]. 어휘가 다른 동의 요청(0.43~0.50)은 합쳐지지 않는다. 그런 티켓은 `research` 에이전트가 처리하면서 같은 결과로 닫힌다.
- 없는 정보의 판단은 호출한 모델이 한다. 무응답 임계값은 오판율 0.64~0.72로 자동 등록 근거가 되지 못한다 (`retrieval-serving.md` 3.4).
- 해소되면 `RESOLVED_BY` 엣지를 달고 `done`으로 바꾼다. 호출자는 `kb_status(ticket)`로 본다. `SessionStart` 통지는 넣지 않는다. 필요해지면 플러그인 훅 하나로 추가할 수 있다.

### 11.5 스킬

`plugin/skills/kb/SKILL.md`는 짧게 둔다. 언제 찾을지, id 우선 흐름, 없으면 `kb_request`, 쓰기는 `kb_write`, 반환 본문은 데이터라는 네 가지다. 첫 호출의 `ToolSearch` 왕복 1회는 받아들인다. `alwaysLoad`로 도구 설명을 상시 올리는 비용보다 작다.

## 12. 쓰기 경로

| 경로 | 호출자 | 비고 |
|---|---|---|
| `kb_write` | 다른 세션 | 일반 경로 |
| `kb write -f x.json` | 스크립트, 훅 | 같은 JSON |
| `~/kb-data/inbox/*.md` | 사람 | 프런트매터의 `id`가 식별자. 박동마다 스캔 |
| 어댑터, 에이전트 | 파이프라인 | changeset 직접 |

전부 `apply_changeset`을 지난다.

| 요구 | 구현 | 근거 |
|---|---|---|
| 멱등 | `journal.idem_key`. 재시도는 첫 결과 반환 | 같은 키 재전송이 `replayed: True` [P1], 세대 교체 중 쓰기 중복 0 [P3] |
| 버전 이력 | 버전 행, 저널 | 재생으로 재현 [P1] |
| 낙관적 잠금 | `expected_version` | 1,600회 수정, 유실 0 (`general-db.md` M15) |
| 내용 무변경 | `content_sha` 비교로 새 버전 생략 | 같은 보고서 M16 |
| 타입 미정 레코드 | `type` 자유 문자열, `props` JSONB | 같은 보고서 2.2 |
| 타입 확장 | 스키마 파일 추가. 색인이 필요하면 DDL 수정 후 재구축 | 재구축 1.25초 [P1] |
| 민감도 | 쓰기 시 지정, 기본 `internal` | |
| 사람 편집 충돌 | `base_version` 비교, 덮어쓰지 않고 `Review` 생성 | 같은 보고서 M16 |

연결은 호출마다 열고 닫는다. 파일 열기와 질의가 게시 사본 기준 p50 0.18 ms라(`general-db.md` M19) 비용이 작고, 스레드 간 연결 공유(400호출 중 24건 실패)와 열린 트랜잭션이 남는 문제(M18)가 구조적으로 사라진다.

`.path` 유닛은 쓰지 않는다. 재귀하지 않고 실행 중 변경을 놓쳐서 어차피 주기 스윕이 필요하다 (`general-db.md` 3.3). 2,000개 무변경 스캔이 69 ms이므로 박동마다 스윕만 한다. 지연은 최대 15분이고, 급하면 `kb inbox`를 직접 실행한다.

SQLite 규칙은 코드 한 곳(`store.py`)에 둔다. `BEGIN IMMEDIATE`만 쓰고, `busy_timeout=30000`, first_party는 `synchronous=FULL`, 수집은 `NORMAL`이다. 수집 커밋이 전원 손실로 되돌려져도 CAS에서 다시 적용된다.

## 13. 외부 소비자 계약 초안

요구 출처는 `docs/contracts/consumers/sagae-tools.md`다. 계약 원본은 `docs/contracts/kb-read-v1.yaml`(OpenAPI 3.1.1)로 둔다.

### 13.1 제공 형태

| 방식 | 내용 |
|---|---|
| HTTP `/v1` | 소켓 활성화. 기본 `127.0.0.1` 또는 Unix 소켓 0600. 유휴 600초 뒤 종료(폴링 60초보다 길다) |
| CLI | `kb api /v1/...`가 HTTP와 같은 JSON을 낸다. 표준 라이브러리만 쓰고 p95 27~30 ms [P10] |
| 스냅샷 | `publish/graph-<seq>.json.zst`, 읽기 전용 사본 `publish/kb-<seq>.sqlite` |

MCP와 HTTP와 CLI는 `kb/core/read.py` 하나를 호출한다. 게이트웨이가 생기면 CLI를 부르거나 HTTP를 프록시한다. 코어가 Python이라 Bun 프로세스 안에서는 직접 호출할 수 없다.

### 13.2 엔드포인트

| 경로 | 화면 |
|---|---|
| `GET /v1/schema` | 타입, 관계, 속성 카탈로그 |
| `GET /v1/overview?types=&status=&limit=&edge_limit=` | 그래프 개요. `total`, `truncated`, `order=rid_asc`, 닫힌 부분 그래프 |
| `GET /v1/nodes?type=&sort=&filter=&cursor=` | 표 보기. 키셋 커서, 정렬 키 허용 목록 |
| `GET /v1/nodes/{id}` | 상세. 현재 주장, 관계, 역방향 링크 |
| `GET /v1/nodes/{id}/neighbors?depth=&rtypes=&limit=` | 이웃 확장 |
| `GET /v1/nodes/{id}/history` | 대체 체인과 두 시간축 구간 |
| `GET /v1/series?subject=&metric=&from=&to=` | `obs` 시계열 |
| `GET /v1/search?q=&types=&origin=&status=&cursor=` | 스니펫, 하이라이트 위치 |
| `GET /v1/facets?...` | 타입, origin, status, 출처별 개수. 시간 구간별 개수 |
| `GET /v1/snapshots/{id}?start=&max_chars=` | 본문, 메타데이터, 인용 위치 |
| `GET /v1/changes?cursor=&limit=` | 커서 변경 피드 |
| `GET /v1/export/graph` | 전체 노드·엣지 컬럼 배열 JSON |
| `GET /v1/ops/freshness`, `/v1/ops/requests` | 수집 신선도, 요청 큐. 지표는 값만 낸다 |

모든 읽기가 `as_of_valid`, `as_of_observed`를 받는다.

### 13.3 공통 규칙

| 주제 | 규칙 |
|---|---|
| 봉투 | `{schema_version, build_id, data_as_of, data, page}`. 요청당 읽기 트랜잭션 1개 |
| `build_id` | `gen-<N>.seq-<S>`. 재구축은 결정적이라 `seq`가 유지되고 커서가 깨지지 않는다 |
| 오류 | RFC 9457 `application/problem+json` |
| 시각 | RFC 3339 UTC, `Z` |
| 페이지네이션 | 불투명 키셋 커서. `limit` 초과는 400 |
| 조건부 GET | `ETag: "seq-S"`, 304 |
| 변경 피드 | `seq` 커서. 버전 행이 피드이므로 **커서가 만료되지 않고 410이 없다**. 세대 교체 뒤에도 유효하다 |
| 기본 숨김 | 목록과 검색의 기본값은 `status=active`, `verification != unverified`, `sensitivity ≤ internal`, `merged_into IS NULL`이다. `superseded`, `dead`, 병합된 노드는 id 직접 조회로 항상 읽힌다. 민감도로 숨겨진 것만 존재 여부까지 감춰 404다 |
| 민감도 상승 | 쿼리 파라미터가 아니라 Bearer 토큰 범위로만. `secret`은 HTTP로 나가지 않는다 |
| 불변 ID | 엔티티, 관계, 주장, 스냅샷. 병합은 `merged_into`로 잇고 옛 id는 계속 해석된다 |
| 인용 위치 | 표시 본문 코드포인트 + `exact`, `prefix`, `suffix`. UTF-16 변환은 소비자 몫 |
| 타입 값 | `type`, `rtype`은 문자열. 닫힌 enum은 `origin`, `sensitivity`, `status`만 |
| 그래프 조건 | 엣지에 항상 `id`, 양끝이 응답에 포함, 좌표 없음, 안정 순서, 방향 멀티그래프 표기 |
| 보안 | `TrustedHostMiddleware`, CORS 없음, `KB_TOKEN` 자리, 쓰기 메서드 없음 |
| 호환 | 깨지면 `/v2`. CI에서 oasdiff, Schemathesis. fixture는 KB가 소유 |

읽기와 적재 격리는 WAL이 준다. 쓰기 중 HTTP p95가 상세 2.5, 이웃 14.7, 검색 6.2 ms였고 개요 최대 387 ms였다 (`general-db.md` M6). 긴 읽기가 체크포인트를 막지 않도록 요청 시간 상한을 둔다. 파일 대체 경로는 게시 사본뿐이다. 라이브 DB에 `immutable=1`을 쓰면 오류 없이 낡은 값이 나온다 (M11).

**세대 교체 중 읽기 동작.** 진행 중인 요청은 옛 세대를 끝까지 읽고, 다음 요청은 포인터를 다시 읽어 새 세대를 본다. 교체 직전 짧은 쓰기 펜스 외에 읽기 중단은 없다 [P3].

### 13.4 sagae-tools 질문에 대한 답

1. **예상 규모(추정).** 1년 차 주장 외 노드 약 10만, 주장 10만~50만, 엣지 30만~100만, `obs` 약 200만 행이다. 주장 상한 50만은 L2 하루 400회를 매일 다 쓰고 구간당 4건이라는 가정의 값이고, 새 문단이 있는 문서만 추출하므로 실제는 그 5분의 1 정도로 본다. 측정이 아니다. 20만 노드·100만 엣지·60만 주장까지 목표를 넘었으므로(`general-db.md` M7) 이 범위 안이다.
2. **실행 위치.** 로컬 WSL ext4. HTTP는 소켓 활성화(설치에 사용자 승인 필요). Proxmox로 옮기면 같은 계약을 TCP + Bearer로 낸다. WAL은 같은 호스트 전제이므로 전체를 옮긴다.
3. **스냅샷 본문.** 원본은 받은 바이트 그대로, 표시 본문은 Trafilatura Markdown 또는 평문을 NFC로 고정한 것이다.
4. **구현 언어.** Python 3.14. 같은 호스트의 다중 프로세스 읽기에 안전하다. 게이트웨이 프로세스 내 호출은 불가, CLI 또는 HTTP다.

## 14. 검색

### 14.1 흐름

```
kb_search(q)
 ├─ 어휘: bigram AND(구문) → 결과가 k 미만이면 OR(BM25)
 ├─ 벡터: 소켓에 150 ms 안에 응답이 오면 질의 벡터 + 전수 스캔 상위 200
 │        → SQL로 상태·민감도·시점 필터
 ├─ 그래프: 상위 3건의 희소 엔티티(문서 빈도 ≤ 15)에서 1홉
 └─ 슬롯 조립: hits(벡터 우선, 없으면 어휘) / lexical(hits에 없는 어휘) / related
```

각 경로는 서로 다른 슬롯을 채우고 순위를 섞지 않는다. 이유는 세 가지다.

- 강한 Dense + RRF는 합성 −0.082, Ko-StrategyQA −0.080으로 유의하게 나빠졌다. 선형 결합은 Dense 쪽 가중을 높이면 Dense에 수렴할 뿐이다.
- 그래프를 순위에 섞으면 단일 홉이 0.066 깎이고, `related` 슬롯으로 분리하면 손실 없이 다중 홉 커버리지가 0.875에서 1.000이 된다(24건, 근거 약함).
- 호출자가 LLM이다. 슬롯을 읽고 판단할 수 있으므로 서버가 융합 파라미터를 튜닝할 이유가 없다. `--dump-json` 같은 정확 식별자는 `lexical` 슬롯이 보장한다.

GPU가 없어도 어휘 경로가 답한다. 벡터 서비스가 꺼져 있으면 응답의 `degraded`로 알린다. 연결 시도가 서비스를 깨우므로 다음 질의부터 벡터가 붙는다.

### 14.2 벡터 (3단계)

- 저장: `index/vectors-<seq>.f32`, `index/ids-<seq>.txt`. 재구축 가능한 파일이고 DB에 넣지 않는다.
- 서비스: `kb-embed.socket`이 Unix 소켓을 쥐고 첫 연결에 기동한다. 모델과 메모리 맵을 올리고 10분 유휴 뒤 종료한다. 콜드 4~6.4초, 웜 질의 GPU 11.5 ms 또는 CPU 104 ms다(e5-large 기준).
- 임베딩 단위: `chunk`, `Claim`, 짧은 노드.
- 모델: 기본 후보는 1024차원 단일 벡터인 `multilingual-e5-large`다(합성 0.685, 한국어·영어 혼합 코퍼스). 대형 모델은 tmpfs 포화로 공개 데이터 측정이 없으므로, **3단계 첫 작업으로 디스크에서 AutoRAG, Ko-StrategyQA, 자체 골든으로 e5-large, KURE-v3, BGE-M3를 재서 고정한다.** KURE-v2는 공개 데이터 최고값이지만 문서당 81~200 KB 다중 벡터라 이 구조에 맞지 않는다.
- 규모: NumPy 전수는 10만 건 6.4 ms다. 100만 건이면 외삽으로 약 64 ms, RAM 4 GB다. 전환 조건은 22장에 있다.
- ML용 venv는 torch 때문에 약 6 GB라 메인 venv와 분리한다. Python 버전 호환은 미측정이다.

### 14.3 문서 검색 단위

긴 문서는 제목 기준으로 ≤ 3,000자 청크로 나눠 `chunk`에 위치만 기록한다. 본문은 CAS의 표시 본문에서 오프셋으로 잘라 읽는다. 스니펫과 하이라이트는 앱이 표시 본문에서 질의 항을 다시 찾아 계산한다 (`general-db.md` 6.3). 토크나이저 등록이 필요 없어 어떤 SQLite 연결로도 읽힌다.

## 15. 에이전트·워크플로우 구성

### 15.1 원칙

에이전트는 입력을 받아 JSON을 돌려주는 함수다. 저장소에 쓰지 않고, 다음 단계를 정하지 않으며, 스케줄 실행에서 Bash를 갖지 않는다. 이 한 줄이 다음을 함께 해결한다.

| 위험 | 해소 방식 |
|---|---|
| rtk 재작성이 `--allowed-tools`를 깨고 `ask`를 우회 | 스케줄 에이전트에 Bash가 없다 |
| 프롬프트 주입 | 추출 에이전트는 도구가 없다 |
| 권한 거부가 exit 0 | 허용 규칙을 쓰는 작업이 `research` 하나뿐이다 |
| 10분 대기 상한, 예산 중단이 exit 0 | 배경 워크플로우가 없다 |
| `--tools` 전파 | 하위 에이전트가 없다 |
| 에이전트당 토큰 16,883~29,787 | 호출당 시스템 프롬프트만 |
| trust 없는 폴더, 훅 재귀 | `--setting-sources ""`, `--strict-mcp-config`, `--system-prompt`로 프로젝트 설정에 기대지 않는다 |

### 15.2 정의

정의는 `agents/*.md`(프롬프트와 프런트매터), 출력 스키마는 `schema/agent/*.json`이다. 실행기는 `kb/agent/run.py` 하나다. 예산과 상한은 초기값이고 측정값이 아니다.

| 에이전트 | 입력 | 도구 | 모델 | 호출당 상한 | 일일 상한 | 출력 |
|---|---|---|---|---|---:|---|
| `extract` | 표시 본문 구간, 후보 엔티티 이름 | 없음 | haiku | $0.02, 3턴 | 400회 | 엔티티, 주장, 인용구 |
| `research` | `Request` 티켓 | WebSearch, WebFetch | haiku | $0.30, 8턴 | 5건 | URL 목록과 이유 |
| `review` | 근거 묶음 | 없음 | haiku | $0.02, 3턴 | 30건 | 상태 제안, 인용구 |
| `retro` | 지표 JSON, 현재 프롬프트 | 없음 | sonnet | $1.00, 3턴 | 주 1회 | 변경 제안(대상 파일, diff, 근거 지표) |

`research`는 URL만 돌려준다. 내용은 결정적 수집기가 받아 CAS에 넣고 `extract`를 지난다. `WebFetch`는 손실 요약이라 원본 보존에 쓸 수 없고 (`compression.md` 6장), 에이전트가 쓴 요약을 지식으로 넣지 않는 편이 R5에 맞다. `dontAsk` + `--settings ops/job-settings.json` 조합에서 `WebSearch`, `WebFetch` 허용 동작은 미측정이라 1단계 끝에 잰다.

`--max-budget-usd`는 사후 검사라 넘을 수 있다 (`harness.md` 3.1). 그래서 실제 상한은 호출 수다. 비용 감각은 문서 구간당 약 $0.001~0.002, 호출당 5~7초다 (`prior-art.md` T7. 짧은 문서 1개 기준이고 구독 차감량이 아니다). 구독 공시 한도의 전제가 "ordinary, individual usage"이므로 일일 상한을 낮게 시작한다.

### 15.3 저장 워크플로우

**0개다.** 문서 하나 처리에 에이전트 간 협력이 필요 없고, 동시성은 Python의 스레드 풀(동시 4)로 충분하며, 재개는 큐의 임대 만료로 해결된다. 요구사항(R12)의 "워크플로우는 저장소에 코드로 존재"는 생기면 `.claude/workflows/`에 둔다는 뜻으로 지킨다. 초기 대량 적재처럼 메인 세션이 관제하는 일회성 작업에는 대화형 워크플로우를 자유롭게 쓴다. 그것은 스케줄 구성 요소가 아니다.

## 16. 자가 개선 루프

### 16.1 지표

| 지표 | 소스 | 저장 |
|---|---|---|
| 수집 수율: 소스별 성공, 304, 변경, 격리 | `run` | `metric` |
| 신선도: `max_age` 초과 소스 수, 소스별 지연 | `source` | 주간 값 |
| 추출 수율: 구간당 주장 수, 게이트 통과율, 재시도율 | `kb agent` | `metric` |
| 토큰: 호출별 `modelUsage`, `total_cost_usd`(추정치), 구독 활용률 | 호출 결과 | `metric` |
| 도구 실패: 세션별 `tool_result.is_error`, 거부 | 전사 ETL | `metric` |
| 조회: 도구별 호출, 빈 결과 비율, 평균 응답 글자 수 | MCP 로그(질의 원문 제외) | `metric` |
| 복구: 재구축 시간, 지문 일치, 백업 크기 | `kb verify` | `metric` |

전사 ETL은 54행 추출기(`harness.md` 7.3)로 시작하고, 원문은 복제하지 않고 수치만 적재한다. 30일 삭제 전에 7일 주기로 돈다. 토큰 합계는 ccusage와 일치 검증된 방식이다. 전사 스키마는 비공식이므로 파싱 실패율 자체를 지표로 둔다.

### 16.2 회고

주 1회 `kb retro`가 지표를 집계해 `retro` 에이전트에 넘긴다. 에이전트는 도구 없이 제안을 JSON으로 돌려주고, Python이 다음을 수행한다.

1. `docs/retro/YYYY-Www.md`에 지표 요약과 제안을 쓴다. 시스템 문서이고 지식 데이터가 아니다.
2. 제안 diff를 `retro/YYYY-Www` 브랜치에 적용한다.
3. 골든 평가를 돌린다. `tests/golden/extract/`(고정 문서의 게이트 통과율, 재현 주장), `tests/golden/search.jsonl`(nDCG@10)이다.
4. 나빠지면 브랜치를 버리고 기록만 남긴다.

**병합은 사람이 한다.** 자동 병합은 없다. 프롬프트, 주기, 어휘, 어댑터 변경이 대상이고, CLAUDE.md는 대상에서 제외한다(사용자 승인 없이 변경 금지). 회고 산출물은 차트나 대시보드가 아니다. 가시화가 필요하면 `sagae-tools`가 `/v1/ops/*`를 읽는다.

### 16.3 부품 자체의 회고

trail과 rtk도 지표로 다룬다. trail MCP 호출 수가 8주 연속 0이면 제거를 제안 항목에 올린다. 저장소가 작을 때는 효용이 작을 것으로 예상되기 때문이다(`compression.md` 5.3). `chars/4` 계열 절감 표시는 믿지 않는다. 한글에서 약 4배 어긋난다.

## 17. 압축, rtk, trail

### 17.1 rtk (R11, R20)

프로젝트 파일에만 둔다. `rtk init`은 쓰지 않는다(CLAUDE.md를 수정한다).

```json
{"env":{"RTK_DB_PATH":"/home/user/sagae-knowloge-base/.state/rtk/history.db","RTK_RECALL":"0",
        "RTK_SUPPRESS_HOOK_WARNING":"1","RTK_TELEMETRY_DISABLED":"1"},
 "hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[
   {"type":"command","command":"$CLAUDE_PROJECT_DIR/ops/hooks/rtk-guard.sh","timeout":10}]}]}}
```

`rtk-guard.sh`는 14줄이다. 읽기 전용 단일 명령(`git status/diff/log/show`, `ls`, `rg`, `grep`, `tree`)만 `rtk hook claude`로 넘기고 나머지는 그대로 통과시킨다. 시험 결과다 [P7].

| 명령 | 결과 |
|---|---|
| `git status`, `git log -n 3`, `ls -la` | 재작성 |
| `git push origin main`, `gh pr merge 1` | 통과(재작성 안 함) |
| `git status && rm -rf x`, `git log > out.txt`, `echo $(git status)` | 통과 |
| `cat a.txt`, `curl https://x`, `uv run pytest` | 통과 |

- 변경 명령이 재작성되지 않으므로 `ask`, `deny`, `--disallowed-tools`가 원문 그대로 평가된다. `rtk uv run`의 stdout 손실(`compression.md` M5c)도 피한다. 어차피 `curl`, `cat`, `gh api`는 절감 0%였다.
- 상태 저장: `RTK_DB_PATH`로 `history.db`가 저장소의 `.state/` 아래로 옮겨졌고, 가짜 HOME에 아무것도 남지 않았다 [P7]. `RTK_RECALL=0`이면 `recall.db`가 없다. 대가는 `rtk recall` 복구 불가다. 원문이 필요하면 `RTK_DISABLED=1`로 다시 실행한다.
- `.rtk/filters.toml`은 쓰지 않는다. 신뢰 기록이 `~/.local/share/rtk/`에 남고 worktree에서 조용히 멈춘다.
- 이 훅은 대화형 세션과 서브에이전트의 저장소 작업에만 닿는다. 스케줄 작업은 `--setting-sources ""`로 훅이 없고 Bash도 없다. MCP 응답에는 rtk가 닿지 않으므로 그 경로의 압축은 11.3이 맡는다.
- 실제 `claude` 세션에서 `env` 블록이 훅과 재작성 명령에 전달되는지는 미측정이다. 가짜 HOME의 직접 실행으로만 확인했다.

### 17.2 trail (R11, R20)

코드맵만 쓴다.

```json
{"mcpServers":{"trail":{"command":"/home/user/.local/bin/trail","args":["mcp"]}}}
```

- `trail init`을 쓰지 않는다. 제한 옵션도 `~/.trail`에 쓰고 새 worktree에서 전역 재기록 경로가 남는다 (`compression.md` 5.5).
- `trail note`도 쓰지 않는다. `~/.trail`에 쓰고 한국어 노트를 거부한다.
- 세션 학습 기록의 자리는 KB 자체다. 작업에서 얻은 결정과 교훈은 `kb_write`로 `Decision`, `Note`에 남긴다. 이것이 R15의 사용자 생산 정보이고 한국어도 된다.
- `.gitignore`에 `/graft/`를 미리 넣어 `trail build`의 수정이 일어나지 않게 한다. worktree마다 `trail build`가 필요하다.
- 대상은 `kb/`의 `.py`뿐이다. 약 3,000줄 규모라 효용이 작을 것이고, 16.3이 이를 측정한다.
- "trailing = Trail-Code"는 정황 판단이다. 사용자 확인이 필요하다(23장).

### 17.3 저장 데이터

| 대상 | 방식 | 값 |
|---|---|---|
| 원본, changeset, 표시 본문 | sha256 CAS + zstd-3 | 시뮬레이션 65배. 실제 피드 5 MB → 0.5 MB [P8] |
| 유튜브 시청 페이지 | 저장하지 않는다. yt-dlp JSON에서 변동 필드(서명 URL, 포맷, 자막 URL)를 뺀 canonical JSON만 | 페이지는 재수집마다 바이트가 달라 CAS 0% (`compression.md` 8.5). 추출 JSON의 안정성은 미측정 |
| 저널 | 월별 NDJSON. 지난달은 zstd | 포인터뿐이라 작다 |
| DB | 압축하지 않는다 | 캐시이고 백업 대상이 아니다 |
| 백업 | restic 내장 압축 | |

zstd 사전은 v1에서 쓰지 않는다. 작은 JSON에서 2배 가까운 이득이 있지만 사전을 잃으면 복호화가 불가능해서 진실 계층에 수명 묶임을 만든다. 작은 객체가 100만 개를 넘으면 재검토한다. 재수집 간 변동이 큰 페이지의 델타 저장, CDC도 쓰지 않는다. 객체 CAS보다 이득이 없었다 (같은 보고서 8.4).

## 18. 대체 불가 데이터의 백업

재구축 가능한 것을 빼면 대상은 `raw/` 하나다. 이것이 이 구조의 가장 큰 운영 이득이다. 백업을 위한 DB 백업 API와 스냅샷 세대 관리가 필요 없다. `raw/`는 추가 전용이라 restic 중복 제거에 가장 유리한 입력이기도 하다.

물리 디스크가 1개이고 `ext4.vhdx`도 C:에 있다 (`general-db.md` 8.2). `/mnt/c` 사본은 vhdx 손상만 막고 디스크 장애는 막지 못한다.

| 등급 | 데이터 | 경로 | RPO | 막는 장애 |
|---|---|---|---:|---|
| A | first_party(`secret` 제외) | 결정적 Markdown → 머신 밖 git(GitHub 비공개) | 약 15분 | 디스크, 분실, 도구 부식 |
| A | first_party 전체, 외부 원본 | restic → 머신 밖(R2 또는 Proxmox SFTP) | 6시간 | 디스크, 랜섬웨어 |
| B | `raw/` 전체 | restic → `/mnt/c/kb-backup` | 6시간 | vhdx 손상, 실수 |
| 없음 | `db/`, `index/`, `publish/` | 재구축 | | |

first_party가 external보다 강한 등급인 이유는 독립된 경로가 둘이기 때문이다. restic은 암호와 도구에 의존하고, Markdown git은 사람이 그대로 읽을 수 있으며 내보내기 형식이 곧 `inbox/` 입력 형식이라 복원 도구가 따로 없다. `general-db.md` M23 기준 1,467건에 커밋 p50 48 ms다.

`secret`은 git 내보내기에서 뺀다. restic은 AES-256 암호화이므로 머신 밖에 둘 수 있다 (`general-db.md` S54). restic 비밀번호는 사용자가 별도 보관해야 하며 잃으면 복구 불능이다. Litestream 없이 RPO를 줄이려면 박동을 줄이면 된다.

**복원 훈련은 재구축 검증과 같은 명령이다.** 주 1회 `kb verify`가 다음을 돌린다.

1. `restic check --read-data-subset=5%`
2. 저널 재생으로 임시 세대를 만들어 라이브 DB와 지문 비교 [P1]
3. 임의 객체 100개 해시 검사
4. 분기 1회는 머신 밖 저장소에서 빈 디렉터리로 복원해 2를 반복

통과하면 `verify` 헬스체크에 핑을 보낸다. 백업이 조용히 죽는 것을 머신 밖에서 잡는다. 외부 데이터 일부의 재수집 불가도 같은 등급으로 보호된다. 링크가 죽어도 데이터가 산다(R1).

## 19. 직접 작성할 코드의 범위 추정

| 모듈 | 내용 | 줄 |
|---|---|---:|
| `core/store.py` | 연결, 버전 가드, CAS, 저널, `apply`, 펜스 | 250 |
| `core/gate.py` | `prepare`, 인용 게이트, 숫자 검사, 슬롯 | 150 |
| `core/read.py` | 검색, 상세, 이웃, 표, 패싯, 이력, 피드, as-of | 450 |
| `core/rebuild.py` | 재구축, 세대 교체, 검증 | 120 |
| `cli.py` | 명령 분기 | 150 |
| `mcp_server.py` | FastMCP 껍데기 7도구 | 120 |
| `http_api.py` | Starlette 라우터, 봉투, 오류 | 180 |
| `ingest/tick.py` | due, 백오프, 호스트 간격, 구조 가드, 핑 | 250 |
| `ingest/adapters/*.py` | 10종(feed, llms 색인, 페이지, GitHub, 레지스트리, HN, suggest, yt-dlp, 표, 내부) 평균 45줄 | 450 |
| `ingest/inbox.py` | Markdown 입력, 내보내기 | 120 |
| `agent/run.py` | 호출, 판정, 사전 점검, 구간 분할, 큐 | 200 |
| `live/*.py` | 신호 수집 + 규칙표 | 250 |
| `ops/*.py` | 백업, 지표, 회고 | 220 |
| `embed/*.py` | 서비스, 증분 빌드(3단계) | 150 |
| **합계** | | **약 3,110** |

테스트 약 1,200줄이 별도이고, 소스 선언, 스키마, 프롬프트, 유닛은 코드가 아닌 설정으로 약 800줄이다. 프로토타입에서 `store.py`, `gate.py`, `rebuild.py`의 뼈대에 해당하는 부분이 158줄로 동작했다 [P1][P3][P4]. 추정의 근거는 이 값과 `general-db.md`의 쓰기 코어 약 60줄, 전사 추출기 54줄이다.

기존 도구로 대체되지 않는 범위다. dlt를 쓰는 안에서도 어댑터, 그래프 변환, 게이트, 조회, 생존 판정은 남는다. dlt가 덜어 주는 것은 `tick.py`와 어댑터의 일부로 약 200줄(추정)이고, 대신 스테이징 표에서 그래프로 옮기는 변환이 추가된다.

## 20. 구현 순서

각 단계 끝에 저장소가 그 자체로 쓸모 있어야 한다.

| 단계 | 내용 | 완료 조건 |
|---|---|---|
| 0 | 사용자 결정(23장), 런타임 설치, ext4 측정 | `kb doctor` 통과, 실제 ext4에서 쓰기·재구축 재측정 |
| 1 | 코어, tick, G 도메인 피드·문서 어댑터, CLI, MCP, `kb_write`, 저널 내보내기, 심장 박동, `/mnt/c` 백업, first_party git, rtk, trail | 다른 프로젝트 세션이 조회·쓰기 가능. 재구축 지문 일치 |
| 2 | L2 추출, 게이트, 생존 판정, 요청 큐, HTTP 계약과 fixture, 머신 밖 백업, 복원 훈련 | 주장이 인용구와 함께 조회됨. sagae-tools 계약 테스트 통과 |
| 3 | 사용자 승인 소스(A~F), 벡터 평가와 서비스, 회고, 전사 ETL | 골든 평가 기준선, 첫 회고 |

도메인 G를 먼저 한다. 약관 위험이 낮고(공식 문서, GitHub, 레지스트리, 공개 RSS), 변화가 빨라 파이프라인이 곧바로 시험되며, 생존 판정 규칙이 이미 있다. 사용자가 우선순위를 다르게 두면 어댑터 순서만 바뀐다.

## 21. 요구사항 대조

| R | 대응 | 절 |
|---|---|---|
| R1 원시 보존 | sha256 CAS, 불변, 파싱보다 먼저 저장 | 2, 7.2 |
| R2 재구축 | 저널 재생. 지문 일치 실측 | 6.5, 부록 P1 |
| R3 관계 중심 | 노드·엣지 두 표. 주장도 노드. `obs`는 노드에 매달린 시계열 | 6.2 |
| R4 시간성 | 두 시간축, 버전 행, 대체 체인 | 6.3, 6.6 |
| R5 출처 게이트 | 결정적 인용 게이트 | 7.5 |
| R6 중립성 | 점수 필드 없음, 귀속 주장, 시각화 없음, 판단 기능 없음 | 6.4, 11.3 |
| R7 신선도 | 클래스별 주기, `next_check_at`, 백오프, DLQ, 워치독, 대체 소스, 구조 가드 | 7.2, 8, 9 |
| R8 지속 실행 | 박동과 데이터 스케줄로 자동 따라잡기. L0과 L2 분리, 호출 상한 | 7.3, 7.4 |
| R9 반환 | 플러그인 MCP 7도구, 요청 큐, id 우선, 서버 예산 | 11 |
| R10 검색 | FTS, 벡터, 그래프 슬롯. GPU 없이 어휘 경로 | 14 |
| R11 압축 | rtk, trail, zstd CAS | 17 |
| R12 자가 개선 | 지표, 주간 회고, 골든 평가, 사람 병합. 정의 전부 저장소 | 16 |
| R13 재발명 금지, 상주 최소 | 상주 0, 약 3,100줄의 접착층, Docker 없음 | 4, 19 |
| R14 LLM 키 없음 | 구독 `claude -p`만 | 7.4 |
| R15 범용 저장 | `origin`으로 같은 표. first_party는 작성자와 버전 이력 | 6.4 |
| R16 대체 불가 보호 | 독립 2경로 머신 밖, 민감도 4단계 | 18 |
| R17 쓰기 인터페이스 | changeset, 멱등, 버전, 자유 타입 | 12 |
| R18 소비자 계약 | `/v1`, 스키마, 커서, 시점 지정, 피드, WAL 격리 | 13 |
| R19 생존 판정 | 3상태 + 세부 값, 적재 전·후 흐름, G 재확인 주기 | 8.2, 10 |
| R20 rtk·trail 한정 | 프로젝트 파일, `.state/` 상태 경로, `init` 불사용 | 17 |

## 22. 약점과 전환 조건

이 안의 약점이다. 임계값은 근거 수치에서 잡은 초기값이다.

| 약점 | 영향 | 전환 조건 | 전환 대상 |
|---|---|---|---|
| 허브 깊은 순회 | 25만 엣지 허브 3-hop p50 238.7 ms, p95 363.3 ms. API는 깊이 2로 제한 | 깊이 3 이상 질의가 실제 요구되고 p95 > 200 ms | LadybugDB 읽기 투영. `seq` 기준으로 재생성 |
| 단일 작성자 | 무제한 쓰기는 약 250쌍/s에서 멈춘다 | 동시 쓰기 세션이 16개 가까이 지속되고 p99 > 100 ms | 임베디드 PostgreSQL. `apply`와 읽기 SQL 교체, 저널 그대로. 피드 커서 재설계 필요 |
| 저널 재생 시간 | 규모와 비례. 47만 행 9.88초 | 재구축 > 30분 | 체크포인트 세대(재생 시작점)를 둔다 |
| 전수 벡터 | 메모리와 지연이 선형 | 벡터 > 100만 또는 p95 > 200 ms | LanceDB + refine(10만 6 ms, 재현율 0.999). 색인 파일만 교체 |
| 어댑터 직접 소유 | 소스 형식 변화를 코드로 따라간다 | 4장 dlt 조건 | 해당 소스만 dlt |
| 머신 꺼짐 공백 | 시점 스냅샷과 짧은 창 피드가 영구 유실될 수 있다 | 4장 조건 | GitHub Actions 또는 Proxmox 수집 노드(`raw/` 형식 그대로 합침) |
| 브라우저 없음 | JS 전용 페이지 본문 부족 | 4장 조건 | Playwright를 해당 소스 어댑터에만 |
| 인용 게이트의 범위 | 함의는 검증하지 않는다 | 표본 감사에서 오주장 비율이 허용 밖 | `review` 에이전트로 함의 판정 추가 |
| 구독 의존 | `--bare` 기본화, 사용량 정책, 로그인 만료 | L2 중단이 7일 이상 지속 | 로컬 sLLM(`ANTHROPIC_BASE_URL`) 또는 API 키. L0은 영향 없음 |
| 전사 스키마 비공식 | 지표 ETL이 깨질 수 있다 | 파싱 실패율 급증 | 해당 지표만 일시 포기 |
| 재구축과 복구 코드의 동등성 | 재생 코드가 틀리면 복구도 틀린다 | | 주간 지문 비교가 상시 검출 |
| 문서 전문 as-of 미지원 | 옛 판 본문 검색 불가 | 소비자가 필수로 요구 | 청크 해시 공유 색인 |

**의도적으로 받아들인 것.** 수집 커밋 일부가 전원 손실에 되돌려질 수 있다(재적용으로 복구). 첫 벡터 질의는 어휘 결과로 나간다. 파일 입력은 최대 15분 늦다.

## 23. 사용자 결정 사항과 미검증 항목

### 23.1 사용자 결정

| # | 결정 | 기본 제안 | 막히는 것 |
|---|---|---|---|
| 1 | "trailing"이 Trail-Code인가 | Trail-Code로 진행 | 17.2 |
| 2 | 약관 회색 소스 사용. suggest, yt-dlp, InnerTube, Kworb, 치지직·SOOP 내부 API 등 | 기본 꺼짐. 도메인 A는 suggest에 달려 있으므로 결정 필요 | A~D 수집 |
| 3 | Data API 키 사용 여부. API 클라이언트의 스크래핑 데이터 취득 금지, 비인증 데이터 30일 보존 제한(`sources-inventory.md` 2장)이 yt-dlp 경로, 불변 보존과 충돌 | v1은 키 없이. 도입하면 해당 원본은 30일 만료 클래스로 분리 | R1 예외 |
| 4 | 머신 밖 백업 대상과 RPO. R2, Proxmox, GitHub 비공개 저장소 생성 | R2 + GitHub 비공개, RPO 15분/6시간 | R16 완결 |
| 5 | 설치 승인: `systemctl --user link/enable`, `loginctl enable-linger`, 플러그인 설치 | 전부 승인 | 1단계 |
| 6 | healthchecks.io 계정 | 체크 3개 | 사망 감지 |
| 7 | HTTP 제공 주체: KB 소켓 활성화 또는 sagae-tools 게이트웨이. MCP를 플러그인 또는 게이트웨이에 등록 | KB 소켓 활성화 + 플러그인. 게이트웨이가 생기면 뒤에 등록 | 13장 |
| 8 | PC가 켜졌고 WSL이 닫힌 시간의 수집 | 기본 안 함. 원하면 작업 스케줄러 1개 추가: `wsl.exe -d Ubuntu -u sagae -- systemctl --user start --wait kb-tick.service`, `StartWhenAvailable=true` | R8 범위 |
| 9 | EDGAR 등 연락처 UA에 쓸 주소 | 전용 주소 또는 소스 비활성 | X14, D08 |
| 10 | 일일 L2 호출 상한 | 400회로 시작 | 구독 창 |

### 23.2 미검증

- **실제 ext4.** 이 안의 모든 `[P]` 값은 tmpfs다. fsync 1.2 ms 주입 측정(`general-db.md`)이 있지만 changeset 경로로 재지 않았다. 0단계 첫 작업이다.
- **전원 손실, `wsl --shutdown`.** `kill -9`까지만 있다.
- **WSL 부팅 경로의 타이머**, 작업 스케줄러 경로의 클라이언트 유지. 소스 분석뿐이다.
- **실문서 규모의 재생.** 합성 텍스트는 짧고 어휘가 작아서 압축률은 대표값이 아니고, FTS 지연은 흔한 어휘 위주라 보수적일 수 있다. 청크와 `obs`는 프로토타입에 없다.
- **`research` 에이전트의 `dontAsk` 경로**, haiku의 긴 구간 추출 품질, 구간당 실제 비용.
- **토큰.** `cols` + `rows` 응답의 Claude 토큰 수.
- **대형 임베딩의 공개 데이터 성능**, torch와 Python 3.14 호환.
- **rtk `env` 전달**의 실제 세션 동작, Orca 훅과의 공존.
- **머신 밖 복원.** 자격 증명이 없어 어느 대상으로도 돌리지 않았다.
- **yt-dlp canonical JSON의 바이트 안정성.**
- **소스별 호출 한도.** suggest, yt-dlp의 차단 임계는 미확인이다. 초기 호출량을 낮게 두고 429를 관찰한다.

## 부록 A. 이 설계의 실측

스크립트는 `/tmp/claude-1000/-home-sagae-sagae-knowloge-base/b32eef31-b09c-4e58-8902-431f279117b3/scratchpad/simplicity/scripts/`에 있고 tmpfs라 재부팅하면 사라진다. 합성 수치는 평가용이며 지식 데이터가 아니다. 구성은 아래 표와 6장의 DDL로 다시 만들 수 있다.

**P1 저널 재생 (`kbproto.py`, `gen.py`, `e1_run.py`).** 표준 라이브러리만 쓴다. 시드 42 합성 changeset. 엔티티 N, 주장 3N(노드), 엣지 5N, 주장의 12%에 소급 `valid_from`을 가진 새 버전. 단일 프로세스, 2,000항목씩 커밋, `synchronous=NORMAL`.

| 항목 | N=10,000, 관리형 3.14.10 / SQLite 3.53.1 | N=50,000, 시스템 3.14.4 / SQLite 3.46.1 |
|---|---:|---:|
| 총 항목 | 93,600 | 468,000 |
| 적용 | 1.50초(62,210행/s) | 11.17초(41,889행/s) |
| 재구축(저널 + CAS, LLM·네트워크 없음) | 1.25초 | 9.88초 |
| 내용 지문 일치 | 예 | 예 |
| DB / raw | 26.4 MB / 2.5 MB | 135.6 MB / 12.7 MB |
| 검색 현재 p50 / p95 | 6.2 / 9.6 ms | 38.9 / 68.6 ms |
| 검색 as-of p95 | 9.5 ms | 71.3 ms |
| 이웃 깊이 2 p95, 허브 p95 | 0.19, 0.77 ms | 0.30, 1.35 ms |
| 변경 피드 500행 p95 | 0.43 ms | 0.43 ms |
| 개요 p50(`Claim` 제외) | 19.5 ms | 115 ms |

- N=10,000의 지문 `03b23fd39e7cf4c0`은 시스템 Python(SQLite 3.46.1)과 관리형 Python(SQLite 3.53.1)에서 같았다. SQLite를 올려도 재생 결과가 같다는 약한 근거다.
- 멱등 재전송은 `{'seq': 4, 'replayed': True}`를 돌려줬다.
- raw 크기는 어휘가 작은 합성 텍스트 값이라 대표값이 아니다.

**P2 재생 결함.** 첫 실행은 지문이 불일치했다. 첫 적용은 입력 dict 순서(`{"subject","slot"}`)로, 재생은 정렬된 canonical JSON(`{"slot","subject"}`)으로 `props`를 직렬화한 것이 원인이다. 적용 입력을 canonical 바이트로 통일해 고쳤다. 지문 비교가 실제로 결함을 잡은 사례다.

**P3 세대 교체 (`e2_swap.py`).** 쓰기 프로세스 4개가 `synchronous=FULL`로 도는 동안 저널 재생 → 꼬리 따라잡기 → 옛 세대에 펜스 → 마지막 꼬리 → 포인터 `os.replace`. 라이브 DB 파일은 rename하지 않는다. 두 런타임에서 3회씩 총 6회.

| 항목 | 값 |
|---|---:|
| 회차별 확인 응답 | 1,813~1,964건 |
| 유실, 중복 | 0, 0 |
| 펜스에서 포인터 교체까지 | 0.6~1.0 ms |
| 쓰기 최대 지연 | 34~55 ms |
| 교체 후 재생 지문 | 전부 일치 |

세대당 작은 데이터(N=3,000)이고 교체 중 크래시는 시험하지 않았다. 9장의 펜스 만료는 설계이고 미측정이다.

**P4 인용 게이트와 티켓 병합 (`e3_gate.py`).** 결과는 7.5, 11.4에 있다. Jaccard 표본 5쌍.

**P5 런타임.** `uv venv --python-preference only-managed --python 3.14` + `fastmcp==4.1.4 trafilatura==2.3.1 feedparser yt-dlp==2026.10.26`. 3.14.10, SQLite 3.53.1, zstd 1.5.7, FTS5 `contentless_delete`, JSONB 동작. 약 82패키지, 137 MB. 시스템 Python 위 venv도 같은 크기로 설치됐다. `httpx`는 의존성에 없고 `httpx2`가 있어서 수집 클라이언트를 `urllib`으로 잡았다.

**P6 MCP (`e4_mcp.py`, `e5_surface.py`).**

| 시험 | 결과 |
|---|---|
| `-> str`, 기본값 | `outputSchema` 자동 생성, `structuredContent={"result":"…"}` |
| `-> str`, `output_schema=None` | 텍스트 블록만 |
| `-> dict` | 구조화 결과 |
| `ToolResult`, `output_schema=None` | 텍스트 블록만 |
| 도구 7개 `tools/list` | 5,463 B |
| 콜드(연결 + 목록) | 관리형 0.68~0.89초, 시스템 0.61~0.67초 |
| 유휴 메모리 | RSS 97.8 MB, PSS 86.0 MB |

처음 잰 메모리 1.2 GB는 stdin을 `/dev/zero`로 준 시험 오류여서 폐기하고 잠긴 파이프로 다시 쟀다.

**P7 rtk.** 가짜 HOME, 임시 git 저장소. `HOME`만 격리하면 `~/.local/share/rtk/history.db`가 생긴다. `XDG_DATA_HOME`이나 `RTK_DB_PATH`를 주면 지정 경로로 옮겨지고 HOME에는 남지 않는다. `RTK_DB_PATH`는 부모 폴더가 있어야 파일이 생겼다(첫 실행 rc=0이지만 파일 없음). 설치 스크립트가 `.state/rtk/`를 만들어 둔다. 재작성 표는 17.1에 있다. 훅 입력 JSON을 직접 넣어 시험했고 실제 모델 호출은 없다.

```sh
#!/bin/sh
# ops/hooks/rtk-guard.sh: 읽기 전용 단일 명령만 rtk로 넘긴다
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
case "$cmd" in
  *[\;\&\|\>\<\`\$\(\)]*|*'
'*) exit 0 ;;
esac
case "$cmd" in
  'git status'|'git status '*|'git diff'|'git diff '*|'git log'|'git log '*|'git show'|'git show '*) ;;
  'ls'|'ls '*|'rg '*|'grep '*|'tree'|'tree '*) ;;
  *) exit 0 ;;
esac
printf '%s' "$input" | exec rtk hook claude
```

**P8 실제 피드 종단 (`e6_tick.py`).** C02, O03, U05, U08, C12, C07 각 1회씩 2회차. 시스템 Python 위 venv, 표준 `urllib`, feedparser, 일반 User-Agent(연락처 없음). 결과는 7.2에 있다.

**P9 타이머.** 비공개 systemd 매니저(사용자 네임스페이스, scratchpad XDG 경로, 전용 하위 cgroup). 실제 사용자 매니저는 건드리지 않았다.

| 유닛 | 설정 | 시작 시각(초) |
|---|---|---|
| a | `OnStartupSec=2s`, `OnUnitInactiveSec=3s`, 작업 1초 | 2.3, 6.4, 10.6, 14.7, 18.9 |
| b | `OnStartupSec=2s`, `OnUnitActiveSec=3s`, 작업 5초 | 2.3, 7.4, 12.4, 17.5 |
| c | a와 같은 설정, 9.0초에 활성화 | 9.1, 13.2, 17.4 |

제안 유닛 6개는 `systemd-analyze --user verify`를 통과했다.

**P10 CLI 콜드 (`e7_cli.py`).** N=10,000 DB, 프로세스마다 Python 기동 + 코어 임포트 + 연결 + FTS 검색 + JSON 출력. 40회씩 3라운드, 부하 평균 약 40.

| 런타임 | p50 | p95 | 최대 |
|---|---:|---:|---:|
| 관리형 3.14.10 | 23.7~24.5 ms | 27.0~29.9 ms | 33.5 ms |
| 시스템 3.14.4 | 24.6~25.3 ms | 27.1~28.7 ms | 32.2 ms |

새 바이너리 첫 측정의 p50 76 ms는 재측정에서 재현되지 않아 쓰지 않았다.

**1차 출처 확인(2026-10-31).** SQLite WAL 문서 11장 https://sqlite.org/wal.html , SQLite 변경 이력 https://sqlite.org/changes.html (3.51.3, 3.53.0의 "Fix the WAL-reset database corruption bug."), systemd.timer https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html (`Persistent=`는 `OnCalendar=` 전용, 지난 `OnStartupSec=`는 즉시 만료).

## 부록 B. 이 작업이 남긴 부수 효과

| 대상 | 내용 | 상태 |
|---|---|---|
| `~/.local/bin/python3.14` | `uv python install 3.14`가 scratchpad의 Python을 가리키는 심볼릭 링크를 18:33에 만들었다. 지시 범위 밖의 쓰기다 | 대상과 시각을 확인하고 내가 만든 것임을 확인한 뒤 18:34에 삭제했다. 약 1분간 존재했다 |
| systemd cgroup | 비공개 매니저 시험의 하위 cgroup `kbsimp`(`init.scope` 포함)가 Bash 도구의 tmux scope 아래 남았다 | 비어 있음을 확인하고 깊이 우선으로 제거했다 |
| 공용 tmpfs | 측정 중 최대 약 500 MB 사용 | 산출물을 지웠다. 남은 것은 스크립트 88 KB다 |
| 저장소 | 이 문서만 추가. 커밋 없음 | |
| 전역 설정 | crontab, 실제 사용자 매니저 유닛, Linger, `~/.claude`, 셸 프로필은 변경하지 않았다. `claude -p`는 이 설계 작업에서 호출하지 않았다 | |
