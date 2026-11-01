# 최종 감사 재확인

- 날짜: 2026-10-31. 감사 시간 23:03~23:40.
- 범위: `audit-final-fixes.md`의 변경 122건과 5장 7건이 ADR, 빌드 계획, 계약에 실제로 들어갔는지 확인했다. 세 문서 사이의 새 모순, 패키지 의존과 소유 경로, 사용자 결정 표와 `audit-final-facts.md` 사실표의 일치를 함께 봤다.
- 대상 판(sha256 앞 16자리): ADR `bc1330f1390d2438`, 계획 `faac406674ad06ec`, 계약 `55dd7c1cce191b94`, 소비자 문서 `aa6b9f6a758d640e`, 수정 내역 `7d4ef79a5218109e`, 사실표 `82e226e0ca455f69`. 감사 중 네 대상 문서의 수정 시각은 22:59 이전 그대로다.
- 성격: 시스템 설계 문서다(CLAUDE.md 지침 5의 예외). 약관 항목은 공개 문구의 대조이고 법률 판단이 아니다.
- 표기: **[재현]** 이번에 직접 실행한 결과, **[문서]** 문구를 해당 위치에서 확인한 결과, **[추론]** 재현하지 않은 판단. 코드가 없으므로 [문서]는 동작이 맞다는 뜻이 아니다. `RC-nn`은 이 재확인에서 새로 적은 결함이다.

## 0. 결론

**불합격이다.** 수정 내역의 서술은 대체로 정확하고 반영 품질도 높다. 그래도 고친 뒤의 문서에 기본 경로를 막는 모순이 1건 있다.

| 확인 항목 | 결과 |
|---|---|
| 확정 결함 80건 | 반영 59, 반영이지만 잔여 결함 있음 19, 부분 반영 2(FACT-02, FACT-05), 미반영 0 |
| 사용자 결정 3건, minor 39건, 편집 중 수정 7건 | 전부 지정 위치에 있다. 잔여는 4장 |
| 의존과 소유 경로 | 정상. 패키지 25, 파동 11, 순환 0, 파동 위반 0, 소유 경로 214개 겹침 0 [재현] |
| 사용자 결정 표 | 경로표 10행의 판정 칸은 사실표와 전부 같다. 사실 3곳이 빠지거나 어긋난다(RC-10) |
| 새 결함 | blocker 1, major 4, minor 21 |
| 사고 | 없음 |

1. **구축 전에 반드시 고칠 것은 1건이다(RC-01).** WP-21의 표시 없는 인수 조건 2건이 결정 10, 11 뒤에만 나오는 결과를 요구한다. 결정 11이 없으면 WP-21은 `done_pending_user`가 될 수 없고 7장 코드 완료도 불가능하다. WP-21 지시는 정반대로 "3단계까지로 끝내고 `done_pending_user`로 반환한다"고 적는다.
2. **문구 대조만으로 지나간 빈틈이 넷 있다(RC-02~RC-05).** 배포본의 `kb jobs run`이 저장소 밖에서 돌 경로가 없다. 다중 도메인 소스가 단일 `domain` 열에 들어가 도메인 D가 빈다. `src:adhoc`의 `trust`가 없어 생존 근거 규칙이 어느 쪽으로 구현해도 깨진다. CLAUDE.md 33행의 세션 조사 자료 관리는 구축 범위에 없다.
3. **수정 내역 2장의 실측은 전부 재현됐다.** 수치 하나까지 같다(2장).
4. **재료는 아직 tmpfs에만 있다 [재현].** 실제 주장 49건 등 WP-22 대상이 전부 스크래치패드에 있다. 다시 만들 수 없으므로 WP-22를 재부팅 전에 돌려야 한다.

## 1. 기계 검사

빌드 계획 본문에서 직접 뽑았다. 작성자의 `check_plan.py`는 쓰지 않았다. 스크립트는 7장에 있다.

| 검사 | 결과 |
|---|---|
| 패키지 | 3장 표 25, 4장 절 25, 파동 표 25. 제목과 의존 전부 일치 |
| 위상 정렬 | 25/25. 순환 0 |
| 파동 | 11단계(0~10). 모든 의존이 앞 파동이다. 각 패키지가 의존 최장 경로와 같은 파동에 있다 |
| 소유 경로 | 214개, 고유 214개. 접두 포함 겹침 0 |
| 2.3 모듈 표 | 전 모듈이 표의 소유 패키지 경로 안에 있다 |
| tick 단계 표 | 13행 전부 소유 패키지 경로 안에 있다 |
| `schemas/cli/` | 4개 전부 표의 패키지가 소유한다 |
| 하위 명령 | 문서에 나온 `kb` 하위 명령 35개 전부 소유 패키지가 있다 |
| 인수 조건의 맨 `kb` | WP-21 밖 0건 |
| 본문 언급 경로 | 주인 없는 경로 0건. 스크립트가 잡은 36건은 전부 오탐이다. 한국어 조사가 붙은 경로, `KB_HOME`의 `ops/runs`, 폴더 언급이다 |
| 전이 의존 밖 사용 | WP-21의 `kb api`(WP-10)가 전이 의존 밖이다(RC-17). WP-14의 `kb jobs`는 문자열 정적 검사라 문제없다 |
| 6장 시험 이름 | 전부 해당 패키지 절에 있다 |
| 인벤토리 ID | 소스 111개가 활성 50, 결정 대기 11, 비활성 50으로 겹침 없이 나뉜다. 활성·대기 전부 클래스가 있다. 활성 `forbidden` 0 |
| 수정 내역 건수 | 3.1 80, 3.2 3, 3.3 39, 합 122, 중복 0. 판정 대상 80건과 3.1이 일치한다 |
| 내역에 없는 감사 ID 14건 | 전부 다른 ID로 합쳐졌다. BLK-03, FACT-01, PLAN-04 → RULE-05. BLK-19, FACT-03 → RULE-10. CTR-13 → BLK-07. FACT-04 → RULE-04. FACT-08 → PLAN-09. PLAN-01 → RULE-01. PLAN-10 → BLK-05. PLAN-15 → RULE-16. RULE-09 → BLK-01. RULE-12 → PLAN-24. RULE-14 → PLAN-03 |
| 반영 앵커 | 122건에 앵커 606개를 절과 패키지 범위로 좁혀 검사해 실패 0. 대조군 6건은 전부 "없음"으로 나와 검사기가 실패를 잡는 것을 확인했다 |
| JSON 예시 | ADR 4, 계약 18, 계획 1. 파싱 오류 0 |
| 계약 예시와 3장 스키마 | `Envelope`, `Page`, `Node`, `Claim`, `EdgeRef`, `Backlink` 12건 통과 [재현] |
| ADR DDL | 7.1, 7.2, 7.11을 SQLite 3.53.1에서 전부 실행했다. 표 4, 16, 15개. FTS5 `contentless_delete` 삭제 동작 [재현] |
| 2.1 골격 | `export`를 떼고 `async function`으로 감싸면 `node --check` exit 0, 그대로는 exit 1 [재현]. `pipeline` 콜백 `(prev, item, index)`, 예외 시 `null`, `agent` 반환 `null`은 워크플로우 참조와 맞다 |

## 2. 실측 재현

수정 내역 2장과 ADR 2장의 값을 격리 HOME에서 다시 쟀다.

| 항목 | 주장 | 재현 결과 |
|---|---|---|
| uv 설치 스크립트 | 0.13.6, sha256 `f7a56e7a…` | 해시 일치, 가짜 HOME 0파일 |
| `UV_PYTHON_DOWNLOADS=manual`(PLAN-09) | `uv lock`, `uv run` 뒤 HOME 0 | 일치. 3.14.10, 82패키지, HOME 0파일 |
| pypdf, cssselect 고정(PLAN-11) | 잠금 가능 | `lxml 6.1.3`, `cssselect 1.6.0`, `pypdf 6.21.4` 해석과 설치 성공 |
| `uv run` 8개 병렬(1장) | 전부 성공 | 실패 0 |
| F12 HTTP | 원문, 인코딩 모두 200 | 15경로 전부 200. `e:feature:history`도 `/history`와 충돌 없음 |
| F12 MCP | 기본은 거부, `exempt_params`면 통과 | 기본 `ResourceNotFoundError`, 면제 4건 전부 통과 |
| F13 PDF | 한글 5,572, 2,287, 684로 세 판독기 동일 | 일치. 깨진 문자 0. NPR 쪽당 약 84자 |
| Gitleaks | 222규칙 중 199 컴파일, 22 플래그 이동 | 일치. 나머지 1건 `pkcs12-file`은 정규식이 없는 경로 규칙이다. RC-24 |
| `api.github.com/robots.txt` | 404 | 일치 |
| `developers.google.com/robots.txt` | `/youtube/partner/`, `authuser`만 | 일치 |
| `support.google.com/robots.txt` | D19 경로 허용 | `/youtube/answer/`를 막는 규칙 없음. 차단 대상은 `/*/search`, `/*/api` 계열 |
| F 도구 저장소 8개 | 존재, 최근 push, 보관 아님 | 일치. 최근 push는 8-26~10-31 |
| RULE-04 robots 표 | 5개 호스트 | `github.com`, `pypi.org`, `export.arxiv.org`, `www.netflix.com`, `www.kobaco.co.kr` 규칙 일치 |
| ajv 8.20.0, yaml 2.9.1 | 실재 | 일치 |
| BLK-02 체인 | 해로운 미탐지 0 | `neither_diff: 0`(300회) |
| BLK-04 게이트 | 45/90 → 16/90, 주어 교체 1/35, 대조군 0, 보류 13/49 | 전부 일치 |
| BLK-20 주소 | `is_global`이 뚫린다 | `224.0.0.1`, `ff02::1`, `fec0::1`, `::7f00:1`, `64:ff9b::7f00:1` 전부 `is_global=True` |
| FACT-07 핸들러 | SIGINT, SIGTERM에서 분리 실행 | 공식 SDK stdio에서 유휴, 도구 실행 중 모두 7.4 ms에 종료하고 분리 프로세스 동작(100 ms 이내). 실제 `claude -p`로는 재지 않았다 |
| CTR-12 Node zstd | `zlib.zstdDecompress` | 동작 |

## 3. 결함별 판정

판정 근거는 [문서]이고 재현한 것만 표시했다. "반영"은 지시한 변경이 지정 위치에 있고 내용이 결함을 고친다는 뜻이다. 동작은 구현 뒤에야 확인된다.

| 결함 ID | 판정 | 확인 내용 |
|---|---|---|
| RULE-01 | 반영, 잔여 RC-08 | 구현 규칙 1, 2.1에 `isolation` 없음, 1장 되돌림, ADR 0장 15, 1.3, 23장 15, deploy 내용 해시 |
| RULE-02 | 반영 | ADR 23 머리 "결정 3과 7이 없으면", 18장 결정 3 전 상태, 부록 A R7·R8, 계획 7장 두 단계 |
| RULE-03 | 반영, 잔여 RC-17 | ADR 15.4 D와 기본 D, 23장 7, R9 미충족, `kb.mcp.json`, 런북, `kb request`, 다른 cwd 시험 |
| RULE-04 | 반영 | `policy.robots`, `tos_ref`, 실측 표, REST 이전, `robots_denied` 행, `test_robots`, `test_robots_sample`. 표 값 [재현] |
| RULE-05 | 반영 | D18 비활성과 결정 1, D19 교체, 거부 호스트, `test_registry`, `test_hosts` |
| RULE-06 | 반영 | ADR 7.2, 0장 18, WP-02, WP-04, WP-08 시험, 계약 2.7, 9장. 병합 제외까지 있다 |
| RULE-07 | 반영, 잔여 RC-01, RC-04, RC-14 | 9단계, `gate_l1`, `E_LIVENESS_SOURCE`, L2 `depends_on`, WP-21 순서, `.checked >= 1` |
| RULE-08 | 반영 | `test_fp_open`, 런북, `--grep`, `--accept-single-copy`, R15 미충족 |
| RULE-10 | 반영, 잔여 RC-21 | "`enabled`만 켠다" 삭제 [재현 grep 0건], WP-24, `ttl_sweep`, OAuth, 7.9 `ttl30` |
| RULE-11 | 반영, 잔여 RC-03 | `by_domain`, 도메인별 하한, L2 큐 도메인 순환, `queue.domain` |
| RULE-13 | 반영 | `src:yt-api-docs`, `src:f-tools`, 공식 문서 읽기 구분, 카드 슬러그 교체. 저장소와 robots [재현] |
| RULE-15 | 반영, 잔여 RC-02 | `internal.d`, `kb jobs run`, `kb-agent.service`, 회고 분리, 티켓 도구, `test_ticket_roundtrip` |
| RULE-16 | 반영, 잔여 RC-04 | `host-policy.yaml`, `capture` 공용 층, `src:adhoc`, `WebFetch(domain:...)`, 우회 시험 |
| RULE-17 | 반영 | `R_JUDGEMENT` 0건 [재현 grep], `E_JUDGEMENT`, 영어·명령형, `howto` 기본 `attributed`, 승격 제외, `test_judgement` |
| RULE-18 | 반영 | 7.8, 8장, 9.1 분리, `E_POLICY`, `first_batch`를 사람 경로로 |
| RULE-19 | 반영 | 7.4, 7.6, 9.2, 10.5, `E_EVENT_TIME`, L2 스키마 |
| RULE-20 | 반영 | `permissions.deny` 4건, 직접 호출 접두사, `test_guard`, `test_state_scope`, jq 검사 |
| RULE-21 | 반영, 잔여 RC-08, RC-20 | `pipeline`, 즉시 로그, `report-incident`, `agent_lost`, `kb incident ack`, 20.1 세 겹 전달 |
| RULE-22 | 반영 | `kb status` 호출 시 계산, `TimeoutStartSec=14min`, 잠금 기록, 경고 건수, kb 실패 표시, `test_silence` |
| RULE-23 | 반영 | `successor`(WP-01), `SUCCESSOR_OF`(WP-02), `E_SUCCESSOR_REQUIRED`, 13장 |
| RULE-24 | 반영 | tick 1단계 스캔, 내부 작업 표, `test_inbox` |
| BLK-01 | 반영 | 0장, 3장, 4장 T0, 8장 dirty 판정, WP-13, `test_drill`, `test_secret_path` |
| BLK-02 | 반영 | 체인 입력이 `hash`를 뺀 `event` 전 열이다. 재생 대조, `test_fault_injection`. [재현] 미탐지 0 |
| BLK-04 | 반영 | 5단계 별칭 대조, `R_ALIAS_MISMATCH`, F7, 24장, 표본 `subject` 유지. [재현] 16/90 |
| BLK-05 | 반영, 잔여 RC-22 | WP-22 신설, 파동 0, 지시 경로 교체 완료. 대상 21개 파일과 폴더 전부 존재, 49, 26, 15건 [재현]. 복사는 아직이다 |
| BLK-06 | 반영 | `eff_status`가 `node`, `span` 열, 판정 때 새 버전과 `span`, `test_asof` 교차 사례, `overview_asof_p100` |
| BLK-07 | 반영 | 14.1, F6, WP-05, `test_filter_recall`, 계약 2.4, 4.8 |
| BLK-08 | 반영, 잔여 RC-16 | 항상 `epoch` + 1, 0단계 재구축, 410, 로컬 앵커 상시, `test_stale_backup` |
| BLK-09 | 반영, 잔여 RC-15 | `system.projection_quarantined`, `quarantine` 표, `.failed`, DLQ, `test_quarantine`, `test_fail_paths` |
| BLK-10 | 반영 | 0장 4, 8장, `para_budget`, `test_perf` 실제 크기, 비동기 비교 기록 |
| BLK-11 | 반영 | 교체 뒤 게이트 밖 지문, 되돌림, 게이트 보유 300 ms 상한 |
| BLK-12 | 반영 | `kb redact`, 7.9 대상 표, `reseal_segment`, 공유 객체, 결정 2, 시험에 git·세그먼트 |
| BLK-13 | 반영 | `--allow-missing`, `gap.recorded`, `recapture`, `test_t1_lag`, 17.4 |
| BLK-14 | 반영 | 수집 프로필에 `kb_source`, `test_collector_e2e`, `test_collector_profile` |
| BLK-15 | 반영 | 7.6 규칙 표, `subject_new`, `test_new_subject` |
| BLK-16 | 반영 | 7.5 문구, 7.6 재추출 행, `kb claim retract`, `test_reextract` |
| BLK-17 | 반영 | 10.6, WP-07 passthrough 앞 제거, `test_hidden`, 24장 한계 |
| BLK-18 | 반영 | `kb_put` first_party 전용, `kb_request`의 `url`, `test_put_scope`, 계약 6.1 |
| PLAN-02 | 반영, 잔여 RC-06, RC-18 | `ops/bin/dev kb` 통일, `[project.scripts]`, 내용 해시, WP-21 첫 단계와 WP-14 앞 배포 |
| PLAN-03 | 반영 | `tick_stage*.py`, 단계 표, `internal.d` 분할, 자동 탐색 |
| PLAN-05 | 반영, 잔여 RC-02 | `share_dir()`, `KB_SHARE`, `runtime/share-<id>/` |
| PLAN-06 | 반영 | 기대 지문 WP-02, 객체 형식과 `paras_sha` WP-01, `predicates.yaml` WP-01, `.d` WP-08, 카탈로그 `type_def` |
| PLAN-07 | 반영 | `ops/bin/check-workflows`. 방식 [재현] |
| PLAN-08 | 반영 | worktree 제거로 원인이 없어졌다. 병렬 [재현] |
| PLAN-09 | 반영 | `UV_PYTHON_INSTALL_DIR`, `manual`, 인수 조건 1. [재현] |
| PLAN-11 | 반영 | 1장 공유 파일 변경, 의존 고정, 평가 전용 `--with`. [재현] |
| PLAN-12 | 반영 | 7.11 DDL, `evidence_state`, `support_check`, `link_status`, 변경 절차. [재현 DDL] |
| PLAN-13 | 반영 | 이벤트 스키마 전수, `kb schema sync`, `kb sources sync`, `series.define`, `node_types` 조건 |
| PLAN-14 | 반영, 잔여 RC-18 | 패키지별 `KB_HOME`, `KB_TOOLCHAIN`, `wp-env.sh`, `src:test` 0건 [재현 grep] |
| PLAN-16 | 반영 | `collect.session_tick=false`, `KB_JOB` 건너뜀 |
| PLAN-17 | 반영, 잔여 RC-19, RC-23 | 20.2 상한, `kb-agent-run` 경로, 표본 실행 조건 |
| PLAN-18 | 반영 | 첫날 L2까지, 런북, 큐 잔량, 예상 일수 |
| PLAN-19 | 반영 | 2.1 `lost`, `blocked` Review 제외, 파동 관문, 재시도 규칙. 골격 의미 확인 |
| PLAN-20 | 반영 | 기준선 파일, lxml 검사, 스텁 `verify`, `.gitignore` 해시 비교. 같은 부류는 RC-07, RC-08 |
| PLAN-21 | 반영 | 가짜 HOME과 가짜 `claude`, 직전·직후 비교, 결정 11 |
| PLAN-22 | 반영, 잔여 RC-01 | `done_pending_user`, `gate`, WP-18 분리, 7장. WP-21에 같은 부류가 남았다 |
| PLAN-23 | 반영 | 2.3 CLI 표, `schemas/cli/`, `.data.items`, `.windows <= 1` |
| PLAN-24 | 반영 | pypdf, `needs_pdf`, `needs_ocr`, 세 어댑터, 소스별 문자 수. [재현 F13] |
| PLAN-25 | 반영 | `kb.rank.client`, `search(mode=)`, 강등 규칙 |
| CTR-01 | 반영 | `e:<type>:<slug>`, 옛 형식 0건 [재현 grep], 불변식, 시험, MCP 면제. [재현 F12] |
| CTR-02 | 반영 | `hostguard.py`, 설정값 허용 목록, 404·405·500 problem+json |
| CTR-03 | 반영 | `baseline/openapi.yaml`, 없으면 실패, 계약 8장 |
| CTR-04 | 반영 | WP-23, 경로별 `data`, 파라미터 형식, 원본 통일. 경로 26개 수 일치 |
| CTR-05 | 반영 | 7.4, 2.9, 미래 발효 규칙, 효력일 작업, `test_default_axis`, fixture |
| CTR-06 | 반영, 잔여 RC-13 | `head`, 최신 버전 민감도, `visibility.revoked`, `test_sensitivity_raise` |
| CTR-08 | 반영, 잔여 RC-12 | 데이터 경로 ETag 통일, 불변 ETag는 `/text`, `/raw`만, `test_etag` |
| CTR-09 | 반영 | `changes_cursor`, 커서 예시 `{"e":1,"s":183422}` [재현 복호], 꼬리 문자열, seq 0 |
| CTR-10 | 반영 | `sort=id`만 안정, 검색 커서 순위 위치, `/v1/nodes` 기본 `id` |
| CTR-11 | 반영 | 5만·20만, 커서로 끝까지, 부하 시험, 10.3과 11장 상태 일치 |
| CTR-12 | 반영 | `group` 프로필, 포함 규칙, `application/zstd`, 전송 바이트 기준, 503 |
| CTR-14 | 반영 | `span.source_id`, `span_facet`, `source`·`author` 필터, 자기 축, `facets_source_p95` |
| CTR-15 | 반영 | `versions`, `chains`, `predicate`, 엔티티 기준 예시 |
| CTR-16 | 반영 | `/claims`, `/edges`, `/body`, 상한과 `truncated`, `Backlink`, 이웃 기본 타입 |
| CTR-17 | 반영 | ID 불변, `merged_into_final`, `test_merge` |
| CTR-18 | 반영 | 2.3 함수, `search_facets`, `kb token`, `degraded` 담당, 경로별 시험, 추정 규모 부하 |
| CTR-19 | 반영 | "줄 위치" 0건 [재현 grep], `text_quote` + 코드포인트 |
| CTR-20 | 반영, 잔여 RC-11 | ajv, yaml 고정 [재현 실재], `fixtures/cas/`, `mcp/`, 경로별 규칙 |
| FACT-02 | **부분** | 경로표, 조항, 위반 결과, III.L, 선택지가 들어갔다. 23.3에 양자택일 표현이 남고 III.I.15가 없다(RC-10) |
| FACT-05 | **부분** | 등급 정의와 `forbidden`, `signals_conflict` 처리는 있다. 활성 소스 최소 11개에 등급이 없고 결정 9 목록이 그만큼 짧다(RC-09) |
| FACT-07 | 반영 | 4장, 15.1, WP-12 `test_signal_ship`, 실제 종료 시험. 핸들러 [재현] |

## 4. 나머지 항목

수정 내역 3.2, 3.3의 42건과 5장 7건은 전부 지정 위치에 있다. 설명이 필요한 것만 적는다.

| 항목 | 확인 |
|---|---|
| PLAN-26, CTR-07, FACT-06 | 결정 13, 14, 23.4로 올라갔다. 기본값과 소유 패키지가 세 문서에서 같다 |
| RULE-25 | 표는 재현 검사를 통과했다. 기계 생성은 내역대로 미반영이다 |
| RULE-26 | 값은 들어갔으나 목록이 전수가 아니다(RC-09) |
| RULE-29 | 조사와 수치는 맞다. 구현 지시에 빈틈이 있다(RC-24) |
| RULE-30 | 색인 금지와 건수 고정은 있다. 사용자 확인 항목이 결정 표에 없다(RC-26) |
| PLAN-30 | 내역의 의존은 전부 들어갔다. WP-21 → WP-10이 새로 빠져 있다(RC-17) |
| PLAN-31 | 표의 항목은 전부 배정됐다. `schema.epoch_bumped`를 쓰는 명령이 같은 부류로 남았다(RC-16) |
| CTR-21 | 예시 12건이 3장 스키마를 통과한다 [재현]. 하이라이트 `신규`, `8,000`과 인용 길이 30도 맞다 [재현] |
| CTR-24 | 소비자 문서 5, 27, 100행은 내역대로 미반영이다 |
| FACT-11 | U03, U16 경로는 내역대로 미확인이다. 둘 다 비활성이라 위험은 없다 |
| 5장 7건 | MCP 면제, 임포트 실패 건너뛰기, `load_registry` 이전, 시험 이전, 판정 투영 비용, `KB_TOOLCHAIN`, `eval-data` 전부 확인했다 |

## 5. 새 결함

### 5.1 blocker

**RC-01. WP-21의 표시 없는 인수 조건 2건이 결정 10, 11을 요구한다.**

- 위치: 계획 WP-21 지시 끝, 인수 조건 `test_dead_seed`, `test_audit_record`, 첫 조건 `pytest tests/first_batch`. 1장 인수, 7장 코드 완료 3. ADR 23장 머리, 결정 11 행.
- 내용 [문서]: WP-21은 "결정 11이 없으면 3단계까지로 끝내고 `done_pending_user`로 반환한다"고 적는다. 1장은 "표시 없는 조건이 전부 통과하고 표시 조건이 남으면 `done_pending_user`"다. 그런데 죽은 데이터 시드(`sources-inventory` 9장, `-g` 10장)는 5단계 `[결정 10, 11 뒤]`에서만 들어온다. `test_dead_seed`의 "superseded 사례에 `SUCCESSOR_OF`"는 표시가 없다. `test_audit_record`는 `kb-first-collect` 반환값과 `kb-verifier` 표본 50건을 요구하는데 역시 표시가 없다. 첫 조건 `pytest tests/first_batch`는 폴더 전체라 두 파일을 함께 돈다.
- 영향: 결정 11이 없는 기본 경로에서 WP-21은 인수를 통과할 수 없다. Review가 `fail`이고 7장 코드 완료 3이 불가능하다. ADR 23의 "미결정이면 표의 기본 동작으로 좁혀서 돈다"가 거짓이 된다. 결정 10, 11을 먼저 받으면 발동하지 않는다. `kb live run`만으로 사례가 채워지지 않는다는 판단은 지시의 시드 규정에서 온 [추론]이다.
- 수정: 두 조건에 `[결정 10, 11 뒤]`를 단다. `tests/first_batch` 첫 조건은 배치 정의 시험만 돌도록 파일을 지정한다. 결정 전 대체 조건을 둔다. 예: 3단계 뒤 G 단위 주어가 `removed`, `superseded`로 판정된 건의 `state`, `howto`가 기본 검색에서 0건이다.

### 5.2 major

**RC-02. 배포본의 `kb jobs run`이 저장소 밖에서 돌 경로가 없다.**

- 위치: 계획 WP-00 deploy와 래퍼, WP-14 `kb-agent.service`, WP-17 `kb jobs run`, WP-18 `kb retro`. ADR 6.1, 6.2, 18장, 20.3.
- 내용 [문서]: 배포 사본은 `schemas/`, `sources/`, `prompts/`뿐이다. `ops/bin/kb-agent-run`, `ops/job-settings/`, `.claude/agents/`, `.claude/workflows/`는 사본에 없다. ADR 20.3은 `--mcp-config ops/job-settings/...`와 `--setting-sources project`로 저장소 루트를 전제한다. `WorkingDirectory`, 저장소 경로 변수는 세 문서에 0건이다 [재현 grep]. `KB_CLAUDE_BIN`은 `env.sh`만 내보내고 래퍼와 유닛에는 없다. `docs/retro/`도 저장소 경로다.
- 영향 [추론]: 결정 3 뒤 타이머로 돌면 L2는 사전 점검에서 시작하지 않고 `kb-fulfill`, `kb-liveness-review`, 회고는 실행 파일이나 설정을 찾지 못한다. WP-17 시험은 가짜 `kb-agent-run`이고 WP-21은 저장소 루트의 수동 실행이라 어디서도 드러나지 않는다. RULE-15와 PLAN-05의 수정이 운영에서 성립하지 않는다.
- 수정: 에이전트 작업의 실행 위치를 정한다. `KB_REPO`와 유닛 `WorkingDirectory`를 두거나 네 경로를 배포 사본에 넣는다. 래퍼나 유닛이 `KB_CLAUDE_BIN`을 내보내게 한다. WP-14 입회 시험에 `kb jobs run` 1회를 넣는다.

**RC-03. 다중 도메인 소스가 단일 `domain` 열에 들어간다.**

- 위치: ADR 10.4 `domain: [G]`, 7.2 `node.domain`, `span.domain`, 7.11 `queue.domain`. 계약 3장 `domain`, 4장 필터. WP-15 `by_domain`, WP-21 하한.
- 내용: 레지스트리는 목록인데 저장과 계약은 문자열 하나다. 변환 규칙이 없다 [문서]. 활성 A~F 13개 중 7개가 다중 도메인이다(D01, D04, D13, D15, D17, D19, P10). 도메인 D에는 단일 도메인 소스가 없다. D13 `C D E`, D15 `C D E`, D19 `C D`다 [재현, 인벤토리 5.1 대조].
- 영향 [추론]: 첫 값만 저장하면 `domain=D` 필터와 패싯, `kb_search(domain=)`가 빈다. `by_domain`을 `node.domain`으로 세면 WP-21의 `.by_domain.D.snapshots >= 3`이 마지막 파동에서 실패한다. 첫 수집 뒤 고치면 투영 스키마와 계약이 함께 바뀐다.
- 수정: 규칙을 정한다. 예: gold에 `node_domain(node_id, domain)` 표를 두고 필터는 포함 일치로, `by_domain`은 소스 목록 기준 다중 집계로, 계약 `domain`은 배열로 한다. WP-23 전에 정해야 계약 파괴 변경을 피한다.

**RC-04. `src:adhoc`의 `trust`가 없어 생존 근거 규칙이 어느 쪽으로도 깨진다.**

- 위치: ADR 9.2 `snapshot`, `liveness` 행. WP-08, WP-21 5단계. 계약 3장 `source.trust`.
- 내용 [문서]: 미등록 URL은 `src:adhoc`로만 받고(RULE-16), `liveness` 신호의 스냅샷은 `trust=primary`여야 한다(RULE-07). `src:adhoc`의 `trust`는 어디에도 없다. WP-21 5단계는 바로 "레지스트리에 없는" 죽은 데이터 후보를 찾는다.
- 영향 [추론]: `secondary`면 레지스트리 밖 죽은 데이터가 전부 `E_LIVENESS_SOURCE`로 거부돼 `test_dead_seed`가 실패한다. `primary`면 아무 URL이나 1차 근거가 되어 CLAUDE.md의 "1차 출처로 확인"이 무력해진다.
- 수정: `src:adhoc`는 `trust=unknown`으로 두고 판정 대상 자신의 공식 호스트(저장소, 패키지 레지스트리, 벤더 문서)일 때만 1차로 인정하는 규칙을 게이트에 둔다. 시험을 WP-08에 더한다.

**RC-05. CLAUDE.md 33행의 세션 조사 자료 관리가 구축 범위에 없다.**

- 위치: CLAUDE.md 저장 범위 33행, `docs/intake/session-research.md`. 수정 내역 4장. 계획 전체.
- 내용: "다른 프로젝트 세션이 조사한 최신 라이브러리 동향과 도구 조사도 이 저장소가 관리한다"가 22:40에 추가됐다. ADR, 계획, 계약에 `intake`가 0건이다 [재현 grep]. 어느 패키지도 접수 대장을 처리하지 않고 7장 완료 보고 항목에도 없다. 수정 내역은 판단을 메인 세션에 넘겼다.
- 영향: 사용자 지시가 구축 범위 밖인 채 완료 보고가 나간다. 접수 자료 사본은 `~/.local/share/sagae-kb/intake/`에 있고 T0 밖이다. 저장 경로 자체는 있다. 세션 자료는 `kb_put`, 외부 사실은 `kb_request`의 `url`이다. 다만 `kb_put`은 결정 2 전 `held`다.
- 수정: 메인 세션이 사용자에게 확인하고 패키지 하나로 만들거나 WP-21 뒤 런북에 넣는다. 범위 밖으로 두면 7장 보고 표에 올린다.

### 5.3 minor

| ID | 위치 | 내용 | 근거 | 수정 |
|---|---|---|---|---|
| RC-06 | WP-00 deploy | 코어 `dependencies`가 비어 있고 전부 optional group인데 deploy 지시에 extra 지정이 없다. 기본 `uv sync --frozen --no-editable`은 `kb`만 깔고 `mcp`, `starlette`, `yaml`, `jsonschema`, `feedparser`, `lxml`이 전부 `ModuleNotFoundError`다. 실제 배포 시험은 WP-21 첫 단계 전에 한 번도 없다 | [재현] | `--extra serve --extra collect`를 지시에 적는다. WP-00에 임시 `KB_HOME` 실제 배포와 `kb doctor` 시험을 더한다 |
| RC-07 | WP-00 인수 조건 2 | `source ops/bin/env.sh; python -I ...`인데 `env.sh` 값 목록에 PATH가 없다. 이 머신에 `python`이 없어 exit 127이다 | [재현] | `env.sh`가 관리형 Python을 PATH에 넣거나 조건을 `ops/bin/dev python -I`로 바꾼다 |
| RC-08 | 1장 되돌림, 2.1 | 이 머신에 `zstd`가 없어 `tar --zstd`가 exit 2이고 0바이트 파일을 남긴다 [재현]. 파동 0에는 `$KB_BUILD_ROOT`가 아직 없다. 골격은 `!snap`만 보고 `bytes`를 검사하지 않는다. `snap.incidents`를 기록도 합산도 안 한다. "파동 끝 `changed_paths` 기계 대조"의 수행 주체가 골격과 Review 어디에도 없다 [문서] | [재현], [문서] | 표준 라이브러리 `compression.zstd`로 만들거나 `.tar.gz`로 바꾼다. `bytes > 0`을 검사한다. `snap.incidents`를 반환값에 합산한다. 대조 단계를 골격에 넣는다 |
| RC-09 | ADR 10.4 등급 표, 23장 9 | 활성 소스 19개가 등급 표에 없다. GitHub, `code.claude.com`, 로컬 실행으로 볼 수 있는 8개를 빼면 최소 11개(L03, L04, L05, M21, O10, U05, U08, U09, U11, U14, U15)가 기본값 `unverified`이고 결정 9 목록에 없다. D01은 "재사용 조건 미확인"인데 `unverified` 정의에 맞으면서 `no_clause`다. U11의 `d2.naver.com`은 X01을 끈 네이버 약관과 같은 계열인데 등급이 없다 [추론] | [재현] | 등급을 전수 배정하고 결정 9를 그 목록으로 바꾼다. D01을 옮긴다 |
| RC-10 | ADR 23.1~23.3 | 6장 참고. III.I.15 누락, 댓글 작성자 조항 누락, "공개 경로 전체 포기"와 "2~4는 함께 쓰지 않는다" | [재현] | 6장 |
| RC-11 | WP-04, WP-11, 계약 2.1, 9장 | `build_id`를 WP-04가 "`gold_schema`, 마지막 seq, 코드 빌드 해시의 해시"로 정의한다. 값을 쓰는 곳은 WP-02의 gold `meta`인데 WP-02 지시에 없다. 코드 해시는 재생 입력이 아니라 계약 9장과 어긋나고, `ops/bin/dev`에는 그 값이 없고, 코드가 바뀔 때마다 fixture 왕복이 깨진다. 같은 seq 재구축의 `build_id`가 같아 "재구축 때 바뀐다"와도 다르다 | [문서] | WP-02로 옮긴다. 코드 해시를 빼고 `gold_schema` + 재생 입력으로 한다. 빌드 디렉터리 이름과 분리한다 |
| RC-12 | 계약 2.5, WP-04, WP-10 `test_etag` | 2.5는 데이터 경로 응답이 "`applied_seq`와 `build_id`만의 함수"라는데 봉투 `degraded`는 `ops.db`에서 온다. `test_etag`의 "`degraded` 변화에서 304가 나지 않음"은 데이터 경로에서 성립할 수 없다. `/text`, `/raw`도 304를 먼저 판단하면 삭제 뒤 410이 안 나간다 [추론] | [문서] | 시험 범위를 `/v1/meta`로 좁히고 2.5 문장을 봉투 `data`로 한정한다. 불변 ETag 경로는 삭제 여부를 먼저 본다 |
| RC-13 | ADR 7.2 `change`, WP-02 | `change.seq`가 PRIMARY KEY인데 민감도 상향은 그 이벤트 seq에 `visibility.revoked` 행을 더 넣으라고 한다. 두 행은 `IntegrityError`이고 그대로면 투영 격리로 이어진다. 한 행으로 바꾸면 `owner` 범위가 원 이벤트를 못 본다 | [재현] | 키를 `(seq, sub)`로 바꾸거나 "원 이벤트 행을 대체한다"고 적는다 |
| RC-14 | ADR 7.6, 7.11, 10.6, WP-08, WP-09 | 보류 주어를 "재확인 큐"에 넣는다는데 `queue.kind`에는 `reconfirm`과 `live`가 따로 있다. WP-09는 `live` 항목을 처리한다. 값이 다르면 G 주장이 영구 `needs_review`다 | [문서] | 생산자 쪽 문구를 `queue(kind=live)`로 고정한다 |
| RC-15 | ADR 7.1, 8장, WP-01, WP-02 | `kb rebuild quarantine release`가 "해제 이벤트"를 쓰는데 7.1 kind 표에 없다. WP-02는 `schemas/events/`를 고칠 수 없다 | [문서] | `system.projection_released`를 7.1과 WP-01 스키마에 넣는다. 재생의 건너뛸 집합이 이를 뺀다 |
| RC-16 | ADR 17.2, 17.4, WP-13 | 복원 런북의 `schema.epoch_bumped`를 쓰는 명령이 없다. WP-13 명령은 `ship`, `drill`, `export`, `redact`다. 사람이 런북만으로 따라 할 수 없다 | [문서] | `kb drill restore` 또는 `kb rebuild`의 복원 하위 명령을 소유 경로에 정한다 |
| RC-17 | 3장 의존, WP-21, WP-12 | WP-21 인수 조건이 `kb api`를 쓰는데 WP-10이 전이 의존 밖이다 [재현]. 파동 순서로만 돌고 파동 관문이 막지 못한다. `test_claude_real`의 `ops/mcp/kb.mcp.json`은 `runtime/bin/kb-mcp`를 가리키는데 배포는 WP-21에서 처음 돈다. 결정 11이 그 전에 오면 `connected`가 될 수 없다 [추론] | [재현], [추론] | WP-21 의존에 WP-10을 더한다. 시험이 임시 설정으로 `ops/bin/dev kb-mcp`를 가리키게 한다 |
| RC-18 | 1장 작업 위치, WP-00, WP-14, WP-21 | 모든 명령이 `wp-env.sh` 뒤인데 이 파일은 패키지별 `KB_HOME`, `KB_CONFIG_DIR`을 고정한다. WP-21과 WP-14 입회의 실운영 예외가 없다. 그대로면 배포와 수집이 빌드 폴더로 가고 `decisions.toml`을 못 읽어 결정을 미승인으로 오판한다 | [문서] | `wp-env.sh WP-21`은 실운영 값을 내보낸다고 적는다. WP-14 입회도 같다 |
| RC-19 | ADR 20.2, 20.3, WP-17, WP-21 7단계 | `kb-verifier`는 `kb` MCP 읽기 도구를 쓰는데 고정 호출은 `--strict-mcp-config`에 `kb-collect.mcp.json`뿐이다. collector 프로필에 `kb_get`이 없다. 도구가 없어도 exit 0이다 | [문서], [추론] | job 설정에 `kb` 서버를 함께 등록하거나 검증 에이전트 도구를 collector 프로필로 바꾼다 |
| RC-20 | WP-17, ADR 20.1, 계획 2.2 | WP-17의 kind 목록에 `agent_lost`가 없다. ADR과 2.2는 5개 값이다. `incidents.schema.json`을 WP-17대로 쓰면 스키마가 어긋난다 | [문서] | WP-17 문구를 5개 값으로 맞춘다 |
| RC-21 | WP-24, WP-06, WP-07 | `host_allow`는 WP-24에만 있고 로더를 가진 WP-06 지시에 없다. WP-24는 `src/kb/collect/`를 고칠 수 없다. WP-24가 재사용하는 `test_registry`의 "비활성 표 전부 활성 아님", "forbidden 활성 0"은 사용자가 고른 소스를 켜면 실패한다 | [문서] | WP-06에 `host_allow` 읽기를 넣는다. 시험을 overlay 없는 기본 레지스트리로 한정한다 |
| RC-22 | WP-22 | 옮길 목록이 문서 4건의 `.in`, `.json`인데 `gate2.py`, `gate2_fix.py`는 `.txt`를 읽는다. 같은 폴더에 있는데 목록에 없다. 내용은 `.in` 안에 그대로 들어 있어 복구는 된다 | [재현] | 목록에 `.txt`를 더한다 |
| RC-23 | ADR 23장 10, WP-21 5단계, 승인 표 | ADR은 결정 10의 기본 동작을 "20.2의 기본값"이라 적고 계획은 결정 10 뒤에만 실행한다. 결정 11만 있을 때의 동작이 갈린다 | [문서] | 한쪽으로 맞춘다 |
| RC-24 | ADR 5장, WP-03 | `airtable-personnal-access-token`은 POSIX 클래스 `[[:alnum:]]`를 쓰고 Python에서 경고만 내고 뜻이 바뀐다. `pkcs12-file`은 경로 규칙이라 본문 검사가 아니다. 130규칙의 `entropy`, 9규칙의 allowlist, 전역 allowlist를 지시가 다루지 않아 그대로 쓰면 오탐이 `secret` 격리로 간다 [추론] | [재현] | 변환 규칙과 `entropy`, allowlist 처리를 WP-03에 적는다 |
| RC-25 | 수정 내역 4장 | "공백 1, 3, 4, 6~10, 14는 계약 0.2.0이 이미 다룬다"가 조금 넓다. 공백 4의 `/v1/changes` `origin` 파라미터, 공백 7의 `subject`와 접두어 일치, 공백 10의 `g-`와 `p-` 관계가 없다 | [문서] | 다음 계약 판의 목록에 더한다 |
| RC-26 | ADR 21장, 23장 | "이 예외 분류는 사용자가 확인한다"가 결정 표에 없어 번호 없이 묻힌다 | [문서] | 23장에 한 행을 두거나 7장 보고에 넣는다 |

## 6. 사용자 결정 표 대조

| 대조 | 결과 |
|---|---|
| 23.1 경로표 10행과 사실표 1.1의 `키 없음`, `키 보유` | 전부 같다 [재현, 스크립트 대조] |
| 근거 문구 | 전부 같다. ADR은 P09를 P09a, b, c로 나눴다(FACT-09) |
| 조건 칸 | 뜻이 같은 축약 7곳. 아래 한 곳만 빠졌다 |
| 1.2 조항표 | 9행 중 8행이 23.1~23.2에 있다. III.I.15가 없다 |
| 1.3 대조 | 양자택일 틀, 근거 III.E.6·III.I.14·III.D, 30일의 범위, III.E.2, III.E.4.h, 결합 금지, III.L, 계정 종료, "막히는 것" 정정이 전부 있다 |
| 1.4 선택지와 23.3 | 7행이 8행으로 늘었고 얻는 것, 남는 것이 일치한다. 사실표의 "공개 경로 전체 포기"를 그대로 옮겼다 |
| 2.2 소스 판정과 10.4 등급 | X11, D20, D11, D18, O 계열, D21, D05, C 계열, GitHub, HF, Kworb 일치. 예외 D01 |
| 5장 R2, healthchecks | 결정 2와 12장 일치. 무료 구간, 결제 수단 2차 표시, 약 7 GB 추론 표시까지 맞다 |
| FACT-13, FACT-15 | 일치 |

**RC-10의 세 곳.**

1. **III.I.15 누락.** 사실표 1.2와 FACT-03 추가 항목은 키 선택 시 HTTP `/v1`, MCP로 내보내는 것이 "offer an API service that allows users to access any data ... provided by the YouTube API Services"에 닿는지 불명확하다고 적었다. ADR 23장과 WP-24에 0건이다 [재현]. 저장소가 다른 세션에 반환하는 것이 목적이므로 키 선택의 쟁점이다. 23.2와 WP-24에 한 줄 넣는다.
2. **댓글 작성자 조항 누락.** 1.1 yt-dlp 행의 "collect or harvest any information that might identify a person"이 23.1에 없다 [재현]. 옵션 4를 고를 때의 조건이다.
3. **선택지 표의 양자택일 잔재.** 23.3의 6행 "공개 경로 전체 포기"와 5행 "2~4는 함께 쓰지 않는다"는 23.1, 결정 1 문장과 어긋난다. 23.1은 WebSub 키 보유 "허용", 채널 RSS와 Trends RSS 키 보유 "불명확"이다. 1.3도 "RSS는 불명확, WebSub은 함께 쓸 수 있다"고 적었다. 사실표 1.4의 축약이 그대로 넘어온 것이고 FACT-02가 고치려던 표현이다. "금지 경로 포기, RSS 불명확, WebSub 가능"으로 바꾼다. 사실표 1.4도 같이 고친다.

## 7. 범위 밖으로 넘긴 항목과 재현 사양

**수정 내역 4장 확인.** 전부 사실이다. BLK-05의 복사는 아직 안 됐고 재료는 스크래치패드에 있다 [재현]. `sagae-tools-reply-2.md`의 공백 16~20은 답이 없다. 특히 공백 17은 FACT-07 수정과 맞물린다. 세션 게이트웨이 tower 뒤에서는 신호가 오지 않고 stdin EOF가 먼저라, ADR 15.4 B로 옮기면 세션 종료 전송을 EOF 경로에도 둬야 한다. v1 기본 경로 D, A에는 영향이 없다.

**스크립트.** `/tmp/claude-1000/-home-sagae-sagae-knowloge-base/b32eef31-b09c-4e58-8902-431f279117b3/scratchpad/audit/recheck/` 아래에 있고 tmpfs라 재부팅하면 사라진다.

| 스크립트 | 내용 |
|---|---|
| `plan_graph.py`, `plan_paths.py` | 계획 본문에서 표, 절, 의존, 소유 경로, 모듈, 단계, 하위 명령을 뽑아 검사 |
| `anchors.py` | 122건, 앵커 606개를 절과 패키지 범위로 검사 |
| `inv_check.py`, `misc_check.py` | 인벤토리 ID, 등급, 클래스, 건수, 시험 이름, JSON 예시, WP-22 재료 |
| `facts_diff.py` | ADR 23장과 사실표 행별 대조 |
| `ddl_check.py`, `schema_check.py` | ADR DDL 실행, `change.seq` 충돌, 계약 예시 스키마 검증 |
| `gitleaks_check.py`, `sig_srv.py`, `sig_drv.py` | Gitleaks 규칙 컴파일, 신호 핸들러 |

툴체인 재현은 uv 0.13.6, CPython 3.14.10, WP-00 의존 그대로였다. HOME은 가짜 폴더였고 `~/.cache/sagae-kb/scratch/audit/recheck`(580 MB)에 두었다가 끝난 뒤 지웠다.

**재현하지 않은 것.** 코드가 없어 패키지 인수 조건은 하나도 돌리지 않았다. 실제 `claude -p` 종료 시험(FACT-07 본 시험), 전원 손실, WSL 재부팅, 부하 시험은 재지 않았다. 활성 소스 전체의 robots 재측정은 하지 않고 바뀐 호스트만 봤다.

**부수 효과.**

| 대상 | 내용 |
|---|---|
| 호출하지 않은 것 | 자동완성, InnerTube, yt-dlp 실행, 채널 RSS, YouTube 페이지 0건. `api.github.com/repos/yt-dlp/yt-dlp`는 저장소 메타데이터 1회다 |
| 외부 요청 | `astral.sh`, uv의 Python과 패키지 내려받기(`pypi.org/simple`, `files.pythonhosted.org`, GitHub 릴리스), `api.github.com` 비인증, `raw.githubusercontent.com`(Gitleaks 설정), `registry.npmjs.org`, robots.txt 10개 호스트, `www.kmcc.go.kr`, `www.nasmedia.co.kr` PDF 3건. 개인 정보를 넣지 않았다 |
| robots | PDF 3건은 robots 판정이 허용일 때만 받았다. `pypi.org/simple`은 robots Disallow이지만 패키지 관리자의 표준 경로이고 이전 감사도 같다 |
| 전역 파일 | `~/.claude`, `~/.claude.json`, 셸 프로필, crontab, systemd, rtk·trail 상태 변경 없음. rtk, trail, `claude`는 실행하지 않았다 |
| 저장소 | 이 파일 하나만 추가했다. 대상 문서는 고치지 않았다. 커밋 없음 |
| 실패한 실행 | 프로토타입 3개를 인자 없이 돌려 `IndexError`가 났고 첫 grep 묶음은 셸 차이로 비어 있어 다시 돌렸다. 부작용 없음 |

**사고.** 없다.
