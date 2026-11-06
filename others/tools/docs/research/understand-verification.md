# Verification of the sagae-tools scout reports

Checked 2026-10-31, 16:03 to 16:22 KST. The KB changed during this check. The last KB state cited here is 16:20.

**Verdict.** Most of what the scouts measured holds: 52 claims were re-checked and confirmed (section 4). But the KB contract's framing is out of date, because the user opened a KB-to-tools negotiation at 16:02:38 KST, after the scouts had read the KB. Use `/home/user/sagae-knowloge-base/docs/contracts/consumers/sagae-tools.md` as the current baseline, not the bottom line of `kb-contract.md`.

**Time-critical.** KB main plans to stop its workflow when research ends and resume it with an edited script. The resumed run reads that consumer doc, and its Decide step maps each item into the contract (script line 339). `research:graph-store` and `research:sources-inventory` had no result yet at 16:20. Section 3.1 lists what the doc is missing; it should reach `sagae-knowloge-base-4d` before the resume.

Labels used below:

- **Overtaken:** true when written, false now.
- **Wrong:** not supported by the evidence even when written.
- **Incomplete:** true, but it leaves out something that changes a decision.

`script` means `~/.claude/projects/-home-sagae-sagae-knowloge-base/b32eef31-b09c-4e58-8902-431f279117b3/workflows/scripts/kb-foundation-design-wf_a0640bc9-66f.js`. Its line numbers are from the 16:07:21 version.

## 1. Corrections

### 1.1 KB contract (`kb-contract.md`)

**C1. The viewer is now a named KB consumer. Overtaken, high impact.**
The report says no KB document names a viewer, and that the research consumer list stops at Claude sessions (lines 12, 126, 200). Now:

- `CLAUDE.md:34`: "가시화 도구는 `sagae-tools`가 만든다. 이 저장소는 데이터 인터페이스를 제공하며 가시화를 구현하지 않는다." Edited 16:04:26.
- `script:147`, R18: a versioned, stable interface with published schema, pagination, point-in-time queries and change detection. It also says heavy consumer reads must not block ingestion.
- `script:155`: a fourth design lens, `platform`, names the viewer as a reader.
- `script:254-263`: a new `general-db` research topic reads the consumer doc, with targets of p95 200 ms for detail, neighbour and search, and 2 s for a 10k node, 50k edge overview.

Limit: R15 to R20 exist only in the script on disk. A script edit takes effect only on a relaunch with `resumeFromRunId` (workflow reference, `## Resume`). KB main says it will do this (transcript 07:07:38Z), but it had not happened by 16:20.

**C2. The "should the user send a reader requirement?" question is closed. Overtaken.**
The user started this at 07:02:38Z: "knowloge-base에 데이터 인터페이스들?에 대해서 협의가 필요함". KB main messaged `sagae-tools-0e` at 07:04:38Z. The reply was recorded at 16:07:13 in `docs/contracts/consumers/sagae-tools.md`, marked provisional, and acknowledged at 07:07:25Z.

**C3. The table of requirements omits R13, now the central conflict. Incomplete, high impact.**
R13 (`script:142`, present from the start): "상시 서버 프로세스를 최소화한다". The consumer doc's first choice is a versioned HTTP API, which needs a process. KB main told sagae-tools the ADR will decide this. The doc already accepts a CLI or library with the same JSON contract as the fallback, so the viewer's API client must not assume HTTP-only behaviour until the ADR lands. Evidence in favour of a shared daemon, from `retrieval-serving.md:10`: session attach 5.5 ms against 1.9 s for stdio, and 597 MB against 4,794 MB across 8 sessions. It also needs a way to keep the daemon alive, and `Linger=no`.

**C4. A provisional data model exists, and Notion-like pages may have a counterpart. Overtaken.**
The report says no entities are defined, that a "page" may have no counterpart, and that the KB has no concept of write-back (lines 64, 230, 235). There is still no schema, but:

- KB main's message lists entities and relations, claims (value, source snapshot, quote), two time axes, `origin` (external, first_party) and `status` (active, superseded, dead).
- R15 stores user-produced notes, decisions and project outputs in the same graph (`CLAUDE.md:29-32`).
- R16 adds a sensitivity label. R17 adds a write path for sessions and tools. R19 formalises the status field.
- R6 now applies only to system-produced output, so attributed user judgements can be stored (R15).

**C5. "Available right now: only the four research Markdown files" was wrong, and the paths behind the alternatives are vanishing. Wrong, then overtaken.**
At the time of writing the scratchpad also held `etl/data/kb.duckdb` (2,631 real fetched rows) and `graph-store/dbs/sq/g.db` (10,000 entities, 63,590 edges, with `valid_from`, `valid_to`, `recorded_at`, `expired_at`). The report's "synthetic or benchmark data" also did not fit `kb.duckdb`: it holds live Hacker News and GitHub feed entries, PyPI releases and YouTube suggestions. The KB now has six research files totalling 354,366 B, not four totalling 230,891 B. Both databases have since been deleted (see C17). Fixtures are now agreed to be KB-owned, but none exists yet.

**C6. The benchmark table needs two updates. Overtaken and incomplete.**

- FalkorDB "writer failed: AF_UNIX path too long" has been resolved. `graph-store/results/falkor.jsonl` now holds `xproc-rate10` runs: readers went from 50,540 to 62,240 edges with 0 errors, 2-hop p50 0.56 ms. The report's "test-path artefact" reading was right.
- LadybugDB's `reopen` mode was left out, and it bears on the report's open question. In `xproc-reopen`, with a writer running, 2-hop p50 was 171.8 ms, p99 1,305 ms, 3.8 queries per second. On these logs a reader either holds a fixed view (`once`) or pays that reopen cost. The machine was shared with other agents, so treat the figures as indicative.

**C7. Citations and counts moved. Overtaken.**

| Item | Report | Now |
|---|---|---|
| Phases | lines 213, 222, 232, 252, 273 | 221, 230, 276, 296, 317 |
| Design contents, red team | 244, 261 | 288, 305 |
| ADR, build plan | 291-292 | 335-336, plus a third output at 337: `docs/contracts/data-interface-v0.md` |
| Dead-data rule | `CLAUDE.md:44` | `CLAUDE.md:53` |
| `sources-inventory.md` | :103, :417 | :104, :420 |
| Journal | 3 of 8 results | 6 of 8: prep, harness, prior-art, compression, etl-orchestration, retrieval-serving |
| Domain G survey | stage 3 | `sources-inventory-g` extra topic, `script:240`, on resume |
| `kb_http_logged.py` | running | Not running; port 18933 is closed |

### 1.2 Token tooling (`token-tooling.md`)

**C8. "trailing" = trail follows as an inference, but the top-ranked evidence is circular. Wrong ranking; conclusion stands.**
Item 1 (`CLAUDE.md:10`) is not independent. KB main wrote that gloss itself at 06:11:01Z, and its workflow prompt at 06:14:01Z still says "로 판단된다. 이 판단이 맞는지도 확인한다." The section header says "사용자 지시", which makes it look like the user's words. `compression.md:15,26,729` correctly says unconfirmed. `trailing` occurs in two history lines, as the report says; the second is inside pasted content.

The real evidence is the user's own sequence:

| KST | Project | User's words |
|---|---|---|
| 14:43:07 | claude-setup | graft나 rtk 같은 도구 효용성 검토해줘. |
| 14:51:51 | sagae-claude-plugins | 현재 워크트리 대상으로, trailhq/Trail-Code 및 rtk 세팅해줘. |
| 15:06:26 | sagae-knowloge-base | rtk 및 trailing을 통해 토큰과 데이터 압축을 통해 |
| 15:14:02 | sagae-knowloge-base | graft 도구가 이름 바뀌었다고 하더라고, graft나, rtk 모두 프로젝트 단위에서만 |
| 15:54:48 | sagae-tools | rtk 및 trailing을 통해 토큰을 효과적으로 (pasted) |

The strongest link is 15:06 to 15:14: in the same session, eight minutes apart, the user pairs rtk with graft where "trailing" had been. The 15:54 reuse suggests a habitual name rather than a one-off typo (inferred). My repeat search found no tool called "trailing", which is weak negative evidence. It is a well-supported inference, not an established fact, and one word from the user settles it.

**C9. "Neither tool is wired anywhere on this machine" no longer holds. Overtaken.**
Still true globally. But branch `foundation/tools-hooks` now exists, and worktree `wf_7fe34f38-d94-5` has `.claude/settings.json` with three hooks plus `.claude/hooks/{rtk-rewrite,trail-context,trail-env,trail-sync}.sh`. All of it is uncommitted (HEAD still `2f2ecbf`) and still changing: `rtk-rewrite.sh` went from 3,774 B to 3,783 B at 16:14:27.

**C10. The landing hook is raw by default, so rules 1 and 2 do not "become partly automatic". Overtaken, high impact.**
Sections 2.5 and 7 describe an exclusion-config candidate. The live wrapper is an allow-list. It has no `XDG_CONFIG_HOME` config, no `.rtk/` directory and no SessionStart hook. I piped 22 commands through it in `bypassPermissions`:

| Result | Commands |
|---|---|
| Rewritten (3) | `git status`, `grep -rn foo .`, `rg foo` |
| Raw (19) | `git log -n 5`, `git diff`, `ls -la`, `ls`, `find`, `grep -c`, `rg -l`, `bun test`, `bun run build`, `bunx tsc`, `bunx vitest`, `tsc`, `vitest`, `playwright test`, `cat`, `head`, `curl`, `gh pr list`, `python3` |

- In `default` mode, `git status` also stays raw.
- For a Bun and TypeScript repo, the daily toolchain gets nothing automatically. The report's section 2.3 table shows what `rtk rewrite` does, not what will run.
- The wrapper's rule is that a command is listed only after a fidelity test. Its doc and tests (`docs/project-tools.md:15-16`, `tests/project-hooks/rtk-rewrite.test.mjs`) never mention Bun, tsc or Playwright. `npx vitest` is on the raw list under "Mutating or networked". So fidelity for this repo's toolchain is untested rather than rejected.
- The same test file classes `ls`, `ls -la`, `find`, `cat`, `head` and `wc -l` as "Lossy in rtk, or with no saving". That contradicts rule 1 of the report's copy-paste block, which tells agents to type `rtk ls` and `rtk find`.
- It adds an `additionalContext` note on every rewrite, which costs a few tokens and fixes the silent-loss hazard for those commands.

**C11. Copy-paste rule 1 likely fails for worktree-isolated agents. Wrong for that case.**
Rule 1 tells agents to type `rtk git status` and `rtk git log -n 20`. An rtk source comment quoted in the workflow transcript (06:59:32Z) says Claude Code's worktree-isolation guard refuses a rewritten `rtk git …` outright. I confirmed that rtk leaves git raw under `.claude/worktrees/` while still rewriting `bun test`. Refusal of a hand-typed `rtk git` is inferred from the same guard and untested, because this agent is not in a worktree. Rule 1 needs a carve-out: plain `git` inside `.claude/worktrees/`.

**C12. Rule 2's `rtk recall <hash>` path conflicts with the landing hook. Overtaken.**
The wrapper sets `RTK_RECALL=0`, and `docs/project-tools.md:59` says `rtk recall` cannot be used. The recovery path is `RTK_DISABLED=1 <command>`, or a pipe or full path such as `grep ... | cat`.

### 1.3 Ecosystem (`ecosystem.md`)

**C13. "Default to npm workspaces with Node" conflicts with what this project told the KB. Conflict, needs a user decision.**
The consumer doc says "TypeScript + Bun이 유력하다". No user preference is recorded either way. Facts for the decision are in section 2, item 5.

**C14. "Keep a storage adapter seam" and "open the DB read-only" no longer match the plan. Overtaken.**
The consumer doc says "읽기 전용 DB 파일 직접 접근은 원하지 않는다". The seam is now a KB API client plus a contract fixture, not a storage adapter. `token-tooling.md` section 2.3 ("querying the KB will mostly go through python3/node/bun scripts") is overtaken the same way.

**C15. A read-only handle is not harmless. Incomplete.**
"Read-only by construction" holds for the viewer's own data but not for the file underneath it. A read-only DuckDB connection blocks writers. SQLite `mode=ro` on a WAL database creates files beside it. Details are in section 2, item 4. The task brief's `mode=ro` tip has the same caveat, so I opened only byte copies.

**C16. A systemd user unit does not keep the viewer available. Incomplete.**
`Linger=no`, and per `etl-orchestration.md:22,181-190` WSL stops about 15 s after the last Windows client, without counting systemd services. That report derives this from source analysis and did not measure it. `pixel-wt` (pixel-wt removed 2026-11-05) showed that a unit ran, not that it survives this. The unit needs an absolute `bun` path too: neither `bun` nor `node` is on a bare PATH. Changing Linger needs the user's approval (`retrieval-serving.md:71`).

**C17. Named paths are stale in both reports. Overtaken.**

- Of the four DB files `ecosystem.md` names, `graph-store/dbs/sq/g.db` and `etl/data/kb.duckdb` were deleted during this run, along with `etl/data/` as a whole.
- The two reports point at different rtk candidates, and both are old: `rtk-mech/candidate/` (15:35) and `interplay/` (15:42). The live one is in the worktree. Copy from the branch once it lands, not from either scratchpad.

**C18. Smaller fixes.**

- "Project hooks are approved" overgeneralises. Memory `third-party-tools-project-scope-only` opens with "In this repo", meaning sagae-claude-plugins. `token-tooling.md` has this right.
- "워크트리 means a top-level repo in `~/`": one of the four is `/tmp/claude-setup`, on tmpfs.
- The proposed `.mcp.json` for trail differs from the in-flight two-hook design, which uses no `.mcp.json`.
- Ports 18933, 18090 and 50051 are no longer listening.

## 2. Resolved gaps

**1. Who owns the contract and how the two sides talk.** Contract source lives in KB `docs/contracts/`, in OpenAPI 3.1 plus JSON Schema. The fixture is KB-owned, both sides run contract tests, and breaking changes bump major. The channel is `sagae-knowloge-base-4d` and `sagae-tools-0e`, confirmed with ListAgents. The KB will answer sagae-tools' three open questions with `data-interface-v0.md` after the ADR.

**2. Does a Windows browser reach WSL loopback?** Yes. `curl.exe` on Windows got HTTP 200 from `127.0.0.1:4700`, and Orca has live tabs on 4701 to 4703. The `ecosystem.md` statement was unevidenced and is now confirmed.

**3. Do the prototype stores hold real relations?** No. Nothing shows a claim-to-quote-to-snapshot chain.

- `g.db`: `PUBLISHED_BY` spans all 36 kind pairs, including Topic to Keyword, because `gen_data.py` picks relation types at random. It has no quote, snapshot, status or origin column, and 47 duplicate triples.
- `kb.duckdb`: flat raw tables with dlt columns only.
- Useful hints only: epoch integer time axes in `g.db`, and a real SCD2 chain in `hist.duckdb` (`a`: first, then renamed, each closed by `_dlt_valid_to`).

Do not derive a schema or fixture meaning from these.

**4. How do readers behave on the candidate engines?** I reproduced this on copies. The `dlt` row is from the ETL agent's output and `etl-orchestration.md` section 7.3; I did not rerun it.

| Case | Result |
|---|---|
| DuckDB 2.0.0: writer open, other process opens read-only | Blocked, `Could not set lock on file` |
| DuckDB: read-only connection open, other process writes | **Blocked** |
| DuckDB: read-only plus read-only | Works |
| dlt load while a reader is attached | **Fails**, `DestinationConnectionError` |
| SQLite WAL, `mode=ro` | Creates `-shm` and `-wal` beside the DB |
| SQLite WAL, `mode=ro` in a read-only directory | Fails: `attempt to write a readonly database` |
| SQLite WAL, `immutable=1` in a read-only directory | Works |
| SQLite reader during an open write transaction | Sees last commit, then new rows after commit |
| Bun `readonly: true` on a WAL copy | Also left `-shm` and `-wal` |

So a viewer holding a live DuckDB file open could make ingestion fail. This confirms the consumer doc's choice of an API. Any file-based fallback should read a published copy (the ETL `os.replace` pattern) and never the live store.

**5. Can each runtime read a likely store?** Both can, with no native dependency. Bun or Node remains a decision (C13), but it does not hinge on bindings if the store is SQLite. DuckDB or LadybugDB bindings were not tested.

| | Bun 1.4.4 | Node v26.13.0 |
|---|---|---|
| Built-in SQLite | 3.53.4, `bun:sqlite` | 3.54.0, `node:sqlite` |
| FTS5 trigram with Korean | Works | Works |
| Read 63,590 edge rows | 8 ms | 42 ms |
| `rtk rewrite` covers the test command | `bun test` yes | `npm test` no |
| Landing hook rewrites it | No | No |
| On a bare PATH | No | No |

**6. Are the 200 ms and 2 s targets plausible on the storage side?** Yes on SQLite, for this size. Measured with Bun on the synthetic graph, on tmpfs, warm, with no writer and no Kiwi. Browser parse, layout and render are not measured.

| Query, 10,000 entities and 63,590 edges | p50 ms | p95 ms |
|---|---|---|
| Neighbours, 1 hop | 0.10 | 0.46 |
| Backlinks, 1 hop | 0.08 | 0.14 |
| 2 hops, limit 200 | 0.03 | 0.07 |
| Facet by kind | 3.95 | 5.18 |
| Facet by relation type, live edges | 10.91 | 13.75 |
| Table page, cursor, 50 rows | 0.02 | 0.04 |
| As-of count, both time axes, no index | 4.43 | 5.56 |
| Full-text with snippets, 20 rows | 0.06 | 0.10 |

Overview of 10,000 nodes and 51,354 live edges: query 128 ms, 3.12 MB JSON, stringify 10 ms, 0.46 MB gzip in 35 ms.

**7. Can the viewer do Korean search itself?** No, not with plain SQLite. Search must go through the KB. A snapshot export gives no usable Korean search unless it ships the tokenizer.

| Query | `unicode61` | `trigram` | `LIKE` |
|---|---|---|---|
| 유튜브 | 699 | 2,876 | not run |
| 채널 | 719 | **0** | 2,837 |
| 광고 | not run | **0** | not run |
| 시청자 | not run | 2,348 | not run |

Trigram cannot match two-syllable words, which `retrieval-serving.md:14` also reports. `unicode61` finds far fewer hits than `LIKE` or trigram, probably because it misses words with attached particles or compounds (inferred from the counts). Index text is also not display text: `kb_proto.db` stores joined tokens (`kb_build_db.py:12`), so its body reads as particle-stripped fragments.

**8. How can UI be verified here?** Through Orca, not WSL. WSL has no Playwright browsers, no Chromium or Chrome, and no Korean fonts (`fc-list :lang=ko` is empty, 89 fonts in total), so a WSL screenshot would likely break Korean text (inferred). `orca-ide` has browser automation including `snapshot`, `screenshot`, `click` and `eval`, running on Windows.

**9. What will a source snapshot look like?** Candidate only: WARC through warcio, with results carrying `warc_record_id`, `payload_digest` and a character position, and JS-rendered content not captured (`etl-orchestration.md:15,256,390`). I could not inspect a file, because `etl/data/warc` was deleted before I reached it.

**10. Does hook coverage reach subagents, and is rewriting real?** Yes to both, for a project hook.

- `compression/logs/hook-wf.log` shows `agent_type: workflow-subagent`; `hook-wt.log` and `hook-live-2.log` show `general-purpose`. All are `bypassPermissions`.
- I observed `rtk hook claude` return `updatedInput: rtk git status`, with no `permissionDecision`, identically in `bypassPermissions` and `default`. The mode gate is therefore entirely in the wrapper.
- This session and its subagents run in `bypassPermissions` (process flags; 11 transcript rows), so the gate would pass here.
- The raw logs come from KB test repos. No rtk hook is configured for this repo, and `rtk gain` stayed at 19 commands after my own `git` and `ls` calls, so nothing here was rewritten.

**11. Artifacts preserved from the deleted stores.**

- `/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/understand/overview-synthetic-10k-51k.json.gz`: the overview payload, for a render benchmark. Synthetic and random.
- `/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/understand/.probe/kb.duckdb`: the only copy of the 2,631 real rows that I know of.
- `/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/understand/.probe/gen_data.py`: the graph generator, with `lock.py`, `bench.ts` and `export.ts` for reproducing the measurements.

All are on tmpfs, so copy them if they matter.

## 3. Remaining gaps

### 3.1 Missing from the consumer doc; send before the KB resumes

1. **Sensitivity.** R16 adds a sensitivity label, but the doc filters only on type, origin and status. Ask for the field, a default-hide rule, and how personal fields such as P05 comment authors are treated (`sources-inventory.md:420`).
2. **Quote offsets.** The ETL plan says "문자 위치" with no base text or unit. Ask which text it indexes (raw payload or extracted text) and which unit. Python counts code points and JS counts UTF-16 units, so emoji in YouTube text would shift highlights (language behaviour, not tested here).
3. **Highlight base.** Search highlight positions must refer to display text, since index text can be tokenized.
4. **Overview limits.** The only size figure anywhere is 10k and 50k: the KB's synthetic benchmark size (`script:76`) and the viewer's target. Nobody has forecast real volume. Ask for `total`, `truncated`, stable ordering and required filters, so the overview survives the store outgrowing the render budget.
5. **Whole-graph values.** The doc says the tool computes community detection and centrality, and also that the client does not hold the full data. These conflict. Name the snapshot export as the input for that work and define its format.
6. **Operational views.** Source freshness and run metrics (R7, R12) and the request queue (R9) are absent from the query list. Decide whether the viewer wants them.
7. **Envelope.** Ask for `schema_version`, `data_as_of` and a build ID, behaviour during a rebuild or publish swap, conditional GET for the 30 to 60 s polling, an error shape, and one timestamp format and zone. The prototypes mix epoch integers and `TIMESTAMPTZ`.
8. **Loopback safety.** First-party data on a local HTTP port needs a `Host` check, no wildcard CORS, and an auth slot for a later Proxmox move.
9. **First-party display.** Ask for body format, author, version history, and how notes link to each other. This decides whether Obsidian-like backlinks and Notion-like pages are possible.

### 3.2 User decisions

1. Bun or Node (C13).
2. Is read-only still right? The first request said "조회해서 가시화". The 16:02 message then put user-produced information in the KB, and the consumer doc has already told the KB the tool is read-only and that the KB will design the input path. The user has not confirmed that, and Obsidian or Notion-like tools are usually where notes get written (inferred).
3. UI style: graph and notes, database views, or both, and which comes first.
4. Does "trailing" mean trail (C8)?
5. Project hooks for sagae-tools: approval for this repo, and whether to extend the allow-list to Bun tooling. Also tracking versus recall, since the wrapper turns off both.
6. Tool name. `loupe` is proposed; all five candidates are unused on PATH, and public registries were not checked.
7. Availability: is "only while Orca or a WSL client is up" acceptable? Is LAN or remote access wanted at all?

### 3.3 Research no report covers

1. **Build versus adopt, the user's rule 2.** No report evaluates any viewer stack. My searches found no mature all-in-one product and no head-to-head benchmark at this scale, and the results were mostly dated. This needs a real survey:
   - Whole apps: Obsidian over a generated vault, Datasette, Grist, NocoDB, Teable.
   - Graph: Sigma.js with Graphology, Cytoscape.js, G6, cosmos.gl.
   - Grid: TanStack Table, Glide Data Grid.

   Apart from the search results for Sigma.js, Cytoscape.js and G6, these names are prior knowledge, not checked. KB `general-db` item (d) covers only input formats and scale limits for four graph libraries, explicitly not a viewer choice.
2. **Browser render benchmark** at 10k and 51k, in Orca's Chromium, using the preserved payload.
3. **Safe source rendering.** How to show captured HTML: a sandboxed iframe, or a WARC replay viewer (ReplayWeb.page is prior knowledge, not checked).
4. **Frontend framework** and timeline or chart libraries.

### 3.4 Waiting on the KB

1. `docs/research/graph-store.md`, `general-db`, `sources-inventory-g`: not published.
2. `docs/adr/0001-architecture.md`, `docs/build-plan.md`, `docs/contracts/data-interface-v0.md`, the fixture: not written.
3. The three questions the KB deferred to the ADR: expected scale, run location and HTTP daemon, snapshot body format.
4. Whether the resume actually happens, so that R15 to R20 reach Design.

### 3.5 Token tooling, unmeasured

1. Real rtk savings on Bun, Vitest, tsc and Playwright.
2. The hook's final form, and whether `wf_7fe34f38-d94` lands it.
3. Per-subagent cost of the startup listing, and whether `ENABLE_CLAUDEAI_MCP_SERVERS=false` reduces it.
4. Whether the prompt hook reaches subagents.

## 4. Confirmed claims

KB contract:

| # | Claim | Evidence |
|---|---|---|
| 1 | KB is on `main` with no commits, remote, stash or extra worktree; `CLAUDE.md` and `docs/` untracked | git commands, 16:03 and 16:17 |
| 2 | No real KB store under `/home/user` | `find` depth 7: only rtk and NSS DBs |
| 3 | One Proxmox guest, `qemu/100 minecraft-server` | `list_resources type=vm`, covers QEMU and LXC |
| 4 | No crontab; only 3 Ubuntu user timers | `crontab -l`, `systemctl --user list-timers` |
| 5 | `sagae` marketplace has only `proxmox`; plugin data only `proxmox-sagae` | `marketplace.json`, `ls` |
| 6 | No KB read interface exists; `kb_server.py` is a prototype with `search`, `get`, `request_info`, `ping`, `startup_info` | Script read; nothing listening |
| 7 | Prep, Research, Design, Judge, Decide; ADR and build plan are planned | `script`; `docs/adr` absent at 16:20 |
| 8 | R1 to R7, R9, R10, R12 text | `script:130-141` |
| 9 | `CLAUDE.md` quotes at 3, 9, 11, 16, 17, 18, 23-24 | Numbered read |
| 10 | 15 `prior-art.md` citations, including the four stack options | `sed` at each line |
| 11 | 10 `harness.md` citations | `sed` at each line |
| 12 | `compression.md:19,21,22` | `sed` |
| 13 | `sources-inventory.md:14,17`; 2026-08-24 definition change | `sed`, line 386 |
| 14 | SQLite xproc-rate10: 50,540 to 62,240; 2-hop p50 0.019, p99 0.147 | `sqlite.jsonl` |
| 15 | LadybugDB rate10: fixed 51,350; 2-hop about 2.5 ms; commit p50 72.18 ms | `ladybug.jsonl` |
| 16 | `g.db` was synthetic and on tmpfs | `example.test` URLs, `df -T` |
| 17 | User rules 5 and 6 quotes, memory quote, `plugin-kb/.mcp.json` shape | Transcript, `project-kb-purpose.md:19`, file read |

Token tooling:

| # | Claim | Evidence |
|---|---|---|
| 18 | rtk 1.1.0; `rtk init --show` reports hook, RTK.md and PreToolUse missing | Run |
| 19 | 0 rtk mentions in global settings; no `~/.claude/{hooks,RTK.md,CLAUDE.md}` | `grep`, `ls` |
| 20 | `rtk gain`: 19 commands, 733 saved, 42.4% | Run |
| 21 | The whole `rtk rewrite` table | 35 commands re-run, all match |
| 22 | Plain hook output has no `permissionDecision` | Simulated input |
| 23 | rtk skips git under `.claude/worktrees/` | Simulated in such a path |
| 24 | Hook fires for Agent and Workflow subagents | `hook-wf.log`, `hook-wt.log`, `hook-live-2.log` |
| 25 | 15 hook events, all 15 commands Orca, 47,347 B, 42,749 B in commands | Parsed |
| 26 | `claude-hook.sh` has no context-injecting keys | `grep -c` = 0 |
| 27 | `effortLevel xhigh`, `teammateMode auto`, agent teams on, no `permissions` key | Parsed |
| 28 | 9 of 10 `claude` processes skip permissions | `ps` |
| 29 | User scope statement and "trailing" in 2 history lines | `history.jsonl` |
| 30 | `~/.graft` contents; "every graft command still works"; trail 0.28.1 wrapper env | `ls`, `trail --help`, wrapper read |
| 31 | rtk config: telemetry off, empty `exclude_commands`, `grep_max_per_file = 25`, `passthrough_max_chars = 2000` | `config.toml` |
| 32 | Permission-hazard table | `compression.md` 4.4 |
| 33 | `rg` and `grep` output grows to 16,274 and 18,590 | `compression.md:157-158` |
| 34 | `trail init` writes globally; `.mcp.json` path gives 0 or 6 tools | `compression.md` 5.5, 5.6 |
| 35 | Korean `trail note` limits | `compression.md` 5.3 |
| 36 | Claude Code output limits; 47,434 versus 18,002 tokens | `compression.md` section 6, line 351 |
| 37 | Cache TTLs and $8 versus $5 write price | `compression.md:451,463` |
| 38 | `env-vars.md:467`, `settings-reference.md:746` | `grep` of docs snapshot |
| 39 | Wf worktree has no commits past `2f2ecbf` | `git log`, 16:20 |

Ecosystem:

| # | Claim | Evidence |
|---|---|---|
| 40 | Plugin rules, `package.json`, file sizes 93, 77, 54, CI steps, 3 commits, dirty main | Files, `git`, `wc -l` |
| 41 | `pixel-wt` ports, loopback URL, tab logic; unit with hardcoded node and PATH, active at measurement (pixel-wt removed 2026-11-05) | Lines 31-32, 83-87; `systemctl` |
| 42 | `orca-ide` launcher path and tab commands | Script head, `--help` |
| 43 | 4 repos registered, automations empty, `~/orca/workspaces` has no files | `orca-ide`, `find` |
| 44 | Mirrored networking; eth0 192.168.x.x/24 | `.wslconfig`, `ip` |
| 45 | No exposure tools on PATH or in `C:\Program Files` | `command -v`, `ls` |
| 46 | node, bun, python3, gh, rtk, trail versions | Run |
| 47 | docker, pnpm, uv, sqlite3, psql, orca absent | `command -v` |
| 48 | Ports 4700 to 4703 in use | `ss -ltn` |
| 49 | Five name candidates unused on PATH | `command -v` |
| 50 | Bun appears in settings only through `statusLine` | Parsed |
| 51 | nvm node trap and 15-minute failure cache | `harness.md:276,416`; bare PATH test |
| 52 | DuckDB cross-process restriction, tagged "prior knowledge; verify" | Reproduced, section 2 item 4 |

## 5. Method and side effects

- **Stores.** I opened only byte copies, taken at 16:03, in `/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/understand/.probe`. That was necessary, not cautious: section 2 item 4 shows opening the originals would have written files into another session's directory. The sidecars did appear on my copies. Copies I no longer needed were deleted afterwards.
- **Could not check.** LadybugDB `g.lbug` was not opened; its figures come from the result logs. WARC files were gone before I reached them. `gh` visibility of the plugin repo was not re-checked. `kb_server.py` was partly read but not run, and port 18933 was not contacted.
- **Side effect outside the scratchpad.** My first `git status` ran without `GIT_OPTIONAL_LOCKS=0`. The KB `.git` directory mtime moved to 16:03:16, the second I ran it. I also ran plain `git status` in `sagae-tools`, the plugins main checkout and the live workflow worktree. No file content changed as far as I can tell. Later KB and worktree reads used `GIT_OPTIONAL_LOCKS=0`.
- **Read-only external calls.** Proxmox `list_resources`, four web searches, `orca-ide` listings, one `curl.exe` GET to `127.0.0.1:4700`. I piped sample JSON into the in-flight hook, which only prints.
- **Not done.** I did not message the KB session, run KB jobs or `claude -p`, or touch `~/.ssh` or `~/.claude/.credentials.json`.
- **Tool anomaly.** One combined Bash call using Windows interop returned no output at all, including its first `echo`. Splitting it worked. The cause is unknown.
- **Volatility.** The KB, its scratchpad and the in-flight hook all changed during this check. Re-read `docs/contracts/` and the hook before relying on anything dated here.
