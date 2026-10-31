# Token tooling for sagae-tools: rtk and "trailing"

Date: 2026-10-31. Read-only investigation. Evidence labels: `[run]` = command run this session, `[file]` = read from the cited file, `[KB-measured]` = measured by an earlier session and recorded in the KB research (not re-run here), `[inferred]` = my inference.

KB research paths are abbreviated:
- `compression.md` = `/home/user/sagae-knowloge-base/docs/research/compression.md`
- `harness.md` = `/home/user/sagae-knowloge-base/docs/research/harness.md`

## 1. Bottom line

1. **"trailing" means `trail`** (trailhq/Trail-Code, npm `@trailhq/trail-code`, formerly graft). Confidence is high but the user has not said so in those words (section 3).
2. **Neither tool is wired into Claude Code today, anywhere on this machine.** `rtk init --show` reports hook, RTK.md and the settings.json PreToolUse hook all missing `[run]`. Both tools run only when an agent types them. Sagae-tools has no CLAUDE.md, no `.claude/` and no memory notes `[run]`, so a new session or subagent does not know they exist.
3. **The user has a standing scope rule: project-level only, no global wiring.** The user's words in the KB session: "graft나, rtk 모두 프로젝트 단위에서만 동작했으면 좋겠어" (`~/.claude/history.jsonl`) `[run]`. So `rtk init -g` is ruled out, even though that is what `rtk gain` and `rtk init --show` tell you to run.
4. **Do not reinvent the wiring.** Workflow `wf_7fe34f38-d94` is implementing project-scoped rtk and trail hooks in sagae-claude-plugins right now. Its implement agent's transcript was last written at 15:59:28 KST, while I was checking `[run]`. Sagae-tools should copy that result once it lands.
5. **rtk covers a limited share of the work.** It only touches Bash output. Most data-reading commands in this stack (`python3`, `node`, `sqlite3`, `sed`, `awk`) are not rewritten at all, and `cat`/`head`/`tail` are rewritten but give 0% savings (section 2.3).

## 2. rtk

### 2.1 State

| Fact | Value | Evidence |
|---|---|---|
| Version | rtk 1.1.0 (`rtk-oss` build: no engine, no PostToolUse compression, no pipeline) | `[run]` `rtk --version`; `compression.md` 4.1 |
| `rtk gain` | 19 commands, 733 tokens saved, 42.4% (18 commands / 53.9% at my first check) | `[run]` |
| Hook in `~/.claude/settings.json` | None; 0 mentions of rtk | `[run]` grep count 0 |
| `~/.claude/hooks`, `~/.claude/RTK.md`, `~/.claude/CLAUDE.md` | Do not exist | `[run]` |
| Config | `~/.config/rtk/config.toml`: telemetry off, `exclude_commands = []`, grep caps 200 total and 25 per file, `passthrough_max_chars = 2000`, recall via sqlite | `[run]` |
| Data | `~/.local/share/rtk/history.db`, `recall.db` | `[run]` |

The 18-to-19 change is row 19, `cat CLAUDE.md` in sagae-claude-plugins at 15:57:30 KST, recorded as `rtk read` with 0 saved. It came from outside this agent `[run]`.

The `gain` figures are a tiny sample and not evidence of real savings. `rtk gain` also estimates tokens as bytes/4, which is especially wrong for Korean (`compression.md` 4.5, 7.4) `[KB-measured]`.

### 2.2 Does it cover subagents and workflow agents?

**Today: no, because no hook exists.** If a project hook is added:

| Path | Hook fires? | Evidence |
|---|---|---|
| Main `claude -p` | Yes | `[KB-measured]` `compression.md` 4.3 |
| Agent tool subagent | Yes (`agent_type: general-purpose`) | same |
| Workflow agent | Yes (`agent_type: workflow-subagent`) | same; also `harness.md` T5b, T13b |
| `isolation: worktree` subagent | Fires, **but git is not rewritten** | same; rtk skips git under `.claude/worktrees/` (`decision.rs:277-303`, read by `wf_7fe34f38`) |
| New worktree session | Fires only if the settings are committed, or via the main checkout's `settings.local.json` | `compression.md` 4.3 |

So one hook in the project's `.claude/settings.json` covers subagents and workflow agents with nothing further per agent. Git savings do not reach agents working in `.claude/worktrees/`.

**Per-repo work needed:** yes. rtk has no project-level config file (`compression.md` 10.3). The minimum is this block in a committed `.claude/settings.json` (`compression.md` 4.2):

```json
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"rtk hook claude","timeout":10}]}]}}
```

**Do not use that plain block as is.** See the hazards below.

### 2.3 What it rewrites and what it does not

Tested with `rtk rewrite` on commands likely in this stack `[run]`. Being rewritten does not mean being compressed; the last column comes from `compression.md` 4.5 where measured.

| Group | Commands | Rewritten? | Real effect |
|---|---|---|---|
| Git | `git status`, `git log`, `git diff` | Yes | `git log -n 30`: 73% smaller. `git log --oneline`: 0%. `git diff` of 471 KB: no real change, because both sides exceed the 30,000-char spill limit |
| Listing and search | `ls -la`, `find`, `grep -rn`, `rg` | Yes | `ls -la` 72%, `find` 92%. Large `rg`/`grep` results can give the model **more** text, 2,326 to 16,000+ chars, because they stop spilling to a file |
| File reading | `cat`, `head -N`, `tail -N` | Yes, to `rtk read` | **0%, byte-identical** |
| JS toolchain | `bun test`, `bun run`, `bun install`, `bunx tsc`, `bunx vitest`, `npx tsc`, `tsc`, `vitest`, `playwright test` | Yes | Not measured on a real project |
| HTTP and GitHub | `curl`, `gh api` | Yes | 0% on JSON |
| GitHub lists | `gh pr list` | Yes | 56%, with 10 rows hidden |
| Other | `wc`, `jq` | Yes | `jq .` truncates large JSON |
| Compound | `git status && bun test` | Yes, both parts | |
| **Not rewritten** | `npm test`, `node`, `python3`, `sqlite3`, `sed`, `awk`, `duckdb`, `tail -f`, `trail`, `cat a \| head -5` | **No** | Unfiltered |

**Not covered at all:** Read, WebFetch, WebSearch and MCP output. In this user's real workflow agents, Bash was 42-55% of tool-result characters and Read 25-46% (`compression.md` 4.10), and part of that Bash share is uncovered commands.

For this tool, querying the KB will mostly go through `python3`/`node`/`bun` scripts. `bun run` is rewritten; rtk cannot compress a script's own custom output in any meaningful way `[inferred]`. Query design has to do that job (section 7, rule 5).

### 2.4 Hazards

All `[KB-measured]`, from `compression.md` 4.4 and 4.6 and the `wf_7fe34f38` journal.

1. **Plain `rtk hook claude` defeats permission rules.** In `bypassPermissions`, `ask` rules and `--disallowed-tools` rules that block without the hook are bypassed with it. This applies here: 9 of the 10 running `claude` processes use `--dangerously-skip-permissions` `[run]`.
2. **It breaks headless allow rules.** `--allowed-tools 'Bash(git status)'` is judged against `rtk git status` and denied. This hits any scheduled headless job.
3. **Silent output loss.** The model sees only its original command and cannot tell output was cut.
   - `git show REV` drops the commit body, including `Co-Authored-By`.
   - `git log` without `-N` stops at 50 lines.
   - `ls -la` loses owner and dates.
   - `find nosuchdir` turns exit 1 into 0.
   - `rtk git diff` output is not an applicable patch and truncates long hunks.
   - `git diff | head -20` printed the stat summary instead of the diff.
4. **Recall coverage is partial.** `rtk recall <hash>` restores rg, grep, find and gh list output. `git log` has no recovery path; use `git log --format=%B`.
5. **`rtk uv run` loses stdout on non-zero exit** (recoverable with `rtk recall`).

### 2.5 The tested safe candidate

`wf_7fe34f38` produced a gated project hook that passed its end-to-end scenarios `[KB-measured]`. Its files survive at `/tmp/claude-1000/-home-sagae-sagae-claude-plugins/01842778-1730-486e-854c-25be5911f20a/scratchpad/interplay/` (`rtk-rewrite.sh`, `candidate-config.toml`, `r-gate/.claude/settings.json`) and I read them `[run]`:

- It runs only with the pinned `rtk 1.1.0`, only on Linux, and only when the input has `permission_mode` `bypassPermissions`. Everything else passes through unchanged, so it fails open.
- `XDG_CONFIG_HOME="$CLAUDE_PROJECT_DIR/.rtk/hook"` loads a project config that excludes mutating git commands, `git show`, `git log`, porcelain, `gh`, `curl`, `wget`, `npm`, `npx`, `find`, `jq`, `stat` and `ls -l`.
- A SessionStart hook sets `RTK_SUPPRESS_HOOK_WARNING=1 RTK_RECALL=0 RTK_DB_PATH=/dev/null` through `CLAUDE_ENV_FILE`.

Three limits to know:
- Sessions in `--permission-mode auto` get no rewriting.
- `RTK_DB_PATH=/dev/null` means `rtk gain` records nothing, so savings cannot be measured.
- `RTK_RECALL=0` removes the `rtk recall` path.

These files are in `/tmp` and may vanish. The final form should come from the workflow's branch, not this scratchpad.

## 3. What "trailing" is

**Conclusion: `trail`, the Trail-Code CLI.** Confidence: high. The user has not confirmed it explicitly.

Evidence in order of weight:

1. `~/sagae-knowloge-base/CLAUDE.md:10` states: `trail`(trailhq/Trail-Code, 코드맵·세션 학습 기록. 구 이름 graft, 사용자가 "trailing"이라 부름) `[run]`.
2. The history shows the same pairing in the user's own words `[run]`:
   - `/tmp/claude-setup`: "graft나 rtk 같은 도구 효용성 검토해줘."
   - `sagae-claude-plugins`: "현재 워크트리 대상으로, trailhq/Trail-Code 및 rtk 세팅해줘."
   - `sagae-knowloge-base`: the rule "rtk 및 trailing을 통해..."
   - `sagae-knowloge-base`, afterwards: "graft 도구가 이름 바뀌었다고 하더라고, graft나, rtk 모두 프로젝트 단위에서만 동작했으면 좋겠어."
3. `trail` is installed beside `rtk` in `~/.local/bin` `[run]`. There is no `trailing` binary.
4. `~/.graft/` is Trail-Code's state directory from its old name: `telemetry.json` (disabled) and `update-check.json` `[run]`. `trail --help` ends with "every graft command still works" `[run]`.
5. A web search found no Claude Code tool called "trailing". It confirmed the rename from `@nanonets/graft` to `@trailhq/trail-code`.

Caveat: `compression.md` section 13 still lists this as unconfirmed by the user, while `CLAUDE.md:10` states it as fact. No later user message confirms it. Repeating the phrase "rtk 및 trailing" here without correcting the KB is suggestive only `[inferred]`.

| Candidate | Confidence | Evidence |
|---|---|---|
| `trail` (Trail-Code, formerly graft) | **High** | Items 1-5 above |
| Typo for "tailing" (limiting output with `tail`) | Low | No local mention. In the KB session the rule appears after the user had asked for Trail-Code setup. Still a valid habit, but not what was meant |
| An unrelated tool named "trailing" | Very low | Web search found none; no binary or config locally |
| ponytail | None | No hits in the tooling search |

Search coverage `[run]`: 0 hits in `~/.claude/settings.json`, `~/.graft`, `~/.agents`, `~/.codex`, `~/sagae-claude-plugins`, `~/.zshrc`, `~/.zsh_history`. Hits in `~/sagae-knowloge-base/CLAUDE.md` and two KB memory notes. The 30 hits in `~/.claude/plugins` are unrelated text such as `trailing` in source code; I read only the file names. "trailing" occurs in two history lines, both this user rule.

### What trail actually does

Version 0.28.1, launched through `~/.local/bin/trail`, a wrapper setting `DO_NOT_TRACK`, `TRAIL_NO_FETCH`, `TRAIL_NO_LOOK_BACK`, `GRAFT_NO_IGNORE` `[run]`. It is a different kind of tool from rtk: it does not compress output, it **replaces exploration**.

- Code map: `trail ask`, `grep`, `skeleton`, `callers`, `map`.
- Learnings: `trail note`, `check`, stored in `.trail/learnings/`.

Limits for this user `[KB-measured]`, `compression.md` 5.3, 5.5, 5.6:
- Only code is indexed; Markdown and JSON are ignored. This matters less in sagae-tools than in the KB, since this repo will hold code.
- Purely Korean queries return nothing. Korean notes are rejected unless forced with `--anyway`.
- Vendor savings figures ("up to 4x", 46% fewer calls) are the vendor's own benchmarks.
- Its output tells the agent to report tokens saved to the user. That costs tokens and can leak into replies.
- `graft/` is not committed, so each worktree needs its own `trail build`.
- `trail build` modifies `.gitignore`. `trail note` writes to `~/.trail/`.

**Do not run `trail init`**, even with restrictive flags. It adds hooks and broad Bash allow rules, and in a fresh worktree it reapplies defaults, writing global hooks into `~/.claude/settings.json` and overriding claude-hud's statusline. This repeated in testing, and it violates the user's scope rule.

Two non-init paths exist `[KB-measured]`:
- A manual `.mcp.json` entry plus `trail build`. This gives 6 tools, but 0 tools in any worktree with no map.
- The two-hook candidate from `wf_7fe34f38`: `UserPromptSubmit` plus a synchronous `PostToolUse`. It worked end to end, including fresh worktrees. The journal says `async: true` is unsafe because the rebuild was cancelled when a short session ended.

## 4. settings.json: what costs tokens

`~/.claude/settings.json` is 47,347 bytes, of which 42,749 are hook command strings `[run]`.

### Hooks

All 15 events are Orca hooks, each a shell one-liner of about 3 KB `[run]`. The hook script prints `{}` and POSTs to localhost. `claude-hook.sh` contains no `additionalContext`, `systemMessage` or `hookSpecificOutput` (grep count 0) `[run]`.

- **Token cost: none.** They add no context and do not reduce any. The cost is process spawn latency on tool calls.
- **Hooks that reduce tokens: none.**
- **Plugin hooks:** claude-hud and proxmox have no `hooks/` directory, and their manifests have no `hooks` key `[run]`.
- The 47 KB file is not sent to the model `[inferred]`; only the bytes the hooks print would be.
- No `permissions` key exists in the file `[run]`.

### Settings that do affect tokens

| Setting | Value | Effect |
|---|---|---|
| `modelSettings.claude-opus-5-5.effortLevel` | `xhigh` | Highest-impact knob present `[inferred]`. Spend on thinking and output per turn. Applies to the Opus default |
| `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `1` | Enables agent teams. Each teammate carries its own context |
| `teammateMode` | `auto` | Governs how teammates are displayed `[inferred]`, not a token setting in itself |
| `enabledPlugins` | claude-hud, proxmox, cc-plugin-you-should-know | HUD: statusline only, no model tokens `[inferred]`. Proxmox: 6 deferred MCP tools and a skill entry. You-should-know: stores session offer state, `~/.claude/plugins/store/` `[run]` |
| `statusLine`, `tui`, `theme` | | No token effect `[inferred]` |
| Not set | `subagentPromptCacheTtl`, `BASH_MAX_OUTPUT_LENGTH`, permissions | Defaults apply |

### Larger costs that are outside settings.json

- **Every subagent pays for the startup listing.** This session opened with hundreds of deferred MCP tool names (Datadog, Atlassian, Figma and others), server instructions for each connector, and the full skills list `[run: visible in this agent's own context]`. Listing names is far cheaper than loading schemas, but it recurs per agent. This is likely a bigger cost than anything in `settings.json` `[inferred, not measured]`.
- **Subagent cache lifetime is 5 minutes** versus 1 hour for a subscription main session. Subagents do not read the parent's cache (`compression.md` 7.5). Long pauses in workflows mean cache rewrites.
- **Workflow fan-out** delays same-prefix agents by up to 5 seconds so they can read the first agent's cache (`compression.md` 7.5).
- `ENABLE_CLAUDEAI_MCP_SERVERS=false` is the documented per-session switch for claude.ai connectors, so this cost may be reducible without touching global config. Untested (section 6).
- `subagentPromptCacheTtl` is a documented setting (`settings-reference.md:746` in the docs snapshot) that could be set to `1h`. Longer TTL writes cost more ($8 versus $5 per million for Opus 5.5, `compression.md` 7.5), so this needs a measurement before adopting.

### Claude Code limits that apply automatically

`compression.md` section 6, `[KB-measured]` and documented:

| Boundary | Default | Past it |
|---|---|---|
| Bash output | ~30,000 chars | Spilled to a file, about 2,000-char preview given |
| MCP output | 50,000 chars / 25,000 tokens | Spilled to a file |
| Read | 25,000 tokens per call | Must page |
| WebFetch | 100,000 chars per page | Lossy model extraction by design |

Korean is about 2.6 times the tokens of English for the same character count (45,000 chars: 47,434 versus 18,002 tokens). Korean MCP output can reach about 52,000 tokens inline before the character limit applies.

## 5. Decisions needed from the user

1. **Wire sagae-tools, and how?** Project hooks were approved for sagae-claude-plugins, and the KB rule scopes tools to project files, but no approval names this repo. Allow rules still need the user's say.
2. **Wait for `wf_7fe34f38-d94`?** Recommended: yes, then copy its result, because a parallel design here would be the wheel-reinvention rule 2 forbids.
3. **Confirm "trailing" = trail.** One word from the user closes it, and also settles the note in `compression.md`.
4. **Measurement or recall?** The tested candidate turns off both `rtk gain` tracking and `rtk recall`. A self-improving setup (rule 1) may want tracking on. This is a trade-off, not a defect.

## 6. What this investigation did not establish

- Real rtk savings on Bun, Vitest or Playwright in a real project. I confirmed only that these commands are rewritten.
- Rewrite behaviour in a real interactive session alongside live Orca hooks. It was tested with a verbatim copy of the Orca hooks and a mock API, and `compression.md` section 13 still lists the interactive case as open.
- Which settings file an `isolation: worktree` subagent reads. The KB docs digest says this is not documented; the `wf_7fe34f38` run found hooks come from the parent session and `CLAUDE_PROJECT_DIR` is the parent checkout.
- The actual token cost of the deferred-tool listing per subagent.
- Whether `ENABLE_CLAUDEAI_MCP_SERVERS=false` actually removes the connector listing for subagents, and how many tokens that saves. It is documented (`env-vars.md:467` in the docs snapshot under `/tmp/claude-1000/-home-sagae-sagae-claude-plugins/01842778-1730-486e-854c-25be5911f20a/scratchpad/docs-raw/`) but not tested. It would also remove Datadog, Figma and Atlassian access for that session.
- Whether `wf_7fe34f38-d94` will finish. It was active at 15:59:28 with an unchanged worktree and no commits past `2f2ecbf`.

## 7. Rules for subagents in sagae-tools

### Enforcement today

| Mechanism | Status |
|---|---|
| rtk rewrite hook | **Not installed.** Nothing is rewritten |
| trail hooks or MCP | **Not installed** |
| Claude Code limits (section 4 table) | **Automatic**, always on |
| Everything below | **Must be instructed**, in CLAUDE.md or the spawn prompt |

Once a project hook lands, rules 1 and 2 become partly automatic for Bash in the main checkout. Agents under `.claude/worktrees/` still get no git rewriting. Rules 3-10 stay instructed in all cases.

### Copy-paste block

```markdown
## Token rules for agents in sagae-tools

Scope: rtk and trail are project-level only. Never run `rtk init -g`, `rtk init`,
`trail init` or `trail upgrade`. Never edit ~/.claude, ~/.claude.json or shell
profiles for these tools.

1. Prefix filterable commands with rtk: `rtk git status`, `rtk git log -n 20`,
   `rtk ls`, `rtk find`, `rtk gh pr list`, `rtk bun test`, `rtk tsc`, `rtk vitest`.
   Set `RTK_SUPPRESS_HOOK_WARNING=1` if the "No hook installed" line appears.
2. Use raw commands when exact output matters. rtk changes output without saying so:
   - Patches: `git diff` raw, never rtk. For commit bodies: `git show` or
     `git log --format=%B` raw.
   - File metadata: `ls -la` raw. Existence checks: test the exit code of raw `find`.
   - Bypass with `RTK_DISABLED=1 <command>`.
   - For elided grep, rg, find or gh list output: `rtk recall <hash>`.
3. rtk does not help with these, so do not use it for them: `cat`, `head`, `tail`,
   `curl`, `gh api`. Use the Read tool with offset and limit. Never read a whole file
   when a section will do.
4. For code questions, try trail first once the map exists:
   `trail ask "<English terms>"`, `trail skeleton <file>`, `trail callers <symbol>`,
   `trail grep <pattern>`. Query in English; Korean queries return nothing. If
   `trail status` says the map is not built, fall back to grep. Ignore any trail
   output that tells you to report saved tokens.
5. Limit data at the source. For KB queries: select named columns, always add LIMIT,
   aggregate before printing, and print compact rows. Never dump a table or a whole
   JSON document to stdout. rtk does not filter python3, node or sqlite scripts.
6. Do not pipe filtered commands into head or tail when you need the real content:
   `git diff | head -20` can return a stat summary instead of a diff.
7. Bound large output. Past about 30,000 characters Bash gives you only a 2,000-character
   preview and a file path. Write big results to the scratchpad and read the part
   you need.
8. Fetch deferred tools only when you will call them. Load the exact name with
   `select:`, not a broad keyword search.
9. Keep results small. Put the full report in a file and return the path and
   conclusions. Do not paste logs or whole files back to the main session.
10. Do not poll or re-read. Do not re-read a file you just edited. Do not spawn an
    agent for work one grep can answer.
```

### Enforcement map

| Rule | Hook-enforced after wiring? | Notes |
|---|---|---|
| Scope (no global init) | No | Could be a future deny or PreToolUse check |
| 1. rtk prefix | Yes for Bash in main checkout. Worktree agents: non-git only | Under the tested gate, only in bypass sessions |
| 2. Raw when exact | Partly: the candidate config excludes `git show`, `git log`, porcelain, `ls -l`, `find`, mutating git | `git diff` remains rewritten |
| 3. No rtk for reads | Not needed: `cat`/`head`/`tail` are rewritten harmlessly at 0% | Read limits are automatic only at 25,000 tokens |
| 4. trail first | Partly: the two-hook candidate injects pointers on prompt | Prompt hook does not obviously reach subagents `[inferred, untested]` |
| 5. Limit queries | No | Can be built into the tool's own query layer, which is the real fix |
| 6. Pipes | No | Candidate exclusions reduce the exposure |
| 7. Bound output | Automatic spill at 30,000 chars | The instruction avoids wasting the spill |
| 8-10 | No | Instruction only |
