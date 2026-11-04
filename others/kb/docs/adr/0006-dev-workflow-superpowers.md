# ADR-0006: Superpowers를 적용한 개발 작업 흐름

- 작성일: 2026-11-05. 사용자 승인일: 2026-11-04.
- 상태: 승인된 설계를 프로젝트 지침·에이전트 정의에 반영. 정적 확인 범위이며 다음 Claude 세션의 플러그인 로딩·실행은 미검증이다.
- 목적: 다음 세션에서 리드가 직접 구현하거나 금지된 시험·git 작업을 실행하지 않고 Superpowers를 사용하게 한다. 사용자는 설계·계획 문서, task별 시험 종료 코드, 로컬 커밋, 독립 검토 결과에서 이를 확인한다.

## 배경과 승인 근거

설치된 Superpowers는 6.4.2다. 이 ADR의 `P`는 `/home/user/.claude/plugins/cache/anthropic-plugin-directory/superpowers/6.4.2-8ca22dba9a94`를 뜻한다. `P/경로:행` 인용은 이 설치본의 실제 파일 기준이다. 버전 근거는 `P/.claude-plugin/plugin.json:4`다. 플러그인 원본을 수정하지 않고 지침 우선순위와 프로젝트 에이전트로 적용한다(`P/skills/using-superpowers/SKILL.md:65`). 별도 플러그인 설정 키가 자동으로 읽힌다고 가정하지 않는다.

2026-11-04 질문 도구로 받은 사용자 답변은 다음과 같다. 이번 작업 지시가 승인 이력을 전달했으며 별도의 승인 로그를 새로 생성하지 않았다.

> 지침 + 전용 에이전트

> 설계는 docs/adr, 계획은 docs/plans

> 단계별 로컬 커밋, 푸시·병합 없음

제시된 설계에 대한 최종 답변:

> 이대로 진행

조사 입력은 `/var/tmp/codex-1000/superpowers-survey.md`다. 조사 당시 없다고 기록한 `docs/research/role-decomposition.md`는 현재 존재한다. 이 ADR은 그 문서 4절의 개발 역할과 `DevHandoff`를 구체화한다. KB 내부의 수집·추출 역할이나 모델 라우팅과 섞지 않는다. 기존 개발 역할 10개를 늘리지 않고 네 역할의 실행 정의를 `.claude/agents/sp-*.md`로 연결한다.

## 결정

| 스킬·경계 | 적용 방식 |
|---|---|
| `brainstorming` | 리드가 목적·관측 위치를 정리하고 질문 전에 `Spike`/`Bounded`/`Architectural` 분류를 알린다. 필요한 질문·승인은 `AskUserQuestion`으로 묶는다. 문서 작성은 Codex 설계자 `high`가 맡는다. |
| 문서 위치 | 구조 설계는 `docs/adr/NNNN-<topic>.md`, 작은 설계·실행 계획은 `docs/plans/YYYY-MM-DD-<topic>.md`. 같은 주제의 설계와 계획을 따로 쓰면 `-design`/`-plan` 접미사로 구분하고 계획에서 설계를 링크한다. |
| `writing-plans` | Codex `high`가 `docs/plans/`에 작성한다. 기본 실행은 이미 승인된 `subagent-driven-development`이며 실행 방식 선택을 반복 질문하지 않는다. |
| task 실행 | 리드는 controller만 맡고 구현 → 시험 → 로컬 커밋 → 독립 검토를 배치한다. 구현자 Codex `medium`, 실패·낮은 확신이면 `high`; 검토자 Codex `high`, 구현자와 다른 세션. |
| 시험·커밋 실행 환경 | `sp-test-runner`, `sp-committer`는 Codex 샌드박스 밖 Claude Haiku `low`. task가 지정한 좁은 시험만 실행하고 현재 브랜치에서 지정 파일만 커밋한다. |
| 검토 | 커밋 후 `review-package`가 생성한 `BASE..HEAD`로 요구 충족·품질을 함께 검토한다. 같은 결과의 Codex·Claude 중복 검토는 판정이 충돌할 때만 허용한다. |
| `verification-before-completion` | 기존 명령의 실제 종료 코드·출력과 산출물 동일성으로 판정한다. 좁은 시험 통과를 전체 시험 통과라고 말하지 않는다. |
| `systematic-debugging` | 원인 조사와 단일 가설 검증을 유지한다. 같은 원인의 실패가 두 번이면 즉시 중단·분석하며 플러그인의 3회·5회 규칙보다 공통 지침 0·6이 우선한다. |
| `finishing-a-development-branch` | 브랜치·워크트리를 유지하고 근거·남은 문제를 보고한다. push·PR·merge는 별도 사용자 요청이 있어야 한다. 삭제·amend·reset은 이 흐름에서 하지 않는다. |
| `using-git-worktrees` | 기본 비활성. 병렬 구현자가 같은 파일을 만져야 할 때만 Claude Haiku `low` 워커가 격리한다. 같은 checkout의 같은 파일에는 동시에 쓰지 않는다. |
| `dispatching-parallel-agents` | 읽기 전용 조사 또는 파일이 겹치지 않는 작업만 병렬화한다. 같은 브랜치의 index·커밋·시험 대상 변경은 직렬화한다. |
| visual companion | 비활성. 필요한 시스템 설계 렌더링은 샌드박스 밖 Claude 워커가 공통 지침 7에 따라 수행한다. KB 제품의 시각화 기능은 만들지 않는다. |
| `writing-skills`·`diagnosing-superpowers` | 요청된 프로젝트 범위만 사용한다. 전역·플러그인 원본 쓰기, 기본 모델 설정 변경, 자동 7개 분석자 실행을 하지 않는다. 자가개선은 `agent-retro` 경로를 따른다. |
| 효과 | `agent-retro status`의 세션별 사용자 정정 횟수로 확인한다. 정정을 줄이지 못한 추가 규칙은 제거한다. 이번 변경에서 효과 측정은 수행하지 않았다. |

`Spike`는 질문·probe 승인을 받고 결과만 남긴다. `Bounded`는 짧은 설계로 충분하며 새 문서를 의무화하지 않는다. 작은 설계 문서가 필요한 경우에만 `docs/plans/`에 둔다. `Architectural`은 작성된 spec 검토, 작성된 plan 검토를 거친다. 아직 없는 문서의 승인을 이전 동의로 간주하지 않되 이미 승인된 설계·실행 방식·로컬 커밋 권한을 재질문하지 않는다. 이 통합 자체는 위 승인을 받아 작성하는 작업이다.

정식 plan이 없는 `Bounded`도 승인된 채팅 설계·인수 기준을 task brief에 고정한다. 워커가 task 전용 workspace를 준비하고, 명시적 출력 경로를 지정한 `review-package`의 `PLAN_FILE` 인자에는 그 brief 경로를 전달한다. 이 helper는 해당 파일의 존재만 확인하고 내용을 계획 문법으로 해석하지 않는다(`P/skills/subagent-driven-development/scripts/review-package:21`, `:30`). 계획에서 task를 추출하는 `task-brief` helper는 이 경우 사용하지 않는다. 작은 변경에 정식 계획 문서를 억지로 만들지 않으면서 커밋 범위 검토는 유지한다.

## 역할과 인계 계약

모델 식별자는 기존 역할 문서의 Codex `gpt-6.1-sol`을 사용한다. Codex `medium`/`high`는 `agent-run`의 tier이며 전역 기본값을 수정하지 않는다. 두 relay의 frontmatter `model: haiku`, `effort: low`는 명령을 중계하는 Claude 비용이고 실제 작업은 명시한 Codex 모델·tier가 수행한다.

| 기존 역할 → 실행 정의 | 모델·벤더 | 입력 | 출력·다음 인계 |
|---|---|---|---|
| `lead` → 기존 관제 세션 | 현재 리드 유지; 통합 판단 `high` | 사용자 목적·승인, spec·plan, 워커 근거 | `DevHandoff`, 배치·판정·한국어 사용자 응답. 직접 구현·시험 재실행·커밋 없음. |
| `designer` → Codex relay | OpenAI `gpt-6.1-sol`, `high` | `DesignBrief`, 분류, 제약·근거 | 구조 spec 또는 작은 설계 문서, self-review 결과 → 리드의 문서 검토 단계. plan 작성도 이 역할의 별도 과제로 수행하며 별도 planner 역할은 만들지 않는다. |
| `implementer` → `sp-implementer` | OpenAI Codex `gpt-6.1-sol`, `medium`; 실패 시 `high` | task brief, spec 관련 구간, Global Constraints, 파일 소유권, 좁은 검증 명령 | 지정 파일 변경·자기 검토·RED/GREEN 근거·해시 manifest·report → 리드 → 시험 실행자. 커밋 없음. |
| `test-runner` → `sp-test-runner` | Anthropic Claude `haiku`/`low`, Codex 샌드박스 밖 | 불변 변경 목록·해시, task에 명시된 시험 디렉터리·명령, 개발 `KB_HOME` | 실행 명령·종료 코드·로그 위치·실행 전후 해시 → 리드 → 커밋 실행자. 코드 수정 없음. |
| `committer` → `sp-committer` | Anthropic Claude `haiku`/`low`, `.git` 쓰기 가능 환경 | 승인 범위, `CommitPacket`, branch·expected HEAD·task BASE·검증 해시·파일 목록 | `{commit_ref, included_paths, artifact_sha, verification_refs, review_package_ref}` → 리드 → 검토자. 경로별 로컬 커밋과 검토 패키지만 생성. |
| `reviewer` → `sp-reviewer` | OpenAI Codex `gpt-6.1-sol`, `high`, 구현자와 다른 세션 | 불변 `ReviewPacket`: brief·제약·report·시험 근거·BASE·HEAD·diff 경로·구현 세션 ID | 요구 충족 판정·Critical/Important/Minor·`file:line`·미확인 항목 → 리드. 수정은 구현자에게만 돌린다. |

기존 `deployer`, `doc-writer`, `primary-researcher`, `kb-recorder` 역할은 유지한다. 이 ADR은 배포를 허가하지 않는다. 독립적인 문서 정리와 조사는 기존 역할을 쓰고 설계 결정은 `designer`에게 맡긴다. tower 기록은 기존 Claude 리드가 맡으며 Codex는 보관 후보만 인계한다.

`docs/research/role-decomposition.md` 4절의 `DevHandoff`와 반환 봉투를 그대로 쓴다. 위임 첫 줄에는 목적과 사용자가 확인할 위치를 둔다. 필수 항목은 목적·목표·수정 범위·범위 밖·출력 형식·완료 기준 2~5개·실행 가능한 검증 명령이다. 검토에는 명령 대신 근거 위치를 줄 수 있다. task brief는 해당 task 원문과 Global Constraints를 포함하고 전체 대화나 전체 plan을 복제하지 않는다.

추가 실행 필드는 `{plan_ref, spec_ref, task_base, expected_head, branch, allowed_test_paths, commands, snapshot_manifest_ref, report_ref, implementer_session_id, reviewer_session_id, tier, model, timeout_s}`다. 각 manifest는 검증 대상 파일별 경로·상태·SHA-256을 담고 삭제는 상태로 표시한다. 다음 역할은 이전 반환의 근거 파일을 읽으며 변경·해시 불일치나 커밋 사이의 예상 밖 HEAD 이동을 통과시키지 않는다. 입력 누락은 `NEEDS_CONTEXT`, 권한·환경 제한은 `BLOCKED`, 낮은 확신은 `DONE_WITH_CONCERNS`로 반환한다. 완료 기준별 결과, 명령별 종료 코드, 재시도 횟수, 미해결·사고를 포함한다. 긴 보고는 파일에 두고 인계 메시지는 4,000자 이내다.

### relay 실행 계약

`~/.claude/agents/codex.md`는 읽기만 하여 패턴을 확인했다. 프로젝트 relay는 task 원문을 따옴표로 감싼 heredoc으로 `agent-run codex <tier> <cwd> <sandbox> <model>`에 전달한다. 구현은 `workspace-write`, 검토는 `read-only`다. relay는 코드를 직접 읽거나 작업을 대신 수행하지 않는다. 고정 역할 제약은 task 원문 앞에 전달하되 원문은 다시 쓰지 않는다.

`AGENT_TIMEOUT`은 반드시 명시한다. 이 프로젝트 relay의 기본은 1800초이며 caller가 다른 양의 정수를 지정하면 그 값을 쓴다. 어댑터 기본 600초와 구분한다. Bash 도구 제한이 600000ms라 1800초를 담을 수 없으면 `run_in_background`와 `TaskOutput`의 최대 60000ms 단위 확인으로 같은 실행을 기다린다. 재실행·임의 detach·권한 우회로 시간을 늘리지 않는다. 실제 도구가 비동기 대기를 제공하지 않으면 제한을 보고한다.

초기 호출에는 `AGENT_RESUME`을 해제해 새 세션을 보장한다. 리드가 반환된 `[session]` ID를 기록하고 수정 과제를 재개할 때만 `AGENT_RESUME=<id>`를 지정한다. 검토자는 구현자 ID를 절대 재개하지 않는다. relay는 Codex 최종 메시지, `[session]`, `[usage]` 줄을 그대로 반환하며 실패 종료 코드와 오류도 숨기지 않는다. 중단·타임아웃은 성공이 아니며 자동 재시도하지 않는다. 워커는 중첩 `agent-run`, `claude -p`, 하위 에이전트를 호출하지 않는다.

## task별 순서

1. 리드는 승인된 spec·plan(정식 문서가 없는 Bounded는 승인된 설계 brief)과 현재 브랜치를 확인하고 워커에게 plan별 `.superpowers/sdd/<plan-basename>/` 상태 기록을 맡긴다. Bounded는 task 식별자로 workspace를 구분한다. 이미 완료한 task를 다시 실행하지 않는다. task 시작 직전 HEAD를 `BASE`로 고정하고 파일 소유권·시험 범위·출력 경로를 brief에 넣는다. 현재 브랜치 작업과 단계별 로컬 커밋은 승인 범위다.
2. `sp-implementer`가 새 Codex 세션에서 task를 구현한다. 행동 변경은 허용된 순수 시험으로 RED → 최소 구현 → GREEN → 정리를 수행한다. 소켓 등으로 RED 실행부터 막히면 시험을 먼저 작성하고 `BLOCKED`로 리드에게 돌린다. 리드가 `sp-test-runner`로 RED를 실행시킨 뒤 같은 구현 세션을 재개한다. 문서·단순 설정은 불필요한 행동 시험을 만들지 않고 task의 정적 검증을 사용한다. 이미 있는 사용자 변경을 TDD 명분으로 삭제하지 않는다.
3. `sp-test-runner`가 검증할 파일 목록·해시를 고정하고 task에 명시된 좁은 디렉터리·파일·명령만 실행한다. 전체 스위트와 `tests/mcp/test_claude_real.py` 읽기·수정·실행은 금지한다. `KB_LIVE`는 해제하고 개발/임시 `KB_HOME`을 명시하며 운영 환경 스크립트를 source하지 않는다. 통과하려고 guard를 해제하지 않는다. 로그와 실행 전후 manifest를 남긴다.
4. `sp-committer`가 시험 결과와 동일한 파일 상태, expected HEAD·브랜치, 비어 있는 index를 확인한다. 다른 세션의 staged 변경·소유권이 불명확한 기존 변경은 건드리지 않고 중단한다. `git add -- <승인 경로>`와 로컬 `git commit`만 수행하고, 검증한 내용과 staged/committed 내용의 동일성·포함 경로를 확인한다. stage 실패 뒤 임의 unstage/reset을 하지 않는다. 승인 문서·계획도 준비된 경로·정적 검증 패킷으로 이 역할에 인계한다.
5. 같은 커밋 실행자가 `HEAD`를 기록하고 아래 명령으로 review package를 만든다. `BASE`는 마지막 한 커밋의 부모로 추측하지 않는다. 패키지가 실패하면 커밋은 보존하고 검토를 진행하지 않는다. `BASE`의 조상 관계·비어 있지 않은 범위를 통과해야 한다(`P/skills/subagent-driven-development/scripts/review-package:21`).

   ```bash
   bash "$SUPERPOWERS_ROOT/skills/subagent-driven-development/scripts/review-package" "$PLAN_FILE" "$BASE" "$HEAD" "$REVIEW_PACKAGE"
   ```

   변수는 리드가 검증된 설치 루트·plan·SHA·plan 전용 출력 파일로 채운다. `SUPERPOWERS_ROOT`는 이 명령을 위한 셸 변수이며 플러그인 설정 API가 아니다. 명시적 출력 경로의 부모는 준비되어 있어야 한다. 패키지는 커밋 목록·통계·문맥 포함 diff만 담고 미커밋 변경은 담지 않는다(`P/skills/subagent-driven-development/scripts/review-package:30`, `:40`).
6. 리드가 `sp-reviewer`를 구현자와 다른 새 Codex 세션으로 실행한다. 검토자는 패키지를 먼저 읽고 요구 충족·품질을 한 번에 검토한다. 같은 파일을 다시 전부 읽거나 시험을 재실행하지 않는다. 이름 붙인 위험을 판단할 근거가 부족할 때만 좁은 추가 읽기를 하고 위치를 보고한다. 추가 시험이 필요하면 명령을 제안하고 리드가 시험 실행자에게 맡긴다.
7. Critical/Important 또는 실제 요구 누락은 구현자에게 돌린다. 이전 검토 HEAD를 `FIX_BASE`로 기록하고 수정 → 좁은 시험 → 새 로컬 커밋 → `FIX_BASE..HEAD` 재검토를 거친다. 재검토는 기존 지적 해결 여부와 수정이 만든 새 결함만 본다. 원래 task `BASE`도 보존한다. Minor는 ledger에 근거·영향을 기록한다. 첫 실패·낮은 확신은 Codex `high`로 올린다. 같은 원인 두 번이면 반복을 멈추고 판단 수준 워커가 원인을 분석하며 리드는 증거를 직접 본다. 플러그인 5회 한도까지 강행하지 않는다.
8. 요구 충족·좁은 시험·검토가 닫힌 뒤에만 task 완료로 기록한다. 여러 task의 계획을 마치면 시작 시 기록한 전체 작업 기준 SHA부터 최종 HEAD까지 패키지를 만들어 별도 Codex `high` 세션의 통합 검토를 한 번 받는다. 이는 task 검토와 다른 통합 범위이며 다른 회사에 같은 결과를 재검토시키지 않는다. 단일 Bounded task는 이미 검토한 동일 범위를 다시 검토하지 않는다. 수정도 동일한 시험·커밋·범위 검토 순서를 따른다. 미해결 중요한 결함을 완료로 표시하지 않는다.
9. `finishing-a-development-branch`는 브랜치·워크트리 유지로 끝낸다. 로컬 커밋·검증 범위·종료 코드·미실행 범위·미해결 문제·리드의 `Ruling`과 틀렸을 때 영향을 한국어로 보고한다. plan별 근거 파일도 보존하고 다른 plan의 workspace는 건드리지 않는다. push·PR·merge·브랜치 삭제는 실행하지 않는다.

## 조사에서 확인한 충돌과 해소

아래 인용은 6.4.2 설치본의 행 번호다. 해결은 모두 사용자 승인에 따른 프로젝트 지침 override이며 플러그인 코드를 고친 것이 아니다.

| 플러그인 지시·근거 | 이 저장소의 해소 |
|---|---|
| spec·plan 기본 경로: `P/skills/brainstorming/SKILL.md:241`, `P/skills/writing-plans/SKILL.md:16` | 사용자 선호 override를 사용해 ADR/계획 경로로 통일한다. 기본 `docs/superpowers/`에 중복 문서를 만들지 않는다. |
| Bounded에는 문서가 없고 질문은 메시지당 하나: `P/skills/brainstorming/SKILL.md:71`, `:204`, `:220` | 분류와 필요한 승인 단계는 유지한다. 질문 도구로 묶고 문서가 필요한 작은 설계만 `docs/plans/`에 쓴다. |
| 사용자에게 실행 방식 선택 요구: `P/skills/writing-plans/SKILL.md:179` | 이미 승인된 subagent-driven을 보존한다. 작성된 plan의 내용 검토는 유지하되 방식 재선택을 요구하지 않는다. |
| 구현자가 commit·full suite 실행: `P/skills/subagent-driven-development/implementer-prompt.md:34`, `:47`; 계획의 git 단계: `P/skills/writing-plans/SKILL.md:132` | `.git` 쓰기는 Claude 커밋 역할로 분리한다. 계획의 commit 단계도 `sp-committer` 인계로 작성한다. 시험 증거 뒤 커밋을 만들므로 표준 review-package를 수정 없이 사용할 수 있다. 조사 제안의 미커밋 diff 대체 방식은 채택하지 않는다. |
| TDD bare suite: `P/skills/test-driven-development/SKILL.md:185`; finishing full suite: `P/skills/finishing-a-development-branch/SKILL.md:16`; parallel 통합 suite: `P/skills/dispatching-parallel-agents/SKILL.md:79` | task에 지정한 좁은 검증만 허용한다. `pytest --ignore=...`도 전체 suite면 금지다. 금지 파일·실제 LLM 호출을 우회 실행하지 않는다. |
| 선작성 제품 코드를 삭제하라는 TDD 규율: `P/skills/test-driven-development/SKILL.md:37`; 단순 코드·문서 시험 판단: `P/skills/test-driven-development/writing-good-tests.md:150` | 행동 변경은 RED부터 시작하되 사용자·다른 세션 변경을 삭제하지 않는다. 문서·단순 설정에 억지 시험을 만들지 않는다. |
| SDD 격리·main 제한: `P/skills/subagent-driven-development/SKILL.md:126`; worktree 동의·생성·setup·baseline: `P/skills/using-git-worktrees/SKILL.md:41`, `:80`, `:104`, `:123` | 현 브랜치의 단계별 로컬 커밋 승인을 적용한다. 겹치는 병렬 구현만 Claude 워커가 별도 worktree에 격리한다. 기존 격리는 재사용하고 자동 install·전체 baseline 시험은 하지 않는다. 생성 실패 시 겹치는 checkout 쓰기로 fallback하지 않고 직렬화한다. |
| 자동 worktree ignore commit: `P/skills/using-git-worktrees/SKILL.md:86` | 필요할 때만 승인 파일 목록에 명시해 커밋 역할로 넘긴다. helper의 전체 stage·cleanup은 하지 않는다. |
| finishing 메뉴에 merge·push/PR: `P/skills/finishing-a-development-branch/SKILL.md:55`; cleanup: `:159` | keep + report로 고정해 메뉴 재질문을 없앤다. 현 브랜치·워크트리·로컬 커밋을 유지한다. |
| 3회 실패 뒤 논의·5회 수정 루프: `P/skills/systematic-debugging/SKILL.md:191`; `P/skills/subagent-driven-development/SKILL.md:373`, `:427` | 첫 실패 상향, 같은 원인 두 번이면 분석. 승인 없이 중요한 결함을 parked 처리해 통과시키지 않는다. |
| HTTP/WebSocket companion: `P/skills/brainstorming/visual-companion.md:70`; 소켓 listen: `P/skills/brainstorming/scripts/server.cjs:703` | companion 비활성. 샌드박스 밖 Claude 워커가 필요한 설계 자료만 렌더링하며 host/foreground 변경으로 소켓 차단을 우회하지 않는다. |
| home 경로 skill·diagnostic 쓰기: `P/skills/writing-skills/SKILL.md:12`; `P/skills/diagnosing-superpowers/SKILL.md:33`; Codex 전역 설정: `P/skills/using-superpowers/references/codex-tools.md:70` | 프로젝트 파일 또는 `$TMPDIR`만 사용한다. 전역 설정·설치 캐시를 수정하지 않으며 별도 경로 env가 존재한다고 주장하지 않는다. 진단의 기본 7명 분석자(`P/skills/diagnosing-superpowers/SKILL.md:74`)도 자동 실행하지 않는다. |
| nested orchestrator: `P/skills/using-superpowers/references/claude-code-tools.md:14`; leaf 계약: `P/skills/subagent-driven-development/implementer-prompt.md:50`, `P/skills/subagent-driven-development/task-reviewer-prompt.md:55` | 리드가 직접 역할들을 배치한다. Codex relay 안의 워커는 leaf이며 중첩 위임을 하지 않는다. |
| plugin 모델 선택·더 싼 재검토: `P/skills/subagent-driven-development/SKILL.md:184`; reviewer 칭찬 요구: `P/skills/subagent-driven-development/task-reviewer-prompt.md:158` | 승인된 구현 medium/검토 high와 relay haiku/low를 명시한다. 사용자 보고는 한국어, 에이전트 인계는 영어, 불필요한 칭찬 없이 판정·근거·우려만 남긴다. |
| reviewer의 추가 시험 허용: `P/skills/subagent-driven-development/task-reviewer-prompt.md:73` | 검토자는 읽기 전용으로 근거를 검토한다. 필요한 추가 실행은 시험 역할에 돌리며 같은 검증을 반복하지 않는다. |
| `/tmp` 예시: `P/skills/requesting-code-review/code-reviewer.md:52`; companion 기본 경로: `P/skills/brainstorming/scripts/start-server.sh:116` | 임시 파일은 디스크 `$TMPDIR`만 사용한다. 하드코딩된 `/tmp` launcher를 단순 env 변경으로 허용하지 않는다. |
| 검증 명령은 전달 문자열 그대로 실행: `P/skills/executing-plans/scripts/task-done:39`; worktree 범용 setup: `P/skills/using-git-worktrees/SKILL.md:104` | 기존 `ops/bin/dev`를 사용하되 `KB_LIVE`를 해제하고 개발/임시 `KB_HOME`을 명시한다. 운영 env 상속이나 guard 우회는 금지한다. |
| workspace 삭제: `P/skills/subagent-driven-development/SKILL.md:482`; rulings 보고: `:473` | 근거와 세션 ID를 보존해 다음 세션이 중복 실행하지 않게 한다. 리드 결정과 영향은 최종 보고에 남긴다. |
| 진단 export·issue와 KB 정책의 분리: `P/skills/diagnosing-superpowers/SKILL.md:44` | 외부 메시지·원문 export를 자동 수행하지 않는다. 코드·문서로 알 수 없는 결정·측정·근원만 기존 Claude 리드에게 보관 후보로 전달한다. |

`verification-before-completion`의 명령·종료 코드·diff 확인(`P/skills/verification-before-completion/SKILL.md:24`, `:100`)과 reviewer의 불변 diff 중심 검토(`P/skills/subagent-driven-development/task-reviewer-prompt.md:32`)는 유지한다. helper 출력 경로 재지정은 `review-package`의 네 번째 인자로만 사용하며 커밋 범위 guard를 우회하지 않는다.

## 환경 경계와 범위 밖

이 환경의 Codex는 `.git` 읽기 전용, 소켓 차단, Claude scratchpad 쓰기 불가, 어댑터 기본 제한 600초다. 모든 Codex 환경의 영구 제품 제약으로 일반화하지 않는다. 보고서·로그는 프로젝트 plan workspace 또는 `$TMPDIR`에 두고 `.git` 권한 변경·scratchpad 우회 쓰기를 하지 않는다. 현재 작업은 추가 LLM·네트워크·시험을 호출하지 않는다.

범위 밖은 플러그인 설치·업데이트·원본 수정, 전역 지침·설정·에이전트 수정, 다른 저장소 변경, 새 실행기·hook 구현, 제품 기능, KB 운영 데이터 변경, 전체 시험, 실제 LLM 시험, 자동 배포·push·PR·merge·amend·reset·삭제다. 기존 KB 에이전트를 개발 역할로 전용하지 않는다. `executing-plans`를 리드 직접 구현의 우회 경로로 쓰지 않는다. 별도 승인된 실행 변경이 필요하면 먼저 역할·권한을 정한다.

## 검증과 완료 판정

이번 산출물의 정적 완료 기준은 ADR·CLAUDE.md 절·네 에이전트·계획 README 존재, CLAUDE.md 기존 절 보존, 에이전트별 `name`/`description`/`model`/`effort`/`tools`, 추가 절 1개, `git diff --check` 종료 코드 0이다. 검증 명령은 다음과 같고 시험·LLM·네트워크를 실행하지 않는다.

```bash
git diff --check
grep -n 'Superpowers 적용' CLAUDE.md
for f in .claude/agents/sp-{implementer,reviewer,test-runner,committer}.md; do
  test -s "$f" && grep -nE '^(model|effort):' "$f" || exit 1
done
```

다음 세션의 실제 수용 판정은 task 목적에 맞는 결과, 승인 경로·역할 사용, 좁은 검증 종료 코드, 검증 내용과 커밋 내용의 일치, 별도 Codex 세션의 BASE..HEAD 판정, 브랜치 보존을 함께 확인한다. 이번 정적 변경만으로 로딩·중계·시험·커밋 동작이나 정정 횟수 감소를 입증했다고 주장하지 않는다. 이 확인을 위해 별도의 전체 suite나 압력 시나리오 LLM 호출을 추가하지 않는다.

## 되돌리기

효과가 없으면 사용자에게 정정 횟수와 실패 근거를 보고하고 프로젝트 범위 제거를 맡긴다. 이 ADR을 대체됨으로 표시하고, CLAUDE.md의 추가 절·네 `sp-*` 정의·계획 README의 이 통합 전용 규칙·역할 문서의 연결만 검토 가능한 역변경으로 만든다. 기존 절·기존 KB 에이전트·다른 워커 변경·작성된 설계·계획·로컬 커밋은 보존한다. 필요하면 승인된 커밋 역할이 역변경을 새 로컬 커밋으로 남긴다. reset·amend·강제 삭제·전역 플러그인 제거를 자동 수행하지 않는다.

## spec 자체 검토

`P/skills/brainstorming/SKILL.md:246`의 네 항목을 작성자가 직접 검토하고 본문에 반영했다.

- 미완성 항목: 실행 역할·경로·입출력·실패 처리·완료 기준을 채웠고 미결 placeholder를 남기지 않았다.
- 모순: Codex 커밋 지시를 Claude 역할로 분리하고 commit 뒤에만 표준 review-package를 사용하도록 통일했다. 기존 커밋 요청 규칙에는 이번 승인을 좁은 예외로 연결했다.
- 범위: 프로젝트 지침·네 역할 정의·문서 경로에 한정했다. KB 역할 분해·제품 구현·전역 설치는 포함하지 않았다.
- 모호성: 작은 설계 문서의 필요 여부와 문서 없는 Bounded의 brief 패키징, 새 구현/검토 세션과 수정 재개, TDD의 차단된 RED 인계, 좁은 검증과 전체 검증, relay 모델과 Codex tier를 구분했다.
