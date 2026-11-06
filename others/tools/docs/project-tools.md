# 프로젝트 도구: rtk, Trail-Code

이 저장소에서 세션을 시작하면 rtk와 Trail-Code가 프로젝트 훅으로 연결된다. 등록은 `.claude/settings.json`에만 있고 전역 설정, 권한 규칙, statusLine은 건드리지 않는다. 훅 스크립트는 sagae-claude-plugins의 `foundation/tools-hooks` 브랜치(`docs/project-tools.md`)와 같은 파일이며, 동작 상세와 한계는 그 문서가 원본이다.

## 훅

| 스크립트 (`.claude/hooks/`) | 시점 | 하는 일 | 제한 시간 |
| :- | :- | :- | :- |
| `rtk-rewrite.sh` | Bash 실행 전 | `bypassPermissions` 모드, 프로젝트 루트, 진행 중 작업 없음 조건에서 옵션 없는 `git status`만 rtk로 실행한다 | 5초 |
| `trail-context.sh` | 프롬프트 제출 시 | `trail ask`가 찾은 코드 위치를 최대 3개 컨텍스트에 넣는다. 맵이 없으면 `trail build --no-reuse`로 `graft/`에 만든다 | 12초 |

- 훅은 실패해도 통과한다. 도구가 없거나 오류가 나면 아무것도 출력하지 않고 종료 코드 0으로 끝난다.
- rtk는 `~/.local/bin/rtk` 1.1.0, Trail은 `~/.local/share/trail-code/0.28.1`에 고정되어 있다. 버전이 다르면 훅은 조용히 멈춘다.
- 이미 실행 중인 세션도 훅 파일을 읽으므로 재시작 없이 적용된다(rtk는 다음 `git status`, Trail은 다음 프롬프트부터).
- Trail 맵은 `graft/`에 생기며 git에 올라가지 않는다. `graft/.cache`에는 소스 사본이 들어 있다.

## 끄기

세션 하나만: `RTK_DISABLED=1 claude`, `TRAIL_NO_HOOKS=1 claude`. 계속 끄려면 `.claude/settings.local.json`에 `{ "env": { "RTK_DISABLED": "1", "TRAIL_NO_HOOKS": "1" } }`를 둔다. 원본 출력은 `RTK_DISABLED=1 git status`.

## 하면 안 되는 것

- `trail init`, `trail mcp`, `trail upgrade`, `rtk init`, `rtk init -g`: 전역 파일을 쓰거나 고정 버전과 권한 규칙을 무너뜨린다.
- `trail note`(`--personal` 없음)가 `.trail/`을 만들면 Trail 훅이 그 체크아웃에서 멈춘다. 되돌리려면 `rm -rf .trail`.
- `Bash(rtk:*)`, `Bash(trail:*)` 허용 규칙 추가.

## 제거

`.claude/settings.json`, `.claude/hooks/`, 이 문서를 지우고 `rm -rf graft .graft .trail`. 이후 `.gitignore`의 해당 항목도 지운다.

## 시험

훅 시험은 플러그인 저장소에 있다: `sh tests/project-hooks/run.sh`. 이 저장소에는 복사하지 않았다. 훅을 고치거나 rtk, Trail-Code, Claude Code를 올리면 그 저장소의 시험을 이 저장소의 `.claude/`로 돌려 확인한다.

## superpowers 플러그인

Claude Code에는 `superpowers` 6.4.2(2026-09-25)가 전역 플러그인으로 깔려 있다. 프로젝트에서는 플러그인을 고치지 않고, `CLAUDE.md`의 "superpowers 플러그인" 절로 스킬 지시를 덮어쓴다. 스킬도 사용자 지시가 스킬보다 우선한다고 적고 있다(`skills/using-superpowers/SKILL.md:65`). 근거 조사와 충돌표 전문은 2026-11-04 제안서(리드 scratchpad)에 있고, 결론만 여기에 둔다.

- 훅: SessionStart(`startup|clear|compact`)마다 `using-superpowers` 전문(약 65줄)이 리드와 팀원 세션에 붙는다. 플러그인이 까는 다른 훅, 명령, 에이전트는 없다.
- 산출물 기본 경로는 `docs/superpowers/specs/`, `docs/superpowers/plans/`이고 쓰자마자 커밋한다. 이 저장소에서는 스펙을 `docs/design/`, 계획을 `docs/plans/`에 쓰고 커밋하지 않는다.
- 계획 실행의 작업 디렉터리는 `.superpowers/sdd/<plan>/`(ledger, brief, 리뷰 묶음)이다. 실행이 끝나면 스킬이 지운다. brainstorm visual companion은 `.superpowers/brainstorm/`에 목업을 쓴다. 둘 다 `.gitignore`의 `/.superpowers/`로 무시된다.
- 계획 문서의 Task 제목은 `### Task N:` 형식이어야 한다. `subagent-driven-development/scripts/task-brief`가 이 정규식으로 Task를 찾는다.
- 서브에이전트 frontmatter의 `skills`는 스킬 전문을 시작할 때 주입한다(최대 32개). 플러그인 스킬은 `superpowers:<이름>`으로 적는다. 2026-11-05 `implementer`로 주입을 확인했다. 나열하지 않아도 Skill 도구로 부를 수 있다(https://code.claude.com/docs/en/sub-agents, 2026-11-04).
- 플러그인 스킬은 `skillOverrides`로 끌 수 없고 `/plugin`에서 플러그인째 끈다(https://code.claude.com/docs/en/skills, 2026-11-04).
- visual companion은 쓰지 않는다. 쓰면 페이지가 외부 로고를 불러온다. 끄려면 `SUPERPOWERS_DISABLE_TELEMETRY=1`(플러그인 `README.md:399`).

### Codex

- Codex CLI 0.166.0에는 `superpowers@openai-curated-remote` 7.0.1이 2026-10-31부터 깔려 있다(`codex plugin list`). 위치는 `~/.codex/plugins/cache/openai-curated-remote/superpowers/7.0.1/`이고, 매니페스트에 훅과 MCP 서버가 없다. 셸 스크립트는 brainstorm 서버와 `find-polluter.sh`뿐이며, 인증 파일, 셸 프로필, 권한 우회를 건드리지 않는다(2026-11-05 확인).
- `agent-run`은 `codex exec --disable plugins`로 실행한다(`~/.local/bin/agent-run`). 그래서 Codex 중계(`implementer-codex`, `security-reviewer-codex`)는 superpowers 스킬을 보지 못한다. 플러그인을 켠 `codex exec`에서는 `superpowers:` 스킬 15개가 보인다(2026-11-05 확인). 같은 규칙은 `implementer-codex`의 고정 Environment 블록에 문장으로 넣었다.
- 제거: `codex plugin remove superpowers@openai-curated-remote`.

## 역할 에이전트 훅 (agent-guard)

`.claude/agents/`의 역할 에이전트는 frontmatter의 PreToolUse 훅으로 `.claude/hooks/agent-guard.py`를 부른다. 프롬프트로만 약속하던 쓰기·git·경로 제한을 도구 단계에서 막는다. 훅은 그 에이전트가 도는 동안만 붙는다.

- 실패하면 막는다. 입력이 JSON이 아니거나, 정책 이름을 모르거나, 내부 오류가 나면 종료 코드 2로 호출을 막는다. rtk·Trail 훅과 반대다. 이 훅은 출력을 줄이는 게 아니라 제한을 지키는 것이기 때문이다.
- 정책은 에이전트마다 frontmatter의 인자로 정한다.

| 정책 | 쓰는 에이전트 | 막는 것 | 강도 |
| :- | :- | :- | :- |
| `relay-write` / `relay-read` | `implementer-codex` / `security-reviewer-codex` | `agent-run codex <tier> <dir> workspace-write`(또는 `read-only`) `<<'TASK_EOF'` 한 번과 고정 블록이 아닌 모든 Bash | 강함(허용 목록) |
| `write-docs` | `doc-writer` | `docs/`와 `tools/*/docs/` 밖의 Edit·Write, `CLAUDE.md`와 `.claude/` | 강함(경로) |
| `write-scratch` | `ux-designer` | scratchpad(`/var/tmp/claude-1000/`, `/tmp/`, 입력의 `scratchpad_dir`) 밖의 Edit·Write | 강함(경로) |
| `write-impl` | `implementer`, `debugger` | 프로젝트와 scratchpad 밖, `.claude/`, `CLAUDE.md`, `.git/`, `node_modules/`, 전역 설정 쓰기 | 강함(경로) |
| `no-write` | 나머지 | 모든 Edit·Write | 강함 |
| `bash-readonly` | `contract-liaison`, `doc-writer`, `ux-designer`, `visual-verifier`, `code-reviewer` | git 상태 변경, 설치, scratchpad 밖으로의 리다이렉트와 파일 명령(`rm`, `mv`, `cp`, `tee`, `sed -i` 등) | 약함(거부 목록) |
| `bash-test` | `test-runner` | 위 목록과 스냅숏 갱신 플래그(`-u`, `--update`, `--update-snapshots`), `--passWithNoTests` | 약함 |
| `bash-commit` | `committer` | `diff/add/restore --staged/commit/log/show/status` 밖의 git, `--amend`, `--no-verify`, `add -A`/`.`/`-u` | 중간 |
| `bash-impl` | `implementer`, `debugger` | git 상태 변경, 설치, 전역 설정과 `.git/`·`.claude/` 대상 파일 명령 | 중간 |
| 공통 | 전원 | `.env`, `*.pem`, `*.key`, `id_rsa*`, `auth.json`, `.credentials*` 읽기와 쓰기, `printenv`. `--kb-db`(`contract-liaison`)는 KB `*.sqlite`·`*.db`, `--net-local`(`visual-verifier`)은 127.0.0.1 밖의 `curl`·`wget`과 `0.0.0.0` | 중간 |

- 거부 목록 정책은 실수를 막는 장치이고 샌드박스가 아니다. `python3 -c`, `node -e` 같은 인터프리터로 쓰면 빠져나간다. 각 에이전트 파일 끝의 "Still prompt-only"가 남은 제한이다.
- 2026-11-05 확인: bypassPermissions 헤드리스 세션(CC 2.1.318)에서 서브에이전트와 `name`을 붙인 에이전트 모두 훅이 Bash 리다이렉트, Write, `git commit`을 막았다. 대화형 세션의 팀원 패널에서는 아직 확인하지 않았다.
- 시험: `python3 -I .claude/hooks/test_agent_guard.py`. 정책별 허용·거부 fixture를 넣고 종료 코드를 확인한다. 훅이나 에이전트 frontmatter를 고치면 돌린다.
- 끄기: 해당 에이전트 frontmatter의 `hooks:` 블록을 지운다. 전역 설정은 건드리지 않는다.
