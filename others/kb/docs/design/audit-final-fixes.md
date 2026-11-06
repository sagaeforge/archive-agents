# 최종 감사 반영 내역

- 날짜: 2026-10-31
- 범위: 확정 결함 80건, 사용자 결정 항목 3건, minor 39건, 합계 122건을 ADR, 빌드 계획, 계약에 반영했다.
- 성격: 시스템 설계 문서다(CLAUDE.md 지침 5의 예외).
- 대상: `docs/adr/0001-architecture.md`(ADR), `docs/build-plan.md`(계획), `docs/contracts/data-interface-v0.md`(계약). `docs/research`, 기존 `docs/design` 파일, `docs/contracts/consumers/sagae-tools.md`는 고치지 않았다.
- 표기: 위치는 고친 뒤의 절과 패키지다. 줄 번호를 쓰지 않는다.

## 1. 기계 검사

고친 뒤 스크립트로 확인했다.

| 검사 | 결과 |
|---|---|
| 패키지 | 25개(WP-00~WP-24). 표와 절의 제목, 의존 일치 |
| 파동 | 11단계(0~10). 모든 의존이 앞 파동에 있다 |
| 의존 순환 | 0건 |
| 소유 경로 겹침 | 214개 경로, 접두 포함 겹침 0건 |
| 2.3 모듈, tick 단계 표, `schemas/cli/` 소유 | 소유 패키지의 경로 안에 있다 |
| 인수 조건의 맨 `kb` | WP-21 밖 0건. WP-21은 지시에서 `runtime/bin/kb`로 정의한다 |
| 인벤토리 111개 ID | 전부 ADR 10.4의 활성, 결정 대기, 비활성 표 중 한 곳에 있다 |
| 계약, ADR의 JSON 예시 | 파싱 오류 0건 |
| 2.1 골격 | `export`를 떼고 `async function`으로 감싸 `node --check` exit 0 |

## 2. 이번 단계의 실측

수정안이 그대로 통하는지 값싸게 재현한 것이다. ADR 2장 F12, F13이다.

| 항목 | 결과 | 반영 |
|---|---|---|
| `e:<type>:<slug>` HTTP | Starlette 1.10에서 원문, 인코딩 모두 200. `e:feature:history`도 경로 충돌 없음 | CTR-01 |
| `e:<type>:<slug>` MCP | `mcp` 2.3.0 기본 `ResourceSecurity`가 `e:`, `s:`를 Windows 드라이브 경로로 거부한다. CTR-01의 수정안만으로는 `kb://node/{id}`가 여전히 실패한다. `exempt_params={"id"}`로 통과 | ADR 15.1, WP-12 |
| PDF 판독기 | pypdf, pypdfium2, pdfminer.six의 한글 글자 수가 3건 모두 같다 | pypdf 6.21.4 |
| Gitleaks 규칙 | 222규칙 중 199개가 Python `re`로 컴파일, 22개는 인라인 플래그 위치 문제 | RULE-29 |
| `UV_PYTHON_DOWNLOADS=manual` | `uv python install`은 동작하고 `uv lock`, `uv run` 뒤 가짜 HOME 파일 0 | PLAN-09. `never`가 아니라 `manual`이다 |
| `api.github.com/robots.txt` | 404 | RULE-04의 REST 이전은 robots 예외가 필요 없다. `official_api`는 PyPI, arXiv에만 쓴다 |
| `developers.google.com/robots.txt` | `/youtube/partner/`, `authuser`만 Disallow | RULE-13 |
| F 도구 저장소 8개 | 전부 존재, 최근 push, 보관 아님 | `src:f-tools` |

## 3. 결함별 변경

### 3.1 확정 결함

| 결함 ID | 문서 | 위치 | 변경 |
|---|---|---|---|
| RULE-01 | 계획, ADR | 계획 구현 규칙 1, 1장, 2.1, WP-00. ADR 0장 15, 1.3, 6.2, 23장 15 | 안 1 적용. worktree와 병합 단계를 없애고 같은 작업 트리에서 병렬 실행한다. 파동 스냅샷을 되돌림 수단으로 둔다. deploy는 내용 해시. 안 2는 결정 15로 남겼다 |
| RULE-02 | ADR, 계획 | ADR 23장 머리, 18장, 부록 A R7·R8. 계획 7장 | 결정 3을 구축 완료 조건으로 올렸다. "미결정은 시스템을 막지 않는다"를 고쳤다. 코드 완료와 운영 완료를 나누고 완료 보고에 스케줄 없음, 사본 1벌을 적는다 |
| RULE-03 | ADR, 계획 | ADR 15.4 D, 23장 7, 부록 A R9. WP-12, 7장 | 전역 변경 없는 경로를 설계에 넣었다. `ops/mcp/kb.mcp.json`, `docs/runbooks/use-from-other-session.md`, `kb request`. `test_claude_real`을 다른 cwd로. 기본값 A 문구 삭제. R9는 결정 7 전 미충족 |
| RULE-04 | ADR, 계획 | ADR 10.4, 12장, 23장 8. WP-06, WP-07 | `policy.robots: enforce\|official_api`, `tos_ref`. 실측 거부 표. GitHub는 atom을 버리고 REST. Netflix, KOBACO 비활성. `robots_denied` 행과 집계. `test_robots`, `test_robots_sample` |
| RULE-05 | ADR, 계획 | ADR 10.4, 23.3~23.4. WP-06, WP-07, WP-21 | D18을 결정 1로 옮겼다. D19를 `support.google.com/youtube/answer/16089387`로 교체. 거부 호스트에 넣고 `test_registry`, `test_hosts`에 넣었다 |
| RULE-06 | ADR, 계획, 계약 | ADR 7.2, 0장 18. WP-02, WP-04, WP-08. 계약 2.7, 9장 | 주어 `dead` 또는 `superseded`면 `state`, `howto`도 그 값이다. 병합은 제외. 시험과 fixture에 반영 |
| RULE-07 | ADR, 계획 | ADR 10.6, 9장 표. WP-08, WP-09, WP-19, WP-21 | 9단계 `R_LIVENESS_UNKNOWN`, `gate_l1` 단계, 근거 `trust=primary`(`E_LIVENESS_SOURCE`), L2 `depends_on`. WP-21 순서를 tick, live, L2, 에이전트, live로. `test_dead_seed`. `kb live run` 조건을 `.checked >= 1`로 |
| RULE-08 | ADR, 계획 | ADR 8장, 0장 13, 23장 2, 부록 A R15. WP-03 | `test_fp_open` 종단 시험, `docs/runbooks/first-party-open.md`, `kb fp list --grep`, TTY 전용 `--accept-single-copy`. R15는 결정 2 전 미충족 |
| RULE-10 | ADR, 계획 | ADR 10.4, 7.9, 23장. 계획 승인 경계, WP-24 | "`enabled`만 켠다"를 삭제. 결정 1 뒤 도는 WP-24를 추가(어댑터, 키, OAuth, `ttl_sweep`) |
| RULE-11 | ADR, 계획 | ADR 10.5. 2.3 CLI 표, WP-15, WP-19, WP-21 | `by_domain`, 도메인별 하한, L2 큐 도메인 순환 |
| RULE-13 | ADR, 계획 | ADR 10.4, 11장, 15.2. WP-07 | `src:yt-api-docs`, `src:f-tools` 추가. 공식 문서 읽기와 결정 1 구분. 카드 예시 슬러그 교체 |
| RULE-15 | ADR, 계획 | ADR 11장, 15.3, 18장, 20.2. WP-09, WP-14, WP-17, WP-18 | `sources/internal.d`, `kb jobs run`, `kb-agent.service`, 회고를 tick에서 분리, `kb_ticket_list`, `kb_ticket_close`, 묶음 `ticket`, `test_ticket_roundtrip` |
| RULE-16 | ADR, 계획 | ADR 0장 16, 10.3, 9.2. WP-06, WP-08, WP-17 | `sources/host-policy.yaml`과 비활성 소스 호스트를 `safe_fetch`가 강제. `capture` 공용 층. `src:adhoc`, `WebFetch(domain:...)` 거부, 우회 시험 |
| RULE-17 | ADR, 계획 | ADR 7.6, 9.3, 10.6. WP-08, WP-19 | `R_JUDGEMENT` 삭제, `E_JUDGEMENT`. 화자 확정 시 `attributed`, 승격 대상 제외, 영어·명령형 어휘, `howto` 기본 `attributed`, `test_judgement` |
| RULE-18 | ADR, 계획 | ADR 7.8, 8장, 9장. WP-08 | collector와 `producer=agent:*`의 `record`는 `E_POLICY`. `first_batch` 시험을 사람 경로로. 9.1 예시 분리 |
| RULE-19 | ADR, 계획 | ADR 7.4, 7.6, 9장, 10.5. WP-08, WP-19 | `event`에 시점 필수, `E_EVENT_TIME`, L2 스키마 반영 |
| RULE-20 | ADR, 계획 | ADR 19.1, 19.2. WP-16 | `permissions.deny`, 직접 호출 접두사, deny 규칙과 상태 경로 시험 |
| RULE-21 | ADR, 계획 | ADR 20.1, 12장. 계획 2.1, 2.2, WP-15, WP-17 | `pipeline` 안에서 즉시 로그, `incidents.ndjson` 파일, `agent_lost`, `kb incident ack` |
| RULE-22 | ADR, 계획 | ADR 12장, 18장. WP-06, WP-14, WP-15, WP-16 | `kb status` 호출 시 계산, `TimeoutStartSec`, 잠금 기록, 경고 건수 1줄, kb 실패 표시, `test_silence` |
| RULE-23 | ADR, 계획 | ADR 9.2, 13장. WP-01, WP-02, WP-09 | `successor` 필수, 투영이 `SUCCESSOR_OF`를 만든다, `E_SUCCESSOR_REQUIRED` |
| RULE-24 | ADR, 계획 | ADR 8장, 10.2, 11장. WP-03 | tick 1단계와 내부 작업에 `inbox` 스캔 |
| BLK-01 | ADR, 계획 | ADR 0장, 3장, 4장 T0, 8장. WP-13 | T0에 `spool/`, `inbox/`. dirty 판정에 스풀 변경. 시험에 held 복원. "에만 있다" 문장 수정 |
| BLK-02 | ADR, 계획 | ADR 7.1, 17.3. WP-01 | 체인 입력에 `event` 전 열, `record_head`, `meta`는 재생 대조, `test_fault_injection` 범위 확대 |
| BLK-04 | ADR, 계획 | ADR 2장 F7, 3장, 10.6, 24장, 부록 B. WP-08 | 5단계에 문장 별칭 대조, `R_ALIAS_MISMATCH`, 수치 16/90으로 수정, 표본을 `subject` 유지로 정의 |
| BLK-05 | 계획, ADR | 계획 WP-22, 파동 0. ADR 2장, 부록 B | 재료 보존 패키지 신설, 패키지 지시의 경로를 저장소 경로로 교체. 실제 복사는 7장 |
| BLK-06 | ADR, 계획, 계약 | ADR 7.2, 3장. WP-02, WP-04, WP-10. 계약 2.9 | `eff_status`를 `node` 열과 버전 행으로. 판정 때 새 버전과 `span`. 교차 시험, 부하 시험에 as-of 개요 |
| BLK-07 | ADR, 계획, 계약 | ADR 14.1, 2장 F6. WP-05. 계약 2.4, 4.8 | 필터나 as-of가 있으면 안쪽 `LIMIT` 없음, `total` 뜻 확정, `test_filter_recall` |
| BLK-08 | ADR, 계획, 계약 | ADR 10.2, 12장, 17.2, 17.4. WP-06, WP-13, WP-15. 계약 2.3, 4.12 | 복원은 항상 `epoch` + 1, `applied_seq > head` 처리, 커서 앞섬 410, 로컬 앵커 대조 상시 |
| BLK-09 | ADR, 계획 | ADR 7.1, 7.2, 8장, 12장, 3장. WP-02, WP-03 | `system.projection_quarantined` 격리와 건너뛰기, `quarantine` 표, 스풀 재적재 실패 DLQ, `test_quarantine`, `test_fail_paths` |
| BLK-10 | ADR, 계획 | ADR 0장 4, 2장 F3, 8장. WP-02, WP-03 | 상한을 게이트 보유당 200문단으로, `para_budget`, `test_perf` 실제 크기, 비동기 투영 비교 기록 |
| BLK-11 | ADR, 계획 | ADR 1.2, 2장. WP-02 | 지문을 교체 뒤 게이트 밖으로, 불일치면 되돌림, 게이트 보유 상한 시험 |
| BLK-12 | ADR, 계획 | ADR 7.9, 3장, 23장 2. 계획 2.3, WP-01, WP-13 | `kb redact`, 대상 표, `reseal_segment`, 공유 객체 처리, 시험에 git·세그먼트·공유 객체 |
| BLK-13 | ADR, 계획 | ADR 12장, 17.4. WP-02, WP-13 | `--allow-missing`, `gap.recorded`, 재수집 큐, `test_t1_lag` |
| BLK-14 | ADR, 계획 | ADR 1.2, 15.1, 20.2. WP-12, WP-17 | collector 프로필에 `kb_source`, `test_collector_e2e` |
| BLK-15 | ADR, 계획 | ADR 7.6. WP-08, WP-19 | `__new__` 임시 엔티티 규칙, `subject_new`, `test_new_subject` |
| BLK-16 | ADR, 계획 | ADR 7.5, 7.6, 10.5, 3장. WP-19 | 문구 수정, 재추출 철회 규칙, `kb claim retract`, `test_reextract`, 자동 대체 금지 시험 |
| BLK-17 | ADR, 계획 | ADR 10.6, 24장. WP-07 | Markdown 숨김 제거, `test_hidden` 확대, 외부 스타일시트 한계 기록 |
| BLK-18 | ADR, 계획, 계약 | ADR 3장, 8장, 10.3, 15.1. WP-03, WP-08, WP-12. 계약 6.1 | `kb_put`은 first_party 전용. 외부 사실은 `kb_request`의 `url`. `test_put_scope` |
| PLAN-02 | 계획, ADR | 계획 1장, WP-00, 전 인수 조건, WP-14, WP-21. ADR 6.2 | `ops/bin/dev kb`로 통일, `[project.scripts]`, 내용 해시 배포, 실제 배포를 WP-21과 입회 시험 앞에 둠 |
| PLAN-03 | 계획, ADR | 계획 2.3, WP-06 외 각 패키지. ADR 10.2 | `tick_stage*.py` 자동 탐색과 단계 표, `sources/internal.d` |
| PLAN-05 | 계획, ADR | 계획 2.3, WP-00. ADR 6.1, 6.2 | `share_dir()`, `KB_SHARE`, `runtime/share-<id>/` |
| PLAN-06 | 계획 | WP-01, WP-02, WP-07, WP-08, 2.3 | 기대 지문을 WP-02로, 문단·시계열 형식을 WP-01로, `paras_sha`, `predicates.yaml`을 WP-01로, `predicates.d`를 WP-08로, 카탈로그는 `type_def`에서 |
| PLAN-07 | 계획 | WP-17 | `ops/bin/check-workflows` |
| PLAN-08 | 계획 | 구현 규칙 1 | worktree를 없애 원인이 사라졌다. 공유 `venv-dev`는 한 작업 트리라 안전하다 |
| PLAN-09 | 계획 | WP-00 | `UV_PYTHON_INSTALL_DIR`, `UV_PYTHON_DOWNLOADS=manual`, 인수 조건 1에 `uv lock`, `ops/bin/dev` |
| PLAN-11 | 계획 | 1장 공유 파일 변경, WP-00, WP-05 | 추가 의존 절차, `pypdf`, `cssselect` 고정, 평가 전용 `--with` |
| PLAN-12 | ADR, 계획, 계약 | ADR 7.2, 7.11. 계획 1장, WP-01. 계약 3장 | `ops.db` DDL, `evidence_state`, `support_check`, `link_status`, 변경 절차 |
| PLAN-13 | 계획 | WP-01, WP-03, WP-07, WP-21 | 이벤트 스키마 전수, `kb schema sync`, `kb sources sync`, `series.define`, `node_types` 조건 |
| PLAN-14 | 계획 | 1장, WP-00, WP-06, WP-07 | 패키지별 `KB_HOME`, `KB_TOOLCHAIN`, `wp-env.sh`, 실운영은 WP-21만, `src:test` 제거 |
| PLAN-16 | ADR, 계획 | ADR 18장. WP-00, WP-16 | `collect.session_tick` 기본 끔, `KB_JOB` 건너뜀 |
| PLAN-17 | ADR, 계획 | ADR 20.2, 23장 10. WP-17 | 기본 상한, 실행 형태 `kb-agent-run`, 표본 실행 조건 |
| PLAN-18 | 계획 | WP-21 | 첫날 L2까지로 자르고 남은 적체는 런북. 큐 잔량 보고 |
| PLAN-19 | 계획 | 1장, 2.1 | `null`을 패키지 ID와 함께 남김, `blocked`는 Review 제외, 파동 관문, 재시도 규칙 |
| PLAN-20 | 계획 | WP-11, WP-14, WP-16, WP-00 | 기준선 파일, lxml 검사, 스텁 `verify`, `.gitignore` 해시 비교 |
| PLAN-21 | 계획, ADR | 1장 전역 파일, 2.2, WP-00, WP-12, WP-16. ADR 23장 11 | 가짜 HOME과 가짜 `claude`, 해시 비교를 명령 직전·직후로, 실제 호출은 결정 11 |
| PLAN-22 | 계획 | 1장, 2.2, WP-14, WP-18, 7장 | `done_pending_user`, `gate` 필드, 평가기 시험과 골든 시험 분리, 완료 기준 정리 |
| PLAN-23 | 계획 | 2.3 CLI 표, WP-05, WP-06, WP-15, WP-19, WP-21 | JSON 필드 고정, `schemas/cli/`, `.data.items`, `.windows <= 1` |
| PLAN-24 | ADR, 계획 | ADR 5장, 7.7, 10.4. WP-07, WP-21 | pypdf, `needs_pdf`, `needs_ocr`, `sitemap`, `csv`, `html_index`, 소스별 문자 수 보고 |
| PLAN-25 | 계획 | 2.3, WP-05, WP-10, WP-12, WP-20, 7장 | `kb.rank.client`, `search(mode=)`, 강등 규칙 |
| CTR-01 | ADR, 계획, 계약 | ADR 7.5, 9장, 15.1, 15.2, 2장 F12. WP-01, WP-10, WP-12. 계약 2.10, 전 예시 | `e:<type>:<slug>`, 공개 ID 불변식, 형식과 경로 시험, MCP `ResourceSecurity` 면제 |
| CTR-02 | 계획, 계약 | WP-00, WP-10. 계약 2.3, 7장 | 자체 ASGI Host 미들웨어, 허용 목록 설정값, 404·405·500 problem+json |
| CTR-03 | 계획, 계약 | WP-11, WP-23. 계약 8장 | 기준선을 `docs/contracts/baseline/openapi.yaml`로. 없으면 실패. 초기 커밋 요청은 안 1에서 필요 없다 |
| CTR-04 | 계획, 계약 | WP-23 신설, WP-04, WP-05, WP-10. 계약 머리말, 3.1, 4장 | 계약 초안 패키지, 경로별 `data`, 파라미터 형식, 원본을 `openapi.yaml`로 통일 |
| CTR-05 | ADR, 계획, 계약 | ADR 7.4. WP-04, WP-07, WP-19. 계약 2.9, 4.7, 9장 | 기본은 관측축만, 미래 발효 대체 규칙과 효력일 작업 |
| CTR-06 | ADR, 계획, 계약 | ADR 7.2 `head`. WP-02, WP-04. 계약 2.7, 4.12 | 최신 버전 민감도로 판단, `visibility.revoked`, `test_sensitivity_raise` |
| CTR-08 | 계획, 계약 | WP-10. 계약 2.5 | `"<epoch>-<applied_seq>-<build_id>"` 통일, `/meta`는 `degraded` 포함, `test_etag` |
| CTR-09 | 계획, 계약 | WP-04, WP-10. 계약 4.1, 4.12, 5장 | `changes_cursor`, 커서에 `epoch`, 꼬리 문자열, 생략은 seq 0 |
| CTR-10 | 계획, 계약 | WP-04, WP-05. 계약 2.4, 4.4 | `id` 정렬만 안정, 검색 커서 순위 위치, `/v1/nodes` 기본 `id` |
| CTR-11 | ADR, 계획, 계약 | ADR 16장. WP-04, WP-10. 계약 4.1, 4.3, 10.3, 11장 | 기본 상한 5만·20만, 커서로 끝까지, 상태 표시 수정 |
| CTR-12 | 계획, 계약 | WP-10. 계약 5장 | `group` 기준 프로필, 포함 규칙, `merged_into`, `application/zstd`, `sha256` 기준, 503 |
| CTR-14 | ADR, 계획, 계약 | ADR 7.2 `span_facet`. WP-02, WP-05, WP-10. 계약 4장, 4.9 | `source_id` 열과 색인, `source`, `author` 필터, 자기 축 규칙, 부하 시험 |
| CTR-15 | 계획, 계약 | WP-04. 계약 4.7, 10.2 | `versions`, `chains`, `predicate` |
| CTR-16 | 계획, 계약 | WP-04. 계약 3.1, 4.5, 4.6, 6.3 | `claims`, `edges`, `body` 경로, 상한과 `truncated`, `Backlink`, 이웃 기본 타입 |
| CTR-17 | ADR, 계획, 계약 | ADR 7.5, 7.2. WP-02, WP-04. 계약 2.7, 2.10 | ID 불변, 읽기가 `merged_into_final`로 묶음, 연쇄 병합 시험 |
| CTR-18 | 계획 | 2.3, WP-04, WP-05, WP-10, WP-20 | `get_claim`, `get_edge`, `meta`, `tickets`, `search_facets`, `kb token`, `degraded` 담당, 경로별 시험, 부하 시험을 추정 규모로 |
| CTR-19 | ADR, 계획 | ADR 7.7. WP-07 | `text_quote` + `start`, `end`. 줄 번호는 내부 계산만 |
| CTR-20 | 계획, 계약 | WP-11. 계약 9장 | ajv, yaml 고정 패키지, `fixtures/cas/`, `mcp/`, 결정적 `build_id`, 경로별 규칙 |
| FACT-02 | ADR | 23장 1, 23.1~23.3, 10.4 | 양자택일 문장을 경로표로 교체, 조항, 위반 결과, III.L 조건, 선택지별 결과 |
| FACT-05 | ADR | 10.4, 23장 9 | `tos` 등급 정의와 배정, `forbidden` 비활성, `signals_conflict`는 고지 뒤 활성. D20 비활성 |
| FACT-07 | ADR, 계획 | ADR 4장, 15.1. WP-12 | 신호 핸들러에서 분리 실행, `test_signal_ship`, 실제 종료 시험 |

### 3.2 사용자 결정 항목

| 결함 ID | 문서 | 위치 | 변경 |
|---|---|---|---|
| PLAN-26 | ADR, 계획 | ADR 17.1, 17.2, 22장, 23장 13. WP-13 | 기본을 작업 트리까지로 고치고 로컬 커밋은 결정 13 뒤 `export.local_commit`으로만 켠다 |
| CTR-07 | ADR, 계획, 계약 | ADR 7.2, 7.9, 23장 14. WP-03, WP-04. 계약 2.8, 11장, 13장 | 결정 14로 올렸다. 기본은 (c). 소유자 CLI는 `kb owner read`(WP-03), `kb api`는 `viewer` 범위로 정했다 |
| FACT-06 | ADR | 23.4, 23.3 | 키 선택 시 재검토 소스와 쟁점을 적었다. 판단은 사용자 몫 |

### 3.3 minor

| 결함 ID | 문서 | 위치 | 변경 |
|---|---|---|---|
| RULE-25 | ADR, 계획 | ADR 10.4, 11장. WP-07 | 111개 ID를 표로 분류, `semiannual` 추가, 어댑터 추가, `test_registry` 전 ID. 표 기계 생성은 미반영 |
| RULE-26 | ADR | 10.4, 23장 9 | `tos: unverified`, 목록을 결정 9에 올렸다(결정 1에서 분리) |
| RULE-27 | ADR, 계획 | ADR 15.1. WP-16, WP-17 | `.mcp.json`에서 `kb-collect` 제거, 작업 전용 설정으로 |
| RULE-28 | ADR, 계획 | ADR 20.2. WP-17 | 공통 규칙 블록과 시험 |
| RULE-29 | ADR, 계획 | ADR 5장, 부록 C. WP-03 | gitleaks, detect-secrets, TruffleHog 조사. Gitleaks 규칙 고정 |
| RULE-30 | ADR | 15.1, 21장 | 회고는 운영 문서이고 색인 금지. `kb_status` 커버리지를 건수로 |
| RULE-31 | 계획 | 1장, WP-00, WP-12, WP-14 | 전역 해시 비교 제거 또는 직전·직후로 축소 |
| RULE-32 | ADR, 계획 | ADR 10.3. WP-06 | `needs_contact` 소스만 지정 연락처 분기 |
| RULE-33 | ADR, 계획 | ADR 10.3, 23장 8. 계획 승인 경계 | `gh api graphql` 예외 명시, 승인 표에 올림 |
| RULE-34 | 계획, ADR | WP-22, ADR 2장 | BLK-05와 같다 |
| RULE-35 | ADR, 계획 | ADR 19.1, 21장. WP-18 | `.state/rtk/history.db` 행 수 지표 |
| BLK-20 | ADR, 계획 | ADR 10.3. WP-06 | 전체 마감 시각, 주소 종류 거부, `test_fetch_guard` 확대 |
| BLK-21 | ADR | 2장 공통, F4, 3장 | 근거 표기를 R1, R12와 `:memory:`로 정정 |
| BLK-22 | 계획 | WP-02, WP-04, WP-07, WP-13, WP-16 | `test_fact_edges`, `test_valid_precision`, `test_marks`, `test_conflicts`, `test_retention`, SessionEnd `timeout` 검사 |
| BLK-23 | ADR, 계획 | ADR 7.6. WP-19 | `feed`, `short` 소스는 철회하지 않는다 |
| BLK-24 | ADR, 계약, 계획 | ADR 14.1, 24장. 계약 4.8. WP-05 | 문구를 줄이고 표본에 넣었다. 색인 확장은 하지 않았다 |
| BLK-25 | ADR, 계획 | ADR 7.9. WP-03 | 값 형태로 좁힘, 전 문자열 필드 검사, `kb secret release` |
| BLK-26 | ADR, 계획 | ADR 8장. WP-02, WP-03, WP-07, WP-08, WP-16, WP-17 | 7건 전부 맞췄다. `kb-collect`, 체크포인트 임계, 줄 위치, 도구 범위, `test_swap_real`, `rg` 범위, `test_hold_rate` |
| PLAN-27 | ADR, 계획 | ADR 10.4, 12장. WP-06 | RULE-04와 같다. U08의 Feedburner 리다이렉트 표기 |
| PLAN-28 | ADR | 10.4, 11장 | RULE-25와 같다 |
| PLAN-29 | 계획 | WP-00 | `--all-extras`, `perf` 마커, `.pytest_cache/`. worktree 폴더는 필요 없어졌다 |
| PLAN-30 | 계획 | 3장 | 의존 추가, WP-18을 파동 9로 |
| PLAN-31 | 계획 | WP-00, WP-03, WP-10, WP-13, WP-14, WP-17, WP-19 | 주인 없는 항목을 전부 배정 |
| PLAN-32 | 계획, ADR | WP-05, WP-06, WP-08, WP-16, WP-17, WP-21, 2.2. ADR 7.8, 9.3, 14.1 | 별칭 TOML, `--batch`, `--no-fetch` 의미, `WP_REVIEW`, 세션 값, 시드, `openapi.yaml` 초안 |
| CTR-21 | 계약, 계획 | 계약 3장, 4.5, 4.7, 4.8. WP-23 | 예시와 스키마 수정, `EdgeRef`, 하이라이트 값 정정. 자동 검증은 WP-23 시험 |
| CTR-22 | ADR, 계약, 계획 | ADR 7.1, 7.2, 7.4, 10.5, 22장. 계약 2.10. WP-02, WP-04, WP-19 | enum 규칙 정리, `gold_schema`, `extract_schema`, 값 목록 |
| CTR-23 | ADR, 계약, 계획 | ADR 7.3, 8장, 15.1. 계약 4.3, 6장. 계획 2.3 | 응답 필드 통일, 개요 제외 5종, `Series` 포함, `evidence_state`, HTTP 쓰기는 v1에 없음 |
| CTR-24 | ADR, 계약, 계획 | ADR 16장. 계약 1장, 10.1, 13장. WP-10, WP-14 | `loupe serve`, tower 반영, TCP를 선택 유닛으로. 소비자 문서는 미반영 |
| CTR-25 | 계약, 계획 | 계약 2.3, 4.8. WP-05, WP-10 | 405, 416, 500, `token_invalid`, `content_removed`, 빈 토큰 `q`, `tombstone` 상태 |
| CTR-26 | ADR, 계약, 계획 | ADR 7.3. 계약 2.7, 3장. WP-02, WP-04 | 엣지 민감도 최댓값, 개수에 숨김, 직접 조회 규칙 |
| CTR-27 | ADR, 계약 | ADR 7.2, 7.4. 계약 2.2, 2.9 | as-of 상태, `/history`, `type_def`, 날짜 입력, `to:null` |
| CTR-28 | ADR, 계약, 계획 | ADR 7.7. 계약 2.11, 4.8, 4.11, 12장. WP-07 | `text_format`, PDF, JSON 기준, `/text` 단위, `passage` 필드 |
| FACT-09 | ADR | 10.4, 23.1 | P09를 Explore, 내부 API, RSS로 나눔. P04 사유 정정 |
| FACT-10 | ADR | 10.4 | D05 사유에 반대 신호 병기, `signals_conflict` |
| FACT-11 | ADR | 10.4, 11장 | U03, U16을 비활성으로. 경로 확인은 미반영 |
| FACT-12 | ADR, 계획 | ADR 10.5. WP-19 | 경로 고정, 값 없음은 시작 안 함 |
| FACT-13 | ADR | 23장 2 | R2 무료 구간, 초과 과금, 결제 수단(2차), 1년차 약 7 GB(추론) |
| FACT-14 | ADR, 계획 | ADR 2장 F11. WP-19 | 카나리아가 전체 플래그로 1회, 표현 정정 |
| FACT-15 | ADR | 24장 | 두 문구 병기 |

## 4. 미반영과 범위 밖

| 항목 | 이유 | 다음 |
|---|---|---|
| BLK-05, RULE-34의 실제 복사 | 이번 단계는 문서 편집이고 지정 산출물 밖을 쓰지 않았다. 재료는 아직 세션 tmpfs에만 있다 | WP-22를 가장 먼저 돌린다. 재부팅 전에 끝내야 한다 |
| CTR-24의 소비자 문서 5, 27, 100행 | 지시가 ADR, 계획, 계약으로 한정했다. 수신 기록이기도 하다 | sagae-tools 세션에 정정을 요청한다 |
| RULE-25의 ADR 표 기계 생성 | 코드가 없다. 표는 손으로 맞췄다 | `test_registry`가 표 대신 레지스트리를 시험한다 |
| CTR-21의 예시 자동 검증 | 스키마 원본이 아직 없다 | WP-23 시험 |
| BLK-24의 색인 범위 재측정 | 어휘 경로 재측정이 필요하다. 문구만 줄였다 | 표본 고정 뒤 필요하면 재측정 |
| FACT-11의 U03, U16 경로 | 이번 단계에서 경로를 찾지 못했다. O02 `llms.txt`에 U03이 등재된 것만 다시 확인했다 | 경로 확인 뒤 결정 9로 켠다 |
| BLK-10의 비동기 투영 비교 | 구현이 있어야 잰다 | WP-03 `test_perf` |
| sagae-tools 2차 회신 `docs/contracts/consumers/sagae-tools-reply-2.md` | 편집 중(22:48)에 도착했고 이번 결함 목록 밖이다. 공백 1, 3, 4, 6~10, 14는 계약 0.2.0이 이미 다룬다. 회신은 고치기 전 계약(`49fb5365…`)을 대조했다. 공백 2, 5, 11~13, 15~20과 남은 요청 6건은 반영하지 않았다 | 다음 계약 판. 공백 16~20은 KB의 답을 기다린다 |
| CLAUDE.md 33행(22:40 추가) | 다른 프로젝트 세션의 조사 자료 관리, 접수 대장 `docs/intake/session-research.md`. 편집 중에 추가됐고 ADR, 계획에 경로가 없다 | 설계 반영 여부를 메인 세션이 정한다 |

## 5. 편집 중 새로 고친 것

감사 목록에 없지만 수정안을 합치며 생긴 어긋남이다.

| 항목 | 내용 | 변경 |
|---|---|---|
| MCP 리소스 | CTR-01 수정안이 `kb://node/{id}`에서 실패한다(2장) | WP-12, ADR 15.1에 `ResourceSecurity` 면제 |
| 같은 트리의 임포트 | 안 1에서는 옆 패키지가 쓰는 중인 `commands/*.py`가 다른 패키지의 CLI를 깬다 | `cli.py`, tick 탐색이 임포트 실패를 건너뛴다 |
| 레지스트리 로더 | PLAN-03 뒤에도 `load_registry`가 WP-07이라 WP-06이 먼저 쓸 수 없다 | WP-06으로 옮겼다 |
| 같은 파동 시험 | WP-13, WP-03 시험이 뒤나 같은 파동의 `kb tick`에 기댔다 | 시험을 WP-06으로 옮기거나 단계 함수를 직접 부른다 |
| 판정 투영 비용 | `eff_status` 버전 행이 게이트 보유를 늘린다 | 문단 예산에 포함, 24장에 미측정 기록 |
| 패키지별 `KB_HOME`과 툴체인 | 패키지마다 Python을 내려받게 된다 | `KB_TOOLCHAIN`, `KB_MODELS`로 분리 |
| Ko-StrategyQA 변환본 | 라이선스 미확인 데이터를 저장소에 넣게 된다 | 저장소 밖 `runtime/eval-data/`로 |

## 6. 재확인 반영 회차

구축 전 마지막 수정이다. `audit-final-recheck.md`의 RC-01~RC-26, 부분 반영 FACT-02, FACT-05, 첫 적재 패키지, 세션 조사 자료 패키지, `sagae-tools-reply-2.md` 공백 15~20을 ADR과 계획에 넣었다. 계약은 다음 단계가 맡으므로 건드리지 않았다. 판단이 필요한 항목은 기본값으로 정했고 ADR 23장 결정 번호는 그대로다. 위치는 고친 뒤의 절과 패키지다.

### 6.1 기계 검사

재확인의 스크립트 사본으로 다시 돌렸다.

| 검사 | 결과 |
|---|---|
| 패키지, 파동 | 3장 표, 4장 절, 파동 표 27개 일치. 11단계(0~10). 순환 0, 파동 위반 0. 각 패키지가 의존 최장 경로와 같은 파동이다 |
| 소유 경로 | 222개, 고유 222개, 접두 포함 겹침 0 |
| 2.3 모듈, tick 단계, `schemas/cli/` | 전부 소유 패키지 경로 안에 있다. 하위 명령 `kb intake`, `kb drill`도 주인이 있다 |
| 인벤토리 | 소스 111개가 활성 50(M21 제외), 결정 대기 11, 비활성 50. 활성 전부 등급이 있고 이중 등급 0, 활성 `forbidden` 0 |
| 6장 시험 이름 | 전부 해당 패키지 절에 있다 |
| 인수 조건의 맨 `kb` | WP-21, WP-25 밖 0건. 둘 다 지시에서 `$KB_HOME/runtime/bin/kb`로 정의한다 |
| 전이 의존 밖 사용 | WP-14의 `kb jobs`는 정적 검사와 입회 시험뿐이다. WP-02의 `kb.write`는 다른 패키지를 가리키는 문장이다 |
| ADR DDL | SQLite 3.53.1에서 7.1, 7.2, 7.11 실행. 표 4, 17, 15개. `change`의 같은 `seq` `sub` 0, 1 두 행 삽입 성공 |
| JSON 예시 | ADR 4, 계약 18, 계획 1. 파싱 오류 0 |
| 2.1 골격 | `node --check` exit 0. 가짜 런타임 실행에서 소유 경로 밖 쓰기가 `incidents`로 나오고 `bytes=0` 스냅샷은 파동을 시작하지 않는다 |
| 앵커 회귀 | 앵커 606개 중 4개 실패. 전부 이번에 고친 문구다: `0) ops/bin/deploy`, `ops/bin/deploy 후`, `WP-21만 쓴다`, `--nodes 50000 --edges 200000` |
| Gitleaks 규칙 | v8.30.1을 Python 3.14에서 다시 확인. 222규칙, 199 컴파일, 22 플래그 이동, 1 경로 전용, `path` 규칙 5개, `entropy` 130, 규칙별 allowlist 9 |
| 접수 자료 경로 | 대장의 경로가 전부 있다. `journal.jsonl`의 `type=result` 줄에는 `label`이 없어 `key`로 `started` 줄과 이어야 한다 [재현] |

### 6.2 재확인 결함

| ID | 문서 | 위치 | 변경 |
|---|---|---|---|
| RC-01 | 계획 | WP-21 | `test_dead_seed`, `test_audit_record`에 `[결정 10, 11 뒤]`. 첫 조건을 `test_batch_def`로 지정. 결정 전 대체 조건 `test_dead_default`. 결정 11이 없으면 4~7단계를 건너뛰고 8단계 결과 절을 쓴다 |
| RC-02 | ADR, 계획 | ADR 6.1, 6.2, 18장, 20.2, 20.3, 21장. WP-00, WP-14, WP-17, WP-18 | 에이전트 실행 파일 4종을 배포 사본에 넣는다. `kb-agent-run`이 `share_dir()`에서 돈다. 래퍼가 `KB_HOME`, `KB_CLAUDE_BIN`을 내보낸다. 회고는 `$KB_HOME/ops/retro/`. 입회 시험 6번, `test_jobs`에 저장소 밖 실행 |
| RC-03 | ADR, 계획 | ADR 7.2, 7.11, 9.1, 9.2, 10.4. WP-02, WP-04, WP-05, WP-15, WP-19 | `node.domain`, `span.domain`을 없애고 `node_domain` 표를 둔다. 필터는 포함 일치, 응답은 배열, 집계는 값마다. `queue.domain`은 순환 키. 시험 `test_domain` 2건, `test_by_domain` |
| RC-04 | ADR, 계획 | ADR 9.2. WP-06, WP-08 | `src:adhoc`는 `trust=unknown`. 대상 자신의 공식 위치일 때만 1차로 인정하는 규칙, `test_policy_items` |
| RC-05 | ADR, 계획 | ADR 7.8, 8장, 15.3, 24장. WP-26, 7장 | 패키지 신설(6.4) |
| RC-06 | 계획 | WP-00 | `--extra serve --extra collect` 명시. 임시 `KB_HOME` 실제 배포와 `kb doctor`, 임포트 시험 |
| RC-07 | 계획 | WP-00 | 조건 2를 `ops/bin/dev python -I`로 |
| RC-08 | 계획 | 1장, 2.1 | `.tar.gz`, 파동 0 기본 경로, `bytes > 0`, `snap.incidents` 합산, `outside` 대조를 골격에 넣었다 |
| RC-09 | ADR | 10.4, 23장 9 | 활성 소스 전수 등급. D01과 11개를 `unverified`로, `d2.naver.com`을 `signals_conflict`로 |
| RC-10 | ADR, 계획 | ADR 23.1~23.3. WP-24 | III.I.15, 댓글 작성자 조항, 양자택일 문구 교체. 사실표 1.4는 읽기 전용이라 그대로다 |
| RC-11 | 계획 | WP-02, WP-04 | `build_id` 정의를 WP-02로. `g-<seq>-<해시>`, 코드 해시 제거, 빌드 디렉터리 이름과 분리 |
| RC-12 | 계획 | WP-10 | `degraded`는 `/v1/meta`로 한정. 불변 ETag 경로는 삭제를 먼저 본다 |
| RC-13 | ADR, 계획 | ADR 7.2. WP-02, WP-04 | `change` 키를 `(seq, sub)`로. 같은 `seq` 행은 한 쪽에 함께 |
| RC-14 | ADR, 계획 | ADR 7.6, 7.11, 10.6. WP-08 | 생산자 문구를 `queue(kind=live)`로 고정 |
| RC-15 | ADR, 계획 | ADR 7.1, 8장. WP-01, WP-02 | `system.projection_released` 추가. 건너뛸 집합에서 뺀다 |
| RC-16 | ADR, 계획 | ADR 17.4. WP-13 | `kb drill restore`가 `schema.epoch_bumped`를 쓴다 |
| RC-17 | 계획 | 3장, WP-21, WP-12 | WP-21 의존에 WP-10. `test_claude_real`은 `ops/bin/dev kb-mcp`를 가리키는 임시 설정 |
| RC-18 | 계획 | 1장, WP-00, WP-14 | `wp-env.sh`의 실운영 값. `WP-14 --live` |
| RC-19 | ADR, 계획 | ADR 0장, 15.1, 20.2. WP-12, WP-17 | `kb-verifier`를 `kb-collect` 프로필 읽기 도구로. 프로필에 `kb_get`을 더해 8개. `test_tools_scope`가 도구 실재를 본다 |
| RC-20 | 계획 | WP-17 | `agent_lost` 추가 |
| RC-21 | 계획 | WP-06, WP-07, WP-24 | `host_allow`를 로더로. `test_registry`는 overlay 없는 기본 레지스트리, WP-24는 `test_overlay` |
| RC-22 | 계획 | WP-22 | `.txt` 추가 |
| RC-23 | ADR | 23장 10 | 실제 실행은 결정 10 기록 뒤로 맞췄다. 상한 기본값은 20.2 그대로다. 계획의 승인 표, `[결정 10, 11 뒤]`와 같다 |
| RC-24 | ADR, 계획 | ADR 5장. WP-03 | POSIX 클래스, 경로 규칙, `entropy`, allowlist 규칙, `test_secret_rules` |
| RC-25 | 이 문서 | 6.6 | 4장의 "계약 0.2.0이 이미 다룬다"는 조금 넓다. 공백 4의 `origin`, 공백 7의 `subject`와 접두어 일치, 공백 10의 `g-`와 `p-` 관계는 계약에 없다. 다음 계약 판 목록에 넣었다 |
| RC-26 | ADR, 계획 | ADR 21장. 7장 | 운영 문서로 분류하는 기본값을 정하고 완료 보고에 적는다. 결정 표에 올리지 않았다 |
| FACT-02 | ADR | 23.2, 23.3 | RC-10으로 끝냈다 |
| FACT-05 | ADR | 10.4, 23장 9 | RC-09로 끝냈다 |

### 6.3 합치며 새로 고친 것

| 항목 | 내용 | 변경 |
|---|---|---|
| 같은 파동의 배포 | WP-25, WP-21이 작업 트리에서 배포하면 같은 파동 패키지가 쓰는 중인 코드가 실운영 tick으로 들어간다 | `ops/bin/deploy --from-snapshot`. 스냅샷은 앞 파동까지의 코드다 |
| 첫 gold | 빈 실운영 경로에는 `current`가 없어 `project_tail`과 지문 비교가 설 곳이 없다 | 첫 빌드는 빈 원장에서 돌고 지문 비교를 건너뛴다. WP-21, WP-25, WP-26이 먼저 부른다 |
| Review 재실행 | Review가 tick 조건을 다시 돌리면 만기 전 소스를 건너뛰어 소스 수 조건이 실패한다 | 소스 수 조건을 빼고 누적값은 `kb status`로 본다. `kb intake`는 `new_events`만 이번 실행 값이다 |
| 보류 주장의 수 | G 단위 주어의 L1 주장은 `kb live run` 전까지 `needs_review`라 활성 수 문턱이 주어 타입에 기댄다 | `counts.claims_review`를 더하고 조건을 활성 + 보류 합으로 |
| 비 TTY `kb put` | 작성자가 정의되지 않았다 | `agent:cli` |
| 옛 배포 삭제 | 살아 있는 자식이 옛 `venv-<id>`를 쓴다 | 2세대 보존, 시작 때 `share_dir()` 고정 |
| 티켓의 URL | `kb_request`의 `url`은 하나인데 병합 규칙이 없다 | 병합되면 `urls`에 쌓이고 많은 티켓은 다음 실행이 잇는다 |

### 6.4 신설 패키지

| 패키지 | 파동 | 의존 | 내용 |
|---|---|---|---|
| WP-25 첫 적재 | 7 | WP-05, WP-07, WP-08, WP-15 | 실운영 배포, 결정 없는 활성 소스의 L0, L1 1회 tick, `kb search`와 `kb status` 조회. 어떤 패키지도 의존하지 않는다. WP-21이 멱등하게 잇는다 |
| WP-26 세션 조사 자료 흡수 | 8 | WP-03, WP-12 | 대장 전 항목을 `f:agent` 기록 또는 제외로 처리, 1차 출처 URL을 티켓 `urls`로 등록, 내부 정보 제거, 비밀 탐지, `kb_put`, `kb_request`와 같은 규칙 |

WP-25의 의존 폐포는 WP-00, 22, 01, 23, 02, 03, 04, 05, 06, 13, 07, 15, 08이다. 3장이 적었던 최단 경로 외에 조회(WP-04, WP-05), 상태(WP-13, WP-15), `gate_l1`(WP-08)이 든다. WP-08을 뺀 파동 6 배치도 가능했지만 L1 주장이 생존 입장 없이 지울 수 없는 원장에 들어가 RULE-07이 되살아난다. 그래서 첫 데이터가 한 파동 늦다.

### 6.5 sagae-tools 공백 15~20

| 공백 | 결정 | 위치 |
|---|---|---|
| 15 부하 | 웜 목표 유지. 노드 40만, 엣지 150만, 문단 15만, 개요 5만·20만으로 잰다. 콜드는 유휴 종료 뒤 첫 요청 p95 1초, 개요 4초(초기값) | ADR 16장. WP-10 부하 조건 |
| 16 세션 귀속 | 프로세스 귀속을 받아들인다. tower는 `KB_MCP_SESSION=tower`. 세션 표시는 `record.props.session`이고 판정에 쓰지 않는다 | ADR 7.8. WP-12 `test_attribution` |
| 17 EOF 전송 | 신호와 EOF가 같은 함수를 1회 부른다. 다른 세션은 15분 tick으로 충분하다 | ADR 15.1. WP-12 `test_eof_ship` |
| 18 긴 수명 | `current` 교체와 옛 빌드 정리는 호출을 깨지 않는다. `KB_MCP_SUPERVISED=1`이면 배포를 감지해 유휴에서 끝난다 | ADR 15.1. WP-12 `test_long_lived` |
| 19 `cur` | 계약 2.4 커서 그대로다. 서버 상태가 없다 | ADR 15.2. WP-04, WP-12 `test_cursor` |
| 20 tower | `upstreams.kb` 출력, `autoApprove` 읽기 도구 6개, `kb_put`, `kb_request` 확인과 `-p` 거부는 이대로, 민감도 상한 `internal` 고정 | ADR 7.9, 15.4. WP-12 `test_sensitivity_cap`, 설정 출력 조건 |

### 6.6 계약 단계로 넘기는 항목

ADR이 정했고 계약 문구가 뒤따라야 한다. WP-23 전에 끝나야 파괴 변경을 피한다.

| 항목 | 근거 | 계약 위치 | 변경 |
|---|---|---|---|
| `domain` 배열 | RC-03 | 3장, 4장, 4.9, 5장 | 문자열을 배열로, 필터 포함 일치, 패싯 값별 집계, export 열 |
| `source.trust` | RC-04 | 2.10 | `unknown` 추가 |
| `build_id` | RC-11 | 2.1 | "재구축 때 바뀐다"를 재생 입력 기준으로 |
| ETag 문장 | RC-12 | 2.5 | 봉투 `data`로 한정, 불변 경로는 삭제 먼저 |
| 변경 피드 | RC-13 | 4.12 | 같은 `seq`의 `visibility.revoked`, 한 쪽에 함께 |
| 공백 4, 7, 10 잔여 | RC-25 | 4.12, 4.8, 5장 | `origin`, `subject`와 접두어 일치, `g-`와 `p-` 관계 |
| 콜드 행과 규모 | 공백 15 | 4장, 10.3 | 6.5 값 |
| 공백 16~20 답 | 6.5 | 6장, 10.1, 13장 | KB 결정 기록과 sagae-tools 회신 |
| 세션 제출 규칙 | RC-05 | 6.1 | `record.props.session`, 세션 조사 자료 |
| 공백 2, 5, 11~13, 남은 요청 6건 | 4장 | 여러 곳 | 이번 회차 범위 밖이다 |

### 6.7 처리하지 않은 것

| 항목 | 이유 | 다음 |
|---|---|---|
| 사실표 1.4의 양자택일 문구 | `audit-final-*.md`는 읽기만 한다 | ADR 23.3이 정본이다 |
| WP-22 실제 복사 | 문서 단계다. 재료는 아직 tmpfs에 있다 | 구축 첫 단계. 재부팅 전에 돌린다 |
| 접수 사본 삭제 | 대장은 적재 뒤 지운다고 적었지만 결정 3 전에는 사본이 1벌이다 | WP-26이 결정 3 뒤로 미뤘다 |
| `intake-deny.txt` 값 | 노드 이름 목록은 저장소에 둘 수 없고 사용자가 정한다 | 없어도 돈다. 내부 정보가 섞인 문서는 본문을 저장하지 않는다 |
| 콜드 목표 1초, 4초 | 근거는 프로토타입 콜드 p50 150 ms뿐이다 | WP-10 측정 뒤 계약 값을 확정한다 |
| tower 동작 | 공백 17, 20의 값은 sagae-tools 측 바이너리 읽기이고 KB가 재현하지 않았다 | 결정 7과 관제 서버 뒤 |
| `docs/adr/0002-user-decisions.md` | 이 회차 중(23:53)에 다른 세션이 쓴 사용자 결정 기록이다. 지시 범위 밖이라 읽기만 했다. ADR 23장의 결정 상태, 머신 밖 대상, "구독 `claude -p`만" 전제(R14, 10.5, WP-19)는 아직 옛 서술이다 | 별도 단계에서 반영한다. WP-25는 결정과 무관해서 영향이 없다 |
| 결정 9 답의 범위 | ADR-0002의 "전부 켬"은 이 회차 전 목록에 대한 답이다. RC-09로 `signals_conflict`에 `d2.naver.com`이, `unverified` 표시에 12건(D01, L03~L05, M21, O10, U05, U08, U09, U11, U14, U15)과 G4 npm 패키지가 더해졌다. `unverified`는 원래 활성이라 동작이 같고 `d2.naver.com`만 새로 켜진다 | 메인 세션이 사용자에게 알린다 |

### 6.8 부수 효과

| 대상 | 내용 |
|---|---|
| 저장소 | ADR, 계획, 이 파일만 고쳤다. 계약, ADR-0002, `docs/research`, 다른 감사 문서, 대장, CLAUDE.md는 그대로다. 커밋 없음 |
| 외부 요청 | `raw.githubusercontent.com`의 Gitleaks 규칙 1건과 robots.txt 1건(404). 개인 정보를 넣지 않았다. 유튜브, 자동완성, InnerTube, yt-dlp는 호출하지 않았다 |
| 로컬 읽기 | 접수 자료의 경로와 구조, `sagae-tools/docs/design/tower.md`를 읽기만 했다. 다른 저장소를 고치지 않았다 |
| 작업 파일 | `~/.cache/sagae-kb/scratch/prebuild/`. 수정 스크립트와 베이스 사본이다 |
| 전역 파일 | `~/.claude`, `~/.claude.json`, 셸 프로필, crontab, systemd, rtk·trail 상태 변경 없음. rtk, trail, `claude`는 실행하지 않았다 |
| 사고 | 없다 |

## 7. 계약 0.3.0 회차

구축 전 마지막 문서 수정이다. `sagae-tools-reply-2.md`의 42건과 6.6에서 넘긴 항목을 계약 0.3.0에 넣고 ADR, 계획을 맞췄다. 판단이 필요한 항목은 기본값으로 정했고 ADR 23장 결정 번호는 그대로다. 항목별 처리는 `docs/contracts/consumers/sagae-tools-reply-2-response.md`다. 수용 40, 변경 2, 거절 0이다.

### 7.1 먼저 가린 것

회신은 계약 `49fb5365…`를 대조했다. 지금 계약 `55dd7c1c…`와 ADR이 이미 처리한 것은 문구만 확인했다.

| 항목 | 상태 |
|---|---|
| 공백 1, 6, 14 | 0.2.0 반영. 공백 14의 `{24,29}`는 스크립트로 `8,000`임을 확인했다 |
| 공백 16~20 | ADR 7.8, 7.9, 15.1, 15.2, 15.4의 결정을 응답표에 그대로 옮겼다 |
| 공백 15 | ADR 16장, WP-10에 반영돼 있었다. 계약 4장에 행을 넣었다 |
| 공백 2의 `kb.read` 표 | 계획 2.3에 이미 있었다 |
| 나머지 | 공백 4, 7, 10은 RC-25의 잔여만 처리했다 |

### 7.2 기본값으로 정한 것

| 항목 | 기본값 | 이유 |
|---|---|---|
| 동시 상한 | 기본 16, 하한 12, ASGI 미들웨어 | 소비자 요구가 12 이상이다. uvicorn `limit_concurrency`는 연결까지 세고 503 `text/plain`이다(로컬 uvicorn 소스 확인) |
| 개요 기본 타입 | 타입 파일 `x-kb-overview`에서 `overview_types`로 낸다. 이웃은 제외 5종만 뺀다 | 목록을 코드에 두면 `count`로 조정할 수 없다. 이웃까지 좁히면 개요에 없는 타입으로 확장할 수 없다 |
| 조정 시점 | 1차 수집 뒤. 기준은 `limit=10000&edge_limit=50000`의 `truncated=false` | 지금은 `count`가 없다. WP-21 결과 절에 적고 `true`면 WP-03 변경 요청이다 |
| 접두어 일치 | 검색에 넣지 않고 `filter=label:prefix:`로 낸다. `node_label` 부분 색인을 더했다 | 색인이 전체 토큰이다. 문법에 이미 `prefix`가 있어 새 파라미터가 없다 |
| `/v1/nodes/{id}`의 ID별 모양 | `Node` + 묶음 + 해당 ID일 때 `claim`, `snapshot`, `series` | 소비자가 응답 `type`으로 화면을 나눈다. 변형 8개의 `oneOf`보다 작다 |
| `oneOf` 형식 | 변형 맨 위 `const`, `mapping` 없음 | `allOf` 안의 `const`와 `mapping`을 ajv 8.20.0이 거부한다 |
| `no-store` 범위 | `/v1/nodes/{id}`, `/body`, `/v1/search`, `/text`, `/raw`, `/v1/ops/*` | loupe가 노드 상세와 본문을 `no-store`로 부른다. 검색 스니펫도 본문 조각이다 |
| `ids=` | `/v1/nodes`에 최대 100개, 직접 조회 규칙, 숨김과 없는 ID는 빠짐 | 새 경로가 없다. 경로 수 26개를 유지한다 |
| 이웃 엣지 상한 | `edge_limit` 기본 2,000, 최대 10,000. 시작 노드는 남긴다 | loupe가 미정이라 적었다. `id` 절단이 시작 노드를 지울 수 있었다 |
| 문서, 근거 ID | `d-`, `ev-` 결정적 해시 | `Document`는 ID 형식과 생산자가 없었고 `Evidence.id` 안정성이 공백 12다. ADR 7.5, WP-01, WP-02에 넣었다 |
| 카드 민감도 | 표시 기호 `internal`. 칸을 늘리지 않는다 | `public`이 대부분이라 예산이 거의 들지 않는다 |
| `full` 프로필, `/v1/counts` | 소비자 없이 남긴다 | 지우면 WP-10을 다시 설계한다. 새 설계를 벌이지 않는다 |

### 7.3 6.6에서 넘긴 항목

| 항목 | 계약 위치 | 처리 |
|---|---|---|
| `domain` 배열(RC-03) | 3장, 4장, 4.9, 5장 | 파괴 변경 |
| `source.trust`(RC-04) | 2.10 | `unknown` 추가 |
| `build_id`(RC-11) | 2.1, 2.6 | 재생 입력 기준으로 고쳤다 |
| ETag 문장(RC-12) | 2.5 | 봉투 `data`로 한정, 불변 경로는 삭제 먼저 |
| 변경 피드(RC-13) | 4.12 | 같은 `seq`, 한 쪽에 함께, `limit` 1행 초과 가능 |
| 공백 4, 7, 10 잔여(RC-25) | 4.12, 4.8, 4.4, 5장 | `origin`, `subject`, 접두어, `g-`와 `p-` |
| 콜드 행과 규모 | 4장, 10.3 | 6.5 값 |
| 공백 16~20 답 | 6.1, 13장, 응답표 | ADR 결정 |
| 세션 제출 규칙(RC-05) | 6.1 | `record.props.session`, 세션 조사 자료 |
| 공백 2, 5, 11~13, 요청 6건 | 여러 곳 | 처리했다 |

### 7.4 계약을 고치며 맞춘 곳

| 문서 | 위치 | 변경 |
|---|---|---|
| ADR | 머리 표기, 1.3, 5장, 7.2, 7.3, 7.5, 7.9, 14.1, 15.2, 16장, 23장 14 | 14건. 결정 번호 그대로다 |
| 계획 | 2.3, WP-01, WP-02, WP-03, WP-04, WP-05, WP-10, WP-11, WP-21, WP-23, 6장 | 31건. WP-10에 `src/kb/serve/limits.py` 소유 경로를 더했다. WP-01~05, WP-21은 지시에 없었지만 같은 값을 쓰므로 맞췄다 |
| 시험 | WP-04 `test_nodes`, `test_table`, WP-05 `test_hit_kinds`, WP-10 `test_limits`, WP-23 `orval-check.sh` | 새 조건. openapi-typescript 조건을 뺐다 |

### 7.5 기계 검사

스크래치(`~/.cache/sagae-kb/scratch/prebuild/contract-0.3/`)에서 계약 3장 YAML과 4장 표로 OpenAPI 초안을 조립해 시험했다. 조립본은 저장소에 넣지 않았다. `docs/contracts/openapi.yaml`은 WP-23 몫이고 loupe `contract:guard`의 트리거다.

| 검사 | 결과 |
|---|---|
| 계약 JSON 예시 | 21건 파싱 오류 0. 6.1을 뺀 전부가 경로별 스키마 통과. 하이라이트 값과 공개 ID 패턴 통과 |
| OpenAPI 검증 | openapi-spec-validator 0.9.0 OK(26개 경로, 스키마 67 + 봉투) |
| Orval | npm 최신 8.46.0(2026-10-30 게시, deprecated 아님). loupe 설정으로 생성, tsc 5.9.3 exit 0, `data: unknown` 0건. loupe `package.json`의 8.44.0도 같은 결과다 |
| 좁히기 | `switch (hit.kind)` 네 값, 나머지 `never` 컴파일 통과 |
| 음성 대조 | `Envelope`에 `data`를 넣으면 `orval-check.sh`가 `data?: unknown`으로 실패. `const`를 하나 빼면 `never`에서 실패 |
| `orval-check.sh` 흐름 | 새 폴더에서 설치부터 실행. 첫 시도는 `tsconfig.orval.json` 이름 때문에 Orval이 확장자 없는 import를 내서 `nodenext`가 실패했다. `bundler`로 해결하고 WP-23 지시에 적었다 |
| ajv 8.20.0 | 91개 스키마 strict 컴파일, `discriminator: true`. 모르는 `kind`, `subject` 없는 `claim` 거부 |
| `node_label` | SQLite 3.46.1 `EXPLAIN QUERY PLAN`이 `SEARCH node USING INDEX node_label` |
| 패키지, 파동 | 27개, 11단계, 순환 0, 문제 0 |
| 소유 경로 | 223개, 고유 223개 |
| 6장 시험 이름 | 전부 해당 패키지 절에 있다 |
| ADR DDL | 7.1, 7.2, 7.11 실행 OK. `change`의 같은 `seq` `sub` 0, 1 삽입 성공 |
| JSON 예시 | ADR 4, 계약 21, 계획 1. 파싱 오류 0 |
| 잔여 문구 | 계약 본문의 `0.2.0` 0건, `e:<type>/` 예시 0건, openapi-typescript는 ADR 대안 칸과 응답표뿐이다 |

### 7.6 처리하지 않은 것

| 항목 | 이유 | 다음 |
|---|---|---|
| sagae-tools 전달과 확인 | 다른 세션이다 | 메인 세션이 0.3.0 파괴 변경 7건과 응답표를 전달한다 |
| 결정 14 | 기본값 (c)이고 사용자 확인 전이다 | 결정 전까지 소켓은 `internal` 이하다 |
| Orval 판 차이 | `loupe.md`는 8.46.0, `tools-wip/loupe/package.json`은 8.44.0이다 | 응답표에 적었다. sagae-tools가 정한다 |
| `overview_types` 조정 | `count`가 없다 | WP-21 결과 절 |
| 콜드 목표 | 근거는 프로토타입 콜드 p50 150 ms뿐이다 | WP-10 측정 뒤 확정 |
| S5 렌더 재측정 | GPU 경합이 의심되는 sagae-tools 측 값이다 | 재측정 값을 받으면 11장을 고친다 |
| `sagae-tools.md` 128행 | 수신 기록이라 고치지 않았다. "공백 16~20은 KB의 답을 기다린다"는 응답표로 닫혔다 | sagae-tools 재수신 때 |

### 7.7 부수 효과

| 대상 | 내용 |
|---|---|
| 저장소 | 계약, ADR, 계획, 이 파일을 고치고 응답표를 새로 썼다. `docs/research`, 다른 감사 문서, 제안서, ADR-0002, 소비자 문서, CLAUDE.md는 그대로다. 커밋 없음 |
| 외부 요청 | `registry.npmjs.org`의 패키지 메타데이터와 설치(orval, openapi-typescript, @redocly/cli 조회, orval, typescript, ajv, ajv-formats, yaml, @tanstack/react-query 설치), `pypi.org`의 openapi-spec-validator. 공개 읽기이고 개인 정보를 넣지 않았다. 유튜브, 자동완성, InnerTube, yt-dlp는 호출하지 않았다 |
| 로컬 읽기 | `sagae-tools`의 설계 문서, 표본 스펙, 설정을 읽기만 했다. 그 저장소의 코드를 실행하지 않았다 |
| 작업 파일 | `~/.cache/sagae-kb/scratch/prebuild/contract-0.3/`. 수정 스크립트, 베이스 사본, 조립본이다. npm은 가짜 HOME과 그 아래 캐시를 썼고 큰 설치물은 끝난 뒤 지웠다 |
| 전역 파일 | `~/.claude`, `~/.claude.json`, 셸 프로필, crontab, systemd, rtk·trail 상태 변경 없음. rtk, trail, `claude`는 실행하지 않았다 |
| 사고 | 없다 |

### 7.8 구축 전 감사 PB-01~PB-04 처리 (2026-11-01)

근거는 `audit-final-prebuild.md` 7.1과 `docs/adr/0002-user-decisions.md`다. 고친 문서는 ADR-0001, 빌드 계획, 계약 세 개다. 패키지 ID, 파동 순서, 소유 경로는 바꾸지 않았다.

| ID | 처리 | 위치 |
|---|---|---|
| PB-01 | `fetch.urls`, `fetch.discover`를 두고 받는 일은 WP-06 tick 3단계 하나로 정했다. 목록 추출은 WP-07의 순수 함수 `kb.parse.discover`다. 하위 페이지는 `queue(kind=page)`(도메인 순환, A~F 우선), URL별 상태는 `ops.db.url_state`다. WP-25는 A~F 먼저, 소스당 `max_pages` 25, 호스트별 시간 예산 조건과 `pages_fetched >= 100` 조건을 갖는다 | ADR 7.11, 10.2, 10.4. 계획 WP-06, 07, 25 |
| PB-02 | WP-26에 차단 목록 작성 단계(`kb intake deny-build`), 목록이 없으면 실행 거부, 노드 이름이 든 줄 전체 제거, 대장 항목별 처리 대조(`expected_treat.yaml`), 실행 뒤 `kb intake verify` 0건 조건을 넣었다 | 계획 WP-26. ADR 24장 |
| PB-03 | 2.1 골격의 모든 `agent()`에 model과 effort를 넣고 재시도에서 사다리를 한 칸 올린다. `args.packages`에 `rung`, `lead_review`를 더했다. WP-01, 03, 08에 리드 수준 검토를 적었다. WP-17 정의와 시험, ADR 20.2에 model/effort를 넣었다 | 계획 2.1, 2.2, WP-01, 03, 08, 17. ADR 20.2 |
| PB-04 | ADR 23장을 결정됨으로 고쳤다. 머신 밖은 외장 SSD E:(`/mnt/e`, drvfs, NTFS)로 ADR 17장, WP-13, WP-14, WP-15에 마운트 확인, 빠졌을 때 건너뜀, 재부팅 뒤 확인, first_party 개방 충족을 넣었다. 결정 1은 WP-24를 Trends RSS와 google.com 자동완성으로 좁혔다. 결정 8, 9는 레지스트리 초기값에 넣고 `d2.naver.com`을 포함했다. R14, ADR 10.5, WP-19, WP-17은 다중 백엔드로 바꾸고 라우팅은 0003을 따른다고만 적었다 | ADR 4, 10.4, 10.5, 17, 23, 24장, 부록 A. 계획 6장 경계, WP-13, 14, 15, 17, 19, 21, 24 |
| decisions.toml | 파동 0의 Decisions 단계(정형 수준)가 `~/.config/sagae-kb/decisions.toml`을 만든다. `approved = [1, 2, 3, 7, 8, 9, 10, 11]`. `wp-env.sh`가 패키지별 설정에 복사하고 WP-21이 읽는다 | 계획 2.1, 2.2, 6장, WP-00, WP-21 |
| 계약 | 서술 3곳만 고쳤다(`held`의 뜻, 도메인 A, first_party). 스키마와 버전은 그대로다 | 계약 6장, 11장 |

**확인이 필요한 가정.** (1) 결정 10을 `approved`에 넣었다. ADR-0002가 "기본값으로 시작"이라 적었기 때문이다. 실행 승인으로 읽는 것이 과하면 목록에서 뺀다. (2) 0003이 작성 중이라 백엔드별 호출 형태, 한도, 라우팅은 적지 않았다. 10.5와 WP-19의 값은 Claude 백엔드 값이라고만 표시했다. (3) 헤드리스 `claude`의 effort 지정 플래그는 확인하지 못해 ADR 20.2에 미확인으로 적었다. (4) NTFS 위 restic 동작은 미측정이라 WP-13 시험으로 넘겼다. (5) P04 자동완성의 정확한 호스트와 robots는 구현 때 다시 잰다. (6) 집 단위 재해는 결정 2 답으로 막지 못하는 위험이다. ADR 24장에 항목으로 더했다.

**부수 효과.** 문서 4개만 고쳤다. 코드, 전역 파일, 다른 저장소는 건드리지 않았다. 외부 요청 없음. 커밋 없음.
