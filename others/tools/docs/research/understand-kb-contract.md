# sagae-knowloge-base read contract

Snapshot taken 2026-10-31 about 15:58 KST. The KB project is changing while this is written, so re-check before relying on it.

## Bottom line

**There is no read contract yet, because there is no database yet.** `/home/user/sagae-knowloge-base` holds one `CLAUDE.md` and four research reports. It has no code, no schema, no data store, no scheduler, no MCP server and no commits. A KB session is in its first phase right now, the design workflow `kb-foundation-design`. That workflow will decide the storage engine, data model and read interface in a file that does not exist yet: `docs/adr/0001-architecture.md`.

Three points matter most for the viewer design:

1. **Do not bind to a schema now.** Everything in section 3 is a stated requirement or a measured candidate, not a schema.
2. **The planned read boundary was specified for Claude sessions, not a visual tool.** R9 names "다른 프로젝트의 Claude Code 세션" as the consumer and requires id-first, token-budgeted responses. A graph or timeline view needs bulk reads. No KB document names a viewer as a consumer.
3. **The window to influence that is open now, and it closes.** The workflow still has Design, Judge and Decide phases to run. Whether to send KB a reader requirement is the user's decision; see section 8.

## 1. Project, maturity, git

| Item | Value | Evidence |
|---|---|---|
| Purpose | "사용자가 원하는 정보를 수집·적재해 두고, 다른 세션의 요청에 반환하는 **정보 저장소** 워크트리" | `CLAUDE.md:3` |
| Maturity | Pre-design. No implementation of any layer | `ls -la`; `find` for `.claude`, `.trail`, `*.db`, `pyproject.toml`, `package.json` returned nothing |
| Git | Is a repo. Branch `main`, **zero commits**, no remote, one worktree, no stash. `CLAUDE.md` and `docs/` are untracked | `git status -sb`: "No commits yet on main"; `git count-objects -v`: 0; `.git/config` has no remote |
| Commit policy | "커밋과 푸시는 사용자가 요청할 때만 한다" | `CLAUDE.md`, 작업 규칙 |
| Live session | Session `b32eef31-...`. Workflow `wf_a0640bc9-66f` was in Research at the time of reading | `journal.jsonl` has 3 results of 8 agents (prep, harness, prior-art). compression, graph-store, etl-orchestration, retrieval-serving and sources-inventory had no journal result yet |

Workflow phases: Prep, Research, Design, Judge, Decide. Source: `~/.claude/projects/-home-sagae-sagae-knowloge-base/b32eef31-b09c-4e58-8902-431f279117b3/workflows/scripts/kb-foundation-design-wf_a0640bc9-66f.js`, lines 213, 222, 232, 252, 273.

The session's own status text describes three stages: stage 1 is this design workflow, stage 2 is the build, and stage 3 is collection (transcript 06:15 and 06:27 UTC). The script says "구축 후 곧바로 1차 수집을 시작한다" (line 288).

## 2. Data stores

**No data store exists.** A real knowledge store holds zero records anywhere checked.

| Candidate location | Result | Evidence |
|---|---|---|
| KB repo | No DB or vault. Only 5 files, none of them knowledge data | `ls`, `find` |
| Home directory (depth 4) | No `*.sqlite`, `*.sqlite3`, `*.duckdb`, `*.kb`, `kb.db`, or knowledge-named data directory. Only the repo and Claude project directories matched | `find /home/user -maxdepth 4 ...` |
| Proxmox | Only guest visible: `qemu/100 minecraft-server`. No KB guest | `list_resources type=vm` (read-only MCP) |
| Scheduler | No crontab. User timers are only 3 Ubuntu system timers | `crontab -l`; `systemctl --user list-timers --all` |
| Plugin | `sagae` marketplace has only `proxmox`. `~/.claude/plugins/data` has only `proxmox-sagae` | `.claude-plugin/marketplace.json`; `ls` |
| Remote | None. No git remote | `.git/config` |

What does exist on disk:

| Path | Kind | Size | Real knowledge data? |
|---|---|---|---|
| `CLAUDE.md` | Markdown | 3,720 B | No, operating rules |
| `docs/research/compression.md` | Markdown | 60,578 B, 746 lines | No |
| `docs/research/harness.md` | Markdown | 60,332 B, 517 lines | No |
| `docs/research/prior-art.md` | Markdown | 48,194 B, 526 lines | No |
| `docs/research/sources-inventory.md` | Markdown | 61,787 B, 677 lines | No, though it is the nearest thing to data: a source catalogue |

Total for `docs/research`: 230,891 B. `prior-art.md:4` and `harness.md:5` state these are design documents, not knowledge data. Three more reports are expected at `docs/research/{graph-store,etl-orchestration,retrieval-serving}.md` (script line 56).

**Do not mistake these for the KB:**

- `/tmp/claude-1000/-home-sagae-sagae-knowloge-base/b32eef31-.../scratchpad/` holds benchmark DBs (`graph-store/dbs/{fk,lb,sq}`) and test corpora (`retrieval/data*`). They are synthetic or benchmark data on tmpfs, not the KB.
- `retrieval/scripts/kb_http_logged.py` (running as a process) and `retrieval/plugin-kb/` are throwaway probes.
- `~/.claude/plugins/data/kb-inline/` was a test directory and was removed (`harness.md:446`).

Evidence for the graph choice is at risk. `/tmp` is a shared 16 GB tmpfs, at 89% during this check (`df -h /tmp`), and research agents reported it reaching 98 to 100% earlier in their transcripts. Scripts there are not preserved (`prior-art.md:466`).

## 3. Schema

**No schema exists: no entities, frontmatter keys, IDs, taxonomies or embeddings are defined.** The sample data requested does not exist, so none is included. What follows is requirement text, which is firm but abstract, then decision inputs, which are not decisions.

### 3.1 Stated requirements (binding on the design, from the workflow script lines 129-143)

| Req | Text | Implication for a reader (inferred) |
|---|---|---|
| R1 | "모든 출처를 내용 해시 기반 불변 스냅샷으로 저장한다" | A snapshot entity with content hash should exist; a viewer could show the source as captured |
| R2 | "그래프 DB와 인덱스는 파생물이며 원시 계층에서 결정론적으로 재구축할 수 있다" | Query-layer files may be replaced on rebuild. Do not assume file identity, and internal row IDs may not survive |
| R3 | "모든 정보는 노드·엣지로 표현하고 사실은 엔티티 간 관계로 연결한다" | Graph edges are a requirement, so typed edges should exist |
| R4 | "유효 시점과 관측 시점을 구분한다. 갱신은 삭제가 아니라 대체이며 과거 값이 시계열로 남는다" | Two time axes, and superseded records stay present |
| R5 | "주장은 스냅샷 안의 원문 인용구와 연결한다. 인용구가 스냅샷에서 기계적으로 확인되지 않는 주장은 검증됨 상태가 될 수 없다" | Claim to quote to snapshot links, plus a verification status |
| R6 | "자체 점수, 추천, 시각화를 만들지 않는다" | The store has no score fields to rank by |
| R7 | "데이터 클래스별 갱신 주기, 다음 확인 시각, 재시도, DLQ, 사망 감지 워치독..." | Freshness metadata per source or data class may exist |
| R9 | "다른 프로젝트의 Claude Code 세션이 조회할 수 있고, 없는 정보는 요청 큐에 넣을 수 있다. 응답은 id 우선이고 토큰 예산을 지킨다" | See section 4 |
| R10 | "한국어와 영어의 하이브리드 검색(전문, 벡터, 그래프 순회)" | Search and embeddings are planned. Model and dimensions are undecided |
| R12 | "실행 지표(수율, 토큰, 실패, 신선도)를 기록" | Run metrics may be available, possibly separately from knowledge data |

Other firm content rules, from `CLAUDE.md`:

- Stored: "출처가 붙은 사실·수치·주장, 그리고 엔티티 간 관계" (line 16).
- Third-party advice is stored only as attributed claims: "출처 X가 Y라고 주장" (line 18).
- Dead data: "삭제하지 않고 대체 처리하며, 기본 검색에서 제외한다" (line 44). **A viewer querying below the KB's search layer must apply this exclusion itself**, or dead data will appear as live.
- Historical facts carry a timestamp (`CLAUDE.md`, 죽은 데이터 section).

The Design phase must specify "데이터 모델(노드·엣지 타입, 시간축, 출처 모델)" and "다른 세션용 인터페이스(MCP 도구 목록과 응답 형태)" (script line 244). The ADR will fix the "적재 계약(스냅샷·주장·엔티티·관계 제출 형식)" (line 288).

### 3.2 Taxonomy that is already firm

Collection domains (`CLAUDE.md`, 수집 범위): A 유튜브 키워드맵, B 유튜브·영상 플랫폼 시장 자료, C 트래픽 유동, D 유튜브 채널 설계, E 마케팅, F 개발, G AI 코딩 도구 활용.

Source IDs exist only as document labels: `P01`-`P14` programmatic, `X..` platform extension, `D..` document-type (`sources-inventory.md` sections 3 to 5). Domain G was added after the inventory agent started, so that inventory covers A to F only. G gets its own source survey at the start of stage 3 (transcript 06:27 UTC). Whether these IDs survive into the store is undecided.

### 3.3 Field names from candidates and source responses (not a schema)

| Origin | Fields | Evidence |
|---|---|---|
| Cognee provenance ledger, cited as reference for a Claim model | `source_quote`, `source_location`, `valid_from`, `valid_until`, `checksum`, `previous_checksum`, `previous_version_id` | `prior-art.md:418` |
| Open Knowledge Format v0.2 | `type` (required), `sources`, `generated`, `verified`, `status`, `stale_after` | `prior-art.md:416` |
| Graphiti | `valid_at`, `invalid_at`, `expired_at`, `episodes`, `source_description` | `prior-art.md:127` |
| GBrain | `provenance`, `trust_tier`, `origin`, `expired_at`, `superseded_by` | `prior-art.md:124` |
| Basic Memory | entity, observation, relation; `@effective` | `prior-art.md:128`, T1 |
| OpenViking watch | `watch_interval`, `last_status`, `last_error`, `next_execution_time`, `is_active` | `prior-art.md:131` |
| yt-dlp raw response | `view_count`, `like_count`, `comment_count`, `channel_follower_count`, `categories`, `tags`, `chapters`, `heatmap` | `sources-inventory.md:103` |

## 4. Read interfaces

**None exists.** There is no CLI, HTTP API, MCP server, query library or export, so nothing is stable.

The intended boundary, as far as it is written down:

| Item | State | Evidence |
|---|---|---|
| Consumer | Claude Code sessions in other projects | R9, script line 138; `CLAUDE.md:9` |
| Packaging | Claude Code plugin is the research recommendation: "**적용 판단: 플러그인이 맞다.**" A research finding, not yet an ADR decision | `harness.md:269` |
| Placement | In `sagae-claude-plugins` by relative path, like proxmox: "이 저장소가 GitHub에 없어도 된다. 코드와 데이터가 분리된다." | `harness.md:280` |
| Transport | stdio per session, with single host HTTP MCP as a fallback | `harness.md:275` |
| Data path | Must be absolute, via `userConfig`, `${user_config.*}` or a code default, because MCP cwd is the calling project | `harness.md:273` |
| Response shape | id-first. Measured 42,633 to 3,498 tokens on a GitHub-issue sample | `compression.md:19` |
| Prior-art pattern | GBrain MEMORY_VERBS noted as a reference for "다른 세션이 의존할 반환 계약" | `prior-art.md:420` |

The name `mcp__plugin_kb_kb__kb_ping` (`harness.md:261`) comes from a test plugin and is not a contract. `retrieval/plugin-kb/.mcp.json` uses `{"type":"http","url":"${user_config.kb_url}"}`, also a probe.

**Mismatch for a viewer (inferred).** Every planned property above is optimised against LLM token cost: id-first, budgeted, paginated. A viewer needs the opposite for some views: all nodes and edges, or a whole time series, in one read. Pulling a graph through a token-budgeted, id-first MCP tool one item at a time would be slow and awkward. No KB document mentions a non-LLM reader. The research consumer list stops at Claude sessions.

## 5. Write paths, cadence, concurrency

**There are no writers today, and no ingestion has run.** Planned, not built:

- **Trigger:** "스케줄의 주체는 호스트 스케줄러 + `claude -p`다" (`harness.md:11`). `CronCreate` and `/loop` are rejected because they die with the session.
- **Split:** deterministic collection without LLM, plus `claude -p` workflows for judgement steps (`harness.md:397`; R8).
- **Restart behaviour:** WSL2 catch-up on next boot is required by R8. Systemd behaviour here is unverified: "`Linger=no`, WSL2 유휴 종료 ... 이 조사 범위 밖이고 실행하지 않았다" (`harness.md:435`). Expect data gaps while the machine is off (inferred).
- **Cadence by source** (`sources-inventory.md` section 7): call-time values, minutes to hours (P09, P10, P04), daily (P02, P03, P08, P11, P12, X15), weekly, monthly, quarterly, half-yearly, yearly, irregular. Different sources have different resolutions, so a shared time grid should not be assumed.
- **Raw layer:** content-addressed snapshots look likely. 14 simulated days went from 675 MB plain to 10.3 MB with object CAS and zstd (`compression.md:21`). YouTube watch pages dedupe 0% (`compression.md:22`). Compression at rest may mean a viewer cannot read raw snapshots as plain files (inferred).

**Concurrency is unknown until the engine is chosen.** The only firm statement: "stdio 서버는 세션마다 뜬다. 동시 세션 수만큼 프로세스가 생기므로 DB가 다중 읽기를 허용해야 한다" (`harness.md:275`). The red team is specifically asked to attack "쓰기 잠금과 MCP 읽기 충돌, 재구축 중 조회, DB 파일 손상, 스키마 진화" (script line 261), so the ADR should address these.

Interim, unpublished results from a still-running agent. Cross-process runs with a writer at about 10 tx/s (`scratchpad/graph-store/results/`):

| Engine | Observed | Caveat |
|---|---|---|
| SQLite 3.53.1 | Readers saw new edges during the run (50,540 to 62,240). 2-hop p50 0.019 ms, p99 about 0.15 ms | Unreviewed raw log |
| LadybugDB | Reader in `once` mode saw a fixed count (51,350 at start and end). 2-hop p50 about 2.5 ms. Writer commit p50 72 ms | `once` mode may simply be one fixed connection or snapshot. Implication for long-lived readers is inferred |
| FalkorDB | Cross-process writer failed: "AF_UNIX path too long" | Test-path artefact, not a verdict on the engine |

Do not treat this as a ranking. The graph-store report has not been published.

## 6. Planned changes and statements about viewers

### Likely reader-breaking changes

Everything is about to change, because nothing is fixed. Specific items:

| Risk | Evidence |
|---|---|
| ADR picks engine, model and interface | `docs/adr/0001-architecture.md`, `docs/build-plan.md` to be written (script lines 291-292) |
| Stack is genuinely open. Four combinations remain, including Markdown plus Basic Memory, GBrain, Graphiti and Hindsight: "결정은 설계 단계의 몫이다" | `prior-art.md:432-439` |
| Rebuild replaces derived stores | R2 |
| Bitemporal supersession means "latest" needs a query rule | R4 |
| Definition breaks inside time series, such as public views unified on 2026-08-24 | `sources-inventory.md` section 8 |
| Source-specific candidates for dead data | `sources-inventory.md` section 9 |
| Candidate upstream churn. GBrain releases daily; Graphiti's missing `httpx` dependency may change upstream | `prior-art.md:60`, `prior-art.md:460` |

### Verbatim statements about viewer, UI, dashboard, graph

User instruction to the KB session (transcript 2026-10-31T06:06:26Z):

> 5. 가시화 및 판단을 제언하는 데이터를 만들지 않는다. 정보 저장소의 대한 역할만 가져야 한다.

> 6. etl/elt등 데이터 적재 및 검색을 효과적으로 다룰 수 있어야 한다. 모든 정보는 그래프화 및 관계 중심적으로 된다.

`CLAUDE.md:11`:

> 5. **저장소 역할만 한다.** 가시화·대시보드·판단/제언 데이터를 만들지 않는다.

`CLAUDE.md:17`:

> 금지: 자체 산출 점수("기회 점수" 등), 추천 순위, "~해야 한다" 형태의 자체 판단, 차트·대시보드·리포트 페이지. Artifact로 게시하지 않는다.

`prior-art.md:450-451`, features to disable on adoption:

> | Graphify, obsidian-wiki | `GRAPH_REPORT.md`, 대시보드 스킬, `graph.html` | 리포트와 가시화 |
> | claude-mem, agentmemory | 뷰어 UI | 가시화 |

Memory `project-kb-purpose.md`:

> 시장 조사에 국한하지 말고 범위를 넓게 수집하되, 저장소는 판단이나 제언을 만들지 않는다.

`prior-art.md:360`, relevant if Markdown is chosen:

> 이 계열의 파일 형식은 Obsidian 앱 없이도 쓸 수 있고, Markdown 원본이라 git 이력이 그대로 출처 이력이 된다.

**Reading of these (inferred):** the separation matches the current request. KB refuses visualization, and sagae-tools provides it, so there is no conflict. Two consequences:

- The ban covers bundled viewers inside the KB. An adopted candidate's built-in viewer is disabled by policy and should not be counted on.
- The viewer should not write scores, rankings or derived judgements back into the KB. Anything it computes stays on the viewer side.

No KB document mentions a separate viewer, `sagae-tools`, or any UI as a planned consumer.

### Constraints that apply to what a viewer displays

- **YouTube policy:** Developer Policies prohibit keeping unauthenticated statistics beyond 30 days, creating derived metrics, and aggregating for YouTube business insight. A 36-month exception applies to audited analytics use (`sources-inventory.md:14`). This is written about API clients. Whether it limits long-term view-count charts depends on which sources are actually used, and that needs a check.
- **Terms of use:** Playboard, Social Blade, YouTube and Naver prohibit or limit automated collection (`sources-inventory.md:17`).
- **Personal data:** "댓글 작성자 ID 등 개인 식별 가능 필드가 P05 응답에 포함된다" (`sources-inventory.md:417`). A viewer should not assume such fields are safe to display.
- **Untrusted content:** collected text is untrusted input, with memory poisoning documented (`prior-art.md:412`). The viewer should render it as data and escape HTML (inferred).

## 7. Natural visualizations

Nothing below can be built on real data today. "Expected" means a requirement demands it. Actual fields await the ADR.

| View | Basis | Status |
|---|---|---|
| Entity and relation graph | R3 | Expected. Edge types unknown |
| Provenance chain: claim to quote to snapshot to source | R1, R5 | Expected. Probably the most distinctive view (inferred) |
| Timeline with valid time and observed time | R4 | Expected |
| Version history of a superseded fact | R4, `CLAUDE.md:44` | Expected |
| Time series, such as keyword or chart rank | R4; sources P04, P09-P13 | Expected once collection runs. Mind source cadence and definition breaks |
| Table browse with filters by domain A to G, source, type, status | `CLAUDE.md`, R5 | Domains firm. Other columns unknown |
| Source freshness and health table | R7 | Expected. It may be a separate operational store |
| Hybrid search box | R10 | Expected, through whatever interface the KB offers |
| Document reader with `[[wikilinks]]`, Obsidian-like | Only if a Markdown option wins | Conditional |

**Available right now:** only the four research Markdown files and the source catalogue tables inside them. They are suitable for a static demo fixture, but they are design documents, not KB data.

**Do not assume:**

- **Any data at all**, nor any schedule for its arrival.
- **Notes or pages.** The planned model is claims, entities and relations. A Notion-like "page" may have no counterpart, and may have to be composed by the viewer.
- **Backlinks or wikilinks,** unless a Markdown option is chosen.
- **Score, rank, importance or recommendation fields.** These are banned.
- **Delete semantics.** Dead data is superseded and hidden by default.
- **One "date" field.** There will be at least two time axes.
- **Write-back, comments, annotations or user tags.** The KB has no such concept, and these would need viewer-side storage.
- **Pre-computed layout, clusters or communities.** Producing them in the KB would fall under its derived-output restrictions (inferred).
- **Embeddings being reachable.** Model, dimensions and storage are undecided.
- **Stable IDs across rebuilds.** Not promised anywhere.
- **Availability from Proxmox or remotely.** Plans are local to this WSL2 machine.
- **G domain coverage** in the source inventory.
- **A remote or committed KB.** There is nothing to clone.

## 8. Recommendations for the viewer design (inferred)

1. **Put a thin data-access adapter behind a viewer-owned domain model,** and develop against a fixture. Choose the real adapter after the ADR. This keeps viewer work moving without guessing the schema.
2. **Ask the user whether to pass a reader requirement to the KB session before Decide.** This is cross-project, and the KB's `CLAUDE.md` restricts rule changes without user approval, so it should not happen silently. The request would cover:
   - a named non-LLM read path, such as a read-only DB handle, a versioned export or a local HTTP endpoint, with bulk graph and time-series access;
   - a `schema_version`;
   - stable public IDs across rebuilds;
   - a defined way to apply the default dead-data filter;
   - defined reader behaviour during writes and rebuilds.
3. **Watch for these files:** `docs/adr/0001-architecture.md`, `docs/build-plan.md`, `docs/design/*.md`, and the three pending research reports. Re-run this contract when the ADR appears.
4. **Keep the viewer read-only against the KB.** R9's request queue is a write path, so it stays out of scope unless the user asks for it.
