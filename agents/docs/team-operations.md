# 팀 운영

메인 세션은 작업을 직접 하지 않고 팀을 조율합니다. 워커를 기다리느라 멈춰서도 안 됩니다. 이 문서는 팀을 어떤 방식으로 띄우고 결과를 어떻게 기다리는지 정리합니다.

## Workflow와 Orca 워커 고르기

기준은 실행 중에 판단이 필요한지입니다. 순서를 스크립트로 미리 정할 수 있으면 Workflow를 쓰고, 진행 상황을 보며 조율해야 하면 Orca 워커를 씁니다.

| 기준 | Workflow | Orca 워커 |
|---|---|---|
| 맞는 작업 | 감사, 리뷰, 대량 마이그레이션처럼 순서를 미리 정할 수 있는 작업 | 결과를 보고 다음 지시를 정해야 하는 장기 작업 |
| 실행 중 소통 | 없습니다. 단계 사이에 확인이 필요하면 단계마다 따로 실행합니다 | 워커가 `question`, `escalation`으로 묻고 메인 세션이 답합니다 |
| 실행 주체 | Claude 서브에이전트 | 별도 터미널의 Claude, Codex 등 |
| 세션을 끝내면 | 저절로 이어지지 않습니다. 세션으로 돌아와 다시 실행해야 합니다 | Run이 Orca에 남습니다. `run-use --id <run_id>`로 이어받습니다 |
| 기다리는 방법 | 필요 없습니다. 백그라운드로 돌고 끝나면 결과가 세션에 나타납니다 | 백그라운드 Bash로 대기 스크립트를 돌립니다 |

## 워커는 백그라운드 Bash로 기다리기

메인 세션은 `orchestration check --wait`, `terminal wait`, `sleep` 반복으로 기다리지 않습니다. 대기는 스크립트 `.claude/hooks/team-watcher-wait.mjs`를 Bash `run_in_background: true`로 돌려 맡깁니다. 스크립트가 끝나면 세션이 깨어나 JSON 한 줄을 읽습니다. 대기 중에는 모델 토큰이 들지 않고, 배치가 아무리 커도 결과는 짧은 한 줄이며, 메시지 제목과 본문은 모델에 전달되지 않습니다.

서브에이전트에게 맡기지 않는 이유: 2026-11-01(Claude Code 2.1.316)에 `team-watcher` 서브에이전트의 Bash 대기가 `timeout: 600000`인데도 180초에 백그라운드로 넘어갔고, 에이전트가 대기를 다시 돌린 뒤 출력 파일을 읽으려다 막혀 이벤트 없이 `watcher_failed`로 끝났습니다. 메인 세션이 직접 돌린 대기는 같은 날 4번 모두 성공했습니다.

1. 한 웨이브의 워커를 모두 시작합니다.
2. 대기 스크립트를 백그라운드 Bash로 돌리고 턴을 끝냅니다.

   ```sh
   node "$(git rev-parse --show-toplevel)/.claude/hooks/team-watcher-wait.mjs" run=<run_id> legs=3 leg=1
   ```

   `run_in_background: true`로 호출합니다. `run`은 지켜볼 Run ID이고 필수입니다. `run-current --json`으로 확인합니다. 명시해야 세션이 Run에서 떨어졌을 때 조용히 빈 결과를 내지 않고 오류로 드러납니다.

   `legs`가 합의한 시간 제한입니다. 1에서 4까지 쓸 수 있고 한 번에 최대 5분씩 기다리므로 `legs=3`은 15분입니다. 범위를 벗어나면 스크립트가 기다리지 않고 `invalid_legs` 오류를 돌려줍니다. `leg`는 지금이 몇 번째 대기인지이고 처음에는 1입니다. 이벤트가 오면 제한과 상관없이 바로 돌아옵니다.
3. 스크립트가 끝나면 세션이 깨어납니다. 출력의 JSON 한 줄을 읽고 아래 표대로 처리합니다. 출력이 파일로 저장되면 그 경로를 메인 세션이 직접 읽습니다.
4. `{"status":"wait","nextLeg":k}`이면 같은 명령을 `leg=k`로 다시 백그라운드로 돌리고 턴을 끝냅니다. 모든 Dispatch가 끝날 때까지 2번으로 돌아갑니다.

| 결과 | 뜻 | 메인 세션이 할 일 |
|---|---|---|
| `event` | `worker_done`, `escalation`, `question`이 도착했습니다 | 배치를 처리하고 ack한 뒤 `leg=1`로 대기를 다시 돌립니다 |
| `checkpoint`의 `unacked_batch` | 이벤트 없는 미확인 배치가 남아 대기가 바로 끝났습니다. 배치는 오래된 순서로 최대 50개라 이벤트가 그 뒤에 있을 수 있습니다 | `event`와 같습니다 |
| `checkpoint`의 `time_limit`, `empty`, `cancelled` | 이벤트가 없습니다. 실패가 아닙니다 | 대기를 `leg=1`로 다시 돌립니다. 세 번 연속이면 먼저 `worker-list --include-remote --json`으로 워커를 확인합니다 |
| `error`, 또는 JSON 없이 끝남 | 대기 자체가 실패했습니다. 워커가 멈췄다는 뜻도, 메일이 없다는 뜻도 아닙니다 | `code`와 `message`를 읽고 원인을 해결한 뒤 대기를 다시 돌립니다. 대기는 다시 시작해도 안전합니다. 같은 오류가 반복되거나 원인을 찾을 수 없으면 대기를 그만 돌리고 아래 `check --run <run_id> --json`으로 받은편지함을 직접 읽습니다 |

배치 처리는 항상 메인 세션이 합니다. 대기 결과는 알림일 뿐이므로 내용은 Orca에서 직접 읽습니다. 아래 명령은 기다리지 않고 바로 끝납니다. `orca-ide` 자리에는 `$ORCA_CLI_COMMAND` 값을 씁니다. 배치가 크면 Bash가 출력을 파일로 저장하고 미리보기만 보여 주므로, 메인 세션은 그 파일을 읽어 전체를 확인합니다.

```sh
orca-ide orchestration check --run <run_id> --json
orca-ide orchestration reply --id <message_id> --body "<답변>" --json
orca-ide orchestration worker-release --dispatch <dispatch_id> --json
orca-ide orchestration check --run <run_id> --ack <delivery_id> --json
```

첫 명령은 미확인 배치를 다시 읽고, 마지막 명령은 ack한 뒤 다음 배치를 받습니다. `check`에는 항상 `--run`을 붙입니다. 세션이 Run에서 떨어진 상태에서 `--run` 없이 실행하면 Run 메일함이 아니라 직접 메일함을 읽어, 메일을 읽음 처리하고 다시 전달하지 않습니다. `worker_done`이 Run 메일함에 있는데 `count`가 0으로 나올 수도 있습니다. Orca 소스로 확인한 동작이고 실제로 실행해 보지는 않았습니다.

`--ack` 결과의 `deliveryId`가 `null`이 될 때까지 처리와 ack를 반복한 뒤 대기를 돌립니다. ack하지 않은 배치는 설계상 다시 전달되므로, 남겨 두면 다음 대기가 같은 배치를 바로 돌려줍니다.

## 주의할 점

- 대기 스크립트는 ack, reply, release, stop, retry를 하지 않습니다. 받은편지함을 읽기만 하고 끝나므로 처리는 모두 메인 세션이 합니다.
- 스크립트는 현재 폴더가 속한 git 저장소의 루트에서 찾습니다. 그래서 `plugins/proxmox` 같은 하위 폴더에서 시작한 세션에서도 동작합니다. git 저장소 밖에서는 명령이 실패해 대기가 출력 없이 끝납니다.
- `checkpoint`나 `error`는 워커 종료의 증거가 아닙니다. 프로세스 종료를 확인하기 전에는 stop, abandon, retry를 하지 않습니다.
- 세션을 띄운 Orca 창을 닫아도 세션은 tmux에서 살아 있을 수 있지만, Orca의 터미널 핸들은 사라집니다. 진행 중이던 대기는 출력 없이 끝나거나 멈출 수 있고, 멈춘 대기는 5분 30초 뒤 `wait_stalled` 오류가 됩니다. 이후의 대기는 `consumer_fenced` 오류를 돌려줍니다. `run-current --json`이 `null`이면 `run-use --id <run_id>`로 다시 연결합니다. 이 상황의 재연결은 아직 실제로 확인하지 못했습니다.
- Run 하나에 대기 하나만 돌립니다. 더 돌려도 메시지는 사라지지 않지만 같은 알림이 중복됩니다.
- 세션을 재시작하면 백그라운드 대기도 사라집니다. `run-use --id <run_id>`로 Run을 이어받고 밀린 배치를 처리한 뒤 다시 돌립니다.
