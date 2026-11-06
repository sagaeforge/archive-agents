# 설계안: 생존성 우선 정보 저장소

- 작성일: 2026-10-31
- 관점: 생존성 우선. 신선도, 링크 사망, 백업, 멱등 재수집, 장애 복구, 사망 감지에서 데이터가 절대 죽지 않는 구성을 끝까지 밀어붙인다.
- 성격: 시스템 설계 문서(CLAUDE.md 지침 5의 설계 문서 예외). 지식 데이터가 아니다.
- 입력: `docs/research/` 보고서 9건, `docs/contracts/consumers/sagae-tools.md`, 이 문서 2장의 추가 실측.
- 표기: `[D번호]`는 이 문서의 실측(2장), `[보고서명 M번호]`는 조사 보고서의 실측이다. **[추정]**은 계산값, **[미측정]**은 재지 않은 값이다.
- 구현은 시작하지 않았다. 저장소에서 바꾼 파일은 이 문서뿐이다.

## 0. 요약

**기본 입장.** 디스크는 망가지고, WSL은 예고 없이 내려가고, 소스는 사라지고, 코드에는 버그가 있고, 백업은 복원해 보기 전에는 백업이 아니다. 그래서 장애를 막는 데 기대지 않고, **무엇이 죽어도 되는지를 파일 단위로 나눈다.**

**진실은 두 가지뿐이다.**

| 구분 | 저장 | 성질 | 잃으면 |
|---|---|---|---|
| 진실 1 | 불변 WARC 세그먼트 `raw/warc/` | 받은 바이트. 쓰기 후 변경 없음 | 링크가 죽었으면 복구 불가 |
| 진실 2 | 해시 체인 원장 `ledger/ledger.db` | 추가 전용 이벤트. 사용자 기록, LLM 추출 결과, 판정 | 재현 불가 |
| 파생 | silver, gold 그래프, FTS, 벡터, 게시 사본, 색인 | 위 둘의 함수 | 지우고 `kb rebuild`로 같은 지문을 다시 얻는다 |

**이 관점이 끌어낸 결정 여덟 가지.**

1. **원장과 그래프를 다른 파일로 나눈다.** 재구축이 쓰기를 막지 않고, 대체 불가 데이터가 작은 파일 하나에 모이며, 그래프 DB는 언제든 버릴 수 있다. SIGKILL 150회에서 확인 응답 47,747건 중 유실 0건, 증분 결과와 전체 재구축의 지문이 일치했다 [D5].
2. **크래시 전용(crash-only)으로 만든다.** 정상 종료 경로에 기대지 않는다. 어느 단계든 죽으면 다음 실행이 이어 간다. WSL이 15초 뒤 끊는 구조에서 이것만 성립한다.
3. **스케줄 상태를 타이머가 아니라 데이터에 둔다.** 단일 명령 `kb tick`이 밀린 일을 표에서 계산한다. systemd, Windows 작업 스케줄러, 세션 시작, 수동 실행이 모두 같은 명령을 부르므로 트리거가 셋 죽어도 하나로 따라잡는다.
4. **검사기를 믿기 전에 검사기를 시험한다.** 실측에서 warcio `check_digests="raise"`는 잘린 레코드를 오류 없이 통과시켰고 [D2], `PRAGMA integrity_check`는 해로운 비트 플립 277건 중 222건을 놓쳤다 [D8]. 그래서 멤버 해시, 세그먼트 크기, 해시 체인을 따로 둔다.
5. **라이브 WAL DB를 경로째 교체하지 않는다.** `os.replace`는 오류 0건, `integrity_check` ok인 채로 읽기의 96%에 섞인 값을 돌려줬다 [D10]. 빌드마다 디렉터리를 만들고 symlink만 바꾼다.
6. **체인은 꼬리 절단을 못 본다. 머신 밖 앵커가 본다.** 낡은 백업은 체인 검증을 통과했고, 머신 밖에 둔 머리 해시만 3,000건 유실을 드러냈다 [D11].
7. **LLM에게 DB 쓰기 권한을 주지 않는다.** 추출기는 도구 없이 JSON만 내고, 결정적 게이트만 원장에 쓴다. 출력은 기록해서 재생하며 다시 호출하지 않는다.
8. **공백도 데이터다.** 머신이 꺼져 놓친 시점 데이터는 메울 수 없다. `gap` 이벤트로 남겨 "값이 안 변했다"와 "못 봤다"를 구분한다.

**가장 큰 구조적 약점.** 수집 주체가 상시 가동이 아닌 PC 한 대이고 물리 디스크도 하나다. 이 설계는 그 약점을 지우지 못하고 범위를 좁힐 뿐이다. 시점 소실 소스의 연속성과 디스크 장애 생존은 머신 밖 자원 없이는 불가능하므로, 사용자 결정이 필요하다(22장).

**이 관점의 비용.** 이벤트 소싱이라 옛 이벤트를 영구히 재생할 수 있어야 하고, 단일 SQLite 안보다 파일과 코드가 많다. 직접 쓸 코드는 Python 약 4,600줄로 추정한다(24장). 압축률도 일부 포기했다(사전 압축을 진실 계층에 쓰지 않는다).

## 1. 불변식

설계 판단이 충돌하면 이 순서로 결정한다. 각 불변식은 시험으로 강제한다(23장).

| ID | 불변식 | 강제 수단 |
|---|---|---|
| I1 | **바이트 우선.** 받은 바이트가 fsync되기 전에는 어떤 파생도 만들지 않는다 | 수집기 구조. 변환은 네트워크가 아니라 WARC를 읽는다 |
| I2 | **진실은 추가만 한다.** 원장은 UPDATE, DELETE가 불가능하다. 세그먼트는 봉인 후 0444다 | 트리거, 파일 권한 |
| I3 | **파생은 버려도 된다.** 파생 계층 전체를 지워도 같은 논리 지문을 다시 얻는다 | 월간 훈련, CI 재생 시험 |
| I4 | **비결정성은 기록하고 재생한다.** LLM 출력과 표시 본문 추출 결과는 재실행하지 않는다 | 추출 결과는 원장, 표시 본문은 WARC `conversion` 레코드 |
| I5 | **어디서 죽어도 된다.** 모든 단계는 멱등이고 다음 실행이 복구한다 | kill 시험을 CI에 둔다 |
| I6 | **침묵은 실패다.** 머신 밖에서 지켜보고, 훈련이 통과하지 않은 백업은 없는 것으로 친다 | healthchecks, 앵커, 정기 훈련 |
| I7 | **T0 데이터는 디스크 밖에 두 곳 이상 있다.** | 19장 |
| I8 | **낡은 값은 낡았다고 말한다.** 응답마다 시각, 생존 상태, stale 표시가 있다 | 응답 스키마 |
| I9 | **수집물은 지시가 아니다.** 저장 전후 모두 비신뢰 데이터로 다룬다 | 도구 없는 추출, 게이트, 응답 필드 분리 |
| I10 | **검사기는 시험한 것만 믿는다.** 탐지 도구는 고장을 주입해 잡는 것을 확인한 뒤 쓴다 | 2장 같은 고장 주입 시험 유지 |

## 2. 추가 실측

조사 보고서가 재지 않았고 이 설계가 기대는 항목만 쟀다. 스크립트는 scratchpad의 `durability/`에 있고 tmpfs라 재부팅하면 사라진다. 핵심 코드는 부록 A에 옮겼다.

**공통 한계.** 데이터는 공용 tmpfs에 뒀다. fsync가 공짜라 처리량은 상한값이다. 전원 손실은 재지 않았고, WAL 절단과 페이지 소실로 근사했다. 재구축 시간은 병렬 작업과 CPU를 공유한 값이다. 표본은 작고 대부분 1회 측정이다.

| ID | 시험 | 결과 | 설계 결정 |
|---|---|---|---|
| D1 | WARC 세그먼트 기본 동작. 문서 9개를 14일 재수집(일 20%가 변경) | 157레코드(response 31, revisit 95, conversion 31), 평문 8.23 MB → 1.63 MB(5.1배). 쓰기 1,012레코드/s, 전체 검증 0.019초, 오프셋 임의 접근 62/62, 건당 0.34 ms | WARC를 원시 계층으로 쓴다. revisit과 conversion이 그대로 동작한다 |
| D2 | warcio `check_digests="raise"`가 잡는 것 | **잘림은 전부 통과.** 마지막 레코드 중간 절단(gzip) 오류 없이 7건, gzip 트레일러 절단 오류 없이 8건, 비압축 본문 절단 오류 없이 8건. 변조는 `block digest failed: sha256:...`로 탐지 | warcio 검증만으로 무결성을 판단하지 않는다. 멤버 해시와 세그먼트 크기를 원장에 둔다 |
| D3 | warcio 다이제스트 동작 | 기본은 sha1. `length` 없는 레코드는 넣어 준 다이제스트를 지우고 다시 계산한다. `_create_digester` 재정의로 SHA-256이 실제 기록됨을 확인 | 작성기를 감싼다. warcio 버전을 고정한다 |
| D4 | 찢긴 꼬리 복구 240회(gzip 트레일러 절단 80회 포함) | warcio 반복자가 준 끝 오프셋을 믿는 방식: 정확 4회, 과대 236회, 그 자리에서 이어 쓰면 236회 손상. zlib으로 멤버 `eof`를 직접 확인하는 방식: 240/240 정확, 이어쓰기 240/240 | 복구에 warcio 오프셋을 쓰지 않는다. 더 나아가 **자르지 않고 새 세그먼트로 넘어간다** |
| D5 | 원장 + 투영 크래시. 쓰기 프로세스 4개, 투영 1개, SIGKILL 150회(쓰기 119, 투영 31) | 이벤트 47,628건, 확인 응답 47,747줄, 유실 0, seq 불일치 0, 멱등 재생 119건, 체인 정상. 증분 투영 지문 = 전체 재구축 지문, 배치 크기를 바꿔도 동일 | 이벤트 소싱 구조 채택 |
| D6 | 재생 처리량 50,000건(FTS bigram 포함) | 재구축 11.93초(4,191건/s), 체인 검증 448,736건/s, 지문 계산 0.23초, 원장 29.2 MB, 그래프 35.0 MB | 100만 건 약 4분 [추정, 선형] |
| D7 | 찢긴 WAL 300회(꼬리 절단 150, 중간 4 KB 소실 150). 체크포인트 없이 2,000커밋 | 300/300이 일관된 접두사로 복구. 무결성 오류 0, 체인 오류 0. 단 유실은 중앙값 1,067건, 최대 2,000건 | 깨지지는 않지만 꼬리는 잃는다. fsync가 거짓이면 체크포인트 이후가 전부 위험하다. 머신 밖 전송으로 범위를 묶는다 |
| D8 | 체크포인트된 원장 1비트 플립 300회 | `integrity_check`만 탐지 28, 체인만 탐지 222, 둘 다 27, 둘 다 못 함 23. 못 잡은 23건은 논리 내용이 원본과 동일(미사용 공간) | **`integrity_check` 단독은 해로운 플립 277건 중 222건을 놓친다.** 둘을 함께 돌리면 해로운 플립 미탐지 0건 |
| D9 | 쓰기 지연. fsync 1.3 ms 주입, 단일 세션 1,500회 | 원장 커밋 p50 1.43, p95 1.47 ms. 원장 + 투영 p50 1.59, p95 1.86, p99 4.69, 최대 7.72 ms | 이중 커밋 비용은 무시할 수 있다. 다중 세션 경합은 [미측정] |
| D10 | 파생 DB 교체 방식 | 아래 표 | 빌드별 디렉터리 + symlink |
| D11 | 종단 재해 훈련. 이벤트 23,072건 + WARC 72레코드를 restic으로 백업 후 전체 삭제 | 아래 표 | 복원 절차 확정 |
| D12 | rtk 상태 경로. 가짜 HOME, 네트워크 없음 | `XDG_DATA_HOME`을 주면 `history.db`가 그 아래 생긴다. 가짜 HOME 쓰기 없음, 실제 `history.db` 불변 | R20의 상태 경로를 프로젝트로 돌릴 수 있다 |
| D13 | 세그먼트 중간 1바이트 플립의 폭발 반경 | warcio 순차 스캔은 157건 중 79건, 8건 표본에서는 3건 뒤 중단. 멤버별 접근은 손상 1건만 실패하고 156/157 회수. 8건 표본에서 멤버 해시가 손상 레코드를 특정. 색인 없이 gzip 매직 재동기화도 156/157. 찢긴 꼬리를 그대로 둬도 색인된 레코드 7/7 읽힘 | 레코드별 gzip + 원장의 멤버 해시. 찢긴 꼬리를 고치지 않는다 |

**D10 상세.** 각 빌드의 합계를 미리 기록하고, 트랜잭션마다 합을 보존하는 쓰기를 돌리며 읽기가 기대 합계와 맞는지 봤다.

| 방식 | 읽기 | 오류 | 값 불일치 | 쓰기 | `integrity_check` |
|---|---:|---:|---:|---|---|
| 대조군: 옛 `-wal` 삭제 후 열기 | 6회 | 0 | 0행 | 해당 없음 | ok |
| 옛 `-wal` 남긴 채 파일 교체(DELETE 헤더) | 6회 | 0 | **6회 모두 20,000행 중 10,432행** | 해당 없음 | **ok** |
| 옛 `-wal` 남긴 채 파일 교체(WAL 헤더) | 6회 | 0 | **6회 모두 10,432행** | 해당 없음 | **ok** |
| 라이브 경로 `os.replace`(DELETE 헤더) | 16,785 | 0 | **16,170(96%)** | 10,455건 확인 후 옛 inode로 소실 | **ok** |
| 라이브 경로 `os.replace`(WAL 헤더) | 16,809 | 0 | **16,186(96%)** | 10,415건 확인 후 소실 | **ok** |
| 빌드별 디렉터리 + symlink | 16,326 | 0 | 0 | 10,062건 전부 현재 빌드 | ok |

SQLite 문서도 데이터베이스 파일과 저널을 어긋나게 짝지으면 손상될 수 있고, 사용 중인 파일을 지우거나 이름을 바꾸면 동작이 정의되지 않는다고 적는다 [S1]. 이 실측이 더한 사실은 **아무 오류 없이 일어난다**는 점이다. 라이브 교체에서 값이 섞인 원인은, 새 파일을 연 읽기가 같은 이름으로 남은 쓰기 프로세스의 `-wal`을 함께 읽기 때문으로 추정한다. 옛 `-wal`을 지운 대조군과 빌드별 디렉터리에서는 재현되지 않았다.

**D11 상세.** 파생 포함 라이브 47.8 MB, restic 저장소 1세대 8.9 MB, 2세대(이벤트 3,000건 추가) 증가 4.86 MB, 백업 0.82~0.96초다. 저장소는 로컬 tmpfs이므로 네트워크 비용은 빠져 있다.

| 시나리오 | 체인 | 그래프 지문 | 앵커 | 소요 |
|---|---|---|---|---|
| S1 최신 백업 복원 | 정상 | 일치 | 일치 | 3.51초 |
| S2 원장 스냅샷 없이 NDJSON 내보내기만으로 재구성 | 정상 | 일치 | 일치 | 3.00초 |
| S3 1세대(낡은) 스냅샷 + 더 새 NDJSON으로 꼬리 3,000건 복구 | 정상 | 일치 | 일치 | 2.85초 |
| S4 낡은 스냅샷만 있음 | **정상** | 불일치 | **불일치, 3,000건 유실 탐지** | 해당 없음 |

S1은 WARC 레코드 72건의 멤버 해시도 전부 확인했다. S4가 결정 6의 근거다. 잘린 체인은 그 자체로 일관되므로 체인 검증은 통과한다.

**부수 효과.** 첫 크래시 시험이 시간 제한을 넘겨 공용 tmpfs에 약 325 MB를 잠시 남겼고 지웠다. 당시 여유는 2 GB 이상이었다. 첫 측정의 sha1 동작, 불변식이 약했던 교체 시험은 무효로 처리하고 다시 쟀다. 전역 설정, crontab, systemd는 건드리지 않았다.

**기존 보고서에 더하는 정정.**

| 보고서 내용 | 정정 |
|---|---|
| `etl-orchestration.md` M21: `check_digests`로 무결성 확인 | 변조는 잡지만 잘림은 못 잡는다 [D2] |
| `general-db.md` 5.4: `os.replace` 원자 게시 | `VACUUM INTO` 사본(WAL 없음, 쓰기 없음)에서만 안전하다. 라이브 그래프에 쓰면 안 된다 [D10] |
| `general-db.md` 프로토타입: `change_log` 자체 `AUTOINCREMENT` | 재구축 때 커서가 깨진다. 원장 seq를 커서로 쓴다(7.5절) |

## 3. 전체 구조

```
 트리거(어느 것이든): systemd timer | Windows 작업 스케줄러 | 세션 시작 hook | 수동
        │  flock, 멱등
        ▼
     kb tick
        │
        ├─ fetch ──▶ raw/warc/*.warc.gz ─────────┐  진실 1 (불변)
        │                                        │
        │                                        ▼
        ├─ parse(dlt) ◀── WARC 읽기        ledger/ledger.db   진실 2 (해시 체인)
        │     ▼                                  ▲     │
        │  derived/silver ─ promote(변경분) ─────┘     │ project (applied_seq)
        │                                              ▼
        │                              derived/gold/<build>/graph.db
        │                                 ▲        │         │
 사용자·세션 쓰기 ── kb put ──▶ 원장 ─────┘        │         │
 L2 추출 ── spool ── 게이트 ──▶ 원장               ▼         ▼
                                            MCP(stdio)   HTTP /v1(소켓 활성화)
        └─ ship ──▶ restic 3곳 + git 내보내기 + 앵커(머신 밖)

 머신 밖 증인(선택) ── 봉인된 세그먼트 ──▶ raw/inbox ──▶ 멱등 수입
```

### 3.1 장애 영역

| 영역 | 포함 | 함께 죽는 것 | 살아남는 경로 |
|---|---|---|---|
| 프로세스 | `kb`, `claude -p`, dlt | 진행 중 작업 | 다음 tick |
| WSL 인스턴스 | 모든 프로세스, `/tmp` | tmpfs, 상주 서버 | ext4의 데이터, 재부팅 후 tick |
| ext4.vhdx | 라이브 데이터 전부 | 원장, 세그먼트, 파생 | `/mnt/c` restic 사본, 머신 밖 |
| 물리 SSD(1개) | C: 전체. vhdx, `/mnt/c` 사본 포함 | 위 전부 | 머신 밖만 |
| 집 | PC, Proxmox | 위 + LAN 사본 | R2, GitHub |
| 외부 소스 | 원문 사이트 | 재수집 가능성 | 이미 받은 WARC |
| 구독·인증 | `claude -p` | L2 추출 | L0, L1은 계속 돈다 |

### 3.2 등급

| 등급 | 데이터 | 복구 시점 목표(RPO) | 복구 시간 목표(RTO) | 사본 |
|---|---|---|---|---|
| T0 대체 불가 | first_party 이벤트, 첨부, 티켓, 판정, 비밀번호 | 5분 이내(머신 밖) | 2시간 [추정] | 라이브, `/mnt/c`, LAN, R2 + 평문 내보내기 |
| T1 재수집 불가 | WARC 전체, external 이벤트(LLM 출력 포함) | 1시간 이내 | 4시간 [추정] | 라이브, `/mnt/c`, LAN, R2 |
| T2 재구축 가능 | silver, gold, FTS, 색인 | 해당 없음 | 재생 시간(D6) | 라이브 1벌 |
| T3 일회용 | 벡터, 게시 사본, 캐시 | 해당 없음 | GPU 수 분 [추정] | 라이브 1벌 |
| T4 운영 | `ops.db`, 실행 기록 | 24시간 | 잃어도 지식 손실 없음 | 라이브, 낮은 빈도 백업 |

`ops.db`를 잃으면 모든 소스가 만기로 보여 한 번 더 수집될 뿐이다. 멱등이고 속도 제한이 있으므로 해롭지 않다. 잃으면 안 되는 것은 `ops.db`에 넣지 않는다.

## 4. 계층별 기술 선택

| 층 | 선택 | 근거 | 버린 안과 이유 | 출구 |
|---|---|---|---|---|
| 원시 바이트 | **WARC 1.1 레코드별 gzip**(warcio 1.8.2 + SHA-256 작성기) | ISO 표준이고 revisit, conversion, resource 의미가 이미 있다 [S4]. 세그먼트 1파일이라 파일 수 폭증이 없다. 네트워크 없이 재구축 실측 [etl M14], 임의 접근 0.34 ms [D1] | 낱개 객체 CAS: 크기는 비슷하나 수십만 파일, 자체 형식. 파일 단위 압축: 임의 접근이 안 되고 손상 뒤를 되살리기 어렵다. 순차 스캔이 멈추는 실측 [D13] | 표준 형식이라 어떤 도구로도 읽는다 |
| 사실 원장 | **SQLite + 추가 전용 + 해시 체인 + NDJSON 봉인 내보내기** | 프로세스 간 쓰기를 기본값으로 받는 유일한 임베디드 엔진 [general-db M3]. 커밋 p50 1.43 ms [D9], kill 유실 0 [D5] | 그래프 DB 단독: 재구축 시 쓰기 정지, 백업 비대. 평문 로그 단독: 멱등 키 조회와 동시성을 직접 구현해야 한다. cksumvfs: 페이지 손상은 잡지만 꼬리 절단을 못 보고 확장 로드가 필요 [S3] | NDJSON에서 언제든 재구성 [D11 S2] |
| 정규화 silver | **dlt 1.32.0**(`merge`, 소스별 SQLite 파일) | `merge`는 어떤 kill 지점에서도 중복 0 [etl M5], 드리프트 보고 내장 [M6] | DuckDB: 쓰기 중 타 프로세스 읽기 거부, 2.0 파일 호환 문제 [etl M11, M12] | silver는 파생. 도구를 바꿔도 WARC에서 재생성 |
| 그래프 gold | **SQLite WAL + FTS5 bigram + 재귀 CTE** | 쓰기 중 읽기 p95 상세 2.5, 이웃 14.7, 검색 6.2 ms, 20배 규모도 85 ms 이내 [general-db M6, M7] | LadybugDB 주 저장소: 두 프로세스 공유 미지원, 저장 안정성 이슈. FalkorDB: 원자 쓰기 없음, 기본값 전량 유실 [graph-store 5.5] | 파생이므로 엔진 교체는 투영기 교체다 |
| 깊은 순회 | 기본 없음. 조건 충족 시 **LadybugDB 읽기 투영** | 허브 3-hop 25만 엣지 SQLite p95 363 ms [graph-store 5.2]. 계약 이웃은 깊이 2까지라 주 경로 밖 | 지금 도입: 쓸 일이 없는 부품 | 일회용 |
| 벡터 | **numpy 플랫 파일** + KURE-v3, 재순위 KURE-Reranker-nano | 메모리 적재 전수 2만 1.0 ms, 10만 6.4 ms(다중 스레드 배치 평균) [retrieval 5.6]. 확장 의존 0, 재생성 가능 | sqlite-vec: 코드 5개월 정체, 그보다 느림. LanceDB: 별도 저장소 | T3. 삭제 후 재생성 |
| 수집 | 정적 추출 우선, `.md` 판 우선. Trafilatura 2.3.1, yt-dlp, feedparser, `gh` | 원본 후 분기 [etl 4.2]. Playwright는 필요 페이지에만 | Crawl4AI: 설치 679 MB, CVE 이력, LLM 의존성 동반. Firecrawl, Browsertrix: Docker 필요 | 소스별 어댑터 |
| 스케줄 | **`kb tick` + systemd user timer + Windows 작업 스케줄러 + 세션 hook** | 상주 PSS 0 [etl 3.3]. WSL은 systemd를 유휴 판정에 넣지 않으므로 상주 오케스트레이터 이점이 없다 [etl 5.2] | Airflow 951 MB, Dagster 550 MB, Prefect 179 MB, Kestra 699 MB [etl M3] | 트리거 교체 비용 0 |
| 사망 감지 | **healthchecks.io + 상태 벡터 + 앵커** | 머신 밖 감시. 무료 20개, 핑 본문 100 kB 저장 [S5] | 같은 PC의 Uptime Kuma: 감시 의미 없음 | 자체 호스팅 v5(BSD) |
| 머신 밖 수집 | **1안 Proxmox LXC 증인, 2안 GitHub Actions** | 3노드 온라인 [general-db M24]. 주거 IP로 같은 응답, 상시 가동. Actions는 지연 p50 6~36분, 러너 IP 응답 [미측정] | 구독 클라우드 예약: 로컬 파일 불가, 원격 필요 [harness 4장] | 세그먼트 수입 규약만 맞추면 어디서든 |
| 백업 | **restic 0.19.1**(백업 API 스냅샷 + 봉인 파일), 저장소 3곳, git 평문 내보내기 | 복원 0.83초, 체크섬 일치, `--read-data`가 팩 변조 탐지 [general-db M21]. 종단 훈련 통과 [D11] | Litestream: PSS 35 MB 상주, R13과 충돌. 선택지로만 남김 | 표준 도구, 비밀번호만 있으면 복원 |
| 반환 | **FastMCP 4.1.4 stdio** + 플러그인 + `kb` CLI | 데몬 없이 동작해 살아 있는 부품이 적다. 호출 p50 2.38 ms [retrieval 2.3] | 상시 HTTP MCP: 데몬 수명 문제 | 코어 공유, 전송만 교체 |
| 소비자 API | **Starlette + uvicorn 소켓 활성화**, OpenAPI 3.1.1 | 콜드 p50 150 ms, 웜 2.3 ms, 유휴 메모리 0 [general-db M9] | 상시 데몬, DB 파일 직접 접근 | 계약이 같으면 어댑터만 교체 |
| LLM | **`claude -p --tools "" --json-schema`**(기본 haiku) | 키 없이 호출당 5~7초, 인용 5/5 [prior-art T7] | Graphiti: 쓰기마다 LLM 2~3회 [T3]. GBrain, Hindsight: 표면이 크고 판단 기능을 잘라내야 한다 | 추출기 ID로 묶여 있어 교체 시 재생 영향 없음 |
| 런타임 | **uv + CPython 3.13 + 잠금 파일 + wheelhouse** | 시스템 3.14는 venv 불가, dlt 3.14는 실험적 [etl 10] | 시스템 Python | 복원 시 wheelhouse로 오프라인 설치 |

## 5. 디렉터리 구조

### 5.1 저장소(코드, Git)

```
sagae-knowloge-base/
├─ CLAUDE.md
├─ pyproject.toml, uv.lock
├─ src/kb/
│  ├─ core/        ledger.py warc.py project.py read.py write.py text.py paths.py   (표준 라이브러리만)
│  ├─ collect/     tick.py fetch.py adapters/
│  ├─ refine/      parse.py promote.py gate.py
│  ├─ survive/     signals.py verdict.py gaps.py
│  ├─ guard/       fsck.py scrub.py watchdog.py ship.py drill.py
│  ├─ serve/       mcp.py http.py
│  └─ cli.py
├─ registry/       sources/*.yaml  predicates.yaml  types/*.schema.json  fallbacks.yaml
├─ .claude/        settings.json  agents/  workflows/  skills/
├─ .mcp.json       저장소 내부 작업용(trail 포함)
├─ ops/
│  ├─ systemd/     kb-tick.{timer,service} kb-l2.{timer,service} kb-read.{socket,service} kb-alert@.service kb-inbox.path
│  ├─ windows/     kb-tick.xml
│  ├─ job-settings.json
│  ├─ hooks/       rtk-guard.sh  bin/rtk-p
│  └─ restic/      backup.sh  excludes
├─ tests/          kill/  golden/  contract/
└─ docs/           design/  adr/  contracts/{openapi.yaml,fixtures/,consumers/}  runbooks/  research/
```

### 5.2 데이터(코드 저장소 밖)

```
/home/user/sagae-kb-data/           ext4. KB_HOME
├─ raw/
│  ├─ warc/t0/YYYY/MM/*.warc.gz      first_party 첨부
│  ├─ warc/t1/<class>/YYYY/MM/*.warc.gz
│  ├─ warc/ttl30/...                 삭제 의무가 있는 소스 전용(7.6절)
│  ├─ open/                          쓰는 중 세그먼트
│  └─ inbox/                         증인에서 온 세그먼트
├─ ledger/
│  ├─ ledger.db                      진실 2
│  └─ export/YYYY/MM/*.ndjson.gz, MANIFEST.ndjson
├─ derived/
│  ├─ cdx/  silver/<source>.db  gold/<build>/graph.db  gold/current -> <build>
│  ├─ vec/<build>/  published/
├─ ops/ops.db, runs/*.jsonl.gz
├─ inbox/notes/  inbox/spool/  spool/l2/
├─ backup/                           백업 API 스냅샷 임시 위치
├─ models/  runtime/{venv,wheels}/
└─ drill/                            훈련 복원 위치. tmpfs 금지
```

- **코드 저장소 밖에 둔다.** `git clean -fdx` 한 번, worktree 전환 한 번으로 지워지는 위치에 대체 불가 데이터를 두지 않는다.
- **경로 검사.** `kb`는 시작 시 `KB_HOME`의 파일시스템을 확인해 tmpfs, 9p, drvfs면 거부한다. SQLite WAL은 같은 호스트의 공유 메모리가 필요하고 [graph-store 2.3], tmpfs는 재부팅에 사라진다.
- **봉인 세그먼트는 0444**, 디렉터리는 0555다. 에이전트 샌드박스의 쓰기 범위는 `spool/`뿐이다.

## 6. 데이터 모델

### 6.1 원장

```sql
CREATE TABLE event(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,  -- UUIDv7
  v INT NOT NULL,            -- 이벤트 스키마 버전
  at TEXT NOT NULL,          -- 거래 시각. 이전 값보다 작아지지 않게 강제
  actor TEXT NOT NULL,       -- user:sagae, agent:<session>, collector:<source>, gate:<ver>
  on_behalf_of TEXT, generated_by TEXT,
  origin TEXT NOT NULL,      -- external, first_party, system
  kind TEXT NOT NULL, idem_key TEXT UNIQUE, payload_sha TEXT NOT NULL,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE payload(sha TEXT PRIMARY KEY, body BLOB) WITHOUT ROWID;      -- 정렬 키 JSON
CREATE TABLE record_head(id TEXT PRIMARY KEY, version INT, content_sha TEXT) WITHOUT ROWID;  -- 낙관적 잠금용, 이벤트에서 재생성 가능
-- event 표에 UPDATE, DELETE를 막는 트리거
```

- **체인 입력:** `sha256(prev_hash, seq, event_id, at, actor, origin, kind, payload_sha)`. 본문이 아니라 본문 해시를 묶으므로 법적 삭제 시 본문만 지워도 체인은 유지된다. 프로토타입은 본문을 같은 행에 뒀고 분리 구조는 [미측정]이다.
- **쓰기는 `BEGIN IMMEDIATE`만.** 승격 쓰기는 `busy_timeout`과 무관하게 즉시 실패한다 [general-db M2]. 원장 `synchronous=FULL`, gold는 `NORMAL`이다. gold의 꼬리가 유실돼도 `applied_seq`부터 다시 재생된다.
- **결정성 규칙:** 원장 JSON에 부동소수를 쓰지 않는다. 수치는 문자열 십진수와 단위로 둔다. 재생은 `at`을 입력으로 쓰고 현재 시각을 읽지 않는다.

이벤트 종류:

| 분류 | kind |
|---|---|
| 레코드 | `record.put`, `record.tombstone`, `record.redact` |
| 관계 | `edge.put`, `edge.expire`, `entity.merge`, `entity.alias` |
| 주장 | `claim.assert`, `claim.supersede`, `claim.retract` |
| 원시 | `snapshot.captured`, `snapshot.displayed`, `segment.sealed`, `segment.imported` |
| 출처 운영 | `source.registered`, `source.status`, `gap.recorded` |
| 생존 | `survival.verdict` |
| 추출 | `extract.run`, `extract.rejected` |
| 요청 | `ticket.open`, `ticket.update`, `ticket.merge`, `ticket.close` |
| 스키마 | `schema.type_defined`, `schema.predicate_defined`, `schema.epoch_bumped` |

### 6.2 그래프 투영

R3에 따라 모든 정보는 노드와 엣지다. 주장은 1급 노드로 승격한다. 엣지에 속성을 욱여넣으면 불변 ID, 대체 체인, 증거 연결을 표현하기 어렵다 [graph-store 6장].

| 노드 타입 | 뜻 | 핵심 속성 |
|---|---|---|
| `Entity`(하위 `Product`, `Feature`, `Repo`, `Package`, `Model`, `Channel`, `Keyword`, `Platform`, `Org`, `Metric`, `Technique`) | 대상 | 정규 키 `repo:github:owner/name`, `feature:claude-code:/ultraplan` |
| `Claim` | 출처가 말한 사실·수치·주장 | 주어, 술어, 값, 단위, 한정자, 유효 구간, `verification` |
| `Source` | 소스 레지스트리 항목 | 클래스, 합법 상태, 등급 |
| `Snapshot` | 불변 스냅샷 | `sha256`, 세그먼트 위치, `display_sha` |
| `Note`, `Decision`, `Artifact`, `Record` | first_party. `Record`는 타입 미정 | `author`, `version`, `body_format` |
| `Ticket` | 정보 요청 | 상태, 요청자 |
| `Attribution` | 제3자의 권고 | "출처 X가 Y라고 주장". `Claim`의 한 형태 |

| 엣지 타입 | 의미 |
|---|---|
| `ABOUT`, `SUBJECT`, `OBJECT` | 주장과 엔티티 |
| `EVIDENCED_BY` | 주장 → 스냅샷(인용 포함) |
| `SUPERSEDES` | 새 판 → 옛 판 |
| `SAME_AS`, `ALIAS_OF`, `MERGED_INTO` | 정체성 |
| `DEPENDS_ON` | 기법 → 기능·버전(생존 전파) |
| `PART_OF`, `SUCCESSOR_OF`, `FORK_OF`, `REPLACED_BY` | 생태계 구조 |
| `LINKS_TO`, `MENTIONS` | first_party 링크 |
| `FALLBACK_OF`, `CAPTURED_FROM` | 소스 운영 |
| `FULFILLS` | 티켓 ← 주장 |

타입은 런타임에 늘어난다. `registry/types/*.schema.json`(JSON Schema 2020-12, `additionalProperties: true`)이 정의하고 `schema.type_defined`로 원장에 남긴다. 알 수 없는 타입은 `Record`로 받는다. 자주 쓰는 속성은 재구축 때 생성 열로 승격한다 [general-db 2.2].

### 6.3 시간축

| 축 | 필드 | 뜻 | 계약 파라미터 |
|---|---|---|---|
| 유효 시간 | `valid_from`, `valid_to`, `valid_precision` | 세상에서 언제 참이었나 | `as_of_valid` |
| 관측(거래) 시간 | `observed_at`, `expired_at` | 저장소가 언제 알았고 언제 대체했나 | `as_of_observed` |
| 확인 시각 | `last_confirmed_at` | 같은 바이트를 마지막으로 다시 본 때 | 응답 표시 |

- 역사적 사실은 `valid_from`을 붙여 active로 유지한다. "ultraplan이 2.1.222에서 제거됐다"는 현재도 참인 사실이다.
- 대체는 `claim.supersede`다. 옛 판의 `valid_to`, `expired_at`을 닫고 지우지 않는다.
- `last_confirmed_at`은 WARC revisit에서 파생하며 논리 지문에서 뺀다. 이벤트를 늘리지 않으면서 "아직 그대로임"을 안다.
- 대량 시계열(자동완성 순위, 조회수)은 원장이 아니라 silver의 관측 표에 둔다. 스냅샷의 순수 함수이기 때문이다.

### 6.4 출처 모델과 인용 게이트

```
Source ──CAPTURED_FROM── Snapshot(sha256) ──conversion── 표시 본문(display_sha, NFC)
                                                             ▲ 코드포인트 오프셋
Claim ──EVIDENCED_BY{exact,prefix,suffix,start,end}──────────┘
```

**표시 본문을 재계산하지 않는다.** Trafilatura가 버전을 올리면 출력이 바뀌고 오프셋이 깨진다. 그래서 표시 본문을 WARC `conversion` 레코드로 저장해 고정한다(I4). 표준은 이 레코드를 다른 레코드 내용의 대체 판으로 정의한다 [S4]. 원본이 이미 텍스트이고 NFC면 레코드를 만들지 않고 `display_sha = payload_sha`로 둔다.

게이트 `kb gate`는 결정적이다.

| 단계 | 검사 | 실패 시 |
|---|---|---|
| 1 스키마 | 출력 JSON 형식 | `extract.rejected` |
| 2 정규화 | 표시 본문 NFC, 인용구 NFC. 공백 차이만 허용하고 원문 오프셋으로 되돌린다 | 해당 없음 |
| 3 인용 | 인용구가 지정한 스냅샷에 있는가. 오프셋을 기계가 계산한다. 위치가 여럿이면 prefix, suffix로 구분 | `extract.rejected`, 검증 불가 |
| 4 엔티티 | 정규 키 해석. 모르면 후보 생성 | 사람 판단 대기열 |
| 5 술어 | `predicates.yaml`에 있는가. 함수형(단일값) 여부 | 새 술어 대기열 |
| 6 입장 | 대상의 생존 상태 확인(15장) | 상태 부여 |
| 7 대체 | 함수형 술어이고 키가 같고 값이 다르면 대체 후보. 유효 시점이 앞서면 소급 정정 | 출처가 다르면 `contested` |

`verification` 값은 `candidate`, `quote_verified`, `contested`, `retracted`다. 인용구가 기계적으로 확인되지 않으면 `quote_verified`가 될 수 없다(R5). LLM의 함의 판단은 넣지 않는다. 사실 정확도 39~77%라는 보고가 있고 [prior-art P10], 게이트의 결정성을 해친다. 이 게이트가 보장하는 것은 "그 문장이 원문에 있다"뿐이다. "그 주장이 사실이다"는 보장하지 않으며, 그래서 주장은 항상 출처 귀속 형태다.

**한국어 대체 키.** 자연어를 파싱하지 않는다. LongMemory의 결정적 파서가 한국어에서 실패했다 [prior-art T2]. L2가 주어와 술어를 등록된 키로 내고, 게이트는 키 일치만 본다. 자동 대체는 함수형 술어로 제한한다. 다중값 술어는 대체하지 않는다.

**first_party(R15).** 인용 게이트 대신 `author`, `generated_by`, `on_behalf_of`, 버전 이력이 출처다. 사용자의 판단은 `author=user:sagae`로 저장할 수 있다. 시스템이 만든 판단은 저장하지 않는다(R6).

### 6.5 생존과 민감도

```
status(계약 필드):  active | superseded | dead | merged
liveness(세부):     active renamed scheduled_removal deprecated partial stale_suspect revived superseded removed
```

`sources-inventory-g.md` 3.1의 9개 상태를 세부로 두고 계약에는 3+1개로 접는다. `removed`는 `dead`, `superseded`는 `superseded`, 나머지는 `active`다. `partial`은 적용 조건(모델, 인증, 플랫폼, 버전 범위)을 속성으로 갖는다. 점수는 두지 않는다. 상태와 근거만 있다.

민감도는 `public`, `internal`, `private`, `secret` 정수 4단계다. 모든 읽기가 코어 한 곳의 필터를 지난다. 숨긴 레코드는 없는 레코드와 같은 404로 답한다 [general-db M6].

## 7. 파이프라인

### 7.1 `kb tick`

```
kb tick [--until-idle] [--max-runtime 25m] [--profile main|witness]

0 preflight   flock(비차단). 경로 검사, 디스크 여유, 시계 편차
1 recover     열린 세그먼트 회수, 원장 → 그래프 따라잡기, inbox 세그먼트 수입
2 plan        registry + ops.db → 만기 목록. 시점 소실 > 늦은 순
3 fetch       호스트별 직렬, 소스별 자식 프로세스, 제한 시간
4 parse       WARC → dlt → silver, 품질 검사
5 promote     silver 변경분 → 원장 이벤트(배치 500건 이하)
6 project     그래프 반영
7 maintain    WAL RESTART 체크포인트, 세그먼트 봉인, 필요 시 게시 사본
8 ship        머신 밖 전송
9 watchdog    상태 벡터 계산, 핑
```

- 잠금은 `flock`이라 프로세스가 죽으면 풀린다. 겹친 tick은 바로 종료한다.
- 단계 실패는 다음 단계를 막지 않는다. fetch가 전부 실패해도 ship과 watchdog은 돈다. preflight의 경로 오류만 전체를 멈춘다.
- 어느 단계에서 SIGKILL돼도 다음 tick의 1단계가 복구한다.
- `--until-idle`은 만기가 없을 때까지 돈다. Windows 쪽에서 부를 때 클라이언트를 잡아 둔다(10장).

### 7.2 L0 fetch

1. 조건부 GET. ETag, Last-Modified는 직전 WARC 응답에서 읽는다. 별도 상태가 없어 잃을 것도 없다.
2. 응답 바이트의 SHA-256을 계산한다.
3. 새 내용이면 `response`, 같은 내용이면 `revisit` 레코드를 현재 실행의 세그먼트에 쓰고 fsync한다.
4. 표시 본문이 다르면 `conversion` 레코드를 쓴다.
5. 새 내용이면 원장에 `snapshot.captured {segment, offset, length, member_sha, payload_sha, display_sha}`를 커밋한다. 멱등 키는 `snap:<WARC-Record-ID>`다.

3과 5 사이에서 죽으면 고아 레코드가 남는다. 다음 tick의 복구가 등록한다. 이 순서가 반대면 원장이 없는 바이트를 가리키게 된다.

**세그먼트 규칙.** 실행마다 새 파일을 만들고 한 파일에 쓰기 프로세스는 하나다. 크래시 뒤에는 **이어 쓰지도 자르지도 않고** 새 세그먼트로 넘어간다. 찢긴 꼬리는 무해하다. 색인된 레코드는 전부 읽혔다 [D13]. 복구는 파일을 고치는 대신 `segment.sealed {valid_size, sha256}`에 유효 범위를 기록한다. 복구 코드의 버그로 멀쩡한 바이트를 잃는 경로 자체를 없애기 위해서다. D4의 단순 복구 실패가 이 판단의 근거다.

**변동 페이지.** 유튜브 시청 페이지는 수 초 간격으로도 바이트가 달라 중복 제거가 0%다 [compression M15]. 페이지를 저장하지 않고 도구 출력 JSON을 `resource` 레코드로 저장한다. 자막 URL(JSON의 94%)처럼 변동이 큰 필드를 빼고 키를 정렬한다 [sources-inventory M-3]. 도구 이름과 버전을 레코드 헤더에 남긴다. 추출 JSON의 바이트 안정성은 [미측정]이다. 영상 사본은 저장하지 않는다(정책 금지).

### 7.3 L1 parse와 promote

- 입력은 항상 WARC다. 네트워크에 가지 않는다. dlt 리소스의 커서는 원장 seq다.
- 소스마다 파이프라인과 SQLite 파일을 나눈다. 리소스 하나의 실패가 소스 전체를 멈추고, poison 패키지가 무관한 리소스까지 막기 때문이다 [etl M8, M9]. 파일을 나누면 긴 적재가 다른 쓰기를 막지 않는다. 20만 행 트랜잭션은 약 7초 동안 같은 파일의 쓰기를 막는다 [general-db 3.4].
- `pipelines_dir`을 `derived/silver/.dlt/`로 명시하고 텔레메트리를 끈다. 기본값은 `~/.dlt`다 [etl 7.2].
- 스키마 계약은 `evolve`다. `schema_update`를 감시해 드리프트만 알린다. `discard_*`는 소리 없이 데이터를 버리고, `freeze`는 이후 전부를 막는다 [etl 7.1].
- poison 패키지는 자동으로 `abort-packages` 후 해당 소스를 재파싱한다. 원시가 있으므로 잃을 것이 없다.
- promote는 silver의 변경분만 원장 이벤트로 낸다. 같은 값이면 이벤트가 없다. 파서 버전이 바뀌면 재파싱 차이를 새 이벤트로 낸다. 옛 이벤트는 그대로 남는다.

### 7.4 L2 에이전트 추출

결정적 수집과 프로세스, 타이머, 실패 판정을 모두 분리한다. L2가 멈춰도 L0, L1, 감시는 통과한다.

```
kb l2 run --max-docs N --budget-usd X
  preflight: claude auth status, 버전 고정 확인, 카나리아 호출, rate_limit_event 활용률
  큐: 변경된 표시 본문만. 캐시 키 (display_sha, extractor_id, prompt_version, schema_version, model)
  호출: 문서마다 claude -p --tools "" --json-schema ... --max-budget-usd
  저장: 원 응답을 spool/l2/에 원자적으로 기록
  게이트: kb gate → claim.assert 또는 extract.rejected
  기록: extract.run {입력 해시, 프롬프트 버전, 모델, 출력 해시, 토큰}
```

- **문서당 Python 루프로 돈다.** 멱등 키가 곧 재개 지점이라 워크플로우 재개에 기대지 않는다. 여러 판단이 필요한 작업만 워크플로우를 쓴다(17장).
- **LLM은 도구가 없다.** 수집 본문은 데이터 블록으로 넣고, 출력은 스키마와 게이트를 지난다. 백그라운드 수집이 기억 오염 경로라는 보고가 있다 [prior-art P14].
- **재귀 방지.** `--setting-sources ""`, `--strict-mcp-config`, `--no-session-persistence`, `env -i`를 쓴다. Orca hook과 섞이지 않는다 [harness 5.2].
- **사용량 자기 제어.** `five_hour.utilization`이 0.5를 넘으면 시작하지 않고 0.7이면 멈춘다. 값은 초기 제안이다. 대화형 작업과 같은 창을 쓴다 [harness 3.5].
- **성공 판정.** exit 코드가 아니라 스트림 판정 규칙(harness 3.3)과 적재 건수로 본다. `--max-budget-usd`는 사후 검사라 초과될 수 있으므로 일일 문서 수 상한을 함께 둔다.
- **대량 철회.** 모든 주장에 추출기 ID가 있다. 나쁜 프롬프트로 만든 주장은 `claim.retract`로 한 번에 물릴 수 있다.

### 7.5 투영과 재구축

```
kb rebuild gold    새 <build> 디렉터리에 원장 전체 재생 → 지문 계산
                   → 프로젝터 잠금 → 꼬리 따라잡기 → symlink 교체 → 잠금 해제
```

- 재구축 중에도 **원장 쓰기는 계속된다.** 파일이 다르기 때문이다. 이것이 단일 파일 안 대비 가장 큰 운영 이득이다.
- 교체는 `gold/.tmp → gold/current` rename으로 원자적이다. 읽기는 요청마다 경로를 새로 연다. 열고 질의까지 0.18 ms다 [general-db M19]. 옛 빌드는 2세대 보존한다.
- **스키마 변경도 같은 경로다.** gold에 `ALTER`하지 않는다. 새 빌드를 만들어 바꾸고 문제가 있으면 symlink를 되돌린다.
- **커서는 원장 seq다.** `change_log.seq = 원장 seq`이므로 재구축해도 소비자 커서가 유지된다. 재구축은 소비자에게 보이지 않는다.
- 투영은 순수 함수다. 입력은 이벤트뿐이고 현재 시각, 난수, 네트워크를 쓰지 않는다. 이벤트 `v`별 업캐스터를 두고 골든 원장을 CI에서 재생한다.
- 프로세스 여럿이 투영할 수 있으므로 `applied_seq`는 `BEGIN IMMEDIATE` **안에서** 읽는다. 측정 프로토타입은 투영자가 하나라 이 경합을 시험하지 않았다.

### 7.6 보존과 삭제

"절대 죽지 않는다"와 정책이 충돌하는 지점이다. 숨기지 않고 규칙으로 둔다.

| 경우 | 규칙 |
|---|---|
| YouTube Data API 데이터(키 사용 시) | 비인증 데이터는 30일 초과 저장 금지 [sources-inventory §2]. `raw/warc/ttl30/`에 분리한다. 세그먼트 단위로 삭제하고 `segment.expired`를 남긴다. 파생 지표 금지 소스에는 집계를 만들지 않는다 |
| 사용자 삭제 요구 | `record.redact`가 `payload` 본문을 지운다. 체인은 유지된다. 파생은 재구축으로 사라진다. NDJSON 내보내기와 restic 과거 세대에는 남으므로, 완전 삭제는 `restic rewrite` + `prune` 절차가 별도로 필요하다 [미측정] |
| `secret` | 평문 내보내기와 git에 넣지 않는다. restic 암호화 저장소에만 간다 |
| 영상 사본 | 저장하지 않는다 |
| 개인 식별 필드 | 댓글 작성자 ID 등은 수집하지 않는다 [sources-inventory §10] |

## 8. 데이터 클래스별 갱신 주기

점검 주기는 인벤토리의 소스 갱신 주기에서 정했다. stale 기준을 넘으면 응답에 `stale: true`가 붙는다. ChurnBench 보고대로 신선도는 나이가 아니라 소스별 정책으로 다룬다 [prior-art P7].

### 8.1 내용 갱신

| ID | 클래스 | 대표 소스 | 점검 주기 | stale 기준 | 소급 수집 | 다음 확인 규칙 |
|---|---|---|---|---|---|---|
| F1 | 시점 소실 표본 | P04 suggest, P09 Trends RSS, P10 Kworb 트렌딩 | 6시간~1일 | 2일 | **불가** | 놓치면 `gap`. 증인이 대행 |
| F2 | 릴리스 | C01, C02, C13, C14, O01, O03, O10, L02, X17 | 6시간 | 48시간 | 가능 | 조건부 GET. 304면 다음 주기 |
| F3 | 피드 | D13, U05, U08, U09, U10, U14 | 1일 | 3일 | 창 크기까지 | 창이 작은 피드는 F1 취급 |
| F4 | 1차 문서 변경 감지 | C03, C04, C06, C10, O02, O05, O09, D15, D19, D22 | 1일 | 3일 | 가능 | `llms.txt` 비교 후 변경 페이지만 |
| F5 | 주간 | C05, O06, P13, X11, U11, U15, L04 | 주 1회 | 14일 | 대부분 가능 | 피드 정체 감시(C05 W37 사례) |
| F6 | 월간 | D03, D04, D20, C08 | 주 1회, 발행 예상 주는 매일 | 45일 | 가능 | 발행 일정 변경 감지 |
| F7 | 분기·반기·연간 | D01, D05, D08~D12, D17, D21, D23, X14 | 월 1회, 발행 달은 주 1회 | 주기 + 30일 | 가능 | 문서 URL 생존 포함 |
| F8 | 수시 | D16, D18, X15, X16, C09 | 주 1회 | 14일 | 가능 | arXiv 3초당 1회 |
| F9 | 사건 | C11, O12, L05 | 1일 | 3일 | 가능 | 해당 없음 |
| F10 | first_party | 사용자 기록 | 해당 없음 | 없음 | 해당 없음 | 참조 링크만 L1 적용 |

`수집 주기`의 호출 시점 값 소스(P05, P06, X01~X05)는 사용자 판단 뒤에 F1로 넣는다(22장).

### 8.2 생존 재확인

| ID | 대상 | 주기 | stale 기준 | 신호(보고서 §3.2) |
|---|---|---|---|---|
| S1 | **G 저장소 140개 내외** | 주 1회 GraphQL 일괄 | 14일 | M01, M02, M03, M04, M05 |
| S2 | **G 패키지** npm, PyPI | 주 1회 | 14일 | M06, M07, M09 |
| S3 | **G 제품 기능·플래그** | 릴리스 단위(F2가 트리거) + 주 1회 | 7일 | M14, M16, M17, M18, M19 |
| S4 | **G 모델 수명** | 1일 | 3일 | M20. `Not sooner than`은 퇴역일로 쓰지 않는다 |
| S5 | **G 문서 URL** | 주 1회 색인 비교, 월 1회 전수 | 35일 | M10, M11, M12, M13 |
| S6 | **G 기법(사용 방법)** | 의존 기능 변경 시 즉시 + 분기 표본 | 90일 | `DEPENDS_ON` 전파, M24 |
| S7 | `scheduled_removal` | 날짜 도래 당일 | 1일 | 예: 2026-11-30 Sonnet 4.5 |
| S8 | **dead·superseded 번복 감시** | 판정 후 14일간 주 1회, 이후 월 1회 | 35일 | M17. 번복 간격 5일, 184일 관측 |
| S9 | A~F 죽은 데이터 후보 | 월 1회 | 35일 | `sources-inventory.md` §9 |
| S10 | MCP Registry | 주 1회 | 14일 | M21 |
| L1 | **인용 URL 링크 사망** | 매일 전체의 1/30 순환 | 35일 | 상태 코드, 최종 URL, 묘비 |

## 9. 실패 처리

### 9.1 분류와 대응

| 관측 | 판정 | 대응 |
|---|---|---|
| 네트워크 오류, 5xx | 일시 | 호출 내 재시도 3회(지수 백오프, `Retry-After` 준수 [etl M7]) 후 소스 백오프 1→2→…→24시간 |
| 429, 403, WAF, 봇 확인 | 차단 | **호스트 서킷 오픈.** 최소 1시간, 반복 시 7일까지. 사용자 평소 YouTube 사용을 보호한다. 다른 소스로 넘기지 않고 대체 소스만 시도 |
| 404, 410 | 의심 | **단일 관측으로 판정하지 않는다.** RSS는 같은 URL이 06:58 UTC 404, 07:06 UTC 200이었다. 서로 다른 시간대 3회 이상 확인 후 `link_status=gone` |
| 200이지만 형식 불일치 | 소스 고장 | `content_type`과 본문 검사. `rss.xml`이 오류 HTML인 사례 [sources-inventory-g S-6] |
| 200 + 묘비 문구 | 기능 사망 후보 | M12 신호. 생존 판정으로 |
| 파서 예외 | 구조 변경 | 레코드를 DLQ로. 원시는 유지. 파서 고친 뒤 재파싱 |
| 값 품질 저하 | 구조 변경 | 행 수, null 비율, 본문 길이가 최근 중앙값에서 벗어나면 `degraded`. 스키마 변화 없이 값만 깨지는 경우를 잡는다 [etl §7] |
| 정적 추출 본문이 짧음 | JS 렌더링 | 브라우저 큐로(blog.youtube 772자 대 2,058자) |
| dlt poison | 패키지 불량 | 자동 abort, 재파싱 |
| 게이트 거부 | 추출 불량 | 재시도하지 않는다. 회고 입력으로 |
| `claude -p` 실패, 한도, 인증 만료 | L2 정지 | 큐만 쌓인다. L0, L1은 계속. 감시가 별도 경보 |

### 9.2 DLQ

`ops.db`의 `dlq` 표에 `(source, record_id, stage, error, attempts, next_at)`를 둔다. 항목이 WARC를 가리키므로 표를 잃어도 재파싱으로 다시 나온다. 첫 실패 뒤 1시간, 1일, 7일에 재시도하고 이후 사람 판단으로 넘긴다.

### 9.3 소스 구조 변경 탐지

| 층 | 수단 |
|---|---|
| 스키마 | dlt `schema_update` |
| 값 | 행 수, null 비율, 본문 길이 기준선 |
| 형식 | Content-Type, 첫 바이트, 피드 파싱 성공 여부 |
| DOM | 태그 경로 해시 변화(HTML 소스) |
| 의미 | 묘비 문구, 표의 상태 행 |

### 9.4 대체 소스

`registry/fallbacks.yaml`이 소스별 순서를 정의한다. 대체 소스 사용은 `source.status`에 남긴다. 대체 경로의 값은 출처가 다르므로 주장에 실제 출처를 붙인다.

| 주 소스 | 대체 |
|---|---|
| C02 문서 Changelog | C01 GitHub CHANGELOG, C14 `releases.atom` |
| C05 What's new | C02(C05 정체 시) |
| O13 사이트 RSS | O03 Changelog RSS, O01 릴리스 |
| P07 채널 RSS | yt-dlp `--flat-playlist`(사용자 승인 시) |
| 문서 페이지 사망 | WARC 최신 스냅샷 → Wayback CDX |
| GitHub `latestRelease` 부정확 | 태그, npm, PyPI 교차(llama.cpp, Aider 사례) |
| Reddit 429 | HN Algolia, GeekNews |

### 9.5 공백

머신이 꺼졌거나 차단돼 시점 소실 소스를 놓치면 `gap.recorded {source, from, to, reason}`을 남긴다. 72슬롯을 놓쳐도 72번 돌리지 않는다. 1회 수집하고 공백을 기록한다 [etl §1]. 시계열 응답에는 구간 공백을 함께 준다.

## 10. 지속 실행

### 10.1 왜 타이머에 상태를 두지 않는가

`Persistent=true`는 놓친 횟수와 무관하게 1회 발화하고, 스탬프가 없으면 첫 활성화에 발화하지 않는다 [etl M19]. 소스마다 타이머를 두면 유닛이 수십 개가 되고 catch-up이 타이머 수만큼 몰린다. 그래서 타이머는 "tick을 불러라"만 말하고, 무엇을 할지는 `next_check_at`이 정한다.

### 10.2 세 경로

| 경로 | 언제 | 설명 | 상태 |
|---|---|---|---|
| A. Windows 작업 스케줄러 | 로그온, 6시간마다 | `wsl.exe -d Ubuntu -u sagae -- <kb> tick --until-idle --max-runtime 45m`. 끝날 때까지 WSL 클라이언트가 유지된다. **catch-up이 끊기지 않는 유일한 경로** | 소스상 정합, [미측정] |
| B. systemd user timer | distro가 떠 있는 동안 15분마다 | 다른 작업으로 WSL이 살아 있을 때 평소 주기를 맡는다 | 비공개 매니저에서 종단 검증 [etl M19], 실제 설치 [미측정] |
| C. 세션 hook | Claude Code 세션 시작 | 백그라운드로 `kb tick`을 띄운다. 세션 자체가 클라이언트라 끊기지 않는다 | [미측정] |

WSL은 클라이언트가 없으면 15초 뒤 `systemctl poweroff`한다 [etl 5.2]. B만으로는 부팅 직후 catch-up이 끊길 수 있다. 끊겨도 kill 안전하므로 데이터는 멀쩡하고 다음 기회로 밀릴 뿐이다.

```ini
# kb-tick.timer
[Timer]
OnStartupSec=90s            # 실측 D. Persistent의 첫 활성화 미발화를 피한다
OnUnitInactiveSec=15min     # [미측정]
RandomizedDelaySec=30s

# kb-tick.service
[Unit]
OnFailure=kb-alert@%n.service
[Service]
Type=oneshot
ExecStart=<kb> tick --max-runtime 12m
Restart=on-failure
RestartMode=direct          # 없으면 OnFailure가 시도마다 발화 [etl 5.1 F, G]
RestartSec=2
RestartSteps=2
RestartMaxDelaySec=8
ExecStopPost=/bin/sh -c 'curl -fsS -m 5 "$HC_TICK/$EXIT_STATUS"'
```

Windows 작업 설정은 `StartWhenAvailable=true`, `MultipleInstancesPolicy=IgnoreNew`, `ExecutionTimeLimit=PT1H`다. `WakeToRun`은 절전 PC를 깨우므로 사용자 결정이다. "로그온 여부와 무관하게 실행" 모드는 미확인이라 우선 로그온 사용자 모드로 둔다.

`loginctl enable-linger`도 켠다. WSL에서 효과가 제한적으로 보이지만 비용이 거의 없고, 부팅 경로의 사용자 매니저 기동을 보장하는 쪽이 안전하다 [etl 5.3].

### 10.3 머신 밖 증인

**문제.** 시점 소실 소스는 PC가 꺼진 동안 영구히 사라진다. 어떤 스케줄러도 이것을 해결하지 못한다 [etl 3.4].

**구조.** 증인은 `kb tick --profile witness`만 돌린다. 원장도 그래프도 없다. F1 클래스만 수집해 봉인된 WARC 세그먼트를 만든다. 메인은 깨어날 때 세그먼트를 가져와 `kb import`로 수입한다.

세그먼트는 불변이고 이름이 겹치지 않으며 수입은 멱등이다. 즉 **원시 계층은 추가만 되는 집합**이라 복제 충돌이 구조적으로 없다. 데이터베이스를 복제하지 않는다. 증인을 나중에 늘리거나 바꿔도 규약은 그대로다.

| 안 | 장점 | 단점 |
|---|---|---|
| Proxmox LXC | 상시 가동, 주거 IP라 같은 응답, 백업 대상 겸용 | 자격 증명 설정 필요, 집이라는 같은 장애 영역 |
| GitHub Actions | 설치 없음 | 지연 p50 6~36분, 러너 IP 응답 [미측정], 비공개 저장소 월 약 2,000분, 60일 비활동 비활성화 |

## 11. 사망 감지

### 11.1 무엇을 감시하는가

`kb watchdog`이 tick마다 돌고 상태 벡터를 만든다.

| 검사 | 조건 | 등급 |
|---|---|---|
| 수집 침묵 | 활성 소스의 48시간 신규 레코드 0 | 치명 |
| 소스 stale | 클래스별 기준 초과 | 경고 |
| 소스 사망 의심 | 연속 실패 + 대체 소스도 실패 | 경고 |
| 원장 체인 | 전체 재검증 실패 | 치명 |
| 원장·세그먼트 대조 | 멤버 해시 불일치 | 치명 |
| 앵커 불일치 | 로컬 머리가 앵커보다 뒤 | 치명 |
| 투영 지연 | `max(seq) - applied_seq` 지속 | 경고 |
| 머신 밖 백업 나이 | T0 1일, T1 3일 초과 | 치명 |
| 훈련 나이 | 월간 훈련 35일 초과 | 치명 |
| L2 큐 나이 | 가장 오래된 항목 7일 초과 | 경고 |
| L2 인증 | `claude auth status` 실패 | 경고 |
| Claude Code 동작 변화 | 버전, `--bare` 기본값, 카나리아 실패 | 경고 |
| 디스크 | 여유 10% 또는 50 GB 미만 | 치명. 수집 정지, 원장 쓰기는 유지 |
| WAL 크기 | 원장 64 MB, gold 256 MB 초과 | 경고 |
| 시계 편차 | HTTP `Date` 대비 5분 초과 | 경고. 절전 복귀 시 발생 가능 |

### 11.2 머신 밖 신호

| healthchecks 체크 | 주기, 유예 | 뜻 |
|---|---|---|
| `kb-tick` | 1일, 2일 | tick이 돌고 있다. PC가 꺼진 날이 있어 유예를 길게 둔다 |
| `kb-ship` | 1일, 2일 | T0 머신 밖 전송 |
| `kb-l2` | 7일, 7일 | L2 진행 |
| `kb-drill` | 35일, 7일 | 훈련 통과 |
| `kb-witness` | 1시간, 3시간 | 증인 생존 |

- 핑 본문에 상태 벡터를 넣는다. `{seq, head, segments, last_snapshot_at, stale_sources, ...}`. healthchecks가 저장하므로 체크당 최근 100건이 머신 밖에 남는다.
- `hc-ping.com`은 없는 UUID에도 HTTP 200을 준다 [etl M19]. 설치 시 응답 본문이 정확히 `OK`인지 확인한다.
- 앵커는 git 내보내기 커밋에도 남긴다. healthchecks와 git이 서로의 백업이다.

**사용자에게 도달하는 경로.** 이메일 경보와 함께, 세션 시작 hook이 치명 상태를 `additionalContext`로 넣는다. 대시보드는 만들지 않는다(지침 5). 상태는 `kb_status`가 사실로 돌려준다.

### 11.3 FMEA

| # | 장애 | 탐지 | 자동 대응 | 남는 손실 | 근거 |
|---|---|---|---|---|---|
| 1 | WARC 쓰기 중 kill | 다음 tick | 새 세그먼트, 고아 등록 | 없음(미커밋 응답은 재수집) | D4 |
| 2 | fsync 후 원장 커밋 전 kill | 고아 레코드 | 멱등 등록 | 없음 | 7.2 |
| 3 | 원장 커밋 후 투영 전 kill | `applied_seq` 뒤처짐 | 따라잡기 | 없음 | D5 |
| 4 | gold 손상 | `quick_check`, 지문 | 새 빌드, symlink 교체 | 없음 | D5, D6 |
| 5 | 라이브 DB 교체 실수 | 코드로 금지 | 경로 교체 함수 자체가 없음 | 없음 | D10 |
| 6 | 원장 비트 플립 | 체인 + `integrity_check` | 경보, 스냅샷 + NDJSON 복원 | 마지막 전송 뒤 쓰기 | D8, D11 |
| 7 | 전원 손실로 WAL 꼬리 유실 | 앵커 비교 | NDJSON 꼬리 재적용 | 마지막 전송 뒤 쓰기 | D7, D11 |
| 8 | vhdx 손상 | 마운트 실패 | `e2fsck` 절차, `/mnt/c` 사본 | 마지막 전송 뒤 쓰기 | general-db 8.2 |
| 9 | SSD 고장 | 수집 침묵 경보 | 런북으로 새 머신 복원 | T0 5분, T1 1시간 | 19장 |
| 10 | 랜섬웨어, 실수로 삭제 | 수집 침묵, 앵커 | append-only 저장소에서 복원 | 마지막 전송 뒤 쓰기 | S6, S7 |
| 11 | 백업이 복원 불가 | 월간 훈련 | 경보 | 훈련 주기 안의 위험 | D11 |
| 12 | restic 비밀번호 분실 | 탐지 불가 | **없음** | 머신 밖 사본 전체 | 22장 1번 |
| 13 | 사이트 구조 변경 | 품질 기준선 | `degraded`, 대체 소스 | 없음(원시 보존, 재파싱) | 9장 |
| 14 | 소스 영구 소멸 | 링크 순환 | `link_status=gone` | 없음(스냅샷 생존) | R1 |
| 15 | 수집 대상이 차단함 | 429, 봇 확인 | 서킷 | 그 기간 공백 기록 | 9.1 |
| 16 | dlt poison | 예외 | abort + 재파싱 | 없음 | etl M9 |
| 17 | OAuth 만료, 한도, `--bare` 기본화 | preflight, 카나리아 | L2만 정지 | 추출 지연 | harness 3.4 |
| 18 | Claude Code 자동 업데이트 | 버전 대조 | 작업은 고정 바이너리 사용 | 없음 | harness 10.1 |
| 19 | MCP 시작 실패 | 세션은 exit 0 | 절대경로, 15분 캐시 인지 | 조회 지연 | harness 6장 |
| 20 | 프롬프트 주입 | 게이트 | 도구 없는 추출, 격리 | 인용 일치 오정보 가능 | prior-art P14 |
| 21 | 나쁜 프롬프트 배포 | 골든 평가, 거부율 | `claim.retract` 일괄 | 없음 | 18장 |
| 22 | 투영 코드 버그 | 지문, 계약 시험 | 이전 빌드로 symlink 되돌림 | 없음 | 7.5 |
| 23 | 원장에 나쁜 이벤트 기록 | 회고, 사용자 | 보상 이벤트 | 이력에 남음 | I2 |
| 24 | 디스크 가득 | 워치독 | 수집 정지, 쓰기는 스풀 | 공백 기록 | 11.1 |
| 25 | tmpfs에 데이터 경로 설정 | 시작 시 경로 검사 | 거부 | 없음 | 5.2 |
| 26 | 시계 역행 | 원장 `at` 단조 강제 | 경보 | 관측 시각 오차 | 6.1 |
| 27 | 워치독 자체 사망 | healthchecks 침묵 | 머신 밖 경보 | 없음 | I6 |
| 28 | 복구 코드 버그가 원본 훼손 | 설계로 회피 | 원본을 고치지 않는다 | 없음 | D4 |
| 29 | 의존 패키지 소멸 | 복원 훈련 | wheelhouse, 모델 가중치 보관 | 없음 | 12.3 |

12번은 자동화로 막을 수 없다.

## 12. 복구 운영

### 12.1 `kb fsck`

| 단계 | 검사 | 주기 |
|---|---|---|
| 1 | 경로, 잠금, 파일 권한 | 매 tick |
| 2 | 열린 세그먼트 회수 | 매 tick |
| 3 | 체인 전체 검증(449k건/s) | 매일 |
| 4 | 앵커 대조 | 매일 |
| 5 | 세그먼트 크기와 sha256 대조 | 매일 1/30 순환 |
| 6 | 멤버 해시, zlib `eof` 전수 | 매일 1/30 순환 |
| 7 | `PRAGMA integrity_check` + 체인 | 주 1회 |
| 8 | gold 지문 대 재생 | 월 1회 |

단계 5, 6이 잘림을 잡는다. warcio 반복자에 맡기지 않는다 [D2].

### 12.2 복원 절차(요약)

전문은 `docs/runbooks/restore.md`에 둔다. 사람이 Claude 없이 따라 할 수 있어야 한다.

1. 새 ext4에 restic과 uv를 설치한다.
2. 디스크 밖에 보관한 비밀번호로 저장소를 연다.
3. `ledger/export/`, `backup/ledger.snapshot.db`, `runtime/`, 설정을 복원한다.
4. 스냅샷에 NDJSON 꼬리를 덧붙여 원장을 재구성한다.
5. 체인을 검증하고 앵커(healthchecks 또는 git)와 머리를 대조한다. 불일치면 유실 범위를 기록한다.
6. `raw/warc/`를 복원하고 원장이 가리키는 멤버 해시를 대조한다.
7. wheelhouse로 환경을 복원한다.
8. `kb rebuild all`로 파생을 재생성하고 지문을 대조한다.
9. tick을 재개한다.

### 12.3 공급망 생존

- `uv.lock` + `runtime/wheels/`에 전 의존성 휠을 보관한다. PyPI가 없어도 복원된다.
- 임베딩 가중치는 리비전을 고정하고 `models/`에 둔다. 사라지면 질의 벡터를 만들 수 없으므로 T1에 포함한다.
- Claude Code는 작업에서 버전 경로로 직접 호출한다. `DISABLE_AUTOUPDATER=1`을 둔다.
- `trust_remote_code`가 필요한 모델은 쓰지 않는다.

## 13. 쓰기 경로

### 13.1 공용 쓰기 코어

모든 통로가 `core.write`를 지난다.

```
검증 → 원장 BEGIN IMMEDIATE → 멱등 키 확인 → expected_version 확인(record_head)
    → 내용 해시 비교(같으면 noop) → event + payload + record_head 삽입 → COMMIT(FULL)
    → 인라인 투영 → 응답 {id, version, seq, replayed, projected}
```

- 커밋 후 투영이 실패해도 쓰기는 성공이다. `projected: false`로 답하고 다음 투영이 처리한다.
- 멱등: 같은 키의 재시도는 첫 응답을 돌려준다 [general-db M15]. 인자 이름을 IETF `Idempotency-Key` 초안과 맞춰 HTTP 쓰기로 옮길 수 있게 한다.
- 전체 지연 p50 1.59 ms, p99 4.69 ms [D9].

### 13.2 통로

| 통로 | 대상 | 비고 |
|---|---|---|
| MCP `kb_put`, `kb_link`, `kb_supersede` | 세션 | 멱등 키 필수 |
| CLI `kb put` | 스크립트, hook | 표준 라이브러리만 |
| 파일 입력 `inbox/notes/` | 사람. Markdown + YAML | ID는 프런트매터. `.path` 유닛 + 주기 스윕 [general-db M16]. `.path`는 재귀하지 않고 실행 중 변경을 놓치므로 스윕이 필수 |
| 스풀 `inbox/spool/` | 원장을 못 열 때 | 임시 파일 + rename. tick이 멱등 적재 |
| 게이트 | L2 산출물 | 에이전트의 유일한 쓰기 통로 |

**쓰기를 잃지 않는 마지막 경로가 스풀이다.** 디스크 잠금, DB 잠금, 예외가 나도 MCP 도구는 내용을 스풀 파일로 남기고 `{"spooled": true}`를 돌려준다.

### 13.3 타입과 버전

- 타입 없는 레코드는 `Record`로 받는다. `props`는 JSON이다.
- 새 타입은 스키마 정의만 추가하면 된다. 옛 레코드는 그대로 유효하다.
- 버전 이력은 `record.put` 이벤트 자체다. gold의 `node_version`은 그 투영이다.
- 저자 귀속은 PROV 구분을 따른다. `author`, `generated_by`, `on_behalf_of`, 이전 버전 링크.
- first_party 쓰기는 `ship` 요청 플래그를 세운다(19장).

### 13.4 파일 사본의 충돌

사람이 편집한 파일이 세션이 먼저 고친 버전을 덮으려 하면 덮지 않고 충돌을 기록한다 [general-db M16]. 진실은 원장이고 Markdown 내보내기는 사본이다.

## 14. 다른 세션 인터페이스

### 14.1 배포

| 구성 | 선택 | 이유 |
|---|---|---|
| 형태 | 플러그인 `kb@sagae` | MCP, 스킬, hook을 함께 준다. 다른 프로젝트에서 전 구성요소 실측 [harness R8] |
| 전송 | stdio | 살아 있어야 할 데몬이 없다 |
| 실행 | `.mcp.json`에 절대경로 `<KB_HOME>/runtime/venv/bin/python -I -m kb.serve.mcp` | 스케줄 환경 PATH 약점 회피. 실패는 15분 캐시된다 [harness 6장] |
| 데이터 경로 | `userConfig`의 절대경로 | MCP cwd는 호출 프로젝트다 |
| 관제 서버 | 등록 가능하되 직결 경로 유지 | 게이트웨이가 죽어도 조회가 살아야 한다 |

코어는 표준 라이브러리만 의존한다. 읽기 경로에 Kiwi, torch를 올리지 않는다. bigram으로 품질 차이가 없고 [retrieval 5.1], CLI p95 25~42 ms를 지킨다 [general-db M8].

### 14.2 도구

| 도구 | 입력 | 출력 | 힌트 |
|---|---|---|---|
| `kb_search` | `q, types?, status?, k=5, as_of_*?, cursor?` | 히트 요약, `related`, 커서 | 읽기 |
| `kb_get` | `ids[], detail=summary` | 레코드, 현재 주장 | 읽기 |
| `kb_neighbors` | `id, depth=1, rtypes?, limit=30` | 부분 그래프 | 읽기 |
| `kb_history` | `id` | 대체 체인, 두 시간축 | 읽기 |
| `kb_evidence` | `claim_id, around=200` | 인용구, 위치, 원문 조각 | 읽기 |
| `kb_status` | 없음 | 신선도, 공백, 훈련, 경보 | 읽기 |
| `kb_request` | `topic, reason, urgency?` | `{ticket, status, duplicates}` | 쓰기 |
| `kb_request_status` | `ticket` | 상태, 연결 주장 | 읽기 |
| `kb_put` | `record, idempotency_key, expected_version?` | `{id, version, seq, replayed}` | 쓰기 |
| `kb_link` | `src, dst, rtype, idempotency_key` | `{id, seq}` | 쓰기 |
| `kb_supersede` | `old, new, reason, idempotency_key` | `{seq}` | 쓰기 |

도구 11개로 표면을 제한한다. GBrain full 162개 156 KB 같은 비용을 피한다 [prior-art].

### 14.3 응답 형태

```json
{
  "data_as_of": "2026-10-31T09:12:03Z", "applied_seq": 183422, "mode": "fts",
  "degraded": ["vector_offline"], "truncated": false, "next_cursor": null,
  "hits": [{
    "id": "clm_01JC...", "kind": "claim",
    "text": "search.list는 별도 버킷 기본 100회/일",
    "status": "active", "verification": "quote_verified", "stale": false,
    "valid": {"from": "2026-06-01"}, "observed_at": "2026-10-31", "last_confirmed_at": "2026-10-31",
    "source": {"id": "src_yt_quota", "title": "Quota Calculator", "origin": "external"},
    "snapshot": "sha256:ab12..."
  }],
  "related": [{"id": "ent_search_list", "rel": "ABOUT", "label": "search.list"}],
  "gaps": [], "content_is_untrusted": true
}
```

- **id 우선.** 응답은 요약이고 본문은 `kb_get`이다. 구조 변경이 형식 변경보다 효과가 크다(−91.8%) [compression M10]. 800자 문서 10건 본문은 p50 10,232토큰, id와 스니펫은 1,048토큰이다 [retrieval 4.2].
- **예산은 서버가 지킨다.** 기본 6,000자, 상한 20,000자다. 토큰이 아니라 글자로 자른다. 한글은 글자당 약 1.05토큰이고 Claude Code의 토큰 경계가 한글에서 동작하지 않을 수 있다 [compression M9]. 넘으면 `truncated: true`와 커서를 준다.
- **`structuredContent`만 보낸다.** Claude Code 2.1.314는 텍스트 블록을 전달하지 않는다 [compression M9]. 명세 권고인 직렬화 텍스트는 같은 내용으로 함께 넣는다. 압축 텍스트를 따로 넣어도 소용없다.
- **순위 숫자를 내지 않는다.** 내부 점수는 응답에 없다. 자체 점수처럼 읽힐 여지를 없앤다(R6).
- **`related`는 순위와 분리한다.** 순위에 섞으면 단일 홉이 0.066 깎인다 [retrieval 5.5].
- **낡음과 저하를 드러낸다.** `stale`, `degraded`, `gaps`가 I8을 구현한다.

### 14.4 요청 큐

없는 정보는 원장의 `ticket.open`이다. 세션을 넘어 살아야 하므로 MCP Tasks를 쓰지 않는다 [retrieval 3.1].

| 단계 | 동작 |
|---|---|
| 접수 | 정규화 키(NFC, 소문자, 공백 정리)가 같으면 병합, `duplicates` 증가 |
| 의미 병합 | 일일 작업이 후보를 묶어 `ticket.merge`. Kiwi, 임베딩은 이 작업에서만 쓴다 |
| 수행 | `kb-fulfill` 워크플로우가 소스를 찾고 `kb fetch`로 WARC에 넣는다. 이후 일반 경로 |
| 해소 | 주장을 `FULFILLS`로 잇고 `ticket.close` |
| 통지 | 세션 시작 hook의 `additionalContext`, 살아 있는 세션에는 SendMessage |
| 조회 | `kb_search`가 관련 티켓 상태를 함께 표시 |

자동 등록은 하지 않는다. 무응답 판별이 약하다(재순위 AUROC 0.92, 정답 95% 유지 시 오판 0.64~0.72) [retrieval 3.4]. 호출 모델이 결과를 읽고 부른다. 빈 검색 로그는 수집 후보 힌트로만 쓴다.

## 15. 생존 판정

### 15.1 흐름

```
 신호 수집(S1~S10, L1)                     적재 경로
   │                                         │
   ▼                                         ▼
 1 이동 확정 M02 M11 ─ renamed           게이트 6단계(입장)
 2 명시 선언 수집 M01 M05 M06 M07 M12 M14 M20 M21 │ 대상 생존 상태 조회
 3 단위 분리 저장소≠프로젝트≠패키지        │ TTL 지났으면 즉시 재확인
 4 조건 추출 → partial                   │
 5 날짜 처리 → scheduled_removal         ├ active → 활성 적재
 6 침묵 처리 M04 M09 → stale_suspect 까지만 ├ dead → status=dead로 적재, 기본 검색 제외
 7 교차 확인 변경 이력 + 현행 문서        ├ 역사적 사실 → 시점 붙여 active
 8 재검사 M17 → revived                  └ 판단 불가 → candidate + 사람 대기열
 9 DEPENDS_ON 전파 → 기법을 사람 대기열로
   │
   ▼
 survival.verdict {target, unit, status, signals[{id, snapshot, quote}], decided_by}
```

이 순서는 `sources-inventory-g.md` 3.4절을 그대로 따른다.

**자동 판정의 범위.** 단일 신호로는 죽음을 판정하지 못한다. 138개 표본에서 `archived`는 수명 종료 17개 중 10개만 잡았고, 양방향으로 틀린다 [sources-inventory-g S-1].

| 판정 | 자동 가능 조건 | 그 외 |
|---|---|---|
| `renamed` | M02 또는 M11 | |
| `scheduled_removal` | M20 표의 날짜. `Not sooner than`은 제외 | |
| `removed` | 묘비(M12), 표의 상태 행(M14) 중 하나 + 교차 확인 | |
| `superseded` | 1차 출처가 후속을 명시 | 기능 동등성은 H01 |
| `stale_suspect` | M04, M09 | `removed`로 자동 승격 금지 |
| `revived` | M17 후보 | H06, H07 사람 판단 |
| 기법 | 없음 | 항상 H05 |

### 15.2 사람 판단

H01~H11 대기열은 `kb-survival-review` 워크플로우가 근거를 모아 정리하고, 판정은 사용자가 내린다. 근거가 충분하면 에이전트가 `decided_by: agent:<ver>`로 제안할 수 있고 `candidate`로 남는다. 판정은 상태와 근거뿐이며 점수를 만들지 않는다.

### 15.3 사후 처리

| 경우 | 처리 |
|---|---|
| 적재 후 죽음 확인 | `survival.verdict`, `claim.supersede` 또는 상태 전이. 삭제 없음. 기본 검색 제외 |
| 전파 | `DEPENDS_ON`을 따라 기법을 사람 대기열로. RECON이 지적한 파급 무효화의 얇은 형태다 [prior-art P8] |
| 번복 | `revived`. 옛 판정은 이력으로 남는다 |
| 소급 | 유효 시점을 과거로 정정. 관측 시간은 현재. 두 축이 어긋나는 사례로 계약 fixture에 넣는다 |
| 기본 검색 | `status=active`. `superseded`, `dead`는 명시할 때만. FTS, 벡터, 그래프 전 경로에 코어 필터 강제 |

## 16. 검색

| 경로 | 조건 | 구성 |
|---|---|---|
| **기본(항상 동작)** | 없음 | FTS5 bigram + 코어 필터. 의존성 0, CPU 3~85 ms [general-db M6, M7] |
| 하이브리드 | 임베딩 서비스 가용 | KURE-v3 상위 30 ∪ 어휘 상위 30 → KURE-Reranker-nano(`max_length` 2048) |
| 그래프 | 항상 | 상위 결과의 희소 엔티티 이웃을 `related`로. 순위에 섞지 않음 |

- **RRF로 합치지 않는다.** 강한 Dense에 BM25를 합치면 합성, Ko-StrategyQA에서 유의하게 나빠졌다 [retrieval 5.3]. 합집합 후 재순위가 합성 코퍼스 최고값 0.715다.
- **`max_length`를 문서 길이에 맞춘다.** 512로 자르면 AutoRAG 0.974가 0.929로 떨어진다.
- **임베딩은 별도 프로세스다.** GPU 적재 4~6초, 소켓 활성화, 유휴 종료. MCP 서버에 넣지 않는다. 임베딩이 없으면 `mode: "fts"`로 답한다. 조회는 절대 실패하지 않는다.
- **벡터는 빌드별 `.npy` + ID 목록이다.** 재순위 없는 CPU 대체는 FTS다. 재순위 CPU 1.2초는 `rerank=true` 명시 때만 쓴다.
- 대형 임베딩의 공개 데이터 성능은 tmpfs 포화로 [미측정]이다. KURE-v3 선택은 구현 초기에 공개 데이터 두 종으로 재확인한다. 모델 교체는 벡터 재생성뿐이다.
- 초기 규모는 FTS만으로 충분할 수 있다. 임베딩은 4단계에서 붙인다.

## 17. 에이전트와 워크플로우

### 17.1 원칙

- 결정적으로 되는 일에 에이전트를 쓰지 않는다. 에이전트 1개 최소 약 2,400토큰이고, 기본값이면 수만 토큰이다 [harness 3.7].
- 에이전트는 DB에 쓰지 않는다. `spool/`과 `kb fetch`, `kb submit`만 쓴다.
- 정의, 워크플로우, 스케줄은 전부 저장소 코드다(R12).

### 17.2 구성

| 에이전트 | 도구 | 모델 | 역할 |
|---|---|---|---|
| `kb-extractor` | 없음 | haiku | 배치 추출, JSON만 |
| `kb-scout` | `WebSearch`, `WebFetch`, `Bash(kb fetch *)` | sonnet | 티켓의 소스 탐색. WebFetch는 손실형이므로 원문은 `kb fetch`로 저장 [compression §6] |
| `kb-judge` | `Read`, `Bash(kb show *)` | sonnet | H01~H11 근거 정리 |
| `kb-retro` | `Read`, `Bash(kb metrics *)` | haiku | 회고 초안 |

공통: `omitClaudeMd: true`, `maxTurns` 명시, 도구 최소화. 맞춤 에이전트는 토큰을 16,883~29,787에서 2,359로 줄인다 [harness T19].

| 워크플로우 | 트리거 | 내용 |
|---|---|---|
| `kb-fulfill.js` | 일 1회, 티켓 있을 때 | scout → `kb fetch` → 일반 경로 |
| `kb-survival-review.js` | 주 1회, 대기열 있을 때 | judge가 근거 정리 |
| `kb-retro.js` | 주 1회 | 지표 → 제안 |
| `kb-eval.js` | 프롬프트 변경 시 | 골든 평가 |

### 17.3 호출 형태

검증된 조합 [harness T21]을 그대로 쓴다.

```sh
env -i HOME="$HOME" PATH="<고정>" LANG=C.UTF-8 DISABLE_AUTOUPDATER=1 \
  CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 \
  "$KB_CLAUDE_BIN" -p "/kb-fulfill" \
    --setting-sources project --strict-mcp-config --settings ops/job-settings.json \
    --tools "Workflow,Read,Bash,WebSearch,WebFetch" \
    --permission-mode dontAsk --permission-prompts none \
    --model haiku --max-turns 8 --max-budget-usd 2 \
    --output-format stream-json --verbose --include-hook-events
```

- `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`이 없으면 10분 뒤 exit 0으로 멈춘다 [harness T22e].
- `Workflow(name)` 허용과 샌드박스는 `--settings`로 넘긴다. 프로젝트 `permissions.allow`는 trust 없으면 무시된다 [harness T4d].
- `--tools`는 워크플로우 에이전트의 상한이다. 필요한 도구가 없어도 exit 0이다 [harness T20].
- 수집 작업은 샌드박스 안에서 돈다. `failIfUnavailable: true`, 쓰기는 `spool/`만 [harness T15].
- 스트림을 `ops/runs/`에 보관하고 판정 규칙 + 응용 수준 검증(적재 건수)으로 성공을 판단한다.
- **rtk hook은 작업에서 쓰지 않는다.** 재작성이 허용 규칙을 깬다 [harness T13a]. `--settings`에 `disableAllHooks`를 둔다. 수집 경로가 압축 도구에 의존하지 않게 한다.

## 18. 자가 개선

### 18.1 지표

| 지표 | 소스 | 저장 |
|---|---|---|
| 수율(소스별 신규 레코드, 주장, 거부율) | 원장, `ops.db` | `ops.db` |
| 토큰, 비용, 도구 실패, 권한 거부 | 전사 ETL, `result` 스트림 | `ops.db` |
| 신선도(클래스별 stale 비율, 공백) | 워치독 | `ops.db` |
| 실패(재시도, DLQ, 서킷) | 수집기 | `ops.db` |
| 생존성(백업 나이, 훈련 소요, RTO, 재생 속도) | 훈련 | `ops.db` + 머신 밖 |

전사는 30일 뒤 조용히 삭제되므로 주 1회 ETL한다. 원문이 아니라 지표만 적재한다 [harness 7.1]. 토큰 합계는 자체 추출과 ccusage가 일치했다 [harness 7.3]. 스키마 변경 위험이 있으므로 ccusage를 교차 확인용으로 쓴다.

### 18.2 회고

```
주 1회 kb-retro → 지표 비교 → 제안 작성(docs/retro/YYYY-Www.md + 패치)
  → 사용자 검토 → 골든 평가 통과 → 적용(prompt_version 증가)
  → 다음 주 지표로 효과 확인 → 나쁘면 되돌리고 해당 버전 주장 철회
```

- **자동 적용하지 않는다.** 커밋은 사용자 요청 시에만 한다. 에이전트가 자기 정의를 바꾸지 않는다.
- **골든 평가.** 고정 스냅샷 묶음(WARC에 있음)을 추출해 스키마 통과율, 인용 통과율, 문서당 토큰을 잰다. 프롬프트 변경의 회귀 시험이다.
- 회고 문서는 시스템 설계 문서라 지침 5의 대상이 아니다. 지식 그래프에 넣지 않는다.

## 19. 대체 불가 데이터의 백업

### 19.1 3곳 + 1평문

물리 디스크가 1개이므로 `/mnt/c` 사본은 SSD 고장을 막지 못한다 [general-db M24].

| 사본 | 위치 | 막는 장애 | 쓰기 보호 | 대상 |
|---|---|---|---|---|
| A | `/mnt/c/.../kb-restic`(restic) | ext4, vhdx 손상 | 없음 | T0, T1 |
| B | Proxmox LXC `rest-server --append-only`(v0.14.0, 2025-05-31, linux_amd64 바이너리 있음) | SSD 고장, 랜섬웨어 | 기존 백업 삭제·변조 불가 [S6] | T0, T1 |
| C | Cloudflare R2(restic S3) | 집 단위 재해 | 버킷 잠금(`locks/` 접두사 제외) [S7] | T0, T1 |
| D | GitHub 비공개 저장소(평문 Markdown + NDJSON 일부) | restic 자체 문제, 사람이 읽기 | Git 이력 | T0. 범위는 사용자 결정(22장 8번) |

- restic은 저장소 파일을 AES-256으로 암호화하므로 `secret`도 머신 밖에 둘 수 있다 [general-db M21].
- A → B, C는 `restic copy`다. 한쪽 실패가 다른 쪽을 막지 않는다. 중복 제거를 유지하려면 대상 저장소를 `--copy-chunker-params`로 만든다.
- 평문 사본이 있는 이유는 **restic 형식이나 비밀번호에 문제가 생겨도 first_party가 살아남게** 하기 위해서다. `secret`은 제외한다.
- R2 10 GB 무료로 시작한다. WARC 증가량은 연 1~2 GB로 추정한다 [추정, 부록 B].
- 버킷 잠금과 restic 잠금 파일의 상호작용은 [미측정]이다.

### 19.2 전송 주기

| 대상 | 방법 | 주기 |
|---|---|---|
| 원장 신규 이벤트 | NDJSON 세그먼트 봉인 → restic → 앵커 | 쓰기 후 5분 지연, 세션 종료 시 즉시 |
| 원장 스냅샷 | SQLite 백업 API | 일 1회 |
| WARC | 봉인 세그먼트 | 1시간 |
| 런타임, 모델 | `runtime/`, `models/` | 변경 시 |
| 평문 내보내기 | 결정적 Markdown + git push | 일 1회, first_party 변경 시 |

- **백업 API를 쓴다.** `VACUUM INTO`는 세대당 20~25 MB, 백업 API는 5~6 MB다 [general-db M21]. `VACUUM INTO`는 게시 사본 전용이다.
- **세션 종료 hook이 왜 필요한가.** 세션이 끝나면 WSL이 15초 뒤 내려갈 수 있어 지연 타이머가 못 돈다. 플러그인의 `SessionEnd` hook이 `kb ship --if-dirty --timeout 20`을 동기로 돌린다. 네트워크가 없으면 실패하고 넘어간다.
- **RPO의 진실.** T0는 쓰기가 일어난 머신이 살아 있는 동안 5분 이내다. 마지막 쓰기 후 전송 전에 SSD가 죽으면 그만큼 잃는다. 더 줄이려면 Litestream 상주(PSS 35 MB, 복제 1초)가 필요하다. R13과 충돌하므로 사용자 결정이다.

### 19.3 훈련

**복원을 시험하지 않은 백업은 경보로 친다.**

| 주기 | 내용 | 경보 |
|---|---|---|
| 매일 | `restic check`, `--read-data-subset`으로 1/30 순환. `--read-data`만 팩 내용을 검사한다 [general-db M21] | 실패 시 치명 |
| 매주 | 최신 원장 복원 → 체인 → 앵커 | 실패 시 치명 |
| 매월 | **전체 종단 훈련.** 복원 → 재구축 → 지문 대조. `KB_HOME/drill/`(ext4)에서 | 35일 초과 시 치명 |
| 분기 | 사람이 런북만 보고 다른 머신(LXC)에 복원 | 달력 |

월간 훈련 소요 시간을 지표로 남겨 RTO 추세를 본다.

### 19.4 비밀 관리

`~/.config/sagae-kb/secrets.env`(0600)에 둔다. restic 비밀번호, R2 키, 핑 URL이다. 저장소에 넣지 않는다. **비밀번호는 디스크 밖에 반드시 사본이 있어야 한다.** 이것이 없으면 이 장의 나머지가 전부 무의미하다.

## 20. 압축과 rtk·trail

### 20.1 저장 압축

| 대상 | 방식 | 근거 |
|---|---|---|
| WARC | 레코드별 gzip + revisit | 표준, 임의 접근, 손상 범위 1레코드 [D1, D13]. 평문 대비 5.1배 [D1] |
| 원장 내보내기 | gzip | 평문 복구 경로 |
| 백업 | restic zstd + 내용 기반 중복 제거 | 2세대 증가 4.86 MB [D11] |
| silver 관측 표 | 그대로. 임계 도달 시 Parquet 냉장 | Parquet은 반복 컬럼에 강함 [compression 8.2] |

**zstd 사전을 진실 계층에 쓰지 않는다.** 사전을 잃으면 복호화할 수 없고 [compression 8.1], 그것은 이 설계가 없애려는 단일 장애점이다. gzip이 zstd보다 약간 약한 것을 감수한다.

### 20.2 rtk(R11, R20)

| 항목 | 결정 |
|---|---|
| 판본 | 설치된 `rtk-oss` 1.1.0 |
| 등록 | `.claude/settings.json`에 손으로 등록. `rtk init`, `rtk init -g` 금지(CLAUDE.md를 고치거나 전역에 쓴다) |
| 훅 | `ops/hooks/rtk-guard.sh`. **허용 목록 방식:** 단일 명령 `git status`, `git diff`, `git log`, `git show`, `ls`, `rg`, `grep`, `tree`만 재작성. 평범한 등록은 `ask`와 `--disallowed-tools`를 뚫는다 [compression M4] |
| 제외 | `uv run`(비정상 종료 시 stdout 소실 [compression M5c]), 변경 명령 전부 |
| 상태 위치 | 재작성 결과를 `ops/hooks/bin/rtk-p`로 보낸다. 이 shim이 `XDG_DATA_HOME=$KB_REPO/.rtk/state`, `XDG_CONFIG_HOME`, `RTK_TELEMETRY_DISABLED=1`, `RTK_SUPPRESS_HOOK_WARNING=1`을 설정한다 [D12]. 실제 세션 연결은 [미측정] |
| 범위 | 대화형 세션 보조만. 스케줄 작업에서 끈다. 수집 경로의 의존성이 아니다 |
| 기대치 | 주력 수집 명령 `curl`, `gh api`, `cat`은 0%다. 30,000자 초과 출력은 이미 2,300자로 대체되므로 큰 절감률은 컨텍스트 절감이 아니다 [compression 4.5]. 저장 명령의 출력을 제한하는 것이 실제 절감이다 |

### 20.3 trail(R11, R20)

| 항목 | 결정 |
|---|---|
| 정체 | "trailing"은 Trail-Code로 판단. 사용자 확인 필요 |
| 연결 | `.mcp.json` 수동 등록 + `trail build`. 저장소 밖 쓰기 없음 확인 [compression M8] |
| 금지 | `trail init`(전역 쓰기, 새 worktree에서 기본값 재적용), `trail note`(`~/.trail` 쓰기, 한국어 거부) |
| 효용 | `.py`만 색인, 한국어 질의 빈 결과. `src/kb/`가 생긴 뒤 코드 탐색용. 지식 데이터에는 쓰지 않는다 |
| 응답 문구 | 도구 출력이 에이전트에게 행동을 지시한다. 스케줄 작업에 연결하지 않는다 |

### 20.4 토큰

응답 압축은 14.3절이 맡는다. id 우선이 지배적이고, TOON은 평면 표에서만 효과가 크다(−50.6%, 중첩 −1.1%) [compression M11]. `structuredContent`에는 적용 효과가 없어 채택하지 않는다. `ensure_ascii=False`는 필수다(토큰 약 2배 차이).

## 21. 외부 소비자 계약 초안

`docs/contracts/openapi.yaml`이 원본이다. 파일은 `sagae-tools.md` 요구를 기준으로 하고, 그 문서는 잠정본이므로 아래도 초안이다.

### 21.1 경계

| 항목 | 결정 |
|---|---|
| 형식 | OpenAPI 3.1.1 + JSON Schema 2020-12 |
| 경로 | `/v1`. 호환 파괴는 `/v2`, sagae-tools 세션에 통지 |
| 전송 | Unix 소켓(0600) 또는 `127.0.0.1`. 소켓 활성화. `StartLimitIntervalSec=0` 필수 [general-db M9] |
| 대체 | 같은 JSON을 내는 `kb api <path>` CLI. 게이트웨이가 있으면 뒤에 둔다 |
| 파일 대체 | `published/*.db`(`VACUUM INTO`, 읽기 전용 폴더에서 열림). 라이브 DB 직접 접근은 제공하지 않는다 |
| MCP | UI 경로로 쓰지 않는다. 코어를 공유한다 |

### 21.2 엔드포인트

| 경로 | 화면 | 비고 |
|---|---|---|
| `GET /v1/meta` | 전체 | 스키마 버전, epoch, `applied_seq`, 저하 상태 |
| `GET /v1/schema` | 스키마 자기기술 | 타입, 관계, 속성 카탈로그 |
| `GET /v1/overview` | 그래프 개요 | 컬럼 배열. `total`, `truncated`, `order=stable`, 닫힌 부분 그래프 |
| `GET /v1/nodes` | 표 보기 | 서버측 정렬·필터, 키셋 커서 |
| `GET /v1/nodes/{id}` | 상세 | 현재 주장, 관계, 역방향 링크. 병합 시 `merged_into` |
| `GET /v1/nodes/{id}/neighbors` | 이웃 | `depth`, `rtype`, `limit` |
| `GET /v1/nodes/{id}/history` | 시계열 | 대체 체인, 두 시간축 구간 |
| `GET /v1/search` | 전문검색 | 스니펫, 하이라이트 위치. 한국어 |
| `GET /v1/facets` | 패싯 | 필터 적용 개수, 시간 구간별 개수 |
| `GET /v1/claims/{id}/evidence` | 출처 | 오프셋 + TextQuoteSelector |
| `GET /v1/snapshots/{id}`, `/text` | 원문 | 메타데이터, 표시 본문 |
| `GET /v1/series/{metric}` | 시계열 | silver 관측. 공백 구간 포함 |
| `GET /v1/changes` | 변경 내역 | 커서 = 원장 seq |
| `GET /v1/exports/graph` | 전체 그래프 입력 | 매니페스트 + 컬럼 배열 JSON zstd |
| `GET /v1/ops/freshness`, `/requests` | 운영 | 읽기 범위 포함 여부는 합의 필요 |

### 21.3 공통 규칙

```json
{
  "schema_version": "1.0.0", "epoch": 1, "build_id": "g-000123",
  "data_as_of": "2026-10-31T09:12:03Z", "applied_seq": 183422,
  "degraded": [], "data": {}, "page": {"next_cursor": null, "total": 1234, "truncated": false}
}
```

| 주제 | 규칙 |
|---|---|
| 일관성 | 요청당 읽기 트랜잭션 1개. 봉투와 본문이 같은 시점이다 |
| 재구축 중 | 소비자에게 보이지 않는다. 열린 요청은 옛 빌드, 새 요청은 새 빌드. 논리 상태는 seq로 같다 |
| 조건부 GET | `ETag: "<epoch>-<applied_seq>"`, 304 |
| 커서 | 키셋, 불투명 base64url. 동시 삽입 중 중복 0, 누락 0 [general-db M20] |
| 변경 피드 | seq 단조. 재구축으로 깨지지 않는다. epoch이 바뀌면 410 후 내보내기로 재동기화 |
| 시점 지정 | 모든 읽기에 `as_of_valid`, `as_of_observed` |
| as-of 검색 | 현재용 FTS와 전 버전 FTS를 분리하고 후처리 필터 [미측정] |
| 기본 제외 | `active`만, 민감도 `internal` 이하. 상승은 토큰 범위로, 쿼리 파라미터로 올릴 수 없다 |
| 숨김 | 404로 통일 |
| 시각 | RFC 3339 UTC, `Z` |
| 오류 | RFC 9457 `application/problem+json` |
| 범위 초과 | `limit` 상한 초과는 400. 잘라 쓰지 않는다 |
| enum | `origin`, `sensitivity`, `status`만 닫힌 enum. 타입은 문자열 + `/v1/schema` |
| 엣지 | 항상 `id`. 양끝이 응답에 포함된 엣지만. 좌표 없음. 방향 멀티그래프 |
| 본문 | NFC 고정. 인용 오프셋은 표시 본문 기준 코드포인트, `start` 포함 `end` 미포함. TextQuoteSelector 병기 |
| 불변 ID | 엔티티, 관계, 주장, 스냅샷. 병합은 `merged_into` |
| 보안 | Host 검사, 와일드카드 CORS 금지, Bearer 자리 |
| first_party | 본문 Markdown, `author`, `version`, 노트 링크는 엣지, 백링크 조회 가능. 페이지 수준이고 블록 수준은 아님 |
| 집계 | KB는 개수, 분포만. 레이아웃, 커뮤니티, 중심성은 도구가 계산. 점수 없음 |

### 21.4 시험과 fixture

KB는 Schemathesis로 응답을 검증하고 CI에서 `oasdiff breaking --fail-on ERR`를 돌린다 [general-db M18]. fixture는 KB가 소유하며 대체 체인, 소급 정정, dead, 병합, 한글 본문, 인용 위치를 포함한다.

### 21.5 sagae-tools 질문 답변

| 질문 | 답 |
|---|---|
| 예상 규모 | 1년차 노드 2~5만, 엣지 20~30만, 주장 10만 내외, 고유 스냅샷 1~2만 [추정]. 측정은 20만·100만까지 목표 통과 |
| 실행 위치, HTTP 데몬 | 로컬 WSL. 소켓 활성화라 유휴 프로세스 0. 설치는 사용자 승인 대상. Proxmox로 옮겨도 계약 동일 |
| 본문 형식 | 원본은 WARC. 표시 본문은 NFC 텍스트 또는 Markdown. 오프셋은 표시 본문 기준 |
| 구현 언어, 동시 읽기 | Python. Bun 프로세스 안에서 호출 불가. HTTP, CLI 경로. 같은 호스트 다중 프로세스 읽기 안전 |

## 22. 사용자 결정

위에서부터 중요하다. 1~3이 없으면 생존성 목표가 성립하지 않는다.

| # | 결정 | 기본 제안 | 미결정 시 |
|---|---|---|---|
| 1 | **restic 비밀번호 디스크 밖 보관** | 비밀번호 관리자 + 종이 | 머신 밖 백업 전체가 잠재 전손 |
| 2 | **머신 밖 대상** | Proxmox LXC + R2 | SSD 고장에서 전손 |
| 3 | **healthchecks 계정과 알림 채널** | 무료 계정 | 침묵 장애를 알 수 없음 |
| 4 | 시스템 설치 승인 | systemd user 유닛, linger, Windows 작업, uv, 플러그인, `/mnt/c` 사본 | 수동 tick만 |
| 5 | ToS 제한 소스 | 소스별 `allowed: false`로 시작 | 1~3단계는 약관이 깨끗한 소스만 |
| 6 | 증인 | Proxmox LXC | 시점 소실 소스에 공백 |
| 7 | T0 RPO | 5분, 무상주 | Litestream 상주면 1초 |
| 8 | git 평문 사본 범위 | `internal` 이하, `private`, `secret` 제외 | |
| 9 | L2 사용량 상한 | 일일 문서 수와 활용률 상한 | 공시 한도 전제는 "ordinary, individual usage"다 |
| 10 | SEC EDGAR 연락처 | 사용자가 지정할 때까지 비활성 | 이메일을 자동 전송하지 않는다 |
| 11 | "trailing" = Trail-Code 확인 | | |
| 12 | `cleanupPeriodDays` 상향 | 변경 없음. 주간 ETL로 충분 | |
| 13 | 관제 서버 등록 | 직결 유지 + 등록 | |

**5번 상세.** 다음은 약관 또는 robots가 자동화를 제한한다. 법률 판단이 아니라 인벤토리의 사실이다.

| 소스 | 제한 | 등록 기본값 |
|---|---|---|
| YouTube 시청 페이지, yt-dlp, InnerTube | 약관의 자동화 조항, `/youtubei/` Disallow | false |
| 채널 RSS | `/feeds/videos.xml` Disallow | false |
| suggest | Google ToS 자동화 조항 | false |
| Trends 비공식 | Google ToS, `/explore?` Disallow | false |
| Playboard, Social Blade, 네이버 계열 | 약관이 자동화 수집 금지 | false |
| API 키 사용 시 | 30일 보존, 파생 지표 금지, 시장 통찰 목적 금지, API 클라이언트의 스크래핑 데이터 취득 금지 | 키 도입 전 재검토 |

도메인 A, C의 상당 부분이 여기에 걸린다. API 키를 도입하면 스크래핑 데이터 경로와 정책상 충돌하므로, 어느 한쪽을 고르는 결정이 필요하다. 레지스트리의 `allowed` 필드는 이 결정 전까지 수집을 막는 게이트다.

## 23. 구축 순서와 인수 시험

각 단계는 다음 단계 없이도 가치가 있고, 언제든 멈출 수 있다.

| 단계 | 범위 | 사용자 승인 | 인수 시험 |
|---|---|---|---|
| 0 코어 | 원장, WARC 작성기, 투영, 읽기 코어, fsck | 불필요 | D2, D4, D5, D8, D10을 `tests/kill/`로 고정 |
| 1 수집 | `kb tick`, 깨끗한 소스(G 문서, GitHub, npm, PyPI, arXiv, HN), 로컬 사본 A, 프로젝트 `.mcp.json` | 데이터 경로 | 수집 중 SIGKILL, 전체 파생 삭제 후 재구축 지문 일치 |
| 2 생존 | 머신 밖 B, C, D, healthchecks, 타이머, Windows 작업, 훈련 | 1~4번 | **실제 재부팅 시험**, 15초 종료 중 kill, `wsl --shutdown` 중 쓰기, 첫 종단 훈련 |
| 3 지식화 | L2, 게이트, 생존 판정, 요청 큐, 플러그인 | 9번 | 골든 평가, 인용 게이트 고장 주입, 카나리아 |
| 4 소비자 | HTTP API, 계약, fixture, 게시, 벡터 | sagae-tools 확정본 | Schemathesis, oasdiff, 재구축 중 폴링 무중단 |
| 5 확장 | 증인, 제한 소스, 깊은 순회, 회고 | 5, 6번 | 세그먼트 수입 멱등성, 서킷 동작 |

**2단계 실제 시험 목록.** 현재 세션을 죽일 수 있어 지금 재지 못한 항목이다. 이 시험이 통과하기 전에는 10장을 사실로 취급하지 않는다.

1. `wsl --shutdown` 후 작업 스케줄러 트리거만으로 catch-up이 끝까지 도는가.
2. 클라이언트 없는 부팅에서 tick이 끊긴 뒤 다음 기회에 이어 가는가.
3. linger 유무에 따른 사용자 타이머 기동.
4. 쓰기 도중 `wsl --terminate`. 원장 접두사 유지와 유실 건수.
5. Windows 절전 복귀 시 타이머, 시계 편차.
6. `hc-ping` 응답 본문 검사, 고의 침묵 시 경보 도달 시간.
7. 머신 밖 저장소에서 다른 머신으로 전체 복원.

## 24. 코드 범위

표준 라이브러리 위주의 Python이다. 줄 수는 프로토타입 규모로 본 [추정]이며 시험 코드를 뺀 값이다.

| 모듈 | 줄 | 내용 | 대신하는 기성품 |
|---|---:|---|---|
| `core/ledger.py` | 200 | 추가, 체인, 멱등, 내보내기 | SQLite, gzip |
| `core/warc.py` | 180 | 세그먼트 작성, 멤버 걷기, CDXJ | warcio |
| `core/project.py` | 400 | 이벤트 → 그래프, 지문, 업캐스터 | 없음(이벤트 소싱 고유) |
| `core/read.py` | 650 | 조회 코어, as-of, 패싯, 필터 | SQLite |
| `core/write.py`, `text.py`, `paths.py` | 250 | 쓰기 코어, bigram, NFC, 경로 검사 | |
| `collect/` | 300 + 어댑터 15종 × 40 | tick, fetch, 속도 제한, 서킷 | `requests`, feedparser, Trafilatura, yt-dlp |
| `refine/` | 450 | dlt 리소스, promote, 게이트 | dlt |
| `survive/` | 350 | 신호, 판정, 공백 | `gh`, 레지스트리 API |
| `guard/` | 500 | fsck, scrub, 워치독, ship, drill | restic, git, healthchecks |
| `serve/` | 400 | MCP 도구, HTTP 라우트 | FastMCP, Starlette |
| `l2.py`, `metrics.py`, `cli.py`, 파일 입력 | 550 | `claude -p` 루프, 전사 ETL, CLI, Markdown | |
| **합계** | **약 4,600** | | |

그 외 systemd 유닛 약 12개, Windows 작업 1개, 소스 레지스트리 YAML 약 100개, 에이전트 4개, 워크플로우 4개, 시험 코드(kill, 골든, 계약)가 약 1,500줄 [추정]이다.

R13에 비춰 가장 무거운 부분은 `project.py`와 `read.py`다. 그래프 계층을 직접 쓰는 것은 기존 프로젝트가 출처 보존, 시간성, 키리스 쓰기, 생존 판정을 함께 만족하지 못하기 때문이다 [prior-art §1]. 다만 투영기는 파생이므로 GraphQLite나 LadybugDB로 바꿔도 진실 계층은 그대로다.

## 25. 이 설계가 틀렸다고 판단할 조건

| 신호 | 임계 | 전환 |
|---|---|---|
| 재구축 시간 | 30분 초과 | 게시 사본 + 꼬리 재생으로 시작 |
| 쓰기 경합 | 동시 세션 p99 100 ms 지속, 초당 커밋 수백 | 임베디드 PostgreSQL로 gold 또는 원장 [general-db 4.4] |
| 깊은 순회 | 허브 3-hop 요구가 실제 발생, p95 200 ms 초과 | LadybugDB 읽기 투영 |
| 벡터 규모 | 전수 질의 p95 100 ms 초과 | LanceDB, HNSW |
| 원장 비대 | 연 1 GB 초과 | 파서 이벤트를 silver로 되돌림 |
| WARC 비대 | 무료 구간 초과 시 비용 문제 | 변동 소스 재검토 |
| 투영 호환 부담 | 업캐스터가 이벤트 종류의 절반 이상 | 체크포인트 이벤트 + 옛 구간 동결 |
| `--bare`가 `-p` 기본값이 됨 | 릴리스 노트 | API 키 또는 고정 버전 유지. 로컬 모델은 1.7B에서 도구 호출만 확인했고 거짓 성공이 있었으므로 대체 경로로 쓰기 어렵다 [sources-inventory-g 8.5] |
| 구독 자동화 사용 제한 | 정책 변경 | L2를 수동 세션으로, 또는 API 키 |
| 운영 비용이 효용을 넘음 | 주간 경보가 사용자의 시간을 잠식 | 소스 축소가 먼저다 |

## 26. 남은 미확인

| 항목 | 영향 | 해소 시점 |
|---|---|---|
| vhdx 위 fsync가 물리 매체까지 닿는지 | T0 로컬 내구성 | 불가능할 수 있음. 머신 밖 전송으로 범위를 묶음 |
| 전원 손실 실측 | D7은 근사 | 2단계 시험 |
| 실제 WSL 재부팅 경로 | 10장 전체 | 2단계 시험 |
| 다중 세션 쓰기 지연 | D9는 단일 세션 | 0단계 |
| 다중 투영자 경합 | 7.5절 규칙 미시험 | 0단계 |
| `payload` 분리와 redact 후 체인 검증 | 프로토타입과 구조가 다름 | 0단계 |
| 머신 밖 네트워크 복원 시간 | RTO는 추정 | 2단계 |
| R2 버킷 잠금 + restic | 쓰기 보호 | 2단계 |
| 추출 JSON의 바이트 안정성 | 변동 소스 중복 제거 | 5단계 |
| 게이트의 실제 통과율 | L2 수율 | 3단계 |
| 대형 임베딩 공개 데이터 성능 | 모델 선택 | 4단계 |
| GitHub 러너 IP의 응답 | 증인 2안 | 5단계 |
| 실제 규모와 변경률 | 부록 B 추정 | 운영 3개월 |
| as-of 검색 구현 | 소비자 계약 | 4단계 |
| rtk shim의 권한 평가 | 20.2절 | 1단계 |

## 부록 A. 재현과 핵심 코드

측정 환경: CPython 3.13.18, SQLite 3.53.1, warcio 1.8.2, restic 0.19.1(공식 바이너리, SHA256SUMS 일치 확인), 공용 tmpfs.

```bash
uv venv --python 3.13 venv; uv pip install warcio
python -I e1_warc.py <dir> docs/research <out>        # D1, D4
python -I e1b_verify.py <dir> <out>                   # D2, D3
python -I e2_ledger.py crash <dir> 150 <out>          # D5. 쓰기 간격 1.5 ms
python -I e2_ledger.py replay <dir> 50000 <out>       # D6
python -I e2_ledger.py tornwal <dir> 2000 300 <out>   # D7
python -I e2_ledger.py bitrot <dir> 5000 300 <out>    # D8
LD_PRELOAD=fsync_delay.so FSYNC_DELAY_US=1300 python -I e2_ledger.py latency <dir> 1500 <out>  # D9
python -I e3_swap.py <dir> <out>                      # D10
python -I e4_drill.py <dir> docs/research <out> <restic> 20000 3000   # D11
```

SHA-256 작성기. warcio의 비공개 메서드를 재정의하므로 버전을 고정한다.

```python
class SHA256Writer(WARCWriter):
    @staticmethod
    def _create_digester():
        return Digester("sha256")
```

엄격한 멤버 걷기. D4에서 240/240 정확했다.

```python
def walk_members(buf):
    pos, count, n, mv = 0, 0, len(buf), memoryview(buf)
    while pos < n:
        d, p, head = zlib.decompressobj(31), pos, b""
        try:
            while p < n and not d.eof:
                chunk = mv[p:min(p + 65536, n)]
                out = d.decompress(chunk)
                if len(head) < 8: head += out[:8]
                p += len(chunk) - len(d.unused_data)
        except zlib.error:
            break
        if not d.eof or not head.startswith(b"WARC/"):
            break
        pos, count = p, count + 1
    return pos, count     # 온전한 멤버의 끝 오프셋과 개수
```

체인 입력. 본문이 아니라 본문 해시를 묶는다.

```python
h = sha256("\n".join([prev, str(seq), event_id, at, actor, origin, kind, payload_sha]))
```

gold 교체. 경로를 교체하지 않고 symlink를 rename한다. 프로젝터는 잠금을 쥐고 다음 쓰기 때 `realpath`를 다시 읽는다.

```python
with exclusive_lock(gold / "swap.lock"):
    os.symlink(build, gold / ".next")
    os.replace(gold / ".next", gold / "current")
```

## 부록 B. 규모 추정

| 항목 | 산식 | 값 [추정] |
|---|---|---|
| G 문서 | 약 440쪽 × 일 3% × 16 KB | 0.2 MB/일 |
| 변경 이력 | C01, C02, O03 변경 시 재수집 | 1 MB/일 |
| 피드 | 30개 × 5 KB | 0.15 MB/일 |
| 자동완성(승인 시) | 일 5,000행 | 0.05 MB/일 |
| 영상 메타(승인 시) | 일 100건 × 9 KB | 1 MB/일 |
| A~F 문서 | 월간·연간 보고서 PDF | 0.5 MB/일 |
| **WARC 합계** | | **약 3 MB/일, 연 1~2 GB** |
| 원장 | 연 50만 이벤트 × 약 600바이트 | 연 300 MB |
| 재구축 | 50만 건 ÷ 4,191건/s | 약 2분 |

D1의 비율, compression 8.4의 변경률을 썼다. 실제 일 변경률은 측정되지 않았다.

## 부록 C. 요구사항 추적

| 요구 | 충족 위치 |
|---|---|
| R1 원시 보존, ELT | 3장, 7.2, I1. WARC + SHA-256 |
| R2 재구축 | 7.5, I3, D5, D11 |
| R3 관계 중심 | 6.2 |
| R4 시간성 | 6.3 |
| R5 출처 게이트 | 6.4 |
| R6 중립성 | 6.4, 6.5, 14.3, 15.2. 점수 없음, 대시보드 없음 |
| R7 신선도 | 8, 9, 11 |
| R8 지속 실행, 결정적/에이전트 분리 | 7.1, 7.4, 10 |
| R9 반환 | 14 |
| R10 검색 | 16 |
| R11 압축 | 20 |
| R12 자가 개선 | 17, 18 |
| R13 재발명 금지, 상주 최소 | 4, 24. 상주 프로세스 0 |
| R14 LLM 키 없음 | 7.4, 17.3 |
| R15 범용 저장 | 6.2, 6.4, 13 |
| R16 대체 불가 보호 | 3.2, 19 |
| R17 쓰기 인터페이스 | 13 |
| R18 소비자 계약 | 21 |
| R19 생존 판정 | 6.5, 8.2, 15 |
| R20 rtk·trail 프로젝트 한정 | 20.2, 20.3, D12 |

## 부록 D. 이 문서에서 새로 쓴 출처

조사 보고서의 출처는 각 보고서를 따른다. 확인일은 모두 2026-10-31이다.

| ID | 출처 |
|---|---|
| S1 | SQLite How To Corrupt, https://www.sqlite.org/howtocorrupt.html (1.3, 1.4, 2.5, 3.1절) |
| S2 | SQLite ATTACH, https://www.sqlite.org/lang_attach.html (WAL에서 파일 간 원자성 없음. 원장과 gold를 한 트랜잭션으로 묶지 않는 이유) |
| S3 | SQLite Checksum VFS, https://www.sqlite.org/cksumvfs.html |
| S4 | WARC 1.1, https://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/ |
| S5 | Healthchecks HTTP API, https://healthchecks.io/docs/http_api/ |
| S6 | restic rest-server, https://github.com/restic/rest-server (`--append-only`) |
| S7 | Cloudflare R2 Bucket Locks, https://developers.cloudflare.com/r2/buckets/bucket-locks/ |
| S8 | restic 저장소 준비, https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html |
| S9 | Task Scheduler WakeToRun, https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-waketorun-settingstype-element |
