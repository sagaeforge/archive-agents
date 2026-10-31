# sagae-claude-plugins

사내 Claude Code 플러그인 마켓플레이스입니다. 현재 플러그인은 `proxmox`(읽기 전용 MCP 서버 + 스킬) 하나입니다.

## 새 PC 설치

### 준비

- Claude Code, `git`, `gh`, `curl`이 설치되어 있어야 합니다.
- Node 22 이상과 npm이 Claude Code를 시작하는 환경의 PATH에 있어야 합니다. 서버는 `node`로 실행되고, 플러그인 의존성은 설치할 때 `npm`으로 받습니다. nvm으로만 설치했다면 터미널 밖에서 시작한 Claude Code가 찾지 못할 수 있습니다.
- 이 저장소를 읽을 수 있는 GitHub 계정이 필요합니다. 비공개 저장소입니다.
- 내부망(192.168.x.x/24)의 노드 8006 포트에 닿아야 합니다.
- 노드에 키 인증으로 root SSH 접속이 되어야 합니다. `bootstrap-token.sh`는 프롬프트 없이 실행되므로 비밀번호를 묻거나 호스트 키를 확인하는 상태로는 실패합니다. 먼저 한 번 접속해 호스트 키를 받아 둡니다.

  `bootstrap-token.sh`의 기본 대상 `pve-node`은 `~/.ssh/config`의 별칭입니다. 아래처럼 별칭을 두거나, 실행할 때 `--host root@192.0.2.1`을 붙입니다.

  ```text
  Host pve-node
    HostName 192.0.2.1
    User root
  ```

### 설치

GitHub SSH 키가 없는 머신은 먼저 셸 프로필에 `export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`을 넣습니다. 이 변수가 없으면 Claude Code가 SSH를 먼저 시도하고, 세션 안의 설치와 플러그인 업데이트가 실패할 수 있습니다.

```sh
gh auth login && gh auth setup-git
claude plugin marketplace add sagaeforge/sagae-claude-plugins
claude plugin install proxmox@sagae
~/.claude/plugins/marketplaces/sagae/plugins/proxmox/scripts/bootstrap-token.sh
```

`bootstrap-token.sh`는 이 머신 전용 토큰을 발급합니다.

이어서 세션을 열고 `/plugin` > Marketplaces > `sagae` > Enable auto-update를 선택합니다. 기본값이 꺼짐이라 이 단계를 빠뜨리면 그 머신은 갱신되지 않습니다.

### 확인

```sh
~/.claude/plugins/marketplaces/sagae/plugins/proxmox/scripts/doctor.sh
```

종료 코드 `0`이면 설치가 끝났습니다. `1`이나 `2`이면 항목마다 나오는 안내를 따른 뒤 다시 실행합니다. 항목의 뜻은 [상태 점검](#상태-점검)에 있습니다.

새 세션에서 `/mcp`를 열어 `proxmox` 서버가 연결되어 있는지 보고, `클러스터 상태 알려줘`라고 물어 노드 3개가 나오는지 확인합니다.

### 설치가 막히면

| 증상 | 대처 |
|---|---|
| `marketplace add`가 `SSH authentication failed`나 `HTTPS authentication failed`로 실패 | 프롬프트 없이 인증되어야 합니다. `gh auth setup-git`을 실행한 뒤 `git -c core.askPass= ls-remote https://github.com/sagaeforge/sagae-claude-plugins.git`으로 확인합니다 |
| `SSH host key is not in your known_hosts file` | `ssh -T git@github.com`을 한 번 실행해 지문을 수락합니다 |
| `bootstrap-token.sh`의 `Could not issue token` | 위의 SSH 조건을 확인합니다. 기존 토큰과 파일은 바뀌지 않습니다. 메시지에 나오는 명령으로 노드에 남은 ID를 확인합니다 |
| doctor 4번 실패, `claude plugin list`에 `The packages it lists`로 시작하는 Note | 의존성 자동 설치가 끝나지 못했습니다. `npm`이 PATH에 없으면 `The packages it lists were not installed, because it needs npm`이, `npm`은 있는데 60초 안에 끝나지 못했으면 `The packages it lists are not installed`가 나옵니다. `npm`을 PATH에 두고 `claude plugin update proxmox@sagae`로 다시 시도합니다 |
| `/mcp`에서 서버가 연결되지 않음 | `claude --debug`로 시작해 `~/.claude/debug/<세션 ID>.txt`를 봅니다. `node`를 찾지 못했다면 PATH를 고칩니다 |

## 배포 방식

`stable` 게이트가 꺼져 있는 지금은 `main`에 push하면 배포됩니다.

auto-update를 켠 머신은 대화형 세션에서 첫 메시지를 보낸 뒤 최대 10분 안에 마켓플레이스와 플러그인을 갱신합니다. 실행 중인 세션은 이전 버전을 유지하고 `Plugin updated: proxmox · Run /reload-plugins to apply`를 표시합니다. 변경 내용은 `/reload-plugins` 또는 다음 실행 때 적용됩니다.

auto-update를 켜지 않았거나 세션을 열지 않은 머신은 갱신되지 않습니다. 백그라운드 갱신은 프롬프트 없이 인증되어야 하고, 실패해도 알리지 않고 기존 체크아웃을 유지합니다. 머신이 뒤처졌는지는 [doctor](#상태-점검)의 3번으로 확인합니다.

바로 반영하려면 다음을 실행합니다.

```sh
claude plugin marketplace update sagae && claude plugin update proxmox@sagae
```

GitHub Actions는 검증만 하며 배포를 막지 않습니다. CI가 실패해도 push된 내용은 배포됩니다.

CI를 통과한 커밋만 내보내는 `stable` 게이트는 준비되어 있지만 꺼져 있습니다. 켜는 절차, 머신별 재등록, 롤백은 [docs/stable-gate.md](docs/stable-gate.md)에 있습니다.

## 토큰 관리

머신마다 `claude-mcp@pve` 아래에 자기 토큰을 하나씩 둡니다. 역할은 `PVEAuditor`이고 만료는 발급 후 365일입니다. 토큰 파일을 다른 머신에 복사하지 마세요. 한쪽에서 교체하면 다른 쪽이 401이 됩니다.

| 옵션 | 동작 |
|---|---|
| 없음 | 토큰 파일이 있으면 아무것도 하지 않고, 없으면 새 토큰을 발급합니다 |
| `--rotate` | 토큰 파일이 있어도 새 토큰으로 교체합니다 |
| `--keep-old` | `--rotate`와 함께 쓰며 이전 토큰을 노드에 남깁니다. 토큰 파일의 ID가 공유 토큰 `mcp`이거나 이 머신의 이름으로 된 ID가 아니면 필수입니다 |
| `--host <SSH 대상>` | 토큰을 발급할 노드입니다. 기본값은 `pve-node`입니다 |
| `--name <토큰 ID>` | 토큰 ID를 직접 정합니다. 기본값은 `m-<호스트>-<연월>`이고, 같은 달에 다시 교체하면 `-2`, `-3`이 붙습니다 |

### 교체

만료되기 전에 교체합니다. doctor 6번이 기한 30일 전부터 경고합니다.

```sh
~/.claude/plugins/marketplaces/sagae/plugins/proxmox/scripts/bootstrap-token.sh --rotate
```

새 토큰 발급, 임시 파일 기록, `/version` 검증, 파일 교체, 이전 토큰 삭제 순서로 진행합니다. 서버는 호출마다 토큰 파일을 읽으므로 재시작할 필요가 없습니다.

파일을 바꾸기 전에 실패하거나 중단되면 이전 토큰과 파일은 그대로 남고, 발급 응답을 받은 새 토큰은 노드에서 지웁니다. 응답을 받지 못하면 이번 실행이 만든 토큰이라는 근거가 없으므로 지우지 않고, 노드에 남아 있을 수 있는 ID와 확인 및 삭제 명령을 알려 줍니다. 파일을 바꾼 뒤 이전 토큰을 지우지 못하거나 중단되면 새 토큰은 그대로 쓰고, 이전 토큰의 삭제 명령을 알려 줍니다.

지우는 이전 토큰은 토큰 파일에 적힌 ID뿐이고, 그 ID가 이 머신의 이름으로 된 `m-<호스트>-<연월>` 형식일 때만 지웁니다. 다른 머신에서 복사한 파일이나 `--name`으로 정한 ID는 다른 머신의 토큰일 수 있으므로 교체를 거부합니다. 이때는 `--rotate --keep-old`로 파일만 바꾸고, 쓰지 않는 토큰임을 확인한 뒤 노드에서 직접 지웁니다.

### 공유 토큰 `mcp`에서 전환

전환은 머신마다 사용자가 승인한 뒤 1대부터 진행합니다.

1. `ssh pve-node 'pveum user token list claude-mcp@pve'`로 현황을 봅니다.
2. 머신마다 `bootstrap-token.sh --rotate --keep-old`를 실행합니다. 다른 머신이 아직 `mcp`를 쓸 수 있으므로, 토큰 파일이 `mcp`이면 `--keep-old` 없는 교체는 거부합니다.
3. 모든 머신을 옮긴 뒤 `ssh pve-node 'pveum user token remove claude-mcp@pve mcp'`로 폐기합니다. 빠진 머신은 401이 나며 `--rotate --keep-old`로 복구합니다.

### 폐기

이 머신의 토큰만 지웁니다. 토큰 파일의 ID가 아직 `mcp`이면 다른 머신도 쓰는 토큰이므로 지우지 말고 위 전환 절차를 따릅니다.

```sh
id=$(cut -d= -f1 ~/.config/proxmox-mcp/token | cut -d'!' -f2)
ssh pve-node "pveum user token remove claude-mcp@pve $id"
rm ~/.config/proxmox-mcp/token
```

## 상태 점검

`doctor.sh`는 이 머신의 플러그인 상태를 점검합니다. 설치 직후, 도구가 오류를 낼 때, 토큰을 교체한 뒤에 실행합니다.

```sh
~/.claude/plugins/marketplaces/sagae/plugins/proxmox/scripts/doctor.sh
```

항목마다 결과와 할 일을 출력합니다. 종료 코드는 `0` 정상, `1` 경고, `2` 실패이고, `--json`을 붙이면 같은 내용을 JSON으로 출력합니다.

| # | 점검 | 실패 | 경고 |
|---|---|---|---|
| 1 | `node`, `npm`이 PATH에 있고 Node 22 이상 | `node`나 `npm`이 없음, `package.json`의 최소 버전 미만 | Node 22 미만 |
| 2 | 마켓플레이스 등록, ref, auto-update | 등록되지 않음, 다른 저장소를 따름 | auto-update 꺼짐, 원격에 `stable`이 있는데 따르지 않음 |
| 3 | 설치 커밋과 `git ls-remote` 비교 | 설치되지 않음, 원격과 다름 | 원격을 읽지 못함, 원격에 ref가 없음, 플러그인이 비활성화됨 |
| 4 | 설치본의 `node_modules` | 패키지가 빠져 있음, 설치본이 없음 | |
| 5 | 토큰 파일. ID만 표시 | 없음, 토큰 형식이 아님 | 다른 사용자가 읽을 수 있음 |
| 6 | 토큰 교체 시기 | | 공유 토큰 `mcp`, 교체 기한 30일 이내 |
| 7 | 호스트별 8006 연결과 TLS | 모든 호스트 실패 | 일부 호스트 실패 |
| 8 | `/version`, `/access/permissions` | 쓰기 권한이 있음, 권한이 없음, 토큰이 거부됨 | |
| 9 | CA와 노드 인증서 만료 | 만료됨 | 30일 이내 만료, 노드 인증서를 읽지 못함 |
| 10 | `gh`로 러너와 마지막 CI 확인 | | 러너 오프라인, 마지막 CI가 성공이 아님 |

`skip`은 앞선 점검이 실패했거나 `gh`가 없어서 확인하지 못한 항목이며 종료 코드에 영향을 주지 않습니다. 등록된 러너가 없는 것은 문제로 보지 않습니다.

- 2번은 원격에 `stable` 브랜치가 있으면 게이트를 쓰는 것으로 봅니다. 그때부터 `stable`을 따르지 않는 머신은 게이트를 거치지 않으므로 경고하고, 등록 안내에 `#stable`을 넣습니다. 브랜치가 없으면 안내에서 뺍니다. 원격을 읽지 못하면 경고하지 않고 안내에 두 경우를 모두 적습니다.
- 3번은 설치 커밋이 원격과 다르면 실패로 봅니다. 방금 push했다면 머신이 갱신할 때까지 이 상태일 수 있습니다. `settings.json`의 `enabledPlugins`에 항목이 아예 없어도 비활성화로 봅니다. Claude Code가 그 플러그인을 로드하지 않습니다(2.1.316 기준).
- 6번은 현재 역할로 토큰의 실제 만료일을 읽을 수 없어(403) 토큰 ID의 연월로 계산합니다. 그달 1일에 발급했다고 보고 365일(`ci-runner-`는 180일)을 더한 날이 기한입니다. ID에 연월이 없으면 건너뜁니다.
- 7번은 토큰을 보내지 않고 `/access/domains`로 확인합니다. 그래서 토큰이 아직 없는 새 머신에서도 네트워크와 CA를 점검할 수 있습니다.

설정, 토큰, 클러스터는 바꾸지 않습니다. doctor 자신은 파일을 쓰지 않고, Proxmox에는 서버와 같은 클라이언트로 GET만 보내며, 외부 명령은 `node --version`, `npm --version`, `git ls-remote`, `gh api`의 GET뿐입니다. 이 명령들이 자기 상태 파일을 남기지 않도록 `gh` 텔레메트리와 Node 컴파일 캐시를 끄고 실행합니다. `gh` 2.103.3과 npm 11.20.0으로 빈 `$HOME`과 `/tmp`에서 실행해 남는 파일이 없음을 확인했고, 다른 버전까지 보장하지는 않습니다. 토큰 값은 출력하지 않습니다. 안내에 나오는 `bootstrap-token.sh`는 클러스터의 토큰을 바꾸므로 사용자가 승인한 뒤에 실행합니다.

## 런북

아래 절차는 아직 실제로 실행한 적이 없습니다. 첫 실행 전에 [리허설 체크리스트](docs/rehearsals.md)를 봅니다.

### 나쁜 커밋 되돌리기

`stable` 게이트가 꺼져 있는 지금은 revert push가 곧 배포입니다. 게이트를 켠 뒤에는 [게이트의 롤백 절차](docs/stable-gate.md#롤백)를 따릅니다.

1. 원인을 되돌립니다.

   ```sh
   git revert <sha> && git push
   ```

   대상이 merge 커밋이면 `-m 1`을 붙입니다. `-m` 없는 `git revert`는 merge 커밋에서 실패합니다. 아래 첫 명령이 부모를 둘 출력하면 merge 커밋입니다.

   ```sh
   git log -1 --format=%p <sha>
   git revert -m 1 <sha> && git push
   ```

   통합 브랜치는 `git merge --no-ff`로 병합합니다. 그래야 병합 전체가 `main`의 merge 커밋 하나가 되고, `git revert -m 1` 한 번으로 병합 전 트리로 정확히 돌아갑니다. fast-forward로 넣으면 브랜치의 마지막 merge 커밋이 `main`의 끝이 되어 그 merge 하나만 되돌아갑니다.

2. 기다릴 수 없는 머신에서 바로 반영합니다. auto-update를 켠 머신은 다음 세션에서 따라옵니다.

   ```sh
   claude plugin marketplace update sagae && claude plugin update proxmox@sagae
   ```

   세션 안에서는 이어서 `/reload-plugins`를 실행합니다.

3. 그동안 멈춰야 하면 `claude plugin disable proxmox@sagae`로 차단하고, 복구한 뒤 `claude plugin enable proxmox@sagae`를 실행합니다.
4. doctor 3번으로 설치 커밋을 확인합니다.

### 토큰 정기 교체

머신 토큰은 발급 후 365일, 러너 토큰은 180일에 만료되므로 그 전에 교체합니다. 머신은 [교체](#교체)를 따릅니다.

러너는 다시 발급합니다. 기본 ID가 `ci-runner-<연월>`이라 같은 달에 다시 발급하면 `--token-id ci-runner-<연월>-2`처럼 새 ID를 줍니다.

```sh
infra/runner/issue-token.sh --node <노드> --vmid <VMID>
```

이전 토큰은 자동으로 지워지지 않습니다. 스크립트가 마지막에 출력하는 명령으로 노드에서 지웁니다. doctor는 러너 토큰을 보지 않으므로 기한을 넘기면 `live-smoke`가 `PVE API 401`로 실패합니다.

### 토큰 유출 대응

1. 노드에서 그 ID만 지웁니다.

   ```sh
   ssh pve-node 'pveum user token remove claude-mcp@pve <id>'
   ```

2. 그 머신에서 토큰 파일을 지우고 `bootstrap-token.sh`로 새 토큰을 받습니다.
3. `recent_tasks`와 노드 인증 로그로 사용 흔적을 확인합니다. 인증 로그는 현재 토큰으로 읽을 수 없어 노드에서 직접 봅니다.
4. 러너 토큰이면 LXC가 침해된 것으로 보고 [러너 재구축](#러너-재구축)까지 진행합니다.

유출된 것이 공유 토큰 `mcp`이면 1번에서 모든 머신이 401이 됩니다. 머신마다 `bootstrap-token.sh --rotate --keep-old`로 복구합니다.

### 러너 재구축

러너를 잃으면 대기 노드 `pve-node`에 다시 만듭니다. 실행은 별도 승인을 받습니다. 목표 복구 시간은 30분이며 아직 재 보지 않았습니다.

```sh
infra/runner/provision.sh --node pve-node --vmid <빈 VMID>
infra/runner/issue-token.sh --node pve-node --vmid <같은 VMID>
gh workflow run ci.yml
```

- 마지막 명령으로 `live-smoke`가 통과하는지 확인합니다.
- 두 스크립트는 `--node` 이름으로 SSH에 접속합니다. 그 이름의 별칭이 없으면 둘 다 `--host root@192.0.2.1`을 붙입니다.
- 원래 노드가 내려가 있으면 그 노드의 설정이 VMID를 계속 차지합니다. `--vmid 101`은 `VMID 101 is not free`로 멈추므로 노드에서 `pvesh get /cluster/nextid`로 빈 번호를 찾습니다.
- 지난 발급과 같은 달이면 `issue-token.sh`에 `--token-id ci-runner-<연월>-2`처럼 새 ID를 줍니다.
- 이전 토큰은 스크립트가 마지막에 출력하는 명령으로 지웁니다.
- 원래 노드가 돌아오면 이전 LXC가 `onboot`로 다시 켜질 수 있으므로 바로 지웁니다. 같은 이름의 러너가 두 대 뜨면 안 됩니다.

### CA 재발급

다음 만료는 노드 인증서 2028-07-23, CA 2036-07-21입니다. doctor 9번이 30일 전부터 경고합니다.

같은 CA로 노드 인증서만 갱신하면 저장소는 바뀌지 않습니다. 서버가 IP로 접속하므로 새 인증서의 SAN에 노드 IP가 있어야 합니다.

CA를 바꾸면 노드 인증서를 교체한 때부터 새 CA가 머신에 닿을 때까지 머신이 `TLS_VERIFY` 오류를 냅니다. 작업 시간을 정해 짧게 끝냅니다.

1. 노드의 CA와 인증서를 교체합니다. 새 CA를 먼저 push하면 게이트가 켜져 있을 때 `live-smoke`가 옛 인증서에서 실패합니다.
2. `plugins/proxmox/certs/pve-root-ca.pem`을 교체해 push합니다. 게이트가 켜져 있으면 `live-smoke`가 새 CA를 검증한 뒤 `stable`이 전진합니다.
3. 각 머신에서 [나쁜 커밋 되돌리기](#나쁜-커밋-되돌리기)의 2번 명령으로 바로 반영합니다.
4. doctor 7번과 9번을 확인합니다.

### 노드 변경

노드를 추가, 제거, 개명하거나 주소를 바꾸면 [CLAUDE.md의 체크리스트](CLAUDE.md#node-changes)를 따릅니다. 노드 목록이 여러 파일에 복사되어 있습니다.

## 서버 로그

서버는 API 호출마다 JSON 한 줄을 stderr에 씁니다. 시각, 도구, 호스트, 경로, 소요 시간, 상태, 페일오버 여부가 들어가며 토큰, 응답 본문, 쿼리 값은 넣지 않습니다. 경로는 도구를 부른 쪽이 정하므로 토큰처럼 보이는 경로는 `<redacted>`로 바꿔 적습니다.

Claude Code는 서버 연결이 끝나면 stderr를 더 읽지 않습니다(2.1.316 기준). 그래서 `.mcp.json`이 `PVE_LOG_FILE`을 플러그인 데이터 폴더로 지정해 같은 줄을 파일에도 남깁니다. 기본으로 켜져 있습니다.

```sh
tail -n 20 ~/.claude/plugins/data/proxmox-sagae/calls.jsonl
```

- 폴더는 Claude Code가 만들고, 파일 권한은 0600입니다.
- 파일이 5MiB에 닿으면 `calls.jsonl.1`로 옮기고 새 파일을 시작합니다. 이전 `.1`은 지워지므로 두 파일을 합쳐 약 10MiB를 넘지 않습니다.
- 플러그인을 업데이트해도 남습니다. 제거하면 Claude Code가 폴더째 지웁니다. [머신별 재등록](docs/stable-gate.md#머신별-재등록)의 `marketplace remove`도 같습니다.
- 파일을 쓸 수 없어도 도구 호출은 실패하지 않습니다.

Claude Code 2.1.316에서 `claude mcp list`로 서버를 띄워 변수 확장, 폴더 생성, 파일 기록을 확인했습니다. **실제 세션에서 도구를 호출했을 때의 기록은 미검증입니다.** [온보딩 리허설](docs/rehearsals.md#1-깨끗한-머신-온보딩)에서 확인합니다.

## 작업 폴더

이 저장소의 작업은 WSL의 `~/sagae-claude-plugins`에서 `claude`를 실행해 진행합니다. `/mnt/c` 아래에 두면 파일 권한이 유지되지 않습니다.

## CI 검증

`main` push와 PR마다 `check` 잡이 GitHub 호스팅 러너에서 Node 20, 22, 26으로 아래 항목을 순서대로 실행합니다. 매니페스트 검증은 CLI가 요구하는 Node 22 이상에서, 변이 검사는 `.nvmrc`의 Node 26에서만 실행합니다. 클러스터에는 접속하지 않습니다.

| 항목 | 막는 것 | 로컬 실행 |
|---|---|---|
| 매니페스트 검증 | `plugin.json`, `marketplace.json` 오류 | `claude plugin validate . && claude plugin validate plugins/proxmox` |
| 비밀값 검사 | 커밋 히스토리 전체의 토큰과 키 | `.github/scripts/gitleaks.sh` |
| 단위 테스트 | 동작 회귀, 쓰기 경로 추가, `version` 고정, 액션과 CLI의 버전 미고정, `stable` 게이트 규칙 위반 | `npm test` |
| 변이 검사 | 테스트 약화. 복사본의 코드를 일부러 망가뜨리고 그 보증을 맡은 테스트 파일이 실패하는지 확인 | `node test/mutation.mjs` |
| 기동 스모크 | 문법 오류, import 오류, 의존성 누락. 운영 의존성만 설치한 복사본을 `.mcp.json`의 명령으로 실행해 도구 6개를 확인 | `node test/smoke/boot.mjs` |

`live-smoke` 잡은 Proxmox의 러너 LXC에서 도구 6개를 실제 클러스터에 호출합니다. 러너가 준비될 때까지 꺼져 있어 건너뜁니다. 켜면 `main` push마다, 그리고 매주 월요일 06:00 KST에 실행됩니다. 켜는 절차, 실패 표시 `INFRA`와 `PLUGIN`, `skip_smoke`는 [docs/live-smoke.md](docs/live-smoke.md)에 있습니다.

`npm`과 `node` 명령은 `plugins/proxmox`에서 `npm ci --ignore-scripts`를 실행한 뒤 그 폴더에서 실행합니다. 나머지는 저장소 최상위에서 실행합니다. `gitleaks.sh`는 Linux x64 전용이며, 고정된 버전을 받아 SHA-256을 확인한 뒤 실행하고 지웁니다.

gitleaks 기본 규칙은 Proxmox 토큰을 찾지 못합니다. 그래서 `.gitleaks.toml`에 전용 규칙을 두었습니다.

Node 버전을 바꿀 때는 `.github/workflows/ci.yml`의 `matrix.node`와 변이 검사 단계의 조건, `plugins/proxmox/package.json`의 `engines`, `.nvmrc`를 함께 고칩니다. 서로 어긋나면 `npm test`가 실패합니다.

## 문서

| 문서 | 내용 |
|---|---|
| [docs/stable-gate.md](docs/stable-gate.md) | `stable` 게이트 켜기, 머신 재등록, 게이트를 켠 뒤의 롤백 |
| [docs/live-smoke.md](docs/live-smoke.md) | 러너 LXC의 라이브 스모크와 결과 읽기 |
| [docs/team-operations.md](docs/team-operations.md) | Workflow와 Orca 워커 고르기, `team-watcher`로 기다리기 |
| [docs/rehearsals.md](docs/rehearsals.md) | 아직 실행하지 않은 리허설 체크리스트와 결과 기록 |
