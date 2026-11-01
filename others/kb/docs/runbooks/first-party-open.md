# first_party 개방 런북

first_party 쓰기(사용자 기록, 세션 기록)는 머신 밖 사본 경로가 확인되기 전까지 원장에 들어가지 않는다. 이 문서는 개방 절차와 그 전후 상태를 다룬다. 근거는 ADR-0001 8장 "first_party 게이트"와 17장 "백업"이다.

## 상태 확인

```
kb fp status --json      # {"held": <보관 항목 수>, "open": <개방 여부>}
kb fp list [--grep 어휘]  # 보관 중인 본문을 찾는다(대소문자 무시, 여러 단어는 모두 포함)
```

- 닫혀 있을 때 `kb put`, `kb_put`, `kb intake`, `inbox/*.md`는 응답 `{held: true, reason: "offsite_path_missing"}`를 받고 `spool/fp-held/<sha>.json`에 fsync로 남는다. 아직 조회되지 않는다.
- 보관 파일은 T0 데이터다. 지우지 않는다. `kb ship --if-dirty`의 dirty 판정에 든다.
- 같은 멱등 키로 다시 보내도 파일은 늘지 않는다. 키가 같고 내용이 다르면 `idempotency_conflict`다.
- 보류 시각은 `authored_at`으로 보존한다. 개방 뒤 적재된 레코드의 `valid_from`이 이 시각이다.

## 정상 개방(머신 밖 복원 훈련 통과)

1. 외장 SSD E:를 `/mnt/e`에 마운트한다(사용자가 수동으로 한다, ADR-0002 결정 2).
2. `kb ship` 으로 사본을 보낸다.
3. `kb drill restore --offsite` 로 복원 훈련을 돌린다. 통과하면 `ops.db`의 `drill` 표에 `kind='restore_offsite'`, `ok=1` 행이 남는다(WP-13이 쓴다).
4. 7일 안에 `kb fp open` 을 돌린다. 훈련 기록이 없거나 7일을 넘었거나 `ok=0`이면 exit 1이다.
5. 성공하면 `system.fp_opened {mode: drill}` 이벤트가 원장에 쓰이고 보관 항목이 적재된다. 이어서 `kb fp status`가 `{"held": 0, "open": true}`를 낸다.

`kb fp open` 은 멱등이다. 이미 열려 있으면 남은 보관 항목만 적재한다. 적재가 `expected_version` 또는 멱등 충돌로 거부된 항목은 `spool/fp-held/.failed/`로 옮기고 `dlq(kind=spool_reload)`에 넣고 치명 경보를 낸다. 지워지지 않는다.

## 단일 사본 위험을 수용하고 개방

머신 밖 사본을 두지 않기로 한 경우에만 쓴다. 이 경로는 디스크 하나가 고장나면 사용자 기록을 되살릴 수 없다는 뜻이다.

```
kb fp open --accept-single-copy
```

- TTY에서만 동작한다. 비 TTY면 exit 1이다.
- `~/.config/sagae-kb/decisions.toml`의 `approved`에 결정 2가 있어야 한다.
- 위험 문구가 나오고 `단일 사본 위험을 수용합니다` 를 그대로 입력해야 한다.
- 같은 UID의 다른 프로세스 앞에서 TTY 확인은 보안 경계가 아니다. 실수 방지다.

## 개방 뒤

- 새 first_party 쓰기는 바로 원장에 들어가고 gold에 투영된다.
- 개방 전에 보낸 요청을 같은 키로 다시 보내면 첫 응답(`replayed: true`)을 받는다.
- `tick`의 recover 단계가 `spool/fp-held`에 남은 항목을 계속 적재한다(개방 경합으로 늦게 생긴 파일).

## 소유자 도구(TTY 전용)

- `kb owner read <id>`: 원장 payload 또는 `raw/fp`에서 private, secret 본문을 읽는다.
- `kb secret release <id>`: 비밀 탐지 오탐을 되돌린다. 격리 표시를 지우고 원래 민감도로 새 버전을 쓴다.
- 둘 다 같은 UID 앞에서는 실수 방지다.
