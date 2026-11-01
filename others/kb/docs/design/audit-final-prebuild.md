# 구축 시작 판정

- 날짜: 2026-10-31 회차. 실제 시각 11-01 00:50~01:15.
- 범위: 재확인의 blocker·major 해소, 계획의 의존과 소유 경로, 첫 적재 경로, 세션 자료 제외 규칙, sagae-tools 회신 응답, 파동 0 재현. 전체 재감사가 아니다.
- 대상 판(sha256 앞 16자리): ADR `d3d711b1a441e125`, 계획 `c03355630a1f193d`, 계약 `9a3f22c40c74cb63`, 응답표 `84a8dc787b25871a`, 회신 `d40b0b473938d306`, 수정 내역 `4a2335dd70d1a35a`. 감사 전후 같다.
- 성격: 시스템 설계 문서다(CLAUDE.md 지침 5의 예외).
- 표기: **[재현]** 이번에 실행한 결과, **[문서]** 문구 확인, **[추론]** 재현하지 않은 판단. `PB-nn`은 이번에 적은 결함이다.

## 0. 결론

**구축을 시작할 수 있다.** 구현 에이전트가 진행할 수 없는 결함은 없다. 다만 major 4건이 있고 PB-01은 WP-06 시작 전에 고치는 편이 싸다.

| 확인 항목 | 결과 |
|---|---|
| 1. RC-01~RC-05, FACT-02, FACT-05 | 7건 전부 해소 |
| 2. 의존과 소유 경로 | 패키지 27, 파동 11, 순환 0, 파동 위반 0, 소유 경로 223개 겹침 0 [재현] |
| 3. 첫 적재 WP-25 | 사용자 결정 불필요. 의존이 전부 앞 파동. 인수 조건이 뒤 패키지 산출물을 요구하지 않는다. 수치 조건은 PB-01에 걸린다 |
| 4. WP-26 제외 규칙 | 합성 표본 시험으로 있다. 실제 실행 결과를 보는 조건이 없다(PB-02) |
| 5. sagae-tools 회신 | 42건 전부 응답. 계약, ADR과 어긋남 0 |
| 6. WP-00, WP-22 | 인수 조건 전부 재현 통과 |
| 새 결함 | blocker 0, major 4, minor 5 |
| 사고 | 없음 |

## 1. 재확인 결함

| ID | 판정 | 근거 |
|---|---|---|
| RC-01 | 해소 | `test_dead_seed`, `test_audit_record`에 `[결정 10, 11 뒤]`. 첫 조건이 `test_batch_def.py` 지정. 결정 전 대체 `test_dead_default`. 결정 11이 없으면 4~7단계를 건너뛴다 [문서] |
| RC-02 | 해소 | ADR 6.1, 18장, 20.3. WP-00 deploy가 실행 파일 4종을 `runtime/share-<id>/`에 복사하고 래퍼가 `KB_HOME`, `KB_SHARE`, `KB_CLAUDE_BIN`을 고정한다. `test_jobs`와 입회 시험 6번이 저장소 밖 실행을 본다. 복사와 래퍼 동작 [재현] |
| RC-03 | 해소 | `node_domain` DDL, 포함 일치, 계약 `domain` 배열, 패싯과 `by_domain` 값별 집계, `queue.domain` 첫 값. 시험 3건 [문서]. DDL 삽입 [재현] |
| RC-04 | 해소 | ADR 9.2 공식 위치 규칙, `trust=unknown`이 계약 2.10에 있다. WP-08 `test_policy_items` [문서] |
| RC-05 | 해소 | WP-26, 7장 보고 행, ADR 7.8, 8장, 15.3 [문서] |
| FACT-02 | 해소 | 23.2 III.I.15, 23.1 댓글 작성자 조항, 23.3 양자택일 문구 교체, WP-24 [문서] |
| FACT-05 | 해소 | 활성과 결정 대기 소스 전부 등급 하나, 활성 `forbidden` 0, 결정 9 목록 = 등급 표 [재현] |

## 2. 기계 검사

계획 본문에서 직접 뽑았다. 작성자 스크립트를 쓰지 않았다.

| 검사 | 결과 [재현] |
|---|---|
| 파동 표, 3장 의존 표, 4장 절 | 27개로 일치. 제목과 의존 일치 |
| 위상 정렬 | 27/27. 순환 0 |
| 파동 순서 | 모든 의존이 앞 파동. 각 패키지가 최장 의존 경로와 같은 파동 |
| 소유 경로 | 223개, 고유 223개, 접두 포함 겹침 0 |
| 2.3 모듈 21개, tick 단계 표, 하위 명령 | 전부 표의 패키지 경로 안 |
| 전이 의존 밖 참조 | 전부 문장 언급, 선택 경로, 가짜로 시험하는 호출이다. WP-12의 `kb api`는 런북 문구, `kb.rank.client`는 없으면 강등, WP-17의 `kb agent`, `kb retro`는 시험에서 가짜다 |
| 2.1 골격 실행 | 가짜 런타임에서 정상, 0바이트 스냅샷 중단, 에이전트 소실, 소유 경로 밖 쓰기 경로 전부 기대대로 |
| ADR DDL | SQLite 3.53.1에서 원장 4표, gold 16표. `change` 같은 `seq` 두 행 삽입 성공 |

| 파동 | 패키지 |
|---|---|
| 0 | WP-00, WP-22 |
| 1 | WP-01, WP-16, WP-23 |
| 2 | WP-02 |
| 3 | WP-03, WP-04 |
| 4 | WP-05, WP-06, WP-13 |
| 5 | WP-07, WP-10, WP-15, WP-20 |
| 6 | WP-08, WP-11, WP-14 |
| 7 | WP-09, WP-12, WP-19, WP-25 |
| 8 | WP-17, WP-26 |
| 9 | WP-18, WP-21 |
| 10 | WP-24(결정 1 뒤) |

## 3. 첫 적재 경로

경로는 WP-00, 22, 01, 23, 02, 03, 04, 05, 06, 13, 07, 15, 08, 25다. 표시 없는 조건에 사용자 결정이 필요한 패키지가 이 경로에 없다 [문서].

| 조건 | 판정 |
|---|---|
| 의존의 파동 | WP-05(4), WP-07(5), WP-15(5), WP-08(6) → WP-25(7) |
| 파동 스냅샷 | 앞 파동까지의 코드가 들어간다. `--from-snapshot` 배포 [재현] |
| 뒤 패키지 요구 | 없다. WP-09의 `kb live`는 "WP-21 전까지"라는 설명 문장뿐이다. 없는 단계는 `absent`다 |
| 사용자 결정 | 선정 규칙이 `requires_decision=null`, `robots=enforce`다. 대상은 51개 소스(G 36, A~F 13, F 개발 2)이고 B~F 전부 소스가 있다 |
| 수치 조건 | `.counts.snapshots >= 100`, `.by_domain.G.snapshots >= 50`은 하위 페이지 수집이 있어야 성립한다(PB-01) |

## 4. 세션 자료 제외 규칙

| 대장 규칙 | 인수 조건 | 판정 |
|---|---|---|
| 제외 표 3행 | `test_ledger`, `.excluded >= 3`, `test_filters`의 본문 미개방 | 있음 |
| 세션 서술을 사실로 적재 금지 | `test_no_claim` | 있음 |
| 1차 출처 재수집 | `test_urls`, `test_put_path` | 있음 |
| 내부 주소, 호스트, 토큰 권한 | `test_filters`(합성) | 합성만 |
| 노드 이름 | `test_filters`의 차단 목록(합성) | 실제 실행에 빈틈(PB-02) |
| 행별 처리(줄 173·180, `urls_only`, `jsonl_filter`, `git show`) | 합성 표본만. `test_ledger`는 `treat` 존재만 본다 | 빈틈(PB-02) |
| 사본 삭제 | `[사용자 입회, 결정 3 뒤] purge-copy` | 있음 |

`.unresolved == 0`은 도달 가능하다. 대장 경로 28개 전부 있고 `docs-raw` 11개, `git show` 대상 존재, 사본 해시 10개 일치다 [재현]. `foundation-design.html`과 sagae-bb 전사, 제외 표 파일은 열지 않았다.

## 5. sagae-tools 회신

회신 항목 수는 13장 9, 공백 20, 요청 6, 닫음 7이고 응답표가 번호 연속으로 전부 다룬다. 합계 42, 수용 40, 변경 2(공백 7, 요청 5), 거절 0으로 머리 문장과 같다 [재현].

| 대조 | 결과 |
|---|---|
| 응답표가 인용한 계약 절 | 전부 실재 [재현] |
| 42건의 문구와 계약, ADR, 계획 | 어긋남 0 [문서]. 공백 16~20은 ADR 7.8, 7.9, 15.1, 15.2, 15.4와 WP-12 시험 5건까지 이어진다 |
| 계약 JSON 예시 21개 | 3장 스키마 대상 19개 통과, 6.1 입력·응답 2개는 대상 스키마가 없다. 파싱 오류 0 [재현] |
| `$ref`, `oneOf` 변형 | 없는 참조 0, 네 변형 맨 위 `const`와 `required` [재현] |
| 공개 ID 예시 | 2.10 패턴 위반 0 [재현] |
| `operationId` | loupe 표본 스펙 26개와 계약 표 26개 일치 [재현] |
| 파괴 변경 | 0.3.0 머리 7건 = 응답표 확인 요청 7건 |

## 6. 파동 0 재현

임시 폴더와 가짜 HOME에서 지시를 그대로 옮겨 돌렸다.

| 패키지 | 조건 | 결과 [재현] |
|---|---|---|
| WP-00 | 1 부트스트랩, `lock --check`, `dev python -V` | exit 0, 가짜 HOME 0파일, uv 0.13.6 |
| WP-00 | 2 Python과 SQLite | `(3, 14) True` |
| WP-00 | 3 `tests/boot` | 통과. perf 기본 제외, `-m perf`로 재선택 |
| WP-00 | 4 `deploy --dry-run` | exit 0, 변경 없음 |
| WP-00 | 5 임시 `KB_HOME` 실제 배포 | `/`에서 `kb doctor` 통과, `mcp`, `starlette`, `yaml`, `jsonschema`, `feedparser`, `lxml` 임포트, 설치본은 site-packages |
| WP-00 | 6 `kb doctor` | `.ok == true`, `/tmp/x`는 exit 1 + `fs_rejected` |
| WP-00 | 파동 스냅샷 배포 | exit 0 |
| WP-22 | 조건 5건 전부 | MANIFEST 26개 일치, 49, 26, 15건, 스트림 6, 금지 패턴 0줄 |

| 재현의 차이 | 내용 |
|---|---|
| 잠금 | `pypi.org/simple`이 robots Disallow라 호출하지 않았다. 로컬 uv 캐시를 휠 116개로 묶고 `--no-index --offline`, Linux x86_64 한정으로 잠갔다. 79패키지이고 핀 12개가 전부 지정값이다. 전체 플랫폼 해석은 재확인의 82패키지 결과를 잇는다. 핀은 그 뒤 바뀌지 않았다 |
| 구현 때 | WP-00의 `uv lock`은 `pypi.org/simple`을 부른다. 계획 1장은 막지 않는다. 구현 지시에 이번 감사의 robots 문구를 그대로 넣으면 WP-00이 막힌다 |
| 경로 | 실운영 `/home/user/sagae-kb-data`를 만들지 않고 임시 폴더로 바꿨다 |
| 코드 | 코어 골격만 썼다. 뒤 패키지 인수 조건은 돌리지 않았다 |

## 7. 새 결함

### 7.1 major

**PB-01. 소스 하나가 URL 여러 개를 받는 경로가 없다.**

- 위치: ADR 10.4 `fetch`, 7.11 `source_state`, `queue.kind`. WP-06 fetch 단계, WP-07 `llms_txt`, `sitemap`, `html_index`. WP-25 인수 조건.
- 내용 [문서]: `fetch`는 `url` 하나이고 `etag`, `last_sha`는 소스당 한 행이며 `queue.kind`에 페이지 수집 값이 없다. WP-07은 "네트워크에 가지 않는다"인데 하위 페이지를 받을 패키지가 정해져 있지 않다. U11(피드 3개), `src:yt-api-docs`(3개), `src:f-tools`(8개)도 한 소스에 URL이 여럿이고 U11은 `inventory_id` 중복 0 규칙 때문에 쪼갤 수 없다.
- 영향 [추론]: 등록 URL만 받으면 첫 적재는 약 60건, G는 약 40건이라 WP-25의 두 수치 조건이 실패한다. 페이지까지 받아도 C03 231쪽, C04 228쪽, C09 약 360쪽을 3초 간격으로 순서대로 받으면 40분을 넘어 `--max-runtime 30m` 안에 A~F에 닿지 못한다. 규칙 4의 `change_requests`로 WP-06을 다시 돌리면 풀리므로 blocker는 아니다. 파동 7에서 알게 되면 첫 데이터가 한 번 더 늦다.
- 수정: WP-06 시작 전에 정한다. 예: `fetch.urls`(정적)와 `fetch.discover`(`llms_txt`, `sitemap`, `html_index`)를 두고 WP-06 fetch 단계가 URL마다 `capture`를 돈다. 목록 추출은 WP-07의 순수 함수로 둔다. URL별 조건부 GET 상태를 `ops.db`에 더한다. `first-load.yaml`은 A~F를 먼저 두거나 소스당 쪽수를 제한한다.

**PB-02. WP-26에 실제 실행 결과를 보는 제외 조건이 없다.**

- 위치: WP-26 인수 조건, `intake-deny.txt`, `test_ledger`.
- 내용 [재현]: `sagae-claude-plugins/README.md`(`treat=full`)에 Proxmox 노드 이름이 든 줄이 1개 있고 지시의 제거 규칙에 걸리지 않는다. 노드 이름은 `$KB_CONFIG_DIR/intake-deny.txt`로만 빠지는데 이 파일이 없고 만드는 단계가 없다. 건수만 셌고 내용은 출력하지 않았다.
- 내용 [문서]: `test_filters`는 합성 표본이고 `test_ledger`는 행별 `treat` 값을 대조하지 않는다. `foundation-design.html`을 `full`로 적어도 인수 조건이 통과한다.
- 영향: 대장의 "노드 이름은 적재하지 않는다"가 실제 실행에서 깨진다. 결정 2 뒤 `internal`로 검색된다.
- 수정: 실행 전 차단 목록을 만드는 단계를 둔다. 실행 뒤 `kb fp list --grep`으로 차단 목록과 내부 주소 0건을 보는 조건을 더한다. `test_ledger`가 행별 `treat`, `exclude_lines`, `urls_file`을 지시 값과 대조한다.

**PB-03. CLAUDE.md 지침 7이 계획에 없다.**

- 위치: CLAUDE.md 13행, 28~41행(파일 수정 시각 00:28). 계획 2.1 골격, WP-17. ADR 20.2.
- 내용 [재현 grep]: 계획과 ADR에 `effort`가 0건이다. 2.1의 `agent()` 호출에 모델과 effort가 없고 맞춤 에이전트 정의에 effort가 없다. 원장, 쓰기 게이트, 인용 게이트의 리드 수준 검토도 없다.
- 영향: 골격을 그대로 쓰면 첫 파동부터 사용자 지침을 어긴다. 실행은 된다.
- 수정: 골격의 호출에 지침 7 표의 값을 넣는다. `args.packages`에 수준을 더한다. WP-17 `test_tools_scope`가 effort를 본다. WP-01, WP-03, WP-08에 리드 수준 검토를 적는다.

**PB-04. 범위 밖 관찰. ADR-0002가 세 문서에 반영되지 않았다.**

- 내용 [재현 grep]: ADR-0002는 "ADR-0001, 빌드 계획, 소스 레지스트리는 이 문서를 따른다"고 적고 `claude -p` 단독 전제를 폐기했다. 세 문서에 `0002`, `0003`, OpenRouter가 0건이고 `docs/adr/0003-llm-backends.md`가 없다. `decisions.toml`을 쓰는 단계도 없다.
- 영향 [추론]: 첫 적재 경로에는 영향이 없다. WP-19, WP-17은 폐기된 전제로 만들어지고 사용자 답이 게이트에 반영되지 않는다.
- 수정: 파동 7 전에 메인 세션이 0003을 정하고 WP-17, WP-19 지시와 `decisions.toml` 작성 절차를 맞춘다.

### 7.2 minor

| ID | 위치 | 내용 | 근거 | 수정 |
|---|---|---|---|---|
| PB-05 | WP-00 | `[build-system]`이 지시에 없다. 빠지면 `kb`가 설치되지 않아 `Failed to spawn: kb`다. 조건 6이 잡는다 | [재현] | `uv_build`를 적는다. 재현은 `uv_build>=0.13.6,<0.14`로 통과 |
| PB-06 | 1장, WP-00 | 에이전트 Bash 도구는 zsh다. `wp-env.sh`가 `BASH_SOURCE`에 기대면 `env.sh`를 못 찾는다. `ops/bin/dev`가 다시 읽어 피해는 작다 | [재현] | 시험을 zsh로도 돈다 |
| PB-07 | WP-22 | 원본을 tmpfs 경로로만 적었다. 디스크 사본 `~/.local/share/sagae-kb/scratch-preserve-2026-10-31/`이 있고 표본 12개가 같다 | [재현] | 원본이 없으면 이 경로를 쓴다고 적는다 |
| PB-08 | 2.1 `outside` | `changed_paths`에 저장소 밖 경로를 적으면 `other` 사고가 된다. WP-00, WP-22는 `runtime/`을 쓴다 | [문서] | 저장소 상대 경로만 적는다고 정한다 |
| PB-09 | WP-25, WP-21 | tick 30분, 45분은 Bash 전경 상한 10분을 넘는다. 끊겨도 kill 안전이다 | [추론] | 배경 실행으로 적는다 |

## 8. 재현 사양과 부수 효과

스크립트는 `/home/user/.cache/sagae-kb/scratch/prebuild/verify/`에 있다. `plan_dag.py`, `cross.py`, `ctr_examples.py`, `ddl.py`, `skeleton.mjs`, `inv.py`, `intake_check.py`, `intake_check2.py`, `rewheel.py`, WP-00 재현 트리 `wp00/repo`다. 약 3 GB인 캐시 사본과 툴체인, WP-22 재현본은 끝난 뒤 지웠다.

| 대상 | 내용 |
|---|---|
| 호출하지 않은 것 | 자동완성, InnerTube, yt-dlp, YouTube 페이지, `pypi.org/simple` |
| 외부 요청 | `astral.sh`, `releases.astral.sh`(uv, CPython. 로그에 GitHub 대체 주소로 넘어간 흔적이 없다), `files.pythonhosted.org`(휠 2개). 세 호스트 robots는 404다. `pypi.org`, `github.com`은 robots.txt만 읽었다. `github.com`의 `/*/*/download/*`는 robots Disallow다. 개인 정보를 넣지 않았다 |
| 전역 파일 | `~/.claude`, `~/.claude.json`, 셸 프로필, crontab, systemd, rtk·trail 상태 변경 없음. rtk, trail, `claude`는 실행하지 않았다 |
| 다른 저장소 | `sagae-tools`, `sagae-claude-plugins`는 읽기만 했고 건수만 냈다 |
| 저장소 | 이 파일 하나만 추가했다. 대상 문서를 고치지 않았다. 커밋 없음 |
| 실패한 실행 | 재현 `deploy`의 `pipefail` 실수와 오프라인 잠금 첫 시도는 재현 쪽 문제였고 고쳐 다시 돌렸다. 부작용 없음 |
| 공유 `/tmp` | 정리 명령에 불필요한 `rm -f /tmp/x`를 넣어 실행했다. 내가 만든 파일이 없는 경로이고 약 15분 전 확인에서는 없었다. 그 사이 다른 세션이 만든 파일이 있었는지는 알 수 없다 |

**재현하지 않은 것.** 코드가 없어 WP-01 이후 인수 조건은 돌리지 않았다. 활성 소스 robots 재측정, 실제 `uv lock`, 전체 플랫폼 잠금은 하지 않았다.

**사고.** 없다.
