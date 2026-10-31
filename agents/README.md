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

## 토큰 관리

머신마다 `claude-mcp@pve` 아래에 자기 토큰을 하나씩 둡니다. 역할은 `PVEAuditor`이고 만료는 발급 후 365일입니다. 토큰 파일을 다른 머신에 복사하지 마세요. 한쪽에서 교체하면 다른 쪽이 401이 됩니다.

| 옵션 | 동작 |
|---|---|
| 없음 | 토큰 파일이 있으면 아무것도 하지 않고, 없으면 새 토큰을 발급합니다 |
| `--rotate` | 토큰 파일이 있어도 새 토큰으로 교체합니다 |
| `--keep-old` | `--rotate`와 함께 쓰며 이전 토큰을 노드에 남깁니다 |
| `--host <SSH 대상>` | 토큰을 발급할 노드입니다. 기본값은 `pve-node`입니다 |
| `--name <토큰 ID>` | 토큰 ID를 직접 정합니다. 기본값은 `m-<호스트>-<연월>`이고, 같은 달에 다시 교체하면 `-2`, `-3`이 붙습니다 |

### 교체

```sh
~/.claude/plugins/marketplaces/sagae/plugins/proxmox/scripts/bootstrap-token.sh --rotate
```

새 토큰 발급, 임시 파일 기록, `/version` 검증, 파일 교체, 이전 토큰 삭제 순서로 진행합니다. 파일을 바꾸기 전에 실패하면 이전 토큰과 파일은 그대로 남고, 검증하지 못한 새 토큰은 노드에서 지웁니다. 지우는 이전 토큰은 토큰 파일에 적힌 ID뿐입니다. 서버는 호출마다 토큰 파일을 읽으므로 재시작할 필요가 없습니다.

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

## 작업 폴더

이 저장소의 작업은 WSL의 `~/sagae-claude-plugins`에서 `claude`를 실행해 진행합니다. `/mnt/c` 아래에 두면 파일 권한이 유지되지 않습니다.
