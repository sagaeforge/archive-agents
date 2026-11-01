# 도메인 G 소스 인벤토리와 생존 판정 기준

도메인 G(AI 코딩 도구 활용)의 소스 지도다. `sources-inventory.md`와 같은 형식을 따르고, `harness.md`·`compression.md`에서 확인한 내용은 다시 조사하지 않고 참조만 한다.

- 확인일: 2026-10-31. 실측 구간은 같은 날 07:34~08:10 UTC다. 주석마다 확인일을 적었다.
- 대상 버전: Claude Code 2.1.316, Codex CLI 0.166.0(둘 다 조사일 기준 최신).
- 근거 표기: **[실측]** 이 환경에서 호출·실행한 결과, **[1차]** 공급자 원문을 받아 문구를 확인한 것, **[2차]** 제3자 글·검색 요약으로 1차 원문을 확인하지 못한 것.
- `수집 주기` 열은 소스 자체의 갱신 주기를 옮긴 값이다. 판단이 아니다. 제3자 권고는 "출처가 주장"으로 귀속해 적었다.
- 문서 성격: §3 생존 판정 기준은 시스템 설계 입력이다(CLAUDE.md "지침 5 적용 기준"의 설계 문서 예외). 나머지는 사실 인벤토리이며 순위·점수·제언을 넣지 않는다. 스타 수는 정렬 기준이 아니라 메타데이터로만 적었다.
- 실측 원본은 보존하지 않았다. 재현 명령과 수치는 §12에 있다.

## 1. 핵심 사실

1. **어떤 단일 신호도 죽음을 판정하지 못한다.** 저장소 138개 표본에서 수명 종료로 확인한 17개 중 `archived` 플래그가 잡은 것은 10개(58.8%)다. README 선언 문구는 15개를 잡았지만 오탐이 1건 있었다. 마지막 커밋 365일 이상은 4개만 잡았다. 표본은 무작위가 아니며 재현율은 상한값이다(§3.5). [실측 S-1]
2. **`archived`는 양방향으로 틀린다.** `continuedev/continue`, `microsoft/autogen`, `openai/skills`, `openai/swarm`, `stravu/crystal`은 플래그가 false인데 README가 중단·폐기를 선언한다. `autogen`의 마지막 커밋은 3일 전이다. 반대로 `gsd-build/get-shit-done`, `MoonshotAI/kimi-cli`, `opencode-ai/opencode`, `wshobson/commands`는 archived지만 프로젝트는 다른 저장소에서 이어진다. [실측 S-1, S-2]
3. **이동이 사망보다 흔하다.** 같은 표본에서 저장소 이름·조직 변경이 21건 잡혔다. `claude-flow`→`ruflo`, `sst/opencode`→`anomalyco/opencode`, `block/goose`→`aaif-goose/goose`, `badlogic/pi-mono`→`earendil-works/pi`, `oobabooga/text-generation-webui`→`oobabooga/textgen` 등이다. GitHub GraphQL의 `nameWithOwner`로 기계 판별된다. [실측 S-1]
4. **CHANGELOG의 "Removed"는 절반이 기능 사망이 아니다.** Claude Code 항목 8,497건 중 `Removed/Deprecated/Dropped`로 시작하는 54건을 분류하니 기능·플래그·모델 제거가 28건(51.9%), 시작 안내 문구 같은 UI 정리가 23건, 제한 해제가 3건이다. 번복도 있다(output styles는 5일 만에 Un-deprecate). 반대로 `/pr-comments` 제거, `--remote` 폐기, `claude-code-plugins` 마켓플레이스 폐기는 CHANGELOG에 없고 문서에만 있다. [실측 S-3]
5. **문서 HTTP 200은 생존이 아니다.** 제거된 ultraplan의 문서 URL은 200을 주고, 제목이 "Ultraplan is no longer available"인 1,102바이트 묘비 페이지다. `llms.txt`에서는 빠졌다. 다만 `slash-commands`처럼 색인에 없어도 현행 내용을 주는 별칭 페이지가 있어서 "색인 누락 = 죽음"도 오탐이다. [실측 S-5]
6. **Codex는 수명 단계를 기계로 내준다.** `codex features list`가 기능 플래그 194개의 단계를 출력한다. under development 82, stable 58, removed 47, experimental 4, deprecated 3이다. 그런데 소스 정의상 `Removed`는 "플래그가 쓸모없어졌으나 호환성 때문에 남김"이다. removed이면서 기본값 true인 10개(`worktrees`, `steer` 등)는 기능이 살아 있다. [실측 S-4]
7. **기능은 모델·인증·표면별로 부분적으로 죽는다.** Claude Code의 Todo·Task 도구는 Opus 4.8·Sonnet 5 이후 기본 제공되지 않는다. Codex의 GPT-5.5 퇴역은 ChatGPT 로그인에만 적용되고 API 키 세션은 영향이 없다. 제품 전체 사망으로 저장하면 틀린다. [^cc-cl][^cdx-models]
8. **Codex 문서가 이전했다.** `developers.openai.com/codex/*`는 `learn.chatgpt.com/docs/*`로 308 이동한다. 구 URL을 적재한 자료는 리다이렉트로 살아 있지만 일부 경로는 404다. [실측 S-5]
9. **소스가 살아 있어도 피드는 죽어 있을 수 있다.** Claude Code What's new는 W37(9월 7~11일)에서 멈췄고 RSS 최신 항목은 9월 15일이다. `developers.openai.com/rss.xml`의 최신 항목은 2026-05-05다. `platform.claude.com/docs/en/release-notes/rss.xml`은 HTTP 200이지만 내용이 Next.js 오류 HTML이다. [실측 S-6]
10. **널리 쓰이던 도구가 이미 끝나 있다.** Roo Code 확장은 2026-05-15 종료, Continue는 "Final 2.0.0" 후 읽기 전용, AutoGen은 유지보수 종료, `openai/skills`는 deprecated, `kimi-cli`는 `kimi-code`로 대체, GSD는 `open-gsd/gsd-core`로 이동했다. 스타 수는 생존을 말해 주지 않는다(`get-shit-done` 64,189). [실측 S-1, S-2]
11. **Claude Code와 Codex 모두 로컬 llama.cpp에 실제로 붙는다.** 1.7B 모델로 `Read`·`Bash` 도구 호출까지 성공했다(GPU, 약 160 tok/s). 그러나 기본 도구 세트에서는 소형 모델이 과제에 실패했는데도 `is_error: false`로 끝났다. 한국 모델 kanana-2-3b는 채팅 템플릿이 대화 중간 system 메시지를 거부해 HTTP 500이 반복됐다. [실측 L-1~L-9]
12. **16GB의 경계는 Q4 부근이다.** 16,376 MiB는 약 17.17×10⁹바이트다. Qwen3.8-27B Q4_K_M(16.46GB), Gemma 4 26B Q4_K_M(16.95GB)은 파일만으로 VRAM을 거의 다 쓴다. 한국 주력 모델 K-EXAONE 2.0(750B), Solar-Open2(250B), A.X K2는 범위 밖이고, 범위 안의 한국 모델은 kanana-2-3b, HyperCLOVAX-SEED-Think-14B 등이다. [실측 L-10]
13. **두 도구의 지침 파일이 수렴했다.** Claude Code는 2.1.277(2026-09-18)부터 CLAUDE.md가 없는 프로젝트에서 AGENTS.md를 읽는다. AGENTS.md는 2025-12-09 출범한 Agentic AI Foundation에 기증됐다. [^cc-cl][^aaif]

## 2. 실측 제약

| 제약 | 내용 | 근거 |
|---|---|---|
| `/tmp` 공유 tmpfs | 16GB, 조사 중 여유 2.2~5.8GB로 변동. 병렬 에이전트와 공유. 큰 모델 내려받기 불가 | [실측] `df -h /tmp` |
| 대형 모델 미실측 | 16GB 경계 모델(7~16GB)은 파일 크기로만 판단. GPU 시험은 1.10GB·2.16GB 모델 2개 | [실측 L-2, L-7] |
| Vulkan 불가 | WSL2에 NVIDIA Vulkan ICD 없음. llama.cpp Vulkan 빌드는 `Available devices: (none)` | [실측 L-1] |
| CUDA 런타임 크기 | llama.cpp CUDA 빌드 + 런타임 압축 해제 794MB(`libcublasLt.so.13` 519.7MB) | [실측 L-2] |
| Ollama 미설치 | `ollama-linux-amd64.tar.zst` 1,454MB. tmpfs 사정으로 미실측 | [실측] GitHub API |
| GPU 공유 | 측정 중 다른 프로세스가 4,086~5,344 MiB 사용. VRAM 증가량에 ±1GB 안팎의 노이즈 가능 | [실측] `nvidia-smi` |
| 키 없음 | Anthropic·OpenAI API 키 없음. 로컬 시험은 가짜 키, 가짜 HOME | [실측] |
| 자동화 차단 | `openai.com/codex`, `chatgpt.com/codex` 403. 사람에게는 열리는 페이지다 | [실측 S-5] |
| Reddit | `r/ClaudeCode` RSS는 200, 이어서 호출한 `r/ClaudeAI`·`r/codex`·`r/LocalLLaMA`는 429. `robots.txt`는 200이지만 차단 HTML | [실측 S-6] |
| 피드 없는 1차 소스 | Anthropic Engineering은 RSS 404이고 `sitemap.xml`(588 URL)에 `/engineering/` 항목 0개 | [실측 S-6] |
| 최신 릴리스 조회 함정 | `latestRelease`가 부정확한 저장소: llama.cpp는 `v0.8.0`(자산 1개)인데 실제 빌드는 `b12019`, qwen-code는 SDK 태그, Aider는 GitHub v0.86.0(2025-08)인데 PyPI 0.86.2(2026-02) | [실측 S-1] |
| Codex 헤드리스 | `codex exec`는 파이프 환경에서 stdin을 기다린다. `</dev/null`이 필요했다 | [실측 L-6] |
| Codex 홈 경로 | `/tmp` 아래 `CODEX_HOME`은 PATH 별칭 생성 경고. 동작은 계속 | [실측 S-4] |

## 3. 생존 판정 기준

CLAUDE.md의 죽은 데이터 정의는 "제거·폐기된 기능, 유지보수가 끊긴 도구, 현재 버전에서 더 이상 통하지 않는 방법"이다. 아래는 이 정의를 G 도메인에서 검사 가능한 규칙으로 옮긴 설계다. 점수를 매기지 않고 근거가 붙은 상태값만 남긴다.

### 3.1 판정 단위와 상태

판정은 단위별로 따로 한다. 같은 프로젝트라도 단위마다 상태가 다르다. 예를 들어 `gsd-build/get-shit-done`은 저장소가 archived, npm 패키지가 deprecated이고, 프로젝트는 `open-gsd/gsd-core`로 살아 있다.

단위: 저장소, 프로젝트, 패키지, 제품 기능(명령·플래그·도구), 모델, 문서 URL, 피드, 기법(사용 방법).

| 상태 | 뜻 | 적재 처리 |
|---|---|---|
| `active` | 1차 출처에 현행으로 존재 | 기본 검색 포함 |
| `renamed` | 이름·위치만 변경, 같은 대상 | 별칭 관계 추가. 대체 아님 |
| `scheduled_removal` | 제거일이 공지됨 | 포함, 제거일 속성 부착, 날짜 도래 시 재검사 |
| `deprecated` | 폐기 선언, 아직 동작 | 포함, 경고 속성 |
| `partial` | 특정 모델·인증·플랫폼·표면에서만 제거 | 포함, 적용 조건 부착 |
| `superseded` | 1차 출처가 후속을 명시 | 기본 검색 제외, 대체 관계 연결 |
| `removed` | 동작하지 않음 또는 종료 선언 | 기본 검색 제외, 삭제하지 않음 |
| `stale_suspect` | 선언 없이 활동이 멈춤 | 포함 유지, 사람 판단 대기열 |
| `revived` | 폐기·제거 후 복귀 | 포함, 이력 보존 |

### 3.2 기계로 검사할 수 있는 신호

"확정력"은 그 신호 하나가 어디까지 말해 주는지를 뜻한다.

| ID | 단위 | 신호 | 검사 | 확정력 | 확인한 사례 | 함정 |
|---|---|---|---|---|---|---|
| M01 | 저장소 | `isArchived` | GraphQL·`gh api repos/O/R` | 저장소 종료 확정, 프로젝트 종료 아님 | 138개 중 10개 | 5개 이상이 후속 저장소를 명시. 미보관 사망 7개 놓침 |
| M02 | 저장소 | `nameWithOwner` ≠ 요청 이름 | GraphQL | `renamed` 확정 | 21건 | 이동 체인: `glittercowboy`→`gsd-build`→`open-gsd/gsd-core`(뒤 단계는 README만 알림) |
| M03 | 저장소 | 조회 결과 없음 | GraphQL `NOT_FOUND` | 의심 | `parruda/claude-swarm`(소유자는 공개 저장소 37개로 존재), `anthropics/claude-code-sdk-typescript` | 비공개 전환과 구분 불가 |
| M04 | 저장소 | 마지막 커밋 경과일 | `defaultBranchRef...committedDate` | 의심(≥365일) | 5건 중 4건 실제 중단 | `autogen`은 3일 전 커밋이 있어도 종료. 표준·벤치 저장소는 원래 드묾(`agents.md` 51일) |
| M05 | 저장소 | README 선언 문구 | 앞 8,000자 정규식 | 강함 | 16건 중 15건 적중 | `modelcontextprotocol/servers`는 보관 서버 목록 섹션으로 오탐. 느슨한 패턴은 `TabbyML/tabby`의 접힘 메뉴 "Archived"도 오탐 |
| M06 | 패키지 | npm `latest`의 `deprecated` | 레지스트리 문서 | 강함 | 41개 중 11개. 후속 명시 2개 | 과거 버전만 deprecated인 15개를 잡으면 오탐(`server-filesystem` 19/23). 문구는 대개 "Package no longer supported." |
| M07 | 패키지 | PyPI `Development Status :: 7 - Inactive` | JSON API | 강함 | `kimi-cli` | 사용률 낮음. `claude-code-sdk`는 표시 없음 |
| M08 | 패키지 | PEP 792 `project-status` | Simple API v1.4 | 현재 변별력 없음 | 18개 전부 `active`, kimi-cli 포함 | 유지보수자가 설정해야 값이 바뀐다 |
| M09 | 패키지 | 마지막 게시일 | npm `time`, PyPI `upload_time` | 의심 | `claude-code-sdk` 2025-09-29, `gpt4all` 2024-08-14 | GitHub 릴리스와 어긋남(Aider) |
| M10 | 문서 | HTTP 404 | 첫 응답과 최종 응답 | 의심 | `docs/en/remote-tasks` 404 | 사이트 개편일 수 있음. 내용은 다른 URL에 있을 수 있음 |
| M11 | 문서 | 3xx 최종 URL 변경 | `curl -L` | `renamed` | `docs.anthropic.com/...`→`code.claude.com`, `developers.openai.com/codex`→`learn.chatgpt.com` | 메타 리프레시는 3xx가 아님(`block.github.io/goose/` 200, 498바이트) |
| M12 | 문서 | 묘비 제목 | 제목에 `is no longer available`, `(removed)`, `removal` | `removed` 확정 | ultraplan, TS SDK V2, Codex MCP server | 본문 앞부분까지 읽어야 함 |
| M13 | 문서 | `llms.txt` 등재 여부 | 색인 비교 | 의심 | ultraplan 누락 | 별칭 페이지도 누락(`slash-commands`, `plugins-reference`, `plugins`, `discover-plugins`, `plugin-marketplaces`) |
| M14 | 문서 | 표의 상태 행 | 명령·도구 표에서 `Removed`, `[DEPRECATED]` | `removed` 확정 | `/ultraplan`, `/vim`(v2.1.92), `/pr-comments`(v2.1.91), `TaskOutput`(v2.1.277), `ANTHROPIC_SMALL_FAST_MODEL` | 공급자별 형식 |
| M15 | 문서 | 용어 대응표 | 용어집 "Deprecated and renamed terms" | `renamed` 확정 | Headless→Non-interactive, Slash commands→Commands | 4행뿐. 범위가 좁음 |
| M16 | 변경 이력 | 항목 머리 문구 | 정규식 + 버전·날짜 대응 | 후보 추출 | 54건 중 기능 제거 28건 | UI 정리 23건 섞임. `Unshipped`, `no longer available`, `Renamed`, `no-op`을 패턴에 추가해야 잡히는 항목 존재 |
| M17 | 변경 이력 | 번복 문구 | `Un-deprecate`, `Re-introduced`, `Restored`, `Reverted` | `revived` 후보 | output styles, ultrathink, Agent `model` 파라미터 | 동작 복귀와 이름 복귀가 다를 수 있음 |
| M18 | 제품 | 런타임 수명 단계 | `codex features list` | 플래그 단위 | 194개 | `removed`+true는 기능 생존. §5.3 |
| M19 | 제품 | 공식 성숙도 라벨 | Codex Feature Maturity, Claude 문서 첫머리 배너 | 위험 등급 | Experimental: "OpenAI may remove or change it" | 라벨 미표기 기능이 곧 GA는 아님 |
| M20 | 모델 | 공식 수명 표 | Model deprecations 표, Codex Models | 날짜 확정 | `claude-sonnet-4-5-20250929` 2026-11-30 퇴역 | "Not sooner than"은 퇴역일이 아니다: `claude-haiku-4-5-20251001`은 2026-10-15가 지났는데 Active. 파트너 플랫폼은 일정이 다름 |
| M21 | 레지스트리 | MCP Registry `status` | `/v0/servers` `_meta` | 강함 | 스캔분 10,300버전 중 deprecated 141, 최신판 29 | `isLatest`로 걸러야 함 |
| M22 | 큐레이션 | 목록의 자체 플래그 | awesome-claude-code CSV `Active`, `Stale` | 약함 | Active=FALSE 11/263, `Stale=TRUE` 0/263 | 직접 대조하니 archived 1건이 Active=TRUE |
| M23 | 피드 | 최신 항목 경과일 | RSS·Atom 파싱 | 피드 생존만 | What's new 46일, `developers.openai.com/rss.xml` 179일 | 200 응답이 HTML일 수 있음(Content-Type과 본문 검사). 소스 생존과 별개 |
| M24 | 모든 단위 | 실행 검증 | 해당 버전에서 명령을 실제 실행 | 가장 강함 | 로컬 연결 시험 §8.5 | 비용이 있고 계정·환경 의존. exit 코드 불신(harness.md §3.3) |

### 3.3 사람이 판단해야 하는 신호

| ID | 질문 | 기계가 못 하는 이유 | 실제 사례 |
|---|---|---|---|
| H01 | 후속이 같은 것을 대체하는가 | 문구는 "use X instead"뿐. 기능 동등성은 안 나온다 | Codex 문서는 `app-server`가 "isn't an MCP server or a drop-in replacement"이고 실험 단계라고 적는다[^cdx-mcp]. Roo Code의 후속은 공식이 아니라 커뮤니티 포크(`Zoo-Code`)와 원류(`Cline`) 안내다 |
| H02 | 활동이 있어도 유지보수가 끊겼는가 | 커밋은 기계가 보지만 의도는 못 본다 | `huggingface/text-generation-inference` 유지보수 모드, `claude-code-base-action`은 커밋이 오늘이지만 릴리스는 2025-05 `beta` |
| H03 | 활동이 없어도 살아 있는가 | 드문 갱신이 정상인 범주 구분 필요 | `agentsmd/agents.md`(표준), `agentskills/agentskills`(83일), `Aider-AI/aider-swe-bench`(벤치 산출물) |
| H04 | 선언 없이 멈춘 것인가 | 임계값이 범주별로 다름 | `Aider-AI/aider`: 커밋 162일, GitHub 릴리스 448일, PyPI 261일, 선언 없음. 포크 `cecli`(PyPI `aider-ce`) 활동 중. `plandex`: Cloud 종료 공지 후 393일 무커밋 |
| H05 | 기법이 현재 버전에서 통하는가 | 팁은 기능명이 아니라 문장이다. 부작용 없이 조용히 무의미해진다 | `TodoWrite` 활용 팁은 Opus 4.8 이후 기본 비활성. `Glob`·`Grep` 도구 팁은 네이티브 빌드에 도구가 없음. `#` 메모 단축키는 2.0.70 제거 |
| H06 | 이름이 같아도 의미가 같은가 | 식별자가 같아 기계는 동일로 본다 | `/simplify`는 2.1.147에 `/code-review`로 개명되고 구 동작이 제거됐다가 2.1.154에 정리 전용으로 부활 |
| H07 | 번복 가능성이 있는가 | 폐기 선언 뒤를 봐야 안다 | output styles 2025-10-30 폐기, 5일 뒤 철회. `/output-style` 명령은 2026-03-11 폐기, 184일 뒤 재추가 |
| H08 | 어느 조건에서 죽었는가 | 조건이 자연어 문장에 있다 | GPT-5.5는 ChatGPT 로그인에서만 퇴역. Sonnet 4.5 1M은 Max 플랜에서만 제거 |
| H09 | 인기가 곧 생존인가 | 스타·다운로드는 누적치다 | `gsd-build/get-shit-done` 64,189, `continuedev/continue` 36,380, `RooCodeInc/Roo-Code` 24,254, `gpt4all` 77,346 |
| H10 | 안전하지 않게 변했는가 | 사고는 메타데이터에 안 남는다 | GeekNews 2026-10-31 항목 제목 "Cursor 마켓플레이스의 Claude Code 확장에서 SSH 백도어 발견"(피드 제목만 확인, 원문 미확인) |
| H11 | 라이선스 변경이 사용 조건을 바꿨는가 | 생존과 별개지만 적재 속성으로 필요 | `crush` FSL-1.1-MIT, `oh-my-openagent` SUL-1.0, `task-master-ai` MIT WITH Commons-Clause |

### 3.4 적용 순서

1. **이동 먼저.** M02·M11로 canonical을 확정하고 `renamed` 처리한다. 이후 신호는 canonical에 대해 검사한다.
2. **명시 선언 수집.** M01, M05, M06, M07, M12, M14, M20, M21 중 하나라도 있으면 근거 문구와 함께 후보로 올린다.
3. **단위 분리.** 저장소 신호를 프로젝트 판정으로 올리기 전에 README에서 후속을 찾는다. 후속이 있으면 저장소는 `superseded`, 프로젝트는 후속을 따라 재검사한다.
4. **조건 추출.** 모델명, 인증 방식, 플랫폼, 버전 범위가 문구에 있으면 `partial`로 둔다(M16, H08).
5. **날짜 처리.** 제거일이 미래면 `scheduled_removal`, 도래 시 재검사한다.
6. **침묵 처리.** 선언이 없고 M04·M09만 걸리면 `stale_suspect`까지만 간다. 자동으로 `removed`가 되지 않는다.
7. **교차 확인.** 제품 기능은 변경 이력과 현행 문서를 둘 다 본다. 어느 한쪽에만 있는 제거가 실제로 있었다(§3.5).
8. **재검사.** `removed`·`superseded`도 삭제하지 않고 M17로 계속 검사한다. 번복 간격은 5일과 184일이 관측됐다.
9. **기법은 근거 기능에 묶는다.** 기법 노드에 의존하는 기능·버전 관계를 적재하면, 기능이 죽을 때 기법이 사람 판단 대기열로 올라간다.

단위별 재검사 주기는 §9의 소스 갱신 주기를 따른다.

### 3.5 표본 검증

**저장소 138개**(이번 조사 후보, 중복 제거). 수명 종료 확인 집합 G는 17개다: archived 10개(`coder/agentapi`, `gsd-build/get-shit-done`, `gsd-build/gsd-2`, `huggingface/text-generation-inference`, `modelcontextprotocol/servers-archived`, `MoonshotAI/kimi-cli`, `opencode-ai/opencode`, `RooCodeInc/Roo-Code`, `wshobson/commands`, `OpenHands/openhands-aci`) + 미보관 7개(`continuedev/continue`, `microsoft/autogen`, `openai/skills`, `openai/swarm`, `stravu/crystal`, `plandex-ai/plandex`, `nomic-ai/gpt4all`).

| 신호 | 적중 | G 안 | 정밀도 | G 대비 재현율 |
|---|---:|---:|---:|---:|
| `archived` | 10 | 10 | 100% | 58.8% |
| README 선언 문구 | 16 | 15 | 93.8% | 88.2% |
| 마지막 커밋 ≥365일 | 5 | 4 | 80.0% | 23.5% |
| 마지막 커밋 ≥180일 | 16 | 8 | 50.0% | 47.1% |
| `archived` ∪ README | 17 | 16 | 94.1% | 94.1% |
| 위 ∪ 커밋 ≥365일 | 19 | 17 | 89.5% | 100% |

표 해석의 한계:

- G는 신호 적중분을 읽어서 만들었다. 어떤 신호에도 안 걸린 121개는 개별 정독하지 않았다. 재현율은 상한값이고 마지막 행의 100%는 구성상 그렇게 나온다.
- 표본은 정체 후보를 의도적으로 넣은 비무작위 표본이다. 수치를 생태계 전체 비율로 읽을 수 없다.
- `plandex`의 README 적중은 Cloud 종료 문구이고 OSS 저장소 자체의 선언은 없다. 정답으로 센 것은 393일 무커밋과 합친 판단이다.
- 마지막 커밋 분포: 30일 미만 95, 30~89일 13, 90~179일 14, 180~364일 11, 365일 이상 5.

**변경 이력 문구.** 2025-04-02~2026-10-31, 434버전, 8,497항목.

| 패턴 | 항목 수 |
|---|---:|
| `no longer` | 319 |
| `removed` 계열 | 200 |
| `renamed` | 63 |
| `replaced` 계열 | 38 |
| `deprecat` | 23 |
| `sunset`·`retire` 계열 | 14 |
| 항목 머리 `Removed/Deprecated/Dropped` | 54 |

54건 수작업 분류: 기능·플래그·명령·모델·설정 제거 28, UI·안내 문구 정리 23, 제한 해제(살아난 쪽) 3. 라벨 제거도 섞인다: "Removed the (research preview) label from the `/fast` dialog"는 승격 신호다.

**큐레이션 목록 대조.** awesome-claude-code `THE_RESOURCES_TABLE_NEW.csv` 263행, GitHub 링크 248개. 내가 직접 조회한 결과 archived 1(`EndeavorYen/chrome-cdp-ex`, 목록은 Active=TRUE), 없음 1(목록도 Active=FALSE), 이동 11, 커밋 ≥365일 1, 180~364일 13이다. `Last Checked`는 2026-06~10에 분포하고 46행은 비어 있다. [실측 S-7]

### 3.6 실제 사례: 패키지와 문서

**npm `latest`가 deprecated인 11개** [실측 S-2]

| 패키지 | 최신 | 게시일 | 메시지 |
|---|---|---|---|
| `@modelcontextprotocol/server-github` | 2025.4.8 | 2025-04-08 | Package no longer supported. |
| `@modelcontextprotocol/server-postgres` | 0.6.2 | 2024-12-04 | 동일 |
| `@modelcontextprotocol/server-puppeteer` | 2025.5.12 | 2025-05-12 | 동일 |
| `@modelcontextprotocol/server-slack` | 2025.4.25 | 2025-04-25 | 동일 |
| `@modelcontextprotocol/server-gitlab` | 2025.4.25 | 2025-04-25 | 동일 |
| `@modelcontextprotocol/server-google-maps` | 0.6.2 | 2024-12-04 | 동일 |
| `@modelcontextprotocol/server-brave-search` | 0.6.2 | 2024-12-04 | 동일. 공식 후속 `@brave/brave-search-mcp-server`는 `servers` README에 있음 |
| `get-shit-done-cc` | 1.42.3 | 2026-05-16 | 동일, 223/223버전 |
| `gsd-pi` | 3.0.0 | 2026-05-14 | 동일, 526/526버전 |
| `@mariozechner/pi-coding-agent` | 0.73.1 | 2026-05-07 | please use @earendil-works/pi-coding-agent instead going forward |
| `@zed-industries/claude-code-acp` | 0.16.2 | 2026-02-17 | This package has been renamed to @agentclientprotocol/claude-agent-acp. |

오탐 표본: `server-filesystem` 19/23, `server-memory` 14/17, `server-everything` 28/32, `server-sequential-thinking` 9/11은 과거 버전만 deprecated이고 최신은 2026-10 게시다. 미탐 표본: `@continuedev/cli` 1.5.47은 표시가 없다.

**문서 URL** [실측 S-5]

| URL | 첫 응답 | 최종 | 뜻 |
|---|---|---|---|
| `docs.anthropic.com/en/docs/claude-code/overview` | 301 | 200 `code.claude.com/docs/en/overview` | `renamed` |
| `docs.anthropic.com/en/docs/claude-code/sdk` | 301 | 200 `.../agent-sdk/overview`(리다이렉트 4회) | `renamed` |
| `www.anthropic.com/engineering/claude-code-best-practices` | 308 | 200 `code.claude.com/docs/en/best-practices` | 블로그가 문서로 흡수 |
| `www.anthropic.com/news/claude-code-on-the-web` | 308 | 200 `claude.com/resources/articles/...` | `renamed` |
| `code.claude.com/docs/en/ultraplan` | 200 | 200, `.md` 1,102바이트 | 묘비 |
| `code.claude.com/docs/en/slash-commands` | 200 | 200, 내용은 skills 페이지 | 별칭 |
| `code.claude.com/docs/en/remote-tasks` | 404 | 404 | 구 경로 |
| `developers.openai.com/codex/cli/reference` | 308 | 200 `learn.chatgpt.com/docs/developer-commands?surface=cli` | `renamed` |
| `platform.openai.com/docs/guides/codex` | 301 | 404 | 구 경로 |
| `platform.openai.com/docs/codex` | 301 | 200 `learn.chatgpt.com/docs/cloud` | `renamed` |
| `github.com/openai/codex/blob/main/docs/config.md` | 200 | 200, 공식 문서로 안내하는 축약 파일 | 내용 이전 |
| `roocode.com` | 301 | 200 `roomote.dev` | 제품 전환 |
| `plandex.ai` | 000 | 000 | 연결 실패 |
| `block.github.io/goose/` | 200 | 200, 498바이트 | 메타 리프레시 추정 |

## 4. G1 Claude Code

### 4.1 소스 표

| ID | 소스 | 접근 | 피드 | 갱신 주기 | 수집 주기 | 접근 상태 |
|---|---|---|---|---|---|---|
| C01 | GitHub `CHANGELOG.md` | raw URL, 키 없음 | `releases.atom`, `commits/main/CHANGELOG.md.atom` | 릴리스 단위. 월 13~28건 | 릴리스 단위 | 200, 1.13MB, 434버전. 날짜 없음 |
| C02 | 문서 Changelog | `docs/en/changelog.md`, RSS | `/docs/en/changelog/rss.xml`(최근 15건) | 릴리스 단위 | 릴리스 단위 | 200. 전 버전 날짜 있음. C01과 버전 집합 일치 |
| C03 | 공식 문서 | `llms.txt`, `llms-full.txt`, 페이지별 `.md` | 없음 | 비정기, 릴리스와 함께 변동 | 변경 감지 | 200. full 10.0MB, 231쪽 |
| C04 | 문서 한국어판 | `docs/ko/...`, `_llms/ko.txt`(228쪽) | 없음 | C03 번역 | 변경 감지 | 200 |
| C05 | What's new | `whats-new/index.md`, RSS | `/docs/en/whats-new/rss.xml` | 주간 표방. W37(9/7~11)에서 멈춤, W31 결락 | 주 1회 | 200. 조사일 7주 경과 |
| C06 | Model deprecations | 페이지 | 없음 | 비정기 | 변경 감지 | 200 |
| C07 | API release notes | 페이지 | `rss.xml`은 200이나 오류 HTML | 수시 | 변경 감지 | 페이지 200, 피드 불가 |
| C08 | Engineering 블로그 | HTML 목록만 | 없음(RSS 404, sitemap 0건) | 2025 13건, 2026 11건 | 월 1회 내외 | 200. 헤더는 27건, 격자는 24건 |
| C09 | claude.com 글 | `/resources/articles`, sitemap | RSS 404 | 수시. sitemap 기준 글 274, 한국어 `/ko/resources` 86 | sitemap 일 단위 비교 | 200. `claude.com/blog`는 이동 |
| C10 | Support Release notes | 고정 문서 | 없음 | 수시 | 변경 감지 | 200 |
| C11 | 상태 페이지 | `status.claude.com` | `history.rss`, `history.atom` | 사건 단위 | 사건 단위 | 200 |
| C12 | `anthropics/claude-code` | `gh api`, Issues | `releases.atom` | 상시. `open_issues_count` 16,206(PR 포함) | 일 1회 | 200. 라이선스 메타 없음 |
| C13 | npm `@anthropic-ai/claude-code` | 레지스트리 | 없음 | 릴리스 단위 | 릴리스 단위 | 200. 2.1.316, deprecated 없음 |
| C14 | Agent SDK | `anthropics/claude-agent-sdk-python`·`-typescript` | `releases.atom` | 릴리스 단위 | 릴리스 단위 | v0.2.176, v0.3.316(둘 다 10-31) |
| C15 | 공식 마켓플레이스 | `anthropics/claude-plugins-official`, `claude.com/marketplace` | 커밋 Atom | 수시 | 일 1회 | `marketplace.json` 315개. sitemap 플러그인 529, 커넥터 1,050 URL |
| C16 | `Piebald-AI/claude-code-system-prompts` | GitHub, 제3자 | `releases.atom` | 버전 단위(v2.1.316, 10-31) | 릴리스 단위 | 200. 비공식 |

주석: C01[^cc-cl-gh], C02[^cc-cl], C03[^cc-llms], C04[^cc-ko], C05[^cc-wn], C06[^model-dep], C07[^api-notes], C08[^eng], C09[^claude-sitemap], C10[^support-notes], C11[^status-claude], C15[^plugins-mkt], C16[^piebald].

월별 릴리스(2025-04~2026-10): 27, 13, 24, 23, 19, 15, 20, 18, 17, 26, 28, 20, 26, 27, 28, 22, 28, 27, 26. [실측 S-3]

### 4.2 기능 변천과 현재 상태

버전·날짜는 문서 Changelog 기준이다.[^cc-cl] 현재 상태는 2026-10-31 문서 기준이다.[^cc-llms]

| 기능 | 변천 | 현재 상태 |
|---|---|---|
| Output styles | 1.0.81(2025-08-14) 출시 → 2.0.30(10-30) 폐기 → 2.0.32(11-04) Un-deprecate → 2.1.73(2026-03-11) `/output-style` 폐기 → 2.1.237(08-20) Concise 추가 → 2.1.269(09-11) `/output-style [name]` 재추가 | `active`, `revived` 이력 |
| 커스텀 명령·스킬 | 2.1.3(2026-01-09) 병합. 용어집: Custom commands→Skills, `.claude/commands/` 계속 동작, "Slash" 표기 삭제 | `renamed` |
| `/simplify` | 2.1.63(02-28) 추가 → 2.1.147(05-21) `/code-review`로 개명·구 동작 제거 → 2.1.152(05-27) `--fix` 호출 → 2.1.154(05-28) 정리 전용 | `revived`, 의미 변경 |
| `ultrathink` | 0.2.44(2025-04-02) 소개 → 2.1.68(2026-03-04) "Re-introduced" → 2.1.311(10-26) xhigh → 2.1.316 끄는 변수 추가 | `revived`. 중간 제거 항목은 CHANGELOG에서 못 찾음 |
| Ultraplan | 2.1.101 등 프리뷰 → 2.1.222(2026-08-04) 제거 | `removed`. 대안으로 plan mode, 클라우드 세션 안내 |
| 백그라운드 출력 도구 | `BashOutput`·`AgentOutput` → 2.0.64(2025-12-10) `TaskOutput` 통합 → 2.1.83(2026-03-25) 폐기 → 2.1.277(09-18) 제거 | `removed`. `Read`로 출력 파일을 읽음 |
| Todo·Task 도구 | 2.1.233(08-14) 신모델에서 제거 → 2.1.268(09-10) Claude 3.x, Opus 4.0~4.7, Sonnet 4.0~4.6, Haiku 4.5에서만 제공 | `partial`. `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`로 복구 |
| `/agents` 마법사 | 1.0.60(2025-07-24) 서브에이전트 도입 → 2.1.198(07-01) 마법사 제거 → 2.1.281(09-23) 잔여 메뉴 제거 | `removed`. `.claude/agents/`와 서브에이전트는 `active` |
| `Glob`·`Grep` 도구 | 2.1.117(04-22) 네이티브 빌드에서 내장 `bfs`·`ugrep`로 교체 | `partial`. 문서: macOS, Linux, WSL에서 기본 부재 |
| npm 설치 | 2.1.15(01-21) 폐기 알림 → 문서는 Native Install 권장, npm 경로 언급 유지, 패키지는 매 릴리스 게시 | `deprecated` 경계. npm 메타 표시 없음 |
| `claude config` | 1.0.7(2025-06-02) 폐기 → 2.0.0(09-29) Unshipped | `removed` |
| SDK | 2.0.25(2025-10-21) CLI 패키지의 SDK 진입점 제거 → `@anthropic-ai/claude-agent-sdk`. TS V2 세션 API는 SDK 0.3.142에서 제거 | `superseded` |
| Agent teams | 2.1.178(06-15) `TeamCreate`·`TeamDelete` 제거, 암묵적 팀으로 전환 | 실험, 기본 꺼짐. harness.md §2.4 |
| 예약 작업 | routines → scheduled tasks 개명(`/routines` 별칭 잔존) | 연구 프리뷰. harness.md §4 |
| `--remote` | 문서: `--cloud`의 폐기된 별칭 | `deprecated`. CHANGELOG에 항목 없음 |
| `/vim`, `/tag`, `/pr-comments` | 2.1.92, 2.1.92, v2.1.91 제거 | `removed`. `/pr-comments`는 문서에만 있음 |
| `#` 메모 단축키 | 2.0.70(2025-12-15) 제거 | `removed` |
| 동적 워크플로우 키워드 | 2.1.160(06-02) `workflow`→`ultracode` | `renamed` |
| Fast mode | Opus 4.7 폐기 06-25·제거 07-24. Opus 4.8 폐기 10-30·제거 예정 11-30 | 모델별 `scheduled_removal`. Opus 5.5는 2.1.304에서 프리뷰 라벨 제거 |
| AGENTS.md | 2.1.277(09-18) CLAUDE.md 없을 때 읽음 → 2.1.281 게이트웨이 등 확대 | `active` |
| `claude-code-plugins` 마켓플레이스 | `ralph-wiggum`→`ralph-loop`, `claude-opus-4-5-migration` 퇴역 | `deprecated`. CHANGELOG에 항목 없음 |
| MCP SSE 전송 | 문서: "deprecated. Use HTTP servers instead, where available" | `deprecated` |
| Slack 구 봇 | 2026-10-05 퇴역, Claude Tag로 전환 | `removed` |
| 작은 설정들 | `ANTHROPIC_SMALL_FAST_MODEL`, `disableArtifact`, `keybindingFlavor`, `allowedPrompts`, 훅 입력 `team_name` | `deprecated` |
| API 파라미터 | `temperature`, `top_p`, `top_k`는 API 버전 `2026-10-21`에서 제거 | `removed`(해당 API 버전) |

번복과 되돌림 표본: 2.1.72 Agent `model` 파라미터 복원, 2.1.283 `claude-ai` 이름 예약 철회, 2.1.141 IDE diff 옵션 복원.

### 4.3 문서가 표시한 성숙도

문서 첫머리 배너와 표 기준이다.[^cc-llms]

| 표시 | 기능 |
|---|---|
| 연구 프리뷰 | agent view, channels, cloud scheduled tasks, ultrareview, computer use(CLI, macOS), fullscreen rendering, Opus 5·4.8 fast mode |
| 실험 | agent teams, advisor tool |
| 공개 베타 | Projects, 자체 호스팅 환경, iOS Simulator 패널, Claude Desktop on Linux, GitLab CI/CD |

### 4.4 모델 수명 표

[^model-dep] 기준이다. 정의: Active, Legacy(업데이트 없음), Deprecated(동작, 퇴역일 지정), Retired(요청 실패). 공개 모델은 최소 60일 전 통지한다고 밝힌다. Bedrock과 Google 관리형은 일정이 별도다.

| 모델 | 상태 | 폐기일 | 퇴역(예정) |
|---|---|---|---|
| `claude-opus-5-5` | Active | - | 2027-09-22 이후 |
| `claude-sonnet-5-5` | Active | - | 2027-09-28 이후 |
| `claude-haiku-5-5` | Active | - | 2027-10-07 이후 |
| `claude-fable-5-1`, `claude-mythos-5-1` | Active | - | 2027-09-01 이후 |
| `claude-fable-5`, `claude-mythos-5` | Active | - | 2027-06-09 이후 |
| `claude-opus-5` | Active | - | 2027-07-24 이후 |
| `claude-sonnet-5` | Active | - | 2027-06-30 이후 |
| `claude-opus-4-8` / `4-7` / `4-6` | Active | - | 2027-05-28 / 04-16 / 02-05 이후 |
| `claude-sonnet-4-6` | Active | - | 2027-02-17 이후 |
| `claude-opus-4-5-20251101` | Active | - | 2026-11-24 이후 |
| `claude-haiku-4-5-20251001` | Active | - | 2026-10-15 이후(날짜 경과) |
| `claude-sonnet-4-5-20250929` | Deprecated | 2026-09-30 | 2026-11-30 |
| `claude-mythos-preview` | Deprecated | 2026-06-09 | 미정 |
| `claude-opus-4-1-20250805` | Retired | 2026-06-05 | 2026-08-05 |
| `claude-opus-4-20250514`, `claude-sonnet-4-20250514` | Retired | 2026-04-14 | 2026-06-15 |
| `claude-3-haiku-20240307` | Retired | 2026-02-19 | 2026-04-20 |
| `claude-3-5-haiku-20241022`, `claude-3-7-sonnet-20250219` | Retired | 2025-12-19, 2025-10-28 | 2026-02-19 |

### 4.5 Engineering 블로그 표본

전문 목록 수집 경로가 HTML뿐이라 표본을 적는다. 총 24건(격자 기준).[^eng] 최근순: Redesigning source control at Anthropic(2026-10-13), How we contain Claude across products(05-25), An update on recent Claude Code quality reports(04-23), Scaling Managed Agents(04-08), How we built Claude Code auto mode(03-25), Harness design for long-running application development(03-24), Building a C compiler with a team of parallel Claudes(02-05), Effective harnesses for long-running agents(2025-11-26), Code execution with MCP(2025-11-04), Beyond permission prompts(2025-10-20), Equipping agents with Agent Skills(2025-10-16), Effective context engineering(2025-09-29), Claude Code best practices(2025-04-18, 문서로 이동).

## 5. G2 Codex

### 5.1 소스 표

| ID | 소스 | 접근 | 피드 | 갱신 주기 | 수집 주기 | 접근 상태 |
|---|---|---|---|---|---|---|
| O01 | `openai/codex` 릴리스 | `gh api`, 키 없음 | `releases.atom`, `commits/main.atom` | 정식 수일 간격, alpha 다수 | 릴리스 단위 | 200. `rust-v0.166.0`(10-29), Apache-2.0, `open_issues_count` 25,763(PR 포함) |
| O02 | 공식 문서 | `learn.chatgpt.com/docs/llms.txt`, 페이지별 `.md` | 없음 | 비정기 | 변경 감지 | 200. 206개 링크, `llms-full.txt` 2.6MB, `codex-manual.md` 3.2MB |
| O03 | 변경 이력 | `/docs/changelog/rss.xml` | RSS 전체 이력 | 2026-09 36건, 10월 20건 | 릴리스 단위 | 200, 4.6MB, 193건(2025-05-19~2026-10-29). `changelog.md`는 404 |
| O04 | Feature Maturity | 페이지 | 없음 | 드묾 | 변경 감지 | 200 |
| O05 | Models | `/docs/models.md` | 없음 | 모델 출시·퇴역 시 | 변경 감지 | 200. `/docs/codex/models.md`는 404 |
| O06 | What's new | `/docs/whats-new.md` | 없음 | 주간 | 주 1회 | 200. 최신 10월 26~30일 |
| O07 | `codex features list` | 로컬 실행 | 없음 | 버전 단위 | 릴리스 단위 | 동작. 계정 불필요 |
| O08 | `features/src/lib.rs` | GitHub raw | 커밋 Atom | 커밋 단위 | 릴리스 단위 | 200, 82KB |
| O09 | OpenAI API deprecations | `developers.openai.com/api/docs/deprecations` | 없음 | 비정기 | 변경 감지 | 200 |
| O10 | npm `@openai/codex` | 레지스트리 | 없음 | 릴리스 단위 | 릴리스 단위 | 200. 0.166.0, 전체 5,674버전 |
| O11 | AGENTS.md | `agents.md`, `agentsmd/agents.md` | 커밋 Atom | 드묾(최근 2026-09-10) | 변경 감지 | 200. `llms.txt` 404. MIT, 별 25,230 |
| O12 | 상태 페이지 | `status.openai.com` | `history.rss` | 사건 단위 | 사건 단위 | 200 |
| O13 | 사이트 RSS | `developers.openai.com/rss.xml` | RSS | 최신 항목 2026-05-05 | 해당 없음 | 200. 138건. `learn.chatgpt.com/rss.xml`과 크기 동일 |

주석: O02[^cdx-llms], O03[^cdx-cl], O04[^cdx-maturity], O05[^cdx-models], O06[^cdx-wn], O08[^cdx-lib], O09[^oai-dep], O11[^agentsmd].

### 5.2 기능 변천과 현재 상태

날짜는 변경 이력 RSS 기준이다.[^cdx-cl]

| 대상 | 변천 | 현재 상태 |
|---|---|---|
| Codex 일반 공개 | 2025-10-06 GA | `active` |
| 표면 | Codex app(2026-02-02), Codex Remote GA(06-25), ChatGPT 데스크톱 합류(07-09), Linux 데스크톱 프리뷰(08-11) | `active` |
| Agent skills | 2025-12-19 도입 | `active` |
| Custom prompts | 2026-01-22 폐기 | `deprecated`. 문서 "Use skills", 페이지 유지 |
| 플러그인 | 2026-03-25 빌드·설치 | `active` |
| `codex mcp-server` | 0.149.0 경고 → 2026-08-24 폐기 → 2026-09-05 제거(0.154.0) | `removed`. 12일 만에 제거. `codex mcp`(외부 MCP 연결)는 유지 |
| `codex exec --full-auto` | 0.147.0(08-07) 제거 | `removed`. `--sandbox workspace-write` |
| 성격 설정 | 0.156.0(09-22) Friendly·Pragmatic 선택 중단 | `removed`. 설정 키는 호환용 잔존 |
| 번들 패치 zsh | 0.163.0(10-15) 제거 | `removed`. 구 플래그에 이전 안내 |
| Codex Cloud 환경 문서 | "Codex Cloud (Legacy)"가 Code Review, Linear·GitHub 연동용으로 잔존 | `partial`. 현행은 Cloud environments |
| 앱 서버 | `codex app-server`는 `[experimental]` | 실험. 문서가 "isn't supported for production workloads"로 명시 |
| 커스텀 프로바이더 | `wire_api`는 `responses`만 지원 | Chat Completions만 내는 서버는 직접 연결 불가 |
| `gpt-5.2`, `gpt-5.3-codex` | 2026-05-26 폐기 | `partial`. ChatGPT 로그인에서 deprecated |
| `gpt-5.4`, `gpt-5.4-mini` | 2026-07-31 공지 → 08-31 Codex에서 퇴역 | `partial`. API 키 무관 |
| `gpt-5.3-codex-spark` | 2026-09-14 퇴역 | `removed`(앱, CLI, IDE) |
| `gpt-5.5` | 2026-09-14 공지 → 10-14 19:00 UTC 퇴역 | `partial`. ChatGPT 로그인 한정, API 무관 |
| 현행 모델 표기 | `gpt-6.1-sol`, `gpt-6.1-terra`(CLI 0.159.0 이상), `gpt-6-luna` | `active` |

### 5.3 수명 단계 분포

`codex features list`(0.166.0), 194개. [실측 S-4]

| 단계 | 기본 true | 기본 false | 합계 |
|---|---:|---:|---:|
| under development | 1 | 81 | 82 |
| stable | 54 | 4 | 58 |
| removed | 10 | 37 | 47 |
| experimental | 0 | 4 | 4 |
| deprecated | 0 | 3 | 3 |

- `Stage` 소스 주석: `Removed`는 "The feature flag is useless but kept for backward compatibility reason.", `Stable`은 "The feature flag is kept for ad-hoc enabling/disabling", `Experimental`은 `/experimental` 메뉴 노출.[^cdx-lib]
- removed + true 10개: `collaboration_modes`, `item_ids`, `realtime_conversation`, `resize_all_images`, `sqlite`, `steer`, `terminal_resize_reflow`, `tool_search_always_defer_mcp_tools`, `tui_app_server`, `worktrees`. 문서에 Worktrees 페이지가 있고 `worktree` 언급 161행이므로 기능이 살아 있다.
- deprecated 3개: `use_legacy_landlock`, `web_search_cached`, `web_search_request`.
- experimental 4개: `analytics_plan_history`, `login_shell_package_path`, `network_proxy`, `prevent_idle_sleep`.
- 문서의 app-server 쪽 열거값은 `beta`, `underDevelopment`, `stable`, `deprecated`, `removed`다. CLI 출력과 이름이 다르다.[^cdx-llms]
- Feature Maturity 원문: Experimental "Unstable and OpenAI may remove or change it", Deprecated "Still available for compatibility, but no longer recommended; OpenAI may remove it in a future release".[^cdx-maturity]

### 5.4 AGENTS.md

- Codex 탐색 순서: 전역 `~/.codex/AGENTS.override.md` 또는 `AGENTS.md`, 그다음 프로젝트 루트에서 현재 디렉터리까지 내려오며 병합. 가까운 파일이 뒤에 온다. 기본 합계 상한 `project_doc_max_bytes` 32 KiB.[^cdx-agentsmd]
- 0.150.0(2026-08-26): 신뢰하지 않는 프로젝트는 프로젝트 수준 AGENTS를 제공하지 못한다는 변경 항목이 있다.[^cdx-cl]
- 재단: Agentic AI Foundation은 2025-12-09 Linux Foundation 산하로 발표됐고 MCP(Anthropic), goose(Block), AGENTS.md(OpenAI)가 창립 프로젝트다. Platinum: AWS, Anthropic, Block, Bloomberg, Cloudflare, Google, Microsoft, OpenAI. 발표문은 AGENTS.md를 6만 개 넘는 프로젝트가 채택했다고 주장한다.[^aaif] 2026-06-04 agentgateway 네 번째 프로젝트 합류는 검색 요약 기준이다.[^aaif-2nd]
- 저장소 활동은 드물다. 최근 커밋 2건은 2026-09-10 Technical Charter 추가다. 드문 커밋이 죽음을 뜻하지 않는 표본이다.[^agentsmd]

## 6. G3 활용법 소스

### 6.1 소스 표

| ID | 소스 | 접근 | 피드 | 갱신 주기 | 수집 주기 | 접근 상태 |
|---|---|---|---|---|---|---|
| U01 | `code.claude.com/docs/en/best-practices` | `.md` | 없음 | C03 | 변경 감지 | 200. 구 블로그 글의 현 위치 |
| U02 | `prompt-library`, `common-workflows` | `.md` | 없음 | C03 | 변경 감지 | 200 |
| U03 | `learn.chatgpt.com/use-cases/llms.txt` | 색인 | 없음 | O02 | 변경 감지 | 색인 명시, 본문 미조사 |
| U04 | awesome-claude-code | GitHub, CSV | 커밋 Atom | 일 단위 커밋 | 일 1회 | 263행. 원문 §3.5 |
| U05 | Simon Willison | 블로그 | `atom/everything/` | 일 단위 | 일 1회 | 200, 30건 |
| U06 | HN Algolia | API, 키 없음 | 없음 | 실시간 | 호출 시점 값 | 200. 최근 30일 키워드 일치 스토리: codex 1,645, claude code 520, mcp server 144, local llm 98 |
| U07 | Reddit `r/ClaudeCode` 등 | `.rss` | RSS | 실시간 | 분~시 | `r/ClaudeCode` 200(25건), 다른 서브레딧 연속 호출 429. 약관 미확인 |
| U08 | GeekNews | `news.hada.io/rss/news`, `/search?q=` | RSS(feedburner 경유) | 일 단위. 50건이 약 2일치 | 일 1회 | 200. 표본 50건 중 AI·에이전트 키워드 일치 14건. `/atom` 404 |
| U09 | 파이토치 한국 사용자 모임 | Discourse | `latest.rss`, `search.json` | 일 단위 | 일 1회 | 200 |
| U10 | 요즘IT | 웹진 | `/magazine/feed/` | 수시 | 일 1회 | 200 |
| U11 | 기업 기술 블로그 | 웹 | `tech.kakao.com/feed`, `techblog.woowahan.com/feed`, `toss.tech/rss.xml`, `d2.naver.com/d2.atom` | 수시 | 주 1회 | 200 |
| U12 | GPTers, Disquiet, OKKY | 웹 | 미확인 | 수시 | 미확인 | 200. 프로그램 경로 미확인 |
| U13 | velog | 웹 | 공통 `/rss/`는 404 | 수시 | 사용자별 | 공통 피드 없음. 사용자별 경로 미확인 |
| U14 | Ollama 블로그 | 웹 | `blog/rss.xml` | 수시. 최신 10-24 | 일 1회 | 200, 63건 |
| U15 | LM Studio | 웹 | `rss.xml` | 수시. 최신 09-18 | 주 1회 | 200, 65건 |
| U16 | OpenAI `use-cases` 컬렉션 | 웹 | 없음 | 비정기 | 변경 감지 | 미조사 |

주석: U01[^cc-bp], U04[^awesome], U05[^simon], U06[^hn], U07[^reddit], U08[^gn], U09[^pytorchkr], U10[^yozm], U11[^kr-tech], U14[^ollama-blog], U15[^lms-blog].

GeekNews `robots.txt`는 GPTBot, ClaudeBot, CCBot 등 학습·대량 수집 봇 묶음을 별도로 다룬다. 해당 규칙의 전문과 사이트 약관은 읽지 않았다. [실측 S-6]

### 6.2 큐레이션·실무 저장소

버전·날짜는 GitHub GraphQL 기준이다.[^scan] "커밋"은 기본 브랜치 마지막 커밋이다. 이 표의 저장소는 읽는 자료여서 설치·실행 시험을 하지 않았다.

| 저장소 | 최신 버전 | 릴리스 | 유지보수 상태 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|---|
| `hesreallyhim/awesome-claude-code` | 없음 | - | 활성. 커밋 10-31, 별 56,947 | NOASSERTION | 문서 자료, 미실측 | CSV 스키마 변동(구 파일명 404) |
| `shanraisshan/claude-code-best-practice` | 없음 | - | 활성. 커밋 10-31, 별 68,350 | MIT | 문서 자료, 미실측 | 제3자 |
| `ykdojo/claude-code-tips` | v0.26.39 | 2026-08-30 | 커밋 09-25, 별 10,293 | NOASSERTION | 문서 자료, 미실측 | 제3자 |
| `affaan-m/ECC` | v2.2.3 | 2026-10-01 | 활성. 커밋 10-30, 별 293,554. 구 `everything-claude-code` | MIT | 문서 자료, 미실측 | 이름 변경 |
| `wshobson/agents` | 없음 | - | 활성. 커밋 10-30, 별 42,029 | MIT | 문서 자료, 미실측 | - |
| `davila7/claude-code-templates` | v1.29.7 | 2026-10-09 | 활성. 커밋 10-31, 별 33,008 | MIT | 문서 자료, 미실측 | - |
| `VoltAgent/awesome-agent-skills` | 없음 | - | 활성. 커밋 10-30, 별 36,653 | MIT | 문서 자료, 미실측 | - |
| `VoltAgent/awesome-claude-code-subagents` | 없음 | - | 활성. 커밋 10-30, 별 26,220 | MIT | 문서 자료, 미실측 | - |
| `ComposioHQ/awesome-claude-skills` | 없음 | - | 커밋 07-24(99일), 별 78,376 | 표기 없음 | 문서 자료, 미실측 | - |
| `composio-community/awesome-codex-skills` | 없음 | - | 커밋 07-26(97일), 별 17,144. 구 ComposioHQ | 표기 없음 | 문서 자료, 미실측 | 이름 변경 |
| `travisvn/awesome-claude-skills` | 없음 | - | 커밋 04-28(186일), 별 15,647 | 표기 없음 | 문서 자료, 미실측 | 정체 의심 |
| `rohitg00/awesome-claude-code-toolkit` | v0.5.0 | 2026-05-11 | 커밋 05-12(172일), 별 2,797 | Apache-2.0 | 문서 자료, 미실측 | 정체 의심 |
| `disler/claude-code-hooks-mastery` | 없음 | - | 커밋 02-01(272일), 별 3,970 | 표기 없음 | 문서 자료, 미실측 | 정체 의심 |
| `anthropics/claude-cookbooks` | 없음 | - | 활성. 커밋 10-29, 별 53,983. 구 `anthropic-cookbook` | MIT | 문서 자료, 미실측 | 이름 변경 |
| `revfactory/claude-code-mastering`(한국어) | 없음 | - | 커밋 01-22(282일), 별 774 | 표기 없음 | 문서 자료, 미실측 | 정체 의심 |
| `revfactory/harness`(한국인 저자) | 없음 | - | 커밋 09-28, 별 9,294 | Apache-2.0 | 문서 자료, 미실측 | - |

## 7. G4 도구 생태계

버전·날짜는 GitHub GraphQL, npm, PyPI 기준이다.[^scan] 스킬·플러그인·오케스트레이터는 모두 **미실측**이다. "적합성"은 설치 전제 사실만 적었다. Claude Code 전역 설정을 건드리는 설치는 CLAUDE.md 지침 4의 제약을 받는다.

### 7.1 표준과 공식 저장소

| 후보 | 최신 버전 | 릴리스 | 유지보수 상태 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|---|
| MCP 사양 | 2026-07-28 | 2026-07-28 | 활성. 커밋 10-31, 별 9,572 | NOASSERTION | 표준 | - |
| `modelcontextprotocol/servers` | v2.2.0 | 2026-10-28 | 활성. 별 91,710 | NOASSERTION | Node·Python | 다수 서버가 `servers-archived`로 이동 |
| `modelcontextprotocol/registry` | v1.8.7 | 2026-10-30 | 활성. 별 7,423 | NOASSERTION | API 키 없이 조회 | 스캔 100초에 10,300버전, 전체 미완 |
| `modelcontextprotocol/inspector` | 2.13.0 | 2026-10-28 | 활성 | NOASSERTION | 미실측 | - |
| MCP Python SDK | v2.3.0 | 2026-10-02 | 활성. 별 24,715 | MIT | 미실측 | - |
| MCP TS SDK | GitHub v2.4.0, npm 1.32.2 | 2026-10-23 | 활성. 별 13,688 | NOASSERTION, npm MIT | 미실측 | 태그와 npm 판 어긋남, 확인 필요 |
| `agentskills/agentskills` | 없음 | - | 커밋 08-09(83일), 별 26,812 | Apache-2.0 | 표준 | `agentskills.io` 스펙 |
| `anthropics/skills` | 없음 | - | 활성. 커밋 10-28, 별 185,545 | 표기 없음 | 문서형 | - |
| `anthropics/claude-plugins-official` | 없음 | - | 활성. 커밋 10-30, 별 45,476 | Apache-2.0 | 내장 마켓플레이스 | 315개 |
| `anthropics/knowledge-work-plugins` | 없음 | - | 활성. 별 34,088 | Apache-2.0 | 미실측 | - |
| `openai/plugins` | 없음 | - | 커밋 10-08, 별 7,678 | 표기 없음 | 미실측 | `openai/skills` 후속 |
| `openai/codex-plugin-cc` | v1.0.6 | 2026-07-08 | 커밋 07-08(115일), 별 34,747 | Apache-2.0 | Codex 로그인 필요 | 정체 의심 |
| `openai/codex-action` | 없음 | - | 활성. 커밋 10-30 | Apache-2.0 | 원격 저장소 필요 | 이 저장소 원격 없음 |
| `vercel-labs/skills` | v1.7.4 | 2026-10-19 | 활성. 별 37,347 | MIT | Node | 미실측 |

### 7.2 스킬·플러그인·방법론

| 후보 | 최신 버전 | 릴리스 | 유지보수 상태 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|---|
| `obra/superpowers` | v7.0.1 | 2026-10-21 | 활성. 별 309,597 | MIT | 플러그인 | 미실측 |
| `thedotmack/claude-mem` | v15.7.0 | 2026-10-30 | 활성. 별 106,728 | Apache-2.0 | 플러그인 | 훅 다수 여부 미확인 |
| `github/spec-kit` | v1.2.5 | 2026-10-28 | 활성. 별 144,152 | MIT | CLI | 미실측 |
| `Fission-AI/OpenSpec` | v1.16.0 | 2026-10-30 | 활성. 별 73,494 | MIT | Node | 미실측 |
| `bmad-code-org/BMAD-METHOD` | v6.12.4 | 2026-10-14 | 활성. 별 54,799 | NOASSERTION, npm MIT | Node | 미실측 |
| `EveryInc/compound-engineering-plugin` | compound-engineering-v3.34.0 | 2026-10-31 | 활성. 별 25,793 | MIT | 플러그인 | 구 개인 저장소에서 이동 |
| `open-gsd/gsd-core` | v1.19.0 | 2026-10-26 | 활성. 별 11,055 | MIT | 미실측 | GSD 후속. 구 npm 전부 deprecated |
| `SuperClaude-Org/SuperClaude_Framework` | v4.3.0 | 2026-03-22 | 커밋 09-27, 별 23,917 | MIT | PyPI `superclaude` | 릴리스 7개월 전 |
| `eyaltoledano/claude-task-master` | 0.43.1 | 2026-03-31 | 커밋 04-23(191일), 별 28,279 | MIT WITH Commons-Clause | npm | 정체 의심, 라이선스 조건 |
| `frankbria/ralph-claude-code` | 없음 | - | 활성. 커밋 10-25, 별 9,720 | MIT | 미실측 | 공식 `ralph-loop` 플러그인과 관계 미확인 |
| `snarktank/ralph` | 없음 | - | 커밋 02-02(271일), 별 22,095 | MIT | 미실측 | 정체 의심 |
| `musistudio/claude-code-router` | v3.1.3 | 2026-10-09 | 커밋 10-10, 별 37,914 | MIT | npm | 게이트웨이 대체 경로, 미실측 |
| `sirmalloc/ccstatusline` | v2.2.33 | 2026-10-30 | 활성. 별 13,475 | MIT | npm | 미실측 |
| `jarrodwatts/claude-hud` | v0.14.1 | 2026-10-30 | 활성. 별 29,042 | MIT | 이 환경에 플러그인 설치됨 | - |

### 7.3 오케스트레이터

| 후보 | 최신 버전 | 릴리스 | 유지보수 상태 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|---|
| `stablyai/orca` | v1.4.245 | 2026-10-30 | 활성. 별 111,306 | MIT | 이 환경에서 사용 중. harness.md §4 | - |
| `ruvnet/ruflo` | v3.66.0 | 2026-10-31 | 활성. 별 80,338. 구 `claude-flow` | MIT | npm | npm 양쪽 이름 동시 게시 |
| `code-yeongyu/oh-my-openagent` | v5.1.51 | 2026-10-28 | 활성. 별 70,516. 구 `oh-my-opencode` | SUL-1.0(npm) | opencode 전제 | 소스 공개 라이선스 |
| `Yeachan-Heo/oh-my-claudecode` | v5.7.22 | 2026-10-30 | 활성. 별 40,439 | MIT | npm `oh-my-claude-sisyphus` | 미실측 |
| `gastownhall/gastown` | v1.2.1 | 2026-06-06 | 커밋 10-28, 별 18,636. 구 `steveyegge/gastown` | MIT | 미실측 | 태그가 커밋을 못 따라감 |
| `gastownhall/beads` | v1.3.2 | 2026-10-24 | 활성. 별 28,317 | MIT | 미실측 | - |
| `BloopAI/vibe-kanban` | v0.1.44-20260424091429 | 2026-04-24 | 커밋 10-28, 별 28,527 | Apache-2.0 | 미실측 | 릴리스 정체 |
| `smtg-ai/claude-squad` | v1.0.20 | 2026-08-20 | 커밋 72일 전, 별 8,705 | AGPL-3.0 | tmux 전제 여부 미확인 | - |
| `siteboon/claudecodeui` | v1.37.6 | 2026-10-27 | 활성. 별 14,358 | AGPL-3.0 | 웹 UI | 저장소 역할 밖 |
| `winfunc/opcode` | v0.2.0 | 2025-08-31 | 커밋 09-18, 별 22,428. 구 `getAsterisk/opcode` | AGPL-3.0 | GUI | 릴리스 14개월 전 |
| `dagger/container-use` | v0.4.2 | 2025-08-19 | 커밋 80일 전, 별 4,083 | Apache-2.0 | docker 없음 | 컨테이너 전제 |
| `nwiizo/ccswarm` | v0.10.2 | 2026-10-09 | 커밋 22일 전, 별 155 | MIT | cargo 없음 | 소규모 |
| `Nimbalyst/nimbalyst` | v0.81.7 | 2026-10-16 | 활성. 별 2,005 | MIT | GUI | Crystal 후속 |

### 7.4 MCP 서버

| 후보 | 최신 버전 | 릴리스 | 유지보수 상태 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|---|
| `upstash/context7` | npm 4.4.4 | 2026-10-19 | 활성. 별 63,985 | MIT | npm | 외부 서비스 의존 |
| `oraios/serena` | v2.1.0 | 2026-10-19 | 활성. 별 30,907 | GPL-3.0-or-later(PyPI) | PyPI `serena-agent` | 코드 소량 저장소 효용 미확인 |
| `microsoft/playwright-mcp` | v0.0.83 | 2026-09-28 | 활성. 별 38,883 | Apache-2.0 | npm | 브라우저 없음 |
| `github/github-mcp-server` | v2.0.3 | 2026-10-21 | 활성. 별 34,108 | MIT | 미실측 | - |
| `punkpeye/awesome-mcp-servers` | 없음 | - | 커밋 10-23, 별 97,103 | MIT | 목록 | - |

### 7.5 다른 코딩 에이전트

| 후보 | 최신 버전 | 릴리스 | 유지보수 상태 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|---|
| `anomalyco/opencode` | v1.19.5 | 2026-10-28 | 활성. 별 223,403. 구 `sst/opencode` | MIT | npm `opencode-ai` | 미실측 |
| `earendil-works/pi` | v1.4.0 | 2026-10-21 | 활성. 별 119,070. 구 `badlogic/pi-mono` | MIT | npm | 구 npm 폐기 |
| `google-gemini/gemini-cli` | v0.66.0 | 2026-10-27 | 활성. 별 108,645 | Apache-2.0 | npm | 키·계정 없음 |
| `OpenHands/OpenHands` | v1.34.0 | 2026-10-27 | 활성. 별 92,315 | MIT | 컨테이너 전제 여부 미확인 | docker 없음 |
| `cline/cline` | v4.1.26 | 2026-10-26 | 활성. 별 71,087 | Apache-2.0 | npm CLI 3.0.74 | GitHub 태그와 npm 판 다름 |
| `aaif-goose/goose` | v1.57.0 | 2026-10-28 | 활성. 별 56,002. 구 `block/goose` | Apache-2.0 | 미실측 | - |
| `charmbracelet/crush` | v0.99.0 | 2026-10-29 | 활성. 별 28,892 | FSL-1.1-MIT(npm) | npm | 소스 공개 라이선스 |
| `QwenLM/qwen-code` | npm 0.26.4 | 2026-10-29 | 활성. 별 28,843 | Apache-2.0 | npm | - |
| `Kilo-Org/kilocode` | v7.8.18 | 2026-10-26 | 활성. 별 27,810 | MIT | npm | - |
| `mistralai/mistral-vibe` | v3.0.4 | 2026-10-30 | 활성. 별 5,258 | Apache-2.0 | PyPI | - |
| `github/copilot-cli` | v1.0.105 | 2026-10-28 | 활성. 별 11,314 | NOASSERTION | 계정 필요 | - |
| `MoonshotAI/kimi-code` | npm 2.4.1 | 2026-10-30 | 활성. 별 8,070 | MIT | npm | `kimi-cli` 후속 |
| `tailcallhq/forgecode` | v2.14.0 | 2026-10-01 | 활성. 별 7,636 | Apache-2.0 | 미실측 | - |
| `Zoo-Code-Org/Zoo-Code` | v3.94.0 | 2026-10-31 | 활성. 별 2,071 | Apache-2.0 | VS Code 확장 | Roo Code 커뮤니티 포크 |
| `cecli-dev/cecli` | v1.10.1 | 2026-10-28 | 활성. 별 414 | Apache-2.0 | PyPI `aider-ce` | Aider 포크, 이름 불일치 |
| `openclaw/openclaw` | v2026.10.9 | 2026-10-29 | 활성. 별 393,505 | MIT | 미실측 | 범용 개인 에이전트 |
| `NousResearch/hermes-agent` | v0.22.5 | 2026-10-23 | 활성. 별 258,958 | MIT | 미실측 | 범용 에이전트 |

## 8. G5 sLLM

### 8.1 소스 표

| ID | 소스 | 접근 | 피드 | 갱신 주기 | 수집 주기 | 접근 상태 |
|---|---|---|---|---|---|---|
| L01 | Hugging Face Hub API | `/api/models`, 키 없음 | 없음 | 실시간 | 조직별 일 1회 | 200. `?blobs=true`로 파일 크기, LFS SHA-256 |
| L02 | llama.cpp 릴리스 | GitHub | `releases.atom` | 일 단위 빌드 태그 | 일 1회 | 200. `b12019`(10-31), 정기 판 `v0.8.0`(10-28) |
| L03 | Ollama | 문서, 라이브러리, GitHub | 블로그 RSS, `releases.atom` | 수일 | 일 1회 | 200. 문서 `llms.txt` 있음 |
| L04 | LM Studio | 문서, 변경 이력 | `rss.xml` | 수시 | 주 1회 | 200. `/docs/api/anthropic-api`는 404, 현행은 `/docs/developer/anthropic-compat/messages` |
| L05 | 독자 AI 파운데이션 모델 | 과기정통부 브리핑 | 없음 | 단계 평가 시 | 사건 단위 | 200 |
| L06 | r/LocalLLaMA | RSS | RSS | 실시간 | 분~시 | 429 관측 |
| L07 | 벤더 블로그 순위 글 | 웹 | 혼재 | 수시 | 낮음 | [2차]. 서로 상충 |

주석: L01[^hf-api], L02[^llama-rel], L03[^ollama-cc][^ollama-rel], L04[^lms-cc], L05[^msit-2][^msit-1].

### 8.2 모델 라인업

공개일은 HF `createdAt`, 크기는 GGUF 파일 합계(10⁹바이트)다.[^hf-api] GGUF는 표시한 저장소 값이고, 파생 저장소는 공식이 아니다. 16GB 표기는 파일 크기만 비교한 것으로 컨텍스트 메모리는 뺀 값이다.

| 모델 | 공개일 | 라이선스 | IQ4_XS | Q4_K_M | Q8_0 | 16,376 MiB 대비 Q4_K_M | GGUF 저장소 |
|---|---|---:|---:|---:|---:|---|---|
| LFM3-1.7B | 2026-10-23 | other | - | 1.10 | 1.85 | 여유 [실측] | `LiquidAI/LFM3-1.7B-GGUF` |
| Granite 4.2 3B | 2026-08 | Apache-2.0 | - | 2.24 | 3.89 | 여유 | `ibm-granite/granite-4.2-3b-GGUF` |
| Gemma 4 E2B | QAT 2026-06 | Apache-2.0 | 2.98 | 3.11 | 5.15 | 여유 | `unsloth/gemma-4-E2B-it-GGUF` |
| Gemma 4 E4B | QAT 2026-06 | Apache-2.0 | 5.07 | 5.34 | - | 여유 | Q4_0 공식 5.15, 나머지 파생 |
| Granite 4.2 8B | 2026-08 | Apache-2.0 | - | 5.35 | 9.35 | 여유 | `ibm-granite/granite-4.2-8b-GGUF` |
| Gemma 4 12B | QAT 2026-06 | Apache-2.0 | 6.38 | 7.12 | 13.13 | 여유 | `unsloth/gemma-4-12b-it-GGUF` |
| gpt-oss-20b | 2025-08-04 | Apache-2.0 | - | 11.62 | 12.11 | 들어감 | `unsloth/gpt-oss-20b-GGUF` |
| Devstral Small 2 24B | 2025-12 | 저장소별 상이 | 12.78 | 14.33 | 25.06 | 들어감(13,665 MiB) | `unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF` |
| Qwen3.8-27B | 2026-08-05 | Apache-2.0 | 14.25 | 16.46 | 29.05 | 파일만 15,697 MiB | `unsloth/Qwen3.8-27B-GGUF` |
| Gemma 4 26B A4B | 미확인 | Apache-2.0 | 13.60 | 16.95 | 27.32 | 파일만 16,164 MiB | `unsloth/gemma-4-26B-A4B-it-GGUF` |
| Gemma 4 31B | QAT 2026-06 | Apache-2.0 | 16.37 | 18.32 | 33.15 | 초과. IQ4_XS 15,611 MiB | `unsloth/gemma-4-31B-it-GGUF` |
| GLM-5.3-Flash | 2026-08-25 | MIT | 156.82 | - | 340.98 | 초과 | `unsloth/GLM-5.3-Flash-GGUF` |

크기 미확인: Qwen3.8-Flash-Next(파생 저장소 Q4_0 2.20GB), DeepSeek-V4.1-Flash(양자화 표기 비표준), MiniMax-M3.1-Flash, Kimi-K3. 파라미터 표기와 파일 크기의 대응은 이름만으로 추정할 수 없다(Gemma 4 E2B는 Q4_K_M이 3.11GB).

Llama 계열은 `meta-llama` 조직 최신이 2025-04(`Llama-Guard-4-12B`, Llama 4)다. 조직별 최신 게시일 기준 사실이고 다른 경로 공개는 조사하지 않았다.

### 8.3 한국 모델

| 모델 | 조직 | 공개일 | 라이선스 | Q4_K_M | 16,376 MiB 대비 | 비고 |
|---|---|---|---:|---:|---|---|
| kanana-2-1.3b-instruct | Kakao | 2026-07-24 | other | 미확인 | 여유 추정 | 파생 저장소 크기 표기가 어긋나 미기재 |
| kanana-2-3b-instruct | Kakao | 2026-07-24 | other | 2.16 | 여유 [실측] | `mradermacher` 파생 GGUF. Claude Code 연결 실패 §8.5 |
| HyperCLOVAX-SEED-Omni-8B | NAVER | 2025-12-23 | other | 미확인 | 미확인 | 멀티모달 |
| HyperCLOVAX-SEED-Think-14B | NAVER | 2025-07-21 | other | 8.92 | 여유 | `naver-ellm` GGUF. 이름이 비공식 파생인지 미확인 |
| HyperCLOVAX-SEED-Think-32B | NAVER | 2025-12-23 | other | 미확인 | 미확인 | - |
| Gravity-30B-A5B | Trillion Labs | 2026-09-09 | Apache-2.0 | 19.61 | 초과. IQ4_XS 16.12(15,373 MiB) | `batiai` 파생 GGUF |
| kanana-2-30b-a3b | Kakao | 2026-01-14 | other | 18.60 | 초과 | 파생 GGUF |
| EXAONE-4.5-33B | LG AI연구원 | 2026-04-04 | other | 20.05 | 초과. IQ4_XS 18.03 | 공식 GGUF 저장소 |
| Solar-Open2-250B | Upstage | 2026-07-22 | other | 해당 없음 | 범위 밖 | 2,500억 파라미터[2차] |
| A.X K2 | SKT | 2026-07-28 | Apache-2.0 | 해당 없음 | 범위 밖 | 6,880억 파라미터[2차] |
| K-EXAONE 2.0 750B A37B | LG AI연구원 | 2026-07-29 | Apache-2.0 | 해당 없음 | 범위 밖 | 저장소명 750B |
| Motif 3 | 모티프테크놀로지스 | 2026-08[2차] | 미확인 | 해당 없음 | 범위 밖 | 3,140억 파라미터[2차]. 공식 저장소 ID 미확인 |

독자 AI 파운데이션 모델 평가: 1차는 LG, 네이버클라우드, SKT, 업스테이지 상위였으나 네이버클라우드가 독자성 기준으로 탈락했다는 보도가 있다.[^kr-1st] 2차는 업스테이지, SKT, LG AI연구원 통과, 모티프테크놀로지스 탈락이다.[^msit-2] 3단계 방안은 예산 확정 후 발표하고 이의제기 절차가 먼저 있다고 브리핑은 밝힌다.[^msit-2] 브리핑 페이지 표기일은 2026-08-19, 언론 보도는 08-18이다.[^kr-2nd]

### 8.4 로컬 실행 도구와 연결 방식

| 후보 | 최신 버전 | 릴리스 | 유지보수 상태 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|---|
| llama.cpp | b12019 / v0.8.0 | 2026-10-31 / 10-28 | 활성. 별 132,916 | MIT | **CUDA 실측 성공.** Vulkan 불가 | CUDA 런타임 575MB |
| Ollama | v0.40.13 | 2026-10-28 | 활성. 별 185,408 | MIT | 미실측 | 1,454MB, 프롬프트 캐시 미지원 |
| LM Studio(`lms`) | 앱 비공개, CLI MIT | CLI 커밋 10-14 | 활성 | 앱 비공개, CLI MIT | 미실측 | GUI 중심 |
| vLLM | v0.32.0 | 2026-10-18 | 활성. 별 95,951 | Apache-2.0 | 미실측 | Python 의존 |
| SGLang | GitHub v0.5.22, PyPI 0.5.23 | 2026-10-19 / 10-30 | 활성. 별 38,316 | Apache-2.0 | 미실측 | - |
| llama-swap | v268 | 2026-10-28 | 활성. 별 6,140 | MIT | 미실측 | - |
| KoboldCpp | v1.124 | 2026-10-31 | 활성. 별 12,104 | AGPL-3.0 | 미실측 | llama.cpp 포크 |
| LocalAI | v4.12.1 | 2026-10-23 | 활성. 별 50,084 | MIT | 미실측 | - |
| Jan | v0.8.8 | 2026-10-28 | 활성. 별 45,191 | NOASSERTION | 미실측 | GUI |
| Open WebUI | v0.12.5 | 2026-10-29 | 활성. 별 157,326 | 자체 라이선스 | 미실측 | 범위 밖(UI) |
| LiteLLM | v1.106.6 | 2026-10-28 | 활성. 별 62,423 | NOASSERTION | 미실측 | 프록시 |
| llama-cpp-python | 0.3.36 | 2026-10-01 | 커밋 30일 전, 별 10,668 | MIT | 미실측 | llama.cpp 추종 지연 가능 |
| textgen(구 text-generation-webui) | v4.9 | 2026-05-20 | 커밋 75일 전, 별 47,730 | AGPL-3.0 | 미실측 | 이름 변경 |

연결 방식:

| 에이전트 | 경로 | 요구 API | 공식 근거 | 실측 |
|---|---|---|---|---|
| Claude Code | `ANTHROPIC_BASE_URL` | `/v1/messages` | 게이트웨이 호환 문서. 공식 문서에 Ollama, llama.cpp, LM Studio 언급 0건[^cc-gw] | llama-server 성공 |
| Claude Code | `ollama launch claude` | Anthropic 호환 | Ollama 문서[^ollama-cc] | 미실측 |
| Claude Code | LM Studio | `/v1/messages` | LM Studio 문서[^lms-cc] | 미실측 |
| Claude Code | `claude-code-router`, LiteLLM | 프록시 변환 | 제3자 | 미실측 |
| Codex | `--oss`, `--local-provider ollama\|lmstudio`, `oss_provider` | 내장 프로바이더 | Codex 문서[^cdx-llms] | 미실측 |
| Codex | `[model_providers.<id>]`, `wire_api = "responses"` | `/v1/responses` | Codex 문서. `responses`가 유일한 값[^cdx-llms] | llama-server 성공 |
| Codex | `ollama launch codex` | Ollama 프로파일 | Ollama 문서[^ollama-codex] | 미실측 |

연결 시 사실:

- Claude Code는 인식 못 하는 모델 ID에 컨텍스트 200K를 가정한다. `[1m]`이면 1M이다.[^cc-gw]
- `ANTHROPIC_BASE_URL` 뒤로 tool search가 기본 켜짐이고 400·422면 끄고 재시도한다(2.1.304). 2.1.268은 서드파티 호환 엔드포인트에서 모든 턴이 400으로 실패하던 2.1.265 회귀를 고쳤다. 프로토콜 호환은 버전마다 흔들린다.[^cc-cl]
- 스트림 무응답 대기는 2.1.299에서 300초다. 2.1.101은 로컬 LLM을 끊던 5분 고정 시간제한을 고쳤다.[^cc-cl]
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`은 베타 필드를 끄지만 `role: "system"` 중간 메시지는 남긴다고 문서가 밝힌다.[^cc-gw] kanana 실패의 원인과 맞물린다.
- Ollama 호환 층은 `cache_control` 프롬프트 캐시를 지원하지 않고, 컨텍스트 64k 이상을 안내한다.[^ollama-anth][^ollama-cc]
- 지원 시점 주장: llama.cpp 2026-01, Ollama v0.14.0(2026-01-16), LM Studio 0.4.1. 검색 요약 기준이다.[^local-2nd]
- 2차 글의 16GB 평가는 상충한다. 일부 글은 Devstral Small 24B를, 일부는 Gemma 4 12B나 Qwen 3.6-35B-A3B를 꼽는다고 주장한다. 일부 목록에는 출처가 의심스러운 모델도 섞여 있었다. 이번에 검증하지 않았다.[^local-rank]

### 8.5 실측 결과

환경: llama.cpp b12019 CUDA 13.4 빌드, 드라이버 610.88, `-ngl 999 -c 32768 -np 1 --jinja`, 루프백 바인드. Claude Code는 가짜 HOME, 가짜 키, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`이다. 모델 1개당 1회 측정이다.

| ID | 시험 | 결과 | 수치 |
|---|---|---|---|
| L-1 | Vulkan 빌드 장치 목록 | 장치 없음 | `Available devices: (none)` |
| L-2 | CUDA 빌드 장치 목록 | 성공 | `CUDA0: NVIDIA GeForce RTX 4080 SUPER (16375 MiB, 15031 MiB free)` |
| L-3 | LFM3 Q4_K_M 로드 | 성공 | 파일 1,049 MiB, VRAM 증가 1,820 / 1,811 MiB. 평가 160~164 tok/s, 프롬프트 6,889~16,206 tok/s(15토큰 호출 제외) |
| L-4 | `/v1/messages` 직접 호출 | 성공 | `thinking` 블록, `signature` 빈 문자열 |
| L-5 | Claude Code `--tools ""` | 성공 | 프롬프트 1,606토큰, `result: OK`, 449ms |
| L-6a | Claude Code `Read` | 성공 | 2턴, 2,396ms, PERSIMMON |
| L-6b | Claude Code `Bash(wc *)` | 성공 | 2턴, 1,060ms, 30바이트 정답 |
| L-6c | Claude Code 기본 도구, `--max-turns 4` | 실패 | `error_max_turns`, 프롬프트 10,997토큰, 14.9초 |
| L-6d | 같은 조건, `--max-turns 10` | **거짓 성공** | 7턴, 63.5초. 호출 순서 Bash, Read, ToolSearch, Read, Read, ToolSearch. 파일을 찾지 못했다는 응답인데 `subtype: success`, `is_error: false` |
| L-7 | kanana-2-3b Q4_K_M 로드 | 성공 | 파일 2,062 MiB, VRAM 증가 6,365 MiB(노이즈 가능) |
| L-8 | kanana + Claude Code | 실패 | HTTP 500 13회, `Jinja Exception: System message must be at the beginning.` 두 시험 모두 120초 시간 초과 |
| L-9 | Codex `exec` + LFM3 | 성공 | `/bin/zsh -lc 'cat note.txt'` exit 0, PERSIMMON. 입력 12,514(캐시 5,957), 출력 90. 경고 `Model metadata for lfm3 not found` |
| L-10 | 크기 환산 | 계산 | 1GB(10⁹)=953.67 MiB. 16,376 MiB=17.17GB. 측정 시 여유 15,031 MiB=15.76GB |

이 결과로 말할 수 있는 범위:

- 연결 경로는 실제로 동작한다. Claude Code 2.1.316은 `provider: firstParty`, `costBasis: unknown`으로 기록했고 stderr에 `[claude-code:unrecognized_model]`을 냈다.
- 도구 호출 품질은 1.7B 소형 모델 1개의 값이다. 16GB 상한 모델의 성능은 측정하지 않았다.
- L-6d는 harness.md §3.3의 "exit·subtype은 성공의 근거가 아니다"가 로컬 모델에서도 재현된 사례다.
- L-8은 모델 자체가 아니라 채팅 템플릿과 Claude Code 요청 구조의 비호환이다. 템플릿 교체로 풀리는지는 시험하지 않았다.

## 9. 갱신 주기별 묶음

| 주기 | 소스 |
|---|---|
| 호출 시점 값 | U06, L01, O07, M21(MCP Registry) |
| 사건 단위 | C11, O12, L05 |
| 릴리스 단위(거의 매일) | C01, C02, C13, C14, C16, O01, O03, O10, L02 |
| 일 | C12, C15, U04, U05, U08, U09, U10, U14, L03 |
| 주 | C05, O06, U11, U15, L04 |
| 월 | C08 |
| 비정기·변경 감지 | C03, C04, C06, C07, C09, C10, O02, O04, O05, O08, O09, O11, U01, U02, U03 |
| 호출 제약 있음 | U07, L06(Reddit 429) |

하위 도메인 매핑:

| 하위 주제 | 1차 소스 | 커뮤니티·제3자 |
|---|---|---|
| G1 Claude Code | C01~C15 | C16, U04 |
| G2 Codex | O01~O13 | U05, U06 |
| G3 활용법 | U01~U03 | U04~U13 |
| G4 생태계 | C15, M21, §7 저장소 | U04 |
| G5 sLLM | L01~L05 | U14, U15, L06, L07 |

## 10. 죽은 데이터 후보

적재 전 확인 대상이다. 상태값은 §3.1이다.

| 대상 | 상태 | 근거 | 후속 |
|---|---|---|---|
| Roo Code 확장 | `removed` | README "shut down on May 15th", archived | 커뮤니티 포크 Zoo-Code, Cline 안내 |
| `continuedev/continue` | `removed` | README "no longer actively maintained and is read-only", Final 2.0.0. 플래그 false | 없음 |
| `microsoft/autogen` | `superseded` | README, 플래그 false | Microsoft Agent Framework |
| `openai/skills` | `superseded` | README "This repository is deprecated", 플래그 false | `openai/plugins` |
| `openai/swarm` | `superseded` | README, 플래그 false | OpenAI Agents SDK |
| `stravu/crystal` | `superseded` | README, 2026-02 폐기, 플래그 false | Nimbalyst |
| `coder/agentapi` | `removed` | README, archived | Coder Agents(다른 제품) |
| `MoonshotAI/kimi-cli` | `superseded` | README, archived, PyPI `7 - Inactive`. README는 기존 설치도 동작 중단 예고 | `kimi-code` |
| `gsd-build/get-shit-done`, `gsd-build/gsd-2` | `superseded` | README, archived, npm 전 버전 deprecated | `open-gsd/gsd-core` |
| `opencode-ai/opencode` | `superseded` | README, archived | Crush |
| `wshobson/commands` | `superseded` | README, archived | `wshobson/agents` |
| `huggingface/text-generation-inference` | `removed` 경계 | README 유지보수 모드, archived | 없음 |
| `OpenHands/openhands-aci` | `removed` | archived, README 문구 없음 | 미확인 |
| MCP 참조 서버(github, postgres, puppeteer, slack, gitlab, google-maps, brave-search 등) | `superseded` | npm deprecated, `servers-archived` | 일부 공식 서버 존재 |
| `plandex-ai/plandex` | `stale_suspect` | Cloud 종료 공지, 커밋 393일, 도메인 연결 실패 | 없음 |
| `nomic-ai/gpt4all` | `stale_suspect` | 커밋 522일, 릴리스 613일, 선언 없음 | 없음 |
| `Aider-AI/aider` | `stale_suspect` | 커밋 162일, 선언 없음 | 포크 cecli |
| `TabbyML/tabby` | `stale_suspect` | 커밋 123일, 릴리스 279일 | 없음 |
| `claude-code-sdk`(PyPI) | `superseded` | 2.0.25 공지, 최종 0.0.25 | `claude-agent-sdk` |
| `@zed-industries/claude-code-acp` | `renamed` | npm 메시지 | `@agentclientprotocol/claude-agent-acp` |
| Claude Code 제거 기능 | `removed` | §4.2 | §4.2 |
| Codex 제거 기능·모델 | `removed`, `partial` | §5.2 | §5.2 |
| Sonnet 4.5, Opus 4.8 fast mode | `scheduled_removal` | 2026-11-30 | Sonnet 5.5, Opus 5.5 |
| What's new 주간 요약 | 피드 정체 | W37 이후 없음 | C02 |
| `developers.openai.com/rss.xml` | 피드 정체 | 최신 2026-05-05 | O03 |

## 11. 조사가 남긴 부수효과

| 대상 | 내용 | 상태 |
|---|---|---|
| `~/.claude/settings.json` | **이 작업이 만들지 않은 변경을 발견했다.** 16:47 KST에 `env.CLAUDE_CODE_TMPDIR`가 추가됐다. 기준 해시 `22f462e98f2b0681`에서 이 키를 뺀 값이 현재 파일과 일치한다. 이번 스크립트와 명령은 이 파일을 쓰지 않았고 `claude`·`codex`는 가짜 HOME으로만 실행했다. 누가 넣었는지는 미확인이다 | 건드리지 않음. 사용자 확인 필요 |
| 나머지 전역 파일 | `settings.hooks`, `settings.plugins`, `~/.zshrc`, `~/.bashrc`, `~/.profile` 해시는 기준과 일치. crontab 없음 | 변경 없음 |
| `~/.npm` | `npm view`·`npm install --prefix`로 캐시·로그 추가 | 유지 |
| 저장소 | 이 문서만 추가 | 커밋 안 함 |
| 측정 산출물 | 모델 3.26GB, CUDA 빌드 794MB, Codex 436MB | 삭제함. 스크립트·로그 56MB는 스크래치패드에 남음 |
| `/tmp` | 측정 중 여유 2.0GB까지 내려감 | 종료 시 5.0GB |
| 외부 호출 | GitHub GraphQL·REST, npm, PyPI, HF, MCP Registry, 문서 사이트. 사용자 식별자 전송 없음 | - |

## 12. 실측 로그

스크립트 위치: 스크래치패드 `sources-g/scripts/`. 호출 구간 2026-10-31 07:34~08:10 UTC.

S-1 저장소 표본

```bash
python3 -I gh_scan.py repos.txt repos.tsv
# GraphQL: nameWithOwner isArchived isDisabled isLocked isFork stargazerCount pushedAt
#          licenseInfo latestRelease defaultBranchRef.target.committedDate issues(states:OPEN)
python3 -I survival_eval.py survival.tsv repos.tsv repos2.tsv repos3.tsv
# unique repos 138, archived 10, readme strict hit 16
# 커밋 경과: <30 95, 30-89 13, 90-179 14, 180-364 11, >=365 5
# 이동 21건. NOT_FOUND는 내가 추측한 이름 6건을 빼고 3건
```

README 엄격 패턴: `no longer (actively )?maintained|no longer the active home|is (now )?deprecated|has been deprecated|been archived|\(archived\)|project archived|has moved|shut down on|been replaced by|is now replaced by|maintenance mode|read-only for all|unmaintained|discontinued|winding down|wind down`

S-2 패키지

```bash
python3 -I pkg_scan.py npm <패키지 41개>   # latest deprecated 11, 과거 버전만 deprecated 15, 404 1
python3 -I pkg_scan.py pypi <패키지 19개>  # project-status active 18/18, api-version 1.4, kimi-cli 7 - Inactive, cecli 404
```

S-3 변경 이력

```bash
curl -o CHANGELOG.github.md https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md   # 1,130,515바이트
curl -o changelog.docs.md https://code.claude.com/docs/en/changelog.md                                  # 1,151,295바이트
python3 -I cc_changelog.py changelog.docs.md CHANGELOG.github.md strict.tsv
# versions 434, entries 8,497, 2025-04-02 ~ 2026-10-31, 두 파일 버전 집합 일치
python3 -I cc_lookup.py changelog.docs.md CHANGELOG.github.md '<regex>'   # 항목을 버전·날짜로 환산
```

S-4 Codex

```bash
HOME=<가짜> CODEX_HOME=<가짜>/.codex codex features list   # 194행
curl https://raw.githubusercontent.com/openai/codex/main/codex-rs/features/src/lib.rs   # 82,514바이트
```

S-5 문서 URL

```bash
curl -s -o /dev/null -w '%{http_code}' <url>                 # 첫 응답
curl -sL -o body -w '%{http_code} %{num_redirects} %{size_download} %{url_effective}' <url>
curl https://code.claude.com/docs/en/ultraplan.md            # 200, 1,102바이트
```

S-6 피드

```bash
python3 -I rss_scan.py <feed>
# cc-changelog 15건, 최신 10-31 / cc-whatsnew 15건, 최신 09-15
# oai-dev 138건, 최신 05-05 / ollama 63건, 최신 10-24 / geeknews 50건, 10-30~10-31 / simon 30건
# platform-notes: 176,281바이트, <item>·<entry> 0개, html id="__next_error__"
```

S-7 큐레이션 대조

```bash
curl -O https://raw.githubusercontent.com/hesreallyhim/awesome-claude-code/main/THE_RESOURCES_TABLE_NEW.csv   # 119,363바이트
python3 -I gh_scan.py aw-repos.txt aw.tsv   # 248개
```

S-8 MCP Registry

```bash
# /v0/servers?limit=100, 커서 순회, 100초 제한, 103쪽
# versions 10,300: active 10,159, deprecated 141. isLatest만: active 3,284, deprecated 29
```

L 시리즈 로컬 모델

```bash
gh api repos/ggml-org/llama.cpp/releases/tags/b12019 --jq '.assets[].digest'   # SHA-256 대조 일치
LD_LIBRARY_PATH=$PWD ./llama-server --list-devices
LD_LIBRARY_PATH=$PWD ./llama-server -m LFM3-1.7B-Q4_K_M.gguf --host 127.0.0.1 --port 18080 \
  --jinja -c 32768 -ngl 999 -np 1 --no-webui --api-key local-test
env -i HOME=<가짜> PATH=... DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  ANTHROPIC_BASE_URL=http://127.0.0.1:18080 ANTHROPIC_API_KEY=local-test \
  claude -p '<프롬프트>' --no-session-persistence --model lfm3 --tools "Read" \
  --allowedTools "Read" --permission-mode dontAsk --max-turns 4 --output-format json
```

```toml
# Codex 가짜 CODEX_HOME/config.toml
model = "lfm3"
model_provider = "localllama"
[model_providers.localllama]
name = "llama.cpp local"
base_url = "http://127.0.0.1:18080/v1"
wire_api = "responses"
env_key = "LOCAL_KEY"
```

```bash
codex exec --skip-git-repo-check -s read-only --json '<프롬프트>' </dev/null
```

모델 파일 SHA-256은 HF LFS 값과 대조해 일치했다(`LFM3-1.7B-Q4_K_M.gguf`, `kanana-2-3b-instruct.Q4_K_M.gguf`).

## 13. 미확인 사항

- 16GB 경계 모델의 실제 VRAM, 속도, 도구 호출 품질. tmpfs 제약으로 7GB 이상 모델을 시험하지 못했다.
- kanana VRAM 증가량 6,365 MiB의 정확도. 다른 GPU 프로세스 변동을 배제하지 못했다.
- kanana 실패가 템플릿 교체로 풀리는지. 다른 한국 모델의 Claude Code 호환성.
- Ollama, LM Studio, vLLM 경로 실측. Codex `--oss` 실측.
- 어떤 신호에도 안 걸린 저장소 121개의 실제 상태.
- 재현율의 진짜 값. 무작위 표본 검증이 없다.
- `ultrathink`의 중간 제거 시점. CHANGELOG에서 찾지 못했다.
- What's new가 W37 이후 멈춘 이유가 중단인지 지연인지. W31 결락 이유.
- Engineering 페이지 헤더 27건과 격자 24건의 차이.
- MCP Registry 전체 규모. 100초 안에 끝까지 못 읽었고 `deleted` 상태 표본도 못 봤다.
- PEP 792 `project-status`가 실제로 쓰이는 사례. 18개 전부 `active`였다.
- `Codex Cloud (Legacy)`의 종료 일정.
- Codex 문서 한국어판. `learn.chatgpt.com/ko/docs`는 404였다.
- Reddit 약관과 인증 없는 RSS 허용량. GeekNews 수집 조건 원문.
- GPTers, Disquiet, OKKY의 프로그램 접근 경로. velog 사용자별 피드 형식.
- MCP TypeScript SDK의 GitHub v2.4.0과 npm 1.32.2 불일치 이유.
- `parruda/claude-swarm`이 삭제인지 비공개 전환인지.
- GeekNews 피드의 "Claude Code 확장 SSH 백도어" 항목 원문과 영향 범위.
- `~/.claude/settings.json`의 `CLAUDE_CODE_TMPDIR`를 추가한 주체.
- 공식 문서 페이지별 `lastmod`. 변경 감지는 해시 비교가 전제다.

[^cc-cl]: Claude Code changelog, https://code.claude.com/docs/en/changelog (확인 2026-10-31, 1차)
[^cc-cl-gh]: CHANGELOG.md, https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md , 피드 https://github.com/anthropics/claude-code/releases.atom (확인 2026-10-31, 1차)
[^cc-llms]: Claude Code 문서 색인, https://code.claude.com/docs/llms.txt , 전문 https://code.claude.com/docs/llms-full.txt , 명령 https://code.claude.com/docs/en/commands , 도구 https://code.claude.com/docs/en/tools-reference , 용어집 https://code.claude.com/docs/en/glossary , 마켓플레이스 https://code.claude.com/docs/en/plugins/anthropic-marketplaces (확인 2026-10-31, 1차)
[^cc-ko]: Claude Code 한국어 문서, https://code.claude.com/docs/ko/overview , 색인 https://code.claude.com/docs/_llms/ko.txt (확인 2026-10-31, 1차)
[^cc-wn]: What's new, https://code.claude.com/docs/en/whats-new , RSS https://code.claude.com/docs/en/whats-new/rss.xml (확인 2026-10-31, 1차)
[^cc-bp]: Best practices, https://code.claude.com/docs/en/best-practices (구 https://www.anthropic.com/engineering/claude-code-best-practices , 확인 2026-10-31, 1차)
[^cc-gw]: Claude Code gateway compatibility guide, https://code.claude.com/docs/en/llm-gateway-protocol (확인 2026-10-31, 1차)
[^model-dep]: Model deprecations, https://platform.claude.com/docs/en/about-claude/model-deprecations (확인 2026-10-31, 1차)
[^api-notes]: Claude Platform release notes, https://platform.claude.com/docs/en/release-notes/overview (확인 2026-10-31, 1차)
[^eng]: Anthropic Engineering, https://www.anthropic.com/engineering (확인 2026-10-31, 1차)
[^claude-sitemap]: claude.com sitemap, https://claude.com/sitemap.xml , 글 https://claude.com/resources/articles (확인 2026-10-31, 1차)
[^support-notes]: Claude release notes, https://support.claude.com/en/articles/12138966-release-notes (확인 2026-10-31, 1차)
[^status-claude]: Claude status history, https://status.claude.com/history.rss (확인 2026-10-31, 1차)
[^plugins-mkt]: claude-plugins-official, https://github.com/anthropics/claude-plugins-official , 디렉터리 https://claude.com/marketplace (확인 2026-10-31, 1차)
[^piebald]: claude-code-system-prompts, https://github.com/Piebald-AI/claude-code-system-prompts (확인 2026-10-31, 2차)
[^cdx-llms]: Codex 문서 색인, https://learn.chatgpt.com/docs/llms.txt , 전문 https://learn.chatgpt.com/docs/llms-full.txt , 설정 https://learn.chatgpt.com/docs/config-file/config-advanced (확인 2026-10-31, 1차)
[^cdx-cl]: ChatGPT & Codex changelog, https://learn.chatgpt.com/docs/changelog , RSS https://learn.chatgpt.com/docs/changelog/rss.xml (확인 2026-10-31, 1차)
[^cdx-maturity]: Feature Maturity, https://learn.chatgpt.com/docs/feature-maturity (확인 2026-10-31, 1차)
[^cdx-models]: Codex Models, https://learn.chatgpt.com/docs/models (확인 2026-10-31, 1차)
[^cdx-wn]: Codex What's new, https://learn.chatgpt.com/docs/whats-new (확인 2026-10-31, 1차)
[^cdx-mcp]: Codex MCP server removal, https://learn.chatgpt.com/docs/mcp-server (확인 2026-10-31, 1차)
[^cdx-lib]: codex-rs/features/src/lib.rs, https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs (확인 2026-10-31, 1차)
[^cdx-agentsmd]: Custom instructions with AGENTS.md, https://learn.chatgpt.com/docs/agent-configuration/agents-md (확인 2026-10-31, 1차)
[^oai-dep]: OpenAI API deprecations, https://developers.openai.com/api/docs/deprecations (확인 2026-10-31, 1차)
[^agentsmd]: AGENTS.md, https://agents.md/ , 저장소 https://github.com/agentsmd/agents.md (확인 2026-10-31, 1차)
[^aaif]: Linux Foundation Announces the Formation of the Agentic AI Foundation, https://aaif.io/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation-aaif-anchored-by-new-project-contributions-including-model-context-protocol-mcp-goose-and-agents-md/ (2025-12-09, 확인 2026-10-31, 1차)
[^aaif-2nd]: AAIF 후속 사건 요약, https://latent.space/wiki/aaif/ (확인 2026-10-31, 2차)
[^scan]: GitHub GraphQL API, https://docs.github.com/en/graphql , npm registry https://registry.npmjs.org , PyPI JSON https://pypi.org/pypi , PEP 792 https://peps.python.org/pep-0792/ (조회 2026-10-31, 실측)
[^awesome]: awesome-claude-code, https://github.com/hesreallyhim/awesome-claude-code (확인 2026-10-31, 1차)
[^simon]: Simon Willison's Weblog, https://simonwillison.net/atom/everything/ (확인 2026-10-31, 1차)
[^hn]: HN Search API, https://hn.algolia.com/api (확인 2026-10-31, 1차)
[^reddit]: r/ClaudeCode RSS, https://www.reddit.com/r/ClaudeCode/.rss (확인 2026-10-31, 실측)
[^gn]: GeekNews, https://news.hada.io/ , RSS https://news.hada.io/rss/news , robots https://news.hada.io/robots.txt (확인 2026-10-31, 실측)
[^pytorchkr]: 파이토치 한국 사용자 모임, https://discuss.pytorch.kr/ (확인 2026-10-31, 실측)
[^yozm]: 요즘IT, https://yozm.wishket.com/magazine/feed/ (확인 2026-10-31, 실측)
[^kr-tech]: 기업 기술 블로그 피드, https://tech.kakao.com/feed/ , https://techblog.woowahan.com/feed/ , https://toss.tech/rss.xml , https://d2.naver.com/d2.atom (확인 2026-10-31, 실측)
[^ollama-blog]: Ollama blog RSS, https://ollama.com/blog/rss.xml (확인 2026-10-31, 1차)
[^lms-blog]: LM Studio RSS, https://lmstudio.ai/rss.xml (확인 2026-10-31, 1차)
[^hf-api]: Hugging Face Hub API, https://huggingface.co/docs/hub/api , 모델 https://huggingface.co/unsloth/Qwen3.8-27B-GGUF , https://huggingface.co/unsloth/gemma-4-12b-it-GGUF , https://huggingface.co/LGAI-EXAONE/EXAONE-4.5-33B-GGUF , https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF (조회 2026-10-31, 실측)
[^llama-rel]: llama.cpp Releases, https://github.com/ggml-org/llama.cpp/releases (확인 2026-10-31, 1차)
[^ollama-rel]: Ollama Releases, https://github.com/ollama/ollama/releases (확인 2026-10-31, 1차)
[^ollama-cc]: Ollama Claude Code 연동, https://docs.ollama.com/integrations/claude-code (확인 2026-10-31, 1차)
[^ollama-codex]: Ollama Codex CLI 연동, https://docs.ollama.com/integrations/codex (확인 2026-10-31, 1차)
[^ollama-anth]: Ollama Anthropic compatibility, https://docs.ollama.com/api/anthropic-compatibility (확인 2026-10-31, 1차)
[^lms-cc]: LM Studio Claude Code 연동, https://lmstudio.ai/docs/integrations/claude-code (확인 2026-10-31, 1차)
[^local-2nd]: New in llama.cpp: Anthropic Messages API, https://huggingface.co/blog/ggml-org/anthropic-messages-api-in-llamacpp , 가이드 https://site-a.pages.dev/guides/claude-code-local-llm-anthropic-base-url/ (검색 요약, 확인 2026-10-31, 2차)
[^local-rank]: 16GB 순위 글, https://genalphai.com/best-local-llm-for-coding-on-16gb-vram-june-2026-rankings/ , https://insiderllm.com/guides/best-local-coding-models-2026/ , https://www.promptquorum.com/power-local-llm/best-local-models-tool-calling-2026 (검색 요약, 확인 2026-10-31, 2차)
[^msit-2]: 독자 AI 파운데이션모델 프로젝트 2차 단계평가 결과 브리핑, https://www.korea.kr/briefing/policyBriefingView.do?newsId=156774781 (2026-08-19 표기, 확인 2026-10-31, 1차)
[^msit-1]: 독자 AI 파운데이션 모델 프로젝트 1차 단계 평가 결과, https://www.korea.kr/briefing/policyBriefingView.do?newsId=156740468 (확인 2026-10-31, 1차 링크, 본문은 검색 요약)
[^kr-1st]: 1차 평가 보도, https://www.aitimes.kr/news/articleView.html?idxno=38163 (확인 2026-10-31, 2차)
[^kr-2nd]: 독파모 2차 보도, https://byline.network/2026/08/0818-7/ , Motif 3 https://wowtale.net/2026/08/13/262915/ (확인 2026-10-31, 2차)
