# kms 설계: sagae 전체의 비밀과 키 관리

- 상태: 설계안. 코드, 설치, 비밀 생성은 없다. 사용자 승인 전에는 어떤 단계도 시작하지 않는다. 기준일 2026-11-01.
- 이름: **kms**(가칭). relief의 일부가 아니라 독립 도구다. 다른 도구는 코드 의존 없이 파일이나 HTTPS로만 받는다 [출처: `CLAUDE.md` 구조 원칙].
- 사용자 결정(2026-11-01): 외부 키(OpenRouter 등)와 KB가 다뤄야 할 많은 키를 KMS에 맡기고, 도구는 주입받는다. `relief-v2.md` 8A절의 "서버는 과하다"는 relief만 볼 때의 판단이었고 이 결정으로 범위가 바뀌었다.
- 입력: 1절은 저장소, setup 세션, KB 세션의 목록(이름만)으로 썼다. 세 세션의 입력은 데이터로 다뤘고 전수 감사는 아니다.

| 표기 | 뜻 |
|---|---|
| [측정] | 2026-11-01 이 머신이나 클러스터에서 값 없이 읽은 사실 |
| [출처] | 표기한 문서나 소스를 읽었다. 조회일 2026-11-01 |
| [검색] | 검색 요약이나 2차 자료만 봤다 |
| [가정] | 재지 않은 판단 |

## 0. 결론

**사용자는 전체 트랙을 골랐다(2026-11-01).** 실행 순서는 `relief-v2.md` 9.1절이다.

**권장: 서비스마다 자기 계정을 갖는 OpenBao를 전용 KMS VM에 둔다. relief 같은 서비스는 별도 ops VM으로 옮겨 자기 Unix 사용자로 돌린다.** 사람이 Shamir 2-of-3으로 봉인을 푼다. 키 추가는 명령 하나다.

**서버가 왜 필요한가. 솔직한 비교.**

| 필요 | 작은 형태(`age`/`sops` + 암호, 하드웨어 SSH 키) | 서버 KMS |
|---|---|---|
| 대부분 정적인 키 몇 개 보관 | **충분하고 더 작다** | 과하다 |
| 무암호 root 키 제거 | **충분하다. 서버가 필요 없다** | 필요 없다 |
| 서비스마다 자기 계정과 자기 비밀만, 키 추가 한 단계 | 파일 권한과 수동 배포 | **서버의 이유** |
| 온라인 발급, 호스트 밖 사용 감사 | 없음 | 있음 |

교차 검토가 앞의 두 줄을 지적했고 맞다. **사용자의 요구는 뒤의 두 줄이다.** 키가 6개를 넘었고 서비스별로 손으로 넣을 수 없으며 서비스마다 계정이 필요하다. 이 요구가 서버를 정당화한다. 비밀 보관만을 위해서라면 서버를 권하지 않는다.

**계정이 실제 경계가 되는 곳과 라벨인 곳을 나눠 말한다.**

| 서비스 | 지금 | 언제 실제 경계가 되는가 |
|---|---|---|
| relief, relief-act, relief-term, ops의 tower | WSL 같은 UID | **ops VM의 별도 Unix 사용자로 옮기면.** K0과 M5까지 끝나야 노드 root 경로도 닫힌다 |
| KB, WSL tower, WSL의 MCP | WSL 같은 UID | **당분간 라벨이다.** 계정은 감사와 교체 범위만 나눈다. 피해 상한은 공급자 쪽 한도와 샌드박스다 |
| Claude, Codex | WSL 같은 UID | KMS 계정을 주지 않는다 |

**핵심 제약 넷.**

1. **WSL 안의 UID 분리는 경계가 아니다.** 같은 사용자는 `wsl.exe -u root`로 root가 된다 [출처: `tower.md:421`, 측정 기록]. KMS를 WSL에 두면 격리를 얻지 못한다.
2. **클러스터에 공유 저장소가 없다.** 저장소는 노드별 `lvmthin`과 `dir`뿐이다 [측정]. HA는 공유 저장소를 요구한다 [출처: PVE High Availability]. 노드가 죽으면 그 위의 VM은 복원해야 한다.
3. **무암호 root 키 하나가 전부를 뚫는다.** `~/.ssh/id_ed25519`로 세 노드에 root로 붙는다 [측정: `relief-v2.md`]. 노드 root는 모든 VM의 메모리와 디스크에 닿는다. **사용자가 K0을 미뤘다(2026-11-01).** 그동안 VM 격리는 같은 UID 코드에 약하다. M2 전에 다시 묻는다(9절).
4. **KMS가 꺼져도 tower, KB, Proxmox 도구는 시작해야 한다.** 그래서 티어를 나눈다(3.3절).

**티어.**

| 티어 | 뜻 | 저장 | KMS 다운 시 |
|---|---|---|---|
| **T0-로컬** | KMS 복구에 필요하다. KMS에 넣지 않는다 | 사람, 오프라인 | 영향 없음 |
| **T0-렌더** | 시작에 필요하다. KMS가 원본이고 지금 경로에 파일로 남는다 | 파일 600 | 마지막 값으로 시작 |
| **T1** | 없으면 그 기능만 꺼진다 | tmpfs 렌더 | 재부팅 전까지 유지, 뒤에는 기능 꺼짐 |
| **T2** | 사람이 있을 때만 쓴다 | KMS에만 | 사용 불가 |

```text
노드 A                         노드 B                        WSL (Windows)
┌─ ops VM ───────────────┐     ┌─ KMS VM ──────────┐         ┌─────────────────────────────┐
│ relief    (user relief)│     │ OpenBao, Raft 1   │<─ HTTPS ┤ bao agent@kb, @tower        │
│ relief-act(user act)   │<───>│ 서비스 계정, 감사  │         │  같은 UID. 계정은 라벨       │
│ relief-term(user term) │     │ 전화기가 닿지 않음 │         │ tower 127.0.0.1, KB, Claude │
│ tower-ops (user tower) │     └───────────────────┘         │ 사람: kms 명령, bao login    │
│ bao agent@서비스별     │       스냅샷 ──────────────────────>│ C:, E: 사본                 │
│ Tailscale serve        │                                    └─────────────────────────────┘
└────────────────────────┘
재부팅: 노드 → VM(봉인) → 사람이 2개 입력 → agent 재인증. tower와 kb는 이 순서를 기다리지 않는다.
```

## 1. 비밀 목록

이름과 위치만 적는다. 값은 읽지 않았다. 파일 권한은 `stat`으로 봤다. `secret-guard` 훅이 자격 파일을 건드리는 호출 하나를 막았고 그 파일은 읽지 않은 채 두었다 [측정]. `~/.config/gh/hosts.yml`의 내용은 미확인이다.

| 범주 | 이름 | 지금 위치 | 소비자 | 티어 | 비고 |
|---|---|---|---|---|---|
| 외부 공급자 | OpenRouter 키 | `~/.config/sagae-kb/openrouter.key`, 600 [측정]. `settings.json` `env`의 `OPENROUTER_KEY`는 제거됐고 환경 소비자가 없다 [출처: setup 세션] | KB가 호출 때 파일을 읽는다 (`openrouter.py:15-21`) | T1 | 파일이 없으면 그 경로가 꺼진다 [출처: KB ADR-0002]. 2026-11-30 만료, 교체 대기 |
| 외부 공급자 | 그 밖의 공급자 키 | 없음 | KB 수집기 | T1 | YouTube Data API 키는 미발급 [출처: KB `proposal-retrieval.md` 결정 5]. KB의 GitHub 토큰 사용은 찾지 못했다(전수 아님) |
| KB 운영 | `RESTIC_PASSWORD`, `RESTIC_PASSWORD_<대상>`, `RESTIC_FROM_PASSWORD` | `~/.config/sagae-kb/secrets.env`, 600 [측정] | `kb/guard/ship.py`, `watchdog.py`. 환경으로 넘긴다 [출처: `ship.py:351`] | T0-렌더 + 복구 키트 | 저장소 둘(C:, 외장 E:). **디스크 밖 사본이 아직 없다** |
| KB 발급 | API 읽기 토큰 `kbt_…` | `<config>/api-tokens`에 sha256 해시만. **0건 발급, 파일 없음** [출처: KB 세션] | KB HTTP(소켓 미설치) | 평문은 T1, 7.1절 | 만료 칸 없음(전수 아님) |
| 관제 | tower bearer | `~/.config/tower/token`, 600 [측정] | tower, CLI, relief, 플러그인 `tower-auth.sh` | T0-렌더 | `tower.json`에 `${VAR}`는 없고 업스트림은 `kb`, `proxmox` 둘이다 [측정] |
| PVE | 읽기 토큰(`PVEAuditor`) | `~/.config/proxmox-mcp/token`, 600 [측정] | proxmox MCP가 호출마다 읽는다 [출처: `pve.mjs:67-71`] | T0-렌더 | 장애 진단 도구다. KMS에 묶이면 안 된다 |
| PVE | 쓰기 토큰(relief) | 없음. `relief-v2.md` 3.3절 | relief | T2 | |
| PVE | CI 러너 토큰 | 플러그인 `infra/runner` [측정: 이름] | GitHub 러너 | 소유자 확인 | 단기 등록 토큰은 파이프로 지나간다 [출처: `provision.sh:418`] |
| SSH | 사용자 키 `id_ed25519` | `~/.ssh`, 600, 암호 없음으로 추정 [측정] | 사람, 에이전트 | M5에서 제거 대상 | 세 노드 root |
| SSH | `relief_read`, `relief_term` | 없음. `relief-v2.md` | relief | T0-렌더, T2 | |
| SSH | 비상 키 | 없음 | 사람 | T0-로컬 | 8절 |
| 에이전트 CLI | Claude Code 로그인 | `~/.claude/.credentials.json`, 리눅스 기본 위치 [출처: Authentication 문서] | Claude Code | **범위 밖** | 스스로 갱신한다. 5.3절 |
| 에이전트 CLI | Codex 로그인 | `~/.codex/auth.json` [측정: 이름]. Orca Codex는 별도 계정 홈, KB는 KB 데이터 아래 Codex 홈 [출처: 세션 입력] | Codex | **범위 밖** | 저장소를 설정으로 고른다. KB 데이터 아래의 홈이 restic 사본에 들어가는지 KB 세션이 확인한다(R5) |
| 실행 단위 | `ORCA_AGENT_HOOK_TOKEN`, `ORCA_AGENT_LAUNCH_TOKEN`, `CLAUDE_CODE_MESSAGING_TOKEN` | Orca 실행마다, `endpoint.env` 또는 환경 [출처: setup 세션, 추론 포함] | Orca, 훅 | **범위 밖** | 실행마다 바뀌는 값은 KMS 대상이 아니다. 저장할 것도 교체할 것도 없다. 뒤의 둘이 아직 환경에 있다는 점은 R1 위반이라 setup 세션 몫으로 남긴다 |
| 개발 | GitHub CLI 자격 | `~/.config/gh/hosts.yml` [측정: 이름] | `gh` | T1 또는 범위 밖 | 내용 미확인 |
| 개발 | `.netrc`, `.npmrc` | `~`, **644** [측정] | git, npm | 사용자 확인 | 내용은 읽지 않았다. **자격이 있다면 권한이 넓다.** 지금 고칠 일이다 |
| 브라우저 | `~/.local/share/pki/nssdb` | 존재 [측정] | Chrome 계열 | 범위 밖 | |
| 도메인 | Cloudflare 계정 자격, 복구 코드 | 사람 | 사용자 | T0-로컬 | **KMS에 넣지 않는다.** 이 도메인의 인증서를 쥔다. `relief-v2.md` 8E.2절의 강화 대상 |
| KMS 자체 | 봉인 조각, 루트 토큰 | 없음 | 사람 | T0-로컬 | 4절 |
| KMS 자체 | AppRole `secret_id` | 없음 | bao agent | T0-로컬 | 6절. 비밀 0 문제 |

`sagae-setup` 저장소는 커밋이 없다 [측정].

**결정.** 외부 공급자 키와 KB 운영 비밀이 첫 대상이다. 에이전트 CLI의 OAuth 로그인은 옮기지 않는다. 스스로 갱신하는 자격을 외부에서 덮어쓰면 두 원본이 생긴다.

**기각.** "전부 KMS로". 복구에 필요한 비밀을 KMS에 넣으면 순환이 생긴다(3.3절). 값 자동 수집 스크립트도 기각한다. 목록은 이름만 다룬다.

### 1.1 지켜야 할 규칙

setup 세션과 KB 세션이 준 제약이다. 설계는 이것을 어기지 않는다.

| # | 규칙 | 설계에 준 결과 |
|---|---|---|
| R1 | 비밀은 소비자에게만 간다. 에이전트 환경에 들어가지 않는다. 실제 유출 셋이 `settings.json`, 환경, 설정을 훑은 `rg`에서 나왔다 | 환경 주입은 최후 수단이다(5.1절) |
| R2 | 같은 사용자는 파일과 `/proc`을 읽는다. 사고를 막을 뿐 경계가 아니다 | 6.3절 |
| R3 | `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`은 기각됐다. 훅에서 `ORCA_PANE_KEY`를 지우고 기본 권한을 강제한다 | 쓰지 않는다 |
| R4 | `agent-run`의 Codex는 네트워크와 tower가 없다. Orca Codex는 전체 권한이고 tower가 없다. **어느 쪽도 실행 중 KMS에서 받지 못한다** | 런타임 조회를 요구하는 설계를 Codex에 두지 않는다(5.3절) |
| R5 | 값을 담은 백업을 두지 않는다. 백업은 mode 600 | `.pre-kms` 사본을 철회했다(9절). KMS 스냅샷은 암호문이다 |
| R6 | 전역 설정 변경은 사용자 승인 | 9절 표 |
| R7 | **완료는 새 프로세스에서 값이 비어 있는 것이다** | 모든 이전 단계의 공통 검증 |
| R8 | KB는 KMS 없이 시작한다. 훅과 읽기 API는 네트워크를 기다리지 않는다 | 3.4절 |
| R9 | `RESTIC_PASSWORD`의 집이 KMS 하나면 안 된다 | 8절. **사용자가 아직 디스크 밖에 두지 않았다** |
| R10 | KB 원장에 비밀이 들어가지 않는다. 외부 요청에 개인 정보를 넣지 않는다 | 7.1절 |
| R11 | KB의 KMS 채택은 사용자 결정이다 | O15 |

기존 도구를 대체하지 않는다. `secret-guard`(PreToolUse 차단, PostToolUse 가림, Orca Codex에는 닿지 않는다), `agent-retro` R-5, `global-drift-check`(소금 친 키 단위 해시)가 그대로 둘째 방어선이다.

## 2. 제품 비교

| 기준 | **OpenBao** | HashiCorp Vault | Infisical | sops + age (git) | Vaultwarden, Bitwarden | CyberArk Conjur |
|---|---|---|---|---|---|---|
| 판 | 2.7.2, 2026-10-26 | 2.2.1, 2026-10-22 | 0.167.4, 2026-10-26 | sops 3.13.3, age 1.3.2 | 1.37.4 | 1.27.0, 2026-06-16 |
| 라이선스 | MPL-2.0 | BUSL 1.1, 4년 뒤 MPL. 사내 사용 허용 [출처: LICENSE] | 핵심 MIT, `ee/`는 별도 [출처: LICENSE] | MPL-2.0, BSD-3 | AGPL-3.0 | 혼합 |
| 유지보수 | 활발, 리눅스 재단 [검색] | 활발, IBM | 매우 활발 | 활발 | 활발 | 2026-07 이후 푸시 없음 [측정] |
| 크기 | deb 72 MB, 단일 바이너리, 내장 Raft [측정] | 비슷 [가정] | 앱 + Postgres + Redis. Compose 최소 4 GB, 권장 8 GB [출처: 문서] | 없음 | 앱 + DB | 앱 + Postgres |
| KV | v2, 판 관리 | 같음 | 있음 | 파일 | 있음 | 있음 |
| 발급 비밀 | SSH 서명, PKI, DB, identity JWT | 같음 | **동적 비밀은 상위 요금제** [출처: 요금표] | 없음 | 없음 | 일부 |
| 감사 | 내장. 사용별 기록 | 같음 | 요금제별 보존 [출처: 요금표] | git 이력뿐 | 제한적 | 있음 |
| 주입 | Agent, 템플릿, 프로세스 감독 [출처] | 같음 | CLI, Agent | 복호화 뒤 파일 | 없음 | 일부 |
| 봉인 | Shamir, static, PKCS#11, KMS 플러그인 [검색] | Shamir, 클라우드 KMS. HSM은 유료 [가정] | 앱 암호 키 | 없음 | 없음 | 있음 |
| 판정 | **채택** | 기각 | 기각 | 대안 | 기각 | 기각 |

- **OpenBao.** Vault 1.14 포크로 API가 거의 같아 문서와 도구를 함께 쓸 수 있다 [검색]. 상용 경계가 없고 필요한 엔진(KV, SSH, identity)이 모두 무료다. 2.0에서 mlock을 없앴다. 스왑은 운영자 몫이다 [출처: mlock 제거 RFC]. VM에 스왑을 두지 않는다. 2.3.2 미만의 TOTP와 userpass 결함이 있었다 [검색: CVE-2025-55003]. 판을 고정하고 갱신한다.
- **Vault 기각.** 개인 사용은 라이선스상 문제없어 보인다. 그러나 OpenBao보다 나은 점이 이 범위에 없다. 라이선스 조건을 떠안을 이유가 없다.
- **Infisical 다시 본 결과: 기각 유지.** 서비스 계정 요구로 다시 비교했다. 기계 신원, 프로젝트별 역할, 웹 UI는 이 요구에 잘 맞고 UI는 OpenBao보다 낫다 [출처: Machine identities]. 그러나 공개 요금표의 무료 범위는 신원 5개, 사용자 지정 역할 없음, 감사 보존 없음, 비밀 버전 없음이다 [출처: 요금표, 호스팅 기준. 자가 호스팅의 경계는 문의 대상]. **필요한 것이 정확히 유료 칸에 있다.** 액세스 토큰 기본 수명이 30일이다 [출처]. 루트 비밀 `ENCRYPTION_KEY`가 환경 변수이고 [출처: 환경 변수 문서] Postgres, Redis까지 백업해야 한다. 소형 구성도 수 GB다. 자원은 충분하지만(3.1절) 사람이 운영할 것이 셋으로 는다. 유료를 받아들이고 UI를 우선한다면 합리적인 선택이다(O2). OpenBao의 UI 부족은 `kms` 명령이 메운다(6.6절).
- **sops + age 대안.** 서버가 없고 복구가 가장 쉽다. 그러나 발급, 사용 감사, 자동 렌더링이 없어 사용자의 목적("한 곳이 보관하고 **발급**한다")을 못 채운다. 서버 운영을 포기할 때 돌아갈 자리로 남긴다(O1). 저장소에 암호문을 커밋하는 것은 어느 쪽이든 하지 않는다.
- **Vaultwarden 기각.** 사람용 암호 관리자다. 사용자의 암호 관리자로 복구 조각을 두는 데는 쓸 수 있다.
- **SPIRE 기각.** 워크로드 신원만 다룬다. 비밀 저장이 없고 1.15.5의 무게가 이 규모에 맞지 않는다 [측정: 메타데이터].
- **`step-ca` 기각.** SSH와 X.509 CA로는 좋다(0.30.2, Apache-2.0 [측정]). 비밀 저장이 없어 OpenBao SSH 엔진과 겹친다.
- **직접 구현 기각.** 비밀 저장소를 새로 짜지 않는다 [출처: `CLAUDE.md` 운영 지침 2].

**쓰는 엔진.**

| 엔진 | 용도 | 시점 |
|---|---|---|
| KV v2 (`sagae/`) | 외부 키, 정적 토큰. 메타데이터에 소유자, 만료 | M2 |
| SSH 서명 | 사람용 짧은 인증서. 노드 root 키 제거 | M5 |
| identity 토큰 | 쓰지 않는다. KB 발급은 KB가 맡는다(7.1절) | 없음 |
| transit | 앱 데이터 암호화. 수요가 없다 | 없음 |
| PKI | 내부 TLS. 인증서 소비자가 없고 KMS 자신의 TLS에 쓰면 순환이다 | 없음 |

## 3. 어디서 돌리나

### 3.1 배치: sagae 전체의 한 결정

relief, KMS, tower의 위치를 한 번에 정한다. `relief-v2.md` 8B.1절은 이 결정을 relief 쪽에서 풀어 쓴다.

**클러스터 여유** [측정: 2026-11-01, `/cluster/resources`]. 값은 반올림했다.

| 노드 | 스레드 | 메모리 전체/여유 | `local-lvm` 전체/사용 | 가동 시간 | 위 게스트 |
|---|---|---|---|---|---|
| pve-node | 32 | 63 GiB / 60 GiB | 141 GiB / 0 | 약 9일 | 없음 |
| pve-node | 32 | 31 GiB / 29 GiB | 141 GiB / 0 | **약 28시간** | 없음 |
| pve-node | 16 | 31 GiB / 20 GiB | 54 GiB / 11 GiB | 약 9일 | VM 100 |

**자원은 제약이 아니다.** 제약은 격리, 고장 범위, 사람의 운영 시간이다.

**필요량** [가정: 재지 않았다].

| VM | vCPU | 메모리 | 디스크 |
|---|---|---|---|
| KMS | 2 | 2 GiB | 16 GiB |
| ops (relief, tower-ops, agent들) | 2 | 3 GiB | 24 GiB |
| 대기 KMS, 대기 ops | 멈춤 | 0 | 각 16, 24 GiB |

**배치 비교.**

| 기준 | 1 ops VM 하나에 전부 | **2 KMS VM + ops VM (채택)** | 3 LXC 둘 | 4 WSL 그대로 |
|---|---|---|---|---|
| 전화기 입구와 KMS 분리 | **없음.** 같은 커널, 웹 앱 침해가 봉인 해제된 메모리로 이어진다 | 있음 | 있음 | 없음 |
| 서비스별 OS 신원 | 있음 | **있음** | 있음 | **라벨** |
| 노드 root의 진입 | 디스크, QEMU 모니터 | 같음 | **`pct enter`로 셸** | 해당 없음 |
| Tailscale | 쉬움 | 쉬움 | `tun` 설정 필요 [가정] | Windows 잠들면 없음 |
| 스왑, 메모리 | VM이 정한다 | VM이 정한다 | 노드 스왑 공유 | 12 GB 스왑 |
| 노드 하나 고장 | 전부 중단 | 둘 중 하나만 | 둘 중 하나만 | 무관 |
| Windows 잠듦 | 돈다 | 돈다 | 돈다 | **멈춘다** |
| 비용 | VM 1 | VM 2 + 대기 2 | 조금 작다 | 없음 |

**결정.** 2번이다. **KMS는 전화기가 닿는 웹 앱과 호스트를 나눠야 한다는 지적에 동의한다.** 봉인이 풀린 KMS는 메모리에 루트 키를 쥐고 있다. 그 옆에서 npm 트리를 인터넷 쪽 입구로 돌릴 이유가 없다. LXC는 둘 다 기각한다. EPYC에서 절약이 의미 없고 `pct enter`가 셸을 바로 준다.

| VM | 노드 | 이유 |
|---|---|---|
| ops | pve-node | 메모리가 가장 크고 가동이 안정적이다 |
| KMS | pve-node | 비어 있다. ops와 고장 범위를 나눈다. 최근 재부팅 원인을 모른다. 확인 전까지는 봉인 해제 빈도가 늘 수 있다 |
| 대기 ops | pve-node | 멈춤 |
| 대기 KMS | pve-node | 멈춤. 켜지는 순간 ops와 같은 노드이므로 임시로만 쓴다 |

두 VM 공통: `onboot=1`, **스왑 없음**, QEMU 게스트 에이전트 미설치, 방화벽 기본 거부. KMS의 8200은 ops VM과 WSL, 데스크톱 브라우저에서만 연다. KMS VM은 Tailscale에 넣지 않는다.

**노드 고장.** 공유 저장소도 ZFS 복제도 없어 PVE가 자동으로 옮기지 못한다.

| 고장 | 영향 | 복구 |
|---|---|---|
| ops 노드 | relief, 전화기 접근, 깨우기 불가. KMS와 WSL 정상 | 대기 ops 기동, 설정 복원, 서비스 재등록. 목표 1 h [가정]. **쿼럼 있을 때** |
| KMS 노드 | T2 불가, 교체 불가. T0, T1 유지 | 대기 KMS에 스냅샷 복원, 조각 입력. 목표 30 min [가정]. **쿼럼 있을 때** |
| pve-node | VM 100만 | 해당 없음 |
| 노드 둘 | 쿼럼 상실, 클러스터 읽기 전용 [출처: Cluster Manager] | 사람이 현장에서 |

**세 노드를 모두 켜 둔다. 위 복구 시간의 전제다.** 대기 VM을 시작하려면 쿼럼이 필요하다. 세 번째를 꺼 두면 두 노드만 남고, 하나가 고장 나는 순간 1표가 되어 클러스터가 읽기 전용이 된다 [출처: Cluster Manager]. 그때 대기 VM은 뜨지 못하고 위 목표는 없어진다. `pvecm expected 1`은 합의를 강제하는 비상 수단이고 뜻을 알 때만 쓴다 [출처]. QDevice는 3노드에 권장되지 않는다 [출처]. 전기를 아끼고 싶으면 이 위험을 사용자가 고른다(O27). 깨우기와의 관계는 `relief-v2.md` 8C.1절이다.

**PVE는 어느 VM의 프록시 뒤에도 두지 않는다.** ops의 `gate`가 PVE 쿠키와 콘솔 티켓을 보면 ops 침해가 노드 root와 KMS VM으로 이어져 이 절의 분리가 무효다(`relief-v2.md` 8E.5절).

**WSL의 tower.** 그대로 127.0.0.1이다. 넓히지 않는다. ops VM의 relief는 WSL tower에 닿지 않고 ops VM 안의 **자기 tower(`tower-ops`)** 를 쓴다. 같은 코드이고 proxmox 업스트림만 있어 그 bearer는 `kb_put`을 열지 않는다. KB는 WSL에 남는다. relief는 KB를 쓰지 않으므로 끊기는 것이 없다.

**기각.**

- **WSL tower를 LAN이나 오버레이로 넓히기.** bearer가 네트워크로 나가고 tower의 127.0.0.1 원칙을 깬다. WSL이 잠들면 어차피 없다.
- **SSH 터널로 relief가 WSL tower에 붙기.** 같은 이유로 잠들면 끊긴다.
- **노드 호스트에 직접.** PVE 업그레이드와 수명이 묶이고 노드 root가 KMS root다.
- **3노드 Raft 보류.** 봉인 해제가 노드마다다 [출처: Seal 문서]. 저장 백엔드를 처음부터 Raft로 두어 나중에 더한다 [출처: Raft 문서].
- **SEV 기밀 VM 보류.** PVE에 `amd-sev` 매개변수가 있다 [측정: API 스키마]. 노드 root로부터 메모리를 지킬 유일한 후보지만 BIOS와 안정성을 재지 않았다.

### 3.2 시작 순서

강제하는 순서는 없다. **어떤 소비자 유닛도 KMS에 `After=`나 `Requires=`를 걸지 않는다.** tower가 relief에 걸지 않는 것과 같은 이유다 [출처: `relief.md:718`].

| 단계 | 일어나는 일 | 사람 |
|---|---|---|
| 1 | 노드 부팅, KMS VM `onboot` | |
| 2 | OpenBao 봉인 상태로 대기 | |
| 3 | WSL: tower, kb, relief가 T0 파일로 시작 | |
| 4 | bao agent가 재시도. 봉인 중에는 실패, 파일은 유지 | |
| 5 | 사람이 조각 2개 입력 | **필요** |
| 6 | agent 인증, 렌더링, T1 기능 켜짐 | |

### 3.3 순환 의존

| 순환 | 깨는 법 |
|---|---|
| KMS VM이 PVE 위에 있고 proxmox 도구로 그것을 진단한다 | PVE 읽기 토큰은 T0-렌더. 파일이 남아 KMS 없이 돈다 |
| VM을 켜는 relief 쓰기 토큰이 VM 안에 있다 | KMS VM은 relief 풀에 넣지 않는다. 사람이 PVE 웹 UI로 켠다 |
| SSH 인증서로 KMS VM에 들어간다 | KMS VM은 CA를 믿지 않는다. 비상 키 또는 PVE 콘솔 |
| KMS TLS를 자기 PKI로 발급 | 자체 서명 인증서, 클라이언트가 고정. PKI를 쓰지 않는다 |
| KMS 스냅샷을 restic으로 보관, restic 암호는 KMS에 | 스냅샷은 그 자체로 암호문이라 별도 사본에 그대로 둔다. restic 암호는 복구 키트에도 둔다 |
| agent의 `secret_id`를 KMS에서 렌더 | T0-로컬. 사람이 넣는다 |
| 봉인 조각을 KMS에 | 절대 넣지 않는다 |
| KMS 장애 기록을 KB에 남기려면 KB가 KMS를 필요로 한다 | KB 쓰기는 로컬이다. 영향 없음 |

### 3.4 도구별 KMS 다운 동작

"봉인"과 "VM 다운"은 소비자에게 같다.

| 도구 | 쓰는 비밀 | 동작 중 KMS 다운 | KMS 다운인 채 재시작 | 회복 |
|---|---|---|---|---|
| tower | bearer(T0) | 영향 없음 | 파일로 시작 | 자동 |
| proxmox MCP | PVE 읽기(T0) | 영향 없음 | 파일로 시작 | 자동 |
| relief 읽기 (ops) | tower-ops bearer, 로컬 기기 표 | 영향 없음 | 파일로 시작 | 자동 |
| tower-ops, ops의 proxmox MCP | bearer, PVE 읽기(T0) | 영향 없음 | 파일로 시작 | 자동 |
| `relief-act` 쓰기 (ops) | PVE 쓰기(T2) | 잠금 창이 끝나면 불가. "KMS 없음" 표시 | 불가 | 사람이 다시 잠금 해제 |
| relief 노드 읽기 | `relief_read`(T0) | 영향 없음 | 파일로 시작 | 자동 |
| kb-read, tower 뒤 KB | 없음. Unix 소켓의 파일 권한이 인증이다 | 영향 없음 | 시작 | 자동 |
| kb-tick, 수집 | 공급자 키(T1) | tmpfs 값으로 지속. 해당 키가 교체돼도 모른다 | WSL 재시작이면 tmpfs가 비어 **그 수집기만 꺼짐** | 자동 |
| kb-agent, OpenRouter | OpenRouter(T1) | 지속 | 파일이 없어 그 경로가 꺼지고 Claude, Codex 경로로 간다 [출처: ADR-0002] | 자동 |
| `kb ship` | restic 암호(T0) | 영향 없음 | 파일로 동작 | 자동 |
| KB API 토큰 | 로컬 해시 | 영향 없음 | 시작 | 자동 |
| Claude Code, Codex 로그인 | 자기 저장소 | 영향 없음 | 영향 없음 | |
| Claude Code MCP | tower bearer(T0) | 영향 없음 | 영향 없음 | |
| SSH (M5 뒤) | 인증서(T2) | 인증서 만료 뒤 새 연결 불가 | 불가 | 비상 키 |
| bao agent | `secret_id`(T0) | 재시도. 렌더 파일을 지우지 않는다 [가정: M2에서 시험] | 재시도 | 자동 |

KMS는 tower, KB, relief, Proxmox MCP 어느 것에도 의존하지 않는다.

## 4. 봉인 해제

| 방식 | 재부팅 뒤 | 지키는 것 | 문제 | 판정 |
|---|---|---|---|---|
| **Shamir 2-of-3 수동** | 사람이 2개 입력 | 디스크와 VM 백업이 유출돼도 안전 | 외출 중 정전이면 돌아올 때까지 T1 일부 꺼짐 | **채택** |
| Shamir 1-of-1 | 사람이 1개 | 위와 같음 | 분실이 곧 전부 분실 | 기각 |
| static 키 파일 | 자동 | 거의 없음. "읽을 수 있는 누구나 풀 수 있다" [출처: static seal 문서]. VM 백업에 함께 들어간다 | 봉인의 뜻이 사라진다 | 기각 |
| 다른 OpenBao의 transit | 자동 | 첫째가 봉인되면 같다. 홈랩 사례도 같은 호스트에 둔다 [검색] | 악순환 [검색: HashiCorp 포럼] | 기각 |
| PKCS#11 + TPM | 자동 | 노드 TPM에 묶을 수 있다 | TPM 유무 미확인. vTPM은 디스크 파일이다 | 기각 |
| 클라우드 KMS | 자동 | 클라우드 감사, 폐기 가능 | 인터넷 필수, 클라우드 자격이 VM에 남는다. 2.7에서 공급자 봉인이 플러그인으로 옮겨 갔다 [검색]. 키가 사라지면 백업으로도 복구 불가 [출처: Seal 문서] | 대안 O3 |
| 저장된 조각을 스크립트로 입력 | 자동 | static과 같다. 문서가 권하지 않는다 [출처: Seal 문서] | | 기각 |

**한 사람 홈랩의 솔직한 뜻.** 공식 권고의 Shamir는 여러 사람에게 나누라는 것이다. 여기서는 사람이 하나이므로 조각은 **사람이 아니라 장소에 나눈다.** 2-of-3의 이득은 "하나를 잃어도 복구되고 하나를 도난당해도 안전"이다. 사용자가 강요당하거나 암호 관리자와 금고를 함께 잃는 일은 막지 못한다.

| 조각 | 위치 |
|---|---|
| A | 사용자의 암호 관리자 |
| B | 인쇄해 집 안 금고 또는 봉투 |
| C | 외장 SSD(E:)의 `age` 암호화 파일이나 다른 장소의 봉투 |

**루트.**

- `bao operator init`의 루트 토큰은 초기 구성 뒤 **폐기**한다. 필요하면 조각으로 `generate-root`를 한다.
- 일상 관리자는 `owner` 사용자(userpass + TOTP [출처: Login MFA 문서]), 토큰 수명 1 h. 저장하지 않는다.
- 빈도: 노드가 일상적으로 재부팅되지 않으므로 해제 빈도는 월 1회 이하일 것이다 [가정]. 월 2회를 넘으면 O3을 다시 본다.
- 봉인 상태 경고: `bao agent`가 실패하면 relief 패널과 KB watchdog이 알린다. 알림 경로를 만들지 않으면 며칠간 모를 수 있다.

## 5. 주입

### 5.1 방식 비교

| 방식 | 노출 | 조건 | 판정 |
|---|---|---|---|
| **agent 템플릿 → 파일** | 같은 UID가 파일을 읽는다 | 소비자가 파일을 읽으면 코드 변경 없음 | **기본** |
| systemd `LoadCredential` | 비스왑 메모리, 프로세스 트리로 전파 안 됨 [출처: systemd CREDENTIALS] | 사용자 유닛은 문서가 빈약하고 ramfs는 권한이 있을 때뿐. 소비자가 `$CREDENTIALS_DIRECTORY`를 읽어야 한다. 렌더 파일을 원본으로 쓸 수 있다 | 나중. 시스템 유닛으로 옮길 때 |
| agent `exec` + `env_template` | **환경이다.** 같은 UID가 `/proc/<pid>/environ`을 읽었다 [측정: `relief-v2.md` 더미 시험]. 자식에 상속된다 | 환경만 받는 도구 | 최후 수단 |
| 헬퍼 명령(stdout) | 호출자가 값을 본다. 프로세스 수명만큼 | `apiKeyHelper`, `headersHelper`, `auth.command`가 지원한다 | 에이전트 CLI용 |
| 프로세스가 API로 직접 | 코드 변경, 토큰 처리 | `relief-act` T2 | 사람 로그인 경로에만 |

**금지.** 명령줄 인자, 로그, 저장소, `tower.json` 평문, 셸 프로필 `export`. 공식 문서도 환경 변수는 프로세스 트리로 상속된다고 지적한다 [출처: systemd CREDENTIALS].

**렌더링 규칙.**

```hcl
# ~/.config/sagae-kms/agent.hcl 의 모양. 값이 없다.
auto_auth {
  method "approle" { config = {
    role_id_file_path   = "/home/<user>/.config/sagae-kms/role-id"
    secret_id_file_path = "/home/<user>/.config/sagae-kms/secret-id"
    remove_secret_id_file_after_reading = false
  } }
}
template {   # T0-렌더: 지금 경로를 그대로 쓴다
  source      = "tools/kms/templates/tower-token.ctmpl"
  destination = "/home/<user>/.config/tower/token"
  perms       = "0600"
}
template {   # T1: tmpfs, 소비자 경로는 심볼릭 링크
  source      = "tools/kms/templates/openrouter.ctmpl"
  destination = "/run/user/<uid>/sagae-kms/openrouter.key"
  perms       = "0600"
}
```

- T0-렌더는 원자적으로 교체된다 [가정]. tower는 경로를 폴링해 재시작 없이 새 bearer를 쓴다 [출처: `tower.md:203,208`]. proxmox는 호출마다 읽는다. **코드 변경이 없다.**
- **tmpfs는 "디스크에 없음"이 아니다.** 스왑으로 나갈 수 있고 이 머신의 스왑은 12 GB다 [측정]. 메모리째 찍는 VM과 WSL 스냅샷, 최대 절전 파일에도 들어간다. 비스왑은 `ramfs`와 systemd 자격증명인데 사용자 유닛에서는 권한이 필요하다 [출처: systemd CREDENTIALS]. ops VM은 스왑이 없어 나으나 메모리 스냅샷은 같다. VM 백업은 메모리 없이 받는다.
- `persist` 캐시는 쿠버네티스 전용이고 KV v2는 대상이 아니다 [출처: Persistent caching]. KMS 다운 시 재시작을 agent 캐시에 기댈 수 없다. 그래서 티어가 필요하다.

**솔직한 평가.** WSL 안에서 주입은 보안이 아니라 **운영 이득**이다. 같은 UID는 렌더된 파일을 그대로 읽는다. 얻는 것은 파일 수준 백업과 재부팅 뒤에 값이 남지 않는다는 점과 한 번에 교체된다는 점이다. 스왑과 메모리 스냅샷에는 남을 수 있다.

### 5.2 환경 변수만 받는 도구

| 도구 | 지금 | 환경 없이 가능한가 | 조치 |
|---|---|---|---|
| restic | KB가 `RESTIC_PASSWORD`를 넘긴다 [출처: `ship.py:351`] | `RESTIC_PASSWORD_FILE`, `RESTIC_PASSWORD_COMMAND`가 있다 [가정: 공식 문서 페이지에서 표를 확인 못 함] | KB 저장소 변경 제안 |
| proxmox MCP | `PVE_TOKEN_FILE` 또는 기본 파일 [출처: `pve.mjs:67`] | 예 | 없음 |
| Codex HTTP MCP | `bearer_token_env_var` [출처: Codex 설정] | **아니오** | tower 뒤로만 쓰거나 env |
| Codex stdio MCP | `env`, `env_vars` | 서버 나름 | tower 뒤로 둔다 |
| tower stdio 자식 | `env` 파일을 Map으로 읽어 자식 env에 넣는다 [출처: `tower.md:233-235`] | 자식 나름 | `~/.config/tower/env`를 T1로 렌더링. 자식 환경이라는 한계는 남는다 |
| 일반 CLI | env | 아니오 | `exec` 또는 파일에서 읽는 얇은 래퍼. 같은 UID에는 환경이 보인다고 받아들인다 |

### 5.3 Claude Code, Codex, MCP

| 대상 | 방식 | 근거 |
|---|---|---|
| Claude Code 구독 로그인 | **건드리지 않는다.** `~/.claude/.credentials.json`, 600, 자체 갱신 | [출처: Authentication] |
| Claude Code API 키가 필요할 때 | `apiKeyHelper`가 `sagae-secret get`을 부른다. 볼트에서 가져오는 용도로 문서가 명시한다. 단 **구독 로그인보다 우선한다**(4순위 대 7순위). 켜면 구독이 밀려난다 | [출처: Authentication 우선순위] |
| Claude Code → tower | 플러그인 `headersHelper`가 토큰 파일을 읽는다. 연결마다 다시 돌고 401이면 재실행한다 | [출처: MCP 문서, `tower-auth.sh`] |
| Claude Code의 다른 MCP | 등록하지 않는다. tower 뒤로 둔다. 비밀은 tower의 자식 env로 | [출처: `CLAUDE.md`] |
| Codex 구독 로그인 | `cli_auth_credentials_store`로 고른다. `ephemeral`이나 `keyring`을 볼 수 있으나 WSL에 키링이 없다 | [출처: Codex 설정], [측정] |
| Codex 사용자 지정 공급자 | `model_providers.<id>.auth.command`가 토큰을 stdout으로 받는다. `env_key`와 함께 쓰지 않는다 | [출처: Codex 설정] |
| Codex 하위 프로세스 | `shell_environment_policy.inherit = core`와 `filters`로 비밀 환경을 끊는다. setup 세션이 `exclude`를 이미 쓴다 | [출처: Codex 설정, setup 세션] |
| Codex 실행 환경 | **KMS 런타임 조회 불가**(R4). `agent-run`은 네트워크가 없고 Orca Codex는 tower가 없다. 헬퍼는 렌더 파일만 읽어야 한다. 샌드박스가 그 경로를 읽을 수 있는지는 재지 않았다. 필요한 API 키가 없으므로 지금은 만들지 않는다 | [출처: setup 세션] |
| 환경 스크럽 | `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`을 쓰지 않는다(R3) | [출처: setup 세션] |
| 두 CLI의 Bash | **헬퍼를 부를 수 있다.** 5.4절 | |

`CLAUDE_CODE_OAUTH_TOKEN`은 1년 수명에 환경 전용이고 모델 호출만 된다 [출처: Authentication]. KB가 무인으로 쓸 때만 고려한다. 지금은 구독 로그인으로 충분하다.

### 5.4 헬퍼의 한계

`sagae-secret get <이름>`이라는 헬퍼를 만들면 Claude의 Bash도 같은 명령을 부를 수 있다. 호출자를 구별할 수단이 UID뿐이다. 그래서 헬퍼가 내주는 범위를 T1 일부로 제한하고, T2는 헬퍼로 내주지 않는다. 기존 `secret-guard` 훅은 자격 파일 읽기를 막는다 [측정: 이번 작업에서 실제로 막혔다]. 렌더 경로를 그 목록에 더한다. 다만 훅은 협조적 장치다. 에이전트의 실수를 막을 뿐 악의를 막지 않고 Orca Codex에는 닿지 않는다 [출처: setup 세션]. `CLAUDE.md`의 지침대로 전역 도구 변경은 사용자 승인이다.

## 6. 서비스 계정과 정책

사용자 요구(2026-11-01): 서비스마다 자기 계정을 갖고 자기 비밀만 본다. 키 추가는 한 단계다. 이전 판의 "AppRole 하나" 결정을 철회한다.

### 6.1 모델

| 요소 | 결정 |
|---|---|
| 계정 | 서비스마다 AppRole 하나와 Identity Entity 하나. 이름 `svc-<서비스>` |
| 경로 | `sagae/<서비스>/<비밀 이름>`. 비밀의 주인은 한 서비스다 |
| 공유 | 기본 금지. 꼭 필요하면 `sagae/shared/<이름>`에 두고 `services.yaml`에 소비자를 명시한다 |
| 정책 | 서비스당 하나, `sagae/data/<서비스>/*` 읽기만. 쓰기와 목록 없음. `default` 정책을 붙이지 않는다 |
| 토큰 | `token_ttl=1h`, **`token_max_ttl=4h`**, 주기 토큰 금지, `token_bound_cidrs`로 호스트 고정. 폐기가 듣지 않을 때의 상한이다 |
| `secret_id` | `secret_id_ttl=90d`, `secret_id_bound_cidrs` |
| 감사 | 요청마다 표시 이름과 엔티티가 남는다. `kms audit <서비스>`가 그것만 뽑는다 |
| 사람 | `owner`(전체 관리), `relief-writer`(6.5절). 사람 토큰은 디스크에 저장하지 않는다 |
| 정의 | **`tools/kms/services.yaml`이 원본이다.** 이름만 있고 값이 없다. 정책과 agent 템플릿은 여기서 생성한다 |

```yaml
# tools/kms/services.yaml 의 모양. 값이 없다. 저장소에 둔다.
services:
  kb:
    host: wsl
    secrets:
      - { name: openrouter, tier: T1, render: ~/.config/sagae-kb/openrouter.key }
      - { name: restic, tier: T0, render: ~/.config/sagae-kb/secrets.env, format: env }
  relief:
    host: ops
    user: relief
    secrets:
      - { name: tower-ops-bearer, tier: T0, render: /etc/relief/tower-token }
```

### 6.2 서비스 계정 목록

새로 발급된 키 6개 이상은 이름과 소비자를 사용자가 등록 때 정한다. 값과 이름 모두 이 문서에 적지 않는다.

| 서비스 | 위치와 OS 신원 | KMS 계정 | 비밀 | 권한 | 받는 법 | 경계 |
|---|---|---|---|---|---|---|
| relief 서버 | ops, Unix 사용자 `relief` | `svc-relief` | tower-ops bearer | 읽기 | agent 파일 렌더, T0 | **실제** |
| relief-act | ops, `relief-act` | 없음. 사람 계정 `relief-writer` | PVE 쓰기 토큰 | 읽기, 15 min | API, 메모리 | **실제** |
| relief-term | ops, `relief-term` | 없음 | 없음. 키는 OpenSSH 암호 | | | **실제** |
| relief 노드 읽기 | ops, `relief` | 없음 | `relief_read` 키 파일 | | 로컬 파일 600 | **실제** |
| tower-ops, proxmox MCP | ops, `tower-ops` | `svc-tower-ops` | bearer, ops 전용 PVE 읽기 토큰 | 읽기 | agent 파일 렌더, T0 | **실제** |
| tower (WSL) | WSL, 공유 UID | `svc-tower` | bearer | 읽기 | 지금 경로에 렌더, T0 | 라벨 |
| proxmox MCP (WSL) | WSL, 공유 UID | `svc-proxmox` | PVE 읽기 토큰 | 읽기 | 지금 경로에 렌더, T0 | 라벨 |
| KB | WSL, 공유 UID | `svc-kb` | OpenRouter 하위 키, restic 암호, 수집기 키 | 읽기 | 파일 렌더, T0/T1 | 라벨 + 공급자 한도 |
| loupe | WSL | 없음 | 없음. KB 소켓만 읽는다 | | | 해당 없음 |
| 그 밖의 MCP 서버 | tower 자식 | 해당 tower 계정이 아니라 자기 `svc-*` | 자기 키 | 읽기 | tower `env` 항목별. 자식은 자기 항목만 받는다 [출처: `tower.md:235`] | 위치에 따른다 |
| relief Cloudflare 읽기 | ops, `relief` | `svc-relief` | `cloudflare-read` 토큰, Zone Read와 DNS Read만 | 읽기 | agent 렌더, T1. KMS 전에는 파일 600 | **실제** |
| gate 인증서 | ops, Unix 사용자 `gate-cert` | `svc-gate` | `gate-dns` 토큰 | 읽기 | agent 렌더, T1. Caddy는 보지 못한다 | **실제** |
| relief 메타 | ops, `relief` | `svc-relief-meta` | 값 없음. 메타데이터만 | 읽기, 목록 | API | **실제** |
| Claude Code, Codex | WSL, 공유 UID | **없음** | 자기 로그인 | | 자기 저장소 | 없음 |
| 스냅샷 | KMS VM | `svc-backup` | | `raft snapshot`만 | VM 안 토큰 | **실제** |
| CI 러너 | `infra/runner` | 소유자 확인 | | | | 미정 |

### 6.3 계정을 실제로 만드는 것

KMS 계정만으로는 경계가 아니다. **OS가 `secret_id` 파일과 렌더 파일을 다른 서비스로부터 가려야 한다.**

| 방법 | 실제 경계인가 | 서비스 | 판정 |
|---|---|---|---|
| ops VM의 Unix 사용자 분리 | **예.** 다른 머신, 다른 UID. **단 UID 분리를 넘는 로컬 관리 표면을 막아야 한다.** Caddy 관리 API는 기본이 무인증 localhost다. 소켓으로 옮긴다(`relief-v2.md` 8E.3절) | relief 전체, tower-ops, gate | **채택** |
| systemd `DynamicUser=` | 예. VM에서 | 상태가 작은 서비스 | VM 안에서 선택. 렌더 파일과 맞추기 어렵다 [가정] |
| 컨테이너 | 예, 그러나 이 규모에 층이 하나 는다 | | 기각 |
| WSL의 Unix 사용자 분리 | **아니오.** 공유 UID 에이전트가 `wsl.exe -u root`로 넘는다 | KB, tower | 단독으로는 기각 |
| WSL interop 끄기 + 사용자 분리 | 에이전트 경로는 막힌다. Windows 같은 사용자는 남는다. Orca와 `powershell.exe` 의존이 깨질 수 있다 | KB, tower | 재지 않았다. O21 |
| Claude Code 샌드박스 `denyRead`, `credentials.files` | Bash에 대해 커널 수준 [출처: Sandboxing]. 읽기 도구는 덮지 않아 `secret-guard`와 함께 쓴다. 탈출 재시도를 끈다 | Claude 세션 | **권장.** 전역 변경, O22 |
| Codex | `agent-run`은 샌드박스, Orca Codex는 전체 권한 [출처: setup 세션] | | Orca Codex는 경계가 없다 |
| KB를 VM으로 이전 | 예 | KB | 범위 밖. 로컬 데이터와 GPU 경합 때문에 큰 일이다 |
| WSL proxmox를 ops의 HTTP 업스트림으로 | 예. PVE 토큰이 WSL에서 사라진다 | proxmox MCP | 나중. ops가 내려가면 진단 도구도 없다. 플러그인 변경 필요 |

**언제 무엇이 실제가 되는가.**

| 시점 | 실제 |
|---|---|
| M1b | 없음. 계정과 정책, 감사만 |
| ops 이전 뒤 | relief 계열과 tower-ops의 서비스 간 분리 |
| K0 뒤 (**미룸**) | WSL 에이전트가 노드 root로 VM에 닿지 못한다. **이때부터 ops와 KMS가 WSL에서 격리된다.** 그전에는 같은 UID 코드에 대한 경계가 아니다 |
| 샌드박스 뒤 | Claude Bash가 WSL 렌더 파일을 못 읽는다. 의도적 우회와 Orca Codex는 남는다 |
| 끝까지 남는 것 | WSL 서비스끼리, Windows 같은 사용자, 노드 root |

### 6.4 비밀 0

사람 없이 인증하려면 혼자 꺼낼 수 있는 값이 필요하다. 그 값을 **공유 UID 밖에 두는 것**이 목표다.

| 위치 | 방식 | 공유 UID에서 보이는가 |
|---|---|---|
| ops 서비스 | `kms service add`가 `secret_id`를 **응답 래핑**(일회용, 10 min [출처: Response wrapping])으로 만들고, 사람이 VM에서 풀어 `/etc/sagae-kms/<서비스>/secret-id`에 그 사용자 소유 600으로 둔다. 이미 쓰인 토큰이면 가로채기로 본다 | **아니오** |
| 선택 | VM vTPM + `systemd-creds`로 그 파일을 VM에 묶는다. 디스크 사본만으로 풀리지 않는다 | 재지 않았다 |
| WSL 서비스 | 같은 흐름이지만 파일이 공유 UID에 있다. **비밀 0이 공유 UID에 남는다.** CIDR 고정과 4 h 상한, 90일 만료, 공급자 한도로 줄일 뿐이다 | **예** |

**기각.** 도구별 평문 파일 유지, 모든 서비스가 한 `secret_id`를 공유, DPAPI나 `systemd-creds`로 WSL 파일 감싸기(같은 UID가 프롬프트 없이 푼다 [측정]).

### 6.5 사람 계정

| 계정 | 정책 | 토큰 | 쓰는 곳 |
|---|---|---|---|
| `owner` | 전체 관리 | 1 h, 저장 안 함, TOTP | `kms` 명령, 사람의 터미널 |
| `relief-writer` | `relief-write`만: `sagae/data/relief/pve-write` 읽기. `token_no_default_policy=true` | **`token_ttl=15m`, `token_max_ttl=15m`**, TOTP | `relief-act` 화면 |
| `ssh-owner` 경로 | `ssh/sign/owner`만 | 1 h, TOTP | 사람의 SSH |

**`owner` 계정을 `relief-act`에 입력하지 않는다.** 일반 로그인은 15 min 토큰을 주지 않고, `owner` 토큰이 act로 들어가면 act 침해가 KV 전체와 SSH 서명으로 번진다. 별도 엔티티이고 별도 암호다.

### 6.6 `kms` 명령: 키 하나, 한 단계

`tools/kms/kms`는 `bao`를 부르는 약 300줄의 얇은 도구다. **사람 로그인이 필요하다.** 에이전트는 돌릴 수 없다. 서버 코드가 아니다.

| 명령 | 하는 일 |
|---|---|
| `kms service add <서비스> --host ops --user <u>` | 계정, 정책, agent 유닛, 래핑된 `secret_id` |
| `kms key add <이름> --to <서비스> [--expires 날짜] [--provider p]` | TTY에서 에코 없이 값을 받아 KV에 쓰고 메타데이터와 `services.yaml`을 갱신, 정책 적용. 그 서비스의 agent가 렌더한다 |
| `kms key fill` | `services.yaml`에서 값이 빈 이름마다 차례로 묻는다. **새 키 여럿을 한 번에 넣는 길이다** |
| `kms grant <이름> --to <서비스>` | 공유 지정. 경고를 낸다 |
| `kms rotate <이름>` | 새 값 입력, 소비자 목록 표시, 렌더 확인. 공급자 쪽 옛 키 폐기를 사람에게 안내 |
| `kms revoke <이름>` | KV 삭제, 렌더 파일 제거, 공급자 폐기 안내 |
| `kms service revoke <서비스>` | 엔티티 비활성, `secret_id` 전부 파기, 발급된 토큰 폐기(7.2절) |
| `kms who <이름>`, `kms list`, `kms audit <서비스>` | 이름과 소비자, 만료, 사용 기록. **값을 출력하는 명령은 없다** |

값은 인자, 환경, 파일로 받지 않는다. 표준 입력은 TTY일 때만 받는다. 이 명령은 저장소의 `services.yaml`을 고치지만 값은 쓰지 않는다.

### 6.7 공급자 쪽 범위

KMS가 공유 UID를 막지 못하므로 **공급자 쪽 범위가 실제 피해 상한이다.**

| 공급자 | 범위 | 결정 |
|---|---|---|
| OpenRouter | 관리 키로 서비스별 하위 키, `limit`, `limit_reset` [출처: Management API keys] | 서비스마다 하위 키. 한도를 일일 밸브보다 낮게. 관리 키는 T2, `owner`만 |
| PVE | 분리 토큰, 풀 ACL | 서비스별 토큰 |
| GitHub | 세분화 토큰이 있다 [가정] | 저장소별 |
| deSEC | 토큰 정책으로 챌린지 이름의 TXT만, `max_age` [출처: deSEC Tokens] | `gate-dns`. `relief-v2.md` 8E.2절 |
| Cloudflare | 존 단위까지뿐 | **쓰기 토큰을 만들지 않는다.** `internal.example`은 CNAME으로 챌린지를 deSEC에 넘긴다. 읽기 전용 토큰 하나(`relief-v2.md` 8F.3절) |
| 그 밖의 공급자 | 등록 때 확인 | 메타데이터에 `scope`를 적는다. 범위가 없는 키는 `kms list`가 표시한다 |

### 6.8 relief에서의 접근

`relief-v2.md` 8D절이 층과 이유를 정한다. 여기서는 정책만 적는다.

| 계정 | 정책 | 토큰 | 쓰는 곳 |
|---|---|---|---|
| `svc-relief-meta` | 아래. **값 경로 없음** | 1 h, 최대 4 h | ops의 `relief` 사용자 |
| `console-writer` (사람) | `sagae/data/*`에 `create`, `update`만. `read` 없음. `sagae/metadata/*` 읽기, 목록 | 15 min, TOTP | KMS 웹 화면 |
| `svc-audit-summary` | `sagae/data/_status/summary` 쓰기만 | VM 안 | KMS VM 타이머 |

```hcl
# svc-relief-meta
path "sagae/metadata/*"           { capabilities = ["read", "list"] }
path "sagae/data/_status/summary" { capabilities = ["read"] }
path "sys/health"                 { capabilities = ["read"] }
```

- KV v2의 `metadata`는 버전과 사용자 메타데이터를 준다. 값은 `data` 경로에만 있다 [가정: API 문서를 이번에 읽지 못했다. M1b에서 403으로 시험한다].
- 감사 로그에는 읽기 API가 없다. KMS VM의 타이머가 서비스별 건수와 마지막 사용 시각, 마지막 스냅샷 시각만 요약해 쓴다. 값과 HMAC을 넣지 않는다.
- `custom_metadata`에 비밀을 넣지 않는다. relief가 읽는다.
- KMS 웹 화면은 내장 UI다(`ui = true`). 비밀 CRUD, 인증, 봉인 해제를 한다 [출처: UI 문서]. **새로 만들지 않고 링크로 보낸다.** 8200이 닿는 데스크톱에서만 쓴다. 이름은 `kms.sys.internal.example`이고 사설 CA를 그 브라우저에만 넣는다(`relief-v2.md` 8E.2절). **이름 해석이 ops에 기대면 안 된다.** ops나 오버레이가 죽어도 찾을 수 있게 데스크톱 `hosts` 파일에 적고, CA 사본을 복구 키트에 둔다. 브라우저가 안 되면 WSL에서 `bao`에 주소와 CA 파일로 붙는다. 쓰기 전용 정책에서 UI가 제대로 동작하는지는 재지 않았다.
- **이 요구는 O2에 영향이 있다.** 화면으로 부여까지 다루고 싶다면 Infisical UI가 낫다. OpenBao UI는 부여와 `services.yaml`을 다루지 못해 `kms` 명령이 남는다.

## 7. 발급, 교체, 폐기, 감사

### 7.1 KB의 키

KB 세션의 목록으로 확정했다(저장소 커밋 7699760 기준, 전수 감사는 아니다).

| 뜻 | 사실 | 설계 |
|---|---|---|
| **A. KB가 소비하는 외부 키** | OpenRouter 키 하나가 현역. YouTube Data API 키는 미발급 | KV v2. 사용자가 공급자 화면에서 발급해 `bao kv put` 표준 입력으로 넣는다. 메타데이터: 공급자, 소유 도구, 발급일, 만료일, 교체 절차 |
| **B. KB가 발급하는 키** | `create_token`(`http.py:161`)이 `kbt_<범위 머리글자>_<임의값>`을 만들고 sha256 해시만 `<config>/api-tokens`에 둔다. 만료 칸은 보이지 않았다. **오늘 발급 0건**, 파일도 없고 `kb-read-tcp.socket`도 설치되지 않았다. Unix 소켓은 토큰 없이 파일 권한이 인증이다 | **KB가 계속 발급한다.** 아래 |

**결정: 발급의 주인은 KB이고 KMS는 전달과 목록을 맡는다.** 이전 판의 identity JWT 안을 철회한다. 이미 구현이 있고, KB는 해시만 쥐므로 비밀 저장소가 되지 않으며, 읽기 API가 네트워크를 기다리면 안 된다는 KB의 제약과 맞다.

| 단계 | 내용 |
|---|---|
| 발급 | `kb token create`의 평문을 파이프로 `bao kv put sagae/<소비자>/kb-token value=-`에 넣는다. 화면, 전사, 원장을 지나지 않는다. KB 원장에는 비밀이 들어가면 안 된다 [출처: KB 세션] |
| 전달 | 소비자 쪽 agent가 렌더한다. T1 |
| 메타데이터 | `custom_metadata`에 범위, 소비자, 발급일, 만료일 |
| 만료 | KB에 만료 칸이 없다. **KB 저장소에 칸 추가를 제안한다.** 그때까지 KV 메타데이터가 교체 일정만 알린다. 강제는 아니다 |
| 폐기 | KB에서 해시 삭제가 진짜 폐기다. KV 항목도 지운다 |
| KMS 다운 | 검증은 로컬 해시라 영향 없음. 전달만 멈춘다 |

**기각.** identity JWT: 공개키 캐시와 KB 변경이 들고 소비자가 없다. KB가 평문을 보관: 해시로 충분하다. KMS가 토큰을 만들어 KB에 등록: 발급 주인이 둘이 된다. 소비자가 생기기 전에는 M6을 시작하지 않는다.

**OpenRouter.** 관리 키로 하위 키를 만들고 끄고 지우며 크레딧 한도를 줄 수 있다 [출처: OpenRouter Management API keys]. 하위 키의 만료는 문서에 없다. **지금은 서버 쪽 지출 한도가 없고 클라이언트의 일일 밸브뿐이다** [출처: KB 세션]. 침해된 코드는 밸브를 지나가지 않는다. 하위 키 한도는 같은 UID 문제와 무관하게 효과가 있는 드문 조치다. 관리 키는 T2다.

**교체 일정.** 현재 키는 2026-11-30에 만료된다(KB 설정). 새 키 결정은 2026-11-23쯤이다. **KMS를 기다리지 않는다.** 지금처럼 파일을 갱신한다. 그때 하위 키와 한도를 함께 정하는 것이 좋다(O14).

### 7.2 교체와 폐기

| 비밀 | 교체 | 주기 | 폐기 | 전파 |
|---|---|---|---|---|
| OpenRouter 키 | 사람이 공급자에서 만들고 `kv put` | 만료 또는 90일 [가정]. 다음은 2026-11-30 | `disabled: true` | agent 렌더, KB가 다음 호출에 파일을 읽는다 [가정] |
| KB API 토큰 | KB에서 새로 발급, `kv put` | 소비자가 생기면 정한다 | KB에서 해시 삭제 | agent 렌더 |
| 기타 공급자 키 | 공급자 화면 | 공급자 정책 | 공급자 화면 | 같음 |
| tower bearer | KMS에서 새 값 생성 | 사고 시 | 값 교체 | 파일 저장, tower 재시작 없이 반영 |
| PVE 읽기 토큰 | 사람이 PVE에서 재발급 | 사고 시 | PVE에서 삭제 | 호출마다 읽음 |
| PVE 쓰기 토큰 | 사람. 30일 만료 | 30일 | PVE에서 삭제 | `relief-act` 다음 잠금 해제 |
| restic 암호 | **`restic key add/remove`는 교체가 아니다.** 저장소 데이터 키는 그대로다. 옛 암호와 키 파일을 복사한 사람은 계속 푼다 [가정: restic 키 구조. 공식 페이지는 명시하지 않는다] | 사고 시 **새 저장소**: 8.1절 | 8.1절 | 다음 ship |
| SSH 인증서 | 자동 만료 | 기본 30 min, 최대 1 h | CA 철회 7.4절 | |
| `secret_id` | `kms service add --rotate` | 90일 | 엔티티 비활성 + 토큰 폐기 | agent 재시작 |
| 봉인 조각 | `operator rekey` | 사고 시 | 8.2절의 세대 규칙 | 복구 키트 교체 |

**자동 교체를 만들지 않는다.** 공급자마다 API가 다르고 대부분 사람 로그인이 필요하다. 대신 KV 메타데이터 `expires_at`을 하루 한 번 읽어 만료 14일 전에 알린다 [가정]. 기존 KB 예산 경고와 겹치지 않게 한다.

**`secret_id` 폐기는 접근을 끊지 않는다.** 이미 발급된 토큰은 살아 있다. 폐기는 세 단계다.

| 단계 | 조치 |
|---|---|
| 1 | 엔티티 비활성 또는 역할 삭제. 새 로그인을 막는다 |
| 2 | **발급된 토큰 폐기.** 토큰 접근자를 찾아 폐기한다. 구체 절차는 M1b에서 시험한다 [가정] |
| 3 | 놓친 토큰의 상한은 `token_max_ttl` 4 h다 |

**유출 사고 절차.** 1 위 표로 계정 폐기 2 영향 범위의 공급자 키를 공급자 쪽에서 폐기 3 감사 로그로 시점 확인 4 새 값 입력 5 `secret_id` 재발급. `kms service revoke`가 1~2를 한다. 외부 키는 **공급자 쪽 폐기만이 진짜 폐기다.** KMS에서 지워도 유출된 값은 산다. 잠금 창도 마찬가지다. T2 값이 창 안에서 복사되면 폐기나 만료까지 유효하다(`relief-v2.md` 3.8절, 교차 검토). KMS는 정적 토큰의 수명을 줄이지 못한다. 그래서 값을 쥐는 프로세스를 좁히고 수명을 줄인다.

### 7.3 감사

| 항목 | 결정 |
|---|---|
| 장치 | `file`을 VM 안에 하나, `syslog`나 `socket`을 둘째로 [출처: Audit 문서]. 하나만 두면 쓰기 실패 때 OpenBao가 요청에 답하지 않는다 |
| 기록 | 거의 모든 요청과 응답. 문자열은 HMAC-SHA256. `sys/unseal`, `sys/seal-status`, `sys/health`는 기록되지 않는다 [출처: Audit 문서] |
| 보존 | VM에서 회전, 일 1회 WSL로 복사 |
| 디스크 가득 참 | **KMS가 멈춘다.** 회전과 용량 경보가 필수다 |
| 활성화 | API로 켜려면 `unsafe_allow_api_audit_creation`이 필요하다. 설정 파일로 켠다 [출처: Audit 문서] |
| 한계 | 렌더된 파일을 읽는 행위는 기록되지 않는다. KMS 감사는 "agent가 언제 읽었나"까지다. **감사 로그는 노드 root에게 강하지 않다.** VM 디스크와 그 복사 경로가 그 권한 아래에 있다. M5 전에는 같은 UID가 그 권한을 가졌다 |

### 7.4 SSH CA

**CA 개인키를 훔치면 일반 수명과 무관하게 모든 노드의 root 인증서를 만든다.** 서명 정책은 정상 경로만 묶는다.

| 항목 | 결정 |
|---|---|
| 개인키 | KMS 안에서 생성, 내보내지 않는다. **KMS 침해 = CA 침해**로 본다 |
| 역할 `owner` | `allowed_users=node-admin`, `default_user=node-admin`, `ttl=30m`, `max_ttl=1h`, 사용자 인증서만, 호스트 인증서 금지, 전달 확장 없음 |
| 노드 | `TrustedUserCAKeys`와 `AuthorizedPrincipalsFile`. root 계정의 허용 주체는 `node-admin` 하나 [출처: `sshd_config(5)`] |
| 신뢰 범위 | 세 노드만. KMS VM과 ops VM은 믿지 않는다 |
| 개별 인증서 폐기 | `RevokedKeys`의 KRL. 파일은 원자적으로 교체한다 [출처: `sshd_config(5)`] |

**CA 철회 절차.** KMS 침해가 의심되면 수명을 기다리지 않는다. 1 비상 키나 콘솔로 노드마다 `TrustedUserCAKeys` 줄 제거, sshd 재시작 2 유효한 인증서가 거절되는지 노드마다 확인 3 새 CA 생성 후 재배포. 분기 훈련에 넣는다.

## 8. 백업과 복구

| 항목 | 결정 | 근거 |
|---|---|---|
| 스냅샷 | Raft 스냅샷을 VM 안 타이머로 하루 1회. 내용은 봉인 키가 있어야 풀린다 | [가정: 명령 문서 미확인, M1에서 시험] |
| 보관 | WSL로 당겨 C:에 복사하고, E:가 마운트돼 있을 때 E:에도. E:는 수동 마운트라 C:만 있는 날이 있다. C:는 같은 머신이다 | [출처: KB `restore.md:9`, KB 세션] |
| 추가 | PVE `vzdump`는 노드 `local`뿐이라 노드 고장에 함께 사라진다. 보조로만 둔다 | [측정] |
| 복구 시험 | 분기마다 대기 VM에 복원. 시험 안 한 백업은 없는 것으로 친다 | |

### 8.1 restic 저장소 교체

옛 암호가 유출됐다고 볼 때의 진짜 절차다. KB 저장소 변경이고 사용자와 KB 세션의 결정이다.

| 단계 | 내용 |
|---|---|
| 1 | 새 암호를 만들어 **복구 키트에 먼저** 넣는다 |
| 2 | 새 저장소 초기화. 데이터 키가 새로 생긴다 |
| 3 | 옛 저장소에서 복사한다. 옛 저장소는 유지 |
| 4 | **오프라인 복원 시험.** 키트의 새 암호만으로 다른 위치에 복원하고 내용을 검증한다 |
| 5 | C:와 E: 모두 끝난 뒤 옛 저장소 삭제 |

옛 암호로 로그인이 실패하는 것을 회복의 증거로 치지 않는다. 키 파일을 복사한 사람에게는 무의미하다.

### 8.2 조각과 스냅샷의 세대

`rekey` 뒤의 새 조각은 그 전 스냅샷을 풀지 못한다 [가정: 스냅샷은 당시 봉인 키를 쓴다. M1에서 시험]. 새 조각만 남기면 옛 스냅샷은 쓸모없고, 사용자는 그것을 복구 수단으로 믿고 있게 된다.

| 규칙 | 내용 |
|---|---|
| 세대 번호 | 조각과 스냅샷 파일 이름에 세대 G를 붙인다. 키트의 표에 "G: 조각 위치, 스냅샷 범위"를 적는다 |
| `rekey` 절차 | 직후 스냅샷을 찍는다 → 대기 VM에서 새 조각으로 복원 시험 → 통과한 뒤에만 옛 조각을 파기 |
| 옛 스냅샷 | 옛 조각과 함께 보존하거나 함께 삭제한다. 섞어 두지 않는다 |
| 복구 시험 | 분기마다 최신 세대로 |

**오프라인 복구 키트.** 값은 저장소, KB, 이 문서에 없다.

| 내용 | 위치 |
|---|---|
| 봉인 조각 A, B, C와 세대 표 | 4절, 8.2절 |
| Tailnet Lock 해제 비밀 | 암호 관리자 |
| Cloudflare 복구 코드 | 암호 관리자, 봉투 |
| KMS 사설 CA와 TLS 인증서 공개 부분, KMS VM 주소 | 저장소 밖 사본 |
| SSH 비상 키(암호 있음) | 암호 관리자, 봉투 |
| PVE `root@pam` 자격 | 사용자의 암호 관리자 |
| restic 암호 | 암호 관리자 |
| 절차서 사본 | 인쇄본 |

**재난 절차.**

| 사건 | 절차 | 목표 |
|---|---|---|
| VM 재부팅 | 조각 2개 입력 | 5 min |
| KMS 노드 고장 | 대기 VM 기동 → 스냅샷 복원 → 조각 입력 → agent 연결 대상 변경 | 30 min [가정] |
| VM 디스크 손상 | 위와 같다 | 30 min |
| WSL 소실 | KMS는 무사. WSL 재구성, `secret_id` 재발급, agent 설치 | 1 h |
| 조각 1개 분실 | 남은 2개로 `rekey`, 8.2절 | 1 h |
| 조각 2개 이상 분실 | **복구 불가.** 스냅샷도 못 푼다. 모든 비밀을 재발급, KMS 새로 구성 | 하루 |
| 클러스터 전체 고장 | 새 머신에 복원, 또는 T0 파일로 tower, KB만 재개 | 하루 |
| 사람 부재, 정전 | T0로 재개, T1 일부 꺼짐. 돌아와서 해제 | |

**재발급 가능성을 복구의 바닥으로 둔다.** 거의 모든 비밀은 공급자나 PVE에서 다시 만들 수 있다. 재발급이 불가능한 것은 restic 암호로 잠긴 과거 백업뿐이다. KB 복구는 이 암호의 디스크 밖 사본을 전제하는데 [출처: KB `restore.md`] **사용자가 아직 그 사본을 만들지 않았다.** KMS와 무관하게 지금 비어 있는 구멍이다(O13보다 먼저, O16). KMS를 이 백업에서 복원하면 순환이므로 KMS가 유일한 집이 되어서도 안 된다.

## 9. 이전 단계

**순서의 뜻.** K1은 KMS와 무관하게 먼저 한다. **K0은 사용자가 미뤘다.** 필수 선행으로 두지 않는다. 그 대가로 K0 전까지 WSL 같은 UID 코드는 노드 root로 KMS VM의 메모리와 디스크에 닿는다. 봉인 해제된 KMS는 그 코드에 경계가 아니다. **서비스 계정(M1b)이 새 키 이전(M2)보다 앞선다.** 계정 없이 넣으면 나중에 전부 옮겨야 한다.

**공통 규칙.**

- 한 번에 한 비밀. KB 관련 단계는 O15를 받은 뒤에만 한다.
- **값이 든 사본을 두지 않는다(R5).** 이전 판의 `.pre-kms`를 철회한다. 되돌리기는 KMS에서 다시 렌더하거나 사용자가 표준 입력으로 파일에 쓰는 것이다. KMS도 불가능하면 공급자에서 재발급한다.
- **모든 단계의 공통 검증(R7).** 새 로그인 셸에서 값이 비어 있어야 한다. 이름만 출력한다.

```sh
zsh -lc 'env' | cut -d= -f1 | grep -xE 'OPENROUTER_KEY|RESTIC_PASSWORD|PVE_API_TOKEN' ; test $? -eq 1
```

- 값 비교는 `global-drift-check`의 소금 친 해시를 쓴다. 평문 비교를 하지 않는다.
- M8에서 **이전에 평문이던 값은 교체한다.** 옛 값이 백업과 전사에 남아 있을 수 있다.

| 단계 | 내용 | 완료 기준 | 검증 명령 | 되돌리기 | 다른 저장소 |
|---|---|---|---|---|---|
| K0 root 키 | `id_ed25519`에 암호, 또는 하드웨어 키. 사람이 쓸 때만 `ssh-agent -t`. **서버 불필요** | 사람 없는 셸에서 노드 root 불가. 사람은 접속 가능. PVE API 도구는 그대로 | `env -u SSH_AUTH_SOCK ssh -o BatchMode=yes <노드> true; test $? -ne 0` | 키 복호화 | 없음. 에이전트의 노드 작업은 사람 승인이 된다 |
| K1 restic | 암호를 디스크 밖에 보관 | 키트에서 꺼낸 값으로 복원 시험 | 사용자가 `restic -r <대상> snapshots`로 확인 | 없음 | KB 세션 |
| M0 준비 | 결정표, 목록 확정, `.netrc`와 `.npmrc` 권한 확인 | 목록에 소유자가 있다 | `stat -c '%a' ~/.netrc ~/.npmrc` | 없음 | KB, setup 세션 목록 |
| M1 서버 | KMS VM, OpenBao, Raft, TLS, 감사, 초기화, 루트 폐기, 스냅샷, 대기 VM 복원 시험. **소비자 없음** | 재부팅 뒤 조각 2개로 해제. 대기 VM 복원 성공. 세대 표 기록 | `bao status -format=json \| jq -e '.sealed==false and .storage_type=="raft"'`, 대기 VM에서 같은 검사 | VM 삭제 | 없음 |
| M1b 서비스 계정 | `services.yaml`, `kms` 명령, 서비스별 AppRole, 정책, 엔티티, `owner`, `relief-writer`. **비밀 없음** | A 서비스 토큰으로 B 경로가 403. `owner` 없이 `kms`가 실패. 토큰이 4 h에 만료. 폐기 뒤 기존 토큰 거절 | `tools/kms/test/policy.sh` (각 쌍 403 확인), `bao token lookup` 의 `explicit_max_ttl` 확인 | 역할과 정책 삭제 | 없음 |
| G1 게이트 | **M2 전에 사용자에게 K0을 다시 묻는다.** 실제 운영 키가 KMS에 들어가기 전의 마지막 값싼 지점이다 | 답이 기록됐다 | 기록 확인 | 없음 | 없음 |
| M2 새 키, 첫 T1 | **새로 발급한 키 전부를 `kms key fill`로.** 서비스별 렌더. OpenRouter 하위 키. KB는 O15 뒤 | 서비스가 자기 키만 렌더받는다. KB 호출 성공. VM을 끄고 재시작해도 KB가 다른 경로로 동작 | `kms who <이름>`, `test -s ~/.config/sagae-kb/openrouter.key`, `systemctl --user is-active sagae-kms-agent@kb` | agent 중단, 링크 제거, 사용자가 표준 입력으로 파일 복원 | KB: 경로 변경 없음, watchdog이 링크를 받는지 |
| M3 T0-렌더 | tower bearer, PVE 읽기, restic 암호 | 렌더가 같은 값을 쓴다. 해시 비교로 판정. KMS를 봉인한 채 tower, proxmox, ship 정상 | `global-drift-check` 전후 비교, `tower status`, `node tools/relief/bin/relief.mjs check --live`, `kb ship --dry-run` | 템플릿 제거. 파일은 그대로 남아 즉시 복귀 | KB: `secrets.env` 렌더 형식 확인 |
| M4 에이전트 CLI | 필요한 API 키만 헬퍼로. Codex `shell_environment_policy`, `secret-guard` 경로 | 구독 로그인이 밀려나지 않는다 | `claude -p 'ping'`, `codex exec 'ping'`, 렌더 파일 읽기가 훅에 막히는지 확인 | 설정 되돌리기 | `~/.claude`, `~/.codex`, `secret-guard`(전역, 사용자 승인) |
| M5 SSH CA | 7.4절 정책, 노드에 `TrustedUserCAKeys`, 인증서 로그인, 비상 키 시험, CA 철회 훈련, 그 뒤 `id_ed25519` 공개키 제거 | 인증서 없이 root 접속 실패. `node-admin` 외 주체 거절. 1 h 넘는 서명 거절. CA 철회가 세 노드에서 동작 | `! ssh -o BatchMode=yes -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 <노드> true`, `ssh -i ~/.ssh/emergency <노드> true` | 공개키 복원. 콘솔 필요 가능 | 노드 설정, `infra/runner`, `relief_read` 키와 조정 |
| M6 KB 토큰 | `kb token create`를 파이프로 KV에, 소비자 렌더. KB에 만료 칸 제안 | 소비자가 생길 때만. 평문이 전사와 원장에 없다. KMS 다운에도 검증 | `kb` 시험, `grep -c kbt_ <전사 경로>` 가 0 | KB에서 해시 삭제, KV 항목 삭제 | KB 저장소 |
| M7 relief | `relief-v2.md` 8A절의 클라이언트 | 잠금 해제, KMS 다운 표시 | `npm test -w @sagae/relief -- kms` | KMS 설정 제거, 쓰기 꺼짐 | 없음 |
| M7b 화면과 메타 | `ui = true`, `console-writer`, `svc-relief-meta`, 요약 타이머 | 메타 계정으로 `data`가 403. 화면 계정으로 값을 읽지 못한다. 요약에 값이 없다 | `tools/kms/test/policy.sh`, `bao kv get` 이 두 계정에서 403 | 계정 삭제, UI 끔 | relief 3s |
| M8 교체 | 옮긴 값 전부 재발급 | 옛 값이 거절된다 | 공급자별 시험 호출, 공통 검증 | 없음. 새 값이 정본 | 공급자 |

- 단계 순서는 위험 순이다. 무암호 키의 위험은 K0이 닫고 사용자가 미뤘다. M5가 다른 길이다.
- `bao operator raft snapshot`과 `kb ship --dry-run`의 정확한 옵션은 구현 때 확인한다.

**저장소별 변경(소유자에게 전달).** 전역 파일과 다른 저장소는 사용자 승인 없이 바꾸지 않는다(R6).

| 저장소 | 변경 | 소유자 |
|---|---|---|
| `sagae-tools` | `tools/kms`: agent 설정, 템플릿, 정책 HCL, 유닛, 절차서, `sagae-secret` 얇은 헬퍼. 서버 코드 없음. 비밀 없음 | 이 저장소 |
| `sagae-knowloge-base` | `openrouter.key` 경로는 그대로. `RESTIC_PASSWORD_FILE` 전환 제안, watchdog의 권한 검사가 심볼릭 링크를 받는지 확인, `api-tokens` 만료 칸, KB 데이터 아래 Codex 홈의 백업 포함 여부 | KB 세션 |
| `sagae-claude-plugins` | 없음. `infra/runner` 토큰 경로만 검토 | 플러그인 소유자. `main` push는 배포다 |
| `sagae-setup` | 복구 키트 절차, agent 설치 절차 | 설정 세션 |
| 전역 | `secret-guard` 경로, `~/.codex/config.toml`, 필요 시 `~/.claude/settings.json` | 사용자 승인 |
| PVE | VM, 대기 VM, 방화벽, M5의 `sshd_config` | 사용자 |

## 10. 사용자 결정

| # | 결정 | 권장 | 다른 답의 결과 | 되돌리기 |
|---|---|---|---|---|
| O1 | 서버형 KMS로 갈 것인가 | 예. **서비스 계정 요구가 이유다.** 정적 키 보관만이면 `age`나 `sops`가 더 작고, 무암호 root 키 수리에도 서버는 필요 없다 | `sops` + `age`면 서버, 봉인이 없고 서비스 계정, 온라인 발급, 감사도 없다 | 쉬움 |
| O2 | 제품 | OpenBao. 다시 비교해도 유지(2절) | Infisical은 기계 신원 UI가 낫다. 필요한 감사, 역할, 버전이 유료 칸이고 Postgres, Redis가 는다 | M2 전이면 쉬움 |
| O3 | 봉인 | 수동 Shamir 2-of-3 | 클라우드 KMS는 무인 재시작이 되나 인터넷, 클라우드 계정이 는다. **키를 잃으면 백업도 못 푼다** | seal 이전은 중단이 필요 [출처: Seal 문서] |
| O4 | 위치 | KMS VM + ops VM, 각 대기 VM. 3.1절 | 한 VM이면 전화기 입구가 KMS 옆이다 | Raft 노드 추가는 쉬움 |
| O5 | 조각 보관 장소 3곳 | 암호 관리자, 금고, 다른 장소 | 같은 곳이면 2-of-3의 뜻이 없다 | `rekey` |
| O6 | T0-렌더 평문 파일 유지 | 유지. KMS 다운 시 시작이 요구사항이다 | 전부 tmpfs면 KMS 다운 재부팅 때 tower가 못 뜬다 | 쉬움 |
| O7 | 에이전트 CLI 로그인 제외 | 제외 | 포함하면 두 원본 | 쉬움 |
| O8 | 서비스별 계정 | **채택.** 이전 판의 "하나"를 철회. 실제 경계는 ops 서비스뿐이고 WSL은 라벨이다 | | 쉬움 |
| O9 | SSH CA로 인증서 로그인 (M5) | 진행. K0이 미뤄지면 M5가 사실상 그 수리다 | 안 하면 무암호 키가 남는다 | **잠금 위험.** 비상 키와 콘솔 시험 뒤 |
| O10 | KB 키 발급의 주인 | KB. KMS는 전달만 | KMS 발급이면 KB 변경과 공개키 캐시가 는다 | 쉬움 |
| O11 | OpenRouter 서버 쪽 한도 | 진행. 하위 키에 `limit` | 안 하면 유출 피해가 잔액 전체이고 클라이언트 밸브는 침해 코드를 막지 못한다 | 쉬움 |
| O12 | 소비자를 WSL 밖으로 옮기는 장기 방향 | 나중에 별도 설계 | 안 하면 6.3절이 영구 한계다 | |
| O13 | 이전 뒤 전면 교체 (M8) | 진행 | 안 하면 옛 값이 백업에 살아 있다 | 불가역 |
| O14 | OpenRouter 새 키 (2026-11-23쯤) | KMS를 기다리지 말고 지금 파일에. 그때 한도 설정 | 놓치면 11-30에 그 경로가 멈춘다 | 쉬움 |
| O15 | KB의 KMS 채택 | M2 전에 결정 | 거절하면 KB는 파일 그대로이고 KMS 소비자가 거의 없어진다 | 쉬움 |
| O16 | **restic 암호를 디스크 밖에 보관** | **KMS와 무관하게 오늘 한다** | 디스크를 잃으면 KB 백업을 복구할 수 없다 | 없음 |
| O17 | 실행 단위 토큰을 범위 밖으로 | 승인 | 넣으면 실행마다 쓰기가 생긴다 | 쉬움 |
| O18 | K0: 무암호 root 키 수리 | **사용자가 미룸(2026-11-01).** G1에서 다시 묻는다 | 그동안 VM 격리는 같은 UID 코드에 약하다. 에이전트의 노드 SSH는 그대로다 | 쉬움 |
| O19 | 새 키의 이름과 소비자 | 사용자가 `services.yaml`에 적는다 | | 쉬움 |
| O20 | OpenRouter 등 서비스별 하위 키 | 진행 | 키 하나를 나눠 쓰면 서비스 계정의 뜻이 없다 | 쉬움 |
| O21 | WSL interop 끄기 | 재본 뒤 결정 | 켜 두면 WSL 사용자 분리는 라벨이다. 끄면 Orca와 Windows 호출이 깨질 수 있다 | 쉬움 |
| O22 | Claude 샌드박스 `denyRead`, 탈출 끔 | 권장. 전역 변경 | 안 하면 공유 UID 파일이 Bash에 보인다 | 쉬움 |
| O23 | 재발급 불가 항목의 새 저장소 절차 | 사고 때만 | | |
| O24 | relief의 KMS 접근 | 메타데이터만, 관리는 UI 링크, 값 보기 없음. `relief-v2.md` 8D절 | 값 보기를 열면 전화기가 닿는 화면에 비밀이 지나간다 | 쉬움 |
| O25 | KMS 이름 | 라우트 없음. `kms.sys.internal.example`로 `*.internal.example` 와일드카드 밖에 두고(두 단계) 사설 CA, 데스크톱만, 그 아래 CAA 발급 금지. ops가 평문을 보지 않고 ops 침해가 KMS 화면을 사칭하지 못한다 | | 쉬움 |
| O26 | KMS 서버를 지금 만들 것인가 | **정해짐: 전체 트랙**(`relief-v2.md` O39) | | 쉬움 |
| O27 | 세 노드 상시 가동 | **정해짐: 모든 노드를 켠다**(2026-11-01) | | 쉬움 |

**되돌리기 어려운 일.**

| 일 | 왜 | 대비 |
|---|---|---|
| `bao operator init` | 조각이 이때 한 번 나온다 | 사용자가 혼자 수행. 에이전트가 보지 않는다 |
| 조각 2개 이상 분실 | 스냅샷까지 복구 불가 | 3곳 분산, 분기 시험 |
| 루트 토큰 폐기 | 조각 없이는 되돌릴 수 없다 | 시험 뒤 |
| restic 새 저장소 | 옛 저장소 삭제 뒤 돌릴 수 없다 | 8.1절의 복원 시험 뒤에만 |
| `rekey` 뒤 옛 조각 파기 | 옛 스냅샷이 풀리지 않는다 | 8.2절 |
| CA 신뢰 배포 | 이후 KMS 침해가 노드 root가 된다 | 7.4절의 철회 훈련 |
| 봉인 방식 전환 | 중단, 이전 절차 필요 [출처: Seal 문서] | 처음에 정한다 |
| M5 공개키 제거 | 노드 잠김 위험 | 콘솔 확인 뒤 한 노드씩 |
| M8 옛 값 폐기 | 옛 값 복귀 불가 | 새 값 시험 뒤 |
| 평문 비밀 삭제 | 사본을 두지 않는다(R5) | KMS 렌더를 확인한 뒤. 재발급이 마지막 길이다 |

## 11. 비용과 한계

| 항목 | 값 |
|---|---|
| 런타임 | KMS VM, ops VM, 멈춘 대기 VM 둘. 3.1절 |
| WSL | 서비스별 agent 데몬(`sagae-kms-agent@`) |
| 코드 | 서버 코드 없음. `kms` 명령, 템플릿, 정책 생성 약 500줄 [가정] |
| 사람 | 초기 구성 1일, 월 1시간, 재부팅마다 5 min, 분기 복구 시험 1시간 [가정] |
| 새 공격면 | LAN의 8200 포트, OpenBao 자체, WSL `secret_id`(서비스별로 나뉘지만 공유 UID에서 모두 보인다) |

**솔직한 평가.** 비밀 격리만 보면 WSL 쪽에서 이 서버의 값어치는 작다. 값어치는 서비스 계정, 한 단계 키 등록과 교체, 호스트 밖 감사, ops VM의 실제 격리다. 이 요구가 사라지면 `sops`와 `age`로 돌아가는 편이 낫다.

| 구분 | 내용 |
|---|---|
| 세션 입력 | setup 세션(`consumers.md`, `apply.md`의 요약), KB 세션(커밋 7699760). 리드를 거쳐 받았다 |
| 측정 | 노드별 CPU, 메모리, 디스크, 가동 시간, 저장소 구성(공유 없음, `lvmthin`), HA 그룹 없음, 파일 권한, 환경 변수 이름, tower 업스트림과 `${VAR}` 없음, 유닛 목록, 설치된 도구, GitHub 메타데이터 |
| 출처 | OpenBao Seal, static seal, Agent, AppRole, Audit, identity token, SSH, Persistent caching, mlock RFC, Vault LICENSE, Infisical LICENSE와 Requirements, systemd CREDENTIALS, Claude Code Authentication과 MCP, Codex 설정, OpenRouter Management API, PVE HA, 저장소 문서 |
| 검색만 | OpenBao 포크 이력, 2.6~2.7의 플러그인 이전, CVE-2025-55003, 홈랩 transit 사례, Infisical 무료 범위 |
| 교차 검토 | Codex 2회. 이 문서의 1회 지적 6건을 반영했다(재현 없이 읽기 기반). 6절, 6.8절, 3.1절의 3차 검토 지적(쿼럼, 프록시, Caddy, 이름 독립)을 반영했다. **이 반영분과 deSEC, Cloudflare 항목은 검토받지 않았다** |
| 재지 않음 | OpenBao를 실제로 돌려 보지 않았다. 템플릿 원자 교체, KMS 다운 시 agent의 파일 유지, Raft 스냅샷 명령, 메모리 사용, 심볼릭 링크와 KB watchdog, restic 환경 변수, `amd-sev`, TPM 유무, 세션 목록의 전수성. 세션 입력은 재확인하지 않았다 |

이 문서를 쓰며 비밀 값을 읽지 않았고, 설치, 생성, 시스템 변경을 하지 않았다. `secret-guard`가 막은 호출은 우회하지 않았다.

## 출처

| 출처 | 판 또는 날짜 |
|---|---|
| [OpenBao](https://github.com/openbao/openbao), [Vault](https://github.com/hashicorp/vault), [Infisical](https://github.com/Infisical/infisical), [sops](https://github.com/getsops/sops), [age](https://github.com/FiloSottile/age), [Vaultwarden](https://github.com/dani-garcia/vaultwarden), [Conjur](https://github.com/cyberark/conjur), [step-ca](https://github.com/smallstep/certificates), [SPIRE](https://github.com/spiffe/spire) | `gh api`, 2026-11-01 |
| [OpenBao Seal](https://openbao.org/docs/concepts/seal/), [static seal](https://openbao.org/docs/configuration/seal/static/) | 2026-11-01 조회 |
| [OpenBao Agent](https://openbao.org/docs/agent-and-proxy/agent/), [Persistent caching](https://openbao.org/docs/agent-and-proxy/agent/caching/persistent-caches/) | 2026-11-01 조회 |
| [AppRole](https://openbao.org/docs/auth/approle/), [Login MFA](https://openbao.org/docs/auth/login-mfa/), [Audit](https://openbao.org/docs/audit/) | 2026-11-01 조회 |
| [Identity tokens](https://openbao.org/docs/secrets/identity/identity-token/), [Signed SSH](https://openbao.org/docs/secrets/ssh/signed-ssh-certificates/), [Raft](https://openbao.org/docs/configuration/storage/raft/) | 2026-11-01 조회 |
| [mlock removal RFC](https://openbao.org/community/rfcs/mlock-removal/), 릴리스 노트 [2.2](https://openbao.org/community/release-notes/2-2-0/), [2.4](https://openbao.org/community/release-notes/2-4-0/), [2.6](https://openbao.org/community/release-notes/2-6-0/) | 2.4는 2025-08-28 |
| [CVE-2025-55003](https://osv.dev/vulnerability/CVE-2025-55003) | 2차 자료 |
| [Vault LICENSE](https://raw.githubusercontent.com/hashicorp/vault/main/LICENSE) | BUSL 1.1 |
| [Infisical Requirements](https://infisical.com/docs/self-hosting/configuration/requirements), [요금표](https://infisical.com/pricing), [Machine identities](https://infisical.com/docs/documentation/platform/identities/machine-identities), [환경 변수](https://infisical.com/docs/self-hosting/configuration/envars) | 2026-11-01 조회 |
| [OpenBao UI](https://openbao.org/docs/configuration/ui/) | 2026-11-01 조회 |
| [Response wrapping](https://openbao.org/docs/concepts/response-wrapping/), [Tokens](https://openbao.org/docs/concepts/tokens/) | 2026-11-01 조회 |
| [Claude Code Sandboxing](https://code.claude.com/docs/en/sandboxing), [sshd_config(5)](https://man.openbsd.org/sshd_config.5), [restic Encryption](https://restic.readthedocs.io/en/stable/070_encryption.html), [Cluster Manager](https://pve.proxmox.com/wiki/Cluster_Manager) | 2026-11-01 조회 |
| [OpenBao vs Vault](https://jorijn.com/en/blog/hashicorp-vault-vs-openbao/), [홈랩 OpenBao 저장소](https://gitea.famfi.dyndns.org/lutz/OpenBAO), [HashiCorp 포럼](https://discuss.hashicorp.com/t/configuring-ha-and-autoseal-on-premises-only/33758) | 2차 자료, 일화 |
| [systemd Credentials](https://systemd.io/CREDENTIALS/) | 2026-11-01 조회, 이 머신 systemd 259 |
| [Claude Code Authentication](https://code.claude.com/docs/en/authentication), [MCP](https://code.claude.com/docs/en/mcp) | 2026-11-01 조회 |
| [Codex 설정 참조](https://learn.chatgpt.com/docs/config-file/config-reference) | 2026-11-01 조회 |
| [OpenRouter Management API keys](https://openrouter.ai/docs/guides/overview/auth/management-api-keys) | 2026-11-01 조회 |
| [PVE High Availability](https://pve.proxmox.com/wiki/High_Availability), [API 스키마](https://pve.proxmox.com/pve-docs/api-viewer/apidoc.js) | 2026-11-01 조회, 2026-09-24 판 |
| 저장소: `tower.md`, `relief.md`, `relief-v2.md`, KB `0002-user-decisions.md`, `proposal-retrieval.md`, `restore.md`, `ship.py`, 플러그인 `pve.mjs`, `provision.sh`, `tower-auth.sh` | 작업 트리 2026-11-01 |
