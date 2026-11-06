# 세션 조사 자료 접수

다른 프로젝트 세션이 조사한 자료의 접수 대장이다. 2026-10-31 사용자 요청으로 시작했다.

## 처리 규칙

- 세션은 본문이 아니라 경로, 주제, 조사일, 1차 출처 포함 여부를 회신한다.
- KB는 파일을 읽어 `first_party` 에이전트 기록(`f:agent:<세션>`)으로 저장한다. 머신 밖 경로 결정 전에는 스풀에 보관되고 조회되지 않는다.
- 문서에 인용된 1차 출처 URL은 수집 후보로 넘겨 수집 경로의 게이트를 지난다. 세션의 서술을 검증된 사실로 적재하지 않는다.
- 사라질 위치의 자료는 `~/.local/share/sagae-kb/intake/`(모드 700, 해시는 `MANIFEST.sha256`)에 복사했다. 이 경로는 KB 백업 대상이 아니므로 적재 뒤 지운다.
- 내부 주소, 호스트 이름, 노드 이름, 토큰 권한 목록은 적재하지 않는다.

## 요청 현황

2026-10-31 요청 발송.

| 세션 | 프로젝트 | 회신 |
|---|---|---|
| `sagae-tools-0e` | sagae-tools | 11건 + 사본 2건 |
| `sagae-claude-plugins-0e` | sagae-claude-plugins | 3건 |
| `claude-setup-22` | claude-setup | 8건 |
| `sagae-bb` | sagae | 3건 |
| `sagae-claude-plugins-9d` | sagae-claude-plugins | 1건 |
| `sagae-claude-plugins-79` | sagae-claude-plugins | 대상 없음 |
| `sagae-claude-plugins-de` | sagae-claude-plugins | 대상 없음 |
| `claude-setup-b1` | claude-setup | 미전달. 승인 없이 만료됐다. 재전송은 사용자가 요청할 때만 한다 |

## 접수 목록

조사일은 모두 2026-10-31이다.

### sagae-tools-0e

내용이 다르면 `verify-*.md`가 조사 보고서보다 우선한다. `spike-results.md`에서는 Adversarial review가 스파이크 본문보다 우선한다.

| 경로 | 주제 | 1차 출처 |
|---|---|---|
| `/home/user/sagae-tools/docs/research/oss-viewers.md` | 기성 뷰어 앱 비교 | 포함(72개) |
| `/home/user/sagae-tools/docs/research/ui-blocks.md` | 웹 뷰어 구성 요소의 버전과 유지보수 상태 | 포함(44개) |
| `/home/user/sagae-tools/docs/research/trends.md` | 뷰어 관련 기술 동향 | 포함(48개) |
| `/home/user/sagae-tools/docs/research/mcp-gateways.md` | MCP 게이트웨이와 집계기 비교 | 포함(57개) |
| `/home/user/sagae-tools/docs/research/mcp-servers.md` | MCP 서버 구축과 호스팅 | 포함(45개) |
| `/home/user/sagae-tools/docs/research/http-gateway.md` | HTTP 게이트웨이, 수명주기, 런타임 | 포함(40개) |
| `/home/user/sagae-tools/docs/research/verify-gateway.md` | 게이트웨이 조사의 적대적 검증 | 포함(46개) |
| `/home/user/sagae-tools/docs/research/verify-viewer.md` | 뷰어 조사의 적대적 검증 | 포함(78개) |
| `/home/user/sagae-tools/docs/research/understand-token-tooling.md` | rtk와 trail 조사 | 없음 |
| `/home/user/sagae-tools/docs/research/spike-results.md` | 이 머신의 실측 S1~S5. L173, L180은 로컬 주소라 적재하지 않는다. 수치는 외부 사실이 아니다 | 없음 |
| `/home/user/sagae-tools/docs/research/spikes/` | 실측 소스와 일부 측정값 | 없음 |
| `intake/sagae-tools-0e/orca-guide.md`, `orca-browser.md` | Orca 사용 메모. 원본은 스크래치패드 | 미확인 |

### sagae-claude-plugins-0e

Trail과 rtk 연결은 진행 중이다. 훅 설정의 최종 결론은 끝난 뒤 다시 받는다.

| 경로 | 주제 | 1차 출처 |
|---|---|---|
| `/home/user/.claude/projects/-home-sagae-sagae-claude-plugins/archive-2026-10-31/docs-raw/` | Claude Code 공식 문서 사본 11개 | 포함 |
| `/home/user/.claude/projects/-home-sagae-sagae-claude-plugins/archive-2026-10-31/foundation-design.html` | GitHub self-hosted 러너 과금·보안, 마켓플레이스 배포 비교. 내부 호스트 정보가 섞여 있어 일반 기술 사실만 추출한다 | 포함 |
| `/home/user/.claude/projects/-home-sagae-sagae-claude-plugins/01842778-1730-486e-854c-25be5911f20a/subagents/workflows/wf_7fe34f38-d94/journal.jsonl` | Trail-Code 0.28.1, rtk 1.1.0, Claude Code 훅 실측. `type=result`이고 label이 `investigate:trail`, `investigate:rtk`, `investigate:claude`인 줄만 읽는다 | `investigate:claude`만 포함 |

### claude-setup-22

분석 메모가 아니라 내려받은 공개 문서다. 내려받은 출처 URL과 확인일이 기록돼 있지 않아 1차 출처 재확인이 필요하다. 복사본 위치는 `intake/claude-setup-22/`다.

| 파일 | 주제 |
|---|---|
| `graft.md` | Trail-Code(구 graft) README |
| `rtk.md` | rtk README |
| `manifest.md` | Orca 플러그인 매니페스트 레퍼런스(format 2) |
| `catalog.json` | Orca 공식 플러그인 카탈로그 |
| `orca-git-graph.md`, `git-graph.json` | 서드파티 Orca Git Graph 플러그인 README와 메타데이터(v0.1.0) |
| `orca-windows-notification-dot.md` | 서드파티 Windows 작업표시줄 알림 플러그인 README |
| `vibeguard.md` | VibeGuard for Orca 보안 플러그인 README |

### sagae-bb

| 경로 | 주제 | 1차 출처 |
|---|---|---|
| `/home/user/.claude/projects/-mnt-c-Users-sagae/b20e2713-f884-4d72-81eb-ef5542195de4/subagents/agent-a1b79d360cb747d71.jsonl` | Claude Code 플러그인 마켓플레이스 스키마, 비공개 저장소 인증, 자동 업데이트, CLI. 서브에이전트 전사라 공개 URL만 쓴다. 추출본은 `intake/bb-urls.txt`(206개) | 포함 |
| `/home/user/sagae-claude-plugins/README.md` | 배포 절차와 자동 업데이트 동작 요약. 운영 문서이고 백그라운드 갱신은 미측정 | 없음 |
| `/home/user/sagae-claude-plugins/plugins/proxmox/package-lock.json` | 사용 버전(`@modelcontextprotocol/sdk` 1.32.2, `zod` 4.6.7) | 없음 |

### sagae-claude-plugins-9d

| 경로 | 주제 | 1차 출처 |
|---|---|---|
| `git show foundation/tools-hooks:docs/project-tools.md` (저장소 `/home/user/sagae-claude-plugins`) | rtk, Trail-Code의 프로젝트 단위 훅 적용과 운영. 사용 문서. worktree 사본은 읽지 않는다 | 없음 |

## 제외

| 자료 | 이유 |
|---|---|
| `audit-build.md`, `audit-ops.md` (sagae-claude-plugins) | 내부 인프라 감사. 내부 IP, 노드 이름, 보안 공백 분석, 토큰 권한 목록이 있고 작성 세션도 대상에서 뺐다. 잠시 만든 사본은 지웠다. 공개 사실은 원문 URL에서 수집한다 |
| sagae-claude-plugins 스크래치패드 전체 | 일부 하위 폴더가 비밀값 패턴에 걸렸다고 회신받았다 |
| sagae-tools의 `understand-ecosystem.md`, `understand-verification.md`, `understand-kb-contract.md`, `brief.md` | 이 머신의 구성과 LAN 주소, KB 자체 내용, 내부 설계 브리프다 |
