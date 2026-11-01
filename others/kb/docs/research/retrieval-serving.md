# 다른 세션 반환 방식과 검색 품질 조사

- 작성일: 2026-10-31. 웹 출처 확인일은 전부 2026-10-31이다.
- 표기: `[S번호]`는 문서 끝 출처 표의 항목이다. `[실측]`은 이 조사에서 직접 잰 값이고, 명령은 10장에 있다.
- 패키지 버전과 날짜는 `https://pypi.org/pypi/<패키지>/json`, 저장소 상태는 `https://api.github.com/repos/<소유자>/<저장소>`를 같은 날 조회한 값이다.
- 이 문서는 시스템 설계용 조사 자료다. 코퍼스 수치는 평가용 합성값이며 지식 데이터가 아니다.

## 0. 요약

- **반환 경로:** 호출 지연은 stdio와 HTTP가 비슷하다(p50 2.38 ms 대 3.42 ms). 차이는 기동과 메모리다. 세션을 새로 열 때 stdio는 1.9초, 떠 있는 HTTP 데몬은 5.5 ms다. 세션 8개 기준 서버 메모리 합은 4,794 MB 대 597 MB다. HTTP는 대신 데몬을 살려 둘 수단이 필요하고, 현재 `Linger=no`다.
- **프로토콜:** Claude Code는 FastMCP 4.1.4 HTTP 서버에 `2026-07-28` 개정으로 붙었다. 세션 ID가 없는 무상태 방식이라 상태는 도구가 돌려준 핸들로 다뤄야 한다.
- **요청 큐:** MCP Tasks는 대안이 못 된다. 메인 대화에서만 동작하고, 서브에이전트와 일회성 `claude -p`에서는 동작하지 않으며, 새 세션이 이어받지 못한다. 지식 저장소 DB의 티켓 테이블이 맞는 구조다. 프로토타입에서 조사만 다른 두 요청이 티켓 하나로 합쳐졌다.
- **응답:** 문서 800자대에서 본문 상위 10건은 p50 10,232 토큰으로 Claude Code 경고선 10,000을 넘는다. id와 스니펫만 주면 1,048 토큰이다.
- **토크나이저:** 절대 강자는 없다. 합성 코퍼스는 Kiwi, 공개 데이터는 MeCab이 앞섰고 격차는 0.03 nDCG 이내다. FTS5 trigram은 한국어 2음절 낱말을 찾지 못해 크게 뒤진다.
- **임베딩:** 강한 Dense는 BM25보다 합성 +0.16~0.20, Ko-StrategyQA +0.19, AutoRAG +0.03 높다. 소형 e5-small은 AutoRAG에서 BM25에 졌다(−0.14). 합성 코퍼스 안에서 상위권 차이는 작다(e5-large 0.685, KURE-v3 0.683).
- **융합:** 예상과 달리 강한 Dense에 BM25를 RRF로 합치면 합성과 Ko-StrategyQA에서 유의하게 나빠졌고 AutoRAG도 같은 방향이다. 공개 논문도 같은 현상을 보고한다[S25][S26]. 약한 Dense에서는 이득이 크다(AutoRAG e5-small +0.096).
- **재순위화:** KURE-Reranker-nano는 길이를 맞추면 세 데이터셋 모두 품질을 올렸고 짧은 문서 GPU 50쌍 19 ms다. 단 `max_length` 512로 긴 문서를 자르면 AutoRAG에서 0.974가 0.929로 떨어져 Dense 단독보다 낮아진다.
- **그래프:** 순위에 섞으면 단일 홉 품질이 떨어진다. 별도 `related` 슬롯으로 주면 순위를 건드리지 않고 다중 홉 커버리지를 얻는다. 단 표본 24건, 사전 기반 엔티티라 근거는 약하다.
- **제약:** LLM API 키가 없어 GraphRAG, LightRAG, HippoRAG는 그대로 못 돌린다. `/tmp`는 16 GB tmpfs라 모델 저장소로 쓸 수 없다.

## 1. 측정 환경과 방법

### 1.1 환경

| 항목 | 값 |
|---|---|
| 장비 | WSL2, Ryzen 9 7900X3D 24스레드, RAM 30 GB, RTX 4080 SUPER 16 GB |
| Python | uv 관리형 CPython 3.12.16, 표준 `sqlite3`는 SQLite 3.53.1(FTS5, 확장 로드 가능) |
| GPU 스택 | torch 2.15.0+cu132, sentence-transformers 6.2.0, transformers 5.22.1 |
| Claude Code | 시작 시 2.1.314, 측정 중 2.1.316으로 바뀜(자동 갱신으로 추정) |
| 부하 | 다른 조사 에이전트와 동시 실행. 측정 시작 시 loadavg 3~25, GPU 메모리 약 4 GB 선점 |

지연 수치는 다른 작업과 경합한 상태의 값이다. 특히 CPU p95는 흔들렸다. 예로 BGE-M3 CPU p95 6,627 ms는 loadavg가 25까지 오른 구간의 값이라 p50만 의미가 있다.

### 1.2 데이터셋

| 이름 | 규모 | 성격 | qrels 작성자 |
|---|---|---|---|
| 합성 유튜브 | 문서 346, 질의 337 | 그룹별 패러프레이즈 문장 평균 40자. 질의 유형 kw 92, nl 103, josa 13, comp 18, mix 41, short 21, 다중 홉 24, 무응답 25 | 이 조사(저자 편향 있음) |
| AutoRAGRetrieval [S42] | 문서 720, 질의 114 | 평균 824자, 쿼리당 정답 1건 | 제3자 |
| Ko-StrategyQA [S43] | 문서 9,251, 질의 592 | 평균 320자, 위키 문단, 쿼리당 정답 평균 1.93건 | 제3자 |

합성 코퍼스는 유튜브 어휘(쇼츠, 썸네일 등)를 보려고 만들었다. 대신 패러프레이즈를 일부러 많이 넣어 Dense에 유리하다. 공개 데이터는 이 편향을 점검하려고 추가했다. 합성 코퍼스의 질의 유형은 다음과 같다.

| 유형 | 의미 | 예 |
|---|---|---|
| kw | 명사 키워드 나열 | 쇼츠 수익 배분 비율 |
| nl | 문서 어휘를 피한 자연어 질문 | 짧은 영상으로 번 돈은 어떻게 나눠 가져? |
| josa | 조사·어미 변화가 많은 질문 | 썸네일에 글씨를 많이 넣으면 안 좋나요 |
| comp | 띄어쓰기 없는 복합어 | 유튜브쇼츠수익배분율 |
| mix | 영문·약어 혼용 | YPP 가입 조건, `--dump-json` 옵션 |
| short | 한 낱말 | 협찬, 자막 |

지표는 nDCG@10, Recall@10, MRR@10이다. 표의 기본값은 다중 홉과 무응답을 뺀 단일 홉 질의 평균이다. 차이 검정은 질의 단위 페어드 부트스트랩 95% 구간이다.

### 1.3 측정하지 못한 항목과 부수 효과

- **대형 모델의 공개 데이터 측정:** 공용 `/tmp` tmpfs가 반복해서 포화됐다. 2 GB 이상 모델은 합성 코퍼스에서만 쟀고, 공개 데이터는 KURE-v2, e5-small, KURE-Reranker-nano만 쟀다.
- **미측정 모델:** bge-reranker-v2-m3, KURE-Reranker-base, Qwen3-Embedding-0.6B는 같은 이유로 못 쟀다. KURE-Sparse-nano는 모델 카드가 `trust_remote_code=True`를 요구해[S32] 내려받은 코드를 실행하지 않는 규칙에 따라 뺐다.
- **공용 `/tmp` 포화에 내 기여가 있었다.** huggingface_hub 2.x의 캐시가 `hub/blobs/`로 바뀐 것을 몰라 삭제 패턴이 빗나갔고, 15:31~15:33 사이 내 모델 캐시 약 3 GB가 남아 `/tmp`가 98%까지 찼다. 그 시간대에 다른 에이전트가 ENOSPC를 겪었을 수 있다. 15:43 전후의 포화는 여러 작업의 합이다.
- **`~/.lbdb` 생성 후 삭제:** Ladybug 확장 프로브가 `HOME` 격리 전에 실행돼 `~/.lbdb`를 만들었다. 사용 중인 프로세스가 없음을 확인하고 지웠다. 이후 실행은 `HOME`을 스크래치로 돌렸다.
- **전역 설정 변경 없음:** MCP 등록 시험은 `CLAUDE_CONFIG_DIR`을 스크래치로 돌려 수행했다. 시험 후 `~/.claude.json`의 `mcpServers`는 비어 있고 스크래치 프로젝트 항목도 없다. 파일 해시는 바뀌었으나 동시에 실행 중인 다른 세션의 갱신이다.

## 2. 반환 경로

### 2.1 경로 비교

| 경로 | 동작 | 세션 시작 비용 | 호출 지연 | 필요한 상주 프로세스 | 다른 프로젝트 접근 | 차단 요인 |
|---|---|---|---|---|---|---|
| MCP stdio | 세션마다 서버 프로세스 생성 [S1] | 도구 이름과 instructions만 [S1] | p50 2.38 ms [실측] | 없음 | 사용자 범위 또는 플러그인 | 세션당 기동 1.9초, 메모리 세션 수 배수 [실측] |
| MCP HTTP | 단일 데몬에 연결 [S1] | 같음 | p50 3.42 ms [실측] | 데몬 1개 | 사용자 범위 또는 플러그인 | 데몬 수명 관리. `Linger=no`, 변경은 사용자 승인 필요 |
| 플러그인 + 스킬 | MCP, 스킬, `bin/`을 묶어 배포 [S2] | 스킬 설명 ~19 tok [실측] | 내장 MCP와 동일 | 내장 MCP에 따름 | 설치 범위 전역. 실제 세션 호출은 `harness.md` R8에서 확인 | 파이썬 의존성은 자동 설치되지 않음(`harness.md`) |
| CLI + 스킬 | `bin/` 실행 파일을 Bash로 호출 [S2] | 스킬 설명만 | 프로세스 기동 포함 | 없음 | 플러그인 활성 시 | 파이썬이면 호출마다 임포트 비용. 미측정 |
| 세션 간 메시지 | SendMessage로 평문 전달 [S3] | 없음 | 수신 측 모델 턴 필요 | 살아 있는 세션 | 같은 머신 세션 | 메시지 약 100만 자, 수신 측 사용량 소모 [S3] |
| Channels | MCP 서버가 세션으로 이벤트 푸시 [S5] | 시작 플래그 필요 | 해당 없음 | 세션별 stdio 서버 | 해당 없음 | 연구 프리뷰, 사용자 정의 채널은 개발 플래그 필요 [S5] |
| Hook 주입 | `additionalContext`로 컨텍스트 삽입 [S7] | 문자열 크기만큼 | 없음 | 없음 | 플러그인 hook | 문자열당 10,000자 상한, 초과분은 파일로 빠짐 [S7] |

### 2.2 MCP 현재 상태

- **2026-07-28 개정:** `initialize`와 `Mcp-Session-Id`가 폐지됐고 요청마다 `_meta`에 버전과 클라이언트 정보가 실린다. `server/discover`가 추가됐다. 스트리머블 HTTP 요청은 `Mcp-Method`, `Mcp-Name` 헤더를 갖는다. Roots, Sampling, Logging은 폐기 예정이고 HTTP+SSE는 1년 유예다 [S8].
- **상태 처리:** 명세는 도구가 명시적 핸들을 돌려주고 모델이 다음 호출에 그 값을 넘기는 방식을 안내한다. 핸들의 수명과 만료 오류를 도구 설명에 적으라고 한다 [S9].
- **FastMCP:** 4.1.4(2026-10-26)가 최신이다. 4.0.0(2026-08-31)이 SDK v2와 2026-07-28 지원을 넣었고, 서버 측 sampling과 roots를 제거했다. 4.1.x에서 HTTP 세션이 SDK 기본 30분 유휴 만료로 바뀌었다 [S11].
- **실측 협상:** Claude Code가 보낸 HTTP 요청 14건은 `server/discover` 7건, `tools/list` 7건이고 전부 `mcp-protocol-version: 2026-07-28`이었다. User-Agent는 `claude-code/2.1.316 (sdk-cli)`다 [실측].
- **도구 검색:** 기본값에서 MCP 도구는 지연 로드되고 이름과 서버 instructions만 시작 시 올라간다. instructions와 상시 로드 도구 설명은 4,096자, 도구 검색으로 로드되는 설명은 16,384자에서 잘린다. 서버 항목의 `alwaysLoad`, 도구의 `_meta["anthropic/alwaysLoad"]`로 조정한다 [S1].

### 2.3 stdio와 HTTP 실측

FastMCP 4.1.4 프로토타입(FTS5 + Kiwi)을 `fastmcp.Client`로 재서 클라이언트 오버헤드가 포함돼 있다 [실측].

| 항목 | stdio | Streamable HTTP(127.0.0.1) | 비고 |
|---|---|---|---|
| 연결 후 `tools/list`, 최소 서버 | 0.919 s | 해당 없음 | fastmcp 임포트만 0.5~0.67 s |
| 연결 후 `tools/list`, Kiwi 적재 | 1.899 s | 0.0055 s | HTTP는 데몬 기동 후 값. 데몬 기동 자체는 1.17 s |
| `ping` p50 / p95 | 1.83 / 2.17 ms | 2.13 / 2.66 ms | 왕복 비용 |
| `search` id 응답 p50 / p95 | 2.38 / 2.79 ms | 3.42 / 4.6 ms | |
| `search` 본문 응답 p50 / p95 | 2.34 / 3.27 ms | 3.61 / 7.05 ms | |
| 동시 8세션 p50 / p95 | 6.93 / 15.21 ms | 36.93 / 65.15 ms | 같은 파이썬 프로세스의 클라이언트 포함. HTTP 값은 상한 근거로 쓰기 어렵다 |
| 동시 처리량 | 해당 없음 | 1세션 300, 4세션 383, 8세션 199 rps | |
| 서버 메모리 합(8세션) | 4,794 MB | 597 MB | Kiwi 프로세스별 적재 때문 |

임베딩 모델을 서버 프로세스에 올리면 차이가 커진다. GPU 적재만 4~6.4초, CPU 프로세스 RSS는 2~3.7 GB였다 [실측]. `alwaysLoad: true`인 서버는 시작 대기가 표준 5초 연결 제한에 걸린다 [S1]. 또한 `harness.md`에 따르면 서버 기동 실패는 15분간 캐시된다.

**stdio 프록시 절충안 [실측]:** `fastmcp.server.create_proxy`로 stdio 프록시를 HTTP 데몬 앞에 두면 Claude Code 쪽 설정은 stdio로 유지된다. 프록시 콜드 스타트 0.711 s, `ping` p50 6.15 ms(직접 1.74 ms), `search` p50 7.15 ms(직접 2.38 ms)로 호출당 약 4.5 ms가 더해진다. 데몬이 내려가 있을 때 프록시가 띄우는 동작은 재지 않았다.

### 2.4 사용자 범위 등록과 다른 위치에서의 접근

`CLAUDE_CONFIG_DIR`을 격리한 상태에서 `claude mcp add -s user`와 `-s local`을 실행했다 [실측].

| 조회 위치 | `kb-stdio`(user) | `kb-http`(user) | `kb-local`(local, proj-a에서 등록) |
|---|---|---|---|
| proj-a | Connected | Connected | Connected |
| 무관한 proj-b | Connected | Connected | 없음 |
| proj-a의 git worktree | Connected | Connected | Connected |

- user 범위는 `<설정 디렉터리>/.claude.json`의 최상위 `mcpServers`에, local 범위는 `projects.<프로젝트 경로>.mcpServers`에 저장됐다.
- local 범위 서버가 같은 저장소의 linked worktree에서도 보였다. 문서 표는 "현재 프로젝트만"이라고 적고, 내가 읽은 범위에는 worktree 언급이 없다 [S1].
- 이 시험은 `claude mcp list`의 상태 점검까지다. 격리 설정에는 인증 정보가 없어 모델이 실제로 도구를 호출하는 단계는 돌리지 않았다. 그 경로는 `harness.md`의 R8에서 플러그인 형태로 확인됐다.
- 우선순위는 local, project, user, 플러그인, 커넥터 순이고 항목은 병합되지 않는다 [S1].

### 2.5 플러그인과 스킬 배포

- 구조: `.claude-plugin/plugin.json`, `.mcp.json`, `skills/<이름>/SKILL.md`, `bin/`. `bin/`의 파일은 플러그인 활성 시 Bash 도구의 PATH에 오른다 [S2].
- 스캐폴드 `sagae-kb`가 `claude plugin validate`를 통과했다. HTTP 서버 URL을 `${user_config.kb_url}`로 치환하는 구성이다. 경고는 공식 디렉터리 제출용 `PRIVACY_URL_MISSING`뿐이다 [실측].
- `claude plugin details` 결과 상시 비용 ~19 tok, 스킬 호출 시 ~30 tok이다. MCP 도구 스키마는 "런타임 해석, 미집계"로 표시된다 [실측].
- 도구 이름은 `mcp__plugin_<플러그인>_<서버>__<도구>`가 된다 [S1].
- `${CLAUDE_PLUGIN_ROOT}`는 버전마다 바뀌고 `${CLAUDE_PLUGIN_DATA}`는 유지되지만 마지막 설치 제거 때 지워진다 [S2]. 지식 DB를 두기에 맞지 않는다.
- 스킬은 설명과 `when_to_use` 합산 1,536자에서 잘린다. `SKILL.md`는 500줄 이내를 권장한다 [S6].

### 2.6 세션 간 메시지, Channels, Hook

- **세션 간 메시지:** v2.1.224부터 같은 머신의 세션 소켓으로 평문이 전달되고, WSL2 세션과 Windows 네이티브 세션은 서로 닿지 못한다. 수신 측은 메시지를 프롬프트처럼 소비하고 50건까지 큐에 둔다. `-p` 작업자는 `crossSessionInbound: accept`로 무인 수신이 가능하다 [S3]. 질의마다 모델 턴이 필요해 조회 경로로는 비용이 크다. `harness.md`도 같은 결론이다. 수집 완료 통지에는 쓸 수 있다.
- **에이전트 팀:** 실험 기능이고 세션당 팀 하나, 세션 간 공유 불가다 [S4]. 저장소 조회 경로가 될 수 없다.
- **Channels:** 연구 프리뷰다. stdio 전용이고 사용자 정의 채널은 `--dangerously-load-development-channels`가 필요하다. 세션이 채널로 등록하지 않은 서버의 이벤트는 오류 없이 버려진다 [S5]. v2 런타임에서 2026-07-28로 협상한 서버는 채널로 등록되지 않는다 [S1]. 표준 프로토콜 서버와 함께 쓰기 어렵다.
- **Hook:** `SessionStart`, `UserPromptSubmit`은 `additionalContext`를 넣을 수 있다. 문자열당 10,000자 상한이고 초과하면 파일 경로와 앞 2,000자 미리보기로 바뀐다 [S7]. 세션 시작 시 완료된 티켓 알림을 넣는 용도에 맞는다.

### 2.7 구현 함정 [실측]

- **공유 `sqlite3` 연결 금지.** FastMCP는 동기 도구를 스레드풀에서 실행한다. `check_same_thread=False`로 연결 하나를 공유했더니 동시 4클라이언트 400호출 중 24건이 실패했다. 내역은 `InterfaceError: bad parameter or other API misuse` 18건, `KeyError: None` 5건, 값이 `None`으로 깨진 `TypeError` 1건이다. 스레드별 연결로 바꾸자 사라졌다.
- **다중 프로세스 쓰기는 문제없었다.** WAL 모드, `timeout=5`에서 stdio 서버 8개가 같은 DB에 800건 쓰기를 오류 없이 3.26초에 마쳤다. 단 tmpfs 위 값이라 디스크 fsync 비용은 반영되지 않았다.
- **서버 실행 인터프리터.** 시스템 Python 3.14에는 `ensurepip`이 없어 `python -m venv`가 안 된다. uv 관리형 Python은 이번 측정에서 스크래치에만 있으므로 상시 경로가 따로 필요하다.
- **FastMCP `_meta` 전달 확인.** `@mcp.tool(meta={"anthropic/maxResultSizeChars": 100000})`이 `tools/list`의 `_meta`에 그대로 실렸다.

## 3. 요청 큐 패턴

### 3.1 MCP Tasks가 맞지 않는 이유

MCP Tasks는 장기 작업 핸들을 표준화한 확장이다. 상태는 `working`, `input_required`, `completed`, `failed`, `cancelled`이고 클라이언트가 `tasks/get`으로 폴링한다 [S10]. Claude Code는 v2.1.304부터 지원한다. 그러나 제약이 요청 큐의 수명과 맞지 않는다 [S1].

| 제약 | 내용 | 요청 큐에 미치는 영향 |
|---|---|---|
| 호출 위치 | 메인 대화만, 서브에이전트 불가 | 작업자 서브에이전트가 요청할 수 없다 |
| 실행 표면 | 터미널 CLI, Agent SDK, GitHub Actions. VS Code와 데스크톱 불가 | 표면별로 동작이 갈린다 |
| 헤드리스 | 일회성 `claude -p`는 미지원. stream-json 입력 세션만 조건부 지원 | 스케줄 세션에서 쓰기 어렵다 |
| 세션 연속성 | 새 세션은 추적하지 않음, 원래 세션을 재개해야 함 | 다음 수집은 몇 시간에서 며칠 뒤다 |
| FastMCP 구현 | `fastmcp[tasks]` 필요, 비동기 함수 필수. 기본 인메모리는 재시작 시 소실, 영속화는 Redis 필요 [S12] | Redis가 없다 |

단일 세션 안에서 도는 장기 조회에는 쓸 수 있다. 수집 요청은 세션을 넘어 살아야 하므로 저장소 DB의 레코드가 맞다. 명세가 안내하는 핸들 방식과 같은 형태다 [S9].

### 3.2 티켓 패턴 프로토타입 [실측]

```sql
create table rq(id integer primary key, key text unique, topic text,
                reason text, requester text, status text, n integer);
insert into rq(key, topic, reason, requester, status, n) values(?,?,?,?,'queued',1)
  on conflict(key) do update set n = n + 1;
```

- `key`는 주제를 형태소 분석해 정렬한 문자열이다. "네이버 클립 수익 정산 주기"와 "네이버 클립의 수익 정산 주기"가 같은 티켓 `rq-1`로 합쳐지고 `duplicates: 1`을 돌려줬다.
- 응답은 `{ticket, status, duplicates}`다. 호출자는 티켓을 들고 끝낸다.
- 의미가 같고 어휘가 다른 요청은 이 방식으로 합쳐지지 않는다. 임베딩 유사도 병합은 재지 않았다.

### 3.3 다음 수집과의 연결

| 단계 | 내용 | 근거 |
|---|---|---|
| 적재 | `request_info` 도구로 티켓 생성, 대기 중 동일 키는 병합 | 3.2 실측 |
| 소비 | 스케줄된 수집이 `queued`를 집어 `in_progress`로 전이 | 스케줄 방식은 `harness.md` 범위 |
| 해소 | 수집 결과의 사실을 티켓에 연결하고 `done`으로 전이. 그래프에서 티켓 노드와 주제 엔티티를 잇는다 | 설계 제안, 미측정 |
| 통지 | 다음 `SessionStart` hook의 `additionalContext`, 또는 살아 있는 세션에 SendMessage | [S7][S3] |
| 조회 | `search` 응답에 관련 티켓 상태를 함께 표시 | 설계 제안, 미측정 |

큐 구현은 표준 라이브러리 SQLite면 충분하지만 기성 부품도 있다. `litequeue` 0.14는 멱등 키, 클레임, 재시도, 만료 복구를 제공하고 런타임 의존성이 없다 [S44]. `huey` 3.5.3의 `SqliteHuey`는 표준 `sqlite3`만으로 큐를 돌린다 [S45]. 이 큐는 작업 실행기라기보다 지식 그래프의 일부 레코드라서, 정렬·병합 규칙을 직접 정하는 단순 테이블과의 비교가 필요하다.

### 3.4 "없는 정보"를 자동으로 알 수 있는가 [실측]

답이 없는 질의 25건과 답이 있는 질의 312건을 상위 1위 점수로 가른 결과다.

| 신호 | AUROC | 정답 95% 유지 시 무응답 오판율 |
|---|---|---|
| Dense 코사인 최고값 | 0.60(e5-small) ~ 0.87(KURE-v2) | 미계산 |
| KURE-Reranker-nano 최고값(후보 50) | 0.92 | 0.64~0.72 |

재순위화 점수가 낫지만 단독 임계값으로는 무응답의 3분의 2가 걸러지지 않는다. 표본도 25건뿐이다. [S25]도 검색 점수의 보정이 전 모델에서 약하다고 보고하고, 판별력이 가장 높은 BM25의 AUROC@10이 0.602다. 임계값은 큐 자동 등록의 근거로 약하다. 호출한 모델이 결과를 읽고 `request_info`를 부르는 흐름이 기본이고, 저점수 질의 로그는 수집 후보 힌트로 쓰는 쪽이 근거에 맞다.

## 4. 응답 설계

### 4.1 Claude Code 쪽 한도 [S1]

| 항목 | 값 |
|---|---|
| 경고 임계 | 도구 출력 10,000 토큰, 고정값 |
| 기본 상한 | 25,000 토큰, `MAX_MCP_OUTPUT_TOKENS`로 변경 |
| 파일 저장 전환 | 텍스트 50,000자 초과 시 파일로 저장하고 경로만 대화에 남김 |
| 도구별 상향 | `_meta["anthropic/maxResultSizeChars"]`, 상한 500,000자 |
| 오류 텍스트 | 약 11,000자 초과 시 앞뒤 5,000자만 유지 |
| HTTP 응답 | 16 MiB 초과 시 요청 실패 |
| 도구 호출 시간 | `MCP_TOOL_TIMEOUT` 기본 약 28시간, 유휴 제한 HTTP 5분·stdio 30분, 2분 초과 시 메인 대화에서 백그라운드 전환 |

이 한도는 한글에서 문서대로 동작하지 않을 수 있다. `compression.md` M9는 한글 45,000자(47,434토큰)가 기본 설정에서 파일로 빠지지 않고 인라인으로 들어왔다고 기록했다. 응답 예산은 클라이언트에 맡기지 않고 서버가 `k`, 문자 수 상한, 커서로 직접 제한해야 안전하다. 또한 `rtk`는 Bash 출력만 다루고 MCP 응답에는 손대지 못한다(`compression.md`). MCP 경로의 압축은 응답 구조로만 얻는다.

### 4.2 점진적 공개 실측 [실측]

상위 10건 응답의 토큰량이다. `tiktoken cl100k_base`로 쟀다. Claude 토크나이저가 아니므로 상대 비교용이다.

| 형식 | 합성(40자) p50 | Ko-StrategyQA(320자) p50 / p95 | AutoRAG(824자) p50 / p95 |
|---|---:|---:|---:|
| 본문+출처 JSON 10건 | 1,013 | 3,580 / 5,486 | 10,232 / 16,351 |
| `search_result` 블록 형태 10건 | 937 | 3,504 / 5,386 | 10,119 / 16,211 |
| id+점수+스니펫 JSON 10건 | 670 | 675 / 722 | 1,048 / 1,169 |
| id+점수+스니펫 TSV 10건 | 515 | 520 / 569 | 894 / 1,016 |
| 후속 `get` 3건 본문+출처 | 278 | 977 / 1,589 | 3,157 / 5,165 |

- 800자대 문서면 본문 10건은 경고선을 넘고 p95는 16,000 토큰을 넘는다.
- AutoRAG 기준 id 응답 뒤 필요한 3건만 받는 흐름은 합계 약 4,200 토큰으로 본문 10건의 약 41%다.
- 긴 문서일수록 이득이 크고, 40자 문장에서는 거의 없다(본문 10건 1,013, id 후 3건 조회 합계 948). 저장 단위가 짧은 사실이면 분리 이득이 제한적이다.
- 스니펫 형식에서 TSV는 JSON보다 15~23% 작다.
- `compression.md`도 같은 방향이다. id 우선 구조가 42,633토큰을 3,498토큰으로 줄였고(−91.8%), 표기 형식 변경보다 구조 변경의 효과가 컸다.

### 4.3 관련 근거

- Anthropic은 `response_format`으로 간결·상세를 고르게 하는 방식을 예시로 든다. 예시에서 간결 응답은 상세의 약 3분의 1이다. 페이지네이션, 범위 선택, 필터, 잘라내기를 권하고, 잘릴 때는 더 좁은 검색을 유도하라고 한다. 사람이 읽는 식별자가 환각을 줄인다고 적었다 [S13].
- qmd는 `query`, `get`, `multi_get`, `status`로 같은 구조를 쓴다 [S34]. Claude Code에서 쓰는 저장소형 도구의 전례다.
- `resource_link`는 본문 없이 URI만 주는 표준 수단이고, `structuredContent`를 쓸 때는 직렬화한 JSON을 TextContent로도 주라고 명세가 권한다 [S9].

### 4.4 출처 포함 형식

- Claude API의 `search_result` 블록은 `source`, `title`, `content[{type:text,text}]`, `citations.enabled`를 갖고 Claude가 자동 인용하게 해 준다. 도구 결과나 사용자 메시지에 넣는다 [S14].
- 다만 MCP 명세의 콘텐츠 타입은 text, image, audio, resource_link, 임베디드 resource다 [S9]. MCP 경유로 `search_result`가 그대로 모델에 도달하는지는 확인하지 못했다.
- 그래서 필드 구성만 맞추는 편이 안전하다. 사실 단위로 다음 필드를 내려보낼 수 있다.

```json
{"id":"f-1042","text":"...","source":{"url":"...","publisher":"...","published_at":"2026-09-01","fetched_at":"2026-10-31"},"as_of":"2026-Q3","entities":["e-yt-shorts"]}
```

- 저장소 내용은 외부에서 온 데이터다. 명세는 서버의 출력 정제와 클라이언트의 결과 검증을 요구한다 [S9]. 응답 본문은 데이터 필드로 분리해, 안의 문장이 지시처럼 읽히지 않게 경계를 둘 필요가 있다.

## 5. 검색 품질 실측

### 5.1 어휘 검색 토크나이저

BM25 엔진은 FTS5이고 k1=1.2, b=0.75로 고정이다 [S35]. `*_content`는 명사, 동사·형용사 어간, 부사, 영문, 숫자를 남겼다. 영문 토큰은 형태소 분석 전에 떼어 보존했다. 질의는 토큰 OR다.

| 구성 | 합성 | AutoRAG | Ko-StrategyQA | 재현율@10(합성) |
|---|---:|---:|---:|---:|
| Kiwi(content) | **0.487** | 0.932 | 0.593 | 0.512 |
| MeCab(content) | 0.479 | **0.943** | **0.619** | 0.508 |
| MeCab + 사용자 사전 53어 | 0.482 | 0.939 | 0.619 | |
| Lindera ko-dic(content) | 0.476 | 0.932 | 0.612 | 0.503 |
| 문자 bigram(사전 없음) | 0.470 | 0.923 | 0.595 | 0.499 |
| tantivy 내장 ngram(2,2) | 0.478 | 0.922 | 0.564 | 0.504 |
| LanceDB FTS ngram(2,3) | 0.469 | 0.927 | 미측정 | 0.497 |
| FTS5 trigram + 2글자 LIKE 보강 | 0.424 | 0.888 | 0.465 | 0.443 |
| FTS5 trigram, 슬라이딩 3-gram | 0.292 | 0.878 | 0.453 | 0.308 |
| FTS5 unicode61 원문 | 0.295 | 0.818 | 0.387 | 0.318 |
| FTS5 trigram, 토큰 그대로 | 0.267 | 0.768 | 0.355 | 0.275 |

합성 코퍼스의 질의 유형별 nDCG@10이다.

| 구성 | kw | nl | josa | comp | mix | short |
|---|---:|---:|---:|---:|---:|---:|
| Kiwi | 0.687 | 0.238 | 0.342 | **0.514** | 0.651 | **0.573** |
| MeCab | 0.701 | 0.235 | 0.350 | 0.411 | 0.644 | 0.514 |
| MeCab + 사용자 사전 | 0.696 | | | 0.412 | | 0.567 |
| Lindera | 0.685 | 0.238 | 0.355 | 0.384 | 0.657 | 0.530 |
| bigram | 0.676 | 0.207 | 0.345 | 0.493 | 0.649 | 0.564 |

페어드 부트스트랩 95% 구간이다.

| 비교(앞이 기준) | 합성 | AutoRAG | Ko-StrategyQA |
|---|---|---|---|
| MeCab − Kiwi | −0.008 [−0.024, +0.007] | +0.010 [−0.004, +0.027] | **+0.026 [+0.010, +0.043]** |
| Kiwi − bigram | +0.017 [−0.004, +0.038] | +0.009 [−0.018, +0.036] | −0.003 [−0.025, +0.020] |
| MeCab − Lindera | +0.003 [−0.011, +0.016] | **+0.011 [+0.001, +0.025]** | +0.007 [−0.004, +0.017] |
| Kiwi − trigram 슬라이딩 | **+0.195 [+0.159, +0.231]** | | |

읽을 점은 다음과 같다.

- 형태소 분석기 사이 차이는 작다. 유의한 쌍은 Ko-StrategyQA의 MeCab 우위와 AutoRAG의 MeCab·Lindera 차이뿐이다.
- 사전 없는 bigram은 세 데이터셋 모두에서 Kiwi와 통계적으로 구분되지 않는다. 신조어에 강하고 의존성이 없지만 색인이 두 배다(9.8 MB 대 20 MB).
- MeCab의 약점은 사전 연식이다. `python-mecab-ko-dic`은 2022-12 패키지다. `쇼츠`를 `쇼/VCP+EP+EF`, `츠/IC`로, `썸네일`을 `썸/네/일`로 쪼갰다. 사용자 사전으로 short는 0.514에서 0.567로 회복됐으나 comp는 그대로다. 사용자 사전 빌드는 `python -m mecab dict-index`로 되고 cargo가 필요 없다.
- Kiwi에도 함정이 있다. `search.list`가 `s` + `earch.list`로 쪼개졌고, `유튜브쇼츠`는 한 토큰이 됐다. 영문 토큰을 먼저 떼어 내는 전처리로 해결된다. 또 `스티비 원더`처럼 공백을 포함한 토큰을 낸다(Ko-StrategyQA 문서 토큰 641,157개 중 3,465개). FTS5에서는 구문 질의로 맞지만, tantivy `whitespace` 토크나이저에서는 색인과 질의가 어긋나 0.593이 0.565로 떨어졌다. 공백 포함 사용자 단어의 허용 공백 수는 `space_tolerance`로 조정한다 [S39].
- trigram의 원인은 명세에 있다. 3자 미만 부분 문자열은 일치하지 않는다 [S35]. 실제로 337개 질의 중 85개가 빈 결과였고, 한국어의 2음절 낱말이 대부분 빠진다.
- 엔진은 품질을 크게 좌우하지 않는다. 같은 토큰에서 FTS5, tantivy, bm25s가 합성 코퍼스 0.003 이내, 공개 데이터의 MeCab 토큰 0.01 이내였다(Kiwi 공백 토큰 사례 제외).

운영 수치다.

| 항목 | Kiwi | MeCab | Lindera | bigram |
|---|---:|---:|---:|---:|
| 적재 시간 | 0.59~0.77 s | 0.01 s | 0.33~0.54 s | 0 |
| 프로세스 RSS | 523 MB | 91 MB | 290 MB | 14 MB |
| 질의 토큰화 p50 | 0.21 ms | 0.06 ms | 0.024 ms | 0.003 ms |
| 문서 토큰화(320자) | 2.67 ms | 0.74 ms | 0.37 ms | 0.035 ms |
| FTS5 질의 p50(9,251건) | 0.48 ms | 0.51 ms | 0.53 ms | 1.44 ms |

엔진별 수치와 통합 방식이다.

- **FTS5:** 토큰을 공백으로 이어 넣는 방식은 표준 `sqlite3`로 된다. 원문 스니펫이 필요하면 APSW가 답이다. `apsw.fts5`로 Kiwi를 FTS5 토크나이저로 등록해 원문을 저장했고 `snippet()`이 `[쇼츠] 광고 [수익]은…`처럼 원문에 강조를 표시했다. nDCG 0.477, p50 0.26 ms [실측].
- **tantivy-py 0.27.0:** 질의 p50 0.043 ms로 FTS5의 약 10분의 1이다. 색인은 위치 정보 없이 1.7 MB이고, 토큰 본문까지 담은 FTS5(9.8 MB)와 비교 조건이 다르다. Python API의 토크나이저는 `facet`, `ngram`, `raw`, `regex`, `simple`, `whitespace`뿐이고 Lindera 등록 수단이 없다 [실측]. `lindera-tantivy`는 Rust 크레이트라 [S41] cargo가 없는 이 환경에서는 빌드할 수 없다. "tantivy + Lindera"는 미리 토큰화해 `whitespace`로 넣는 경로로만 쟀다.
- **Lindera:** `lindera` 6.2.0 휠에서는 `embedded://ko-dic`이 실패했고, `lindera-python-ko-dic` 2.2.0 [S40]에서 동작했다. 둘 다 모듈명이 `lindera`라 같은 환경에 넣으면 충돌한다. 별도 venv로 쟀다 [실측].
- **LanceDB FTS:** `lindera/ko-dic`은 토크나이저 이름으로 인식되지만 `~/.local/share/lance/language_models/lindera/ko-dic`이 없어 실패했다. 공식 문서는 Lindera를 일본어로 안내한다 [S36]. 사전 배치는 시험하지 않았다.

### 5.2 임베딩

합성 코퍼스, GPU는 배치 32, CPU는 12스레드다 [실측].

| 모델 | 차원 | 가중치 MB | VRAM MB | nDCG@10 | Recall@10 | MRR | GPU 질의 p50 | CPU 질의 p50 | GPU 문서/s | CPU 문서/s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| multilingual-e5-large | 1024 | 2,262 | 2,196 | **0.685** | **0.722** | 0.859 | 11.5 ms | 104 ms | 575 | 28 |
| KURE-v3 | 2048 | 2,299 | 2,257 | 0.683 | 0.721 | **0.860** | 17.8 ms | 85 ms | 337 | 21 |
| KURE-v1 | 1024 | 2,288 | 2,221 | 0.664 | 0.696 | 0.848 | 15.1 ms | 103 ms | 381 | 29 |
| KURE-v2(late interaction) | 128×토큰 | 308 | 355 | 0.654 | 0.673 | 0.857 | 21.7 ms | 63 ms | 304 | 78 |
| BGE-M3 | 1024 | 2,293 | 2,221 | 0.651 | 0.677 | 0.850 | 21.3 ms | 108 ms | 380 | 30 |
| multilingual-e5-small | 384 | 493 | 471 | 0.560 | 0.588 | 0.740 | 12.7 ms | 25 ms | 486 | 130 |

유형별 nDCG@10이다.

| 모델 | kw | nl | josa | comp | mix | short |
|---|---:|---:|---:|---:|---:|---:|
| e5-large | 0.788 | 0.561 | 0.696 | 0.653 | 0.771 | 0.697 |
| KURE-v3 | 0.788 | 0.559 | 0.630 | 0.672 | 0.794 | 0.654 |
| KURE-v1 | 0.769 | 0.552 | 0.612 | 0.585 | 0.746 | 0.693 |
| KURE-v2 | 0.772 | 0.518 | 0.620 | 0.626 | 0.730 | 0.698 |
| BGE-M3 | 0.757 | 0.530 | 0.592 | 0.567 | 0.744 | 0.709 |
| e5-small | 0.731 | 0.381 | 0.456 | 0.500 | 0.666 | 0.601 |

공개 데이터 결과다.

| 모델 | AutoRAG | Ko-StrategyQA | 비고 |
|---|---:|---:|---|
| KURE-v2 | **0.972** | **0.808** | 토큰 평균 391 / 158, 문서당 약 200 KB / 81 KB(f32) |
| e5-small | 0.801 | 0.752 | |
| 어휘 최고(MeCab) | 0.943 | 0.619 | 비교용 |

- 합성 코퍼스 순위는 3자 벤치마크와 다르다. KURE 저장소의 MTEB(kor, v2) 9개 과제 평균 nDCG@10은 KURE-v2 0.8160, KURE-v3 0.8027, KURE-v1 0.7616, BGE-M3 0.7509다 [S27]. 합성 코퍼스는 40자 문장 위주라 차이가 덜 드러났을 수 있다(추정). 내 합성 수치는 유튜브 어휘에서 무너지지 않는다는 확인으로 읽고, 모델 간 순위는 공개 데이터 실측과 [S27]을 함께 봐야 한다.
- [S27]은 KURE 팀 자체 집계다. 독립 재현은 이번에 KURE-v2와 e5-small만 했고, 공개 데이터에서 KURE-v2가 앞선 방향은 일치한다.
- KURE-v2는 가중치 308 MB로 소형이지만 다중 벡터라 저장량이 다르다. 평균 800자 문서 기준 문서당 약 200 KB로, 1024차원 단일 벡터(4 KB)의 약 50배다. 1만 문서에 약 2 GB, 전수 MaxSim은 9,251건에서 질의당 약 25 ms(GPU)였다. 큰 코퍼스에서는 PLAID 같은 색인이 필요하다고 모델 카드가 적는다 [S29].
- KURE-v3는 2048차원이고 1024로 줄여도 점수의 99%를 유지한다고 적혀 있다 [S27][S30]. 이 축소는 재지 않았다. KURE-v1은 BGE-M3를 한국어 데이터로 미세 조정한 모델이다 [S28].
- BGE-M3 저장소 본체에는 safetensors가 없다(`pytorch_model.bin`과 ONNX). 이번 측정은 `torch.load` 기본값 `weights_only=True` 경로로 불렀다.

### 5.3 융합

RRF가 Dense를 끌어내린 결과를 그대로 믿지 않고 깊이, k, 가중치, 선형 결합을 바꿔 확인했다 [실측].

| 데이터셋 / Dense | Dense | RRF60 깊이100 | RRF60 깊이20 | 선형 α0.5 | 선형 α0.7 | 선형 α0.85 | 어휘 단독 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 합성 / e5-large | **0.685** | 0.590 | 0.615 | 0.627 | 0.670 | **0.685** | 0.487 |
| 합성 / KURE-v3 | **0.682** | 0.587 | 0.601 | 0.622 | 0.663 | 0.677 | 0.487 |
| 합성 / KURE-v2 | 0.654 | 0.580 | 0.595 | 0.610 | 0.646 | **0.656** | 0.487 |
| 합성 / e5-small | 0.560 | 0.551 | 0.555 | 0.563 | **0.571** | 0.570 | 0.487 |
| Ko-StrategyQA / KURE-v2 | **0.808** | 0.713 | 0.728 | 0.760 | 0.796 | 0.806 | 0.619 |
| Ko-StrategyQA / e5-small | 0.752 | 0.713 | 0.721 | 0.739 | **0.760** | 0.759 | 0.619 |
| AutoRAG / KURE-v2 | **0.972** | 0.957 | 0.957 | 0.956 | 0.970 | 0.965 | 0.943 |
| AutoRAG / e5-small | 0.801 | 0.897 | 0.897 | 0.923 | 0.909 | 0.854 | 0.943 |

AutoRAG / e5-small의 선형 α0.3은 0.934다. 합성 코퍼스의 RRF 전체 sweep(깊이 5~100, k 10·60, Dense 가중치 1~3)에서도 e5-small을 뺀 5개 모델은 Dense 단독을 넘지 못했다.

RRF가 Dense 대비 달라진 폭의 부트스트랩 구간이다(깊이 20).

| 데이터셋 / Dense | 차이 [95% 구간] |
|---|---|
| 합성 / KURE-v3 | −0.082 [−0.102, −0.062] |
| 합성 / e5-large | −0.071 [−0.090, −0.052] |
| 합성 / e5-small | −0.005 [−0.023, +0.012] |
| Ko-StrategyQA / KURE-v2 | −0.080 [−0.095, −0.065] |
| Ko-StrategyQA / e5-small | −0.031 [−0.045, −0.017] |
| AutoRAG / KURE-v2 | −0.015 [−0.034, +0.003] |
| AutoRAG / e5-small | **+0.096 [+0.058, +0.136]** |

- 동일 현상이 문헌에 있다. [S25]는 BRIGHT 벤치마크의 선형 융합에서 강한 모델이 나빠졌다고 적었다(GTE-Qwen2 −2.0, ReasonIR −2.9, 100점 척도). 약 20 이하의 모델에는 무비용 개선이고, 최상위 모델에는 피하라고 한다. RRF는 같은 경향에 개선폭이 더 작다고 한다. [S26]은 특허 검색에서 RRF가 5개 중 2개 모델에서만 나아졌다고 보고한다.
- RRF가 이긴 연구도 있다. 텍스트·표 문서 연구는 RRF가 양쪽을 모두 이겼다고 보고한다(Recall@5 RRF 0.695, BM25 0.644, Dense 0.587) [S46]. 이 데이터는 BM25가 Dense보다 강해서, 내 AutoRAG / e5-small 사례와 같은 쪽이다. 어느 쪽이 약한지에 따라 결과가 갈린다.
- 선형 결합은 Dense 가중치를 높이면 Dense에 수렴한다. 합성과 Ko-StrategyQA에서 α0.85는 Dense와 같은 수준이다. 큰 이득은 없고 손해도 없다. [S26]도 RRF가 튜닝된 선형 보간보다 낮다고 적는다.
- **어휘 색인의 가치는 순위 융합 말고도 있다.** GPU 없이 도는 대체 경로이고, AutoRAG에서는 단독 0.943으로 e5-small을 이겼다. 재순위화와 묶으면 더 오른다(5.4).
- 어휘가 Dense를 이긴 질의도 있다. KURE-v2 기준 합성 35건, Ko-StrategyQA 37건, AutoRAG 3건이다.

### 5.4 재순위화

KURE-Reranker-nano(가중치 597 MB, fp16)를 후보 위에 올렸다 [실측]. 합성은 `max_length=512`, AutoRAG는 2048, Ko-StrategyQA는 512다.

| 후보 | 합성 | AutoRAG(2048) | Ko-StrategyQA |
|---|---:|---:|---:|
| 어휘 상위 50 → 재순위 | 0.599 | 0.974 | 0.775 |
| e5-small 상위 50 → 재순위 | 0.678 | 0.974 | 0.831 |
| KURE-v2 상위 50 → 재순위 | 0.706 | 0.974 | **0.841** |
| KURE-v2 30 + 어휘 30 합집합 → 재순위 | 0.698 | 0.974 | 0.839 |
| e5-large 상위 50 → 재순위 | 0.709 | 미측정 | 미측정 |
| KURE-v3 상위 50 → 재순위 | **0.712** | 미측정 | 미측정 |
| KURE-v3 30 + 어휘 30 합집합 → 재순위 | **0.715** | 미측정 | 미측정 |

Dense 단독 대비 상승폭은 합성 KURE-v3 +0.030, Ko-StrategyQA KURE-v2 +0.033, e5-small +0.079다. 합집합 후보와 Dense 후보의 차이는 ±0.008 이내였다(검정은 안 했다).

- **길이 제한이 결과를 뒤집었다.** AutoRAG에서 `max_length=512`일 때 재순위 결과는 0.929로 KURE-v2 단독 0.972보다 낮았다. 2048로 늘리자 0.974가 됐다. 문서를 자르면 재순위화가 해가 될 수 있다. 모델 상한은 8,192 토큰이다 [S31].
- 어휘 + 재순위만으로 Ko-StrategyQA 0.775다. 임베딩 없이 e5-small 단독(0.752)을 넘는다.
- 처리량은 합성 3,544쌍/s, Ko-StrategyQA 533쌍/s, AutoRAG 236쌍/s(512), 194쌍/s(2048)다. 문서 길이에 크게 좌우된다.
- 지연은 짧은 문서 50쌍 기준 GPU p50 19.4 ms, CPU p50 1,193 ms(12스레드)다. VRAM 최고 472 MB, 긴 문서에서 1,048 MB다.
- KURE 팀 집계로 9개 과제 평균 nDCG@10은 KURE-Reranker-base 0.8908, nano 0.8757, bge-reranker-v2-m3 0.8518이다 [S33]. 측정 조건이 다르다.

### 5.5 그래프 순회

사전 68개 엔티티로 문서 135건을 연결한 이분 그래프를 썼다(간선 208). LLM 추출이 아니라 사전 일치다. 다중 홉 질의 24건은 정답 두 문서가 브리지 엔티티로 이어진다 [실측].

순위에 섞는 경우(기준선은 RRF(Kiwi, KURE-v3))다.

| 방식 | 다중 홉 정답 전부 포함 @3 | @5 | @10 | 단일 홉 nDCG |
|---|---:|---:|---:|---:|
| 그래프 없음 | 0.667 | 0.875 | 0.917 | 0.587 |
| PPR(α=0.5) 후 RRF | 0.667 | 0.875 | 1.000 | 0.574 |
| 1홉 확장 후 RRF | 0.833 | 0.958 | 1.000 | 0.521 |

순위를 두고 `related` 슬롯으로 분리한 경우다. 단일 홉 순위는 변하지 않는다.

| 기준 순위 | 상위 5 | 상위 5 + related 5 | 상위 10 |
|---|---:|---:|---:|
| KURE-v2 Dense | 0.875 | 1.000 | 0.958 |
| BGE-M3 Dense | 0.792 | 1.000 | 0.917 |
| e5-large Dense | 0.792 | 0.958 | 0.833 |
| KURE-v3 Dense | 0.917 | 0.958 | 1.000 |
| Dense + nano 재순위(전 모델 공통) | 0.917~0.958 | 1.000 | 0.917~0.958 |

- 1홉 확장을 순위에 섞으면 다중 홉은 좋아지지만 단일 홉이 0.066 깎인다. 분리하면 그 손실이 없다.
- `related`는 상위 3건의 희소 엔티티(문서 빈도 15 이하)에서 뽑은 이웃이다. 합산 항목 수는 상위 10과 같다.
- 근거는 약하다. 질의 24건이고, 문서 346건이라 상위 10에 이미 대부분 들어간다. 질의에 단서 어휘가 많이 남아 있다. LLM으로 뽑은 관계 그래프의 효과는 재지 않았다.
- GraphRAG-Bench는 단순 사실 검색에서 기본 RAG가 GraphRAG와 같거나 낫고, 복합 추론에서 그래프가 앞선다고 보고한다 [S23]. 내 결과와 방향이 같다.

### 5.6 벡터 저장

KURE-v1 벡터 346건에 잡음을 더해 만든 1024차원 데이터를 실제 질의 벡터로 조회했다 [실측]. 소수 중심 주변에 몰린 분포라 실제 코퍼스의 재현율과 다를 수 있다. 재현율은 전수 코사인 상위 10 대비다. 2만 건은 파일, 10만 건은 tmpfs 절약을 위해 인메모리다.

| 엔진 / 색인 | 2만 p50 | 2만 재현율 | 2만 크기 | 2만 구축 | 10만 p50 | 10만 재현율 | 10만 구축 |
|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite-vec 0.1.9 전수 | 36.3 ms | 1.000 | 170 MB | 3.7 s | 90.3 ms | 1.000 | 1.5 s |
| sqlite-vec bit + float 재채점(후보 200) | 7.3 ms | 0.942 | 이론값 +2.6 MB | 0.1 s | 17.9 ms | 0.836 | 0.4 s |
| LanceDB 0.41 flat | 55 ms | 1.000 | 82 MB | 0.2 s | 464 ms | 1.000 | 1.2 s |
| LanceDB IVF_HNSW_SQ | 5.9 ms | 0.895 | 106 MB | 1.3 s | 3.8 ms | 0.772 | 9.0 s |
| LanceDB IVF_HNSW_SQ + refine 20 | 8.9 ms | 1.000 | 106 MB | 1.3 s | 6.0 ms | 0.999 | 9.0 s |
| LanceDB IVF_PQ + refine 20 | 8.4 ms | 0.975 | 109 MB | 3.9 s | 미측정 | | |
| LanceDB IVF_PQ | 5.7 ms | 0.350 | 109 MB | 3.9 s | 미측정 | | |
| Ladybug 0.22.1 HNSW | 4.0 ms | 1.000 | 92 MB | 6.9 s | 3.4 ms | 0.787 | 32.5 s |
| DuckDB 2.0 vss HNSW | 3.7 ms | 0.987 | 156 MB | 2.1 s | 3.2 ms | 0.921 | 5.7 s |

- 비교용 numpy 전수는 2만 건 1.0 ms, 10만 건 6.4 ms다. 벡터를 메모리에 올린 다중 스레드 배치 곱의 질의당 평균이다. 문서 수만 건이면 전용 색인이 필수는 아니다.
- LanceDB flat은 같은 2만 건에서 첫 실행 75 ms, 재실행 55 ms로 흔들렸다. 표는 재실행 값이다.
- sqlite-vec 안정판은 전수 검색이고 파일이 큰 편이다. 저장소에는 `sqlite-vec-diskann.c`, `sqlite-vec-ivf.c`가 있고 0.1.10-alpha.4(2026-05-18)가 최신 사전 릴리스다 [S37]. 최근 푸시도 2026-05-18이다. 이슈와 PR은 10월까지 들어오고 있다. README는 v1 전이라 호환 파괴가 있을 수 있다고 적는다 [S37].
- HNSW 기본값의 10만 건 재현율은 0.79~0.92라 파라미터 조정 없이 쓰기 어렵다. 조정은 재지 않았다.
- Ladybug와 DuckDB의 벡터 기능은 확장으로 내려받는다. 각각 `~/.lbdb`, `~/.duckdb`에 쓰고 첫 실행에 네트워크가 필요하다. DuckDB HNSW 영속화는 `hnsw_enable_experimental_persistence` 플래그가 필요했다.
- LanceDB는 MaxSim 다중 벡터를 지원하고 코사인만 허용한다. 색인 없는 큰 다중 벡터 표는 프로세스를 오래 멈출 수 있다고 문서가 경고한다 [S38].
- 2만 건 쓰기와 그래프 질의를 함께 본 그래프 저장소 측정은 `graph-store` 조사 범위다.

### 5.7 파이프라인 지연 합산

단계 p50을 더한 추정치다. 실제 파이프라인을 한 번에 잰 값은 아니다 [실측 합산].

| 단계 | GPU 경로 | CPU 대체 경로 |
|---|---:|---:|
| MCP 왕복 | 2~3 ms | 2~3 ms |
| 질의 토큰화(Kiwi) | 0.2 ms | 0.2 ms |
| FTS5(9,251건) | 0.5 ms | 0.5 ms |
| 질의 임베딩 | 12~22 ms | 25~108 ms |
| 벡터 검색(2만, 전수~HNSW) | 4~36 ms | 4~36 ms |
| 재순위화 50쌍 | 19 ms(짧은 문서) | 1,193 ms |
| 합계 | 약 40~80 ms | 약 1.2~1.3 s, 재순위 제외 시 30~150 ms |

긴 문서에서 재순위화는 처리량 기준 약 210~260 ms(GPU, 50쌍, 194~236쌍/s)로 늘어난다.

## 6. 최신 연구에서 쓸 수 있는 부분

| 기법 | 핵심 | 요구 | 이 환경에서 쓸 부분 | 제외할 부분 | 출처 |
|---|---|---|---|---|---|
| GraphRAG 3.3.0 | 엔티티 그래프와 커뮤니티 요약 | LLM 필수, Python <3.14 | 커뮤니티 개념 정도 | 전체 파이프라인. 전역 검색 질의당 평균 331,375 토큰 | [S21][S23] |
| LazyGraphRAG | NLP 명사구 공출현 그래프, 색인에 LLM 미사용 | 색인 비용 벡터 RAG 수준, 전체 GraphRAG의 0.1%. 질의 시 LLM | **명사구 공출현 그래프.** Kiwi·MeCab 명사로 키 없이 구현 가능 | 공개 라이브러리 포함 여부는 페이지에서 확인 안 됨 | [S22] |
| LightRAG 1.5.7 | 이중 수준 검색, 증분 갱신 | LLM 필수. 질의당 평균 100,832 토큰(GraphRAG-Bench) | **재색인 없는 증분 병합** 아이디어 | 프레임워크 자체 | [S18][S19][S23] |
| HippoRAG 2 | PPR, 문단 노드 통합 | OpenIE에 LLM, OpenAI 호환 엔드포인트 필수. 질의당 1,008 토큰 | **엔티티+문단 PPR.** 연상 과제 7% 개선 보고. 내 사전 그래프 실측에서 PPR 이득은 작았다 | 패키지 `2.0.0a4`(2025-06) 알파 | [S16][S17][S23] |
| RAPTOR | 재귀 군집 요약 트리 | LLM 요약 | 주제별 상위 요약 노드 개념 | 원 저장소 최종 푸시 2024-09 | [S20] |
| Contextual Retrieval | 청크마다 50~100토큰 맥락을 붙여 임베딩·BM25 | LLM. 캐시 사용 시 문서 100만 토큰당 $1.02 | **청크 맥락 문장을 수집 시 함께 작성.** 수집 에이전트가 이미 원문을 읽고 있다 | 상위 20 실패율 35%, 49%, 67% 감소는 Anthropic 데이터 기준 | [S15] |
| LinearRAG | 관계 없는 Tri-Graph, 가벼운 엔티티 추출 | 구축에 토큰 추가 소모 없음 | **관계 추출 없는 그래프.** 내 사전 그래프와 같은 계열 | 수치 미확인 | [S24] |
| KURE-Sparse | 학습된 희소 표현 | `trust_remote_code` | 희소 벡터 경로의 존재만 기록 | 코드 검토 전 실행 불가 | [S27][S32] |
| qmd | FTS5 + sqlite-vec + GGUF 재순위, MCP, 플러그인 | Node 22+, GGUF 모델 | **전체 구조의 전례.** RRF k=60, 상위 30 재순위, 위치 가중 혼합 | 기본 임베딩은 영어 중심. CJK는 문자 분해 후 구문 질의(`prior-art.md`) | [S34] |

GraphRAG-Bench의 토큰 수치는 논문 그림 8~9의 표 값이다. 같은 논문 본문의 서술(최대 4×10^4 토큰)과 맞지 않아 자릿수 비교로만 읽어야 한다 [S23].

"LLM 필수"의 뜻이 중요하다. 이 환경에는 API 키가 없지만 Claude Code 세션은 있다. 수집 에이전트가 문서를 읽는 시점에 엔티티, 관계, 맥락 문장을 함께 쓰면 별도 키가 필요 없다. 대신 위 프레임워크를 그대로 돌릴 수는 없고 산출 형식만 차용한다. 로컬 LLM 경로는 재지 않았다.

Contextual Retrieval의 200,000 토큰 미만 조언도 참고할 만하다. 그 규모면 RAG 없이 전체를 프롬프트에 넣으라고 한다 [S15]. 저장소 초기 규모에서는 검색 복잡도보다 범위 지정이 먼저일 수 있다.

## 7. 후보 표

유지보수 상태는 2026-10-31의 PyPI, GitHub 조회값이다. 적합성의 근거는 해당 절에 있다.

### 7.1 반환 경로

| 후보 | 최신 버전 | 릴리스 날짜 | 유지보수 상태 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|---|
| FastMCP | 4.1.4 | 2026-10-26 | 활발. 10-31 푸시, ★28.3K | Apache-2.0 | 실측 통과. Claude Code와 2026-07-28 협상 | 없음 |
| MCP Python SDK | 2.3.0 | 2026-10-02 | 활발 | MIT | FastMCP 의존으로 설치됨 | 없음 |
| MCP stdio | 명세 2026-07-28 | 2026-07-28 | 표준 | 해당 없음 | 상주 없음. 세션당 1.9 s, Kiwi RSS 수백 MB | 세션 수 배수 메모리 |
| MCP Streamable HTTP | 명세 2026-07-28 | 2026-07-28 | 표준 | 해당 없음 | 연결 5.5 ms, 메모리 1개분, 모델 공유 | 데몬 수명. `Linger=no` |
| Claude Code 플러그인 | CC 2.1.316 | 측정 중 갱신 | 활발 | 상용 | validate 통과, 상시 ~19 tok | 파이썬 의존성은 자동 설치 안 됨(`harness.md`) |
| 세션 간 메시지 | v2.1.224+ | 해당 없음 | 정식 기능 | 상용 | 완료 통지용 | 살아 있는 세션 필요 |
| Channels | 연구 프리뷰 | 해당 없음 | 프리뷰 | 상용 | 부적합 | 개발 플래그, v2 런타임 제외 |
| MCP Tasks | ext-tasks | 해당 없음 | 확장 | 해당 없음 | 세션 내부 장기 조회만 | 서브에이전트·`-p` 불가, Redis 필요 |
| qmd | v2.8.3 | 2026-08-16 | 활발. 10-15 푸시, ★30.8K | MIT | 구조 참고 | 한국어 토크나이저 없음, 그래프 없음 |

### 7.2 토크나이저와 어휘 엔진

| 후보 | 최신 버전 | 릴리스 날짜 | 유지보수 상태 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|---|
| kiwipiepy | 0.24.1 | 2026-10-20 | 활발 | Apache-2.0 | 신조어·복합어 강점. 0.487 / 0.932 / 0.593 | RSS 523 MB, 공백 토큰 |
| python-mecab-ko | 1.3.7 | 2024-07-14 | 패키지 정체 | BSD-3 | 공개 데이터 최고. 0.479 / 0.943 / 0.619, RSS 91 MB | 사전 2022-12, 신조어는 사용자 사전 필요 |
| lindera + lindera-python-ko-dic | 6.2.0 / 2.2.0 | 2026-09-26 / 2026-02-10 | 활발 | MIT | 0.476 / 0.932 / 0.612, 가장 빠름 | 모듈명 충돌, 사전 연식은 MeCab 계열 |
| SQLite FTS5 trigram | 표준 라이브러리 내장(측정 3.53.1) | 해당 없음 | 활발 | Public Domain | 부적합. 0.292 / 0.878 / 0.453 | 3자 미만 불일치 |
| 문자 bigram | 자체 전처리 | 해당 없음 | 해당 없음 | 해당 없음 | 무의존. 0.470 / 0.923 / 0.595 | 색인 2배 |
| tantivy-py | 0.27.0 | 2026-10-22 | 활발 | MIT | 가장 빠른 BM25, 색인 소형 | Lindera 네이티브 미지원, cargo 없음 |
| APSW | 3.54.1.0 | 2026-10-19 | 활발 | OSI 계열 | Kiwi FTS5 토크나이저 등록 성공, 원문 스니펫 | 표준 `sqlite3`와 별도 연결 |
| bm25s | 0.3.16 | 2026-10-28 | 활발 | MIT | 품질 동등, 질의 p50 0.55 ms | 증분 갱신 미확인 |
| LanceDB FTS | 0.41.0 | 2026-10-29 | 활발 | Apache-2.0 | ngram 0.469 / 0.927 | `lindera/ko-dic` 사전 없음 |

표의 세 수치는 합성 / AutoRAG / Ko-StrategyQA의 nDCG@10이다.

### 7.3 임베딩과 재순위화

| 후보 | 최신 갱신 | 릴리스 날짜 | 유지보수 상태 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|---|
| KURE-v3 | 2026-10-21 | 2026-10-20 | 신규 | Apache-2.0 | 합성 0.683. MTEB 0.8027 [S27] | 2 GB+, 2048차원 저장량 |
| KURE-v2 | 2026-09-07 | 2026-08-29 | 신규 | Apache-2.0 | 합성 0.654, 공개 최고 0.972 / 0.808 | 문서당 81~200 KB, 전용 색인 필요 |
| KURE-v1 | 2026-09-07 | 2024-12-21 | 안정 | MIT | 합성 0.664 | 2 GB+ |
| BGE-M3 | 2024-07-03 | 2024-01 | 정체, 다운로드 월 3천만 | MIT | 합성 0.651 | 본체 safetensors 없음 |
| multilingual-e5-large | 2026-04-02 | 2023-06 | 안정 | MIT | 합성 0.685 | 2 GB+ |
| multilingual-e5-small | 2026-04-02 | 2023-06 | 안정 | MIT | CPU 25 ms. 0.560 / 0.801 / 0.752 | 한국어 품질 낮음 |
| Qwen3-Embedding-0.6B | 2026-04-20 | 2025-06 | 활발 | Apache-2.0 | 미측정 | tmpfs 공간 |
| KURE-Reranker-nano | 2026-10-21 | 2026-10-01 | 신규 | Apache-2.0 | 전 데이터 상승, GPU 19 ms, VRAM 0.5~1 GB | CPU 1.2 s, 길이 설정 주의 |
| KURE-Reranker-base | 2026-10-21 | 2026-10-01 | 신규 | Apache-2.0 | 미측정, MTEB 0.8908 [S33] | 가중치 3.4 GB |
| bge-reranker-v2-m3 | 2024-06-24 | 2024-03 | 정체 | Apache-2.0 | 미측정, MTEB 0.8518 [S33] | tmpfs 공간 |
| KURE-Sparse-nano | 2026-10-19 | 2026-10-12 | 신규 | Apache-2.0 | 미측정, MTEB 0.7716 [S27] | `trust_remote_code` 필요 |
| sentence-transformers | 6.2.0 | 2026-10-21 | 활발 | Apache-2.0 | `MultiVectorEncoder`, `CrossEncoder` 실측 동작 | torch 포함 약 6 GB |

### 7.4 벡터 저장과 그래프 내장 벡터

| 후보 | 최신 버전 | 릴리스 날짜 | 유지보수 상태 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|---|
| sqlite-vec | 0.1.9, 0.1.10-alpha.4 | 2026-03-31, 2026-05-18 | 코드 푸시 5개월 정체, 이슈·PR은 활동. ★8.2K | MIT/Apache-2.0 | FTS5와 한 파일. 2만 36 ms, 10만 90 ms | 안정판 전수 검색, v1 이전 |
| LanceDB | 0.41.0 | 2026-10-29 | 활발. 10-31 푸시, ★11.8K | Apache-2.0 | refine 포함 10만 6 ms, 재현율 0.999. 다중 벡터 지원 | 별도 저장소, 한국어 FTS 미해결 |
| Ladybug | 0.22.1 | 2026-10-28 | 활발. 10-30 푸시, ★1.9K. Kuzu 후속 | MIT | 그래프와 벡터 한 파일. 2만 4 ms | 10만 기본 재현율 0.787, 확장 다운로드, 신생 |
| DuckDB + vss | 2.0.0 | 2026-10-21 | 활발 | MIT | 10만 3.2 ms, 0.921 | HNSW 영속화 실험 플래그, 확장 다운로드 |
| Kuzu | 0.11.3 | 2025-10-10 | **보관 처리** | MIT | 신규 채택 부적합 | 저장소 archived |
| fast-plaid + PyLate | 1.7.0.2110 / 1.6.0 | 2026-08-27 / 2026-06-11 | 활발 | MIT | KURE-v2용 색인 후보. 미측정 | 별도 색인 |

### 7.5 그래프·기억 프레임워크

| 후보 | 최신 버전 | 릴리스 날짜 | 유지보수 상태 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|---|
| graphrag | 3.3.0 | 2026-10-08 | 활발. ★36.5K | MIT | 그대로는 부적합 | LLM 키, Python <3.14 |
| lightrag-hku | 1.5.7 | 2026-09-02 | 활발. ★40.4K | MIT | 그대로는 부적합 | LLM 키, 질의 토큰 비용 |
| hipporag | 2.0.0a4 | 2025-06-24 | 패키지 정체, 저장소 10-06 푸시 | MIT | PPR 개념만 | OpenAI 호환 엔드포인트, 알파 |
| RAPTOR | 저장소 | 2024-09 최종 푸시 | 정체 | MIT | 개념만 | LLM |
| graphiti-core | 0.31.2 | 2026-10-20 | 활발. ★32.4K | Apache-2.0 | `prior-art.md` 범위 | LLM 키 |
| cognee | 1.6.6 | 2026-10-29 | 활발. ★32.9K | Apache-2.0 | `prior-art.md` 범위 | LLM 키 |

### 7.6 요청 큐

| 후보 | 최신 버전 | 릴리스 날짜 | 유지보수 상태 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|---|
| SQLite 티켓 테이블 | 표준 라이브러리 | 해당 없음 | 해당 없음 | Public Domain | 프로토타입 동작, 800건 동시 쓰기 무오류 | 재시도·만료 로직 직접 구현 |
| litequeue | 0.14 | 2026-07-31 | 유지 중 | MIT | 멱등 키, 클레임, 재시도 보유. 미측정 | Python 3.12+ |
| huey (SqliteHuey) | 3.5.3 | 2026-10-24 | 활발 | MIT | 작업 실행기형. 미측정 | 소비자 프로세스 필요 |
| fastmcp[tasks] | FastMCP 4.1.x | 2026-10 | 활발 | Apache-2.0 | 부적합 | Redis, 세션 수명 |

## 8. 실측으로 드러난 제약

1. `/tmp`는 16 GB tmpfs이고 RAM을 쓴다. torch 스택 약 6 GB와 2.3 GB 모델 몇 개로 포화됐고 ENOSPC가 반복됐다. 모델 저장 경로는 디스크여야 한다.
2. huggingface_hub 2.x 캐시는 `hub/blobs/`와 `xet/`를 쓴다. `models--*` 패턴 삭제는 아무것도 지우지 않는다.
3. LLM API 키가 없어 GraphRAG, LightRAG, HippoRAG를 그대로 실행할 수 없다.
4. cargo가 없어 `lindera-tantivy`를 빌드할 수 없다. tantivy-py에는 Lindera 등록 수단이 없다.
5. FastMCP 동기 도구는 스레드풀에서 돈다. `sqlite3` 연결 공유는 오류와 값 손상을 낸다.
6. 시스템 Python 3.14는 venv를 못 만든다. 상시 서비스용 인터프리터 경로를 따로 정해야 한다.
7. 임베딩을 서버 프로세스에 넣으면 기동이 4~6초 이상 늘어난다. `alwaysLoad` 서버의 시작 대기 5초 제한에 걸릴 수 있다.
8. KURE-Sparse는 원격 코드를 요구하고 BGE-M3 본체는 pickle 가중치다.
9. Ladybug와 DuckDB 확장은 첫 실행에 네트워크가 필요하고 홈 디렉터리에 쓴다.
10. 재순위화 `max_length`를 문서 길이에 맞추지 않으면 품질이 Dense 단독보다 떨어진다.
11. Kiwi는 공백 포함 토큰을 낸다. 공백 기준 토크나이저와 섞으면 색인과 질의가 어긋난다.
12. `lindera`와 `lindera-python-ko-dic`은 같은 모듈명이라 한 환경에 공존하기 어렵다.
13. MCP Tasks는 서브에이전트와 일회성 `claude -p`에서 동작하지 않는다.
14. 2026-07-28로 협상한 서버는 Channels로 등록되지 않는다.

## 9. 미확인 사항

- 모델이 실제로 HTTP MCP 도구를 호출하는 경로. 상태 점검과 `fastmcp.Client` 호출까지만 재었다. stdio 플러그인 경로는 `harness.md` R8에서 확인됐다.
- HTTP 데몬을 살려 둘 수단. `Linger=no`, WSL 유휴 종료의 영향, `SessionStart` hook으로 띄울 때 MCP 연결과의 경쟁 상태를 재지 않았다.
- `search_result` 블록이 MCP 도구 결과로 모델까지 그대로 도달하는지.
- Claude 토크나이저 기준 토큰 수. 전부 cl100k 근사다.
- 외부 스크립트가 다른 세션의 소켓에 메시지를 넣는 정확한 페이로드. 문서는 인증 줄만 설명한다 [S3].
- 대형 임베딩의 공개 데이터 성능. [S27] 수치만 있다.
- KURE-v3 1024차원 축소, 재순위화 교차 모델 비교, 하이브리드 희소 경로.
- 실제 벡터 10만 건 이상에서의 재현율. 측정 벡터는 군집 편향이 있다. HNSW 파라미터 조정도 안 했다.
- 디스크 위 SQLite 쓰기 지연. 측정은 tmpfs다.
- LLM으로 추출한 관계 그래프의 효과. 다중 홉 평가는 24건, 사전 기반이다.
- 무응답 판별 임계값. 음성 표본이 25건뿐이다.
- 합성 코퍼스 수치의 일반화. 저자가 문서와 질의를 모두 썼다.

## 10. 재현 명령

스크립트와 산출물은 `SP=/tmp/claude-1000/-home-sagae-sagae-knowloge-base/b32eef31-b09c-4e58-8902-431f279117b3/scratchpad/retrieval` 아래에 있고 tmpfs라 재부팅하면 사라진다. 저장소에는 넣지 않았다.

```bash
source $SP/../env.sh; cd $SP
uv venv --python 3.12 venv
uv pip install --python venv/bin/python kiwipiepy python-mecab-ko tantivy lindera sqlite-vec lancedb apsw bm25s \
  fastmcp huggingface_hub hf-xet tiktoken torch sentence-transformers ladybug duckdb
uv venv --python 3.12 venv-lindera; uv pip install --python venv-lindera/bin/python lindera-python-ko-dic

# 코퍼스와 공개 데이터
venv/bin/python -I scripts/corpus.py $SP
venv/bin/python -I scripts/ext_fetch.py $SP          # mteb/Ko-StrategyQA, mteb/AutoRAGRetrieval

# 어휘 검색 (DS = data, data_autorag, data_sqa)
venv/bin/python -I scripts/tok_dump.py $SP DS kiwi_content          # bigram, mecab_content, mecab_content_user 동일
LINDERA_DIC=embedded://ko-dic venv-lindera/bin/python -I scripts/tok_dump.py $SP DS lindera_content
WITH_BM25S=1 venv/bin/python -I scripts/lex_eval.py $SP DS

# 임베딩·재순위
scripts/run_embed.sh data BAAI/bge-m3 nlpai-lab/KURE-v1 nlpai-lab/KURE-v2 nlpai-lab/KURE-v3 \
  intfloat/multilingual-e5-small intfloat/multilingual-e5-large
SCRIPT=rerank_eval.py scripts/run_embed.sh data nlpai-lab/KURE-Reranker-nano
venv/bin/python -I scripts/rerank_cand.py $SP data_sqa nlpai-lab/KURE-Reranker-nano
scripts/rr_autorag.sh                                               # max_length=2048

# 융합·그래프·부트스트랩
venv/bin/python -I scripts/hybrid_eval.py $SP data
venv/bin/python -I scripts/fusion_sweep.py $SP data
venv/bin/python -I scripts/fusion2.py $SP data_sqa mecab_content kiwi_content
venv/bin/python -I scripts/graph2.py $SP
venv/bin/python -I scripts/boot_ext.py $SP

# 벡터 저장 (확장이 홈에 쓰이지 않게 HOME 격리)
HOME=$SP/fakehome venv/bin/python -I scripts/vec_bench.py $SP 20000 1024 sqlite-vec lancedb ladybug duckdb
VEC_MEM=1 HOME=$SP/fakehome venv/bin/python -I scripts/vec_bench.py $SP 100000 1024 sqlite-vec lancedb ladybug duckdb

# 반환 경로
venv/bin/python -I scripts/mcp_bench.py $SP
venv/bin/python -I scripts/mcp_bench2.py $SP
venv/bin/python -I scripts/resp_tokens.py $SP
CLAUDE_CONFIG_DIR=$SP/cc-config claude mcp add -s user --transport http kb-http http://127.0.0.1:18933/mcp
CLAUDE_CONFIG_DIR=$SP/cc-config claude mcp list
CLAUDE_CONFIG_DIR=$SP/cc-config claude plugin validate ./plugin-kb
CLAUDE_CONFIG_DIR=$SP/cc-config command claude --plugin-dir ./plugin-kb plugin details sagae-kb
```

주요 구현 값은 다음과 같다.

| 항목 | 값 |
|---|---|
| FTS5 스키마 | `fts5(body, tokenize="unicode61 remove_diacritics 0 tokenchars '-._=:/%'")` |
| 질의 | 고유 토큰을 `"t1" OR "t2" ...`로 연결, `order by bm25(d)` |
| content 품사 | NNG, NNP, SL, SH, SN, XR, VV, VA, MAG(Kiwi는 -R, -I 변이 포함) |
| 라틴 전처리 | `[A-Za-z0-9][A-Za-z0-9._\-=:/%]*`를 먼저 떼어 원형과 분할형을 모두 보존 |
| RRF | `Σ w/(k+rank+1)`, 기본 k=60 |
| 선형 결합 | 각 목록 상위 100을 질의별 min-max 정규화 후 `α·dense + (1−α)·lex` |
| PPR | 엔티티 idf 가중 이분 그래프, α=0.5, 30회 반복 |
| 모델 로드 | `trust_remote_code=False`, 데이터 읽는 Python은 `-I` |

## 출처

전부 2026-10-31 확인. 구분은 1차(공식 문서, 저장소, 논문 원문)와 팀 자체 집계를 나눴다.

| ID | 출처 | 구분 |
|---|---|---|
| S1 | https://code.claude.com/docs/en/mcp | 1차 |
| S2 | https://code.claude.com/docs/en/plugins-reference | 1차 |
| S3 | https://code.claude.com/docs/en/cross-session-messaging | 1차 |
| S4 | https://code.claude.com/docs/en/agent-teams | 1차 |
| S5 | https://code.claude.com/docs/en/channels-reference | 1차 |
| S6 | https://code.claude.com/docs/en/skills | 1차 |
| S7 | https://code.claude.com/docs/en/hooks | 1차 |
| S8 | https://blog.modelcontextprotocol.io/posts/2026-07-28/ | 1차 |
| S9 | https://modelcontextprotocol.io/specification/2026-07-28/server/tools | 1차 |
| S10 | https://modelcontextprotocol.io/extensions/tasks/overview | 1차 |
| S11 | https://gofastmcp.com/changelog | 1차 |
| S12 | https://gofastmcp.com/servers/tasks | 1차 |
| S13 | https://www.anthropic.com/engineering/writing-tools-for-agents | 1차 |
| S14 | https://platform.claude.com/docs/en/build-with-claude/search-results | 1차 |
| S15 | https://www.anthropic.com/engineering/contextual-retrieval | 1차 |
| S16 | https://arxiv.org/abs/2502.14802 | 1차 |
| S17 | https://github.com/OSU-NLP-Group/HippoRAG | 1차 |
| S18 | https://arxiv.org/abs/2410.05779 | 1차 |
| S19 | https://github.com/HKUDS/LightRAG/releases | 1차 |
| S20 | https://arxiv.org/abs/2401.18059 | 1차 |
| S21 | https://github.com/microsoft/graphrag/releases | 1차 |
| S22 | https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/ | 1차 |
| S23 | https://arxiv.org/html/2506.05690v3 | 1차 |
| S24 | https://arxiv.org/abs/2510.10114 | 1차 |
| S25 | https://arxiv.org/html/2604.03676v1 | 1차, 6.2·6.3절 |
| S26 | https://arxiv.org/html/2605.24297v1 | 1차 |
| S27 | https://github.com/nlpai-lab/KURE | 1차, 팀 자체 집계 |
| S28 | https://huggingface.co/nlpai-lab/KURE-v1 | 1차, 팀 자체 집계 |
| S29 | https://huggingface.co/nlpai-lab/KURE-v2 | 1차, 팀 자체 집계 |
| S30 | https://huggingface.co/nlpai-lab/KURE-v3 | 1차, 팀 자체 집계 |
| S31 | https://huggingface.co/nlpai-lab/KURE-Reranker-nano | 1차, 팀 자체 집계 |
| S32 | https://huggingface.co/nlpai-lab/KURE-Sparse-nano | 1차, 팀 자체 집계 |
| S33 | https://github.com/nlpai-lab/KURE/blob/main/eval/cross-encoder/results/README.md | 1차, 팀 자체 집계 |
| S34 | https://github.com/tobi/qmd | 1차 |
| S35 | https://www.sqlite.org/fts5.html | 1차 |
| S36 | https://lancedb.github.io/lance/format/table/index/scalar/fts | 1차 |
| S37 | https://github.com/asg017/sqlite-vec | 1차 |
| S38 | https://docs.lancedb.com/search/multivector-search | 1차 |
| S39 | https://raw.githubusercontent.com/bab2min/kiwipiepy/main/README.md | 1차 |
| S40 | https://pypi.org/project/lindera-python-ko-dic/ | 1차 |
| S41 | https://github.com/lindera/lindera-tantivy | 1차 |
| S42 | https://huggingface.co/datasets/mteb/AutoRAGRetrieval | 1차 |
| S43 | https://huggingface.co/datasets/mteb/Ko-StrategyQA | 1차 |
| S44 | https://github.com/litements/litequeue | 1차 |
| S45 | https://huey.readthedocs.io/en/latest/api.html | 1차 |
| S46 | https://arxiv.org/html/2604.01733v1 | 1차 |
