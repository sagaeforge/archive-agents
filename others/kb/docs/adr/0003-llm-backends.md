# ADR-0003: LLM 백엔드 라우팅

- 날짜: 2026-11-01
- 상태: 결정됨. Codex 경로만 실측 전이라 꺼 둔다(7장). "3종 모두 동작"(ADR-0002)은 Codex 실측 통과 전까지 미충족이다.
- 입력: `docs/research/llm-hosted.md`, `docs/research/llm-sllm.md`, ADR-0002, ADR-0001 10.5, 10.6, 20.3. 원자료는 `~/.cache/sagae-kb/llm-eval/results/`다.
- 표기: **[실측]** 결과 파일의 값. **[mock]** 호출 없이 요청 본문만 본 값. **[무효 런]** GPU 경합 표시 런의 값. **[추론]** 측정 값으로 한 계산이나 해석. **[설정값]** 이 문서가 정한 값이고 측정이 아니다. 전부 `sources/internal.d/extract.yaml`에서 바꾼다.

## 1. 결정

1. 공개 문서 추출은 OpenRouter `openai/gpt-6.1-sol`로 시작해 잔액을 실작업으로 쓴다. 소진 뒤 정기 처리는 `claude -p --model haiku`다.
2. sLLM은 공개 문서 추출과 함의 판정에 쓰지 않는다. 네 모델 모두 사전 고정 기준에 불합격했다.
3. 민감 범위 추출은 Nemotron을 네트워크 없는 이름공간에서 돌린다. 사전 고정 기준 `민감 자료 처리`를 유효 런으로 통과했다.
4. 민감 범위는 어떤 외부 LLM으로도 가지 않는다. 코드가 전송 직전에 검사하고 모르면 거부한다.
5. 인용 게이트는 모델과 무관하게 같다. 모델별 예외나 문턱이 없다. 주장에 백엔드와 모델을 남긴다.
6. L2에 재시도 사다리를 쓰지 않는다. 경로 전환은 5장 규칙을 따른다.

## 2. 라우팅

외부 LLM은 Claude, Codex, OpenRouter 전부다. sLLM만 내부다. 범위 정의는 3장이다.

| 과제 | 입력 | 1순위 | 대체(순서대로) | 전부 막히면 |
|---|---|---|---|---|
| 공개 문서 추출, 잔액 있음 | 공개 범위 | OpenRouter `openai/gpt-6.1-sol`, 공급자 OpenAI 고정 | OpenRouter `anthropic/claude-haiku-5.5` → `claude -p --model haiku` → Codex(통과 뒤) | 큐에 남긴다. L0, L1, 조회는 돈다 |
| 공개 문서 추출, 소진 뒤 | 공개 범위 | `claude -p --model haiku` | Codex(통과 뒤) | 큐에 남긴다 |
| 민감 자료 추출 | first_party, `internal`, `private` | sLLM Nemotron, 이름공간 안 | 없음. 외부로 넘기지 않는다 | 원문만 저장한다 |
| 추출 제외 자료 | `secret`, 세션 자료 | 추출하지 않는다 | 없음 | 원문만 저장한다 |
| 민감도 보조 분류 | 민감 범위 | sLLM Nemotron + 쓰기 시 비밀 탐지. 상향 전용 | 비밀 탐지만 | 현재 등급 유지 |
| 재확인: 인용구 대조 | 전 범위 | 결정적 문자열 대조(10.7). LLM 없음 | 없음 | 해당 없음 |
| 재확인: 함의 판정 | 공개 주장의 `R_VALUE_MISMATCH`, `R_SUBJECT_CONTEXT`, `R_ALIAS_MISMATCH` | OpenRouter `anthropic/claude-sonnet-5.5`(보정 통과 뒤) | `claude -p --model haiku` 일일 100건 | `needs_review` 유지 |
| 재확인: 민감 범위 | 민감 범위 주장 | 없음. sLLM은 오승인 기준 불합격 | 없음 | `needs_review` 유지 |
| 교차 확인 | 공개 주장 표본 주 80건(언어별 40) | 추출과 다른 벤더. Sol 추출분은 OpenRouter `anthropic/claude-sonnet-5.5`, Haiku 추출분은 OpenRouter `openai/gpt-6.1-sol` | Codex(통과 뒤) → `claude -p --model sonnet`(같은 벤더로 표시) | 그 주를 공백으로 기록 |

- **왜 Sol인가.** 같은 표본에서 창당 통과 주장이 가장 많고(9.53) 왜곡 0/80이다. 소진 목표와 품질이 같은 방향이다. 9장. [실측]
- **왜 함의 판정이 OpenRouter인가.** Sol 추출분은 창당 보류 약 2.0건이라 400창이면 800건이고 일일 100건 상한으로는 밀린다. [추론] 잔액이 있는 동안 처리량을 일 1,000건 [설정값]으로 올린다. `claude -p` Sonnet의 오승인은 0/94다. OpenRouter 경유는 재지 않았다. 141건 보정(약 $0.5 [추론])을 1회 돌려 오승인 ≤0.05, 재현율 ≥0.80이면 켠다. 그전에는 대체가 1순위다.
- **교차 확인의 결과는 지표다.** 주장 상태를 바꾸지 않고 `claim.assert`를 내지 않는다(ADR-0001 10.6 표본 감사). Sol의 판정 성능은 재지 않았다. [추론]
- **경로가 바뀌어도 다시 뽑지 않는다.** 큐는 `(para_sha, prompt_version, extract_schema)`로 판정하고 백엔드를 보지 않는다. 전환이 재추출이 되면 지출이 두 배가 되고 ADR-0001 7.6 규칙이 옛 주장을 철회한다. 재추출은 명시 명령으로만 한다.

## 3. 민감도 경계

| 범위 | 정의 |
|---|---|
| 공개 범위 | `origin=external` 그리고 `sensitivity=0`, 표시가 `f:user`, `f:agent:*`가 아니고, 비밀 탐지 무검출 |
| 민감 범위 | 나머지 전부. first_party, 세션 자료(`f:agent:*`), `sensitivity≥1`, 값을 모르는 입력 |

- **검사 위치.** `src/kb/extract/guard.py` 한 곳이다. 외부 어댑터는 `SendPermit` 없이 요청을 만들 수 없다.
- **검사 시점.** 전송 직전, 창의 모든 문단을 원장 `head`의 최신 민감도로 본다(ADR-0001의 가시성 규칙). 값이 없거나 읽기 실패면 거부다.
- **허가 근거.** 저장된 `origin`, `sensitivity`, 표시뿐이다. LLM 분류는 허가 근거가 아니다. 유효 런에서 `internal` 1건을 `public`으로 잡았다. [실측]
- **상향 전용.** sLLM 분류는 등급을 올리기만 한다. `secret`은 Nemotron 6/6, 정규식 단독 4/6이다. [실측, 합성 24건]
- **파생 주장.** 원본 민감도를 물려받는다. 추출은 비식별이 아니다. 합성 표본의 통과 주장 30건 중 4건에 연락처 형식이 그대로 있었다. [실측]
- **세션 자료와 `secret`.** ADR-0001 7.8의 "세션 서술은 어느 경로로도 `claim.assert`가 되지 않는다"를 유지한다. `secret` 본문은 `kb owner read`만 읽는다(7.9). 둘은 sLLM이 합격해도 추출하지 않는다. 세션 자료는 분류만 한다.
- **first_party 게이트.** `fp_open` 전에는 민감 범위 추출도 돌지 않는다.
- **자동 에이전트 읽기.** `kb-collect` 프로필의 `kb_search`, `kb_get`, `kb_source`도 공개 범위만 돌려준다. 이 도구의 결과는 Claude로 간다.
- **위반 처리.** 허가 없는 전송이 일어나면 `incidents`의 `external_send`다. L2 전체를 멈춘다.

## 4. OpenRouter 소진 정책

목표는 2026-11-30 19:41 KST 키 만료 전에 잔액을 실작업으로 쓰는 것이다. 월 상한은 없다.

| 항목 | 값 | 근거 |
|---|---:|---|
| 잔액 | $145.24 | [실측] |
| Sol 단가 | $0.032337/창 | [실측] 19창, 최소 $0.0246, 최대 $0.0409 |
| 잔액으로 처리할 창 | 4,491 | [추론] |
| 400창/일 | $12.93/일, 11.2일 | [추론] |
| 400창/일의 마지막 시작 시각 | 2026-11-19 14:11 KST | [추론] |
| 밸브 $30/일까지 올리면 | 927창/일, 4.8일, 2026-11-25 23:29 KST | [추론] |
| 첫 적체 3,300창 | $106.7, $38.5 남음 | [추론] |
| 첫 적체 5,867창 | 4,491창째 소진, 1,376창은 Haiku로 400창/일 3.4일 | [추론] |

- **일일 창 수.** `max(400, 잔액 ÷ 남은 일수 ÷ 7일 평균 단가)`다. 위쪽은 밸브가 막는다. 운영 창은 6,000자까지라 표본 평균 4,977자보다 단가가 오를 수 있고, 평균 단가가 이를 따라간다. [추론]
- **소진 순서.** ① 공개 문서 추출 큐 ② 함의 판정 ③ 교차 확인 표본 확대. 합성 호출이나 같은 창 반복 호출로 태우지 않는다.
- **큐가 먼저 비면.** 3,300창이면 보류 약 6,600건, 건당 약 $0.003으로 약 $20이다. 신규 창은 1년 3.3만 창 기준 일 91창, 약 $2.9/일이다. 나머지는 교차 확인을 전수로 넓혀 쓴다. [추론]
- **안전 밸브.** `daily_valve_usd`, 기본 $30 [설정값]. KST 자정에 초기화하고 OpenRouter 전 호출을 합산한다. 계획 지출 $12.93의 약 2.3배라 밀린 일정을 따라잡을 수 있고, 버그가 있어도 잔액이 4.8일은 버틴다. 호출 전 예약, 호출 뒤 정산이다. 키에 `limit`이 없어 서버 쪽 상한이 없으므로 클라이언트가 막는다. [실측]
- **호출당 상한.** Sol은 `max_tokens` 4,000(측정값)과 예약 $0.054(입력 7,000, 출력 4,000토큰 가격)다. 측정 최대 출력은 2,957토큰이고 잘림 0이다. [실측]
- **잔액 기준.** 내부 장부가 기준이다. 측정에서 장부와 계정 증가분이 $0.931171로 일치했다. `/credits`는 대조용이다. 문서는 관리 키 전용이라 적고 일반 키로 200을 받았으므로 실패해도 멈추지 않고 경고만 한다. [실측]
- **첫 100창 점검.** 별도 재측정 없이 실운영 첫 100창을 측정으로 쓴다. 게이트 통과율 0.70 미만이면 멈추고, 고정 심판 80건을 1회 돌린다. Sol이 19창 측정이라 필요하다. [설정값]
- **시한 관리.** `kb status`가 잔액, 7일 평균 지출, 예상 미소진액, 키 만료까지 일수를 보인다. 2026-11-23(D-7)에 미소진이 예상되면 사용자에게 새 키 여부를 묻는다. 크레딧은 키와 별개라 키가 만료돼도 사라지지 않는다. [실측]

## 5. 전환 규칙

| 신호 | 판정 | 조치 | 복귀 |
|---|---|---|---|
| 잔액 소진 | 장부 잔액 < $0.10 [설정값] 또는 HTTP 402 | OpenRouter 끔. 소진 뒤 표로 간다 | 충전 또는 새 키 |
| 키 없음, 만료 | 키 파일 없음, `expires_at` 경과, HTTP 401 | OpenRouter 끔. D-7부터 경고 | 새 키 |
| 일일 밸브 | KST 일 합계 + 예약 > 밸브 | 그날 OpenRouter 정지. **대체 경로로 넘기지 않는다**. 버그가 구독으로 번지면 안 된다 | 다음 KST 0시 |
| 호출당 비용 초과 | 실제 비용 > 예약 | 그 배치 정지, 사고 기록 | 사람이 확인 |
| Claude 5시간 활용률 | 시작 시 >0.5, 도중 ≥0.7, 값 없음 | 시작 안 함 또는 정지. 다음 경로로 | 다음 회차에 재검사 |
| Claude 7일 활용률 | ≥0.80 | 정지. 다음 경로로 | 다음 회차에 재검사 |
| Claude 초과 과금 | `isUsingOverage=true` | 즉시 정지, 사고 기록 | 사람이 확인 |
| Claude 일일 창 | 400창 | 그날 Claude 추출 정지 | 다음 KST 0시 |
| Codex 한도 | `ordinaryUsageAllowed≠true` 또는 `usedPercent≥50` [설정값] | 호출 안 함. 크레딧을 쓰지 않는다 | `resetsAt` 뒤 재검사 |
| 오류율 상승 | 최근 50호출 중 HTTP 오류, 시간 초과, 스키마 실패, 잘림이 20% 이상, 또는 연속 5회 [설정값] | 그 모델을 1시간 끄고 다음 경로로 | 카나리아 1회 통과 |
| 게이트 통과율 하락 | 최근 20창 통과율 < 기준선 × 0.85 [설정값] | 그 모델을 끄고 다음 경로로, `kb status` 경고 | 회고 확인 뒤 사람이 켠다 |
| 빈 응답 | 최근 50창(`switch.yield_window`) 중 주장 0건인 창의 비율 ≥ 0.6(`switch.yield_empty_ratio`)이고 창이 가득 참. 모델별 `llm:yield:<키>`에 0/1을 쌓는다 [설정값] | 그 모델을 끄고 다음 경로로(`human=true`). 빈 창은 `gate_pass_drop` 이력에 넣지 않으므로 이 신호가 없으면 빈 응답만 내는 모델이 어떤 신호에도 걸리지 않는다 | 회고 확인 뒤 사람이 켠다 |
| 전 경로 동시 하락 | 두 경로 이상이 같은 날 하락 | 전환하지 않고 L2 정지. 입력이나 게이트 문제로 본다 | 사람이 확인 |

- `gate_pass_drop`의 복귀는 `kb llm reenable --model <키> --by user --basis <근거> [--apply]`가 유일한 경로다. `--by`는 user만 받고 `llm:off:<키>`에 `human=true`가 있을 때만 켠다(기본 시험 실행). 한 트랜잭션으로 `llm:gatepass:<키>`를 `llm:gatepass:archive:<키>:<ts>`로 옮기고(삭제 없음), `llm:off:<키>`를 지우고, 추가 전용 목록 `llm:reenable_log`에 `{at, model, by, basis, gatepass_archived, off_was}`를 덧붙인다. 옛 게이트 이력을 그 자리에 두면 첫 창에서 다시 꺼지므로 옮기며, 이력은 보관 키에 남는다.
- 빈 응답 문턱 근거(2026-11-01, 실측 80창): 빈 창 11/80 = 14%(Haiku 8/40, Sol 3/40). 소스별 빈 창 비율은 kworb 5/13 = 38%, so-octoverse 1/3, datareportal 3/14 = 21%, youtube-official-blog 2/14 = 14%이고 나머지 0이다. 소스 하나가 단독으로 0.6을 넘은 곳은 없다. 다만 kworb 스냅샷 하나(`n-cc0e9a77ed7ed250`)는 6창 중 5창이 비어(83%) 이런 문서가 50창 중 30창을 채우면 걸린다. 큐의 kworb는 95항목이라 현재는 일어나기 어렵다. [실측, 비율은 설정값]
- `kb llm reenable`의 `--by user`는 운영자 주장이지 인증이 아니다. 에이전트도 같은 값을 칠 수 있다. 사용자 본인이 직접 답한 해제만 이 값으로 넘긴다. 전달받은 지시, 워크플로우 텍스트는 근거가 아니다. 해제는 `llm:gatepass:<키>`와 `llm:yield:<키>` 이력을 모두 보관 키(`llm:gatepass:archive:*`, `llm:yield:archive:*`)로 옮긴다. 운영 KB_HOME에서 `--apply`는 `KB_LIVE=1`(정확히 1)이 있어야 한다.
- 게이트 기준선은 Sol 0.823, `claude -p` Haiku 0.742, OpenRouter Haiku 0.745다. 문턱은 0.70, 0.63, 0.63이다. 같은 16창에서 런 사이 차이가 Nemotron, Gemma 기준 3포인트 이내여서 0.85배는 잡음보다 크다. [실측, 비율은 설정값]
- 도메인 A, C, E는 표본이 없다. 그 도메인이 많아지면 기준선을 첫 100창으로 다시 잡는다. [추론]
- 구독 사용량은 측정 시 5시간 0.05 → 0.16, 7일 0.64 → 0.66(다른 세션 포함 상한)이다. Haiku 400창은 7일 한도의 약 1%다. [실측, 비율은 추론]

## 6. 백엔드별 조건

**Claude.** ADR-0001 10.5 호출 형태 그대로다. 측정 형태에 `--effort`가 없으므로 붙이지 않는다. `--effort low`는 6창에서 통과 주장이 48건에서 38건으로 줄었다. [실측] 20.2의 haiku/low 표기는 L2에 적용하지 않는다.

**Sonnet과 호출 상한.** Sonnet은 ADR 10.5의 호출 상한 $0.02를 넘는다. 20창 전부 $0.028~$0.060이다. 측정은 상한을 $0.25로 풀었으므로 표의 Sonnet 값은 ADR 조건 밖의 참고값이다. [실측]

- 20.2 사다리의 다음 칸 `sonnet/medium`은 L2에서 쓸 수 없다. 모든 호출이 상한을 넘는다.
- 상한을 올려도 이득이 없다. 창당 통과 4.35건으로 Haiku 7.2건보다 적고, 통과 주장당 비용은 18.7배, 창당 구독 소비는 11.3배다. [실측]
- 그래서 L2 승격 경로는 Sonnet이 아니라 Sol이다. 소진 뒤에는 승격이 없다.
- 상한은 모델별 값이다. `$0.02`는 Haiku 전용(측정 최대 $0.00606)이다. 교차 확인의 `claude -p --model sonnet`은 10건 묶음 124회가 $0.0246~$0.0394(건당 약 $0.003)라 `--max-budget-usd 0.05` [설정값]를 쓴다.
- 상한이 실제로 호출을 끊는지는 재지 않았다.

**OpenRouter.** `provider.order` 고정, `require_parameters: true`. 공급자는 측정값이다(Sol OpenAI 19/19, Haiku Azure 20/20). Sol은 `full` 스키마, Haiku는 `strict-min+anyof`로 보낸다. 동시 수는 측정한 1이다. 1이어도 약 167창/시간이라 밸브 한도 927창/일에 충분하다. [실측, 계산]

**Codex.** 7장.

**sLLM.** 상주 프로세스 0을 지킨다. `llama-server`는 `kb agent run --scope sensitive`의 자식으로만 산다. 타이머, 소켓 활성화, 유휴 대기를 두지 않는다.

1. 큐가 비었으면 띄우지 않는다.
2. 여유 VRAM 6,144 MiB [설정값] 미만이면 이번 회차를 건너뛰고 지표에 남긴다. 로드 뒤 증가 측정값은 3,749~4,352 MiB다. [실측]
3. `unshare -Urn`으로 이름공간에 들어가 `ip link set lo up`을 하고, 워커와 서버를 그 안에서 함께 돌린다.
4. `llama-server -m <gguf> --host 127.0.0.1 --port 18080 -ngl 999 -c 16384 -np 2 -cram 0 --no-context-shift -t 12 -tb 12 --reasoning off`
5. `/health` 대기, 카나리아 1회. 로드 1.5~4.5초다. [실측]
6. `/apply-template` 결과에 빈 사고 블록을 붙여 `/completion`에 `json_schema`와 함께 보낸다. 없으면 40창 중 10창이 잘린다. [무효 런]
7. 끝나면 TERM, 20초 뒤 KILL, 프로세스 잔존 0을 확인한다. 부모가 죽어도 남지 않게 `PR_SET_PDEATHSIG`를 건다.
8. 전후 `nvidia-smi`와 경합 판정을 `ops.db`에 남긴다. 경합이면 속도 지표만 무효로 표시한다.

처리량은 공개 문서 2슬롯 316창/시간, 합성 first_party 1슬롯 325창/시간이다. [실측] 바이너리는 llama.cpp b12020, 모델은 `models/manifest.json`의 해시로 고정해 `$KB_MODELS`에 둔다. `~/.cache` 경로는 측정용이다. 왜곡은 재지 못했다. 고정 심판이 외부 LLM이고 표본이 로컬 전용이기 때문이다. Gemma 4 12B는 이름공간 측정 전까지 예비로만 둔다. Nemotron을 못 쓰면 원문만 저장한다.

## 7. Codex

**실호출 0건.** 주간 한도가 2026-11-04 15:35 KST까지 소진 상태이고 이 상태의 호출은 구매 크레딧을 쓸 수 있다. 그때까지 `codex.enabled=false`다.

| 수준 | 내용 |
|---|---|
| mock으로만 확인 | `--output-schema`가 `text.format` strict로 나감. 플래그별 노출 도구, `view_image`, `request_user_input`이 남음. 기본 모델과 effort. 어댑터 파싱 |
| 실환경 확인 | `env -i`에서 저장 로그인 동작(`account/rateLimits/read`), 미인증이면 exit 1과 401, `run_codex.py`가 한도 상태에서 호출 없이 exit 3 |
| 미검증 | 모델이 이 플래그 조합을 받는지, 구조화 출력 강제, 품질, 시간, 토큰, 주입 내성, 도구 호출 여부, 한도 초과 상태의 동작 |

- **실측 시점.** 2026-11-04 15:35 KST 초기화 뒤 첫 작업일. 구독 한도만 쓴다. 리셋권(2026-11-07 08:28 KST 만료)과 크레딧은 쓰지 않는다.
- **절차.** `~/.cache/sagae-kb/llm-eval/hosted/run_codex.py`를 `gpt-6.1-sol`, `gpt-6-luna`로 `--windows subset20.jsonl` 실행한다. 한도 조건이 안 맞으면 스스로 exit 3으로 끝난다. 그 뒤 `score.py`, `judge.py`다.
- **합격선.** 대량 1차 추출 기준 그대로다. 스키마 ≥0.95, 게이트 ≥0.668, 왜곡 ≤6.25%, 창당 ≤60초에 스트림 `tool_items` 0건을 더한다. 둘 다 합격이면 한도 소비가 작은 쪽을 쓴다.
- **불합격이면.** 경로를 끈 채 사용자에게 보고한다. "3종 모두 동작"을 못 채운 것이므로 이 ADR을 고친다.
- **제약.** "도구 0개"를 달성하지 못했다. `view_image`가 남고 네트워크 도구는 없다. [mock] 공개 범위만 보낸다. 코딩 작업과 주간 한도를 나누므로 대체 경로로만 쓴다.

## 8. 공통 어댑터

```python
class Backend(Protocol):
    name: str          # claude | codex | openrouter | sllm
    external: bool     # sllm만 False
    def preflight(self) -> Preflight: ...      # 인증, 한도, 잔액, 키 만료, 바이너리, 카나리아
    def extract(self, job: Job, permit: SendPermit | None) -> Result: ...
```

- `Result`는 하네스 `raw.jsonl` 계약이다: `window_id`, `backend`, `model`, `served_model`, `provider`, `raw`, `usage{input_tokens, output_tokens, cached_input_tokens, reasoning_tokens}`, `finish_reason`, `elapsed_s`, `cost_usd`, `error`.
- 어댑터는 호출과 응답 변환만 한다. 라우팅, 재시도, 지출 판단을 하지 않는다. 코드 펜스 제거 같은 후처리를 하지 않는다.
- 전송 스키마는 어댑터별로 달라도 검증은 공통 층이 `full` 정본으로 한다. 잘림은 실패다.
- 위치는 `src/kb/extract/backends/{claude,codex,openrouter,sllm}.py`, 라우터는 `src/kb/extract/route.py`다. `kb-agent-run`과 워크플로우는 Claude 전용으로 남는다.
- 모델별 카나리아가 필요하다. 구조화 출력 지원이 같은 요청의 성공을 뜻하지 않는다. 7개 모델 중 3개가 첫 호출에서 400이었다. [실측]

## 9. 같은 20창 비교

`score.py --windows subset20.jsonl`, 사본 채점(`results/compare20/summary.json`). Sol은 19창이고 Sol의 19창으로 맞추면 Haiku는 게이트 0.769, 창당 통과 7.37이다. sLLM의 왜곡은 40창 심판 표본의 부분집합이다.

| 백엔드 | 창 | 스키마 | 게이트 | 인용구 존재 | 창당 통과 | 왜곡 | 초/창 | $/창 | 판정 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| OR `gpt-6.1-sol` | 19 | 1.00 | 0.823 | 0.996 | 9.53 | 0/80 | 21.5 | 0.03234 | 공개 1순위 |
| OR `claude-haiku-5.5` | 20 | 1.00 | 0.745 | 0.995 | 7.45 | 0/80 | 20.1 | 0.00292 | 공개 대체 |
| `claude -p` Haiku | 20 | 1.00 | 0.742 | 0.985 | 7.20 | 1/80 | 21.8 | 0.00402 추정 | 소진 뒤 1순위 |
| `claude -p` Sonnet(상한 $0.25) | 20 | 1.00 | 0.521 | 1.000 | 4.35 | 0/80 | 12.6 | 0.04536 추정 | L2 미사용 |
| Nemotron [무효 런] | 20 | 1.00 | 0.597 | 0.818 | 6.90 | 0/41 | 무효 | 0 | 민감 범위 |
| Gemma 4 12B [무효 런] | 20 | 1.00 | 0.546 | 0.877 | 6.20 | 2/45 | 무효 | 0 | 예비 |
| Qwen3.8-27B | 20 | 1.00 | 0.488 | 0.905 | 5.15 | 2/40 | 51.8 | 0 | 미사용 |
| Kanana-2-3B | 20 | 1.00 | 0.179 | 0.537 | 1.20 | 3/46 | 8.1 | 0 | 미사용 |
| Codex | 미측정 | | | | | | | | 7장 |

Nemotron, Gemma의 유효 런은 16창뿐이고 게이트 0.591~0.601, 0.468~0.470, 창당 22.8초, 38.5초(2슬롯)다. 기준 0.668 미달은 같다.

민감 자료 처리 판정 근거다. [실측, 합성 표본] 인터페이스 `lo`뿐, 외부 접속 실패, `secret` 6/6, 고위험 14/14, first_party 6창 스키마 1.00, 인용구 존재 1.00, 게이트 0.732.

함의 판정 오승인이다. `claude -p` Sonnet 0/94, Haiku 3/94, Qwen 8/94, Gemma 15/94, Nemotron 21/94 [무효 런], 기준 5%다. 같은 문항, 다른 프롬프트다. [실측]

## 10. 기록과 지표

**주장 출처.** `claim.assert.extractor`를 `l2:<backend>:<model>:<prompt_version>`으로 쓴다. L2 주장에 필수다. 게이트 판본은 기존 `evidence.gate_version`이다. 모델 교체 뒤 `kb claim retract --extractor`로 경로별 철회가 된다.

**`extract.run`.** 기존 필드에 `backend`, `provider`, `served_model`, `schema_profile`, `purpose`, `scope`, `route_reason`, `finish_reason`, `elapsed_s`, `cost_usd`를 더한다. `cost_usd`는 OpenRouter 실제값이고, Claude는 구독이라 추정값이며 실제 청구가 아니다. Codex는 null이고 `usedPercent`를 남긴다. sLLM은 0이다.

**호출 기록.** `ops.db`에 호출마다 위 값과 잔액, `five_hour`, `seven_day`, 전환 사유를 남긴다. 창 본문은 넣지 않는다.

**회고 지표.** `kb metrics --week --json`의 `llm` 키다. 수치만 넣는다.

| 묶음 | 지표 |
|---|---|
| 모델별 품질 | 호출, 창, 오류율, 잘림, 스키마 실패, 게이트 통과·보류·거부, 창당 통과 주장, 교차 확인 왜곡률 |
| 비용 | 토큰, $/창, $/통과 주장, 일 지출, 밸브 도달 횟수 |
| 소진 | 잔액, 7일 평균 지출, 예상 미소진액, 키 만료까지 일수 |
| 한도 | `five_hour`, `seven_day`, Codex `usedPercent` 최고값, 정지 횟수 |
| 경계 | 가드 거부 수, 민감 범위 처리 수, `external_send` 사고 수 |
| 경로 | 사유별 전환 횟수, 경로별 체류 시간 |
| sLLM | 로드 시간, VRAM 최고, 경합 횟수, 건너뛴 회차 |

## 11. 미검증

| 항목 | 상태 | 확인 시점 |
|---|---|---|
| Codex 실호출 | 7장 | 2026-11-04 15:35 KST 이후 |
| OpenRouter Sonnet 함의 판정 | 경로 미측정 | 켜기 전 141건 보정 |
| OpenRouter 동시 호출 | 재지 않음. 1로 시작 | 처리량이 모자랄 때 |
| `--max-budget-usd` 초과 시 동작 | 재지 않음 | Sonnet을 쓰지 않으므로 교차 확인 첫 실행 때 |
| systemd 안의 `unshare -Urn` | 대화형 셸에서만 측정 | WP-19 |
| 민감 범위 왜곡 | 고정 심판을 쓸 수 없어 미측정 | 사용자 표본 확인(결정 12) 때 |
| 주입 내성 | 전 경로 미측정 | WP-19 |
| 표본 크기 | Sol 19창, first_party 6창, 민감도 24건 | 첫 100창과 회고 |

## 12. 수치 출처

경로는 `~/.cache/sagae-kb/llm-eval/` 기준이다. 표에 없는 임계값은 [설정값]이다.

| 수치 | 출처 |
|---|---|
| 게이트, 왜곡, 인용구, 창당, 초/창, $/창, 비용 최소·최대 | `results/compare20/summary.json`, `docs/research/llm-sllm.md` 3장 |
| 판정, 합격선 0.668, 6.25% | `results/sllm/verdicts.json`, `harness/tasks/criteria.json` |
| 이름공간, first_party, 민감도 | `results/sllm/netns/`, `results/sllm/verdicts.json`, `docs/research/llm-sllm.md` 5장 |
| 같은 16창 게이트, 처리량, VRAM, 로드 | `results/sllm/*/score.json`, `local.json`, `docs/research/llm-sllm.md` 2, 3장 |
| 함의 오승인 | `results/judge/calib-{haiku,sonnet}.json`, `results/sllm/tasks-*/out/tasks_score.json` |
| 심판 묶음 비용 | `results/*/judged.jsonl`의 `judge_cost` |
| 잔액, 키 만료, `limit`, 장부 일치, 구독 활용률, Sonnet 효율 비율 | `docs/research/llm-hosted.md` 0, 2, 3, 5장, `hosted/final_table.json`, `hosted/openrouter/live/spend.json` |
| Sol `max_tokens`, 공급자, 최대 출력 | `results/openrouter/gpt-6.1-sol-20w/{meta.json,raw.jsonl}`, `hosted/run_openrouter.py` |
| 첫 적체, 1년 3.3만 창, 400창/일 | ADR-0001 10.5, 부록 A, `docs/research/llm-hosted.md` 7장 |
| 소진 계산 | 잔액 145.24 ÷ 0.032337. 키 만료 시각에서 소진 일수를 뺐다 |
| Claude 정지 문턱 | ADR-0001 10.5, `hosted/run_claude.py` |
| Codex 상태, mock 범위 | `docs/research/llm-hosted.md` 4장, `hosted/codex/`, `hosted/run_codex.py` |
