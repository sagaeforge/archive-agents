# 복원 런북

사람이 Claude 없이 따라 할 수 있는 절차다. 근거는 ADR-0001 17장이다. 모든 명령은 WSL 셸에서 한다.
`<KB>` 는 데이터 폴더(기본 `/home/user/sagae-kb-data`)이고 `<REPO>` 는 이 저장소 폴더다.

## 0. 준비물

- restic 비밀번호(`~/.config/sagae-kb/secrets.env`의 `RESTIC_PASSWORD`). 이 파일이 디스크와 함께 사라졌다면 보관해 둔 사본에서 찾는다(결정 4). 비밀번호가 없으면 restic 사본은 열 수 없다.
- 사본이 있는 곳: `/mnt/c/Users/<사용자>/kb-restic`(사본 A), 외장 SSD E:의 `/mnt/e/kb-restic`(사본 B, 머신 밖).
- 이 저장소의 `uv.lock`, `ops/restic/`.

## 처음 설정(사용자 입회, 결정 2, 3, 4)

```
cp <REPO>/ops/restic/targets.example.yaml ~/.config/sagae-kb/targets.yaml    # 경로를 고친다
install -m 600 /dev/null ~/.config/sagae-kb/secrets.env                       # RESTIC_PASSWORD=... 를 적는다
kb ship --init local-c                  # restic init
# E: 를 마운트한 뒤(2장)
kb ship --init offsite-e                # 마운트 확인 -> restic init -> 마커 .kb-offsite-id 기록
kb ship --dry-run --json                # targets[].available 이 둘 다 true 인지
kb ship --fingerprint && kb drill restore --offsite   # 통과하면 kb fp open
```

## 1. restic 설치

```
cd <REPO>
source ops/bin/env.sh            # KB_TOOLCHAIN 등을 내보낸다
ops/restic/install-restic.sh     # 0.19.1, SHA256SUMS 확인 뒤 $KB_TOOLCHAIN/bin/restic
export PATH="$KB_TOOLCHAIN/bin:$PATH"
```

수동으로 하려면 `https://github.com/restic/restic/releases/tag/v0.19.1` 의 `SHA256SUMS` 로 `restic_0.19.1_linux_amd64.bz2` 를 확인한 뒤 `bunzip2` 하고 `chmod 755` 한다.

## 2. 외장 SSD E: 마운트(사본 B를 쓸 때)

`kb` 는 마운트하지 않는다. 사용자가 직접 한다. 드라이브를 꽂아 둔 채 재부팅하면 자동으로 마운트되는 것을 확인했다(2026-11-01 03:12 재부팅 뒤 `/mnt/e` 자동 마운트). 드라이브가 빠져 있거나 마운트가 풀렸을 때만 아래 명령으로 직접 마운트한다.

```
sudo mkdir -p /mnt/e
sudo mount -t drvfs E: /mnt/e
findmnt -T /mnt/e -o TARGET,SOURCE,FSTYPE,OPTIONS     # SOURCE E:\, FSTYPE 9p(drvfs), OPTIONS에 aname=drvfs
cat /mnt/e/kb-restic/.kb-offsite-id                    # offsite-e
```

TARGET, SOURCE, FSTYPE, 마커 중 하나라도 어긋나면 `kb ship` 은 이 대상을 건너뛴다(`offsite_unmounted`). `metadata` 옵션은 확인하지 않는다. 이미 마운트돼 있으면 `sudo umount /mnt/e` 뒤 위 명령으로 다시 한다.
`/mnt/e` 가 마운트돼 있지 않으면 빈 ext4 디렉터리라 거기에 쓰면 사본이 ext4에 생긴다. 위 `findmnt` 가 `E:\` 를 보여 줄 때만 진행한다.

## 3. 저장소 열기

```
export RESTIC_REPOSITORY=/mnt/e/kb-restic          # 또는 /mnt/c/Users/<사용자>/kb-restic
export RESTIC_PASSWORD='<비밀번호>'
restic snapshots --host kb
restic unlock                                       # 낡은 잠금만 지운다
restic check --read-data-subset 1/30                # 선택. 전체 확인은 --read-data
```

태그: `t0`(원장 사본, 내보내기, raw/fp, spool, inbox, 앵커), `t1`(raw/objects, models, wheels), `t3`(ops.db, ops/runs. 사본 A만).

## 4. 복원(스테이징 폴더로)

`--target /` 로 원래 자리에 바로 풀지 않는다. restic 은 상위 폴더(`/home` 등)의 메타데이터를 건드릴 수 있다. 디스크의 스테이징 폴더에 풀고 옮긴다. `/tmp` 는 메모리(16GB)라 쓰지 않는다.

```
STAGE=$HOME/kb-restore-stage ; mkdir -p "$STAGE"
restic restore latest --host kb --tag t0 --target "$STAGE"
restic restore latest --host kb --tag t1 --target "$STAGE"     # 없으면 건너뛴다(7장)
find "$STAGE" -maxdepth 8 -name ship -type d      # 이 폴더의 부모가 원래 <KB> 의 내용이다
```

찾은 `.../ship` 의 부모 폴더에 `ledger`, `raw`, `spool`, `inbox`, `ship` 이 있다. 새 `<KB>` 로 옮긴다(아래 `<STAGE의 KB>` 를 그 부모 경로로 바꾼다).

```
mkdir -p <KB>
cp -a <STAGE의 KB>/. <KB>/
rm -rf "$STAGE"
```

## 5. 원장 복원: 체인, 앵커, 유실 범위, epoch

```
export KB_HOME=<KB>
cd <REPO>
ops/bin/dev kb drill restore --ledger <KB>/ship/ledger.db --anchors <앵커 파일> --json
```

- 한 명령이 체인 검증, 무결성 검사, 앵커 대조, 유실 범위 기록, `schema.epoch_bumped` 를 돈다.
- `--anchors` 는 더 새로운 앵커가 있을 때 준다(healthchecks 핑 본문에 남긴 `{seq, head_hash, at}` 를 한 줄씩 적은 파일, 또는 살아 있는 다른 사본의 `ledger/anchors.ndjson`). 복원본 안의 `ledger/anchors.ndjson` 은 항상 함께 본다.
- 출력의 `lost` 가 null 이 아니면 복원본이 앵커보다 뒤다. `lost.from_seq..to_seq` 가 사라진 이벤트이고 `schema.epoch_bumped` 이벤트와 `ops.db` 의 사고 `restore_loss` 에 남는다. 그 구간의 입력은 다시 넣어야 한다(보관해 둔 세션 기록, 수집 재실행).
- 앵커까지 함께 낡았으면 `lost` 는 null 이지만 epoch 은 오른다. 소비자는 epoch 변화로 재동기화한다.
- `ok: false` 와 `chain.ok: false` 이면 사본이 손상된 것이다. `ledger/ledger.db.bad` 로 옮겨 두고 설치하지 않는다. 6장으로 간다.
- 이미 `ledger/ledger.db` 가 있으면 거절한다. 덮어쓰지 않는다.

## 6. 원장 사본이 없거나 깨졌을 때: 내보내기로 재구성

봉인 세그먼트(`ledger/export/`)가 평문 복구 경로다. 사본(`ship/ledger.db`)이 없거나 5장이 체인 실패를 내면:

```
ops/bin/dev kb drill restore --from-export --json
```

세그먼트의 봉인 해시와 체인을 확인하며 원장을 다시 만든다. 봉인 이후의 이벤트는 없다. 앵커가 그 범위를 알려 준다.

## 7. 객체, spool, inbox, 휠하우스

- `raw/objects` 는 `t1` 이라 하루까지 원장보다 뒤일 수 있다. 4장에서 함께 복원했다. `t1` 이 없으면 객체는 비어 있고 8장이 채운다.
- `spool/in`, `spool/fp-held`, `inbox/` (`.done` 포함)는 4장에서 복원됐다. 보류 항목은 다음 `kb tick` 이 적재한다.
- 환경: `<KB>/runtime/wheels` 가 있으면 `uv sync --frozen --offline --no-index --find-links <KB>/runtime/wheels` (<REPO> 에서). 없으면 `ops/restic/build-wheelhouse.sh` 로 다시 받는다.

## 8. gold 재구축과 지문

```
ops/bin/dev kb rebuild gold --allow-missing
ops/bin/dev kb verify all
```

없는 CAS 객체는 `gap.recorded` 와 재수집 큐(`recapture`)로 넘어간다. 첫 `kb tick` 이 다시 가져온다.
`kb ship --fingerprint` 로 보낸 사본의 `ship/ship.json` 에는 그 시점의 gold 지문(`gold_fp`)이 있다. `kb drill restore --level full` 이 복원본을 재구축해 이 지문과 비교한다(아래 훈련).

## 9. 재개

```
ops/bin/dev kb tick --until-idle
ops/bin/dev kb status
```

그리고 `kb ship --force` 로 복원본을 새 사본으로 올린다.

## 훈련(복원 연습)

```
kb drill check                    # restic check --read-data-subset n/30 (매일 순환)
kb drill restore --level ledger   # T0 복원 + 체인 + 앵커 (매주)
kb drill restore --level full     # T0+T1 복원 + 재구축 + 지문 (매월)
kb drill restore --offsite        # 사본 B에서 full. 통과하면 7일 안에 kb fp open 이 열린다
```

`--offsite` 는 `findmnt` 와 마커 확인을 통과하지 못하면 돌지 않는다(기록도 쓰지 않는다). 훈련 홈은 `<KB>/drill/` 이고 끝나면 지운다(`--keep` 으로 남긴다).

## 자주 겪는 문제

| 증상 | 조치 |
|---|---|
| `repository is already locked` | 다른 restic 이 실제로 도는지 `pgrep restic` 로 본다. 없으면 `restic unlock`. `kb ship` 은 매번 unlock 과 `--retry-lock 2m` 을 쓴다 |
| `kb ship` 이 offsite-e 를 건너뜀 | 2장의 `findmnt` 와 마커를 본다. `kb ship --dry-run --json` 의 `targets[].reason` 이 이유다 |
| 마커 없음/불일치 | 다른 드라이브다. 맞는 드라이브면 `echo offsite-e > /mnt/e/kb-restic/.kb-offsite-id` |
| I/O 오류로 한 대상만 실패 | 드라이브를 다시 꽂고 마운트한다. 다음 `kb ship` 이 unlock 뒤 `check` 를 먼저 돈다 |
| NTFS 위 restic | C:와 E:에서 실측했고 권한·fsync 오류는 없었다. 열린 과제는 맨 아래 참조 |

## 열린 과제

- 메타데이터 옵션(`-o metadata`)으로 만든 저장소를 옵션 없이 읽는 경우는 실측하지 않았다. 다음 재부팅 뒤 `kb ship --dry-run --json`, `restic check --read-data`(3장 저장소 환경), `kb drill restore --offsite`로 확인한다.
