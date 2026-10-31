# 프로젝트 도구: rtk, Trail-Code

이 저장소에서 세션을 시작하면 rtk와 Trail-Code가 훅으로 연결됩니다. 등록은 `.claude/settings.json`에만 있어서 다른 프로젝트에는 영향이 없고, 플러그인과 함께 배포되지도 않습니다. 전역 설정, 권한 규칙, statusLine은 추가하지 않습니다.

## 적용 시점과 확인 범위

- **재시작 없이 적용됩니다.** 훅 파일이 체크아웃에 생기면 실행 중인 세션도 읽습니다. merge나 pull이 끝나는 순간 그 체크아웃의 세션에 켜진다는 뜻입니다. 약 1.5초가 걸렸고, 6초 뒤에는 모두 적용되어 있었습니다. rtk는 같은 턴의 다음 `git status`부터, Trail은 다음 프롬프트부터 동작합니다. 확인한 조건은 폴더를 이미 신뢰했고 `.claude/`가 이미 있는 경우입니다.
- **확인한 버전:** Claude Code 2.1.316과 2.1.314, rtk 1.1.0, Trail-Code 0.28.1입니다. 두 Claude Code 버전 모두 전체 테스트와 실행 중 적용을 확인했습니다. 가짜 HOME과 네트워크 차단 상태에서 모델을 스크립트로 대체해 확인했습니다. 실제 모델을 쓴 세션, 실제 사용자 설정, Orca와 함께 쓴 경우는 확인하지 않았습니다.

## 실행되는 훅

| 스크립트 (`.claude/hooks/`) | 시점 | 하는 일 | 제한 시간 |
| :- | :- | :- | :- |
| `rtk-rewrite.sh` | Bash 실행 전 | 옵션 없는 `git status`를 rtk로 실행합니다 | 5초 |
| `trail-context.sh` | 프롬프트 제출 시 | `trail ask`로 찾은 코드 위치를 최대 3개 컨텍스트에 넣습니다. 맵이 없으면 먼저 `trail build --no-reuse`로 파일을 모두 읽어 맵을 만듭니다 | 12초 |

편집 뒤에 실행되는 훅은 없습니다. 맵(`graft/`)이 작업 트리와 달라지면 `trail ask`가 답하기 전에 스스로 갱신하므로, Write든 Bash든 다른 세션이든 어떤 경로로 바뀌어도 다음 프롬프트의 포인터는 최신입니다. 파일 크기와 수정 시각을 모두 그대로 둔 채 내용만 바꾸는 도구는 예외입니다.

## rtk

**rtk는 `bypassPermissions` 모드의 프로젝트 루트에서 실행한 옵션 없는 `git status`에만 동작하고, `.claude/worktrees/` 안에서는 동작하지 않습니다.** 그래서 격리된 worktree에서 일하는 에이전트에게는 아무 효과가 없고, 줄어드는 토큰도 크지 않습니다. 다음 조건을 모두 만족할 때만 바꾸고, 나머지는 모두 원본 그대로 실행됩니다.

- `bypassPermissions` 모드입니다. 다른 모드에서 바꾸면 자동 승인되던 `git status`에 승인 요청이 뜹니다.
- 작업 폴더가 프로젝트 루트입니다. rtk는 저장소 루트 기준 경로를 출력하므로, 하위 폴더에서는 다른 파일을 가리킬 수 있습니다. `cd`로 옮긴 뒤에도 마찬가지입니다.
- `.claude/worktrees/` 밖입니다. 그 안에서는 Claude Code의 격리 가드가 `rtk git`을 거부합니다. 그래서 격리된 에이전트와 `--worktree` 세션에서는 rtk가 아무것도 바꾸지 않습니다.
- 진행 중인 작업이 없습니다. merge, rebase, cherry-pick, revert, am, bisect 중이면 바꾸지 않습니다. rtk는 상태를 한 줄만 보여 주고, 범위 cherry-pick이나 revert가 멈춘 상태를 알아보지 못해 적용되지 않은 커밋이 남아 있어도 `clean`이라고 출력합니다.
- 저장소 루트에 이름에 `HEAD detached `가 들어간 파일이 없습니다. rtk가 파일 이름을 분리된 HEAD 표시로 오해해 브랜치와 ahead/behind 대신 그 이름을 출력합니다.
- git이 트리 전체를 봅니다. `status.showUntrackedFiles`가 기본값(`normal`)이 아니거나 git이 열지 못하는 폴더가 있으면 바꾸지 않습니다. 원본 git은 `use -u`나 `Permission denied`로 일부만 봤다고 알리지만, rtk는 그대로 `clean`이라고 출력합니다.

`git diff`, `git log`, git 내부 명령, `gh`, `npm test`, `claude plugin validate`, `orca-ide`, `ls`, `tree`, `find`는 바꾸지 않습니다.

**`grep`, `rg`도 바꾸지 않으며, 목록에 다시 넣으면 안 됩니다.**

- Bash 도구의 `grep`, `rg`는 `.gitignore`를 따르는 Claude Code 내장 함수입니다. `rtk grep`은 `/usr/bin/grep`을 실행하므로 `.env`, `.git/config`, `graft/`, `.claude/worktrees/`까지 읽고, Read deny 규칙으로도 막히지 않습니다.
- 결과가 없는 검색이 실패한 도구 호출이 됩니다. Claude Code는 실행한 명령이 `grep`, `rg`일 때만 종료 코드 1을 결과 없음으로 봅니다.
- 결과가 많으면 긴 경로를 `plugins/.../server/index.mjs`처럼 줄입니다. 서로 다른 파일이 같은 이름으로 보이고, 그 경로는 열 수 없습니다.
- 격리된 에이전트에서는 `*`, `{a,b}`가 든 명령이 거부되고, 시스템 `rg`가 없는 PC에서는 `rtk rg`가 실패합니다. 명령이 길면 deny 규칙을 비껴갈 수도 있습니다.

**실제 실행 형태는 `timeout ... rtk git status || git status`입니다.** rtk가 실패하거나 5초 안에 끝나지 않으면 원본이 실행되고 그 종료 코드가 결과가 됩니다. 원본이 하위 명령으로 남으므로 어디에 정의된 deny, ask 규칙이든 그대로 적용됩니다. PostToolUse 훅이나 Orca에는 이 형태로 보입니다.

**출력에서 달라지는 점:** 브랜치, upstream 대비 ahead/behind, 변경 파일, 충돌은 그대로 보입니다. 사라지는 것은 git의 안내 문구, sparse checkout 비율, 서브모듈 변경의 세부 내용, `status.showStash`를 켠 경우의 stash 개수, 위 조건으로 걸러지지 않는 stderr 경고(예: 줄바꿈 변환 경고)입니다. 재작성할 때마다 모델에게 원본 보는 방법을 알립니다.

rtk의 사용 기록 DB는 만들지 않습니다. DB 경로를 만들 수 없는 곳(`/dev/null/rtk.db`)으로 지정하므로 root나 컨테이너에서도 `/dev`를 건드리지 않습니다.

## Trail

Trail 훅은 모든 모드에서 동작합니다.

- Trail은 영어 토큰으로 찾습니다. 한글만 있는 프롬프트에는 대개 아무것도 추가되지 않습니다. 파일명이나 심볼 이름을 함께 쓰면 찾습니다.
- 훅은 `ask`와 `build`만 실행하고 노트를 읽지도 보여 주지도 않습니다. `TRAIL_HOME`을 존재할 수 없는 경로로 지정하므로 `~/.trail`을 읽지도 쓰지도 않습니다.
- 사람이 입력한 프롬프트에만 동작합니다. 백그라운드 작업 알림, 다른 에이전트나 세션이 보낸 메시지처럼 Claude Code가 넣는 턴은 건너뜁니다. 맨 앞(또는 안내 문구 한 줄 다음)이 `<태그`로 시작하는 프롬프트도 이런 턴으로 보므로, 사람이 그렇게 입력해도 컨텍스트가 붙지 않습니다.
- 에이전트 팀에서는 사람이 리드에게 입력한 프롬프트에만 Trail 컨텍스트가 붙습니다. 팀원의 첫 지시와 팀원끼리 주고받는 메시지에서는 `UserPromptSubmit` 훅 자체가 실행되지 않습니다. 팀원의 `git status`에는 위의 rtk 조건이 그대로 적용됩니다.
- 코드 위치는 3개까지 넣습니다. 더 있으면 마지막 줄에 목록이 완전하지 않다고 표시하므로, 호출자 목록을 그것이 전부라고 읽지 않습니다.
- 이름과 경로는 프로젝트가 정한 글인데 훅 컨텍스트로 모델에게 전달되므로, 코드처럼 생긴 항목만 넣습니다. 쓸 수 있는 문자는 영문자, 숫자, `_ $ . # @ : / -`이고, 이름은 64자, 경로는 160자까지입니다. `/`로 시작하거나 `..`로 위로 올라가는 경로도 뺍니다. 뺀 항목이 있으면 목록이 완전하지 않다는 표시가 붙습니다. 공백이나 한글이 든 파일 이름, 문자열로 쓴 메서드 이름, 문장을 넣은 `import` 문자열은 이렇게 빠지므로 띄어 쓴 문장이나 가짜 훅 출력 줄은 이 훅으로 들어가지 못합니다. **식별자 모양으로 쓴 문구는 막지 못합니다.** `the_user_approved_setup` 같은 이름은 그대로 나가므로 머리글에 지시가 아니라고 적어 둡니다. 실제 모델이 이 머리글을 어떻게 읽는지는 확인하지 않았습니다.
- 맵은 세션을 시작한 체크아웃을 설명합니다. `EnterWorktree`로 다른 체크아웃에 들어가면 포인터가 그곳의 코드와 맞지 않으므로 훅이 아무것도 넣지 않습니다. 빠져나오면 다시 동작합니다. 같은 체크아웃의 하위 폴더로 `cd`한 경우는 그대로 동작합니다.
- 포인터는 그래프에서만 나옵니다. `graft/` 아래의 `.md` 카드와 `INDEX.md`는 맵을 처음 만들 때만 쓰이고 그 뒤로는 갱신되지 않으므로, `find`나 `cat`으로 직접 읽으면 낡은 내용일 수 있습니다. 새로 만들려면 `rm -rf graft`를 실행합니다.
- **`graft/.cache`에는 소스 본문의 사본이 있습니다.** 주석을 포함한 코드가 `graft/.cache/extract.*.json`에 복사되고, 원본의 파일 권한은 따라오지 않습니다. **`Read` deny 규칙은 이 사본을 막지 못합니다.** git에는 올라가지 않으며, 원본에서 값을 지우면 다음 갱신 때 사본에서도 사라집니다.
- 훅에서 실행하는 Trail은 프로젝트 파일을 따라 프로젝트 밖에 쓰거나 명령을 실행하지 않습니다. `.env`를 읽지 않고, 다른 체크아웃의 맵을 복사하지 않으며, `.gitignore`를 고치지 않습니다. 설정 파일의 `env`로 들어온 `GRAFT_DIR`도 지웁니다. Trail이 실행하는 git에서는 저장소의 `core.fsmonitor`와 `core.hooksPath`가 꺼집니다. `.claude/settings.json`은 명령을 직접 등록할 수 있는 파일이므로 이 설명의 대상이 아닙니다.
- **맵을 만들 때는 `--no-reuse`로 파일을 모두 다시 읽고 `graft/.cache`의 파싱 캐시를 쓰지 않습니다.** Trail은 캐시에 든 경로를 확인하지 않고 그 경로에 `.md` 카드를 쓰기 때문에, JSON 파일 하나로 `~/.claude/CLAUDE.md` 같은 파일을 덮어쓸 수 있습니다. 파일 이름에 붙는 값은 Trail 버전이 같으면 어디서나 같고, `git add -f`로 커밋에 넣을 수도 있습니다. 맵이 이미 있으면 `trail ask`가 갱신할 때 이 캐시를 읽습니다. 이때는 카드를 쓰지 않으므로 프로젝트 밖에 쓰지는 않지만, 심어 둔 항목이 맵에 들어가고 코드처럼 생겼다면 잘못된 코드 위치로 출력될 수 있습니다.
- **직접 실행하는 `trail`에는 이 보호가 없습니다.** 직접 실행한 `trail build`는 캐시를 그대로 재사용하므로, 출처를 모르는 브랜치에서는 먼저 `rm -rf graft`를 실행합니다.
- **`.trail/`이 있으면 Trail 훅이 멈춥니다.** 아래 저장소 노트를 참고합니다. `.claude/helpers/trail-hooks.cjs`나 `.claude/skills/trail/SKILL.md`가 있거나, `.claude/settings.json`에 `trail-hooks.cjs` 또는 `/.trail/hook.cjs`라는 글자가 있어도 같습니다. Trail은 이것들을 보고 저장소가 자기 경로에 있다고 판단해 `.trail/`을 만들고 맵을 옮기고 백그라운드 프로세스를 띄우며, 맵이 없으면 캐시를 재사용하는 빌드를 백그라운드로 시작합니다. 보통 `trail init`이 남기는 것들입니다. 다시 켜려면 그 파일이나 글자를 지웁니다.
- 다음 중 하나가 있어도 **Trail 훅이 Trail을 실행하지 않고 조용히 멈춥니다.** 프로젝트 밖의 경로를 가리킬 수 있기 때문입니다. `graft/workspace.json`, 심볼릭 링크인 `graft`나 `.graft`, 그 두 폴더 안의 심볼릭 링크입니다. 이 저장소에서는 어느 것도 저절로 생기지 않습니다. 다시 켜려면 `rm -rf graft .graft`를 실행합니다.
- 프로젝트 폴더에 `.git`이 없어도 Trail 훅이 멈춥니다. `.git`이 없는 폴더 아래에 git 저장소가 둘 이상 있으면 Trail이 workspace로 보고 각 저장소를 캐시를 재사용해 빌드하는데, `--no-reuse`가 그 빌드까지 전달되지 않기 때문입니다.

`trail note`는 직접 실행할 때만 동작합니다.

- **개인 노트(`--personal`):** `~/.trail/`에 저장되며 훅에는 영향이 없습니다.
- **저장소 노트(`--personal` 없음):** `.trail/`에 저장되고, **그 체크아웃에서는 Trail 훅이 멈춥니다.** `.trail/`이 있으면 `trail ask`가 백그라운드 프로세스를 띄우고 코드 맵이 `.trail/cache/`로 옮겨지는데, Trail에 이를 끄는 설정이 없기 때문입니다. `.trail/`은 git에 올라가지 않으므로 다른 worktree는 영향을 받지 않습니다. 다시 켜려면 `rm -rf .trail`을 실행합니다. 이 체크아웃의 저장소 노트도 함께 지워집니다.

## 한계

- 프로젝트 훅은 세션을 시작한 폴더의 `.claude/settings.json`에서 읽습니다. `plugins/proxmox`처럼 하위 폴더에서 시작하면 동작하지 않습니다.
- 대화형 세션은 폴더 신뢰를 승인해야 훅이 실행됩니다. `claude -p`는 이 확인 없이 실행합니다.
- 추적 중인 파일의 상위 폴더를 심볼릭 링크로 바꾸면 Trail이 링크 너머의 파일을 읽어 맵에 넣습니다. 프로젝트 밖에 쓰지는 않습니다. 전체 트리를 훑어야 알 수 있어 막지 않습니다.
- 훅이 실행하는 것은 모두 파일입니다. `bypassPermissions`에서는 Write 도구로 `.claude/hooks/`의 스크립트나 rtk, Trail 설치 파일을 고칠 수 있고, 고친 내용은 다음 훅에서 셸로 실행됩니다. Bash를 막아도 이 경로는 막히지 않습니다. 막으려면 해당 경로에 `Edit` deny 규칙이 필요하며, 이 저장소는 권한 규칙을 넣지 않습니다. `acceptEdits`는 `.claude/hooks/` 쓰기를 거부합니다.

## 끄는 방법

세션 하나만 끌 때:

```sh
RTK_DISABLED=1 claude     # rtk 훅만
TRAIL_NO_HOOKS=1 claude   # Trail 훅만
```

계속 끄려면 메인 체크아웃의 `.claude/settings.local.json`에 넣습니다. 이 파일은 git에 올라가지 않고 모든 worktree에 적용됩니다.

```json
{ "env": { "RTK_DISABLED": "1", "TRAIL_NO_HOOKS": "1" } }
```

`{ "disableAllHooks": true }`도 있지만 Orca 훅 등 사용자 수준 훅까지 함께 꺼지므로 권장하지 않습니다.

## 원본 출력 보기

앞에 `RTK_DISABLED=1`을 붙입니다. 훅이 건드리지 않으므로 항상 원본이 나옵니다.

```sh
RTK_DISABLED=1 git status
```

`git status | cat`처럼 파이프를 붙이거나 `git status --long`처럼 옵션을 줘도 원본입니다. merge, rebase처럼 진행 중인 작업이 있거나 git이 트리의 일부만 볼 수 있으면 자동으로 원본이 나옵니다. rtk의 복구 기록(recall)은 꺼 두었으므로 `rtk recall`은 쓸 수 없습니다.

## 도구가 없는 PC

아무 일도 일어나지 않습니다. 훅은 조용히 끝나고 명령과 프롬프트는 그대로 진행됩니다. 설치를 권하거나 내려받지 않습니다. 다음 중 하나라도 맞지 않으면 그렇게 동작합니다.

- `~/.local/bin/rtk`가 없거나 버전이 1.1.0이 아닌 경우 (rtk 훅)
- `~/.local/share/trail-code/0.28.1`이 없는 경우 (Trail 훅)
- `jq`나 `timeout`이 없는 경우 (모든 훅)
- `git`으로 저장소 상태를 확인하지 못하는 경우 (rtk 훅)
- `graft/`나 `.graft/`가 있는데 `find`가 없는 경우 (Trail 훅)

도구가 멈추거나 오류를 내도 같습니다. 제한 시간 안에 끊기고 원래 작업이 계속됩니다. rtk가 `git status`를 실행하다 실패해도 원본이 대신 실행됩니다.

## 제거

```sh
git rm .claude/settings.json .claude/hooks/rtk-rewrite.sh \
  .claude/hooks/trail-context.sh .claude/hooks/trail-env.sh
git rm -r tests/project-hooks docs/project-tools.md
rm -rf graft .graft .trail
```

`.claude/settings.json`에 다른 설정이 생겼다면 파일을 지우지 말고 해당 훅 항목만 지웁니다. `graft`, `.graft`, `.trail`은 체크아웃마다 따로 있습니다.

도구까지 지우려면 다음을 실행합니다. `~/.trail`의 개인 노트도 함께 지워지므로 필요하면 먼저 옮겨 둡니다.

```sh
rm ~/.local/bin/rtk; rm -rf ~/.config/rtk ~/.local/share/rtk
rm ~/.local/bin/trail; rm -rf ~/.local/share/trail-code ~/.graft ~/.trail
```

## 하면 안 되는 것

- **`trail init`:** 허용 규칙(`Bash(trail:*)`)을 추가하고, Claude 메모리 노트를 커밋 가능한 `.trail/learnings/`로 복사하며, 이후 세션이 전역 훅과 statusLine을 다시 씁니다.
- **`rtk init`, `rtk init -g`:** `CLAUDE.md` 또는 전역 설정을 바꿉니다. rtk가 `rtk init -g`를 권해도 따르지 않습니다.
- **`trail mcp`, SessionStart 훅에서 Trail 호출:** 전역 파일을 다시 쓰는 자가 복구가 이 경로로 실행됩니다.
- **`trail upgrade`, `Bash(rtk:*)`나 `Bash(trail:*)` 허용 규칙 추가:** 버전 고정과 권한 규칙이 무력해집니다.

## 테스트

```sh
sh tests/project-hooks/run.sh
```

실제 Claude Code를 가짜 HOME, 네트워크 차단 상태로 실행해 확인합니다(모델은 스크립트로 대체). 필요한 도구가 없으면 테스트는 실패하지 않고 이유를 남기며 건너뜁니다. `jq`나 `timeout`이 없으면 훅 출력을 확인하는 테스트를, `bwrap`, Claude Code, rtk, Trail-Code가 없으면 세션 테스트를, `tmux`가 없으면 에이전트 팀 테스트를 건너뜁니다. 다른 Claude Code 버전으로 확인하려면 `PROJECT_HOOKS_CLAUDE=<실행 파일 경로>`를 앞에 붙입니다. rtk, Trail-Code, Claude Code를 올린 뒤에는 꼭 다시 실행합니다. 특히 `|| git status` 형태와 `TRAIL_HOME`, `DOTENV_PATH`, `GRAFT_NO_SEED`, `--no-reuse`, `.trail/` 처리, Trail이 자기 경로로 판단하는 파일 목록, 진행 중인 작업을 건너뛰는 규칙, 팀원 턴에 프롬프트 훅이 실행되지 않는 동작은 현재 버전에서 확인한 것에 의존합니다.
