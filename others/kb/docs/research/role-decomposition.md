# 목적별 KB 역할 분해안

작성일: 2026-11-05. 설계 근거일: 2026-11-04. 상태: 사용자 검토용 제안. 이 문서는 ADR, 실행 코드, 에이전트 정의, 운영 설정을 바꾸지 않는다. 개발 역할 절(§4)은 2026-11-05 CLAUDE.md 기준으로 2차 갱신했다.

목적은 책을 찾는 사람, 읽는 사람, 정리하는 사람, 근거를 검사하는 사람을 각각 두는 것이다. 사용자는 주제를 넣었을 때 생기는 출처 후보·주장·관계·미해결 항목에서 각 결과의 생산자와 검사자를 확인할 수 있어야 한다. 개발 세션에서도 설계, 구현, 검사, 실행 권한이 분리되어야 한다. 역할 수보다 **한 역할이 한 종류의 입력에 한 연산을 수행하고 한 출력 스키마만 반환하는가**로 분해를 판정한다.

근거는 이번 작업에서 읽은 저장소 문서와 코드다. 외부 조사와 실행 측정은 하지 않았다. 모델명·비용·합격선은 ADR-0004의 2026-11-04 기록을 참조하며, 이 제안의 성능을 실측한 값으로 해석하지 않는다. 샌드박스 제약은 작업 지시에서 받은 환경 조건이다.

## 1. KB 역할 카탈로그

### 공통 계약과 실행 단위

KB 역할은 30개다. 주제·발견 4개, 입장·수집 4개, 자료별 추출 8개, 정규화·관계 6개, 검증·생존 4개, 유지·메모 정제 4개다. 이 중 `none` 12개, `local` 9개, `external` 9개다. `none` 역할은 **no LLM**이며 에이전트 세션을 만들지 않는 함수·프로토콜 작업이다. 역할 하나를 상주 프로세스 하나로 만들지 않는다.

모든 역할의 반환 봉투 `RoleResult`는 `{role_id, role_version, input_ref, input_version, input_sha, schema_version, status, data, evidence_refs, unresolved, incidents}`다. `status`는 `ok | empty | held | rejected | failed`, `unresolved`는 `{code, target_ref, reason_code, attempted, next_role}` 배열이다. 각 카드의 출력 스키마는 `data`의 필드다. `none`도 같은 봉투를 쓰며 모델 provenance는 비운다. LLM 호출은 추가로 `{run_id, engine, requested_model, served_model, model_vendor, provider, prompt_version, cost_usd, duration_ms}`를 남긴다. 비공개 본문은 실행 봉투나 로그에 복제하지 않는다.

추출 후보 `FactCandidate`의 공통 필드는 `{candidate_id, subject_mention, statement, kind, stance, speaker, value, unit, valid_from, qualifier, prior_value, changed_on, depends_on, evidence}`다. `evidence`는 `{snapshot_ref, exact, start_cp, end_cp, heading_refs, table_refs, media_time}`이며 없는 선택자는 `null`이다. 모델이 낸 위치는 결정적 위치 검사로 다시 확인한다. 추출기는 기존 엔티티 ID나 술어를 확정하지 않는다. `claim-normalize`와 `entity-resolve`가 뒤에서 처리한다. `kind=event`의 시점, 귀속 주장의 화자, 원문 인용, 민감도 상속은 기존 계약을 따른다.

각 입력의 민감도와 원본 참조는 서버가 봉투 밖의 신뢰 문맥으로 전달한다. 모델 출력으로 민감도·권한·다음 엔진을 지정할 수 없다. 후보의 `statement` 표기 정책은 기존 정책과 별도로 판본을 관리하고, 추출 역할에 번역 작업을 더하지 않는다.

모델 등급은 `D`=결정적 코드, `S`=소형·정형, `M`=산문·문맥 해석, `J`=보정된 판단이다. 로컬 `S`의 첫 후보는 `nemotron-bolt-e4b`, 분류의 비교 후보는 `gemma4-12b`다. 외부 `S`의 후보는 Haiku 계열과 `gpt-5.4-mini`, `M`은 `gpt-6.1-sol`·Sonnet 계열이다. `J`는 등급 이름만으로 승인되지 않고 역할별 보정 통과를 요구한다. 이는 후보 배치이며 전 역할에 같은 모델을 복제하는 기본값이 아니다.

카드의 허용 엔진 `API`는 `openrouter | openai_api | anthropic_api`를 뜻한다. 실행기가 설치·검증된 조합만 선택한다. `local`의 기존 백엔드 식별자 `sllm`은 호환을 위해 유지한다. 자동 KB 경로에 소비자 구독이나 `codex` 엔진을 넣지 않는다. 개발 세션의 Codex 우선 원칙은 4절에서 따로 적용한다.

문맥 상한 `S`=본문 6,000자 이내의 한 항목, `L`=본문 24,000자 이내의 한 절 또는 연속 페이지, `P`=후보 쌍과 근거 한 구간, `B`=유한한 구조 레코드 묶음이다. 모두 제안값이다. 상한을 넘으면 같은 형식으로 분할하며 문서 전체를 작은 역할에 덧붙이지 않는다. 인용의 상위 제목·표 머리·시간 위치는 분할 후에도 보존한다. OCR·ASR·문서 파싱·분할·직렬화·원장 쓰기는 기존 도구를 잇는 결정적 기반 계층이며 LLM 프롬프트에 맡기지 않는다.

캐시 접두의 공통 앞부분은 `(role_id, role_version, prompt_version, schema_version, policy_version, input_kind, context_profile)`이다. 카드에는 그 뒤에 붙을 고정 사전·규칙을 적는다. 시각, 실행 ID, 개별 문서 ID, 후보 목록, 원문은 고정 접두 뒤에 둔다. `none`의 캐시는 프롬프트 캐시가 아니라 입력 해시와 파서 판본에 따른 결과 캐시다. 민감도와 접근 범위가 다른 실행은 캐시를 공유하지 않는다.

스키마 통과는 의미 정확성의 증명이 아니다. 모든 지표는 거부·보류·빈 결과·후속 감사와 함께 보고한다. `none`과 `local`은 비용 0으로 나눠 순위를 만들지 않고 처리량, 지연, 전력, 오류율로 비교한다. 외부는 역할별 품질 조건을 먼저 통과한 뒤 수락 단위당 총비용으로 비교한다.

### 주제·발견: 4개

#### `topic-plan`

- **목적:** 주어진 주제 범위를 유한한 검색·발견 계획으로 분해한다. **입력:** first_party `TopicSpec` 한 판, 사용자가 준 시드·범위·제외어만, `S`.
- **출력 스키마(필드):** `{topic_ref, scope_terms, excluded_terms, discovery_slots:[{source_kind, seed_ref, reason_code}], ambiguity_candidates}`. 계획은 운영 자료이며 세계 사실 주장이 아니다.
- **도구/권한:** 해당 spec 읽기만; 검색·등록·원장 쓰기 없음. `private`는 로컬 서비스 작업만 가능하다.
- **LLM 필요와 model tier:** `local / S`; 명시 필드가 충분하면 결정적 템플릿 우선. **허용 엔진:** `local`. **캐시 접두 단위:** 주제 계획 스키마·수집 종류 사전.
- **성과 지표:** 범위 준수율, 중복 없는 실행 가능 슬롯 비율, 계획당 지연. **실패·불확실 시:** 단서로 가를 수 없는 복수 대상만 `topic_ambiguity`; 유휴 GPU 부족은 대기.
- **현재 대체·분할:** ADR-0004 T.1·T.2·T.7, `kb-first-collect`의 시드 해석; 범용 주제 기획자에서 발견 실행을 분리한다.

#### `protocol-discover`

- **목적:** 알려진 발견 프로토콜에서 출처 후보 참조를 열거한다. **입력:** 구조화된 `DiscoveryRequest` 한 건, `B`; 프로토콜별 어댑터를 고정한다.
- **출력 스키마(필드):** `{topic_ref, candidates:[{source_ref, protocol, anchor_id, found_by, evidence_ref}], exhausted}`. 실제 위치 값은 정책 계층에서 관리하고 여기서는 참조로 넘긴다.
- **도구/권한:** 등록 소스 조회·승인된 프로토콜 요청만; 본문 해석·등록 없음. 비공개 주제는 등록된 로컬 자료 조회만 허용한다.
- **LLM 필요와 model tier:** `none / D`. **허용 엔진:** `none`. **캐시 접두 단위:** 발견 어댑터 판본·프로토콜 스키마.
- **성과 지표:** 중복 제거 후 유효 후보 수/요청, 새 수집기로 이어진 비율. **실패·불확실 시:** 구조적 발견 공백만 공개 검색 허가를 확인한 뒤 `prose-source-scout`; 정책 차단은 `source-policy`로 반환한다.
- **현재 대체·분할:** ADR-0004 T.2 D-1~D-8, `kb-researcher`의 레지스트리·피드·구조 식별자 탐색, `src/kb/parse/discover.py` 확장.

#### `prose-source-scout`

- **목적:** 결정적 발견으로 해소되지 않은 공개 검색 슬롯에서 1차 출처 후보만 찾는다. **입력:** 외부 검색이 허가된 `PublicSearchSlot` 한 건, `S`.
- **출력 스키마(필드):** `{slot_ref, candidates:[{source_ref, source_kind, reason_code, search_evidence_ref}], exhausted}`; 사실 문장과 인용 주장은 출력하지 않는다.
- **도구/권한:** 검색 브로커만; 원문 수집은 `snapshot-fetch`에 요청한다. 범용 셸·KB 제출 도구 없음.
- **LLM 필요와 model tier:** `external / S`, 슬롯 해석 실패 때만 `M`. **허용 엔진:** `API`. **캐시 접두 단위:** 검색 슬롯 유형·1차 출처 선정 규칙·고정 검색 도구 정의.
- **성과 지표:** 정책 통과 후 채택 출처/총비용, 검색 호출/채택 출처. **실패·불확실 시:** `protocol-discover`에 다른 프로토콜 슬롯을 반환하거나 빈 결과; 새 소스의 정책 문제는 `source-policy`.
- **현재 대체·분할:** `.claude/agents/kb-researcher.md`, `kb-fulfill`·`kb-first-collect`의 공개 산문 탐색; 본문 읽기와 적재를 제거한다.

#### `candidate-classify`

- **목적:** 후보 페이지가 지정 주제에 해당하는지만 분류한다. **입력:** `CandidatePreview` 한 건과 그 주제의 최소 시드 집합, `S`; 출처 종류 분류와 신뢰 등급 판정은 하지 않는다.
- **출력 스키마(필드):** `{candidate_ref, topic_ref, relevance:match|no_match|unknown, evidence_spans, reason_code}`.
- **도구/권한:** 제공된 미리보기만; 네트워크·등록 없음.
- **LLM 필요와 model tier:** `local / S`; 시드 비율 규칙 우선. **허용 엔진:** `local`. **캐시 접두 단위:** 주제 해당성 분류 규칙·도메인 사전.
- **성과 지표:** 골든 해당성 정확도·재현, 오제외율, 후보/초. **실패·불확실 시:** 기준 미달이면 `unknown` 힌트만 유지하고 `source-policy`로 전달한다. 모델 불확실성만으로 HITL을 만들지 않는다.
- **현재 대체·분할:** ADR-0004 T.3 주제 해당성, T.10·7.8 `classify`; 종류 분류가 불합격한 결과와 해당성 결과를 합쳐 쓰지 않는다.

### 입장·수집: 4개

#### `source-policy`

- **목적:** 수집 후보를 기존 정책에 따라 입장 판정한다. **입력:** 수집된 검사값을 갖춘 `SourceCheckBundle` 한 건, `B`.
- **출력 스키마(필드):** `{candidate_ref, verdict:auto_attach|auto_register|needs_user|rejected, checks, reason_codes, existing_source_ref, missing_checks}`.
- **도구/권한:** 정책·승인 이력·레지스트리 읽기만; 새 정책 해석이나 예외 생성 없음. 누락된 검사 수집은 스케줄러에 반환한다.
- **LLM 필요와 model tier:** `none / D`. **허용 엔진:** `none`. **캐시 접두 단위:** T.3 정책 판본·검사 스키마.
- **성과 지표:** 금지 후보 자동 등록 0, 동일 입력 재현성, 미완성 검사 오승인 0. **실패·불확실 시:** 기존 자동 기준 밖의 미해결 의도만 `source_policy`; 명시적 금지는 거부하며 사람 승인으로 우회하지 않는다.
- **현재 대체·분할:** ADR-0004 T.3, `src/kb/collect/registry.py` 검사; `kb-collector`가 정책을 판단하던 부분을 코드로 고정한다.

#### `collector-register`

- **목적:** 승인된 후보를 수집기 정의로 직렬화한다. **입력:** 결정적 승인 검증을 통과한 `ApprovedSourcePlan` 한 건, `B`.
- **출력 스키마(필드):** `{source_id, adapter_id, parser_version, cadence, l2_policy, topic_refs, registry_patch_ref, approval_ref}`.
- **도구/권한:** 지정 레지스트리 경로의 검증된 변경만; 승인 기록 생성·정책 변경·배포·커밋 없음.
- **LLM 필요와 model tier:** `none / D`. **허용 엔진:** `none`. **캐시 접두 단위:** 수집기 템플릿·레지스트리 스키마.
- **성과 지표:** 재적용 무변경 비율, 잘못된 어댑터 선택 0, 승인 없는 등록 0. **실패·불확실 시:** 지원하지 않는 어댑터는 등록 보류 후 4절 `designer`에게 구현 요청; 승인 누락은 `source-policy`.
- **현재 대체·분할:** ADR-0004 T.4, 레지스트리 로더·`registry_sync`; 범용 사서에게 YAML 작성과 배포를 함께 맡기지 않는다.

#### `snapshot-fetch`

- **목적:** 승인된 수집 요청을 조건부 수집하여 스냅샷 참조로 반환한다. **입력:** 정책이 묶인 `FetchRequest` 한 건, `B`.
- **출력 스키마(필드):** `{source_ref, snapshot_ref, content_sha, media_kind, not_modified, fetch_status, captured_at}`.
- **도구/권한:** 기존 `safe_fetch`와 CAS 저장만; 리다이렉트별 검사·robots·크기·미디어 정책 유지. 내용 기반 셸 실행 없음.
- **LLM 필요와 model tier:** `none / D`. **허용 엔진:** `none`. **캐시 접두 단위:** 수집 정책 판본·조건부 요청 상태.
- **성과 지표:** 304 비율, 유효 스냅샷/요청, 정책 위반 0. **실패·불확실 시:** 일시 실패는 기존 재시도 큐, 정책 실패는 `source-policy`; 내용의 의미를 추정하지 않는다.
- **현재 대체·분할:** `src/kb/collect/capturer.py`, ADR-0004 T.5; `kb-collector`의 `kb_fetch` 동작을 읽기·추출에서 분리한다.

#### `sensitivity-classify`

- **목적:** 자료 한 건의 민감도를 상향할 필요가 있는지 분류한다. **입력:** 신뢰된 로컬 서비스가 만든 `SensitivityPacket` 한 건, `S`; 원본 등급 포함.
- **출력 스키마(필드):** `{input_ref, minimum_sensitivity, detected_classes, matched_spans, reason_codes}`; 원본보다 낮은 등급을 출력할 수 없다.
- **도구/권한:** 격리한 로컬 메모리의 입력만; 네트워크·일반 MCP·전역 로그·등급 하향 없음.
- **LLM 필요와 model tier:** `local / S`; 결정적 비밀 탐지가 먼저이고 보조 모델은 상향 전용. **허용 엔진:** `local`. **캐시 접두 단위:** 민감도 분류표·탐지 규칙 판본.
- **성과 지표:** 비밀 재현, 하향 오분류 0, 외부 유출 0. **실패·불확실 시:** 보수적인 상위 등급으로 보류; 격리 해제는 사용자가 시작하는 별도 동작이며 자동 HITL로 대체하지 않는다.
- **현재 대체·분할:** `src/kb/extract/guard.py`, `sensitive.py`의 입력 경계, ADR-0004 7.8 `sensitive`; 최종 전송 가드를 대체하지 않고 앞단 보조로 분리한다.

### 자료별 추출: 8개

#### `structured-extract`

- **목적:** 선언된 피드·API 구조 레코드를 사실 항목으로 파싱한다. **입력:** parser ID가 고정된 `StructuredRecord` 묶음, `B`; 산문 필드는 제외한다.
- **출력 스키마(필드):** `{parser_id, parser_version, entities, claims, edges, series, prose_refs}`; 각 항목은 원본 포인터·위치를 가진다.
- **도구/권한:** 기존 L1 어댑터만; 네트워크·임의 필드 추론·직접 원장 쓰기 없음.
- **LLM 필요와 model tier:** `none / D`. **허용 엔진:** `none`. **캐시 접두 단위:** 프로토콜별 파서 ID·스키마 판본.
- **성과 지표:** L1 게이트 통과율, 중복 항목 0, 처리 항목/초. **실패·불확실 시:** 알 수 없는 스키마는 4절 `designer`에게 fixture 참조 전달; 선언된 산문만 해당 추출 역할로 간다.
- **현재 대체·분할:** `src/kb/parse/adapters`의 피드·패키지·자료 어댑터, ADR-0004 3.2 S·C 및 T.5; 구조 자료의 L2 호출을 제거한다.

#### `table-extract`

- **목적:** 알려진 열 매핑을 가진 표의 행을 결정적으로 추출한다. **입력:** `MappedTable` 한 건, `B`; CSV와 HTML 표는 앞단에서 이 구조로 파싱한다.
- **출력 스키마(필드):** `{table_ref, row_claims:[{row_ref, subject_cell, predicate, value, unit, valid, header_refs, evidence}], rejected_rows}`.
- **도구/권한:** CSV·표 파서와 허용된 매핑만; 수치 보간·추론·원장 쓰기 없음.
- **LLM 필요와 model tier:** `none / D`. **허용 엔진:** `none`. **캐시 접두 단위:** 표 스키마·열 매핑·단위 사전 판본.
- **성과 지표:** 원문 수치 보존율, 게이트 통과율, 처리 행/초. **실패·불확실 시:** 미지의 열은 `table-fieldmap`; 빈칸과 합계 의미를 추정하지 않는다.
- **현재 대체·분할:** `src/kb/parse/adapters/data.py`, ADR-0004 D2·7.8; 표 머리에만 주어·단위가 있는 자료를 산문 프롬프트에서 뺀다.

#### `table-fieldmap`

- **목적:** 미지의 표 헤더를 기존 필드에 대응시키는 후보만 낸다. **입력:** `UnknownTableHeader` 한 건과 제한된 예시 행, `S`.
- **출력 스키마(필드):** `{table_ref, mapping_candidates:[{column_ref, target_field, unit_ref, evidence_ref}], unmapped_columns}`; 값 추출 결과는 없다.
- **도구/권한:** 입력 표의 헤더·예시만; 파서 설치·설정 적용 없음.
- **LLM 필요와 model tier:** `local / S`. **허용 엔진:** `local`. **캐시 접두 단위:** 허용 필드·단위 사전·표 유형.
- **성과 지표:** 골든 100건의 스키마 1.00, 후보 매핑을 적용한 게이트 통과 ≥ 0.95라는 ADR 목표; 아직 미측정. **실패·불확실 시:** `unmapped`로 보류 후 4절 `designer`가 파서 변경안을 검토한다. 유료 엔진으로 넘기지 않는다.
- **현재 대체·분할:** ADR-0004 T.10·7.8 `map_fields`; `table-extract`와 대응 제안의 권한을 나눈다.

#### `prose-extract`

- **목적:** 공개 HTML·markdown 산문 구간에서 인용 가능한 사실 후보만 추출한다. **입력:** 표시 본문에서 분할한 `PublicProseWindow` 한 건, `S`.
- **출력 스키마(필드):** `{window_ref, candidates:[FactCandidate], empty_reason}`; 엔티티 후보 ID, 합의·최종 검증 상태는 출력하지 않는다.
- **도구/권한:** 제공된 창·제목·최소 문맥만; 검색·KB 조회·제출 없음.
- **LLM 필요와 model tier:** `external / S`부터, 기준 미달이면 별도 시도에서 `M`. **허용 엔진:** `API`. **캐시 접두 단위:** 산문 추출 규칙·후보 스키마; 문서 공통 문맥은 뒤쪽 재사용 구간.
- **성과 지표:** 게이트·감사 조건 아래 수락 주장/총비용, 잘림률, 중복률. **실패·불확실 시:** 추출 불능은 빈 결과; 문맥 상한 초과는 동일 역할의 재분할; 근거 보류는 `claim-gate` 뒤 `entailment-judge`.
- **현재 대체·분할:** `prompts/extract.txt`, `extract/prompt.py`, `runner.py`, `windows.py`; `kb-collector`의 읽기·인용 부분. 공개 로컬 추출은 ADR-0004 7.8 불합격이므로 자동 후보에 넣지 않는다.

#### `longdoc-extract`

- **목적:** 긴 PDF·장문 문서의 한 절에서 절 문맥에 의존하는 사실을 추출한다. **입력:** 페이지·절·각주 위치를 보존한 `PublicDocumentSection` 한 건, `L`.
- **출력 스키마(필드):** `{section_ref, candidates:[FactCandidate], required_context_refs, unreadable_spans}`.
- **도구/권한:** 로컬 PDF 파서가 만든 지정 절만; 원본 파일 실행·다른 절 자유 탐색 없음. 표는 `table-extract` 입력으로 앞단에서 분리한다.
- **LLM 필요와 model tier:** `external / M`; 짧은 창의 성공 점수를 상속하지 않는다. **허용 엔진:** `API`. **캐시 접두 단위:** 장문 추출 규칙·각주 처리·절 스키마.
- **성과 지표:** 장문 골든의 근거 누락률, 페이지 대응 오류, 수락 주장/총비용. **실패·불확실 시:** `required_context_refs`를 반환해 결정적 조립기가 한정 보충; 읽을 수 없는 부분은 보류한다.
- **현재 대체·분할:** `pdf_doc`·`page_md` 뒤의 동일 L2 창 처리, `extract/windows.py`; 짧은 산문과 장문을 별도 평가군으로 만든다.

#### `transcript-extract`

- **목적:** 자막·전사 한 구간에서 화자와 시각에 귀속된 사실 후보를 추출한다. **입력:** 정렬된 `TimedTranscriptSegment` 한 건, `S`.
- **출력 스키마(필드):** `{segment_ref, candidates:[FactCandidate], speaker_refs, uncertain_spans}`; 모든 근거에 `media_time`을 요구한다.
- **도구/권한:** 로컬 VTT·SRT 파서 또는 로컬 ASR 결과만; 미디어 다운로드·외부 전송·임의 화자 신원 추정 없음.
- **LLM 필요와 model tier:** `local / S`, 역할별 합격 전에는 후보 보관만. **허용 엔진:** `local`; 일반 공개 산문 경로로 재분류하여 외부에 보내지 않는다.
- **캐시 접두 단위:** 자막 추출 규칙·화자/시각 스키마. **성과 지표:** 시각 근거 완전성, 전사 오류에 의한 오추출, 수락 후보/로컬 실행시간.
- **실패·불확실 시:** `uncertain_spans`로 남기고 같은 로컬 전사 구간의 재처리 대기; 사용자가 해소해야 할 의도 문제와 단순 인식 오류를 구별한다.
- **현재 대체·분할:** ADR-0004 11.3 미디어 계획·T.10, 향후 `vtt_srt` 뒤 추출; 미디어 바이트와 파생물을 외부 LLM에 보내지 않는 경계를 보존한다.

#### `code-extract`

- **목적:** 코드·API 레퍼런스의 서술에서 버전·시그니처·조건이 붙은 사실 후보를 추출한다. **입력:** 공개 `ApiReferenceBlock` 한 건, `S`; 기계 파싱 가능한 선언은 먼저 제거한다.
- **출력 스키마(필드):** `{block_ref, symbol_refs, candidates:[FactCandidate], unsupported_examples}`; 실행 예시를 실제 동작 관측으로 바꾸지 않는다.
- **도구/권한:** 참조 블록만; 코드 실행·패키지 설치·저장소 쓰기 없음. AST·명세 파서는 앞단에서 no LLM으로 처리한다.
- **LLM 필요와 model tier:** `external / M`; 정형 설명은 보정된 `S`와 비교 가능. **허용 엔진:** `API`.
- **캐시 접두 단위:** API 참조 추출 규칙·심볼/버전 스키마. **성과 지표:** 심볼·버전 오귀속률, 코드 예시의 사실 오인율, 수락 주장/총비용.
- **실패·불확실 시:** 누락된 버전·선언 위치를 보류하고 `claim-gate`로 전달; 의미 판정이 필요한 보류만 `entailment-judge`.
- **현재 대체·분할:** `prompts/extract.txt`로 함께 처리하던 개발 문서·README·API 참조; 선언 파싱과 자연어 해석을 분리한다.

#### `memo-extract`

- **목적:** first_party 메모 한 판에서 작성자 귀속의 주장·관계 후보를 추출한다. **입력:** `FirstPartyMemoRevision` 한 판의 한 구간, `S`.
- **출력 스키마(필드):** `{record_ref, record_version, author_ref, candidates:[FactCandidate], relation_mentions, sensitivity_floor}`; 외부 사실 검증을 주장하지 않는다.
- **도구/권한:** 신뢰된 로컬 서비스의 해당 메모만; `private` 본문은 개발 세션·일반 MCP에 보이지 않는다. 관련 비공개 기록을 따라 읽지 않는다.
- **LLM 필요와 model tier:** `local / S`; 명시 링크·구조 필드는 결정적 파싱 우선. **허용 엔진:** `local`.
- **캐시 접두 단위:** first_party 귀속·메모 추출 스키마. **성과 지표:** 작성자 보존율, 원본 최대 민감도 준수, 수락 후보/실행시간.
- **실패·불확실 시:** 원문을 보존하고 후보만 보류; 외부 사실은 내용 전송 없이 승인된 공개 출처 티켓으로 분리 가능한 경우에만 후속 조사한다. 민감 범위를 공개 티켓으로 복사하지 않는다.
- **현재 대체·분할:** `src/kb/extract/sensitive.py`, `tick_stage.py`의 first_party 큐, ADR-0005 5.8; 메모 추출과 `publish` 정제를 구별한다.

### 정규화·관계: 6개

#### `claim-normalize`

- **목적:** 추출 후보를 허용된 값 표기 규칙에 따라 정규화한다. **입력:** `FactCandidate` 한 건, `B`; 원문은 불변이다.
- **출력 스키마(필드):** `{candidate_id, normalized_fields, original_fields, applied_rule_ids, unresolved_fields}`.
- **도구/권한:** 날짜·수치·단위의 명시 규칙만; 누락값 보완·문장 재작성·원장 쓰기 없음.
- **LLM 필요와 model tier:** `none / D`. **허용 엔진:** `none`. **캐시 접두 단위:** 값 정규화 규칙·단위 사전 판본.
- **성과 지표:** 값 의미 변경 0, 동일 입력 재현성, 정규화 후 불일치율. **실패·불확실 시:** 모르는 값은 원형 유지 후 `claim-gate`; 함의 판정으로 값을 고쳐 쓰지 않는다.
- **현재 대체·분할:** `extract/items.py`, `gate/values.py`의 정규화와 대조 경계, `prompts/extract.txt`의 날짜·값 보정 책임.

#### `entity-resolve`

- **목적:** 명시 식별자를 기존 엔티티 후보에 연결한다. **입력:** 근거가 붙은 `IdentityMention` 한 건과 접근 가능한 인덱스의 후보, `B`.
- **출력 스키마(필드):** `{mention_ref, resolved_entity_ref, match_basis, candidate_refs, identity_evidence_refs, unresolved_reason}`.
- **도구/권한:** 외부 ID·동일 타입 별칭 인덱스 읽기만; 병합·라벨 변경·새 별칭 쓰기 없음. 공개 실행에는 공개 후보만 조회한다.
- **LLM 필요와 model tier:** `none / D`. **허용 엔진:** `none`. **캐시 접두 단위:** ID 대조 규칙·인덱스 판본·접근 범위.
- **성과 지표:** 오연결률, 결정적 해소율, 동음이의어 자동 병합 0. **실패·불확실 시:** `alias-propose`; 같은 표기만으로 병합하지 않는다. 주제 정의의 복수 앵커가 남으면 `topic_ambiguity`.
- **현재 대체·분할:** `extract/windows.py:candidates_for`, `schema.py`의 동적 주어 enum, 게이트 6단계와 ADR-0004 R.2; 추출 프롬프트에서 엔티티 선택을 걷어낸다.

#### `alias-propose`

- **목적:** 근거가 있는 표기 쌍의 동일 대상 후보를 제안한다. **입력:** `AliasPairPacket` 한 쌍, `P`; 짝 문서의 제목 또는 라벨 근거 두 개만 허용한다.
- **출력 스키마(필드):** `{pair_ref, proposal:alias|same_as|distinct|unknown, entity_refs, alias_forms, evidence_refs, reason_code}`.
- **도구/권한:** 해당 쌍만; 번역 문장 생성·엔티티 병합·별칭 쓰기 없음.
- **LLM 필요와 model tier:** `local / S`. **허용 엔진:** `local`. **캐시 접두 단위:** 별칭 비교·타입 호환 규칙.
- **성과 지표:** 골든 200쌍 이상에서 오병합 ≤ 0.02, 재현 ≥ 0.90라는 ADR 목표, 후보/초. **실패·불확실 시:** `entity-resolve`에 미해결 반환; `SAME_AS`·타입 충돌은 기존 사람 검토 경계를 유지하고, 6.8 신호 계약과의 정합성은 6절 질문에 남긴다.
- **현재 대체·분할:** ADR-0004 3.3·R.2·7.8 `alias`·`dedup`; `.claude/agents/kb-collector.md`의 새 엔티티·별칭 판단.

#### `relation-candidates`

- **목적:** 근거 구간에서 규칙으로 관계 후보를 열거한다. **입력:** 두 끝점의 위치가 붙은 `EvidenceSegment` 한 건, `B`; 문단·표·전사는 앞단에서 같은 위치 계약으로 변환한다.
- **출력 스키마(필드):** `{segment_ref, pairs:[{pair_id, left_ref, right_ref, mention_spans, rule_type, evidence_ref, basis}], existing_pairs_skipped}`.
- **도구/권한:** 별칭 위치·기존 엣지 읽기와 명시 문형 규칙만; 공동 출현을 세계 관계로 확정하지 않는다.
- **LLM 필요와 model tier:** `none / D`. **허용 엔진:** `none`. **캐시 접두 단위:** 언어별 문형 규칙·관계 타입 사전 판본.
- **성과 지표:** 후보 재현, 규칙 엣지의 게이트 통과, 불필요한 쌍 감소. **실패·불확실 시:** 규칙이 없는 쌍만 `relation-prefilter`; 규칙으로 결정된 엣지도 `claim-gate`의 끝점 검사를 받는다.
- **현재 대체·분할:** ADR-0004 R.3 1~2단계; R.2의 구조 관계는 `structured-extract`가 이미 생성하므로 중복하지 않는다.

#### `relation-prefilter`

- **목적:** 규칙 미해결 쌍에서 의미 관계 가능성이 없는 쌍을 거른다. **입력:** `UnclassifiedRelationPair` 한 쌍, `P`.
- **출력 스키마(필드):** `{pair_id, keep:yes|no|unknown, type_hints, reason_code}`; 타입 힌트는 최대 두 개이고 확정 엣지가 아니다.
- **도구/권한:** 두 라벨·타입·근거 한 구간만; 조회·외부 요청·쓰기 없음.
- **LLM 필요와 model tier:** `local / S`. **허용 엔진:** `local`. **캐시 접두 단위:** 관계 가능성 분류 규칙·허용 타입 사전.
- **성과 지표:** 골든 200쌍에서 관계 있음 재현 ≥ 0.95라는 ADR 목표, 제거율, 지연. **실패·불확실 시:** 미합격·미확인은 버리지 않고 `unknown`으로 유지; 공개이며 전송 허가된 쌍만 `relation-classify`, 나머지는 로컬 대기다.
- **현재 대체·분할:** ADR-0004 R.3 3단계, T.10 관계 후보 거르기; 최종 관계 분류와 별도 프롬프트·스키마를 쓴다.

#### `relation-classify`

- **목적:** 공개 근거 한 구간이 두 엔티티 사이의 어떤 관계를 진술하는지 판정한다. **입력:** 전송이 허가된 `PublicRelationPair` 한 쌍, `P`.
- **출력 스키마(필드):** `{pair_id, rtype_or_none, direction, qualifier, evidence_ref, exact}`; `none`도 정상 출력이다.
- **도구/권한:** 쌍과 허용 관계 목록만; 검색·병합·원장 쓰기 없음.
- **LLM 필요와 model tier:** `external / S`, 방향·조건 판정이 불충분하면 별도 시도에서 `M`. **허용 엔진:** `API`.
- **캐시 접두 단위:** 관계 분류 규칙·관계 타입·방향 스키마. **성과 지표:** 감사 조건 아래 수락 엣지/총비용, 방향 오류, `none` 정답률.
- **실패·불확실 시:** `claim-gate`로 후보 반환; 미해결은 보류한다. private·미디어 파생 근거는 이 입력 타입으로 만들 수 없다.
- **현재 대체·분할:** ADR-0004 R.3 4단계·7.4 `relate`; `kb-collector`의 읽기 결과와 관계 판단을 분리한다.

### 검증·생존: 4개

#### `claim-gate`

- **목적:** 제출 후보의 인용·값·끝점·귀속·생존 입장 조건을 결정적으로 검사한다. **입력:** `IngestCandidateBundle` 한 건, `B`; 항목 종류별 기존 검사기를 고정한다.
- **출력 스키마(필드):** `{items:[{candidate_ref, result, codes, verification, exact_selector, stance, speaker}], support_refs, live_refs, validated_bundle_ref}`.
- **도구/권한:** 스키마·정책·현재 원본·접근 가능한 별칭·생존 상태 읽기만; LLM 호출·권한 승격 없음. 원장 반영은 별도 단일 쓰기 서비스가 수행한다.
- **LLM 필요와 model tier:** `none / D`. **허용 엔진:** `none`. **캐시 접두 단위:** 게이트 판본·현재 원본/정책/생존 상태 판본; 상태가 바뀌면 재검사한다.
- **성과 지표:** 잘못된 인용 수락 0, 끝점 없는 엣지 통과 0, 기존 결정적 결과 재현성. **실패·불확실 시:** 공개 세 보류 코드만 `entailment-judge`; 생존은 `liveness-reader`, 인용 실패·주입은 기존 거부/격리 절차.
- **현재 대체·분할:** `src/kb/gate/*`, ADR-0001 10.6, ADR-0004 R.4. 기존 함수들을 묶는 서비스 경계이며 별도의 LLM 검사자를 추가하지 않는다. L1 `parser_derived`는 기존 `gate_l1` 생존 검사와 파서·근거 검증 경계를 유지한다.

#### `entailment-judge`

- **목적:** 보류된 공개 주장 한 건이 인용과 한정 문맥에 의해 뒷받침되는지만 판정한다. **입력:** `HeldPublicClaimPacket` 한 건, `P`; 대상은 `R_VALUE_MISMATCH`, `R_SUBJECT_CONTEXT`, `R_ALIAS_MISMATCH`뿐이다.
- **출력 스키마(필드):** `{claim_ref, supported:true|false, reason_code, evidence_refs, unresolved}`. 문장·인용·주어를 수정하지 않는다.
- **도구/권한:** 해당 주장·인용·문맥만; 검색·다른 주장의 판단·직접 `claim.review` 쓰기 없음.
- **LLM 필요와 model tier:** `external / J`, 역할 보정 통과 필수. **허용 엔진:** `API`, 추출 모델과 다른 모델 벤더만 허용한다.
- **캐시 접두 단위:** 함의 판정 기준·보정 세트 판본·스키마. **성과 지표:** 보정 오승인율, 감사 오류율, 정확히 해소된 보류/총비용; `true` 개수를 성능으로 삼지 않는다.
- **실패·불확실 시:** `needs_review` 유지 후 자동 해소가 끝나지 않은 경우에만 `gate_unresolved`; 판단어·비공개 주장은 이 경로로 보내지 않는다.
- **현재 대체·분할:** `extract/support.py:judge`·`run_queue`, `prompt.py:SUPPORT_SYSTEM`, `schema.py:SUPPORT_SCHEMA`; 불확실성을 표현할 수 있는 별도 계약을 제안한다.

#### `sample-auditor`

- **목적:** 표본으로 뽑은 수락 주장·관계의 의미 왜곡 여부를 독립 판정한다. **입력:** 샘플러가 고정한 `AcceptedEvidencePacket` 한 건, `P`; 생산자의 설명·추론은 제외한다.
- **출력 스키마(필드):** `{sample_ref, producer_run_ref, verdict:faithful|distorted|unresolved, error_codes, evidence_refs}`.
- **도구/권한:** 지정 표본과 불변 근거 읽기만; 원장 상태 변경·추출 수정·추가 표본 자의 선택 없음.
- **LLM 필요와 model tier:** `external / J`; 주장·엣지 표본은 계약 내 구별된 항목별 보정을 요구한다. **허용 엔진:** `API`, 생산자와 다른 모델 벤더·다른 세션.
- **캐시 접두 단위:** 표본 감사 기준·항목 유형·보정 판본. **성과 지표:** 왜곡 검출 재현, 감사자 오판율, 감사 표본/총비용; `unresolved`를 정상으로 세지 않는다.
- **실패·불확실 시:** 해당 팔의 감사 공백 기록; 다른 벤더가 없으면 감사 대기이며 동일 모델로 대체하지 않는다. 발견한 결함의 후속 판단은 기존 품질 루프가 맡는다.
- **현재 대체·분할:** `.claude/agents/kb-verifier.md`, `extract/support.py:cross_check`, ADR-0004 9장·R.5. 문자열 대조는 `claim-gate`가 하고 의미 대조만 남긴다.

#### `liveness-reader`

- **목적:** 1차 출처의 생존 근거를 H01~H11 신호로 읽어 정리한다. **입력:** 대상 한 개에 대한 공개 `LivenessEvidencePacket`, `S`; 구조 신호·발췌 위치가 이미 준비되어 있다.
- **출력 스키마(필드):** `{entity_ref, signals:[{h_code, evidence_ref, exact, effective_date, successor_mention, conditions}], conflicts, insufficient}`; 최종 상태 필드는 없다.
- **도구/권한:** 입력 근거만; 검색·등록·상태 확정·원장 쓰기 없음. 저장소·패키지의 구조 신호 수집과 최종 규칙 적용은 기존 결정적 생존 코드가 한다.
- **LLM 필요와 model tier:** `external / S`; 결론 없는 어려운 근거를 큰 모델로 무제한 반복하지 않는다. **허용 엔진:** `API`, 공개 근거만.
- **캐시 접두 단위:** H01~H11 근거 분류·후속/조건 스키마. **성과 지표:** 신호 분류 정확도, 근거 누락률, 규칙으로 해소된 대상/총비용.
- **실패·불확실 시:** 결정적 생존 규칙이 결론에 이르지 못한 충돌·부족만 `liveness_unresolved`; 단순 `removed`·`superseded`라는 이유로 HITL을 만들지 않는다.
- **현재 대체·분할:** `.claude/agents/kb-judge.md`, `kb-liveness-review`, ADR-0001 13장과 ADR-0005 6.8. `kb-judge`의 근거 정리 경계를 보존한다.

### 유지·메모 정제: 4개

#### `evidence-reconfirm`

- **목적:** 새 스냅샷에서 기존 인용·포인터 근거의 존속 여부를 대조한다. **입력:** `EvidenceRevisionPair` 한 건, `B`.
- **출력 스키마(필드):** `{evidence_ref, result:present|absent|ambiguous|degraded, new_selector, moving_window, affected_refs}`.
- **도구/권한:** 옛 근거와 새 스냅샷 읽기만; 자동 의미 재작성·새 추출 없음. 후속 confirm·expire·withdraw는 기존 규칙 서비스가 적용한다.
- **LLM 필요와 model tier:** `none / D`. **허용 엔진:** `none`. **캐시 접두 단위:** 인용 대조 규칙·피드 이동창·구조 변경 기준 판본.
- **성과 지표:** 잘못된 철회 0, 재확인/초, 모호한 위치의 오확정 0. **실패·불확실 시:** 구조 변경은 `degraded`와 재파싱 요청; 로컬 문장 찾기 후보를 추가하는 일은 정확도 목표를 통과한 후 별도 역할로 제안한다.
- **현재 대체·분할:** `src/kb/extract/reconfirm.py`, ADR-0004 R.6. `event` 유지·이동창 예외를 보존하고 7.8 `recheck`의 미합격 후보를 확정기로 쓰지 않는다.

#### `coverage-report`

- **목적:** 주제·수집기 운영 집계를 공백과 수율 자료로 계산한다. **입력:** 고정 시점의 `OperationalMetricSnapshot` 한 건, `B`.
- **출력 스키마(필드):** `{topic_ref, gaps:[{kind, count, target_refs}], source_yields, role_costs, cache_metrics, audit_gaps, cadence_flags}`.
- **도구/권한:** 집계용 운영 상태 읽기만; 원문·비공개 제목·정책 변경·레지스트리 수정 없음.
- **LLM 필요와 model tier:** `none / D`. **허용 엔진:** `none`. **캐시 접두 단위:** 집계 정의·기간·메트릭 스키마.
- **성과 지표:** 원자료와 합계 일치, 공백 누락 0, 쓸모없는 재발견 호출 감소. **실패·불확실 시:** 누락된 계측을 표시하고 4절 `designer`에 개선 요청; 정의된 공백은 코드가 발견 슬롯으로 되돌린다.
- **현재 대체·분할:** ADR-0004 T.7·9장, `kb retro`의 지표 정리. `.claude/agents/kb-retro.md`의 제안 작성은 개발 세션의 별도 설계 변경안으로 옮긴다.

#### `memo-refine-local`

- **목적:** 한 메모의 짧은 구간을 의미 추가 없이 정제 초안으로 바꾼다. **입력:** 로컬 준비에서 고정한 `LocalMemoRefinementPacket` 한 건, `S`; 한 판·한 메모만 포함한다.
- **출력 스키마(필드):** `{source_record_ref, source_version, drafts:[{type, body, source_spans}], unresolved, fidelity_flags}`; 후보는 계속 `private`다.
- **도구/권한:** 신뢰된 로컬 서비스의 해당 판만; 관련 기록 조회·외부 호출·결과 공개·원본 수정 없음.
- **LLM 필요와 model tier:** `local / S`; 단순 서식은 결정적 코드 우선. **허용 엔진:** `local`.
- **캐시 접두 단위:** 짧은 메모 정제 규칙·초안 스키마. **성과 지표:** 원문 의미 보존, 사용자 확정 결과/로컬 실행시간, 불필요한 외부 호출 감소.
- **실패·불확실 시:** 로컬 준비기는 길이·미해결 구간·품질 플래그로 외부 필요성을 먼저 판단한다. 필요할 때만 `memo-refine-external`용 고정 요청을 만들며, 동의 전에는 호출하지 않는다. 동의가 없으면 로컬 결과 유지 또는 명시적 보류다.
- **현재 대체·분할:** ADR-0005 5.10 로컬 준비, 일반적인 정제자에서 짧은 메모 경로를 분리한다. 분할·배치 조립은 코드가 맡는다.

#### `memo-refine-external`

- **목적:** 로컬 처리로 부족한 긴 메모 구간을 동의된 범위 안에서 정제한다. **입력:** 서버가 전송 동의를 검증한 `ConsentedMemoRefinementPacket` 한 건, `L`; 고정한 요청 바이트·엔진·모델에 묶인다.
- **출력 스키마(필드):** `{action_ref, source_version, external_payload_sha, drafts:[{type, body, source_spans}], fidelity_flags, unresolved}`; 자동 공개 상태는 없다.
- **도구/권한:** 고정 요청 한 번의 모델 호출만; 검색·다른 메모 읽기·자동 재시도·엔진 변경·원본 수정·공개 없음.
- **LLM 필요와 model tier:** `external / M`. **허용 엔진:** 동의에 묶이고 실행기가 있는 `API` 팔 하나.
- **캐시 접두 단위:** 긴 메모 정제 규칙·초안 스키마; private 접두·결과의 외부 캐시 보존은 승인된 전송 매개변수에 포함하고 제공자 보존 정책을 확인하기 전에는 공유 캐시를 켜지 않는다.
- **성과 지표:** 사용자 확정 결과/총비용, 원문 의미 변경률, 동의 없는 호출 0. **실패·불확실 시:** 새 외부 전송에는 새 동의; 불확실한 전송 예약은 유지한다. 외부 미가용이면 로컬 결과 또는 실패 상태를 반환한다.
- **현재 대체·분할:** ADR-0005 5.10 외부 정제 경로. `publish_external_refine` 전송 동의와 결과의 `publish` 확인을 서로 대체하지 않는다.

## 2. 역할 간 분리 규칙

### 생산자·판정자의 독립성

| 역할 쌍 | 강제 분리 | 적용 방식 |
|---|---|---|
| `prose-extract`, `longdoc-extract`, `code-extract` → `entailment-judge` | 다른 모델 벤더·다른 모델·새 세션 | 추출자의 설명·이전 대화 없이 주장·근거만 전달한다. 다른 중계 엔진으로 같은 모델을 부르는 것은 독립 검증이 아니다 |
| 추출·`relation-classify` → `sample-auditor` | 다른 모델 벤더·다른 모델·새 세션 | 감사기는 자체 보정 통과가 필요하고 생산 팔의 품질 조건만 갱신한다. 주장 상태를 직접 바꾸지 않는다 |
| `relation-prefilter` → `relation-classify` | 다른 역할·스키마 | 로컬 거르기의 재현을 먼저 보장한다. 외부 판정은 원래 근거를 보고 힌트를 정답으로 취급하지 않는다. 이 쌍은 서로 독립 감사자가 아니므로 다른 벤더를 강제하지 않는다 |
| `liveness-reader` → 생존 규칙 적용기 | 읽기와 상태 확정 권한 분리 | LLM은 H 신호만 낸다. 구조 신호와 규칙이 상태를 정하고 미해결만 사람에게 간다 |
| 정제자 → 외부 전송·공개 실행기 | 콘텐츠 생산과 권한 검증 분리 | 모델의 `ready`·작성자 주장·동작 요청으로 동의를 대신할 수 없다 |

기존 ADR은 교차 감사에 다른 벤더를 요구한다. 이 제안은 같은 추출 오류가 함의 판정으로 통과하는 것을 줄이기 위해 `entailment-judge`에도 이를 확대한다. 이는 **제안된 변경**이며 현재 코드가 이미 보장한다고 적지 않는다. `model_vendor`는 모델 계열의 제작사이고 `provider`는 실제 실행 제공자, `engine`은 호출 경로다. 셋을 구별하며 벤더를 확인할 수 없으면 독립 감사 팔로 쓰지 않는다. 자기 출력의 재검사는 형식 교정일 뿐 감사로 집계하지 않는다.

### private와 외부 호출 경계

| 범위 | 허용 역할 | 경계 |
|---|---|---|
| `private` 본문을 처리할 수 있는 로컬 LLM | `topic-plan`, `sensitivity-classify`, `memo-extract`, `memo-refine-local`, 필요시 로컬 별칭·관계 후보 역할 | 신뢰된 KB 서비스 안에서만 처리한다. 개발 세션·일반 MCP는 읽지 못한다 |
| 원칙적으로 private를 받지 않는 역할 | `prose-source-scout`, `prose-extract`, `longdoc-extract`, `code-extract`, `relation-classify`, `entailment-judge`, `sample-auditor`, `liveness-reader` | 입력 스키마 생성 단계에서 public 원본·제목·후보·근거를 모두 확인한다 |
| private 처리 가능 예외 | `memo-refine-external` | ADR-0005 5.10의 해당 메모 판·실제 전송 해시·엔진·모델에 묶인 사전 WebAuthn 동의 한 번만. 다른 private 제목·링크·메모는 포함하지 않는다 |
| 결정적 파서·게이트·재확인 | 로컬 기반 계층 및 해당 `none` 역할 | 현재 원본 민감도 최댓값과 접근 범위를 유지한다. 역할 이름만으로 읽기 권한을 얻지 않는다 |
| 미디어와 파생 전사 | `transcript-extract`, 로컬 후보 처리 | 바이트와 파생물을 외부 LLM에 보내지 않는다. 공개 자료라는 이유로 일반 산문 팔에 섞지 않는다 |

`internal`도 자동 외부 허용이 아니다. first_party 제목·별칭·제외어·검색어의 내보내기 허가를 개별 확인한다. `private TopicSpec`의 외부 검색·LLM 내보내기는 계속 금지다. 비밀 탐지로 `secret`이 된 자료는 일반 역할 큐에 넣지 않는다. 원본 민감도 변경은 이미 만든 주장·복사 근거·관계·색인·캐시 읽기에도 즉시 적용한다.

외부 엔진 호출 권한은 위 카탈로그에서 `external`인 9개 역할에만 있다. 그중 검색 도구를 쓰는 것은 `prose-source-scout`뿐이다. 나머지는 고정 입력의 단발 호출이다. `local` 역할이 실패하거나 GPU가 바쁘다고 외부 팔을 추가하지 않는다. 공개 창 거르기나 관계 거르기를 건너뛰는 경우는 사전 정의된 코드 경로로 기록하며, 민감 입력의 전송 허가를 바꾸지 않는다. ADR-0004 T.2의 애매한 해당성 판단에 대한 API 대체 문구는 T.10의 로컬 과제 유료 대체 금지와 맞지 않으므로, 이 제안은 T.10 쪽으로 통일한다. 이는 후속 ADR 개정 항목이다.

HITL은 ADR-0005 6.8의 `topic_ambiguity`, `source_policy`, `liveness_unresolved`, `gate_unresolved`라는 미해결 신호로만 올린다. 스키마 오류, 타임아웃, 빈 결과, 바쁜 GPU는 재처리·대기·오류 상태다. 사용자 시작 동작인 `release`, `declassify`, `publish`, `publish_external_refine`는 HITL 항목과 별개이며 각각의 사람 증명을 보존한다. 사람의 `accept`는 `review_state`를 바꾸며 `verification=needs_review`와 원래 문장·인용을 유지한다.

## 3. 역할 내부의 엔진 선택과 E1 영향

### 역할을 먼저 고르고 그 안에서 팔을 선택한다

현재 E1도 이미 `Arm(task, engine, model)`로 과제 종류를 구별한다. 문제는 모든 산문을 `extract`, 여러 에이전트 작업을 `agent`라는 넓은 통계군으로 합치고, 그 단위에서 좋은 모델을 고르는 데 있다. 제안은 선택기 복제를 늘리는 것이 아니라 **과제의 식별·허용 팔·합격 기준을 작은 역할의 계약에 귀속시키는 것**이다.

요청은 코드가 `input_kind`, 민감도, 길이, 필요한 연산으로 역할 DAG에 배치한다. 다음으로 역할의 결정적 경로를 확인한다. LLM이 필요하면 해당 역할이 가진 허용 팔에서 정책·권한·보정·실행기·예산·용량을 충족하는 것만 남기고 선택한다. 같은 팔로 시작한 한 실행은 끝까지 고정한다. 후속 역할은 새 입력과 새 예산 예약을 가진 별도 실행이다. 실패 직후 새 역할 이름으로 호출 비용·정지 규칙을 우회할 수 없다.

`role × engine`의 실제 팔 키는 `(role_id, role_version, context_profile, engine, model, calibration_version)`다. 역할 판본은 프롬프트·출력 계약을 고정한다. 같은 모델의 PDF 추출 성적을 HTML 추출에 쓰거나, local 정제의 결과를 함의 판정 성적으로 쓰지 않는다. 세분화로 표본이 부족해지면 동등한 계약임이 검증된 역할 판본 사이에서만 통계를 이어받는다. 무측정 팔은 제한된 파일럿에서 결과를 모을 수 있지만 생산 승인을 받은 팔로 표시하지 않는다.

`RolePolicy`의 필드는 `{role_id, input_schema, output_schema, context_profile, deterministic_executor, allowed_engines, model_tiers, min_quality, calibration_ref, external_permission, tools, cache_prefix_version, max_cost, max_duration, escalation}`다. 출력 JSON Schema와 enum·길이·필수 근거 참조는 기계 검증한다. 입력 종류나 문맥 상한이 바뀌면 역할 또는 계약 판본을 나눈다. 프롬프트에서 임의 역할을 고르게 하지 않는다.

### E1에서 유지할 것과 역할로 구분할 것

| 현재 위치 | 유지 | 역할별로 바꿀 계약 |
|---|---|---|
| `src/kb/extract/engines.py` | 자동 엔진 허용 목록, 인증 검사, 엔진 상태·상한 확인, 단일 팔 고정, 탐색/활용 공통 알고리즘 | `Arm.task`의 넓은 식별을 `role_id` 중심으로 확장한다. `LOCAL_TASKS`의 문자열 목록 대신 `RolePolicy.allowed_engines`를 사용하고, 품질 바닥·표본 크기·성과 단위를 역할에서 읽는다 |
| 같은 파일의 `record`, `score`, `record_audit` | 비용·거부·보류·스키마 실패·감사 분리 | 통계는 역할·문맥·계약 판본별로 남긴다. 감사 결과를 마지막 행에 붙이는 방식 대신 정확한 `producer_run_id`에 결합한다. 확인 불가 감사는 미감사로 둔다 |
| `src/kb/extract/route.py` | 전역·엔진 정지, 예산 경계, 실행기 유무 확인, 실행 중 대체 금지 | `plan(scope, purpose)` 앞에 역할 계약을 받는다. 모델명 문자열에서 추측하던 벤더를 검증된 `model_vendor` 메타데이터로 대체한다. 함의·감사 모두 생산자 벤더를 필수 입력으로 받는다 |
| `src/kb/extract/types.py`, `prompt.py`, `schema.py` | `Job`·`Result`·원응답 처리, 전송 스키마와 정본 검증 분리, 문서 구획 보호 | `role_id`, `role_version`, `input_kind`, `context_profile`, provenance를 명시한다. 하나의 `extract.txt`·동적 주어 enum을 자료별 추출 계약과 후속 해석 계약으로 나눈다 |
| `src/kb/extract/runner.py`, `sensitive.py`, `support.py` | CAS 원응답, 재생, 큐 임대·반환, 결정적 게이트, 민감도 재검사 | 산문·PDF·코드·메모별 실행 결과를 별도로 기록한다. 함의와 감사의 입력·스키마·효과를 분리한다. 결과를 크게 한 번 생성하고 역할 라벨만 붙이는 방식은 쓰지 않는다 |
| `src/kb/extract/cache.py` | 완료 표시는 엔진·모델 선택과 독립, 재구축 시 재호출 없음, 명시적 재추출 | 완료 키는 `(role_id, input_sha, role_version, schema_version)`로 구분한다. 원응답 키는 여기에 엔진·모델·접근 범위를 더한다. 프롬프트 접두 캐시와 원응답 재생 캐시는 구별한다 |
| `src/kb/extract/budget.py`, `guard.py` | 엔진별 하나의 지출 원장, 예약·정산·불확실 비용, 전송 직전 검사 | 예약에 `role_id`, `run_id`, `topic_ref`, `parent_run_id`를 붙여 귀속한다. 역할별 비용은 집계 축이며 엔진 예산을 중복 생성하지 않는다. publish 동의는 선택기 밖에서 검증한다 |
| `src/kb/agentrun/auth.py` | 격리 환경, 현재 코드의 인증 helper, 서명 검증, 하위 도구에 인증값 비상속, 비밀 제거 | 역할별 도구 허용 목록을 더 좁힌다. 역할 분해 때문에 인증 경계나 구독 차단을 되돌리지 않는다 |
| `src/kb/agentrun/invoke.py` | 명시 엔진, 실행 상한, 격리 설정, 결정 게이트, 실행 가능한 조합만 지원 | `JOBS`의 넓은 워크플로우를 코드 DAG가 구동하는 역할 요청으로 바꾼다. `--role`과 계약 참조를 검증하고, 각 역할에는 자기 도구만 준다. 기존 잡 이름은 이행용 진입점으로 남길 수 있다 |
| `src/kb/agentrun/runner.py` | 서명 누락 실패 처리, 사고 수거, 스트림 보관, 예산 초과 정지 | 현재 `Arm('agent', ...)`를 실제 역할 팔로 기록한다. 모든 성공을 `accepted` 주장 수로 환산하지 않는다. 출처 후보 역할은 채택 출처, 감사 역할은 정답 판정 단위로 기록한다 |
| `src/kb/agentrun/stream.py`, `record.py`, `verdict.py` | 사고 분리·실행 결과·권한 거부 검사 | 실행 성공과 역할 출력 성공을 분리한다. 역할 스키마·후속 수락 결과·근거 참조를 확인하며, 오류 없는 프로세스 종료만으로 역할 완료를 선언하지 않는다 |

`docs/research/e1-engine-isolation.md`의 범위 경계는 유지한다. O1의 직접 API·Batch와 A1의 추가 실행 환경을 이번 역할 분해에 끼워 구현하지 않는다. 선택기가 지원하는 엔진이라도 실행기가 없으면 후보에서 빠진다. 해당 메모와 현재 `auth.py`의 세부 방식이 다르면 현재 코드를 기준으로 검토하고, 인증 경계를 단순화한다는 이유로 제거하지 않는다.

이행 중 기존 `extract`·`agent` 통계는 보존하되 새 역할에 복제하지 않는다. 과거 입력 형식을 확실히 구분할 수 있는 기록만 명시적 변환으로 연결하고, 나머지는 `legacy_unclassified`로 남긴다. 기존 `extractor` 식별자도 보존하고 별도 역할 provenance를 덧붙여 일괄 철회와 옛 원응답 재생을 유지한다. `done_carry` 역시 동등성이 확인된 기존 공개 산문 완료 표시에만 연결하며, 역할 판본 변경이 전체 자료의 유료 재추출을 시작하지 않게 한다.

ADR-0004 5.2의 산문 수락 주장 비용 추정은 새 30개 역할의 성과가 아니다. 도구 왕복과 단계별 출력 때문에 분해만으로 비용이 줄었다고 말할 수 없다. 추출→정규화→해석→게이트→감사까지의 총비용, 단계별 지연, 캐시 적중, 최종 수락 단위를 함께 측정해야 한다. 순수 형식 변환은 같은 프로세스의 함수 호출로 묶고 LLM 대화 왕복을 만들지 않는다.

## 4. KB를 만드는 개발 세션의 역할

개발 역할은 10개다. 리드는 관제만 하고 작업은 아래 역할에 맡긴다. KB 내부의 자동 실행 엔진 선택과 개발자의 Codex 세션 선택은 다르다. 이 표는 `CLAUDE.md`의 「Codex 우선」에 따른 제안이며, Superpowers 실행 연결은 [ADR-0006](../adr/0006-dev-workflow-superpowers.md)의 2026-11-04 사용자 승인으로 구체화했다. 승인된 흐름의 단계별 로컬 커밋만 허용하며 배포·push·PR·merge·외부 메시지를 허가하지 않는다. 네 `sp-*` 정의는 아래 역할의 실행 수단이고 새 역할이 아니다.

- **§4 운영 규칙(2026-11-05 CLAUDE.md 반영)**
  - **검토 결과:** 검토자는 발견 사항을 최종 메시지로 반환하며 검토 보고서 파일 경로를 요구받지 않는다. 기록 파일이 필요한 과제에서는 `doc-writer`가 그 최종 메시지를 근거로 작성한다. (근거: 프로젝트 `CLAUDE.md` 「Superpowers 적용」.)
  - **검토 패키지 경로:** `review-package`의 `OUTFILE`은 디렉터리가 아닌 파일 경로다. (근거: 프로젝트 `CLAUDE.md` 「Superpowers 적용」.)
  - **작업 격리와 소유권:** worktree는 기본으로 만들지 않는다. 병렬 구현 작업은 읽기 전용 또는 서로 다른 파일을 다룰 때만 허용하며, 같은 파일 묶음의 수정자는 한 명이다. (근거: 프로젝트 `CLAUDE.md` 「Superpowers 적용」.)
  - **워커 보고:** 결론, 근거 경로, 완료 기준별 통과·실패를 보고한다. 긴 내용은 파일에 쓰고 경로만 보고한다. 팀원 보고는 4,000자에서 잘린다. (근거: 공통 `CLAUDE.md` §1 「리드는 관제하고 작업은 워커가 한다」·§2 「토큰을 아낀다」.)
  - **Orca 협업:** Orca는 협업에만 쓴다. 먼저 `task-create --spec`으로 작업을 만든 뒤 `worker-start --task`로 실행한다. `worker_done`은 preamble의 Task·Dispatch ID를 따른다. 각 리드는 자기 Run을 소유하고 상대에게 `send --to run:<상대 Run>`으로 보낸다. 소비형 `check` 전에 `check --peek`로 확인한다. Codex 신뢰는 경로 단위이며 설정 변경은 사용자 승인을 받는다. (근거: 공통 `CLAUDE.md` §8 「다른 회사의 에이전트는 어댑터로 부른다」.)
  - **회사 간 검토:** Codex 판정이 충돌하거나 미검증 항목을 남겼을 때만 Claude 검토자를 추가한다. 되돌리기 어려운 단계의 교차 검토 여부는 §6의 사용자 결정으로 남기며, 질문 5의 답은 잠정 상태다. (근거: 프로젝트 `CLAUDE.md` 「Superpowers 적용」, 이 문서 §6-1 「사용자 답변」.)

공통 인계 `DevHandoff`는 `{task_id, role_id, purpose, observable_result, inputs:[{path, revision_or_sha}], allowed_paths, forbidden_actions, output_schema, acceptance, verification_command_or_evidence, deadline, timeout_s, upstream_task_ids}`다. 반환은 `{status, artifacts, changed_paths, acceptance_results, verification:[{command, exit_code, evidence_ref}], retries, unresolved, incidents}`다. 변경 가능한 경로와 결과를 묶고, 같은 파일 묶음의 수정자는 한 명이다. 다음 역할은 필요한 산출물과 근거만 받으며 이전 세션 대화 전체를 상속하지 않는다.

| id·목적 | 모델·벤더·허용 환경 | 입력 → 출력 스키마 | 도구/권한·인계 | 캐시 접두·성과·실패 시 |
|---|---|---|---|---|
| `lead`: 작업 배치·통합 판단 | Codex `gpt-6.1-sol`, `high`, OpenAI 우선. 사용자의 기존 리드가 Claude라면 관제 세션은 유지 | `UserTaskEnvelope` → `{task_graph, assignments, blockers, reviewed_evidence_refs, user_decisions}` | 워커 조율·보고·근거 읽기만. 직접 구현·시험 재실행 없음. `DevHandoff`로 목적과 사용자가 확인할 위치를 먼저 전달 | 관제 계약·위임 기준 고정. 사용자 정정·누락 인수 항목 감소. 근거 부족은 해당 역할에 반환 |
| `designer`: 한 변경안 설계 | Codex `gpt-6.1-sol`, `high`, OpenAI | 제약·코드 근거·계측을 묶은 `DesignBrief` → `{decision, interfaces, invariants, migration, validation_plan, open_questions}` | 읽기 전용 코드 조사·설계 산출물만. 구조 spec은 `docs/adr`, 작은 설계·실행 계획은 `docs/plans`에 쓴다. 계획 작성도 이 역할의 별도 과제로 받는다. 회고 지표도 명시적인 설계 과제로 받는다. 구현·운영 변경 없음 | 설계 검토 기준·인터페이스 템플릿. 설계 재작업률. 맥락·요구 불명확은 `lead` |
| `implementer`: 확정 설계 구현 | Codex `gpt-6.1-sol`, `medium`, OpenAI; 실패·낮은 확신이면 `high` | 승인된 `ImplementationBrief` → `{patch_ref, changed_paths, assumptions, verification_refs}` | `sp-implementer` relay로 지정 제품 파일 수정·TDD와 허용된 좁은 로컬 확인만. 소켓 시험·커밋·배포는 다음 역할에 인계 | 언어·코딩 규칙·계약 고정. 수락 변경/비용·결함 재발률. 설계 모순은 `designer`, 권한 제약은 해당 실행 역할 |
| `reviewer`: 산출물의 독립 결함 검토 | 별도 Codex `gpt-6.1-sol` 세션 `high`, OpenAI. 작성자가 Claude면 Codex. Superpowers의 회사 간 중복 검토는 판정 충돌 때만 Claude Sonnet `high` 또는 판단 난도에 따라 Opus `high` | 불변 `ReviewPacket` → `{findings:[{severity, file_ref, evidence_ref, consequence}], verdict, missing_checks}` | `sp-reviewer` relay로 커밋 뒤 `review-package`의 `BASE..HEAD`를 읽기 전용 검토. 작성자의 자기 검토를 독립 검토로 세지 않는다. 일반 검토의 Codex·Claude 중복 실행 없음 | 보안·원장·게이트별 검토 기준. 근거 있는 결함·오탐률. 판단 불일치는 코드·실행 근거로 가르고 불가하면 `lead` |
| `test-runner`: 지정 검증 실행 | Superpowers는 `sp-test-runner`: Codex 샌드박스 밖 Claude Haiku `low`, Anthropic. 일반 흐름은 승인된 샌드박스 밖 Codex `gpt-6.1-sol`, `low`, OpenAI 우선. 렌더링 해석은 Sonnet `medium` | 고정 산출물과 `VerificationPlan` → `{artifact_sha, commands, exit_codes, result_refs, environment_limits, render_refs}` | 최종 인수 시험은 Codex 샌드박스 밖에서 실행한다. 샌드박스 안의 순수 TDD 근거는 구현자가 인계한다. task에 지정된 좁은 시험만 실행하며 전체 suite·`tests/mcp/test_claude_real.py` 읽기·수정·실행·`KB_LIVE` 사용은 금지한다. 실패를 통과시키려고 제품 코드나 시험을 수정하지 않는다. 렌더링은 별도 검증 작업으로 받는다 | 검증 절차·환경 규격. 재현 가능한 종료 코드·렌더링 근거. 실패는 `implementer`, 환경 결함은 `lead` |
| `committer`: 검증 산출물의 커밋 | 이 환경에서 `.git` 쓰기가 가능한 Claude Haiku `low`, Anthropic. 메시지·파일 목록 준비는 Codex 가능 | 사용자 커밋 요청 또는 ADR-0006의 기존 승인과 `CommitPacket` → `{commit_ref, included_paths, artifact_sha, verification_refs}` | `sp-committer`가 현재 브랜치에서 승인된 파일 목록만 로컬 커밋하고 검토 패키지를 만든다. 코드 수정·검증 생략·push·PR·merge·amend·reset 없음. 실제 diff와 검증한 해시를 재대조 | 커밋 절차 고정. 의도하지 않은 파일 포함 0. 불일치면 실행을 멈추고 `lead` |
| `deployer`: 검증된 릴리스 적용 | 운영 권한이 있는 샌드박스 밖 Claude Haiku `low`, Anthropic. 배포계획 검토는 Codex `high` | 승인된 `ReleasePacket` → `{release_ref, before_state_ref, after_state_ref, health_results, rollback_ref}` | 승인된 배포·상태 확인·정해진 롤백만. 제품 코드 수정·임의 DB 조작 없음. 배포 권한이 실제 주어진 경우에만 배치 | 릴리스 절차·건강 확인 계약. 사용자 관측 결과·복구 가능성. 이상은 정해진 롤백과 `lead` 보고 |
| `doc-writer`: 확정 근거의 문서화 | Codex `gpt-6.1-sol`, `medium`, OpenAI | `DocumentationPacket` → `{document_ref, source_refs, changed_paths, unresolved}` | 지정 문서만 수정. 제품 설계 결정·출처 없는 사실 추가·ADR 승인 상태 변경 없음 | 문서 유형·용어·출력 구조. 누락·근거 불일치·사용자 정정. 설계 미결은 `designer` |
| `primary-researcher`: 질문에 대한 1차 출처 조사 | Codex `gpt-6.1-sol`, `medium`, OpenAI; 도구가 허용되는 세션에서만 수행 | 범위가 고정된 `ResearchQuestion` → `{claims, primary_source_refs, checked_at, version_refs, alternatives, unknowns}` | 승인된 검색·문서 읽기만. 구현·KB 쓰기 없음. 비공개 질의는 외부로 내보내지 않는다 | 조사 질문 유형·출처 평가 규칙. 1차 출처로 확인한 결론/비용. 출처 접근 불가는 원인·남은 불확실성 포함해 `lead` |
| `kb-recorder`: 보관할 결정과 이유 접수 | tower MCP에 닿는 Claude 리드 세션, Haiku `low` 상당의 정형 작업, Anthropic. 모델 변경을 위해 새 범용 세션을 만들지 않는다 | 정제한 `RetentionPacket` → `{stored_refs, idempotency_key, approval_result, blocked_reason}` | 기존 리드의 전용 기록 단계에서 `kb_put`·`kb_request`만. 호출별 사용자 확인 유지; `-p`·Codex 워커에서 우회하지 않는다. 외부 사실은 1차 출처를 붙인 요청으로 분리 | 기록 스키마·비밀 제거 기준. 중복 저장 0·보관 가능한 결정 회수율. MCP·승인 부재면 리드에게 보관 후보만 반환 |

이 환경의 알려진 Codex 제약은 `.git` 읽기 전용, 소켓 차단, Claude scratchpad 쓰기 불가, 기본 실행 제한 600초다. 구현 실패와 환경 실패를 구별해야 한다. 일반 Codex 구현·문서 작업은 그대로 수행하고, 막힌 커밋·소켓 시험·MCP·렌더링만 해당 Claude 역할에 넘긴다. 운영 적용도 현재 샌드박스 밖의 승인된 실행 주체가 필요하다. 이 조건을 Codex 제품 전체의 영구 제약으로 일반화하지 않는다.

긴 작업은 `AGENT_TIMEOUT`을 명시하고 같은 세션의 후속 지시는 반환된 `[session]` ID를 `AGENT_RESUME`으로 전달한다. Superpowers relay의 기본 1800초는 해당 프로젝트 정의에 한정하고 어댑터의 전역 기본값은 바꾸지 않는다. 새 구현·검토 세션은 재개 변수를 해제하며 검토자는 구현자 세션을 재사용하지 않는다. 임시 자료는 `$TMPDIR`에만 둔다.

Superpowers의 승인된 흐름은 `lead → designer(설계·계획) → sp-implementer → sp-test-runner → sp-committer → sp-reviewer`이며, 수정은 구현자로 돌아가 같은 순서를 거친다. 검토는 커밋된 범위를 요구하므로 시험·커밋 뒤에 배치한다. 일반 변경의 흐름은 `lead → designer → implementer → reviewer / test-runner → committer → deployer`다. 독립 검토와 시험은 같은 불변 산출물을 병렬로 읽을 수 있으나 Superpowers의 커밋 전 시험과 커밋 후 검토 순서는 지킨다. 배포는 별도 요청·권한이 있을 때만 실행한다. 문서 작성과 1차 출처 조사는 필요한 과제에만 배치하고, 끝난 결정·측정·근원 분석은 `kb-recorder` 입력으로 만든다. KB 내부 모델이 세계 사실을 정리하는 일과 개발 세션이 설계 결정을 내리는 일을 혼합하지 않는다.

## 5. 현재 LLM 호출 위치의 대응과 이행 순서

아래 번호는 ADR-0004 3.1의 10개 호출 위치다. 그 표의 행 번호·라우팅은 당시 진단이고, 현재 E1 코드는 일부를 이미 바꿨다. 특히 `route.py`는 API 팔 고정과 자동 구독 차단을 구현 중이므로 과거 대체 사다리를 다시 만드는 계획으로 읽지 않는다.

| 현재 호출 위치 | 새 역할·경로 | 제거·보존할 책임 |
|---|---|---|
| 1. L2 공개 추출, `kb agent run --scope public`, `extract/runner.py` | 구조는 `structured-extract`·`table-extract`; 산문은 `prose-extract`, PDF는 `longdoc-extract`, API 서술은 `code-extract` → `claim-normalize` → `entity-resolve` → `claim-gate` | 구조·변경 로그의 중복 L2 제거, 번역본 제외 유지. 미디어는 `transcript-extract`의 로컬 경로로 분리 |
| 2. L2 민감 추출, `--scope sensitive`, `extract/sensitive.py` | 로컬 `sensitivity-classify` → `memo-extract` → 정규화·로컬 해석 → `claim-gate` | 외부 전송·외부 함의 판정 없음. `publish` 동의 예외를 일반 민감 추출에 적용하지 않음 |
| 3. 함의 판정, `extract/support.py:judge`·`run_queue` | `entailment-judge` | 공개 세 코드만, 다른 모델 벤더·보정 통과. 모델은 판정만, 서버가 기존 `claim.review` 효과 적용 |
| 4. 교차 확인, `extract/support.py:cross_check` | `sample-auditor` | 추출과 분리된 입력·목표·팔. 정확한 생산 실행에 감사 결과 귀속, 주장 상태 직접 변경 없음 |
| 5. 활용률 카나리아, 과거 `extract/route.py` | LLM 역할 제거; 기존 결정적 인증·정지 검사만 유지 | 자동 작업의 소비자 구독 제거 유지. 품질 파일럿과 유료 활용률 카나리아를 구별 |
| 6. 티켓 처리 `kb-fulfill`, `agentrun/invoke.py` | 코드 DAG: `topic-plan` → `protocol-discover` → 필요한 `prose-source-scout` → 정책·수집 → 자료별 추출·게이트 | 하나의 티켓 처리자에게 탐색·읽기·적재를 모두 허용하지 않음. 티켓의 해결 여부·`ANSWERS` 결합은 결정적 조립기가 계산 |
| 7. 생존 검토 `kb-liveness-review` | 구조 신호는 기존 `kb live run`, 산문 근거만 `liveness-reader` | `kb-judge`의 근거 정리 유지, 최종 생존 확정·효과 적용은 코드. 미해결 신호만 HITL |
| 8. 회고 `kb retro` | `coverage-report`로 LLM 집계 제거; 변경 제안이 필요하면 4절 `designer`에 별도 개발 과제 | `kb-retro`의 넓은 자동 제안 세션은 종료 대상. prompt·cadence·vocabulary·adapter 변경은 근거 있는 변경안으로 검토하며 trust·policy·전역 지침 자동 변경 금지 |
| 9. 1차 수집 `kb-first-collect` | `protocol-discover`·`prose-source-scout`·`candidate-classify`·`source-policy`·`collector-register`로 출처 발견 분해, 적재는 다음 DAG | 발견자가 본문을 읽고 주장 번들을 제출하는 권한 제거. 수집기 등록 후 결정적 수집 우선 |
| 10. 수동 표본 감사 `kb-verifier` | 기계 대조는 `claim-gate`, 의미 감사는 `sample-auditor` | `text[start:end]` 대조에 LLM을 쓰지 않음. 공개 표본의 독립 의미 판정만 유료 |

3장 밖의 신규 계획도 대응이 필요하다. R.3은 `relation-candidates → relation-prefilter → relation-classify → claim-gate`다. `quoted_llm` 관계는 `sample-auditor`가 별도 표본 감사하고, 구조 포인터 관계는 L1 경로로 남긴다. T.7은 `coverage-report`, T.10의 필드 대응·별칭은 각각 `table-fieldmap`·`alias-propose`다. ADR-0005 5.10은 `memo-refine-local → 필요한 경우 사전 동의 → memo-refine-external → 별도 결과 공개 확인`이며, 결과에서 추출할 때는 공개가 승인된 결과 자체를 first_party 원본으로 삼는다.

이행 순서는 다음과 같다. 각 단계는 사용자 검토 후의 제안이며 이 문서 작성으로 실행하지 않는다.

1. 역할 계약·자료 분류·민감도·문맥 상한을 먼저 승인한다. 기존 큐와 E1 기록에 역할 메타데이터를 추가하되 원장·완료 표시·원응답은 유지한다. 현행 10개 호출의 출력과 비용을 기준선으로 보존한다.
2. 구조 자료·표·카나리아·지표 집계의 no LLM 경로부터 분리한다. 이미 구현된 `policy.py`의 `none / declared / prose`를 사용하고 정책 변경이 기존 L2 자료의 무조건 재추출을 유발하지 않게 한다.
3. 공개 산문·장문·API 서술의 입력과 출력 계약을 나누고, 정규화·엔티티 해석을 프롬프트 밖으로 옮긴다. 기존 고정 스냅샷·골든과 후속 게이트로 역할별 수락·왜곡·총비용을 비교한다. 역할 이름만 바꾼 공용 프롬프트로 완료 처리하지 않는다.
4. E1 팔 키·감사 귀속·도구 권한을 역할 기준으로 전환한다. 독립 함의·표본 감사의 보정과 품질 공백 표시를 먼저 갖추고, 다른 벤더가 없을 때 대기하는지 확인한다. 미구현 API·Batch 실행기는 계속 후보에서 제외한다.
5. 관계 후보·별칭·로컬 거르기를 붙인다. ADR-0004 7.8의 합격선 미달은 힌트만 유지하고, 전사 추출도 별도 골든을 통과하기 전에는 자동 승격하지 않는다. GPU 부재로 공개·비공개 전송 경계가 바뀌지 않아야 한다.
6. first_party 추출과 두 메모 정제 경로를 마지막으로 연결한다. 고정 전송 내용의 사전 동의, 별도 결과 확인, 원본 판 변경, 민감도 상향, 불확실 전송의 예약 유지가 기존 계약대로 보장된 뒤 활성화한다. 개발 세션은 즉시 역할별 인계를 적용할 수 있지만 커밋·배포 권한은 개별 요청 범위를 따른다.

도입 판정은 실제 주제 한 건의 후보·수집기·주장·관계에서 역할과 근거를 추적할 수 있는지, 같은 목적의 기존 경로보다 총비용·오류·사용자 정정이 줄었는지로 한다. 새 역할 30개의 스키마 통과만으로 도입 성공을 선언하지 않는다. 이번 문서 작업에서는 시험·렌더링·성능 측정을 하지 않았다.

## 6. 사용자에게 남길 질문

1. **30개 실행 역할의 경계를 승인할 것인가?** 권장 기본값: 이 경계를 계약으로 채택하되 역할마다 상주 세션을 만들지 않는다. 다음 분리는 PDF의 표·본문처럼 입력 계약이나 문맥 상한이 달라질 때만 한다.
2. **함의 판정에도 추출자와 다른 모델 벤더를 강제할 것인가?** 권장 기본값: 강제한다. 적합한 다른 벤더가 없으면 보류하고 동일 모델의 자기 승인을 독립 판정으로 세지 않는다.
3. **로컬 역할의 미합격 결과를 어디까지 쓸 것인가?** 권장 기본값: 분류·별칭·관계 거르기·전사 추출은 기준 통과 전까지 힌트/후보만 저장하고, 거르기 미합격은 원자료를 버리지 않는다. 기존 불합격 공개 추출·함의 판정을 로컬에 재배치하지 않는다.
4. **`SAME_AS`·타입 충돌 검토를 어떤 사용자 신호로 노출할 것인가?** 권장 기본값: 자동 병합은 하지 않고, 주제 의도를 가를 수 없는 경우만 `topic_ambiguity`로 올린다. 그 밖의 동일성 후보는 검색에서 제외한 검토 후보로 보관하고 별도 신호 추가는 보류한다. ADR-0004 R.5의 항상 사람 대기 규칙과 ADR-0005 6.8의 미해결 신호 계약을 ADR 개정 때 명시적으로 맞춘다.
5. **개발 검토의 별도 회사 모델 적용 범위는?** 권장 기본값: 일반 변경은 별도 Codex 세션에서 검토한다. 되돌리기 어려운 결정의 교차 검토와 Codex가 수행할 수 없는 커밋·소켓 시험·MCP·렌더링·운영 실행에만 Claude를 쓴다. 리드는 결과와 근거를 통합하고 실제 작업은 역할별 워커에게 맡긴다.

KB 보관 후보는 역할 계약을 먼저 고른 뒤 엔진을 선택한다는 결정, 생산자·판정자의 모델 벤더 분리 이유, 미합격 로컬 결과의 후보 지위, private 정제의 두 확인 경계다. 아직 제안이므로 승인된 결정으로 저장하지 않는다. 이 Codex 워커에서는 tower 보관을 수행하지 않았으며, 리드가 검토 결과를 확정한 뒤 중복 없는 보관 입력으로 정리할 수 있다.

## 6-1. 사용자 답변 (잠정, 2026-11-05)

사용자는 역할 분해를 실험 중이며, 실험 결과는 메인 세션에서 따로 답하기로 했다. 아래는 그 전에 받은 답이고 **잠정 결정**이다. 실험 결과가 나오면 이 절과 위 권장 기본값을 함께 다시 고친다.

1. **30개 실행 역할의 경계:** 채택. 역할마다 상주 세션은 만들지 않는다.
2. **함의 판정의 모델 벤더 분리:** 강제. 다른 벤더가 없으면 보류하고 동일 모델의 자기 승인을 독립 판정으로 세지 않는다.
3. **로컬 역할의 미합격 결과:** 미합격 원자료도 함께 저장한다. 분류·별칭·관계 거르기·전사 추출의 결과는 기준 통과 전까지 힌트·후보로만 쓴다.
4. **SAME_AS·타입 충돌 신호:** 동일성 전용 신호를 추가한다. 자동 병합은 하지 않는다.
5. **개발 검토의 별도 회사 모델 범위:** 일반 변경은 Codex, 되돌리기 어려운 결정의 교차 검토와 Codex가 못 하는 일(커밋, 소켓 시험, MCP, 렌더링, 운영 실행)만 Claude.

**보류 중:** 실험 결과 대기. 이 잠정 결정을 확정하거나 바꾸는 근거는 메인 세션의 답이다.
