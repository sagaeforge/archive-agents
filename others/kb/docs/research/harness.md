# Claude Code 운영 하네스 조사

- 조사일: 2026-10-31
- 대상: Claude Code 2.1.314(착수 시 설치본). 측정 도중 2.1.316으로 자동 업데이트되어, 판단에 쓰는 시험은 2.1.314 바이너리로 다시 실행했다. 시험별 버전은 부록 A에 적었다.
- 성격: 시스템 설계 문서다(CLAUDE.md "지침 5 적용 기준"의 ADR 예외). 지식 데이터가 아니다.
- 표기: 문서 사실은 출처 링크와 확인일을 붙였다. 실측은 `T..`(최초), `R..`(2.1.314 재현) ID로 적었고, 명령과 수치는 부록 A에 있다.
- 비용 표기: `total_cost_usd`는 클라이언트 추정치다(정가 기준, `costBasis: "list"`). 구독 차감량이 아니다.

## 0. 결론 요약

1. **스케줄의 주체는 호스트 스케줄러 + `claude -p`다.** `CronCreate`와 `/loop`는 세션에 묶이고, `-p`에서 만든 cron은 프로세스 종료와 함께 사라진다(T7b, R7b). 클라우드 예약은 로컬 파일을 못 보고 저장소를 다루려면 GitHub 접근이 필요한데, 이 저장소는 원격도 커밋도 없다.
2. **저장 워크플로우는 헤드리스에서 이름으로 실행된다.** 단 `Workflow(<name>)` 허용 규칙이 있어야 하며, 없으면 exit 0으로 조용히 거부된다(T5a, T5b).
3. **exit 코드는 작업 성공의 근거가 아니다.** 권한 거부, 예산 초과로 죽은 워크플로우, 대기 상한으로 죽은 워크플로우가 모두 exit 0 + `success`다(T3, R12, T22e). 반대로 워크플로우가 `completed`인데 메인 모델의 후속 행동 때문에 exit 1이 된 경우도 있다(R19).
4. **기본 대기 상한 10분이 긴 워크플로우를 죽인다.** 상한을 넘긴 워크플로우는 exit 0으로 중단된다(T22e). 작업마다 `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`을 지정해야 한다(T22f).
5. **API 키가 없어 `--bare`를 쓸 수 없다**(T9, R9). 그런데 공식 문서는 `--bare`가 향후 `-p`의 기본값이 된다고 예고한다. 구독 전용 운영에 대한 가장 큰 미래 위험이고, 버전 고정이 필요한 이유다.
6. **권한은 `--settings` 파일로 넘긴다.** 프로젝트 `permissions.allow`는 trust가 없으면 무시된다(T4d). `--settings`는 trust와 무관하게 적용된다(T4e). 이 저장소는 trust가 승인된 상태지만, 새 클론과 스크래치에서는 깨진다.
7. **토큰 절감 수단은 `--tools`와 맞춤 에이전트다.** 요청당 컨텍스트는 21,770에서 5,529로 줄고(C.a→C.e), 같은 사소한 작업의 워크플로우 에이전트는 16,883~29,787에서 2,359로 줄어든다(T19, R19). 다만 `--tools` 제한은 워크플로우 에이전트까지 전파되고, 필요한 도구가 없어도 exit 0이다(R20).
8. **다른 세션 공유는 플러그인이 맞다.** 사용자 범위 MCP는 도구만 주지만 플러그인은 MCP, 스킬, 에이전트, 워크플로우, hook을 함께 준다. 다른 프로젝트에서 전부 동작함을 확인했다(R8, R8b).
9. **세션 전사는 30일 뒤 조용히 삭제된다.** 자가 개선 지표는 그 전에 적재해야 한다. 토큰 합계는 ccusage와 자체 추출이 일치했다. 도구 실패 지표는 ccusage에 없어 자체 추출이 필요하다.

## 1. 측정 방법

- 모든 `claude -p`는 `env -i`로 실행했다. `HOME`, `PATH`, `LANG`, `TERM`만 넘겨 systemd/cron 실행과 같은 조건을 만들었고, 그 결과 `CLAUDECODE`, `ORCA_*`, `TMUX`가 전달되지 않는다. Orca 패널 상태를 건드리지 않기 위한 조치이기도 하다.
- 모델은 `haiku`로 고정했고(`claude-haiku-5-5`), 호출당 `--max-turns`는 2 이내다.
- 시험 프로젝트는 스크래치에 만들었다. 이 폴더들은 trust가 없으므로, 부록의 결과는 "새 클론에서 `-p`를 돌렸을 때"에 해당한다. 이 저장소는 `hasTrustDialogAccepted: true`다.
- 한계: 작은 작업 위주의 1회 측정이다. 토큰 수치는 실행마다 달라진다(같은 에이전트가 16,883과 29,787). 실제 10분 대기, 실제 사용량 한도 도달은 재현하지 않았다.

## 2. 구성 요소 (확인 항목 1)

### 2.1 서브에이전트 `.claude/agents`

- 우선순위는 managed > `--agents` > 프로젝트 > 사용자 > 플러그인이다. 필수 필드는 `name`, `description`이다. [sub-agents](https://code.claude.com/docs/en/sub-agents) 2026-10-31
- 제어 필드: `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`, `background`, `omitClaudeMd`, `effort`, `isolation`. 오타 필드는 조용히 무시되고, `name`이나 `description`이 없는 파일은 조용히 건너뛴다. [sub-agents](https://code.claude.com/docs/en/sub-agents) 2026-10-31
- 기본 동시 실행 상한은 20, 중첩 깊이는 메인 아래 3층이다. [sub-agents](https://code.claude.com/docs/en/sub-agents) 2026-10-31
- **trust가 없는 폴더의 `-p`에서는 프로젝트 에이전트의 프런트매터 `hooks`와 인라인 `mcpServers`가 동작하지 않는다.** `--agents` JSON으로 넘기면 동작한다. [permissions](https://code.claude.com/docs/en/permissions) 2026-10-31, 실측 T4(미발화), T4b(발화)
- 플러그인 에이전트는 `hooks`, `mcpServers`, `permissionMode`, `initialPrompt`를 무시한다. [plugins/components](https://code.claude.com/docs/en/plugins/components) 2026-10-31
- 도구 이름 주의: `system/init.tools`에는 `Task`로 나오지만 실제 `tool_use`와 hook의 `tool_name`은 `Agent`다(T4). 규칙과 matcher는 `Agent`로 쓴다.

### 2.2 스킬 `.claude/skills`

- `SKILL.md` 프런트매터로 `context: fork`, `agent`, `allowed-tools`, `disable-model-invocation`, `user-invocable`, `paths`, `hooks`, `model`, `effort`를 제어한다. `description`과 `when_to_use`는 합쳐서 1,536자로 잘린다. [skills](https://code.claude.com/docs/en/skills) 2026-10-31
- `-p`에서 `/skill-name`은 프롬프트에 넣으면 확장된다. [headless](https://code.claude.com/docs/en/headless) 2026-10-31
- 항상 지켜야 하는 규칙은 스킬이 아니라 hook으로 둔다. 플러그인 루트의 `CLAUDE.md`는 로드되지 않는다. [plugins/components](https://code.claude.com/docs/en/plugins/components) 2026-10-31

### 2.3 저장 워크플로우 `.claude/workflows`

- JavaScript 스크립트를 런타임이 실행하고, 계획과 중간 결과는 스크립트 변수에 있다. `.claude/workflows/`(프로젝트), `~/.claude/workflows/`(개인), 플러그인 `workflows/`에 저장한다. 프로젝트가 개인보다 우선한다. [workflows](https://code.claude.com/docs/en/workflows) 2026-10-31
- 런타임 제약: 파일시스템과 셸 직접 접근 불가, `import()` 불가, `Date.now()`·`Math.random()` 불가, 실행 중 사용자 입력 불가. 동시 에이전트 기본 16(`min(16, CPU-2)`이고 이 머신은 24코어), 실행당 1,000개, `parallel`/`pipeline`당 4,096항목. [workflows](https://code.claude.com/docs/en/workflows) 2026-10-31
- 입력은 `script`, `name`, `scriptPath`, `args`, `resumeFromRunId`다. `resumeFromRunId`는 같은 세션에서만 유효하고, `scriptPath`는 세션 도구에 `Read`가 있어야 한다. [agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript) 2026-10-31
- **별도 프로세스 재개가 동작한다.** 세션을 저장해 두고 `claude -p --resume <sid>`로 `Workflow({scriptPath, resumeFromRunId})`를 호출하면, 완료된 에이전트는 8~12 ms에 토큰 0으로 재생된다(T11, R11). `--no-session-persistence`로 돌린 작업은 재개할 수 없으므로, 재개가 필요한 작업은 이 플래그를 쓰지 않는다.
- 에이전트 스톨 판정은 10분, 재시작은 최대 5회다. `parallel()`/`pipeline()` 안의 실패는 `null`로 남고 실행은 계속된다. [workflows](https://code.claude.com/docs/en/workflows) 2026-10-31
- 사용량 한도 도달 시 일시정지는 대화형 세션 전용이다. `claude -p`에서는 해당 에이전트가 실패한다. [workflows](https://code.claude.com/docs/en/workflows) 2026-10-31
- `ultracode` 키워드는 `-p` 프롬프트에서 동작하지 않는다. 헤드리스에서는 저장 워크플로우를 명시 호출한다. [workflows](https://code.claude.com/docs/en/workflows) 2026-10-31

### 2.4 에이전트 팀

- 실험 기능이고 기본 꺼짐이다. 사용자 settings의 `env`에 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`이 켜져 있다. [agent-teams](https://code.claude.com/docs/en/agent-teams) 2026-10-31
- **`-p`와 SDK에서는 팀원을 만들지 않는다.** 이름 붙인 서브에이전트도 일반 서브에이전트로 실행된다. [agent-teams](https://code.claude.com/docs/en/agent-teams) 2026-10-31, 실측 T17(`task_type: local_agent`, 팀 도구 없음)
- 대화형 세션에서는 Claude가 스스로 이름을 붙인 서브에이전트가 확인 없이 팀원으로 뜰 수 있다. 메인 세션 관제(지침 1)에서는 의도치 않은 팀 생성을 감안해야 한다. [agent-teams](https://code.claude.com/docs/en/agent-teams) 2026-10-31
- 제한: 세션당 1팀, 중첩 불가, 리드 고정, in-process 팀원은 `/resume`으로 복구되지 않음, 팀원은 worktree로 격리되지 않음. [agent-teams](https://code.claude.com/docs/en/agent-teams) 2026-10-31

**적용 판단:** 스케줄 작업은 저장 워크플로우로, 메인 세션의 대화형 협업만 팀으로 나눈다. 팀은 헤드리스에서 쓸 수 없고 재개도 약하다.

## 3. 헤드리스 `claude -p` (확인 항목 2)

### 3.1 상한

| 상한 | 동작 | 근거 |
|---|---|---|
| `--max-turns N` | 메인 루프만 센다. 서브에이전트와 워크플로우 에이전트의 턴은 포함되지 않는다. 초과 시 exit 1, `error_max_turns` | [cli-reference](https://code.claude.com/docs/en/cli-reference) 2026-10-31, T1, T4 |
| `--max-budget-usd X` | 클라이언트 추정치로 사후 검사하므로 상한을 넘을 수 있다. 메인 초과 시 exit 1, `error_max_budget_usd` | [cli-reference](https://code.claude.com/docs/en/cli-reference) 2026-10-31, T2(상한 $0.0001, 실제 $0.00174) |
| 예산과 워크플로우 | 상한 도달 시 배경 워크플로우를 죽인다. **이때 exit 0, `success`, `completed`** | T12, R12(순차 6개 중 4~5번째 진행 중 중단, 상한 $0.012, 실제 $0.0133) |
| 배경 대기 상한 | 기본 600,000 ms. 넘기면 워크플로우를 멈추고 **exit 0**. `0`이면 무제한 | [headless](https://code.claude.com/docs/en/headless), [env-vars](https://code.claude.com/docs/en/env-vars) 2026-10-31, T22e, T22f |
| SIGTERM | exit 143. 진행 중 턴은 미완료로 남고 `SessionEnd` hook은 실행된다 | [headless](https://code.claude.com/docs/en/headless) 2026-10-31 |

턴 수의 함정 두 가지:

- 도구가 지연 로딩(deferred)이면 `ToolSearch`가 한 턴을 쓴다. `--max-turns 2`로 MCP 도구 하나를 호출하면 초과할 수 있다(T8c: `ToolSearch` → 도구 → 응답 순서로 3턴, exit 1).
- 워크플로우 완료 알림 뒤의 턴도 상한에 걸린다. R19는 워크플로우가 `completed`였는데 메인 모델이 결과를 재검증하다 초과해 exit 1이 됐다. 메인 도구를 줄이면 이 여지도 줄어든다(R20은 도구가 `Workflow,Read`뿐이고 정상 종료).

### 3.2 권한 모드

- `claude -p`의 기본은 `default`(Manual)이고, 승인이 필요한 호출은 허용 규칙이 없으면 거부된다. v2.1.302부터 이렇게 고정됐다. [permission-modes](https://code.claude.com/docs/en/permission-modes) 2026-10-31
- `--permission-prompts none`을 쓰면 거부를 재시도하지 말라고 모델에 알린다. v2.1.259 이상. [headless](https://code.claude.com/docs/en/headless) 2026-10-31, 실측 T3b
- `dontAsk`는 프롬프트가 필요한 호출을 거부하고 허용 목록만 실행한다. `--allowedTools`와 함께 쓴다. [headless](https://code.claude.com/docs/en/headless) 2026-10-31, 실측 T3c
- `auto`는 분류기가 심사하고, 구독 + haiku + `-p`에서 동작했다(T14, R14). `defaultMode: "auto"`는 프로젝트 settings에서 효력이 없다. [permission-modes](https://code.claude.com/docs/en/permission-modes) 2026-10-31
- **Bash 샌드박스가 이 머신에서 무인 동작한다.** `bwrap`과 `socat`이 설치돼 있다. `{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,"failIfUnavailable":true}}`로 cwd 안은 쓰기 가능하고 밖은 `Read-only file system`이며 프롬프트가 없다(T15, R15). 웹에서 수집한 신뢰할 수 없는 데이터를 다루는 작업에 필요한 경계다. [sandboxing](https://code.claude.com/docs/en/sandboxing) 2026-10-31

**신뢰 경계:** 문서는 `-p`가 trust 대화상자를 건너뛰고 폴더를 신뢰한 것으로 취급한다고 밝힌다. 그 결과 저장소의 `.claude/settings.json` hook, `env`, `apiKeyHelper`, `.mcp.json` 서버가 실행된다. 반대로 `permissions.allow`, 프로젝트 에이전트의 프런트매터 hook, 인라인 MCP는 쓰이지 않는다. [permissions](https://code.claude.com/docs/en/permissions) 2026-10-31, 실측 T4, T4d

### 3.3 출력 형식과 성공 판정

`--output-format`은 `text`, `json`, `stream-json`이고, `--json-schema`는 결과를 `structured_output`으로 준다. [headless](https://code.claude.com/docs/en/headless) 2026-10-31

스트림에서 쓸모 있는 필드(T0 등 실측에서 확인):

- `system/init`: `tools`, `agents`, `skills`, `plugins`, `plugin_errors`, `mcp_servers[].status`, `permissionMode`, `claude_code_version`, `apiKeySource`. claude.ai 커넥터는 비동기로 붙어서 첫 init에는 없을 수 있고 `pending` 상태도 나온다(T0, T18).
- `result`: `subtype`, `is_error`, `terminal_reason`, `permission_denials`, `total_cost_usd`, `modelUsage`, `subagent_stats`, `safety_stops`, `api_error_status`. `result` 이벤트는 배경 작업이 있으면 2개 이상이므로 **마지막 것을 쓴다**(T5b).
- `system/task_notification`: 배경 작업의 `status`(`completed`, `stopped`).
- `rate_limit_event`: `unifiedWindows.five_hour.utilization`, `seven_day.utilization`, `resetsAt`. 스케줄러의 자기 제어 신호로 쓸 수 있다.
- `terminal_reason` 전체 열거값은 [agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript) 2026-10-31에 있다.

**판정 규칙(검증함):** 스트림 파일을 읽어 다음을 모두 만족할 때만 성공으로 본다.

1. 마지막 `result`의 `is_error`가 false
2. `permission_denials`가 비어 있음
3. 모든 `task_notification.status`가 `completed`
4. `mcp_servers`에 `failed`가 없음

기록된 스트림에 적용한 결과는 다음과 같다. exit 코드만으로는 이 실패들이 모두 성공으로 보인다.

| 스트림 | exit | 판정 | 사유 |
|---|---|---|---|
| T21 권고 조합 | 0 | ok | |
| T22f 상한 0 | 0 | ok | |
| T5a 허용 없음 | 0 | fail | `denials:Workflow` (당시 T0 실패 캐시로 `mcp_failed`도 함께 표시) |
| T13a rtk 재작성 | 0 | fail | `denials:Bash` |
| R12 예산 초과 | 0 | fail | `background_task_not_completed` |
| T22e 대기 상한 | 0 | fail | `background_task_not_completed` |

이 규칙은 하네스 수준의 판정이다. R20처럼 에이전트가 "할 수 없었다"고 텍스트로 답하고 끝나는 경우는 잡지 못한다. 그래서 `schema`로 구조화 결과를 강제하고, 최종 판정은 적재 건수 같은 응용 수준 검증에 둔다.

### 3.4 스케줄 실행 시 인증

- 인증 우선순위: 클라우드 공급자 > `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > `apiKeyHelper` > `CLAUDE_CODE_OAUTH_TOKEN` > 프로필 > `/login` 구독 OAuth. `-p`에서는 `ANTHROPIC_API_KEY`가 있으면 항상 그것을 쓴다. [authentication](https://code.claude.com/docs/en/authentication) 2026-10-31
- Linux 자격증명은 `~/.claude/.credentials.json`(0600)이다. [authentication](https://code.claude.com/docs/en/authentication) 2026-10-31
- **`env -i`로 `HOME`만 넘겨도 구독 OAuth로 동작했다**(T0, `apiKeySource: none`). 환경변수 없이 파일 인증이 된다.
- 로그인 만료 시 모델 요청마다 `Login expired · Please run /login`로 실패하고, 무인 세션은 복구하지 못한다. [authentication](https://code.claude.com/docs/en/authentication) 2026-10-31
- `claude setup-token`은 1년짜리 토큰을 발급한다(브라우저 승인 필요, 미실행). 모델 요청만 가능하고 claude.ai 커넥터는 못 가져오며, 로컬 MCP는 동작한다. [authentication](https://code.claude.com/docs/en/authentication) 2026-10-31
- **`--bare`는 OAuth와 `CLAUDE_CODE_OAUTH_TOKEN`을 읽지 않는다.** 이 환경에서는 exit 1, `Not logged in · Please run /login`이다(T9, R9). 이때 `subtype`은 `success`이고 `is_error`가 true다. `subtype`만 보면 틀린다.
- **미래 위험:** "`--bare` is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release." [headless](https://code.claude.com/docs/en/headless) 2026-10-31. 기본값이 바뀌면 구독 로그인 `claude -p`가 깨질 수 있어 업그레이드 전 확인이 필요하다.
- 사전 점검은 `claude auth status`로 할 수 있다(모델 호출 없음, `subscriptionType: max` 확인).

### 3.5 구독 사용량 소비

- Claude 플랜으로 로그인하면 Agent SDK와 `claude -p`는 구독 한도에서 차감된다. 2026-06-15로 예고됐던 변경은 보류됐다. [지원 문서](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) 2026-10-31
- 2026-10-07 업데이트로 Max, Ultra, Team에 월간 API 크레딧이 포함됐다. 단 연결된 Claude Console 조직의 **API 키로 실행할 때만** 적용되고, 문서에 금액은 없다. [지원 문서](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) 2026-10-31
- Max는 5시간 세션 한도와 주간 한도가 있고, Fable 주간 한도가 별도로 있다. 채팅과 Claude Code가 같은 한도를 공유한다. [지원 문서](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan) 2026-10-31
- 대규모 워크플로우 팬아웃 한 번이 주간 한도를 소진할 수 있다. [errors](https://code.claude.com/docs/en/errors) 2026-10-31
- 광고된 사용 한도는 "ordinary, individual usage"를 전제로 한다. [legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance) 2026-10-31
- 스케줄 작업은 대화형 작업과 같은 창을 쓴다. 이 조사 중에도 다른 세션이 함께 돌며 5시간 활용률이 0.11에서 0.23으로 올랐다. 낮은 우선순위 작업은 `rate_limit_event`의 활용률을 보고 미루는 구조가 필요하다.

### 3.6 헤드리스에서의 Workflow, 서브에이전트

| 질문 | 결과 | 근거 |
|---|---|---|
| Workflow 도구가 있는가 | 있다. `init.tools` 27개 중 하나 | T0 |
| 이름으로 실행 | 된다. `/probe-wf` + `Workflow(probe-wf)` | T5b |
| 경로·인자·스키마로 실행 | 된다. `scriptPath`, `args`, `--json-schema` | T5c |
| 플러그인 워크플로우 | 된다. `/kb:kb-refresh` + `Workflow(kb:kb-refresh)` | R8b |
| 허용 없이 | exit 0으로 거부 | T5a |
| 서브에이전트 | 된다. 프로젝트 정의, `--agents`, 플러그인 정의 모두 | T4, T4b, R8 |
| 워크플로우 에이전트의 hook | 프로젝트 hook 발화. `agent_type: workflow-subagent` | T5b |
| 맞춤 에이전트로 실행 | 된다. `agent(..., {agentType})` | T19, T21 |
| `subagent_stats`에 집계되는가 | **워크플로우 에이전트는 집계되지 않는다**(`spawned: 0`). `wf_*.json`을 봐야 한다 | T5b |

`--no-session-persistence`여도 `<project>/<sid>/workflows/wf_*.json`, 스크립트 사본, `journal.jsonl`, `agent-*.meta.json`은 남는다. 대화 전사 `.jsonl`만 남지 않는다(T5b). 그래서 이 플래그를 써도 워크플로우 상태 판독은 가능하다.

### 3.7 컨텍스트와 토큰 절감

요청당 컨텍스트(입력+캐시 토큰, 2.1.316, `Reply with exactly: OK` 1턴):

| 구성 | 요청당 토큰 | 도구 | 스킬 |
|---|---:|---:|---:|
| a. 기본 | 21,770 | 27 | 38 |
| b. `--strict-mcp-config` | 21,555 | 27 | 38 |
| c. b + `--setting-sources project` | 17,283 | 27 | 20 |
| d. c + `--disable-slash-commands` | 20,436 (증가, 원인 미확인) | 26 | 0 |
| e. d + `--tools "Read,Bash"` | 5,529 | 2 | 0 |
| f. `ENABLE_CLAUDEAI_MCP_SERVERS=false` | 21,770 | 27 | 38 |

a와 f가 같은 이유는 커넥터가 비동기로 붙어 첫 요청에 아직 반영되지 않기 때문으로 보인다. 다턴 작업에서 커넥터가 차지하는 양은 이 표로 알 수 없다.

워크플로우 에이전트 1개의 토큰(사소한 응답 기준):

| 에이전트 | 기본 설정 | `--tools "Workflow,Read"` + 프로젝트 전용 |
|---|---:|---:|
| 기본 `workflow-subagent` | 16,883~29,787 | 2,634 |
| 맞춤 `thin`(`tools: Read`, `omitClaudeMd: true`) | 2,359 | 2,353 |
| 기본 + Bash 1회 | 33,279 | 도구 없어 실패 |

**결정적 주의:** 메인 `--tools`는 워크플로우 에이전트의 상한이기도 하다. `--tools "Workflow,Read"`에서는 Bash가 필요한 에이전트가 "no Bash tool"이라고 답하고 끝나며 exit 0이다(T20, R20). 메인에는 하위 작업에 필요한 도구까지 모두 열어야 한다(T21은 `Workflow,Read,Bash`).

**rtk와 권한의 상호작용(지침 4):** `rtk hook claude`는 `updatedInput`만 돌려주고 `permissionDecision`을 주지 않는다. 그래서 Claude Code가 **재작성된 명령을 다시 평가**한다. 읽기 전용이라 자동 승인되던 `git status`가 `rtk git status`가 되면서 헤드리스에서 거부된다(T13a, R13). `Bash(rtk *)`를 허용하면 해결되지만(T13c) `rtk run`은 임의 명령을 실행하므로, 넓은 규칙 대신 `Bash(rtk git *)`처럼 좁히거나 샌드박스와 함께 쓴다.

### 3.8 검증된 작업 호출 형태

T21에서 전체 조합이 함께 동작함을 확인했다(exit 0, 8초, $0.0052, 판정 ok).

```sh
env -i HOME="$HOME" PATH="<node 절대경로>:$HOME/.local/bin:/usr/bin:/bin" LANG=C.UTF-8 \
  DISABLE_AUTOUPDATER=1 CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 \
  claude -p "/kb-job" \
    --setting-sources project --strict-mcp-config \
    --settings ops/job-settings.json \
    --tools "Workflow,Read,Bash" \
    --permission-mode dontAsk --permission-prompts none \
    --model haiku --max-turns 8 --max-budget-usd 2 \
    --output-format stream-json --verbose --include-hook-events
```

`ops/job-settings.json`에는 `permissions.allow`의 `Workflow(kb-job)`와 3.2의 sandbox 설정을 둔다. T21은 `--max-turns 2`, `--max-budget-usd 0.05`로 실행했다. 위의 8과 2는 실사용 초기값 제안이며 측정값이 아니다. MCP가 필요한 작업은 `--mcp-config`를 더한다(`--setting-sources project`는 사용자 플러그인을 끈다, T4f).

## 4. 스케줄 수단 비교 (확인 항목 3)

| 수단 | 실행 위치 | 세션이 꺼져도 유지 | 로컬 파일 | 원격 저장소 필요 | 최소 주기 | 근거 |
|---|---|---|---|---|---|---|
| `CronCreate` | 해당 세션 | **아니오.** 세션 전용. 재개 시 복원되지만 놓친 실행은 안 돌린다. 반복 작업 7일 만료 | 가능 | 불필요 | 1분 | [scheduled-tasks](https://code.claude.com/docs/en/scheduled-tasks) 2026-10-31, T7b, R7b |
| `/loop` | 해당 세션 | **아니오.** self-paced는 재개 시 복원 안 됨 | 가능 | 불필요 | 1분 | [scheduled-tasks](https://code.claude.com/docs/en/scheduled-tasks) 2026-10-31 |
| 클라우드 예약(구 routines, `/schedule`) | Anthropic 클라우드 | 예 | **불가**(매번 fresh clone) | **저장소를 다루려면 GitHub 필요** | 1시간 | [routines](https://code.claude.com/docs/en/routines) 2026-10-31 |
| Desktop 로컬 예약 | 내 머신 | 앱이 열려 있고 깨어 있을 때만. 7일 내 놓친 실행 1회 보충 | 가능 | 불필요 | 1분(Claude 지정), 1시간(폼) | [desktop-scheduled-tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks) 2026-10-31 |
| 호스트 스케줄러 + `claude -p` | 내 머신 | 예(호스트 조건부) | 가능 | 불필요 | 스케줄러 의존 | T21(`env -i`로 모사, 실제 타이머는 미실행) |
| `orca automations` | Orca 런타임 | 미확인 | 가능 | 불필요 | cron/RRULE | [Orca docs](https://www.onorca.dev/docs/cli/automations) 2026-10-31, 미실측 |
| GitHub Actions | GitHub 러너 | 예 | 불가 | 필요 | GitHub 의존 | [scheduled-tasks](https://code.claude.com/docs/en/scheduled-tasks) 2026-10-31, 미실측 |

세부 사실:

- `CronCreate`의 `durable` 파라미터는 현재 세션 스키마에서 "Has no effect — durable persistence is not available"로 명시돼 있다(2026-10-31 도구 스키마 확인). 문서의 `.claude/scheduled_tasks.json` 저장은 feature-flag 조회가 꺼진 경우에 한한다. [scheduled-tasks](https://code.claude.com/docs/en/scheduled-tasks) 2026-10-31
- `-p`에서 `CronCreate`는 성공해도 프로세스가 곧 끝나므로 의미가 없다. 결과 문구가 "Session-only (not written to disk, dies when Claude exits)"이고 4초 만에 종료됐다(T7b, R7b).
- 실행 지터: 반복 작업은 주기의 절반까지, 최대 30분 늦게 시작한다. [scheduled-tasks](https://code.claude.com/docs/en/scheduled-tasks) 2026-10-31
- 클라우드 예약은 연구 프리뷰이고 이름이 routines에서 scheduled tasks로 바뀌었다(`/routines` 별칭, `claude.ai/code/routines`, `/fire` API에는 옛 이름이 남음). Pro, Max, Ultra, Team, Enterprise에서 쓸 수 있고 실행은 구독 사용량을 쓴다. [routines](https://code.claude.com/docs/en/routines) 2026-10-31
- 클라우드 예약 한도: 예약 실행 시간당 100회(계정), Run now와 API는 작업당 시간당 30회. [routines](https://code.claude.com/docs/en/routines) 2026-10-31
- 클라우드 기본 네트워크 Trusted 허용 목록은 204개 항목이고 `*.googleapis.com`, `accounts.google.com`은 있지만 `suggestqueries.google.com`, `www.youtube.com`은 없다. 수집에 쓰려면 Custom 설정이 필요하다. [cloud-environments](https://code.claude.com/docs/en/cloud-environments) 2026-10-31
- 클라우드 실행은 auto 모드로 시작하고, 예약 프롬프트는 사용자 승인으로 취급되지 않는다. [routines](https://code.claude.com/docs/en/routines) 2026-10-31
- 2.1.314부터 Anthropic 클라우드 실행은 claude.ai 계정에 활성화된 플러그인을 로드한다. [changelog](https://code.claude.com/docs/en/changelog) 2026-10-31
- 이 계정의 예약 API는 응답한다. `RemoteTrigger list` 결과는 HTTP 200, 빈 목록이다(2026-10-31 실측). 이 저장소는 `git remote` 없음, 커밋 없음이다.
- `--bg`(agent view)는 터미널 없이 돌지만 스케줄러가 아니다. 머신 종료 시 멈추고, trust 없는 폴더에서 스크립트로 실행하면 `Workspace not trusted`로 exit 1이다(T10). 연구 프리뷰다. [agent-view](https://code.claude.com/docs/en/agent-view) 2026-10-31
- `orca automations create`는 `--trigger`(프리셋, cron, RRULE), `--provider claude`, `--precheck`, `--missed-run-grace-minutes`, `--workspace-mode`, `--reuse-session`을 받는다(2026-10-31 CLI 도움말). 공식 문서는 Orca가 꺼져 있을 때의 동작을 밝히지 않는다. 3자 분석은 프로세스 내부 60초 타이머라고 주장한다. [BenchKeeper #461](https://github.com/ESchuderer/BenchKeeper/issues/461) 2026-10-31, 미검증.

**적용 판단:** 수집 ETL은 호스트 스케줄러로 돌린다(지침 6의 "데이터가 죽지 않도록"은 세션과 분리된 실행을 요구한다). 클라우드 예약은 로컬 저장소에 쓸 수 없어 주 수단이 될 수 없고, 저장소를 GitHub에 올린 뒤 생존 감시용 보조 수단으로만 검토할 수 있다. 호스트 쪽 설계(`Linger=no` 해소, WSL2 기동)는 이 보고서 범위 밖이며 사용자 승인이 필요한 변경이다.

## 5. Hook (확인 항목 4)

### 5.1 서브에이전트 적용과 병합

- 프로젝트 `settings.json`의 hook은 서브에이전트 안에서도 발화하고, 입력에 `agent_id`, `agent_type`이 붙는다. [hooks](https://code.claude.com/docs/en/hooks) 2026-10-31, 실측 T4(`agent_type: probe`), T5b(`workflow-subagent`)
- 설정 수준 간 hook은 교체가 아니라 **병합**된다. 일치하는 hook은 병렬로 실행되고, 같은 핸들러는 1회만 실행된다. [hooks](https://code.claude.com/docs/en/hooks) 2026-10-31
- 실측(T4): 사용자 Orca hook + 프로젝트 hook에서 `hook_started`가 SessionStart 2, PreToolUse 4(도구 2개 × 2개 출처), PostToolUse 4, SubagentStart 2, SubagentStop 2, Stop 2였다. 프로젝트 hook이 없는 UserPromptSubmit은 1이다.
- 중복 제거 실측(T4g): 같은 핸들러를 `--settings`와 프로젝트에 넣어도 1회 실행됐다.
- 사용자 hook과 프로젝트 hook은 둘 다 돈다. 한쪽만 끄려면 `--setting-sources`로 소스를 빼야 하고, 전체를 끄려면 `--settings '{"disableAllHooks":true}'`를 쓴다. 개별 hook만 끄는 방법은 없다. [hooks](https://code.claude.com/docs/en/hooks) 2026-10-31, 실측 T4f
- 프로젝트 hook은 trust 없는 `-p`에서도 실행된다. 신뢰하지 않는 저장소에 `-p`를 돌리면 그 저장소의 hook이 실행된다는 뜻이다. [hooks](https://code.claude.com/docs/en/hooks) 2026-10-31
- 서브에이전트 프런트매터 hook은 그 에이전트 실행 중에만 유효하고 `Stop`은 `SubagentStop`으로 변환된다. `SubagentStop`은 `agent_transcript_path`와 `last_assistant_message`를 준다. [hooks](https://code.claude.com/docs/en/hooks) 2026-10-31
- 플러그인 hook은 `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`를 받고, MCP 도구 matcher는 `mcp__plugin_<plugin>_<server>__<tool>` 전체 이름이어야 한다. [plugins/components](https://code.claude.com/docs/en/plugins/components) 2026-10-31, 실측 T8(`plugin-hook.log` 기록)

### 5.2 Orca 전역 hook과의 관계

- 전역 settings의 hook은 15개 이벤트에 걸려 있고 전부 `timeout: 10`이다. PostCompact를 제외한 14개는 같은 긴 명령이다(2026-10-31 설정 판독).
- `~/.orca/agent-hooks/claude-hook.sh`를 읽어 보면, `ORCA_AGENT_HOOK_PORT`, `ORCA_AGENT_HOOK_TOKEN`, `ORCA_PANE_KEY`가 없으면 `{}`만 출력하고 끝난다. `CLAUDE_JOB_DIR`이 있어도 일찍 끝난다. 차단 결정을 내지 않는다.
- 비-Orca 환경 비용은 hook 1회당 평균 7 ms다(20회 측정). 다만 도구 호출마다 프로세스를 만들고 `--setting-sources project`로 제거할 수 있다.
- 주의: Orca 패널에서 시작한 프로세스는 `ORCA_*`를 상속한다. 그 안에서 `claude -p`를 그대로 띄우면 hook이 `127.0.0.1`로 이벤트를 보내 해당 패널 상태에 섞일 수 있다(스크립트 판독, 실측 안 함). 스케줄 호출은 `env -i`로 분리한다.

## 6. 패키징: 사용자 범위 MCP와 플러그인 (확인 항목 5)

현재 환경: `sagae` 마켓플레이스는 `github: sagaeforge/sagae-claude-plugins`, `autoUpdate: true`이고 `proxmox@sagae`가 사용자 범위로 설치돼 있다. 마켓플레이스 항목은 상대경로 소스이고 `version`이 없어 커밋 SHA가 버전이다(`2f2ecbf73dc0`). `.mcp.json`은 `${CLAUDE_PLUGIN_ROOT}/server/index.mjs`를 쓴다. 사용자 범위 `mcpServers`는 비어 있다.

| 기준 | 사용자 범위 MCP | 플러그인 |
|---|---|---|
| 저장 위치 | `~/.claude.json` | 마켓플레이스 저장소, `~/.claude/plugins/cache/...` |
| 제공 요소 | 도구만 | MCP, 스킬, 서브에이전트, 워크플로우, hook |
| 버전 관리 | 없음(머신 로컬) | 커밋 SHA 또는 `version` |
| 도구 이름 | `mcp__kb__kb_ping` (T8c) | `mcp__plugin_kb_kb__kb_ping` (R8) |
| 다른 프로젝트에서 동작 | 가능 | 가능, 전 구성요소 확인 (R8, R8b) |
| 상시 비용 | 도구 검색으로 지연 | 설명 토큰 상시 부담. proxmox 예 ~126 tok, 호출 시 ~520 tok(`claude plugin details`) |
| 갱신 | 수동 | `claude plugin update`, 대화형 세션 자동 갱신 |
| 동일 명령 중복 시 | 우선 | 후순위(로컬 > 프로젝트 > 사용자 > 플러그인 > 커넥터) |

출처: [mcp](https://code.claude.com/docs/en/mcp), [plugins/overview](https://code.claude.com/docs/en/plugins/overview), [plugins/components](https://code.claude.com/docs/en/plugins/components), [plugins/loading](https://code.claude.com/docs/en/plugins/loading) 2026-10-31

**적용 판단: 플러그인이 맞다.** 이 저장소의 역할은 "다른 세션에 정보를 반환"이고, 그러려면 도구뿐 아니라 언제 어떻게 조회할지 알려 주는 스킬이 함께 가야 한다. 사용자 범위 등록은 스킬이 빠지고 재현성이 없다. 이미 같은 형태의 proxmox 선례가 있다.

설계에 반영할 사실:

- **MCP 서버의 cwd는 호출 프로젝트다.** 실측 응답은 `cwd`와 `CLAUDE_PROJECT_DIR`가 호출 프로젝트, `KB_ROOT`만 플러그인 경로였다(R8). 데이터 경로는 절대경로로 받아야 한다. 수단은 `userConfig`, `${user_config.*}`, 또는 proxmox처럼 코드 기본값이다. [plugins/components](https://code.claude.com/docs/en/plugins/components) 2026-10-31
- **플러그인 코드를 설치 경로에 상태로 두면 안 된다.** `${CLAUDE_PLUGIN_ROOT}`는 버전마다 바뀌고, 유지되는 곳은 `${CLAUDE_PLUGIN_DATA}`다. [plugins/components](https://code.claude.com/docs/en/plugins/components) 2026-10-31
- **stdio 서버는 세션마다 뜬다.** 동시 세션 수만큼 프로세스가 생기므로 DB가 다중 읽기를 허용해야 한다. 문제가 되면 호스트의 단일 HTTP MCP로 바꿀 수 있다. 플러그인 `.mcp.json`은 HTTP도 지원한다. [plugins/overview](https://code.claude.com/docs/en/plugins/overview), [mcp](https://code.claude.com/docs/en/mcp) 2026-10-31
- **서버 기동 실패는 15분간 캐시된다.** 세션은 도구 없이 계속되고 `-p`는 exit 0이다. 첫 시험(T0)에서 PATH에 nvm의 `node`가 없어 `plugin:proxmox:proxmox`가 `failed`가 됐고, node를 PATH에 넣어도 15분 동안 `failed`였다. 창이 지나자 293 ms에 연결됐다(T18). [errors](https://code.claude.com/docs/en/errors) 2026-10-31. 기록은 `~/.claude/mcp-needs-auth-cache.json`으로 보인다(T0 시각에 항목이 생겼고 연결 성공 뒤 사라졌다). 이후 프로세스에서도 `failed`가 유지됐으므로 프로세스 간에 공유된다. 스케줄 PATH는 반드시 고정한다. `command: "node"`처럼 PATH에 의존하는 선언은 스케줄 환경의 약점이다.
- **의존성:** 마켓플레이스 설치는 Node.js 의존성만 자동 설치한다. Python 서버는 별도 처리가 필요하다. [plugins/loading](https://code.claude.com/docs/en/plugins/loading) 2026-10-31. 이 환경의 시스템 Python은 `ensurepip`이 없고 uv도 기본 PATH에 없다.
- **자동 갱신은 대화형 세션에서만 돈다.** `-p`만 도는 경로는 플러그인이 갱신되지 않는다. [plugins/loading](https://code.claude.com/docs/en/plugins/loading) 2026-10-31
- **개발 경로:** `--plugin-dir`는 설치 없이 제자리 로드한다. 로컬 경로 마켓플레이스의 상대경로 플러그인도 제자리 로드되어 버전을 올릴 필요가 없다. [plugins/loading](https://code.claude.com/docs/en/plugins/loading) 2026-10-31
- **배치:** `sagae-claude-plugins`에 proxmox처럼 상대경로로 넣으면 이 저장소가 GitHub에 없어도 된다. 코드와 데이터가 분리된다.
- 검증 도구: `claude plugin validate`(T8 통과), `claude plugin details`, `claude plugin eval`. [plugin-evals](https://code.claude.com/docs/en/plugin-evals) 2026-10-31

**다른 경로와의 비교:** 교차 세션 메시징은 살아 있는 세션 사이의 평문 전달이고 메시지 약 100만 자 제한이 있다. `-p` 세션도 수신 가능하지만 무인 수신에는 `crossSessionInbound: accept`가 필요하다. [cross-session-messaging](https://code.claude.com/docs/en/cross-session-messaging) 2026-10-31. 질의 응답의 기본 경로로는 항상 떠 있는 세션이 필요해 적합하지 않고, 작업 완료 통지 같은 관제 용도에 맞다.

## 7. 세션 전사와 자가 개선 지표 (확인 항목 6)

### 7.1 어디에 무엇이 있나

- 경로: `~/.claude/projects/<project>/<session>.jsonl`. 서브에이전트는 `<session>/subagents/`, 큰 도구 출력은 `<session>/tool-results/`에 있다. [claude-directory](https://code.claude.com/docs/en/claude-directory) 2026-10-31
- **보존은 기본 30일이고 삭제는 메시지 없이 진행된다.** `cleanupPeriodDays`는 0이 허용되지 않으며 큰 값으로 늘릴 수 있다. [settings-reference](https://code.claude.com/docs/en/settings-reference) 2026-10-31
- 전사에는 파일 내용, 명령 출력, 시스템 프롬프트와 도구 정의가 평문으로 들어 있다. 민감 정보가 섞일 수 있으므로 원문 복제가 아니라 지표만 적재한다. [claude-directory](https://code.claude.com/docs/en/claude-directory) 2026-10-31
- 현재 규모: 40개 파일, 약 54 MB(하위 23개가 서브에이전트, 2026-10-31 측정).

### 7.2 지표 소스

| 지표 | 소스 | 필드 |
|---|---|---|
| 토큰 | 전사 `assistant.message.usage` | `requestId`로 중복 제거, `output_tokens` 최댓값 유지 |
| 도구 호출 | 전사 `assistant.message.content[]` | `tool_use.name`, `id` |
| 도구 실패 | 전사 `user.message.content[]` | `tool_result.is_error`, `tool_use_id`로 도구 매핑 |
| 권한 거부 | 전사, `result` | `toolDenialKind`, `permission_denials` |
| 작업 결과 | `result` 이벤트 | `terminal_reason`, `total_cost_usd`, `modelUsage`, `subagent_stats`, `safety_stops` |
| 워크플로우 | `<session>/workflows/wf_*.json` | `status`, `agentCount`, `durationMs`, `workflowProgress[].{tokens,toolCalls,attempt,state}` |
| 워크플로우 에이전트 결과 | `subagents/workflows/wf_*/journal.jsonl` | `started`, `result`, `toolsUsed` |
| 플랜 활용률 | `rate_limit_event` | `unifiedWindows.{five_hour,seven_day}.utilization` |
| 스킬·플러그인 귀속 | 전사 assistant 레코드 | `attributionSkill`, `attributionPlugin`, `attributionMcpServer`, `attributionMcpTool` |
| 헤드리스 구분 | 전사 공통 | `entrypoint`: 대화형 `cli`, `-p`는 `sdk-cli` (T19) |

중복 제거 규칙은 공식 `session-report`의 `analyze-sessions.mjs` 주석과 같다. 한 API 호출이 content block마다 한 줄씩 기록되고 마지막 줄만 최종 `output_tokens`를 갖는다(2026-10-31 판독).

`result.usage`는 메인 루프만 포함하므로 합산에는 `modelUsage`를 쓴다. [agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript) 2026-10-31

### 7.3 교차 검증

같은 표본(16개 파일, 35.6 MB, 6,145행)에 표준 라이브러리 Python 54행의 자체 추출기와 ccusage 20.0.46을 돌렸다.

| 항목 | 자체 추출 | ccusage |
|---|---:|---:|
| input | 858 | 858 |
| output | 1,353,943 | 1,353,943 |
| cache write | 4,161,077 | 4,161,077 |
| cache read | 73,089,335 | 73,089,335 |
| 소요 | 0.13초 | 0.049초 |

**토큰 합계가 전 항목 일치한다.** 자체 추출기는 추가로 API 요청 406건, 도구 호출 902건, 실패 47건(Bash 45건), 실패 유형 분포, 거부 1건을 뽑았다. ccusage는 도구 실패를 다루지 않는다.

### 7.4 방식 비교

| 방식 | 장점 | 한계 |
|---|---|---|
| 전사 ETL | 진실의 원천. 설정 변경 불필요. 비용 없음 | 스키마가 비공식이라 변할 수 있음. 30일 창 안에 적재 필요 |
| `result` 스트림 보관 | 작업 단위 판정과 직결. 공식 메시지 타입 | 스케줄 작업에만 있음 |
| hook 수집(`PostToolUse`, `SubagentStop`) | 실시간, 서브에이전트 구분 | 전역 적용은 사용자 settings 변경 필요 |
| OTel(`CLAUDE_CODE_ENABLE_TELEMETRY=1`) | 공식 지표와 이벤트. `api_request`, `tool_result`, `subagent_completed` 등 | OTLP 수신기가 필요한데 이 환경에 docker가 없음 [monitoring-usage](https://code.claude.com/docs/en/monitoring-usage) 2026-10-31 |

**적용 판단:** 주기적 전사 ETL + 작업별 `result` 보관으로 시작한다. 둘 다 LLM 호출이 없고 전역 설정을 바꾸지 않는다. `session-report`와 `/insights`는 HTML 리포트를 만들므로 지침 5에 따라 지식 저장소에 넣지 않고, 필요할 때 사람이 보는 도구로만 둔다. [commands](https://code.claude.com/docs/en/commands) 2026-10-31. OTel은 수신기가 생기면 재검토한다.

## 8. 후보 표

버전과 날짜는 2026-10-31 GitHub API, npm, PyPI 조회값이다.

### 8.1 실행과 오케스트레이션

| 후보 | 최신 버전 | 릴리스 날짜 | 유지보수 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---:|---|---|
| Claude Code CLI | 2.1.316 (착수 시 2.1.314) | 2026-10-31 (2.1.314: 10-30) | 거의 매일 릴리스 | 상용 약관 | 필수 기반 | 자동 업데이트, `--bare` 기본화 예고 |
| `claude -p` + 저장 워크플로우 | 내장 | 위와 동일 | 활발 | 위와 동일 | **높음.** T21 검증 | exit 코드 불신, 10분 상한, 허용 규칙 필수 |
| 서브에이전트 | 내장 | 위와 동일 | 활발 | 위와 동일 | 높음 | 프런트매터 hook은 trust 필요 |
| 에이전트 팀 | 내장 | 위와 동일 | 실험 | 위와 동일 | 대화형만 | `-p` 불가 |
| `--bg`/agent view | 내장 | 위와 동일 | 연구 프리뷰 | 위와 동일 | 낮음 | 스케줄러 아님, 머신 종료 시 정지 |
| `CronCreate`, `/loop` | 내장 | 위와 동일 | 활발 | 위와 동일 | 세션 내 폴링만 | 세션 전용, 7일 만료 |
| 클라우드 예약 | 서비스(버전 없음) | 2026-10-31 문서 확인 | 연구 프리뷰 | 상용 약관 | 낮음(현 상태) | GitHub 원격 없음, 로컬 파일 불가, 1시간 주기 |
| Desktop 로컬 예약 | Desktop 1.1.5368 이상 요구 | 미확인 | 활발 | 상용 약관 | 낮음 | 앱 상시 실행 필요, 설치 여부 미확인 |
| Orca automations | Orca 1.4.245 | 2026-10-30 | 활발 | MIT | 중간, 미실측 | 런타임 요구 미확인, 대화형 세션 기반 |
| Agent SDK Python | 0.2.176 | 2026-10-31 | 활발 | MIT | 중간, 미실측 | `claude -p`로 충분, 추가 의존성 |
| Agent SDK TS | 0.3.316 | 2026-10-31 | 활발 | README 참조 | 중간, 미실측 | 위와 동일 |
| claude-code-action | v1 | 2025-08-26 (저장소 push 2026-10-31) | 활발 | MIT | 낮음 | 러너에 로컬 데이터 없음, 원격 필요 |

### 8.2 공유 패키징

| 후보 | 최신 버전 | 릴리스 날짜 | 유지보수 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|---|
| 플러그인(`kb@sagae` 안) | 커밋 SHA | 해당 없음 | 사용자 관리 | 사용자 관리 | **높음.** R8, R8b, 선례 있음 | Python 의존성 처리, 데이터 절대경로 |
| 사용자 범위 MCP | 내장 | 위 CLI와 동일 | 활발 | 상용 약관 | 중간. 개발 초기에만 | 스킬 없음, 재현성 없음, `~/.claude.json` 변경 |
| 프로젝트 `.mcp.json` | 내장 | 위 CLI와 동일 | 활발 | 상용 약관 | 저장소 내부 작업용 | 다른 프로젝트에서 안 보임 |

### 8.3 지표와 전사 분석

| 후보 | 최신 버전 | 릴리스 날짜 | 유지보수 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|---|
| 자체 추출기(표준 라이브러리) | 해당 없음 | 해당 없음 | 자체 | 자체 | **높음.** 일치 검증됨 | 비공식 스키마 변화 추적 |
| ccusage | 20.0.46 | 2026-10-30 | 활발 | npm은 MIT, GitHub 메타 NOASSERTION | 높음. 교차 검증용으로 실측 | 도구 실패 지표 없음, npm 패키지 |
| session-report (공식 플러그인) | 마켓플레이스 커밋 | 미확인 | 공식 | LICENSE 포함 | 로직 참고용 | HTML 산출, 지침 5와 충돌 |
| `/insights` | 내장 | 위 CLI와 동일 | 활발 | 상용 약관 | 낮음 | HTML 리포트, 대화형 |
| OTel 내장 | 내장 | 위 CLI와 동일 | 활발 | 상용 약관 | 낮음(현재) | 수신기 필요, docker 없음 |
| agentsview | v0.46.1 | 2026-10-23 | 활발 (`kenn-io/agentsview`로 이동) | MIT | 미실측 | 분석 앱, 저장소 역할과 중복 |
| tokscale | 저장소 push 2026-10-30 | 미확인 | 활발 | MIT | 미실측 | ccusage와 중복 |
| claude-code-log | 1.7.0 | 2026-10-05 | 유지 | MIT | 미실측 | HTML 변환 중심 |
| claude-code-transcripts | 0.6 | 2026-01-25 | 둔화 | Apache-2.0 | 미실측 | 게시 도구 |
| claude-devtools | 저장소 push 2026-09-26 | 미확인 | 활발 | MIT | 미실측 | GUI |
| Claude-Code-Usage-Monitor | 저장소 push 2026-07-05 | 미확인 | 둔화 | MIT | 미실측 | `rate_limit_event`로 대체 가능 |
| sniffly | 저장소 push 2025-08-08 | 미확인 | **정체** | MIT | 부적합 | 1년 이상 미갱신 |
| claude-code-otel | 저장소 push 2025-06-17 | 미확인 | **정체** | MIT | 부적합 | 미갱신, docker 전제 |

## 9. 권고 구성(안)

```
.claude/
  settings.json        프로젝트 hook(rtk 등), deny 규칙
  agents/              worker 정의: tools 최소, omitClaudeMd, maxTurns
  skills/              저장소 내부 절차
  workflows/           kb-*.js 저장 워크플로우
ops/
  job-settings.json    --settings용: Workflow(name) 허용, sandbox
```

- **계층 분리:** 결정적인 수집과 적재는 LLM 없이 스크립트로 돌리고, 판단이 필요한 단계만 `claude -p` 워크플로우로 넘긴다. 에이전트 1개의 최소 비용이 2,400토큰, 기본값이면 수만 토큰이고 구독 창을 대화형 작업과 공유하기 때문이다.
- **허용 규칙은 `.claude/settings.json`이 아니라 `--settings`로:** worktree는 메인 체크아웃의 trust를 쓰지만 새 클론은 trust가 없다.
- **버전 고정:** 작업 환경에 `DISABLE_AUTOUPDATER=1`을 둔다. 이번 측정 중 실제로 버전이 바뀌었다. 업그레이드는 changelog에서 `--bare`와 `-p` 기본값 변경을 확인한 뒤 수동으로 한다.
- **스케줄러 쪽 사전 검사:** `claude auth status`, `rate_limit_event` 활용률, `mcp_servers.status`.
- **재시도:** 작업 재시도는 우리 쪽 적재 상태(멱등 키)를 기준으로 하고, `--resume`은 비용이 큰 워크플로우에만 쓴다. 재개하려면 세션이 저장돼 있어야 한다.
- **전사 보존:** 전사 ETL 주기를 30일보다 충분히 짧게 둔다. `cleanupPeriodDays` 상향은 전역 설정 변경이므로 사용자 승인 사항이다.

## 10. 제약과 미확인

### 10.1 실측으로 드러난 제약

1. exit 0은 성공을 뜻하지 않는다. 권한 거부(T3), 워크플로우 거부(T5a), 예산 중단(R12), 대기 상한 중단(T22e), 도구 부재(R20)가 모두 exit 0이다.
2. exit 1도 실패를 뜻하지 않는다. R19는 워크플로우가 `completed`였다.
3. `subtype: success`는 `is_error: true`와 함께 나올 수 있다(T9, R9).
4. 기본 대기 상한 10분이 `-p` 워크플로우를 멈춘다(T22e는 15초 상한으로 재현, 10분 실측은 아님).
5. API 키가 없어 `--bare`가 불가능하다(T9, R9).
6. trust 없는 폴더에서 프로젝트 `permissions.allow`가 무시된다(T4d). 프런트매터 hook도 무시된다(T4).
7. `CronCreate`는 `-p`에서 프로세스와 함께 사라진다(T7b, R7b).
8. `--tools`는 워크플로우 에이전트의 상한이다(T20, R20).
9. 플러그인 stdio MCP 실패는 15분 캐시되고 세션은 계속된다(T0, T18). nvm의 node는 `env -i` PATH에 없다.
10. rtk 재작성은 헤드리스 권한 평가를 바꾼다(T13a, R13).
11. deferred 도구는 턴을 하나 더 쓴다(T8c).
12. 자동 업데이트가 측정 도중 바이너리를 바꿨다(2.1.316 설치 15:25 KST, T8부터 적용).
13. 이 저장소는 원격과 커밋이 없어 클라우드 예약을 붙일 수 없다.

### 10.2 미확인

- 실제 사용량 한도 도달 시 `-p`의 exit 코드와 `terminal_reason`(문서상 후보 `blocking_limit` 등, 미재현).
- `total_cost_usd`와 실제 플랜 차감의 관계. `costBasis: "list"`만 확인했다.
- 구독 OAuth의 무인 장기 갱신. 현재 로그인 수명과 `-p`에서의 자동 갱신 주기는 측정하지 않았다(자격증명 파일은 열지 않음).
- `CLAUDE_CODE_OAUTH_TOKEN` 경로. `claude setup-token`이 브라우저를 요구해 미실행.
- 어느 세션이 자동 업데이트를 일으켰는지. `-p`도 시작 시 업데이트를 확인한다는 문서가 있지만 특정하지 못했다.
- 이 머신의 trust 승인 폴더에서 프로젝트 `permissions.allow`가 실제로 적용되는지. 저장소에 시험 파일을 둘 수 없어 문서로만 확인했다.
- `orca automations`의 런타임 요구와 놓친 실행 처리.
- Desktop 앱 설치 여부.
- 실제 수집 규모에서의 워크플로우 스톨, 메모리, 동시 실행 동작.
- 구성 d(`--disable-slash-commands`)에서 컨텍스트가 늘어난 이유.
- 클라우드 예약의 실제 실행. `RemoteTrigger list`만 호출했다.
- 호스트 스케줄러 쪽 동작(`Linger=no`, WSL2 유휴 종료). 이 조사 범위 밖이고 실행하지 않았다.

## 11. 조사가 남긴 부수효과

금지 항목(저장소, `~/.claude` 설정, crontab, systemd, 셸 프로필)은 변경하지 않았다. 종료 시 `settings.json` 해시(`c5a2bc42c0dd0647`)와 `~/.claude.json`의 프로젝트 목록 4개는 시작 때와 같고, 사용자 범위 MCP와 crontab도 변함없다. 다음은 `claude -p` 실행에 따라온 변화다.

| 대상 | 내용 | 상태 |
|---|---|---|
| `~/.claude/mcp-needs-auth-cache.json` | T0의 PATH에 node가 없어 `plugin:proxmox:proxmox` 실패 항목이 06:20:11Z에 기록됨. 이후 15분간 새 세션이 proxmox MCP 연결을 건너뛰었을 수 있다 | 06:35Z 이후 재연결 성공으로 자동 삭제. 파일을 손으로 고치지 않았다 |
| `~/.local/bin/claude` | 측정 중 2.1.314에서 2.1.316으로 자동 업데이트 | 유지. 어느 세션이 일으켰는지 미확인 |
| `~/.claude/projects/-tmp-...-harness-p{0,2,4,6,7,9,10}` | 시험 프로젝트의 세션 데이터 | 남겨 둠. 30일 후 자동 삭제 |
| `~/.claude/plugins/data/kb-inline/` | `--plugin-dir` 시험이 만든 빈 디렉터리 | `rmdir`로 제거함 |
| rtk 사용 기록 | T13c 실행분이 `rtk gain` 집계에 포함될 수 있다 | 유지 |
| 스크래치의 전사 표본 사본 | ccusage 교차 검증용 | 삭제함 |
| 구독 사용량 | `claude -p` 62회, 추정 $0.26 상당 | 소비됨 |

## 부록 A. 실측 기록

공통: `cc`는 `env -i HOME PATH=<nvm>:<bun>:~/.local/bin:/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 TERM=dumb CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude`다. T0만 PATH에 nvm과 bun이 없고 auto memory 변수도 없다. R 계열은 `~/.local/share/claude/versions/2.1.314`를 직접 실행하고 `DISABLE_AUTOUPDATER=1`을 더했다. 별도 표기가 없으면 `--model haiku --no-session-persistence`다. 실행 시각은 2026-10-31 06:20~06:45Z다.

| ID | 버전 | 명령 요지 | 결과 |
|---|---|---|---|
| T0 | 2.1.314 | `cc -p "Reply with exactly: OK" --max-turns 1 --max-budget-usd 0.25 --output-format stream-json --verbose --include-hook-events` | exit 0, 2.8초. tools 27, skills 38, plugins 6. `apiKeySource: none`, `permissionMode: default`. proxmox MCP `failed`. 캐시 쓰기 10,946, 읽기 11,607. $0.0023 |
| T1 | 2.1.314 | `-p "Use the Read tool..." --max-turns 1 --output-format json` | exit 1, `error_max_turns`, `terminal_reason: max_turns` |
| T1b | 2.1.314 | 위 + `--max-turns 2` | exit 0, `success` |
| T2 | 2.1.314 | `--max-turns 1 --max-budget-usd 0.0001` | exit 1, `error_max_budget_usd`, `budget_exhausted`. 실제 $0.00174 |
| T3 | 2.1.314 | 기본 모드 `touch` 요청, `--max-turns 2` | exit 0, `success`, `completed`, `permission_denials` 1건, 파일 없음 |
| T3b | 2.1.314 | 위 + `--permission-prompts none` | exit 0, 거부 1건, 재시도 없음 |
| T3c | 2.1.314 | `--permission-mode dontAsk --allowedTools "Bash(touch *)"` | exit 0, 거부 0, 파일 생성 |
| T4 | 2.1.314 | 프로젝트 hook + `.claude/agents/probe.md`, 프롬프트로 서브에이전트 호출, `--max-turns 2` | exit 0. hook.log 9행, Bash 호출에 `agent_id`, `agent_type: probe`. 프런트매터 hook 미발화. stderr `Ignoring 1 permissions.allow entry...` |
| T4b | 2.1.314 | `--agents '<JSON + hooks>'` | exit 0, 프런트매터 hook 발화 |
| T4d | 2.1.314 | 프로젝트 `Bash(touch project-allow-*)` 허용, trust 없음 | exit 0, 거부 1건, 파일 없음 |
| T4e | 2.1.314 | `--settings job-settings.json`으로 같은 종류 허용 | exit 0, 거부 0, 파일 생성 |
| T4f | 2.1.314 | `--setting-sources project` | 이벤트당 hook 1회, plugins 3(내장), mcp 0, skills 22 |
| T4g | 2.1.314 | 같은 핸들러를 `--settings`와 프로젝트에 등록 | PreToolUse 1회 |
| T5a | 2.1.314 | `cc -p "/probe-wf" --max-turns 2` | exit 0, `success`, 거부 `Workflow`, `Review dynamic workflow before running` |
| T5b | 2.1.314 | 위 + `--allowedTools "Workflow(probe-wf)"` | exit 0, 8초, `result` 2개, `workflow-subagent`, `subagent_stats.spawned: 0`, $0.0093 |
| T5c | 2.1.314 또는 2.1.316(교체 시점) | `scriptPath`, `args`, `--allowedTools Workflow`, `--json-schema` | exit 0, `structured_output.wf_result`에 `{"r":{"v":"path-ok"},"args":{"topic":"youtube"}}` |
| T7b | 2.1.316 | `--tools CronCreate --allowedTools CronCreate` | exit 0, 4초, `Session-only (not written to disk, dies when Claude exits)` |
| R7b | 2.1.314 | 같음 | exit 0, 같은 문구 |
| T8 | 2.1.316 | 다른 프로젝트에서 `--plugin-dir <kb-plugin>`, `kb:kb-reader` 호출 | exit 0, $0.0076. 스킬, 에이전트, 워크플로우, MCP, hook 모두 동작 |
| R8 | 2.1.314 | 같음 | exit 0. `plugin:kb:kb` connected, 서버 cwd는 호출 프로젝트 |
| T8b, R8b | 2.1.316, 2.1.314 | `-p "/kb:kb-refresh" --allowedTools "Workflow(kb:kb-refresh)"` | exit 0, 플러그인 워크플로우 완주 |
| T8c | 2.1.316 | `--mcp-config mcp-kb.json --allowedTools mcp__kb__kb_ping --max-turns 2` | exit 1, `error_max_turns`. `ToolSearch` → 도구 → 응답 |
| T9 | 2.1.316 | `cc --bare -p ...` | exit 1, `Not logged in · Please run /login`, `subtype: success`, `is_error: true`, `api_error`, 비용 0, 89 ms |
| R9 | 2.1.314 | 같음 | 같은 결과 |
| T10 | 2.1.316 | trust 없는 폴더에서 `cc --bg "..."` | exit 1, `Workspace not trusted...` |
| C.a~f | 2.1.316 | 3.7 표의 플래그 조합, `--max-turns 1` | 3.7 표 |
| T11 | 2.1.316 | 세션 저장 실행 후 `-p --resume <sid>`로 `scriptPath`, `resumeFromRunId` 재실행 | exit 0, 12 ms, 서브에이전트 토큰 0 |
| R11 | 2.1.314 | 같음 | exit 0, 8 ms, `total_tokens: 0` |
| T12 | 2.1.316 | 순차 에이전트 6개, `--max-budget-usd 0.012` | exit 0, `success`, `completed`, 작업 `killed`/`stopped`, 4번째 진행 중 중단, $0.0133 |
| R12 | 2.1.314 | 같음 | 같은 결과, 5번째 진행 중 중단, $0.0133 |
| T13a | 2.1.316 | 프로젝트 hook `rtk hook claude`, 서브에이전트가 `git status --short` | exit 0, `This command requires approval` |
| R13 | 2.1.314 | 같음 | 같은 결과, 거부 1건 |
| T13b | 2.1.316 | 워크플로우 에이전트에서 같은 명령 | exit 0, 차단됨(hook이 워크플로우 에이전트에도 적용) |
| T13c | 2.1.316 | 위 + `--allowedTools "Bash(rtk *)"` | exit 0, 거부 0, 정상 출력 |
| T14 | 2.1.316 | `--permission-mode auto --permission-prompts none --strict-mcp-config` | exit 0, 파일 생성 |
| R14 | 2.1.314 | 같음 | 같은 결과, $0.0021 |
| T15, R15 | 2.1.316, 2.1.314 | `--settings sb.json`(sandbox), `touch inside.txt; touch ~/.cache/...` | exit 0, 거부 0. cwd 쓰기 성공, 밖은 `Read-only file system` |
| T17 | 2.1.316 | `name: worker1`을 준 서브에이전트 | `task_type: local_agent`, 팀 도구 없음 |
| T18 | 2.1.316 | 캐시 만료 후 node PATH 포함 실행 | proxmox `connected`, 293 ms, 캐시 항목 삭제 |
| T19 | 2.1.316 | `/cmp`, 기본 설정 | exit 0, $0.0152. default 29,787, thin 2,359, needs-bash 33,279. `entrypoint: sdk-cli` |
| R19 | 2.1.314 | 같음 | **exit 1**, `error_max_turns`, 그러나 워크플로우 `completed`. default 16,883, thin 2,359, needs-bash 33,279 |
| T20 | 2.1.316 | `--tools "Workflow,Read" --setting-sources project --strict-mcp-config` | exit 0, $0.0041. 2,634 / 2,353 / 2,657, needs-bash는 Bash 없음 |
| R20 | 2.1.314 | 같음 | exit 0, $0.0018. 2,634 / 2,353 / 2,654, 같은 실패 |
| T21 | 2.1.314 | 3.8의 호출(`--max-turns 2 --max-budget-usd 0.05`) | exit 0, 8초, $0.0052. tools 3, mcp 0, `dontAsk`, 산출 파일 정상 |
| T22e | 2.1.314 | `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=15000`, 40초 걸리는 에이전트 | exit 0, 19초, `stopped`, `completed`. stderr `Background tasks still running 15s after the last turn...; stopping them.` |
| T22f | 2.1.314 | 같은 작업, 상한 `0` | exit 0, 47초, `completed`, `{"r":"slept-ok"}` |
| Hook | 해당 없음 | `env -i`로 `claude-hook.sh` 20회 | 평균 7 ms |
| Tx | 해당 없음 | 자체 추출기와 `ccusage session --json --offline`(격리 HOME) | 7.3 표. ccusage 추정 $61.33 |

T22의 초기 시도(T22, T22b, T22c, T22d)는 `sleep` 차단과 허용 규칙 불일치로 대조가 성립하지 않아 판단에서 제외했다. 다만 T22에서도 상한 초과 시 exit 0으로 중단되는 동작은 같았다.

## 부록 B. 주요 출처 (전부 2026-10-31 확인)

- 헤드리스: [headless](https://code.claude.com/docs/en/headless), [cli-reference](https://code.claude.com/docs/en/cli-reference), [agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript)
- 에이전트: [agents](https://code.claude.com/docs/en/agents), [sub-agents](https://code.claude.com/docs/en/sub-agents), [workflows](https://code.claude.com/docs/en/workflows), [agent-teams](https://code.claude.com/docs/en/agent-teams), [agent-view](https://code.claude.com/docs/en/agent-view), [skills](https://code.claude.com/docs/en/skills)
- 스케줄: [scheduled-tasks](https://code.claude.com/docs/en/scheduled-tasks), [routines](https://code.claude.com/docs/en/routines), [desktop-scheduled-tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks), [cloud-environments](https://code.claude.com/docs/en/cloud-environments)
- 권한·hook: [permissions](https://code.claude.com/docs/en/permissions), [permission-modes](https://code.claude.com/docs/en/permission-modes), [hooks](https://code.claude.com/docs/en/hooks), [sandboxing](https://code.claude.com/docs/en/sandboxing), [settings](https://code.claude.com/docs/en/settings)
- 인증·요금: [authentication](https://code.claude.com/docs/en/authentication), [costs](https://code.claude.com/docs/en/costs), [legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance), [Agent SDK와 플랜](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [Pro·Max·Ultra에서 Claude Code](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan)
- 패키징: [plugins/overview](https://code.claude.com/docs/en/plugins/overview), [plugins/components](https://code.claude.com/docs/en/plugins/components), [plugins/loading](https://code.claude.com/docs/en/plugins/loading), [plugins/host-marketplace](https://code.claude.com/docs/en/plugins/host-marketplace), [mcp](https://code.claude.com/docs/en/mcp), [cross-session-messaging](https://code.claude.com/docs/en/cross-session-messaging)
- 지표: [sessions](https://code.claude.com/docs/en/sessions), [claude-directory](https://code.claude.com/docs/en/claude-directory), [monitoring-usage](https://code.claude.com/docs/en/monitoring-usage), [settings-reference](https://code.claude.com/docs/en/settings-reference)
- 버전: [changelog](https://code.claude.com/docs/en/changelog), [setup](https://code.claude.com/docs/en/setup), [anthropics/claude-code releases](https://github.com/anthropics/claude-code/releases), [ccusage](https://github.com/ccusage/ccusage), [agentsview](https://github.com/kenn-io/agentsview), [Orca](https://github.com/stablyai/orca), [Orca automations 문서](https://www.onorca.dev/docs/cli/automations)
