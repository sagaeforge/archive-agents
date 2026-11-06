# 토큰·데이터 압축 조사: rtk, trail, 응답 설계, 저장 압축

- 작성일·확인일: 2026-10-31. 웹 출처별 확인일은 §11 표에 있다.
- 범위: 운영 지침 4번("rtk 및 trailing으로 토큰과 데이터를 압축")의 근거 자료. 시스템 설계 입력이며 지식 데이터가 아니다.
- 표기: `[S번호]`는 §11 출처, `[M번호]`는 §12 실측 기록이다. 벤더·제3자 수치는 "X가 주장"으로 적었다. "시뮬레이션"은 실제 원본에 변경을 합성한 값이다.
- 환경: WSL2 Linux 6.18, 24 CPU, RAM 30GB, Python 3.14.4, Node 26.13.0, Claude Code 2.1.314, rtk-oss 1.1.0, Trail-Code 0.28.1, git 2.53.0.

## 1. 핵심 사실

1. **rtk는 Bash 출력만 다룬다.** 설치본 `rtk-oss`는 엔진이 빠진 판이라 `Read`·MCP·`WebFetch` 출력에는 손대지 못한다 [S4]. 수집 작업의 주력 명령인 `curl`, `gh api`, `cat`은 0% 감소였고, `python`, `sed`, `sqlite3`, `duckdb`, `yt-dlp`는 재작성 대상이 아니다 [M5].
2. **프로젝트 훅은 전역 설정 없이 동작한다.** `.claude/settings.json`에 `rtk hook claude`를 손으로 넣으면 `claude -p`, 서브에이전트, Workflow 에이전트, worktree 격리 에이전트의 Bash 모두에서 발동했다 [M3]. `rtk init`은 필요 없다. `-g` 없이 실행하면 훅은 등록하지 않고 `CLAUDE.md`를 수정하며 필터 템플릿만 만든다 [M1].
3. **평범한 `rtk hook claude` 등록은 권한 규칙을 뚫는다.** `bypassPermissions`에서 `ask` 규칙과 `--disallowed-tools` 규칙이 훅 없이는 막고 훅이 있으면 실행됐다. 실제 모델로 재현했다 [M4].
4. **재작성은 헤드리스 허용 규칙을 깬다.** `--allowed-tools 'Bash(git status)'`는 재작성 뒤 `rtk git status`로 판정돼 거부됐다 [M4]. 스케줄 수집 작업에 직접 해당한다.
5. **rtk의 큰 절감률은 실제 컨텍스트 절감과 다르다.** Claude Code는 30,000자 초과 Bash 출력을 파일로 빼고 약 2,300자만 전달한다. `git diff` 471KB→34KB는 양쪽 다 이 경계를 넘어 실질 변화가 없다 [M5, M6].
6. **"trailing"은 Trail-Code로 판단되지만 사용자 확인은 없다** (§2).
7. **trail은 코드가 적은 저장소에서 효용이 작다.** `.py`만 인덱싱하고 Markdown·JSON은 무시했다. 한국어 질의는 빈 결과였고 한국어 학습 노트는 "이유가 없다"며 거부됐다 [M7].
8. **`trail init` 없이 쓰는 경로가 있다.** `.mcp.json` 수동 등록과 `trail build`만 쓰면 저장소 밖 쓰기가 없고, 전역 재기록(이슈 #711)의 발동 조건도 생기지 않는다 [M8].
9. **한글은 토큰 경계를 무력화한다.** 한글 45,000자는 실제 47,434토큰인데 기본 한도 25,000토큰에 걸리지 않고 인라인으로 들어왔다 [M9].
10. **MCP 응답은 형식보다 구조가 지배한다.** id 우선 구조는 42,633토큰을 3,498토큰으로 줄였다(-91.8%). TOON은 평면 한글 -50.6%, 그래프형 -6.3%, 중첩 -1.1%였다(모두 압축 JSON 대비) [M10, M11].
11. **`structuredContent`를 보내면 Claude Code는 텍스트 블록을 버린다.** 압축 텍스트를 넣어도 모델은 구조화 내용만 본다 [M9].
12. **저장은 내용 주소 저장이 지배적이다.** 14일 스냅숏(시뮬레이션) 평문 675MB가 파일별 zstd 105MB, 객체 CAS+zstd 10.3MB가 됐다. `git gc`만으로도 소형 문서 93MB가 2.36MB로, 직접 만든 델타 체인(2.35MB)과 같은 수준이었다 [M14].
13. **변동 페이지는 예외다.** 유튜브 시청 페이지는 수 초 간격 재수집에도 바이트가 달랐고, 객체 CAS는 0%, CDC는 오히려 전체 zstd보다 커졌다 [M15].

## 2. "trailing"의 정체

판단: `~/.local/bin/trail`(trailhq/Trail-Code, 내부 이름 graft)이다. 근거는 정황이며 사용자가 직접 확인한 것은 아니다.

- `~/.claude/history.jsonl`에서 사용자는 순서대로 "graft나 rtk 같은 도구 효용성 검토해줘.", "현재 워크트리 대상으로, trailhq/Trail-Code 및 rtk 세팅해줘.", 그리고 "rtk 및 trailing을 통해 토큰과 데이터 압축을 통해"라고 썼다. "trailing"은 기록 전체에서 이 1회뿐이다 [M0].
- `trailing`이라는 실행 파일은 없다. `~/.local/bin`에는 `claude orca-ide pixel-wt rtk trail`만 있었다 [M0]. pixel-wt는 2026-11-05에 제거됐다.
- Trail-Code README는 "Trail-code는 graft의 새 이름"이라고 밝힌다 [S13].

## 3. 과거 세션 회수 결과

| 출처 세션 | 내용 | 이 보고서에서의 처리 |
|---|---|---|
| `-tmp-claude-setup/ca40f4f0` (05:43Z) | "graft나 rtk 효용성 검토". 웹 조사만, 실행 측정 없음. 결론은 설치 보류, Trail은 큰 저장소에서 시험 | 수치는 재확인 |
| `sagae-claude-plugins/01842778`, `wf_40bcafc9-1ed` | "Trail-Code 및 rtk 세팅". rtk-oss 1.1.0, Trail-Code 0.28.1 설치, 텔레메트리 끔, 연결은 안 함 | 재사용 |
| 같은 세션, `wf_7fe34f38-d94` | 프로젝트 단위 연결 조사(동시 진행). 소스 정독과 가짜 Messages API 시나리오 | 재사용. 핵심 시나리오는 실제 모델로 재현 |

과거 기록 중 이번 실측으로 정정된 내용은 다음과 같다.

| 과거 기록 | 정정 |
|---|---|
| "자동 훅 공식 경로는 `rtk init -g`뿐" | 손 등록이 동작한다 [M3] |
| "`settings.local.json`은 메인 worktree에만 적용" | 문서상 worktree는 메인 체크아웃의 파일을 쓰며(v2.1.211+) [S17], 실측도 일치 [M3] |
| "Trail을 `.mcp.json`으로만 연결하는 방식은 미시험" | 쓰기 없음을 확인. 단 그래프 빌드 전에는 도구 0개 [M8] |
| `rtk --help`의 "curl: JSON schema output" | 1.1.0 JSON은 패스스루(0%) [M5] |
| 훅 7개(Trail) | 프로젝트 파일 기준 9개 명령·7개 이벤트 (`wf_7fe34f38` 정정) |

## 4. rtk

### 4.1 상태와 판본

- 최신 안정판 v1.1.0(2026-10-25). dev 프리릴리스가 거의 매일 나오며 최신은 `dev-1.2.0-rc.591`(2026-10-30). 저장소 스타 85,094, 열린 이슈 1,644, 기본 브랜치 `develop` [S1, S2].
- 세 가지 내려받기가 있다 [S4].

| 판 | 라이선스 | 내용 |
|---|---|---|
| `rtk-oss` (설치본) | Apache-2.0 | 훅 코어, 명령 필터. 엔진 없음 |
| `rtk` | Apache-2.0 + BUSL-1.1 | 위 + 엔진(`rtk pipeline`, PostToolUse 압축, `pipeline.toml`) |
| `rtk-proxy` | BUSL-1.1 | API 트래픽 프록시 데몬. 어느 `rtk`에도 미포함 |

엔진이 없는 설치본에서는 `rtk pipeline`이 없고 `pipeline.toml`도 무시된다 [S4]. 엔진의 `toon`, `web-md`, `md-slim` 같은 메서드 [S8b]는 이 판에서 쓸 수 없다.

### 4.2 전역 없이 저장소 범위로 훅 걸기

`rtk init`의 동작(가짜 HOME, 네트워크 없는 네임스페이스) [M1]:

| 명령 | 결과 |
|---|---|
| `rtk init` | `CLAUDE.md`에 블록 추가, `.rtk/filters.toml` 생성. 훅 없음. 그런데 출력은 `hooks: registered globally` |
| `rtk init --hook-only --no-patch` | 경고 후 파일 변화 없음(`--hook-only only makes sense with --global`) |

`hooks: registered globally` 문구는 훅이 없는데도 출력됐다. 소스 `hook_check.rs`의 "Claude Code가 설치되지 않았으면 Ok" 분기 때문에 `.claude`가 없는 가짜 HOME에서 나온 것으로 보이며, 실제 HOME에서는 재현하지 않았다.

이 저장소의 `CLAUDE.md`는 "사용자 승인 없이 변경 금지"이므로 `rtk init`은 그 조건과 충돌한다. 손 등록은 다음 한 블록이다 [M3].

```json
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"rtk hook claude","timeout":10}]}]}}
```

훅 계약 [M2]: stdin은 PreToolUse JSON, 재작성 시 stdout은 다음과 같고, 재작성이 없으면 stdout이 비고 종료 코드 0이다. `permissionDecision: "allow"`는 설정 파일의 허용 규칙이 전체를 덮을 때만 붙는다.

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecisionReason":"RTK auto-rewrite","updatedInput":{"command":"rtk git status"}}}
```

| 명령 예 | 재작성 |
|---|---|
| `git status`, `git log`, `ls -la`, `rg`, `grep -rn`, `find`, `wc -l`, `gh api`, `curl`, `jq`, `uv run`, `pytest` | 예 |
| `cat a.txt` → `rtk read a.txt`, `head -20 a.txt` → `rtk read a.txt --head-lines 20` | 예 |
| `git status && ls`, `git status \| head -3`, `FOO=1 git status`, `cd /tmp && git status` | 예 (각 세그먼트) |
| `python3 x.py`, `sed -n ...`, `node x.js`, `sqlite3`, `duckdb`, `yt-dlp` | 아니오 |
| `git log > out.txt`, `echo $(git status)`, `for ...; do ...; done` | 아니오 |

### 4.3 훅 적용 범위 실측

모두 실제 `claude -p`(모델 Haiku), 임시 git 저장소, `--setting-sources project,local`로 시험했다 [M3]. 문서도 "서브에이전트의 도구 호출은 메인과 같은 훅을 발동하고 입력에 `agent_id`, `agent_type`이 실린다"고 명시한다 [S16].

| 경로 | 설정 위치 | 결과 |
|---|---|---|
| `claude -p` 메인 | `.claude/settings.json` | 발동. `git status` 재작성 |
| Agent 도구 서브에이전트 | 동일 | 발동. `agent_type: general-purpose` |
| Workflow 도구 에이전트 | 동일 | 발동. `agent_type: workflow-subagent` |
| `isolation: worktree` 서브에이전트 | 커밋된 `.claude/settings.json` | 발동. `git`은 재작성 안 됨(원본 출력) |
| 새 worktree에서 `claude -p` | 커밋된 `.claude/settings.json` | 발동 |
| 새 worktree에서 `claude -p` | 메인 체크아웃의 `settings.local.json`만 존재 | 발동. 파일을 치우면 미발동(대조군) |
| 훅 명령 실행 파일 없음 | 임의 | Bash는 원본대로 실행, 세션 안 막힘 |

보조 증거: 이 머신의 워크플로우 에이전트 transcript 18개에 `PreToolUse:Bash` `hook_success`가 352건 기록돼 있다(사용자 수준 Orca 훅) [M3].

`.claude/worktrees/` 아래에서 `git`을 건너뛰는 것은 `wf_7fe34f38`이 소스(`decision.rs:277-303`)로 확인했고, 위 worktree 격리 실측과 일치한다.

### 4.4 권한 규칙과의 상호작용

문서: "Claude Code는 권한 규칙을 Claude가 보낸 입력이 아니라 훅이 반환한 입력에 대해 평가한다" [S16].

rtk 내부 문서는 규칙이 없는 기본 판정에서 Claude Code 훅이 `permissionDecision: "ask"`를 보낸다고 적었지만 [S10], 실제 출력에는 이 필드가 없었다 [M2].

실측 [M4](실제 모델, Haiku):

| 시나리오 | 훅 없음 | 훅 있음 |
|---|---|---|
| 프로젝트 `ask: Bash(git log:*)`, `bypassPermissions` | 차단 | **실행됨** |
| `--disallowed-tools 'Bash(git log:*)'`, `bypassPermissions` | 차단 | **실행됨** |
| `--disallowed-tools 'Bash(*git log*)'`, `bypassPermissions` | - | 차단(`rtk git log`까지 일치) |
| 프로젝트 `deny: Bash(git status)`, `bypassPermissions` | - | 차단(재작성 안 함) |
| `--allowed-tools 'Bash(git status)'`, default, `--permission-prompts none` | - | **거부**(거부 기록의 명령이 `rtk git status`) |
| `--allowed-tools 'Bash(rtk git status)'`, 동일 | - | 실행 |
| 프로젝트 `allow: Bash(git status)`, default, `--permission-prompts none` | - | 실행(rtk가 `allow` 출력) |
| 프로젝트 `allow`, `dontAsk` | - | 실행 |

`wf_7fe34f38`의 추가 결과(재사용, 가짜 Messages API 사용) [R1]:

- rtk는 Claude Code 설정 파일 4개만 읽는다. `--settings`, `--disallowedTools`, 관리형 설정의 규칙은 보지 못한다.
- 재작성 대상에 변경 명령이 포함된다: `git push/commit`, `gh pr merge`, `ssh`, `kubectl apply`, `docker run` 등.
- cwd가 자체 `.claude`를 가진 하위 폴더로 옮겨지면 루트의 deny가 보이지 않아 우회된다.
- 와일드카드 없는 규칙 `Bash(git push)`를 rtk는 접두사로 해석해 Claude Code보다 넓게 허용한다.
- 제외는 `[hooks] exclude_commands`뿐이고 프로젝트 설정이 없다. 훅에 `XDG_CONFIG_HOME`을 지정하는 우회는 파일 누락·TOML 오류 시 조용히 무효가 된다.
- 훅의 `if` 필드는 복합 명령을 막지 못한다.
- 허용 목록 래퍼(단일 명령 `git status/diff/log/show`, `ls`, `grep`, `rg`, `tree`만 통과, `bypassPermissions`일 때만, SessionStart로 경고·텔레메트리 스위치 설정) 후보가 위 우회를 모두 막았다. 후보 파일은 다른 세션 스크래치패드에 있어 사라질 수 있다: `/tmp/claude-1000/-home-sagae-sagae-claude-plugins/01842778-1730-486e-854c-25be5911f20a/scratchpad/rtk-mech/candidate/`

### 4.5 출력 크기 실측

표본은 Trail-Code 저장소 얕은 클론, 네트워크 명령은 실제 호출이다. 종료 코드는 전 항목 동일했다 [M5].

"모델이 받는 양"은 Claude Code가 30,000자 초과 시 약 2,300자만 전달하는 동작 [S18, M6]을 반영한 값이다. 2,326은 같은 동작의 실측값을 대표값으로 쓴 것이다.

| 명령 | 원본(B) | rtk(B) | 바이트 절감 | 모델이 받는 양 (원본→rtk) |
|---|---:|---:|---:|---|
| `git log -n 30` | 29,643 | 7,979 | 73.1% | 29,643 → 7,979 |
| `git log --oneline -n 50` | 3,644 | 3,644 | 0% | 동일 |
| `git show --stat HEAD` | 694 | 694 | 0% | 동일 |
| `git diff HEAD~10 HEAD` | 471,446 | 33,971 | 92.8% | 2,326 → 2,326 |
| `ls -la src` | 1,883 | 517 | 72.5% | 1,883 → 517 |
| `find src -name "*.ts"` | 8,203 | 669 | 91.8% | 8,203 → 669 (310개 숨김) |
| `rg -n import src` | 242,837 | 16,274 | 93.3% | 2,326 → 16,274 (증가) |
| `grep -rn "export function" src` | 169,947 | 18,590 | 89.1% | 2,326 → 18,590 (증가) |
| `cat README.md` (61KB) | 61,308 | 61,308 | 0% | 동일 |
| `cat src/cli.ts` | 143,355 | 143,355 | 0% | 동일 |
| `cat package-lock.json` | 48,199 | 48,199 | 0% | 동일 |
| `head -50 README.md` | 3,581 | 3,581 | 0% | 동일 |
| `curl` GitHub releases JSON | 257,798 | 257,798 | 0% | 동일 |
| `curl` 유튜브 자동완성 JSON | 335 | 336 | -0.3% | 동일 |
| `gh api .../issues?per_page=30` | 141,739 | 141,739 | 0% | 동일 |
| `gh issue list -L 30` | 5,184 | 1,565 | 69.8% | 5,184 → 1,565 (10건 숨김) |
| `gh pr list -L 30` | 4,039 | 1,786 | 55.8% | 4,039 → 1,786 (10건 숨김) |
| `gh release view` | 8,876 | 8,876 | 0% | 동일 |

`rtk`가 큰 `rg` 결과를 늘린 것은 정보량 차이다. 원본 쪽은 2,000자 미리보기와 파일 경로만 받고, rtk 쪽은 파일별로 묶인 일부 매치를 받는다.

보고 수치의 주의점:

- `rtk gain`은 "Excluded: 8 oversized outputs (input past the ~30k-char agent cap)"라며 큰 출력을 스스로 제외한다 [M5].
- `rtk read --head-lines 50`은 `history.db`에 94.2% 절감으로 기록됐으나 `head -50` 대비 바이트가 동일하다. 파일 전체를 입력으로 잡은 결과다 [M5].
- `rtk gain`의 토큰은 `bytes/4` 추정이고 토크나이저가 없다 [S5]. 한글에서는 이 추정이 크게 어긋난다(§7.4).

### 4.6 손실 형태와 복구

| 대상 | 손실 | 복구 |
|---|---|---|
| `git diff` | 긴 hunk 절단, 헤더 제거 | `rtk git diff --no-compact` |
| `rg`/`grep` | 파일당 25, 전체 약 200건, 긴 줄 절단 | `rtk recall <hash>` |
| `find` | 경로 축약, 목록 생략 | `rtk recall <hash>` |
| `git log` | 본문 3줄 초과분 `[+N lines omitted]` | 없음 [R1]. `git log --format=%B`는 온전 |
| `gh issue/pr list` | 일부 행 숨김 | `rtk recall <hash>` |
| `ls -la` | 소유자, 권한, 시각 제거 | 안내 없음 [R1]. `RTK_DISABLED=1 ls -la` |
| `find . -maxdepth 1` | 디렉터리 항목이 사라짐 | 안내 없음 [R1] |

실패 보존 실측 [M5b]: 55개 테스트 중 5개 실패에서 `rtk pytest -q`는 1,880B→802B, 실패 5건의 위치와 메시지를 유지했고 종료 코드 1을 보존했다.

**`rtk uv run` 데이터 손실** [M5c, S12]: 스크립트가 0이 아닌 코드로 끝나면 stdout이 사라진다. 실측에서 원본 stdout 1,059B가 rtk에서는 65B(`warning: rate limited`와 복구 힌트)가 됐고 종료 코드 3은 유지됐다. 전체는 `rtk recall <hash>`로 복구된다. rtk 이슈 #4860은 Windows에서 보고됐고 이번에 Linux에서도 재현했다. 2026-10-31 현재 열림 상태다.

모델은 자기가 낸 원본 명령만 보므로 출력이 줄었다는 사실을 알 수 없다 [R1].

`rtk recall` 동작 [S3, M5b]:

- 기본 모드는 `sqlite`, 위치 `~/.local/share/rtk/recall.db`(권한 0600), 사용자당 1개다.
- 한도: 200개, 30일, 항목당 10MiB. gzip 무손실 저장.
- 끄는 방법: `RTK_RECALL=0`(명령 단위), `rtk config recall disabled`(사용자 설정).
- 끄면 힌트에 복구 경로가 없어진다 [R1].

### 4.7 TOML 필터

실측 [M12]:

- `.rtk/filters.toml`은 신뢰 전에 적용되지 않는다. 신뢰 전 `rtk rewrite 'mycollect --all'`은 종료 코드 1(재작성 없음).
- `rtk trust -y` 후 재작성된다. 원본 966B가 `RESULT rows=42`와 복구 힌트로 줄고 종료 코드 7이 보존됐다.
- 신뢰 기록은 저장소가 아니라 `~/.local/share/rtk/trusted_filters.json`에 절대 경로와 SHA-256으로 남는다. 파일을 고치면 신뢰가 풀린다 [S3, M12].
- 하위 폴더에서는 적용되지 않았다. `wf_7fe34f38`은 worktree처럼 경로가 달라져도 조용히 멈춘다고 보고했다 [R1].
- `rtk verify --filter <이름>`이 인라인 테스트를 돌린다(1/1 통과) [M12].
- 필드: `match_command`, `strip_lines_matching`, `keep_lines_matching`, `replace`, `match_output`, `max_lines`, `tail_lines`, `truncate_lines_at`, `on_empty` 등 [S11].

### 4.8 `rtk llm-proxy`

- 설치되어 있지 않다. `rtk llm-proxy setup`은 `rtk-proxy not found`를 출력한다 [M1b].
- `rtk-proxy-x86_64-unknown-linux-musl.tar.gz`가 v1.1.0 릴리스 자산에 있다 [S2].
- 문서: 프록시는 Claude Code와 `api.anthropic.com` 사이의 로컬 데몬이고, `ANTHROPIC_BASE_URL` 또는 `rtk claude`로 연결한다. 정규화(ansi, progress, dedup)는 기본, CCR(`rtk_retrieve`)은 규칙을 지정해야 켜진다 [S7, S8].
- 제약: 프록시 규칙은 사용자 파이프라인에만 두고, 프로젝트의 `.rtk/`는 읽지 않는다. `Read` 결과는 다시 쓰지 않는다. 캐시 안정성이 필요한 메서드만 쓸 수 있다 [S8].
- 실측하지 않았다. 사용자의 인증 정보가 제3자 데몬을 지나가기 때문이다. 구독 OAuth 동작은 문서에서 찾지 못했다.

### 4.9 텔레메트리와 로컬 저장

- 기본 꺼짐, 옵트인. `rtk init`이 묻고 기본값은 no [S9]. 이 머신은 `consent: no`, `enabled: no` [M1b].
- 켜면 하루 1회 익명 ping(장치 해시, 버전, 명령 수, 절감률 등)을 보낸다. 명령 내용과 파일 경로는 보내지 않는다고 문서가 명시한다 [S9].
- `RTK_TELEMETRY_DISABLED=1`은 설정과 무관하게 막는다 [S3].
- 네트워크를 쓰지 않는 대신 로컬 기록이 있다. `history.db`는 훅에 들어온 명령을 원문으로 저장하며, `[tracking] enabled=false`로도 멈추지 않고 가짜 Authorization 헤더까지 기록됐다. `recall.db`에는 마스킹이 없다 [R1].
- 프로젝트 훅만 쓰면 `[rtk] /!\ No hook installed — run rtk init -g ...`가 24시간에 한 번 stderr로 나와 도구 결과에 섞인다 [M5c]. `RTK_SUPPRESS_HOOK_WARNING=1`로 막힌다 [S3, M5c].

### 4.10 이 사용자의 실제 작업에서 rtk가 닿는 범위

도구 결과 글자 수 집계 [M6b]. Bash 안에는 rtk가 다루지 않는 명령도 포함된다.

| 집합 | Bash | Read | WebFetch | WebSearch | MCP |
|---|---:|---:|---:|---:|---:|
| 지식 저장소 워크플로우 에이전트(8개, 336만 자) | 54.8% | 25.2% | 15.4% | 4.4% | 0% |
| 플러그인 저장소 워크플로우 에이전트(10개, 518만 자) | 42.1% | 46.4% | 10.2% | 0% | 0.4% |
| 메인 세션 전체(18개, 198만 자) | 41.9% | 6.6% | 39.4% | 1.9% | 4.1% |

`rtk discover --all --since 30` [M6c]: 43개 세션, Bash 2,253건 중 543건이 대상이고 "약 343.9K 토큰 절감 가능"으로 표시됐다. 다만 그중 `cat`(106.3K), `gh api`(26.9K), `curl`(2.4K) 합 135.6K(39.4%)는 §4.5 실측에서 0%였다.

## 5. trail (Trail-Code)

### 5.1 상태

- npm `@trailhq/trail-code` 0.28.1(최종 수정 2026-10-30), MIT. GitHub Releases는 없고 npm이 배포 경로다. 저장소 스타 10,965, 열린 이슈 277, 마지막 푸시 2026-10-30, 2026-07-03 생성 [S13, S14].
- `~/.local/bin/trail`은 심볼릭 링크가 아니라 환경변수(`DO_NOT_TRACK`, `TRAIL_NO_FETCH`, `TRAIL_NO_LOOK_BACK`, `GRAFT_NO_IGNORE`)를 넣는 래퍼 스크립트다 [M0].
- 벤더는 "도구 호출 46% 감소, 시간 60% 감소, 비캐시 입력 42% 감소"를 주장한다 [S13]. 과거 세션 검토는 저장소 2개, 162회 벤치마크라고 기록했다.

### 5.2 명령별 동작 (가짜 HOME, 네트워크 없음) [M7]

| 명령 | 동작 | 저장소 밖 쓰기 |
|---|---|---|
| `trail status` | `code map ✗ not built` 표시. 쓰기 없음 | 없음 |
| `trail build` | 인덱스 생성, `.gitignore`에 `/graft/` 추가(없으면 파일 생성). 0.34초, RSS 약 115MB | 없음 |
| `trail ask/grep/skeleton/callers/map` | 질의. 각 0.3초대 | 없음 |
| `trail note` | `.trail/`을 만들고 학습 저장. 이후 맵 위치가 `.trail/cache/`로 바뀜 | **`~/.trail/README.md`, `repos/index.json`, `repos/known.json`** |
| `trail check --base <ref>` | 변경을 학습과 대조 | 없음 |
| `trail skills --json` | 기본 `offers.on: true`, 세션당 1회, 주당 3회 제안 | 없음 |
| `trail init` (제한 옵션) | §5.5 | `~/.trail/` 여러 파일 |

`.trail/` 구조 [M7]:

```text
repo/
├── .trail/
│   ├── .gitignore        (statusline.cjs, cache/)
│   ├── README.md
│   ├── cache/            맵. 커밋 제외
│   ├── hook.cjs          init 시에만
│   ├── statusline.cjs    init 시에만
│   └── learnings/        YYYY-MM-DD-<slug>-<author>.md (커밋 대상)
└── graft/                학습 전 맵 위치. .gitignore
~/.trail/                 개인 학습, repos/, install.json
```

학습 파일은 YAML 머리말(`title`, `author`, `date`, `branch`, `id`, `scope`, `status`, `src`, `touches`)과 `## Decided`, `## Tried and ruled out`, `## Watch out` 본문으로 된 Markdown이다.

### 5.3 코드가 적은 데이터 저장소에서의 효용

저장소 구성: Markdown 8개, JSON 40개, Python 1개 [M7].

| 시험 | 결과 |
|---|---|
| `trail build` | `parsed: 1 of 1 files`, 노드 3개. Markdown·JSON은 대상 아님 |
| `trail grep PreToolUse` (Markdown에만 존재) | `no hits` |
| `trail ask "fetch suggest youtube autocomplete"` | `fetch_suggest` 1순위 |
| `trail ask "유튜브 키워드맵 조사"` | 빈 결과 |
| `trail ask "훅 위치"` (같은 제목의 학습 존재) | 빈 결과 |
| `trail note` 한국어, 코드 언급 없음 | 거부: 파일/함수를 안 짚음, "이유" 없음 |
| `trail note` 한국어, `--touches`, "때문이다" 포함 | 거부: "No line says why" |
| `trail note` 영어, because 포함 | 저장 |
| `trail note --anyway` 한국어 | 저장 |
| `trail check --base HEAD~1` (학습이 짚은 파일 변경) | `no learning bears on this change` |
| 절감 표시 | 1개 파일 저장소에서 16~54토큰(도구 자체 추정) |

한글 처리: 과거 조사의 `ask`가 ASCII만 처리한다는 이슈 기록, `wf_7fe34f38`의 "순수 한국어 프롬프트는 아무것도 반환하지 않음" [R1], 위 실측이 서로 일치한다.

도구 출력이 에이전트에게 행동을 지시한다. 질의 출력에는 `At the end of your reply, tell the user the total trail tokens saved this turn`이, `trail note` 뒤에는 `Close your reply with one line, word for word...`가 붙는다 [M7]. 이 문구도 토큰을 쓰고 응답 내용에 영향을 준다.

### 5.4 외부 전송, LLM 키, 텔레메트리

- **LLM 키**: 불필요. 지도, 훅, 학습, `trail check`는 키 없이 동작하고, `trail build --deep`만 키를 쓴다 [S13].
- **`trail init`의 회고**: 사용자의 Claude Code 로그인으로 과거 세션 메시지와 최근 병합 PR 50개의 리뷰 댓글을 읽어 Anthropic으로 보낸다(Trail로는 안 간다고 명시) [S13]. 사용량을 소모한다.
- **메모리 복사**: 비대화형 `trail init`은 Claude 메모리 노트를 `.trail/learnings/`로 묻지 않고 복사하며, `TRAIL_NO_LOOK_BACK=1`로 막히지 않는다 [R1].
- **텔레메트리**: 기본 켜짐, `DO_NOT_TRACK=1` 또는 `trail telemetry disable`로 끈다. `DO_NOT_TRACK`은 npm 버전 확인도 끈다 [S13, S15]. 전송 대상 `events.nanonets.com`이 코드에 있다 [M0]. 이 머신은 래퍼의 `DO_NOT_TRACK` 때문에 꺼져 있다 [M0].
- **워크스페이스**: `team.trailhq.com` 연결은 `trail login`, `--connect`를 쓸 때만이다. 연결하면 커밋된 학습이 전송된다 [S13].
- **`gh` 사용**: 프로젝트 훅이 설치되면 세션 시작 시 `git fetch`, `gh pr list`를 돌릴 수 있고, `.trail/hook.cjs`는 래퍼를 거치지 않아 래퍼의 환경변수가 적용되지 않는다 [R1].

### 5.5 전역 파일을 건드리는가

| 경로 | `~/.claude` | `~/.trail` | 비고 |
|---|---|---|---|
| `trail build`, `ask`, `grep` | 없음 | 없음 | `.gitignore` 수정 [M7] |
| `trail note` | 없음 | 있음 | [M7] |
| `init --no-statusline --no-global --no-agents --no-build` | 없음 [M7b] | 있음 | 저장소에 훅 7개 이벤트, Bash 허용 규칙 5개 추가 |
| `init` 기본 | **있음** | 있음 | `~/.claude/settings.json`, `helpers/graft-hooks.cjs`, 전역 스킬 [R1] |
| 제한 옵션으로 init 후 새 worktree/clone | **있음** | 있음 | 옵션 기록이 커밋되지 않아 기본값으로 재적용 [R1, S14b] |

- `--dry-run`은 `--no-global`을 줘도 `~/.claude/...` 쓰기를 나열했지만 실제 실행은 쓰지 않았다. 미리보기와 실제가 다르다 [M7b].
- 허용 규칙: `Bash(trail:*)`, `Bash(graft:*)`, `Bash(npx graft:*)`, `Bash(graft-dev:*)`, `Bash(node dist/cli.js:*)`. `trail:*`에는 버전 고정을 무시하는 `trail upgrade`가 포함된다 [M7b, R1].
- 문서는 `trail init`이 `CLAUDE.md`를 건드리지 않는다고 명시한다 [S13].

### 5.6 `trail init` 없이 쓰는 경로

| 경로 | 결과 |
|---|---|
| `.mcp.json` 수동 등록, 맵 없음 | 도구 0개(`tools/list` 빈 배열). `tools/call`은 응답하나 결과 없음. 쓰기 없음 [M8] |
| 위 + `trail build` | 도구 6개(`tools/list` 3,515B), 쓰기 없음. `.gitignore`만 변경 [M8] |
| 위를 새 worktree에서 시작 | 쓰기 없음. 맵이 없어 도구 0개 [M8] |

`graft/`는 커밋되지 않으므로 worktree마다 `trail build`가 필요하다. 자가 복구 코드는 `hosts.length === 0`이면 멈추는데(`upkeep.js`), 연결 흔적이 없으면 이 조건에 해당한다. `wf_7fe34f38`도 같은 결론이며, MCP 대신 `UserPromptSubmit` + `PostToolUse` 두 훅을 쓰는 후보를 실행 검증했다 [R1].

## 6. Claude Code의 출력 경계값

| 경계 | 기본값 | 초과 시 | 출처 |
|---|---|---|---|
| Bash 인라인 | 약 30,000자. `BASH_MAX_OUTPUT_LENGTH` 최대 150,000, `bashOutputMaxChars` 최대 128,000 | 파일 저장, 앞 2,000자 미리보기와 경로 | [S18, S19]. 실측 251,670B→2,326자, 27,000B→26,999자 [M6] |
| MCP 글자 수 | 50,000자 | 파일 저장. `MAX_MCP_OUTPUT_TOKENS`로 바뀌지 않음 | [S20]. 실측 40,000자 인라인, 60,000자→2,354자 [M9] |
| MCP 토큰 경고 | 10,000토큰, 고정 | 경고 | [S20] |
| MCP 토큰 한도 | 25,000토큰, `MAX_MCP_OUTPUT_TOKENS` | 파일 저장 | [S20]. 한글 예외는 아래 |
| 도구별 상향 | `_meta["anthropic/maxResultSizeChars"]`, 최대 500,000자 | | [S20]. 실측 120,000자 인라인 [M9] |
| MCP 오류 | 약 11,000자 | 앞뒤 5,000자만 유지 | [S20] |
| HTTP/SSE MCP 응답 | 16 MiB | 요청 실패 | [S20] |
| MCP 설명/지침 | 4,096자, tool search 로드 시 16,384자 | 절단 | [S20] |
| Read | 호출당 25,000토큰, 전체 읽기는 256KB까지 | 나눠 읽기 | [S18, S19] |
| WebFetch | 페이지당 100,000자, 15분 캐시 | 이어 읽기 | [S18] |

**WebFetch는 설계상 손실이 있다.** 가져온 페이지를 별도 모델 호출로 프롬프트에 맞춰 추출하고, Claude는 그 결과만 받는다. 원문이 필요하면 `curl`을 쓰라고 문서가 안내한다 [S18]. 수집 원문 보존 목적에는 맞지 않는다.

**한글 토큰 경계** [M9]: 같은 45,000자가 영어는 18,002토큰, 한글은 47,434토큰이었다(글자당 약 1.05토큰). 한글 45,000자는 기본 설정에서 파일로 빠지지 않고 인라인으로 들어왔고 `MAX_MCP_OUTPUT_TOKENS=80000`에서도 같았다. 문서의 "25,000토큰 초과 시 파일 저장"이 이 경우 작동하지 않은 셈이다. 내부 판정이 실제 토크나이저가 아니라 글자 수 기반 추정이라는 설명이 맞아 보이지만 이는 추론이다. 한글 응답은 글자 수 경계 50,000자까지, 즉 약 52,000토큰까지 한 번에 들어올 수 있다.

**도구 지연 로딩** [S20, M9]: tool search가 기본이라 MCP 도구는 이름만 먼저 올라오고, 첫 사용 때 `ToolSearch` 왕복이 1회 생긴다. 모든 프로브에서 이 호출이 관측됐다.

## 7. 응답 토큰 절감 기법

### 7.1 MCP 응답 설계

제1차 지침(주장은 모두 Anthropic):

- 도구는 높은 신호의 정보만 돌려주고, UUID나 MIME 같은 저수준 식별자를 피하며, 사람이 읽을 이름을 쓰라고 주장한다 [S22].
- `response_format`(concise/detailed) 예시에서 206토큰 대 72토큰(약 1/3)을 제시한다 [S22].
- 페이지네이션, 범위 선택, 필터링, 절단을 합리적 기본값으로 조합하라고 주장한다 [S22].
- 오류 메시지는 다음 행동을 알려 주도록 쓰라고 주장한다 [S22].

id 우선 구조 실측 [M10]. GitHub issue 20건, 압축 JSON, 실제 Claude 토큰:

| 응답 형태 | 토큰 |
|---|---:|
| 원본 전체 20건 | 42,633 |
| 필드 정리, 본문 포함 20건 | 15,276 |
| 요약 20건(id, title, state, updated, 앞 120자) | 2,308 |
| id + 제목 20건 | 690 |
| 상세 1건, 필드 정리 | 427, 763 |
| 상세 1건, 원본 | 1,715, 2,134 |

조합 비교: 원본 20건 42,633 대비 요약 20건 + 정리 상세 2건은 3,498토큰(-91.8%), 요약 20건 + 원본 상세 2건은 6,157토큰(-85.6%)이다. 위 수치는 응답 1회분이고, 도구 결과는 이후 매 턴 캐시 읽기로 다시 과금된다 [S21, S26].

Claude Code의 MCP 동작 실측 [M9]:

| 항목 | 결과 |
|---|---|
| `content` 텍스트와 `structuredContent`를 함께 반환 | **모델은 `structuredContent`만 받음.** 텍스트 블록은 전달되지 않음 |
| `resource_link` | 모델은 `[Resource link: doc1] probe://doc/1 (sample doc)` 48자를 받고, `ReadMcpResourceTool`로 본문을 읽음 |
| 연결 순서 | `server/discover` 후 미지원이면 `initialize`(protocolVersion `2025-11-25`)로 폴백 |

MCP 사양 초안은 구조화 결과를 낼 때 하위 호환용으로 직렬화 JSON을 텍스트 블록에도 넣으라고 권고한다(SHOULD) [S24]. 위 실측대로면 Claude Code에서는 두 벌이 겹쳐 과금되지 않는 대신, 압축 텍스트를 넣어도 무시된다. 이 동작은 문서에서 찾지 못했고 2.1.314 실측 결과다.

MCP 2026-07-28 사양(최신 안정판) [S25]: `tools/list`, `prompts/list`, `resources/list`, `resources/read` 응답이 `ttlMs`, `cacheScope`를 싣고, 목록은 결정적 순서를 갖는다. 사양 초안은 결정적 순서가 LLM 프롬프트 캐시 적중률을 높인다고 명시한다 [S24]. 프로토콜 세션이 없어져 상태는 명시적 핸들로 주고받는 방식이 안내된다 [S24].

### 7.2 점진적 공개와 code execution

| 기법 | 주장 | 출처 |
|---|---|---|
| Code execution with MCP (2025-11-04) | 도구를 파일로 노출해 필요한 정의만 읽고, 중간 결과를 실행 환경에서 걸러 150,000토큰→2,000토큰(98.7%). 안전한 실행 환경이 필요하다고 경고 | Anthropic [S27] |
| Tool Search Tool (2025-11-24) | 77K→8.7K, 85% 감소. 도구 10개 미만이면 이득이 작음 | Anthropic [S28] |
| Programmatic Tool Calling | 43,588→27,297, 37% 감소. 단일 호출이나 중간 결과를 봐야 할 때는 이득이 작음 | Anthropic [S28] |
| Code Mode (2026-02-20) | `search()`, `execute()` 두 도구로 1.17M→약 1,000토큰, 99.9% 감소. V8 격리 실행 | Cloudflare [S29] |

두 수치는 서로 다른 벤치마크이므로 직접 비교할 수 없다. 이 환경의 Bash 도구가 사실상 코드 실행 경로라는 점은 §6의 "결과를 파일로 저장하고 필요한 만큼 읽는" 동작과 맞닿는다.

훅 기반 압축: `PostToolUse`의 `updatedToolOutput`은 모든 도구의 출력을 바꿀 수 있고, 내장 도구는 출력 스키마에 맞아야 한다. MCP 출력은 스키마 검증 없이 통과한다 [S16]. rtk 전체판의 `hook.after_tool`이 이 경로이며 Claude Code에서만 동작한다고 문서가 밝힌다 [S6]. 이번 실측에는 포함하지 않았다.

### 7.3 포맷 비교

실제 Claude 입력 토큰. `claude -p`의 `usage`에서 빈 프롬프트 기준값을 뺐다. 왕복 복호화는 4종 모두 일치했다 [M11].

| 포맷 | A 평면 한글 240행 | B 평면 영어 60행 | C 중첩 GitHub 원본 5건 | D 그래프형 40건 |
|---|---:|---:|---:|---:|
| JSON pretty (`indent=2`, `ensure_ascii=False`) | 10,457 | 9,601 | 12,339 | 11,943 |
| `json.dumps()` 기본값 | 15,439 | 8,465 | 11,234 | 9,856 |
| JSON 압축 + `ensure_ascii=True` | 14,720 | 7,986 | 10,840 | 9,295 |
| JSON 압축 | 7,571 | 7,975 | 10,805 | 9,291 |
| YAML | 7,566 | 8,242 | 10,949 | 8,927 |
| TOON 4.4 | 3,741 | 6,184 | 10,691 | 8,705 |
| Markdown 표 | 3,983 | 6,250 | - | - |
| CSV | 3,493 | 5,961 | - | - |
| **TOON ÷ JSON 압축** | **-50.6%** | **-22.5%** | **-1.1%** | **-6.3%** |

- 한글에서 `ensure_ascii=True`(Python `json.dumps` 기본)는 같은 데이터의 토큰을 약 2배로 늘린다(14,720 대 7,571).
- 평면 표에서는 CSV가 TOON보다 6~7% 작고, Markdown 표는 TOON과 비슷하다.
- 벤더 README는 TOON의 약점으로 깊은 중첩, 반균일 배열, 순수 표를 들고, 표에서는 CSV가 더 작다고 인정한다 [S30]. 위 실측과 일치한다.
- 벤더는 244문항 검색 정확도에서 TOON 72.2%(±2.8), JSON 71.4%(±2.8), 토큰 42.6% 감소를 주장한다. 같은 문서는 구간이 겹치면 차이가 통계적으로 의미 없다고 밝히며, 두 값의 구간은 겹친다 [S30].
- 독립 논문(Matveev, arXiv 2603.03306)은 TOON **생성** 과제에서 일반 JSON의 일회성 정확도가 가장 높고, 짧은 문맥에서는 지시문 오버헤드가 TOON의 이득을 줄인다고 보고한다 [S31]. 입력 표현과 출력 생성은 구분이 필요하다.

### 7.4 토크나이저 주의

| 페이로드 | 바이트 | `chars/4` | GPT `o200k` | Claude | Claude÷o200k |
|---|---:|---:|---:|---:|---:|
| A TOON | 7,595 | 930 | 3,037 | 3,741 | 1.23 |
| A JSON 압축 | 15,013 | 2,784 | 4,512 | 7,571 | 1.68 |
| B TOON | 12,782 | 3,193 | 4,757 | 6,184 | 1.30 |
| D JSON 압축 | 17,477 | 4,368 | 5,586 | 9,291 | 1.66 |

- 전 페이로드에서 Claude÷o200k는 1.23~1.68이었다 [M11].
- 벤더 벤치마크는 GPT `o200k_base`로 측정했다 [S30].
- `chars/4`는 한글에서 4배 어긋난다(930 대 3,741). rtk `gain`, trail의 절감 표시, 대부분의 추정이 이 계열이다.
- Haiku 5.5와 Opus 5.5의 토큰 수는 시험한 8개 페이로드에서 정확히 같았다 [M11].
- `POST /v1/messages/count_tokens`가 공식 경로다. 문서는 이 값도 추정이며 실제 입력 토큰과 소폭 다를 수 있고, Claude 4.7 이후 모델은 같은 텍스트에서 이전보다 약 30% 많은 토큰을 낸다고 밝힌다 [S21b]. 이 환경에는 API 키가 없어 `claude -p` usage로 대신했고 기준값 편차는 2토큰이었다.

### 7.5 프롬프트 캐싱에 유리한 구조

API 사실 [S21]:

- 캐시는 접두사 일치이고 순서는 `tools` → `system` → `messages`다.
- 중단점은 최대 4개, 뒤돌아보기는 최대 20위치다.
- 최소 길이는 Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1 등 현행 모델 512토큰이다.

| 모델 | 입력 | 5분 쓰기 | 1시간 쓰기 | 캐시 읽기 | 출력 |
|---|---:|---:|---:|---:|---:|
| Opus 5.5 | $4 | $5 | $8 | $0.20 | $20 |
| Sonnet 5.5 | $2 | $2.50 | $4 | $0.10 | $10 |
| Haiku 5.5 (10만 토큰 이하) | $0.10 | $0.125 | $0.20 | $0.01 | $0.50 |
| Fable 5.1 | $10 | $12.50 | $20 | $0.25 | $50 |

Claude Code 사실 [S26]:

- 요청 층: 시스템 프롬프트(도구 정의) → 프로젝트 맥락(CLAUDE.md, 자동 메모리, 무조건 규칙) → 대화.
- 도구 정의 집합이 바뀌면 전체가 무효가 된다. tool search로 지연된 MCP는 예외로, 첫 요청의 도구 목록을 유지한다.
- `CLAUDE.md` 수정은 세션 중 캐시를 깨지 않지만 반영도 되지 않는다.
- 스킬과 플랜 모드는 대화 메시지로 추가되어 접두사를 유지한다.
- 모델 변경, 대부분의 effort 변경, fast mode 전환, compaction은 무효화 사유다. Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1은 API 키 또는 구독에서 effort 변경 시 캐시를 유지한다.
- TTL: 구독 메인 대화(`-p` 포함)는 1시간, 서브에이전트·워크플로우·팀원은 5분. `promptCacheTtl`, `subagentPromptCacheTtl`로 지정한다(v2.1.242+). API 키는 둘 다 5분.
- 서브에이전트는 자체 프롬프트로 시작해 부모 캐시를 읽지 않는다. fork는 부모를 그대로 물려받아 읽는다.
- 워크플로우 팬아웃은 같은 접두사 에이전트의 첫 요청을 기본 최대 5초 늦춰 첫 에이전트의 캐시를 읽게 한다.
- 캐시 범위는 사실상 한 머신의 한 디렉터리다. 순차 세션은 시작 시 git status 스냅숏이 같을 때만 접두사를 공유한다.
- `--exclude-dynamic-system-prompt-sections`는 머신별 부분을 첫 사용자 메시지로 옮긴다 [S32]. 기본 시스템 프롬프트에만 적용된다.

실측 [M11]: 별개의 `claude -p` 프로세스 두 번이 같은 접두사 637토큰을 공유했다. 첫 호출은 쓰기 637토큰에 $0.000130, 다음 호출은 읽기 637토큰에 $0.0000086이었다.

MCP 사양의 결정적 도구 순서 [S24]와 claude-api 스킬 문서의 "`json.dumps`는 `sort_keys=True`로 고정" 항목 [S21c]은 같은 문제를 다룬다.

### 7.6 외부 실증 (제3자)

| 측정 | 방법 | 결과 | 한계 |
|---|---|---|---|
| Yongkyun, 2026-06-18 [S33] | 자기 세션 614M 토큰 재생(500세션, $926.31) | headroom 2.8%, rtk 0.5%, caveman 0.4%, 합 3.7% | 작성자 본인 코퍼스. rtk는 공표 절감률을 적용한 추정 |
| 같은 글 | 마이크로벤치 | headroom 중앙값 54%, rtk 33~99%, caveman 50% | 이상적 입력 |
| Dasein Code-Compression Bench, 2026-07-04 [S34] | SWE-bench Verified 100건, Sonnet 4.6 | rtk 비용 +13%, 입력 +16%, 54/100. headroom +44%, 58/100. caveman -19%, 58/100 | Dasein이 후원·운영. 기준 행 해결 수는 추출 못 함 |
| 벤더 [S13, S35] | 자체 벤치 | Trail 입력 -42%, context-mode 98% | 벤더 측정 |

같은 글은 네이티브 도구 비중이 커서 rtk가 닿지 못하는 몫이 크다고 설명한다. §4.10 실측의 방향과 같다. 또 도구 결과가 매 턴 캐시 읽기로 다시 지불되므로 초기 절감이 세션 전체에서 커진다고 주장한다 [S33].

## 8. 저장 데이터 압축

### 8.1 소형 문서: zstd 사전

문서별 독립 압축. 80%로 학습, 20% 시험. 값은 원본÷압축 [M13a].

| 말뭉치 (평균 크기, 시험 문서 수) | gzip-6 | zstd-3 | zstd-19 | zstd-3 +16K | zstd-3 +64K | zstd-3 +112K | zstd-19 +112K |
|---|---:|---:|---:|---:|---:|---:|---:|
| GitHub issue JSON (5,645B, 100) | 2.78 | 2.67 | 2.80 | 4.60 | 5.04 | 5.20 | 5.96 |
| 유튜브 자동완성 JSON (370B, 104) | 2.15 | 2.16 | 2.27 | 3.91 | 4.13 | 3.83* | 4.62* |
| 문서 Markdown (52,665B, 14) | 3.36 | 3.28 | 3.76 | 3.41 | 3.49 | 3.51 | 4.25 |
| 문서 HTML (593,846B, 14) | 6.71 | 8.09 | 9.82 | 8.70 | 10.45 | 12.33 | 16.14 |

\* 학습 표본이 작아 사전이 70,974B에서 멈췄다.

- 속도(단일 스레드): zstd-3 압축 101~831MB/s, 해제 794~2,859MB/s. zstd-19 압축 5~9MB/s. 사전 사용 zstd-3 압축 117~692MB/s, 해제 587~2,885MB/s.
- 학습 시간 0.03~1.3초.
- 손익분기: issue JSON은 64KB 사전으로 문서당 약 1,004B를 아껴 약 65건이면 회수된다. 자동완성 JSON은 16KB 사전으로 문서당 약 79B를 아껴 약 207건이면 회수된다.
- 사전 효과는 문서가 작고 구조가 같을수록 크다. Markdown은 거의 없었다.
- 사전과 데이터의 수명은 묶인다. 사전을 잃으면 복호화할 수 없다.
- 문서는 사전 크기 상한으로 약 100KB를 제시한다 [S36].
- `zstandard`의 `precompute_compress(level=3)`는 수준을 고정한다. 첫 측정에서 zstd-19+사전이 zstd-3과 같은 값으로 나와 재측정했다 [M13a].

Python 3.14 표준 라이브러리 `compression.zstd`도 같다 [M13b]: zstd 1.5.7, `train_dict(tr, 65536)` 0.079초, 같은 분할에서 2.67→5.01배, 왕복 일치. 관리형 3.12/3.13에서는 PyPI `zstandard`가 필요하다.

### 8.2 표 형식: Parquet, DuckDB, SQLite

키워드 스냅숏 표 131,040행. 실제 자동완성 477개 시드를 30일로 복제하고 일 5%를 뒤섞었다(시뮬레이션). 반복이 극단적으로 많아 **최선값**에 해당한다 [M13c].

| 형식 | 바이트 | 배율 |
|---|---:|---:|
| JSONL | 24,455,910 | 1 |
| JSONL gzip-6 | 1,790,015 | 13.7 |
| JSONL zstd-3 | 646,319 | 37.8 |
| JSONL zstd-19 | 392,881 | 62.2 |
| Parquet snappy | 261,683 | 93.5 |
| Parquet zstd-3 | 111,960 | 218 |
| Parquet zstd-9 | 105,595 | 232 |
| Parquet zstd-19 | 102,233 | 239 |
| Parquet zstd-3, `(seed, rank, date)` 정렬 | 72,235 | 339 |
| DuckDB 2.0 파일 | 1,323,008 | 18.5 |
| SQLite | 14,061,568 | 1.7 |
| SQLite + 인덱스 | 18,808,832 | 1.3 |

반복 없는 실데이터(하한) [M13d]:

| 표 | JSONL | gzip-6 | zstd-3 | zstd-19 | Parquet zstd-3 | Parquet zstd-19 |
|---|---:|---:|---:|---:|---:|---:|
| 자동완성 1회분 4,777행 | 364,909 | 48,798 | 45,343 | 34,659 | 42,746 | 37,705 |
| issue 500행(본문 포함) | 1,239,635 | 412,121 | 395,003 | 331,086 | 398,991 | 339,703 |

Parquet의 큰 배율은 컬럼 반복이 있을 때만 나온다. 한 번 찍은 텍스트 위주 데이터에서는 zstd와 같은 수준이다. 정렬은 같은 내용에서 35% 작아졌다.

조회 시간(DuckDB, 3회 중 최소, ms) [M13c]:

| 대상 | 집계 | 조건 조회 |
|---|---:|---:|
| JSONL zstd-3 (`read_json`) | 65.3 | 69.7 |
| Parquet zstd-3 | 2.5 | 1.5 |
| Parquet 정렬 | 2.9 | 1.2 |
| DuckDB 네이티브 | 2.6 | 1.0 |
| SQLite + 인덱스 (sqlite3) | 44.5 | 0.1 미만 |

Parquet 형식은 2.14.0(2026-09-11), pyarrow 26.0.0, DuckDB 2.0.0(2026-10-21)으로 시험했다 [S37].

### 8.3 재수집 시 바이트 안정성 (실측)

내용 주소 저장의 이득은 같은 내용이 같은 바이트로 다시 오는지에 달려 있다 [M15].

| 대상 | 간격 | 바이트 동일 |
|---|---|---|
| Claude Code 문서 HTML | 약 25분 | 12개 중 11개 |
| Claude Code 문서 Markdown | 약 25분 | 12개 중 11개 |
| GitHub issues API (100건) | 약 25분 | 100건 중 100건(필드 기준) |
| 유튜브 시청 페이지 HTML | 수 초 | 3쌍 중 0쌍 |

유튜브 측정은 4개 영상 2회씩이었고, 한 쌍은 둘째 응답이 정확히 49,152B로 잘려 제외했다.

### 8.4 내용 주소 저장(CAS)

실제 원본 문서를 기반으로 14일 스냅숏을 시뮬레이션했다. 일 변경률은 issue 4%, 자동완성 20%, Markdown 3%, HTML 3% [M14].

| 방식 | 4종 전체(바이트) | 소형 3종(바이트) |
|---|---:|---:|
| 평문 | 675,358,428 | 93,383,639 |
| 파일별 zstd-3 | 104,925,372 | 32,219,626 |
| 객체 CAS (BLAKE3) + zstd-3 | 10,259,044 | 3,451,044 |
| 객체 CAS + zstd-3 + 64KB 사전 | 9,301,118 | 2,493,118 |
| CDC(FastCDC 평균 16KB) + zstd-3 | 10,953,797 | 3,410,495 |
| 이전 판 델타(zstd-3, raw 사전) | 7,855,201 | 2,347,757 |
| git, 일 1커밋, loose | - | 4,225,436 |
| git gc | - | 2,456,094 |
| git gc --aggressive | - | 2,359,066 |
| restic 0.19.1 `--compression auto` | - | 4,620,602 |
| restic 0.19.1 `--compression max` | - | 4,412,944 |

- 객체 CAS 값에 매니페스트는 빠져 있다. 4종 전체 기준 zstd 후 매니페스트는 객체 317KB, CDC 938KB다.
- 유일 객체 비율: issue 7,000→767, 자동완성 5,880→1,463, Markdown 980→96, HTML 980→93.
- 소요 시간: git 커밋 1.6초 + gc 0.5초 + aggressive 0.7초. restic 11.0~13.4초, 복원 0.8초, 원본과 차이 0건.
- CDC는 객체 CAS보다 유리하지 않았다. 소형 3종에서는 거의 같았고 전체에서는 약 7% 컸다. 청크별 압축이 문맥을 잃는 것이 원인으로 보인다.
- HTML 클래스의 git·restic 측정은 `/tmp` 용량 문제로 하지 못했다(§9).

### 8.5 변동 페이지

유튜브 시청 페이지 재수집 쌍 [M15].

| 페이지 | 크기 | zstd-3 | 이전 판 델타 z3 | 델타 z19 | CDC 신규 1KB | 4KB | 16KB |
|---|---:|---:|---:|---:|---:|---:|---:|
| `dQw4w9WgXcQ` | 1,413,032 | 155,923 | 78,100 | 53,474 | 58.5% | 87.0% | 100% |
| `jNQXAC9IVRw` | 1,324,186 | 143,205 | 76,132 | 51,150 | 55.8% | 76.3% | 85.8% |
| `kJQP7kiw5Fk` | 1,416,276 | 155,923 | 78,653 | 53,733 | 52.4% | 82.8% | 100% |

- 객체 CAS는 중복 제거 0%다.
- CDC의 신규 청크를 청크별 zstd로 저장하면 353,281~456,064B로 페이지 전체 zstd-3보다 크다.
- 이전 판을 raw 사전으로 쓴 델타가 절반 이하로 줄였다.
- 페이지 자체는 `ytInitialPlayerResponse`가 포함된 스크립트 묶음이다. 추출한 JSON의 바이트 안정성은 측정하지 않았다.

## 9. 후보 표

버전·날짜는 2026-10-31에 GitHub API, npm, PyPI로 확인했다 [S1, S2, S14, S38]. "실측"은 이번 조사에서 실행한 것이다.

| 후보 | 최신 버전 | 릴리스일 | 유지보수 | 라이선스 | 이 환경 적합성 | 차단 요인 | 실측 |
|---|---|---|---|---|---|---|---|
| rtk-oss | 1.1.0 | 2026-10-25 | 매우 활발, 일 단위 dev | Apache-2.0 | 설치됨. Bash만, `git`/`ls`/`find`에서 효과 | 규칙 우회, `uv run` stdout 손실, 프로젝트 설정 없음 | 예 |
| rtk 전체판 | 1.1.0 | 2026-10-25 | 동일 | Apache-2.0 + BUSL-1.1 | Read·MCP 압축 경로 보유 | 미설치, BUSL, 필터가 손실형 | 문서만 |
| rtk-proxy | 1.1.0 | 2026-10-25 | 동일 | BUSL-1.1 | 대화 전체 대상, 사용자 파이프라인 전용 | 미설치, 인증 경유, 프로젝트 범위 불가 | 아니오 |
| Trail-Code | 0.28.1 | 2026-10-30(npm) | 활발 | MIT | 코드 소량이라 효용 작음, 한글 미지원 | init의 전역 쓰기, 메모리 복사, 한국어 노트 거부 | 예 |
| context-mode | 1.0.169 (`next` 2.0.0-next.17) | 2026-06-29 (`next` 2026-10-30) | 활발 | Elastic-2.0 | 도구 출력 샌드박스, FTS5. Node 26 충족 | 소스 공개 라이선스, 벤더 수치, 훅 다수 | 아니오 |
| headroom | 0.42.0 | 2026-10-26 | 활발 | Apache-2.0 | 로컬 프록시 | 제3자 벤치에서 비용 증가 보고 | 아니오 |
| caveman | 4.0.1 | 2026-10-13 | 활발 | Apache-2.0 | 응답 문체 축소 | 한국어 효과 미상 | 아니오 |
| tokf | 0.2.54 | 2026-09-06 | 활발 | MIT | 설정 기반 CLI 필터. Linux 사전 빌드 있음 | 소규모(스타 199), rtk와 같은 Bash 범위 | 아니오 |
| snip | 0.25.2 | 2026-09-12 | 활발 | MIT | YAML 필터 CLI. Linux 사전 빌드 있음 | 소규모(스타 473), rtk와 같은 Bash 범위 | 아니오 |
| TOON (`@toon-format/toon`) | 4.4.0 | 2026-10-08 | 활발 | MIT | 평면 응답 표현. Node 26 동작 | 생성 과제는 불리 보고, 중첩 이득 없음 | 예 |
| TOON (`toon-format`, PyPI) | 1.2.0 | 2026-10-18 | 활발 | MIT | Python 3.10+ | TS 구현과의 결과 비교 안 함 | 설치만 |
| zstd + `compression.zstd` | 1.5.7 | 2025-02-19 | 저장소 활발, 릴리스 간격 김 | BSD 또는 GPLv2 | Python 3.14 표준 라이브러리 | CLI 없음. 관리형 3.12/3.13은 불가 | 예 |
| `zstandard` (PyPI) | 0.25.0 | 2025-09-14 | 유지 | BSD-3-Clause | 3.13 휠 동작 | - | 예 |
| Parquet / pyarrow | 2.14.0 / 26.0.0 | 2026-09-11 / 2026-10-09 | 활발 | Apache-2.0 | 반복 컬럼에 강함. 3.13 휠 동작 | 단건 갱신 부적합(별도 설계) | 예 |
| DuckDB | 2.0.0 | 2026-10-21 | 활발 | MIT | Parquet 질의 1~3ms, CLI 없이 Python으로 | 메이저 판 직후, 소형 파일 오버헤드 | 예 |
| git | 2.53.0 | 시스템 | 활발 | GPL-2.0 | 추가 코드 없이 2.36MB | 대용량 원본은 저장소 비대, 무결성 외 질의 없음 | 예 |
| restic | 0.19.1 | 2026-07-05 | 활발 | BSD-2-Clause | 단일 정적 바이너리, 복원 검증됨 | 미설치, 암호화 필수, git보다 큼 | 예 |
| kopia | 0.23.1 | 2026-06-16 | 활발 | Apache-2.0 | 단일 바이너리 | 미설치 | 아니오 |
| borg | 1.4.5 | 2026-07-18 | 활발 | BSD-3-Clause | Python 기반 | 미설치 | 아니오 |
| OpenZL | 0.3.0 | 2026-09-29 | 활발 | BSD | 구조 데이터 전용. C11/C++17, `make` 빌드 가능(gcc, g++, make 있음, cmake 없음) | 소스 빌드 필요, 벤더 수치만, 비구조 텍스트에 부적합 | 아니오 |
| sqlite-zstd | 0.3.5 | 2025-05-10 | 정체(마지막 푸시 2025-06-30) | LGPL-3.0 | SQLite 행 압축 확장. x86_64 Linux 사전 빌드 있음 | 1년 넘게 정체, 3.46 호환 미확인 | 아니오 |
| fastcdc (PyPI) | 1.7.0 | 2024-06-27 | 정체 | MIT | CDC 측정용 | 이번 데이터에서 이득 없음 | 예 |

벤더 주장: OpenZL은 zstd-19보다 평균 35% 좋다는 Meta 주장이 Phoronix를 통해 보고됐고, 비구조 데이터에는 zstd가 맞다는 설명이 함께 있다 [S39].

## 10. 실측으로 드러난 제약

1. `/tmp`는 16GB tmpfs이고 병렬 에이전트가 공유한다. 측정 중 `retrieval` 6.3G, `etl` 3.5G, `uv-cache` 2.2G가 쓰고 있었고, 본 측정이 마지막 쓰기로 한도를 넘겼다. 수집 데이터는 `/tmp`에 둘 수 없다.
2. `rtk init`은 `CLAUDE.md`를 수정하므로 "승인 없이 변경 금지" 조건과 충돌한다.
3. rtk 설정은 사용자 파일뿐이며 프로젝트 파일이 없다. 환경변수와 훅 래퍼가 프로젝트 범위의 유일한 수단이다.
4. 재작성 훅과 `--allowed-tools`는 함께 쓸 수 없다(규칙을 `rtk ...` 형태로 쓰지 않는 한). 스케줄 작업에 해당한다.
5. 승인을 받을 곳이 없는 헤드리스 실행에서 승인이 필요한 호출은 자동 거부된다 [M4].
6. `--no-session-persistence`여도 큰 도구 결과는 `~/.claude/projects/.../tool-results/`에 쓰인다 [M9].
7. API 키가 없어 `count_tokens`를 쓸 수 없다. `claude -p` usage로 대신할 수 있고 비용은 작다.
8. 비교에 쓸 CLI가 없다: `zstd`, `sqlite3`, `duckdb`. Python 바인딩으로 대신했다.

## 11. 출처

확인일은 모두 2026-10-31이다.

| ID | 출처 | URL |
|---|---|---|
| S1 | rtk 저장소 메타데이터 | https://github.com/rtk-ai/rtk |
| S2 | rtk v1.1.0 릴리스 | https://github.com/rtk-ai/rtk/releases/tag/v1.1.0 |
| S3 | rtk 설정 문서 | https://github.com/rtk-ai/rtk/blob/v1.1.0/docs/guide/getting-started/configuration.md |
| S4 | rtk 판본과 라이선스 | https://github.com/rtk-ai/rtk/blob/v1.1.0/docs/guide/resources/editions.md |
| S5 | rtk 절감 설명 | https://github.com/rtk-ai/rtk/blob/v1.1.0/docs/guide/resources/savings-explained.md |
| S6 | rtk 에이전트 범위 | https://github.com/rtk-ai/rtk/blob/v1.1.0/docs/guide/resources/agent-coverage.md |
| S7 | rtk 프록시 개요 | https://github.com/rtk-ai/rtk/blob/v1.1.0/docs/guide/proxy/overview.md |
| S8 | rtk 프록시 압축 | https://github.com/rtk-ai/rtk/blob/v1.1.0/docs/guide/proxy/compression.md |
| S8b | rtk 메서드 | https://github.com/rtk-ai/rtk/blob/v1.1.0/docs/guide/pipelines/methods.md |
| S9 | rtk 텔레메트리 | https://github.com/rtk-ai/rtk/blob/v1.1.0/docs/TELEMETRY.md |
| S10 | rtk 훅 내부 문서 | https://github.com/rtk-ai/rtk/blob/v1.1.0/src/hooks/README.md |
| S11 | rtk TOML 필터 | https://github.com/rtk-ai/rtk/blob/v1.1.0/src/filters/README.md |
| S12 | rtk 이슈 #4860 | https://github.com/rtk-ai/rtk/issues/4860 |
| S13 | Trail-Code README (0.28.1 패키지 동봉본) | https://github.com/trailhq/Trail-Code/blob/main/README.md |
| S14 | Trail-Code 저장소, npm | https://github.com/trailhq/Trail-Code , https://www.npmjs.com/package/@trailhq/trail-code |
| S14b | Trail-Code 이슈 #711 | https://github.com/trailhq/Trail-Code/issues/711 |
| S15 | Trail-Code 텔레메트리 | https://github.com/trailhq/Trail-Code/blob/main/TELEMETRY.md |
| S16 | Claude Code 훅 | https://code.claude.com/docs/en/hooks.md |
| S17 | Claude Code 설정 | https://code.claude.com/docs/en/settings.md |
| S18 | Claude Code 도구 참조 | https://code.claude.com/docs/en/tools-reference.md |
| S19 | Claude Code 환경변수 | https://code.claude.com/docs/en/env-vars.md |
| S20 | Claude Code MCP | https://code.claude.com/docs/en/mcp.md |
| S21 | Claude 프롬프트 캐싱 | https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md |
| S21b | Claude 토큰 계산 | https://platform.claude.com/docs/en/build-with-claude/token-counting.md |
| S21c | claude-api 스킬 `shared/prompt-caching.md` (Claude Code 2.1.314 동봉) | 로컬 번들 |
| S22 | Anthropic, Writing tools for agents (2025-09-11) | https://www.anthropic.com/engineering/writing-tools-for-agents |
| S24 | MCP 사양 초안 Tools | https://modelcontextprotocol.io/specification/draft/server/tools |
| S25 | MCP 2026-07-28 공지 | https://blog.modelcontextprotocol.io/posts/2026-07-28/ |
| S26 | Claude Code 프롬프트 캐싱 | https://code.claude.com/docs/en/prompt-caching.md |
| S27 | Anthropic, Code execution with MCP | https://www.anthropic.com/engineering/code-execution-with-mcp |
| S28 | Anthropic, Advanced tool use | https://www.anthropic.com/engineering/advanced-tool-use |
| S29 | Cloudflare Code Mode | https://blog.cloudflare.com/code-mode-mcp/ |
| S30 | TOON README | https://github.com/toon-format/toon |
| S31 | Matveev, arXiv 2603.03306 | https://arxiv.org/abs/2603.03306 |
| S32 | `claude --help` (2.1.314) | 로컬 실행 |
| S33 | Yongkyun, Cutting LLM Token Costs | https://codepointer.dev/p/cutting-llm-token-costs-with-rtk |
| S34 | Dasein Code-Compression Bench | https://raw.githack.com/daseinlabs/code-compression-bench/master/results/2026-07-04/dashboard.html |
| S35 | context-mode | https://github.com/mksglu/context-mode |
| S36 | Python `compression.zstd` | https://docs.python.org/3.14/library/compression.zstd.html |
| S37 | Parquet, Arrow, DuckDB 릴리스 | https://github.com/apache/parquet-format , https://github.com/apache/arrow , https://github.com/duckdb/duckdb |
| S38 | 나머지 후보 저장소와 패키지 | https://github.com/headroomlabs-ai/headroom , https://github.com/JuliusBrussee/caveman , https://github.com/mpecan/tokf , https://github.com/edouard-claude/snip , https://github.com/facebook/zstd , https://github.com/restic/restic , https://github.com/kopia/kopia , https://github.com/borgbackup/borg , https://github.com/phiresky/sqlite-zstd , https://pypi.org/project/zstandard/ , https://pypi.org/project/fastcdc/ , https://pypi.org/project/toon-format/ |
| S39 | OpenZL 0.3 보도 | https://www.phoronix.com/news/OpenZL-0.3-Released |
| R1 | `wf_7fe34f38-d94` 조사 결과(2026-10-31 동시 진행, 사용자 설정 없는 샌드박스, 가짜 Messages API) | `~/.claude/projects/-home-sagae-sagae-claude-plugins/01842778-1730-486e-854c-25be5911f20a/subagents/workflows/wf_7fe34f38-d94/journal.jsonl` |

## 12. 실측 기록

작업 디렉터리 `C=/tmp/claude-1000/-home-sagae-sagae-knowloge-base/b32eef31-b09c-4e58-8902-431f279117b3/scratchpad/compression`. 스크립트는 `$C/scripts`, 로그는 `$C/logs`. 스크래치패드는 임시이므로 핵심 명령을 여기에 남긴다. 모든 `rtk`, `trail` 시험은 별도 명시가 없으면 가짜 HOME과 `unshare -rn`(`scripts/sbx.sh`)에서 돌렸다.

| ID | 명령과 수치 |
|---|---|
| M0 | `rg -c trailing ~/.claude/history.jsonl` → 1. `ls ~/.local/bin`. `trail telemetry` → `off: DO_NOT_TRACK is set`. `rg -o 'https?://[a-zA-Z0-9.-]+' <dist>` → `events.nanonets.com`, `team.trailhq.com` |
| M1 | `rtk init`, `rtk init --hook-only --no-patch`, `rtk init --show` (`rtk-init-test.sh`) |
| M1b | `rtk llm-proxy setup`, `rtk telemetry status` |
| M2 | `printf '<PreToolUse JSON>' \| rtk hook claude`, 28개 명령 (`rtk-hook-contract.sh`) |
| M3 | `claude -p '...' --model haiku --no-session-persistence --setting-sources project,local --strict-mcp-config --mcp-config '{"mcpServers":{}}' --permission-mode bypassPermissions --output-format stream-json --verbose --include-hook-events`. 훅 래퍼가 stdin의 `agent_id`, `agent_type`, `permission_mode`를 기록 (`hook-live-*.sh`, `hook-wf.sh`, `hook-wt.sh`). transcript 집계는 `attachment.type == hook_success` |
| M4 | 위 + `--allowed-tools`, `--disallowed-tools`, `--permission-prompts none`, 프로젝트 `permissions` (`hook-live-3.sh`, `hook-rules.sh`). 결과 판정은 `tool_result.is_error`와 `permission_denials` |
| M5 | `rtk-measure.sh`: 각 명령을 `bash -c`로 원본과 `rtk` 형태로 실행해 `wc -c`와 종료 코드 비교. 표본은 `git clone --depth 300 trailhq/Trail-Code` |
| M5b | `pytest -q` 대 `rtk pytest -q`, 50통과 5실패. `rtk recall <hash>`, `rtk recall --list`, `rtk config recall` |
| M5c | `uv run --no-project python c.py`(종료 3) 대 `rtk uv run ...`. `rtk-uv.sh` |
| M6 | `claude -p`로 `cat big.txt`(251,670B), `cat mid.txt`(27,000B). `tool_result` 길이 2,326, 26,999 (`bash-cap.sh`) |
| M6b | `tool-share.py`: transcript의 `tool_use.id`와 `tool_result`를 묶어 도구별 글자 수 합산 |
| M6c | `XDG_DATA_HOME=<격리> rtk discover --all --since 30` |
| M7 | `trail-test.sh`, `trail-test2.sh`: 가짜 HOME, 네트워크 없음, 래퍼 환경변수 적용. 전후 파일 목록 비교 |
| M7b | `trail init --no-statusline --no-global --no-agents --no-build`와 `--dry-run` (`trail-test3.sh`) |
| M8 | `trail-mcp-client.py`로 `trail mcp`에 initialize, tools/list, tools/call. 전후 `sha1sum` 비교 |
| M9 | `mcp-test-server.py`(표준 라이브러리 프로브 서버), `mcp-probe.sh`, `mcp-probe2.sh`. 한글·영어 45,000자 토큰은 M11 방식 |
| M10 | `idfirst-build.py` + M11 방식 |
| M11 | `claude -p --model claude-haiku-5-5 --system-prompt 'Reply with OK.' --tools '' --setting-sources '' --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-session-persistence --output-format json --effort low < payload`. `input + cache_creation + cache_read` 합에서 빈 프롬프트 기준값(639, Opus 614) 차감. TOON 인코딩과 왕복 검증은 `@toon-format/toon@4.4.0`, `gpt-tokenizer` o200k (`toon-encode.mjs`, 네트워크 없음) |
| M12 | `rtk-toml.sh`, `rtk-toml2.sh`: `rtk trust -y`, `rtk rewrite`, `rtk verify --filter` |
| M13a | `zstd-dict.py`, `zstd-dict2.py`: `zstandard` 0.25.0, zstd 1.5.7, 시드 42, 80/20 분할 |
| M13b | 시스템 Python 3.14.4 `compression.zstd.train_dict`, 같은 시드 |
| M13c | `tabular.py`: pyarrow 26.0.0, duckdb 2.0.0 |
| M13d | `tabular2.py` |
| M14 | `cas.py`: BLAKE3, `fastcdc`(4K/16K/64K, `fat=True`). `cas-tools2.sh`: 일별 커밋 후 `git gc`, `git gc --aggressive --prune=now`, `restic init/backup/restore/check` |
| M15 | `curl` 재수집 후 `cmp`. `yt-volatile.py`, `yt-cdc.py` |

표본: 유튜브 자동완성 518회(0.25~0.3초 간격, `hl=ko`, `gl=KR`), GitHub API 500건, 공식 문서 70쪽, 유튜브 시청 페이지 8회.

## 13. 미확인 사항

- "trailing"이 Trail-Code를 뜻하는지에 대한 사용자 확인.
- 한글이 25,000토큰 한도에 걸리지 않는 내부 이유. 글자 수 기반 추정은 추론이다.
- 대화형 세션에서의 재작성 프롬프트 동작, 실제 Orca 훅과 rtk 훅의 동시 동작.
- 격리 worktree에서 `.claude/settings.local.json`만 있을 때의 서브에이전트 동작. 커밋된 설정과 새 worktree 세션은 확인했다.
- `rtk-proxy` 실측과 구독 OAuth 호환. 전체판 `rtk`의 `hook.after_tool` 실측.
- context-mode, headroom, caveman, tokf, snip, OpenZL, kopia, borg 실측.
- HTML 스냅숏에 대한 git·restic 크기.
- 실제 일 단위 변경률. §8.4의 변경률과 §8.2의 표는 시뮬레이션이다.
- 유튜브 페이지에서 추출한 JSON의 바이트 안정성. 데이터 API 응답의 안정성.
- TOON의 Python 구현과 TS 구현의 출력 일치 여부. Claude 모델에서의 TOON 해석 정확도.
- Dasein 벤치마크의 기준 행 해결 수.
- 12개 페이지 중 `agent-loop` 1건이 달라진 원인.

## 14. 실측 부산물

- `/tmp`: git·restic 첫 측정에서 tmpfs가 가득 찼다. 그 짧은 구간에 다른 에이전트의 쓰기가 실패했을 수 있다. 스냅숏과 표본을 지워 본 측정 디렉터리는 18MB로 줄였다.
- `~/.claude/projects/-tmp-claude-1000--...-scratchpad-compression-*`: `claude -p` 시험이 만든 디렉터리 4개(합계 약 436KB)가 남아 있다. 세션 기록과 `tool-results`이며 설정 파일은 아니다. 금지 범위를 고려해 지우지 않았다.
- `~/.local/share/rtk/history.db`: 초기 훅 시험에서 재작성된 `rtk` 명령이 격리 환경 밖 Bash에서 돌아 전체 19행 중 9행이 이 실측에서 나왔다. `recall.db`는 전체 1행이다.
- 저장소, `~/.claude/settings.json`, crontab, systemd, 셸 프로필은 변경하지 않았다.
- `claude -p` 실측 사용량은 합계 약 $0.7 상당이며 대부분 Opus 토큰 측정 8회다.
