# 빌드 계획 실행 가능성 감사

- 날짜: 2026-10-31
- 대상: `docs/build-plan.md`. 참고로 `docs/adr/0001-architecture.md`, `docs/contracts/data-interface-v0.md`, `docs/contracts/consumers/sagae-tools.md`, `docs/research/*.md`, `CLAUDE.md`
- 범위: 22개 패키지를 구현자 입장에서 따라가 실제로 구축이 되는지 본다. 순환 없음과 소유 경로 겹침 0건은 기계 검사를 통과했으므로 반복하지 않았다.
- 근거 표기: `[재현]`은 이번에 직접 돌린 결과, `[원문]`은 문서 내용 대조, `[추론]`은 돌려 보지 않은 판단이다.
- 재현 위치: `/home/user/.cache/sagae-kb/scratch/audit/plan`, 스크래치패드 `audit/plan`. 저장소에는 이 파일만 추가했다.

## 1. 결론

**이대로는 구축을 시작할 수 없다.** 고정한 버전은 전부 실제로 설치되고, 성능 기준도 여유가 있다. 막는 것은 설계가 아니라 실행 장치다.

| 등급 | 건수 | 뜻 |
|---|---:|---|
| blocker | 7 | 이대로 구축하면 실패하거나 지침을 어긴다 |
| major | 19 | 큰 재작업이나 잘못된 결과를 부른다 |
| minor | 6 | 고치면 좋다 |

blocker 7건은 다음과 같다.

1. **worktree 격리가 커밋 없는 저장소에서 동작하지 않는다.** 다음 파동은 앞 파동의 코드를 볼 수 없고 ADR도 볼 수 없다(PLAN-01).
2. **`kb`와 `kb-mcp`를 설치하는 단계가 어느 패키지에도 없다.** `ops/bin/deploy`는 커밋이 없으면 이름부터 정하지 못한다(PLAN-02).
3. **`kb tick`이 아직 없는 후행 패키지를 부를 규약이 없다.** WP-07부터 소유 규칙에 걸려 `blocked`가 된다(PLAN-03).
4. **활성 소스에 `www.youtube.com`이 있다.** 사용자 결정 1 전에 자동 호출이 나가고 WP-21 시험도 실패한다(PLAN-04).
5. **배포본이 `schemas/`, `sources/`, `prompts/`를 찾지 못한다.** 스케줄 실행이 첫 단계에서 멈춘다(PLAN-05).
6. **선행 패키지가 후행 패키지의 산출물을 먼저 써야 하는 역순서가 4곳 있다.** 기계 검사는 패키지 의존만 보므로 잡지 못했다(PLAN-06).
7. **WP-17의 `node --check`는 통과할 수 없다.** 계획의 워크플로우 골격 자체가 실패한다(PLAN-07).

**가장 시급한 일은 PLAN-10이다.** 왜곡 표본, 표기 공격 26건, 기록된 스트림, 프로토타입, 계획 생성 데이터가 전부 세션 전용 tmpfs에만 있다. 재부팅하면 사라지고, 일부 인수 조건은 다시 만들 수 없다. 저장소로 옮기는 일은 사용자 결정 없이도 할 수 있다.

## 2. 구축 전에 사용자가 정할 것

| # | 결정 | 왜 필요한가 | 관련 |
|---|---|---|---|
| A | 기준 커밋과 파동별 커밋을 전용 브랜치에 허용할 것인가, 커밋 없이 한 작업 트리를 나눠 쓸 것인가 | 커밋은 사용자 요청 때만 한다. 현재 계획은 커밋이 있어야 도는 구조다 | PLAN-01 |
| B | D13, D15, D18, D19, D22(YouTube·Google 문서형)를 자동 수집할 것인가 | ADR 10.4는 켰고 결정 1은 전부 꺼짐이라고 적었다. 두 문장이 충돌한다 | PLAN-04 |
| C | `kb-first-collect`의 에이전트 수, 총액, 활용률 문턱 | 1차 수집에서 가장 비싼 단계인데 상한이 없다 | PLAN-17 |
| D | 인수 시험의 실제 `claude -p`가 `~/.claude`에 남기는 기록을 사고에서 뺄 것인가 | 지금 규칙대로면 시험마다 `global_file_change` 사고다 | PLAN-21 |
| E | 골든 표본을 언제 사람이 확인할 것인가 | WP-18 인수 조건이 사람 없이 통과할 수 없다 | PLAN-22 |
| F | `export/first_party` 자동 로컬 커밋을 허용할 것인가 | ADR 17.1과 ADR 22가 서로 반대다 | PLAN-26 |
| G | robots가 막는 활성 소스 X11, X15, D11을 어떻게 할 것인가 | 켜 둔 소스가 준수 규칙 때문에 수집되지 않는다 | PLAN-27 |

## 3. 고치는 순서

1. **지금:** PLAN-10의 재료를 저장소로 옮긴다.
2. **결정 A, B, C:** 이 셋이 계획의 형태를 바꾼다.
3. **계획 수정, WP-00 시작 전:** PLAN-01, 02, 03, 05, 06, 09, 11, 12, 13. 2.3 공유 인터페이스와 WP-00, 01, 02, 06, 07 지시가 바뀐다.
4. **인수 조건 교체:** PLAN-07, 14, 20, 21, 22, 23. 문장 수정이고 재작업이 작다.
5. **안전장치:** PLAN-15, 16, 17, 19. WP-06, 16, 17, 21과 실행 규칙을 고친다.
6. **나머지:** PLAN-18, 24~32.

## 4. 결함

### 4.1 blocker

#### PLAN-01 worktree 격리와 커밋 금지가 양립하지 않는다

- **위치:** 빌드 계획 1장 격리·커밋 규칙, 2.1 골격, 2.2 스키마
- **결함:** 저장소는 커밋이 0개이고 `CLAUDE.md`, `docs/`도 추적되지 않는다. 계획은 파동마다 `isolation: 'worktree'`로 돌리되 커밋하지 말라고 한다. worktree는 커밋에서만 파일을 얻으므로 다음 파동이 앞 파동의 산출물을 받을 길이 없다.
- **근거:**
  - `[재현]` 커밋 없는 임시 저장소에서 `git worktree add ../x -b wp-00`은 orphan 브랜치의 빈 트리(`.git`만 있음)를 만들고 exit 0이다. `git worktree add -b x ../y HEAD`는 `fatal: invalid reference: HEAD`, exit 128이다.
  - `[재현]` 기준 커밋이 있어도, 메인 트리에 합친 미커밋 `pyproject.toml`과 `src/`는 다음 worktree에 없다. `.git`만 있다.
  - `[원문]` Review 단계의 `agent()`에는 `isolation`이 없고 합치기 전에 돈다. 검증 에이전트는 검증할 코드를 볼 수 없다.
  - `[원문]` `WP_RESULT`에 worktree 경로가 없다. 합칠 위치를 알 수 없다.
  - `[추론]` 골격의 `results.filter(Boolean)` 때문에 worktree 생성이 실패하면 모든 패키지가 `null`이 되고, Review도 돌지 않은 채 오류 로그 없이 끝난다.
  - 소유 경로만 합치는 일을 메인 세션이 맡는 것도 지침 1(메인은 관제만)과 맞지 않는다.
- **수정:** 결정 A로 고른다.
  - 안 1: 전용 브랜치에 기준 커밋(`CLAUDE.md`, `docs/` 포함)과 파동별 커밋을 허용한다. worktree는 최신 파동 커밋에서 만들고, 병합은 전용 에이전트가 맡고, Review는 병합 뒤에 돈다. `WP_RESULT`에 `worktree_path`를 넣는다.
  - 안 2: 커밋 없이 간다. `isolation`을 지우고 한 작업 트리를 나눠 쓴다. 파동 전에 디스크에 `tar` 스냅샷을 남겨 되돌림 수단으로 삼고, `changed_paths`는 git이 아니라 소유 경로 대조로 구한다. 8개 병렬 `uv run`은 같은 프로젝트에서 전부 성공했다 `[재현]`.

#### PLAN-02 `kb`와 `kb-mcp`를 설치하는 단계가 없다

- **위치:** WP-00 지시와 인수 조건, 인수 조건 137개 중 맨 `kb`로 시작하는 15개, WP-12, WP-14, WP-16
- **결함:** 맨 `kb`를 어떻게 찾는지 정의가 없다. `runtime/bin/kb`는 `ops/bin/deploy`만 만드는데, WP-00 인수 조건은 `--dry-run`뿐이고 계획 어디에도 실제 배포를 돌리는 단계가 없다. `venv-<git sha>`는 커밋이 없으면 만들 수 없다. `kb-mcp` 래퍼는 `python -I -m kb`로 적혀 있어 `kb`와 같은 일을 한다. WP-12가 고치려 해도 `ops/bin/deploy`는 WP-00 소유이고, `src/kb/commands/mcp.py`도 어느 패키지 소유 경로에 없다.
- **근거:**
  - `[재현]` `git rev-parse HEAD`는 exit 128이다.
  - `[재현]` `uv run --frozen --all-extras kb`는 동작한다. 즉 `ops/bin/dev kb ...`가 현실적인 경로다.
  - `[원문]` `rg deploy docs/build-plan.md`는 WP-00 세 줄뿐이다. 그런데 WP-12, 14, 16, 17은 `runtime/bin/kb`, `kb-mcp`를 전제한다.
- **수정:**
  - 인수 조건의 맨 `kb`를 `ops/bin/dev kb`로 통일한다.
  - 배포 이름을 git sha 대신 `uv.lock`과 `src/`의 내용 해시로 정한다.
  - WP-00이 `[project.scripts]`에 `kb-mcp = "kb.serve.mcp:main"`을 미리 둔다. 스크립트는 실행할 때만 import하므로 모듈이 나중에 생겨도 된다.
  - 실제 배포를 파동 관문으로 넣는다. 최소한 WP-14 직전과 WP-21 직전이다.

#### PLAN-03 `kb tick`의 후행 단계를 연결할 규약이 없다

- **위치:** WP-06 지시, 2.3 공유 인터페이스, ADR 10.2, 소유 규칙
- **결함:** WP-06은 ADR 10.2의 9단계를 구현하라고 받지만 parse(WP-07), confirm(WP-19), publish(WP-10), ship(WP-13), watchdog·체크포인트(WP-15)는 뒤나 같은 파동이고 2.3에 호출 규약이 없다. 뒤 패키지는 `src/kb/collect/`를 고칠 수 없다. `sources/internal.yaml`도 WP-06 단독 소유인데 WP-09(live), WP-13, WP-15, WP-18(전사 ETL, 회고), WP-20(벡터 증분)이 항목을 넣어야 한다.
- **근거:** `[원문]` WP-07 인수 조건 `kb tick --only src:cc-changelog-gh --json | jq -e ".parsed >= 1"`은 tick이 parse를 불러야 통과한다. 규칙상 WP-07은 `blocked`를 반환해야 하고 그 뒤로 WP-08, 09, 12, 17, 18, 19, 21이 멈춘다. 같은 공백으로 ADR 9.3의 `kb fetch` 출력 `text_sha`, `chars`도 WP-06에서 채울 수 없다.
- **수정:** `commands/`와 같은 방식을 2.3에 추가한다. `src/kb/<패키지>/tick_stage.py`가 `STAGE`와 `run(ctx) -> StageResult`를 내고 tick이 자동 탐색한다. 없는 단계는 건너뛰고 `--json`에 표시한다. `sources/internal.yaml`은 `sources/internal.d/<패키지>.yaml`로 나눈다. WP-07, 09, 10, 13, 15, 18, 19, 20 지시에 등록을 넣는다.

#### PLAN-04 활성 소스에 `www.youtube.com`이 있고 WP-21 시험과 결정 1을 어긴다

- **위치:** ADR 10.4 초기 활성, ADR 11 클래스 표, ADR 23 결정 1, WP-07, WP-21 `test_hosts`
- **결함:** ADR 10.4는 `D17~D23`과 D13, D15를 켠다. D18의 URL은 `https://www.youtube.com/trends/`이고 D19는 `https://www.youtube.com/howyoutubeworks/...`다. 결정 1의 기본값은 "전부 꺼짐"이고, 인벤토리는 YouTube 약관이 공개 검색엔진 외 자동화 접근에 사전 서면 허가를 요구한다고 적는다. WP-07이 충실하게 구현하면 `kb tick`이 사용자 결정 없이 하루 1회 YouTube로 요청을 보낸다. WP-21 `test_hosts`는 `youtube.com` 0건을 요구하므로 올바른 구현이 실패하고, 그때는 이미 요청이 나간 뒤다.
- **근거:** `[원문]` `sources-inventory.md`의 `[^yt-trends]`, `[^yt-reco]`, ADR 11 표의 `feed`(D18), `docs`(D19). 같은 묶음의 D13은 `blog.youtube/rss/`, D15와 D22는 `support.google.com`이라 시험에는 걸리지 않지만 결정 1의 "YouTube·Google 경로"에 든다.
- **수정:** D18, D19를 초기 비활성으로 옮긴다. D13, D15, D22는 결정 B로 명시한다. 호스트 거부 목록을 `safe_fetch` 코드 수준에 넣고 `test_policy`로 고정한다(PLAN-15). `test_hosts`는 사후 확인으로 남긴다.

#### PLAN-05 배포본이 저장소 루트의 데이터 파일을 찾지 못한다

- **위치:** ADR 6.1, 6.2 배포 항목, ADR 18, WP-00 deploy, WP-14 유닛
- **결함:** 런타임이 읽는 `schemas/events`, `schemas/types`, `schemas/ingest`, `schemas/predicates.yaml`, `schemas/aliases`, `schemas/agent`, `sources/`, `prompts/`는 저장소 루트에 있어 `--no-editable` 설치본에 들어가지 않는다. 유닛에는 `WorkingDirectory`가 없고 `python -I`라 현재 폴더도 경로에 없다. 저장소 경로를 직접 읽으면 ADR 6.2의 "진행 중인 편집이 운영 프로세스에 닿지 않는다"가 깨진다.
- **근거:** `[재현]` 복제 프로젝트의 `uv sync --frozen --no-editable` 결과 site-packages에는 `__init__.py __main__.py cli.py commands core`뿐이고 `classes.yaml`, `claim.assert.json`, `extract.txt`는 0건이다. `cd /`에서 실행하면 `sources` 없음, 저장소 루트에서만 보인다. 저장소 루트에서 돌리는 수동 시험은 통과하고 `[사용자 입회]` 시험에서야 드러난다 `[추론]`.
- **수정:** `kb.core.paths.share_dir()`를 2.3에 추가하고 모든 로더가 이 함수만 쓴다. `ops/bin/deploy`가 세 폴더를 `runtime/share-<id>/`로 복사하고 래퍼가 `KB_SHARE`를 내보낸다. `ops/bin/dev`에서는 저장소 루트를 돌려준다. WP-01부터 로더가 생기므로 WP-00에서 정해야 한다.

#### PLAN-06 선행 패키지가 후행 패키지의 산출물을 먼저 써야 한다

- **위치:** WP-01, WP-02, WP-07, WP-08, 2.3
- **결함:** 패키지 의존에는 순환이 없지만 파일 수준에서는 순서가 뒤집힌 곳이 있다. 기계 검사가 보지 않는 층이다.

| 먼저 쓰는 쪽 | 필요한 것 | 만드는 쪽 | 결과 |
|---|---|---|---|
| WP-01 (파동 1) | `tests/golden/`의 기대 지문 | WP-02의 `fingerprint`와 DDL (파동 2) | WP-01은 값을 만들 수 없고 WP-02는 `tests/golden/`을 고칠 수 없다. `test_replay`가 막히면 18개 패키지가 멈춘다 |
| WP-02 (파동 2) | 문단 목록 CAS 객체 형식, 시계열 NDJSON 형식 | WP-07 (파동 5) | 투영과 표시 본문 시험이 나중에 정해질 형식을 추측해야 한다 |
| WP-07 (파동 5) | `schemas/predicates.yaml`의 `functional` | WP-08 (파동 6) | 자동 `claim.supersede` 조건을 판단할 파일이 아직 없다 |
| WP-04 (파동 3) | `/v1/schema`의 `predicates` | WP-08 (파동 6) | 카탈로그에 넣을 재료가 없다(PLAN-13) |

- **근거:** `[원문]` 각 패키지 지시와 소유 경로. WP-07의 `snapshot.text` 필드 목록(`text_sha`, `text_format`, `extractor`)에는 문단 목록 객체를 가리키는 값도 없다.
- **수정:** 기대 지문을 WP-02 소유 `tests/project/golden.fingerprint`로 옮긴다. 문단 목록과 시계열 묶음 형식을 WP-01의 `schemas/events/`에 정의하고 `snapshot.text`에 `paras_sha`를 넣는다. `schemas/predicates.yaml`을 WP-07 앞으로 옮겨 WP-08은 항목만 늘리게 한다.

#### PLAN-07 WP-17의 `node --check`는 통과할 수 없다

- **위치:** WP-17 인수 조건 5번, 2.1 골격
- **결함:** 워크플로우 스크립트는 `export`, 최상위 `await`, 최상위 `return`을 함께 쓴다. WP-17은 모든 워크플로우가 `incidents`를 반환하게 요구하므로 `return`을 뺄 수 없다. Node는 이 조합을 모듈로도 CommonJS로도 받지 않는다. WP-17이 막히면 WP-21도 막힌다.
- **근거:** `[재현]` 계획 2.1 골격을 그대로 저장해 Node v26.13.0으로 돌리면 `SyntaxError: Illegal return statement`, exit 1이다. 마지막 `return`만 빼면 exit 0이다.
- **수정:** `ops/bin/check-workflows`를 둔다. `export`를 떼고 본문을 `async function`으로 감싸 `node --check`한다. 골격은 exit 0, 깨진 스크립트는 exit 1을 냈다 `[재현]`.

### 4.2 major

#### PLAN-08 병렬 worktree가 같은 `venv-dev`를 쓰면 다른 패키지의 코드를 시험한다

- **위치:** WP-00 `ops/bin/dev`, 1장 격리 규칙
- **결함:** `UV_PROJECT_ENVIRONMENT=$KB_HOME/runtime/venv-dev`는 전 worktree가 공유한다. `uv run`은 실행마다 editable 경로를 자기 worktree로 다시 쓴다. 다중 프로세스 시험의 자식이 옆 패키지 코드를 import해도 시험은 통과로 보일 수 있다.
- **근거:** `[재현]` A worktree의 긴 작업 중 B에서 `uv run`을 돌리자 A의 자식 프로세스가 `B /.../wtB/src/kb/who.py`를 찍었다. `.pth`도 wtB로 바뀌었다.
- **수정:** PLAN-01에서 worktree를 유지하면 `UV_PROJECT_ENVIRONMENT=$PWD/.state/venv-dev`로 나눈다. `.state/`는 이미 무시 대상이고 한 벌은 137 MB다.

#### PLAN-09 `UV_PYTHON_INSTALL_DIR`이 없어 CPython이 전역에 또 내려온다

- **위치:** WP-00 지시의 `env.sh` 값 목록
- **결함:** `--install-dir`은 그 명령 한 번에만 쓰인다. `env.sh` 목록에 `UV_PYTHON_INSTALL_DIR`이 없어 `uv lock`, `uv run`은 설치본을 찾지 못하고 `~/.local/share/uv/python`에 내려받는다. 지금 그 폴더는 없다. 인수 조건 1번은 `bootstrap.sh`만 보므로 이 쓰기를 잡지 못한다.
- **근거:** `[재현]` WP-00 변수만 준 가짜 HOME에서 `uv lock`을 돌리자 HOME 파일이 0개에서 3,528개로 늘었다. 변수를 더하면 0개다.
- **수정:** `env.sh`에 `UV_PYTHON_INSTALL_DIR=$KB_HOME/runtime/python`을 넣고, `UV_PYTHON_DOWNLOADS=never`도 고려한다. 인수 조건 1번에 `uv lock`과 `ops/bin/dev` 실행까지 포함한다.

#### PLAN-10 시험 재료와 프로토타입이 세션 전용 tmpfs에만 있다

- **위치:** WP-02, 05, 06, 08, 16, 17, 19 지시와 인수 조건, ADR 2장, 부록 B
- **결함:** 인수 조건이 쓰는 재료가 저장소에 없다. ADR은 "사양으로 다시 만들 수 있다"고 적었지만 아래 일부는 사양만으로 복원되지 않는다. 경로 `scratchpad adr/scripts/...`는 이 세션 ID에 묶여 다른 세션에서는 찾을 수 없다.
- **근거:** `[재현]` `git ls-files`는 0개이고 `tests/`, `eval/`, `schemas/`가 없다. 재료의 실제 위치는 다음과 같다.

| 재료 | 쓰는 곳 | 스크래치패드 위치 |
|---|---|---|
| 왜곡 90건, 대조군 38건, 실제 주장 49건 | WP-08 `test_distortion`, 보류율 비교 | `adr/scripts/gate2.py`, `t5_tables.py`, `redteam/t5_gate.py`와 입력 데이터 |
| 표기 공격 26건 | WP-02 `test_tokens`, WP-05 `test_attack` | `adr/scripts/tok_eval.py`, `redteam/t4_ko.py`. 문서에는 8건만 나온다 |
| 기록된 스트림 6종 | WP-17 `test_verdict`, WP-19 시험 | `harness/out/` 127개 파일 |
| 프로토타입 | WP-06, 08, 16 지시가 경로로 지목 | `adr/scripts/fetch_guard.py`, `gate2.py`, `rtk_real2.sh` |
| Ko-StrategyQA 변환본 | WP-05, WP-20 | `retrieval/`, ADR 부록 B가 지목 |
| 계획 원본 | 계획을 고칠 때 | `adr/wp.json`, `adr/wp_data.py` |

- **수정:** WP-00 시작 전에 `tests/fixtures/`와 `docs/design/prototypes/`로 옮기고 계획의 경로를 저장소 경로로 바꾼다. 스트림은 개인 정보를 확인한 뒤 옮긴다. 합성 표식이 필요한 재료에는 표식을 단다.

#### PLAN-11 `pyproject.toml`, `uv.lock` 단독 소유와 `--frozen`이 후행 패키지를 막는다

- **위치:** WP-00 소유 경로, WP-05, WP-07
- **결함:** 의존성을 더할 수 있는 패키지가 WP-00뿐이고 `ops/bin/dev`는 `--frozen`이다. 뒤 패키지가 필요를 발견하면 `blocked`밖에 없고, 계획에 잠금을 고치는 절차가 없다.
- **근거:**
  - `[재현]` `mteb/Ko-StrategyQA`는 parquet 3개뿐이다. 조사 때 스크립트는 `pyarrow`와 `huggingface_hub`를 썼는데 둘 다 잠금에 없다. WP-05의 "내려받기 절차"는 어디에도 없다.
  - `[재현]` 잠금에 PDF 판독기가 없다(PLAN-24). `cssselect`도 없어 `lxml`의 `.cssselect()`를 쓸 수 없다. WP-07의 `<style>` 단순 선택자는 직접 구현해야 한다.
- **수정:** 추가 의존 절차를 1장에 넣는다. 패키지가 `risks`에 요청하고 전용 짧은 패키지가 잠금을 고친다. WP-05 평가 전용으로는 고정판 `--with pyarrow==<버전>`이나 datasets-server JSON을 쓰고 절차를 `eval/lexical/README`에 적는다. PDF 판독기는 지금 결정해 WP-00 목록에 넣는다.

#### PLAN-12 스키마 파일이 단독 소유인데 후행 패키지의 열이 빠져 있다

- **위치:** WP-01 `opsdb.py`, WP-02 `schema.sql`, ADR 7.2, 7.6, 10.6, 12
- **결함:** `ops.db`는 표 이름만 있고 열 정의가 없는데 뒤 패키지는 이 모듈로만 접근해야 한다. `graph.db`에는 ADR이 쓰는 필드가 없다. 뒤 패키지는 `schema.sql`, `opsdb.py`를 고칠 수 없고, 마이그레이션 절차도 없다.
- **근거:** `[재현]` 전문 검색 결과 `evidence_state`(ADR 7.6, WP-19), `support_check`(ADR 10.6, WP-19), `link_status`(ADR 12, WP-06)는 ADR 7.2 DDL과 계약 `Evidence`에 없다. 후보 큐, 재확인 큐, 리뷰 대기열의 열도 어디에도 없다.
- **수정:** ADR에 `ops.db` DDL을 적고 WP-01이 그대로 옮긴다. 빠진 필드를 7.2와 계약에 넣는다. `schema_version`을 올리는 패키지 간 절차를 1장에 둔다. `ops.db`는 잃어도 되므로 `user_version`으로 재생성하면 충분하다.

#### PLAN-13 작성자가 없는 이벤트 때문에 계약 필드가 운영에서 비게 된다

- **위치:** ADR 7.1 kind 표, 계약 4.2, 4.11, WP-02, 03, 04, 06, 07, 08, 11
- **결함:** `schema.type_defined`, `schema.predicate_defined`, `source.registered`, `source.status`, `series.define`을 쓰는 패키지가 없다. `schemas/types/`와 `schemas/predicates.yaml`을 원장에 넣는 단계도 없다. 또 WP-01 지시에는 `schemas/events/`에 무엇을 쓸지 설명이 없고 소유 경로에만 나온다.
- **근거:**
  - `[재현]` 패키지 지시와 인수 조건에서 위 다섯 종류는 언급 0건이다.
  - `[추론]` `type_def`가 비어 `/v1/schema`의 `node_types`, `predicates`가 비고, `Source` 노드가 없어 `/v1/snapshots/{id}`의 `source.label`, `trust`와 카드 출처 칸을 채우지 못한다. WP-11 fixture는 합성 원장에 이 이벤트를 직접 넣으므로 계약 시험은 통과하고, 운영에서만 빈 값이 나온다.
- **수정:** WP-01에 이벤트 페이로드 스키마 전수 작성을 지시하고 kind별 시험을 둔다. WP-07에 `source.registered` 동기화를, WP-08이나 부트스트랩 명령에 타입·술어 등록을 맡긴다. WP-21 인수 조건에 `/v1/schema`의 `node_types` 비어 있지 않음을 더한다.

#### PLAN-14 인수 시험이 실운영 `KB_HOME`의 지울 수 없는 원장에 쓴다

- **위치:** 1장 작업 위치, WP-06, 07, 19, 21 인수 조건, WP-01 삭제 금지 트리거
- **결함:** 모든 명령이 `env.sh` 뒤에 돌고 `KB_HOME` 기본값은 실데이터다. 원장은 `event`의 DELETE를 막는다. 구현 중의 시험 이벤트와 버그 있는 파서 결과가 진실 저장소에 영구히 남는다. 초기화는 곧 데이터 손실 사고다.
- **근거:**
  - `[원문]` WP-06 `kb fetch https://code.claude.com/docs/llms.txt --source src:test`는 등록되지 않은 `src:test`로 `snapshot.captured`를 남긴다. WP-07의 `kb tick --only`, WP-19의 `kb agent run --max-windows 1`도 실제 이벤트를 쓴다.
  - `[원문]` `$KB_HOME/test-tmp/`는 패키지 공용이고 "끝나면 지운다". 병렬 패키지가 서로의 임시 폴더를 지울 수 있다.
- **수정:** 구축 중에는 `KB_HOME=$HOME/.cache/sagae-kb/build/<wp>`처럼 패키지별 인스턴스를 쓰고, 실운영 `KB_HOME`은 WP-21에서만 쓴다. 임시 폴더는 `test-tmp/<wp>/`로 나눈다. `src:test` 대신 시험 전용 레지스트리를 쓴다.

#### PLAN-15 `kb_fetch`는 임의 URL을 받고 호스트 정책이 없다

- **위치:** WP-06 `safe_fetch`, `capture`, `test_policy`, WP-12 `kb_fetch`, WP-21
- **결함:** `safe_fetch`는 사설 주소만 막고 호스트 거부 목록이 없다. robots, 호스트 간격, 서킷은 tick의 3단계에만 있어 `kb_fetch`, `kb_put source_url`, `kb fetch`는 거치지 않는다. WP-06 인수 조건이 등록 안 된 `src:test`를 통과시키므로 미등록 소스 허용이 사실상 요구된다. WP-21 4단계는 "레지스트리에 없는" 대상을 찾는 일이라 LLM이 고른 URL이 그대로 나간다. YouTube, EDGAR 금지는 문장 지시와 사후 시험뿐이다. `kb-researcher`의 WebFetch는 `fetch_log`에 남지도 않는다.
- **근거:** `[원문]` WP-06 `test_policy` 범위는 `enabled=false`, `needs_contact`, User-Agent, 대체 소스 등급이다. WebSearch 결과에 영상 링크가 섞이면 금지 호스트 호출로 이어진다 `[추론]`.
- **수정:** 거부 호스트를 `sources/classes.yaml`에 두고 `safe_fetch`가 호출마다 검사한다. robots, 간격, 서킷을 `capture` 층으로 내린다. 미등록 URL은 `src:adhoc` 등 명시적 소스로만 받고 `tos` 미확인으로 기록한다. `test_policy`에 `kb_fetch`로 거부 호스트를 호출하면 네트워크 0회인 시험을 넣는다. `kb-researcher`에도 같은 범위를 문서로 묶는다.

#### PLAN-16 SessionStart 훅이 수동 tick 기본값을 넘어 실수집을 시작한다

- **위치:** WP-16 `session-start.sh`, ADR 18, ADR 23 결정 3
- **결함:** 결정 3 전 기본 동작은 "수동 tick"이다. 그런데 훅은 저장소 세션이 열릴 때마다 만기가 있으면 `kb tick`을 배경으로 띄운다. `KB_JOB` 조건은 rtk 가드에만 있고 이 훅에는 없다. 배포만 끝나면 WP-21 전에, PLAN-04의 호스트를 포함한 실수집이 시작될 수 있다. `--setting-sources project`로 도는 `kb-agent-run`에서도 훅이 돈다.
- **근거:** `[원문]` WP-16 지시. harness 조사 T5b는 워크플로우 에이전트에서도 프로젝트 훅이 발화한다고 적었다. 실제 설치 측정은 없다 `[추론]`.
- **수정:** 훅의 배경 tick은 설정 `collect.session_tick=true`일 때만 돌고 기본은 꺼 둔다. WP-21 통과와 사용자 승인 뒤에 켠다. `KB_JOB`이 있으면 건너뛴다.

#### PLAN-17 `kb-first-collect`에 비용 상한과 실행 형태가 없다

- **위치:** WP-17, WP-21 지시, ADR 20.2, 20.3
- **결함:** WP-21에서 가장 비싼 단계인데 에이전트 수, 총액, 재시도 횟수, 활용률 문턱이 어디에도 없다. `five_hour.utilization` 제어는 WP-19의 L2에만 있다. `kb-collector`는 sonnet에 `maxTurns: 30`이고 재시도 단계까지 있다. 예시 `--max-budget-usd 2`를 그대로 쓰면 워크플로우가 중간에 죽고, 그래도 exit 0이다. 메인 세션 Workflow로 돌지 `kb-agent-run`으로 돌지도 정해지지 않았다. WP-17은 `kb-fulfill`의 `--dry-run`만 시험하므로 첫 실제 실행이 WP-21이다.
- **근거:** `[원문]` harness T12, R12: 상한 도달 시 배경 워크플로우가 죽어도 exit 0. T5a: `Workflow(<name>)` 허용 규칙이 없으면 exit 0으로 조용히 거부된다.
- **수정:** 결정 C를 받아 고정한다. 도메인별 에이전트 수 상한, 스크립트 안 항목 수 상한, 실행 전 활용률 0.5 문턱, 라운드당 재시도 1회를 스크립트에 넣는다. `kb-first-collect`의 작은 표본 실제 실행을 WP-17 인수 조건에 넣는다.

#### PLAN-18 L2 적체가 며칠 걸리는데 WP-21을 끝내고 이어 갈 주체가 없다

- **위치:** WP-21 지시, ADR 10.5, 부록 A, 결정 3
- **결함:** L2 큐는 모든 문단이고 일일 400창이다. 첫 배치 적체는 8~15일이다. 순서는 "L2 그다음 에이전트 수집"이라 글자대로면 4단계가 그만큼 밀린다. 에이전트 하나는 며칠을 버티지 못하고, 결정 3 전에는 `kb-agent.timer`도 없다. 다음 날 누가 잇는지 없다.
- **근거:** `[재현]` C01 실제 파일은 1,129,420자이고 계획 규칙(500자 문단, 6,000자 창)으로 195창이다. `[추론]` 인벤토리 크기로 C03 약 1,670창, O02 약 430창, C04 약 1,000창이다. 합계 3,300창이면 8일 이상이다. ADR 산식(440쪽 × 40문단 ÷ 3)으로는 5,867창, 약 15일이다.
- **수정:** WP-21을 "L0, L1, 첫날 L2, 표본 에이전트 수집, 인수 통과"까지로 자르고, 남은 L2는 수동 `kb agent run` 런북으로 넘긴다. 4단계는 L2 완료를 기다리지 않는다. 완료 보고에 큐 잔량과 예상 일수를 적는다.

#### PLAN-19 패키지 실패 때의 동작이 정의되지 않았다

- **위치:** 2.1 골격, 1장 재시도, 3장
- **결함:**
  - 에이전트가 죽으면 `null`이 되고 `filter(Boolean)`로 사라진다. 로그도 패키지 이름도 남지 않는다.
  - `status: blocked`도 그대로 Review로 간다.
  - 다음 파동을 시작해도 되는 조건이 없다.
  - 막힌 패키지의 부분 산출물을 합칠지 버릴지 없다.
  - 3회 규칙은 에이전트 안의 규칙이고, 그 뒤 재시도 주체가 없다.
  - `resumeFromRunId`는 바뀌지 않은 호출을 캐시로 재생하므로 `blocked` 결과도 재생된다. 앞쪽 호출을 바꾸면 뒤쪽 호출이 전부 다시 돈다.
- **근거:** `[원문]` 2.1 골격, workflow 참조. 파급 범위는 8장 표다. WP-21까지의 길에 15개 패키지가 있고 그중 하나만 막혀도 1차 수집이 멈춘다.
- **수정:** 골격에서 패키지 ID와 함께 `null`을 `log`로 남기고 `blocked`는 Review에서 뺀다. 파동 관문을 1장에 둔다. 의존 패키지가 전부 `done`일 때만 다음 파동 대상이 되고, 무관한 패키지는 진행한다. 재시도는 실패 패키지만 새 `args.packages`로 돌린다. 안 2를 택하면 스냅샷으로 되돌린 뒤 돌린다.

#### PLAN-20 저장소·머신 상태 때문에 실행할 수 없는 인수 조건

- **위치:** WP-11, WP-14, WP-16, WP-00 인수 조건
- **결함과 근거:**

| 패키지 | 조건 | 문제 | 근거 |
|---|---|---|---|
| WP-11 | oasdiff 기준선은 마지막 커밋본 | 커밋이 없다 | `[재현]` `git show HEAD:...` exit 128 |
| WP-14 | `xmllint --noout` | 이 머신에 없다. 설치는 시스템 변경이다 | `[재현]` `xmllint` 없음, `libxml2-utils` 미설치 |
| WP-14 | `systemd-analyze --user verify` | `runtime/bin/kb`가 없으면 실패한다. 와일드카드로 WP-20의 `kb-rank.service`도 걸린다 | `[재현]` `Command ... is not executable`, exit 1. `/bin/true`로 바꾸면 exit 0 |
| WP-16 | `trail build && git status --short .gitignore`가 변경 없음 | 커밋 없는 저장소에서는 늘 `?? .gitignore`가 나온다 | `[재현]` 1줄 출력 |
| WP-00 | `sha256sum CLAUDE.md ...` | `CLAUDE.md`가 미추적이라 worktree에 없다 | `[재현]` 다음 파동 worktree에 `.git`만 있었다 |

- **수정:** WP-11은 저장소에 `docs/contracts/openapi.baseline.yaml`을 두고 비교한다. WP-14는 `ops/bin/dev python -c "from lxml import etree; etree.parse(...)"`로 바꾸고, `verify`는 PLAN-02의 배포 뒤로 옮기거나 임시 스텁 실행 파일로 돌린다. WP-16은 `.gitignore`의 해시를 앞뒤로 비교한다.

#### PLAN-21 전역 상태에 기대는 인수 조건이 비결정적이고 금지 문장과 충돌한다

- **위치:** WP-00, WP-12, WP-16 인수 조건, 2.2 `incidents` 규칙
- **결함:** 이 머신의 전역 파일은 다른 세션이 계속 바꾼다. 패키지 시작 때와 끝 때를 비교하면 거짓 실패와 거짓 사고가 난다. 또 실제 `claude -p`는 그 자체로 `~/.claude.json`, `~/.claude/`에 쓰는데, WP-16은 이 파일들을 바꾸지 말라고 하고 2.2는 작은 일도 사고로 적으라고 한다.
- **근거:**
  - `[재현]` `~/.claude.json` 해시가 내 쓰기 없이 7분 사이 3번 달랐다(21:11:34, 21:15:56, 21:18:13).
  - `[재현]` `~/.zshrc`가 감사 중 21:23:17에 다른 세션 작업으로 바뀌었다(4,234에서 4,454바이트). WP-00의 "패키지 시작 때 값과 같음"은 이 경우 실패한다.
  - `[재현]` 가짜 HOME의 비로그인 `claude -p`도 `.claude.json`, `.claude/backups/`, `.claude/projects/<cwd>/<uuid>.jsonl`을 남긴다. 전사는 `--no-session-persistence`로 빠지지만 나머지는 남는다. 로그인 실행도 같을 것이다 `[추론]`.
- **수정:** 스크립트 단위 시험은 가짜 HOME과 가짜 `claude`로 바꾼다. 예를 들어 `register-user.sh`는 호출을 기록하는 스텁으로 검증한다. 전역 해시 비교는 패키지 시작과 끝이 아니라 해당 명령 직전과 직후로 좁힌다. 실제 `claude -p` 기록의 처리는 결정 D로 적는다.

#### PLAN-22 사람이 있어야 하는데 표시가 없는 조건, 달성할 수 없는 완료 기준

- **위치:** WP-18 인수 조건 6번, WP-14 인수 조건 5번, 2.2 `status`, 7장 완료 기준 1
- **결함:** WP-18의 `eval/run.py --suite smoke`는 `.cases > 0`을 요구하는데 지시는 사람이 확인한 표본만 쓰고 자기 출력으로 정답을 만들지 말라고 한다. 에이전트 혼자 통과할 길이 없고 `[사용자 입회]` 표시도 없다. 표시가 붙은 조건은 WP-14 하나뿐이다. `status`는 `done`, `blocked`뿐이라 WP-14는 입회 조건을 남긴 채 `done`을 낼 수 없다. 완료 기준 1은 WP-00~19의 조건 전부 통과인데 기준 4는 재부팅 시험 전임을 보고하라고 한다.
- **근거:** `[원문]` 해당 지시와 표.
- **수정:** WP-18 6번을 평가기 시험과 `[사용자 입회]` 골든 시험으로 나눈다. `status`에 `done_pending_user`를 더하고 조건별 `gate` 필드를 둔다. 완료 기준 1에서 `[사용자 입회]`를 뺀다.

#### PLAN-23 패키지 사이의 JSON 필드가 정의되지 않아 마지막 시험이 깨진다

- **위치:** WP-05, WP-15, WP-19, WP-21 인수 조건
- **결함:** WP-21이 읽는 필드를 만드는 패키지의 지시에 그 필드가 없다.
- **근거:** `[재현]`

| 조건 | 어긋나는 경우 | 결과 |
|---|---|---|
| `.incidents.open == 0` | WP-15가 `incidents`를 배열로 내면 | `jq` 오류, exit 5 |
| `.counts.claims_active`, `.entities`, `.snapshots` | WP-15 지시에는 `counts`만 있다 | 이름이 다르면 실패 |
| `kb search ... | jq ".items"` | 봉투 형식이면 `.data.items`다 | `false`, exit 1 |
| `.windows == 1` | 같은 줄이 "큐가 비면 windows 0 허용"이라고 적었다 | `false`, exit 1 |

- **수정:** `kb status --json`, `kb search --json`, `kb agent run --json`, `kb tick --json`의 스키마를 `schemas/cli/`에 두고 2.3에 올린다. WP-19 조건은 `.windows <= 1`로 고치고 큐 비어 있음을 별도로 검사한다.

#### PLAN-24 활성 소스의 본문을 텍스트로 만드는 경로가 비어 있다

- **위치:** WP-07 지시, ADR 10.4, ADR 16, `sources-inventory.md` M-13
- **결함:** `display_text`는 Markdown, HTML만 다룬다. 활성 D 소스의 실제 내용은 PDF인 곳이 있고 PDF 판독기가 없다. 어댑터 목록에 sitemap(C09, C15), CSV(U04), HTML 목록(C08)도 없다. 어댑터가 없으면 색인 페이지만 들어온다.
- **근거:** `[재현]` 잠금에 `pypdf`, `pdfminer`, `fitz`가 없다. `[원문]` 인벤토리 M-13은 `kmcc.go.kr/download.do`와 나스미디어 NPR을 PDF로 받았고, NPR은 14쪽에 추출 텍스트 1,173자로 이미지 위주다. ADR 16은 원본 형식에 PDF를 적었다. 도메인 B, E의 수치가 1차 수집에서 빠진다 `[추론]`.
- **수정:** 소스별로 `needs_pdf`, `needs_ocr`를 표시하고 PDF 판독기 하나를 고정한다. 이미지 위주 문서는 비활성으로 내린다. `sitemap`, `csv`, `html_index` 어댑터를 WP-07에 넣는다. WP-21 보고에 소스별 본문 문자 수를 적는다.

#### PLAN-25 `mode=hybrid`를 켜는 패키지가 없다

- **위치:** WP-05, 10, 12, 20, 7장 마지막 문장, 2.3
- **결함:** 계획은 "WP-20이 끝나면 `mode=hybrid`가 켜진다"고 적지만 `search()` 시그니처에 `mode`가 없고 `kb.rank`는 2.3에 없다. WP-20은 `src/kb/serve/`, `src/kb/read/search.py`를 고칠 수 없다. WP-10과 WP-20은 같은 파동이고, WP-12는 WP-20에 의존하지 않으면서 소켓을 쓰라고 받는다.
- **근거:** `[원문]` 2.3과 소유 경로.
- **수정:** 2.3에 `kb.rank.client.search(q, ctx, ...) -> Ranked | None`을 고정하고, 없으면 어휘 경로로 내려가게 한다. WP-05의 `search()`에 `mode`를 넣는다. WP-10, 12는 이 함수만 부른다.

#### PLAN-26 `export_md`의 자동 로컬 커밋이 ADR 22와 어긋난다

- **위치:** WP-13 지시, ADR 17.1, ADR 22
- **결함:** ADR 22는 "커밋과 푸시는 사용자가 요청할 때만 한다. 내보내기 저장소도 같다"고 적었다. ADR 17.1과 WP-13은 `kb export markdown`이 로컬 커밋까지 한다고 적었고, 앵커도 그 커밋에 넣는다. 주기 실행에 묶이면 요청 없는 커밋이 자동으로 쌓인다. first_party 개방 전에는 대상이 없어 발동하지 않는다.
- **근거:** `[원문]` ADR 줄 1008, 1190, WP-13.
- **수정:** 결정 F로 정하고 한쪽 문장을 고친다. 허용하지 않으면 작업 트리까지만 쓰고 앵커는 머신 밖 경로에 맡긴다.

### 4.3 minor

#### PLAN-27 robots가 막는 활성 소스와 분류 공백

- **위치:** WP-06, ADR 10.4, ADR 12 실패 표
- **결함:** "robots.txt 준수"인데 X11, X15, D11은 `User-agent: *`에 `Disallow: /`다. WP-07은 `netflix_tsv`, `arxiv` 어댑터를 만들지만 실제로는 수집되지 않는다. ADR 12 실패 표에 robots 거부 분류가 없다. 또 U08은 `feeds.feedburner.com`으로 리다이렉트된다.
- **근거:** `[재현]` 활성 소스 대표 URL 53건을 `kb-collector/0.1.0`으로 조회하니 전부 200 또는 206이었고 robots 거부는 3건이었다. arXiv API는 robots와 달리 200을 준다.
- **수정:** 결정 G로 소스별 처리를 적는다. `policy.robots: api_exempt`처럼 명시하거나 비활성으로 내린다. 실패 표에 `robots_denied`를 넣는다.

#### PLAN-28 소스 분류가 비어 있는 항목

- **위치:** ADR 10.4, 11, WP-07 `test_registry`
- **결함:** 활성인데 클래스가 없는 소스가 O08, O13, U06, U16이다. D16은 클래스는 있으나 활성도 비활성도 아니다. X06, X13, L07도 어느 목록에도 없다.
- **근거:** `[재현]` ADR 목록과 인벤토리 111개 ID를 기계 대조했다.
- **수정:** ADR 표에 빠진 항목을 넣는다.

#### PLAN-29 WP-00 세부 공백

- **위치:** WP-00
- **결함과 근거:**
  - `[재현]` `optional group`으로 만든 뒤 글자 그대로 `uv run --frozen pytest`를 돌리면 `Failed to spawn: pytest`다. `--all-extras`가 필요하다.
  - `[원문]` `-m perf` 마커 등록과 기본 제외가 없어 `pytest tests/core -q`에 성능 시험이 섞일 수 있다.
  - `[원문]` `.gitignore`에 `.pytest_cache/`, Claude Code worktree 폴더가 없고 WP-00만 고칠 수 있다.
- **수정:** 세 가지를 WP-00 지시에 넣는다.

#### PLAN-30 선언되지 않은 의존

- **위치:** 3장 의존 표
- **결함:** 파동 순서 덕분에 돌지만 `depends_on`에 없는 의존이 있다. 부분 재실행이나 파동 조정에서 깨진다. 같은 파동 안의 WP-17, WP-18은 서로의 결과를 볼 수 없다.
- **근거:** `[재현]` 기계 교차 참조와 읽기.

| 패키지 | 빠진 의존 | 이유 |
|---|---|---|
| WP-07 | WP-04 | `kb get` |
| WP-08, WP-09 | WP-05 | 기본 검색 복귀·제외 시험 |
| WP-10, WP-11 | WP-03 | 쓰기 동시 시험, `held` 응답 |
| WP-12 | WP-13 | `kb ship` |
| WP-14, WP-17 | WP-15 | `kb status` |
| WP-15 | WP-04 | `counts` |
| WP-17 | WP-09 | `kb-liveness-review` |
| WP-18 | WP-17 | `kb-retro`, `kb-agent-run`. 같은 파동이다 |

- **수정:** 의존을 더하고 WP-18을 파동 9로 옮긴다.

#### PLAN-31 주인 없는 운영 동작

- **위치:** ADR 7.9, 10.5, 17, 빌드 계획 소유 경로
- **결함과 근거:** `[원문]` 다음은 설계에 있으나 만드는 패키지가 없다.

| 항목 | 상태 |
|---|---|
| `runtime/wheels/` | ADR 17.4 복원 절차가 쓰는데 채우는 패키지가 없다. 복원 런북이 그 단계에서 막힌다 |
| `record.redact` 실행 명령 | `kb redact`가 없다. `claim.retract`, `record.tombstone`도 없다 |
| inbox 주기 처리 | tick 단계와 내부 작업 표에 없다. `kb inbox`를 손으로 돌려야 한다 |
| `KB_CLAUDE_BIN` | `env.sh` 목록에 없다. WP-14, 17, 19가 각자 정해야 한다 |
| `src/kb/core/config.py` | 소유만 있고 지시가 없다. `lexical.rare_only`, `push_allowed`가 여기 있어야 한다 |
| `kb-agent.service`, `kb jobs` | 소유만 있고 내용이 없다 |
| `~/.config/sagae-kb/api-tokens` | 만드는 절차가 없다 |

- **수정:** 표의 항목을 각 패키지 지시에 배정한다. `runtime/wheels/`는 WP-13, `KB_CLAUDE_BIN`과 config는 WP-00이 맞다.

#### PLAN-32 작은 지시 모순

- **위치:** 각 패키지
- **결함과 근거:** `[원문]`
  - WP-16은 `.mcp.json`에 `kb-collect`를 넣는데 ADR 15.1은 일반 세션에 노출하지 않는다고 적었다.
  - WP-05는 의존성이 없어야 한다면서 `schemas/aliases/*.yaml`을 읽는다. PyYAML은 `collect` 그룹이고 `kb.read`는 표준 라이브러리다.
  - `sources/first-batch.yaml`은 `kb tick`이 읽지 않는다. 시험 전용 문서가 되고 G 먼저, A~F 나중 순서를 강제하지 못한다.
  - WP-08의 `--no-fetch`는 의미가 없다. `url` 스냅샷은 인용구를 확인할 본문이 없는데 `rejected == 0`을 요구한다.
  - 2.1이 쓰는 `WP_REVIEW` 스키마가 2.2에 없다.
  - `agent:<세션>`의 세션 값을 MCP 서버가 어디서 얻는지 없다.
  - 워크플로우는 `Math.random`을 쓸 수 없는데 표본 감사는 무작위 50건이다. 시드를 `args`로 받아야 한다.
  - 소비자 문서가 계획 작성 뒤(21:06) 갱신돼 `openapi.yaml` 초안을 WP-10 구현 전에 달라고 요청했다. 이 파일은 파동 5의 WP-10만 쓸 수 있다. 계약 내용은 `audit-final-contract.md`의 CTR-04가 다룬다.
- **수정:** 각 줄을 해당 지시에 반영한다. `openapi.yaml` 초안은 파동 0~2의 별도 소형 패키지로 빼고 WP-10이 이어받는다.

## 5. 패키지별 판정

"가능"은 지시만 읽고 구현할 수 있다는 뜻이다. 공통 요인 PLAN-01, 02, 05, 10, 14는 전 패키지에 걸리므로 표에서 뺐다.

| 패키지 | 판정 | 막는 요인 |
|---|---|---|
| WP-00 | 부분 | PLAN-09, 29, 31. `deploy --dry-run`은 PLAN-02 |
| WP-01 | 부분 | PLAN-06, 12, 13 |
| WP-02 | 불가 | PLAN-06, 12, 13 |
| WP-03 | 가능 | PLAN-32(세션 값) |
| WP-04 | 가능 | PLAN-06, 13(`/v1/schema` 재료) |
| WP-05 | 부분 | PLAN-11, 25, 32 |
| WP-06 | 불가 | PLAN-03, 15 |
| WP-07 | 불가 | PLAN-03, 04, 06, 24, 28 |
| WP-08 | 부분 | PLAN-32(`--no-fetch`), PLAN-30 |
| WP-09 | 부분 | PLAN-03(`internal.yaml`), PLAN-30 |
| WP-10 | 가능 | PLAN-25, 30 |
| WP-11 | 부분 | PLAN-20 |
| WP-12 | 부분 | PLAN-21, 25 |
| WP-13 | 가능 | PLAN-03, 26, 31 |
| WP-14 | 불가 | PLAN-20, 22, 31 |
| WP-15 | 부분 | PLAN-03, 23 |
| WP-16 | 부분 | PLAN-16, 20, 21, 32 |
| WP-17 | 불가 | PLAN-07, 17 |
| WP-18 | 불가 | PLAN-03, 22, 30 |
| WP-19 | 부분 | PLAN-03, 12, 23 |
| WP-20 | 부분 | PLAN-25, 31 |
| WP-21 | 불가 | PLAN-04, 17, 18, 23, 24 |

## 6. 인수 조건 분류

계획의 인수 조건은 137개다. 사용자 입회 표시는 WP-14의 1개뿐이다.

| 분류 | 조건 | 비고 |
|---|---|---|
| 네트워크 | WP-00 1·3번, WP-05 평가, WP-06 `kb fetch`, WP-07 `kb tick --only`, WP-11 `contract-check`와 `npx`, WP-13 전 시험(restic 내려받기), WP-20 평가, WP-21 대부분 | 결정적이지 않다. 원격 변동의 영향을 받는다 |
| 구독 사용량 | WP-12 `test_claude_real`(상한 0.03), WP-16 `test_real_session`(0.03), WP-19 `kb agent run --max-windows 1`(0.02), WP-21 L2와 에이전트 | Review가 다시 돌리면 앞 3개는 2배가 된다. 합계 최대 $0.16 `[추론]` |
| 긴 시간 | WP-01 `test_kill`, WP-02 쓰기 중 교체, WP-04·05·10 성능, WP-20 평가(모델, 약 6 GB venv), WP-21 tick 최대 45분, L2 8~15일 | 에이전트 Bash 전경 상한은 10분이라 45분 조건은 배경 실행이 필요하다 |
| 사람 필요, 표시됨 | WP-14 5번 | 결정 3 뒤 |
| 사람 필요, 표시 없음 | WP-18 6번(골든 표본) | PLAN-22 |
| 전역 상태 의존 | WP-00 6번, WP-12 7번, WP-14 3번, WP-16 3번 | PLAN-21 |
| GPU | WP-20 평가 | RTX 4080 SUPER, 유휴 11 GB. 조건 3 GB 충족 |
| 머신 도구 없음 | WP-14 `xmllint` | PLAN-20 |

## 7. 고정 버전 설치 실측

전부 격리 환경에서 시험했다. 가짜 HOME 파일은 PLAN-09의 경우 외에는 0개다.

| 항목 | 고정값 | 결과 |
|---|---|---|
| uv 설치 스크립트 | 0.13.6, sha256 `f7a56e7a...` | 해시 일치. `UV_UNMANAGED_INSTALL`로 HOME 파일 0 |
| CPython | 3.14.10, `--no-bin --install-dir` | 4초 설치, HOME 파일 0 |
| SQLite, zstd | ≥ 3.51.3, `compression.zstd` | 3.53.1, 1.5.7. FTS5 `contentless_delete`, JSONB 동작 |
| 의존성 해결 | WP-00 목록 전체 | 80개 패키지 해결, `--all-extras` 76개 설치, venv 137 MB |
| serve | mcp 2.3.0, starlette 1.10.0, uvicorn 0.54.0 | `MCPServer`, `tool(meta, structured_output)`, `Server.serve(sockets)`, `TestClient` 확인 |
| collect | feedparser 6.0.14, trafilatura 2.3.1, lxml 6.1.3, pyyaml 6.0.3, jsonschema 4.26.0 | 전부 import, 한글 HTML 추출과 RSS 파싱 동작. `hidden` 문단은 Trafilatura가 남기므로 WP-07의 전처리가 정말 필요하다 |
| dev | schemathesis 4.32.7, openapi-spec-validator 0.9.0 | OpenAPI 3.1.1 문서 `python -m openapi_spec_validator` exit 0 |
| 바이너리 | restic 0.19.1, oasdiff 1.35.0 | 릴리스 자산과 체크섬 파일 있음 |
| npm | openapi-typescript 7.13.0 | 있음. peer `typescript ^5.x` |
| 기존 도구 | Node 26.13.0, rtk 1.1.0, trail 0.28.1, claude 2.1.316 | 일치. `--max-turns`는 `--help`에 없으나 조사 실측에서 동작 |
| 모델, 데이터 | KURE-v3, KURE-Reranker-nano, `mteb/Ko-StrategyQA` | Hugging Face API 200 |

## 8. WP-21 판단과 실패 전파

### 8.1 사용자 결정 없이 무엇을 수집하는가

ADR 10.4 활성 67개 ID가 대상이다. G1~G5, A~F 문서형, 저장소 약 140개, npm·PyPI 메타다. 여기에 문제가 셋 있다.

- D18, D19는 `www.youtube.com`이다(PLAN-04).
- D13, D15, D22는 YouTube·Google 자산이고 U08은 Feedburner를 거친다.
- 약관이 미확인이거나 재사용 허가가 필요한 소스가 섞여 있다. D01은 재사용에 허가 절차가 있다고 적혔고, D03, D09~D12, D17, D20, D21, D23, X11은 인벤토리에 약관이나 이용 조건이 미확인으로 적혀 있다. 저장이 재사용인지는 사용자 판단 대상이다.

도메인 A의 키워드 데이터는 없고, 계획이 이 사실을 보고하도록 적은 것은 맞다.

### 8.2 비용과 사용량 상한

| 단계 | 상한 | 판정 |
|---|---|---|
| L0, L1 | LLM 없음. `--max-runtime 45m` | 있음 |
| L2 | 호출 $0.02(사후 검사), 일일 400창, 동시 4, 활용률 0.5·0.7 | 있음 |
| `needs_review` 함의 판정 | "일일 상한 안에서". 값이 없다 | 값 없음 |
| `kb-first-collect` | 없음 | PLAN-17 |
| `kb-verifier` 50건 | `maxTurns: 6`, 총량 없음 | 약함 |

### 8.3 끝난 뒤 조회되는가

설계상 된다. CLI `kb search`, `kb get`, `kb api`로 읽고, 이 저장소 세션은 `.mcp.json`으로 읽는다. HTTP는 결정 3, 다른 프로젝트 세션은 결정 7 뒤다. 다만 현재 계획대로면 PLAN-02, 05, 13, 23 때문에 인수 시험이 실패하거나 일부 응답이 빈다. `counts.claims_active >= 1000`은 L2 하루 400창에 C01 결정적 주장을 더하면 닿을 수준이다 `[추론]`.

### 8.4 패키지 하나가 실패하면

의존 폐포로 센 값이다. 숫자는 함께 멈추는 패키지 수다.

| 패키지 | 멈추는 수 | WP-21 영향 | 패키지 | 멈추는 수 | WP-21 영향 |
|---|---:|---|---|---:|---|
| WP-00 | 21 | 있음 | WP-09 | 1 | 있음 |
| WP-01 | 19 | 있음 | WP-12 | 3 | 있음 |
| WP-02 | 18 | 있음 | WP-13 | 2 | 있음 |
| WP-03 | 12 | 있음 | WP-15 | 1 | 있음 |
| WP-06 | 10 | 있음 | WP-17 | 1 | 있음 |
| WP-04 | 9 | 있음 | WP-19 | 1 | 있음 |
| WP-05 | 8 | 있음 | WP-10 | 2 | 없음 |
| WP-07 | 7 | 있음 | WP-11, 14, 16, 18, 20 | 0 | 없음 |
| WP-08 | 6 | 있음 | | | |

재개는 부분적으로 된다.

| 대상 | 재개 | 설명 |
|---|---|---|
| `kb tick` | 됨 | 다음 tick이 잇도록 설계됐다 |
| L2 | 됨 | 문단 캐시 키로 이어 간다 |
| 적재 묶음 | 됨 | `batch_id:ref` 멱등 |
| 패키지 구현 | 안 됨 | 부분 산출물 처리와 재시도 주체가 없다(PLAN-19) |
| `kb-first-collect` | 불명 | 조사상 `--resume`과 `resumeFromRunId`가 되지만 계획에 절차가 없다 |
| 실운영 원장 오염 | 안 됨 | 지울 수 없다(PLAN-14) |

## 9. 확인해서 통과한 항목

- 고정 버전은 전부 설치되고 동작한다(7장).
- 파동 순서는 명시적 의존과 맞다. 뒤 파동을 참조하는 명령은 WP-16 훅 3건뿐이고 지시가 "`kb`가 없으면 조용히 끝난다"고 처리했다.
- `trail build`는 `/graft/`가 미리 있으면 `.gitignore`를 바꾸지 않고 가짜 HOME 파일도 0개다.
- rtk 재작성은 `rg` 무결과의 `출력 0줄` 조건을 깨지 않는다. 재작성 뒤에도 0줄이다.
- 성능 기준에 여유가 있다. SQLite FULL 단일 쓰기 p99는 단독 2.13 ms, 부하(입출력 2 + CPU 4) 14.24 ms, 부하(입출력 6 + CPU 12) 35.76 ms로 WP-01의 50 ms 아래다. 체인 계산을 뺀 근사치다.
- C01 실제 크기는 1,130,515바이트로 `min_bytes: 500000`을 만족하고 `raw.githubusercontent.com` robots는 404다.
- `kb-collector/0.1.0` UA는 대표 URL 53건에서 전부 응답을 받았다. 인벤토리는 브라우저 UA로 잰 값이었다.
- 승인 대상 스크립트 `install-units.sh`, `register-user.sh`는 기본 건식 실행으로 지시돼 있다.
- 디스크 여유 947 GB는 tick 문턱 50 GB를 넉넉히 넘는다. systemd 사용자 매니저, `systemd-socket-activate`, `jq`, `rg`, `gh`도 있다.
- 공유 트리에서 8개 병렬 `uv run --frozen`은 전부 성공했다.
- CLAUDE.md의 `incidents`와 개인 정보 규칙은 실제로 있다(61, 62행).

## 10. 재현 방법과 부수 효과

스크립트는 스크래치패드 `audit/plan/`의 `e1.sh`(worktree), `e4.sh`~`e7.sh`(uv, 설치, 공유 venv, 배포본), `e8.py`, `e9.py`(robots, UA), `e10.sh`(systemd, 전역 파일), `e11.sh`(`claude --help`, trail), `e12.py`(소스 대조), `e13.sh`(`claude -p` 쓰기), `e14.py`(이벤트 작성자), `e15.sh`(rtk), `e16.sh`(추출, 병렬 `uv run`), `perf.py`, `xref.py`다. tmpfs라 재부팅하면 사라지므로 핵심 명령은 각 결함에 적었다.

| 항목 | 내용 |
|---|---|
| 저장소 | 이 파일만 추가했다. 커밋하지 않았다. `git worktree`는 임시 저장소에서만 돌렸다 |
| 전역 파일 | 내가 바꾼 것은 없다. `~/.local/share/uv`, `~/.trail`, `~/sagae-kb-data`는 끝까지 없었다. rtk `history.db` 수정 시각은 20:19:55 그대로다. crontab과 `~/.config/systemd/user`도 그대로다 |
| 관측한 변경 | `~/.zshrc`가 21:23:17에 바뀌었다(4,234에서 4,454바이트, 끝부분은 Orca용 `claude()` 함수). 내 명령에는 이 파일을 쓰는 동작이 없고 같은 시각 다른 저장소 세션들이 돌고 있었다. 원인 세션은 확인하지 못했다. 사용자 확인 대상이다 |
| 감사 중 바뀐 대상 문서 | `docs/contracts/consumers/sagae-tools.md`가 21:06:35에 다른 세션의 회신으로 갱신됐다(9,674에서 10,263바이트). 내가 쓴 것이 아니다. 관제 서버 tower는 KB MCP만 쓰고 HTTP 소비자는 `loupe serve`라는 정정과 `openapi.yaml` 초안 요청이 추가됐다. `openapi.yaml` 요청은 PLAN-32에 반영했고, tower 정정은 이 감사의 판정을 바꾸지 않는다 |
| rtk, trail, claude | HOME을 격리해 실행했다. `claude -p`는 비로그인 가짜 HOME에서 돌아 API 호출 0, 비용 0이다 |
| 외부 요청 | 공개 읽기만 했다. astral.sh, PyPI, GitHub, npm, Hugging Face, 활성 소스 대표 URL과 robots.txt다. UA는 `kb-collector/0.1.0` 또는 curl 기본값이고 개인 정보는 넣지 않았다. `youtube.com`, `google.com` 호스트는 일부러 뺐다 |
| 예외 | U08 `news.hada.io/rss/news`가 Google 소유 `feeds.feedburner.com`으로 리다이렉트돼 GET 1회가 나갔다. 금지 경로(자동완성, InnerTube, yt-dlp)는 아니다 |
| 부하 | 측정 중 약 20초간 CPU와 디스크를 썼다. 부하 평균 최대 약 7.8이다 |
| 디스크 | `~/.cache/sagae-kb/scratch/audit/plan`의 큰 폴더는 끝낸 뒤 지웠다 |
