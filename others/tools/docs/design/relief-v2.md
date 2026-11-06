# relief v2 설계: 쓰기, PVE 화면, 터미널, 상태 조회

- 상태: 설계안. 코드는 없다. 사용자 승인 전에는 쓰기, 터미널 코드를 시작하지 않는다. 기준일 2026-11-01.
- 대상: 읽기 전용 지도 relief를 관리 도구로 넓히는 일. VM 시작과 중지, Proxmox 화면 연결, 내장 SSH 터미널, 패키지 갱신 현황, BMC 하드웨어 상태, 그리고 이것들이 쓰는 비밀의 관리. 뒤에 모바일 접근(8B절), 전원 켜기(8C절), KMS 접근(8D절), 이름 라우팅(8E절), 도메인과 메일(8F절)이 더해졌다.
- 관계: `docs/design/relief.md`를 대체하지 않고 이어 쓴다. 그 문서의 1절 "쓰기"와 "웹 터미널" 비목표, 6.3절의 쓰기 금지 범위, 7.1절의 복사 전용 SSH, 16절 D2, 19절의 배치 규칙은 이 문서가 승인되면 바뀐다(12절).
- 사용자 결정(2026-11-01): 쓰기를 원한다. 예전의 복사 전용 SSH 결정은 "웹 엔진 안의 SSH" 요청으로 대체한다. 그 위험은 7절에 그대로 적는다.

| 표기 | 뜻 |
|---|---|
| [측정] | 2026-11-01 이 머신이나 클러스터에서 잰 값. 브라우저 값은 헤드리스 Chromium 156(Linux)이고 Windows Chrome이 아니다 |
| [출처] | 표기한 문서나 소스를 읽었다. 조회일은 2026-11-01이다 |
| [검색] | 검색 요약이나 2차 자료만 봤다. 1차 자료로 확인하지 못했다 |
| [가정] | 재지 않은 판단 |
| 표기 없음 | 이 문서의 제안 |

## 0. 결론

**사용자는 전체 트랙을 골랐다(O39, 2026-11-01).** 실행 순서는 9.1절이다. 아래 비교는 그 결정의 근거로 남긴다. 이 문서 전체는 한 사람의 홈랩에 많다는 교차 검토의 평가와 그 비용은 그대로다.

| | **최소 트랙** | **전체 트랙** |
|---|---|---|
| 얻는 것 | 전화기에서 지도 읽기, 전화기로 PC 깨우기, 인증, 깨끗해진 root 키 | 쓰기, 터미널, 서비스 계정, 내부 도메인, KMS |
| 입구 | Tailscale `serve`, `*.ts.net` | `gate`, `*.internal.example` |
| 새 VM | ops 1 | ops, KMS 2 + 대기 2 |
| 구축 [가정] | 사람 약 1일 | 사람 1~2주, 에이전트 작업 별도 |
| 운영 [가정] | 월 30 min | 월 3 h, 재부팅마다 봉인 해제, 분기 복구 훈련 |
| 새 의존성 | Tailscale | Tailscale, OpenBao, Caddy, `lego`, DNS 서버, deSEC, 패스키 라이브러리, node-pty, `ws`, xterm |
| 주요 위험 | 낮다. 읽기와 깨우기뿐이고 PVE 쓰기 자격이 없다 | 봉인, 복구, 조각 분실, 노드 고장 절차가 사람에게 온다 |
| 되돌리기 | VM 삭제 | 복구 키트, CA 신뢰, RP ID가 남는다 |

**사용자가 말한 요구와 최소 트랙.**

| 요구 | 최소 트랙에서 | 가장 작은 추가 |
|---|---|---|
| 모바일 | **충족.** 읽기와 PC 깨우기 | |
| 쓰기 | **미충족** | `relief-act` + `relief-act` 사용자만 읽는 토큰 파일 + 풀 ACL. KMS 없이 된다. 3k, 4a |
| 서비스별 계정 | **부분.** ops의 Unix 사용자 분리와 OpenRouter 하위 키로 실제 경계는 생긴다. 한 단계 키 등록, 중앙 목록, 감사는 없다 | `sops`나 `age` 파일. 완전한 충족은 KMS(`kms.md` M1, M1b)뿐이다 |
| `*.internal.example` | **미충족.** `*.ts.net`을 쓴다. 산 도메인은 놀게 된다 | Caddy와 수동 또는 자동 인증서. 이름을 바꾸면 패스키 재등록이 든다. 최소 트랙은 암호라 영향이 작다 |

**트랙별 단계.** 번호는 9절의 표다. 앞의 둘은 트랙과 무관하게 한다.

| 순서 | 단계 | 최소 | 전체 |
|---|---|---|---|
| 1 | `kms.md` K1 restic. K0 root 키는 **사용자가 미뤘다**(9.1절) | 한다 | 한다 |
| 2 | 0 PVE 링크 아웃 | 한다 | 한다 |
| 3 | 1 인증(암호, 쿠키 없는 세션) | 한다 | 한다 |
| 4 | 3r ops 이전 | 한다. 서비스별 Unix 사용자까지 | 한다 |
| 5 | 3o 원격 공개 | `serve` 경로, Tailscale ACL, 읽기 전용. Phase 1의 인증 뒤에 | `gate` 경로, 패스키 뒤에 |
| 6 | 3w PC 깨우기 | 한다 | 한다 |
| 7 | 2 패키지, 3 BMC | 선택 | 한다 |
| | 3n 이름, 3m 패스키 | 없음 | 한다 |
| | 3k, 4a, 4b 쓰기 | 없음. 요구가 남아 있으므로 다음 후보 | 한다 |
| | 6 터미널 | 없음 | 한다 |
| | 8 기기 쓰기, 노드 깨우기, SSH CA, KMS 관리 화면 | **미룬다** | 뒤로 |
| | `kms.md` M1~M8 | 없음 | 한다 |

**검토 때의 권장은 최소 트랙이었다.** 막다른 길이 없다. 전체 트랙의 앞 여섯 단계와 같고 다른 것은 입구뿐이다. 쓰다가 부족한 요구부터 더한다. 다만 **이것은 사용자가 말한 요구 넷 중 하나만 채운다.** 쓰기가 가장 먼저 필요하면 3k와 4a를 바로 잇는다.

**가장 중요한 사실 넷.** 넷째는 모바일 요구로 생겼다. **원격 공개는 relief의 위협 모델을 바꾼다.** 아래 1, 2번과 1절의 표는 127.0.0.1 전제로 쓴 것이고 8B절 이후에는 오버레이가 더해진다.

1. **경계는 relief가 아니라 PVE ACL이다.** Windows 같은 사용자는 경계 밖이고 [출처: `tower.md:421`] WSL 같은 UID도 파일을 다 읽는다. relief 로그인은 브라우저 경로만 막는다. 쓰기의 피해 상한은 PVE 쪽 토큰 범위가 정한다.
2. **같은 UID는 이미 세 노드의 root다.** 이 작업이 쓴 SSH 별칭 세 개는 `user root`이고, 에이전트 없는 셸에서 `BatchMode`로 로그인됐다 [측정]. 그러므로 v2가 새로 여는 것은 "같은 UID의 권한"이 아니라 **브라우저에서 닿는 쓰기 경로**다. 설계의 비용은 대부분 거기에 쓴다. 비밀번호 없는 root 키는 v2와 무관하게 남은 가장 큰 구멍이다(11절 O10).
3. **MCP 쓰기 도구는 만들면 안 된다.** proxmox 업스트림은 `autoApprove: ["*"]`이고 [출처: `tower.md:120`] 도구는 30 s 안에 목록에 오른다 [출처: `tower.md:264`]. `proxmox_vm_stop`을 더하면 그 순간 모든 Claude 세션이 확인 없이 VM을 끌 수 있다.

| 항목 | 결정 | 기각 |
|---|---|---|
| 1 위협 모델 | 막는 대상은 악성 웹 페이지, 침해된 게스트의 문자열, 다른 UID와 host network 컨테이너. Windows 같은 사용자와 같은 UID는 PVE ACL로 피해 상한만 둔다 | "로그인으로 같은 UID를 막는다" |
| 2 인증 | 로컬 암호 로그인, **쿠키 없는** 출처 고정 세션(`sessionStorage` + `Authorization`), 정확한 Origin, 사전 계획 ID, 단계별 재확인, 감사 로그. 읽기 `/api/*`도 세션 뒤로 옮긴다 | 세션 쿠키, 무인증 + Origin만, WebAuthn, TOTP, mTLS, PAM |
| 3 쓰기 | npm 없는 별도 프로세스 `relief-act`가 PVE REST를 직접 부른다. 새 토큰, 새 역할(`VM.PowerMgmt`, `VM.Audit`), 풀 하나, 수명 30일. 처음 동작은 시작, 종료, 재부팅. tower와 플러그인 변경 없음 | MCP 쓰기 도구, 별도 쓰기 MCP, 기존 토큰 승격, relief 서버 안의 토큰 |
| 4 웹 엔진 | **링크 아웃.** 내장의 유일한 출구는 Electron | 파이프 프록시와 iframe(철회), 동일 출처 프록시, 직접 iframe, 자격 주입 프록시, Tauri |
| 5 SSH | xterm.js + `ws` + node-pty로 고정 인자의 `/usr/bin/ssh` 실행. 키는 relief가 보지 않는다. 처음엔 게스트만, 노드 root는 별도 결정 | ssh2, ttyd, WeTTY, PVE termproxy |
| 6 패키지 | 노드는 `/nodes/{n}/apt/versions`(기존 권한)와 SSH 강제 명령 `apt list --upgradable`. 적용 버튼은 만들지 않는다 | `Sys.Modify` 부여, 게스트 agent exec, 노드 업그레이드 버튼 |
| 7 BMC | 노드 안에서 `/dev/ipmi0`를 읽는 SSH 강제 명령. BMC 자격과 BMC 네트워크를 쓰지 않는다. Redfish는 펌웨어 확인 뒤 다시 본다 | Redfish 지금 도입, IPMI over LAN, BMC 전원 제어 |
| 8 순서 | 인증 → 읽기 상태 → VM 이전 → 패스키 → 원격 공개 → 쓰기 → 터미널. 9절 | 쓰기 먼저 |
| 9 키 관리 | sagae 전체는 `docs/design/kms.md`의 KMS가 맡고 relief는 클라이언트다. 쓰기 토큰은 사람 로그인 뒤에만 나온다. KMS가 없어도 relief는 시작하고 읽는다. SSH 키는 relief 밖. 8A절 | relief 내장 KMS, `age` 런타임 대체, agent 전달, 감사 서명 키 |
| 10 모바일 | relief를 전용 VM으로 옮기고 Tailscale `serve`로만 연다. 공개 포트 0. 패스키, 기기별 폐기, 처음엔 읽기와 깨우기만. 8B절 | 공개 프록시, Cloudflare Tunnel, LAN만, WSL 상주, 전화기 터미널 |
| 11 전원 켜기 | relief VM의 매직 패킷. 노드가 전부 꺼지면 상시 장치나 집 안 경로뿐이다. 8C절 | PVE `wakeonlan`(`Sys.PowerMgmt`), 스마트 플러그, BMC는 나중 |
| 12 KMS 접근 | 상태는 relief에서, 관리는 KMS 화면으로, 값 보기는 없다. relief는 메타 전용 계정. 8D절 | relief 관리 계정, 브라우저 직결, 관리 화면 재구현 |
| 13 이름 | 안쪽 전용 도메인 `internal.example`, 분할 DNS, Caddy, 범위 좁힌 DNS-01, 새 도구 `gate`. 공개 서비스는 다른 도메인, 별도 호스트. 8E절 | 공개 포워딩, `*.int`, `.internal`, 내부 CA, 상위 도메인 쿠키 |

**만들지 말 것.** 노드 전원(`Sys.PowerMgmt`), 노드 패키지 적용, 게스트 agent exec, BMC 전원과 Redfish 쓰기, MCP 쓰기 도구, PVE 프록시, tower 마운트(`/relief`), 라우터 암호 저장, 감사 서명 키.

```text
Chrome 전용 창
  http://127.0.0.1:4815  ── Authorization 헤더 ──> relief (WSL, npm 있음, 쓰기 경로 없음)
    ├ 지도, 패널, 상태                             ├ 읽기: tower /mcp + bearer → proxmox MCP → PVE (PVEAuditor, 변경 없음)
    ├ xterm.js ── WebSocket ──────────────────────> relief-term: node-pty → /usr/bin/ssh (키는 ssh가 쥔다)
    └ "PVE 열기" → 별도 앱 창 → PVE :8006            └ 노드 읽기: ssh 강제 명령 키 → ipmitool, apt list
  http://127.0.0.1:4819  (별도 창)   ──────────────> relief-act (npm 없음)
    사실 확인, KMS 로그인                             └ 쓰기: PVE REST (새 토큰, 풀 범위, 메모리에만)
```

## 1. 위협 모델

### 1.1 누가 relief에 닿는가

| 주체 | 오늘 닿는 것 | 쓰기가 생기면 | 막는가 |
|---|---|---|---|
| Windows 같은 사용자 프로세스 | 127.0.0.1, `\\wsl.localhost` 파일, `wsl -u root` [출처: `tower.md:421`] | 토큰 파일과 프로세스를 그대로 읽는다 | 못 막는다. 피해 상한은 PVE ACL, 사후 추적은 PVE 태스크 로그 |
| WSL 같은 UID(Claude 세션, Bash, npm 스크립트) | `~/.config`, SSH 별칭으로 노드 root [측정] | 위와 같고 이미 그 이상을 가졌다 | 못 막는다. 11절 O10이 근본 조치 |
| WSL 다른 UID, host network 컨테이너 | 무인증 `/api/*` [출처: `relief.md:729`] | 로그인이 없으면 쓰기까지 | **막는다.** 세션 |
| 악성 웹 페이지(일반 브라우저) | Origin과 Fetch Metadata에 막힌다 | CSRF, WebSocket 탈취 시도 | **막는다.** 2절 |
| 다른 로컬 포트의 페이지(loupe, 개발 서버, 악성 패키지의 서버) | `guard.ts:12`가 포트와 스킴을 보지 않아 **통과한다** | relief에는 쓰기가 없다. 세션은 그 출처의 저장소에만 있어 받지 못한다 | **막는다.** 정확한 Origin, 쿠키 없음 |
| 침해된 게스트 | 게스트 이름, 태그, agent 값, SSH 출력 | 화면과 터미널에 악성 문자열 | **막는다.** 값은 데이터다 |
| 침해된 PVE UI(저장형 XSS) | 없음 | relief와 별도 창, 별도 호스트라 닿지 않는다 | **막는다.** 프록시를 두지 않는다 |
| LAN의 다른 기기 | 127.0.0.1 바인딩이라 못 닿는다. eth0은 LAN 주소이므로 바인딩을 넓히면 안 된다 [출처: `CLAUDE.md`] | 같다. VM에서도 LAN에 바인딩하지 않는다 | 유지 |
| 오버레이의 내 기기 (8B절 뒤) | Serve 포트 | 패스키 없이는 정적 화면뿐 | **막는다.** 패스키 |
| Tailscale 계정 탈취 | 통로에 기기 추가 | 패스키가 없어 relief에 못 들어온다 | **막는다.** Tailnet Lock이 기기 추가도 막는다 |
| Tailscale 제어 평면 침해 | 기기 키 배포 조작 | 같다 | **줄인다.** Tailnet Lock [출처] |
| 인터넷 전체 | 없음 | **없음.** 공개 포트 0, Funnel 끔 | 유지 |

Chrome은 공개 사이트가 loopback에 fetch나 WebSocket을 열 때 권한 프롬프트를 낸다 [출처: developer.chrome.com, Local Network Access, 2026-11-01 조회]. 다만 사용자가 허용할 수 있고 loopback 출처끼리는 해당하지 않아 경계로 세지 않는다.

### 1.2 쓰기가 생긴 뒤의 공격

| 공격 | 할 수 있는 일 | 막는 것 | 남는 위험 |
|---|---|---|---|
| 악성 페이지가 폼 POST | VM 중지 시도 | 정확한 Origin, 사용자 지정 헤더, JSON 전용, 일회용 계획 ID | 없음 [가정: 시험으로 강제] |
| 악성 페이지가 WebSocket 연결 | 터미널 탈취(CSWSH). WebSocket은 동일 출처 정책과 CORS 밖이다 [검색: Solita, CWE-1385] | 업그레이드 때 정확한 Origin, 세션, 10 s 일회용 티켓 | 없음 [가정: 시험으로 강제] |
| DNS 재바인딩 | Host를 속여 응답 읽기 | Host 정확 일치 | 없음 |
| 침해된 게스트의 값 | 이름에 HTML, 제어 문자, agent IP를 다른 호스트로 | 값은 표시만 한다. 대상은 `vmid`와 선언된 별칭뿐이고 SSH에 agent IP를 쓰지 않는다 | 사람이 속을 수 있다. 확인 창은 `vmid`를 함께 보인다 |
| 침해된 게스트의 터미널 출력 | 터미널 이스케이프로 클립보드, 링크, 제목 | OSC 52 애드온과 proposed API를 켜지 않는다(7절) | xterm.js 자체 결함 |
| PVE 저장형 XSS | 프레임 안에서 사용자의 PVE 세션으로 동작 | 막지 못한다. relief로 번지지 않게만 한다 | 사용자 PVE 권한 전체. 2025~2026년에 XSS 공고가 있었다 [검색: CVE-2025-57539, CVE-2025-57540, CVE-2026-51081] |
| 쓰기 토큰 도난 | 풀 안 게스트의 전원 전부(시작, 중지, 재설정, 일시 중지, `stopall`). **복사본은 잠가도 살아 있다** | PVE 풀 ACL, 수명 30일, 폐기 | 폐기나 만료 전까지 풀 안 게스트 정지 |
| tower bearer 도난 | `kb_put`, proxmox 읽기 [출처: `relief.md:252`]. 쓰기는 **아니다.** 쓰기를 MCP 뒤에 두지 않기 때문이다 | 3절 | 오늘과 같다 |
| relief 세션 도난 | 지도 읽기, 터미널 열기 요청. 쓰기는 **아니다** | 세션 값은 그 출처에서 명시적으로 보낼 때만 나간다 | 같은 출처의 스크립트 실행. CSP가 막는다 |
| npm 의존성 침해(relief 서버) | 읽기 값. 쓰기 토큰과 터미널 입력은 프로세스에 없다 | `relief-act`, `relief-term` 분리(3.8, 7.1절) | `act/` 파일 변조로 다음 시작 때 실행 |
| KMS `secret_id` 탈취 | T0, T1 읽기. 쓰기 토큰은 **아니다** | 쓰기 토큰은 사람 로그인 뒤에만 나온다 | 무인 비밀 전부 |
| 에이전트가 비밀 파일을 읽어 전사나 KB로 유출 | 값이 대화와 저장소에 남는다 | 쓰기 토큰은 암호문이다. 무인 비밀은 그대로 평문이다 | tower bearer, 읽기 토큰, `relief_read` |
| 같은 UID의 능동적 변조 | relief 소스를 고쳐 다음 로그인 때 암호를 가로챈다 | 막지 못한다(8A.6절) | 전부 |
| 잠금 풀린 전화기 분실 | 지도 읽기, 깨우기. 재고와 내부 주소가 화면에 보인다 | 세션 유휴 30 min, 기기 제거, 쓰기는 KMS 로그인, 터미널 금지 | 세션이 살아 있는 동안의 읽기 |
| 동기화 패스키 계정 탈취 | relief 로그인 | 공급자 계정의 2단계, 재확인, `device revoke` | 읽기와 깨우기. 쓰기는 KMS가 따로 막는다 |
| 깨우기 남용 | 기계를 켠다 | 대상당 속도 제한, `key`만 받음 | 전기와 소음 |

**쿠키는 포트를 가리지 않는다.** 그래서 세션에 쿠키를 쓰지 않는다(2.1절). 호스트 이름을 나눠도 같은 호스트의 다른 포트는 쿠키를 받는다. 이전 판의 `relief.localhost` 이동은 이 문제를 풀지 못했다.

**잠금 창은 피해 상한이 아니다.** 창은 `relief-act`를 통한 사용만 제한한다. 창이 열린 사이 복사된 토큰은 폐기나 만료까지 쓸 수 있다. 피해 상한은 토큰의 범위(풀)와 수명(30일)이다.

**결정.** 위 표의 "막는다"만 설계 목표로 삼고 나머지는 피해 상한과 기록으로 받는다. 쓰기 토큰은 KMS에 두지만(8A절) 이것을 경계로 세지 않는다. 같은 UID는 root SSH로 우회한다. O10을 끝내면 효과가 커진다. ptrace가 막혀 있어 메모리에 있는 토큰을 같은 UID가 조용히 읽지 못한다 [측정: 8A.3절].

## 2. 인증

### 2.1 결정

| 항목 | 값 | 근거 |
|---|---|---|
| 로그인 | Phase 1은 사람이 정한 암호 하나. VM 이전 뒤 패스키로 바꾸고 암호를 없앤다(8B.3절). 해시만 `~/.config/relief/auth.json`(mode 600). `relief passwd`가 TTY에서 받는다 | KMS 없이 로그인해야 한다(8A.3절) |
| 해시 | `node:crypto`의 argon2id. 새 의존성 없음. 매개변수는 구현 때 OWASP Password Storage Cheat Sheet로 정한다 | `crypto.argon2Sync`가 Node 26.13에 있다 [측정] |
| 세션 | 256비트 임의값. 서버 메모리에 해시만. 재시작하면 로그아웃. 유휴 30 min, 최대 12 h [가정] | 파일에 세션을 남기지 않는다 |
| 세션 전달 | **쿠키를 쓰지 않는다.** 로그인 응답 본문으로 받아 `sessionStorage`에 두고 `fetch`마다 `Authorization: Bearer`로 보낸다 | `sessionStorage`는 출처 단위라 포트까지 묶인다 [출처: HTML 표준]. 다른 포트의 서버는 아무것도 받지 못한다. 자동 전송이 없어 CSRF 표면이 사라진다 |
| 호스트 | `127.0.0.1:4815` 그대로 | 쿠키가 없으므로 호스트를 옮길 이유가 없다. `relief.localhost` 이동을 철회했다 |
| 잠금 | 실패 5회에 30 s, 이후 배로 [가정] | 로컬 무차별 대입 |
| 감사 | 3.6절 | |

**VM 이전 뒤의 값.** 이 절의 Host와 Origin은 Serve 주소로 바뀐다. 호스트 이름 하나, 정확 일치는 같다. 세션 전달 방식은 그대로다.

**CSRF와 Origin.** 쓰기 라우트(`relief-act`, 3.8절)는 아래를 모두 통과해야 한다. 터미널 열기도 같다. OWASP에서 Fetch Metadata의 지위가 심층 방어인지 주 방어인지 1차 자료로 확인하지 못했으므로 [검색] 하나에 기대지 않는다.

| 검사 | 규칙 |
|---|---|
| Host | `127.0.0.1:4819`(relief 서버는 `:4815`) 정확 일치 |
| Origin | `http://127.0.0.1:4819`(relief 서버는 `:4815`) 정확 일치. 없으면 거절 |
| Fetch Metadata | `sec-fetch-site`가 있으면 `same-origin`만 |
| 메서드, 형식 | POST, `application/json`, `X-Relief-Action: 1`. CORS 응답 헤더를 내지 않으므로 교차 출처는 사전 요청에서 끝난다 |
| 세션 | `Authorization` 헤더로 유효 |
| 계획 ID | 일회용, 60 s, 세션과 대상에 묶임(3.4절). 동기화 토큰 역할을 겸한다 |

**지금의 `guard.ts`는 쓰기에 쓸 수 없다.** 읽기 전용이라 문제가 없었을 뿐이다.

| 위치 | 문제 | 고침 |
|---|---|---|
| `guard.ts:12` | Origin의 스킴과 포트를 지우고 호스트 이름만 본다. `http://localhost:9999`가 통과한다 | 정확 일치 |
| `guard.ts:12` | Origin이 없으면 통과한다 | 쓰기는 거절 |
| `guard.ts:16` | `navigate`면 통과한다. tower는 `dest=document`까지 본다 [출처: `tower.md:404`]. 다른 로컬 포트의 폼 POST가 지나간다(코드 읽기, 재현하지 않음) | 쓰기는 `same-origin`만, 읽기는 `dest`까지 |

**읽기 라우트.** `/api/snapshot`, `/api/metrics`, `/api/status`도 Phase 1부터 세션 뒤로 옮긴다. 지금도 내부 주소와 재고가 무인증이고 [출처: `relief.md:729`], v2는 패키지 버전과 하드웨어 상태까지 더해 공격자에게 쓸모 있는 목록이 된다. 비용은 창을 열 때 로그인 한 번이다.

- `relief status`와 `check`는 HTTP를 쓰지 않거나, 없다면 GET 전용 로컬 파일 토큰을 쓴다. 다른 작업자가 상태 점검을 고치는 중이므로 합칠 때 맞춘다.
- `/relief` tower 마운트는 영구히 끈다. tower 프록시는 `authorization`을 지우고 GET, HEAD만 지나므로 [출처: `tower.md:410`, `tower.md:43`] 세션이 동작하지 않는다. R3을 "끔"으로 닫는다.
- 정적 HTML과 JS는 세션 없이 나간다. 값이 없기 때문이다. 데이터는 `/api/*`뿐이다.
- 포트 점유: 다른 UID가 relief가 꺼진 틈에 4815를 잡아 가짜 로그인을 낼 수 있다. systemd 소켓이 포트를 계속 쥐어 막는다 [출처: `relief.md:718`]. 소켓 유닛을 쓰지 않으면 이 방어가 없다.

### 2.2 동작별 재확인

| 단계 | 대상 | 요구 |
|---|---|---|
| L0 | 읽기, 지도 | 세션 |
| L1 | 시작 | 세션 + 계획 확인 창. 쓰기 잠금 해제 창 밖이면 KMS 로그인(8A.2절) |
| L2 | 종료, 재부팅, 터미널(게스트) | L1 + 최근 5 min 안의 암호 재입력. 터미널은 SSH 키 암호가 이를 겸한다(8A.5절) |
| L3 | 강제 중지, 재설정, 터미널(노드) | 매번 암호 + 게스트 이름이나 호스트 별칭을 직접 입력 |

### 2.3 기각

| 후보 | 이유 | 근거 |
|---|---|---|
| 세션 쿠키(`HttpOnly`, `SameSite=Strict`, `__Host-`) | 쿠키는 포트로 격리되지 않아 같은 호스트의 다른 포트 서버가 받는다. 위 속성들은 받는 서버를 막지 못한다 | 13절 교차 검토, RFC 6265 |
| 무인증 + Origin 검사만 | 브라우저 밖 클라이언트는 Origin을 지어낸다. 다른 UID와 host network 컨테이너가 쓰기를 부른다 | 1.1절 |
| WebAuthn(Windows Hello) | **Phase 1에서만 기각.** 8B.3절이 뒤집었다. 재확인 품질은 가장 좋다. 하드웨어에 묶인 루트 키 후보이기도 하다. 그러나 `@simplewebauthn/server` 14.0.3은 직접 의존성이 10개다 [측정: `npm view`]. 지키는 문이 relief뿐이고 같은 UID는 토큰을 바로 읽으므로 지금 값어치를 못 한다 | O10 뒤에 다시 본다 |
| TOTP | 비밀이 같은 디스크에 있고 시계 동기화까지 는다. `otplib` 13.6.0 | 같은 UID가 복제한다 |
| 클라이언트 인증서, loopback TLS | 인증서 관리가 사용자 몫으로 늘고 같은 UID에 경계가 아니다 | |
| PAM, OS 계정 | WSL 안 비밀번호 체계에 묶이고 네이티브 모듈이 필요하다 | |
| 세션 없이 tower bearer 재사용 | 브라우저로 토큰을 내리면 안 된다 [출처: `tower.md:405`] | |

## 3. 쓰기 경로

### 3.1 어디에 권한을 두는가

| 기준 | A 기존 proxmox MCP에 쓰기 도구 | B 별도 쓰기 MCP를 tower 뒤에 | **C `relief-act`가 PVE REST 직접 (채택)** | D 별도 UID 액추에이터 |
|---|---|---|---|---|
| 권한 위치 | 공유 토큰을 승격 | 새 토큰, 서버 프로세스 | 새 토큰, relief | 새 토큰, 다른 UID |
| bearer로 쓰기 가능 | **예.** `tools/call`은 이름만 본다 [출처: `relief.md:252`] | **예.** 토큰별 범위가 없다 [출처: `tower.md:77`] | 아니오 | 아니오 |
| Claude 세션 노출 | **자동 승인.** `autoApprove: ["*"]` | 호출마다 확인. 지키는 것은 Claude Code뿐이고 bypass와 Bash는 지나간다 [출처: `tower.md:265`] | 없음 | 없음 |
| 플러그인 변경 | `pve.mjs:102,229`의 GET 고정과 `tools.mjs:70`의 `readOnlyHint`를 깬다. `main` push는 배포다 | 새 서버, 새 플러그인 | 없음 | 없음 |
| tower 장애 시 | 쓰기도 멈춤 | 쓰기도 멈춤 | 영향 없음 | 영향 없음 |
| 기록 | 인자가 로그에 없다 [출처: `tower.md:452`] | 같음 | relief 감사 + PVE 태스크 | 같음 |
| 같은 UID 방어 | 없음 | 없음 | 없음 | 토큰은 지키나 root SSH가 남아 무의미 |
| 비용 | 약 150줄, 외부 저장소 | 약 300줄, 외부 저장소 | 약 300줄 | C + 시스템 유닛, 소켓, root 설치 |

**판정: C.** `relief.md` 19절의 "자격이 필요하면 tower 뒤"는 읽기 출처용 규칙이다. 쓰기 자격을 공유 bearer 뒤에 두면 bearer의 뜻이 "읽기와 KB"에서 "VM 정지"로 바뀐다. relief의 MCP 경로는 그대로 읽기 전용이다. `allowlist.ts`, `mcp.ts`, `relief.md` 12절의 쓰기 금지 시험을 고치지 않는다. 대가는 D2("전용 PVE 토큰을 만들지 않는다")의 예외이며 사용자 결정이 필요하다(O1). D2의 이유였던 "PVE 클라이언트 복제"는 쓰기 전용 약 40줄로 제한된다.

**기각: 기존 토큰 승격.** tower 토큰은 `PVEAuditor`이고 `/`에 감사 권한만 있다 [측정: `/access/permissions`]. 승격하면 모든 세션과 플러그인이 쓰기 권한을 공유한다.

### 3.2 동작과 권한

경로는 PVE API 스키마에서 뽑았다 [출처: pve-docs `apidoc.js`, 2026-09-24 판, 설치본 PVE 9.2.2 측정]. 권한 경로는 모두 `/vms/{vmid}`다.

| 동작 | 경로 `POST /nodes/{n}/…` | PVE 권한 | 피해 범위 | 되돌림 | 단계 | 상태 |
|---|---|---|---|---|---|---|
| 시작 | `qemu/{id}/status/start`, `lxc/{id}/status/start` | `VM.PowerMgmt` | 게스트 1. 노드 메모리와 CPU 소비 | 종료 | L1 | 1차 |
| 종료(ACPI) | `qemu/{id}/status/shutdown`, `lxc/{id}/status/shutdown` | `VM.PowerMgmt` | 게스트 1의 서비스 중단. 응답 없으면 시간 초과 | 시작 | L2 | 1차 |
| 재부팅 | `qemu/{id}/status/reboot`, `lxc/{id}/status/reboot` | `VM.PowerMgmt` | 게스트 1. **대기 중 설정이 적용된다** [출처: 스키마] | 없음. 설정 변경이 따라올 수 있다 | L2 | 1차 |
| 강제 중지 | `qemu/{id}/status/stop`, `lxc/{id}/status/stop` | `VM.PowerMgmt` | 게스트 1. 전원을 뽑는 것과 같다. 파일 시스템 손상 가능 | 시작하나 손상은 못 되돌린다 | L3 | 2차 |
| 재설정 | `qemu/{id}/status/reset` (LXC에는 없다) | `VM.PowerMgmt` | 위와 같다 | 위와 같다 | L3 | 2차 |
| 스냅샷 생성 | `qemu/{id}/snapshot`, `lxc/{id}/snapshot` | `VM.Snapshot` | 저장소 소비 | 삭제에 다른 경로 필요 | | 하지 않음 |
| 마이그레이션 | `qemu/{id}/migrate`, `lxc/{id}/migrate` | `VM.Migrate` | 네트워크, 저장소, 게스트 중단 가능 | 재이동 | | 하지 않음 |
| 일괄 시작, 중지 | `startall`, `stopall` | ID별 `VM.PowerMgmt` | 노드 전체 | | | **relief는 호출 안 함.** 토큰으로는 풀 안에서 가능 |
| 노드 재부팅 | `/nodes/{n}/status` | `Sys.PowerMgmt` | 노드와 그 위 게스트 전부 | | | **만들지 않음** |
| 설정 변경 | `qemu/{id}/config` | `VM.Config.*` | 게스트 정의 | | | 만들지 않음 |

사전 조회에 `GET …/status/current`와 `GET …/pending`을 쓴다. 둘 다 `VM.Audit`이다 [출처: 스키마]. 태스크 상태는 자기 태스크면 추가 권한이 없다 [출처: 스키마]. `/cluster/ha/status/current`는 `/`의 `Sys.Audit`이 필요해 쓰기 토큰으로 읽지 못한다. HA 관리 여부는 `status/current` 응답의 `ha` 칸으로 본다 [가정: 응답 칸은 재지 않았다]. 칸이 없으면 계획을 거절한다.

**금지 매개변수.** 본문은 코드에 고정한다. `skiplock`, `forceStop`, `force-cpu`, `stateuri`, `migratedfrom`, `keepActive`, `overrule-shutdown`, `todisk`를 보내지 않는다. 종료는 `timeout=60` 하나다 [가정].

### 3.3 새 토큰

토큰 범위는 풀이다. `/pool/{poolid}`의 권한은 풀 구성원이 물려받는다 [출처: pve.proxmox.com/wiki/User_Management]. 풀에 넣지 않은 새 게스트는 relief가 건드리지 못하므로 기본이 거부다.

```sh
# 사용자가 노드에서 실행한다. 이 저장소의 어떤 에이전트도 대신 실행하지 않는다.
pveum pool add relief --comment 'relief may power these'
pveum pool modify relief --vms 100
pveum role add ReliefPower --privs 'VM.Audit VM.PowerMgmt'
pveum user add relief@pve --comment 'relief write path'
pveum acl modify /pool/relief --users relief@pve --roles ReliefPower
pveum user token add relief@pve act --privsep 1 --expire <30일 뒤 epoch>
pveum acl modify /pool/relief --tokens 'relief@pve!act' --roles ReliefPower
```

- 분리 토큰의 실효 권한은 사용자와 토큰의 교집합이라 두 곳 모두에 ACL을 건다 [출처: User_Management]. 명령 문법은 실행 전에 PVE 9.2 `pveum help`로 확인한다 [가정].
- 값은 사용자가 KMS의 `sagae/relief/pve-write`에 넣는다(8A.2절). 저장소, `relief.json`, 환경 변수, 로그, 응답에 없다. 평문 파일을 두지 않는다.
- 항목이 없거나 잠겨 있으면 쓰기 코드는 꺼져 있고 버튼 대신 이유가 보인다. **끄는 법은 항목 삭제이고, 완전히 막는 법은 PVE에서 토큰 폐기다.**
- `relief check --write`는 TTY에서 KMS 로그인을 받아 쓰기 토큰으로 `GET /access/permissions`를 읽어 권한 집합이 정확히 위 두 개이고 경로가 풀 범위인지 본다. 넓으면 쓰기를 켜지 않는다. 범위를 사람의 기억이 아니라 시험으로 확인한다.

**클라이언트.** `act/pve.mjs` 한 파일(3.8절). `node:https`, 메서드 POST와 위 GET, CA는 `relief.json`의 `pveCaFile`, 호스트는 `pveHosts`. 인증서 이름 검사를 끄지 않는다. 연결 실패만 다음 호스트로 넘기고, 응답을 받았거나 불명확하면 **재시도하지 않는다.** 멱등성을 모른다.

### 3.4 계획과 실행 (dry run 대용)

PVE 전원 API에는 dry run이 없다 [출처: 스키마 매개변수 목록]. 대신 relief가 실행 전 상태를 보여 주는 계획을 만든다.

| 단계 | 동작 |
|---|---|
| `POST /api/actions/plan` `{vmid, action}` | 쓰기 토큰으로 새로 읽는다: 노드, 상태, `lock`, 대기 설정, HA 관리 여부. 지도 스냅샷을 믿지 않는다. 사실과 경고, `planId`를 돌려준다. PVE 호출 없음 |
| 화면 | 대상 이름과 `vmid`, 노드, 현재 상태, 경고, 단계별 입력 |
| `POST /api/actions/execute` `{planId, confirm}` | `planId` 소모, 재확인, 상태를 다시 읽어 계획과 다르면 409, 감사 기록, PVE 호출 |
| 추적 | UPID를 저장하고 `/nodes/{n}/tasks/{upid}/status`를 폴링해 지도의 '기동 중'과 잇는다 |

| 계획 거절 조건 | 이유 |
|---|---|
| 풀 밖, 없는 `vmid`, 현재 상태와 맞지 않는 동작 | 입력 오류 |
| `lock` 있음 | `skiplock`을 쓰지 않는다 |
| HA 관리 게스트 | 전원 요청의 뜻이 달라진다. v2 범위 밖 |
| 쓰기 토큰의 실효 권한이 다름 | 3.3절 |
| 재부팅에 대기 설정 있음 | 거절하지 않고 경고를 낸다 |

`vmid`와 `node`는 게스트가 고를 수 없는 값만 쓴다. 이름, 태그, agent 값은 표시만 한다. `validNode`, `validId`와 같은 규칙을 쓰기 모듈에서 다시 검사한다.

### 3.5 피해 상한

| 층 | 상한 |
|---|---|
| PVE | 풀 안 게스트의 전원뿐. 노드, 저장소, 네트워크, 사용자 권한 없음. 토큰 30일 만료 |
| relief 코드 | 경로와 본문을 상수 표에서만 만든다. 라우트가 경로를 입력으로 받지 않는다. 호출 지점 하나를 소스 시험으로 강제한다 |
| 잠금 창 | `relief-act`를 통한 사용만 제한한다. **복사된 토큰은 막지 못한다** |
| 동시성 | 쓰기는 한 번에 하나. 일괄 API 없음 |
| 속도 | 10 min에 5회, L3는 5 min에 1회 [가정]. 넘으면 429 |
| 시간 | 재확인 5 min, 계획 60 s |

**이 상한이 못 막는 것.** relief를 거치지 않은 토큰 사용이다. 도난당한 토큰은 속도 제한 없이, 폐기나 만료 전까지 풀 전체를 끌 수 있다. 그래서 풀을 작게 유지한다.

### 3.6 감사 로그

`~/.local/state/relief/audit.jsonl`, mode 600, 추가 전용 [가정: 5 MiB 회전 2개]. 실행 전에 한 줄, 끝나면 한 줄. 쓰기 전에 감사 기록이 실패하면 실행하지 않는다.

- 칸: 시각, 세션 해시 앞 8자, 동작, `vmid`, 노드, 계획의 상태 요지, UPID, 결과. 터미널은 대상, 시작, 끝, 바이트 수.
- 넣지 않는 것: 암호, 토큰, 쿠키, 터미널 내용, PVE 실패 문구 전체. 실패 문구에는 명령줄과 내부 주소가 있었다 [출처: `relief.md:558`].
- 같은 UID가 고칠 수 있으므로 **증거가 아니라 작업 기록이다.** 더 나은 기록은 PVE 태스크 로그이고 전용 사용자로 호출이 구분된다. **다만 조건부다.** 공격자가 노드 root면 PVE 로그도, 노드에서 닿는 원격 사본도 지운다(O10). 노드 root가 없는 공격자에게만 강하다. 패널이 UPID로 둘을 잇는다.

### 3.7 필요한 변경

| 위치 | 변경 | 승인 |
|---|---|---|
| PVE | 풀, 역할, 사용자, 토큰, ACL 2건 | **사용자. 되돌릴 수 있으나 전역 변경이다** |
| 이 머신 | `relief.json`의 `pveHosts`, `pveCaFile`, `kmsUrl`, `kmsCaFile` | 사용자 |
| KMS | `sagae/relief/pve-write` 항목, 정책 `relief-write`. `kms.md` M7 | 사용자 |
| CA | `sagae-claude-plugins/plugins/proxmox/certs/pve-root-ca.pem`을 경로로 읽는다. 플러그인 코드 변경 없음 | 없음 |
| tower 코드, `tower.json` | 없음 | |
| 플러그인 코드 | 없음 | |

### 3.8 relief-act: 쓰기만 하는 별도 프로세스

**왜 분리하는가.** 잠금 창은 토큰을 지키지 못한다. relief 서버에는 npm 의존성이 있고, 침해된 패키지는 창이 열린 사이에 토큰을 복사해 잠근 뒤에도 쓴다. 복사본은 **폐기나 만료까지** 살아 있고 그 기간은 최대 토큰 수명이다. JS 문자열과 스왑에 남는 사본까지 생각하면 relief 프로세스 안에서는 이를 줄일 수 없다. 그래서 토큰을 쥐는 코드에서 npm을 뺀다.

| 항목 | 결정 |
|---|---|
| 코드 | `tools/relief/act/`. `node:` 내장만 import한다. `node_modules` 없이 돈다. 소스 시험으로 강제한다 |
| 실행 | `relief-act.socket`, `relief-act.service`. `127.0.0.1:4819`. 포트는 문서와 소켓에서 비어 있다 [측정] |
| 화면 | act가 직접 내는 HTML 한 장. 프레임워크 없음, `default-src 'none'`에 자기 스크립트만. relief UI는 `vmid`와 동작으로 만든 URL을 새 창으로 열 뿐이다 |
| 확인 | 사실을 act가 직접 읽어 자기 화면에 그린다. 침해된 relief UI가 대상을 바꿔 보이게 할 수 없다 |
| KMS 로그인 | 그 화면에서 act가 직접 받는다. relief 서버와 relief UI 번들은 암호, TOTP, 토큰을 보지 못한다 |
| 보호 | 2.1절의 표를 Host `127.0.0.1:4819`, Origin `http://127.0.0.1:4819`로 적용. 세션은 같은 방식의 명시 전송 |
| 기록 | `audit.jsonl`을 act가 쓴다 |

**이로써 relief 서버에는 PVE 쓰기 경로가 없다.** 쓰기 라우트, 쓰기 자격, 쓰기 코드가 모두 없고 `relief.md`의 읽기 전용 불변식이 relief 서버에는 그대로 남는다. 3.4절의 `POST` 경로는 act의 것이다.

**남는 위험을 줄이지 못한 부분.**

- 잠금은 relief를 통한 사용을 멈출 뿐이다. 이미 복사된 토큰은 막지 못한다. 분리는 복사될 기회를 줄인다.
- 같은 UID의 침해된 패키지가 `act/` 파일을 고치면 다음 시작 때 실행된다. 표적 공격을 막지 못한다. 설치 스크립트를 끈 것(`ignore-scripts=true` [측정])이 입구 하나를 닫아 줄 뿐이다.
- 그래서 토큰 수명을 **30일로 줄인다**(이전 판 90일). 교체는 사용자가 PVE에서 한다. 쓰기가 드물어 받아들일 수 있다. 만료 14일 전부터 패널이 알린다 [가정].

## 4. 웹 엔진

**결정: PVE 화면은 링크 아웃이다. 프록시와 iframe은 만들지 않는다.** 내장을 끝내 원하면 유일한 출구는 Electron이다. 이전 판의 파이프 프록시 권장은 교차 검토에서 틀린 것으로 확인돼 철회했다(13절).

"웹 엔진"이 곧 새 브라우저 엔진일 필요는 없다. 사용자는 이미 전용 Chrome 창을 쓰고 있으므로 관건은 PVE 화면을 어떻게 잇느냐다.

### 4.1 PVE에서 잰 것

| 항목 | 값 | 근거 |
|---|---|---|
| `X-Frame-Options`, CSP | **없다.** `GET /` 응답 헤더에 둘 다 없다. PVE 9.2.2 | [측정] |
| CORS | `/api2/json/version`에 없다 | [측정] |
| 인증 쿠키 | `PVEAuthCookie`, JS가 `document.cookie`로 `secure; samesite=lax`, 세션 쿠키로 쓴다 | [측정: 노드의 `proxmoxlib.js:335`] |
| CSRF | 쿠키 인증의 쓰기에는 `CSRFPreventionToken`이 필요하다. 첫 HTML에 실린다 | [측정: 응답 HTML], [출처: `pveproxy.pm:231`] |
| WebSocket Origin | 서버 코드에 Origin 처리가 없다. 콘솔 티켓에 기댄다 | [출처: pve-http-server 6.0.5 `AnyEvent.pm`] |
| 자산 경로 | 전부 절대 경로(`/pve2/`, `/pwt/`, `/proxmoxlib.js`, `/qrcode.min.js`) | [측정: 응답 HTML]. 경로 접두어 마운트는 안 되고 **자기 호스트의 루트**가 필요하다 |
| 인증서 | 클러스터 CA가 서명한 노드 인증서 | [측정] |
| 토큰과 콘솔 | 토큰 API는 VM과 시스템 콘솔을 덮지 않는다 | [출처: User_Management] |

브리프의 전제와 달리 `X-Frame-Options`는 장애물이 아니다. **장애물은 쿠키다.**

| 쿠키 시험 [측정: Chromium 156, 합성 서버, PVE의 쿠키 문자열과 같은 속성] | 프레임에서 저장 | 프레임 요청에 전송 | 부모 호스트에 전송 |
|---|---|---|---|
| 교차 사이트 https iframe (직접 PVE 모양) | **안 됨** | 안 됨 | 안 됨 |
| `relief.localhost` + `pve.localhost` (교차 사이트) | **안 됨** | 안 됨 | 안 됨 |
| `127.0.0.1:A` + `127.0.0.1:B` | 됨 | 됨 | **새어 나감** |
| `relief.localhost` + `pve.relief.localhost` | 됨 | 됨 | 안 감 |

**이 표의 함정.** 마지막 줄은 **호스트가 다른 경우**만 잰 것이다. 쿠키는 포트로 격리되지 않는다 [출처: RFC 6265]. 같은 `pve.relief.localhost`의 다른 포트에 서버를 띄우면 그 서버가 `PVEAuthCookie`를 받는다. `HttpOnly`, `__Host-`, 정확한 Origin 검사는 쿠키를 **받는 서버**를 막지 못한다. loopback에는 포트를 소유하는 개념이 있을 뿐 호스트 이름을 소유하는 개념이 없다.

그래서 로그인이 유지되려면 동일 사이트여야 하고, 동일 사이트 loopback에서는 다른 UID의 서버가 PVE 세션 쿠키를 받는다. 1.1절의 "다른 UID를 막는다"와 양립하지 않는다.

### 4.2 비교

| 기준 | **링크 아웃 (채택)** | 파이프 프록시 + iframe | 동일 출처 프록시 | 직접 iframe | Electron | Tauri |
|---|---|---|---|---|---|---|
| 로그인 유지 | 됨 | 됨 [측정: 쿠키 모양] | 됨 | **실패** [측정] | 됨 [가정] | 미확인 |
| PVE 쿠키가 loopback의 다른 서버로 | 아니오. 쿠키는 노드 호스트에 있다 | **예** | **예** | 아니오 | 아니오, 파티션 분리 [검색: session 문서] | 미확인 |
| PVE 스크립트가 relief 세션에 닿음 | 아니오 | 아니오 | **예** | 아니오 | 아니오 | 미확인 |
| 새 리스너 | 없음 | 포트 하나 | 없음 | 없음 | 없음 | 없음 |
| TLS 고정 | Chrome 신뢰 저장소 | relief | relief | Chrome 신뢰 저장소 | `setCertificateVerifyProc` [검색] | 미확인 |
| 설치 | 없음 | 없음 | 없음 | 없음 | Windows 쪽 앱. 바이너리 내려받기가 `ignore-scripts=true`와 충돌할 수 있다 [가정] | Windows 쪽 Rust 도구 사슬 |
| 갱신 부담 | 없음 | 없음 | 없음 | 없음 | 8주마다 메이저, 지원 3개, 45.2.1 [출처: electronjs.org] | WebView2 자동 |
| 코드 | 약 10 | 약 200 | 약 200 + 경로 재작성 | 수 줄 | 약 300 + 패키징 | 약 300 + Rust |
| 판정 | **채택** | **철회** | 기각 | 기각 | 내장을 원할 때의 유일한 출구 | 기각 |

- **링크 아웃.** 패널의 "PVE 열기"가 새 탭(`noopener noreferrer`)으로 노드 주소를 직접 연다. Phase 0에서 구현했고 `--app` 창은 쓰지 않는다(relief.md 9.15절). 주소는 관측한 노드에서 만들고 다른 URL을 받지 않는다. 클러스터 CA를 브라우저 프로필이 믿어야 경고가 없다. 콘솔(noVNC, xterm)까지 PVE가 그대로 준다.
- **파이프 프록시 철회.** 위 쿠키 문제가 근본이고 고칠 수 없다. 스파이크는 로그인 화면까지 떴지만 [측정: 저장소 밖 40줄, GET만, 로그인 안 함, 요청 26건 200, 인증서 이름 검사 끔] 그것이 안전을 뜻하지 않았다.
- **동일 출처 기각.** PVE UI는 게스트 이름과 설정을 그리는 큰 ExtJS 앱이고 XSS 공고가 이어졌다 [검색]. 같은 출처에 두면 그 스크립트가 relief 세션을 쓴다. 자산이 절대 경로라 HTML과 JS 재작성도 필요하다.
- **Electron.** 프록시도, iframe도, 공유 쿠키도 없다. 파티션이 쿠키를 앱 안에 가둔다. 그러나 Chromium 사본 갱신을 사람이 떠안는다. 사용자가 그 비용을 받아들일 때만 만든다(O5).
- **Tauri 기각.** 한 창의 여러 웹뷰는 `unstable` 기능이고 Windows에서 쌓임 순서 결함이 있다 [검색: tauri#9059, #9798]. 인증서 처리는 찾지 못했다.

### 4.3 프록시를 다시 연다면 지킬 조건

사용자가 위험을 알고도 원하거나 loopback에 다른 UID가 없다고 판단해 다시 열 때의 최소 조건이다. 지금 설계에는 없다.

| 조건 | 이유 |
|---|---|
| 자격을 넣지 않는다. 토큰, 티켓, 쿠키를 프록시가 만들거나 보관하지 않는다 | 넣는 순간 포트 하나가 PVE 권한이 된다 [출처: `tower.md:413`] |
| **대상을 고정한다.** 설정의 호스트와 포트로만 잇고 URL은 문자열로 잇는다. 절대 형식 요청(`GET http://…`), `//host`, `CONNECT`, 점 세그먼트를 거절한다. 끝난 대상 URL의 호스트를 다시 확인한다 | 쿠키와 본문이 다른 호스트로 새는 길이다 [출처: `tower.md:408-409`] |
| **리다이렉트를 따르지 않는다.** 응답의 `Location`이 대상 밖이면 502 | 위와 같다 |
| Host 정확 일치, 비GET과 WebSocket의 Origin 정확 일치 | PVE가 Origin을 보지 않는다 [출처] |
| 로그에 경로를 남기지 않는다 | 콘솔 URL에 티켓이 들어간다 |
| 응답에 `frame-ancestors`, `nosniff`를 더하고 `X-Frame-Options`는 더하지 않는다 | 프록시가 붙인 값이 UI를 깬 사례 [검색: 포럼] |
| TLS: CA 고정, 이름 검사 유지 | 스파이크는 껐다 |

### 4.4 솔직한 평가

사용자는 내장을 요청했고 이 설계는 그것을 주지 않는다. 내장은 편의일 뿐 기능을 더하지 않는다. 링크 아웃은 약 10줄이고 같은 UI를 준다. PVE의 콘솔이 노드 셸을 relief 코드 없이 해결한다는 점도 그대로다. 이것이 7절에서 노드 root를 뒤로 미루는 이유다.

## 5. Chrome 창 안의 전체 흐름

| 사용자 동작 | 경로 |
|---|---|
| `relief open` | `http://127.0.0.1:4815/`, 로그인 화면 |
| 지도 읽기 | 세션 값을 `Authorization` 헤더로 보낸다 |
| VM 시작 | 패널 버튼 → `relief-act` 창 → 사실 확인 → 실행 → UPID → 지도 '기동 중' |
| PVE 보기 | 패널의 "PVE 열기"(새 탭) |
| 터미널 | 패널 버튼 → 터미널 탭 → SSH 키 암호 |
| 잠그기, 30 min 유휴 | 세션 종료, 터미널 종료, 스크롤백 지움 |

## 6. 패키지 상태

"갱신 가능"은 층마다 뜻이 다르다. 한 숫자로 합치지 않는다.

| 층 | 읽는 곳 | 권한 | 범위 | 상태 |
|---|---|---|---|---|
| PVE 핵심 패키지 | `GET /nodes/{n}/apt/versions`. `Version`은 후보, `OldVersion`은 설치본 [출처: pve-manager `APT.pm:96-119,921-928`] | `Sys.Audit`, 기존 토큰으로 된다 [측정] | 큐레이션 목록뿐. `RunningKernel`도 있다 | 채택. 오늘 한 노드에서 차이 0건 [측정] |
| 저장소 설정 | `GET /nodes/{n}/apt/repositories` | `Sys.Audit` [출처: 스키마] | 활성 저장소와 경고 | 채택 |
| 노드 전체 패키지 | SSH 강제 명령 `apt list --upgradable` | 8절의 읽기 키 | 전부. `aptupdate` 태스크가 목록을 새로 고친다 [출처: `relief.md:557`] | 채택 |
| 게스트 OS | 기존 `agent/get-osinfo` | `VM.GuestAgent.Audit` | 판 이름뿐 | 있음 |
| 게스트 패키지 | 없음 | | | **"출처 없음"으로 그린다.** 생기면 8.3절의 강제 명령과 같은 모양으로 게스트별 추가 |
| 저장소 의존성 | `npm outdated --json`, `npm audit --json` | 레지스트리 호출 | 이 저장소 워크스페이스와 플러그인 저장소 | 채택. `relief deps` 명령으로 하루 1회 [가정] |

**쓰기와 읽기.**

| 층 | 읽기 | 적용 |
|---|---|---|
| 노드 | 표대로 | **버튼을 만들지 않는다.** 하이퍼바이저 갱신의 피해는 노드 전체이고 재부팅 판단이 사람 몫이다. API로도 없다. 웹 UI의 업그레이드는 콘솔이고 토큰은 콘솔을 못 쓴다 [출처: User_Management]. PVE 화면이나 터미널에서 사람이 한다 |
| 게스트 | 없음 | 터미널에서 사람이 한다 |
| 저장소 의존성 | 표대로 | relief가 적용하지 않는다. 변경은 커밋이고 검토 대상이다 |

**기각.**

| 후보 | 이유 | 근거 |
|---|---|---|
| `GET /nodes/{n}/apt/update` | 읽기인데 `Sys.Modify`가 필요하다. 실제로 403이 났다. `Sys.Modify`는 노드 네트워크 변경까지 열고 공식 문서가 주의를 준다. 목록 하나에 그 권한을 줄 수 없다 | [측정], [출처: 스키마, User_Management] |
| 게스트 `agent/exec` | `VM.GuestAgent.Unrestricted`는 임의 명령, 곧 게스트 root다. 토큰 범위를 무의미하게 만든다 | [출처: 스키마] |
| `pct exec` | LXC에 API가 없고 노드 root가 필요하다 | 7절 |
| OSV 직접 조회 | `npm audit`으로 충분하고 외부 호출이 하나 는다 | |

**주의.** `relief deps`는 패키지 이름을 레지스트리에 보낸다. relief가 머신 밖으로 보내는 호출은 공인 IP 하나뿐이라는 문구 [출처: `relief.md:464`]가 바뀐다. `npm`은 절대 경로로 부른다. 맨 PATH에 없다 [출처: `CLAUDE.md`]. 저장소의 7일 규칙(`min-release-age=7`)과 `ignore-scripts=true`를 따른다 [측정]. 화면은 "새 판 있음"과 "7일 규칙 통과"를 나눠 적는다.

허용 목록 추가: `/nodes/{n}/apt/versions`, `/nodes/{n}/apt/repositories` 두 줄. 주기 1 h [가정]. `Package`, `Version`, `OldVersion`, `RunningKernel`만 받는다. 응답의 `Description`은 크고 쓸모없다 [측정].

## 7. SSH 터미널

**위험을 먼저 적는다.** 복사 전용 결정의 이유는 "연결도 실행도 자격도 없다"였다 [출처: `relief.md:491`]. 내장 터미널은 그 셋을 전부 뒤집는다. 오늘 노드 별칭은 root다 [측정]. 터미널 세션 하나를 빼앗기면 클러스터 전체 root이고 PVE 풀 범위가 무의미해진다. 쓰기 설계에서 가장 위험한 기능이 이 항목이다. 그래서 마지막에 만들고, 처음에는 게스트만 연다.

### 7.1 결정

| 항목 | 값 | 근거 |
|---|---|---|
| 화면 | `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0 | [측정: `npm view`, MIT]. PVE 콘솔도 xterm.js다 [측정: 패키지 `pve-xtermjs`] |
| 전송 | `ws` 8.22.x, 업그레이드 라우트 하나 | [측정: `npm view`, MIT, 의존성 0] |
| 실행 | `node-pty` 1.1.0으로 `/usr/bin/ssh`를 인자 배열로. 셸을 거치지 않는다 | [측정: `npm view`, MIT] |
| 실행 사용자 | relief 프로세스 UID. 원격 사용자는 선언 파일이 정한다 | |
| 키 | 전용 키 `relief_term`을 OpenSSH 암호로 잠근다. relief가 읽지 않고 `ssh`만 쓴다. agent 전달 없음 | 키가 Node 메모리에 없다(8A.5절) |
| 대상 | `~/.config/relief/ssh.json`의 별칭 목록. 임의 주소를 받지 않는다 | |
| 설정 | `ssh -F ~/.config/relief/ssh_config -- <별칭>` | `~/.ssh/config`의 `Match exec`, `ProxyCommand`를 끌어오지 않는다 |
| 세션 | 동시 2개, 유휴 15 min, 최대 4 h [가정]. 로그아웃하면 닫는다 | |
| 프로세스 | 터미널 코드는 relief 서버의 다른 의존성과 떨어진 `relief-term` 프로세스에 둔다. 의존성은 `ws`, `node-pty`뿐. **`relief-term.socket`이 포트를 항상 쥔다** | 키 암호가 pty를 지나간다. 지도의 npm 트리가 볼 필요가 없다. 포트가 비어 있으면 다른 UID가 먼저 잡아 가짜 터미널로 암호를 모을 수 있다 |

**의존성 게이트.** `node-pty`의 패키지에는 macOS와 Windows 프리빌드만 있고 Linux는 `node-gyp`를 돌려야 한다 [측정: tarball]. 저장소는 `ignore-scripts=true`다 [측정]. 일반 설치로는 빌드되지 않는다. g++, make, python3은 있다 [측정]. Node 26에서 빌드되는지는 재지 않았다. 이 패키지에 한해 명시적 재빌드 단계를 두는 것이 사용자 결정이다(O7). 안 되면 7.3절의 Windows Terminal이 대안이다.

```text
# ~/.config/relief/ssh_config 의 공통 값
StrictHostKeyChecking yes   # 별칭의 지금 값은 ask다 [측정]
UpdateHostKeys no
ForwardAgent no
ForwardX11 no
ClearAllForwardings yes
PermitLocalCommand no
ControlMaster no
IdentitiesOnly yes
IdentityAgent none
ServerAliveInterval 30
```

| 주제 | 결정 | 이유 |
|---|---|---|
| 호스트 키 | `known_hosts`만 믿는다. 모르는 호스트는 연결을 거절하고 이유를 보인다. 브라우저에서 수락하는 길이 없다 | 터미널의 "yes" 하나가 신뢰 근거가 되면 안 된다. 최초 등록은 사람이 일반 터미널에서 한다 |
| 게스트 주소 | agent가 준 IP를 쓰지 않는다. 별칭만 쓴다 | agent 값은 게스트가 정한다 [출처: `relief.md:491`]. 침해된 게스트가 연결을 돌리지 못한다 |
| 인증 흐름 | `POST /api/term/open`이 `Authorization` 세션을 보고 10 s 일회용 티켓을 만들어 권한 제한된 Unix 소켓으로 `relief-term`에 등록한다. 티켓은 세션과 **대상 별칭**에 묶인다. relief-term은 등록되지 않은 티켓을 거절하고 탭은 대상 이름을 보인다. 터미널 탭은 `127.0.0.1:4818`의 자기 화면이고 티켓을 URL 조각으로 받는다. WebSocket은 브라우저가 헤더를 못 붙이므로 정확한 Origin(`:4818`)과 티켓을 본다. 티켓은 한 번 쓰면 사라진다 | CSWSH [검색] |
| 터미널 출력 | 신뢰하지 않는다. `allowProposedApi` 끔, OSC 52 애드온 없음, 웹 링크 애드온 없음, 제목 변경 무시 | 게스트가 출력을 정한다 |
| 붙여 넣기 | 브래킷 붙여 넣기 유지, 여러 줄이면 확인 | |
| 유휴 | **사람의 입력**만 센다. xterm은 장치 상태 질의(DSR 등)에 자동으로 답하고 그 답도 입력 스트림으로 나간다. 게스트가 이것으로 타이머를 늘릴 수 있다. 화면의 키와 붙여 넣기 사건만 타이머를 갱신한다. 15 min 뒤 알리고 닫는다 | 잠그지 않은 창, 게스트가 조작 가능 |
| 스크롤백 | 세션 종료, 로그아웃, 유휴 종료에서 `term.clear()`와 `dispose()`로 지운다. `sessionStorage`나 디스크에 두지 않는다 | 지난 출력에 비밀이 있을 수 있다 |
| 기록 | **내용은 기본 끔.** 메타데이터(대상, 시각, 바이트)만 감사 로그에 | 터미널 내용에는 붙여 넣은 비밀이 있다. 평문 기록은 root 세션 사본이다 |
| 내용 기록 선택 | 켜면 asciicast 형식, 출력만, mode 600, 세션마다 화면 표시. 입력은 기록하지 않는다 | 형식만 빌린다. asciinema는 GPL-3.0이라 코드를 넣지 않는다 [측정: gh api] |

복사 전용 버튼은 남긴다. 같은 함수 `server/model/ssh.ts`를 쓴다. 내장을 끄면 그 상태로 돌아간다.

### 7.2 범위

| 대상 | 1차 | 이유 |
|---|---|---|
| 게스트 | 연다. L2 | 피해가 게스트 하나다 |
| 노드 | **닫는다.** PVE 화면의 콘솔을 쓴다 | PVE 로그인과 TFA를 거치고 relief가 root를 갖지 않는다 |
| 노드(사용자가 원하면) | 전용 키, 암호 있는 키, L3, 또는 root가 아닌 관리 사용자 | O6 |

### 7.3 기각

| 후보 | 이유 | 근거 |
|---|---|---|
| `ssh2` 1.17.0 | 키를 Node가 다루고, `known_hosts`(해시 형식 포함)와 설정 해석을 다시 짠다. 선택적 네이티브 의존성이 있다 | [측정: `npm view`, MIT, 저장소 2026-08 활동] |
| ttyd | C 바이너리에 세션마다 포트가 는다. 마지막 릴리스가 1.7.7(2024-03)이다. 인증과 Origin을 relief 밖에 두게 된다 | [측정: gh api] |
| WeTTY | 자체 서버와 인증을 또 들인다. relief 세션과 겹친다 | [측정: gh api, MIT, 2026-10 활동] |
| PVE `termproxy`를 토큰으로 | 토큰은 콘솔을 쓰지 못한다. `Sys.Console`이나 `VM.Console`도 필요하다 | [출처: User_Management, 스키마] |
| `ssh -tt`를 파이프로 | 네이티브가 없지만 창 크기 변경이 전달되지 않는다 [가정] | |
| Windows Terminal 띄우기 (`wt.exe`) | **더 안전한 대안이다.** 브라우저 안에 root 셸이 없다. 사용자가 "내장"을 요청했으므로 기본은 아니고, node-pty가 실패하거나 O5에서 내장을 접으면 이것으로 간다 | |

## 8. BMC

### 8.1 읽기 전용 조사 결과

허용된 세 명령만 실행했다 [측정: 2026-11-01]. BMC 네트워크, BMC 자격, 일련번호는 건드리지 않았다.

| 노드 | 보드 | `/dev/ipmi*` | `ipmitool` | `mc info` | Redfish |
|---|---|---|---|---|---|
| pve-node | 보드 A | 있음 | 있음 | 응답함 | 그럴듯함 |
| pve-node | 보드 B | 있음 | **없음** | 실행 안 됨 | 그럴듯함 |
| pve-node | 보드 A | **없음** | 있음 | 장치 없음 오류 | 그럴듯함 |

- pve-node의 장치가 없는 원인은 모른다. 드라이버 미적재가 유력하나 [가정] 허용 명령으로는 가릴 수 없다. 같은 보드인 pve-node에는 장치가 있다.
- Redfish 판단은 문서 기반이다. 두 보드 모두 제조사 문서에 Redfish가 있다 [검색]. **어떤 BMC에도 연결해 보지 않았다.**

### 8.2 먼저 볼 보안 문제

**BMC 펌웨어의 Redfish 인증 우회 취약점.** 심각도 최고 등급이고 실제 악용이 보고됐다 [검색]. 공격자가 BMC 관리자를 만들 수 있다. 이 클러스터의 세 BMC가 영향권일 가능성이 있다. 식별 번호와 수정판은 저장소에 적지 않고 사용자가 제조사 공지에서 확인한다.

| 보드 | 영향 | 조치 |
|---|---|---|
| 보드 B | 제조사가 수정판을 냈다 [검색] | 현재 판을 사용자가 BMC 화면에서 확인 |
| 보드 A | 제조사 수정 공고에 이 보드가 들었는지 확인하지 못했다 [검색]. 현재 판의 수정 여부는 모른다 | 제조사 지원 페이지에서 확인 |

BMC가 일반 LAN에 있는지도 이 문서는 모른다. `edge.json`의 `interface`가 미확인이다. **이 확인이 relief 기능보다 시급하다**(O9). 버전 확인 전에는 relief가 Redfish에 붙지 않는다.

### 8.3 결정: 노드 안의 강제 명령으로 읽는다

| 기준 | **SSH 강제 명령 + `ipmitool` (채택)** | Redfish GET | IPMI over LAN | 기존 PVE API |
|---|---|---|---|---|
| BMC 자격 | 없음 | ReadOnly 계정 3개 | USER 계정 3개 | 없음 |
| BMC 네트워크 | 없음. `/dev/ipmi0` | WSL에서 BMC 주소로 | 같음 | 없음 |
| 사전 작업 | 키 1개, p1 설치, p2 드라이버 | 계정, 인증서, 펌웨어 확인 | 계정, cipher 설정 | 없음 |
| 스키마 | 평문 파싱 | 표준 JSON | 평문 | 센서 API 없음 [출처: 스키마의 `/hardware`는 PCI, USB뿐] |
| 판정 | 채택 | 펌웨어 확인 뒤 재검토 | 기각. RMCP+ 인증 약점 [가정] | 불가 |

**키 하나로 노드 읽기를 묶는다.** 패키지 목록(6절)과 센서를 같은 강제 명령으로 읽는다. 키 도난의 피해는 그 출력을 읽는 것뿐이다.

```text
# authorized_keys 한 줄 (값은 예시 자리다)
restrict,command="ipmitool sdr elist full; echo ---; ipmitool chassis status; echo ---; ipmitool sel list last 20; echo ---; apt list --upgradable 2>/dev/null" ssh-ed25519 <공개키> relief-read
```

- `restrict`는 전달, pty, 에이전트를 끈다. `command`는 클라이언트 입력을 무시한다. 같은 모양을 relief는 Docker 호스트 후보로 이미 적었다 [출처: `relief.md:519`]. **실행해 본 적 없다**(Phase 3 첫 시험).
- 넣지 않는 명령: `fru`(일련번호), `lan print`(주소), `user list`, `mc reset`, `chassis power`, `sol`. 노드 root는 KCS로 BMC 관리자와 같으므로 강제 명령이 유일한 범위 제한이다.
- 개인 키 `~/.ssh/relief_read`는 무인 수집이라 암호가 없다. 범위가 읽기뿐이라 받아들인다.
- PVE의 root `authorized_keys`는 클러스터 공유 파일일 수 있다 [가정: 9.x에서 달라졌을 수 있다]. 편집 전에 사용자가 확인한다.
- 수집은 `execFile('/usr/bin/ssh', ['-F', cfg, '--', alias])`, 주기 5 min [가정], 노드당 시간 제한 30 s. 출력은 게스트 값과 같은 문을 지난다: 길이 제한, 제어 문자 제거, 줄 형식이 안 맞으면 그 칸은 미확인. 값은 `pve:node:<name>` 패널과 `bmc` 객체의 관측 사실이 된다(`relief.md` 3절의 `decl:bmc`에 관측이 더해진다).
- 센서 이름은 보드마다 다르다. 임계 판단은 `ipmitool`의 상태 칸만 쓰고 relief가 임계값을 지어내지 않는다. 보드 A 둘과 보드 B 하나의 출력 모양은 재지 않았다.

**배치의 예외.** `relief.md` 19절은 자격이 필요한 출처를 tower 뒤 MCP로 두라고 했다. 소비자가 relief뿐이고 키가 읽기 전용이며 MCP로 감싸면 외부 저장소 변경과 배포가 늘어나므로 relief 어댑터로 둔다. Claude가 센서를 읽을 필요가 생기면 그때 옮긴다(O8).

### 8.4 기각

| 후보 | 이유 |
|---|---|
| Redfish 지금 도입 | 8.2절의 CVE 경로를 직접 두드리고 BMC 자격 3개가 생긴다. in-band로 필요한 값이 나온다 [가정: Phase 3에서 확인] |
| BMC 전원 제어, SOL, KVM | 노드 전체의 피해 범위이고 이 설계의 범위 밖이다. BMC 화면은 링크로도 내지 않는다 |
| `ipmi_exporter` | 수집기를 노드마다 두고 메트릭 서버까지 필요하다. 비목표다 [출처: `relief.md:72`] |
| relief가 `ipmitool`을 SSH 인자로 전달 | root 전체 키가 필요하다 |

## 8A. 키 관리: relief는 KMS의 클라이언트다

**사용자가 범위를 바꿨다(2026-11-01).** sagae 전체의 비밀을 KMS 하나에 맡긴다. 설계는 `docs/design/kms.md`이고 relief의 일부가 아니다. 이전 판의 "KMS 서버는 과하다"는 relief만 볼 때의 판단이었다. 같은 UID 한계에 대한 판단은 그대로이며 `kms.md` 0절과 6.3절에 옮겼다. 이 절은 relief가 KMS를 어떻게 쓰는지만 정한다.

**원칙.** relief는 KMS 없이 시작하고 읽는다. KMS가 없으면 쓰기와 노드 터미널만 멈춘다. 코드 의존은 없고 HTTPS API 두 개뿐이다. `relief.json`에 `kmsUrl`이 없으면 쓰기가 꺼진다.

### 8A.1 비밀 목록

티어는 `kms.md` 0절의 정의다.

| 비밀 | 티어 | 위치 | 유출 피해 | 폐기 |
|---|---|---|---|---|
| PVE 쓰기 토큰 | T2 | `sagae/relief/pve-write`. 잠금 창에서만 `relief-act` 메모리 | 풀 안 게스트 전원 | `pveum user token remove` |
| relief 로그인 해시 | 로컬 | `~/.config/relief/auth.json`, 600. KMS에 묶지 않는다 | 오프라인 추측 | `relief passwd` |
| 세션 값, 계획 ID, 터미널 티켓 | 메모리 | 저장 없음 | 세션 동안 | 로그아웃, 재시작 |
| KMS 토큰 | 메모리 | 잠금 창 동안. 디스크에 없음 | `relief-write` 정책 범위 | 수명 만료 |
| `relief_read` 키 | T0-렌더 | `~/.ssh/relief_read`, 600. 강제 명령이 범위다(8.3절) | 센서와 패키지 목록 | `authorized_keys`에서 제거 |
| `relief_term` 키 | T2 | OpenSSH 암호로 잠근 파일. KMS에 넣지 않는다(8A.5절) | 등록된 대상의 셸 | 대상에서 제거 |
| tower bearer | T0-렌더 | `~/.config/tower/token`. 경로와 읽는 법이 그대로다 | `kb_put`, proxmox 읽기 | KMS에서 값 교체 |
| BMC 읽기 계정 | 없음 | **만들지 않는다.** in-band로 읽는다 | | |
| 라우터 관리자 암호 | 없음 | **KMS에도 넣지 않는다.** 쓸 어댑터가 없고 넣으면 쓸 이유가 생긴다 [출처: `relief.md:911`] | 집 네트워크 전체 | |
| 감사 로그 서명 키 | 없음 | **만들지 않는다.** 같은 UID가 읽어 다시 서명한다. 더 나은 기록은 PVE 태스크 로그와 KMS 감사다. 노드 root에게는 그것도 조건부다(3.6절) | | |

### 8A.2 쓰기 잠금 해제

주체는 `relief-act`다(3.8절).

| 단계 | 동작 |
|---|---|
| 1 | L1 이상 동작이 잠금 창 밖이면 act 화면이 **전용 계정 `relief-writer`** 의 암호와 TOTP를 받는다 |
| 2 | act가 `POST /v1/auth/userpass/login/relief-writer`로 그대로 넘긴다. 저장하지 않는다 |
| 3 | 받은 토큰(`token_ttl`과 `token_max_ttl` 15 min, 정책 `relief-write` 하나, `default` 없음)으로 `GET /v1/sagae/data/relief/pve-write` |
| 4 | 값은 `secrets.use('pveWrite', fn)` 범위 함수 안에서만 쓴다. 호출 지점은 `act/pve.mjs` 하나다. 소스 시험으로 강제한다 |
| 5 | 쓰기가 없으면 15 min 뒤 버퍼를 0으로 덮고 KMS 토큰을 폐기한다. 로그아웃과 재시작도 같다 |

- **`owner` 계정을 act에 넣지 않는다.** 일반 로그인은 15 min 토큰을 주지 않고, `owner` 토큰이 들어가면 act 침해가 KV 전체와 SSH 서명으로 번진다. `relief-writer`는 별도 엔티티이고 그 비밀 하나만 읽는다(`kms.md` 6.5절).
- **창의 뜻을 과장하지 않는다.** 창이 닫히면 act가 토큰을 쓰지 않을 뿐이다. 창 안에서 복사된 값은 PVE에서 폐기하거나 30일 만료될 때까지 유효하다. KMS도 정적 PVE 토큰의 수명을 줄이지 못한다.
- **agent 렌더 파일을 쓰지 않는다.** 쓰기 토큰이 파일로 렌더되면 같은 UID가 읽는다. 사람 로그인을 거쳐야만 나오게 하는 것이 T2의 뜻이다.
- CA는 `relief.json`의 `kmsCaFile`로 고정한다. tower를 거치지 않는다. bearer와 쓰기를 섞지 않는 3.1절의 이유와 같다.
- 환경 변수, 명령줄, `EnvironmentFile`, 로그, 오류 문구, 스냅샷, 상태 파일에 값이 없다. 같은 UID는 `/proc/<pid>/environ`과 `cmdline`을 읽었고 `/proc/<pid>/mem`은 권한 오류였다 [측정: 더미 값, `ptrace_scope` 1].
- JS 문자열은 지울 수 없어 헤더를 만드는 순간 힙에 사본이 남는다. 스왑이 12 GB 있어 디스크로 나갈 수 있다 [측정]. 유닛에 `LimitCORE=0`을 적는다. "메모리에만"은 파일이 없다는 뜻이지 흔적이 없다는 뜻이 아니다.

**relief 로그인과 KMS 로그인을 나눈다.** 로그인 해시를 로컬에 두어야 KMS가 없어도 지도를 본다. 두 암호를 같은 값으로 둘지는 사용자 결정이다(O15). 별도 암호를 권장한다.

### 8A.3 KMS가 없을 때

| 기능 | KMS 다운 | 표시 |
|---|---|---|
| 지도, 패널, 패키지, BMC | 정상 | 없음 |
| 로그인 | 정상 | 없음 |
| 잠금 창 안의 쓰기 | 창이 끝날 때까지 정상 | 남은 시간 |
| 새 쓰기 | 불가 | "KMS 없음 · PVE 화면을 쓰세요" |
| 게스트 터미널 | 정상. 키 암호는 로컬이다 | 없음 |
| 노드 터미널(M5 뒤) | 인증서 만료 뒤 불가 | 이유 |

**KMS VM은 relief 풀에 넣지 않는다.** 그 VM을 켤 토큰이 그 VM 안에 있는 순환이다(`kms.md` 3.3절). `check --write`가 풀 구성원에 KMS VM이 없는지 본다.

### 8A.4 `age` 파일은 남기지 않는다

| 용도 | 판정 | 이유 |
|---|---|---|
| 런타임 대체 | **기각** | KMS 복구에 relief가 필요하지 않다. 사용자는 PVE 웹 UI로 VM을 켠다. 같은 토큰의 둘째 저장소만 생기고 교체 때 어긋난다. 쓰기가 잠시 멈추는 것은 받아들인다 |
| 부트스트랩 | **조건부** | relief Phase 4를 KMS M2 전에 내야 할 때만 쓴다. `vault.age`(`age-encryption` 0.3.1, 왕복 0.8 s [측정])를 임시로 두고 M7에서 지운다. 의존성 하나와 약 120줄이 이 기간만을 위해 든다. **권장은 기다리는 것이다.** 쓰기는 급하지 않다 |
| 복구 키트 | 별개 | 조각 C를 `age`로 암호화하는 일은 `kms.md` 4절의 범위다. relief 코드가 아니다 |

### 8A.5 SSH 키는 relief 밖에 둔다

| 방식 | 키 위치 | relief가 보는가 | 세션 탈취 피해 | 판정 |
|---|---|---|---|---|
| **암호 있는 전용 키 + `ssh`가 터미널에서 물음** | `~/.ssh/relief_term` | 키는 못 본다. 암호 입력은 pty를 지나가나 저장하지 않는다 | 암호 없이 새 연결 불가 | **Phase 6 채택.** 데몬 없음 |
| **KMS SSH 서명 인증서** | 키는 로컬, 인증서 30 min [가정] | 못 본다. 잠금 토큰으로 서명만 요청 | 수명 동안 | **M5 뒤 노드 터미널의 기본** |
| 전용 `ssh-agent -a <소켓> -t 15m` | 메모리 | 못 본다 | 수명 동안 소켓 사용 가능. 같은 사용자와 root가 쉽게 악용한다 [출처: `ssh-agent(1)`] | 입력이 번거로울 때의 대안 |
| **agent를 서버로 전달** (`ForwardAgent yes`) | 로컬 | 못 본다 | **원격의 권한 상승자가 내 agent로 다른 호스트에 붙는다** [출처: `ssh_config(5)`] | **기각.** 다단은 `ProxyJump` |
| 키를 KMS에 넣고 `ssh2`로 | Node 메모리 | **본다** | 프로세스 침해 = 키 | 기각 |
| 하드웨어 키(`ed25519-sk`) | 토큰 | 못 본다 | 터치마다 확인 | 나중. `usbipd`가 없다 [측정] |

터미널 `ssh_config`에 `IdentitiesOnly yes`, `IdentityFile ~/.ssh/relief_term`, `IdentityAgent none`, `ForwardAgent no`를 둔다. 키 암호가 재확인을 겸하므로 터미널을 열 때 relief 암호를 다시 받지 않는다.

### 8A.6 이것이 막지 못하는 것

| 공격자 | 할 수 있는 일 | 왜 못 막는가 |
|---|---|---|
| 같은 UID 코드 | `tools/relief/act`를 고쳐 다음 잠금 해제 때 KMS 암호를 가로챈다. `secret_id`로 T0와 T1을 읽는다. O10 전에는 root SSH로 노드에서 직접 `pveum` | relief가 그 UID가 쓸 수 있는 파일에서 돈다 |
| Windows 같은 사용자 | `wsl -u root`로 메모리와 파일, 브라우저 입력 | 경계 밖이다 [출처: `tower.md:421`] |
| 침해된 relief 서버 | 읽기 값. 쓰기 토큰은 없다 | `relief-act` 분리가 줄인 몫이다 |
| 침해된 `relief-act` | 창 안의 토큰, 입력되는 KMS 암호. **복사본은 폐기나 만료까지 유효** | 평문이 그 안에 있다. 의존성이 없어 입구가 좁을 뿐이다 |
| 노드 root | PVE 로그와 그 원격 사본, KMS VM 메모리 | 로그가 그 권한 아래에 있다 |

KMS로 달라지는 것: 쓰기 토큰이 이 머신의 디스크에 아예 없다. 대화 전사, 백업, 복사된 설정으로 샐 값이 없다. 사용 기록이 호스트 밖에 남는다. 다만 유출된 값의 쓰임은 토큰 수명까지 간다. 이 이득도 `kms.md`의 M5와 이 문서의 O10을 끝내야 온전해진다.

## 8B. 모바일과 원격 접근

**사용자 요구(2026-11-01).** 사용자의 태블릿, 전화기, 접는 전화기에서 relief를 쓴다. 이 요구는 "127.0.0.1에서 이 머신의 브라우저 하나만"이라는 지금까지의 전제를 끝낸다.

**결론.**

| 질문 | 결정 |
|---|---|
| relief는 어디서 도는가 | **클러스터의 ops VM.** WSL은 Windows와 함께 잠든다. KMS VM과 분리한다 |
| 통로 | **Tailscale 오버레이.** 공개 포트 0, Funnel 끔. 입구는 8E절의 `gate` |
| 바인딩 | relief는 VM의 `127.0.0.1`에 그대로. LAN 바인딩 없음 |
| 인증서 | 8E.2절의 와일드카드. 이전 판의 Serve 인증서는 대체 경로다 |
| 기기 | 기기마다 오버레이 등록과 패스키 등록, 두 겹 |
| 처음 범위 | **읽기와 PC 깨우기만.** 쓰기는 뒤에, 강제 중지와 터미널은 전화기에서 금지 |
| 순서 | **패스키가 끝나기 전에는 아무것도 원격으로 열지 않는다** |

### 8B.1 어디서 돌리나

**배치는 sagae 전체의 한 결정이고 `kms.md` 3.1절이 원본이다.** 비교, 클러스터 여유, 노드 고장 표가 거기 있다. 결론은 **KMS VM과 ops VM을 나눈다**이다. 자원은 제약이 아니었다. 세 노드에 메모리 약 110 GiB가 비어 있다 [측정].

| 질문 | 답 |
|---|---|
| WSL에 남는가 | 아니오. Windows가 잠들면 전화기에서 못 쓴다. **Windows PC가 호스트라는 점이 이 요구의 진짜 한계다** |
| KMS와 같은 VM인가 | **아니오.** 전화기가 닿는 웹 앱을 봉인 해제된 KMS 옆에 두지 않는다 |
| LXC인가 | 아니오. `pct enter`가 셸을 바로 주고 `tun`이 번거롭다 [가정]. 절약이 의미 없다 |
| 어느 노드 | ops는 pve-node, KMS는 pve-node. 고장 범위를 나눈다 |

**ops VM 안의 Unix 사용자.** 서비스마다 분리한다. 공유 UID와 달리 여기서는 실제 경계다(`kms.md` 6.3절).

| 사용자 | 서비스 | 쥔 것 |
|---|---|---|
| `relief` | 지도, 읽기, 깨우기 | tower-ops bearer, `relief_read` |
| `relief-act` | 쓰기 | 잠금 창의 PVE 토큰 |
| `relief-term` | 터미널 | `relief_term` |
| `tower-ops` | tower, proxmox MCP | PVE 읽기 토큰 |

**옮기면 달라지는 것.**

| 항목 | WSL 지금 | ops VM |
|---|---|---|
| Proxmox 읽기 | WSL tower 경유 | **ops VM 안의 두 번째 tower.** 코드는 같고 설정에 proxmox 업스트림만 둔다. 127.0.0.1 바인딩 그대로이고 bearer가 `kb_put`을 열지 않는다. 쓰기 금지 시험도 그대로 돈다 |
| WSL tower | | **바꾸지 않는다.** bind를 넓히지 않는다. relief가 닿지 않는다 |
| KB | relief는 쓰지 않는다 | 끊기는 것이 없다 |
| PVE 읽기 토큰 | 공유 파일 | ops 전용 `PVEAuditor` 토큰. 복사하지 않고 새로 발급한다 |
| `edge.json`, `relief_read` | WSL | ops. 저장소와 KB 밖 규칙은 같다 |
| `local` 어댑터(PC 관측) | `node:os` | 쓸 수 없다. PC는 `health` 출처로만 본다. 값이 줄어든다 |
| `relief_term` 키 | WSL | ops의 `relief-term` 소유. 암호 입력은 터미널 그대로. `known_hosts`도 옮긴다 |
| 데스크톱 접속 | `http://127.0.0.1:4815` | Windows도 오버레이로 같은 주소 |
| 백업 | 없음 | **값 없는 백업(R5).** 설정과 상태만 WSL로 당긴다. 비밀은 재등록으로 되찾는다. `vzdump`는 `secret_id`를 담으므로 쓰지 않는다 |

**`kms.md`와의 연결.** ops 서비스는 KMS의 첫 WSL 밖 소비자이고 서비스별 계정이 실제 경계가 되는 곳이다. K0이 미뤄져 있는 동안 WSL 같은 UID가 노드 root로 VM에 닿으므로 같은 UID 코드에 대한 격리는 아니다(9.1절). relief는 KMS가 없어도 돈다는 원칙은 같다(8A.3절).

### 8B.2 통로 비교

| 기준 | **Tailscale (채택)** | 직접 WireGuard | LAN만, 로컬 TLS | Cloudflare Tunnel | 공개 역방향 프록시 |
|---|---|---|---|---|---|
| 집 밖에서 | 됨 | 됨 | **안 됨** | 됨 | 됨 |
| 라우터 포트 포워드 | 없음 | **필요** | 없음 | 없음 | **필요** |
| 동적 공인 IP | 무관 | DDNS 필요 | 무관 | 무관 | DDNS 필요 |
| 인터넷에서 보이는가 | 아니오 | 포트 하나 | 아니오 | **예** | **예** |
| TLS 종료 | VM | VM | VM | **제3자 경계** [출처: Cloudflare] | VM |
| 인증서 | 자동 공인 | 직접 | 사설 CA를 기기마다 설치 | 자동 | 자동 |
| 제3자 신뢰 | 제어 평면. Tailnet Lock으로 줄인다 | 없음 | 없음 | 트래픽 전체 | 없음 |
| 전화기 앱 | 공식 | 공식 | 불필요 | 불필요 | 불필요 |
| 비용 | 개인 비상업 무료, 사용자 6, 기기 무제한 [출처: 요금표] | 없음 | 없음 | 무료 범위 [가정] | 없음 |
| 판정 | **채택** | 대안 | 기각 | **기각** | **기각** |

- **Tailscale.** 클라이언트 BSD-3-Clause, v1.104.4(2026-10-28) [측정: GitHub]. 제어 서버는 상용이다.
- **공개 역방향 프록시 기각.** 오늘 포트 포워드가 0개다 [출처: `relief.md` D6]. VM 전원을 끄는 앱을 인터넷에 내놓을 이유가 없다. 인증 결함 하나가 곧 사고가 되는데, 그 인증을 이 프로젝트가 처음 만든다.
- **Cloudflare Tunnel 기각.** 포트는 없지만 공개 주소이고, 터미널과 관리 트래픽이 제3자 경계를 지난다.
- **LAN만 기각.** 집 밖에서 안 되고, 사설 CA를 전화기마다 설치해야 한다. 요구를 못 채운다.
- **직접 WireGuard 대안.** 제3자가 없다는 장점이 크다. 라우터 일부 모델이 서버를 지원한다는 자료가 있으나 [검색: 블로그, 공식 확인 못 함] 모델과 펌웨어를 확인하지 않았다. 포트 포워드 하나가 늘고 `edge.json` 선언이 바뀐다. Tailscale 약관이나 계정이 문제가 되면 이쪽으로 간다.
- **Headscale 기각.** BSD-3-Clause, v0.29.7 [측정]. 제어 서버를 인터넷에 직접 운영해야 해 공개 표면이 다시 생긴다.

### 8B.3 결정

| 항목 | 결정 | 근거 |
|---|---|---|
| 바인딩 | relief, act, term은 ops VM의 `127.0.0.1`. 입구는 오버레이 주소의 Caddy(8E.3절). 0.0.0.0을 쓰지 않는다 | 뒤쪽이 localhost에만 있어야 한다 [출처: Serve 문서] |
| Funnel | **끈다.** Funnel은 공개 인터넷 노출이다 | [출처: Serve 문서]. `tailscale funnel status`를 Phase 검증에 넣는다 |
| 출처 | `https://relief.internal.example`. relief, act, term이 호스트로 나뉜다(8E.5절). `*.ts.net`은 대체 경로 | 3.8절의 출처 분리 유지 |
| 인증서 | 8E.2절. Serve 경로로 내려가면 Let's Encrypt 90일 인증서를 Tailscale이 받는다 | [출처: Enabling HTTPS] |
| 이름 | **임의 tailnet 이름, 일반적인 기기 이름.** 인증서는 공개 CT 원장에 남는다 | [출처: Enabling HTTPS] |
| ACL | 기본 거부. 사용자 기기 → `tag:relief`의 Serve 포트만. VM에서 기기로는 없음. 서브넷 라우터를 켜지 않는다 | LAN 전체를 전화기에 열지 않는다 |
| 기기 키 만료 | 사용자 기기는 유지. 태그 서버는 기본 만료 없음 | [출처: Subnet 문서] |
| 제어 평면 | **Tailnet Lock.** 서명 노드 2개 이상, Android는 서명 불가, Windows와 태블릿으로 둔다 | [출처: Tailnet Lock]. 해제 비밀 10개는 복구 키트에. 잃으면 tailnet을 복구하지 못한다 |

**기기 등록.**

| 단계 | 내용 |
|---|---|
| 1 | 기기에 Tailscale 설치, 로그인, Tailnet Lock 서명 |
| 2 | VM 콘솔이나 SSH에서 `relief device add <이름>` → 10 min 일회용 코드 |
| 3 | 기기에서 코드 입력, 패스키 생성 |
| 4 | 서버가 기기 표에 이름, 자격 ID, 공개키, 권한을 쓴다 |

오버레이에 있다고 relief를 믿지 않는다. **두 겹이 따로 필요하다.**

**패스키를 채택한다(이전 판 기각을 뒤집는다).** 2.3절의 기각 이유는 "지키는 문이 relief뿐이고 같은 UID가 우회한다"였다. 이제 문이 원격이고 relief는 다른 머신에 있어 이유가 사라졌다. 전화기에서 긴 암호를 치는 비용도 크다.

| 항목 | 결정 |
|---|---|
| 방식 | WebAuthn, 사용자 확인 필수(Face ID, 지문). `@simplewebauthn/server` 14.0.3, 직접 의존성 10개 [측정] |
| 저장 | `~/.config/relief/devices.json`. **공개키뿐이라 비밀이 없다.** `auth.json`의 암호를 없앤다 |
| RP ID | `relief.internal.example` 정확한 이름(8E.5절). **나중에 바꾸면 모든 기기를 다시 등록한다.** IP는 RP ID가 될 수 없어 127.0.0.1에서는 쓸 수 없다. 그래서 Phase 1은 암호이고 이름이 정해진 뒤 교체한다 |
| 세션 | 2.1절의 출처 고정 방식 그대로. 기기마다 하나, 서버가 자격 ID에 묶는다. `sessionStorage`가 비면 패스키를 다시 묻는다 |
| 재확인 | L1 이상은 relief에서 패스키 재확인 |
| 복구 | 모든 기기를 잃으면 VM 콘솔에서 `relief device add`. PVE 콘솔은 사용자의 PVE 로그인이다 |

**`relief-act`는 npm이 없어 WebAuthn 라이브러리를 쓸 수 없다.** 검증을 직접 짜지 않는다. act의 쓰기 잠금은 KMS 로그인(8A.2절) 그대로이고 전화기에서는 암호 관리자 자동 입력과 TOTP로 한다. 쓰기가 드물어 받아들인다. 패스키는 relief 서버의 문이고 relief 서버에는 PVE 쓰기가 없으므로, 침해돼도 피해는 읽기와 깨우기다.

**기기별 신원의 한계.** iCloud 키체인과 Google 비밀번호 관리자는 패스키를 동기화한다. 같은 계정의 전화기와 태블릿이 같은 자격을 쓸 수 있다. 이 경우 신원 단위는 기기가 아니라 패스키 공급자 계정이다. 감사의 기기 이름은 등록 때 붙인 이름이고 증명이 아니다. `Tailscale-User-*` 헤더는 사용자 단위이고 태그 기기에는 없어 기록용이다 [출처: Serve 문서].

**잃어버린 전화기.** 어느 브라우저에서든 순서대로 한다.

| 순서 | 조치 | 효과 |
|---|---|---|
| 1 | Tailscale 관리 화면에서 기기 제거 | 통로가 끊긴다. 앱이 잠겨 있지 않아도 |
| 2 | `relief device revoke <이름>` | 자격 삭제, 그 기기 세션 전부 종료 |
| 3 | 동기화 패스키라면 공급자 계정에서 기기 제거, 다른 기기 재등록 | 복제본 차단 |
| 4 | 쓰기를 허용한 기기였다면 KMS 암호 교체 | 자동 입력 복제본 차단 |

Tailnet Lock을 켠 경우 재등록에 서명이 필요하다. 사용자가 전화기만 들고 있을 때는 1번은 되고 2번은 못 한다. 그래서 1번만으로 통로가 끊기는지가 Phase 검증이다.

### 8B.4 기기별 권한

서버의 기기 표로 강제한다. 사용자 에이전트 문자열을 믿지 않는다.

| 기능 | Windows | 태블릿 | 전화기 |
|---|---|---|---|
| 지도, 패널, 상태 | 허용 | 허용 | 허용 |
| PC, 노드 깨우기 | 허용 | 허용 | 허용 |
| 시작, 종료, 재부팅 | 허용 | 2차 | 2차 |
| 강제 중지, 재설정 (L3) | 허용 | 금지 | **금지** |
| 터미널 | 허용 | 금지. O23 | **금지** |

- **처음에는 읽기 전용이다.** 깨우기만 예외다. 끄는 동작이 없고 비밀이 없다.
- **터미널 금지 이유.** 전화기를 잃으면 패스키 하나 뒤에 셸이 있다. 터치 키보드에서 잘못된 입력의 비용도 root에서는 크다. PVE 콘솔은 사용자의 PVE 로그인으로 그대로 쓸 수 있다.
- 쓰기 2차는 8A.2절의 KMS 로그인을 거친다.

### 8B.5 PWA

| 항목 | 결정 |
|---|---|
| 형태 | 홈 화면 PWA. iOS와 Android 모두. 앱 스토어 앱을 만들지 않는다 |
| 조건 | HTTPS, `manifest`, `display: standalone`, 서비스 워커 |
| 캐시 | 정적 자산만. `/api/*`는 `no-store`이고 서비스 워커가 건드리지 않는다. **오프라인 지도를 두지 않는다.** 기기에 재고가 남으면 안 된다 |
| iOS 저장소 | 홈 화면 앱은 브라우저와 같은 할당량이다 [출처: WebKit]. 저장소가 지워져도 다시 인증하면 된다 |
| 확인할 일 | **iOS 홈 화면 앱 안의 WebAuthn을 확인하지 못했다** [검색]. Phase 3m 첫 시험이다. 안 되면 Safari 탭으로 쓴다 |
| 알림 | 범위 밖 |

### 8B.6 화면에 주는 영향

결과만 적는다. 데스크톱 UI는 다른 작업자가 만들고 있다.

- 호버가 없다. 호버 전용 정보는 탭과 패널로 간다. 구멍과 경고가 호버 뒤에 숨으면 안 된다.
- 좁은 폭이 셋이다. 태블릿은 지도와 패널을 나란히, 전화기와 접는 전화기의 바깥 화면은 패널이 아래 시트로, 펼친 화면은 그 사이다. 접고 펼 때 선택과 위치를 유지한다.
- 2.5D 지도의 팬과 핀치는 페이지 확대와 충돌한다. 500객체 SVG 성능은 모바일에서 재지 않았다. `relief.md` 10절의 출구 조건을 기기에서 다시 잰다.
- 라벨 12 px 고정, 터치 대상 크기, 2D 기본값 여부를 다시 본다. 좁은 화면은 2D나 목록(`role="tree"`)이 기본일 수 있다.
- 키보드 표는 쓸 수 없다. 패널 버튼으로 대체한다.

## 8C. 전원 켜기

**사용자 요구(2026-11-01).** 서버와 PC를 켠다. 끄기는 기존 쓰기 경로이고 바뀌지 않는다.

**결론: relief VM이 같은 LAN에 매직 패킷을 직접 보낸다.** 권한도 비밀도 필요 없다. 다만 **잠든 기계는 자기를 깨우지 못하므로, 노드가 전부 꺼지면 relief도 꺼져 있고 이 경로가 없다.**

### 8C.1 누가 패킷을 보내는가

| 상태 | 대상 | 집 안 | 집 밖 |
|---|---|---|---|
| 노드 켜짐, PC와 WSL 잠듦 | PC | relief VM | relief VM. **첫 사용 사례** |
| 노드 일부 꺼짐 | 꺼진 노드 | relief VM(살아 있는 노드 위일 때) | 같음 |
| ops 노드만 꺼짐 | 그 노드 | 전화기 WoL 앱, 라우터 WOL | **보낼 곳 없음** |
| 노드 전부 꺼짐, PC 잠듦 | 전부 | 전화기 WoL 앱, 라우터 WOL | **보낼 곳 없음** |

**WSL은 보내는 쪽이 될 수 없다.** Windows와 함께 잠든다. 집 안에서는 Wi-Fi의 전화기가 같은 브로드캐스트 영역에 있어 직접 보낼 수 있다. 이것은 만들 것이 없다.

**상시 켜 둘 노드.** ops VM이 있는 노드가 꺼지면 relief도 없다. **세 노드를 모두 켜 둔다.** 전기를 아끼려 세 번째를 끄면 두 노드만 남아 **어느 하나가 고장 나는 순간 쿼럼을 잃고** 대기 VM을 시작할 수 없다. 그 노드가 ops 노드면 집 밖 깨우기도 함께 없어진다(`kms.md` 3.1절). 세 번째를 끄는 것은 그 위험을 받아들일 때만이다(O40).

**집 밖 + 전부 꺼짐의 답은 작은 상시 장치뿐이다.** 소형 장치에 Tailscale과 깨우기 페이지 하나를 둔다. 오늘 세 노드는 계속 켜져 있으므로 [측정: 모두 online] 사용자가 실제로 노드를 끄는지부터 정한다(O24). 정전 복구는 BIOS의 AC 복구 설정이 먼저다.

한 노드만 켜 두는 방법은 쓰기 어렵다. 다수가 없으면 클러스터는 읽기 전용이 된다 [출처: Cluster Manager]. 켜 있던 VM이 계속 도는지와 새로 시작되는지는 재지 않았다.

### 8C.2 방법 비교

| 기준 | **relief VM 브로드캐스트 (채택)** | PVE `wakeonlan` | BMC Redfish, IPMI | 라우터 WOL | 스마트 플러그 |
|---|---|---|---|---|---|
| 권한 | 없음. `node:dgram` | **`Sys.PowerMgmt` on `/nodes/{node}`** [출처: 스키마] | BMC 자격 | 라우터 관리자 | 클라우드 계정 |
| 전부 꺼짐 | 불가 | 불가. 보낼 노드가 켜져 있어야 한다 [가정] | **가능.** BMC는 대기 전원으로 돈다 | 라우터는 켜져 있다 | 가능 |
| PC | 가능 | 노드 전용 | PC에 BMC 없음 | 가능 | 하드 전원 |
| NIC, BIOS 의존 | 있음 | 있음 | 없음 | 있음 | AC 복구 설정 |
| 집 밖 | relief 경유 | relief 경유 | 상시 장치 필요 | 외부 접속 설정 필요 | 공급자 앱 |
| 판정 | **채택** | **기각** | 나중, 노드 전용 | 집 안에서만 | 기각 |

- **PVE `wakeonlan` 기각.** 같은 `Sys.PowerMgmt`가 `POST /nodes/{node}/status`의 노드 재부팅과 종료를 연다 [출처: 스키마]. 켜려다 끄는 권한을 준다. 3.2절의 "노드 전원 만들지 않음"과 충돌한다. MAC을 PVE 설정(`PUT /nodes/{node}/config`, `Sys.Modify`)에 두는 것도 불필요하다.
- **BMC 나중.** 가장 믿을 만한 전원 경로다. 그러나 BMC 자격과 BMC 네트워크가 필요해 8.3절의 결정과 충돌하고, BMC 펌웨어 취약점 확인(O9) 전에는 Redfish에 붙지 않는다. 상시 장치가 생기고 O9가 끝나면 다시 본다. 집 안에서는 BMC 웹 화면을 사람이 직접 쓸 수 있다.
- **라우터 WOL.** 관리 화면에 PC를 등록하는 기능이 있고 앱도 있다 [검색: 블로그]. 집 안 예비 경로로 좋다. 집 밖 사용은 라우터 외부 접속을 열어야 하므로 기각한다. 라우터 API가 없어 relief가 부르지 못한다 [출처: `relief.md` D3].
- **스마트 플러그 기각.** 전원을 끊었다 잇는 하드 전원이고, 클라우드 계정이 비밀과 공격면을 더한다. BIOS AC 복구와 조합해야 켜진다. 서버에 BMC가 있어 값어치가 없다. 멈춘 PC를 살리는 용도라면 나중에 본다.

### 8C.3 네트워크

| 질문 | 답 | 근거 |
|---|---|---|
| 라우터 LAN 안 | 됨. 같은 L2 브로드캐스트다. Wi-Fi에서 보내 유선을 깨워도 된다 [가정: 공유기가 브리지] | Phase에서 시험 |
| WAN에서 LAN으로 | **안 된다.** 포트 포워드 0개이고 포워드로 브로드캐스트를 보내는 방법은 장비마다 다르다 | [검색: 블로그]. 하지 않는다 |
| Tailscale 넘어로 | 믿지 않는다. 서브넷 라우터는 네트워크 계층이다 | [출처: Subnet 문서], 커뮤니티 보고가 엇갈린다 [검색]. **패킷은 LAN 안의 VM이 보낸다** |
| VM에서 LAN으로 | `vmbr0`가 브리지라 나갈 것이다 [가정]. PVE 방화벽 규칙은 0건이다 [측정: `relief.md` Q2] | Phase 시험 |

**켜기 전에 사람이 확인할 설정.** 값을 저장소에 적지 않는다.

| 대상 | 확인 |
|---|---|
| 노드 BIOS | Wake on LAN 또는 Power on by PCI-E 켬, ErP/EuP 끔, AC 복구 동작 |
| 노드 OS | `ethtool <if>`의 `Wake-on: g`. 재부팅 뒤 유지되는지 |
| 노드 NIC | 꺼진 상태에서 링크 불이 살아 있는지. 어느 포트가 깨우는지 |
| PC | **유선.** BIOS WoL 켬, 메인보드의 깊은 절전 끔, 장치 관리자에서 NIC의 매직 패킷 깨우기 |
| PC 전원 상태 | **Windows의 빠른 시작은 S5/S4에서 NIC를 깨우지 않는다.** S3 잠자기와 명시적 최대 절전은 된다 [출처: Microsoft, 2026-02-12] |
| PC 대기 방식 | `powercfg /a`로 S3인지 Modern Standby인지 본다. 후자는 재지 않았다 |

### 8C.4 설계

| 항목 | 결정 |
|---|---|
| 코드 | relief 서버의 `wake.ts`. `node:dgram`, UDP 9, LAN 브로드캐스트. 자격이 없어 `relief-act`에 둘 이유가 없다. PVE 쓰기가 아니므로 3.8절의 불변식이 유지된다 |
| 대상 | `~/.config/relief/wake.json`(VM, 600). `key`, `title`, `mac`, `strictObject`. **실제 MAC은 저장소, KB, 스냅샷, 로그에 없다.** 라우트는 `key`만 받는다 |
| 확인 | PC: 대상 이름을 보이는 확인 창 한 번. 노드: 추가로 패스키 재확인 |
| 결과 표시 | **"패킷 보냄"과 "켜짐 확인"을 나눈다.** WoL에는 응답이 없다. `health`와 PVE `online`으로 2 min까지 본다 |
| 감사 | `audit.jsonl`에 기기 이름, `key`, 결과. MAC 없음 |
| 속도 | 대상당 60 s에 1회, 전체 10 min에 5회 [가정]. **"전부 깨우기"를 두지 않는다** |
| KMS | 필요 없다. KMS VM이 꺼진 노드에 있어도 동작한다 |

**피해 범위.**

| 대상 | 잘못 눌렀을 때 |
|---|---|
| PC | 켜진다. 전기와 소음. 데이터 위험 없음 |
| 노드 | 부팅, 클러스터 합류, `onboot` 게스트 자동 시작. KMS VM이 있으면 봉인 상태로 뜬다(`kms.md` 4절) |
| 공통 | 끄는 경로가 없다. 공격자가 얻는 것은 전기 요금과 소음이다 |

WoL은 인증이 없는 프로토콜이다. LAN의 누구나 깨울 수 있고 이것은 지금도 그렇다. SecureOn 암호는 쓰지 않는다.

**첫 사용 사례.** 전화기 → 오버레이 → relief VM → PC. Phase 3w까지 끝나면 된다. Windows가 S3에 있어야 한다.

## 8D. relief에서의 KMS 접근

**사용자 요구(2026-11-01).** 같은 관제 화면에서 키와 서비스 계정을 다룬다. 다만 전화기가 닿는 relief가 비밀을 훔치는 길이 되면 안 된다.

**결론. relief는 메타데이터만 읽는 계정 하나를 갖는다. 값이 relief를 지나가는 경로는 없다.** 관리는 KMS 자기 화면으로 보내고, 값 공개는 relief 어디에도 만들지 않는다.

| 층 | 내용 | 어디서 | 누구의 신원 | 기기 |
|---|---|---|---|---|
| 1 상태 | 봉인, 건강, 비밀 이름, 소유 서비스, 만료, 마지막 교체, 감사 요약 | **relief** | relief의 `svc-relief-meta` | 전 기기. 전화기는 이름 목록에 패스키 재확인 |
| 2 관리 | 키 추가, 부여, 교체, 폐기 | **KMS 화면 또는 `kms` 명령** | 사람의 KMS 계정 | **데스크톱만** |
| 3 값 보기 | 값 표시 | **relief에 없다** | 비상시 `owner`가 터미널에서 | relief 없음 |

### 8D.1 relief가 KMS 자격을 갖는가

| 기준 | **메타 전용 계정 + 관리 링크 아웃 (채택)** | relief가 관리 계정 보유 | 브라우저가 KMS API 직접 | 관리 화면 재구현 |
|---|---|---|---|---|
| 값이 relief를 지나감 | 아니오 | **예** | relief UI 번들이 본다 | **예** |
| relief 침해 피해 | 이름과 일정 노출 | **KV 전체** | npm UI가 토큰과 값을 본다 | 같음 |
| KMS 네트워크 | ops에서 8200 | 같음 | **전화기에 KMS를 열어야 한다** | 같음 |
| 만들 것 | 적음 | 많음 | CORS 설정 | 가장 많음 |
| 판정 | **채택** | 기각 | 기각 | 기각 |

**브라우저 직결을 기각하는 이유.** 사용자의 신원으로 부르는 것은 맞지만, 부르는 페이지가 relief 출처이면 relief의 npm 번들이 토큰과 값을 본다. KMS의 신원은 KMS의 출처에서 써야 한다. 그래서 링크 아웃이다.

**`svc-relief-meta` 정책.** 값 경로가 없다. 정확한 정의는 `kms.md` 6.8절이다.

```hcl
path "sagae/metadata/*"            { capabilities = ["read", "list"] }
path "sagae/data/_status/summary"  { capabilities = ["read"] }
path "sys/health"                  { capabilities = ["read"] }
```

### 8D.2 층 2: 관리

- relief 패널의 버튼은 고정 주소의 KMS 화면을 새 창으로 연다. 주소는 설정 값이고 입력을 받지 않는다.
- **값은 KMS 화면이나 `kms` 명령에 직접 입력한다. relief 화면에는 값 입력 칸이 없다.** 이것을 규칙으로 사용자에게 보인다. 침해된 relief가 가짜 입력 칸을 내도 "relief는 값을 묻지 않는다"로 알아챌 수 있어야 한다.
- 화면용 계정은 **쓰기 전용**이다. KV `data`에 `create`, `update`만 있고 `read`가 없다(`kms.md` 6.8절). 화면에서 값이 보이지 않는다.
- **동작마다 패스키를 재확인할 수 없다.** OpenBao 로그인 MFA는 TOTP, Okta, Duo, PingID다 [출처: Login MFA]. 재확인 단위는 TOTP 로그인과 15 min 토큰이다. 요청과 다르다.
- `services.yaml` 소비자 변경과 정책 생성은 화면이 하지 못한다. 키 값 입력은 화면으로 되지만 **부여는 `kms` 명령이다.**

**전화기에서 관리하지 않는다.** KMS VM은 오버레이 밖이고 그대로 둔다. 집 밖 긴급 폐기는 공급자 화면에서 한다. 외부 키의 진짜 폐기가 거기 있다(`kms.md` 7.2절). 전화기에서 계정 비활성까지 원하면 별도 설계다(O29).

### 8D.3 층 3: 값 보기

**만들지 않는다.** 정당화되지 않는다. 값이 필요한 사람은 공급자 화면에서 새로 발급하면 된다. 렌더 파일은 서비스가 쓴다. 사람이 값을 봐야 하는 일은 없고, 보는 순간 화면, 전사, 스크린샷으로 샌다. 비상시 `owner`로 터미널에서 읽는 길은 KMS 자체에 남고 감사된다.

### 8D.4 침해 피해

| 침해 | 얻는 것 | 얻지 못하는 것 |
|---|---|---|
| relief 서버 | 비밀 이름, 소유 서비스, 만료, 사용 요약, 기기 표 | 값, 관리, 봉인 조작 |
| 전화기 | 위 목록 일부 | 값, 관리 |
| relief UI 번들 | 위와 같다. 가짜 입력 칸을 낼 수 있다 | 진짜 KMS 화면의 입력 |
| `relief-act` | PVE 쓰기 토큰, 창 안의 `relief-writer` 입력 | 다른 비밀 |
| 가짜 링크 | 침해된 relief가 KMS 주소를 바꿔 피싱 | 사용자가 북마크로 들어가면 막힌다. **KMS 화면은 북마크로 연다** |

이름 목록도 정찰 자료다. 어떤 공급자를 쓰는지, 무엇이 곧 만료되는지 알려 준다. 그래서 전화기는 건수만 보이고 이름에 재확인을 둔다.

### 8D.5 지도의 KMS

`kms` kind 객체를 KMS VM 위에 그린다. 새 어댑터는 값을 읽지 않는다.

| 상태 | 뜻 | 그림 |
|---|---|---|
| 정상 | 봉인 해제, 건강 | 기본 |
| **봉인** | 응답하나 봉인 | 경고. "사람이 조각 입력 필요" |
| 응답 없음 | VM 다운이나 네트워크 | 낡음. 봉인으로 추측하지 않는다 |
| 미확인 | 계정 없음 | 빈 상자 |

| 경고 | 조건 | 표시 |
|---|---|---|
| 곧 만료 | `expires_at` 14일 안 | 건수, 3일 안이면 강조 |
| 만료됨 | 지남 | 강조 |
| 범위 없음 | 메타데이터에 `scope`가 없음 | 패널 |
| 교체 오래됨 | 90일 넘음 [가정] | 패널 |
| 스냅샷 낡음 | 요약의 마지막 스냅샷이 2일 넘음 | 경고 |

주기: 상태 60 s, 메타데이터 1 h. 값이 없으므로 스냅샷에 넣어도 되지만 이름은 패스키 세션 뒤에만 나간다.

## 8E. 이름: 서브도메인 라우팅

**사용자 요구(2026-11-01).** relief, Proxmox 같은 서비스에 IP와 포트 대신 사용자 도메인 아래의 고정된 이름을 준다. 네트워크를 설계보다 넓히지 않는다. 문서는 `internal.example`, `public.example`, `private.example`만 쓰고 실제 이름은 저장소에 없다(8E.7절).

**결론. 내부 전용이다. 공개 포트 0을 유지한다.**

| 질문 | 결정 |
|---|---|
| 이름 | **안쪽은 `<서비스>.internal.example`, 바깥은 `public.example`의 명시한 이름.** 도메인이 다르다 |
| 해석 | **분할 DNS.** 서비스 이름은 오버레이 안에서만 풀린다. 공개 DNS에 서비스 이름 레코드가 없다 |
| 라우터 | ops VM의 Caddy. 오버레이 주소에만 바인딩 |
| 인증서 | `*.internal.example` 와일드카드 하나, ops에만. DNS는 Cloudflare, 챌린지는 CNAME으로 deSEC에 위임. 공개 서비스는 자기 인증서 |
| 소유 | 새 도구 **`gate`**. 선언 파일이 원본이고 relief는 읽기만 한다 |
| KMS | **라우트 없음** |

### 8E.1 통로 비교

| 기준 | Tailscale `serve`와 MagicDNS | **Caddy + 오버레이 (채택)** | 공개 DNS + 공개 포워딩 |
|---|---|---|---|
| 사용자 도메인 | **아니오.** `*.ts.net`뿐이고 MagicDNS에 임의 레코드를 못 넣는다 [출처: Tailscale DNS] | 예 | 예 |
| 공개 포트 | 0 | **0** | **1개 이상** |
| 라우트별 규칙 | 없음 | 있음 | 있음 |
| TLS 종료 | ops VM | ops VM | ops VM |
| 요구 | 없음 | 인증서 자동화 | 포트, DDNS |
| 판정 | 대체 경로 | **채택** | **관리 서비스에는 기각** |

**이름 구조.** 사용자 제안이고 이 설계도 권한다. **바깥용 `public.example`과 안쪽용 `internal.example`을 나눈다.** 안쪽 도메인은 새로 산다. `*.internal.example` 안을 대체한다.

| 기준 | **별도 등록 도메인 (채택)** | `*.internal.example` (이전 안) | `.internal`, `home.arpa` 사설 이름 |
|---|---|---|---|
| 공개 DNS에서 서비스 이름 | **없음** | 없음 | 없음 |
| 공개 인증서 | 된다 | 된다 | **안 된다.** 내부 이름은 공개 CA가 발급하지 못한다 [출처: CA/B Forum]. 사설 CA를 기기마다 넣어야 한다 |
| 패스키 RP ID | 등록 가능 도메인 | 같음 | 기기 CA에 기댄다 |
| 등록 기관 제약 | 없음. Cloudflare로 샀다 | 알 수 없는 `public.example` 등록 기관에 묶인다 | 없음 |
| 브랜드와 분리 | **완전히** | 같은 도메인. 사고와 설정이 섞인다 | 완전히 |
| DNS 토큰 범위 | `_acme-challenge` TXT까지 좁힌다 | 챌린지 존 | 해당 없음 |
| 비용 | 도메인 비용. 구입 완료 | 0 | 0 |
| 판정 | **채택** | 철회 | **기각** |

**`.internal` 기각.** ICANN이 2024-07-29 결의로 사설용으로 영구 예약했다 [출처: draft-davies-internal-tld, 위키 요약]. 공개 ACME가 발급할 수 없어 `*.internal.example`의 자리를 대신하지 못한다. 전화기 셋에 사설 CA를 넣는 비용은 8E.2절의 내부 CA 기각 사유와 같다. 이 문서의 `internal.example`은 자리표시 이름이고 `.internal` TLD가 아니다.

| 규칙 | 내용 |
|---|---|
| 해석기 | ops VM의 작은 DNS 서버를 오버레이 주소에만 바인딩. `gate`가 내용을 생성한다. Tailscale 분할 DNS로 `internal.example`만 그리로 보낸다 [출처: Tailscale DNS] |
| ACL | 사용자 기기 → ops의 53, 443 |
| 고장 | 해석기는 라우터와 같은 VM이라 함께 죽는다 |
| **공개 DNS** | `internal.example`의 공개 존에는 NS, SOA, CAA, `_acme-challenge` CNAME만 있다. **서비스 이름 레코드도 와일드카드도 없다** |
| 공개되는 것 | 도메인이 있다는 것과 CT의 `*.internal.example`뿐이다. 개별 이름은 없다. 도메인 이름에 브랜드와 이어지는 말을 쓰지 않는다. WHOIS 비공개를 켠다 |
| DNSSEC | 공개 존 서명이 내부 응답과 어긋날 수 있다. 처음에는 끄고, 검증하는 스텁에서 실패하는지 Phase 3n에서 기기 셋으로 잰다 [가정] |

**공개 포워딩 기각.** 8B.2절의 이유와 같다. 전원을 끄는 앱과 PVE를 인터넷에 내놓지 않는다.

**게임 포트는 다른 문제다.** 공개 게임 서비스는 HTTP가 아니다. 라우터를 지나지 않고 라우터 포트 포워드 하나와 SRV 레코드로 된다.

| 항목 | 내용 |
|---|---|
| 뜻 | "공개 포트 0"이 "1"이 된다. `edge.json` `portForwards`에 선언한다 |
| 위험 | **LAN이 평평하다.** VLAN이 없어 [측정: `relief.md` Q2] 침해된 게임 VM은 노드, BMC 네트워크에 닿는다. KMS 방화벽은 막지만 BMC는 아니다. 8.2절의 CVE 확인이 먼저다 |
| 이름 | `_<서비스>._tcp.play.public.example` SRV. 대상은 A 레코드 이름이어야 한다 [출처: 게임 위키, 가정] |
| 결정 | 이 절의 범위 밖이다. 사용자 결정 O30 |

### 8E.2 인증서와 DNS 호스트

와일드카드는 DNS-01만 된다 [출처: Let's Encrypt]. **`internal.example`은 Cloudflare Registrar로 샀다**(사용자, RDAP 확인, 2026-11-01. 1년, 전송 잠금). Cloudflare Registrar의 도메인은 Cloudflare 네임서버를 써야 하므로 [출처: Registrar FAQ] **DNS 호스트는 Cloudflare로 정해졌다.** 이전 판의 Porkbun + deSEC DNS는 철회한다.

**DNS-01 토큰을 어디에 둘 것인가.**

| 기준 | a 존 토큰을 ops의 `lego`에 | **b `_acme-challenge` CNAME + deSEC (채택)** |
|---|---|---|
| Cloudflare에 할 일 | API 토큰 발급 | CNAME 한 줄, DNS 전용 |
| 토큰이 쓰는 곳 | Cloudflare 존 | deSEC의 챌린지 이름 하나 |
| 범위 | 존, IP, TTL로 제한. 레코드 단위 제한은 문서에 없다 [출처: Create token] | **TXT, 그 이름 하나** [출처: deSEC Tokens]. `max_age` |
| 토큰 도난: 공개 A 레코드 생성 | **가능** | 불가 |
| 토큰 도난: CAA 변경 | **가능.** `accounturi`와 `sys` 금지를 지운다 | **불가.** 존이 다르다 |
| 토큰 도난: `kms.sys` 공개 인증서 | **가능.** 8E.2의 KMS 보호가 무너진다 | 불가 |
| 토큰 도난: `*.internal.example` 인증서 | 가능 | 가능. `accounturi`가 막는다 |
| 고장 지점 | Cloudflare 하나 | deSEC가 내려가면 갱신이 밀린다. 인증서 수명 안에 복구하면 된다 |
| 계정 | 없음 | 무료 deSEC 계정 하나 |
| 공식 지원 | lego 지원 | CNAME 위임은 공식 방법이고 [출처: Let's Encrypt] lego가 deSEC를 지원한다 [출처]. 조합은 재지 않았다 |
| 판정 | 대안 | **채택** |

**판정 이유.** a에서는 전화기가 닿는 ops VM의 토큰 하나가 이 절의 모든 경계를 지운다. b는 한 줄과 계정 하나를 더 쓰고 토큰의 피해를 인증서 발급 시도 하나로 줄인다. deSEC 고장에 대비해 갱신 실패 경보를 두고, 긴 장애면 사용자가 수명이 짧은 Cloudflare 토큰으로 수동 갱신한다.

| 항목 | 결정 |
|---|---|
| 토큰 | `gate-dns`. deSEC 기본 정책 쓰기 거부, 챌린지 이름 TXT만 쓰기 [출처: deSEC Tokens]. `max_age` 90일, KMS 메타데이터에 만료. `DESEC_TOKEN_FILE`로 파일에서 읽는다 [출처: lego] |
| Cloudflare 쓰기 토큰 | **만들지 않는다.** 읽기 전용 토큰은 8F.3절 |
| 소유 | `svc-gate`, T1. `lego`만 받고 Caddy는 받지 않는다 |
| 인증서 | `*.internal.example` 하나, ops VM에만. 90일, 자동 갱신 |
| **CAA** | `issuewild`를 Let's Encrypt와 이 ACME 계정(`accounturi`)으로 묶는다 [출처: RFC 8657, 검색]. `sys.internal.example`에 `issue ";"`, `issuewild ";"` |

**Cloudflare 존의 규칙.**

| 규칙 | 내용 |
|---|---|
| **프록시 끔** | 주황 구름은 트래픽을 Cloudflare로 돌리고 Cloudflare 인증서로 서비스한다 [출처: Proxied DNS records]. 이 존에 프록시 레코드를 두지 않는다. 내부 이름이 공개된다 |
| A, AAAA, 와일드카드 | **없다.** 레코드는 NS, SOA, CAA, `_acme-challenge` CNAME(DNS 전용)뿐이다 |
| **Universal SSL 끔** | **Universal SSL이 켜진 존에 CAA를 넣으면 Cloudflare가 자기 CA의 CAA를 자동으로 더한다** [출처: CAA records]. `accounturi` 제한을 넓히는 일이다. 프록시 레코드가 없어 잃는 것이 없다. **CAA를 넣기 전에 끈다** [출처: Disable Universal SSL]. 공개 해석기의 DoH로 CAA를 읽어 확인한다 |
| Tunnel, Workers, 그 밖의 기능 | 쓰지 않는다 |
| DNSSEC | 처음에는 끈다. 켜려면 8E.1절의 기기 시험 뒤에 |
| `accounturi` 입력 | Cloudflare CAA 화면이 매개변수를 받는지 문서에 없다 [출처: CAA records]. Phase 3n 첫 시험이다 |

**Cloudflare 계정이 이제 이 도메인의 인증서를 쥔다.** 계정을 빼앗기면 CAA를 지우고 무엇이든 발급한다. 토큰 범위로 막을 수 없는 위다. 사용자가 할 일이다.

| 항목 | 내용 |
|---|---|
| 2단계 | 보안 키 둘 이상. 공식 문서도 요소 둘 이상과 여러 키를 권한다 [출처: Cloudflare 2FA]. 이메일 코드에 기대지 않는다 |
| 복구 코드 | 암호 관리자와 복구 키트. 재발급하면 옛 코드가 무효다 [출처] |
| 메일 계정 | 가입 메일이 재설정 경로다. 같은 수준의 2단계 |
| 암호 | 고유값, 암호 관리자 |
| Global API Key | **쓰지 않는다.** 전체 권한이고 범위, 만료, IP 제한이 없다 [출처: API keys]. 유출이 의심되면 교체 |
| API 토큰 | 읽기 전용 하나(8F.3절). 쓰기는 비상시에만 존 하나, 짧은 TTL로 만들고 지운다 |
| 구성원 | 사용자 혼자 |
| 등록 | 전송 잠금 유지, 자동 갱신, 결제 수단 유효 |
| KMS | 이 계정의 자격을 KMS에 넣지 않는다. **KMS 복구에 도메인이 필요 없고, 도메인 복구가 KMS에 묶이면 안 된다** |

**토큰을 좁혀도 남는 것.** `_acme-challenge` TXT를 쓸 수 있으면 그 이름의 인증서를 받을 수 있다. `accounturi`가 다른 계정의 발급을 막는다. 사칭하려면 오버레이 안에서 DNS까지 바꿔야 한다.

**기각.** 내부 CA: Android 7 이후 앱은 사용자 CA를 믿지 않고 [출처: OWASP MASTG] Chrome의 현재 동작은 확인하지 못했다. 기기를 잃을 때마다 다시 한다. Tailscale 인증서: `*.ts.net`뿐이다. 대체 경로로만 남긴다. HTTP-01: 80을 공개해야 하고 와일드카드가 안 된다 [출처: Let's Encrypt]. 자체 `acme-dns`: UDP 53을 공개해야 한다.

**토큰을 라우터에 두지 않는다.** Caddy의 DNS 챌린지는 공급자 모듈이 든 맞춤 빌드가 필요하다 [검색]. 전화기가 닿는 프로세스에 DNS 토큰을 두는 것도 피한다. 그래서 **표준 Caddy는 인증서 파일만 읽고**, `lego`를 별도 Unix 사용자 `gate-cert`의 타이머로 돌려 갱신한다.

**인증서 하나가 모든 이름을 덮는 위험.**

| 키 | 있는 곳 | 훔치면 | 대응 |
|---|---|---|---|
| `*.internal.example` | ops VM, `gate` 사용자 | 한 단계 아래 모든 이름을 유효한 인증서로 사칭한다. **오버레이 안의 위치가 필요 없다.** 오버레이가 꺼진 기기를 가짜 DNS나 Wi-Fi로 끌면 된다 | 수명 90일. 아래 |
| 공개 서비스 인증서 | 공개 호스트나 호스팅 | 그 이름만 | **공유하는 것이 없다.** 다른 도메인이고 다른 호스트다 |
| KMS 인증서 | KMS VM | KMS만 | 와일드카드 밖. 아래 |

**훔친 와일드카드로 가짜 `relief-act`가 뜬다.** 브라우저에는 진짜와 같은 출처다.

| 입력 | 가짜 화면에서 | 남는 것 |
|---|---|---|
| 패스키 | 같은 이름이므로 서명은 된다. 그러나 **그 도전값에만 묶인다.** 진짜 서버로 실시간 중계하려면 오버레이가 필요하다. 재사용은 안 된다 | 오버레이에 있는 공격자의 중계 |
| `relief-writer` 암호 + TOTP | **그대로 넘어간다.** 암호는 남고 TOTP는 곧 만료된다 | 암호 유출. 쓰려면 KMS에 닿아야 하고 KMS는 ops와 LAN에서만 열린다 |
| 값 | 없다. relief 쪽 화면은 값을 묻지 않는다(8D.2절) | |

쓰기 잠금을 패스키에 묶는 것이 가장 낫지만 act는 npm이 없어 WebAuthn 라이브러리를 쓸 수 없고 KMS는 패스키를 받지 않는다. **남은 위험으로 적어 둔다.** 기기의 Tailscale을 항상 켜고 오버레이가 꺼졌을 때 쓰기를 하지 않는다. 키 유출이 의심되면 인증서를 폐기하고 `relief-writer` 암호를 교체한다.

**KMS 이름은 와일드카드 밖에 둔다.** 해석기와 와일드카드 키가 모두 ops에 있다. `kms.internal.example`이면 ops 침해가 유효한 인증서의 가짜 화면으로 KMS 암호를 낚는다. **`kms.sys.internal.example`은 두 단계라 `*.internal.example`이 덮지 않는다.** 사설 CA를 데스크톱에만 넣는 것은 그대로다.

**KMS 이름은 ops 해석기에 기대지 않는다.** KMS는 LAN 직결인데 이름이 ops DNS를 지나면 ops나 오버레이가 죽었을 때 복구 화면을 찾지 못한다. 그것이 KMS가 가장 필요한 때다. 데스크톱의 `hosts` 파일에 `kms.sys.internal.example`을 KMS 주소로 적는다. 사설 CA 인증서 사본은 복구 키트에 둔다. 브라우저가 CA를 잃어도 WSL에서 `bao`에 주소와 `-ca-cert`로 붙는다(`kms.md` 6.8절). KMS VM 주소는 정적이다.

이 모델에서 더 좋아진 점이 있다. `sys.internal.example`에 CAA `issue ";"`와 `issuewild ";"`를 두면 공개 CA가 그 아래를 아예 발급하지 않는다. `gate-dns` 토큰은 `_acme-challenge.sys`를 쓸 수 없으므로 ops가 침해돼도 그 이름의 공개 인증서를 받지 못한다. 공개 레코드에는 `sys` 라벨만 보인다.

### 8E.3 라우터

| 항목 | 결정 |
|---|---|
| 제품 | Caddy 2.11.7, Apache-2.0 [측정]. 표준 빌드 |
| 기각 | Traefik 3.7.17(라우터에 토큰이 들어간다, 동적 설정이 이 규모에 넘친다), nginx(갱신과 재적재를 직접 맞춘다), `tailscale serve`(자기 도메인이 안 된다) |
| 위치 | ops VM, Unix 사용자 `gate` |
| 바인딩 | **오버레이 주소의 443만.** LAN, 80, 0.0.0.0 없음. 자동 HTTPS 끔 |
| **관리 API** | 기본 `localhost:2019`는 인증이 없다. 다른 Unix 사용자가 설정을 바꿔 입구를 가로채고 인증 입력을 모을 수 있다. **`admin unix//run/gate/admin.sock`, 디렉터리 `gate` 전용 700** [출처: Caddy 옵션, API]. 재적재는 `gate apply`만 한다 |
| 뒤쪽 | 같은 VM의 `127.0.0.1` 서비스뿐. PVE를 대상으로 두지 않는다 |

**대상과 DHCP.**

| 대상 | 주소 | 처리 |
|---|---|---|
| ops VM | 정적. 오버레이 주소는 LAN 임대와 무관하다 | 이름이 DHCP의 영향을 받지 않는다 |
| PVE 노드 | 정적 [출처: `relief.md` D7] | **라우트 없음.** 직접 연결 |
| 다른 VM | 정적으로 만든다 | 임대면 라우트를 받지 않는다 |
| WSL | **라우트 없음.** 서비스가 127.0.0.1이고 잠든다 | 필요해지면 ops로 옮긴다 |
| Windows PC | 라우트 없음 | 깨우기는 8C절 |

실제 주소와 도메인은 `~/.config/gate/site.json`(ops, 600)에만 있다. 저장소의 `routes.yaml`은 이름과 키만 있다.

### 8E.4 라우트 표의 주인

**새 도구 `gate`다.** `tools/gate`, 서버 코드 없이 선언 파일, 생성기, 검사기 약 300줄이다 [가정].

| 항목 | 결정 |
|---|---|
| 원본 | `tools/gate/routes.yaml`. 이름, 대상 키, 허용 기기 묶음, 인증 주체 |
| 명령 | `gate check`, `gate apply`(Caddy 설정 생성, 재적재), `gate status --json` |
| relief | `gate status`의 JSON 파일을 읽는다. 코드 import 없음. 라우트를 지도에 `route` 객체로, 건강과 인증서 만료를 사실로 그린다. **relief는 라우트를 고치지 못한다** |
| gate | relief를 모른다. relief 없이 돈다 |
| tower | **겹치지 않는다.** tower 마운트는 127.0.0.1의 경로 접두어 프록시로 GET, HEAD뿐이고 같은 머신 소비자용이다. gate는 호스트 이름 기준의 오버레이 입구다. tower를 gate 뒤에 두지 않는다. bearer 서비스를 원격에 내지 않는다 |

### 8E.5 보안

| 라우트 | 대상 | 허용 기기 | 인증 주체 |
|---|---|---|---|
| `relief` | 127.0.0.1:4815 | 전 기기 | 패스키 |
| `relief-act` | 127.0.0.1:4819 | 8B.4절 표 | KMS 계정 |
| `relief-term` | 127.0.0.1:4818 | **데스크톱** | 티켓, SSH 키 |
| `pve` | **없음. 철회.** PVE는 직접 연결만이다 | | |
| KMS | **없음.** 이름 `kms.sys.internal.example`만 있고 KMS VM을 직접 가리킨다 | 데스크톱 | KMS 계정 |
| tower | **없음** | | |

**KMS에 라우트를 두지 않는 이유.** Caddy가 TLS를 끝내므로 ops VM이 값을 평문으로 본다. KMS를 전화기가 닿는 호스트와 나눈 뜻이 사라진다. KMS 화면은 LAN의 데스크톱에서 자기 TLS로 연다.

**PVE를 `gate` 뒤에 두지 않는다.** 이전 판의 `pve` 라우트를 철회한다. 프록시는 TLS를 끝내므로 `gate`가 관리자 쿠키와 콘솔 티켓을 본다. `gate` 침해가 PVE 관리자, 노드 root, KMS VM으로 이어져 **VM 분리를 통째로 무효로 만든다.** PVE는 데스크톱에서 노드로 직접 연결한다(4절 링크 아웃). 집 밖과 전화기에서는 PVE를 쓰지 않는다. 4.3절의 조건은 `gate`에 적용하지 않는다.

| 규칙 | 내용 |
|---|---|
| 라우트별 허용 | Tailscale ACL은 호스트 단위라 라우트를 못 가린다. Caddy `remote_ip`로 기기의 오버레이 주소를 묶는다. 기기 표와 같은 이름을 쓴다 |
| 인증 없는 라우트 금지 | `gate check`가 `auth` 없는 라우트를 거절한다. 게이트가 인증을 대신하지 않는다 |
| Host | 정확 일치. 모르는 이름은 연결을 닫는다. 기본 사이트가 없다. 뒤쪽의 `guard.ts`도 자기 이름만 받는다 |
| 전달 헤더 | `X-Forwarded-*`를 라우터가 새로 쓴다. 클라이언트 값을 지운다 |
| **쿠키** | **호스트 전용. 상위 도메인 쿠키 금지.** `Domain=internal.example`이 하나라도 있으면 모든 서브도메인이 받는다. 앞서 찾은 쿠키 문제가 그대로 커진다. 도메인이 나뉘어 공개 쪽과는 공유될 길이 없다. relief 계열은 쿠키가 없다. `gate check`가 응답을 찾아 `Domain=`이 있으면 실패한다 |
| 패스키 RP ID | **`relief.internal.example` 정확한 이름.** 상위 도메인으로 잡으면 모든 서브도메인이 쓸 수 있다 |
| 출처 분리 | `relief`, `relief-act`, `relief-term`이 호스트로 나뉜다. 포트 분리보다 낫다. 같은 사이트이므로 Origin 검사는 그대로 둔다 |
| HSTS | 각 호스트에만. 상위 도메인에 `includeSubDomains`를 걸지 않는다 |

**8B.3절과의 관계.** 이 절이 `tailscale serve`, `*.ts.net` 출처, Serve 인증서를 대체한다. Tailscale 통로, ACL, Tailnet Lock, 기기 등록은 그대로다.

### 8E.6 A 레코드와 DDNS

| 레코드 | WAN IP 변경의 영향 | 처리 |
|---|---|---|
| `*.internal.example` | **없다.** 공개 레코드가 없고 오버레이 주소다 | 분할 DNS가 답한다 |
| `private.example`의 A 레코드 | 바뀌면 낡는다 | 지금처럼 relief의 `a-record` 경고, 사용자가 수정 |
| `public.example`의 공개 사이트 | 외부 호스팅이면 없다 | `proxies` 대상, "비교 불가" |
| 게임 이름 | **낡는다** | 포트를 연다면 DDNS가 필요하다 |

**내부 라우팅에 DDNS는 필요 없다.** 게임을 공개할 때만 필요하다. 라우터 제조사 DDNS는 무료로 라우터 제조사 도메인의 이름을 준다 [검색: 블로그]. CNAME과 SRV 조합이 되는지는 확인하지 못했다. `public.example`의 DNS API를 확인한 뒤 정한다(O28).

### 8E.7 세 도메인과 공개 서비스

사용자의 도메인은 셋이 된다. 문서는 자리표시 이름만 쓰고 실제 이름은 저장소에 두지 않는다.

| 도메인 | 쓰임 | 공개 DNS | 등록 기관 |
|---|---|---|---|
| `private.example` | **개인용. 서비스 이름을 두지 않는다** | 지금 그대로 | DNS API가 없는 등록 기관 [출처: 사용자 입력] |
| `public.example` | 외부인이 보는 이름만. **메일은 iCloud**(8F절) | 메일 레코드뿐. 루트 A 없음 [측정: 8F.3절] | 등록 기관 미확인(O28). **DNS는 Cloudflare** |
| `internal.example` | 관리와 내부 서비스 전부 | NS, SOA, CAA, 챌린지 CNAME만 | Cloudflare. DNS도 Cloudflare, 챌린지 TXT는 deSEC |

**둘 사이에 공유하는 것이 없다.** 인증서, 키, DNS 토큰, 호스트, 쿠키, 패스키 모두 따로다.

| 라우트 종류 | 이름 | 호스트 | 인증서 |
|---|---|---|---|
| 관리 | `<서비스>.internal.example` | ops VM | `*.internal.example` |
| KMS | `kms.sys.internal.example` | KMS VM | 사설 CA, 데스크톱만 |
| 공개 사이트 | `www.public.example` | **별도 호스트** | 그 이름의 인증서 |
| 공개 게임 | `play.public.example` + SRV | 게임 VM | 해당 없음 |

**공개 서비스는 relief와 KMS와 호스트를 나눈다. 필수다.**

| 공개 서비스 위치 | 공개 포트 | 판정 |
|---|---|---|
| 외부 정적 호스팅 | **0 유지** | **사이트의 기본값** |
| 별도 VM + 포트 포워드 | 1 | 필요할 때만. 8E.1절의 평평한 LAN 위험이 그대로다 |
| ops VM | | **금지** |

**`edge.json`.** `dnsRecords`는 목록이고 레코드마다 `hostname`과 `provider`가 있어 **여러 도메인을 이미 담는다** [측정: `collect/edge.ts:33`, `edgemap.ts:172`]. 어긋남 검사도 레코드마다 돈다. 부족한 점은 셋이다.

| 빈틈 | 지금 | 변경 |
|---|---|---|
| 레코드 형식 | `type`이 `'A'` 고정 | `CNAME`, `SRV`, `CAA`를 허용한다. 비교는 A만 |
| 도메인 단위 사실 | 없음 | 선택 칸 `domains: [{ key, role, registrar, dnsHost, renewBy }]`, 레코드의 `domain` 참조. `role`은 `personal`, `public`, `internal` |
| 외부 호스팅 레코드 | WAN IP와 비교되면 거짓 경고 | `proxies`를 `target`으로 쓰면 "비교 불가"다. **지금 스키마로 된다** |

**서비스 이름은 `edge.json`에 넣지 않는다.** `gate`의 것이다. `edge.json`은 공개 DNS의 선언이다.

**도메인별 검사.**

| 검사 | 도구 | 내용 |
|---|---|---|
| `a-record` | relief | 있는 그대로, 레코드마다 |
| `renew-by` | relief | 등록 만료 임박. 세 도메인 모두. **`internal.example`이 끊기면 인증서 갱신이 멈춘다** |
| `mail-guard` | **`gate check`** | `public.example`의 메일 레코드가 기대 상태와 같다(8F.5절) |
| `no-public-admin` | **`gate check`** | 공개 해석기에서 서비스 이름이 NXDOMAIN이고 공개 존의 레코드 형식이 허용 목록뿐이다 |
| `no-parent-cookie` | `gate check` | `Domain=` 없음 |
| `ct-names` | `gate check` | CT 조회에 개별 이름이 없다 |
| `caa` | `gate check` | `accounturi`와 `sys`의 금지 |

도메인별 공개 값은 relief의 `domains` 출처가 읽는다(8F절). `gate check`는 배포 전 검사이고 relief 없이 돈다.

## 8F. 도메인, DNS, 메일

**사용자 요구(2026-11-01).** `public.example`의 메일은 iCloud 사용자 지정 도메인으로 들어온다. 도메인, DNS, 메일도 지도의 일부다. relief는 Cloudflare 정보도 보여야 한다. **뒤의 DNS 작업이 메일을 깨면 안 된다.**

**결론.** 자격 없는 읽기 출처 `domains`를 더한다. 기대 상태는 `edge.json`에 선언하고 어긋나면 경고한다. Cloudflare API는 읽기 전용 토큰 하나를 뒤에 더한다. 메일함에는 닿지 않는다.

### 8F.1 `domains` 출처

| 도메인마다 | 출처 | 주기 |
|---|---|---|
| 등록 기관, 네임서버, 만료 | RDAP. IANA 부트스트랩으로 서버를 찾는다 [출처: RFC 9224] | 24 h |
| A, AAAA, MX, NS, CAA | 공개 DNS | 6 h |
| SPF(루트 TXT), DMARC(`_dmarc`), DKIM(선언한 선택자) | 공개 DNS | 6 h |
| 공개 이름의 인증서 만료 | TLS 접속. `publicNames`에 선언한 이름만 | 24 h |

`.com`, `.net`, `.dev`, `.kr` 모두 IANA 부트스트랩에 RDAP 서버가 있다 [측정: `dns.json`, 2026-10-28 판]. 없는 TLD는 등록 칸이 미확인이고 `edge.json`의 `renewBy`가 대신한다.

| 제한 | 값 |
|---|---|
| 해석기 | `relief.json`의 `dnsResolvers`, 공개 해석기 둘로 고정. 시스템 해석기를 쓰지 않는다. ops의 분할 DNS가 공개 시야를 가리기 때문이다 |
| 질의 | 선언한 도메인과 이름만. 입력을 받지 않는다. 시간 제한 5 s [가정] |
| RDAP | https만, 부트스트랩의 호스트만, 본문 64 KiB, 리다이렉트는 같은 허용 목록 안 |
| TLS | 443, SNI, 인증서만 읽고 끊는다. **내부 이름에는 접속하지 않는다** |
| 값 | 게스트 값과 같은 문을 지난다. 길이 제한, 제어 문자 제거 |
| 자격 | **없다** |
| 구현 | `node:dns`의 `Resolver`, `node:tls`, `fetch`. 새 의존성 없음 [출처: Node DNS] |

**실패는 "없음"이 아니다.** 시간 초과와 SERVFAIL은 "확인 실패"다. **NXDOMAIN이나 빈 응답을 두 해석기가 함께 줄 때만 "없음"이다.** 메일에 거짓 경보를 내지 않으려는 규칙이고 4절의 "0과 모름을 가른다"와 같다.

**이 출처는 relief의 외부 호출을 는다.** 8E.7절의 "relief는 DNS를 조회하지 않는다"를 철회한다. 공개 도메인 이름이 해석기와 RDAP 서버에 간다. 이미 공개된 값이다.

### 8F.2 기대 상태

`edge.json`의 `domains`에 선언한다. 실제 값은 저장소에 없다. `fixtures/edge.example.json`은 자리표시 이름만 쓴다.

```ts
domains?: {
  key: string; role: 'personal' | 'public' | 'internal'; name: string;
  registrar?: string; renewBy?: string;
  expect?: {
    nameservers?: string[]; apex?: string[]; caa?: string[];
    mx?: { priority: number; host: string }[]; spf?: string;
    dkim?: { selector: string; cname: string }[]; dmarc?: string;
    publicNames?: string[]; forbidNames?: string[];
  };
}[];
```

칸 없음은 "검사 안 함"이고 `[]`은 "없어야 한다"이다. 7.1절의 규칙과 같다. `internal.example`은 `apex: []`, `mx: []`이다.

| 경고 | 조건 | 심각도 |
|---|---|---|
| 도메인 만료 임박 | 30일 안, 7일 안이면 강조 | 경고 |
| 인증서 만료 임박 | 14일 안 | 경고 |
| **MX 없음** | 선언이 있고 두 해석기가 없다고 답함 | **심각. 메일이 멈춘다** |
| **MX 바뀜** | 선언과 다름 | **심각** |
| SPF 깨짐 | 없음, 둘 이상, `include:icloud.com` 없음, 문법 오류 [출처: 지원 글, RFC 7208] | 심각 |
| DKIM 어긋남 | 선언한 CNAME과 다름 | 경고 |
| DMARC 깨짐 | 없음, 문법 오류, `p=` 없음 | 경고. 없음은 오늘의 상태다 |
| 네임서버 바뀜 | 선언과 다름 | 심각. 레코드 전체가 옮겨 갔을 수 있다 |
| CAA 어긋남 | 선언 밖의 CA. Cloudflare CA가 보이면 Universal SSL이 켜졌다는 뜻이다(8E.2절) | 경고 |
| 금지 이름 등장 | `forbidNames`나 내부 이름이 공개 DNS에 보임 | 심각 |

Apple의 정확한 레코드 값은 iCloud 화면이 준다 [검색: 지원 글]. 선택자 `sig1` 등과 MX 호스트를 추측해 넣지 않고 그 화면에서 옮겨 적는다. DKIM은 선택자를 공개 DNS에서 찾을 수 없어 선언한 것만 본다.

### 8F.3 Cloudflare

| 정보 | 공개 DNS, RDAP | API |
|---|---|---|
| 네임서버, 등록 만료 | **됨** | |
| CAA, MX, TXT 값 | **됨** | |
| 존 상태(활성, 대기) | NS로 추정 | 됨 |
| 레코드 전체와 **프록시 여부** | 이름을 알아야 하고 프록시 표시는 안 보인다 | 됨 |
| SSL 모드, Universal SSL | CAA로 간접 | 추가 권한 필요. 어느 권한인지 문서가 확정하지 않는다 [출처: Permissions] |

**결정: 읽기 전용 토큰 하나를 둔다. 단 공개 출처가 먼저다.** 공개 DNS와 RDAP가 대부분을 준다. API만의 값은 존 상태와 프록시 표시다. "프록시 끔" 규칙(8E.2절)을 눈으로 확인할 유일한 길이라 값이 있다.

| 항목 | 결정 |
|---|---|
| 권한 | **Zone Read, DNS Read.** 해당 존만. 쓰기 권한 없음 [출처: Permissions, Create token] |
| SSL 모드 | 보이지 않아도 둔다. 프록시 레코드가 없으면 뜻이 없고 권한이 는다 |
| 보관 | KMS 전에는 ops의 `relief` 사용자 파일 600. 뒤에는 `sagae/relief/cloudflare-read`, T1 |
| 주기 | 6 h |
| 도난 피해 | 존의 레코드 읽기. 어차피 대부분 공개다 |
| 이전 결정과의 관계 | 8E.2절의 "Cloudflare API 토큰을 만들지 않는다"는 **쓰기 토큰**에 관한 것이고 그대로다. `lego`에는 주지 않는다 |

**`public.example`의 공개 상태**(리드가 DoH로 읽음, 2026-11-01. 값은 문서에 없다).

| 항목 | 상태 | 뜻 |
|---|---|---|
| 네임서버 | **Cloudflare** | `internal.example`과 같다. 8E.2절의 존 규칙과 DNS-01 선택이 두 도메인에 다 적용된다 |
| MX | iCloud 둘 | 기대 상태로 옮긴다 |
| SPF | iCloud 포함, `~all` | 같음 |
| `apple-domain` TXT | 있음 | 보호 대상 |
| 루트 A, 와일드카드 | 없음 | `apex: []`로 선언한다 |
| DMARC | **없음(NXDOMAIN)** | 아래 O44. `domains` 첫 실행에서 경고가 뜬다. 맞는 경고다 |
| DKIM | 확인 안 함 | iCloud 화면의 선택자로 선언한 뒤 잰다 |
| 등록 기관 | 미확인 | RDAP가 답한다 |

**읽기 토큰은 두 존을 덮을 수 있다.** 토큰은 존 단위로 고른다 [출처: Create token]. 범위는 `internal.example`과 `public.example`, Zone Read와 DNS Read만이다. 메일 레코드와 프록시 표시까지 API로 볼 수 있다.

**계정 하나가 두 도메인을 쥘 수 있다.** 두 존이 같은 Cloudflare 계정이면 그 계정의 침해는 인증서뿐 아니라 **메일 라우팅까지** 바꾼다. 8E.7절의 "공유하는 것이 없다"는 인증서, 키, 호스트 이야기이고 계정에는 해당하지 않는다. 등록 기관도 같은 계정인지 사용자가 확인한다. O37의 강화는 메일을 지키는 일이기도 하다.

**`public.example`에 CAA를 넣지 않는다.** 지금 필요가 없다. 공개 서비스를 만들 때 Universal SSL 규칙(8E.2절)을 함께 정한다. 그때 DNS-01이 필요하면 같은 CNAME 위임을 쓰되 **토큰과 ACME 계정을 따로 둔다.**

### 8F.4 메일 객체

`mail` kind를 도메인에 잇는다. `decl:mail:<key>`, 관계 `mail`: 도메인 → iCloud.

| 상태 | 조건 |
|---|---|
| 정상 | MX, SPF가 선언과 같고 DKIM, DMARC에 경고 없음 |
| 주의 | DKIM이나 DMARC 경고 |
| **깨짐** | MX나 SPF 심각 경고 |
| 확인 실패 | 해석기 실패. 낡음으로 그린다 |

**메일함에는 닿지 않는다.** 자격이 없고 만들지 않는다. "정상"은 DNS가 맞다는 뜻이지 메일이 도착한다는 증명이 아니다. 패널이 그렇게 적는다.

**DMARC 없음.** 사용자가 `_dmarc.public.example`에 TXT를 넣기를 권한다(O44). 시작은 `v=DMARC1; p=none`이다. 수신 쪽 처리를 바꾸지 않고 정책만 알린다.

- **Apple이 `p=none`을 권한다는 것은 확인하지 못했다.** Apple 지원 문서 두 쪽에는 DMARC 언급이 없었다 [출처: Apple 지원]. 공개 안내는 DMARC를 선택 사항으로 적고 정책 값을 정하지 않는다 [출처: OVHcloud]. `p=none`으로 시작하는 것은 일반 관행이다.
- `quarantine`이나 `reject`로 올리기 전에 DKIM을 선언해 재고, 실제 보낸 메일이 SPF나 DKIM 정렬을 통과하는지 본다. 먼저 올리면 자기 메일이 반송될 수 있다.
- `rua` 보고 주소는 선택이다. 메일함이 보고서로 찬다.
- 이 변경은 사용자가 Cloudflare 화면에서 한다. 에이전트가 하지 않는다.

### 8F.5 메일을 지키는 규칙

**gate, DNS, 라우팅 작업은 `public.example`의 메일 관련 레코드를 추가하거나 바꾸지 않는다.**

| 대상 | 금지 |
|---|---|
| 루트 A, AAAA, CNAME | 변경 금지. 루트 CNAME은 MX와 공존하지 못한다 [가정: DNS 표준] |
| 와일드카드 `*.public.example` | 생성 금지 |
| MX | 변경 금지 |
| SPF | 변경 금지. 도메인에 하나뿐이다 [검색] |
| DKIM CNAME, `_dmarc`, `apple-domain` TXT | 변경 금지. O44의 `_dmarc` 추가는 사용자가 한다 |
| 네임서버 | 변경 금지. 옮기려면 사용자가 레코드 전체를 먼저 옮긴다 |

- **`gate`는 `public.example`의 DNS 자격을 갖지 않는다.** 구조로 막는 것이 첫째다. `internal.example`의 챌린지 위임뿐이다.
- `gate check`가 공개 해석기로(`dig` 없이, `node:dns`나 DoH) 위 레코드를 읽어 `edge.json`의 기대 상태와 비교한다. 다르면 실패하고 `gate apply`가 멈춘다. 파일 형식만 읽고 relief 코드를 import하지 않는다.
- 사용자가 이 레코드를 바꿀 때는 전후로 `gate check`를 돌리고 `edge.json`을 함께 고친다.
- 공개 사이트를 외부 호스팅에 둘 때 호스팅의 "DNS 자동 설정"을 쓰지 않는다. 필요한 이름만 사람이 넣는다.

## 9. 단계

순서의 이유: 인증 없는 쓰기를 한 순간도 만들지 않는다. 읽기로 인증을 먼저 길들인다. 위험이 큰 것을 뒤에 둔다.

| Phase | 내용 | 완료 기준 | 실행 가능한 검증 | 되돌리기 | 실제 시스템 시험 | 교차 검토 |
|---|---|---|---|---|---|---|
| 0 링크 아웃 | "PVE 열기" 링크. 관측한 노드 주소로 새 탭(구현 완료) | 패널에서 PVE가 새 탭으로 열린다. 다른 URL을 받지 않는다 | `npm test -w @sagae/relief -- open` | 커밋 되돌리기 | 사용자가 창을 연다 | 불필요 |
| 1 인증 | 로그인, 쿠키 없는 세션, Origin 강화, 읽기 세션화, 감사 골격 | 세션 없이 `/api/*` 401. 다른 로컬 포트의 POST 403. 응답에 `Set-Cookie`가 없다. 다른 포트의 합성 서버가 값을 받지 못한다 | `npm test -w @sagae/relief && npm run test:e2e -w @sagae/relief -- security auth`, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4815/api/snapshot` 가 401, `! curl -si http://127.0.0.1:4815/ \| grep -qi set-cookie` | 커밋 되돌리기. `auth.json`을 지워도 무인증으로 열리지 않고 닫힌 채 실패한다 | Windows Chrome의 `sessionStorage`와 새로 고침 | **필요.** 쓰기의 기반이다 |
| 2 패키지 읽기 | `apt/versions`, `repositories`, `relief deps` | 패널에 후보와 설치본이 보인다. 차이가 0이면 "0건 관측". 허용 목록 시험이 두 경로만 더했다 | `node tools/relief/bin/relief.mjs check --live`, `npm test -w @sagae/relief -- allowlist` | 허용 목록 두 줄 제거 | `check --live` | 불필요 |
| 3 노드 읽기 | 강제 명령 키, 어댑터, BMC 사실 | 센서가 관측으로 보인다. 어떤 인자를 줘도 출력이 같다. 일련번호 패턴이 스냅샷에 없다 | `! ssh -i ~/.ssh/relief_read <별칭> id | grep -q '^uid='`, `node tools/relief/bin/relief.mjs check --live` | `authorized_keys` 한 줄 제거 | **필요.** 세 노드 출력 모양, p1 설치, p2 드라이버 | 불필요 |
| 3r ops 이전 | ops VM, 서비스별 Unix 사용자, `tower-ops`, 전용 읽기 토큰, relief를 VM의 127.0.0.1에. **원격 없음** | 지도가 VM에서 돈다. WSL을 꺼도 수집이 계속된다. 외부 리스너가 없다. 사용자끼리 파일을 읽지 못한다 | `ss -ltn \| grep -vE '127\.0\.0\.1\|::1'` 에 relief 포트가 없다, `sudo -u relief cat <relief-act 파일>` 이 거절, `node tools/relief/bin/relief.mjs check --live` | WSL 유닛 재활성화, VM 삭제 | **필요.** VM 생성은 사용자. `kms.md` M1b 뒤면 계정으로 받는다 | 불필요 |
| 3n 이름 | Universal SSL 끄기, CAA, 챌린지 CNAME, deSEC 토큰, `gate`, Caddy, `lego`, 해석기, 분할 DNS, 와일드카드, `svc-gate`. 라우트는 시험용 하나 | 오버레이 기기에서만 열린다. LAN과 인터넷에서 안 닿는다. 인증서 자동 갱신. 토큰이 Caddy 프로세스에 없다. 토큰으로 다른 레코드 쓰기가 거절된다. 공개 CAA에 Cloudflare CA가 없다. 프록시 레코드와 A 레코드가 없다 | `gate check`, `ss -ltn \| grep ':443'` 이 오버레이 주소만, 오버레이에서 `curl -sI https://test.internal.example`, `gate check`의 `no-public-admin`(공개 해석기, DoH), `caa`. 이 머신에 `dig`가 없으므로 검사는 `dig`에 기대지 않는다. DoH나 `getent`, `node:dns`를 쓴다 | `gate` 끔, CNAME 제거 | **필요.** 계정 강화와 존 변경은 사용자 | 필요 |
| 3m 패스키 | WebAuthn, 기기 표, `relief device add\|revoke`, 재확인, 암호 제거. Serve 없이 SSH 터널로 시험 | 등록 코드 일회용. 폐기한 자격의 세션이 끊긴다. 잘못된 RP ID와 Origin 거절. iOS 홈 화면 앱에서 패스키 동작 | `npm test -w @sagae/relief -- device`, `npm run test:e2e -w @sagae/relief -- security auth device` | 커밋 되돌리기 | **필요.** 기기 셋 | **필요.** 3o 전에 끝낸다 |
| 3o 원격 공개 | Tailscale ACL, Tailnet Lock, `gate` 라우트, PWA. 읽기 전용. **3m과 그 교차 검토 뒤에만** | 세 기기에서 지도가 열린다. 패스키 없이 `/api/*` 401. 공개 인터넷에서 닿지 않는다. 기기 제거로 통로가 끊긴다. `Domain=` 쿠키 없음 | `tailscale funnel status` 가 비어 있다, `curl -s -o /dev/null -w '%{http_code}' https://relief.internal.example/api/snapshot` 가 401, `gate check`, 라우터 `portForwards` 0개 유지 | `gate` 라우트 제거 | **필요.** 분실 훈련 포함 | **필요** |
| 3d `domains` | 공개 DNS, RDAP, TLS 어댑터, `domains` 스키마, 메일 객체, 경고. **자격 없음** | 실패와 없음이 구분된다. 해석기 둘이 일치해야 심각 경고. 내부 이름에 접속하지 않는다 | `npm test -w @sagae/relief -- domains`, `node tools/relief/bin/relief.mjs check --live` | 어댑터 끔 | **필요.** 실제 도메인 등록 | 불필요 |
| 3w 깨우기 | `wake.ts`, `wake.json`, 결과 표시 | PC가 S3에서 전화기로 깨어난다. MAC이 스냅샷, 로그, 응답에 없다 | `npm test -w @sagae/relief -- wake`, `! grep -rEi '([0-9a-f]{2}:){5}[0-9a-f]{2}' docs tools/relief/fixtures` | 라우트 제거 | **필요.** BIOS와 NIC 확인 뒤 | 불필요 |
| 3s KMS 보기 | `kms` 어댑터, 지도 객체, 만료 경고, 관리 링크. `kms.md` M1b, M7b 뒤 | `svc-relief-meta`로 `data` 경로가 403. 봉인과 응답 없음이 구분된다. relief에 값 입력 칸이 없다 | `npm test -w @sagae/relief -- kms-view`, `! grep -rn 'sagae/data/' tools/relief/server \| grep -v _status` | 어댑터 끔, 계정 삭제 | 필요 | 필요 |
| 3k relief-act 골격 | `act/`, 소켓 유닛, 자기 화면, KMS 로그인, `secrets.use`, 잠금 창, KMS 다운 표시. `kms.md` M2 뒤 | relief 서버와 UI에 쓰기 경로가 없다. KMS 없이 relief 정상. 표식 값이 환경, 명령줄, 로그, 응답에 없다. 창이 끝나면 쓰기 거절 | `npm test -w @sagae/relief -- act`, `! grep -rnE "^import .* from" tools/relief/act \| grep -v "from 'node:"` | 유닛 끄기, 쓰기 꺼짐 | 필요. 봉인 상태의 표시 | 4a와 같이 |
| 4a 쓰기 1차 | act의 계획, 시작, 종료, 재부팅. 토큰은 `secrets.use`로만 | mock에서 표의 금지 조건 전부 거절. `check --write`가 권한 집합 일치를 확인. 시험 게스트가 시작되고 종료된다. UPID가 감사와 PVE에 같다 | `npm test -w @sagae/relief -- act`, `node tools/relief/bin/relief.mjs check --write` | KMS 항목 삭제, PVE 토큰 폐기 | **필요.** 첫 실행은 빈 시험 게스트. 사용자 입회 | **필요.** 토큰 발급 전에 |
| 4b 쓰기 2차 | 강제 중지, 재설정 | L3 시험 통과. 속도 제한 동작 | `npm test -w @sagae/relief -- act` | 동작 표에서 제거 | **필요.** 시험 게스트 | 4a와 같이 |
| 6 터미널 | xterm.js, `relief-term`, 게스트, `relief_term` | 잘못된 Origin, 재사용 티켓, 모르는 호스트 키가 모두 거절. agent 소켓이 환경에 없다. 자동 DSR 답이 유휴 타이머를 늘리지 않는다. 종료 뒤 스크롤백이 비었다. 한글 IME 입력 | `npm run test:e2e -w @sagae/relief -- term` (로컬 sshd), `npm test -w @sagae/relief -- term` | `ssh.json` 삭제, 의존성 제거 | **필요.** 게스트 하나 | **필요.** 원격 셸 경로 |
| 7 노드 터미널 | 사용자가 O6에서 고를 때만 | 7.2절 | Phase 6과 같음 | 대상 제거 | 필요 | 필요 |
| 8 기기 쓰기 | 태블릿, 전화기의 시작, 종료, 재부팅 (O22) | 기기 표가 강제한다. L3와 터미널은 거절된다 | `npm test -w @sagae/relief -- device act` | 기기 표 권한 제거 | 필요 | 3m과 같이 |

- 위 `npm test` 인자는 만들 시험 파일 이름이다. Phase마다 그 시험을 함께 만든다. 단, 워커가 쓴 시험만으로 완료를 판정하지 않고 기존 `security.spec.ts`와 실제 실행을 같이 돌린다.
- 교차 검토는 다른 회사 에이전트로 한다. 토큰 발급과 터미널 공개가 되돌리기 어려운 일이기 때문이다. 의견이 갈리면 시험으로 가리고, 못 가리면 양쪽 근거를 사용자에게 보인다.
- **순서의 규칙.** 이름(3n)이 패스키(3m)보다 앞선다. RP ID가 이름에 묶이기 때문이다. 3o는 3m과 그 교차 검토가 끝나기 전에 시작하지 않는다. 3r과 3m 동안 relief는 VM의 127.0.0.1에만 있고 SSH 터널로만 닿는다.
- 다른 작업자가 `tools/relief`의 UI, 추세, 변경 기록, 상태 점검을 고치는 중이다. Phase 0 전에 그 작업을 합친다. 이 설계의 파일 위치는 그 뒤 다시 확인한다.

### 9.1 전체 트랙 실행 계획

사용자는 전체 트랙을 골랐다(O39, 2026-11-01). 아래가 순서다. "지금"은 사용자 행동 없이 에이전트가 시작할 수 있다는 뜻이다. 모두 코드와 시험까지이고 커밋과 배포는 지시를 받는다. 검증 명령은 위 표의 해당 줄과 `kms.md` 9절이다.

| # | 단계 | 누가 | 사용자 행동 | 검증 | 선행 |
|---|---|---|---|---|---|
| 1 | 0 PVE 링크 아웃 | **에이전트, 지금** | 없음 | `npm test -w @sagae/relief -- open` | UI 작업 병합 |
| 2 | 1 인증 | **에이전트, 지금** + 교차 검토 | 첫 암호 설정 | `security`, `auth` 시험, 무세션 401 | 1 |
| 3 | 3d `domains` | **에이전트, 지금** | `edge.json`에 도메인과 기대 값(O42) | `npm test -w @sagae/relief -- domains`, `relief check --live` | 1 |
| 4 | 2 패키지 | **에이전트, 지금** | 없음 | `check --live` | 2 |
| 5 | `tools/kms`, `tools/gate`, `relief-act`, `relief-term` 코드 | **에이전트, 지금.** 합성 값과 일회용 시험 서버만 | 없음 | 각 시험. 실제 자격 없음 | 2 |
| 6 | K1 restic, O14 OpenRouter 키, O44 DMARC | **사용자** | 암호를 디스크 밖에, 새 키, `_dmarc` TXT | 복원 시험, `domains` 경고 해소 | 없음. **11-23 전** |
| 7 | 계정 준비 | **사용자** | Tailscale, deSEC, Cloudflare 강화(O37) | 8E.2절 표 | 없음 |
| 8 | VM 생성 | **사용자** | KMS, ops, 대기 VM 둘. 토큰이 읽기 전용이라 에이전트가 못 만든다 | `/cluster/resources`에 보인다 | 7 |
| 9 | M1 KMS 서버 | 에이전트 + **사용자** | `operator init`은 사용자 혼자, 조각 보관 | `kms.md` M1 | 8 |
| 10 | 3r ops 이전 | 에이전트 | SSH 접근 부여 | 3r 줄 | 2, 8 |
| 11 | M1b 서비스 계정 | 에이전트 + **사용자** | `owner` 로그인, 키 이름 등록 | `policy.sh` | 9 |
| 12 | **게이트: K0 재질문** | **사용자** | M2 전에 다시 묻는다 | 사용자의 답 기록 | 11 |
| 13 | M2 새 키, 하위 키 | **사용자** + 에이전트 | `kms key fill`, O15 KB 채택 | `kms.md` M2 | 12 |
| 14 | 3n 이름 | 에이전트 + **사용자** | Universal SSL 끄기, CAA, CNAME | 3n 줄, `gate check` | 7, 10 |
| 15 | 3m 패스키 | 에이전트 + **사용자** | 세 기기 등록 | 3m 줄 | 14 |
| 16 | **게이트: 교차 검토** | 다른 회사 에이전트 | 결과 승인 | 3m, 3n, 인증 | 15 |
| 17 | 3o 원격 공개 | 에이전트 + **사용자** | Tailnet Lock 서명, 분실 훈련 | 3o 줄 | 16 |
| 18 | 3w 깨우기 | 에이전트 + **사용자** | BIOS, NIC, 빠른 시작 확인, MAC 파일 | 3w 줄 | 17 |
| 19 | 3s KMS 보기, M7b, Cloudflare 읽기 토큰 | 에이전트 + **사용자** | 토큰 발급 | 3s 줄 | 13 |
| 20 | 3k, 4a 쓰기 | 에이전트 + **사용자** + 교차 검토 | PVE 풀, 역할, 토큰(O2), 시험 게스트 | 4a 줄 | 13, 16 |
| 21 | M3, M4 이전 | 에이전트 + **사용자** | 전역 설정 승인 | `kms.md` M3, M4 | 13 |
| 22 | 6 터미널, 4b, 8 기기 쓰기 | 에이전트 + 교차 검토 | 게스트 키, `known_hosts` | 각 줄 | 20 |
| 23 | M5 SSH CA, M8 전면 교체 | **사용자** + 에이전트 | 콘솔 입회 | `kms.md` M5, M8 | 21 |

**K0을 미룬 뜻.** 이 계획은 K0 없이 진행한다. 그동안 WSL의 같은 UID 코드는 `id_ed25519`로 노드 root이고, 노드 root는 ops와 KMS VM의 디스크와 메모리에 닿는다. **VM 분리는 서비스끼리, 그리고 사고에 대한 경계이지 같은 UID 코드에 대한 경계가 아니다.** 12번 게이트에서 사용자에게 다시 묻는다. 실제 키가 KMS에 들어가기 전의 마지막 값싼 지점이다.

## 10. 비용

줄 수는 [가정]이고 시험을 뺐다. 시험은 대략 같은 양이다. 의존성 판은 구현 때 `min-release-age=7`로 다시 고른다. `ws`, `@xterm/xterm`은 최근 게시분이 규칙에 걸릴 수 있다 [측정: 메타데이터 수정일 2026-10-29~31].

| Phase | 서버 | 화면 | 새 의존성 | 새 공격면 |
|---|---|---|---|---|
| 0 | 10 | 10 | 없음 | 없음 |
| 1 | 250 | 100 | 없음 | 로그인 라우트 |
| 2 | 120 | 80 | 없음 | 레지스트리 외부 호출 |
| 3 | 120 | 60 | 없음 | 읽기 키 1개, 노드 강제 명령 |
| 3k | 60 | 0 | 없음 | 127.0.0.1:4819, KMS로 나가는 HTTPS |
| 4 | 350 | 100 | 없음. `node:` 내장뿐 | 쓰기 토큰, POST 라우트 2개 |
| 6 | 250 | 150 | `ws`, `node-pty`(네이티브), `@xterm/xterm`, `@xterm/addon-fit` | WebSocket에서 셸까지, 네이티브 모듈 |
| 3r | 80 | 0 | 없음 | VM 하나(대기 VM 하나), tower 하나, 읽기 토큰 하나 |
| 3m | 200 | 80 | `@simplewebauthn/server`(직접 10) | 등록과 로그인 라우트 |
| 3o | 40 | 120 | Tailscale 클라이언트 | **원격 입구**, 제3자 제어 평면, 공개 CT 원장의 이름 |
| 3w | 80 | 40 | 없음 | 깨우기 라우트, MAC 파일 |
| 3n | 350 | 0 | Caddy, `lego`, DNS 서버. 도메인 구입 완료, deSEC 무료 계정 | **오버레이 입구**, 53 포트(오버레이), DNS 토큰, `*.internal.example` 키 |
| 3s | 100 | 80 | 없음 | KMS 메타데이터 계정 |
| 3d | 200 | 80 | 없음 | 공개 해석기와 RDAP 외부 호출, 읽기 전용 Cloudflare 토큰 |
| 합계 | 약 2,160 | 약 900 | 7 + Tailscale | 화면은 모바일 레이아웃 비용을 뺐다 |

현재 relief의 수준과 비교하면 관리 도구로서의 유지 부담이 크게 는다. 특히 Phase 1과 6은 보안 결함이 그대로 사고가 되는 코드다. 끝까지 만들기 전에 Phase 4에서 멈출 수 있고, 그래도 VM 관리는 완성이다.

## 11. 사용자 결정

**정해진 것(2026-11-01).**

| # | 결정 | 값 |
|---|---|---|
| O39 | 트랙 | **전체 트랙** |
| O40 | 세 번째 노드 | **모든 노드를 켜 둔다** |
| O21 | 통로 | **Tailscale, Tailnet Lock** |
| O27 | 내부 도메인 | **구입 완료.** DNS는 Cloudflare |
| O10 | 무암호 root 키 (`kms.md` K0) | **미룸.** M2 전에 다시 묻는다(9.1절) |

**남은 것.**

| # | 결정 | 권장 | 다른 답의 결과 |
|---|---|---|---|
| O1 | 쓰기 토큰을 `relief-act`가 직접 쥐는 D2 예외 | 승인 | MCP로 가면 bearer가 쓰기가 된다. 권장하지 않는다 |
| O2 | PVE에 풀, 역할, 사용자, 토큰 생성(사용자 실행) | 승인. 풀에는 처음에 시험 게스트만 | 없으면 Phase 4가 없다 |
| O3 | 1차 동작 | 시작, 종료, 재부팅. 강제 중지와 재설정은 2차 | 강제 중지를 1차에 넣으면 L3 시험이 먼저다 |
| O4 | 읽기까지 로그인 뒤로 | 승인 | 무인증 유지면 패키지와 BMC 값은 세션 뒤로 나눠야 하고 코드가 는다 |
| O5 | PVE 화면 | **링크 아웃으로 확정.** 프록시와 iframe을 철회했다 | 내장을 원하면 Electron뿐이다. 앱과 갱신 부담을 받아들여야 한다 |
| O6 | 터미널의 노드 root | 1차 제외. PVE 콘솔 사용 | 원하면 전용 키와 L3 |
| O7 | `node-pty` 네이티브 빌드 예외 | 승인 | 거절하면 Windows Terminal 방식 |
| O8 | 노드 읽기를 tower 뒤가 아니라 relief 안에 | 승인 | MCP면 플러그인 저장소 작업과 `main` 배포가 는다 |
| O9 | BMC 펌웨어 판과 망 분리 확인 | **먼저 한다.** relief와 무관하게 | 미룰수록 CVSS 10 경로가 열려 있을 수 있다 |
| O11 | 노드 쓰기 승인: p1 `ipmitool` 설치, p2 드라이버, 강제 명령 키 추가 | 승인 | 없으면 해당 노드는 미확인 |
| O12 | 터미널 내용 기록 | 끔 | 켜면 root 세션 사본이 디스크에 남는다 |
| O13 | 접속 이름 | **결정 불필요.** Phase 1은 `127.0.0.1`, VM 뒤에는 Serve 주소(8B.3절). 임의 tailnet 이름과 일반적인 기기 이름을 쓴다 | |
| O14 | KMS 자체 | `kms.md` 10절의 결정표를 따른다 | KMS가 늦으면 8A.4절의 임시 `age` 파일 또는 쓰기 연기 |
| O15 | relief 로그인과 KMS 로그인 암호 | 별도 값. 둘 다 암호 관리자에 | 같은 값이면 입력이 줄고 로컬 해시 유출이 KMS 추측으로 이어진다 |
| O16 | 터미널 전용 키의 암호 | 세션마다 입력 | 번거로우면 전용 `ssh-agent` 15 min. 그 동안 같은 UID가 소켓을 쓴다 |
| O17 | KMS 전에 쓰기를 낼 것인가 | 기다린다 | 낸다면 임시 `vault.age`와 의존성 하나가 는다 |
| O18 | 쓰기를 npm 없는 `relief-act`로 분리, 토큰 수명 30일 | 승인 | 합치면 침해된 패키지가 토큰을 복사해 수명 끝까지 쓴다 |
| O19 | 터미널을 `relief-term` 프로세스로 분리 | 승인 | 합치면 지도의 npm 트리를 키 암호가 지나간다 |
| O20 | ops VM과 KMS VM 분리, 배치 | 승인(`kms.md` O4). VM 생성은 사용자 | 한 VM이면 전화기 입구가 KMS 옆이다. WSL이면 PC가 잠들면 못 쓴다 |
| O22 | 전화기와 태블릿의 시작, 종료, 재부팅 | 처음엔 금지, 8단계에서 허용 | 처음부터 열면 분실의 피해가 커진다 |
| O23 | 태블릿 터미널 | 금지 | 키보드 있는 태블릿만 허용할 수 있다. 분실 피해는 같다 |
| O24 | 노드를 실제로 끄는가, 집 밖에서 켜야 하는가 | 먼저 사용 패턴을 정한다 | 그렇다면 소형 상시 장치 구입 |
| O25 | 노드 BIOS, PC BIOS와 빠른 시작 설정 | 사용자가 확인 | 안 맞으면 패킷이 가도 안 켜진다. 빠른 시작을 끄면 PC 부팅이 느려진다 |
| O26 | 패스키 동기화 허용 | 허용 | 기기 묶인 키만 받으면 기기별 신원이 강해지나 iOS에서 어렵다 |
| O28 | `public.example`의 등록 기관과 계정 확인 | DNS는 Cloudflare로 확인됨. 등록 기관은 RDAP로. **같은 Cloudflare 계정인지 사용자가 확인** | 관리 서비스는 막지 않는다 |
| O29 | 전화기에서 긴급 폐기 | 만들지 않는다. 공급자 화면을 쓴다 | 원하면 별도 설계 |
| O30 | 공개 게임 포트 | 범위 밖. 열기 전에 격리와 BMC 확인. 별도 호스트 필수 | 열면 "공개 포트 0"이 깨지고 DDNS가 필요하다 |
| O31 | `pve` 라우트 | **닫음. 만들지 않는다.** PVE는 직접 연결만 | |
| O32 | relief의 메타데이터 계정 | 승인 | 없으면 지도에 KMS 상태가 없다 |
| O33 | 관리 화면 | OpenBao UI로 링크 아웃, 쓰기 전용 계정 | 화면에서 부여까지 원하면 `kms.md` O2가 Infisical로 기운다 |
| O34 | 공개 사이트 위치 | 외부 정적 호스팅, 자기 인증서 | 집에서 돌리면 포트 하나와 별도 VM, 격리가 필요하다 |
| O35 | `private.example`에 서비스 이름 안 두기 | 승인 | |
| O36 | DNS-01 토큰 위치 | **deSEC CNAME 위임**(b). Cloudflare API 토큰을 만들지 않는다 | 존 토큰이면 ops 침해가 CAA와 KMS 이름 보호를 지운다 |
| O37 | **Cloudflare 계정 강화(8E.2절 표).** 보안 키 둘, 복구 코드, 메일 2단계, Global Key 미사용, 자동 갱신 | **3n 전에** | 빼앗기면 CAA를 지우고 인증서를 발급한다. 만료되면 갱신이 멈추고 남이 그 이름을 살 수 있다 |
| O38 | Universal SSL 끄기, 프록시 끔 | 승인. CAA보다 먼저 | 켜 두면 Cloudflare CA가 CAA에 더해진다 |
| O41 | 데스크톱 `hosts`에 KMS 이름 | 승인. Windows 파일 변경 | 없으면 ops 고장 때 KMS 화면을 못 찾는다 |
| O42 | `public.example`을 `edge.json`에 등록, iCloud 화면의 레코드 옮겨 적기 | 3d 전에 | 없으면 메일 검사가 없고 `mail-guard`가 돌지 못한다 |
| O43 | 읽기 전용 Cloudflare 토큰 | 승인. 두 존, Zone Read, DNS Read | 없으면 프록시 표시와 존 상태가 안 보인다 |
| O44 | `public.example` DMARC | `p=none`으로 추가. 올리기는 DKIM과 정렬 확인 뒤 | 없으면 위조 메일 정책이 없다. Apple 권고는 확인하지 못했다 |

**되돌리기 어려운 일.**

| 일 | 왜 | 대비 |
|---|---|---|
| 패스키 RP ID | 바꾸면 모든 기기 재등록 | O27을 3m 전에 |
| 공개 CT 원장 | 인증서 이름은 지울 수 없다 | `*.internal.example`만 발급. 개별 이름은 CT에 없다 |
| 도메인 이름 | RP ID이자 CT 기록이다 | O27을 신중히. 브랜드와 잇지 않는다 |
| 도메인 만료 | 남이 사면 그 이름의 인증서를 받는다 | O37 |
| Tailnet Lock | 해제 비밀을 잃으면 tailnet 복구 불가 | 복구 키트 |
| 게임 포트 공개 | 공격면이 생기고 평평한 LAN에 닿는다 | O30 |
| `*.internal.example` 키를 공개 호스트에 복사 | 공개 호스트 침해가 관리 이름 사칭이 된다 | 금지 |
| PVE 쓰기 토큰 발급 | 복사본은 폐기까지 유효 | 30일, 풀 범위 |

## 12. 다른 문서와 저장소에 필요한 변경

| 대상 | 변경 | 시점 |
|---|---|---|
| `docs/design/relief.md` 1절 | "쓰기", "웹 터미널" 비목표를 이 문서로 옮긴다 | 승인 뒤 |
| 같은 문서 6.3절 | "쓰기 코드 경로가 없다"를 "MCP 경로에는 없다"로 | Phase 4 |
| 같은 문서 7.1절 | "머신 밖 호출은 공인 IP뿐", 복사 전용 문구 | Phase 2, 6 |
| 같은 문서 11절, 16절 | 포트 4819, R3 닫음, D2 예외 | Phase 1, 4 |
| 같은 문서 19절 | 배치 규칙에 쓰기 예외와 노드 읽기 | 승인 뒤 |
| `tools/relief/server/guard.ts` | 2.1절 | Phase 1 |
| `tools/gate/` | 새 도구, `routes.yaml`, `mail-guard` | Phase 3n |
| `relief.md` 7.1절 | "머신 밖 호출은 공인 IP뿐" 문구, `domains` 스키마 | Phase 3d |
| `internal.example` Cloudflare 존 | Universal SSL 끄기, CAA, 챌린지 CNAME. 사용자 | Phase 3n |
| deSEC | 계정, 존, 제한 토큰. 사용자 | Phase 3n |
| `tools/relief/server/collect/edge.ts`, `relief.md` 7.1절 | `domains`, 레코드 `type` 확장 | Phase 3n. 다른 작업자와 조정 |
| `docs/design/kms.md` | 배치와 서비스 계정을 반영했다 | 완료 |
| `tools/relief/scripts/chrome.ps1`, `open.ts` | URL 고정값을 Serve 주소로 | Phase 3o |
| 라우터, Windows, 노드 | 8C.3절 설정. 사용자 | Phase 3w |
| `tools/relief/act/`, `relief-act` 유닛 | 3.8절 | Phase 3k |
| `tower.md`, tower 코드, `tower.json` | **없음.** bearer는 같은 경로에 렌더된다 | |
| `docs/design/kms.md` | 별도 설계. relief는 M7의 소비자다 | 승인 뒤 |
| `sagae-claude-plugins` 코드 | **없음.** CA 파일을 경로로 읽기만 한다 | |
| PVE, 노드, BMC | 11절 O2, O9, O10, O11. 사용자 실행 | |
| `~/.ssh` | `relief_read`, `relief_term` 생성은 사용자가 한다 | Phase 3, 6 |

## 13. 측정과 한계

| 구분 | 내용 |
|---|---|
| 측정 | PVE 스키마의 `wakeonlan` 권한, Tailscale과 Headscale 메타데이터, 더미 값의 `systemd-creds --user`와 DPAPI 왕복, `/proc` 가시성, `age-encryption` 왕복, 비밀 파일의 모드(값은 읽지 않음), PVE 9.2.2 응답 헤더, 쿠키 코드, 자산 경로, 토큰 권한, `apt/update` 403, `apt/versions` 200, SSH 별칭 사용자, 세 노드 보드와 IPMI 장치, Chromium 156 쿠키 네 조합, 프록시 스파이크(로그인 화면까지), `node-pty` 패키지 구성, npm과 GitHub 메타데이터, Node의 argon2, ptrace 설정 |
| 출처 | PVE API 스키마와 User_Management, pve-manager `APT.pm`, `pveproxy.pm`, pve-http-server 6.0.5, Electron 문서, Chrome LNA 문서, 저장소 문서와 코드 |
| 검색만 | 도메인 가격과 TLD 수, RFC 8657 지원과 시행 일정, `.internal` 예약 결의, 등록 기관의 API 부재, 라우터 DDNS, Caddy DNS 빌드, 라우터 WOL과 WireGuard, Tailscale WoL 보고, iOS 패스키, OpenBao 봉인 동작과 라이선스 비교, Redfish 지원, BMC 취약점의 보드별 영향과 수정판, PVE XSS 공고, Tauri 상태, OWASP CSRF 표현, 프록시 헤더 사례 |
| 재지 않음 | 8F의 모든 동작(RDAP 응답, DKIM, Apple의 실제 레코드 값, Cloudflare 읽기 토큰, 두 존의 계정), 8D, 8E의 모든 동작(Caddy, `lego`, deSEC 토큰 정책, CNAME과 `lego` 조합, Cloudflare CAA의 `accounturi` 입력, Universal SSL 끄기 뒤의 CAA, 분할 DNS와 DNSSEC, Tailscale 분할 DNS와 전화기의 해석, `gate`의 공개 DNS 검사, OpenBao UI와 쓰기 전용 정책, Chrome의 사용자 CA), 8B, 8C의 모든 동작(Tailscale, Serve 포트, Tailnet Lock, 패스키, iOS 홈 화면 앱의 WebAuthn, 기기 셋, 매직 패킷, 노드와 PC의 WoL, VM에서 나가는 브로드캐스트, 모바일 SVG 성능), KMS 전체(`kms.md` 11절), 실제 ssh 암호 프롬프트의 xterm 동작, Windows Chrome 전부, `sessionStorage` 세션, `pveum` 명령 실행, 실제 쓰기 호출, Node 26의 `node-pty` 빌드, xterm.js의 한글 IME, `ipmitool sdr`, `sel`, `chassis`, 강제 명령 동작, BMC 펌웨어 판 |

**아직 교차 검토를 받지 않은 것.** 8F절, 9.1절, 0절의 두 트랙, 3차 검토 반영분, Cloudflare와 deSEC 위임, 세 도메인 모델(8E.2, 8E.7절). 특히 패스키, 기기 폐기, 원격 공개는 **3o 전에 검토가 끝나야 한다.** 쿠키 없는 세션, `relief-act`, `relief-term`은 2차 검토에서 설계상 수정됐다고 확인받았다.

**3차 검토(2026-11-01, Codex).** Cloudflare 변경 전 판을 읽었다. 재현 없음. 다섯 건을 수용했다: PVE 라우트 철회, Caddy 관리 API를 소켓으로, 쿼럼 전제, 와일드카드 사칭 주장 정정, KMS 이름 독립. 범위 평가는 0절의 두 트랙이다.

**교차 검토(2026-11-01, Codex).** 문서와 코드를 읽은 검토이고 공격을 재현하지 않았다.

| 지적 | 등급 | 처리 |
|---|---|---|
| 쿠키가 포트로 격리되지 않아 다른 UID 서버가 세션을 받는다 | 높음, 확인 | 수용. 쿠키 없는 세션, 프록시와 iframe 철회, `relief.localhost` 철회(2.1, 4절, O5, O13) |
| 잠금 창이 피해 상한이라는 주장 | 높음, 확인 | 수용. 주장 철회, `relief-act` 분리, 토큰 30일(1.2, 3.8, 8A.2절, O18) |
| 프록시 대상과 리다이렉트 규칙 부재 | 중간 | 수용. 프록시는 없고 재개 조건으로 기록(4.3절) |
| 자동 DSR 답이 유휴를 늘림, 스크롤백 잔존 | 중간 | 수용(7.1절). `relief-term` 분리는 이 문서의 추가 조치다(O19) |
| PVE 로그가 강하다는 주장 | 중간, 확인 | 수용. 노드 root에게 조건부(3.6, 8A.1, 8A.6절) |

결함이 없다고 본 것: Host 정확 일치의 재바인딩 방어, CSRF와 일회용 계획, 게스트 값과 대상의 분리, `VM.Audit`과 풀 범위 `VM.PowerMgmt`, 재부팅 뒤 잠금, 쓰기 전 인증 순서. 수정본을 다시 검토받지는 않았다.

이 문서를 쓰며 PVE와 BMC에 쓰기를 하지 않았다. PVE에는 GET만 보냈고 프록시 스파이크는 저장소 밖에서 인증 없이 GET만 보냈다. 비밀 값을 읽지 않았다.

**이 머신의 부작용 하나.** 더미 값으로 `systemd-creds --user encrypt`를 돌리자 systemd 서비스가 없던 호스트 키 `/var/lib/systemd/credential.secret`(root, 400)을 만들었다. 설계상 자동 생성이고 relief는 쓰지 않는다. 사용자가 지우려면 `sudo rm`이면 된다.

## 출처

| 출처 | 판 또는 날짜 |
|---|---|
| [PVE API 스키마 apidoc.js](https://pve.proxmox.com/pve-docs/api-viewer/apidoc.js) | Last-Modified 2026-09-24 |
| [PVE User Management](https://pve.proxmox.com/wiki/User_Management) | 2026-11-01 조회 |
| [pve-manager APT.pm](https://github.com/proxmox/pve-manager/blob/master/PVE/API2/APT.pm), [pveproxy.pm](https://github.com/proxmox/pve-manager/blob/master/PVE/Service/pveproxy.pm) | master, 2026-11-01 조회 |
| [pve-http-server AnyEvent.pm](https://github.com/proxmox/pve-http-server/blob/master/src/PVE/APIServer/AnyEvent.pm) | 6.0.5, 설치본과 같은 판 |
| [Embed proxmox console into an iframe](https://forum.proxmox.com/threads/embed-proxmox-console-into-an-iframe.115629/), [blank screen behind reverse proxy](https://forum.proxmox.com/threads/blank-screen-on-gui-behind-reverse-proxy.66714/) | 포럼, 일화 |
| [CVE-2025-57540](https://db.gcve.eu/vuln/CVE-2025-57540), [CVE-2025-57539](https://www.sentinelone.com/vulnerability-database/cve-2025-57539/), [CVE-2026-51081](https://www.sentinelone.com/vulnerability-database/cve-2026-51081/) | 2025-09, 2026-07. 2차 자료 |
| [Chrome Local Network Access](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access) | 2026-11-01 조회 |
| [Electron 일정](https://www.electronjs.org/docs/latest/tutorial/electron-timelines), [보안](https://www.electronjs.org/docs/latest/tutorial/security) | 45.2.1 기준 |
| [tauri#9059](https://github.com/tauri-apps/tauri/pull/9059), [tauri#9798](https://github.com/tauri-apps/tauri/issues/9798) | 2024, 2026-11-01 조회 |
| [Securing WebSocket Endpoints](https://dev.solita.fi/2018/11/07/securing-websocket-endpoints.html), [CWE-1385](https://appsec.backslash.security/cwe/1385) | 2차 자료 |
| [systemd-creds(1)](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html) | 이 머신 systemd 259 |
| [How to use data protection](https://learn.microsoft.com/en-us/dotnet/standard/security/how-to-use-data-protection) | 2026-07-22 |
| [age](https://github.com/FiloSottile/age), [typage](https://github.com/FiloSottile/typage), [sops](https://github.com/getsops/sops) | 1.3.2, 0.3.1, 3.13.3. 2026-11-01 `gh api` |
| [OpenBao](https://github.com/openbao/openbao), [Vault](https://github.com/hashicorp/vault) | 2.7.2, 2.2.1. 2026-11-01 `gh api` |
| OpenBao 릴리스 노트 [2.2](https://openbao.org/community/release-notes/2-2-0/), [2.4](https://openbao.org/community/release-notes/2-4-0/), [2.6](https://openbao.org/community/release-notes/2-6-0/) | 2.4는 2025-08-28 |
| [OpenBao와 Vault 비교](https://jorijn.com/en/blog/hashicorp-vault-vs-openbao/) | 2차 자료 |
| [ssh-agent(1)](https://man.openbsd.org/ssh-agent.1), [ssh_config(5)](https://man.openbsd.org/ssh_config.5) | 2026-11-01 조회, 이 머신 OpenSSH 10.2 |
| [Tailscale Serve](https://tailscale.com/kb/1312/serve), [Enabling HTTPS](https://tailscale.com/kb/1153/enabling-https), [Tailnet Lock](https://tailscale.com/kb/1226/tailnet-lock), [Subnet routers](https://tailscale.com/kb/1019/subnets), [요금표](https://tailscale.com/pricing) | 2026-11-01 조회 |
| [tailscale](https://github.com/tailscale/tailscale), [headscale](https://github.com/juanfont/headscale) | 1.104.4, 0.29.7. `gh api` |
| [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) | 2026-11-01 조회 |
| WebKit 블로그 14403(홈 화면 웹 앱의 저장소), [passkeys.dev iOS](https://passkeys.dev/docs/reference/ios) | 2026-11-01 조회 |
| [Tailscale WoL 토론](https://redlib.hackliberty.org/r/Tailscale/comments/1jublor/question_wake_on_lansoftware) | 2025-04, 일화 |
| [Windows Wake on LAN](https://learn.microsoft.com/en-us/troubleshoot/windows-client/setup-upgrade-and-drivers/wake-on-lan-feature) | 2026-02-12 |
| [PVE Node Management](https://pve.proxmox.com/wiki/Proxmox_Node_Management), [Cluster Manager](https://pve.proxmox.com/wiki/Cluster_Manager) | 2026-11-01 조회 |
| [Let's Encrypt 챌린지](https://letsencrypt.org/docs/challenge-types/), [lego DNS 목록](https://go-acme.github.io/lego/dns/), [Tailscale DNS](https://tailscale.com/kb/1054/dns) | 2026-11-01 조회 |
| [deSEC Tokens](https://desec.readthedocs.io/en/latest/auth/tokens.html), [Cloudflare Create token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/), [Registrar FAQ](https://developers.cloudflare.com/registrar/faq/), [acme-dns](https://github.com/joohoi/acme-dns) | 2026-11-01 조회 |
| [Cloudflare CAA records](https://developers.cloudflare.com/ssl/edge-certificates/caa-records/), [Disable Universal SSL](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/disable-universal-ssl/), [Proxied DNS records](https://developers.cloudflare.com/dns/manage-dns-records/reference/proxied-dns-records/), [2FA](https://developers.cloudflare.com/fundamentals/user-profiles/2fa/), [API keys](https://developers.cloudflare.com/fundamentals/api/get-started/keys/), [lego deSEC](https://go-acme.github.io/lego/dns/desec/) | 2026-11-01 조회 |
| [CA/B Forum Internal Names](https://cabforum.org/working-groups/server/internal-names), [draft-davies-internal-tld](https://datatracker.ietf.org/doc/draft-davies-internal-tld/), [RFC 8657 해설](https://site-b.pages.dev/blog/sc098v2-caa-rfc8657-mandatory) | 2차 자료 포함 |
| [Caddy](https://github.com/caddyserver/caddy), [Traefik](https://github.com/traefik/traefik), [Caddy DNS 모듈](https://caddy.community/t/how-to-use-dns-provider-modules-in-caddy-2/8148) | 2.11.7, 3.7.17 |
| [OWASP MASTG 0286](https://mas.owasp.org/MASTG/tests/android/MASVS-NETWORK/MASTG-TEST-0286/), [SRV 설명](https://www.mcmiddleearth.com/wiki/setting-up-a-srv-record/) | 2차 자료 |
| [OpenBao UI](https://openbao.org/docs/configuration/ui/) | 2026-11-01 조회 |
| [RFC 9224](https://datatracker.ietf.org/doc/rfc9224/), [IANA RDAP dns.json](https://data.iana.org/rdap/dns.json), [Node DNS](https://nodejs.org/api/dns.html), [Cloudflare Permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) | 2026-11-01 조회 |
| [Apple 지원 안내](https://support.apple.com/guide/icloud/set-up-a-custom-email-domain-mmdd8d1c1fa7/icloud), [iCloud 사용자 지정 도메인](https://support.apple.com/en-us/102540), [OVHcloud 안내](https://docs.ovhcloud.com/en/guides/web-cloud/domains/domain-icloud.md), [SPF, DKIM 설명](https://www.suped.com/learn/dmarc/how-to-set-up-dmarc-dkim-spf-for-icloud-mail) | 2026-11-01 조회, 2차 자료 포함 |
| [Caddy 전역 옵션](https://caddyserver.com/docs/caddyfile/options), [Caddy API](https://caddyserver.com/docs/api) | 2026-11-01 조회 |
| npm 메타데이터 `age-encryption` 0.3.1, `ws` 8.22.1, `node-pty` 1.1.0, `ssh2` 1.17.0, `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, `electron` 45.2.1, `@tauri-apps/cli` 2.12.4, `@simplewebauthn/server` 14.0.3, `otplib` 13.6.0 | `npm view`, 2026-11-01 |
| GitHub 메타데이터 ttyd 1.7.7, WeTTY, ssh2, asciinema | `gh api`, 2026-11-01 |
