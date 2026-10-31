# stable 배포 게이트

CI를 통과한 커밋만 머신에 나가게 하는 장치입니다. 머신은 `main` 대신 `stable` 브랜치를 따라가고, `stable`은 CI만 움직입니다. 설계 문서의 결정 D-1 안 A에 해당합니다.

**지금은 꺼져 있습니다.** 저장소에 파일만 있고 `stable` 브랜치, 저장소 변수, 머신 등록, `core.hooksPath`는 그대로입니다. 머신은 여전히 `main`을 따라가며 `main` push가 곧 배포입니다. 이 문서의 절차는 D-1을 결정한 뒤에 실행합니다.

## 구성

| 파일 | 하는 일 | 꺼져 있을 때 |
|---|---|---|
| `.github/workflows/ci.yml`의 `promote` 잡 | `check`와 [라이브 스모크](live-smoke.md)가 통과하면 `stable`을 그 커밋으로 fast-forward합니다. 강제 push를 하지 않고 브랜치를 만들지도 않습니다 | 건너뜁니다. 쓰기 토큰도 생기지 않습니다 |
| `.github/workflows/rollback.yml` | 수동 실행으로 `stable`을 CI를 통과했던 이전 커밋으로 되돌립니다 | `stable`이 없으므로 실패합니다 |
| `.githooks/pre-push` | `stable` 직접 push와 삭제를 거부합니다. `main` push 전에 매니페스트 검증, `npm test`, 비밀값 검사를 실행합니다 | `core.hooksPath`를 설정하기 전에는 실행되지 않습니다 |

훅은 `--no-verify`로 건너뛸 수 있고 설정한 clone에서만 동작합니다. 빠른 피드백을 주는 보조 장치이고, 머신을 지키는 것은 `promote`입니다.

훅은 작업 트리가 아니라 push하는 커밋을 임시 폴더에 풀어서 검사합니다. 그래서 커밋하지 않은 수정이 결과를 바꾸지 않습니다. `main` push 때마다 `npm ci`와 gitleaks 내려받기를 거치므로 네트워크가 필요하고, `gitleaks.sh`가 Linux x64 전용이므로 훅도 그 환경에서만 통과합니다. PATH에 `claude`가 없어도 push가 멈춥니다.

`promote`는 `check`와 라이브 스모크를 모두 기다립니다. 스모크가 건너뛰어도 판단할 수 있도록 `if`에 `!cancelled()`가 있고, 이 함수가 "모든 선행 잡 통과" 규칙을 없애므로 `needs.check.result == 'success'`를 따로 적습니다. 이 줄을 지우면 실패한 `check`도 통과합니다. `npm test`와 변이 검사가 이를 막습니다.

스모크 없이 전진하는 길은 두 가지뿐입니다.

- `skip_smoke`로 수동 실행합니다. 러너나 클러스터가 멈췄을 때 그 실행 한 번만 건너뜁니다.
- `LIVE_SMOKE_ENABLED`를 꺼 둡니다. 러너가 없는 동안의 상태로, `promote`는 `check`만 요구합니다. 러너가 잠시 멈췄다고 이 변수를 끄지 마세요.

`check`가 실패하면 어느 쪽이든 전진하지 않습니다. 주간 실행은 스모크가 통과해도 `promote`를 실행하지 않습니다. 롤백한 뒤 `main`에 남아 있는 커밋을 다시 내보내면 안 되기 때문입니다.

## 켜기

저장소에서 한 번만 실행합니다.

1. 이 게이트가 들어간 커밋이 `main`에 있고 CI가 통과했는지 확인합니다. `promote`는 건너뛴 상태여야 합니다.
2. CI를 통과한 마지막 커밋을 고릅니다.

   ```sh
   sha=$(gh run list --workflow ci.yml --branch main --event push --status success --limit 1 --json headSha --jq '.[0].headSha')
   ```

3. `stable`을 만듭니다. `promote`는 브랜치를 만들지 않으므로 소유자가 직접 만듭니다. 훅이 켜져 있어도 되도록 `--no-verify`를 붙입니다.

   ```sh
   git push --no-verify origin "$sha:refs/heads/stable"
   ```

4. 게이트를 켭니다.

   ```sh
   gh variable set STABLE_GATE_ENABLED --body true
   gh workflow run ci.yml
   ```

   Actions에서 `promote`가 `stable already contains`로 끝나는지 봅니다. 실제 전진은 다음 `main` push 때 처음 일어납니다. 스모크가 켜져 있는데 러너가 멈춰 있으면 `gh workflow run ci.yml -f skip_smoke=true`로 실행합니다.

5. [머신별 재등록](#머신별-재등록)을 진행합니다. 재등록 전의 머신은 계속 `main`을 따라갑니다.
6. push하는 clone마다 훅을 켭니다. 이 설정은 그 clone의 모든 worktree에 적용됩니다.

   ```sh
   git config core.hooksPath .githooks
   ```

7. `CLAUDE.md`와 `README.md`의 "`main` push가 배포" 문장을 고칩니다. `README.md`의 설치 명령도 `sagaeforge/sagae-claude-plugins#stable`로 바꿉니다. 그대로 두면 새 머신이 게이트를 거치지 않는 `main`을 따라갑니다.

## 머신별 재등록

플러그인을 쓰는 모든 머신에서 실행합니다. 머신당 약 5분을 잡습니다. `stable`이 만들어진 뒤에 진행합니다.

```sh
claude plugin marketplace remove sagae   # 플러그인도 함께 제거됩니다
claude plugin marketplace add sagaeforge/sagae-claude-plugins#stable
claude plugin install proxmox@sagae
```

이어서 세션을 열고 `/plugin` > Marketplaces > `sagae` > Enable auto-update를 선택합니다. **이 단계를 빠뜨리면 그 머신은 조용히 갱신을 멈춥니다.** `remove`가 `autoUpdate` 설정까지 지우고, 기본값은 꺼짐입니다.

- 토큰 파일 `~/.config/proxmox-mcp/token`은 건드리지 않으므로 다시 발급할 필요가 없습니다.
- `remove` 없이 `add`만 실행하면 `its source doesn't match its extraKnownMarketplaces entry` 오류로 실패합니다.
- `settings.json`의 `source`만 고치는 방법은 쓰지 마세요. CLI가 `Marketplace 'sagae' not found`를 내고 업데이트가 되지 않습니다.
- 실행 중인 세션은 이전 버전을 유지합니다. `/reload-plugins`나 다음 실행부터 적용됩니다.

끝나면 확인합니다.

```sh
claude plugin marketplace list --json | jq '.[] | select(.name == "sagae") | .ref'    # "stable"
jq '.sagae.autoUpdate' ~/.claude/plugins/known_marketplaces.json                      # true
jq -r '.plugins["proxmox@sagae"][0].version' ~/.claude/plugins/installed_plugins.json # 아래 값의 앞 12자리
gh api repos/sagaeforge/sagae-claude-plugins/commits/stable --jq .sha
```

doctor가 병합되어 있으면 `~/.claude/plugins/marketplaces/sagae/plugins/proxmox/scripts/doctor.sh`로 마무리합니다.

## 평소 동작

`main`에 push하면 `check`와 `live-smoke`가 통과한 뒤 `promote`가 `stable`을 그 커밋으로 옮깁니다. 머신은 auto-update로 따라옵니다. PR과 `main` 외 브랜치, 주간 실행에서는 `promote`가 실행되지 않습니다.

| 보이는 현상 | 뜻 | 대처 |
|---|---|---|
| `check` 실패, `promote` 건너뜀 | 게이트가 막았습니다. 머신에는 영향이 없습니다 | 고쳐서 다시 push합니다 |
| `live-smoke` 실패, `promote` 건너뜀 | 게이트가 막았습니다. 머신에는 영향이 없습니다 | 요약의 `INFRA`, `PLUGIN`을 봅니다. [결과 읽기](live-smoke.md#결과-읽기) |
| `live-smoke` 대기 중 | 러너가 꺼져 있습니다. 24시간 뒤 실패합니다 | 러너를 복구하거나 `gh workflow run ci.yml -f skip_smoke=true`를 실행합니다 |
| `main is at ... so its own run decides` | 더 새로운 push가 있어 그 실행이 결정합니다 | 없음 |
| `stable does not exist` | 게이트는 켜져 있는데 브랜치가 없습니다 | [켜기](#켜기)의 2, 3번을 실행합니다 |
| `push`가 `non-fast-forward`로 거부 | `stable`에 직접 push했거나 `main`을 강제 push했습니다 | 두 브랜치의 공통 조상으로 [롤백](#롤백)합니다 |
| `refusing to allow ... workflows permission` | 아래 제약에 걸렸습니다 | 아래 절차를 따릅니다 |

### workflow 파일이 바뀐 커밋

`.github/workflows/`가 바뀐 구간에서는 GitHub가 `promote`의 push를 거부할 수 있습니다. `GITHUB_TOKEN`에는 `workflows` 권한을 줄 수 없고, GitHub의 권한 표에는 ref 생성과 갱신이 Workflows 권한 항목에도 올라 있습니다. 실제로 거부되는지는 아직 확인하지 못했습니다. 이런 구간이면 `promote`가 경고를 남기고, 거부되어도 `stable`은 그대로입니다. 안전하지만 배포가 멈춥니다.

거부되면 `check` 통과를 확인한 뒤 소유자의 SSH 키로 직접 전진시킵니다. 강제 옵션이 없으므로 fast-forward만 됩니다.

```sh
git push --no-verify origin <check를 통과한 SHA>:refs/heads/stable
```

workflow를 바꿀 때마다 이 절차가 필요하고 그 번거로움이 크면 이 저장소 전용으로 Contents와 Workflows 쓰기 권한만 가진 fine-grained PAT를 Secrets에 두고 `promote`의 checkout `token`에 지정합니다. 새 자격 증명이 생기는 일이므로 별도로 결정합니다.

## 롤백

먼저 `main`의 원인을 되돌립니다. 그러지 않으면 다음 push가 같은 내용을 다시 올립니다.

1. CI가 막은 경우: 머신에는 영향이 없습니다. `git revert <sha> && git push`로 끝납니다.
2. 이미 `stable`로 나간 경우: 같은 revert를 push합니다. CI를 통과하면 `stable`이 전진합니다.
3. 러너나 클러스터가 멈춰 스모크를 기다릴 수 없는 경우: revert를 push한 뒤 `gh workflow run ci.yml -f skip_smoke=true`로 `check`만 통과시켜 전진시킵니다.
4. CI 자체를 기다릴 수 없거나 멈춘 경우: revert를 push한 뒤 `rollback.yml`로 `stable`을 CI를 통과한 커밋으로 되돌립니다.

   ```sh
   gh run list --workflow ci.yml --branch main --status success --limit 5 --json headSha,displayTitle
   gh workflow run rollback.yml -f sha=<전체 SHA>
   ```

   `rollback.yml`은 `main`에 있고, `stable`보다 이전이며, CI를 통과한 커밋만 받습니다. 그래서 `main`의 다음 커밋은 다시 fast-forward로 전진합니다.

   workflow 파일이 바뀐 구간이라 거부되면 소유자가 직접 실행합니다. `stable`이 그 사이 움직였다면 이 명령은 실패합니다.

   ```sh
   git push --no-verify --force-with-lease=refs/heads/stable:<지금 stable SHA> origin <전체 SHA>:refs/heads/stable
   ```

5. 각 머신에서 바로 반영합니다.

   ```sh
   claude plugin marketplace update sagae && claude plugin update proxmox@sagae
   ```

   세션 안에서는 `/reload-plugins`를 실행합니다. `stable`이 뒤로 움직여도 이 명령은 이전 버전으로 되돌립니다.

6. 긴급 차단이 필요하면 `claude plugin disable proxmox@sagae`를 실행하고, 복구 후 `enable`합니다.

## 잠시 멈추기와 끄기

`promote`만 멈추려면 변수를 끕니다. `stable`은 그 자리에 머물고 머신도 그대로입니다. `rollback.yml`은 계속 쓸 수 있습니다.

```sh
gh variable set STABLE_GATE_ENABLED --body false
```

게이트를 없애려면 모든 머신을 다시 `main`으로 등록한 뒤(재등록 절차에서 `#stable`만 뺍니다. auto-update도 다시 켭니다) 변수와 브랜치를 지웁니다.

```sh
gh variable delete STABLE_GATE_ENABLED
git push --no-verify origin :stable
git config --unset core.hooksPath
```

## 확인한 범위

| 항목 | 상태 |
|---|---|
| `promote.sh`, `rollback.sh`, `pre-push`의 동작 | `npm test`가 실제 git과 임시 bare 저장소로 검사합니다 |
| 재등록과 `stable` 전진, 후진의 머신 반영 | 임시 설정 폴더와 로컬 저장소로 실행했습니다(Claude Code 2.1.316, `git` URL 소스, 수동 update 명령) |
| `promote`의 실행 조건 | `npm test`가 `ci.yml`의 실제 `if` 식을 경우별로 평가합니다. 작업 상태 규칙은 테스트가 흉내 낸 것입니다 |
| GitHub Actions에서의 `promote`, `rollback.yml` 실행 | **미검증.** 아직 한 번도 실행되지 않았습니다 |
| `GITHUB_TOKEN`의 `stable` push와 workflow 파일 제약 | **미검증.** 첫 사례는 W8이 `ci.yml`을 바꿀 때입니다 |
| `owner/repo#ref` 형식 등록 | **미검증.** 공식 문서의 형식이며 실제로는 URL 형식만 실행했습니다 |
| `stable`이 뒤로 움직였을 때의 백그라운드 auto-update | **미검증.** 수동 명령만 확인했습니다. 롤백할 때는 5번을 실행합니다 |

`--no-verify`로 `main`의 커밋을 `stable`에 직접 올리면 fast-forward인 한 탐지되지 않습니다. 이 게이트는 실수를 막는 장치이고, 소유자의 자격 증명은 막지 못합니다.
