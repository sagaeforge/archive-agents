# ADR-0005 FW1~FW9 계획의 공백 해소안

상태: 검토 대기
확인일: 2026-11-05

**목적:** 사용자가 FW 구현 계획을 승인할 수 있도록 K-c 상한, WebAuthn 의존성, 비용 대조 가능성, 선행 작업 인계를 구체화한다. 확인 위치는 이 문서의 근거와 인계 표다. 제품 구현·설치·실호출·커밋은 수행하지 않았다. 아래 설정값과 인터페이스는 승인·구현을 위한 제안이며, ADR이나 현재 코드에 이미 존재한다는 뜻이 아니다.

## G1. K-c 호출 상한

### 확인한 규칙과 빠진 값

ADR-0005 6.9는 K-c를 **연구 실행 전체의 실제 LLM/도구 호출 수를 엔진·재시도에 걸쳐 합산하는 하드 상한**으로 설명한다. 하지만 **실행별 호출 수의 숫자는 정하지 않았다.** 단위·기본값·재시도/엔진 전환·동시 예약·초과 중단의 결정 담당을 FW6/E1/D5로 지정하고, 구현·시험 전 해당 유료 에이전트 연구 경로를 409 `budget_unavailable`로 닫는다(`docs/adr/0005-first-party-write-api.md:849`, `docs/adr/0005-first-party-write-api.md:850`).

ADR이 인용한 기존 값은 별도 경계다. `maxTurns`는 현재 정의/검사에서 collector 30, researcher 8, judge 3, verifier 6이다(`.claude/agents/kb-collector.md:7`, `tests/agentrun/test_tools_scope.py:10`). ADR-0004의 검증 반복 3회와 작업 실행 40분도 실행 전체 호출 수가 아니다(`docs/adr/0004-research-backend.md:1258`, `docs/adr/0004-research-backend.md:1298`). ADR-0005의 열린 주제 20개·연구 요청 하루 5회 역시 호출 상한이 아니다(`docs/adr/0005-first-party-write-api.md:810`).

### 제안 해소

초기 설정은 **`max_llm_tool_calls_per_run = 30`**으로 제안한다. 숫자의 출처는 기존 collector의 `maxTurns: 30`이며, 가장 긴 기존 에이전트 정의의 수치를 보수적인 시작값으로 재사용하는 **새 설계 판단**이다. 턴과 호출이 같다는 환산이나 성능 측정 결과가 아니다. 한 턴에 여러 도구를 쓰면 기존 30턴보다 일찍 멈출 수 있다.

| 항목 | 제안 계약 |
|---|---|
| 범위·단위 | 유료 에이전트 연구의 `run_id`별 공통 장부. 실제 LLM 요청 시도 1건 또는 에이전트 도구 실행 시도 1건을 각각 1로 센다. 병렬 도구 3개는 3이다. 그 실행의 하위 과제와 로컬 LLM 대체도 같은 계수를 쓴다. 독립된 결정적/로컬 연구 경로는 ADR 6.9의 기존 양·예산 경계를 유지한다. |
| 중첩·재시도 | LLM이 도구를 요청한 경우 LLM 요청과 각 도구 실행을 따로 센다. 도구 내부의 추가 LLM 요청도 별도 계수다. 재시도·엔진 전환·프로세스 재시작·열린 실행 합류로 0으로 초기화하지 않는다. 캐시/멱등 재생처럼 새 호출이 없으면 증가하지 않는다. |
| 원자성 | 전송/도구 실행 직전에 공통 장부에서 슬롯을 내구 예약한다. `consumed + reserved <= 30`을 잠금 안에서 검사한다. 유료 요청은 ADR 6.4의 세 단위 금액 예약과 함께 허가되어야 한다. 슬롯이나 금액 예약 하나라도 실패하면 실행하지 않는다. |
| 반환 | 실행 전 취소가 증명된 슬롯만 반환한다. `sending` 이후의 실패·응답 유실·재시작은 소비한 호출로 유지한다. 금액 반환은 별도로 ADR 6.4를 따른다. `(호출 ID, 시도 번호)`가 새로 전송되면 새 슬롯과 새 금액 예약이 필요하다. |
| 초과 | 31번째 호출은 전송/실행 전에 차단하고 새 과제·엔진 전환을 중단한다. 상태는 기존 `budget_unavailable`, 실패 이유는 계약에 추가할 `call_cap_exceeded`로 제안한다. 이미 보낸 호출만 정산하고, 자동으로 새 연구 실행을 만들어 계속하지 않는다. |
| 강제 불가 어댑터 | CLI 프로세스 시작 1회를 내부 LLM 호출 1회로 간주하지 않는다. 내부 요청·도구마다 실행 전 허가를 강제할 수 없는 어댑터는 이 경로에서 사용하지 않는다. 사후 스트림 계수만으로 하드 상한을 입증할 수 없다. |

예약 키·전송 경계·불확실 예약의 근거는 `docs/adr/0005-first-party-write-api.md:752`와 `:754`, 사용 가능한 연구 상태는 같은 파일 `:728`이다. 현재 `budget.admit()`은 임의 예약 ID와 `job`을 저장하고, `before_send()`는 `reserved → sent`를 기록한다. 실행 전체 계수는 이 함수들에 없다(`src/kb/extract/budget.py:326`, `:347`, `:361`). 에이전트 실행자는 CLI 전체 예산을 한 번 예약한다(`src/kb/agentrun/runner.py:113`). 따라서 위 계약은 FW6/E1/D5에서 추가해야 한다.

**미검증:** 30회로 실제 연구가 충분히 끝나는지, 모든 어댑터가 내부 전송을 사전 통제하는지, 병렬·재시작에서 상한이 보존되는지. 향후 `tests/fpapi/test_research_call_cap.py`는 30/31 경계, 동시 예약, 재시도/엔진 전환, 합류/재생, 재시작, 불투명 어댑터의 외부 호출 0을 검증해야 한다. 현재 이 시험은 실행하지 않았다.

**사용자 결정: 예.** 숫자와 계수 단위가 연구 결과량을 바꾸는 새 정책이므로 **위 의미의 실행별 합산 30회를 초기 기본값으로 승인할지** 한 건만 결정한다. 승인과 강제 검증 전에는 ADR의 경로 폐쇄를 유지한다.

## G2. WebAuthn 의존성 선택

### ADR 요구와 후보 비교

ADR은 서버 WebAuthn 검증을 직접 만들지 않고 유지보수 중인 라이브러리를 사용하며, 후보를 `py_webauthn`으로 적었다(`docs/adr/0005-first-party-write-api.md:843`). 선택 기준은 서명·UV·카운터 증가·정확한 RP/origin·1회용 도전 검증이고, 신뢰 저장소와 동작 원자성은 KB 책임이다(`docs/adr/0005-first-party-write-api.md:830`, `:832`, `:835`, `:836`). 현재 프로젝트는 Python `>=3.14`이고 `serve` 의존성에는 WebAuthn 패키지가 없다(`pyproject.toml:5`, `:9`).

두 후보를 비교했다. **의존성 규모는 필수 직접 런타임 의존성 수와 해당 패키지 wheel 크기**로 비교한다. 전이 의존성 전체의 설치 크기나 현재 lock 대비 증가량은 측정하지 않았다. 빌드·개발·선택 extra는 직접 런타임 수에서 제외했다.

| 후보 | 유지보수 근거·버전 | 라이선스 | 의존성 규모·Python 조건 | 1차 출처·접근일 |
|---|---|---|---|---|
| `py_webauthn` 저장소 / PyPI `webauthn` | 조사 시 최신 안정판 `3.0.1`, 2026-09-25 배포. 최근 배포가 유지보수의 관측 근거다. | `BSD-3-Clause` | 직접 **5개**: `pyasn1>=0.6.2`, `pyasn1-modules>=0.4.2`, `cbor2>=6.1.2`, `cryptography>=49.0.0`, `pyOpenSSL>=26.3.0`. wheel **73.9 kB**. Python `>=3.10`. | [PyPI](https://pypi.org/project/webauthn/), [v3.0.1 pyproject](https://github.com/duo-labs/py_webauthn/blob/v3.0.1/pyproject.toml), [LICENSE](https://github.com/duo-labs/py_webauthn/blob/v3.0.1/LICENSE). 접근일 **2026-11-05**. |
| Yubico `python-fido2` / PyPI `fido2` | 조사 시 최신 안정판 `2.2.1`, 2026-06-29 배포. 최근 배포가 유지보수의 관측 근거다. | 기본 `BSD-2-Clause`; `fido2/hid/`의 포함 코드는 Apache-2.0, 포함 public suffix list는 MPL-2.0. | 직접 **1개**: `cryptography>=2.6,!=35,<52`. NFC용 `pcsc` extra의 `pyscard`는 선택이다. wheel **238.4 kB**. Python `>=3.10,<4`. | [PyPI](https://pypi.org/project/fido2/2.2.1/), [2.2.1 pyproject](https://github.com/Yubico/python-fido2/blob/2.2.1/pyproject.toml), [README 라이선스·범위](https://github.com/Yubico/python-fido2/blob/2.2.1/README.adoc). 접근일 **2026-11-05**. |

### 제안 해소

FW9는 **`webauthn==3.0.1`을 우선 선택**하고 `serve` 선택 의존성에 포함하는 것으로 제안한다. 직접 의존성 수는 `fido2`가 더 작지만, ADR 후보와 일치하고 서버 등록/인증 검증 API에 필요한 입력을 명시할 수 있다는 판단이다. `verify_authentication_response()`는 `expected_challenge`, `expected_rp_id`, `expected_origin`, 저장된 공개 키·카운터, `require_user_verification`을 받는다([v3.0.1 인증 검증 소스](https://github.com/duo-labs/py_webauthn/blob/v3.0.1/webauthn/authentication/verify_authentication_response.py), 접근일 **2026-11-05**). 실제 의존성 추가와 lock 갱신은 FW9 소유다.

FW9 어댑터는 `require_user_verification=True`와 신뢰 저장소의 정확한 origin 목록을 전달한다. 특히 라이브러리의 카운터 검사는 **이전 값과 새 값이 모두 0이면 통과**하므로, KB는 검증 결과의 `new_sign_count > stored_sign_count`를 별도로 요구해야 ADR을 만족한다. 이는 암호 검증 재구현이 아니라 ADR 정책의 추가 검사다([동일 소스의 카운터 조건·반환값](https://github.com/duo-labs/py_webauthn/blob/v3.0.1/webauthn/authentication/verify_authentication_response.py), 접근일 **2026-11-05**; `docs/adr/0005-first-party-write-api.md:836`). 카운터가 늘지 않는 인증기는 현재 ADR에서는 사용할 수 있다고 판단하지 않는다.

**미검증:** Python 3.14에서의 실제 설치·wheel/전이 의존성 호환성과 전체 용량, 저장소의 기존 lock과 충돌, 실물 인증기의 UV/카운터 동작, 전체 공급망 소스 감사. 이번에는 패키지를 설치하지 않았다. 검토한 [build 선언](https://github.com/duo-labs/py_webauthn/blob/v3.0.1/pyproject.toml), [등록 검증](https://github.com/duo-labs/py_webauthn/blob/v3.0.1/webauthn/registration/verify_registration_response.py), [인증 검증](https://github.com/duo-labs/py_webauthn/blob/v3.0.1/webauthn/authentication/verify_authentication_response.py)에서는 KB 인증 파일·셸 설정·권한을 변경하는 처리를 확인하지 못했지만, helper·전이 의존성 전체의 부재 증명은 아니다(접근일 **2026-11-05**). FW9가 설치 전 나머지 소스와 재현 가능한 lock을 확인하고 합성 등록/인증 시험을 수행한다. 사용할 수 없으면 사람 동작을 닫고 원인을 보고한다.

**사용자 결정: 아니오.** ADR이 FW9에 위임한 기술 선택이다. 라이브러리 변경을 이유로 UV·엄격한 카운터 증가·신뢰 저장소 정책을 완화하지 않는다. 정책 완화가 필요하다는 증거가 생길 때만 별도 결정을 올린다.

## G3. 제공자 비용 대조 가능성

### 현재 코드에서 확인한 것

확인일은 **2026-11-05**, 범위는 `src/kb/extract/`, `src/kb/agentrun/runner.py`와 관련 예산 호출부다. 다음은 정적 코드 확인이며 동작 시험 통과를 뜻하지 않는다.

| 구분 | 현재 동작과 근거 |
|---|---|
| 내구 예약 | SQLite `BEGIN IMMEDIATE`로 예약을 직렬화하고 엔진·모델·과제·금액·날짜·예약 ID를 저장한다. 전송 직전 재검사 뒤 상태가 `sent`가 된다(`src/kb/extract/budget.py:140`, `:326`, `:361`). 미해결 예약은 날짜를 가로질러 집계한다(`src/kb/extract/budget.py:197`). |
| 응답 기반 정산 | OpenRouter 응답의 `usage.cost`를 `cost_usd`로 읽어 `settle()`한다. 응답의 generation `id`를 결과에 보존하는 코드는 이 파서에 없다(`src/kb/extract/backends/openrouter.py:99`, `:107`, `:111`; `src/kb/extract/runner.py:287`). 에이전트 CLI 경로는 결과의 `total_cost_usd`를 정산에 넘긴다(`src/kb/agentrun/runner.py:165`). |
| 증거 기반 정산 입구 | `reconcile(reservation_id, actual, evidence)`가 있고 비어 있지 않은 `evidence`를 요구한다. 내부적으로 원래 예약을 정산하고 `llm:reconciled:<id>`에 증거를 남긴 뒤 예약을 삭제한다. 제공자에서 증거를 가져오거나 진위를 검증하는 구현은 이 함수에 없다(`src/kb/extract/budget.py:491`, `:396`, `:433`). |
| 잔액 대조 | `/credits`의 `total_credits-total_usage`를 가져온다. preflight는 초기 잔액을 설정하거나 로컬 잔액과의 차이를 지표로 기록한다. 개별 호출 대조가 아니다(`src/kb/extract/backends/openrouter.py:29`, `:53`). |
| ADR과의 차이 | 비용이 없거나 잘못되면 예약액을 즉시 비용으로 처리하고 예약을 제거한다. runner의 예외 처리와 CLI 종료도 이 정산을 호출한다(`src/kb/extract/budget.py:389`, `:396`, `:434`; `src/kb/extract/runner.py:280`; `src/kb/agentrun/runner.py:156`). ADR의 `sending → uncertain` 유지, 세 단위 보류, 재시작 복구, 7일 후 정산은 아직 이 코드로 충족했다고 볼 수 없다(`docs/adr/0005-first-party-write-api.md:743`, `:752`, `:757`, `:759`). |

기본 추출 backend는 OpenRouter와 sLLM이다(`src/kb/extract/runner.py:18`). 엔진 허용 목록에 OpenAI·Anthropic이 있다는 사실만으로 각 비용 조회 어댑터가 있다는 뜻은 아니다(`src/kb/extract/engines.py:18`). 현재 HTTP 공통 함수의 무과금 metadata 예외도 OpenRouter `/credits`·`/key`만 열려 있다. 새 비용 조회를 같은 유료 전송 경로로 무심코 연결하면 예약을 요구하므로, D5는 명시적인 읽기 전용 비용 조회 경계를 인계해야 한다(`src/kb/extract/llmhttp.py:41`).

### 제공자 공식 문서에서 확인한 것

| 제공자 | 확인된 API·대조 수준 | 제한·미확인 | 1차 출처·접근일 |
|---|---|---|---|
| OpenRouter | `GET /api/v1/generation?id=<generation_id>`는 Bearer 인증과 generation ID를 요구하고 `total_cost`·토큰·모델 등의 호출 단위 자료를 반환한다. ID를 보존한 호출에는 개별 대조 근거가 있다. `GET /api/v1/credits`는 관리 키로 계정의 총 구매·총 사용액을 조회한다. | generation ID 자체를 응답 유실로 받지 못한 경우의 개별 식별은 이 API만으로 입증되지 않는다. 계정 합계는 공유 계정의 특정 예약 귀속 증거가 아니다. 이 배치 키의 조회 권한·기록 보존 기간·지연은 실측하지 않았다. | [Generation API](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation), [Credits API](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits). 접근일 **2026-11-05**. |
| Anthropic API | 신규 연동 권장 API는 beta `GET /v1/organizations/analytics/usage`와 `/analytics/cost`. Claude Console 조직에는 Admin 자격 증명이 필요하다. 모델·workspace·API key 등으로 집계하며 `1m`/`1h`/`1d` 기간 대조가 가능하다. beta 헤더는 `analytics-usage-cost-2026-08-24`. 비용 `amount`는 소수 문자열 **센트**이므로 내부 USD로 변환해야 한다. | 확인한 API는 집계 자료이며 KB의 `(call_id, attempt)`로 비용을 찾는 호출 단위 영수증은 확인하지 못했다. 데이터는 보통 4시간, 최대 24시간 뒤 갱신되고 월말 후 약 7일까지 수정될 수 있어, 호출 후 7일의 KB 마감과 제공자 최종 확정을 같게 보면 안 된다. 계정 접근·실제 자료는 미확인이다. | [Usage and Cost Analytics API](https://platform.claude.com/docs/en/manage-claude/usage-cost-analytics-api). 접근일 **2026-11-05**. 기존 `/usage_report/messages`·`/cost_report`는 [legacy 문서](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)에 남아 있다(같은 접근일). |
| OpenAI API | `GET /v1/organization/usage/completions`는 `1m`/`1h`/`1d` 사용량과 요청 수, `GET /v1/organization/costs`는 **일 단위** 비용을 제공한다. API key·project 등으로 범위를 줄일 수 있다. Admin API에는 별도 Admin API key가 필요하다. | 확인한 비용 API의 필터/집계에는 요청 ID 단위 영수증 조회가 없다. 따라서 사용량×가격의 추정만으로 특정 timeout 호출의 최종 청구를 확정하지 않는다. 이 배치의 관리자 권한·가격/할인 적용·데이터 지연은 미확인이다. | [Usage Completions](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions), [Costs](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs), [Administration](https://developers.openai.com/api/reference/administration/overview). 접근일 **2026-11-05**. |

### 제안 해소

D5는 제공자별 능력을 **`per_call` / `aggregate_only` / `unavailable`**로 인계한다. 문서상 OpenRouter는 ID 확보 시 `per_call` 후보, Anthropic/OpenAI는 이번 조사 범위에서 `aggregate_only` 후보다. 이 분류는 위 문서에 대한 설계 추론이며 배치 확인 전에는 `available`로 광고하지 않는다. 모든 제공자가 호출 단위 대조를 지원한다는 전제를 제거한다.

1. 예약에 `spec/topic/run/call_id/attempt/engine/model`과 전송 시각을 연결하고, 응답을 받으면 provider ID와 비용 증거를 저장한다. 증거에는 출처·조회 구간·통화·확인 시각·정산 금액을 포함하며 키·본문은 넣지 않는다. 금액 상태와 G1의 호출 계수는 구분한다.
2. 응답 유실은 세 단위 예약을 `uncertain`으로 유지한다. 제공자 자료가 그 시도를 특정하고 비과금 또는 금액을 증명할 때만 반환/실액 정산한다. 사후 metadata 조회를 모델 호출로 취급하거나 예약을 소비하지 않는다.
3. 호출별 특정이 불가능하면 같은 엔진·계정/키·UTC 구간의 비용 합계와 로컬 정산+보류 합계를 대조한다. 공유 사용·지연·조정으로 설명되지 않는 차액은 환급하지 않는다. 주제나 시도에 임의 배분하여 확정 비용으로 표시하지 않는다. 관리자 조회가 없어도 ADR의 보수적 마감은 유지한다.
4. 호출 후 7일 안에 확정하지 못하면 **예약 전액으로 정산하고 반환하지 않는다**. 제공자 집계가 나중에 수정될 수 있다는 사실은 증거에 남긴다. 이미 전액 정산한 예약에 늦은 영수증을 다시 적용해 이중 청구하거나 자동 환급하지 않는다. 현재 `_complete()`는 정산 후 예약을 삭제하므로 이 이력 처리도 D5 인계에 명시해야 한다(`src/kb/extract/budget.py:433`).

위의 보류·기간 합계·7일 마감 정책은 이미 `docs/adr/0005-first-party-write-api.md:758`에 있다. 이번 제안은 이를 제공자별로 실행 가능하게 나누는 것이다.

**미검증:** 실제 관리자/관리 키의 가용성, provider ID와 예약의 내구 연결, 비용 조회 어댑터, 기간 대조 실행기, 7일 마감·재시작·중복 정산 방지, 주제/전체/엔진 동시 보류. 실키·관리 API·유료 LLM을 호출하지 않았다. FW6는 D5의 합성 영수증·timeout·재시작 검증과 함수 인계를 받기 전 유료 경로를 열지 않는다.

**사용자 결정: 아니오.** 호출 단위 대조가 안 될 때의 기간 합계·차액 미반환·7일 마감은 승인된 ADR 정책이다. 관리자 키 발급은 현재 문서 승인을 위한 요구가 아니며 이 작업에서 수행하지 않는다. 관리자 자료가 없다는 이유로 예약을 반환하거나 기능을 완료로 표시하지 않는다.

## G4. 선행 구현과 FW 간 인계 계약

### 공통 인계 봉투

**제안 해소:** 실행 순서는 **FW1 → FW2 → FW3 → FW4 → FW5 → FW9 → FW6 → FW7 → FW8**을 유지한다. ADR은 FW9를 FW5 뒤·운영 전 FW7 범위에 넣고, FW6은 TP1·TP5·D5 뒤로 정했다(`docs/adr/0005-first-party-write-api.md:1063`). 순서의 각 화살표는 실행 종료 알림이 아니라 아래 자료의 인수다.

구현 때만 기존 계획의 `.superpowers/sdd/2026-11-05-adr-0005-fw-plan/` 아래 task별 `report`·`manifest`·review package에 다음을 담는다. 새 실행 도구나 별도 자동화는 만들지 않는다. 이 문서 작업에서는 그 파일들을 만들지 않았다.

- **범위:** task ID, 브랜치, `BASE`/최종 `HEAD`, 수정 파일 목록·SHA-256, 공유 파일의 다음 소유자, source-of-truth ADR 위치.
- **생산 인터페이스:** 실제 `file:line`, 공개 함수의 이름·시그니처·반환/오류 모양, 이벤트/스키마 판, 잠금의 소유자·순서·트랜잭션 경계. 아직 없는 함수 이름으로 인계 완료를 주장하지 않는다.
- **검증:** 계획의 허용된 좁은 명령·실제 종료 코드·검증 전후 manifest, 완료 기준별 결과·재시도 수·미실행/미해결, 별도 세션의 불변 `BASE..HEAD` 검토와 지적 처리.
- **소비 조건:** 소비자가 읽어야 할 artifact와 fixture, 준비 상태·닫힌 경로, 미충족 시 `NEEDS_CONTEXT` 또는 기능 폐쇄 사유. 리드는 검토·검증된 SHA와 다음 task의 기반이 같은지 확인하고 한 파일 묶음의 쓰기 소유자를 한 명으로 유지한다.

이는 검증 snapshot→지정 경로 로컬 커밋→불변 패키지→별도 검토→task 완료의 기존 계약을 구체화한다(`docs/adr/0006-dev-workflow-superpowers.md:92`, `:94`, `:95`, `:102`, `:103`, `:105`). 이번 요청의 **커밋 금지**는 그대로이며 위 절차는 향후 승인된 FW 구현에 대한 인계다.

### 외부 선행 task → FW 소비자

| 생산자 | 반드시 넘길 구현 계약·근거 | 소비자와 인수 실패 시 처리 |
|---|---|---|
| TP1 | `kb_request(kind=topic)`·`kb topic add --from-ticket`·HTTP가 공유할 실제 주제 요청 함수. 잠금 안 대상/판 확인·동일 주제 합류·멱등 결과 고정, Topic/별칭/엣지·민감도 동기화의 파일/함수/시험. FW2의 `TopicSpec`/slug와 합의한 스키마 판. | FW6이 연구 요청/승격에 사용. FW9의 `kb topic approve` 연결점은 별도 TP3 담당에게 받는다(`docs/adr/0005-first-party-write-api.md:733`). TP1 완료만으로 승인 경로까지 완성됐다고 보지 않는다. HTTP만 별도 생성기를 만들지 않는다. ADR 근거 `docs/adr/0005-first-party-write-api.md:671`, `:677`, `:683`, `:686`, `:833`. 인계가 없으면 FW6 연결은 `NEEDS_CONTEXT`. |
| TP5 | 주제별 비용 귀속 키·월 경계·통화/정밀도·`topic:<id>` 읽기 모양·집계 갱신 함수와 시험. D5와 세 단위 예약의 원자성/실패 복구 담당을 합의하고, 단순 사후 집계를 예약 구현으로 대체하지 않는다. | FW6의 주제 월 $10 기본 상한과 상태 비용 표시, D5의 금액 장부가 소비. 근거 `docs/adr/0005-first-party-write-api.md:730`, `:743`, `:747`. 미준비 시 유료 연구를 닫는다. |
| E1 | 실제 선택/실행 API, 가능한 엔진·인증·호스트 경계, 로컬 대체, 불변 요청 바이트 해시·provenance, 자동 재전송 제어, G1의 내부 LLM/도구 사전 허가 연결점. 함수·지원 능력·대역 시험을 명시한다. | FW9 외부 정제와 FW6 유료 연구가 소비. FW9는 엔진·payload가 바뀌면 새 동의 없이는 전송하지 않는다. E1 미준비는 로컬 대체, 계수 강제 불가 유료 어댑터는 폐쇄. 근거 `docs/adr/0005-first-party-write-api.md:630`, `:689`, `:850`, `:1061`. |
| D5 | G3의 제공자별 대조 능력·증거 조회 함수, `(call_id,attempt)` 금액 예약/전송/보류/정산 API, 세 단위 동시 예약·재시작/7일 복구, G1 슬롯과의 원자성, 가격표 판·비용 상한·동시성 시험. 실제 코드와 ADR 상태명의 매핑도 제공한다. | FW9 publish와 FW6 연구가 소비. `budget.admit`/`before_send`/`settle`/`reconcile`은 현재 연결 후보이며 완성된 세 단위/uncertain 구현은 아니다(`src/kb/extract/budget.py:326`, `:361`, `:440`, `:491`). 미준비 시 FW9 외부 정제는 로컬 대체, FW6 유료 연구는 409 `budget_unavailable`(`docs/adr/0005-first-party-write-api.md:674`, `:752`, `:758`, `:1061`). |

현재 `open_ticket()`은 `_open_rows()`를 확인한 뒤 따로 `commit()`하고, 읽기 컨텍스트는 `internal`이다(`src/kb/ticket/__init__.py:118`, `:149`, `:157`, `:163`). TP1의 원자적/private 연구 인계를 이것으로 대체할 수 없다. 선행 task의 완료·시험·커밋은 이번 조사로 인증하지 않았다.

### 각 FW task의 생산물 → 다음 소비자

아래 함수/모듈은 계획상 산출물이다. 실제 생성 위치·시그니처는 각 task가 공통 봉투로 확정한다. 각 행의 ADR 인용은 `docs/adr/0005-first-party-write-api.md` 기준이다.

| task | 생산물·공통 인터페이스 | 다음 task가 읽는 것·인수 조건 | ADR 근거 |
|---|---|---|---|
| FW1 | `docs/contracts/openapi.yaml`, `data-interface-v0.md`, CHANGELOG·11종 fixture, `first-party-secret-rules-v1.json`의 판/실제 해시·합성 벡터. 계약 0.4.0의 쓰기/오류/meta/history 모양. | FW2는 타입·요청 스키마, FW3는 비밀 벡터·순번/구간, FW4는 HTTP 봉투·오류·쓰기 참조, FW9/FW6는 확장할 계약을 읽는다. artifact/서버 해시 불일치는 편집기 준비 완료를 막는다. | `:1052` |
| FW2 | Page/Note/TopicSpec/Review·세 엣지·`cancelled` 스키마, 정규화/기본 민감도·결정적 slug·추가 키 정책과 fixture. | FW3는 검증/정규화 호출 계약, FW6는 slug·Topic/티켓 갱신 모양, FW9는 Review·사람 결정 스키마를 읽는다. `record.py`의 쓰기 소유권은 FW3로 넘긴다. | `:1053` |
| FW3 | `author.resolve`, `put_record`, `tombstone_record`, `engine.commit`의 HTTP 확장; `WriteResult`·`VersionConflict.current`·현재 가시성 재검사·actor별 멱등/ID·비밀 거절·추출 큐 정책. | FW4/FW9/FW6는 실제 함수·인수·오류와 무저장/재생 fixture를 읽는다. 라우트에서 자체 CAS/원장 쓰기를 만들지 않는다. 공유 쓰기 파일은 이후 task에 순차 인계한다. | `:1054` |
| FW4 | 인증된 `serve/fpapi.py`·HTTP 라우트, 토큰 문맥(`tok_id`/`actor`/`created_app`), `fpquota.py`·`write_refs.py`, 스풀 예약/복구·소유/한도·오류 직렬화, private 읽기 연결. | FW5는 읽기 문맥·준비 플래그, FW9는 reviewer 확장 지점·한도/참조, FW6는 연구 라우트 연결점과 잠금 순서를 읽는다. `private_open`은 FW5 증거 전 false. HTTP 파일은 FW9→FW6 순으로 수정 소유권을 넘긴다. | `:1055` |
| FW5 | `raw/fp` 큰 본문·문단/FTS, tombstone 링크 갱신, 현재 원본 기준 파생 민감도와 모든 읽기 통로의 가시성, 증분/재구축 비교 증거. | FW9는 후보/공개 경계·원본 private 유지, FW6는 주제/실행 메타데이터 필터, FW7는 재투영 전후 누출 방지 증거를 읽는다. FW2/FW4와 읽기 검증이 모두 준비된 뒤에만 private 읽기 준비를 광고한다. | `:276`, `:1056` |
| FW9 | `reviewer.py`·`actions.py`·특권 등록 CLI, 선택/고정된 WebAuthn 의존성, 두 도전·증명과 신뢰 검사, 비동기 publish·로컬 대체·provenance, 계약 **0.5.0**·fixture와 안전한 meta. | FW6는 0.5.0 계약과 reviewer/가시성/공유 파일 변경을 보존하고 E1/D5의 실제 API를 재사용한다. FW7/FW8은 두 확인 분리·카운터·신뢰 검사·닫힌 외부 경로 근거를 읽는다. E1/D5 후 도착으로 외부 경로를 새로 연결하면 FW9 변경으로 검증/검토 후 인계한다. | `:836`, `:1061` |
| FW6 | TP1/TP5/E1/D5 인계 확인, 원자적 `research.request`/실행 합류/멱등/중지·승격·리뷰, 연구 비용/가시성·세 단위 예약, 승인된 G1 강제와 `test_research_call_cap.py` 근거. | FW7은 FW3~FW5/FW9와 합친 최종 SHA·계약 0.5.0·대역 예산/전송 시험·잔여 제한을 읽는다. 미결 K-c나 선행 미준비를 FW6 전체 완료로 표시하지 않는다. | `:677`, `:743`, `:850`, `:1057` |
| FW7 | `docs/reviews/0005-codex-fw7.md`: 최종 검토 코드 SHA·검증 manifest·위협별 판정·지적별 시험/반박·해결 상태·통과/차단. | FW8은 **같은 배포 후보 코드 SHA**의 최종 통과 기록과 계약/규칙 해시를 읽는다. FW6 전 예비 검토는 최종 통과가 아니다. Critical/Important 잔존 또는 검토 뒤 코드 변경이면 관련 범위를 다시 닫는다. | `:1058`, `:1063` |
| FW8 | 임시 `KB_HOME` 소켓 끝단 시험, `docs/runbooks/first-party-write-api.md`, 계약 0.5.0 소비자 인계 문안, 실제 승인·입회·활성화/전달 상태. | 사용자와 소비자는 검증한 후보·meta·제한을 읽는다. 운영 재시작·TTY 토큰 발급은 별도 사용자 승인/입회 뒤 사용자 수행이다. 승인/입회/전달이 없으면 대기/미전달로 남긴다. | `:1059`, `:1097` |

**미검증:** TP1/TP5/E1/D5 실제 완료 SHA·함수 시그니처·잠금 호환성·좁은 시험 결과, FW 간 인터페이스의 실제 연결. 위 표는 그 공백을 닫을 인수 계약이며 구현 완료 증거가 아니다. 리드는 선행 봉투를 받은 뒤 담당자가 읽을 정확한 파일/함수와 수정 소유권을 task brief에 채운다. 빠진 자료를 추측해서 구현하거나 운영을 열지 않는다.

**사용자 결정: 아니오.** 기존 순서·역할·보안 게이트를 유지하는 구현자 간 인계 형식이다. FW8의 운영 재시작 승인·입회는 이미 정해진 별도 운영 단계이며, 지금 계획 승인과 합치지 않는다.

## 승인 시 남길 결정

- **새 사용자 결정 1건:** G1의 유료 에이전트 연구 실행별 LLM/도구 시도 합산 **30회** 기본값과 계수 의미. G2~G4는 위 기술 제안과 미검증 조건을 계획에 반영할 대상으로 둔다.
- 문서 검토가 끝나도 유료 경로의 실제 개방, WebAuthn 실물 등록, FW7 통과, FW8 재시작 승인이 완료된 것은 아니다.
- tower `kb_search`/`kb_put`/`kb_request` 도구는 이 Codex 환경에 제공되지 않아 KB 검색·저장을 수행하지 못했다. 승인 후 Claude 리드가 보관할 후보는 **30회 시작값을 기존 collector 수치에서 보수적으로 가져온 판단과 한계**다. 외부 라이브러리/API 사실은 본문의 1차 URL과 접근일을 붙여 `kb_request`로 보관하며 비밀·계정 식별자는 넣지 않는다.
