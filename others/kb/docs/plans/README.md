# 개발 설계와 실행 계획

상태: 2026-11-04 사용자 승인 적용. 2026-11-05 문서·에이전트 정의 반영, 실제 다음 세션 실행은 미검증.

[ADR-0006](../adr/0006-dev-workflow-superpowers.md)에 따라 작은 설계와 실행 계획을 이 디렉터리에 둔다. 구조 설계 spec은 `docs/adr/NNNN-<topic>.md`에 둔다. `Bounded` 변경마다 별도 문서를 의무적으로 만들지는 않는다.

- 파일명은 `YYYY-MM-DD-<topic>.md`이고 주제 식별자는 짧은 영어 kebab-case로 쓴다. 같은 날 같은 주제의 설계와 계획을 따로 쓰면 `<topic>-design.md`, `<topic>-plan.md`로 구분한다.
- 본문은 한국어, 코드·식별자는 원어로 쓴다. 실행 계획은 대상 spec을 링크하고 설계 결정을 중복 정의하지 않는다.
- 문서 첫 부분에 `상태: 초안 | 검토 대기 | 승인 | 실행 중 | 완료 | 대체됨` 중 실제 상태 하나와 갱신일을 적는다. 계획 승인과 실행 완료를 혼동하지 않는다. 관련 승인·대체 문서가 있으면 링크한다.
- template은 설치된 [`superpowers:writing-plans`의 Plan Document Header 및 Task Structure](/home/user/.claude/plugins/cache/anthropic-plugin-directory/superpowers/6.4.2-8ca22dba9a94/skills/writing-plans/SKILL.md:52)를 사용한다. 기본 저장 경로는 이 디렉터리로 바꾼다. 설치본이 이동하면 리드가 실제 plugin root를 확인하며 전역 파일·plugin 원본을 수정하지 않는다.
- 헤더의 Goal·Architecture·Tech Stack·Spec, Global Constraints·Review Focus, `### Task N:`과 checkbox 단계를 유지한다. 설명은 한국어로 작성하고 exact path·인터페이스·값·검증 명령·기대 결과를 구체화한다.
- 각 task에는 목적과 사용자가 확인할 결과, 목표, 수정 범위·범위 밖, 출력 형식, 완료 기준 2~5개, 좁은 검증 디렉터리·명령과 실행 역할을 명시한다. 다른 task와 공유하는 인터페이스와 파일 소유권도 적는다.
- 기본 실행은 이미 승인된 `subagent-driven-development`다. 구현은 Codex `medium`(실패 시 `high`), 계획 작성은 Codex `high`가 맡는다. 작성된 계획 내용 검토는 질문 도구로 받고 실행 방식은 재선택하지 않는다.
- 행동 변경의 RED/GREEN 단계와 최종 검증은 task에 지정한 좁은 범위로 쓴다. 전체 스위트, `tests/mcp/test_claude_real.py` 읽기·수정·실행, `KB_LIVE`는 금지다. 단순 문서·설정은 불필요한 행동 시험을 추가하지 않고 정적 검증을 적는다.
- template의 구현자 직접 git 단계는 `sp-test-runner` 검증 → `sp-committer`의 지정 파일 로컬 커밋 → 별도 Codex 세션 `sp-reviewer`의 `review-package BASE..HEAD` 검토로 바꾼다. 수정도 같은 순서로 새 커밋을 만든다. push·PR·merge·amend·reset을 계획에 넣지 않는다.
- task 결과와 근거는 plan별 `.superpowers/sdd/` workspace에 워커가 기록한다. 문서 상태를 완료로 바꾸는 시점은 목적·좁은 검증·독립 검토가 모두 충족된 뒤다. 마지막에는 브랜치·워크트리를 유지하고 검증 범위와 남은 문제를 보고한다.
