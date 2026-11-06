# 세션 지식 자동 수확 런북 (`kb harvest`)

이 PC의 세션이 배운 것이 세션과 함께 사라지지 않게, 큐레이션된 결과만 한 시간마다 기록으로 거둔다. 결정적이고 LLM과 네트워크를 쓰지 않는다. 근거는 ADR-0001 7.8(세션 지식 자동 수확 행)과 ADR-0002 "세션 지식 자동 수확"이다.

## 원칙(사용자 결정)

- 큐레이션된 결과만 받는다. 전사 전체, 스크래치패드, 도구 출력은 읽지 않는다.
- 모든 자료는 비밀 탐지와 내부 주소 제거를 지난다. 세션 자료는 외부 LLM으로 가지 않는다.
- 세션 자료는 `first_party` 에이전트 기록(타입 `Learning`, 작성자 `agent:harvest`, 대리 `user:sagae`)이고 주장(claim, entity, edge)이 되지 않는다.
- 외부 사실은 글 안의 공개 URL을 담은 티켓이 되어 수집 경로가 1차 출처에서 확인한다.

## 명령

```
kb harvest --dry-run --json          # 읽기만 한다. 원장, 스풀, 티켓에 쓰지 않는다
kb harvest --dry-run --dump DIR      # 저장하려는 기록을 DIR에 파일로 내보낸다(검토용, 0600)
kb harvest --json                    # 기록과 티켓을 쓴다(tick 작업과 같은 코드)
```

| 옵션 | 뜻 |
|---|---|
| `--config FILE` | 설정 파일(기본 `sources/internal.d/harvest.yaml`의 `settings`) |
| `--claude-projects DIR` | Claude 프로젝트 폴더(기본 `~/.claude/projects`) |
| `--repo PATH` | `docs/research`를 읽을 체크아웃(여러 번 가능, 글롭 허용, 기본 `~/sagae-*` 중 `.git`이 있는 폴더) |
| `--max-writes N`, `--min-age S` | 이번 실행의 쓰기 상한, 최근 수정 유예 |
| `--samples N` | 보고서에 싣는 표본 제목 수(본문은 싣지 않는다) |

차단 목록(`$KB_CONFIG_DIR/intake-deny.txt`, `kb intake deny-build`가 만든다)이 없으면 `E_DENY_MISSING`으로 멈춘다. 차단 목록 없이는 돌지 않는다.

## 원본과 선별

| 종류 | 위치(읽기 전용) | 거두는 것 | 거르는 것 |
|---|---|---|---|
| `memory` | `~/.claude/projects/*/memory/*.md` | 머리말을 뗀 본문. 제목은 `description`, 세션은 `originSessionId`. 머리말 `metadata.type`이 `feedback`, `project`, `reference`인 것 | 색인 `MEMORY.md`, `type: user`(사용자 프로필, `exclude_memory_types`) |
| `workflow` | `…/<세션>/subagents/workflows/<wf>/journal.jsonl` | 결과(`result`)의 `summary`와 `verdict`, `status`, `recommendation`, `evidence`, 짧은 목록(`findings`, `facts`, `risks`, `defects`, `unknowns`, `open_questions`, `needs_user`, `user_decisions`, `incidents`: 항목 8개, 300자). JSON을 통째로 싣지 않는다 | 80자 미만 결과(시험용 한 단어), `acceptance`, `changed_paths` 등 그 밖의 키 |
| `agent_report` | `…/<세션>/subagents/agent-*.jsonl` | 끝난 에이전트(`meta.finished`가 참, 마지막 메시지가 `end_turn`)의 마지막 assistant 글. 파일 끝 1 MiB만 읽는다 | 800자 미만이거나 20000자 초과, `team-watcher` 등 보고서가 아닌 유형, 워크플로우 안의 에이전트(결과가 위 `workflow`에 있다) |
| `research_doc` | 설정한 체크아웃의 `docs/research/*.md` | 문서 전체 | `.git`이 없는 폴더 |

- 폴더를 열기 전에 프로젝트 폴더 이름이 `scratchpad`, `test-tmp`, `tmp-claude-<숫자>-`, `-home-…--cache-`에 걸리면 뺀다.
- 심볼릭 링크, 4 MiB 초과, 10분 안에 고친 원본(쓰는 중일 수 있다)은 건너뛴다.

## 정화 규칙(원본마다 이 순서)

1. **비밀 탐지**(`kb.write.secrets_scan`, Gitleaks 기본 규칙 + 개인 키 머리 + 고엔트로피 `KEY=값` 줄)를 정화 전 원문에 건다. 하나라도 걸리면 **원본을 통째로 건너뛴다**. 값은 어디에도 남기지 않고 규칙 ID별 건수만 보고한다.
   - 예외 하나: 줄 머리의 `KEY=<정확히 40자리 소문자 16진수>`는 git 커밋 SHA로 보고 앞 12자리와 `…`로 줄인 뒤 탐지한다(고엔트로피 규칙이 SHA를 비밀로 오탐한다). 키 이름에 `TOKEN`, `KEY`, `SECRET`, `PASS`, `AUTH`, `API` 등이 들면 줄이지 않고 계속 건너뛴다. 대문자, 39·41·64자리, 16진수가 아닌 고엔트로피 값도 그대로 건너뛴다. 줄여서 저장하므로 쓰기 코어의 자체 탐지도 같은 판정이다(격리되지 않는다).
2. **줄 정화**(`kb.intake.scrub`을 그대로 쓰고 아래를 더한다). 걸린 줄은 통째로 뺀다.
   - intake 규칙: 사설·루프백·링크 로컬·비공개 IPv4, ULA·링크 로컬 IPv6, `localhost:포트`, `.local .lan .internal .home.arpa` 호스트, 차단 목록 문자열(호스트·노드 이름), `scopes:`/`token permissions` 줄
   - 수확이 더한 규칙: **이메일 주소가 든 줄**(예외 없음. `pkg@5.9.3`, `@scope/pkg` 같은 패키지 표기는 이메일이 아니라 남긴다), **차단 목록 항목의 앞부분 토큰**(`영문4자이상-숫자…` 꼴 항목 `abcd-7262`에서 `abcd-`를 뽑아 같은 계열 이름 전부, 대소문자 무시), 자리표시 사설 대역(`192.168.x.x`, `10.0.0/8`, `172.16.x.x`), IPv6 사이트 로컬, `.localdomain .intranet .corp .ts.net .homelab` 호스트, 토큰 권한 줄(`token scopes`, `OAuth scopes`, `scopes = […]`, `read:org` 같은 콜론 형식 범위, `contents: write` 같은 GitHub 세부 권한, Proxmox `PVEAuditor`와 `Sys.Audit` 같은 권한 이름)
   - 숫자만 3성분인 버전(`10.x.x.x`), `10.8/18.3 ms` 같은 측정값, 단수 `scope`는 건드리지 않는다.
3. 제어 문자와 ANSI 이스케이프를 지우고, 128 KiB를 넘으면 줄 경계에서 자른다(`truncated`).
4. **사후 검증**: 저장할 제목, 본문, props 전체에 같은 줄 규칙과 비밀 탐지를 다시 건다. 걸리면 저장하지 않는다(코드 결함 신호).
5. 쓸 때 `put_record`가 한 번 더 비밀 탐지를 건다(걸리면 `secret`으로 격리). 수확은 사전 탐지로 막으므로 `writes.secret_hits`는 0이어야 한다.

## 기록 형식

- ID: 원본 경로에서 정한 안정된 ID(`f-…`). 원본 하나에 기록 하나다. 경로가 바뀌면 새 기록이다.
- `props`: `source_kind`, `project`, `source_path`(홈은 `~`), `session`(원본 세션, 자기 신고 표시값), `source_date`, `content_sha`, `scrubbed_lines`, `tags: ["harvest", 종류]`, 종류별 `memory_type`/`workflow`/`agent_type` 등. 민감도 `internal`.
- 멱등 키 `harvest:<ID>:v<N>:<해시16>`. 내용이 같으면(`content_sha` 비교, 수정 시각만 바뀐 경우 포함) 아무것도 쓰지 않는다. 다르면 `expected_version`을 건 같은 ID의 새 버전이다. A → B → A로 되돌아가도 새 버전으로 남는다.
- first_party가 닫혀 있으면(결정 2 전) 기록은 `spool/fp-held`에 보관되고 같은 규칙으로 멱등이다. 열린 뒤 `kb fp open`이나 tick의 recover가 쓴 순서대로 적재한다.
- 사용자가 지운(`record.tombstone`, `record.redact`) 기록은 되살리지 않는다(`removed_by_user`로 센다).
- 원본이 사라져도 기록은 지우지 않는다.

## URL 티켓

- 정화된 글에서 `https` URL을 뽑아 `kb intake`와 같은 거름(내부 주소, userinfo, 비밀 쿼리, 차단 목록 문자열, 활성 소스 URL, `host_allowed`)을 지난 것만 `세션 수확 출처 재확인: <프로젝트>` 티켓의 `urls`로 보낸다. 사실 확인은 `kb-fulfill`과 수집 경로가 한다.
- 질의 문자열에 `@`나 `%40`이 든 URL은 올리지 않는다(티켓의 URL은 나중에 수집기가 요청하므로 이메일 같은 개인 정보가 외부 요청에 실리면 안 된다). 경로의 `@scope/pkg`는 괜찮다.
- 한 번이라도 티켓에 오른 URL(닫힌 티켓 포함)은 다시 올리지 않는다. 수확이 매시간 돌기 때문이다.
- 상한: 원본당 20, 실행당 60, 티켓당 `kb.ticket.MAX_URLS`(50). 넘은 URL은 버리지 않고 세며 다음 실행이 잇는다.

## 상한(실행당, `settings`에서 바꾼다)

| 키 | 기본 | 뜻 |
|---|---|---|
| `max_writes` | 40 | 새 기록과 새 버전의 합. 넘으면 보고서 `deferred.cap`으로 세고 다음 실행이 잇는다(최근 수정 순) |
| `max_write_bytes` | 2 MiB | 쓰는 본문 바이트 합 |
| `max_body_bytes` | 128 KiB | 기록 하나의 본문(`max_write_bytes` 이하여야 한다) |
| `max_urls`, `max_urls_per_source` | 60, 20 | 티켓에 새로 올리는 URL |
| `max_sources`, `max_read_bytes`, `transcript_tail_bytes` | 1000, 4 MiB, 1 MiB | 훑는 원본 수와 읽는 바이트 |
| `exclude_memory_types` | `["user"]` | 거두지 않는 메모리 유형(머리말 `metadata.type`) |
| `enabled` | true | false면 tick 작업이 아무것도 하지 않는다(수동 `kb harvest`는 그대로 돈다) |
| `deadline_s` | 120 | 실행 시간. tick 안에서는 tick 마감도 따른다 |
| `min_age_s` | 600 | 이보다 최근에 고친 원본은 미룬다 |
| `min_report_chars`, `max_report_chars`, `min_result_chars` | 800, 20000, 80 | 보고서 길이 거름 |

## 스케줄

`sources/internal.d/harvest.yaml`의 `harvest.sessions`: `every_s: 3600`, `stage: 1`(recover 뒤). tick이 만기일 때만 돌고 상주 프로세스, systemd 유닛, LLM 호출, 네트워크 호출이 없다. 예외는 잡아 tick 경고로 남기고(다음 시도는 한 시간 뒤) tick을 막지 않는다. 겹친 실행은 `ops/harvest.lock`이 막는다.

## 점검

1. `kb harvest --dry-run --json`으로 프로젝트별 `candidates`, `skipped_secret`, `lines_removed`, `urls_found`와 `verify`(차단 목록, 내부 주소, 확장 규칙, 비밀 적중 줄 수, 모두 0이어야 한다)를 본다. `skipped_secret_rules`는 규칙 ID만 담는다.
2. 사람이 본문을 보려면 `--dump DIR`로 내보내 읽는다. 보고서에는 본문이 없다.
3. 적재 뒤: `kb fp status`(보관 수), `kb fp list --grep 어휘`(보관 본문 검색). 결과 JSON 형식은 `schemas/cli/harvest.schema.json`이다.

## 알려진 한계

- 차단 목록에 없는 새 호스트·노드 이름은 걸러지지 않는다. 노드를 더하면 `kb intake deny-build --nodes FILE`로 목록을 갱신한다(`영문4자이상-숫자` 꼴이면 같은 계열 앞부분 토큰도 자동으로 따라온다).
- 홈 경로(`/home/…`)는 거르지 않는다(결정: 그대로 둔다).
- Gitleaks 규칙의 오탐은 원본을 통째로 건너뛴다. `skipped_secret_rules`로 찾아 원본 쪽 줄을 고친다. 위 SHA 예외는 정확히 40자리 소문자 16진수에만 걸리고, 키 이름이 비밀스러운 줄과 다른 모양의 값에는 걸리지 않는다.
- 줄 단위 제거라 코드 펜스나 표 안의 줄이 빠지면 구조가 깨질 수 있다(결정: 그대로 둔다).
- 워크플로우 결과의 서술(판정, 권고 포함)은 세션의 서술이다. `f:agent:harvest`로 표시되며 사실이 아니다.
