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

CI를 통과한 커밋만 내보내는 `stable` 게이트는 준비되어 있지만 꺼져 있습니다. 켜는 절차, 머신별 재등록, 롤백은 [docs/stable-gate.md](docs/stable-gate.md)에 있습니다.

## 토큰 폐기

```sh
ssh pve-node 'pveum user token remove claude-mcp@pve mcp'
rm ~/.config/proxmox-mcp/token
```

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
