# sagae-claude-plugins

사내 Claude Code 플러그인 마켓플레이스입니다. 현재 플러그인은 `proxmox`(읽기 전용 MCP 서버 + 스킬)와 `tower`(관제 서버 MCP 엔드포인트 등록) 둘입니다.

## 새 PC 설치

```sh
gh auth login && gh auth setup-git
claude plugin marketplace add sagaeforge/sagae-claude-plugins
claude plugin install proxmox@sagae
~/.claude/plugins/marketplaces/sagae/plugins/proxmox/scripts/bootstrap-token.sh   # 또는 기존 토큰 파일을 ~/.config/proxmox-mcp/token 에 복사
```

이어서 `/plugin` > Marketplaces > `sagae` 에서 auto-update를 켭니다. 내부망(192.168.x.x/24)에 접근할 수 있어야 합니다.

## tower 플러그인

`tower`는 이 머신에서 도는 관제 서버(127.0.0.1:4800)의 병합 MCP 엔드포인트 하나를 Claude Code에 등록하는 얇은 HTTP 플러그인입니다. 서버 코드는 없습니다. 관제 서버가 설치돼 있고 `~/.config/tower/token`이 있어야 합니다. 토큰은 `scripts/tower-auth.sh`가 연결 때마다 이 파일에서 읽으며 저장소에는 값이 없습니다.

```sh
claude plugin install tower@sagae
```

도구 이름은 `mcp__plugin_tower_tower__<업스트림>_<도구>` 형태입니다. 권한 와일드카드 `mcp__plugin_tower_tower__*`는 프로젝트 설정이 아니라 사용자 설정(`~/.claude/settings.json`)에 둡니다.

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

## 작업 폴더

이 저장소의 작업은 WSL의 `~/sagae-claude-plugins`에서 `claude`를 실행해 진행합니다. `/mnt/c` 아래에 두면 파일 권한이 유지되지 않습니다.
