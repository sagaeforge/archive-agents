# 프로토타입 보존본 (WP-22)

세션 tmpfs에 있던 설계 시험 스크립트를 저장소로 옮긴 사본이다. 원본은 세션 scratchpad에 있었고 복사만 했다. 이 디렉터리의 파일은 실행 가능한 제품 코드가 아니라 근거 재현용이다.

## 공통 처리

- 홈 경로(`/home/user` → `/home/<user>`), 이메일(`<EMAIL>`), API 토큰 형식 문자열(`<TOKEN>`), UUID(`<SESSION_OR_UUID>`)를 가렸다. 내용의 나머지는 원문 그대로다.
- 파일별 sha256과 원본 경로는 `tests/fixtures/MANIFEST.json`이 아니라 이 디렉터리 밖이므로 기록하지 않았다. 원본 경로는 아래 표에 적는다.
- 실측 ID와 합성 여부: 이번 이관에서는 파일별 실측 ID를 추출하지 않았다. 아래 "합성 여부" 열은 파일 구조 기준의 판단이며, 실측 ID 목록은 후속 작업으로 남긴다.

## 파일 목록

| 저장소 경로 | 원본 (scratchpad 기준 상대 경로) | 역할 | 합성 여부 |
|---|---|---|---|
| adr-scripts/proto.py | adr/scripts/proto.py | 초기 프로토타입 | 합성 입력 |
| adr-scripts/fetch_guard.py | adr/scripts/fetch_guard.py | 수집 URL 차단 규칙 시험 (CASES 15건) | 합성 입력 |
| adr-scripts/gate2.py | adr/scripts/gate2.py | 주장 게이트 2차 시험 | 합성 입력 |
| adr-scripts/span_eval.py | adr/scripts/span_eval.py | 인용 구간 일치 평가 | 합성 입력 |
| adr-scripts/tok_eval.py | adr/scripts/tok_eval.py | 한국어 토큰화 평가 (CORPUS, CASES 26, ALIAS) | 합성 입력 |
| adr-scripts/rtk_guard_test.sh | adr/scripts/rtk_guard_test.sh | rtk 가드 시험 | 합성 입력 |
| adr-scripts/rtk_real.sh | adr/scripts/rtk_real.sh | rtk 실측 스크립트 1 | 실측 호출 기록 대상 |
| adr-scripts/rtk_real2.sh | adr/scripts/rtk_real2.sh | rtk 실측 스크립트 2 | 실측 호출 기록 대상 |
| adr-scripts/mcp_probe.py | adr/scripts/mcp_probe.py | MCP 탐침 | 실측 호출 기록 대상 |
| adr-scripts/mcp_sdk.py | adr/scripts/mcp_sdk.py | MCP SDK 시험 1 | 실측 호출 기록 대상 |
| adr-scripts/mcp_sdk2.py | adr/scripts/mcp_sdk2.py | MCP SDK 시험 2 | 실측 호출 기록 대상 |
| adr-scripts/mcp_srv.py | adr/scripts/mcp_srv.py | MCP 시험 서버 | 합성 입력 |
| audit-blocking/chain_fix.py | audit/blocking/chain_fix.py | 원장 체인 수정안 시험 | 합성 입력 |
| audit-blocking/fg.py, fg_real.py, fg_test.py | audit/blocking/fg*.py | 차단 규칙 우회 시험 (fg_real은 실측 입력) | 혼합 |
| audit-blocking/gate2_fix.py | audit/blocking/gate2_fix.py | 게이트 2차 수정안 | 합성 입력 |
| audit-blocking/gate2_subjfield.py | audit/blocking/gate2_subjfield.py | 주체 필드 게이트 시험 | 합성 입력 |
| audit-contract/t1_schema.py ~ t12.py | audit/contract/t*.py | 계약 검증 시험 (스키마, 앱, MCP, 검색, 라우터 등) | 합성 입력 |
| audit-fixes/*.py | audit/fixes/*.py | 감사 지적 수정 적용·검사 스크립트 | 합성 입력 |
| adr/wp.json, adr/wp_data.py | adr/wp.json, adr/wp_data.py | 패키지 계획 데이터 | 계획 데이터 |

시험 입력 자료는 `tests/fixtures/`를 본다. 주장 게이트 49건 원장은 `tests/fixtures/gate/gate_rows.json`에 있다.

## 시험 스트림

`tests/fixtures/streams/stem-<원본 파일 stem>.jsonl`은 scratchpad `harness/out/`의 기록을 그대로 옮긴 것이다. 파일명은 원본 stem만 따랐고 시나리오(권한 거부, 예산 초과, 대기 상한, MCP failed, 정상, is_error)는 결과 레코드로 검증하지 않았다. 시나리오 대응표는 후속 확인 대상이다.
