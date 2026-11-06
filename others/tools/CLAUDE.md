# sagae-tools

사용자가 자주 쓰는 작업을 자동화하는 도구 모음이다.

## 운영 지침

1. 메인 세션은 직접 작업하지 않는다. 실제 작업은 팀과 서브에이전트가 맡고, 메인 세션은 에이전트 관제와 비효율적인 구조의 개선을 맡는다.
2. 바퀴를 재발명하지 않는다. 구현 전에 최신 연구 동향과 기존 도구를 조사하고, 쓸 수 있는 것은 쓴다.
3. rtk와 trailing으로 토큰을 효율적으로 쓴다. trailing은 trail(Trail-Code, 구 graft)이다(사용자 확인됨). 두 도구는 `.claude/settings.json`의 프로젝트 훅으로만 연결하고 전역 설정은 건드리지 않는다. 동작과 끄는 법은 `docs/project-tools.md`.
4. 서브에이전트와 팀 에이전트를 세션 복제로 띄우지 않는다. 리드가 업무 수준을 판단해 에이전트마다 모델과 effort를 차등 지정한다(아래 "에이전트 모델과 effort").

## 구조 원칙

- 도구끼리 종속되지 않는다. 관제 서버는 뷰어 없이 동작하고, 뷰어는 관제 서버의 소비자 중 하나다.
- MCP 서버는 Claude Code 확장에 직접 넣지 않는다. Claude Code에는 관제 서버의 병합된 MCP 엔드포인트 하나만 등록하고, MCP 서버는 그 뒤에 둔다. 서버를 추가해도 Claude Code 설정은 바뀌지 않는다.
- sagae-knowloge-base는 계약으로만 읽는다. DB 파일에 직접 접근하지 않고, 파생값을 KB에 되쓰지 않는다. 뷰어(loupe)는 KB의 쓰기 인터페이스로 first_party 기록만 쓰고, 수집된 사실을 고치지 않는다.
- 계약 원본은 KB 저장소의 `docs/contracts/`에 있다. 이 저장소에 복사본을 원본처럼 두지 않는다.

## 관례

- 문서는 한국어, 코드와 커밋 메시지는 영어로 쓴다.
- 서비스는 기본적으로 127.0.0.1에만 바인딩한다. 이 머신은 WSL 미러 네트워킹이라 eth0이 LAN 주소다.
- systemd 유닛의 런타임 경로는 절대 경로로 적는다. 맨 PATH에는 node와 bun이 없다.
- 대규모 정찰을 띄우기 전에 `ListAgents`로 그 정보를 소유한 세션이 있는지 확인한다. 소유 세션의 미공개 판단은 그 세션에 묻고, 저장소에 있는 문서는 그대로 읽어도 된다.
- 워크플로 결과는 `agent()` 반환값으로 받는다. 서브에이전트에게 보고서 파일을 쓰게 하지 않는다. Claude Code는 이름이 `REPORT`, `SUMMARY`, `FINDINGS`, `ANALYSIS`로 시작하는 `.md` 파일 쓰기를 서브에이전트에게 막고, 반환값은 워크플로 저널에 남는다.
- 브라우저 시험은 헤드리스로 돌린다. 실제 GPU처럼 보이는 탭이 꼭 필요하면 시작 전에 사용자에게 알리고, Orca 탭은 `--worktree path:<저장소>`로 열고 닫는다. 지정하지 않으면 다른 워크트리에 뜨고 닫기도 조용히 실패한다.

## 에이전트 모델과 effort

서브에이전트와 팀 에이전트를 띄우는 리드(메인 세션과, 하위 작업을 나누는 에이전트)가 업무마다 모델과 effort를 정한다. 아래 표는 출발점이고 리드가 업무를 보고 조정한다.

| 업무 수준 | 예 | 모델 | effort |
|---|---|---|---|
| 기계 작업 | 파일 정리, 결과 집계, 정해진 명령 재실행 | `haiku` | `low` |
| 일반 작업 | 정찰, 문서 읽기, 스캐폴드, fixture, 시험 재현 | `sonnet` | `medium` |
| 구현 | 설계가 정해진 코드 작성, 결함 수정 | `sonnet` | `high` |
| 어려운 구현 | 동시성, 프로토콜 경계, 막힌 문제의 디버깅 | 세션 모델 | `high` |
| 판단 | 설계, 적대적 검토, 보안 검토 | 세션 모델 | `high` |
| 최종 판단 | 되돌리기 어려운 결정 | 세션 모델 | `xhigh` 이상 |

- 워크플로의 `agent()`는 지정하지 않으면 세션 모델과 effort를 물려받는다. `model`과 `effort`를 항상 적는다.
- `Agent` 도구의 `fork`는 세션 모델과 effort를 그대로 쓰고 바꿀 수 없다. 판단 업무에만 쓴다.
- 개발 작업은 `.claude/agents/`의 역할별 에이전트에게 맡기고, 맞는 역할이 없을 때만 `general-purpose`를 쓴다.
- 처음부터 높게 잡지 않는다. 낮은 수준에서 실패하면 그 단계만 한 칸 올려 다시 돌린다.

## superpowers 플러그인

플러그인 스킬은 쓰되 아래 규칙이 스킬 지시보다 우선한다. 세부와 근거는 `docs/project-tools.md`.

- 산출물: 스펙은 `docs/design/<tool>-<topic>.md`, 계획은 `docs/plans/YYYY-MM-DD-<tool>-<topic>.md`에 한국어로 쓴다. 계획의 Task 제목만 `### Task N: <영어 이름>`으로 둔다. `docs/superpowers/`는 쓰지 않는다.
- 질문: 한 번에 하나씩 묻지 않는다. 스펙·계획 검토, 실행 방식, 브랜치 마무리 메뉴도 `AskUserQuestion`으로 묶어 묻는다.
- 커밋: 스펙과 계획은 커밋하지 않는다. 소유자가 계획과 실행 방식을 승인하면 그 계획 범위에서 `committer`가 경로 목록으로 Task별 로컬 커밋을 만든다. push, amend, rebase는 하지 않는다. 병합과 push는 소유자가 그 자리에서 고를 때만 한다.
- 실행: 리드는 Native(executing-plans)를 쓰지 않는다. 계획은 subagent-driven-development로 실행하고, 작은 계획은 워커 하나에게 executing-plans로 맡긴다. 리드의 탐색은 `Explore`, 재시험은 `test-runner`가 한다.
- 역할: 구현은 `implementer-codex` 또는 `implementer`, Task·최종 리뷰는 `code-reviewer`, 원인 불명 실패는 `debugger`. 스킬의 cheap/standard/most capable은 위 표로 읽고, 최종 전체 리뷰는 세션 모델 `high`.
- 워크트리: 공유 체크아웃에서 브랜치를 바꾸지 않는다(relief·tower systemd 유닛이 이 체크아웃에서 돈다). `git worktree add`와 `.worktrees/`는 쓰지 않는다. 격리가 필요하면 Agent의 `isolation: "worktree"`를 쓰고 기준 브랜치를 브리프에 적는다. 의존성은 설치하지 않는다.
- TDD 예외: 문서, 지침 파일, `.claude/` 설정과 에이전트, systemd 유닛, 스파이크. 기존 시험·빌드·실제 실행으로 검증한다. 지우는 코드는 이번 Task에서 자기가 쓴 것만.
- 실패: 같은 이유로 2회 실패하면 멈춘다(systematic-debugging의 3회보다 우선).
- 워커: using-superpowers의 "1%면 호출"을 따르지 않고 브리프와 frontmatter `skills`가 정한 스킬만 쓴다. brainstorming은 리드만 한다. Codex는 `agent-run`이 플러그인을 끄므로 스킬을 못 읽는다. TDD·검증 규칙은 브리프나 중계 고정 블록에 문장으로 넣는다.
- 쓰지 않음: visual companion(대신 `ux-designer`와 `visual-verifier`). diagnosing-superpowers는 소유자 요청 시에만 쓴다.
- 역할 에이전트의 쓰기·git·경로 제한은 frontmatter 훅(`.claude/hooks/agent-guard.py`)이 막는다. 훅을 고치면 `python3 -I .claude/hooks/test_agent_guard.py`를 돌린다.
