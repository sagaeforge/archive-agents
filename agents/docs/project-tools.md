# 프로젝트 도구: rtk, Trail-Code

이 저장소에서 세션을 시작하면 rtk와 Trail-Code가 훅으로 연결됩니다. 등록은 `.claude/settings.json`에만 있어서 다른 프로젝트에는 영향이 없고, 플러그인과 함께 배포되지도 않습니다. 전역 설정, 권한 규칙, statusLine은 추가하지 않습니다.

## 실행되는 훅

| 스크립트 (`.claude/hooks/`) | 시점 | 하는 일 | 제한 시간 |
| :- | :- | :- | :- |
| `rtk-rewrite.sh` | Bash 실행 전 | 아래 명령만 rtk를 거치도록 바꿉니다 | 5초 |
| `trail-context.sh` | 프롬프트 제출 시 | `trail ask`로 찾은 코드 위치를 최대 3개 컨텍스트에 넣습니다. 맵이 없으면 먼저 `trail build`를 실행합니다 | 12초 |
| `trail-sync.sh` | Write, Edit, MultiEdit 후 | 프로젝트 안의 파일이 바뀌면 `trail build`로 맵(`graft/`)을 갱신합니다 | 15초 |

**rtk가 바꾸는 명령은 다음뿐입니다. 나머지는 모두 원본 그대로 실행됩니다.**

- 옵션 없는 `git status`
- `grep`: `-r -R -n -E -F -i -w` 옵션만 쓴 경우
- `rg`: `-n -N -i -F -w -S` 옵션만 쓴 경우

파이프, 리디렉션, `&&`, `$`, `\`가 있는 명령과 검색어에 `git`이 들어간 명령도 원본입니다. `git diff`, `git log`, git 내부 명령, `gh`, `npm test`, `claude plugin validate`, `orca-ide`, `ls`, `tree`, `find`도 마찬가지입니다.

**재작성은 `bypassPermissions` 모드에서만 일어납니다.** 다른 모드에서 바꾸면 자동 승인되던 `git status`에 승인 요청이 뜨기 때문입니다. Trail 훅은 모든 모드에서 동작합니다.

**실제 실행 형태는 `true || <원본>; <rtk 명령>`입니다.** `true ||` 뒤의 원본은 실행되지 않습니다. Claude Code는 모든 하위 명령에 deny, ask 규칙을 적용하므로, 원본을 남겨 두면 어디에 정의된 규칙이든 그대로 적용됩니다. PostToolUse 훅이나 Orca에는 이 형태로 보입니다.

**출력에서 달라지는 점:** `git status`는 형식만 줄고 정보는 그대로입니다. `grep`, `rg`는 결과가 많을 때만 줄어듭니다. 파일당 25개까지 보여 주고 `+15 more in a.txt`로 표시하며, 긴 줄은 `...`로 자르고 들여쓰기를 없앱니다. 재작성할 때마다 모델에게 원본 보는 방법을 알립니다.

**한계**

- `.claude/worktrees/` 안에서는 rtk가 git을 재작성하지 않으므로 `grep`, `rg`만 바뀝니다.
- Trail은 영어 토큰으로 찾습니다. 한글만 있는 프롬프트에는 대개 아무것도 추가되지 않습니다. 파일명이나 심볼 이름을 함께 쓰면 찾습니다.
- 프로젝트 훅은 세션을 시작한 폴더의 `.claude/settings.json`에서 읽습니다. `plugins/proxmox`처럼 하위 폴더에서 시작하면 동작하지 않습니다.

## 끄는 방법

세션 하나만 끌 때:

```sh
RTK_DISABLED=1 claude     # rtk 훅만
TRAIL_NO_HOOKS=1 claude   # Trail 훅 둘 다
```

계속 끄려면 메인 체크아웃의 `.claude/settings.local.json`에 넣습니다. 이 파일은 git에 올라가지 않고 모든 worktree에 적용됩니다.

```json
{ "env": { "RTK_DISABLED": "1", "TRAIL_NO_HOOKS": "1" } }
```

`{ "disableAllHooks": true }`도 있지만 Orca 훅 등 사용자 수준 훅까지 함께 꺼지므로 권장하지 않습니다.

## 원본 출력 보기

앞에 `RTK_DISABLED=1`을 붙입니다. 훅이 건드리지 않으므로 항상 원본이 나옵니다.

```sh
RTK_DISABLED=1 grep -rn createClient plugins
RTK_DISABLED=1 git status
```

`grep ... | cat`처럼 파이프를 붙이거나 `/usr/bin/grep`처럼 전체 경로를 써도 원본입니다. rtk의 복구 기록(recall)은 꺼 두었으므로 `rtk recall`은 쓸 수 없습니다.

## 도구가 없는 PC

아무 일도 일어나지 않습니다. 훅은 조용히 끝나고 명령과 프롬프트는 그대로 진행됩니다. 설치를 권하거나 내려받지 않습니다. 다음 중 하나라도 맞지 않으면 그렇게 동작합니다.

- `~/.local/bin/rtk`가 없거나 버전이 1.1.0이 아닌 경우 (rtk 훅)
- `~/.local/share/trail-code/0.28.1`이 없는 경우 (Trail 훅)
- `jq`나 `timeout`이 없는 경우 (모든 훅)

도구가 멈추거나 오류를 내도 같습니다. 제한 시간 안에 끊기고 원래 작업이 계속됩니다.

## 제거

```sh
git rm .claude/settings.json .claude/hooks/rtk-rewrite.sh \
  .claude/hooks/trail-context.sh .claude/hooks/trail-sync.sh .claude/hooks/trail-env.sh
git rm -r tests/project-hooks docs/project-tools.md
rm -rf graft
```

`.claude/settings.json`에 다른 설정이 생겼다면 파일을 지우지 말고 해당 훅 항목만 지웁니다. 도구까지 지우려면 다음을 실행합니다.

```sh
rm ~/.local/bin/rtk; rm -rf ~/.config/rtk ~/.local/share/rtk
rm ~/.local/bin/trail; rm -rf ~/.local/share/trail-code ~/.graft
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

실제 Claude Code를 가짜 HOME, 네트워크 차단 상태로 실행해 확인합니다(모델은 스크립트로 대체). `bwrap`이나 도구가 없으면 세션 테스트는 건너뜁니다. rtk, Trail-Code, Claude Code를 올린 뒤에는 꼭 다시 실행합니다. 특히 `true ||` 형태와 재작성 허용 목록은 현재 버전에서 확인한 동작에 의존합니다.
