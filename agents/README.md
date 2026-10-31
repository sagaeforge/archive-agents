# sagae-claude-plugins

사내 Claude Code 플러그인 마켓플레이스입니다. 현재 플러그인은 `proxmox`(읽기 전용 MCP 서버 + 스킬) 하나입니다.

## 새 PC 설치

```sh
gh auth login && gh auth setup-git
claude plugin marketplace add sagaeforge/sagae-claude-plugins
claude plugin install proxmox@sagae
~/.claude/plugins/marketplaces/sagae/plugins/proxmox/scripts/bootstrap-token.sh   # 또는 기존 토큰 파일을 ~/.config/proxmox-mcp/token 에 복사
```

이어서 `/plugin` > Marketplaces > `sagae` 에서 auto-update를 켭니다. 내부망(192.168.x.x/24)에 접근할 수 있어야 합니다.

## 배포 방식

`main`에 push하면 끝입니다. Claude Code가 대화형 세션 시작 후 백그라운드에서 마켓플레이스를 갱신하고(최대 약 10분 지연), 변경 내용은 다음 실행 또는 `/reload-plugins` 때 적용됩니다.

바로 반영하려면 다음을 실행합니다.

```sh
claude plugin marketplace update sagae && claude plugin update proxmox@sagae
```

GitHub Actions는 검증만 하며 배포를 막지 않습니다. CI가 실패해도 push된 내용은 배포됩니다.

## 토큰 폐기

```sh
ssh pve-node 'pveum user token remove claude-mcp@pve mcp'
rm ~/.config/proxmox-mcp/token
```

## 서버 로그

서버는 API 호출마다 JSON 한 줄을 stderr에 씁니다. 시각, 도구, 호스트, 경로, 소요 시간, 상태, 페일오버 여부가 들어가며 토큰, 응답 본문, 쿼리 값은 넣지 않습니다.

Claude Code는 서버 연결이 끝나면 stderr를 더 읽지 않으므로(2.1.316 기준) 세션에서는 이 로그가 남지 않습니다. 로그를 남기려면 Claude Code를 실행하기 전에 `PVE_LOG_FILE`에 절대 경로를 지정합니다.

```sh
export PVE_LOG_FILE="$HOME/.config/proxmox-mcp/calls.jsonl"
```

서버는 같은 줄을 이 파일에 덧붙입니다. 파일을 새로 만들 때 권한은 0600입니다. 폴더는 미리 있어야 하고, 쓸 수 없어도 도구 호출은 실패하지 않습니다. 파일은 자동으로 줄어들지 않으므로 필요 없어지면 직접 지웁니다.

## 작업 폴더

이 저장소의 작업은 WSL의 `~/sagae-claude-plugins`에서 `claude`를 실행해 진행합니다. `/mnt/c` 아래에 두면 파일 권한이 유지되지 않습니다.
