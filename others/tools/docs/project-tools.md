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
