# ELT 파이프라인, 크롤링·추출, 스케줄링 조사

- 조사일: 2026-10-31 (KST). 웹 출처의 확인일은 부록 C 표에 출처별로 적었고, 모두 2026-10-31이다.
- 표기: `[S번호]`는 출처(부록 C), `[M번호]`는 이 머신의 실측(§9)이다.
- 성격: 시스템 설계 입력 문서다. CLAUDE.md 지침 5의 예외(설계 문서)에 해당한다. 수집 지식 데이터로 적재하지 않는다.
- 실측 범위: `scratchpad/etl/` 전용 venv(Python 3.13.18, uv 0.13.6). 저장소, `~/.claude`, crontab, 실제 systemd 설정, 셸 프로필은 바꾸지 않았다.

## 1. 결론

**상시 서버는 필요 없다. 얇은 조합으로 충분하다.** 후보 조합은 다음과 같다.

| 층 | 선택 | 근거 |
|---|---|---|
| 적재 | dlt 1.32.0 (`merge` + 결정적 기본키) | SIGKILL·결함 주입에서 중복·유실 0 [M5] |
| 원본 보존 | warcio 1.8.2 (WARC) | 네트워크 없이 WARC만으로 동일 결과 재구축 [M14] |
| 스케줄 | systemd user timer (`Persistent=true`) | catch-up → dlt → 핑 종단 검증 [M19] |
| 사망 감지 | healthchecks.io 무료 | 머신 밖에서 침묵을 감지. 20개 무료 [S13] |
| 머신 꺼짐 대비 | GitHub Actions | 스케줄 지연 실측 p50 6~36분 [M22] |

오케스트레이터가 필요 없다고 본 근거는 네 가지다.

1. **상시 서버는 distro와 함께 죽는다.** WSL은 Windows 쪽 클라이언트가 없으면 15초 뒤 `systemctl poweroff`를 실행한다. 서비스가 떠 있어도 판정에 들어가지 않는다 [S01][S02][S03]. 상시 서버가 "항상 떠 있다"는 이점이 여기서는 성립하지 않는다.
2. **유휴 메모리 비용이 크다.** Airflow 951MB, Kestra 699MB, Dagster 550MB, Prefect 179MB다. 얇은 조합의 추가 상주 비용은 0이고, `systemd --user`는 이미 떠 있다(RSS 9.3MB) [M3].
3. **재시도·복구는 오케스트레이터가 아니라 dlt와 systemd에 있다.** 패키지 재개, 재시도, 지수 백오프, 실패 알림이 모두 실측으로 동작했다 [M5][M7][M19].
4. **구간별 backfill은 이 데이터에 쓸모가 없다.** 자동완성 같은 시점 스냅샷은 과거 값을 다시 얻을 수 없으므로 놓친 슬롯 72개를 72번 돌려도 소용없다. 1회 catch-up이면 충분하다.

**다만 얇은 조합만으로 해결되지 않는 위험이 다섯 가지 있다.** 설계에서 반드시 다뤄야 한다.

| # | 위험 | 실측 | 대응 |
|---|---|---|---|
| 1 | catch-up 작업이 15초 뒤 끊긴다 | 소스 분석. 실측 불가(§5.2) | Windows 쪽 클라이언트를 작업 끝까지 유지 |
| 2 | DuckDB는 쓰기 중 다른 프로세스가 읽지 못한다 | 읽기 연결이 있으면 dlt 적재 실패 [M11] | 적재 DB와 서빙 DB 분리 [M17], 또는 SQLite WAL [M13] |
| 3 | 스키마 freeze 실패가 전체 파이프라인을 막는다 | 무관한 리소스까지 차단 [M9] | 소스별 파이프라인 분리, `abort-packages` 절차 |
| 4 | 짧은 창의 소스는 꺼진 동안 영구 유실된다 | GitHub atom 10건, HN 30건 [M4] | 소스별 창을 최대 다운타임과 비교, 머신 밖 수집 |
| 5 | `append`는 극히 좁은 구간에서 중복된다 | 2000행/1000 고유 [M5] | `merge`와 결정적 키만 사용 |

## 2. 환경 실측 [M0]

| 항목 | 값 |
|---|---|
| WSL / 커널 / Windows | WSL 3.0.3.0 / 6.18.54.1-1 / 10.0.26300.9818 |
| 배포판 / systemd | Ubuntu 26.04.1 LTS / 259 |
| `.wslconfig` | `memory=48GB`, `networkingMode=Mirrored`, `autoMemoryReclaim=Gradual`. 14:26 수정. 현재 VM은 08:48 부팅이고 메모리 30GiB이므로 미반영 상태다 |
| 유휴 설정 | `instanceIdleTimeout`, `vmIdleTimeout` 없음. 기본값 15000ms, 60000ms 적용 [S01] |
| 사용자 매니저 | `Linger=no`인데 `user@1000.service`는 active (로그인 세션 c1, c2 존재) |
| 저널 부팅 이력 | 오늘 3회만 있어 다운타임 분포는 아직 산출 불가 |
| 타이머 스탬프 | 사용자 측 `~/.local/share/systemd/timers` 없음 (Persistent 타이머 없음) |
| cgroup 위임 | `cpu memory pids`. `io`는 없음 |
| 없는 것 | java, deno, chrome, anacron. `sudo`는 비밀번호 필요 |
| `/tmp` | 16GB tmpfs. **병렬 작업자가 공유하며 scratchpad도 여기 있다** |

**tmpfs 제약.** 측정 중 사용률이 98%까지 올라 Kestra, ArchiveBox, Docling 측정이 `No space left on device`로 실패했다. 다른 작업자의 쓰기도 영향을 받았을 수 있고, 이 작업의 사용량(최대 3.5GB)도 원인 중 하나였다. 이후 측정이 끝난 산출물을 지웠다. 운영 데이터는 `/tmp`에 둘 수 없고 `/home`(여유 950GB)에 둬야 한다.

네트워크는 넓게 열려 있다. PyPI, GitHub, suggestqueries, YouTube 시청 페이지, Wayback, healthchecks, npm, Maven, Adoptium, Hacker News, Hugging Face, Wikipedia가 모두 200을 반환했다. 예외는 YouTube 채널 RSS(§4.3)와 `registry.ollama.ai` 루트(503)다.

## 3. ELT·오케스트레이션

### 3.1 후보표

유지보수 상태는 GitHub API의 최근 push 일자와 릴리스 주기로 판단했다. 설치 수치는 §9 [M1]이다.

| 도구 | 최신 / 릴리스 | 유지보수 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|
| dlt | 1.32.0 / 2026-10-29 | 활발. push 10-31 | Apache-2.0 [S22] | 높음. 라이브러리, 서버 없음 | `duckdb<2` 상한 [M12] |
| Dagster | 1.13.28 / 2026-10-30 | 활발. push 10-30 | Apache-2.0 | 중간. 1회성 실행은 서버 없이 가능 | 스케줄은 daemon 필요 [S26] |
| Prefect | 3.9.1 / 2026-10-30 | 활발. push 10-30 | Apache-2.0 | 중간. 1회성 실행 비용이 측정 구성 중 가장 큼 [M2] | 스케줄은 서버·워커 필요 |
| Airflow | 3.3.2 / 2026-09-17 (3.4.0rc1 10-28) | 활발. push 10-31 | Apache-2.0 | 낮음. 프로세스 40개 | SQLite는 운영 금지, PostgreSQL 또는 MySQL 권장 [S31]. 둘 다 없음 |
| Kestra | 2.0.7 / 2026-10-20 (2.0은 LTS [S34]) | 활발. push 10-30 | Apache-2.0 (일부 EE 전용 [S34]) | 낮음. JVM 상주 | Java 25 필요 [M3]. 문서의 "21+"와 불일치 [S32] |
| Hamilton | 1.90.0 / 2026-04-25 | 중간. push 10-27, 릴리스는 6개월 전. Apache 인큐베이팅 | Apache-2.0 | 조건부. DAG 라이브러리일 뿐 스케줄러 아님 | 없음. 패키지명 `apache-hamilton` |
| dbt-core | 1.12.6 / 2026-10-14 | 활발. push 10-31 | Apache-2.0 | 조건부. SQL 변환이 생길 때 | dbt-duckdb가 duckdb 2.0을 가져와 dlt와 충돌 위험 [M12] |
| SQLMesh | 0.236.4 / 2026-10-22 | 활발. push 10-31. Linux Foundation 기증 [S36] | Apache-2.0 | 조건부. 위와 같음 | DB 파일명 `sqlmesh.duckdb` 금지 [M18] |

dbt 동향: 2026-06-01 dbt Core v2 첫 알파가 Apache-2.0으로 공개됐다. v1.x는 PyPI에 남으며 종료일은 제시되지 않았다 [S35]. SQLMesh는 2026-03-25 Fivetran이 Linux Foundation에 기증한다고 발표했다 [S36].

### 3.2 같은 작업의 실행 비용

작업은 Atom/RSS 3개, PyPI JSON 5개, YouTube 자동완성 3개를 읽어 2,631행을 DuckDB에 넣는 것이다. wall 시간은 네트워크 대기 때문에 변동이 커서 CPU 시간을 함께 적었다.

| 구성 | CPU 초 (3회) | wall 초 (3회) | 최대 RSS MB | 상태 디스크 |
|---|---|---|---|---|
| dlt 단독 | 1.57 / 1.51 / 1.51 | 2.40 / 2.44 / 2.54 | 157~168 | 4KB |
| Hamilton + dlt | 4.15 / 2.37 / 2.97 | 14.66 / 2.29 / 11.80 | 193~206 | 4KB |
| Dagster 1회성 | 6.27 / 5.31 / 4.32 | 18.60 / 6.32 / 5.24 | 223~231 | 788KB |
| Prefect 1회성 | 16.51 / 7.72 / 6.46 | 18.03 / 13.98 / 7.80 | 277~293 | 5.3MB |

모두 데이터 결과는 같았다(중복 키 0). 표의 RSS는 프로세스 트리 중 가장 큰 프로세스 값이다 [M2].

### 3.3 상주 시 유휴 메모리

| 구성 | PSS MB | 프로세스 수 | 측정 창 |
|---|---|---|---|
| Airflow `standalone` | 951 | 40 | 150초 |
| Kestra `server local` (튜토리얼 끔) | 699 | 1 (JVM) | 120초 |
| Dagster `dev` (웹+daemon+코드서버) | 550 | 5 | 90초 |
| Dagster `dagster-daemon`만 | 247 | 2 | 60초 |
| Prefect `server start` (워커 없음) | 179 | 1 | 75초 |
| 얇은 조합 | 0 추가 | 0 | `systemd --user` 기존 RSS 9.3MB |

워크로드가 없는 유휴 값이다 [M3]. Airflow는 SQLite·LocalExecutor로 돌린 개발 구성이므로 운영 구성의 값이 아니다.

### 3.4 놓친 실행의 처리 방식

| 스케줄러 | 다운타임 후 동작 | 근거 |
|---|---|---|
| systemd `Persistent=true` | 놓친 횟수와 무관하게 **1회** | 실측. 72슬롯 놓쳐도 1회 [M19] |
| Dagster | 비파티션 스케줄은 마지막 tick 1회. 파티션 스케줄은 `max_catchup_runs`(기본 5)까지 | 설치본 소스 [S27] |
| Airflow 3 | 기본 `catchup=False`. 켜면 구간별 실행 | [S30] |
| Kestra | 기본 `recoverMissedSchedules: ALL`. `LAST`, `NONE` 선택 가능 | 기본 설정 파일 [M3], [S33] |
| Prefect | 시작 시각을 넘긴 런은 15초 뒤 `Late`. 서버 부재 시 복구 동작은 공식 문서에서 확인 못함 | [S28] |
| cron | 없음. `anacron`은 이 머신에 없음 | [M0] |
| GitHub Actions | 지연·드롭 가능, 보충 없음 | [S16] |
| Windows 작업 스케줄러 | `StartWhenAvailable=true`면 놓친 뒤 실행. 기본 false | [S12] |

위 어느 것도 "머신이 꺼져 있는 동안"을 해결하지 못한다. 해결하는 것은 머신 밖 실행뿐이다.

## 4. 크롤링·추출

### 4.1 후보표

| 도구 | 최신 / 릴리스 | 유지보수 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|
| Trafilatura | 2.3.1 / 2026-10-06 | 활발. push 10-30 | Apache-2.0 | 높음. 18패키지, 61MB, 브라우저 불필요 | JS 렌더링 페이지는 내용 부족 [M20] |
| yt-dlp | 2026.10.26 / 2026-10-26 | 매우 활발 | Unlicense | 높음. 29MB, API 키 불필요 | JS 런타임 필요(node 가능). IP 제한 위험 [S40] |
| Playwright | 1.64.1 (Python) / 2026-10-22 | 활발 | Apache-2.0 | 중간. 필요한 페이지에만 | Chromium 라이브러리 없음, `install-deps`용 sudo 없음 [M20][S42] |
| Crawl4AI | 0.9.5 / 2026-10-14 | 활발. 0.9.x만 지원 [S38] | Apache-2.0 | 중간. 설치 679MB | 2026년 CVE 다수 [S38][S39]. LLM 의존성 동반 [M20] |
| Docling | 2.145.0 / 2026-10-29 | 매우 활발 | MIT | 조건부. PDF가 필요할 때. HTML 등은 torch 없는 `docling-slim` 가능 [S43] | 기본 PDF 경로가 torch를 요구, 현재 tmpfs에 설치 불가 [M21] |
| Firecrawl 자체 호스팅 | v2.11.0 / 2026-06-19 (SDK 4.54.0 / 10-22) | 활발. push 10-31 | AGPL-3.0 (SDK MIT) | 낮음 | **Docker 없음.** Redis, PostgreSQL 등 스택 필요. Fire-engine 미포함 [S37] |

`firecrawl-py`의 MIT는 SDK 라이선스이고, 서버는 AGPL-3.0이다.

### 4.2 실측 비교

정적 HTML은 `curl`로 받은 파일이다. 출력 길이는 도구마다 뜻이 달라서 품질 지표가 아니다. Trafilatura는 본문만, Crawl4AI는 페이지 전체를 마크다운으로 낸다.

| 대상 | Trafilatura | Crawl4AI | Playwright 렌더링 텍스트 | Docling-slim |
|---|---|---|---|---|
| ko.wikipedia 유튜브 (1,474KB) | 87,700자, 0.68초 | 384,763자, 2.44초 | 미측정 | 미측정 |
| blog.youtube 뉴스 (74KB) | **772자**, 0.05초 | 6,680자, 1.67초 | 2,058자, 3.83초 | 미측정 |
| MS Learn wsl-config (90KB) | 26,393자, 0.06초 | 미측정 | 미측정 | 57,186자, 0.38초 |
| 프로세스 RSS | 120MB | Python 162MB | Python 67MB | 339MB |

blog.youtube 행이 경로 분기의 근거다. 정적 추출이 772자에 그치고 렌더링은 2,058자를 낸다. 값싼 정적 추출을 먼저 하고, 결과가 너무 짧을 때만 브라우저로 넘기면 된다. 브라우저 쪽 수치에 Chromium 프로세스 메모리는 포함되지 않았다 [M20].

### 4.3 YouTube 관련 실측

- 메타데이터: `yt-dlp --skip-download --dump-json` 1.66초, 76MB. 조회수 447,263,104 등 필드를 얻었다.
- JS 런타임: 없으면 경고가 나고 "지원 중단" 안내가 뜬다. 기본 활성은 deno뿐이고 `--js-runtimes node`로 node를 쓸 수 있다 [M20]. README는 `yt-dlp-ejs`와 JS 런타임을 완전한 YouTube 지원의 요구사항으로 적는다 [S40].
- 채널 목록: `--flat-playlist --playlist-end 20` 0.74초, 60MB. 다만 `view_count`, `timestamp`, `upload_date`가 `null`이다.
- 자동 자막: `--write-auto-subs --skip-download`로 VTT 440바이트를 받았다.
- **채널 RSS는 측정한 모든 시점에 404다.** 약 06:18Z, 06:45Z, 06:59Z에 채널 ID 4종과 `playlist_id` 형식이 모두 실패했다. 공개 보고는 간헐 장애로 설명하지만 [S55] 이 환경에서는 복구를 관측하지 못했다 [M23]. `sources-inventory.md`도 같은 결과를 더 넓게 측정했고, 해당 경로가 robots.txt의 Disallow 대상임을 기록했다.
- IP 위험: "Sign in to confirm you're not a bot"에 대해 유지관리자는 IP 제한이 원인이라고 답했다 [S40]. WSL의 출구는 사용자 회선이므로 과도한 호출은 평소 YouTube 사용에도 영향을 줄 수 있다. 실측에서는 호출이 적어 차단을 만나지 않았다. 임계값은 미확인이다.

### 4.4 Crawl4AI 보안 이력

대부분 Docker API 서버 쪽 문제다. CVE-2026-57572(인증 없는 RCE, 0.9.0 이전)와 CVE-2026-53753(샌드박스 탈출 RCE, 0.8.7에서 수정)이 있다 [S39]. 그러나 라이브러리도 안전지대는 아니어서 0.9.3~0.9.5의 수정 일부는 라이브러리에도 적용된다 [S38]. 0.9.5에는 Chromium TLS 검증이 꺼져 있던 문제의 수정도 포함된다 [S38]. 설치본에는 `unclecode-litellm 1.81.13`, `openai`, `patchright`가 따라온다 [M20]. Docker API를 쓰지 않고 라이브러리로 쓰며 0.9.x 최신을 유지하는 것이 전제다.

## 5. 스케줄링

### 5.1 systemd 타이머 실측

실제 사용자 매니저는 건드리지 않았다. `XDG_*`를 scratchpad로 돌린 비공개 매니저를 사적 namespace와 전용 하위 cgroup에서 돌렸다. 시험 후 하위 cgroup이 제거됐고, `Linger=no`, 타이머 3개, `~/.config/systemd/user` 없음을 재확인했다 [M19]. 그 뒤 15:39:50에 다른 도구가 같은 경로에 `pixel-wt.service`(Orca worktree용, 2026-11-05 제거됨)를 만들었다. 이 시험의 산출물이 아니며 건드리지 않았다.

| 시나리오 | 결과 |
|---|---|
| A. `Persistent=true`, 스탬프 3일 전 (hourly) | 시작 +0.2초에 **1회만** 발화. 재기동해도 다시 발화하지 않음 |
| B. `Persistent=true`, 스탬프 없음 | **발화 안 함.** 스탬프만 생성. 최초 활성화에는 catch-up이 없다 |
| C. `Persistent=false`, 오래된 스탬프 | 발화 안 함 |
| D. `OnStartupSec=4s` | +4.3초 발화 |
| E. exit 75 두 번 후 성공 | 3회 시도 (0.2, 1.3, 2.5초). `ExecStopPost`가 매번 `$SERVICE_RESULT`, `$EXIT_STATUS`를 받음 |
| F. 항상 실패 + `OnFailure` (기본 RestartMode) | **`OnFailure`가 시도마다 발화.** 3회 시도에 알림 4번 |
| G. F + `RestartMode=direct` | `OnFailure` **1회**(+7.7초). `ExecStopPost`는 3회 |
| G2. `RestartSec=1 RestartSteps=3 RestartMaxDelaySec=8` | 간격 1.2, 2.2, 4.3, 8.2초. 지수 백오프 확인 |

F가 실제로 밟기 쉬운 함정이다. `RestartMode=direct`는 systemd 254 이상에서 쓸 수 있고, 이 머신은 259다 [S10].

### 5.2 WSL 유휴 종료와 catch-up

소스 커밋 `b6fea0f` 기준으로 확인했다.

1. `wsl.exe` 등 호출 프로세스가 수명 관리자에 클라이언트로 등록된다 [S02].
2. 등록된 프로세스가 없으면 `instanceIdleTimeout`(기본 15초) 뒤 인스턴스를 멈춘다 [S01][S02][S04].
3. init은 Plan9 서버를 멈춘 뒤 `systemctl poweroff`를 실행한다. 사용 중인 파일이 있으면 멈추지 않는다 [S03].
4. 모든 distro가 멈추면 `vmIdleTimeout`(기본 60초) 뒤 VM이 내려간다 [S01][S02].

여기서 나오는 결론은 **유휴 판정에 systemd 서비스가 들어가지 않는다**는 것이다. 사용자 보고도 일치한다 [S05][S07]. 이슈 #13416은 2026-10 시점에도 열려 있고 유지관리자의 공식 입장은 없다 [S05].

따라서 다음이 성립한다.

- 타이머는 distro가 살아 있을 때만 발화한다.
- 부팅 직후 catch-up이 시작돼도 클라이언트가 없으면 약 15초 뒤 poweroff로 끊긴다. **이 동작은 소스 분석 결과이며 실측하지 않았다.** 측정하려면 현재 세션을 죽여야 한다.
- dlt는 kill에 안전하므로 끊겨도 데이터는 깨지지 않는다 [M5]. 그러나 다음 부팅까지 수집이 멈춘다.
- 전체 소스가 동시에 catch-up하면 부하가 몰린다. `RandomizedDelaySec=`는 catch-up에도 적용된다 [S09].

### 5.3 linger

`loginctl enable-linger`는 "부팅 시 사용자 매니저를 띄우고 로그아웃 뒤에도 유지"한다 [S11]. WSL에서는 효과가 제한적으로 보인다. `wsl.exe` 실행 시 init이 그 사용자의 로그인 세션을 만들기 때문이다 [S03]. 이 머신도 `Linger=no`인데 사용자 매니저가 떠 있다 [M0]. 즉 어차피 부팅을 일으킨 `wsl.exe`가 세션을 만든다.

다만 linger 없이 부팅 경로에서 사용자 타이머가 catch-up하는지는 **실제 재시작으로 확인하지 못했다**. 다른 사용자(root 등)로 부팅이 일어나면 동작이 다를 수 있다. linger를 켜도 비용이 거의 없으므로 켜는 것이 안전한 쪽이나, 이는 설정 변경이라 이번에 수행하지 않았다.

### 5.4 distro를 깨우고 유지하는 방법

모두 Windows 측 또는 전역 설정 변경이라 이번에 시험하지 않았다. 사용자 승인이 필요하다.

| 방법 | 내용 | 근거 수준 |
|---|---|---|
| (a) 작업 스케줄러가 작업을 직접 실행 | `wsl.exe -d Ubuntu -u sagae -- <수집 스크립트>`. 스크립트가 끝날 때까지 클라이언트 유지. `StartWhenAvailable=true` | 소스상 정합. WSL 소스 주석에 scheduled task 사례 언급 [S02]. 미실측 |
| (b) `instanceIdleTimeout=-1` + `vmIdleTimeout=-1` | 유휴 종료 해제. 로그온 시 1회 기동 필요 | 공식 문서에 설정 존재 [S01]. 효과 보고는 엇갈림: "appears to solve"(2026-07) [S06], "didn't work for me"(2026-04) [S07] |
| (c) 상주 클라이언트 | 작업 스케줄러로 `wsl -d <distro> -e sleep infinity` | 사용자 보고 [S05] |

(a)는 VM을 작업 시간에만 쓰고 놓친 실행까지 처리하지만 systemd 타이머의 역할과 겹친다. (b)와 (c)는 systemd 타이머를 그대로 쓸 수 있지만 VM이 상주한다.

### 5.5 사망 감지

머신이 꺼진 경우까지 감지하려면 감시자가 머신 밖에 있어야 한다.

| 후보 | 조건 | 비고 |
|---|---|---|
| healthchecks.io | 무료 20 jobs, job당 로그 100건 [S13] | `/start`, `/fail`, `/{exit-status}`, `rid`, 100KB 본문. 체크당 분당 5회 이하 권고 [S14] |
| healthchecks 자체 호스팅 | v5.0.3 / 2026-10-27, BSD-3-Clause | 머신 밖에 둘 곳이 필요 |
| Dead Man's Snitch | 무료 1개, 유료 $5/3개부터 [S15] | 소스별 감시엔 부족 |
| Uptime Kuma | 2.5.8 / 2026-10-26, MIT | 같은 PC에 두면 감시 의미 없음 |

실측 함정: `hc-ping.com`은 **존재하지 않는 UUID에도 HTTP 200 `OK (not found)`을 준다** [M19]. `curl -f`로는 오타를 잡지 못하므로 응답 본문이 `OK`인지 봐야 한다.

종단 검증에서 `ExecStopPost`의 `$EXIT_STATUS`를 핑 경로로 넘기는 패턴이 동작했다 [M19]. 시도마다 호출되므로 재시도 중의 실패도 핑으로 나간다. 재시도 끝의 최종 실패만 알리려면 핑 대신 `OnFailure`로 보내는 설계도 가능하다.

### 5.6 GitHub Actions

공식 제약 [S16][S17]:

- 최소 간격 5분. 부하 시 지연되고, 드롭될 수 있다. 정시(`:00`)를 피하라고 안내한다.
- 공개 저장소는 표준 러너 무료. 60일간 활동이 없으면 스케줄이 자동 비활성화된다.
- 비공개 저장소는 월 $12 포함(Linux 2코어 $0.006/분 기준 약 2,000분). 시간당 3분 작업이면 월 약 2,160분으로 넘는다.
- 시간대 지정이 가능하다.

실측한 공개 저장소의 스케줄 지연이다 [M22].

| 저장소 / cron | 표본 | p50 | p90 | 최대 |
|---|---|---|---|---|
| yt-dlp `23 23 * * *` | 47 | 6.1분 | 8.9분 | 46.9분 |
| yt-dlp `22 22 * * *` | 46 | 7.5분 | 10.5분 | 55.4분 |
| astral-sh/uv `0 0 * * *` | 100 | 36.0분 | 42.8분 | 182.1분 |
| actions/runner-images `0 12 * * 1` | 50 | 7.3분 | 80.8분 | 120.6분 |
| actions/runner-images `32 4 * * 0` | 50 | 33.6분 | 87.8분 | 102.9분 |

p50이 가장 큰 것은 UTC 0시 정각 cron이었지만, 정각이 아닌 `32 4 * * 0`도 p50이 33.6분이어서 정각 회피만으로 지연이 사라지지는 않는다. 표본 기간에 yt-dlp와 uv의 일일 실행은 빠진 날이 없었다. 공개 저장소 5개 워크플로우의 표본이므로 일반화에는 한계가 있다. dlt 문서는 `dlt deploy <스크립트> github-action --schedule "*/30 * * * *"`로 배포하는 경로를 제공한다 [S23].

저장소 설계 시 주의점도 있다. 로컬 DuckDB 파일은 러너에 없다. dlt의 커서는 목적지 DB에서 복구되므로 [M15], 러너는 DB가 아닌 원본(NDJSON, WARC)만 저장소로 보내고, 로컬이 깨어날 때 같은 자연키로 `merge`하는 방식이 맞다. 이 경로는 부품별로만 시험했고 전체로는 돌리지 않았다. 러너 IP에서 suggestqueries나 YouTube가 응답하는지도 미확인이다.

## 6. 링크 사망 대비

### 6.1 후보표

| 도구 | 최신 / 릴리스 | 유지보수 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|
| warcio | 1.8.2 / 2026-10-28 | 활발 | Apache-2.0 | 높음. 파이썬 라이브러리, HTTP 응답 그대로 보존 | JS 렌더링 결과는 담지 못함 |
| wacz | 0.6.0 / 2026-09-10 | 활발 | Apache-2.0 | 높음. WARC를 패키징 | 없음 |
| SingleFile CLI | v2.21.0 / 2026-10-28 | 활발 | AGPL-3.0 | 중간. 사람이 볼 단일 HTML 생성 | Chrome 필요 [M21] |
| ArchiveBox | 0.9.77 / 2026-10-27 | 매우 활발. Python API는 BETA, REST API는 ALPHA [S44] | MIT | 낮음. 페이지당 비용이 큼 | 첫 실행 785MB 자동 설치, 페이지당 105.8MB [M21] |
| Browsertrix Crawler | 1.15.2 / 2026-10-29 | 활발 | AGPL-3.0 | 낮음 | 단일 Docker 컨테이너용 설계 [S47]. **Docker 없음** |
| Wayback SPN2 | 서비스 | 운영 중 | 해당 없음 | 보조 사본으로 적합 | 인증 없이 429 받음(아래) |

### 6.2 실측

| 방식 | 대상 | 시간 | 저장 크기 | 비고 |
|---|---|---|---|---|
| warcio | 2개 URL, 복호화 1,521,279바이트 | 0.98초 | 242,857바이트 | 전송 압축 그대로 저장 |
| warcio + wacz | 위와 동일 | 추가 시간 미측정 | 244,504바이트 | |
| SingleFile CLI | blog.youtube 1개 | 21.3초 | 591,508바이트 | 헤드리스 Chromium |
| ArchiveBox 기본 플러그인 | IANA 안내 페이지 1개 | 112초 | **105.8MB** | YTDLP, GIT 끈 상태. 로그상 메모리 증가 2.5GB |

**무결성.** `ArchiveIterator(check_digests="raise")`로 원본은 4개 레코드가 통과했고, 페이로드 1바이트를 뒤집은 파일은 `block digest failed`로 탐지됐다 [M21]. 첫 변조 시험은 대상 위치를 찾지 못해 바이트를 바꾸지 못한 무효 시험이었고, 수정해서 다시 측정한 결과다.

**ArchiveBox.** 첫 실행에서 Node(204MB), Puppeteer Chromium(403MB), 캐시(142MB)를 `~/.config/abx`에 스스로 설치했다. 큰 파일은 SingleFile 19MB, `responses/index.jsonl` 18.9MB, 폰트 원본(9.4MB 파일 여러 개), WACZ 8.7MB였고, 같은 콘텐츠가 여러 형식으로 저장된다. 측정 대상 페이지에 대용량 폰트가 있었으므로 일반값으로 보면 안 된다. 표본은 1페이지뿐이다.

### 6.3 Wayback SPN2

공식 문서의 제한은 다음과 같다 [S45].

| 항목 | 익명 | 인증(S3 키) |
|---|---|---|
| 분당 캡처 | 3 | 7 |
| 일일 캡처 | 200 | 30,000 |
| 일일 용량 | 문서 내 표기 불일치 (500MB, 2GB) | 5GB |

URL당 일일 5회, 페이지 캡처 50초, 전체 2분 제한도 있다. 파라미터로 `if_not_archived_within`, `capture_all`, `capture_outlinks`가 있다.

읽기 API는 정상이다. Availability API와 CDX(0.59초)가 응답했다 [M21]. 익명 저장 시험은 `https://example.com/` 1회만 했고 **즉시 429**였다. example.com은 많이 저장되는 URL이어서 URL당 일일 5회 제한에 걸렸을 수 있으므로, 이 결과로 익명 저장이 막혔다고 결론 낼 수 없다. 429를 받은 뒤 재시도하지 않았다.

SPN은 로컬 WARC를 대체하지 않는다. 제3자 서비스이고 대상 사이트가 막을 수도 있다. 머신이 모두 사라질 때를 대비한 머신 밖 사본으로 쓰는 것이 적절하다.

## 7. 재시도·DLQ·멱등성·증분·드리프트 범위

기존 도구로 어디까지 되는지 정리했다.

| 패턴 | 도구가 제공 | 실측 결과 | 직접 만들 것 |
|---|---|---|---|
| HTTP 재시도 | dlt `requests` 헬퍼 | 503 3회 성공 3.01초, 429 `Retry-After` 준수, 404 즉시 실패, 500 5회 15초 [M7] | 없음 |
| 작업 재시도 | systemd `Restart`, `RestartSteps` | 지수 백오프 동작 [M19] | 없음 |
| 적재 재개 | dlt 패키지 재개 | 커밋 직후 kill도 재실행 안 함 [M5] | 없음 |
| 멱등성 | dlt `merge` + 기본키 | 어떤 kill 지점에서도 중복 0 [M5] | 결정적 키 설계 |
| 증분 | `dlt.sources.incremental`. `end_value`로 상태 없는 backfill [S20] | 커서 동작, 디렉터리 삭제 후 복구 [M15] | 없음 |
| 조건부 GET | 없음. `resource_state()`에 저장 가능 | GitHub atom 304 [M4] | 약 5줄 |
| 변경 이력 | `scd2` 전략 | 이름 변경과 소멸 이력 보존 [M16] | 없음 |
| 드리프트 탐지 | `load_info.load_packages[*].schema_update` | 새 컬럼, 변형 컬럼 포착 [M6] | 알림 연결 |
| 드리프트 차단 | `schema_contract` | 동작하나 부작용 큼 [M6][M9] | 복구 절차 |
| DLQ | **없음** | `dlt.mark` 조합으로 구현 가능 [M10] | 약 5줄 |
| 값 품질 저하 | **없음** | HTML 구조 변경은 스키마가 안 바뀌어 탐지 불가 | 행 수·null 비율 검사 |
| 실패 알림 | systemd `OnFailure` | `RestartMode=direct`로 1회 [M19] | 알림 대상 연결 |
| 사망 감지 | healthchecks.io | 핑 패턴 검증(로컬 목 서버) [M19] | 없음 |

### 7.1 스키마 계약 모드별 결과 [M6]

입력은 base → 새 컬럼 → 타입 변경 → 컬럼 누락 → 중첩 추가 순서의 5단계다. 모드 정의는 공식 문서에 있다 [S19].

| 설정 | 남은 id | 결과 |
|---|---|---|
| `evolve` (기본) | 1,2,3,4,5 | 컬럼 자동 추가, 타입 충돌은 `n__v_text` 변형 컬럼 |
| `columns: freeze` | 1 | 2단계에서 실패, **이후 전부 같은 `load_id`로 재실패** |
| `columns: discard_row` | 1,3,4 | id 2, 5가 **기록 없이 사라짐** |
| `columns: discard_value` | 1,2,3,4,5 | 값이 **기록 없이 사라짐** |
| `data_type: freeze` | 1,2 | 3단계에서 실패, 이후 전부 재실패 |

이 저장소의 "데이터가 죽지 않는다" 원칙에는 `evolve`와 `schema_update` 감시 조합이 맞다. `discard_*`는 소리 없이 데이터를 버린다.

dlt 1.22부터 `data_type` 계약은 정밀도, 스케일, nullable, 시간대 변경에도 적용된다 [S56].

### 7.2 알아야 할 dlt 동작

- **리소스 하나의 실패가 소스 전체를 멈춘다.** `good`과 `bad`를 한 소스로 돌리면 `good` 테이블도 생기지 않는다. 리소스별로 `run`하면 격리된다 [M8]. 소스별 파이프라인으로 나눠야 한다.
- **pending 패키지가 있으면 새 데이터를 추출하지 않는다.** 문서에도 있고 [S18] 실측에서도 같은 경고가 나왔다 [M5]. 크래시 다음 실행은 pending만 처리하고 끝나므로 신규 수집은 한 번 더 돌아야 한다.
- **poison 패키지는 무관한 리소스까지 막는다** [M9]. 복구는 `dlt pipeline <이름> abort-packages`다 [S18]. `drop_pending_packages`는 1.30에서 폐기 예정이다 [M9].
- **abort는 커서를 되돌린다.** `last_value`가 2에서 1로 돌아갔고, 소스가 다시 주는 한 id 2는 유실되지 않았다 [M9].
- **`with_table_name`은 리소스의 기본키를 상속한다.** DLQ 행에 `id`가 없으면 `UnboundColumnException`이 난다. `make_hints(primary_key=[], merge_key=[])`와 `create_table_variant=True`로 해결된다 [M10].
- **임시 저장소에서는 pending이 사라진다.** 실행 메시지가 CI 러너 등을 직접 언급한다 [M9].
- **`pipelines_dir` 기본값은 `~/.dlt/pipelines`다** (설치본 `get_dlt_pipelines_dir`). 운영 경로를 명시해야 한다. 텔레메트리도 기본 수집이다 [S21].
- 읽기 연결로 실패하면 extract 전에 멈춘다. pending이 남지 않으므로 다음 실행에서 소스를 다시 읽는다 [M11].

### 7.3 DuckDB 제약

| 상황 | 결과 [M11] |
|---|---|
| A 쓰기 연결 중 B가 read_only 접속 | **차단** (`Could not set lock on file`) |
| A 읽기 연결 중 B가 쓰기 접속 | **차단** |
| A 읽기 연결 중 B가 read_only 접속 | 가능 |
| 읽기 연결이 열린 상태에서 dlt 적재 | **실패** (`DestinationConnectionError`) |

이 저장소의 목적이 다른 세션에 정보를 돌려주는 것이므로 그대로 쓰면 충돌한다. 시험한 해결책은 두 가지다.

- **파일 교체 게시** [M17]: 적재 DB를 복사해 `os.replace`로 서빙 파일을 교체했다. 기존 읽기 연결은 옛 값을 일관되게 보고, 새 연결은 새 값을 본다. 적재와 충돌하지 않는다. 대가는 복사 비용과 게시 지연이다.
- **SQLite WAL** [M13]: 쓰기 트랜잭션 중에도 다른 연결이 읽었다. dlt `sqlalchemy` 목적지로 `merge`가 동작한다. 단 `upsert` 전략은 미지원이고 `delete-insert`, `scd2`만 된다.

`dlt[ducklake]` extra도 존재하지만 미측정이다. 저장소 선택은 다른 조사의 범위이므로 여기서는 제약만 기록한다.

**DuckDB 2.0.** 2026-10-21에 나왔고 dlt는 `duckdb<2`로 묶여 있다 [M12]. 호환 PR #4600과 이슈 #4595가 열려 있다 [S24]. 현재 위험은 다음과 같다.

- dbt-duckdb는 2.0.0을 설치한다. dlt 환경은 1.5.6이다.
- 1.5.6으로 만든 파일을 2.0이 쓴 뒤 1.5.6으로 다시 읽는 것은 됐다.
- **2.0이 새로 만든 파일은 1.5.6이 열지 못한다** (`version number 69, ... between 64 and 68`).
- Python API의 `Relation.fetchone()`이 제거됐다.

dbt와 같은 파일을 공유한다면 dbt 환경에도 `duckdb<2`를 고정해야 한다.

## 8. 결정적 수집기와 LLM 추출의 분리

### 8.1 구조

수집은 LLM이 없어도 끝까지 돌아야 한다. LLM이 멈추거나 사용 한도가 차도 원본은 계속 쌓여야 한다. 그래서 층을 나누고 흐름을 한 방향으로 둔다.

```
L0 결정적 수집 (LLM 비용 0, 타이머)
   fetch → 원본 불변 저장(WARC/NDJSON) → dlt merge → 문서 테이블 + content_sha256
L1 결정적 추출 (LLM 비용 0, L0과 같은 실행)
   feedparser, Trafilatura, yt-dlp JSON, VTT 파싱 → 구조화 필드
   본문이 짧으면 브라우저 큐로 분기
L2 LLM 추출 (비용 있음, 별도 타이머, 지연 허용)
   큐에서 꺼냄 → 스키마 강제 출력 → 출처 위치를 붙여 저장
```

이 구조는 메달리온 구조와 같은 발상이다. bronze는 원본을 그대로 두고, 후속 층은 언제든 bronze에서 재구축할 수 있다 [S52]. 이 재구축 성질은 실측했다. 네트워크를 끊고 WARC만으로 DB를 다시 만들어 지문 `4aa2695b…`가 일치했다 [M14].

### 8.2 분리 규칙

| 규칙 | 이유 |
|---|---|
| L0과 L2는 서로 다른 프로세스, 다른 타이머로 돈다 | 한쪽 실패가 다른 쪽을 막지 않게 한다. L2 없이도 사망 감지가 통과해야 한다 |
| L2 입력은 항상 L0의 저장본이다. 네트워크에 직접 가지 않는다 | 재현 가능하고, 링크가 죽어도 재처리할 수 있다 |
| L2의 캐시 키는 `(content_sha256, extractor_id, prompt_version, schema_version, model)`이다 | 같은 입력을 두 번 처리하지 않는다. 프롬프트를 바꾸면 새 키로 재처리된다 |
| L2 결과는 별도 테이블에 추가만 한다 | 판단 층이 원본과 사실 층을 덮어쓰지 않게 한다 |
| 모든 L2 결과에 `warc_record_id`, `payload_digest`, 문자 위치를 붙인다 | 지침 5의 "출처가 붙은 사실" 요건이다. 행→WARC 연결은 실측했다 [M14] |
| 수집 콘텐츠는 신뢰할 수 없는 입력이다 | 웹 페이지의 문구가 프롬프트 주입이 될 수 있다. L2는 도구 없이, 격리된 디렉터리에서 돌린다 |

### 8.3 기존 도구로 대체할 수 있는 부분

지침 2에 따라 큐와 추출기를 직접 만들기 전에 검토할 대상이다. 둘 다 이번에 실행하지 않았다.

| 도구 | 현황 | 해당 부분 |
|---|---|---|
| CocoIndex | 1.0.26 / 2026-10-22, Apache-2.0 | 입력 해시와 코드 해시로 재처리를 건너뛴다 [S54]. README의 다이어그램 설명에 "eight always-on subsystems"가 있어 상주 필요 여부를 확인해야 한다 |
| LangExtract | v1.7.1 / 2026-10-08, Apache-2.0 | 추출값을 원문의 문자 범위에 연결한다. Ollama로 로컬 모델 사용 가능. Google 공식 지원 제품은 아니다 [S53] |

### 8.4 Claude Code를 L2로 쓸 때의 사실

이 환경에는 API 키가 없고 Claude Code 로그인만 있다.

- `claude -p --output-format json --json-schema '<스키마>'`로 구조화 출력을 받는다. 결과는 `structured_output` 필드이고, 없을 수 있으므로 반드시 존재를 확인해야 한다 [S48].
- 비용 필드 `total_cost_usd`는 클라이언트 추정치다 [S48].
- **`--bare`는 구독 로그인을 쓰지 않고 `ANTHROPIC_API_KEY`가 필요하다. 그리고 문서는 `--bare`가 향후 `-p`의 기본값이 된다고 밝힌다** [S48]. 이 환경에서는 그 시점에 L2가 깨질 수 있으므로 릴리스 노트를 감시해야 한다.
- 비대화형 실행은 Manual 모드로 시작해 승인이 필요한 호출은 거부된다. 무인 실행에는 `--permission-prompts none`이 있다 [S48].
- 플랜 로그인 상태의 `claude -p`는 구독 한도에서 차감된다. 2026-06-15로 예고됐던 변경은 "paused"이며 페이지에 "For now, nothing has changed"라고 적혀 있다 [S50]. 제3자 글은 시행 여부가 서로 엇갈리므로 공식 페이지를 기준으로 삼았다.
- 클라우드 예약 작업은 PC가 꺼져도 돈다. 리서치 프리뷰이고, 구독 사용량을 쓰며, 시간당 1회보다 잦은 cron은 거부되고, 매 실행마다 저장소를 clone한다 [S49]. L2나 머신 밖 수집의 후보이지만 미측정이다.

L2 호출은 이번에 실행하지 않았다. 사용자의 사용량을 쓰는 데다 분리 구조 검증에는 필요 없었기 때문이다.

## 9. 실측 기록

공통: `source scratchpad/env.sh`, 도구별 `HOME`을 scratchpad로 격리, 텔레메트리 끄는 환경변수 지정(효과는 미검증). `/tmp`가 공유 tmpfs이고 다른 작업이 동시에 돌았으므로 시간 값에는 경합이 포함된다.

**M0 환경**
```
wsl.exe --version; loginctl show-user sagae; journalctl --list-boots
cat /mnt/c/Users/user/.wslconfig; systemctl --user list-timers --all; findmnt -T /tmp
```

**M1 설치 크기** `uv venv --python 3.13 V; uv pip install ...; du -sm V` (Python 3.13). 설치 시간은 공유 캐시 때문에 의미가 없어 뺐다.

| 스펙 | 패키지 | MB |
|---|---|---|
| `dlt[duckdb,sqlalchemy] feedparser` | 45 | 118 |
| `dagster dagster-webserver dagster-dlt dlt[duckdb]` | 89 | 229 |
| `prefect dlt[duckdb]` | 121 | 228 |
| `apache-hamilton dlt[duckdb]` | 44 | 200 |
| `sqlmesh[duckdb]` | 58 | 259 |
| `dbt-core dbt-duckdb` | 59 | 330 |
| `apache-airflow==3.3.2` (공식 constraints) | 128 | 191 |
| `trafilatura` | 18 | 61 |
| `warcio wacz requests` | 53 | 40 |
| `yt-dlp[default]` | 11 | 29 |
| `crawl4ai` | 95 | 679 |
| `playwright` + Chromium 403 + 헤드리스 셸 273 + ffmpeg 6 | 4 | 140+682 |
| `archivebox` + 첫 실행 785 | 108 | 271+785 |
| `docling-slim[format-html,format-pdf-docling,format-office]` | 53 | 240 |
| 위 + `models-onnxruntime` | 57 | 577 |
| Kestra JAR 125 + Temurin JRE 25 192 | - | 317 |

**M2 1회성 비용** `python oneshot.py <cmd>` (`RUSAGE_CHILDREN`으로 wall, CPU, 최대 RSS 측정). 대상 명령: `python kb_collect.py`, `dagster asset materialize -f dagster_defs.py --select kb_collect`, `python prefect_flow.py`, `python hamilton_run.py`. 결과는 §3.2. Dagster 자산에는 `RetryPolicy`, Prefect 태스크에는 `retries`를 지정했다.

**M3 유휴 메모리** `setsid <서버>`로 기동 후 프로세스 트리의 PSS 합을 5초마다 샘플링. 결과는 §3.3.
```
dagster dev -f dagster_defs.py -p 13000 -h 127.0.0.1
dagster-daemon run -f dagster_defs.py
prefect server start --host 127.0.0.1 --port 14200
PATH=venv/bin:$PATH AIRFLOW__CORE__LOAD_EXAMPLES=False airflow standalone
kestra-2.0.7 server local --port 18090 --config kestra-min.yml   # kestra.tutorial-flows.enabled: false
```
무효 처리한 값: Airflow 153MB(PATH 누락으로 자식 기동 실패), Kestra Java 21(`Unrecognized option: --sun-misc-unsafe-memory-access=allow`), Kestra 975MB·718MB(ENOSPC와 가드 종료로 도중 사망). Kestra 기본 설정의 튜토리얼 플로우가 플러그인 자동 설치를 유발해 `work`가 292MB까지 커졌다. 끄면 3MB다.

**M4 최소 파이프라인** dlt + feedparser + DuckDB. 부록 A.

| 실행 | 초 | RSS MB | 행 | 비고 |
|---|---|---|---|---|
| 1회차 | 3.77 | 169.3 | feed 50, pypi 2,551, suggest 30 | 패키지 1 |
| 2회차 | 1.52 | 158.8 | 정규화 후 merge | GitHub atom 2개 304. 중복 키 0 |

피드 창: GitHub `releases.atom` 10건씩, HN RSS 30건.

**M5 크래시**

| 시험 | kill 지점 | 재실행 후 |
|---|---|---|
| A | extract 직후 SIGKILL | 정상 완료, `_dlt_loads` 1, 중복 0 |
| B | normalize 직후 SIGKILL | pending만 적재(0.34초), 새 데이터 미추출 경고 |
| C | 무작위 SIGKILL 14회 (400k행) | 400,000/400,000. **단 kill이 전부 load 전이었을 가능성이 커서 load 안전성의 근거로 쓰지 않는다** |
| D | load 중 무작위 SIGKILL (600k행, 41잡, 4워커) | append 1회, merge 4회 kill. 둘 다 600,000행, 중복 0, 유실 0. 표본 적음 |
| E | `complete_job` 직전 (커밋 후) | 커밋 확인됨(kill 시점 1000행). resume 후 append도 1000/1000. pending transition marker 덕분 [S25] |
| F | `save_pending_transition` 직전 (커밋과 marker 사이) | **append 2000행/1000 고유.** merge 1000/1000 |

E, F는 `PackageStorage` 메서드를 패치해 정확히 그 지점에서 `os.kill(SIGKILL)` 했다. F의 창은 커밋과 marker 기록 사이의 극히 짧은 구간이다. D에서 재현되지 않은 이유이기도 하다.

**M6 드리프트** 결과는 §7.1. `load_info.load_packages[*].schema_update`에 `extra`, `n__v_text`, `meta__k`가 잡혔다.

**M7 재시도** 로컬 HTTP 서버, `dlt.sources.helpers.requests`.

| 경로 | 시도 | 초 | 결과 |
|---|---|---|---|
| 503 두 번 후 200 | 3 | 3.01 | 200 |
| 429 `Retry-After: 2` 후 200 | 2 | 2.00 | 200 |
| 404 | 1 | 0.00 | HTTPError |
| 항상 500 | 5 | 15.01 | HTTPError |

**M8 부분 실패** 한 소스에 `good`, `bad`(예외 발생): `PipelineStepFailed(step=extract)`, `good` 없음. 리소스별 `run`: `good` 5행 적재, `bad`만 실패.

**M9 poison** `columns: freeze` 위반 후 `has_pending_data=True`. 무관한 리소스 실행도 `NormalizeJobFailed`, 테이블 없음. `drop_pending_packages()`(폐기 예정 경고, 대체 `abort_packages`) 후 `last_value` 2→1. 전체 창을 다시 주자 id 1,2,3. 오류 메시지에 임시 저장소에서는 pending이 유실된다는 안내가 있다.

**M10 DLQ** 부록 A. `make_hints` 방식: items [1,4], `_dlq` 2행(`int_parsing`, `missing`). 별도 리소스 방식은 지연 평가 때문에 `_dlq`가 비어 실패했다. `p.run([info.asdict()], table_name="_load_info")`로 적재 정보 저장 확인.

**M11 락** 두 프로세스로 §7.3 조합 시험. dlt 실패 후 `has_pending_data=False`, 스키마 미생성.

**M12 DuckDB 버전** venv별 `duckdb.__version__`: dlt, sqlmesh, dagster, prefect, hamilton 1.5.6, dbt 2.0.0. 2.0 생성 파일의 `storage_version`은 `v2.0.0+`, 1.5.6 생성 파일을 2.0이 연 경우는 `v1.0.0+`.

**M13 SQLite** `dlt.destinations.sqlalchemy("sqlite:///x")`. SQLite 3.53.1. `upsert` 지정 시 `DestinationCapabilitiesException`. `merge` 기본값으로 값 갱신 확인. WAL에서 `BEGIN IMMEDIATE` 중 읽기 성공.

**M14 원본 우선** `capture_http`로 GitHub atom 2개(514,153바이트)를 WARC 66,639바이트로 저장하고, WARC에서 파싱해 dlt 적재(20행, `warc_record_id` 2종). 프록시를 닫힌 포트로 지정해 네트워크를 차단하고 재구축한 결과 지문 동일.

**M15 상태 복구** 5행 적재 후 `pipelines_dir/<이름>` 삭제 → 8행 소스로 재실행 → `start_value=5`, 8행/8 고유.

**M16 SCD2** `{"disposition":"merge","strategy":"scd2"}`. a(first) 닫힘, a(renamed) 소멸 시 닫힘, b 현행.

**M17 게시** 위 §7.3. 기존 읽기 연결 v=1 유지, 새 연결 v=2.

**M18 변환** `dbt run` 모델 1개 0.18초. `sqlmesh plan --auto-apply` wall 1.95초 CPU 3.23초 RSS 201MB, `sqlmesh run` 1.74초. DB 파일명이 `sqlmesh.duckdb`면 카탈로그명이 상태 스키마와 겹쳐 `Ambiguous reference` 오류.

**M19 systemd** 부록 B. 종단 시험 결과:

| 경로 | 관측 |
|---|---|
| 성공 | 스탬프 5일 전 → 시작 즉시 타이머 발화 → dlt 4.01초, 167MB → 핑 `/0?result=success` (+4.9초) → 2,631행, 중복 0 |
| 실패 | DNS 실패 → dlt 재시도 15초 → exit 1 → 백오프하며 3회 시도 → `/alert/kb-collect.service` 1회 (+62.8초) |

실패 경로의 DNS 장애는 의도한 것이 아니다. 사적 namespace에서 `/mnt`를 덮으면서 `/etc/resolv.conf`(→`/mnt/wsl/resolv.conf`)가 가려졌다. 원인을 찾아 `/srv`로 옮긴 뒤 성공 경로를 얻었다. 비공개 매니저에서는 `MemoryPeak=[not set]`이어서 `MemoryMax=`의 실효는 **미검증**이다. `hc-ping.com`은 전부 0인 UUID로 1회 요청했다.

**M20 크롤러**
```
trafilatura.extract(html, output_format="markdown", with_metadata=True)
AsyncWebCrawler(BrowserConfig(headless=True)).arun(url, CrawlerRunConfig(cache_mode=BYPASS))
playwright: chromium.launch(headless=True), goto + networkidle 8초
yt-dlp --no-config --js-runtimes node --skip-download --dump-json <url>
```
Chromium 156.0.8078.4는 `libnspr4`, `libnss3`, `libnssutil3`, `libasound`가 없어 exit 127로 실패했다. `sudo` 없이 `apt-get download`와 `dpkg -x`로 scratchpad에 풀고 `LD_LIBRARY_PATH`로 해결했다. YouTube 소개 페이지 렌더링은 HTML 2.97MB, 텍스트 5,127자, 4.07초.

**M21 보존과 Docling**
```
capture_http(out); ArchiveIterator(f, check_digests="raise")
wacz create -o t.wacz --detect-pages t.warc.gz
single-file <url> out.html --browser-executable-path=<chrome> --browser-headless=true
archivebox add --depth=0 'https://www.iana.org/help/example-domains'
curl 'https://web.archive.org/save/https://example.com/'    # 1회, 429
```
ArchiveBox 앞선 두 번의 시도는 ENOSPC와 가드 종료로 실패했고, 세 번째 `rc=0`은 같은 URL이라 산출물이 없었다. 새 컬렉션과 새 URL로 실제 산출물을 확인한 네 번째 값만 썼다. Docling: `docling-slim`에서 HTML 변환 성공. PDF는 `models-onnxruntime`를 넣어도 `No module named 'torch'`. 전체 설치는 tmpfs에 들어가지 않아 **PDF 변환과 GPU 성능은 미측정**이다. CPU용 전체 설치는 torch 2.15.0+cpu, docling-ibm-models 4.0.4 등을 해석했다(dry-run).

**M22 GitHub Actions 지연** `gh api repos/<r>/actions/runs?event=schedule&per_page=100`의 `created_at`과 cron 시각의 차이. 단순 cron만 계산했다.

**M23 YouTube RSS** `curl -o /dev/null -w '%{http_code}' 'https://www.youtube.com/feeds/videos.xml?channel_id=...'` 06:18Z, 06:45Z, 06:59Z 전부 404.

## 10. 미확인 사항

1. WSL 유휴 종료가 실제 작업을 몇 초에 끊는지. 소스 분석만 했다. 측정하려면 현재 세션을 죽여야 한다.
2. linger 없이 `wsl.exe` 부팅 경로에서 사용자 타이머가 catch-up하는지.
3. `instanceIdleTimeout=-1`이 클라이언트 없이 distro를 유지하는지. 보고가 엇갈린다.
4. 작업 스케줄러의 "로그온 여부와 무관하게 실행" 모드에서 `wsl.exe` 동작.
5. Windows 절전 복귀 시 VM과 타이머의 동작. https://github.com/microsoft/WSL/issues/8763 은 제목만 확인했다. `WakeSystem=`이 WSL에서 Windows를 깨우는지도 미확인이다.
6. YouTube 자동완성과 yt-dlp의 호출 한도. GitHub 러너 IP에서의 응답.
7. Docling PDF 변환 성능, GPU 경로.
8. Crawl4AI, Firecrawl의 추출 품질. 이번 측정은 품질 평가가 아니다.
9. 익명 SPN이 현재 동작하는지. 429 원인을 판정하지 못했다.
10. `MemoryMax=` 등 자원 제한의 실효. 사용자 매니저에서는 `cpu memory pids`만 위임된다.
11. 수천 소스 규모의 dlt 성능, 긴 시간 운영 시 WARC 증가량과 압축. 이번 표본은 2,631행이다.
12. Prefect가 서버 다운타임 후 놓친 스케줄을 어떻게 처리하는지.
13. CocoIndex의 상주 프로세스 필요 여부, LangExtract와 로컬 모델 조합.
14. 운영 설치 경로. 시스템 Python 3.14에는 ensurepip가 없고 `uv`는 scratchpad에만 있다. dlt의 3.14 지원은 실험적이다 [S22].

## 부록 A. 재현 코드 핵심

증분과 조건부 GET. 커서와 ETag가 패키지 상태에 함께 묶인다.

```python
@dlt.resource(name="feed_entries", write_disposition="merge", primary_key="entry_id")
def feed_entries(published=dlt.sources.incremental("published_at", initial_value="1970-01-01T00:00:00+00:00")):
    st = dlt.current.resource_state().setdefault("etags", {})
    for name, url in FEEDS.items():
        hdr = {"If-None-Match": st[name]} if st.get(name) else {}
        r = rq.get(url, headers=hdr, timeout=30)          # dlt.sources.helpers.requests
        if r.status_code == 304: continue
        r.raise_for_status()
        if r.headers.get("etag"): st[name] = r.headers["etag"]
        for e in feedparser.parse(r.content).entries:
            ...  # yield {"entry_id":..., "feed":..., "published_at": iso}
```

DLQ. `with_table_name`은 기본키를 상속하므로 이 형태로 써야 한다.

```python
try:
    yield Row(**r).model_dump()
except ValidationError as e:
    yield dlt.mark.with_hints(
        {"payload": json.dumps(r, ensure_ascii=False), "error": e.errors()[0]["type"], "source": "items"},
        dlt.mark.make_hints(table_name="_dlq", write_disposition="append", primary_key=[], merge_key=[]),
        create_table_variant=True)
```

커밋과 marker 사이 결함 주입.

```python
orig = PackageStorage.save_pending_transition
def boom(self, load_id, file_name, *a, **k):
    if file_name.startswith("t."): os.kill(os.getpid(), signal.SIGKILL)
    return orig(self, load_id, file_name, *a, **k)
PackageStorage.save_pending_transition = boom
```

원본을 거쳐 적재. 각 행이 WARC 레코드를 가리킨다.

```python
with capture_http(warc):            # warcio.capture_http, requests는 이 뒤에 import
    requests.get(url, headers={"Accept-Encoding": "identity"})
for rec in ArchiveIterator(f, check_digests="raise"):
    if rec.rec_type == "response":
        h = rec.rec_headers
        for e in feedparser.parse(rec.content_stream().read()).entries:
            yield {"entry_id": e.id, "warc_record_id": h.get_header("WARC-Record-ID"),
                   "payload_digest": h.get_header("WARC-Payload-Digest")}
```

## 부록 B. 검증한 systemd 유닛 형태

`systemd-analyze --user verify`를 통과했고 비공개 매니저에서 종단 실행했다. 경로와 URL은 시험용을 일반화했다. 실제 설치는 사용자 승인 뒤의 일이다.

```ini
# kb-collect.timer
[Timer]
OnCalendar=*-*-* 00/6:00:00
Persistent=true
RandomizedDelaySec=5min      # 동시 catch-up 분산. 이 줄은 시험 시 AccuracySec=1s로 대체했다
```

```ini
# kb-collect.service
[Unit]
OnFailure=kb-alert@%n.service
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=oneshot
ExecStartPre=-/usr/bin/curl -fsS -m 5 <핑URL>/start
ExecStart=<python> kb_collect.py --db <db> --pipes <dir>
Restart=on-failure
RestartMode=direct           # 없으면 OnFailure가 시도마다 발화
RestartSec=2
RestartSteps=2
RestartMaxDelaySec=8
TimeoutStartSec=120
ExecStopPost=/bin/sh -c '/usr/bin/curl -fsS -m 5 "<핑URL>/$EXIT_STATUS"'
```

비공개 매니저 실행법. 소켓 경로가 108바이트를 넘어 namespace로 짧은 경로를 만든다. `/mnt`를 덮으면 WSL의 `resolv.conf`가 가려지므로 `/srv`를 쓴다. systemd가 같은 cgroup의 프로세스를 옮길 수 있어 전용 하위 cgroup이 필수다.

```bash
unshare --user --map-root-user --mount bash -c '
  mount --bind $R/runtime /srv
  exec unshare --user --map-user=1000 --map-group=1000 bash inner.sh'
# inner.sh
CG=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/kbexp; mkdir $CG; echo $$ > $CG/cgroup.procs
env -i HOME=$R/home XDG_RUNTIME_DIR=/srv XDG_CONFIG_HOME=$R/config XDG_DATA_HOME=$R/data \
  XDG_STATE_HOME=$R/state XDG_CACHE_HOME=$R/cache PATH=/usr/bin:/bin \
  /usr/lib/systemd/systemd --user --unit=exp.target --log-target=console &
```

## 부록 C. 출처

버전, 릴리스 날짜, 라이선스 표기는 PyPI JSON(`https://pypi.org/pypi/<패키지>/json`)과 GitHub API(`gh api repos/<저장소>`, `.../releases/latest`)로 2026-10-31에 수집했다.

| ID | 출처 | 확인일 |
|---|---|---|
| S01 | https://learn.microsoft.com/en-us/windows/wsl/wsl-config (문서 갱신 2026-10-16) | 2026-10-31 |
| S02 | https://github.com/microsoft/WSL/blob/b6fea0ff51c99f126760d3eaa86b71fdb6d2bdfa/src/windows/service/exe/LxssUserSession.cpp (L2912-2939, L3903, L4170-4210) | 2026-10-31 |
| S03 | https://github.com/microsoft/WSL/blob/b6fea0ff51c99f126760d3eaa86b71fdb6d2bdfa/src/linux/init/init.cpp (L755, L2863, L2906) | 2026-10-31 |
| S04 | https://github.com/microsoft/WSL/blob/b6fea0ff51c99f126760d3eaa86b71fdb6d2bdfa/src/windows/service/exe/Lifetime.cpp (L80) | 2026-10-31 |
| S05 | https://github.com/microsoft/WSL/issues/13416 | 2026-10-31 |
| S06 | https://github.com/microsoft/WSL/issues/9968 | 2026-10-31 |
| S07 | https://github.com/microsoft/WSL/discussions/9245 | 2026-10-31 |
| S09 | https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html | 2026-10-31 |
| S10 | https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html | 2026-10-31 |
| S11 | https://www.freedesktop.org/software/systemd/man/latest/loginctl.html | 2026-10-31 |
| S12 | https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-startwhenavailable-settingstype-element | 2026-10-31 |
| S13 | https://healthchecks.io/pricing/ | 2026-10-31 |
| S14 | https://healthchecks.io/docs/http_api/ | 2026-10-31 |
| S15 | https://deadmanssnitch.com/plans | 2026-10-31 |
| S16 | https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows | 2026-10-31 |
| S17 | https://docs.github.com/en/billing/concepts/product-billing/github-actions | 2026-10-31 |
| S18 | https://raw.githubusercontent.com/dlt-hub/dlt/devel/docs/website/docs/running-in-production/running.md | 2026-10-31 |
| S19 | https://dlthub.com/docs/general-usage/schema-contracts | 2026-10-31 |
| S20 | https://dlthub.com/docs/general-usage/incremental/cursor | 2026-10-31 |
| S21 | https://dlthub.com/docs/reference/telemetry | 2026-10-31 |
| S22 | https://raw.githubusercontent.com/dlt-hub/dlt/devel/README.md | 2026-10-31 |
| S23 | https://dlthub.com/docs/walkthroughs/deploy-a-pipeline/deploy-with-github-actions | 2026-10-31 |
| S24 | https://github.com/dlt-hub/dlt/issues/4595, https://github.com/dlt-hub/dlt/pull/4600 | 2026-10-31 |
| S25 | dlt 1.32.0 설치본 `dlt/load/load.py` L335 `resume_started_jobs`, `dlt/common/storages/load_package.py` L648 (https://github.com/dlt-hub/dlt) | 2026-10-31 |
| S26 | https://dagster.io/docs/guides/automate/schedules/troubleshooting-schedules | 2026-10-31 |
| S27 | dagster 1.13.28 설치본 `dagster/_scheduler/scheduler.py` L637-640, `dagster/_core/scheduler/scheduler.py` L263 (https://github.com/dagster-io/dagster) | 2026-10-31 |
| S28 | https://docs.prefect.io/v3/concepts/states, prefect 3.9.1 설치본 `settings/models/server/services.py` L331-370 | 2026-10-31 |
| S30 | https://airflow.apache.org/docs/apache-airflow/stable/configurations-ref.html, https://airflow.apache.org/docs/apache-airflow/stable/authoring-and-scheduling/timetable.html | 2026-10-31 |
| S31 | https://airflow.apache.org/docs/apache-airflow/stable/howto/set-up-database.html | 2026-10-31 |
| S32 | https://kestra.io/docs/installation/standalone-server | 2026-10-31 |
| S33 | https://kestra.io/docs/workflow-components/triggers/schedule-trigger, https://kestra.io/plugins/core/trigger/io.kestra.plugin.core.trigger.schedule | 2026-10-31 |
| S34 | https://kestra.io/blogs/release-2-0, https://kestra.io/docs/releases | 2026-10-31 |
| S35 | https://docs.getdbt.com/blog/dbt-core-v2-is-here | 2026-10-31 |
| S36 | https://www.businesswire.com/news/home/20260325552632/en, https://thenewstack.io/fivetran-donates-sqlmesh-lf/ | 2026-10-31 |
| S37 | https://docs.firecrawl.dev/contributing/self-host | 2026-10-31 |
| S38 | https://raw.githubusercontent.com/unclecode/crawl4ai/main/SECURITY.md | 2026-10-31 |
| S39 | https://www.ionix.io/threat-center/cve-2026-57572/, https://advisories.gitlab.com/pypi/crawl4ai/CVE-2026-53753/ | 2026-10-31 |
| S40 | https://github.com/yt-dlp/yt-dlp, https://github.com/yt-dlp/yt-dlp/issues/14404, https://github.com/yt-dlp/yt-dlp/issues/15800 | 2026-10-31 |
| S42 | https://playwright.dev/python/docs/browsers | 2026-10-31 |
| S43 | https://pypi.org/project/docling-slim | 2026-10-31 |
| S44 | https://raw.githubusercontent.com/ArchiveBox/ArchiveBox/dev/README.md | 2026-10-31 |
| S45 | https://docs.google.com/document/d/1Nsv52MvSjbLb2PCpHlat0gkzw0EvtSgpKHu4mk0MnrA/edit (`export?format=txt`로 읽음) | 2026-10-31 |
| S47 | https://raw.githubusercontent.com/webrecorder/browsertrix-crawler/main/README.md | 2026-10-31 |
| S48 | https://code.claude.com/docs/en/headless | 2026-10-31 |
| S49 | https://code.claude.com/docs/en/routines | 2026-10-31 |
| S50 | https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan | 2026-10-31 |
| S52 | https://www.databricks.com/blog/what-is-medallion-architecture, https://learn.microsoft.com/en-us/fabric/onelake/onelake-medallion-lakehouse-architecture | 2026-10-31 |
| S53 | https://raw.githubusercontent.com/google/langextract/main/README.md | 2026-10-31 |
| S54 | https://raw.githubusercontent.com/cocoindex-io/cocoindex/main/README.md | 2026-10-31 |
| S55 | https://discuss.ai.google.dev/t/youtube-rss-feed-endpoint-returns-404-errors/113379, https://feeder.co/help/rss/youtube-feeds/ | 2026-10-31 |
| S56 | https://dlthub.com/docs/release-notes/1.22 | 2026-10-31 |
