# sagae-claude-plugins

사내 Claude Code 플러그인 마켓플레이스입니다. 현재 플러그인은 `proxmox`(읽기 전용 MCP 서버 + 스킬) 하나입니다.

## 새 PC 설치

```sh
gh auth login && gh auth setup-git
claude plugin marketplace add sagaeforge/sagae-claude-plugins
claude plugin install proxmox@sagae
~/.claude/plugins/marketplaces/sagae/plugins/proxmox/scripts/bootstrap-token.sh
```

이어서 `/plugin` > Marketplaces > `sagae` 에서 auto-update를 켭니다. 내부망(192.168.x.x/24)에 접근할 수 있어야 합니다.

`bootstrap-token.sh`는 이 머신 전용 토큰을 발급합니다. `curl`이 필요하고 노드에 SSH로 root 접속할 수 있어야 합니다. 기본 대상은 `pve-node`이며 `--host`로 바꿀 수 있습니다.

## 배포 방식

`main`에 push하면 끝입니다. Claude Code가 대화형 세션 시작 후 백그라운드에서 마켓플레이스를 갱신하고(최대 약 10분 지연), 변경 내용은 다음 실행 또는 `/reload-plugins` 때 적용됩니다.

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
| 2 | 마켓플레이스 등록, ref, auto-update | 등록되지 않음, 다른 저장소를 따름 | auto-update 꺼짐 |
| 3 | 설치 커밋과 `git ls-remote` 비교 | 설치되지 않음, 원격과 다름 | 원격을 읽지 못함, 원격에 ref가 없음, 플러그인이 비활성화됨 |
| 4 | 설치본의 `node_modules` | 패키지가 빠져 있음, 설치본이 없음 | |
| 5 | 토큰 파일. ID만 표시 | 없음, 토큰 형식이 아님 | 다른 사용자가 읽을 수 있음 |
| 6 | 토큰 교체 시기 | | 공유 토큰 `mcp`, 교체 기한 30일 이내 |
| 7 | 호스트별 8006 연결과 TLS | 모든 호스트 실패 | 일부 호스트 실패 |
| 8 | `/version`, `/access/permissions` | 쓰기 권한이 있음, 권한이 없음, 토큰이 거부됨 | |
| 9 | CA와 노드 인증서 만료 | 만료됨 | 30일 이내 만료, 노드 인증서를 읽지 못함 |
| 10 | `gh`로 러너와 마지막 CI 확인 | | 러너 오프라인, 마지막 CI가 성공이 아님 |

`skip`은 앞선 점검이 실패했거나 `gh`가 없어서 확인하지 못한 항목이며 종료 코드에 영향을 주지 않습니다. 등록된 러너가 없는 것은 문제로 보지 않습니다.

- 3번은 설치 커밋이 원격과 다르면 실패로 봅니다. 방금 push했다면 머신이 갱신할 때까지 이 상태일 수 있습니다.
- 6번은 현재 역할로 토큰의 실제 만료일을 읽을 수 없어(403) 토큰 ID의 연월로 계산합니다. 그달 1일에 발급했다고 보고 365일(`ci-runner-`는 180일)을 더한 날이 기한입니다. ID에 연월이 없으면 건너뜁니다.
- 7번은 토큰을 보내지 않고 `/access/domains`로 확인합니다. 그래서 토큰이 아직 없는 새 머신에서도 네트워크와 CA를 점검할 수 있습니다.

아무것도 바꾸지 않습니다. 파일을 쓰지 않고, Proxmox에는 서버와 같은 클라이언트로 GET만 보내며, 외부 명령은 `node --version`, `npm --version`, `git ls-remote`, `gh api`의 GET뿐입니다. 토큰 값은 출력하지 않습니다. 안내에 나오는 `bootstrap-token.sh`는 클러스터의 토큰을 바꾸므로 사용자가 승인한 뒤에 실행합니다.

## 서버 로그

서버는 API 호출마다 JSON 한 줄을 stderr에 씁니다. 시각, 도구, 호스트, 경로, 소요 시간, 상태, 페일오버 여부가 들어가며 토큰, 응답 본문, 쿼리 값은 넣지 않습니다.

Claude Code는 서버 연결이 끝나면 stderr를 더 읽지 않으므로(2.1.316 기준) 세션에서는 이 로그가 남지 않습니다. 로그를 남기려면 Claude Code를 실행하기 전에 `PVE_LOG_FILE`에 절대 경로를 지정합니다.

```sh
export PVE_LOG_FILE="$HOME/.config/proxmox-mcp/calls.jsonl"
```

서버는 같은 줄을 이 파일에 덧붙입니다. 파일을 새로 만들 때 권한은 0600입니다. 폴더는 미리 있어야 하고, 쓸 수 없어도 도구 호출은 실패하지 않습니다. 파일은 자동으로 줄어들지 않으므로 필요 없어지면 직접 지웁니다.

## 작업 폴더

이 저장소의 작업은 WSL의 `~/sagae-claude-plugins`에서 `claude`를 실행해 진행합니다. `/mnt/c` 아래에 두면 파일 권한이 유지되지 않습니다.

## CI 검증

`main` push와 PR마다 `check` 잡이 GitHub 호스팅 러너에서 Node 20, 22, 26으로 아래 항목을 순서대로 실행합니다. 매니페스트 검증만은 CLI가 요구하는 Node 22 이상에서 실행합니다. 클러스터에는 접속하지 않습니다.

| 항목 | 막는 것 | 로컬 실행 |
|---|---|---|
| 매니페스트 검증 | `plugin.json`, `marketplace.json` 오류 | `claude plugin validate . && claude plugin validate plugins/proxmox` |
| 비밀값 검사 | 커밋 히스토리 전체의 토큰과 키 | `.github/scripts/gitleaks.sh` |
| 단위 테스트 | 동작 회귀, 쓰기 경로 추가, `version` 고정, 액션과 CLI의 버전 미고정, `stable` 게이트 규칙 위반 | `npm test` |
| 변이 검사 | 테스트 약화. 복사본의 코드를 일부러 망가뜨리고 `npm test`가 실패하는지 확인 | `node test/mutation.mjs` |
| 기동 스모크 | 문법 오류, import 오류, 의존성 누락. 운영 의존성만 설치한 복사본을 `.mcp.json`의 명령으로 실행해 도구 6개를 확인 | `node test/smoke/boot.mjs` |

`npm`과 `node` 명령은 `plugins/proxmox`에서 `npm ci --ignore-scripts`를 실행한 뒤 그 폴더에서 실행합니다. 나머지는 저장소 최상위에서 실행합니다. `gitleaks.sh`는 Linux x64 전용이며, 고정된 버전을 받아 SHA-256을 확인한 뒤 실행하고 지웁니다.

gitleaks 기본 규칙은 Proxmox 토큰을 찾지 못합니다. 그래서 `.gitleaks.toml`에 전용 규칙을 두었습니다.

Node 버전을 바꿀 때는 `.github/workflows/ci.yml`의 `matrix.node`, `plugins/proxmox/package.json`의 `engines`, `.nvmrc`를 함께 고칩니다. 서로 어긋나면 `npm test`가 실패합니다.
