# 삭제(redact) 런북

민감 정보가 잘못 들어갔거나 지워 달라는 요청이 있을 때 쓴다. 근거는 ADR-0001 7.9 표와 17장이다.
체인은 유지된다(해시는 본문이 아니라 본문 해시를 묶는다). 지우는 것은 본문이다.

## 한눈에

| 단계 | 명령 | 대상 |
|---|---|---|
| 1 | `kb redact <id> --reason "사유"` | 원장 payload, WAL, 봉인 세그먼트(재봉인), CAS 객체, spool, inbox, ops/runs, gold(재구축), 원장 사본 `ship/` |
| 2 | `kb redact <id> --purge-git <export/first_party> --git-path records/<파일>` | 내보내기 git 이력 |
| 3 | `kb redact <id> --purge-restic [--target ID]` | restic 과거 세대(/mnt/c, E:) |

1단계는 TTY 에서만 돈다. 실수 방지용이고 같은 UID 앞에서 보안 경계가 아니다. 2, 3단계는 사용자 승인 뒤에 한다(이력 재작성, 외장 SSD 쓰기).

## 1단계: 로컬

```
kb redact f-xxxx --reason "토큰이 들어갔다" --json
```

출력에서 확인한다.

- `wal_cleared: true`. false 이면 읽기 연결이 체크포인트를 막고 있어 평문이 `ledger.db`/`-wal` 에 남아 있다. `ok: false` 로 끝난다. 열린 `kb` 읽기 프로세스를 닫고 같은 명령을 다시 한다(멱등이다).
- `shared` 와 `shared_report`: 다른 레코드가 같은 본문(또는 같은 CAS 객체)을 쓰면 지우지 않고 공유 ID 를 보고한다. 그 레코드도 지울지는 사용자가 정한다. 마지막 사용자가 지워질 때 객체가 함께 지워진다.
- `resealed`: 지운 본문이 든 모든 봉인 세그먼트를 재봉인했고 `ledger/export/MANIFEST.ndjson` 에 `resealed` 행이 붙었다. 같은 본문이 여러 달에 걸쳐 있어도 세그먼트마다 한다.
- `spool`, `inbox`, `runs`: 같은 ID 의 대기 이벤트, 같은 ID 나 본문의 파일, 실행 스트림 행을 지웠다. 다른 레코드의 대기 이벤트는 남는다.
- `tmp`: 크래시가 남긴 `.tmp-*` 중 묵은 것(기본 1분, 평문이 든 것은 즉시)을 지웠다.
- `ship_copies`: `<KB>/ship/ledger.db` 는 지우기 전 평문을 갖고 있어 지웠다. 다음 `kb ship` 이 새로 만든다.
- gold 는 기본으로 다시 만든다(`--no-rebuild` 로 건너뛸 수 있고 그때는 경고가 붙는다). 옛 gold 빌드는 지운다. `publish/`, `derived/vec` 가 있으면 그것도 다시 만든다(해당 명령은 WP-10, WP-20).

삭제된 본문은 gold 에서 `[redacted]` 로 보이고 일반 읽기는 404/410 이다.

## 2단계: 내보내기 git

`export/first_party` 는 로컬 작업 트리만 있고 푸시하지 않는다(결정 2, 13). 이 레코드가 public/internal 이었고 커밋돼 있다면 이력에 남아 있다.

```
kb redact f-xxxx --purge-git <KB>/export/first_party --git-path records/<인코딩된 id>.md
```

내부에서 `git filter-branch --index-filter 'git rm --cached --ignore-unmatch'`, `refs/original` 삭제, `reflog expire`, `gc --prune=now` 를 돈다. 파일 이름은 `python -c 'from kb.guard.export_md import rel_path; print(rel_path("f-xxxx"))'`. 원격 저장소가 있고 이미 푸시했다면 이 명령은 로컬만 고친다. 원격은 사용자가 강제 푸시로 따로 바꾸고, 다른 복제본(포크, 캐시)에도 남을 수 있다.
`git filter-repo` 가 설치돼 있으면 그것이 권장 도구다. 이 환경에는 없어서 `filter-branch` 를 쓴다.

## 3단계: restic 과거 세대

사본 A(`/mnt/c`)와 사본 B(E:)는 append-only 가 아니다. rewrite + prune 으로 지운다. append-only 대상을 나중에 더하면 prune 이 막히므로 그때 결정 2 의 삭제 절차를 따로 정한다.

E: 는 마운트돼 있어야 한다(`restore.md` 2장). 마운트 확인을 통과하지 못한 대상은 건너뛰고 `skipped` 로 보고한다.

```
kb redact f-xxxx --purge-restic            # 모든 대상. --target offsite-e 처럼 고를 수 있다
```

내부 순서:

1. 해당 대상에 `kb ship --force`(모든 계층)를 먼저 돌려 지운 뒤의 깨끗한 최신 스냅샷을 만든다.
2. 지운 파일(CAS 객체, spool/inbox 파일)은 모든 스냅샷에서 제외한다. 바뀐 파일(재봉인한 세그먼트, 새 원장 사본, ops/runs)은 태그별 최신 스냅샷만 남기고 과거 스냅샷에서 제외한다: `restic rewrite --forget --exclude-file ...`.
3. `restic prune`.

옛 시점으로 되돌아가야 한다면 과거 스냅샷에서는 원장 사본이 빠져 있다. 최신 스냅샷(깨끗한 사본)과 내보내기 세그먼트로 복원한다(`restore.md` 5, 6장). 외장 SSD 위 prune 은 느리다.

## 검증

복원본에서 찾는다(평문 조각을 알 때).

```
for id in $(restic snapshots --json | jq -r '.[].id'); do
  restic restore $id --target $HOME/verify-$id && grep -rIl --binary-files=text "<조각>" $HOME/verify-$id
done
git -C <KB>/export/first_party log -p --all | grep -c "<조각>"
```

SQLite 파일과 zst 로 압축된 세그먼트, CAS 객체는 `grep` 에 보이지 않으니 `zstd -dc` 로 풀어 본다(CAS 객체는 끝 32바이트가 해시 꼬리표다). 이 저장소의 `tests/backup/test_redact_chain.py` 가 같은 검증을 한다.

체인: `kb verify chain` 이 ok 여야 한다.

## 다시 쓰기 금지

지운 본문과 같은 내용을 다시 쓰려 하면 원장이 거부한다(`RedactedPayload`). 지운 비밀이 되살아나지 않게 하는 장치다.
