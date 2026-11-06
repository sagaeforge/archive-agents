# LLM 호스티드 백엔드 실측

- 작성일: 2026-11-01. 측정과 1차 출처 확인일: 2026-10-31~11-01.
- 범위: ADR-0001 10.5 L2 추출에 쓸 호스티드 백엔드 세 종류. Claude(`claude -p`), Codex(`codex exec`), OpenRouter.
- 성격: 측정 기록이다. 라우팅 결정은 `docs/adr/0003-llm-backends.md`가 한다. sLLM 측정은 별도 문서다.
- 근거 표기: **[실측]** 이 환경에서 호출한 결과. **[mock]** 로컬 mock 서버로 요청 본문만 잡은 결과이고 모델을 호출하지 않았다. **[1차]** 공급자 원문을 받아 문구를 확인했다. **[2차]** 검색 요약이고 원문을 못 읽었다. **[추론]** 측정하지 않은 계산이나 해석이다.

## 0. 요약

1. **Claude와 OpenRouter는 동작한다. Codex는 실호출을 하지 않았다.** Codex 주간 한도가 100%이고, 이 상태에서 호출하면 구매 크레딧이 차감될 수 있다. 이번 작업에 크레딧 지출 권한이 없어 mock으로 프로토콜만 확인했다. [실측, mock]
2. **품질과 처리량이 가장 좋은 모델은 `openai/gpt-6.1-sol`(OpenRouter)이다.** 19창에서 게이트 통과 82.3%, 창당 통과 주장 9.53건, 왜곡 0/80, 근거 없는 주장 0건이다. 창당 $0.0323이다. [실측]
3. **$150는 Sol로 약 4,600창이다.** ADR의 첫 적체 3,300~5,867창과 거의 같은 규모이고, 일일 400창이면 11.6일이다. 첫 적체를 Sol로 돌리면 충전금이 실제 작업으로 소진된다. [실측 단가 + 추론]
4. **`claude -p --model haiku`는 ADR 호출 형태 그대로 쓸 수 있다.** ADR 10.5의 전체 플래그 조합으로 20창을 돌렸고 스키마 100%, 게이트 74.2%, 왜곡 1/80이다. 호출당 최대 $0.0061로 상한 $0.02 안이다. [실측]
5. **Sonnet은 ADR 상한으로 돌릴 수 없다.** 20창 전부 호출당 $0.02를 넘었고($0.028~$0.060), 게이트 통과 주장은 Haiku보다 적다. [실측]
6. **게이트는 왜곡을 잘 막는다.** 전 런 합계로 게이트를 통과한 판정 표본 499건 중 왜곡은 1건이다. 보류(`needs_review`) 231건의 83%는 실제로 정상이었다. [실측]
7. **잔액은 $150가 아니다.** 측정 전 $146.17, 측정 뒤 $145.24다. 이번 측정 지출은 $0.9312(상한 $1)이다. [실측]
8. **OpenRouter 키는 2026-11-30 19:41 KST에 만료된다.** 크레딧이 아니라 키의 `expires_at`이다. 만료 전에 새 키가 필요하다. [실측]
9. **크레딧은 구매 후 365일이 지나면 만료될 수 있고, 구매 후 24시간이 지나면 환불 요청을 받지 않는다.** 다만 약관 9조는 위반이 아닌 계정 해지 때 잔여 크레딧을 환불한다고 적는다. 구매일은 API로 알 수 없다. [1차]

사용자 확인이 필요한 항목은 8장에 있다.

## 1. 측정 조건

**표본.** sLLM 측정과 같은 하네스(`~/.cache/sagae-kb/llm-eval/harness`)의 40창에서 고른 20창이다(`hosted/subset20.jsonl`, SHA-256 `5e6001098de81f592a871077fd5f1f109a8fd3a438769ef07d9a68fba0646d0a`). 한국어 10, 영어 10이고 도메인은 G 13, B 3, F 3, D 1이다. 창 평균 4,977자다.

- 언어별 `window_id` 순서의 짝수 위치를 고른 뒤 도메인 F, D를 넣으려고 `cc-llm-gateway#1`을 `yt-quota#0`으로, `cc-ko-sandboxing#7`을 `yt-ypp-ko#0`으로 바꿨다.
- `nielsen-gauge-2026-08#0`은 보도자료의 공개 담당자 메일이 있어 넣지 않았다.
- 전송 전 표본 40창에서 메일, 전화번호, 로컬 경로, 토큰 형식을 검사했다. 위 메일 1건만 잡혔다. 전부 공개 URL이고 `docs/intake`와 사용자 기록은 없다. [실측]
- 유튜브·Google 문서는 저장된 사본을 썼다. 해당 호스트를 호출하지 않았다.

**측정 정의.** 하네스 README를 따른다. 입력은 `sampleio`, 스키마는 `schema.extract_schema`, 채점은 `score.py`, 왜곡은 `judge.py`다.

- 스키마 유효율은 `full` 스키마를 통과한 창의 비율이다. 전송 스키마를 바꾼 런도 채점은 `full`이다.
- 왜곡은 고정 심판(`claude -p --model sonnet`, 도구 0개)이 `num_wrong` 또는 `subject_wrong`으로 판정한 주장이다. 런당 80건(언어별 40건), 시드 20261031이다. 주장이 적은 런은 있는 만큼 판정했다.
- 호출은 런별 순차 1건이고 재시도는 0회다. 창당 시간은 호출 벽시계다.

**심판 보정.** 왜곡 0%가 심판이 관대해서 나온 값이 아닌지 확인하려고 `ok`로 판정된 실제 주장에 왜곡을 기계로 주입했다. 수치 변경 12건은 12건 모두 잡았다(`num_wrong` 11, `subject_wrong` 1). 주어 교체 12건은 11건을 잡고 1건을 놓쳤다. 대조군 원문 12건은 전부 `ok`였다. 표본이 작고, 심판이 Claude 계열이라 Claude 출력에 편향이 있는지는 재지 못했다. [실측]

**게이트 판본.** 측정 중 00:13에 `gate.py`가 바뀌었다(한글 후보를 등록 별칭 대조에서 제외). 표의 게이트 지표는 전 런을 최종 판본으로 다시 채점한 값이다. 심판 표본의 상태도 최신 결과와 다시 조인했다.

**GPU.** 호스티드 경로는 GPU를 쓰지 않으므로 GPU 경합이 측정값을 바꾸지 않는다. Claude 런은 `meta.json`에 측정 전후 `nvidia-smi`를 남겼다. OpenRouter 런은 남기지 않았다.

## 2. 결과

OR은 OpenRouter 경유다. `$/창`은 OpenRouter의 경우 응답의 실제 `usage.cost`이고, Claude의 경우 CLI 추정(`total_cost_usd`)이며 구독이라 실제 청구가 아니다. 입력에는 캐시 토큰이 포함된다. [실측]

| 백엔드 | 창 | 스키마 | 게이트 통과 | 보류 | 거부 | 인용구 존재 | 창당 주장 | 창당 통과 | 왜곡 | 통과분 왜곡 | 초/창(p50, p95) | 입력 | 출력(추론) | $/창 | $/통과 주장 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `claude -p` Haiku 5.5 | 20 | 100% | 74.2% | 23.2% | 2.6% | 98.5% | 9.7 | 7.2 | 1/80 | 0/57 | 21.8 (20.2, 51.7) | 7,271 | 5,238 (3,084) | 0.00402 | 0.00056 |
| `claude -p` Sonnet 5.5 | 20 | 100% | 52.1% | 40.1% | 7.8% | 100% | 8.35 | 4.35 | 0/80 | 0/47 | 12.6 (12.4, 23.3) | 6,655 | 1,875 (0) | 0.04536 | 0.01043 |
| OR gpt-6.1-sol | 19 | 100% | 82.3% | 17.3% | 0.4% | 99.6% | 11.58 | 9.53 | 0/80 | 0/60 | 21.5 (21.3, 30.5) | 3,325 | 2,403 (452) | 0.03234 | 0.00339 |
| OR claude-haiku-5.5 | 20 | 100% | 74.5% | 25.0% | 0.5% | 99.5% | 10.0 | 7.45 | 0/80 | 0/56 | 20.1 (20.8, 29.0) | 6,533 | 4,539 (2,545) | 0.00292 | 0.00039 |
| OR gpt-6-luna | 20 | 100% | 67.2% | 26.2% | 6.7% | 93.3% | 9.75 | 6.55 | 0/80 | 0/57 | 24.6 (23.8, 35.1) | 3,256 | 2,679 (1,384) | 0.00175 | 0.00027 |
| OR gemini-3.8-flash | 6 | 100% | 67.3% | 25.0% | 7.7% | 98.1% | 8.67 | 5.83 | 0/51 | 0/35 | 18.2 (17.2, 26.3) | 2,813 | 2,837 (1,018) | 0.01275 | 0.00219 |
| OR deepseek-v4.1-flash | 20 | 100% | 59.7% | 25.6% | 14.7% | 97.5% | 11.9 | 7.1 | 4/80 | 0/49 | 5.9 (4.3, 14.9) | 3,338 | 2,003 (0) | 0.00158 | 0.00022 |
| OR gemini-3.1-flash-lite | 20 | 100% | 53.1% | 32.3% | 14.6% | 94.6% | 6.5 | 3.45 | 3/80 | 0/45 | 3.6 (3.6, 6.0) | 4,038 | 1,222 (0) | 0.00284 | 0.00082 |
| OR solar-pro4 | 20 | 95% | 48.2% | 23.2% | 28.5% | 82.5% | 11.4 | 5.5 | 0/80 | 0/44 | 19.2 (18.5, 28.5) | 2,409 | 1,971 (0) | 0.00154 | 0.00028 |
| OR glm-5.3-flash | 20 | 75% | 51.7% | 26.7% | 21.5% | 82.0% | 8.6 | 4.45 | 4/80 | 1/49 | 30.2 (24.5, 69.4) | 3,189 | 5,226 (3,298) | 0.00112 | 0.00025 |

| 측정 안 됨 | 사유 |
|---|---|
| `codex exec` gpt-6.1-sol, gpt-6-luna | 플랜 주간 한도 100%. 4장 |
| OR qwen3.5-flash-02-23 | 공통 프롬프트로 실패. 공급자가 `json_object`로 낮춰 처리하며 메시지에 'json' 단어를 요구했다. 5.3절 |

**언어별.** 게이트 통과율이다. [실측]

| 백엔드 | 한국어 | 영어 |
|---|---:|---:|
| OR gpt-6.1-sol | 79.7% | 85.1% |
| `claude -p` Haiku | 75.8% | 72.6% |
| OR claude-haiku-5.5 | 74.3% | 74.7% |
| OR gpt-6-luna | 67.0% | 67.4% |
| OR deepseek-v4.1-flash | 70.8% | 48.3% |
| OR solar-pro4 | 56.7% | 38.9% |
| OR glm-5.3-flash | 45.7% | 59.0% |
| OR gemini-3.1-flash-lite | 52.6% | 53.4% |
| `claude -p` Sonnet | 54.9% | 49.4% |

**읽는 법.**

- 왜곡 판정 표본이 80건일 때 0건이면 95% 상한은 약 3.7%다. 0/80끼리의 차이는 없는 것으로 본다. [추론]
- 자동 신호 `auto_distortion_rate`(17.4~40.7%)는 왜곡률이 아니다. 판정 합계에서 보류 231건 중 191건(83%)이 `ok`였다. 예를 들어 Sonnet은 절 제목의 버전 번호를 문장에 넣어서(`버전 2.1.191에서 ...`) 값 대조에 걸렸고, 보류 판정 29건 중 25건이 정상이었다. 게이트 통과율은 품질의 하한으로 읽어야 한다. [실측]
- 판정 합계 771건 중 왜곡은 12건이다. 사례를 직접 읽어 보니 **표의 열 귀속 오류**(비교표의 값을 옆 열 모델에 붙임)와 **범위 확대**(`약 500개까지` → `최대 500개`, `successful` 응답 → 모든 응답)가 대부분이다. 대부분 보류로 걸러졌지만 표 머리 대조가 없으면 빠질 수 있는 유형이다. [실측, 분류는 추론]
- 표본의 주장 수가 스키마 상한 12에 닿는다. Sol은 창당 11.58건이라 일부 창에서 잘렸을 수 있다. 창당 주장 수의 진짜 차이는 표보다 클 수 있다. [추론]
- ADR 규모 산식의 창당 4건보다 실측 통과 주장이 많다(Haiku 7.2, Sol 9.53). 주장 규모 추정을 다시 잡아야 한다. [추론]
- `--effort low` 민감도: Haiku 6창에서 추론 토큰이 3,330에서 2,250으로 줄었으나 창당 시간은 21.5초에서 19.1초로만 줄었고, 게이트 통과 주장은 48건에서 38건으로 줄었다. 표본이 작다. ADR 플래그를 바꿀 근거는 되지 않는다. [실측]

## 3. Claude: `claude -p`

**호출 형태.** ADR 10.5 그대로 `--tools "" --setting-sources "" --strict-mcp-config --system-prompt --json-schema --max-turns 3 --max-budget-usd 0.02 --no-session-persistence --permission-prompts none --output-format stream-json --verbose`, `env -i`, 고정 바이너리 2.1.316이다. 인증은 구독(`max`)이다. [실측]

- **ADR F11의 공백(FACT-14)이 메워졌다.** 전체 플래그 조합에서 `structured_output`, `rate_limit_event`, `permission_denials` 빈 값을 모두 확인했다. 초기화 이벤트의 도구는 `StructuredOutput` 하나다. [실측]
- **`--json-schema`는 모델 쪽 강제 디코딩이 아니다.** CLI가 `StructuredOutput` 도구 호출을 클라이언트에서 검증하고, 위반하면 오류를 도구 결과로 돌려줘 모델이 다시 쓴다. 예: `Output does not match required schema: /claims/5: must NOT have additional properties ('limit' is not allowed)`. 이 재시도가 턴을 쓰므로 `--max-turns 3`이 실제 재시도 상한이고, 입력 토큰이 약 3배가 된다(5,800 → 17,684). Haiku 20창 중 1창에서 발생했다. [실측]
- **상한.** Haiku는 호출당 최대 $0.00606으로 $0.02 안이다. Sonnet은 최소 $0.028, 최대 $0.060이라 20창 전부 초과했다. Sonnet 측정은 상한을 $0.25로 풀었다. [실측]
- **비용 표시.** `total_cost_usd`는 정가 환산 추정이고 구독 사용량이 실제 소비다. 가격은 Haiku 5.5 입력 $0.10, 출력 $0.50, Sonnet 5.5 $2, $10(MTok)이다. [1차]

**과금 상태.** `rate_limit_event`는 `overageStatus: rejected`, `overageDisabledReason: out_of_credits`, `isUsingOverage: false`였다. 호출은 구독 한도에서만 차감되고 초과 과금은 일어나지 않았다. [실측]

**구독 소비.** ADR의 경로 `rate_limit_info.unifiedWindows.five_hour.utilization`이 실제로 있다. 측정 시작과 Sol 재판정 직전 값은 5시간 0.05 → 0.16, 7일 0.64 → 0.66이다. 같은 시간에 다른 세션이 돌았으므로 이 증가는 상한이다. 정가 환산 소비는 전체 약 $3.8(추출 $1.00, 심판 $2.69, 보정 $0.10)이고, 위 값을 읽은 시점까지는 약 $3.55다. 이 비율이면 Haiku 400창(약 $1.6)은 7일 한도의 약 1%다. [실측, 비율은 추론]

**플랜 정책.**

- 구독 로그인 상태의 `claude -p`는 구독 한도에서 차감된다. 2026-06-15로 예고됐던 변경은 보류 상태다. [1차]
- `--bare`는 여전히 "will become the default for `-p` in a future release"다. API 키 없이 구독만 쓰면 깨질 수 있어 위험은 그대로다. [1차]
- **새 사실.** 2026-10-07부터 Max 플랜에 월 $100 API 크레딧이 포함된다. Console 조직을 연결해야 받고, 이월되지 않으며, 플랜당 조직 하나이고 연결은 사용자가 직접 바꿀 수 없다. Claude Agent SDK와 Claude API를 덮고 Claude Code는 덮지 않는다. 지원 문서는 연결 조직의 API 키로 돌리는 `claude -p`도 덮는다고 적는다. [1차] 이 경로는 재지 않았고 연결도 하지 않았다. Haiku 경유 단가면 월 약 3.4만 창이다. [추론]

## 4. Codex: `codex exec`

**실호출을 하지 않았다.** 호출 전에 플랜 상태를 읽었다. [실측, 2026-10-31 23:58과 11-01 00:32 KST 두 번 같은 값]

| 항목 | 값 |
|---|---|
| 플랜 | Pro. 로그인 방식 ChatGPT |
| 주간 한도 | `usedPercent: 100`, 창 10,080분 |
| `ordinaryUsageAllowed` | `false` |
| 초기화 | 2026-11-04 15:35 KST |
| 크레딧 잔액 | 46,447.21. 측정 전후 변동 없음 |
| 무료 리셋권 | 1개. 2026-11-07 08:28 KST 만료. 쓰지 않았다 |

공식 문서는 "After you reach your included limits, available credits let you continue working."라고 적는다. [1차] 도움말의 "usage draws from your credit balance" 문구는 검색 요약으로만 봤고 원문은 자동 접근이 403이다. [2차] 한도 초과 상태의 호출이 실패하는지 크레딧을 차감하는지는 재지 않았다. 이번 작업이 허용한 것은 구독 사용량이고 크레딧과 리셋권은 사용자 자산이라 어느 쪽도 쓰지 않았다.

**확인한 것.** 모델을 부르지 않는 로컬 mock 제공자로 `codex exec`의 요청 본문을 잡았다. 가짜 `env_key`를 써서 ChatGPT 인증을 쓰지 않았다. CLI 0.166.0이다.

**구조화 출력.** `--output-schema`는 `text.format`에 `{"type":"json_schema","strict":true,"name":"codex_output_schema"}`로 나간다. 문서의 `--output-schema`, `-o`, `--json`, `--ephemeral`과 일치한다. 하네스 `full` 스키마를 OpenRouter에서 `gpt-6-luna`, `gpt-6.1-sol`에 strict로 보내면 통과했으므로 Codex에서도 통과할 것이다. [mock, 1차, 마지막은 추론]

**기본 모델.** `-m` 없이 `gpt-6.1-sol`, effort `low`, verbosity `low`다. 대안은 `gpt-6-luna`(기본 effort `medium`), `gpt-6.1-terra`다. [mock]

**도구 차단.** 설정 문서에서 "도구 0개" 옵션을 찾지 못했다. 기본 `read-only` 샌드박스는 쓰기를 막을 뿐 도구를 없애지 않는다. 플래그별 실제 도구 목록이다. [mock]

| 조합 | 모델에 보이는 도구 | 요청 크기 |
|---|---|---:|
| 기본 | `exec`(중첩 `exec_command`, `apply_patch`, `write_stdin`, `view_image`, MCP 자원 등), `wait`, `request_user_input`, `request_user_input_async`, `clock.sleep`, `spawn_agent` 등 협업 6종 | 60,578 B |
| + `--ignore-user-config --ignore-rules`, `--disable`로 `hooks`, `plugins`, `apps`, `goals`, `image_generation`, `memories`, `shell_tool` 끔, `-c web_search="disabled"` | `exec`에서 `exec_command`, `write_stdin`이 빠진다. 나머지 그대로 | 52,521 B |
| + `-c agents.enabled=false` | 협업 6종이 빠진다 | 44,191 B |
| + `-c model_catalog_json=<사본>` | **`request_user_input`, `view_image`만 남는다.** `exec`, `wait`, `clock`이 사라진다 | 32,641 B |
| + `-c model_instructions_file=<최소 지침>` | 같다. 기본 지침 21,546자가 교체된다 | 10,982 B |

- 사본 카탈로그는 `~/.codex/models_cache.json`을 복사해 `tool_mode`, `multi_agent_version`, `apply_patch_tool_type`을 지우고 `shell_type: "disabled"`로 둔 파일이다. 전역 파일은 바꾸지 않고 `-c`로만 넘긴다. CLI 판이 오르면 다시 만들어야 한다.
- `-c tools.view_image=false`, `-c skills.config=[...]`, `-c project_doc_max_bytes=0`은 효과가 없었다. 스킬 목록 5,480자와 전역 `~/.codex/AGENTS.md`가 매 호출 입력에 남는다. 비밀은 아니지만 도구 기본 동작으로 OpenAI에 전송되는 내용이다.
- **"도구 0개"는 달성하지 못했다.** `view_image`는 로컬 이미지 파일을 읽을 수 있다. 네트워크 도구가 없고 샌드박스가 `read-only`이므로 유출 경로는 보이지 않는다. ADR 20.1 "비신뢰 입력에 Read를 주지 않는다"를 글자 그대로는 만족하지 못한다. [추론]
- 실제 모델이 이 조합을 받아들이는지, 주입 문구에 도구를 호출하지 않는지는 재지 않았다. 어댑터는 스트림의 `item` 유형을 기록해 도구 호출을 잡는다.

**비대화 인증.**

- `env -i`(HOME, PATH, LANG만)에서 저장된 ChatGPT 로그인이 동작한다(`account/rateLimits/read` 성공). `auth.json`은 읽지 않았다. [실측]
- 인증이 없는 `CODEX_HOME`에서는 재연결 뒤 `turn.failed`, exit 1로 끝난다. 조용한 성공이 없다. 메시지는 `401 Unauthorized`다. [실측]
- 문서는 자동화 기본값으로 API 키(`CODEX_API_KEY`)를 권하고, 계정 인증은 "only if you specifically need to run as your Codex account"로 적는다. ChatGPT 세션 토큰은 사용 중 자동 갱신된다. [1차]
- 사용량은 `codex app-server`의 `account/rateLimits/read`로 호출 없이 읽을 수 있다. `codex exec --json`의 `turn.completed`는 토큰만 준다. [실측, 1차]

**비용 추정.** 크레딧 단가(1M 토큰)는 GPT-6.1 Sol 입력 50, 캐시 2.5, 출력 250이고 GPT-6 Luna 2.5, 0.25, 12.5다. [1차] 입력에 스킬·AGENTS.md 약 1,600토큰을 더하면 창당 Sol 약 0.85, Luna 약 0.05 크레딧이다. 20창이면 약 17, 약 1 크레딧이다. [추론] 크레딧의 금액 환산은 확인하지 못했다. 사용자의 Codex 주간 한도는 이미 소진되어 있어 L2를 구독에 얹으면 코딩 작업과 경합한다. [추론]

**대리 측정.** 같은 모델을 OpenRouter로 쟀다(2장). 경로가 달라 Codex 측정을 대신하지는 못한다.

**준비된 실행.** `hosted/run_codex.py`는 위 조합을 고정하고, 시작 전 한도를 읽어 `ordinaryUsageAllowed`가 `false`면 호출 없이 exit 3으로 끝난다. 실제 경로에서 거부를 확인했다. [실측] mock으로 파싱과 전송 형태도 확인했다.

## 5. OpenRouter

### 5.1 카탈로그

`GET /api/v1/models`(2026-10-31 23:52 KST) 452개 중 `structured_outputs` 지원 378개다. [실측]

| 구분 | 수 |
|---|---:|
| 유료 | 280 |
| `:batch` 변형 | 71 |
| `~` 별칭 | 18 |
| 무료 | 5 |
| 라우터 | 4 |

유료 280개를 입력 2.5K + 출력 2K 토큰 호출 1,000회 비용으로 나누면 $1 미만 55, $1~$5 90, $5~$20 69, $20 이상 66개다. 전체 목록과 가격은 `hosted/openrouter/structured_models.csv`다. 일부 모델은 `expiration_date`가 있다(`llama-3.1-70b-instruct` 2026-11-03 등).

한국 모델은 `upstage/solar-mini4`, `upstage/solar-pro4`뿐이다.

**지원은 모델이 아니라 엔드포인트 단위다.** 문서가 "per endpoint"라고 적고 `require_parameters: true`를 권한다. [1차] Haiku 5.5의 Bedrock, Claude Platform on AWS 엔드포인트는 `structured_outputs`가 없었다. [실측]

### 5.2 잔액 API

| 호출 | 결과 [실측] |
|---|---|
| `GET /api/v1/key` | 200. `limit: null`, `is_free_tier: false`, `is_management_key: false`, **`expires_at: 2026-11-30T10:41:00Z`** |
| `GET /api/v1/credits` | 200. `total_credits: 200`, `total_usage: 53.83`(측정 전) |

- 문서는 `/credits`에 "Management key required"라고 적지만 일반 키로 200을 받았다. 문서와 다르므로 이 동작에 기대지 않는다. [1차, 실측]
- 키에 `limit`이 없어 서버 쪽 지출 상한이 없다. 이번 $1 상한은 러너가 호출 전 예약으로 강제했다.
- `usage.include`는 폐기됐다. 응답의 `usage.cost`가 기본으로 온다. [1차, 실측]
- 지출 대조: 러너 장부 $0.931171, 계정 `total_usage` 증가분 $0.931171로 일치한다. 149회 호출, 상한 거부 1회다. [실측]

### 5.3 "구조화 출력 지원"은 같은 요청의 성공을 뜻하지 않는다

7개 모델에 같은 요청을 보냈더니 3개가 첫 호출에서 400을 냈다. [실측]

| 모델 | 오류 | 처리 |
|---|---|---|
| `claude-haiku-5.5`(Vertex) | `Invalid schema: Enum value 'states' does not match declared type ['string','null']` | 전송 스키마를 `anyOf`로 변환해 통과. 채점은 `full` |
| `gemini-3.1-flash-lite` | `Request contains an invalid argument` | 같은 변환으로 통과. 원인은 특정하지 못했다. `gemini-3.8-flash`는 처음부터 변환을 적용했다 |
| `qwen3.5-flash-02-23`(Alibaba) | `'messages' must contain the word 'json' ... 'json_object'` | 측정 제외. 공통 프롬프트를 고치지 않았다 |

운영 어댑터에는 공급자별 전송 변환과 모델별 카나리아가 필요하다. 전송 변환은 `hosted/run_openrouter.py`의 `to_anyof`다. Anthropic 문서도 `maxLength` 같은 제약을 API 스키마에서 빼라고 적는다. [1차]

### 5.4 라우팅이 비용과 품질을 바꾼다

- **GLM 5.3 Flash는 공급자에 따라 창당 비용이 20배 차이 난다.** OpenInference $0.0002, CoreWeave $0.0033, Crusoe $0.0043, Friendli $0.0045다. 필수 추론이 공급자별로 달라 8,000토큰 상한에서 5창이 잘렸고 스키마 유효율이 75%가 됐다. [실측]
- **DeepSeek V4.1 Flash는 기본 추론이 토큰을 다 쓴다.** 첫 시험에서 출력 8,000토큰 중 7,998이 추론이었고 잘렸다. `reasoning: {effort: "none"}`로 측정했다. 한 런이 공급자 4곳에 나뉘었다. [실측]
- Solar Pro 4는 `quote` 길이 상한을 넘겨 1창이 스키마를 위반했고, 인용구 존재율이 82.5%로 낮다. [실측]
- 운영에서는 `provider.order`로 공급자를 고정해야 표의 값이 재현된다. [추론]

입력 토큰은 공급자가 다르게 센다. 같은 표본에서 Anthropic 경유 평균은 약 6,500, 다른 공급자는 약 2,400~4,000이다. Anthropic은 스키마가 입력에 들어가는 것으로 보인다. [실측, 원인은 추론]

## 6. 크레딧 만료와 환불

OpenRouter Terms of Service, Last Updated: August 31, 2026. [1차]

| 조항 | 원문 | 뜻 |
|---|---|---|
| 4.1 | "refunds for unused Credits may be requested within twenty-four (24) hours from the time the transaction was processed. If no refund request is received within twenty-four (24) hours following the purchase, any unused Credits become non-refundable." | 환불은 구매 후 24시간 안에만 된다 |
| 4.1 | "the platform fees are non-refundable. Cryptocurrency payments are never refundable." | 수수료와 암호화폐 결제는 환불되지 않는다 |
| 4.2 | "OpenRouter reserves the right to expire unused credits three hundred sixty-five (365) days after purchase." | 구매 후 365일이 지나면 만료될 수 있다. 자동 소멸이 아니라 권리 유보다 |
| 4.4 | "Credits are non-transferable, including between accounts" | 다른 계정으로 옮길 수 없다 |
| 9 | "If you violate any provision of these Terms ... any unused Credits will not be refunded." | 약관 위반 해지는 환불이 없다 |
| 9 | "Except for OpenRouter's termination of your account for violation of these Terms, any Credits remaining in your account upon termination will be refunded to you through your original payment method within thirty (30) days of termination." | 위반이 아닌 계정 해지 때는 잔여 크레딧이 30일 안에 환불된다 |

FAQ도 "we reserve the right to expire unused credits after one year of purchase"라고 적는다. 구매 수수료는 Standard 5.5%이고 구매 때 한 번 낸다. 추론 단가에 마크업은 없다. [1차]

**사용자 상황에 대입.** 사용자는 충전금을 소진하기로 했다. 24시간 환불은 구매 시점을 알 수 없어 판단하지 못한다. 4.2의 기한도 구매일에서 센다. `/credits`는 합계만 주고 구매 내역 API는 찾지 못했다. 충전이 여러 번이면 건별로 기한이 다를 수 있다. 구매일은 Credits 페이지에서 사람이 확인해야 한다. 9조의 해지 환불은 조문상 존재하지만 약관 해석이 필요한 사항이라 여기서 판단하지 않는다.

## 7. $150 소진 계산

**전제.**

- 처리량은 ADR 10.5의 일일 400창이다. 이 값은 수요가 아니라 상한이다.
- 첫 적체는 3,300~5,867창이다(PLAN-18). 1년차 추정은 문단 10만 ÷ 3 = 약 33,333창이고, 고유 문단 범위 5만~15만을 쓰면 1.7만~5만 창이다(ADR 규모 산식, 전부 추정).
- 실측 모델은 창당 실제 비용이다. 표본 창은 평균 4,977자이고 운영 창 크기가 다르면 비례해 달라진다.
- 미측정 모델은 실측 프로파일(입력 3,325, 가시 출력 1,951, 필수 추론이면 추론 1,964 추가) × 카탈로그 가격이다. Sonnet은 Anthropic 경유 입력이 크고 CLI 실측에서 thinking이 0이었으므로 OR Haiku의 입력 6,533과 가시 출력 1,995를 썼다.
- 실제 잔액 $145.24는 $150의 96.8%다. 창 수와 일수에 0.968을 곱한다.

| 모델 | 근거 | 입력/출력 $/MTok | $/창 | $150 창 수 | 400창/일 소진 일수 | 첫 적체 비용 | 1년차 3.3만 창 비용 |
|---|---|---|---:|---:|---:|---:|---:|
| `openai/gpt-6.1-sol` | 실측 19창 | 2 / 10 | 0.03234 | 4,639 | 11.6 | $107~$190 | $1,078 |
| `anthropic/claude-sonnet-5.5` | 추론 | 2 / 10 | 0.03301 | 4,544 | 11.4 | $109~$194 | $1,100 |
| `openai/gpt-6.1-terra` | 추론 | 1 / 5 | 0.01308 | 11,470 | 28.7 | $43~$77 | $436 |
| `google/gemini-3.8-flash` | 실측 6창 | 0.825 / 4.125 | 0.01275 | 11,767 | 29.4 | $42~$75 | $425 |
| `moonshotai/kimi-k2.6` | 추론 | 0.65 / 3.41 | 0.00881 | 17,022 | 42.6 | $29~$52 | $294 |
| `anthropic/claude-haiku-5.5` | 실측 20창 | 0.1 / 0.5 | 0.00292 | 51,319 | 128.3 | $10~$17 | $97 |
| `google/gemini-3.1-flash-lite` | 실측 20창 | 0.25 / 1.5 | 0.00284 | 52,758 | 131.9 | $9~$17 | $95 |
| `openai/gpt-6-luna` | 실측 20창 | 0.1 / 0.5 | 0.00175 | 85,891 | 214.7 | $6~$10 | $58 |
| `mistralai/mistral-small-2603` | 추론 | 0.15 / 0.6 | 0.00167 | 89,874 | 224.7 | $6~$10 | $56 |
| `deepseek/deepseek-v4.1-flash` | 실측 20창 | 0.045 / 0.5 | 0.00158 | 94,751 | 236.9 | $5~$9 | $53 |
| `upstage/solar-pro4` | 실측 20창 | 0.15 / 0.6 | 0.00154 | 97,146 | 242.9 | $5~$9 | $51 |
| `z-ai/glm-5.3-flash` | 실측 20창 | 0.016 / 0.148 | 0.00112 | 133,516 | 333.8 | $4~$7 | $37 |
| `google/gemini-2.5-flash-lite` | 추론 | 0.1 / 0.4 | 0.00111 | 134,811 | 337.0 | $4~$7 | $37 |
| `deepseek/deepseek-v4-flash` | 추론 | 0.091 / 0.182 | 0.00066 | 228,126 | 570.3 | $2~$4 | $22 |
| `upstage/solar-mini4` | 추론 | 0.05 / 0.2 | 0.00056 | 269,622 | 674.1 | $2~$3 | $19 |
| `mistralai/mistral-nemo` | 추론 | 0.029 / 0.03 | 0.00016 | 968,188 | 2,420.5 | $1 미만 | $5 |

**창당 비용 기준선.** 400창/일로 $150를 소진하려면 30일 안에 $0.0125, 90일 $0.0042, 180일 $0.0021, 365일 $0.0010 이상이어야 한다.

**해석.** [추론]

- 일일 400창을 365일 내내 채우면 측정한 모델은 모두 기한 안에 소진된다. 그러나 400창은 상한이다. 첫 적체가 끝나면 수요가 줄어든다.
- 1년차 3.3만 창을 전제하면 $150를 쓸 수 있는 모델은 창당 $0.0045 이상이다. 측정한 모델 중 Sol과 Gemini 3.8 Flash뿐이다. Haiku, Luna, DeepSeek, GLM으로 전량을 처리해도 $37~$97만 쓴다.
- 소진 목표와 품질이 같은 방향인 것은 Sol이다. 첫 적체 약 4,500창을 Sol로 처리하면 잔액이 그 작업으로 소진되고 일수는 약 11일이다.
- 365일 기한을 넘기지 않으려면 첫 적체에 고가 모델을 쓰는 편이 안전하다. 값싼 모델로 시작하면 수요가 줄어든 뒤 잔액이 남는다.
- `:batch` 변형은 단가가 절반이다(`gpt-6.1-sol:batch` $1/$5). 소진이 목표면 쓸 이유가 없고, 소진 뒤 저가 운영에 후보가 된다. Batch API는 재지 않았다.

## 8. ADR-0003에 넘기는 사항

측정이 말하는 것과 사용자 확인이 필요한 것을 나눈다. 결정은 ADR-0003이 한다.

**측정이 뒷받침하는 배치.** [추론]

| 구간 | 경로 | 근거 |
|---|---|---|
| 첫 적체 | OpenRouter `openai/gpt-6.1-sol`, `provider` 고정 | 통과 주장이 가장 많고 왜곡 0/80. 잔액을 실작업으로 소진 |
| 소진 뒤 정기 처리 | `claude -p --model haiku` | 추가 지출 없음, 왜곡 1/80, 상한 안 |
| 구독 장애 대비 | OpenRouter `claude-haiku-5.5` 또는 `gpt-6-luna` | 같은 품질대. 키와 잔액이 있는 동안 |
| Codex | 한도가 남을 때만의 예비 경로 | 실호출 미검증, 코딩 작업과 한도 경합 |

**공통 조건.**

- 민감도 필터: OpenRouter는 공개 문서만 보낸다. 사용자 기록은 이 경로로 가지 않는다.
- 판정은 `finish_reason`, 스키마 검증, `usage.cost`를 함께 본다. 잘림을 실패로 센다.
- 잔액, 키 만료, 플랜 한도를 카나리아에 넣는다. Codex는 `ordinaryUsageAllowed`를 시작 조건으로 둔다.
- ADR의 `--max-budget-usd 0.02`는 Haiku 전용이다. 모델을 바꾸면 상한도 바꿔야 한다.

**사용자 확인 필요.**

| 항목 | 내용 | 기한 |
|---|---|---|
| Codex 실측 | 초기화 뒤 구독으로 돌릴지, 무료 리셋권을 쓸지, 크레딧을 쓸지. 초기화를 기다리면 추가 비용이 없다 | 초기화 2026-11-04 15:35 KST. 리셋권 만료 2026-11-07 08:28 KST |
| OpenRouter 키 | 2026-11-30 만료. 새 키를 만들고 만료 없는 키로 둘지 | 2026-11-30 19:41 KST 전 |
| 크레딧 구매일 | 365일 기한 계산에 필요. Credits 페이지에서 확인 | 운영 전 |
| Sol 본측정 범위 | 첫 적체 투입 전에 40창 전체로 재측정할지. 약 $1.3로 이번 상한 밖이다 | 첫 적체 전 |
| Max 월 $100 API 크레딧 | Console 조직 연결 여부. 연결은 직접 바꿀 수 없다 | 수시 |

## 9. 미측정과 한계

- `codex exec` 실호출 전부. 품질, 시간, 토큰, 도구 차단 조합의 실제 수용, 주입 내성, 한도 초과 상태의 동작.
- Gemini 3.8 Flash는 6창이다. Sol은 상한 때문에 19창이다(`simon-2#0` 미측정).
- 주입 내성은 어느 경로에서도 재지 않았다. 표본에 주입 문구가 없다.
- 표본이 작고 대부분 1회 측정이다. 공급자, 시간대, 부하에 따른 변동은 재지 않았다.
- 도메인 A, C, E 표본이 없다(하네스 한계). 후보 enum과 술어 목록은 운영 값이 아니다.
- OpenRouter 동시 처리(ADR 동시 4)는 재지 않았다. 문서상 유료 모델에 플랫폼 요청 상한은 없고, 잔액 대비 진행 중 비용 예산(`in_flight_budget`)은 있다. [1차]
- 재현성: `temperature`, `seed` 지원이 모델마다 달라 `claude -p`, Haiku, Luna, Sol은 온도를 넣지 못했다. 지원 표는 각 런의 `meta.json`에 있다.
- 심판은 Claude Sonnet 하나다. 민감도 보정은 주입 24건과 대조군 12건이다.
- 게이트 2, 6, 9단계는 하네스에 없다.

## 10. 부수 효과와 사고

**외부 전송.** Anthropic과 OpenRouter(그리고 OpenRouter가 고른 공급자)에 하네스 공개 문서 창과 그 주장만 보냈다. 인증 없는 Codex 시험은 `hello` 한 단어가 `api.openai.com`에 도달해 401을 받았다. 유튜브·Google의 수집 경로(자동완성, Trends, Data API 등)는 호출하지 않았다. OpenRouter를 거친 Gemini 추론과 Vertex 경유 Haiku 시도는 LLM 호출이고 내용은 같은 공개 문서다.

**자격 증명.** OpenRouter 키는 러너 프로세스 안에서만 읽었고 출력하거나 기록하지 않았다. 응답의 `label` 등은 허용 목록으로 걸렀다. `~/.codex/auth.json`은 읽지 않았다.

**사고 1건(경미).** `codex app-server` 응답 전체를 한 번 출력해 ChatGPT 계정 식별자와 리셋권 식별자가 이 세션 기록에 남았다. 자격 증명은 아니다. 저장 파일에서는 지웠고 어댑터는 허용 목록만 남긴다. 세션 기록의 값은 지우지 못했다.

**전역 파일.** `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.codex/hooks.json`, 셸 프로필, crontab, systemd는 바뀌지 않았다. `~/.codex/models_cache.json`과 플러그인 캐시 표식은 작업 중 갱신됐다. Codex 자체 캐시이고 다른 세션도 갱신할 수 있어 원인은 특정하지 못했다.

**운영 실수.**

- Haiku 러너가 끝나기 전에 채점해 19창 기준 심판을 시작했다가 멈추고 20창으로 다시 돌렸다. 심판 1~2회분이 낭비됐다. 결과에는 영향이 없다.
- 그때 `pkill -f`의 패턴이 내 셸 명령줄에도 맞아 셸이 종료됐다. 패턴이 내 스크립트 이름뿐이라 다른 세션에는 영향이 없었다.

**산출 위치.** 큰 파일은 전부 `~/.cache/sagae-kb/llm-eval` 아래에 있다. 저장소에는 이 문서만 썼고 커밋하지 않았다.

## 11. 재현

```sh
B=~/.cache/sagae-kb/llm-eval; H=$B/harness; cd $B/hosted
python3 -I run_claude.py --model haiku --run-dir $B/results/claude-cli/haiku-20w --windows subset20.jsonl --budget 0.02
python3 -I run_openrouter.py --plan openrouter/plan.json --cap 0.95          # 호출 단위 지출 상한. 장부 openrouter/live/spend.json은 누적이고, 이미 $0.93이라 새 측정은 장부를 옮긴 뒤 돌린다
python3 -I run_codex.py --run-dir $B/results/codex-cli/gpt-6.1-sol-20w --windows subset20.jsonl   # 한도 초과면 호출 없이 exit 3
python3 -I run_codex.py --model gpt-6-luna --effort medium --run-dir $B/results/codex-cli/gpt-6-luna-20w --windows subset20.jsonl
python3 -I $H/scripts/score.py <run_dir> --windows subset20.jsonl
python3 -I $H/scripts/judge.py pool <run_dir> --per-run 80
python3 -I $H/scripts/judge.py run <run_dir> --model sonnet --batch 10
python3 -I $H/scripts/judge.py sum <run_dir>
python3 -I final_table.py; python3 -I calc_burn.py
```

sLLM 런과 비교할 때는 `score.py <run_dir> --windows ../hosted/subset20.jsonl`로 같은 20창만 채점한다. 원자료는 `results/claude-cli/`, `results/openrouter/`, 집계는 `hosted/final_table.json`, `hosted/openrouter/burn.json`, `burn.csv`, 보정은 `hosted/judge_calib.json`, 요청 본문은 `hosted/codex/mock/`이다.

## 12. 출처

확인일 2026-10-31~11-01.

- OpenRouter 약관: https://openrouter.ai/terms
- OpenRouter FAQ: https://openrouter.ai/docs/faq
- OpenRouter 요금: https://openrouter.ai/pricing
- OpenRouter 모델 목록: https://openrouter.ai/api/v1/models
- OpenRouter OpenAPI(`/credits`, `/key`, `/batches`): https://openrouter.ai/openapi.json
- OpenRouter 한도: https://openrouter.ai/docs/api_reference/limits
- OpenRouter 구조화 출력: https://openrouter.ai/docs/guides/features/structured-outputs
- OpenRouter 공급자 선택: https://openrouter.ai/docs/guides/routing/provider-selection
- OpenRouter 사용량 집계: https://openrouter.ai/docs/cookbook/administration/usage-accounting
- Codex 비대화 모드: https://learn.chatgpt.com/docs/non-interactive-mode
- Codex 가격·크레딧: https://learn.chatgpt.com/docs/pricing
- Codex 인증: https://learn.chatgpt.com/docs/auth
- Codex 설정: https://learn.chatgpt.com/docs/config-file/config-reference
- Codex app-server: https://learn.chatgpt.com/docs/app-server
- Codex 모델: https://learn.chatgpt.com/docs/models
- OpenAI 도움말(원문 403, 검색 요약만 확인, 2차): https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-personal-plans
- Claude 가격: https://platform.claude.com/docs/en/about-claude/pricing
- Claude 구독자 API 크레딧: https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers
- Claude 구조화 출력: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Claude Code 헤드리스: https://code.claude.com/docs/en/headless
- Agent SDK와 플랜: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
