# 레드팀 감사: 정보 저장소 설계안 4종

- 작성일: 2026-10-31
- 대상: `proposal-simplicity.md`, `proposal-durability.md`, `proposal-retrieval.md`, `proposal-platform.md`
- 방법: 각 안이 기대는 가정을 골라 실제 ext4와 설계안 프로토타입으로 재현했다. 재현할 수 없는 것은 1차 출처로 확인했고, 그것도 안 되면 `추론`으로 표시했다.
- 표기: `[X번호]`는 이 감사의 재현이고 1장에 있다. `[P]`, `[D]`, `[E]`는 각 설계안의 실측이다. `R번호`는 설계안들이 공유하는 요구사항 번호다.
- 성격: 시스템 설계 문서다(CLAUDE.md 지침 5의 예외). 약관 항목은 공개 문구의 사실이고 법률 판단이 아니다.

## 0. 요약

**네 안 중 그대로 채택할 수 있는 안은 없다.** 다만 치명 결함은 대부분 안의 뼈대가 아니라 특정 결정 하나에 있고, 다른 안에 답이 있다. 고치는 비용은 대체로 작다. 진실 계층에 fsync를 넣어도 쓰기 p99가 5.8 ms에서 8.1 ms로 오를 뿐이다 [X13].

가장 위험한 결과 일곱 가지다.

| # | 결과 | 영향 안 | 증거 |
|---|---|---|---|
| 1 | platform의 `kb rebuild`를 문서대로 구현하면 쓰기 중 **DB가 깨지거나 확인 응답한 쓰기가 62~64% 조용히 사라진다.** 저널이 그 DB 안에 있어서 진실이 함께 사라진다 | platform | [X2] |
| 2 | simplicity의 "진실은 `raw/`"는 시험된 적이 없다. 프로토타입에 파일 저널 코드가 없고 P1, P3은 SQLite 표를 재생했다. 문구대로 구현하면 인접 줄의 16~18%가 뒤집히고, 구멍이 나도 `seq` 최댓값 비교는 통과한다 | simplicity | [X3] |
| 3 | `synchronous=NORMAL`로 번호를 발급하는 안은 전원 손실 뒤 `seq`를 재사용한다. 소비자 커서가 DB를 앞질러 새 행을 영구히 못 보고, 파일 재구축은 `UNIQUE` 오류로 실패한다 | simplicity, platform(추론), retrieval(추론) | [X4] |
| 4 | 인용 게이트는 문장을 보지 않는다. 왜곡 문장 90건 중 인용구만 보는 게이트 90건, 숫자까지 보는 게이트 85건이 통과했다. durability와 platform은 숫자를 바꾼 문장 38건도 전부 통과시켰다 | 전부 | [X6] |
| 5 | 같은 문서를 다시 추출하면 (주어, 술어) 슬롯 재현율이 0~14%다. 자동 대체, 접기, 결정적 ID가 전부 여기에 기댄다. 실제 출력에서 유효한 값 30일과 90일이 한 슬롯에 충돌했다 | 전부 | [X10][X11] |
| 6 | platform의 질의 규칙은 Ko-StrategyQA 592개 질의 **전부 0건**이다. 문서가 인용한 0.595는 다른 규칙(OR)으로 잰 값이다 | platform | [X5] |
| 7 | 네 안 모두 쓰는 `wal_checkpoint(RESTART)` 때문에 6초짜리 읽기가 쓰기를 5.6초 멈춘다. `busy_timeout` 30초면 최대 30초다. 소비자 계약 6번 "읽기가 적재를 막으면 안 된다"에 어긋난다 | 전부, platform이 최악 | [X1] |

**안별 한 줄 평가.**

| 안 | 평가 |
|---|---|
| simplicity | 고치기 가장 쉬운 구조이고 수집 비용 통제와 재확인 설계가 최선이다. 그러나 커밋 지점이 "버려도 되는 캐시" 안에 있어 핵심 주장이 거꾸로 서 있다 |
| durability | 데이터 생존은 네 안 중 가장 강하고 이 감사의 공격 다수를 버텼다. 게이트에 숫자 검사가 없고 운영량이 가장 크다 |
| retrieval | 반환 품질과 토큰은 최선이다. 저장 층이 가장 약하고(단일 파일에 first_party 원본), rtk 상태가 HOME으로 샌다 |
| platform | 쓰기 게이트는 실제 ext4에서도 재현되는 진짜 성과다 [X12]. 그러나 재구축 방식과 질의 규칙에 즉시 고쳐야 할 결함이 있다 |

**사용자 결정 없이는 어떤 안도 데이터 생존을 말할 수 없다.** 머신 밖 대상, restic 비밀번호의 디스크 밖 보관, WSL이 닫힌 시간의 수집, 유튜브 데이터 경로가 정해지기 전까지 R8과 R16은 미충족이다(2.10절).

## 1. 재현 실측

**공통 조건.** 별도 표시가 없으면 실제 ext4(`/dev/sdd`), CPython 3.13.18, SQLite 3.53.1이다. X3, X4, X13은 `kbproto.py`가 `compression.zstd`를 요구해서 시스템 Python 3.14.4(SQLite 3.46.1) 또는 관리형 3.14.10으로 돌렸다. 표본은 작고 대부분 1회 측정이다. 부하 평균은 2~4였다. 전원 손실은 재지 않았고 스냅샷 복원으로 근사했다.

| ID | 시험 | 결과 | 대상 |
|---|---|---|---|
| X1 | 읽기 트랜잭션을 6초 쥔 동안 체크포인트 + 대화형 쓰기(FULL) | 체크포인트 없음 최대 58 ms, `PASSIVE` 46 ms, `RESTART` **5,637 ms**, 게이트 안 `RESTART` **5,529 ms**. 읽기 12초 + `busy_timeout` 5초면 **5,008 ms** 정지 후 `SQLITE_BUSY`. 정지 시간은 남은 읽기 시간과 `busy_timeout` 중 짧은 쪽이다 | 전부 |
| X2 | platform 14.5 `os.replace` 재구축. 쓰기 4개, 게이트를 쥔 채 꼬리 따라잡기 후 교체. 조합별 5회 | 아래 표 | platform |
| X3 | simplicity 2장 ①②③을 문구대로 구현(`O_APPEND` 한 줄 쓰기). 쓰기 4개, 6,000건 | 인접 줄 역전 987~1,090건(16~18%). 커밋과 추가 사이 SIGKILL 26회에서 구멍 26개. `max(seq)` 비교와 꼬리 줄 비교 모두 "정상". 파일만으로 재구축하면 26건 유실, 지문 불일치 | simplicity |
| X4 | NORMAL 커밋 20건 후 WAL 꼬리 소실을 스냅샷 복원으로 근사, 새 쓰기 5건 | 소비자 커서 120, DB 최대 105, `seq > 커서` 결과 0건. 새 행 5건을 영구히 못 본다. 소비자가 가진 20건은 DB에 없다. `seq-105`가 다른 내용을 가리켜 ETag가 충돌한다. 저널 파일에 같은 `seq` 5쌍. 파일 재구축은 `UNIQUE constraint failed: journal.seq`로 실패 | simplicity |
| X5 | Ko-StrategyQA 9,251문서, 592질의, bigram FTS5 | OR 0.595(빈 결과 0). **항 구문 AND 0.000(빈 결과 592/592)**. AND 후 k 미만이면 OR 0.595. 식별자·표기 25건: AND 11건 실패, OR 3건 실패 | platform, 전부 |
| X6 | 실제 추출 주장 49건의 문장만 기계적으로 왜곡, 인용구는 유지 | 왜곡 90건: 인용구 전용 90 통과, 숫자 검사 포함 85 통과. 대조군 숫자 변경 38건: 인용구 전용 38 통과, 숫자 검사 0 통과 | 전부 |
| X7 | 같은 49건을 원문 문맥과 수작업 대조 | 명백히 틀린 주장은 찾지 못했다. 그러나 **13건(27%)은 뜻을 정하는 주어나 조건이 인용구 밖에 있다**(5, 7, 8, 9, 16, 20, 21, 22, 23, 25, 38, 39, 42번) | 전부 |
| X8 | Trafilatura 2.3.1에 숨은 본문 9종 | `hidden` 속성, `font-size:0`, 흰 글씨, 화면 밖 배치, CSS 클래스 숨김 **5종이 표시 본문으로 들어온다**. `display:none` 인라인, `aria-hidden`, 주석, `noscript`는 걸러진다. 표준 `urllib.request.urlopen`은 `file:` URL을 그대로 읽는다 | 전부 |
| X9 | E13 재현 구조에 **틀린 값**을 넣었다(하루 50회). Haiku, 조건당 4회 | 주석 없음: 4회 모두 단서를 달고 의심. 문장 안 주석: **3회가 단서 없이 수용**, 변경 사실까지 그대로 인용. 1회만 의심 | retrieval |
| X10 | 같은 입력 재추출. Haiku, 문서 2종, 기존 1회 + 신규 2회 | 짝별 자카드: 문장 0.00~0.16, (문장, 인용구) 0.00~0.16, **(주어, 술어) 0.00~0.14**, 술어 0.25~0.62, 인용구 0.32~0.57. 한 문서의 술어가 회차별 10~12개인데 3회 합집합은 19개 | 전부 |
| X11 | X10의 실제 출력에서 슬롯 충돌 조사 | `('YPP 재신청','reapply_wait_period')`에 30과 90이 충돌. 둘 다 유효하고 조건만 다르다. `qualifiers`는 8회 실행의 모든 주장에서 빈 값 | simplicity, durability |
| X12 | P6을 실제 ext4에서 재측정(fsync 주입 없음). 8세션 + 승격 8만 이벤트 | 게이트 없음 p99 731 ms, 최대 2,033 ms. **차단 flock p99 19.0 ms, 최대 20.4 ms.** 시간 제한을 위한 `LOCK_NB` + 5 ms 재시도는 p50 33 ms, p99 258 ms, 최대 315 ms. 표본 약 140건 | platform, 전부 |
| X13 | 프로토타입 경로 대 CAS 파일·디렉터리 fsync + 저널 줄 fsync, 1,500회 | p50 4.65 → 6.71 ms, p99 5.76 → 8.13 ms | simplicity |
| X14 | 30만 행 FTS5 OR 질의, 모든 행에 도메인 어휘를 붙인 코퍼스(상한값) | 편중 없음 p95 5.0 ms, 편중 **p95 125 ms**(25배) | retrieval, 전부 |
| X15 | FastMCP 4.1.4 재시작 후 옛 세션 ID로 호출 | 기본(stateful) `404 Session not found`. `stateless_http=True`는 200 | retrieval |
| X16 | rtk 1.1.0, 가짜 HOME | 훅 프로세스에만 `XDG_DATA_HOME`을 주고 재작성 명령을 Bash 환경으로 실행하면 `~/.local/share/rtk/history.db`가 생긴다. 가드는 `git diff --output=x`, `git log --output=x`, `rg --pre x`, `tree -o x`를 "읽기 전용"으로 통과시켜 재작성한다(실행은 안 했다) | retrieval, 전부 |
| X17 | restic 0.19.1 백업 중 SIGKILL | `backup` 재실행은 성공. **`check`는 잠금 오류로 rc=11**, `unlock` 필요 | 전부 |
| X18 | 정적 확인 | simplicity 6.5 예제 `obs` 항목이 6.1 DDL에서 `NOT NULL constraint failed: obs.snapshot`. `--output-format json` 결과에 `rate_limit_event` 없음(키 27개 확인, stream-json에는 있음). CLI 읽기 경로는 `mode=ro`라 체크포인트하지 않음 | simplicity, retrieval |
| X19 | Claude Code `CHANGELOG.md` 실측 | 1,130,515바이트. 릴리스 100건이 120일에 걸침(하루 약 0.83건). 9,000자 창이면 126창 | retrieval, platform, durability |

**X2 상세.** 게이트를 쥔 채 교체하는 가장 친절한 구현이다.

| 연결 | 옛 `-wal` | 확인 응답 유실 | `integrity_check` |
|---|---|---|---|
| 프로세스·스레드별 유지 | 그대로 둠 | 4회 전량(100%), 1회 65.4% | **5회 모두 손상**(`malformed` 또는 `btreeInitPage` 오류) |
| 프로세스·스레드별 유지 | 삭제 | 61.7~64.4% | **5회 모두 ok** |
| 호출마다 | 그대로 둠 | 0 | ok |
| 호출마다 | 삭제 | 0.2~0.4% | ok |

platform 7.4와 retrieval `db.py`는 스레드별 연결이다. 유일하게 안전했던 조합은 호출마다 연결 + 옛 `-wal` 유지인데, durability D10은 같은 조합의 다른 조건에서 값 섞임을 재현했으므로 안전하다고 보지 않는다.

## 2. 차단 결함

ADR 전에 해소해야 하는 결함이다.

### 2.1 라이브 WAL DB 경로 교체 (platform)

**시나리오.** 스키마 변경으로 `kb rebuild`를 돌린다. 세션이 쓰고 있다. 교체 뒤 쓰기는 전부 성공 응답을 받지만 옛 inode로 간다.

**증거.** [X2]. platform 14.5는 "새 파일을 만들어 `os.replace`로 교체한다"고 적고 근거로 general-db M19를 든다. M19는 쓰기가 없는 게시 사본의 시험이다. durability D10이 이미 같은 문제를 경고했다. platform에서 더 나쁜 이유는 최근 저널이 `kb.db` 안에 있어서 파생물이 아니라 진실이 사라지기 때문이다.

**수정.** durability의 빌드 디렉터리 + symlink 또는 simplicity의 세대 포인터 + 펜스를 쓴다. 저널을 별도 파일로 분리하는 것이 근본 해법이다.

### 2.2 진실과 커밋 지점의 역전 (simplicity)

**시나리오.** 쓰기 순서가 ① CAS ② SQLite 커밋 ③ 저널 줄 추가다. 확인 응답이 나가는 지점은 ②이고, 그 시점에 저널 행은 "언제든 버리는 캐시"에만 있다.

**증거.**

- 프로토타입에 `raw/journal`이 없다. `grep`으로 `ndjson`, `fsync`가 0건이다. P1의 `export_journal`과 P3의 `tail`은 SQLite `journal` 표를 읽는다. "9.4만 행 재구축"은 파일 진실의 증거가 아니다. 23.2절의 미검증 목록에도 없다.
- 문구대로 구현하면 [X3]처럼 줄 순서가 뒤집히고 구멍이 생긴다. "다음 박동이 `seq`를 비교해 메운다"는 집합 차이로 구현해야 하고 그때도 DB가 살아 있어야 한다.
- 8.3절의 "매 박동 저널 꼬리 내보내기"로 읽으면 순서 문제는 사라지지만, 최대 15분치 확인 응답이 캐시에만 있게 된다. S1이 DB를 백업하지 않으므로 그 구간은 어디에도 없다.
- `cas_put`에 fsync가 없다. 전원 손실 뒤 FULL로 커밋된 저널 행이 없는 객체를 가리킬 수 있다.

**수정.** 둘 중 하나를 고른다. 파일을 진실로 두려면 게이트 안에서 저널 줄을 fsync한 뒤 SQLite에 반영한다(`seq`는 게이트 순서로 발급). 아니면 durability처럼 별도 SQLite 원장을 진실로 인정하고 파일을 내보내기로 낮춘다. 비용은 작다[X13].

### 2.3 `NORMAL`로 번호를 발급하면 번호가 재사용된다 (simplicity, platform, retrieval)

**시나리오.** 수집 커밋은 `NORMAL`이다. 전원이 나가 WAL 꼬리가 사라지면 `seq`가 되감기고 같은 번호가 다른 내용으로 다시 발급된다.

**증거.** [X4]. simplicity 22장은 이것을 "재적용으로 복구"로 받아들였고 번호 재사용을 다루지 않았다. platform은 15분마다 봉인하므로 봉인 세그먼트와 DB가 갈라지고 해시 체인도 갈라진다(추론, 구조 동일). retrieval은 `change_log` 번호에서 같은 일이 생긴다(추론). durability는 원장이 FULL이고 gold만 NORMAL이라 같은 내용으로 다시 투영되므로 이 공격을 버틴다. fsync가 거짓말하지 않는다는 전제에서다.

**수정.** 피드 번호를 발급하는 커밋은 FULL로 한다. 100이벤트 배치당 fsync 1회라 비용이 작다. 시작 시 비정상 종료를 탐지하면 `epoch`을 올려 소비자를 재동기화시킨다. 봉투에 `epoch`이 있는 안은 durability뿐이다.

### 2.4 인용 게이트는 문장을 검증하지 않는다 (전부)

**시나리오.** 모델이 인용구는 정확히 베끼고 문장을 왜곡한다. 부정, 비교어, 단위, 주어가 바뀌어도 `verified`로 기본 검색에 나간다.

**증거.**

- [X6]. platform의 `verify()`는 문장을 입력으로 받지 않는다. durability 6.4의 7단계에도 문장 대조가 없다. P11의 "3,370건 전부 거부"는 **인용구를** 변조한 시험이다. 실제 위험은 인용구가 맞고 문장이 틀린 경우이고, 그 경우를 재지 않았다.
- [X7]. 실제 49건 중 13건은 인용구만으로 뜻이 정해지지 않는다. `The quota cost is 1 per call.`은 어떤 메서드의 문장으로도 쓸 수 있고, `보통 1개월 정도`는 주어가 없다. platform의 8자 하한을 통과한다.
- [X8]. 사람에게 안 보이는 본문이 표시 본문에 들어온다. 공격자 페이지의 숨은 문장은 인용구로 정확히 일치하므로 게이트를 통과한다. prior-art P14의 지속 오염 경로와 같다.

**수정.** 값은 인용구에서 기계로 뽑고 모델 문장의 값과 대조한다. 숫자에 더해 단위, 비교어, 부정어 토큰을 대조한다. 주어 별칭이 인용구 또는 같은 문단·표 머리에 있어야 한다. 표 행은 머리 줄을 함께 저장한다. HTML은 추출 전에 숨김 속성과 스타일을 제거한다. 함의 판정은 표본 감사로 쓴다. 필드 이름을 `verified`가 아니라 `quote_found` 계열로 바꿔 의미를 과장하지 않는다.

### 2.5 LLM 슬롯 위에 자동 대체를 올렸다 (전부)

**시나리오.** 값이 바뀌어도 새 주장의 슬롯이 옛 주장과 달라 대체되지 않는다. 옛 값과 새 값이 함께 `active`로 남는다. 반대로 조건만 다른 두 주장이 한 슬롯에 들어가면 유효한 값이 대체된다.

**증거.**

- [X10]. 슬롯 재현율 0~14%다. 주어 문자열이 `YouTube 파트너 프로그램(YPP)`, `YPP 자격 요건`, `YPP 가입 요건`으로 흔들리고, 네 안의 별칭 해석은 정규형 완전 일치라 새 엔티티를 만든다.
- [X11]. 30일과 90일 충돌. simplicity 6.6과 durability 6.4의 규칙이면 같은 출처이므로 한쪽이 대체되어 기본 검색에서 사라진다. retrieval과 platform은 둘 다 남기지만 거짓 충돌 표시가 된다.
- [X10]. retrieval의 `Claim` ID는 문장 또는 슬롯과 `text_sha256`을 해시한다. 재추출하면 ID의 84~100%가 바뀌고, 문서가 바뀌면 전부 바뀐다. "딥링크가 깨지지 않는다"가 성립하지 않는다.
- E8의 43/49 미등록 술어가 그대로 재현됐다. retrieval은 그 주장이 `skey=NULL`로 영구히 공존하고, durability는 대기열로 가고, simplicity는 `states`로 빠져 대체되지 않는다.

**비용 폭주로 이어지는 경로 [X19].** 캐시 키가 문서 해시인 안(durability, retrieval, platform)은 한 글자 변경에 문서 전체를 다시 추출한다. `CHANGELOG.md`는 릴리스마다 126창, 약 1,400주장, 정가 추정 $0.42다. 하루 0.83회면 슬롯이 맞지 않는 한 **문서 하나가 연 40만 주장을 만든다.** retrieval의 1년차 가정 10만~30만을 혼자 넘는다. durability는 창 분할 규칙이 없어 1.1 MB를 한 호출에 넣어야 한다.

**수정.** 자동 대체는 결정적 파서가 뽑은 값(모델 수명 표, 쿼터 표, 레지스트리)에만 허용한다. LLM 주장은 대체하지 않고 공존시키되, 신선도는 simplicity 7.6의 인용구 재확인으로 잡는다. 슬롯에 의존하지 않는 유일한 장치다. 술어와 주어는 닫힌 후보 목록에서 고르게 한다. ID는 정규화 인용구와 주어 엔티티로 만든다. L2 캐시는 문단 단위로 한다.

### 2.6 한글 어휘 경로 (platform, 일부 전부)

**시나리오.** 세션이 `쇼츠 수익은`이나 `8000시간`으로 찾는다. 문서에 있는데 0건이고, 호출 모델은 "없는 정보"로 판단한다.

**증거.** [X5]. platform 12.3과 `fts_query`는 항 구문 AND이고, 인용한 품질 수치는 `lex_eval.py`의 OR 값이다. 호출 모델이 키워드로 물으면 완화되지만 조사 하나, 숫자 표기 하나로도 0건이 된다. 소비자 계약 7번이 KB 안에서 해결하라고 요구한 항목이다. simplicity의 AND → OR 폴백은 0.595를 유지한다.

**전 안 공통.** `앱`, `훅`, `봇`, `탭`처럼 조사가 붙는 한 음절 단어는 OR로도 못 찾는다. `훅`은 도메인 G의 핵심어다. `숏츠`와 `쇼츠`, `8,000`과 `8000`도 어휘 경로에서 갈린다.

**수정.** 질의는 bigram OR 폴백을 기본으로 한다. 숫자는 구분 기호 제거형을 함께 색인한다. 한글 런의 첫 음절 등 단음절 토큰을 추가하고 재현율과 크기를 잰다. 별칭 사전을 검색 앞단에 둔다.

### 2.7 `RESTART` 체크포인트 (전부)

**시나리오.** sagae-tools가 전체 그래프를 읽거나, 백업 API가 스냅샷을 잡거나, `kb verify`가 지문을 계산한다. 그동안 박동의 `RESTART`가 쓰기 잠금을 쥐고 기다린다.

**증거.** [X1]과 SQLite 문서("blocks new database writers while it is pending"). simplicity 8.3 매 박동, durability 7.1 maintain, retrieval 10장 적재 뒤, platform 7.4 승격 직후. platform은 게이트 안에서 돌리므로 정지가 게이트 대기로 전파되고, 30초를 넘으면 문서대로 503이 된다. 설계안들이 근거로 든 general-db M2의 쓰기 최대 21 ms는 읽기가 짧은 조건의 값이고, 긴 읽기와 겹치는 경우는 재지 않았다.

**수정.** 기본은 `PASSIVE`다. WAL이 임계를 넘을 때만 전용 연결에서 `busy_timeout` 100 ms 이하로 `RESTART`를 시도하고 게이트 밖에서 돈다. 큰 읽기는 `publish/` 사본으로 보내고 HTTP 읽기 트랜잭션에 시간 상한을 둔다.

### 2.8 `first_party` 경로가 게이트와 삭제의 사각지대다 (전부)

**시나리오 1, 오염.** 어떤 세션이 웹 페이지를 읽다가 주입된 지시로 `kb_write`를 호출한다. `first_party`는 인용 게이트와 R6 검사를 건너뛰고 기본 검색에 나가 모든 세션에 사실로 전달된다.

**시나리오 2, 위조.** simplicity의 `kb_write` 입력에 `author`가 있다. 호출자가 `user:sagae`를 적으면 사용자 판단으로 저장된다. retrieval과 durability도 서버 강제 방식을 적지 않았다.

**시나리오 3, 유출.** 세션이 `.env`를 붙여 넣은 노트를 기본값 `internal`로 쓴다. simplicity는 15분, 다른 안도 1일 안에 평문으로 GitHub에 올라가고, 불변 계층과 restic에 남는다.

| 안 | 삭제 수단 | 문제 |
|---|---|---|
| simplicity | **없음.** "물리 삭제는 없다", 연산에 삭제가 없다 | 18장 git 경로가 `secret`만 빼므로 `private`도 평문으로 나간다 |
| durability | `record.redact` | NDJSON, git, restic 과거 세대에 남는다. `--append-only`와 버킷 잠금이 `prune`을 막는다. 절차 미측정 |
| retrieval | 명시 없음 | `fp_event`가 추가 전용이다 |
| platform | `node.purge`는 `purgeable`만 | 쓰기 시점에 등급을 알아야 한다. 실수로 쓴 비밀은 해당이 없다 |

쓰기 시 비밀 탐지는 네 안 모두 없다. 민감도 필터도 같은 UID의 Bash 앞에서는 경계가 아니다. 세션은 DB 파일을 직접 읽을 수 있다. 실수 방지일 뿐이라고 적어야 한다.

**수정.** 작성자는 서버가 전송 계층에서 정한다. `agent` 작성 기록은 기본 검색에서 사용자 기록과 구분해 표시한다(retrieval의 `f:<작성자>`). 외부 사실 제보는 게이트로 보낸다. 쓰기 시 비밀 패턴을 탐지해 내보내기에서 제외한다. 삭제 절차를 git, restic까지 실제로 시험한다.

### 2.9 수집 경계가 없다 (전부)

**시나리오.** 공격자 페이지에 주입된 지시를 읽은 조사 에이전트가 `file:///home/user/.config/sagae-kb/secrets.env`나 내부 주소를 후보 URL로 돌려준다. 결정적 수집기가 이를 받아 CAS에 넣고, 그 내용은 검색되고 백업된다.

**증거.** [X8]. simplicity의 수집 HTTP는 표준 `urllib`이다. retrieval 8.4와 platform 13.1의 `kb_put(url, quote)`은 서버가 세션이 준 URL을 받는다. 설계에 스킴, 호스트, 크기 제한이 없다.

**에이전트 권한.** platform `kb-researcher`는 `WebSearch, WebFetch, Read`, retrieval `kb-tickets`는 `Read, Bash(kb fetch)`, `WebSearch`다. 비신뢰 입력, 비밀 읽기, 외부 전송이 한 작업에 모인다. Bash 샌드박스는 `Read`와 `WebFetch` 도구를 막지 않는다. `~/.config/gh/hosts.yml`의 토큰은 `repo`, `admin:public_key` 범위다. simplicity의 `research`는 `Read`가 없어 이 조합을 피한다.

**수정.** 수집 함수 하나로 모은다. `https`만, 해석 후 사설·루프백·링크 로컬 주소 거부, 리다이렉트마다 재검사, 크기와 시간 상한을 둔다. 조사 작업에서 `Read`를 뺀다.

### 2.10 사용자 결정 전에는 R8, R16이 미충족이다 (전부)

**WSL.** 타이머는 distro가 살아 있을 때만 돈다. simplicity 기본 구성은 "사용자가 WSL을 쓰는 동안"이므로 짧은 창 소스(U08 50건 약 2일치, HN 30건)가 쉬는 날 영구 유실된다. 작업 스케줄러 경로는 네 안 모두 소스 분석뿐이고 미측정이다. "로그온 여부와 무관하게 실행"은 세션 0 문제로 실패 보고가 있다. `-1` 유휴 설정도 효과 보고가 엇갈린다.

**머신 밖.** WSL은 마지막 쓰기 15초 뒤 내려갈 수 있어 다음 박동이 오지 않는다. simplicity의 RPO "약 15분", retrieval의 "디버운스 5분", platform의 "머신 밖 1시간"은 머신이 켜져 있는 동안의 값이다. durability만 `SessionEnd`로 대응하는데 현재 공식 문서상 공유 예산이 **1.5초**다. 훅에 `timeout`을 명시해야 최대 60초까지 늘어난다. `kb ship --timeout 20`은 설정 없이는 끊긴다. 강제 종료에서는 실행되지 않는다.

**순서.** platform은 백업 전에 `first_party` 쓰기를 열지 않는다. simplicity는 1단계, retrieval은 0단계에 연다. 사용자 기록이 쌓이기 시작한 뒤에는 되돌릴 수 없으므로 platform의 순서가 맞다.

**결정 필요.** 머신 밖 대상, 비밀번호 디스크 밖 보관, 감시 계정, 작업 스케줄러 등록과 실측, 증인 수집기, 유튜브 경로. CLAUDE.md는 "데이터가 절대 죽지 않게"를 요구하지만 PC 한 대로는 시점 소실 소스에 대해 달성할 수 없다. durability의 `gap` 기록처럼 공백을 데이터로 남기는 것이 정직한 하한이다.

## 3. 심각 결함

| ID | 결함 | 영향 안 | 근거 | 수정 |
|---|---|---|---|---|
| S1 | **대체 주석이 틀린 값의 방어선을 끈다.** E13은 맞는 값만 시험했다. 호출 모델의 의심은 틀린 값에 대한 마지막 방어인데 주석이 이를 무력화한다. 주석 재료인 직전 주장이 2.5절의 슬롯 오류로 만들어질 수 있다 | retrieval | [X9] | 결정적 파서나 인용구로 확인된 변경 이력에만 붙인다. 주석에 출처를 넣는다 |
| S2 | **죽은 주어로 들어오는 새 주장이 조용히 사라진다.** 잘못된 `dead` 판정 하나가 이후 주장을 기본 검색에서 지운다. `revived` 때 그 주장들을 되살리는 절차가 네 안 모두 없다. simplicity는 `superseded` 주어까지 포함한다. M18은 Codex `removed` 47개 중 10개가 살아 있다고 적고, 선언 신호 합집합 정밀도도 94.1%(비무작위)다. retrieval의 "상태 표 자동 전이"가 여기에 걸릴 수 있다 | 전부 | 문서 대조 | 적재 시 판정을 주장에 복사하지 말고 읽을 때 현재 상태로 계산한다. 자동 `dead` 건수에 상한을 둔다 |
| S3 | **WAL-reset 버그 범위의 SQLite로 쓴다.** platform `bin/kb`는 `/usr/bin/python3`이고 `kb put`을 포함한다. retrieval도 CLI를 시스템 Python으로 돌리며 같은 코어로 쓴다. 3.46.1은 버그 범위(3.7.0~3.51.2)다. 조건은 두 연결이 같은 순간 쓰기나 체크포인트를 하는 것이고, 상대가 고쳐진 버전이어도 막지 못한다 | platform, retrieval | SQLite 문서, simplicity 3장 | simplicity의 버전 가드를 쓰기 연결에 건다. 읽기 CLI는 `mode=ro`라 안전하다[X18] |
| S4 | **자가 개선 입력이 오염된다.** retrieval 골든셋은 `kb_get`이 뒤따른 카드를 약한 정답으로 쓰고(순위 편향 강화), 추출된 주장에서 역질문을 만든다(틀린 주장이 정답이 된다). 회고 입력의 거부 표본, DLQ, 0건 질의는 비신뢰 데이터다. platform `kb-retro`는 `Read`, `Bash(kb *)`를 갖고 `sources/`까지 패치한다. 공격자 도메인을 `trust: primary`로 올리는 제안이 나올 수 있다. simplicity는 LLM diff를 브랜치에 적용하고 어댑터 코드까지 골든 평가로 실행한다. 게이트 통과율을 최적화하면 재현율이 조용히 떨어지는데 재현율 지표가 없다 | 전부 | 문서 대조 | 골든셋은 사람 확인분을 기준으로 한다. 회고 입력에서 원문을 빼고 수치만 준다. 패치 평가는 샌드박스에서 돈다. 소스 신뢰 등급은 회고 대상에서 뺀다 |
| S5 | **L2 자기 제어가 눈을 감고 있다.** simplicity 7.4와 retrieval 8.3은 `--output-format json`인데 `rate_limit_event`는 stream-json에만 있다. retrieval은 버전 고정이 전제라면서 `claude`를 PATH로 부른다. 오늘 하루 사이 2.1.314에서 2.1.316으로 올라갔고 대화형 세션의 업데이트가 작업에도 영향을 준다 | simplicity, retrieval | [X18] | stream-json으로 바꾼다. 버전 경로를 고정하되 옛 판 보존 정책을 확인한다(미확인) |
| S6 | **구독 경로 정책이 "당분간"이다.** 6월 15일로 예고된 `claude -p` 별도 크레딧 전환은 중단됐을 뿐 철회가 아니다("For now, nothing has changed"). 일부 문서는 아직 옛 공지를 싣고 있다. 무인 자동 사용에 대한 언급은 없다. R14의 전제가 흔들릴 수 있다 | 전부 | 1차 출처 | 호출 수 상한을 유지한다. L2가 멈춰도 L0, L1이 도는 구조는 네 안 모두 맞다 |
| S7 | **쓰기 게이트가 없으면 대화형 쓰기가 초 단위로 튄다.** platform 외 세 안은 게이트가 없다. simplicity 2,000항목, retrieval 2,500행, durability 500건 배치는 P5 기준 p99 1.8~2.0초다. simplicity의 "약 100 ms"는 외삽이고 P5 기준 약 190 ms다 | simplicity, durability, retrieval | [X12], P5 | 게이트와 배치 100을 도입한다 |
| S8 | **게이트에 시간 제한을 넣으면 이득이 사라진다.** platform 10장은 30초 초과 시 503인데 차단 `flock`에는 제한이 없다. 재시도 구현은 p99 258 ms로 SQLite 백오프 문제를 다시 만든다. 멈춘 소유자가 있으면 무한 대기다 | platform | [X12] | 별도 대기 스레드에서 차단 `flock`을 걸고 시간 초과 시 응답한다. 구현 후 재측정한다 |
| S9 | **재구축이 파서 버전에 묶인다.** retrieval 8.5는 문구대로면 L1을 재실행한다. 새 Trafilatura가 다른 `text_sha256`을 만들면 원장 인용구가 어긋나 주장이 빠진다. `first_party` 원본이 재구축 대상 DB 안에 있고, 라이브 교체 절차가 없다. `vec.sqlite`는 `rid`로 이어져 재구축 뒤 엉뚱한 행을 가리킬 수 있다(추론). `change_log` 번호가 달라져 소비자 커서가 깨진다 | retrieval | 문서 대조, durability 2장 정정 | 표시 본문을 CAS에서 재사용한다. `fp_event`를 별도 파일로 분리한다. 벡터 키를 공개 ID로 한다 |
| S10 | **스키마 진화 경로가 없다.** "마이그레이션 코드를 쓰지 않는다"는 옛 changeset 형식을 영원히 읽는다는 뜻이고 업캐스터가 없다. `kb verify`는 같은 코드의 두 결과를 비교하므로 재구축 뒤에는 재생 버그를 잡지 못한다. 세션별 stdio 서버는 옛 코드로 새 세대를 쓴다 | simplicity | 문서 대조 | 이벤트 버전과 골든 재생을 CI에 둔다. durability, platform의 방식이다 |
| S11 | **rtk 상태가 HOME으로 샌다.** 래퍼의 환경변수는 재작성 명령에 전달되지 않는다. 지침 4 위반이고 `rtk init`과 무관하게 일어난다. platform은 "구현 때 확인", durability shim과 simplicity `env`는 실제 세션 미측정이다 | retrieval, 전부 | [X16] | 재작성 명령이 쓸 환경은 세션 `env`나 shim으로 넘기고 실제 세션에서 확인한다 |
| S12 | **쓰기 경로 하나라는 주장의 예외.** 시계열 점은 `kb.write()`를 거치지 않고 Parquet로 간다. 저널 재생으로 복원되지 않고 as-of도 없다. 64 KB를 넘는 `first_party` 본문은 WARC로 가서 T0가 아니라 일 1회 T1 백업을 탄다 | platform | 문서 대조 | 큰 본문은 T0 전용 위치로 보낸다 |
| S13 | **봇 확인은 429가 아니다.** yt-dlp 차단은 "Sign in to confirm you're not a bot" 오류로 나오고, 보고에 따르면 IP 단위라 ISP 재할당을 기다려야 한다. 네 안의 수집은 사용자가 곧 채널을 운영할 가정용 IP에서 돈다. 서킷에 봇 확인을 포함한 안은 durability뿐이다. platform은 RSS 404의 대체로 약관이 더 무거운 `yt-dlp --flat-playlist`를 승인 조건 없이 적었고(durability는 "사용자 승인 시"로 적었다), retrieval은 "P04 client 변형"을 대체 소스로 적었다. `ops.sqlite`를 잃으면 서킷 상태도 사라진다 | simplicity, retrieval, platform | 1차 출처, 문서 대조 | 서킷에 내용 기반 판정을 넣는다. 폴백이 약관 등급을 올리지 못하게 한다. 계정·쿠키 사용을 금지한다. 증인을 쓰면 IP도 분리된다 |
| S14 | **민감한 값의 위치 모순.** retrieval은 `query_log`를 백업에서 뺀다고 적었지만 `kb.sqlite` 전체를 백업 API로 복사한다. 질의 원문에 다른 프로젝트 정보가 섞인다 | retrieval | 문서 대조 | 별도 파일로 분리한다 |
| S15 | **운영량이 사람을 넘는다.** durability는 치명 조건이 많고 머신 밖 대상을 정하기 전까지 `머신 밖 백업 나이`가 상시 치명이다. 데스크톱 사용 패턴에서 `수집 침묵`이 거짓 경보가 될 수 있다. H01~H11 사람 대기열은 전 안에 상한이 없고 사용자는 한 명이다 | durability, 전부 | 문서 대조 | 단계별로 경보를 켠다. 대기열에 상한과 기본 처리를 둔다 |

## 4. 보통 이하

| ID | 내용 | 영향 안 | 근거 |
|---|---|---|---|
| M1 | 크래시 뒤 restic 잠금이 남아 `check`가 실패한다. 복원 훈련이 거짓 경보를 내고 `forget`, `prune`도 막힌다. 주기 작업 앞에 `restic unlock`(낡은 잠금만 제거)과 `--retry-lock`을 둔다 | 전부 | [X17] |
| M2 | 어휘 지연은 코퍼스 어휘 분포에 민감하다. E7은 위키 문장 순환이라 낙관적이다. X14는 전 행 편중 상한값이므로 실제는 그 사이다. 30만 게이트가 먼저 울릴 수 있다 | retrieval, 전부 | [X14] |
| M3 | stateful MCP는 유휴 재시작 뒤 404다. Claude Code가 재초기화하는지는 재지 않았다. `stateless_http=True`면 문제가 사라진다 | retrieval | [X15] |
| M4 | 예제 `obs` 항목이 자기 DDL에서 실패한다. `snapshot` 기본값 또는 PK 변경이 필요하다 | simplicity | [X18] |
| M5 | `Persistent=true`는 `OnCalendar=` 타이머에만 효과가 있다. platform의 `OnStartupSec` + `OnUnitActiveSec` 조합에서는 무효이고 retrieval은 타이머 종류를 적지 않았다 | platform, retrieval | systemd 문서 |
| M6 | 실행마다 세그먼트를 만들면 15분 박동에서 연 약 3.5만 파일이다. "파일 수 폭증이 없다"와 어긋난다. 디렉터리 0555도 월 폴더에 새 세그먼트를 만들려면 풀어야 한다 | durability | 계산 |
| M7 | `kb_neighbors` 200노드에 글자 예산이 없다. 행당 60자면 1만 토큰대다. durability, platform의 상한 20,000자는 한글 약 2만 토큰으로 경고선 1만을 넘는다 | simplicity, durability, platform | 문서 대조 |
| M8 | durability 응답은 긴 키 JSON이라 E5 기준 탭 카드의 약 2배다. `structuredContent`와 텍스트를 함께 보내므로 전송량도 2배다 | durability | E5 |
| M9 | `expected_version`이 선택이라 두 세션이 같은 레코드를 고치면 마지막 쓰기가 이긴다. 이력에는 남지만 현재 값이 조용히 바뀐다. `first_party` 갱신에는 필수로 한다 | 전부 | 문서 대조 |
| M10 | 내용 해시 기본 멱등 키는 같은 문장을 의도적으로 두 번 쓴 기록을 하나로 합친다 | platform | 문서 대조 |
| M11 | `inbox` 스캔에 안정화 검사가 없어 저장 중인 파일을 읽을 수 있다. `.path`는 66~87 ms에 반응한다. 파일 삭제의 의미도 정의되지 않았다 | 전부 | 문서 대조 |
| M12 | 월 저널 압축 회전과 동시 추가가 겹치면 옛 inode로 쓴 줄이 사라진다(추론) | simplicity | 문서 대조 |
| M13 | 가드의 "읽기 전용"은 옵션을 보지 않는다. 허용 명령에서 `--output`, `--pre`, `-o`를 거른다 | 전부 | [X16] |
| M14 | `.wslconfig`에 `networkingMode=Mirrored`가 이미 있고 VM 재시작 뒤 적용된다. 그때부터 `127.0.0.1` 수신이 Windows에서도 보인다. Unix 소켓을 기본으로 하고 토큰을 "자리"로만 두지 않는다 | simplicity, durability | 환경 확인 |
| M15 | 복원 형식이 현재 상태 Markdown뿐이면 버전 이력, 양시간, 엣지를 잃는다. `inbox`로 되돌리면 `recorded_at`이 복원 시각이 된다 | simplicity | 문서 대조 |
| M16 | 시각을 커밋 전에 확정하면 잠금 대기로 `seq`와 `at` 순서가 뒤집혀 음수 구간 행이 생길 수 있다. 시계 역행도 같다. 단조 강제는 durability뿐이다 | simplicity, retrieval, platform | 문서 대조 |

## 5. 시나리오 대조표

`버팀`은 공격이 실패했거나 설계가 막는다. `부분`은 일부 경로가 뚫리거나 조건부다. `무너짐`은 재현됐거나 구조상 막을 수단이 없다.

| 시나리오 | simplicity | durability | retrieval | platform |
|---|---|---|---|---|
| WSL 유휴 종료, 타이머 누락 | 부분. 멱등이나 기본은 WSL 사용 중에만 | 부분. 트리거 3중, `gap` 기록. 실경로 미측정 | 부분 | 부분 |
| 쓰기 잠금과 MCP 읽기 | 부분. `RESTART`[X1] | 부분 | 부분 | 부분. 게이트 안이라 전파 |
| 재구축 중 조회 | 버팀[P3]. 교체 중 크래시 미측정 | 버팀[D10] | 부분. 라이브 교체 절차 없음 | **무너짐**[X2] |
| DB 파일 손상 | 부분. 저널 구멍, DB 비백업 | 버팀[D8, D11] | 부분. 단일 파일 | 부분. 봉인 전 15분, DB 사본 일 1회 |
| 백업 없는 디스크 장애 | 결정 전 무너짐 | 결정 전 무너짐, 설계 최선 | 결정 전 무너짐 | 결정 전 무너짐, 쓰기 개방 순서 최선 |
| 스키마 진화 | 부분. 업캐스터 없음 | 버팀. 비용 큼 | 부분. 파서 의존 | 버팀. 재구축 교체는 2.1 |
| `claude -p` 비용, 재시도 | 부분. 문단 캐시 최선, 활용률 미확인 | 부분. 문서 키, 창 규칙 없음 | **무너짐**. 문서 키 + ID 변동[X19] | 부분. 문서 수 상한이 창 수를 못 묶음 |
| 유튜브 차단, ToS | 기본 꺼짐으로 버팀, 켜면 부분 | 버팀. 서킷에 봇 확인 | 기본 꺼짐, 켜면 부분 | 기본 꺼짐, 켜면 부분 |
| 인용구 통과 왜곡 | 부분. 숫자만 | **무너짐**[X6] | 부분. 숫자, 린트, 선택 함의 | **무너짐**[X6] |
| 한글 검색 누락 | 부분 | 미지정 | 부분. 별칭, 다중 질의 | **무너짐**[X5] |
| MCP 응답 비대화 | 부분. 이웃 무예산 | 부분. 긴 키, 20,000자 | 버팀. 최선 | 부분. 20,000자 |
| 자가 개선 오염 | 부분. 입력은 수치뿐, 패치 실행 위험 | 부분 | 부분. 골든셋 편향 | 부분. 소스 패치 권한 |
| 사용자 생산 정보 유실 | 부분. 2.2 | 버팀. 스풀, 훅 설정 필요 | 부분. 단일 파일 | **무너짐**. 2.1 수정 후 버팀 |
| 다중 쓰기 충돌 | 부분. `seq` 뒤집힘, 낙관 잠금 선택 | 부분 | 부분 | 부분. 게이트 최선 |
| 소비자 계약 파괴 | 부분. `seq` 재사용, ETag 충돌 | 버팀. `epoch` | 부분. 커서, stateful | **무너짐**. 재구축, 빈 검색 |
| 민감 정보 노출 | **무너짐**. 삭제 수단 없음, `private` 평문 | 부분 | 부분 | 부분 |
| 무거운 읽기가 수집을 막음 | 부분[X1] | 부분. 재구축은 분리 | 부분. `kb.sqlite` 공용 | 부분. 게시 파일 분리는 강점 |
| 생존 오판으로 유효 정보 폐기 | 부분. 적재 시 자동 `dead`, 자동 대체 | 부분. 같은 출처 자동 대체 | 부분. `kind` 구분 강점, 상태 표 자동 전이 | 부분. `temporal_scope` 강점, 번복 전파 없음 |

## 6. 안별 판정

### simplicity

- **위반.** R2(파일 진실 미구현, 재구축 실패[X3][X4]), R16(`private` 평문 전송, 삭제 수단 없음, 머신 밖 전에 `first_party` 개방), R8(기본 구성에서 WSL 사용 중에만 수집), R5(문장 미검증), R19(적재 시 자동 `dead`, 같은 출처 자동 대체[X11]).
- **강점.** 문단 해시 L2 캐시, 인용구 재확인(7.6), AND → OR 폴백[X5], 도구 없는 추출과 `Read` 없는 조사, SQLite 버전 가드, 세대 포인터 + 펜스, 가장 작은 코드량.

### durability

- **위반.** R5(숫자 검사 없음[X6]), R13(유닛 약 12개, 사본 4곳, 운영 경보), R3(시계열이 silver에 있어 그래프 밖), R4(as-of 검색 미측정), R9(토큰), R8·R16은 사용자 결정 뒤.
- **강점.** 별도 FULL 원장이라 [X4]를 버틴다. symlink 교체, 체인 + 머신 밖 앵커, `gap` 데이터, 검사기를 시험하는 원칙, `epoch`, 경로 검사, 업캐스터, 봇 확인 서킷, 스풀.

### retrieval

- **위반.** R20(rtk 상태 유출[X16]), R2(재구축이 파서 의존, `first_party` 원본이 대상 DB 안), R16(단일 파일), R7(`skey=NULL` 주장이 영구 공존), R5(주석이 왜곡을 증폭[X9]), R13(소켓 3종, venv 2개, 타이머 7개 + `.path` 1개, GPU).
- **강점.** 사실 카드와 서버 예산, 강등 표시 `r`, `claim.kind`로 역사적 사실 구분, 충돌을 숨기지 않는 표시, `f:<작성자>`, 숫자 게이트를 보류로 처리, 저장 지연 실측이 실제 ext4.
- **E12의 주의.** KB에 정답 문서 4쪽만 넣은 시험이다. 적중을 전제한 비교이고, 없는 정보일 때의 비용(검색 2회 + 웹 경로)을 재지 않았다.

### platform

- **위반.** R2·R18(`os.replace`[X2]), R10·R18(AND 질의[X5]), R5(숫자 검사 없음[X6]), R16(큰 `first_party`의 등급 강등), R17(시계열 쓰기 우회), R13(저장 등급 5개, 타이머 6개 + `.path` 1개 + 소켓 3개).
- **강점.** `flock` 게이트 + 배치 100, 실제 ext4에서 재현[X12]. `stateless_http`로 재시작을 실측[P8]. 백업 뒤 `first_party` 개방. `retention` 등급, 토큰 범위 표, 선언형 `expect`, `validate()`의 R6 검사, 호출자 입력에 `author`가 없다.

## 7. 접붙일 아이디어

| 가져올 것 | 출처 | 가는 곳 | 효과 |
|---|---|---|---|
| 별도 FULL 원장, 파생은 NORMAL | durability | 전 안 | 2.2, 2.3 해소 |
| 빌드 디렉터리 + symlink, 또는 세대 포인터 + 펜스 | durability, simplicity | platform, retrieval | 2.1 해소 |
| `flock` 게이트 + 배치 100(대기 시간 제한은 재설계) | platform | 전 안 | 쓰기 p99 731 ms → 19 ms[X12] |
| 문단 해시 L2 캐시 | simplicity | 전 안 | 2.5의 비용과 증식 차단 |
| 인용구 재확인 | simplicity | 전 안 | LLM 슬롯 없이 낡음 탐지 |
| `claim.kind` 또는 `temporal_scope` | retrieval, platform | 전 안 | 역사적 사실 보호 |
| 숫자 게이트를 보류로 처리 | retrieval | durability, platform | 왜곡 대조군 차단[X6] |
| AND → OR 폴백 | simplicity | platform, durability | 빈 결과 제거[X5] |
| 사실 카드, 서버 예산, 강등 표시 | retrieval | 전 안 | 토큰과 정직성 |
| 머신 밖 앵커, 검사기 고장 주입 | durability | 전 안 | 꼬리 절단 탐지, 거짓 안심 방지 |
| `gap` 이벤트, `epoch` | durability | 전 안 | 공백과 재동기화를 데이터로 표현 |
| 백업 뒤 `first_party` 개방 | platform | simplicity, retrieval | 대체 불가 데이터 보호 |
| `retention` 등급과 redact 연산 | platform, durability | simplicity, retrieval | 삭제 의무 대응 |
| `stateless_http` | platform | retrieval | 유휴 재시작 안전[X15] |
| SQLite 쓰기 버전 가드, `KB_HOME` 경로 검사 | simplicity, durability | 전 안 | 버그 범위와 tmpfs 차단 |
| 조사 에이전트에서 `Read` 제거 | simplicity | platform, retrieval | 권한 삼각형 분리 |

## 8. 측정이 주장보다 약한 곳

| 주장 | 실제로 잰 것 | 빠진 것 |
|---|---|---|
| simplicity "저널 재생 46.8만 행" | SQLite 표 + CAS | 파일 저널 전부. 동시성, 크래시, fsync |
| simplicity "`[P3]` 유실 0" | 표 기반 세대 교체 | ③단계. 교체 중 크래시 |
| platform "게이트가 3,370건 전부 거부" | 인용구 변조 | 문장 왜곡[X6] |
| platform "무중단 교체"(14.5) | 쓰기 없는 게시 사본 | 라이브 DB[X2] |
| platform 어휘 품질 표 | OR 규칙 | 자기 질의 규칙[X5] |
| durability D5 "유실 0" | tmpfs, SIGKILL | 페이지 캐시 소실(문서가 밝힘) |
| retrieval E13 "4/4 수용" | 맞는 값 1문항 | 틀린 값[X9] |
| retrieval E12 "1/20~1/35" | 답이 들어 있는 KB 4문항 | 없는 정보의 비용 |
| retrieval E8 "49/49" | 인용구 일치 | 문장 함의, 재추출 안정성[X10] |
| 전 안의 슬롯 기반 대체 | 없음 | 슬롯 재현율[X10] |

## 9. 공격이 실패한 것

감사의 균형을 위해 적는다.

- platform의 `flock` 게이트는 실제 ext4에서 P6을 재현했다(p99 19.0 ms 대 21.7 ms)[X12]. fsync 주입 측정이 맞았다.
- 호출마다 연결 + 게이트 조합은 5회 모두 유실이 없었다. 다만 durability D10 때문에 안전으로 인정하지 않는다.
- durability는 [X4]의 번호 재사용을 구조로 막는다.
- 진실 계층 fsync의 비용 공포는 근거가 없다. p99 8.1 ms다[X13].
- 시스템 Python의 **읽기** CLI는 `mode=ro`라 체크포인트하지 않는다[X18]. S3는 쓰기 경로만의 문제다.
- 수작업 대조에서 Haiku의 실제 49건에 명백한 거짓은 찾지 못했다[X7]. 위험은 관측된 오류율이 아니라 게이트가 그것을 알 수 없다는 점이다.
- vhdx가 C: 여유를 넘어 커지는 시나리오는 지금 해당하지 않는다. C:에 1.7 TB가 남았다. 다만 디스크 가드가 보는 948 GB는 가상 크기다.
- `claude -p` 비용 공격의 호출당 금액은 작다. 위험은 금액보다 주장 증식과 큐 정체다.
- `display:none` 인라인, 주석, `noscript`, `aria-hidden`은 Trafilatura가 걸렀다[X8].

## 10. 재지 못한 것

- 실제 `wsl --shutdown`, 작업 스케줄러 경로, 절전 복귀. 현재 세션을 죽인다. 저널 부팅 기록도 오늘 3회뿐이라 실제 가동률을 계산하지 못했다.
- 실제 전원 손실. X4는 스냅샷 복원 근사다. vhdx 위 fsync의 물리 도달 여부는 미상이다.
- WAL-reset 버그 자체의 재현. 조건만 확인했다.
- 유튜브 차단 임계. 약관상 시험하지 않았다. 차단이 같은 IP의 브라우저 사용까지 번지는지는 출처가 없다(추론).
- Claude Code가 stateful MCP 404 뒤 재초기화하는지, 네이티브 설치기의 옛 버전 보존 수.
- 공격자 페이지에서 시작하는 주입 전 과정. 경로의 각 고리만 확인했다.

## 부록 A. 재현 정보와 부수 효과

스크립트는 `/tmp/claude-1000/-home-sagae-sagae-knowloge-base/b32eef31-b09c-4e58-8902-431f279117b3/scratchpad/redteam/`에 있고 tmpfs라 재부팅하면 사라진다.

| ID | 스크립트 |
|---|---|
| X1 | `t1_ckpt.py` |
| X2 | `t2_replace.py`(`pf_core.py` 재사용) |
| X3, X4 | `t3_journal.py`, `t3b_fork.py`(`kbproto.py` 재사용) |
| X5 | `t4_ko.py` |
| X6 | `t5_gate.py` |
| X8 | `t6_hidden.py` |
| X9 | `t7_srv.py`, `t7_run.sh`(`proto_kb3.py` 변형) |
| X10, X11 | `t8_run.sh` + 비교 코드 |
| X12 | `t9_multi.py` |
| X13 | `t10_fsync.py` |
| X14 | `t25_skew.py` |
| X15 | `t14_mcp.py` |
| X16 | `hookcase.sh` |
| X18 | `ddl_obs.py`, `t13_sys.py` |

**부수 효과.**

- 실제 ext4 시험을 `~/.cache/kb-redteam/`에서 했고 끝난 뒤 디렉터리를 지웠다. 설정 파일이 아니다.
- `claude -p --model haiku` 12회, CLI 추정 합계 약 $0.014다.
- restic 0.19.1 공식 바이너리를 내려받아 SHA256을 확인하고 쓴 뒤 지웠다. 검증용 venv도 지웠다.
- 로컬 포트 18981, 18982, 18990을 시험 중에만 썼다.
- Windows 쪽은 `.wslconfig` 읽기, `wsl.exe -l -v`, `%USERPROFILE%` 조회만 했다.
- 유튜브, Google 자동완성에는 요청을 보내지 않았다.
- 저장소에는 이 문서만 추가했다. `~/.claude`, crontab, systemd, 셸 프로필은 변경하지 않았다.

## 부록 B. 1차 출처 (확인일 2026-10-31)

| 내용 | 출처 |
|---|---|
| WAL-reset 버그 범위, 마지막 연결 체크포인트 | https://sqlite.org/wal.html |
| 체크포인트 모드별 차단 동작 | https://www.sqlite.org/c3ref/wal_checkpoint_v2.html |
| `Persistent=`, 단조 타이머 | https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html |
| `SessionEnd` 1.5초 예산 | https://code.claude.com/docs/en/hooks |
| `claude -p` 구독 사용 정책 | https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan |
| WSL 유휴 설정 보고 | https://github.com/microsoft/WSL/discussions/8659 |
| 작업 스케줄러 "로그온 무관" 실패 보고 | https://learn.microsoft.com/en-us/answers/questions/2188387/task-scheduler-does-not-work-with-the-option-run-w |
| 유튜브 IP 차단 보고(커뮤니티) | https://github.com/yt-dlp/yt-dlp/issues/10128 |
| Claude Code 변경 이력 크기, 릴리스 빈도 | https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md , GitHub Releases API |
