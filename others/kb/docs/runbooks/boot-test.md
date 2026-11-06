# 부팅 입회 시험 (WP-14, ADR-0001 18장)

사용자 입회와 결정 3 승인 뒤에만 돈다. 재부팅과 `wsl --terminate`는 세션을 죽이므로 자동으로 돌리지 않는다.

## 준비

```
source ops/bin/wp-env.sh WP-14 --live
ops/bin/deploy
bash ops/bin/install-units.sh --apply      # 외장 SSD 전송은 --with-tcp와 무관
```

결과는 `ops.db`의 `boot_test(step, ok, note)`에 기록한다. 1~6 전부 통과하면 `kb status`의 `boot_path_unverified`가 사라진다.

## 1. wsl --shutdown 뒤 작업 스케줄러만으로 catch-up 완주

- 단계: 작업 `kb-tick` 등록 확인(`schtasks.exe /Query /TN kb-tick`). PowerShell에서 `wsl --shutdown`. 로그온 트리거 또는 6시간 반복을 기다리거나 `schtasks.exe /Run /TN kb-tick`.
- 기대: 작업이 distro를 깨워 `kb tick --until-idle`을 끝까지 돈다. `kb status --json`의 `freshness.last_tick_at`이 갱신된다. 재부팅 뒤 `/mnt/e`가 마운트돼 있지 않으면 `kb ship`이 offsite-e를 건너뛰고 `offsite_unmounted`를 낸다. 사용자가 수동으로 마운트(`findmnt /mnt/e`로 TARGET, SOURCE, FSTYPE 확인)한 뒤 다음 박동이 전송을 잇는다.
- 되돌림: `schtasks.exe /Delete /TN kb-tick /F`. 마운트 해제는 `sudo umount /mnt/e`.

## 2. 클라이언트 없는 부팅에서 tick이 끊긴 뒤 이어 가는가

- 단계: tick 실행 중 모든 WSL 클라이언트를 닫아 15초 뒤 distro가 내려가게 한다. 다시 연다.
- 기대: 잠금이 남지 않고(`kb status`에 정지 tick 없음) 다음 박동이 이어 간다. 잃는 데이터 없음(kill 안전).
- 되돌림: 남은 잠금이 있으면 `kb doctor` 안내를 따른다. 원장은 수정하지 않는다.

## 3. linger 유무별 사용자 타이머 기동, kb-read.socket 재부팅 후 첫 호출

- 단계: (a) linger 켠 상태(`loginctl show-user sagae -p Linger`가 yes)에서 Windows 재부팅 후 로그온 없이 `systemctl --user list-timers`. (b) `loginctl disable-linger sagae` 뒤 같은 절차. (c) 재부팅 후 첫 호출 `curl --unix-socket ~/sagae-kb-data/run/read.sock http://localhost/v1/meta`와 지연 기록.
- 기대: linger 켜면 타이머가 로그온 없이 뜬다. `/v1/meta` 첫 호출이 성공하고 지연을 `boot_test.note`에 남긴다.
- 되돌림: `loginctl enable-linger sagae`(기본 운영 상태).

## 4. 쓰기 중 wsl --terminate

- 단계: `kb put`을 반복하는 동안 PowerShell에서 `wsl --terminate <distro>`. 다시 열어 `kb verify all`.
- 기대: 원장 접두사가 유지되고 `kb verify all` 통과. 유실 건수를 `note`에 기록(스풀 대기분 제외).
- 되돌림: 실패하면 `docs/runbooks/restore.md`.

## 5. 절전 복귀 시 타이머와 시계 편차

- 단계: Windows를 절전에 넣었다 깨운다. 전후로 `date`, `systemctl --user list-timers`, `kb status --json`.
- 기대: 시계 편차가 보정되고 타이머가 다음 박동을 실행한다. 놓친 시점은 `gap`으로 남는다.
- 되돌림: 없음(읽기 전용 관찰). 편차가 크면 `sudo hwclock -s`.

## 6. kb-agent.service 1회

- 단계: 저장소 밖(`cd ~`)에서 `systemctl --user start kb-agent.service`, 뒤이어 `journalctl --user -u kb-agent.service -n 50`.
- 기대: `runtime/share`의 실행 파일과 설정을 찾아 `kb jobs run`이 끝까지 돌고 exit 0.
- 되돌림: `systemctl --user stop kb-agent.service`.

## 전체 되돌림

```
systemctl --user disable --now kb-tick.timer kb-agent.timer kb-read.socket kb-read-tcp.socket
rm ~/.config/systemd/user/kb-*.{timer,service,socket}; systemctl --user daemon-reload
schtasks.exe /Delete /TN kb-tick /F
```
