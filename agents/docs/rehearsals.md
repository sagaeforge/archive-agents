# 리허설 체크리스트

실제 push, 토큰 교체, 깨끗한 머신이 필요한 연습입니다. 설계 문서 W9의 완료 조건에 해당합니다.

**아래 네 항목은 모두 미검증입니다.** 문서만 작성했고 한 단계도 실행하지 않았습니다. 실행하다가 문서와 다른 점이 나오면 문서를 고치고 [결과 기록](#결과-기록)에 남깁니다.

| # | 리허설 | 상태 | 시작 조건 |
|---|---|---|---|
| 1 | [깨끗한 머신 온보딩](#1-깨끗한-머신-온보딩) | 미검증 | 기반 작업이 `main`에 병합되어 있습니다 |
| 2 | [토큰 교체](#2-토큰-교체) | 미검증 | 1번이 끝났습니다 |
| 3 | [롤백](#3-롤백) | 미검증 | D-1을 결정했습니다. `stable` 되돌림은 게이트가 켜져 있어야 합니다 |
| 4 | [공유 토큰 `mcp` 폐기](#4-공유-토큰-mcp-폐기) | 미검증 | 모든 머신을 옮겼고 사용자가 승인했습니다. 항상 마지막입니다 |

## 시작하기 전에

- [ ] 리허설마다 사용자가 승인한 뒤 시작합니다. 클러스터의 토큰이나 배포되는 커밋이 실제로 바뀝니다.
- [ ] 플러그인을 쓰는 머신 목록을 적습니다. 지금 확인된 머신은 `sagae-windows` 1대뿐입니다.

아래에서 doctor는 `~/.claude/plugins/marketplaces/sagae/plugins/proxmox/scripts/doctor.sh`를 뜻하고, `bootstrap-token.sh`도 같은 폴더에 있습니다.

## 1. 깨끗한 머신 온보딩

**미검증.** 플러그인을 쓴 적 없는 환경에서 [README](../README.md#새-pc-설치)만 보고 설치를 끝내 doctor가 통과하는지 봅니다. 아래 둘은 여기서 처음 실제로 실행됩니다.

- 의존성 자동 설치. 공식 문서에는 있지만 새 머신에서 실행해 본 적이 없습니다.
- `bootstrap-token.sh`의 원격 부분. 실제 `ssh`, `pveum`, `--expire`, 토큰 ID 형식을 처음 거칩니다.

### 준비

- [ ] `~/.claude/plugins/marketplaces/sagae`와 `~/.config/proxmox-mcp`가 없는 환경을 고릅니다. 새 PC, 새 VM, 새 WSL 배포판 중 하나입니다.
- [ ] `hostname -s`가 다른 머신과 겹치지 않는지 확인합니다. 토큰 ID 기본값이 `m-<호스트>-<연월>`입니다. 같은 Windows의 새 WSL 배포판은 이름이 같을 수 있습니다. 겹치면 호스트 이름을 바꾼 뒤 시작합니다.

### 실행

- [ ] 시작 시각을 적습니다.
- [ ] README의 준비를 README만 보고 갖춥니다.
- [ ] `claude plugin marketplace add`와 `claude plugin install`까지 실행합니다.
- [ ] `bootstrap-token.sh`가 새 버전인지 확인합니다. `0`이 나오면 **멈춥니다.** 옛 버전은 토큰 파일이 없는 머신에서 공유 토큰을 다시 발급해 다른 머신을 모두 401로 만듭니다.

  ```sh
  grep -c -- --rotate ~/.claude/plugins/marketplaces/sagae/plugins/proxmox/scripts/bootstrap-token.sh
  ```

- [ ] `claude plugin list`에 `The packages it lists`로 시작하는 Note가 없는지 봅니다. Claude Code가 설치를 거부했으면 `were not installed, because <이유>`, 설치가 끝나지 못했으면 `are not installed`가 뒤에 붙습니다. `npm`이 없을 때의 이유는 `it needs npm`으로 시작합니다.
- [ ] `bootstrap-token.sh`를 실행합니다. `Token claude-mcp@pve!m-<호스트>-<연월> written to ...`가 나옵니다.
- [ ] auto-update를 켭니다.
- [ ] doctor를 실행합니다.
- [ ] 새 세션의 `/mcp`(`tower`)와 `클러스터 상태 알려줘`로 확인합니다.
- [ ] 호출 로그가 남았는지 봅니다. 방금 호출한 도구의 줄이 있고 권한이 `600`이어야 합니다. 토큰 값이 없어야 합니다.

  ```sh
  LOG="$(jq -r .upstreams.proxmox.env.PVE_LOG_FILE ~/.config/tower/tower.json)"
  stat -c '%a' "$LOG"
  tail -n 5 "$LOG"
  ```

- [ ] 끝 시각을 적습니다.

### 통과 기준

- [ ] doctor 종료 코드가 `0`입니다. `1`이면 경고 내용을 적습니다. `main`의 마지막 CI가 성공이 아니면 10번 경고로 `1`이 나옵니다.
- [ ] 4번이 `node_modules has all 2 dependencies.`로 통과합니다.
- [ ] 5번의 ID가 이 머신의 `m-<호스트>-<연월>`이고, 6번이 `Rotate by <날짜>.`로 통과합니다.
- [ ] README에 없는 일을 하지 않았습니다. 했다면 그 자체가 README의 결함이므로 적고 고칩니다.

## 2. 토큰 교체

**미검증.** 1번의 머신에서 실행합니다. 자기 토큰만 바뀌므로 다른 머신에 영향이 없고, 실패해도 그 머신만 다시 설치하면 됩니다.

### 실행

- [ ] 현황을 저장합니다. ID만 나오고 토큰 값은 나오지 않습니다.

  ```sh
  ssh pve-node 'pveum user token list claude-mcp@pve'
  ```

- [ ] 시작 시각을 적습니다.
- [ ] 교체합니다. `Token claude-mcp@pve!m-<호스트>-<연월>-2 written to ...`와 `Old token m-<호스트>-<연월> deleted.`가 나옵니다. 같은 달에 교체하면 새 ID에 `-2`가 붙습니다.

  ```sh
  ~/.claude/plugins/marketplaces/sagae/plugins/proxmox/scripts/bootstrap-token.sh --rotate
  ```

- [ ] 세션을 재시작하지 말고 도구를 한 번 호출합니다. 서버는 호출마다 토큰 파일을 읽으므로 401이 나오면 안 됩니다.
- [ ] doctor의 5, 6, 8번이 통과합니다.
- [ ] 토큰 목록을 다시 봅니다. 이전 ID가 사라지고 새 ID가 생겼으며 나머지는 그대로입니다.
- [ ] 다른 머신에서 도구를 한 번 호출합니다. 401이 나오면 안 됩니다.
- [ ] 끝 시각을 적습니다.

파일을 바꾸기 전에 실패하면 이전 토큰과 파일은 그대로 남습니다. 스크립트의 출력을 적고 멈춥니다. PVE 소스를 읽은 바로는 토큰을 지워도 ACL 줄이 남고 PVE가 경고와 함께 무시합니다. 실제로 보지는 않았으므로 그런 경고가 나오면 적습니다.

### 실제 머신 전환

통과하면 [공유 토큰 전환](../README.md#공유-토큰-mcp에서-전환)을 머신 1대부터 진행합니다.

- [ ] `sagae-windows`에서 `bootstrap-token.sh --rotate --keep-old`를 실행합니다. `Old token mcp left on the node.`가 나옵니다.
- [ ] doctor 6번의 `mcp` 경고가 사라지고 종료 코드가 `0`입니다.
- [ ] 머신 목록의 나머지 머신을 같은 방법으로 옮깁니다.

리허설 환경을 더 쓰지 않으면 [폐기](../README.md#폐기)로 그 토큰을 지웁니다.

## 3. 롤백

**미검증.** 소요 시간을 남기고, `stable`이 뒤로 움직인 것이 머신에 반영되는지 봅니다. 수동 명령은 임시 저장소에서 확인했지만, 백그라운드 auto-update가 뒤로의 이동을 따라가는지는 아직 아무도 확인하지 못했습니다.

아래는 게이트가 켜져 있을 때의 절차입니다. 게이트를 켜지 않기로 했다면 [게이트가 꺼져 있을 때](#게이트가-꺼져-있을-때)를 씁니다.

### 준비

- [ ] D-1을 결정했고 [게이트를 켰습니다](stable-gate.md#켜기).
- [ ] 연습할 머신의 doctor 2번에 `ref stable`과 `auto-update on`이 나옵니다.

### 실행

실제 사고 때는 `main`을 먼저 되돌립니다. 연습에서는 순서를 바꿉니다. revert를 먼저 push하면 `promote`가 곧 `stable`을 전진시켜 뒤로 움직인 상태를 볼 수 없기 때문입니다. 연습 커밋은 문서만 바꾸므로 그동안의 위험은 없습니다. `good`과 `bad`를 쓰므로 명령은 같은 셸에서 이어서 실행합니다.

1. 돌아갈 커밋을 적습니다. CI를 통과한 커밋이어야 하므로 둘째 명령이 1 이상을 출력해야 합니다.

   ```sh
   good=$(gh api repos/sagaeforge/sagae-claude-plugins/commits/stable --jq .sha)
   gh run list --workflow ci.yml --branch main --commit "$good" --status success --json databaseId --jq length
   ```

2. 연습 커밋을 `main`에 push합니다. 이 문서 끝에 아무 줄이나 추가합니다. 코드는 그대로지만 커밋이 바뀌므로 머신에는 새 버전입니다.

   ```sh
   git commit -am "Rehearse a rollback" && git push
   bad=$(git rev-parse HEAD)
   ```

3. `promote`가 끝나면 `stable`이 `$bad`인지 보고 머신을 올립니다. 마지막 명령은 `$bad`의 앞 12자리를 출력해야 합니다.

   ```sh
   gh api repos/sagaeforge/sagae-claude-plugins/commits/stable --jq .sha
   claude plugin marketplace update sagae && claude plugin update proxmox@sagae
   jq -r '.plugins["proxmox@sagae"][0].version' ~/.claude/plugins/installed_plugins.json
   ```

4. **T0.** 되돌리기를 실행합니다. 9번까지 `gh workflow run ci.yml`을 실행하지 마세요. `main`의 끝이 아직 `$bad`이므로 `promote`가 `stable`을 다시 전진시킵니다.

   ```sh
   gh workflow run rollback.yml -f sha="$good"
   ```

5. **T1.** `stable`이 `$good`이 되면 시각을 적습니다.
6. **T2.** 백그라운드 반영을 봅니다. 수동 명령 없이 새 세션을 열고 메시지를 한 번 보낸 뒤 최대 10분 기다립니다. `Plugin updated: proxmox`가 나오고 위의 `jq` 결과가 `$good`의 앞 12자리로 돌아오면 시각을 적습니다. 그대로면 그 사실을 적습니다.
7. **T3.** 수동 반영을 봅니다. 6번에서 돌아오지 않았거나 두 번째 머신이 있으면 실행합니다. 세션 안에서는 이어서 `/reload-plugins`를 실행합니다.

   ```sh
   claude plugin marketplace update sagae && claude plugin update proxmox@sagae
   ```

8. doctor 3번이 `Installed <$good의 앞 12자리> is the remote's stable.`로 통과합니다.
9. `main`을 되돌립니다. CI가 통과하면 `stable`이 전진하고 머신이 따라옵니다.

   ```sh
   git revert --no-edit "$bad" && git push
   ```

### 게이트가 꺼져 있을 때

`stable`이 없으므로 revert만 연습합니다. `stable` 되돌림의 머신 반영은 미검증으로 남습니다.

1. 위의 2번처럼 연습 커밋을 `main`에 push합니다. 이 push가 곧 배포입니다.
2. 머신을 올리고 `jq` 결과가 `$bad`의 앞 12자리인지 봅니다.
3. **T0.** `git revert --no-edit "$bad" && git push`를 실행합니다.
4. **T1.** [런북](../README.md#나쁜-커밋-되돌리기)의 2번으로 머신에 반영하고 시각을 적습니다.
5. doctor 3번을 확인합니다.

## 4. 공유 토큰 `mcp` 폐기

**미검증.** 되돌릴 수 없습니다. 같은 값으로 복구할 방법이 없으므로 항상 마지막에 실행합니다.

- [ ] 머신 목록의 모든 머신에서 doctor를 실행했고, 5번의 ID가 `mcp`가 아닙니다.
- [ ] 러너가 있다면 자기 토큰(`ci-runner-`)을 씁니다.
- [ ] 토큰 목록을 저장합니다.
- [ ] 사용자가 폐기를 승인했습니다.
- [ ] 폐기합니다.

  ```sh
  ssh pve-node 'pveum user token remove claude-mcp@pve mcp'
  ```

- [ ] 모든 머신에서 doctor를 다시 실행합니다. 8번이 통과합니다.
- [ ] 목록에서 빠진 머신은 `PVE API 401`이 납니다. 그 머신에서 `bootstrap-token.sh --rotate --keep-old`로 복구합니다.

## 결과 기록

실행한 뒤 이 표를 채우고 위의 상태 표를 고칩니다.

| 날짜 | 리허설 | 머신 | 소요 시간 | 결과 | 문서와 달랐던 점 |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

롤백은 구간별로 적습니다.

| 날짜 | T1 - T0, `stable` 되돌림 | T2 - T1, 백그라운드 반영 | T3 - T1, 수동 반영 |
|---|---|---|---|
|  |  |  |  |

## 이 문서 밖의 미검증 항목

- GitHub Actions의 첫 실행, `promote`, `rollback.yml`, `GITHUB_TOKEN` 제약은 [stable 게이트의 확인한 범위](stable-gate.md#확인한-범위)에 있습니다.
- 러너 LXC, `live-smoke`, 실패 알림의 도달은 [라이브 스모크의 확인한 범위](live-smoke.md#확인한-범위)에 있습니다.
- 러너 재구축 시간은 `infra/runner/provision.sh`를 승인받아 실행할 때 잽니다. 끝날 때 나오는 `Took <초>s.`를 목표 30분과 비교합니다.
- 대기 스크립트의 Run 재연결은 [팀 운영](team-operations.md#주의할-점)에 있습니다.
