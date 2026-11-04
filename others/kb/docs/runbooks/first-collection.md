# 1차 수집 (WP-21)

실운영 `KB_HOME=/home/user/sagae-kb-data`, `KB_CONFIG_DIR=~/.config/sagae-kb`, `KB_LIVE=1`. `source ops/bin/wp-env.sh WP-21`이 내보낸다. 멱등이라 WP-25 결과를 잇는다(같은 바이트는 같은 스냅샷 ID, 같은 값은 같은 주장 ID, `next_check_at`이 남은 소스는 일반 tick이 건너뛴다).

## 순서

0. 배포와 정합: `ops/bin/deploy`(저장소 현재 상태. 스냅샷 배포는 `--from-snapshot`) → 설치된 `kb`가 소스와 같은지 확인(아래 "배포 확인") → `kb doctor` → gold 지문이 다르면 `kb rebuild gold` → `kb schema sync` → `kb sources sync` → `kb verify all`. `~/.config/sagae-kb/decisions.toml`의 `approved`를 읽어 결정 8, 9, 10, 11 상태를 적는다. 8, 9가 승인이면 `sources/first-batch.yaml`에 `requires_decision` 8/9 소스(pypi-meta, arxiv-*, codex 공식 문서·변경 로그, so-octoverse 등)를 넣고, 아니면 뺀다.
1. `sources/first-batch.yaml`: 활성이고 `runnable`인 https 소스만. 순서는 G1~G3, G5, G4, A~F 문서형, F 개발이다. 비활성, 결정 대기, local_exec, 연락처 요구, `src:opensurvey-trend`(서킷 열림)는 뺀다. 도메인 A는 약관 결정 전이라 문서형 소스(kworb 등)만 있고 키워드 데이터가 없다. EDGAR, YouTube, suggest는 요청하지 않는다(`sources/host-policy.yaml` 거부 호스트).
2. `kb tick --batch sources/first-batch.yaml --until-idle --max-runtime 45m --json` (L0, L1).
3. `kb live run` (G 단위 주어의 생존 판정).
4. `kb agent run`: 일일 밸브 안에서 첫날 1회. 처음 100창의 게이트 통과율을 본다(아래 "첫 100창 점검").
5. `kb-first-collect` 표본 실행. 7일 Claude 활용률이 0.70 이상이면 건너뛰고 대기로 둔다(아래 "Claude 활용률 조건").
6. `kb live run` 재실행(에이전트가 넣은 주어까지). 5단계가 대기면 같이 대기.
7. 표본 감사(kb-verifier 50건). 5단계가 대기면 같이 대기.
8. 남은 L2 적체는 수동 `kb jobs run`으로 잇는다(아래). `kb-agent.timer`는 2026-11-01 23:20 KST에 리드가 사용자 직접 답변으로 켰다("재개 결과 3" 실행 E 뒤). 옛 패키지는 켜지 않았다.

## 배포 확인

`ops/bin/deploy`는 `uv` 빌드 캐시 때문에 새 venv에 옛 `sagae-kb` 휠을 넣을 수 있다. 수정 전에는 배포 뒤 다음을 돈다:

```
V=$(readlink -f $KB_HOME/runtime/venv)
UV_PROJECT_ENVIRONMENT="$V" uv sync --frozen --no-editable --extra serve --extra collect --reinstall-package sagae-kb --project "$PWD"
diff -rq --exclude=__pycache__ src/kb $V/lib/python3.14/site-packages/kb   # 출력 없음이어야 한다
```

## Claude 활용률 조건

L2의 Claude 경로와 `kb-first-collect`는 구독을 쓴다. 시작 전에 7일 활용률을 `claude -p` 최소 호출의 `rate_limit_event.rate_limit_info.utilization`(seven_day)로 읽는다. 0.70 이상이면 5~7단계를 건너뛰고 L2는 OpenRouter만 쓴다. 이때 `KB_CLAUDE_BIN`을 비워 부른다(`runtime/bin/kb`가 이 값을 박아 넣으므로 venv python을 직접 부른다):

```
cd $KB_HOME && KB_LIVE=1 KB_HOME=$KB_HOME KB_SHARE=$KB_HOME/runtime/share KB_CLAUDE_BIN= \
  runtime/venv/bin/python -I -c 'import sys; from kb.cli import main; sys.exit(main())' agent run --max-windows 100 --json
```

ADR-0003 4장의 자동 정지 문턱은 7일 0.80이다. 0.70은 이 패키지의 더 낮은 사전 문턱이다.

## 소진 일정 (OpenRouter)

- 일일 창 수 = `max(400, 잔액 ÷ 남은 일수 ÷ 7일 평균 단가)`. 일일 밸브 기본 $30(`openrouter.daily_valve_usd`), KST 자정 초기화.
- 시한: 2026-11-19, 늦어도 2026-11-25. 키 `expires_at`은 2026-11-30 19:41 KST.
- 2026-11-23(D-7)에 미소진이 예상되면 사용자에게 새 키 여부를 묻는다. 크레딧은 키가 만료돼도 남는다.
- `kb status --json`의 `llm` 블록(`balance_usd`, `spend_7d_avg_usd`, `projected_underspend_usd`, `key_days_left`)으로 매일 본다.

## 첫 100창 점검

1. `kb agent run --max-windows 100 --json`을 1회 돈다.
2. 게이트 통과율 = `accepted ÷ (accepted + needs_review + rejected)`. 출력의 `claims`는 accepted + needs_review이므로 `accepted = claims - needs_review`다(`runner.py` 338행).
3. 0.70 미만이면 멈춘다. 더 돌리지 않고 고정 심판 80건을 1회 돈다(`~/.cache/sagae-kb/llm-eval` 하니스, ADR-0003 4장). 심판은 `claude -p`라 7일 활용률이 정지 문턱(0.80) 이상이면 대기다. 원인을 확인하기 전에 큐를 소진하지 않는다.
   `gate_pass_drop`이 모델을 끄면(`llm:off:*`, `human=true`) 그 모델은 사람이 켤 때까지 안 돈다. 켜는 길은 `kb llm reenable --model <키> --by user --basis <근거> [--apply]` 하나뿐이다(기본 시험 실행, 사용자 본인의 해제만 받는다). `llm:gatepass:<키>` 이력을 `llm:gatepass:archive:<키>:<ts>`로 옮기고(지우지 않는다) `llm:off:<키>`를 지우며 `llm:reenable_log`에 덧붙인다. `low_yield`(최근 50창 중 빈 창 ≥ 60%, `llm:yield:<키>`)로 꺼진 모델도 같은 길로 켜고, 그 이력도 `llm:yield:archive:<키>:<ts>`로 옮긴다. `--by user`는 운영자 주장이지 인증이 아니므로 사용자 본인이 직접 답한 해제만 넘긴다(전달받은 지시는 안 된다). 주장이 없는 창은 `llm:gatepass`에 쌓지 않는다. 끈 값이나 이력을 손으로 지우지 않는다. 운영 KB_HOME에서 `--apply`는 `KB_LIVE=1`이 있어야 한다. 에이전트가 사용자 지시를 전해 받아 지운 과거 기록은 `kb llm correct-reenable-record --apply`로 고친다(`llm:human_reenable`만 고친다).
4. 0.70 이상이면 일일 창 수 공식대로 잇는다.

## 수동 kb jobs run 절차

`kb jobs run --dry-run`으로 만기 작업을 본다 → `kb jobs run`. L2는 `extract.l2`(1시간 간격)가 `kb agent run --scope public`을 부른다. 결정 3 뒤에는 `kb-agent.timer`가 같은 일을 한다. 위 첫 100창 점검이 통과한 뒤에만 쓴다.

## 결과 (2026-11-01, 재시도 반영)

### 결정과 조건

- `decisions.toml` approved = [1, 2, 3, 7, 8, 9, 10, 11]. 결정 8, 9, 10, 11 모두 승인.
- Claude 7일 활용률 0.88(`status=allowed_warning`, `resetsAt` 1793869200, 2026-11-04경). 0.70 이상이라 `kb-first-collect`(5단계)를 건너뛰고 대기로 표시했다. 6, 7단계도 대기다. 고정 심판 80건도 `claude -p`라 대기다.
- L2는 OpenRouter만 썼다(`KB_CLAUDE_BIN` 비움). Claude 호출은 활용률 조회 1회($0.00059)뿐이다. `kb-agent.timer` 켜지 않음. `kb-tick.timer`는 이미 켜져 있다.

### 1~3단계

- 0단계: 배포 `f3941db59e10`, 설치본과 `src/kb` 차이 0건, 투영 지문 일치(재빌드 불필요), `kb schema sync` 1회 쓰기 1건(`schema.type_defined`) 뒤 0건, `kb sources sync` 변경 0건. `kb verify all` 통과(이벤트 16,071, CAS 참조 3,251, 누락 0).
- 재시도 tick 1회: `.sources=57`, `.pages_fetched=40`, `.pages_queued=40`, `.pages_capped=246`, `.parsed=41`, `.failed_sources=0`, `.robots_denied=0`, 모든 단계 ok.
- `kb live run`(`--limit 100`, `--limit 150`): 대상 250, 확인 80, 판정 기록 63(alive 62, renamed 1), 거부 17, 미도달 170. 미도달 사유: `no_source` 165, `budget_exceeded` 4, `no_probe` 1. 거부 17건: `E_NO_EVIDENCE` 12(GraphQL 경로의 저장소, 스냅샷 없음), `E_LIVENESS_SOURCE` 5(1차 출처 아님). 기본 검색에서 사라진 건수 0.
- 미도달 `no_source`는 피드 항목 문서다(status.openai.com, lmstudio.ai, news.hada.io, ollama.com 등 약 470건). 레지스트리가 그 URL을 소유하지 않아 생존 판정이 닿지 않는다.
- 누적: 스냅샷 1,539, 엔티티 1,350, 노드 7,035, 엣지 3,158.

### 도메인별 건수 (`by_domain`, 다중 집계)

| 도메인 | sources_active | sources_failed | snapshots | claims_active |
|---|---:|---:|---:|---:|
| A | 1 | 0 | 9 | 62 |
| B | 8 | 1 | 40 | 66 |
| C | 7 | 0 | 141 | 84 |
| D | 3 | 0 | 127 | 20 |
| E | 4 | 0 | 127 | 37 |
| F | 6 | 1 | 114 | 55 |
| G | 46 | 2 | 1,185 | 344 |

전체 `claims_active` 541, `claims_review` 442. 도메인 A는 키워드 데이터가 없다(kworb 순위 표만). 결정 11 뒤 인수 조건(`claims_active >= 1000`, G >= 500, B~F >= 20)은 미달이다.

### L2

- 누적 41창(`llm:day`), 저장된 주장 100건: accepted 37, needs_review 63, rejected 15, failed 1(`truncated`). 게이트 통과율 37/115 = 0.32. 0.70 미만이다. 첫 100창에 못 미쳐 멈췄다.
- 모델별: Sol 20창, 통과 23/69 = 0.33, $0.233156. OpenRouter Haiku 20창, 통과 15/54 = 0.28, $0.022528. 두 모델 모두 20창째에 `gate_pass_drop`으로 꺼졌다(`human=true`). 그래서 첫 실행이 40창에서 끝났다. 이번 재시도의 `kb agent run --max-windows 60`은 `all_blocked`로 0창, $0다. ADR-0003 5장대로 사람이 켜기 전에는 돌지 않는다. 끈 값을 지우지 않았다.
- 보류 62건을 게이트로 재생한 결과(읽기 전용): `R_SUBJECT_CONTEXT` 47건, `R_VALUE_MISMATCH` 25건(대부분 `neg`), `R_LIVENESS_UNKNOWN` 2건(겹침 있음).
- `R_SUBJECT_CONTEXT` 47건 중 34건은 소스 이름이나 발행처를 문맥에 넣으면 풀린다. 문서 제목이 `Changelog`라 `Claude Code`가 문맥에 없다. 평가 하니스(`harness/scripts/gate.py`)는 발행처를 문맥에 넣지만 운영 `kb.gate`는 넣지 않는다. 기준선 0.823과 운영 값이 같은 게이트가 아니다. 이 34건만 풀려도 상한 71/115 = 0.62다. [추론]
- 비용: 오늘 합계 $0.258161(Sol 창당 약 $0.0117, Haiku 창당 약 $0.0011). OpenRouter 잔액 $144.9454. `spend_7d_avg_usd` 0.0369, `projected_underspend_usd`(예상 미소진액) 143.8648, `key_days_left`(키 만료까지) 29.3일. 일일 밸브 $30 도달 없음.
- 큐 잔량: L2 문단 341,425(`queue_l2`), 페이지 892, 생존 1,481, support_check 62. 예상 일수: Sol 단가 $0.0117, 창 약 4문단 가정 시 L2 큐는 약 85,400창이고 소진에 약 $1,000가 필요하다. 잔액으로는 약 12,400창(약 15%)이다. 2026-11-19까지 18일이면 일 약 690창, 일 $8 안팎으로 밸브 안이다. 통과율 문제가 풀린 뒤의 값이다. [추론]

### 소스별 본문 문자 수

문자 수가 아니라 수집한 원본 바이트(스냅샷 `bytes` 합)로 근사한다. 상위(바이트, 스냅샷 수): google-ads-help 120.5M(70), yt-how-recommendations 115.4M(71), claude-api-release-notes 90.3M(70), yt-ypp-help 89.6M(55), claude-com-sitemap 81.0M(151), claude-model-deprecations 39.0M(69), claude-support-release-notes 24.9M(69), cc-docs-en 16.1M(231), cc-docs-ko 11.7M(229), yt-api-docs 6.1M(56), codex-docs 5.3M(194). 재시도 tick과 `kb-tick.timer`를 합쳐 단일 URL 소스마다 스냅샷이 1~4개 늘었다(앞 실행의 51~69개는 결함 수정 전 값이고 원장에 남는다).

### 타입별 count

Document 2,410, Snapshot 1,539, Claim 1,186, Tool 744, Series 282, Model 250, Feature 202, Source 116, Learning 80, Video 76, Artifact 38, Repo 36, Ticket 23, Package 17, Product 15, Concept 7, note 6, decision 4, Platform 1, Person 1, Decision 1, Channel 1. 생존 값이 붙은 노드: active 86, renamed 1.

### 결정 대기로 꺼진 소스

결정 대기로 꺼진 소스는 없다(8, 9 승인으로 배치에 포함). 비활성(약관, 키·계정 필요) 소스는 배치 밖이다. `src:opensurvey-trend`는 403, 서킷 열림이라 뺐다.

### 인수 조건

- tick JSON 조건, `counts.entities >= 300`, `counts.snapshots >= 200`, 열린 사고 0, B~F 스냅샷 >= 3: 통과.
- `kb verify all --json`: 통과.
- `kb api /v1/schema`, `/v1/snapshots/<첫 스냅샷>`의 `.data.source.trust`("primary"): 통과.
- `kb search`: `Claude Code 훅` 50건, `쇼츠 수익` 50건, `OpenRouter` 45건. `쇼츠 수익` 상위는 관련성이 낮다(세션 기록, 일반 문단이 섞인다).
- 결정 11 뒤 `claims_active` 조건: 실패(위).
- 표본 감사 불일치 목록: 5단계가 대기라 없음(`kb-verifier` 미실행).
- `kb api '/v1/overview?limit=10000&edge_limit=50000'`: `truncated=false`, `total=1630`. WP-03 조정 요청 없음.

## 알려진 결함

1. 게이트 통과율 미달과 모델 정지. 아래 "재개 결과 3". Sol, OpenRouter Haiku 둘 다 `human=true`로 꺼져 있다. 새 게이트 기준 Sol 0.659는 문턱 0.70 미만이다(CI가 0.70을 포함). 재개에는 사용자의 해제 결정이 필요하다. 이전 `llm:off` 해제는 사용자 결정이 아니었고 정정했다.
2. `ops/bin/deploy`의 옛 휠 문제는 `--reinstall-package sagae-kb`로 고쳐졌다. 위 "배포 확인"의 diff는 그대로 돈다(2026-11-01 출력 0줄).
3. `kb live run`의 GraphQL 저장소 신호는 스냅샷이 없어 `E_NO_EVIDENCE`로 거부된다(`src/kb/commands/live.py`가 `repos/x/y`로 소유 소스를 찾지만 소유 소스가 없다). 근거 없음 12건이 사람 대기열에 들어갔다.
4. 피드 항목 문서 약 470건은 레지스트리 소유가 아니라 생존 판정이 닿지 않는다.
5. `low_yield` 잔여: 빈 창과 유효 창이 번갈아 나오면 빈 비율이 문턱 0.6에 닿지 않아 작동하지 않는다. 일일 밸브 상한이 한도다.
6. 통과율 측정 표본은 11개 스냅샷뿐이고, 큐의 91.2%는 측정 자료가 없는 층이다.
7. `llm:off` 해제 승인은 사용자 본인 입력으로 확인되지 않았다. `kb llm correct-reenable-record`로 기록을 정정한다.
9. 열린 결함, `slugify`의 한글 충돌: `kb.parse.model.slugify`가 한글을 지워 'YouTube 홈페이지', 'YouTube 주제별 페이지'가 모두 `e:feature:youtube`가 된다. 읽기 전용 사본(원장 23724건까지) 측정: 한글이 든 라벨의 엔티티 중 id에 해시가 없는 것 489개(전체 3,480개 중). L2 `__new__` 항목 259건 중 한글 라벨이 이미 있던 다른 라벨의 id로 떨어진 것 10건, id 6개(`e:feature:youtube`, `e:feature:youtube-shorts`, `e:concept:ott`, `e:concept:awareness-and-consideration` 등). 첫 29창에서는 7건이 이 때문에 `R_SUBJECT_CONTEXT`로 막혔고 수락된 충돌은 없었다. 고치지 않았다(기존 id가 바뀐다).
10. 2026-11-01 수정: L2 변환이 허용 목록(값 `25년`/`25년도` + 인용구 `(25년)`/`25년도` + 스냅샷 연도 이하)만 연도로 바꾼다(`normalized_fields`). 나머지 시각 값은 그대로 `E_SCHEMA`다. 값 검사는 문장 중간의 `No. 2`를 부정으로 보지 않는다. `kb agent run --json`에 `codes`(사유별 건수, 코드가 둘인 항목은 각 코드에 센다)가 있다. 재생: 첫 29창 Sol 48/73 = 0.658 → 56/73 = 0.767, 앞의 80창(보류 표본) Sol 0.665 → 0.713, Haiku 0.761 변화 없음.
8. 시험 순서 의존: `tests/first_batch/test_dead_seed.py` 12건이 전체 실행에서만 실패한다(`KB_HOME=<임시 경로> ops/bin/dev pytest -q`, HEAD d2c26fa에서도 같은 12건 실패, 2026-11-01 측정). 단독 실행과 `tests/first_batch` 디렉터리 실행은 skip 또는 통과한다. 앞선 시험이 임시 KB_HOME에 부분 gold를 만들어 skip 조건이 풀리는 것으로 추정한다(미확인). 시험은 수정하지 않았다.
9. 임시 Concept의 한글 고유명 별칭 34건은 계속 제외된다. 표본 'Asad Ikram·Ella Haig의 플랫폼 측정 연구'가 수락됐다. 심각도 낮음.
10. `put_record`에 세션 `l2`를 주면 임시 Concept을 만들 수 있다. 운영자 설정이 있어야 한다. 심각도 낮음.
11. 추출 사전 카나리아에 백오프가 없다. 실행당 최대 1회이고 상한 $0.02다.
12. 결정 11이 승인되면 기본 전체 시험에 `tests/mcp/test_claude_real.py`가 들어가 실제 `claude -p`를 부른다. 전체 시험을 돌리기 전에 제외해야 한다.
13. 문서 내부 통과율 하락 약 -15점은 원인 미상이다.
14. `src/kb/extract/sensitive.py:200,202`: 두 문장이 인용구 하나를 공유하면 `IdemConflict`에 닿을 수 있고 :99에서 잡지 않아 실행이 죽는다. 지금까지 0건. 심각도 중간.
15. `values.py`의 `_DATE`, `_APOS_YY` 억지 사례(낮음): '2개까지'와 'through 2 3 step guides', '2024년 5%다'와 "경력 '24년 5%".

## 해결한 결함 (2026-11-01 재시도)

- `kb verify all`의 CAS 누락: `window_sha`는 CAS 참조가 아니다. 창 본문은 스냅샷 문단에서 다시 만들고, 창을 CAS에 넣으면 ttl 본문이 영구 객체로 남는다. `verify.py`의 `CAS_KEYS`에서 뺐다. 기존 이벤트 백필은 필요 없다.
- `--batch --until-idle`의 반복 강제 재요청: force를 `run_tick`당 1회로 제한했다(`tick_stage.py`).
- `kb live run` 요약에 `unreachable_reasons`를 넣었다. `budget_exceeded`, `circuit_open`은 1시간 안에 다시 본다. 304와 재사용 응답은 살아 있음으로 본다(앞 실행까지는 미도달로 빠졌다).

## 재개 결과 (2026-11-01, 게이트 수정 뒤)

- 배포 24b0966934cb, 소스와 diff 없음(`uv sync --reinstall-package` 우회), `kb rebuild gold`, `schema sync`, `sources sync`, `verify all` ok.
- 사람 해제(정정: 사용자의 결정이 아니다. 워크플로우 지시로 전달된 승인을 근거로 에이전트가 지웠고 사용자 본인의 해제로 확인되지 않았다. 기록은 2026-11-01 "재개 결과 3"에서 `by=agent`, `approval=relayed_unverified`로 정정했다. 이 절의 0.908도 미확인이다): Sol과 OpenRouter Haiku의 `llm:off`를 지웠다. 옛 게이트 기준 `llm:gatepass` 이력도 지웠다(남기면 첫 창에서 재정지). `tick_state llm:human_reenable`과 incidents.ndjson에 기록.
- 해제 뒤 31창: 저장 주장 99, rejected 32, needs_review 30, 비용 $0.312(창당 약 $0.0104). 최근 20창 통과율 Sol 49/101=0.485(다시 `gate_pass_drop`, human), Haiku 20/29=0.69. 0.70 미만이라 L2를 멈췄다. 고정 심판 80건은 이 패키지가 돌리지 않았다. Claude 경로는 `seven_day`로 꺼져 있다.
- 누적 상태: 스냅샷 1,693, claims_active 1,056, claims_review 540, 엔티티 1,907, 큐 L2 189,681. 도메인별 claims_active A 535, B 125, C 85, D 427, E 37, F 75, G 346. 잔액 $144.63, 예상 미소진액 $142.24, 키 만료까지 29.2일. 열린 사고 0.
- `kb-first-collect`, 6단계의 에이전트 주어 판정, 표본 감사 50건은 통과율 정지로 돌리지 않았다.

## 재개 결과 2 (2026-11-01 14:53 KST)

### 조건

- 배포 24b0966934cb(소스 변경 없음, 재배포 무변경), 설치본과 `src/kb` diff 0줄. 지문 일치라 `kb rebuild gold` 불필요. `schema sync` 0건, `sources sync` 변경 0건.
- `llm:off`를 지우지 않았다. ADR-0003 5장은 "회고 확인 뒤 사람이 켠다"이고 전달된 승인은 사용자 본인의 입력으로 확인되지 않았다.
- `kb-agent.timer` 켜지 않음. 일일 밸브 $30 유지(도달 없음).
- Claude 7일 활용률 0.91, 5시간 값 없음. 리드 지시로 이 런북의 0.70 사전 문턱을 넘겨 5~7단계를 돌렸다. ADR 20.2의 문턱은 5시간 값이라 값이 없으면 판정되지 않는다. 고정 심판 80건은 지시 범위 밖이라 대기다.

### L2 (OpenRouter)

- OpenRouter Haiku 10창: 저장 31, needs_review 7, rejected 7, 통과 24/38 = 0.63, $0.013204. 70창을 요청했으나 10창째에 Haiku도 `gate_pass_drop`(human)으로 꺼졌다. 최근 20창 44/70 = 0.629, 문턱 0.633(0.745 × 0.85).
- 배포 게이트 기준 누적 40창(Sol 20, Haiku 20): 통과 90/157 = 0.573. 0.70 미만이고 100창에 못 미쳐 멈췄다.
- 재생 0.908은 재현되지 않았다(미확인, "재개 결과 3" 참고). 운영값과의 차이 중 확인된 것: 앞 30창의 `E_QUOTE_AMBIGUOUS` 거부 23건(문서 안 두 곳 일치. 모델이 prefix, suffix를 안 낸다), needs_review 30건.
- 비용: 오늘 합계 약 $0.586. 창당 Sol $0.01335, Haiku $0.00118. 잔액 $144.615, 예상 미소진액 $142.16, 키 만료까지 29.2일.

### kb-first-collect

- 표본 2회(시드 21, 22, 도메인 G) 수락 0건, 원장 쓰기 없음, 합계 $1.91(추정). `kb-collector`(Haiku)가 `kb_ingest_validate`를 43~49회 반복하다 턴을 소진하고 StructuredOutput을 내지 못했다. 두 번째는 시드에 묶음 형식을 넣었다. `.claude/agents/kb-collector.md`에 형식 설명이 없다.
- 같은 원인 2회이고 활용률이 높아 3회째를 돌리지 않았다. 죽은 데이터 사례는 적재되지 않았다.

### 생존 판정 재실행

`kb live run --limit 60`: 확인 60, 변경 60. `--limit 150`은 280초 안에 끝나지 않아 끊었다.

### 표본 감사

시드 21, 활성 LLM 주장 125건 중 50건. 기계 대조 `text[start:end] == exact` 불일치 0건. `kb-verifier`(Haiku)가 인용과 앞뒤 300자를 대조했다(도구 없음, $0.0089). 검사 50건, 불일치 2건:

- `c-frnbaarlxevd`: Snapshot says the plugin system is 'not yet available (planned for v5.0)', but the statement's present-tense '현재는 사용할 수 없다' is not supported as of 2026-11-01. The snapshot is undated, so the claim needs a date anchor or a check against the current release.
- `c-susy6ssifnlq`: Quote says the show is on October 18 (2026), but today is 2026-11-01, so '예정되어 있다' (is scheduled) is stale. It should be stated as a past event with its date (kind=event).

### 수치

- 큐 잔량: L2 문단 200,932, 페이지 436, 생존 1,523, support_check 98. 예상 일수: 통과율 문제와 사용자 해제 전에는 산정 불가. [추론] 창당 4문단이면 약 50,000창이고, 일 690창이면 73일이다.
- tick: sources 58, failed 0, robots_denied 0, parsed 178, 전 단계 ok.
- 스냅샷 1,868, 엔티티 1,924, 노드 8,817, 엣지 3,995, claims_active 863, claims_review 765.
- 도메인별 claims_active(snapshots): A 541(60), B 124(44), C 85(149), D 427(181), E 37(134), F 90(124), G 131(1,415). 도메인 A의 값은 자동완성과 Trends 주장이다.
- `claims_active`가 1,056에서 863으로 줄었다. 배치 tick이 G 주어의 결정적 주장을 새 버전으로 다시 내고 `gate_l1`이 생존 미판정으로 218건을 보류했다. 값은 삭제되지 않고 `needs_review`에 있다.
- 원인 분석(2026-11-01, 원장 사본 읽기 전용): 결함이 아니라 9단계 정책의 뒤늦은 적용이다. seq 20646 전에는 재보류 키가 첫 보류 키와 같아 중복 제거되어, 재파싱으로 `parser_derived`가 된 주장이 생존 미상 주어에도 활성으로 남았다(예: `c-hc7wrf6vc7ri` assert 5회, 보류 2회, 보류 seq 3768과 20646). `_hold_key`의 seq 접미(seq 20646부터, 접미 보류 325건)가 이를 막아 218건이 한꺼번에 묶였다. gate_l1 보류 1,240건은 주장 915건이고 그중 현재 활성 `needs_review` 689건이다. 이 689건의 주어 620개에 생존 판정(`survival.verdict`)이 하나도 없고 gold `liveness`도 비어 있다(Document 340, Feature 193, Repo 138, Package 18). 잘못 묶인 주장은 0건이다. 접미 보류도 기본 키 이력으로 `kb.live.effects.release_held`가 풀고(`test_claim_reheld_over_ticks_...`), 판정 한 번이면 3틱 재보류분도 풀린다.
- 복구는 생존 미상 주어를 판정하는 것뿐이다. Document 340건은 피드 항목(status.openai.com 102, lmstudio.ai 65, ollama.com 63, news.hada.io 63 등)이라 레지스트리가 소유하지 않아 `no_source`로 닿지 않는다(결함 4). 이 주어를 G 단위에서 뺄지는 ADR 결정이고 이 작업의 범위 밖이다.
- 타입별 count: Document 2,531, Claim 1,886, Snapshot 1,875, Tool 751, Keyword 474, Series 322, Model 250, Feature 206, Source 122, Learning 97, Video 84, Repo 76, Product 40, Artifact 38, Ticket 24, Package 18, Concept 12, Metric 10, note 6, decision 5, Platform 1, Person 1, Decision 1, Channel 1.
- 소스별 본문 문자 수: 앞 결과 절의 값 이후 다시 재지 않았다.
- `kb api '/v1/overview?limit=10000&edge_limit=50000'`: `truncated=false`, 노드 1,729, 엣지 684. WP-03 조정 요청 없음.

## 재개 결과 3 (2026-11-01)

근거: 원장 사본 읽기 전용 재측정(`extract.run` 80건, 11개 스냅샷)과 R1 검토. 모델 호출 없음.

- 새 게이트(`window=_seen_spans`) 통과율: Sol 0.659 [0.504, 0.801], Haiku 0.761 [0.655, 0.851], 합산 0.701. 스냅샷 군집 합산 구간 [0.541, 0.858]. 80창이 11개 스냅샷에서 나와 이 구간이 정직한 값이다.
- 옛 게이트 재생 보정 오차는 1점 미만이다. 재생 0.908은 재현되지 않았다(미확인). 가장 가까운 값은 0.822이고, 재생을 실제 운영 상태로 되돌리면 0.451로 내려간다.
- 측정 자료가 없는 층이 큐 항목의 91.2%다. `--scope public`의 "A-F 우선"은 약 11.3k 항목이고 그중 95%가 pypi-meta(패키지 메타데이터 JSON)다.
- G 활성 주장 346에서 131로 준 것은 seq 20646의 1회성 정정이다. 346이 부풀려진 값이었다. 보류 692건 중 잘못 보류된 것은 0건이다.
- 이벤트 주장 보류 제외: 사용자가 2026-11-01에 "event는 보류 제외"로 결정했다. 9단계(`gate_l1`, 인용 게이트)가 `kind=event`를 보류하지 않는다. `state`, `howto`(Repo, Feature, Package 349건 등)는 계속 보류한다.
- 이미 보류된 event 주장 복구: `kb live release-events`는 개수만 센다. `--apply`가 쓴다(운영 KB_HOME은 `KB_LIVE=1` 필요). 대상은 kind=event이고 현재 needs_review이며 마지막 verification 이벤트가 `gate_l1`의 `R_LIVENESS_UNKNOWN` 보류인 주장뿐이다. 그 뒤에 의존 대상 사망 suspect나 별칭 불일치 같은 다른 검토가 있으면 건드리지 않는다. 키는 `live:release-event:<주장>:<보류 seq>`라 다시 보류된 뒤 두 번째 복구도 실제로 쓴다.
- `low_yield` 잔여: 빈 창과 유효 창이 번갈아 나오면 작동하지 않는다. 일일 밸브가 상한이다.
- 이전 "재개 결과"의 `llm:off` 해제는 사용자 결정이 아니었다. 기록을 `by=agent`, `approval=relayed_unverified`로 정정한다.
- Sol 재개: 사용자의 직접 승인으로 `kb llm reenable`을 돌렸다. 첫 실행은 29창에서 `gate_pass_drop`으로 멈췄다. 수락 48, needs_review 16, rejected 9, 통과 48/73 = 0.658, 비용 $0.2636, 잔액 $144.35.
- 0.70 미만이라 일일 밸브는 $30으로 두었고 `kb-agent.timer`는 켜지 않았다. 고정 심판은 Claude 7일 활용률이 풀릴 때까지 대기한다. rejected 항목의 코드는 저장되지 않는다.
- Sol 29창 비수락 25건 분석: 데이터 문제 12, 모델 오류 7, 게이트 오탐(false negative) 6.
- 수정: 숫자나 `%` 뒤의 `(25년)`과 `25년도`를 2025로 본다. 그 밖은 바뀌지 않는다. 재생 결과 Sol은 29창에서 56/73 = 0.767, 보류 표본(holdout)에서 119/167 = 0.713이고 Haiku는 변함없다.
- 열린 결함: `slugify`가 한글을 지운다. 한글 라벨 엔티티 3,480건 중 489건의 id에 해시가 없다. L2 `__new__` 항목 259건 중 10건이 충돌했다.
- Sol 실행 2: 82창에서 멈췄다. 수락 134, needs_review 36, rejected 1, 통과 134/171 = 0.784, 최근 20창 44/64 = 0.688, 비용 $0.7308, 잔액 $143.62. 이 값으로 Sol 기준선을 0.784, 문턱을 0.666, 일일 밸브를 $60으로 바꿨다(사용자 결정, ADR-0002).

## Sol 정지 원인 정리 (2026-11-01)

- 원인 분석: 세 번의 `gate_pass_drop`은 사실 품질 하락이 아니었다. 보류 83건 중 거짓 주장으로 읽히는 것은 0건이다. 원인은 20창 판정의 잡음, L2가 스스로 등록한 별칭이 이후 문장을 막는 게이트 결함, 문서별 문제다.
- 변경 1, 별칭: `known`에서 L2가 등록한 `Concept`의 한글 별칭만 뺀다(`provisional` 참, `author=agent:l2`, 별칭에 한글). 라틴 문자 별칭과 다른 타입은 그대로 막는다. `producer=agent:l2` 묶음은 MCP와 `kb ingest`에서 `E_POLICY`로 거부되고, `entity` 항목의 `props.provisional`은 버려진다. 다른 주체가 같은 ID에 쓰면 확정이다. 재생: 수락 236에서 247/319, 런 A 56/73(+0), 런 B 140/171(마지막 20창 0.688에서 0.750), 런 C 51/75 = 0.680. 새로 수락된 11건은 모두 읽어 거짓이 없다(문장 하나는 'will be held' 시제 흠: RecSys '26 문장).
- 변경 2, 창: `switch.gate_window` 20에서 50. 오탐 정지(참 0.784, 연속 100회 평가) 0.70~0.75에서 0.04~0.17, 탐지 지연(통과율 반감, 비어 있지 않은 창) 중앙 6에서 10(p90 10에서 18). 순서대로 135창은 50창 0회 정지, 최저 0.725, 마지막 124/168 = 0.738. 문턱 0.666, 비율 0.85, 기준선 0.784는 그대로다. 근거는 ADR-0003 5장.
- 변경 3, 에이전트 작업: `kb jobs run`이 `agents.fulfill`, `agents.liveness_review`, `metrics.retro`를 작업마다 부르기 직전에 검사한다. `llm:stop`, HALT, 자동 복귀 없는 `llm:off:claude`, 7일 ≥ 0.80, 5시간 > 0.5, 초과 과금, 7일 값 없음이면 건너뛰고 출력의 `skipped`에 `claude_<사유>`를 남긴다(실패 아님, 다음 회차 재시도). `claude_hold_<사유>`는 사람이 정지를 풀어야 끝난다. 검사 비용은 저장값이 신선하면 0, 아니면 카나리아 1회(haiku, 상한 $0.02, 실측 $0.00059). 카나리아가 실패하면 1시간부터 두 배씩 최대 하루 물러난다(`claude_canary_backoff`). 손으로 부르는 `kb-first-collect`, `kb-agent-run`, `kb retro`는 이 검사 밖이라 위 "Claude 활용률 조건"대로 사람이 먼저 읽는다.
- 재개 전 확인: `kb jobs run --dry-run`은 검사를 하지 않는다. 건너뜀 기록은 `kb jobs run` 출력과 `agentjob.skipped` 지표에서 본다. `KB_CLAUDE_BIN`이 가리키는 파일이 없으면 검사가 `claude_preflight_no_bin`으로 닫아 작업이 계속 건너뛰어진다(배포 때 박힌 경로가 Claude 업데이트로 사라졌는지 본다).
- 아직 안 한 것: 배포, 타이머, 기준선, 문턱, `slugify` 충돌. Sol 재개는 `kb llm reenable`(사용자 직접 승인)으로만 한다.
- 실행 C: 24창, 통과 46/75 = 0.613, $0.258.
- 에이전트 작업이 Claude 7일 활용률 0.95에서 `claude -p`를 불렀다(정가 기준 지출 $0.536).
- 검토자의 전체 시험이 실제 `claude -p`를 1회 불렀다(상한 $0.03, 실제 지출은 측정 못 함).
- 작업 게이트가 나오기 전까지 리드가 `kb-agent.timer`를 껐다.
- 재작업 반영: 별칭 규칙을 좁혔고 `switch.gate_window`를 50으로 올렸으며 에이전트 작업에 활용률 게이트를 달았다.
- 실행 D: 22:00 KST, 빌드 5f449032cea4, 62창, 비용 $0.565, `gate_window` 50. 통과 88/146 = 0.603으로 문턱 0.666 미만이라 Sol이 꺼졌다. `kb-agent.timer`는 리드가 꺼 둔 상태다.
- 같은 게이트 기준 도메인별 통과율: A 0.767, B 0.819, C 0.680, D 0.603. 혼합 효과는 -0.2점이고 소스 내부 잔차가 -19.9점이다. 실행과 라운드가 겹쳐(공선) 하락의 원인은 열려 있다.
- 비수락 58건: 모델 오류 31, 게이트 오탐 17, 데이터 10. 146건 기준 원인별 점수: 조어한 주어 라벨 16.4, 값/부정 정규식 8.2, kisdi-stat 프롬프트 머리글 인용 4.1, 별칭 3.4. 값/부정 수정을 재생하면 0.685이고 아직 구현하지 않았다. 한 검토자가 거짓으로 읽은 주장은 없었다.

## 실행 D 대응: 정규식과 extract-2 (2026-11-01, 미배포)

- 값/부정 정규식(`gate@3`): 실행 A~D의 `R_VALUE_MISMATCH` 28건 중 16건이 풀린다. 검토에서 극성 뒤집힘이 통과해(`피해 보상`, `not to approve`) 규칙을 좁히고 `to not`과 주어 이름 규칙을 없앴다. 재생(사본, LLM 없음): A 56/73 = 0.767(변화 없음), B 140에서 144/171 = 0.842, C 51에서 53/75 = 0.707, D 88에서 98/146 = 0.671, 전체 335에서 351/465 = 0.755. 수락에서 떨어진 항목은 0건이다. 연속 재생의 최근 50창 최저는 0.656으로 문턱 0.666 아래가 106번 평가 중 1번이다. 게이트 역할을 통과율보다 앞세운 리드 결정이고 수치를 맞추려고 넓히지 않는다.
- `extract-2`: 머리글을 `<source_info>`로 분리하고 주어 표기와 인용 규칙을 넣었다. `extract_schema`는 그대로다. 프롬프트 효과는 재생할 수 없다. 다음 실행으로만 잰다. 측정값이 없다.
- 판본 올림의 영향(실행 D 시점 사본, 원장 head 25218): `done_carry` 없이 올리면 완료 표시 584문단이 무효가 되고 커서가 0으로 돌아가 큐 재훑기가 15분 tick 51회 걸린다. 이 동안 새 스냅샷의 적재가 밀린다. 265,926행이 다시 큐에 들어가고 그중 265,297행은 대체된 스냅샷이라 다음 꺼내기에서 지워진다. 살아 남는 629행(A~F 599, G 30)이 약 300창, 창당 $0.0091이면 약 $2.7, ADR의 $0.0323이면 약 $9.7을 쓴다. 다음 100창 중 18창이 재실행이 되고 96창의 순서가 바뀐다. 옛 주장 630건은 철회되지 않으므로 주어나 인용구가 달라진 것은 새 주장과 공존한다. 그래서 `done_carry: ["extract-1:extract-schema-1"]`을 넣었다. 이 설정으로는 재투입 0행, 재호출 0창, 추가 비용 $0, 다음 100창 순서 그대로이고, 남은 242,103행은 원래대로 `extract-2`로 추출된다. 완료 표시는 지우지 않는다.
- 옛 문단을 새 프롬프트로 다시 보려면 `kb agent run --reextract --snapshot <id>`를 쓴다. 이 명령은 대상 문단의 옛 판본 완료 표시도 지운다. 이때만 재추출에 없는 옛 주장이 철회된다. 같은 주어와 인용구는 `claim_id_llm`이 같아 새 주장이 생기지 않고 옛 `extractor`로 남는다.
- `gate@3`: 판본 값은 새 `claim.assert`의 `evidence.gate_version`에만 들어간다. 원장 사본(25,218 이벤트)을 `gate@2`, `gate@3`으로 각각 재구축한 지문이 같다(`afc9698545c6...`). 완료 키, 원응답 키, 큐 행도 그대로다. 같은 주어와 인용구를 다시 내면 `existing`이고 이벤트가 없어 멱등 충돌이 없으며 옛 증거는 `gate@2`로 남는다. 예외는 민감 경로의 `l2s:claim:<id>`로, 기존 ID 검사 없이 판본이 든 페이로드를 쓰므로 같은 주장을 다시 쓰면 `IdemConflict`다. 사본의 `l2s:claim` 이벤트와 `l2s` 큐는 0건이라 지금은 닿지 않는다.
- 시작 전에 볼 것: 실행 D 이전 `llm:gatepass` 이력은 `extract-1` 값이다. 재개 뒤 50창은 두 판본이 섞일 수 있다. 판본별 통과율은 `extract.run.prompt_version`으로 가른다.
- 사용자가 프롬프트와 정규식 수정을 골랐다. 재생 결과: A 56/73, B 144/171, C 53/75, D 98/146 = 0.671, 롤링 50창 최저 0.656. 프롬프트 효과는 측정하지 않았다.
- `done_carry`는 옛 문단을 완료로 유지한다. 따라서 살아 있는 약 242,103행이 재추출 없이 `extract-2` 아래에서 추출된다.
- 실행 E: `extract-2`, `gate@3`, 빌드 a602514ecab3, 100창, 정지 없음. 수락 183, needs_review 14, rejected 2, 통과 183/199 = 0.920, 비용 $0.7947. 수락 40건 표본 감사(시드 7, 검토자 1명): 근거 확인 31, 사소함 5, 과장 3, 주어 오류 1, 거짓 0. 마지막 50창 중 빈 창 24.
- 소진 시작: 2026-11-01 23:20 KST에 리드가 사용자 직접 답변으로 `kb-agent.timer`를 켰다. `install-units.sh`가 아니라 그 타이머 하나만 심볼릭 링크로 설치했다. 첫 실행 26분, 마지막 50창 112/134 = 0.836, 빈 창 22/50, 당일 합계 598창과 $4.86, 잔액 $140.34, 활성 주장 1,970, 정지 없음, Sol 켜짐.
- 아직 실제로 보지 못한 것: 활용률 0.80 초과 시 Claude 작업 건너뜀. 해당 작업이 `not_due`였다.

## L2 적재 정책 `l2: none|declared|prose|all` (ADR-0004 D1, 2026-11-04, 미배포)

- 소스 항목의 `l2` 필드가 새 문단을 L2 큐(`kind=l2`)에 넣을지 정한다. 기본은 `all`이다. 해석 순서: 소스 `l2` > 파서 기본값(`src/kb/extract/policy.py`의 `PARSER_L2`) > `all`. 틀린 값과 등록되지 않은 소스는 `all`이다.
  - `none`: 넣지 않는다. 산문이 없는 구조 자료 파서(`github_repo_meta`, `hf_models`, `mcp_registry`, `kworb`, `trends_rss`, `codex_features`)와 번역본(`src:cc-docs-ko`, `translation_of: src:cc-docs-en`)이다.
  - `declared`: 파서가 선언한 산문 구간(어댑터의 `prose`)과 겹치는 문단만 넣는다. `pypi_meta`는 `/info/description`(README), `npm_meta`는 packument `/readme`, `hn_algolia`는 `/hits/*/story_text`, `csv`는 소스 `parse.prose`의 열(`src:awesome-claude-code`는 `Description`)이다.
    - 구간은 저장하지 않고 표시 본문에서 그때그때 계산한다. 문단 색인(`paras_sha`), `para_sha`, done 키는 바뀌지 않는다.
    - 구간을 계산하지 못한 스냅샷(판정 불가)은 넣지 않고 보류 표식으로 남긴다. sweep 결과의 `undecided`로 센다.
    - CSV는 빈 줄이 없어 문단 하나가 여러 행에 걸친다. `awesome-claude-code`는 문단 347개가 모두 설명 칸과 겹쳐 사실상 `all`이다.
  - `prose`: JSON, 키-값 줄, 글자가 거의 없는 문단은 빼고 산문만 넣는다(휴리스틱). 보기 좋게 찍은 JSON을 산문으로 볼 수 있어 JSON 소스에는 쓰지 않는다. 현재 쓰는 소스는 없다.
  - 수집(L0)과 파싱(L1)은 정책과 무관하게 계속한다.
- `src:g4-npm-registry`는 `raw_file@1`에서 `npm_meta@1`로 바꿨다. 전체 packument, 축약 메타, 버전 문서를 모두 읽어 `latest_version`, `license`, `maintained_status`(deprecated)를 jsonpointer 근거로 낸다.
  - Accept 제약: 축약 메타(`Accept: application/vnd.npm.install-v1+json`)는 응답 content-type도 그 값이다. 소스의 `expect.content_type`이 `application/json`뿐이라 Accept만 바꾸면 수집 기대 검사가 실패한다. 바꿀 때는 `expect.content_type`에 그 값을 더한다. 축약 메타에는 `readme`와 `license`가 없다. 지금은 `Accept: */*`로 전체 packument를 받는다.
- 기존 행과 되돌리기: tick 5단계가 정책 표가 바뀐 첫 tick에 큐를 정책에 맞춘다(`policy.sweep_if_changed`). 행과 원장은 지우지 않는다.
  - 정책이 거르는 `queued`, `taken` 행은 `state='skipped_policy'`가 된다.
  - 정책이 받는 `skipped_policy` 행은 `queued`로 돌아온다(`restored`). 정책을 `all`로 바꾸면 그 소스의 skipped 행이 전부 돌아온다.
  - 적재 때 걸러 낸 문단은 행을 만들지 않고 URL마다 최신 스냅샷 하나를 보류 표식(`tick_state` `extract:l2policy:held:<소스>|<URL>`)으로 남긴다. 정책이 넓어진 sweep이 그 스냅샷을 다시 적재한다(`held_queued`).
  - `kb agent run --reextract`도 정책을 따른다. `none`이면 건너뛰고, 그 밖에는 정책이 받는 문단만 다시 넣으며 남아 있는 `skipped_policy` 행을 되살린다.
  - 꺼내기(`order.take`)와 되돌리기(`queue_done` 재예약, `_release`, `unattempted`)는 `skipped_policy`를 건드리지 않고, `queue_left`, 워치독 `queue_l2`, 지표 `retries`는 세지 않는다.
- 수동 확인: `kb queue stats --by-source --json`(읽기 전용; 소스별 `category`, `policy`, `rows`, `queued`, `skipped_policy`, `queued_new`)과 `kb queue sweep [--dry-run] [--json]`. `queued_new`는 마지막 sweep 이후 큐에 들어온 `queued`, `taken` 행 수다(`--since <ms>`로 바꾼다).
  - 배포 전 판정: `kb queue stats --by-source --json | jq -e '[.sources[] | select(.policy=="none") | .queued_new] | (add // 0) == 0'`
- 사본 측정(2026-11-04, `~/.cache/sagae-kb/s/d1sim`의 복사본, URL별 최신 스냅샷): L2로 가는 문단은 `pypi-meta` 585/10,831, `awesome-claude-code` 347/347, `hn-algolia-g` 45/791, `hn-algolia-f` 0/103, `g4-npm-registry` 8/66,263이다. 판정 불가 0. 첫 sweep은 skipped 997행을 되돌렸고(1.9초), 원장과 done 키 2,732개는 그대로였다.
