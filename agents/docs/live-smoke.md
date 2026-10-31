# 라이브 스모크

러너 LXC에서 MCP 서버를 `.mcp.json`의 명령으로 띄우고 도구 6개를 실제 클러스터에 호출하는 검사입니다. 단위 테스트가 보지 못하는 실제 API와의 불일치, 토큰, TLS 문제를 잡습니다. 설계 문서의 W8에 해당합니다.

**지금은 꺼져 있습니다.** 저장소에 파일만 있고 러너와 `LIVE_SMOKE_ENABLED` 변수는 없습니다. `live-smoke` 잡은 건너뛰고 CI 결과도 그대로입니다. 러너 없이 켜면 `main` push마다 잡이 24시간 대기한 뒤 실패하므로, 이 문서의 절차는 러너를 만든 뒤에 실행합니다.

## 언제 실행되나

| 실행 | `check` | `live-smoke` | `promote` |
|---|---|---|---|
| `main` push | 실행 | 실행 | 둘 다 통과하면 실행 |
| PR, 다른 브랜치의 수동 실행 | 실행 | 건너뜀 | 건너뜀 |
| `main`의 수동 실행 (`gh workflow run ci.yml`) | 실행 | 실행 | 둘 다 통과하면 실행 |
| `main`의 수동 실행 + `skip_smoke` | 실행 | 건너뜀 | `check`만 통과하면 실행 |
| 주간 실행 (월요일 06:00 KST) | 실행, 변이 검사 제외 | 실행 | 건너뜀 |

- `promote`는 `STABLE_GATE_ENABLED`가 꺼져 있으면 언제나 건너뜁니다. [stable 배포 게이트](stable-gate.md)를 봅니다.
- `LIVE_SMOKE_ENABLED`가 꺼져 있으면 `live-smoke`는 항상 건너뛰고 `promote`는 `check`만 요구합니다. 변수를 켜기 전까지 달라지는 것은 주간 `check` 실행뿐입니다.
- PR 코드는 러너와 토큰에 닿지 않습니다. 워크플로 파일을 고치는 push까지 막지는 못합니다. push 권한이 곧 러너 코드 실행 권한입니다.

## 켜기

1. [러너를 만듭니다](../infra/runner/provision.sh). 실행은 별도 승인을 받습니다.

   ```sh
   infra/runner/provision.sh --node pve-node --vmid 101
   infra/runner/issue-token.sh --node pve-node --vmid 101
   ```

2. 변수를 켜고 한 번 실행합니다.

   ```sh
   gh variable set LIVE_SMOKE_ENABLED --body true
   gh workflow run ci.yml
   ```

3. Actions의 `live-smoke` 요약에 `Live smoke: PASS`가 나오는지 봅니다.

`stable` 게이트가 이미 켜져 있으면 이 변수를 켜는 순간부터 `promote`가 스모크 통과를 요구합니다. 게이트가 꺼져 있으면 스모크만 실행되고 `stable`은 움직이지 않습니다.

## 끄기

```sh
gh variable set LIVE_SMOKE_ENABLED --body false
```

게이트가 켜져 있으면 그때부터 `promote`는 `check`만 요구합니다. 러너가 잠시 멈춘 정도라면 끄지 말고 아래의 `skip_smoke`를 씁니다. 그래야 건너뛴 기록이 실행마다 남습니다.

## 결과 읽기

잡은 어느 쪽이든 실패로 끝납니다. 구분은 Actions 실행의 요약과 마지막 줄에만 남습니다.

| 요약 | 뜻 | 대처 |
|---|---|---|
| `PASS` | 모든 검사 통과 | 없음 |
| `FAIL INFRA: no host answered` | 어떤 호스트도 응답하지 않았습니다. 코드까지 가지 못했습니다 | 클러스터와 네트워크를 먼저 봅니다. 급하면 `skip_smoke`를 씁니다 |
| `FAIL INFRA: no API token on this machine` | 러너에 토큰 파일이 없습니다 | `infra/runner/issue-token.sh`를 실행합니다 |
| `FAIL PLUGIN: N failed` | 호스트는 응답했는데 검사가 틀렸습니다 | `FAIL` 줄을 봅니다 |
| 잡이 대기 상태 | 러너가 꺼져 있습니다. 24시간 뒤 실패합니다 | 아래의 러너가 멈췄을 때를 봅니다 |

`FAIL` 줄의 끝은 다음을 뜻합니다.

| 표시 | 뜻 | 대처 |
|---|---|---|
| `PVE API 401` | 토큰이 만료, 교체 또는 폐기되었습니다. 러너 토큰은 180일 뒤 만료됩니다 | `infra/runner/issue-token.sh`로 다시 발급합니다 |
| `PVE API 403` | 토큰 권한이 부족합니다 | ACL을 확인합니다. `PVEAuditor`보다 넓히지 않습니다 |
| `the token holds N privileges beyond .Audit` | 토큰 권한이 설계보다 넓습니다 | 즉시 토큰을 폐기하고 다시 발급합니다 |
| `a certificate expires in N days` | 노드 인증서나 CA의 만료가 가깝습니다. 음수면 이미 지났습니다 | 인증서를 갱신합니다. CA가 바뀌면 `certs/pve-root-ca.pem`도 교체합니다 |
| `All PVE hosts unreachable` 또는 대문자 코드 | 서버가 호스트에 닿지 못했습니다 | 첫 줄들의 `host` 표시와 함께 봅니다 |
| `tool error`, `unexpected ...` | 그 밖의 오류입니다. 내용은 로그에 남기지 않습니다 | 같은 커밋을 로컬에서 실행합니다 |

인증서 검증 실패(`UNABLE_TO_VERIFY_LEAF_SIGNATURE` 같은 `host` 줄)는 일부러 `PLUGIN`으로 표시합니다. 호스트는 응답했고 원인이 이번 커밋의 CA일 수 있습니다. `INFRA`로 표시하면 `skip_smoke`로 넘겨 잘못된 CA를 모든 머신에 내보낼 수 있습니다.

노드 하나만 내려가면 `node_status`나 `certificates`가 실패해 `PLUGIN`으로 표시됩니다. 첫 줄들에서 그 호스트의 상태를 함께 확인합니다. 응답한 호스트가 하나라도 있으면 `INFRA`가 아닙니다.

## 러너가 멈췄을 때

잡은 대기하고 `promote`도 함께 기다립니다. 최대 24시간 뒤 실패합니다. `timeout-minutes`는 실행 시간만 제한합니다.

수정이 급하면 `check`만 통과시켜 전진시킵니다. 실행 이력에 수동 실행과 건너뛴 `live-smoke`가 남습니다.

```sh
gh workflow run ci.yml -f skip_smoke=true
```

`skip_smoke`는 스모크만 건너뜁니다. `check`가 실패하면 `promote`는 실행되지 않습니다.

러너를 잃었으면 [켜기](#켜기)의 명령을 다른 노드와 빈 VMID로 다시 실행합니다. 같은 달에 토큰을 다시 발급하면 `issue-token.sh`에 `--token-id`로 새 ID를 줍니다. 복구한 뒤 `gh workflow run ci.yml`로 스모크를 다시 실행합니다.

## 주간 실행

월요일 06:00 KST에 스모크와 인증서 만료 점검을 실행합니다.

- 러너가 꺼져 있으면 잡이 24시간 뒤 실패하고, 그 실패 알림이 감시 역할을 합니다. GitHub는 14일 넘게 연결되지 않은 러너를 지우므로 그 전에 알 수 있습니다.
- 인증서가 30일 안에 만료되면 주간 실행만 실패합니다. push와 수동 실행은 만료가 지났을 때만 실패합니다. 아직 유효한 인증서가 배포를 막으면 안 되기 때문입니다.
- 주간 실행은 `promote`를 실행하지 않습니다. 롤백 뒤에 `main`에 남은 커밋을 다시 내보내면 안 되기 때문입니다.

## 로컬 실행

내부망에 접근할 수 있고 토큰이 있는 머신의 `plugins/proxmox`에서 `npm ci --ignore-scripts`를 실행한 뒤 실행합니다. GET만 보냅니다.

```sh
node test/smoke/live.mjs
```

`PVE_HOSTS`, `PVE_CA_FILE`, `PVE_TOKEN_FILE`을 서버와 같은 의미로 읽습니다. 호스트를 일부러 틀리게 주면 `INFRA`를 볼 수 있습니다. 이때는 실제 토큰을 쓰지 않도록 가짜 토큰 파일을 줍니다.

```sh
PVE_TOKEN_FILE=/tmp/fake-token PVE_HOSTS=192.0.2.1,192.0.2.2,192.0.2.3 node test/smoke/live.mjs
```

## 검사 항목

| 항목 | 단언 |
|---|---|
| `cluster_overview` | 노드 수가 3이고 이름 3개가 모두 있으며 HA 상태가 있습니다. 쿼럼 값은 기록만 합니다 |
| `list_resources` | 노드가 3건 이상입니다. `sdn` 1건 이상은 W4가 병합되면 저절로 켜집니다. 그 전에는 `sdn=unchecked`로 표시합니다 |
| `node_status` | 세 노드 모두 `pveversion`이 있습니다 |
| `guest_config` | 게스트 1대의 설정에 `digest` 키가 있습니다 |
| `recent_tasks` | 배열이고 길이가 5 이하입니다 |
| `api_get` | `/version`이 있고, `/access/permissions`의 모든 권한이 `.Audit`로 끝나며 1개 이상입니다 |
| `certificates` | 세 노드의 인증서와 CA가 만료되지 않았습니다. 주간 실행은 30일 이상 남아야 합니다 |

## 로그에 남는 것

Actions 로그는 GitHub에 저장되므로 응답 내용을 남기지 않습니다. 호스트와 응답 시간, 검사별 통과 여부와 소요 시간, 개수만 출력합니다. 오류는 `PVE API 403` 같은 상태와 코드만 남기고 문구는 버립니다. 서버의 stderr도 받지 않습니다. `npm test`가 응답의 모든 자유 입력 칸에 표식을 넣은 가짜 PVE로 이를 확인합니다.

어떤 호스트가 어떤 도구를 처리했는지는 W4 이후 서버 로그에만 있습니다. 스모크 로그의 `host` 줄은 호스트별 연결 상태입니다.

## 확인한 범위

| 항목 | 상태 |
|---|---|
| 도구 6개 단언, 응답 내용 미출력 | 이 머신에서 실제 클러스터에 실행해 통과했습니다. `npm test`가 가짜 PVE로 매번 확인합니다 |
| 호스트를 틀리게 준 경우의 `INFRA` | 이 머신에서 TEST-NET 주소와 없는 이름으로 확인했습니다 |
| `ci.yml`의 실행 조건 | `npm test`가 실제 `if` 식을 표대로 평가합니다. 작업 상태 규칙은 테스트가 흉내 낸 것이고 GitHub에서 실행한 것은 아닙니다 |
| GitHub Actions에서의 `live-smoke` 실행 | **미검증.** 러너가 없어 한 번도 실행되지 않았습니다 |
| 러너 정지 시 대기와 `skip_smoke` | **미검증.** 위와 같습니다 |
| LXC에서 `setup-node`, `npm ci` 동작 | **미검증.** 방화벽이 외부 443을 열어 두는 것까지만 확인했습니다 |
| 실패 알림의 실제 도달 | **미검증** |
| LXC 게스트의 `digest` 키 | **미검증.** 지금 클러스터에는 QEMU VM만 있어 PVE API 스키마로만 확인했습니다 |
