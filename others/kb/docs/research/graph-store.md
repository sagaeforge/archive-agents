# 그래프 중심 저장 계층 조사 (Docker 없는 WSL2)

- 작성일: 2026-10-31. 웹 출처 확인일은 부록 A 표에 출처별로 적었고 전부 2026-10-31이다.
- 표기: `[S번호]`는 부록 A의 출처, `[실측]`은 이 조사에서 직접 잰 값이다. 실행 명령은 9장에 있다.
- 패키지 버전과 날짜는 `https://pypi.org/pypi/<패키지>/json`, 저장소 상태는 `https://api.github.com/repos/<소유자>/<저장소>`를 같은 날 조회한 값이다.
- 성격: 시스템 설계 입력 문서다(CLAUDE.md 지침 5의 예외). 합성 데이터 수치는 평가용이며 지식 데이터로 적재하지 않는다.
- 함께 읽을 문서: `etl-orchestration.md`, `retrieval-serving.md`, `prior-art.md`, `docs/contracts/consumers/sagae-tools.md`. 그쪽에서 이미 잰 사실은 다시 재지 않고 참조했다.

## 0. 요약

- **선택은 엔진보다 서빙 구조에 달려 있다.** 쓰기 프로세스와 읽기 프로세스가 갈라지는 구조에서, 데몬 없이 지원되고 새 커밋이 바로 보인 엔진은 SQLite WAL뿐이다. 읽기 p50은 쓰기 중에도 0.016 ms에서 0.019 ms로 거의 그대로였다 [실측].
- **LadybugDB는 문서와 실제 동작이 다르다.** 쓰기 프로세스가 있어도 읽기 전용 열기가 성공한다. 그러나 메인테이너는 두 프로세스의 파일 공유를 "NOT a supported operation"이라고 못 박았고 [S4], 열어 둔 읽기 프로세스는 새 커밋을 전혀 보지 못했다(13,590개 엣지 추가 동안 51,350에서 멈춤) [실측]. 오류 0건은 동작한다는 뜻이 아니다.
- **단일 프로세스 안에서는 판도가 바뀐다.** HTTP 데몬 하나가 파일을 소유하고 쓰기도 데몬을 거치면 LadybugDB, Grafeo 모두 지원 구성이 된다. LadybugDB 스레드 모드의 읽기 p50은 쓰기 유무와 무관하게 4.1 ms 안팎이었다 [실측].
- **규모가 커질수록 그래프 엔진이 유리한 구간이 있다.** 2-hop은 SQLite가 가장 빠르지만(p50 0.012 ms), 허브 3-hop은 25만 엣지에서 SQLite 238.7 ms, LadybugDB 43.4 ms, FalkorDB 17.3 ms로 뒤집힌다. 10K에서 5배 키우자 SQLite는 약 14배, LadybugDB는 약 6배 늘었다 [실측].
- **기본값으로 쓰면 데이터를 잃는 후보가 있다.** FalkorDBLite 기본 설정(`appendonly no`)에서 `kill -9`하자 확인 응답을 받은 2,000개 노드가 전부 사라졌다. AOF를 켜면 전부 살아남았다 [실측].
- **나머지 엔진의 `kill -9` 복구는 3회 모두 유실 0건이다**(SQLite, LadybugDB, DuckDB, FalkorDB+AOF, Grafeo) [실측]. 전원 손실은 재지 않았다.
- **한글 전문검색은 토큰을 엔진 앞에서 만들면 다섯 엔진 모두 된다.** 다만 소비자 계약의 스니펫과 하이라이트까지 맞추려면 사전 토큰화 컬럼으로는 부족하다. 스니펫이 `유튜 튜브 브쇼 [쇼츠]`처럼 깨진다. SQLite는 apsw Python 토크나이저로 원문 스니펫을 얻었다 [실측]. FTS5 trigram은 2음절 낱말의 재현율이 0이다 [실측].
- **소비자 계약 목표는 이 규모에서 전 엔진이 여유 있게 넘는다.** 1만 노드·5만 엣지 전체 조회가 27.5~132.9 ms였다 [실측]. 성능은 선택 기준이 되지 못하고, 동시성·내구성·운영이 기준이 된다.
- **측정 한계:** 공용 tmpfs에서 쟀다. fsync 비용이 빠져 있으므로 쓰기 처리량은 상한값이다. 대신 하드웨어와 무관한 커밋당 fsync 횟수를 함께 쟀다(5.6절).

## 1. 측정 환경, 조건, 한계

### 1.1 환경

| 항목 | 값 |
|---|---|
| 장비 | WSL2, Linux 6.18.54.1, 24 CPU, RAM 30 GB, Ubuntu 26.04.1, glibc 2.43 |
| Python | uv 관리형 CPython 3.13.18, 표준 `sqlite3`는 SQLite 3.53.1(FTS5, DBSTAT, 확장 로드 가능) |
| 데이터 위치 | `/tmp` 아래 scratchpad. **16 GB tmpfs이고 병렬 작업자가 공유한다** |
| 데몬 | Docker 없음, Java 없음, 비밀번호 없는 sudo 없음. gcc, make는 있고 cmake는 없음 |

측정 버전은 다음과 같다.

| 구성 | 버전 |
|---|---|
| LadybugDB | `ladybug` 0.22.1, 확장 fts·vector는 `extension.ladybugdb.com`에서 내려받음 |
| SQLite | SQLite 3.53.1, `sqlite-vec` 0.1.9, `apsw` 3.54.1.0, `graphqlite` 0.12.0 |
| FalkorDB | `falkordblite` 0.11.0 안의 FalkorDB v4.22.1(module ver 42201), Redis 8.10.2, `redis` 8.1.0 |
| DuckDB | 2.0.0, duckpgq `9c11bc192a`, fts `223b8cb9e6` |
| Grafeo | 0.6.0 |
| 토크나이저 | `kiwipiepy` 0.24.1, 모델 0.24.0 [S48] |

### 1.2 합성 데이터

`gen_data.py`로 시드 42에서 결정적으로 만든다. 기본 규모는 노드 1만, 엣지 5만이다.

- 노드: `id, kind, name, text, first_seen, last_seen`. `text`는 받침 규칙을 지킨 조사를 70% 붙이고 30%는 맨 명사로 둔 한국어 2~3문장이다.
- 엣지: `id, src, dst, rtype, weight, source_url, valid_from, valid_to, recorded_at, expired_at`. 시작점은 절반이 Zipf(지수 0.85), 끝점은 Zipf라 허브가 있다. 유효시간은 25%가 닫혀 있고, 거래시간은 10%가 만료돼 있다.
- 쓰기 부하: 트랜잭션 하나가 새 엣지 90개, 기존 엣지 10개 만료, 노드 20개 갱신이다. 스케줄러의 증분 적재를 흉내 낸다.
- 해시: `nodes.csv` `9ec36c4166efb69d`, `edges.csv` `46f9b483cd50b029`(sha256 앞 16자).

### 1.3 결과 검증

엔진별 하네스가 맞는 답을 내는지 확인하려고 합계 체크섬을 비교했다. **전 엔진이 일치했다** [실측].

| 질의 | 10K/50K | 50K/250K |
|---|---:|---:|
| 2-hop 고유 도달 수 합(균일 시작 1,000개) | 119,690 | 266,260 |
| 2-hop 행 질의 합 | 38,594 | |
| 바이템포럴 as-of 2-hop 합 | 18,624 | 39,609 |
| 허브 2-hop 합(50개) | 66,740 | 391,193 |
| 3-hop 합(균일 200개) | 286,327 | 1,136,001 |
| 3-hop 합(허브 20개) | 115,862 | 581,350 |

SQL/PGQ 경로(시작점 200개)는 22,550으로 일반 SQL과 같았고, GraphQLite(시작점 300개)는 33,975로 SQLite와 같았다.

### 1.4 측정 한계

- **tmpfs라서 fsync가 사실상 무비용이다.** 운영 지침상 임시 데이터는 scratchpad에 둬야 해서 ext4에서 재지 않았다. 적재와 쓰기 처리량은 상한값이고, `synchronous=FULL`이 `NORMAL`보다 느리지 않게 나온 것도 그 때문이다. 하네스의 DB 경로 인자만 바꾸면 ext4에서 다시 잴 수 있다.
- **공용 머신이다.** 실행 시작 시 부하 평균이 2.8~23.8로 흔들렸고 CPU 격리가 없다. 수 ms 이하 차이는 해석하지 않는다.
- **`kill -9`는 프로세스 크래시만 재현한다.** 전원 손실, OS 크래시, WSL 강제 종료는 재지 않았다.
- **합성 코퍼스의 어휘는 작다.** 주제어 30개와 복합어 10개다. 정답을 부분 문자열로 정의해 n-gram 계열에 유리하다. 실제 순위 품질은 `retrieval-serving.md` 5.1절을 따른다(bigram과 Kiwi가 세 데이터셋에서 통계적으로 구분되지 않음).

### 1.5 폐기한 측정과 부수 효과

- **코퍼스 1차본 폐기.** 받침을 무시하고 조사를 붙여(`트래픽가`) 형태소 분석기가 부당하게 불리했다. 문법을 고치고 맨 명사를 넣어 다시 만들었다.
- **SQLite 1차 실행 폐기.** 다른 작업자가 tmpfs를 채워 0 MB가 되면서 부분 파일이 남았다.
- **FalkorDB 초기 두 실행 폐기.** 첫 실행은 scratchpad 경로가 AF_UNIX 108바이트 제한을 넘었고, 둘째는 내 스크립트의 변수 충돌로 서버를 먼저 내렸다. 둘 다 엔진 문제가 아니다.
- **비교 왜곡 정정.** SQLite 무제한 쓰기가 실행 중 그래프를 5만에서 75만 엣지로 키워 읽기가 느려 보였다. 전 엔진을 고정 10 tx/s로 다시 쟀다(5.4절).
- **tmpfs 0 MB 구간이 있었던 실행 두 건**(SQLite 본 실행, Grafeo 본 실행)은 쓰기 오류 0건과 `integrity_check` ok를 확인하고 채택했다. Grafeo 크래시 시험은 여유 공간이 충분할 때 다시 돌렸다.
- **`~/.lbdb` 생성 후 삭제.** LadybugDB 첫 프로브가 `HOME` 격리 전에 실행돼 저장소 밖에 확장을 내려받았다. 31초 전에 생긴 디렉터리이고 내용이 그 프로브의 확장 4개임을 확인한 뒤 지웠다. 이후 모든 엔진은 `HOME`을 scratchpad로 돌렸고, 종료 시 `~/.lbdb`, `~/.duckdb`가 없음을 확인했다.

## 2. 설계를 가르는 제약

### 2.1 서빙 구조별 지원 여부

아직 확정되지 않은 구조가 세 가지 있다. `etl-orchestration.md`는 상시 서버 없는 systemd 타이머 조합을 제시했고, `sagae-tools` 계약은 HTTP 읽기 API를 1순위로 요구하며 DB 파일 직접 접근을 원하지 않는다. `retrieval-serving.md`는 HTTP 데몬이 세션 기동과 메모리에서 유리하다고 쟀다(세션 8개 4,794 MB 대 597 MB).

| 엔진 | A. 데몬 없음. 세션별 stdio 읽기 + 타이머 쓰기 | B. HTTP 데몬 읽기 + 별도 타이머가 같은 파일에 쓰기 | C. 모든 읽기·쓰기가 데몬 한 프로세스 경유 |
|---|---|---|---|
| SQLite WAL | **지원, 실측** | **지원, 실측** | 지원 |
| GraphQLite(SQLite) | 동작 실측 | 동작 실측 | 지원 |
| LadybugDB | 미지원 [S4]. 스냅샷 교체로만 가능 | 미지원. 스냅샷 교체로만 가능 | **지원, 스레드 실측** |
| Grafeo | 잠금으로 거부 [실측] | 잠금으로 거부 [실측] | 스레드 실측. Grafeo Server는 미측정 |
| DuckDB 임베디드 | 잠금으로 거부 [실측] | 잠금으로 거부 [실측] | 지원 |
| DuckDB + Quack | 해당 없음(서버 필요) | Quack 서버 경유로 실측 | Quack 서버 실측 |
| FalkorDB | 해당 없음(서버 필요) | 서버 경유로 실측 | 서버 실측 |

`etl-orchestration.md`의 적재기는 dlt이고 쓰기는 별도 프로세스다. HTTP 데몬을 둬도 적재가 파일에 직접 쓰면 구조 B가 된다. LadybugDB나 Grafeo를 주 저장소로 쓰려면 적재 결과를 데몬의 쓰기 API로 넣거나 스냅샷을 교체해야 한다.

### 2.2 상시 프로세스의 수명

- WSL 유휴 판정에 systemd 서비스가 들어가지 않고, Windows 쪽 클라이언트가 없으면 distro가 내려간다(`etl-orchestration.md` 5.2절). 기본값은 `instanceIdleTimeout` 15,000 ms, `vmIdleTimeout` 60,000 ms다 [S47].
- 서버형 저장소는 distro와 함께 죽는다. 따라서 FalkorDB나 Quack을 쓰면 "항상 떠 있음"이 아니라 "필요할 때 띄워서 복구"를 전제해야 한다. FalkorDB AOF 재시작은 276,710 엣지에서 1.6초였다 [실측].
- 임베디드 엔진은 기동 지연이 작다. LadybugDB 읽기 전용 열기와 첫 질의가 106.9 ms였다 [실측].

### 2.3 파일 위치

SQLite WAL은 공유 메모리를 쓰므로 모든 프로세스가 같은 호스트에 있어야 하고 네트워크 파일시스템에서 동작하지 않는다 [S24]. 운영 DB는 WSL 내부 ext4에 둬야 하며 `/mnt/c`의 DrvFs에 두면 안 된다. tmpfs도 재부팅에 사라지므로 안 된다.

### 2.4 DuckDB 버전 묶임

dlt 1.32.0은 `duckdb<2`로 묶여 있다(`etl-orchestration.md` M12). 이 조사의 DuckDB 수치는 2.0.0 기준이고, dlt와 함께 쓰려면 1.5.x가 된다. DuckPGQ 호환표에는 1.5.5, 1.5.6도 있다 [S18]. 1.5.x에서는 재지 않았다.

## 3. 후보 표

"이 환경 적합성"은 Docker 없음, Python 휠, 구조 A~C 지원, 내구성을 합친 평가다.

| 후보 | 최신 버전 | 릴리스 날짜 | 유지보수 상태 | 라이선스 | Python 휠 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|---|---|
| **SQLite + FTS5 + sqlite-vec** | SQLite 3.54.1, sqlite-vec 0.1.9 (0.1.10-alpha.4) | 2026-10-16, 2026-03-31 (2026-05-18) | SQLite 활발 [S23]. sqlite-vec 코드 푸시 2026-05-18 이후 정체 [S27] | 퍼블릭 도메인, MIT/Apache-2.0 | apsw cp311~315, sqlite-vec py3 manylinux | **상.** 구조 A~C 전부 지원, 한 파일 | Cypher 없음. 벡터 안정판은 전수 검색 |
| GraphQLite | 0.12.0 | 2026-10-17 | 매우 활발. 2025-07 생성, 커밋 126개 중 118개가 1인 [S29] | MIT | py3 manylinux | 중. SQLite 위 Cypher, WAL 읽기 동작 | 베타, 1인 의존, EAV로 크기 큼, FTS 없음 |
| **LadybugDB** | 0.22.1 | 2026-10-28 | 매우 활발. 푸시 10-30, ★1.9K, 포크 168 [S1] | MIT | cp310~314 manylinux | **중.** 구조 C 또는 스냅샷 읽기 전용 | 다중 프로세스 공유 미지원 [S4], 저장 안정성 이슈 열림 [S6], 확장 다운로드, `algo` 로드 실패 |
| Kuzu | 0.11.3 | 2025-10-10 | **보관 처리.** Apple 인수 [S9][S10] | MIT | cp37~314 | 하. 신규 채택 부적합 | 죽은 저장소 |
| Kuzu 포크들 | Vela v0.12.0, RyuGraph 25.9.2, Bighorn | 2026-06-14, 2025-12-06, 없음 | Vela 소규모(★51), RyuGraph 정체, Bighorn 보관 [S11] | MIT | Vela는 PyPI 없음 | 하 | 지속성 불확실 |
| **FalkorDB / FalkorDBLite** | 서버 6.0.3, 4.22.3, Lite 0.11.0(내장 4.22.1) | 2026-10-22, 10-28, 10-19 | 매우 활발. ★10.5K [S12]. 6.0은 Rust 재작성 [S13] | SSPLv1, Lite 래퍼 BSD, Redis 8은 RSALv2/SSPLv1/AGPLv3 택일 [S17] | Lite cp312~314 manylinux_2_38 | **중.** 서버 프로세스 전제 | 기본값 유실 위험, 전체 RAM 상주 [S15], SSPL, 다중 쿼리 트랜잭션 없음 [S14] |
| DuckDB + DuckPGQ | 2.0.0, duckpgq `9c11bc19` | 2026-10-21, 2026-10-26 | DuckDB 활발(LTS 2027-10 이상). DuckPGQ는 "research project" [S19] | MIT | cp311, cp312-abi3 | 중. ELT와 분석에 적합, 그래프 주 저장소로는 약함 | 다른 프로세스 읽기 거부, FTS UPDATE 미반영 [실측], VSS 영속화 운영 비권장 [S21], dlt `duckdb<2` |
| Grafeo | 0.6.0 | 2026-10-23 | 매우 활발. 2026-01 생성, 커밋 2,104개 중 1,977개(94%)가 1인 | Apache-2.0 | cp312-abi3 manylinux | 중. 기능은 가장 잘 맞고 성숙도가 부족 | v1 이전, 1인 의존, 쓰기 중 타 프로세스 읽기 거부, 허브 3-hop 느림 |
| Neo4j Community | 2026.10 | 2026-10 | 활발 | GPLv3 [S34] | 드라이버만 | 하. 미설치 | Java 21/25 필요 [S33], Java 없음. Community는 dump가 오프라인 전용 [S35] |
| Memgraph | 3.14.0 | 2026-10-21 | 매우 활발 | BSL 1.1 + MEL, 2030 Apache-2.0 전환 [S38] | `pymgclient`만 | 하. 미설치 | deb/rpm 또는 소스 [S36], sudo 없음. 기본 인메모리 모드 [S37] |
| CozoDB | 0.7.6 | 2023-12-11 | **정체.** 마지막 커밋 2024-12-04, PR 무응답 [S39] | MPL-2.0 | cp37-abi3 | 하 | 유지보수 중단 상태 |
| Oxigraph | 0.5.13 | 2026-10-22 | 활발 | MIT 또는 Apache-2.0 | cp39-abi3 | 하. RDF 전용 | FTS·벡터 없음, 쓰기 중 read-only 열기는 "undefined behavior" [S40], 디렉터리 저장 |
| TerminusDB | 12.0.9 (12.1-rc1) | 2026-10-28 | 활발. Gettier 팀 유지 | Apache-2.0 | 클라이언트만(`terminusdb` <3.13) | 하. 미설치 | Docker 또는 소스 빌드 경로뿐이고 cargo, swipl 없음 [S41] |
| PostgreSQL + AGE | PG18/v1.8.0-rc0, PG15/v1.8.0-rc0 | 2026-07-09, 2026-09-19 | 활발, 릴리스는 rc | Apache-2.0 | `apache-age-python` 0.0.7(2023) | 하. 미설치 | PostgreSQL 없음, sudo 없음. `pgembed`에 AGE 없음 [S43], 서버 프로세스 필요 |
| Graphiti | 0.31.2 | 2026-10-20 | 매우 활발. ★32.4K | Apache-2.0 | py3 | 저장소 아닌 계층. 스키마 참고용 | LLM·임베더 필수, `add_triplet`도 LLM 호출 [S45]. Kuzu 드라이버 폐기 예정 [S44] |
| Cognee | 1.6.6 | 2026-10-29 | 매우 활발. ★32.9K | Apache-2.0 | py3 | 저장소 아닌 계층 | LLM 키 전제. 기본 그래프가 ladybug [S46] |
| ArcadeDB | 26.10.2, 임베디드 26.10.2.post1 | 2026-10-15, 10-22 | 매우 활발 | Apache-2.0 | JRE 내장 휠 cp310~314 | 미평가 | 미측정. 멀티 프로세스 동작 미확인 |
| SurrealDB | 3.3.5, Python 2.0.0 | 2026-10-29, 2026-04-23 | 활발 | BSL 1.1 | abi3 | 미평가 | Python SDK 3.x는 베타 |
| Turso Database | 0.8.3 (0.9 pre) | 2026-10-12 | 매우 활발, v1 이전 | MIT | cp310-abi3 | 관찰 대상 | FTS와 벡터 색인이 experimental [S42] |
| XTDB | 2.2.0 | 2026-10-21 | 활발 | MPL-2.0 | 없음 | 하 | 그래프 엔진 아님, JVM. 바이템포럴 참고용 |

제외한 것: Dolt(그래프 아님), TypeDB(FTS·벡터 없음, 서버), HelixDB(객체 저장소 지향), Dgraph(분산 구성), lance-graph, sqlite-graph(알파).

## 4. 평가 축 표

측정 후보 여섯 개만 적는다. 수치는 5장에 있다.

| 축 | SQLite | GraphQLite | LadybugDB | FalkorDB | DuckDB | Grafeo |
|---|---|---|---|---|---|---|
| 쓰기 중 타 프로세스 읽기 | 지원 | 동작 | 미지원 | 서버 경유 | Quack 경유 | 거부 |
| 새 커밋 가시성 | 즉시 | 즉시로 추정 | 재오픈 필요 | 즉시 | 즉시 | 스레드 내 미측정 |
| 쓰기 모델 | 단일 쓰기 | 단일 쓰기 | 단일 쓰기 [S5] | 그래프당 단일, FIFO [S14] | 프로세스 내 낙관적 [S20] | 프로세스 내 MVCC [S31] |
| 다중 문장 트랜잭션 | 있음 | 있음 | 있음 | **없음** [S14] | 있음 | 있음 |
| 질의 언어 | SQL, 재귀 CTE | Cypher | Cypher | Cypher | SQL, SQL/PGQ | GQL, Cypher 외 |
| 바이템포럴 난이도 | 낮음 | 중간 | 중간 | 중간 | 낮음 | 낮음~중간 |
| FTS | 내장, 쓰기 동기화는 트리거 | 없음 | 확장, 자동 갱신 | 내장, 자동 갱신 | 확장, UPDATE 미반영 | 내장, 자동 갱신 |
| 한글 토크나이저 내장 | 없음(앞단 또는 Python 토크나이저) | 없음 | 없음 | 없음 | 없음 | `cjk_bigram` |
| 벡터 | sqlite-vec 전수 | 없음 | HNSW 확장 | HNSW 내장 | VSS 실험적 | HNSW 내장 |
| 재구축(10K/50K, FTS 포함) | 0.23초 | 1.35초(FTS 없음) | 1.38초 | 1.07초 | 0.53초 | 1.36초 |
| 상시 프로세스 | 불필요 | 불필요 | 불필요 | **필요** | 불필요(Quack 시 필요) | 불필요 |
| 파일 하나 백업 | 온라인 `VACUUM INTO` 실측 | 같음 | 정지 또는 체크포인트 후 복사 | RDB 한 파일. AOF는 디렉터리 | 정지 후 복사 | `save`, `backup_full` 문서상 온라인 [S32], 미측정 |
| 이식 가능 덤프 | SQL, 파일 그대로 | 파일 그대로 | `EXPORT DATABASE`(Parquet + Cypher), FTS 유지 실측 | RDB | Parquet | 미측정 |

바이템포럴 난이도는 6장에서 설명한다.

## 5. 실측 결과

### 5.1 적재와 디스크

전체 시간은 3회 중앙값이고, 각 엔진의 FTS 색인 생성까지 포함한다. LadybugDB·SQLite·DuckDB·Grafeo는 tokenizer별로 색인을 3~4개 만들었고 FalkorDB는 필드 3개짜리 색인 1개다. 크기 비교는 그 차이를 감안해야 한다 [실측].

| 엔진 | 전체 적재 | 노드+엣지만 | 디스크 | 파일 수 | 방식 |
|---|---:|---:|---:|---:|---|
| SQLite | 0.225 s | 0.125 s | 16.1 MB | 1 | 한 트랜잭션 `executemany`, B-tree 2, FTS5 4 |
| DuckDB | 0.532 s | 0.129 s | 20.5 MB | 1 | `COPY`, ART 2, FTS 4 |
| FalkorDB | 1.069 s | 0.76 s | RAM 47.1 MB, RSS 226 MB | 해당 없음 | `UNWIND` 배치 |
| GraphQLite | 1.35 s | 1.33 s | 55.5 MB(WAL 23.9 MB 포함) | 3 | `insert_*_bulk`, FTS 없음 |
| Grafeo | 1.36 s | 0.70 s | 11.4 MB | 1 | 배치 API, FTS 4 |
| LadybugDB | 1.38 s | 약 0.3 s | 46.5 MB | 1 | `COPY`, FTS 3 |

- SQLite는 FTS 색인 4개를 합쳐도 16.1 MB다. 객체별로 entity 5.6 MB, edge 4.3 MB, trigram 1.7 MB, bigram 0.9 MB, Kiwi 0.4 MB다.
- 재구축 시간은 형태소 분석이 지배할 수 있다. Kiwi는 문서 1,262~2,165건/초, bigram은 112,326~134,092건/초다. 10K 기준 Kiwi만 약 5~8초로 DB 적재보다 길다.

5배 규모(5만 노드, 25만 엣지) 값이다 [실측].

| 엔진 | 전체 적재 | 디스크 | 비고 |
|---|---:|---:|---|
| SQLite | 1.34 s | 82.1 MB | |
| DuckDB | 1.75 s | 72.9 MB | |
| LadybugDB | 4.11 s | 179.3 MB | |
| Grafeo | 5.59 s | 57.4 MB | |
| FalkorDB | 5.72 s | RAM 219 MB, RSS 614 MB | RDB 27.4 MB |

### 5.2 그래프 순회

한 프로세스 단일 스레드 값이다. 단위는 ms, FalkorDB는 루프백 TCP 왕복을 포함한다. 시작점 1,000개이고 경유 노드 수가 작은 것이 많아 p50이 낮다 [실측].

| 엔진 | 2-hop p50 / p95 / p99 | as-of 2-hop p50 / p95 / p99 | 허브 2-hop p50 / p95 / p99 |
|---|---|---|---|
| SQLite | 0.012 / 0.043 / 0.093 | 0.013 / 0.065 / 0.127 | 0.237 / 0.627 / 0.731 |
| Grafeo | 0.078 / 0.297 / 0.56 | 0.04 / 0.138 / 0.248 | 1.156 / 2.723 / 3.206 |
| GraphQLite | 0.214 / 0.896 / 1.722 | 0.435 / 3.78 / 7.482 | 4.87 / 11.508 / 15.019 |
| FalkorDB | 0.496 / 0.672 / 0.819 | 0.529 / 0.715 / 0.886 | 0.961 / 1.497 / 1.635 |
| DuckDB SQL | 1.842 / 2.771 / 3.791 | 3.922 / 4.658 / 5.195 | 2.695 / 5.776 / 6.263 |
| DuckDB SQL/PGQ | 2.07 / 3.05 / 3.937 | | |
| LadybugDB | 2.186 / 4.006 / 5.042 | 3.243 / 4.878 / 5.434 | 2.294 / 3.648 / 3.89 |

LadybugDB는 준비된 문장을 써도 2-hop p50이 1.978 ms다. 계획 비용보다 실행 경로의 고정 비용이 크다. GraphQLite는 시작점 300개다.

깊은 순회는 결과가 달라진다. 3-hop p50(ms)이다 [실측].

| 엔진 | 균일 200개 10K→50K | 허브 20개 10K→50K | 허브 증가 배수 |
|---|---:|---:|---:|
| FalkorDB | 1.25 → 3.83 | 4.16 → 17.26 | 4.2배 |
| DuckDB | 5.39 → 10.51 | 7.15 → 29.73 | 4.2배 |
| LadybugDB | 3.42 → 2.79 | 7.21 → 43.42 | 6.0배 |
| SQLite | 0.48 → 1.31 | 16.57 → 238.67 | 14.4배 |
| Grafeo | 3.32 → 6.60 | 115.31 → 1,406.28 | 12.2배 |

- 균일 시작점은 SQLite가 여전히 앞선다. 허브에서 거꾸로다. 지식 그래프의 "유튜브" 같은 허브 노드가 바로 이 경우다.
- SQLite는 25만 엣지에서도 p50 238.7 ms, 최대 421.2 ms라 쓸 수는 있으나, 증가율이 커서 규모를 더 키우면 계약 목표(p95 200 ms)를 넘는다. 25만 엣지 허브 3-hop p95가 이미 363.3 ms다.
- Grafeo는 2-hop이 빠른 대신 허브 3-hop이 가장 느리다. 문서에 "each query runs on one thread"라고 적혀 있다 [S30].

### 5.3 한글 전문검색

정답은 원문 부분 문자열 일치다(대소문자 무시). 수치는 재현율이다. 같은 토큰을 주면 재현율은 SQLite, LadybugDB, FalkorDB, DuckDB, Grafeo에서 동일했다 [실측].

| 질의 | 성격 | 정답 수 | 공백 토큰 원문 | FTS5 trigram | Kiwi 사전 없음 | Kiwi + 사전 14개 | bigram AND |
|---|---|---:|---:|---:|---:|---:|---:|
| 알고리즘 | 4음절 + 조사 | 2,209 | 0.324 | 1.000 | 1.000 | 0.995 | 1.000 |
| 유튜브 | 3음절 + 조사·복합 | 2,876 | 0.243 | 1.000 | 0.813 | 1.000 | 1.000 |
| 쇼츠 | 2음절, 복합어 내부 포함 | 2,806 | 0.252 | **0.000** | 0.717 | 1.000 | 1.000 |
| 광고 | 2음절, 복합어 내부 포함 | 2,937 | 0.253 | **0.000** | 1.000 | 0.997 | 1.000 |
| 최적화 | 복합어 내부만 | 853 | 0.000 | 1.000 | 1.000 | 0.961 | 1.000 |
| 숏폼 | 2음절, 복합어 내부만 | 859 | 0.000 | **0.000** | 0.205 | 1.000 | 1.000 |
| 키워드분석 | 복합어 전체 | 877 | 1.000 | 1.000 | 0.998 | 0.990 | 1.000 |
| youtube | 라틴 | 519 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |

- 정밀도는 대부분 1.000이다. 예외는 Kiwi의 `키워드분석`(0.5425)으로, `키워드`와 `분석`이 떨어져 있어도 맞는다. bigram은 AND·구문 모두 1.000이다.
- trigram의 0은 명세대로다 [S25]. "3자 미만 부분 문자열은 일치하지 않는다"는 동작이 `retrieval-serving.md`에서도 재현됐다.
- Kiwi는 신조어에 약하고 사전으로 고친다. 사전을 넣으면 다른 낱말이 조금 흔들린다(`최적화` 0.961).
- FalkorDB 원문 접두 검색 `유튜브*`는 사전 토큰화 없이 조사 붙은 형태를 잡았다(재현율 1.000). 복합어 내부(`최적화`)는 못 잡는다.
- Grafeo `cjk_bigram`은 엔진 내장이고 재현율 1.000이지만 질의가 OR라서 `키워드분석` 정밀도가 0.153이다.
- DuckDB는 기본 설정에서도 한글 공백 토큰이 검색됐다(재현율이 원문 열과 동일).

엔진별 지연이다. bigram으로 8개 질의를 전부 가져온 범위(ms)이고 Grafeo는 OR다 [실측].

| 엔진 | 범위 |
|---|---:|
| Grafeo | 0.11~1.49 |
| SQLite | 0.31~2.12 |
| FalkorDB | 0.70~4.34 |
| LadybugDB | 3.54~9.73 |
| DuckDB | 12.67~21.20 |

**스니펫과 하이라이트.** 계약은 "스니펫과 하이라이트 위치"를 요구한다. 사전 토큰화 컬럼은 검색은 되지만 표시가 깨진다. SQLite에서 비교했다 [실측].

| 방식 | `snippet()` 결과 | 재구축 | 재현율·정밀도 |
|---|---|---:|---:|
| 사전 토큰화 컬럼 + unicode61 | `…유튜 튜브 유튜 튜브 브쇼 [쇼츠] 확인 인된 된다 shorts 썸네 네일…` | 0.024 s | 1.000 |
| apsw Python 토크나이저(원문 색인) | `…유튜브 유튜브[쇼츠] 확인된다. Shorts 썸네일…` | 0.129 s | 1.000 |

- Python 토크나이저는 원문 오프셋을 FTS5에 넘기므로 `snippet()`, `highlight()`가 원문 위에서 동작한다. 질의는 구문으로 처리돼 정확한 부분 문자열 의미가 된다.
- 대가가 있다. 토크나이저를 등록하지 않은 연결은 `no such tokenizer: ko_bigram`으로 실패했다 [실측]. 모든 읽기 프로세스가 apsw로 같은 토크나이저를 등록해야 하고, 표준 `sqlite3` 모듈만으로는 읽을 수 없다.
- 다른 길은 `lindera-sqlite` 같은 C ABI 확장이다 [S28]. 재지 않았다. 다른 엔진은 사전 토큰화 시 원문 하이라이트를 앱에서 다시 계산해야 한다.
- FTS 갱신은 SQLite(트리거), LadybugDB, FalkorDB에서 INSERT·SET·DELETE가 모두 반영됐다 [실측]. DuckDB는 기본 색인이 갱신되지 않고 [S22], `incremental=1`은 INSERT만 반영하고 UPDATE는 옛 토큰으로 남았다 [실측].

### 5.4 쓰기 중 동시 읽기

이 조사의 핵심이다. 고정 10 tx/s로 쓰고(15초면 엣지 약 13,590개 추가), 읽기는 2-hop과 FTS를 3:1로 섞어 연속 실행했다. 기준선은 쓰기 없는 같은 읽기다 [실측].

표를 읽을 때 조건이 조금씩 다르다. Grafeo와 GraphQLite는 12초를 썼고, GraphQLite 쓰기는 엣지 90개만이며 기준선은 단일 프로세스 값이다. LadybugDB 재오픈 행은 고정 속도 없이 돌렸고 쓰기는 약 12 tx/s였다.

| 엔진·방식 | 읽기 위치 | 지원 여부 | 2-hop p50 기준선→쓰기 중 | p99 기준선→쓰기 중 | 오류 | 읽기가 본 엣지 수 |
|---|---|---|---:|---:|---:|---|
| SQLite WAL | 별도 프로세스 2개 | 공식 | 0.016 → 0.019 | 0.113 → 0.147 | 0 | 50,540 → 62,240 **실시간** |
| GraphQLite WAL | 별도 프로세스 2개 | 공식(SQLite) | 0.214 → 0.235 | 1.72 → 2.06 | 0 | 미측정 |
| FalkorDB 서버 | 별도 프로세스 2개 | 공식 | 0.52 → 0.56 | 0.87 → 1.25 | 0 | 50,540 → 62,240 **실시간** |
| DuckDB Quack | 별도 프로세스 2개 | 공식 | 6.36 → 5.8 | 10.5 → 8.3 | 0 | 50,450 → 62,240 **실시간** |
| LadybugDB | 같은 프로세스 스레드 4개 | 공식 | 4.05 → 4.18 | 8.3 → 8.8 | 0 | 미측정 |
| Grafeo | 같은 프로세스 스레드 4개 | 공식 | 0.18 → 0.19 | 1.46 → 1.5 | 0 | 미측정 |
| LadybugDB read_only 유지 | 별도 프로세스 2개 | **미지원** | 2.52 | 5.2 | 0 | 51,350 → 51,350 **멈춤** |
| LadybugDB 질의마다 재오픈 | 별도 프로세스 1개 | **미지원** | 171.8 | 1,305 | 0 | 질의마다 갱신 |
| DuckDB 임베디드 | 별도 프로세스 | 거부 | | | `Could not set lock on file` | |
| Grafeo 임베디드 | 별도 프로세스 | 거부 | | | `database file cannot be locked for reading` | |

- DuckDB Quack의 읽기 FTS 자리는 `LIKE`로 대체했다. FTS 함수의 Quack 경유 동작은 재지 않았다. 파라미터 바인딩도 실패해(`Values were not provided for the following parameters: 1`) 리터럴을 직접 넣었다. 이 기준선은 쓰기 구간보다 나쁘게 나왔는데 공용 머신의 잡음으로 본다.
- DuckDB Quack 쓰기 커밋 p50은 21.6 ms다. 임베디드 묶음 쓰기의 6.7 ms보다 크다.
- 10 tx/s 쓰기 중 FTS p99는 SQLite 1.4 ms, Grafeo 스레드 2.2 ms, FalkorDB 8.4~9.2 ms, LadybugDB 스레드 15~16 ms(기준선 13~14 ms)였다. LadybugDB 읽기 전용 별도 프로세스의 약 11 ms는 멈춘 스냅샷을 읽은 값이라 비교 대상이 아니다.

쓰기 최대 처리량이다. tmpfs 상한값이고 트랜잭션 구성이 조금씩 다르다 [실측].

| 엔진 | tx/s | 커밋 p50 | 조건 |
|---|---:|---:|---|
| Grafeo | 577 | 1.49 ms | 스레드. 엣지 90개와 노드 20개가 21개 개별 커밋, 만료 10개 없음 |
| SQLite | 518 | 1.73 ms | 읽기 프로세스 2개 동시. 그래프가 75만 엣지까지 증가 |
| FalkorDB | 197 | 4.90 ms | 읽기 프로세스 2개 동시. 문장 3개가 각각 원자적 |
| DuckDB 임베디드 | 146 | 6.65 ms | 쓰기 단독, DataFrame 묶음 삽입 |
| LadybugDB | 15.4 | 64.0 ms | 스레드, 만료 10개 없음 |

**LadybugDB 쓰기가 느린 이유.** 트랜잭션을 나눠 보니 엣지 90개 `UNWIND…MATCH…CREATE`가 56.3 ms로 대부분이고, 커밋은 0.38 ms다. 준비된 문장도 줄이지 못했다(62.3 ms). 증분 엣지 삽입이 1개당 약 0.6 ms라는 뜻이다. 대량 적재는 `COPY`가 빠르다(5만 엣지 약 0.2초). 스케줄러 증분 적재를 그대로 넣기보다 묶어서 `COPY`로 다시 만드는 쪽이 맞는 엔진이다 [실측].

**LadybugDB 스냅샷 교체.** 체크포인트 5.0 ms, 파일 복사와 rename 63.5 ms(46.5 MB, tmpfs), 읽기 전용 열기와 첫 질의 106.9 ms였다 [실측]. 쓰기 프로세스와 파일을 공유하지 않으므로 다중 `READ_ONLY`로 지원 범위에 든다. 신선도는 게시 주기로 결정된다. `etl-orchestration.md` M17이 DuckDB로 같은 방식을 쟀다.

### 5.5 크래시와 내구성

쓰는 프로세스(FalkorDB는 서버)를 `kill -9`하고 재시작해서, 확인 응답 받은 트랜잭션 수와 복구된 엣지 수를 비교했다. 세 번 돌렸다 [실측].

| 엔진 | 설정 | 라운드별 확인된 tx | 유실 | 비고 |
|---|---|---|---:|---|
| SQLite | WAL, `synchronous=NORMAL` | 1,356 / 1,983 / 2,708 | 0 | `integrity_check` ok |
| LadybugDB | 기본 | 14 / 24 / 26 | 0 | WAL 재생 |
| DuckDB | 기본 | 43 / 53 / 69 | 0 | WAL 재생 |
| Grafeo | 기본(Batch) | 1,378 / 2,179 / 2,673 | 0 | 재오픈 630~1,091 ms |
| FalkorDB | AOF `everysec` | 537 / 799 / 1,091 | 0 | |
| **FalkorDBLite** | **기본값** | 2,000개 노드 확인 | **전부** | `appendonly no`, 저장 규칙 `900 1 300 100 60 200 15 1000` |
| FalkorDBLite | `serverconfig={"appendonly":"yes"}` | 2,000개 노드 확인 | 0 | 생성자 인자로 켤 수 있음 |

복구 엣지가 기대보다 90개 많은 라운드가 있다. 커밋 직후 로그를 쓰기 전에 죽은 경우로, 유실이 아니다.

- FalkorDBLite 기본값은 정상 종료 시에만 안전하다. 정상 종료 후 재오픈하면 2,000개가 그대로 있었다 [실측].
- FalkorDBLite의 서버 수명은 괜찮다. 서버를 띄운 프로세스가 끝나도 다른 프로세스가 연결돼 있으면 서버가 유지됐고, 마지막 연결이 끝나면 정리됐다 [실측].
- FalkorDB는 한 쿼리가 원자 단위다. 트랜잭션 쓰기 시험의 세 문장은 중간에 죽으면 일부만 남을 수 있다.
- LadybugDB 소크: FTS와 벡터 색인이 있는 DB에서 삽입과 `CHECKPOINT` 2,000회, 200회마다 재오픈 검증을 오류 없이 통과했다(53.5초) [실측]. 다만 작은 데이터이고 Linux tmpfs다. 이슈 #843(단일 프로세스의 내구적 손상, macOS, 0.19.1)은 같은 형태의 소크에서 약 750회째에 손상이 났다고 보고됐고, 2026-09-10 시점 최신 코드에서는 손상 대신 즉시 실패하는 형태로 여전히 재현된다고 적혀 있다. 조사일 현재 열려 있다 [S6]. 이번 시험은 그 이슈의 해소를 증명하지 않는다.

**백업.** SQLite `VACUUM INTO`는 쓰기가 도는 동안 0.058초에 24.4 MB 단일 파일을 만들었다 [실측]. LadybugDB `EXPORT DATABASE`는 `schema.cypher`, `index.cypher`, Parquet 파일 묶음을 만들고 `IMPORT` 후 FTS가 살아 있었다(2,000건) [실측]. DuckPGQ 속성 그래프는 재오픈 후에도 남고 `ANY SHORTEST` 가변 길이 경로가 동작했다 [실측].

### 5.6 커밋당 fsync 횟수

tmpfs 편향을 줄이려고 재본 값이다. `LD_PRELOAD`로 `fsync`, `fdatasync`, `msync` 호출을 세고 커밋 수로 나눴다. 호출 횟수는 저장장치와 무관하다 [실측].

| 엔진 | 설정 | 커밋 수 | 호출 수 | 커밋당 |
|---|---|---:|---:|---:|
| SQLite | `synchronous=FULL` | 4,311 | 6,871 | 1.59 |
| SQLite | `synchronous=NORMAL` | 4,481 | 2,662 | 0.59 |
| LadybugDB | 기본 | 137 | 149 | 1.09 |
| DuckDB | 기본 | 1,119 | 1,122 | 1.00 |
| Grafeo | 기본 Batch | 7,715 묶음 | 976 | 0.13 |
| FalkorDB | AOF `everysec` | 1,924 | 16 | 초당 약 2회 |
| FalkorDB | AOF `always` | 1,917 | 5,775 | 3.01(문장 3개) |

읽는 법: ext4에서 fsync 한 번이 L ms면 커밋 지연이 대략 (커밋당 횟수 × L) ms 늘어난다. Grafeo와 `everysec`는 커밋을 fsync로 보장하지 않으므로 전원 손실에서 최근 커밋을 잃을 수 있다. Grafeo 문서의 내구성 모드 설명과 일치한다 [S32]. SQLite NORMAL도 전원 손실이나 시스템 크래시에서 최근 커밋이 되돌려질 수 있으나, 문서는 WAL + NORMAL이 손상으로부터 안전하다고 적는다 [S49].

### 5.7 벡터

10,000건, 384차원 임의 단위 벡터다. 군집 구조가 없어 ANN에 가장 불리하다. 쓰기와 함께 본 규모별 비교는 `retrieval-serving.md` 5.6절이 더 넓다(1024차원, 2만·10만 건) [실측].

| 엔진 | 색인 | 삽입 | 색인 구축 | 질의 p50 | 재현율@10 |
|---|---|---:|---:|---:|---:|
| sqlite-vec 0.1.9 | 전수 | 0.09 s | 없음 | 2.96 ms | 1.000 |
| LadybugDB | HNSW 기본값 | 27.0 s | 5.8 s | 7.55 ms | 0.995 |
| Grafeo | HNSW 기본값 | 0.15 s | 13.9 s | 0.34 ms | 0.85 |
| FalkorDB | HNSW 기본값 | 38.1 s(색인 포함) | | 2.72 ms | 0.65 |
| FalkorDB | `efRuntime: 200` | 41.0 s(색인 포함) | | 3.29 ms | 0.89 |

LadybugDB와 FalkorDB의 삽입 시간은 Cypher 문장으로 넣은 값이라 엔진 한계가 아니다. 벌크 경로는 재지 않았다. sqlite-vec의 ANN은 0.1.10 알파에 있고 재지 않았다 [S27]. SQLite 공식 `vec1` 확장은 IVFADC 기반이고 현재 0.8이며 그래프 기반 색인은 할 일 목록에 있다 [S26]. 재지 않았다.

### 5.8 소비자 계약 목표 대조

`sagae-tools` 잠정 요구는 약 1만 노드·5만 엣지이고, 이 조사 규모와 같다 [실측].

| 계약 목표 | 측정값 | 판정 |
|---|---|---|
| 개요 일괄 2초 이내 | 전체 6만 행을 Python 객체로: DuckDB 27.5 ms, Grafeo 62.9 ms, LadybugDB 71.3 ms, SQLite 97.6 ms, FalkorDB 132.9 ms | 충족. HTTP 직렬화 제외 |
| 이웃 확장 p95 200 ms 이내 | 2-hop p95 0.043~4.0 ms, 허브 2-hop p95 0.6~11.5 ms | 충족 |
| 검색 p95 200 ms 이내 | 전수 반환 FTS 0.1~21.2 ms | 충족 |
| 한국어 토크나이징, 스니펫, 하이라이트 | SQLite + Python 토크나이저로 원문 스니펫 | SQLite 충족. 나머지는 앱 재계산 필요 |
| `as_of_valid`, `as_of_observed` | 두 시간축 필터 2-hop p95 0.065~4.9 ms | 충족(6장) |
| 대체 체인, 변경 피드 | 이 조사에서 구현하지 않음 | 미측정. Grafeo만 `changes_between` API 존재 |

한 사용자이고 폴링 주기가 30~60초라는 계약 조건을 보면, 스냅샷 교체 방식의 신선도도 허용 범위일 수 있다.

## 6. 바이템포럴 모델링

- 기준 모델은 Graphiti다. 엣지에 `valid_at`, `invalid_at`(유효시간)과 `created_at`, `expired_at`(거래시간)을 둔다 [S45]. 논문은 두 시간축 T, T′를 쓰고 모순되는 새 엣지가 오면 옛 엣지의 `t_invalid`를 새 엣지의 `t_valid`로 설정한다고 설명한다 [S44b]. `prior-art.md` T3이 실제 동작을 확인했다.
- 계약의 `as_of_valid`, `as_of_observed`는 이 두 축에 그대로 대응한다.
- 측정 후보 중 유효시간을 엔진이 제공하는 것은 없다. 전부 컬럼으로 직접 모델링했고, 5.2절의 as-of 2-hop이 그 값이다. 체크섬은 전 엔진 18,624로 같았다 [실측].

| 엔진 | 난이도 | 근거 |
|---|---|---|
| SQLite | 낮음 | 엣지가 행이라 불변 ID, 인덱스, 부분 인덱스, 트리거를 그대로 쓴다. 정정은 `UPDATE … SET expired_at`과 새 행 삽입을 한 트랜잭션에 넣는다 |
| DuckDB | 낮음 | SQLite와 같다. 단 UPDATE가 잦으면 열 저장 특성상 불리하다 |
| FalkorDB | 중간 | 엣지 속성 인덱스가 있어 조회는 쉽다. 다중 쿼리 트랜잭션이 없어 만료와 생성을 한 쿼리에 담아야 한다 [S14] |
| LadybugDB | 중간 | 관계 테이블에 사용자 기본키가 없고 `r.id`로 찾으면 스캔이다(10건 7.5 ms). 관계를 `Claim` 노드로 승격해 기본키로 찾는 구조가 맞다 |
| GraphQLite | 중간 | EAV라 필터가 조인으로 풀린다. as-of p99 7.5 ms로 비용이 드러났다 |
| Grafeo | 낮음~중간 | 거래시간은 네이티브다. `history_retention="forever"`로 열면 `execute_as_of`가 과거 값을 돌려주고 재오픈 후에도 유지됐다 [실측]. 기본값에서는 `history before epoch 3 is not retained`로 실패했다. 유효시간은 여전히 직접 넣어야 한다 |

계약이 관계와 주장에 불변 ID를 요구하고 `merged_into`와 대체 체인을 요구하므로, 관계를 1급 레코드로 다루는 모델이 어떤 엔진에서든 필요하다. CLAUDE.md의 "죽은 데이터는 삭제하지 않고 기본 검색에서 제외"도 모든 검색 경로에 상태 필터를 강제한다. FTS와 벡터 후처리 필터까지 포함한다. Graphiti 검색이 기본값에서 무효 엣지를 빼지 않는다는 `prior-art.md` T3의 관찰이 같은 함정을 보여 준다.

## 7. 상위 후보 소견

### 7.1 SQLite (WAL + FTS5 + sqlite-vec)

- 강점: 쓰기 중 별도 프로세스 읽기가 공식 지원이고 실측도 깨끗하다. 한 파일, 온라인 단일 파일 백업, 다중 문장 트랜잭션, 최소 의존성이다. dlt `sqlalchemy` 목적지로 `merge`가 동작한다(`etl-orchestration.md` M13).
- 약점: Cypher가 없어 경로 질의는 재귀 CTE나 코드로 쓴다. 허브 깊은 순회가 규모와 함께 급격히 느려진다. 그래프 알고리즘은 외부에서 돌려야 한다.
- 주의: 긴 읽기 트랜잭션이 체크포인트를 막아 WAL이 무한히 커질 수 있다 [S24]. `sqlite3` 연결을 스레드 간에 공유하지 않는다(`retrieval-serving.md` 2.7절). sqlite-vec는 코드가 5개월 정체돼 있고 v1 이전이다.

### 7.2 LadybugDB

- 강점: Cypher, FTS, HNSW, `COPY`, 한 파일이 한 엔진에 있다. 허브 3-hop이 SQLite보다 5.5배 빠르고(25만 엣지) 격차가 규모와 함께 벌어졌다. Kuzu의 사실상 후속이고 활동이 활발하다. 공식 MCP 서버(`mcp-server-ladybug`)가 있다 [S8].
- 약점 1, 동시성: 메인테이너가 "Two processes sharing the same ladybugdb database file is NOT a supported operation"이라고 적었고, "LadybugDB at this point is prioritizing a faster dev cycle over correctness of this onerous condition"이라고 밝혔다 [S4]. 지원 구성은 한 프로세스 안 여러 스레드다.
- 약점 2, 문서 불일치: 동시성 문서는 혼합 사용이 불가하다고 하나 [S5], 0.22.1은 읽기 전용 열기를 막지 않는다 [실측]. 잠금이 안전을 지켜 주지 않으므로 코드로 금지해야 한다. 재오픈 경로의 SIGSEGV 보고가 있다 [S4][S7].
- 약점 3, 저장 안정성: 0.22.0 릴리스 노트만 봐도 체크포인트 복구, WAL 재생, 저장 계층 수정이 수십 건이다 [S3]. 활발하다는 뜻이면서, 이 영역이 아직 안정되지 않았다는 뜻이기도 하다. 저장 버전이 0.19의 43에서 0.22의 49로 올랐고 0.23은 50이다 [S2]. 구버전 읽기는 지원 목록이 있어 일정 범위 호환된다.
- 약점 4, 공급: FTS·벡터가 휠에 없고 첫 실행에 `extension.ladybugdb.com`에서 받는다. `HOME` 아래 `~/.lbdb`에 저장된다. 재구축 시 확장 서버가 필요하므로 버전 고정과 보관이 필요하다. `algo` 확장은 `libnetworkit.so` 누락으로 로드에 실패했다 [실측]. `LOAD`는 쓰기 트랜잭션이라 동시 연결에서 실패한다. 시작 시 한 번 해야 한다 [실측].
- 패키지명 변화: `real_ladybug`는 0.15.3(2026-04-01)에서 멈췄고 `ladybug`로 옮겼다.

### 7.3 FalkorDB / FalkorDBLite

- 강점: 서버 경유 읽기가 안정적이다. 쓰기가 많아도 오류 없이 p50이 2배 정도만 늘었다. 허브 3-hop이 가장 빠르다. Graphiti의 임베디드 경로이고(`graphiti-core[falkordblite]`) `prior-art.md` T3이 구동을 확인했다. MCP 서버가 있다 [S16].
- 약점: 기본값이 데이터를 잃는다(5.5절). "FalkorDB stores all data in RAM"이고 [S15], 25만 엣지에서 RSS 614 MB다. SSPLv1이다. 개인 내부 사용에는 문제가 되지 않아 보이나, 외부 서비스화나 재배포 계획이 생기면 검토가 필요하다. 다중 쿼리 트랜잭션이 없다 [S14].
- 버전 주의: Lite 0.11.0은 C 엔진 4.22.1을 내장한다. 6.0은 Rust로 다시 쓴 새 엔진이고 [S13], 문서의 일부 프로시저가 6.0에서 아직 동작하지 않는다고 적혀 있다 [S14b]. 이 조사의 수치는 6.0에 그대로 옮길 수 없다.

### 7.4 DuckDB + DuckPGQ

- 2.0.0은 LTS이고 [S19b], `COPY`와 전체 스캔이 가장 빠르다(개요 27.5 ms). 그래프 주 저장소보다 ELT와 분석 층에 맞는다.
- DuckPGQ는 "research project and still a work in progress"라고 스스로 밝힌다 [S19]. 2.0부터 `SET active_grammar_extensions = ['duckpgq']`가 필요하다 [S18].
- 2.0 데이터베이스 파일은 이전 버전이 읽지 못한다 [S19b]. dlt 묶임과 겹치면 파일 호환 문제가 생긴다.

### 7.5 Grafeo (관찰 대상)

- `cjk_bigram`, 네이티브 이력, CDC, HNSW, BM25, 하이브리드 검색, 한 파일, 가장 작은 디스크, Apache-2.0으로 요구와 가장 잘 맞는다. `grafeo-mcp`, `grafeo-server`도 있다.
- 2026-01에 생긴 v1 이전 프로젝트이고 커밋 대부분이 1인이다. "데이터가 절대 죽지 않아야 한다"는 지침에서 이 이력은 위험이다. 허브 3-hop도 약하다. 주 저장소보다 재구축 가능한 파생 층으로 재평가할 만하다.

### 7.6 Graphiti, Cognee

저장소가 아니라 그 위 계층이다. LLM 키가 없어 이 환경에서 그대로 쓸 수 없다. `add_triplet`도 내부에서 `resolve_extracted_edge(self.llm_client, …)`를 호출한다 [S45]. `prior-art.md` T3의 스텁 측정도 2회 호출로 일치한다. 로컬 모델(RTX 4080 SUPER) 연결은 재지 않았다. 스키마와 무효화 규칙은 그대로 참고할 수 있다.

## 8. 구성 선택지

저장소 선택은 2.1절의 서빙 구조 결정에 따라 달라지므로 세 선택지로 남긴다. 공통 전제는 원본 보존이다. `etl-orchestration.md`의 WARC와 dlt 적재가 진실의 원천이고, 그래프 저장소는 재구축할 수 있어야 한다.

| | 선택지 1: SQLite 단일 | 선택지 2: SQLite + LadybugDB 읽기 투영 | 선택지 3: FalkorDB 서버 중심 |
|---|---|---|---|
| 구성 | SQLite에 엔티티·관계·주장 테이블, FTS5, sqlite-vec | 1번 위에 주기적으로 `COPY`로 만든 LadybugDB 스냅샷을 원자 교체, 깊은 순회만 그쪽으로 | FalkorDBLite(AOF) 또는 서버 + Graphiti 스키마 |
| 구조 A·B·C | 전부 가능 | 전부 가능 | 서버 전제 |
| 쓰기 경합 | 없음(WAL) | 없음. 투영은 쓰기와 파일을 공유하지 않음 | 없음(서버 직렬화) |
| 깊은 순회 | 허브에서 약함 | 강함 | 가장 강함 |
| 신선도 | 즉시 | SQLite는 즉시, 투영은 게시 주기 | 즉시 |
| 내구성 | 표준. fsync 비용 있음 | 투영은 버려도 됨 | AOF 필수, 재시작 복구 |
| 운영 부담 | 최소 | 게시 작업 추가, 확장 보관 | 프로세스 기동·복구 관리, RAM |
| 주 위험 | 규모 증가 시 깊은 순회 | 저장 형식 변경, 이중 관리 | 설정 실수로 유실, SSPL, 6.0 이행 |

근거로 보면 선택지 1이 되돌리기 가장 쉽다. 파일 하나이고, 선택지 2는 1 위에 쌓는 구조라 깊은 순회가 실제로 필요해질 때 더할 수 있다. LadybugDB 투영은 SQLite에서 재생성할 수 있으므로 손상돼도 복구가 쉽고, LadybugDB의 저장 안정성 위험을 주 저장소 밖으로 격리한다. 다만 데몬 하나로 모든 쓰기를 모으는 구조 C를 택한다면 LadybugDB를 주 저장소로 두는 안도 지원 범위에 들어온다. 그래도 7.2절의 저장 안정성 이슈는 남는다.

"바퀴를 재발명하지 않는다"는 지침과의 긴장은 있다. 선택지 1은 그래프 계층을 직접 만든다. GraphQLite가 그 틈을 메울 수 있고 WAL 읽기가 동작했으나, 베타와 1인 의존, EAV 비용, FTS 부재를 감안해야 한다.

결정 전에 확인할 값은 두 가지다. 예상 규모(엔티티, 주장 수)와 HTTP 데몬 여부다. `sagae-tools`도 같은 질문을 기다리고 있다.

## 9. 재현

하네스는 `scratchpad/graph-store/scripts/`에 있고 저장소에는 넣지 않았다. scratchpad는 tmpfs라 재부팅하면 사라지므로, 사양은 1.2절과 아래 질의로 재구현할 수 있다. 데이터는 시드 42에서 결정적이다. 공통 전제는 `source scratchpad/env.sh`, `uv venv --python 3.13`, `HOME`을 scratchpad로 돌리는 것이다.

```bash
# 설치(엔진별 전용 venv)
uv pip install 'ladybug==0.22.1' pyarrow pandas numpy kiwipiepy
uv pip install apsw sqlite-vec==0.1.9 graphqlite==0.12.0 kiwipiepy numpy
uv pip install falkordblite==0.11.0 falkordb numpy kiwipiepy
uv pip install duckdb==2.0.0 pyarrow pandas numpy kiwipiepy
uv pip install grafeo==0.6.0 numpy kiwipiepy

# 데이터
python -I gen_data.py data/10k 10000 50000 42
python -I pretok.py data/10k

# 시나리오. graph-store 디렉터리에서 실행하고 절대 경로를 인자로 넘긴다
for s in run_lb1 run_lb2 run_lb3 \
         run_sqlite run_sq2 \
         run_falkor run_fk_wrap2 \
         run_dk1 run_dk2 run_dk3 \
         run_gf run_gq \
         run_extra run_scale run_contract; do
  bash "scripts/$s.sh" "$PWD"
done
# 순서대로 LadybugDB, SQLite, FalkorDB와 Lite 수명, DuckDB와 Quack, Grafeo와 GraphQLite,
# 3-hop과 커밋당 fsync, 5만·25만 규모, 개요 일괄과 스니펫이다.
# run_sq2와 run_lb3이 고정 10 tx/s 값을 낸다. 모두 tmpfs 여유가 부족하면 대기하거나 중단한다.
```

ext4 재측정은 하네스 호출의 DB 디렉터리 인자(`$SP/dbs/...`)와 FalkorDB `--dir`을 ext4 경로로 바꾸면 된다.

대표 질의는 다음과 같다. Cypher 엔진은 같은 문장을 쓰고 SQL 엔진은 조인으로 옮겼다.

```cypher
-- 2-hop
MATCH (a:Entity {id:$id})-[:REL]->(b:Entity)-[:REL]->(c:Entity) RETURN count(DISTINCT c.id)
-- 바이템포럴 as-of: r1, r2 각각에 같은 조건
WHERE r.valid_from <= $v AND (r.valid_to IS NULL OR r.valid_to > $v)
  AND r.recorded_at <= $t AND (r.expired_at IS NULL OR r.expired_at > $t)
```

```python
# FTS5 원문 스니펫용 Python 토크나이저(요지). 한글 연속은 겹치는 bigram, 라틴은 소문자 한 토큰, 원문 오프셋 유지.
@apsw.fts5.StringTokenizer
def ko_bigram(con, params):
    def tok(text, flags, locale):
        for m in re.finditer(r"[가-힣]+|[A-Za-z0-9]+", text):
            s, e = m.span(); run = m.group(0)
            if run[0].isascii(): yield s, e, run.lower()
            elif e - s == 1: yield s, e, run
            else:
                for i in range(s, e - 1): yield i, i + 2, text[i:i + 2]
    return tok
```

```c
/* 커밋당 fsync 계수: fsync, fdatasync, msync를 가로채 원자 카운터를 올리고 종료 시 FSYNC_OUT에 추가한다 */
/* gcc -shared -fPIC -O2 -o fsync_count.so fsync_count.c -ldl; LD_PRELOAD=./fsync_count.so FSYNC_OUT=f.out <쓰기 명령> */
```

## 10. 미해결

- **ext4 실측.** 실제 WSL2 ext4의 fsync 지연과 쓰기 처리량. 커밋당 횟수만 있고 지연 값이 없다.
- **전원 손실 내구성.** `kill -9`만 쟀다. `wsl --shutdown`이나 강제 종료 중 쓰기는 재지 않았다.
- **규모.** 25만 엣지까지 쟀다. 예상 규모가 정해지면 다시 봐야 한다.
- **LadybugDB 장기 안정성.** 소크 2,000회는 작은 데이터다. 이슈 #843, #666, #1007의 현재 상태는 실사용 규모의 시험 없이 판단할 수 없다.
- **`enable_multi_writes`.** LadybugDB Python 인자에 있으나 시험하지 않았다.
- **Grafeo Server, grafeo-mcp, FalkorDB 6.0, DuckDB 1.5.x + dlt 조합.** 재지 않았다.
- **Quack 경유 FTS와 파라미터 바인딩.** 이번 실패가 Quack 제약인지 사용 방법 문제인지 가리지 못했다.
- **미설치 후보.** Neo4j, Memgraph, TerminusDB, PostgreSQL + AGE는 문서로만 평가했다. JDK 압축본이나 `dpkg-deb -x`로 sudo 없이 띄울 수 있는지는 시도하지 않았다.
- **로컬 LLM 경로.** Graphiti, Cognee를 로컬 모델로 돌린 비용과 품질.
- **원문 오프셋 제공 방식.** `highlight()` 마커 방식은 확인했다. 문자 오프셋을 직접 돌려주는 FTS5 보조 함수는 내 시험 코드가 실패해 확인하지 못했다.
- **대체 체인과 변경 피드.** 구현과 성능을 재지 않았다.

## 부록 A. 출처

확인일은 전부 2026-10-31이다.

| 번호 | 출처 | URL | 확인일 |
|---|---|---|---|
| S1 | LadybugDB 저장소, 릴리스 v0.22.1 | https://github.com/LadybugDB/ladybug/releases/tag/v0.22.1 | 2026-10-31 |
| S2 | LadybugDB 저장 버전 표 | https://github.com/LadybugDB/ladybug/blob/main/src/include/storage/storage_version_info.h | 2026-10-31 |
| S3 | LadybugDB 릴리스 v0.22.0 노트 | https://github.com/LadybugDB/ladybug/releases/tag/v0.22.0 | 2026-10-31 |
| S4 | LadybugDB 이슈 #1007 메인테이너 답변 | https://github.com/LadybugDB/ladybug/issues/1007#issuecomment-5763847709 , https://github.com/LadybugDB/ladybug/issues/1007#issuecomment-5787629554 | 2026-10-31 |
| S5 | LadybugDB 동시성·트랜잭션 문서 | https://docs.ladybugdb.com/concurrency/ , https://docs.ladybugdb.com/cypher/transaction/ | 2026-10-31 |
| S6 | LadybugDB 이슈 #843(내구적 손상) | https://github.com/LadybugDB/ladybug/issues/843 | 2026-10-31 |
| S7 | LadybugDB 이슈 #666, #766, #939, PR #615 | https://github.com/LadybugDB/ladybug/issues/666 , https://github.com/LadybugDB/ladybug/issues/766 , https://github.com/LadybugDB/ladybug/issues/939 , https://github.com/LadybugDB/ladybug/pull/615 | 2026-10-31 |
| S8 | LadybugDB MCP 서버, FTS·벡터·확장 문서, 1주년 글 | https://github.com/LadybugDB/mcp-server-ladybug , https://docs.ladybugdb.com/extensions/full-text-search/ , https://docs.ladybugdb.com/extensions/vector/ , https://docs.ladybugdb.com/extensions/ , https://thedataquarry.com/blog/celebrating-one-year-of-ladybug/ | 2026-10-31 |
| S9 | Kuzu 저장소(보관 공지) | https://github.com/kuzudb/kuzu | 2026-10-31 |
| S10 | Apple의 Kuzu 인수 보도(EU 공시 기반) | https://www.macrumors.com/2026/02/11/apple-acquires-new-database-app/ , https://betakit.com/apple-strikes-deal-to-acquire-canadian-database-software-startup-kuzu/ | 2026-10-31 |
| S11 | Kuzu 포크 | https://github.com/vela-engineering/kuzu , https://github.com/predictable-labs/ryugraph , https://github.com/Kineviz/bighorn | 2026-10-31 |
| S12 | FalkorDB 저장소, 라이선스 | https://github.com/FalkorDB/FalkorDB | 2026-10-31 |
| S13 | FalkorDB 6.0.0 릴리스 노트 | https://github.com/FalkorDB/FalkorDB/releases/tag/v6.0.0 | 2026-10-31 |
| S14 | FalkorDB 동시성 문서 | https://docs.falkordb.com/design/concurrency.html | 2026-10-31 |
| S14b | FalkorDB 전문검색 문서 | https://docs.falkordb.com/cypher/indexing/fulltext-index.html | 2026-10-31 |
| S15 | FalkorDB 설계·설정 문서 | https://docs.falkordb.com/design/ , https://docs.falkordb.com/getting-started/configuration.html | 2026-10-31 |
| S16 | FalkorDBLite, FalkorDB MCP 서버 | https://github.com/FalkorDB/FalkorDBLite , https://github.com/FalkorDB/FalkorDB-MCPServer | 2026-10-31 |
| S17 | Redis 라이선스 | https://github.com/redis/redis | 2026-10-31 |
| S18 | DuckPGQ 커뮤니티 확장 | https://duckdb.org/community_extensions/extensions/duckpgq | 2026-10-31 |
| S19 | DuckPGQ 소개 | https://duckpgq.org/ | 2026-10-31 |
| S19b | DuckDB 2.0.0 발표 | https://duckdb.org/2026/10/21/announcing-duckdb-200 | 2026-10-31 |
| S20 | DuckDB 동시성, Quack 문서 | https://duckdb.org/docs/2.0/connect/concurrency.html , https://duckdb.org/docs/2.0/quack/overview.html | 2026-10-31 |
| S21 | DuckDB VSS 문서 | https://duckdb.org/docs/2.0/core_extensions/vss.html | 2026-10-31 |
| S22 | DuckDB FTS 문서 | https://duckdb.org/docs/2.0/core_extensions/full_text_search.html | 2026-10-31 |
| S23 | SQLite 변경 이력 | https://sqlite.org/changes.html | 2026-10-31 |
| S24 | SQLite WAL 문서 | https://sqlite.org/wal.html | 2026-10-31 |
| S25 | SQLite FTS5 문서 | https://sqlite.org/fts5.html | 2026-10-31 |
| S26 | SQLite vec1 확장 문서 | https://sqlite.org/vec1/doc/trunk/doc/vec1.md | 2026-10-31 |
| S27 | sqlite-vec 저장소, 알파 릴리스 | https://github.com/asg017/sqlite-vec , https://github.com/asg017/sqlite-vec/releases/tag/v0.1.10-alpha.1 | 2026-10-31 |
| S28 | lindera-sqlite | https://github.com/lindera/lindera-sqlite | 2026-10-31 |
| S29 | GraphQLite | https://github.com/colliery-io/graphqlite | 2026-10-31 |
| S30 | Grafeo 저장소, 조직 | https://github.com/GrafeoDB/grafeo , https://github.com/GrafeoDB | 2026-10-31 |
| S31 | Grafeo 트랜잭션 문서 | https://grafeo.dev/user-guide/transactions/ | 2026-10-31 |
| S32 | Grafeo 영속화 문서 | https://grafeo.dev/user-guide/persistence/persistent/ | 2026-10-31 |
| S33 | Neo4j 설치 요구사항 | https://neo4j.com/docs/operations-manual/current/installation/requirements/ | 2026-10-31 |
| S34 | Neo4j 라이선스, 저장소 | https://neo4j.com/licensing/ , https://github.com/neo4j/neo4j | 2026-10-31 |
| S35 | Neo4j 오프라인 백업, 전문검색 | https://neo4j.com/docs/operations-manual/current/backup-restore/offline-backup/ , https://neo4j.com/docs/cypher-manual/current/indexes/semantic-indexes/full-text-indexes/ | 2026-10-31 |
| S36 | Memgraph 설치 문서 | https://memgraph.com/docs/getting-started/install-memgraph | 2026-10-31 |
| S37 | Memgraph 백업, 전문검색 문서 | https://memgraph.com/docs/database-management/backup-and-restore , https://memgraph.com/docs/querying/text-search | 2026-10-31 |
| S38 | Memgraph 라이선스 | https://github.com/memgraph/memgraph | 2026-10-31 |
| S39 | CozoDB | https://github.com/cozodb/cozo | 2026-10-31 |
| S40 | Oxigraph 저장소, pyoxigraph Store 문서 | https://github.com/oxigraph/oxigraph , https://pyoxigraph.readthedocs.io/en/stable/store.html | 2026-10-31 |
| S41 | TerminusDB | https://github.com/terminusdb/terminusdb | 2026-10-31 |
| S42 | Turso Database, SurrealDB, ArcadeDB, XTDB | https://github.com/tursodatabase/turso , https://github.com/surrealdb/surrealdb , https://github.com/ArcadeData/arcadedb , https://github.com/humemai/arcadedb-embedded-python , https://github.com/xtdb/xtdb | 2026-10-31 |
| S43 | Apache AGE, pgembed | https://github.com/apache/age , https://github.com/Ladybug-Memory/pgembed | 2026-10-31 |
| S44 | Graphiti README, 설정 | https://github.com/getzep/graphiti | 2026-10-31 |
| S44b | Zep 논문 arXiv 2501.13956 | https://arxiv.org/html/2501.13956 | 2026-10-31 |
| S45 | Graphiti 소스 `graphiti.py`, `edges.py` | https://github.com/getzep/graphiti/blob/main/graphiti_core/graphiti.py , https://github.com/getzep/graphiti/blob/main/graphiti_core/edges.py | 2026-10-31 |
| S46 | Cognee 소스 `graph/config.py` | https://github.com/topoteretes/cognee/blob/main/cognee/infrastructure/databases/graph/config.py | 2026-10-31 |
| S47 | WSL 설정 문서 | https://learn.microsoft.com/en-us/windows/wsl/wsl-config | 2026-10-31 |
| S48 | Kiwi | https://pypi.org/project/kiwipiepy/ | 2026-10-31 |
| S49 | SQLite PRAGMA synchronous 문서 | https://sqlite.org/pragma.html#pragma_synchronous | 2026-10-31 |
