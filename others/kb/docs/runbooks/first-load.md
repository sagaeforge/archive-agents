# 첫 적재 (WP-25)

실운영 `KB_HOME=/home/user/sagae-kb-data`, `KB_CONFIG_DIR=~/.config/sagae-kb`, `KB_LIVE=1`. 결정적 경로(L0, L1)만 쓴다. L2, 에이전트, MCP, HTTP, 스케줄러, systemd, crontab을 쓰지 않는다. 멱등이라 WP-21이 그대로 잇는다.

## 순서

1. 시작 전 점검: `kb verify all`로 체인을 확인하고 원장 이벤트 종류를 센다. schema 이벤트 외의 시험 이벤트가 있으면 지우지 말고 멈춘다(원장은 지울 수 없다). 빌드 중 남은 `perfprof/`는 지운다.
2. 배포: `ops/bin/deploy --from-snapshot ~/.cache/sagae-kb/build/snapshots/wave-<n>.tar.gz` (같은 파동 패키지가 쓰는 중인 파일을 싣지 않는다).
3. `$KB_HOME/runtime/bin/kb doctor` → gold가 없거나 지문이 다르면 `kb rebuild gold` → `kb schema sync` → `kb sources sync`.
4. `kb tick --batch sources/first-load.yaml --until-idle --max-runtime 30m --json` 1회.
5. `kb status --json`, `kb search`, `kb verify all --json`으로 확인한다.

`sources/first-load.yaml`은 ADR 10.4 초기 활성 표 중 enabled, requires_decision 없음, robots=enforce, 결정적 어댑터가 있는 소스다. 순서는 A~F 문서형, F 개발, G1, G2, G3, G5다. 제외: O07(로컬 실행), G4 전부(저장소 순환은 GitHub 시간당 예산을 다 쓴다), 결정 8/9 대기 소스, `src:opensurvey-trend`(아래 결함).

## 결과 (2026-11-01)

시작 상태: 원장 86건은 전부 `schema.*`(system:schema-sync). 체인 정상. 시험 이벤트 없음. `perfprof/` 삭제.
tick 1회(30분 상한 소진, 총 30분 04초). 출력 `.pages_fetched=147`, `.pages_capped=6765`, `.parsed=436`, `.failed_sources=0`, `.robots_denied=0`, `.stages.parse=ok`, `.stages.gate_l1=ok`, `.stages.fetch=ok`(단 `errors` 53건, 아래).

- 스냅샷 수: 546 (`.counts.snapshots`)
- 사실 수: 활성 158 (`.counts.claims_active`), 보류 394 (`.counts.claims_review`)
- 노드 3229, 엣지 1467, 엔티티 968, 원장 5479건, `queue_l2` 0
- 도메인별 수(다중 집계, 합이 전체보다 클 수 있음):

| 도메인 | sources_active | snapshots | claims_active |
|---|---|---|---|
| A | 1 | 4 | 51 |
| B | 8 | 16 | 51 |
| C | 7 | 74 | 20 |
| D | 3 | 70 | 20 |
| E | 4 | 71 | 20 |
| F | 6 | 29 | 14 |
| G | 46 | 374 | 73 |

- 도메인 A는 키워드 데이터가 없다. kworb(P10) 순위 표만 들어갔다.
- G 단위 주어의 L1 주장은 WP-21의 `kb live run` 전까지 `needs_review`로 남아 기본 검색에 나오지 않는다. 문단 검색은 된다.
- 실패 소스: `src:opensurvey-trend`(403 blocked, 배치에서 제외), `src:f-tools`의 FFmpeg/FFmpeg 릴리스 404(`suspect`).
- GitHub 시간당 예산(50) 초과: `src:cc-repo-meta` 52건 `budget_exceeded`. 다음 tick이 잇는다.
- 이번 실행에서 성공 수신 0건 소스: cc-agent-sdk, cc-workflows, hn-algolia-g, kr-tech-blogs, hf-models, korea-sovereign-ai (예산 초과이거나 304만 받았다. 원인 미조사).
- needs_ocr 소스: 없음(`snapshot.text` 페이로드에 `needs_ocr` 0건).
- unverified 소스(18): datareportal, mobileindex-blog, nielsen-gauge, kmcc-media-survey, kisdi-stat, youtube-official-blog, nasmedia-npr, codex-npm, simonw-atom, geeknews, pytorch-kr, yozm-it, kr-tech-blogs, ollama-blog, lmstudio-blog, ollama-releases, lmstudio-docs, korea-sovereign-ai.
- 큐 잔량: page 644, live 438. 남은 페이지는 이후 tick과 WP-21이 잇는다.
- `kb verify all`: 체인, CAS, 지문 모두 ok.
- `kb search` 표본: "Claude Code 훅" 17건, "Shorts" 50건, "Codex" 50건.

## 알려진 결함 (WP-06 소유, change_request)

`src/kb/collect/state.py`의 `State.put`은 행이 이미 있을 때 `state`를 빼고 UPSERT해서 `NOT NULL constraint failed: source_state.state`(또는 `url_state.state`)로 실패한다. 호출처는 `tick_stage.py`의 지연 처리(`DEFER_MS`, `circuit_open`)다. 서킷이 열린 소스가 있으면 fetch 단계가 매 반복 예외로 끝나고, `--until-idle`이 반복해 같은 소스에서 멈춘다. 이번 실행에서 `errors` 53건. 배치에서 `src:opensurvey-trend`를 빼도 다른 지연에서 같은 예외가 난다.
