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
| 기다리는 방법 | 필요 없습니다. 백그라운드로 돌고 끝나면 결과가 세션에 나타납니다 | `team-watcher`에 맡깁니다 |

## 워커는 team-watcher로 기다리기

메인 세션은 `orchestration check --wait`, `terminal wait`, `sleep` 반복으로 기다리지 않습니다. 대기는 `team-watcher` 서브에이전트가 맡습니다. Haiku로 실행되고 Bash 외의 도구가 없습니다.

1. 한 웨이브의 워커를 모두 시작합니다.
2. `Agent` 도구로 `team-watcher`를 띄우고 턴을 끝냅니다. 정의에 `background: true`가 있어 항상 백그라운드로 실행되므로 메인 세션은 멈추지 않습니다.

   ```text
   Agent(subagent_type: "team-watcher", description: "Watch Orca inbox", prompt: "run=<run_id> legs=3")
   ```

   `run`은 지켜볼 Run ID이고 필수입니다. `run-current --json`으로 확인합니다. 명시해야 세션이 Run에서 떨어졌을 때 조용히 빈 결과를 내지 않고 오류로 드러납니다.

   `legs`가 합의한 시간 제한입니다. 1에서 4까지 쓸 수 있고 한 번에 최대 5분씩 기다리므로 `legs=3`은 15분입니다. 생략하면 3이고, 범위를 벗어나면 기다리지 않고 `invalid_legs` 오류를 돌려줍니다. 이벤트가 오면 제한과 상관없이 바로 돌아옵니다.
3. 끝나면 JSON 한 줄이 메인 세션에 도착합니다. 아래 표대로 처리합니다.
4. 모든 Dispatch가 끝날 때까지 2번으로 돌아갑니다.

| 결과 | 뜻 | 메인 세션이 할 일 |
|---|---|---|
| `event` | `worker_done`, `escalation`, `question`이 도착했습니다 | 배치를 처리하고 ack한 뒤 watcher를 다시 띄웁니다 |
| `checkpoint`의 `unacked_batch` | 이벤트 없는 미확인 배치가 남아 대기가 바로 끝났습니다 | `event`와 같습니다 |
| `checkpoint`의 `time_limit`, `empty`, `cancelled` | 이벤트가 없습니다. 실패가 아닙니다 | watcher를 다시 띄웁니다. 세 번 연속이면 먼저 `worker-list --include-remote --json`으로 워커를 확인합니다 |
| `error`, 또는 JSON 없이 끝남 | 대기 자체가 실패했습니다. 워커가 멈췄다는 뜻은 아닙니다 | `code`와 `message`를 읽고 원인을 해결한 뒤 watcher를 다시 띄웁니다. 대기는 다시 시작해도 안전합니다 |

배치 처리는 항상 메인 세션이 합니다. watcher 결과는 알림일 뿐이므로 내용은 Orca에서 직접 읽습니다. 아래 명령은 기다리지 않고 바로 끝납니다. `orca-ide` 자리에는 `$ORCA_CLI_COMMAND` 값을 씁니다.

```sh
orca-ide orchestration check --json                      # 미확인 배치를 다시 읽습니다
orca-ide orchestration reply --id <message_id> --body "<답변>" --json
orca-ide orchestration worker-release --dispatch <dispatch_id> --json
orca-ide orchestration check --ack <delivery_id> --json  # ack하고 다음 배치를 받습니다
```

`--ack` 결과의 `deliveryId`가 `null`이 될 때까지 처리와 ack를 반복한 뒤 watcher를 띄웁니다. ack하지 않은 배치는 설계상 다시 전달되므로, 남겨 두면 다음 watcher가 같은 배치를 바로 돌려줍니다.

## 주의할 점

- watcher는 ack, reply, release, stop, retry를 하지 않습니다. `.claude/hooks/team-watcher-guard.mjs`가 대기 명령 외의 Bash를 모두 막습니다. 대기 명령을 바꾸면 정의와 훅을 함께 고치고 `node --test .claude/hooks/team-watcher-guard.test.mjs`를 실행합니다.
- 프로젝트 서브에이전트의 훅은 폴더를 신뢰한 뒤에만 실행됩니다. 신뢰하지 않은 폴더에서는 watcher를 쓰지 않습니다.
- `checkpoint`나 `error`는 워커 종료의 증거가 아닙니다. 프로세스 종료를 확인하기 전에는 stop, abandon, retry를 하지 않습니다.
- 세션을 띄운 Orca 창을 닫아도 세션은 tmux에서 살아 있을 수 있지만, Orca의 터미널 핸들은 사라집니다. 진행 중이던 대기는 출력 없이 끝나거나 멈출 수 있고, 멈춘 대기는 5분 30초 뒤 `wait_stalled` 오류가 됩니다. 이후의 watcher는 `consumer_fenced` 오류를 돌려줍니다. `run-current --json`이 `null`이면 `run-use --id <run_id>`로 다시 연결합니다. 이 상황의 재연결은 아직 실제로 확인하지 못했습니다.
- Run 하나에 watcher 하나만 띄웁니다. 더 띄워도 메시지는 사라지지 않지만 같은 알림이 중복됩니다.
- 세션을 재시작하면 watcher도 사라집니다. `run-use --id <run_id>`로 Run을 이어받고 밀린 배치를 처리한 뒤 다시 띄웁니다.
- 세션 시작 때 `.claude/agents/`가 없었으면 새 정의를 감지하지 못합니다. 처음 병합한 뒤에는 세션을 재시작합니다.
