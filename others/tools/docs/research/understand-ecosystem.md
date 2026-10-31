# Ecosystem survey for sagae-tools

Surveyed 2026-10-31, about 15:55 to 16:01 KST. Scope: conventions of the user's tool ecosystem, so the first sagae-tools viewer fits and reuses what exists.

Labels: **[verified]** means I read the file or ran the command. **[inferred]** means my conclusion from evidence. **[prior knowledge]** means not checked in this survey.

## 0. Findings that change the plan

1. **There is no KB database to read yet.** `sagae-knowloge-base` has no commits. It holds only `CLAUDE.md` and `docs/research/*.md` (`git log` fails with "does not have any commits yet"). Every `.db`, `.duckdb` and `.lbug` file found is a throwaway prototype in another session's scratchpad on tmpfs (`df -T /tmp` = tmpfs), so it disappears on reboot. The storage engine is still undecided: the KB session has SQLite, DuckDB, LadybugDB and FalkorDB trials side by side.
2. **The native UX for this user is a loopback web page in an Orca browser tab.** `pixel-wt` already does this: a server on `127.0.0.1`, opened with `orca-ide tab create --url`, and supervised by a systemd user unit.
3. **Nothing exposes internal services today.** There is no Tailscale, WireGuard, reverse proxy or tunnel on PATH, in Windows Program Files, or in any repo doc or memory. The one access rule on record is "내부망(192.168.x.x/24)에 접근할 수 있어야 합니다" (`sagae-claude-plugins/README.md`).
4. **The KB forbids visualization inside itself** (`sagae-knowloge-base/CLAUDE.md`, 지침 5). That rule is why this tool must be separate, and it means the viewer must never write derived scores back into the KB.
5. **WSL runs in Mirrored networking, so eth0 is the real LAN address 192.168.x.x.** Binding to `0.0.0.0` could put a server on the LAN (not tested, and Windows firewall behaviour is unverified). Bind to `127.0.0.1` by default, as `pixel-wt` does.

## 1. sagae-claude-plugins

**What exists [verified].** Private GitHub repo `sagaeforge/sagae-claude-plugins`, marketplace name `sagae`, 3 commits on main. It has one plugin, `proxmox`.

| Item | Convention | Evidence |
|---|---|---|
| Layout | `.claude-plugin/marketplace.json`, then `plugins/<name>/` with `.claude-plugin/plugin.json`, `skills/`, `.mcp.json` | `CLAUDE.md` Layout |
| Language | User-facing docs in Korean; code, comments and commits in English | `CLAUDE.md` Rules |
| Runtime | Node ESM `.mjs`, `"type": "module"`, `engines.node >=20`, `private: true` | `plugins/proxmox/package.json` |
| Size | Very small: `pve.mjs` 93 lines, `index.mjs` 77, test 54 | `wc -l` |
| Dependencies | Only `@modelcontextprotocol/sdk` and `zod`; new deps must be in `package-lock.json` | `package.json`, `CLAUDE.md` |
| Tests | `node --test test/*.test.mjs` (the last commit fixed this glob for Node 22) | `package.json`, `git log` |
| CI | Node 22, `claude plugin validate`, `npm ci`, `npm test`. Validates only and does not block deployment | `.github/workflows/ci.yml`, `README.md` |
| Packaging | Pushing `main` is the deployment. Never set `version`; updates key off the commit SHA | `CLAUDE.md` Rules |
| Secrets | Outside the repo in `~/.config/proxmox-mcp/token`. `.gitignore` covers `token`, `*.token`, `.env` | `CLAUDE.md`, `.gitignore` |
| Safety | Read-only by construction: the client can only send GET, and the token holds only `PVEAuditor` | `CLAUDE.md` Rules |

Uncommitted edits on main add the rule "The main session does no work itself" to `CLAUDE.md` and `/graft/` to `.gitignore` (`git diff`).

**Unmerged work worth knowing.**
- `docs/team-operations.md` in worktree `wf_40bcafc9-1ed-5` chooses between Workflow (order can be scripted) and Orca workers (needs judgment during the run).
- `infra/runner/` on branch `foundation/w7-runner` (worktree `wf_40bcafc9-1ed-8`) provisions an unprivileged Debian 13 LXC with nftables. No remote branch contains that commit. Whether it was ever run is unknown, because I did not query the cluster.

**Reusable for the viewer.**
- The read-only-by-construction pattern: open the DB read-only and expose only GET routes.
- The `node --test` setup and the minimal-dependency style.
- The marketplace itself, for a later thin skill (section 6).
- Reuse here means copying the pattern. No shared library exists.

## 2. Skills, Codex, Orca and agents

**Skills [verified].** `~/.agents/skills/` holds `computer-use`, `find-skills`, `orca-cli` and `orchestration`, installed by the community skills CLI and tracked in `~/.agents/.skill-lock.json` (sources `stablyai/orca`, `vercel-labs/skills`). `~/.claude/skills/` symlinks into it and also has `synced/`.

**Codex [verified].** `~/.codex/` contains only hook wiring (`hooks.json`, trusted-hash state in `config.toml`). There are no Codex instructions and no `AGENTS.md` for these repos. The hooks look Orca-managed [inferred, from `~/.codex/.orca` and `harness.md` section 5.2].

**How Orca is launched [verified].** The command is `orca-ide`, not `orca`.
- `~/.local/bin/orca-ide` calls `powershell.exe` with `~/.local/share/orca/orca-wsl-bridge.ps1`, which runs `C:\Users\user\AppData\Local\Programs\orca\resources\bin\orca.exe`.
- `pixel-wt` honours `ORCA_CLI_COMMAND` and defaults to `orca-ide`.
- Orca runs on Windows (`host list`: `sagae-windows`, `win32`). Paths come back as UNC, such as `\\wsl.localhost\Ubuntu\home\sagae\sagae-tools`.
- **Trap:** `orca-ide` reads stdin. In a heredoc-driven script it swallows the rest of the script, which happened during this survey. Always pass `</dev/null`.

**How worktrees are actually used [verified].**
- `orca-ide worktree list` shows 4 repos registered in place as main worktrees: `claude-setup`, `sagae-claude-plugins`, `sagae-knowloge-base`, `sagae-tools`.
- `~/orca/workspaces/` is effectively empty: `sagae-proxmox/` and `.orca-preparing/` have no content.
- So "워크트리" in practice means a top-level repo in `~/`. Parallel work uses Claude Workflow worktrees under `.claude/worktrees/` (8 in the plugins repo).
- `orca-ide automations list` is empty, so no Orca automation is in use yet.
- Agent teams are on: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` in `~/.claude/settings.json`, and session teams in `~/.claude/teams/`.

**Other pieces.**
- `~/.zshrc` and `~/.tmux.conf` run one tmux session per Orca worktree and keep Korean text intact over OSC 52.
- `pixel-wt.service` watches for new worktrees and gives each its own Pixel Agents office on a port from 4700 to 4799.

## 3. Durable preferences

From `~/.claude/projects/*/memory/`. There is no global `~/.claude/CLAUDE.md`, and the sagae-tools memory is empty.

| Preference | Source |
|---|---|
| Korean with the user and in docs; tool names and code identifiers stay in their original form | KB `CLAUDE.md`, plugin `CLAUDE.md` |
| Main session only supervises and self-improves; work goes to teams, workflows and subagents | KB `CLAUDE.md` 지침 1, plugin `CLAUDE.md` |
| Main session never blocks in a foreground wait; a background watcher or Workflow waits | memory `main-session-never-blocks-on-workers` |
| Large work is split by goal and run in parallel, at ambitious scale | memory `work-in-parallel-by-goal` |
| Do not reinvent the wheel; check primary sources because prior knowledge is assumed stale | KB `CLAUDE.md` 지침 2, 작업 규칙 |
| rtk and trail are project-scoped only: no `rtk init -g`, no `~/.claude` or shell profile changes. Project hooks are approved; permission allow rules and statusLine changes still need the user's say | memories `third-party-tools-project-scope-only`, `feedback-project-scoped-tools` |
| Commit and push only on request; pushing `main` needs explicit approval | KB `CLAUDE.md`, memory `work-in-parallel-by-goal` |
| Work from WSL paths, never under `/mnt/c` | memory `sagae-proxmox-plugin`, plugin `README.md` |
| The passphrase-less SSH key is deliberate; do not raise it again | memory `ssh-key-no-passphrase` |
| Confirm before hard-to-reverse actions on cluster nodes | same memory, proxmox `SKILL.md` |
| User is a Korean developer preparing a YouTube channel, runs a Proxmox homelab, uses Orca | memory `user-profile` |

**No recorded preference exists** for UI style, frontend framework, or bun versus node. These need asking or a reasoned default.

## 4. Hosting and access model

- **The KB lives here, not on the cluster, as far as local evidence shows [verified locally].** It is on this WSL host only, as a repo with no commits and no remote. The cluster API was not called, per the task rules.
- **Future host is undecided.** `harness.md` recommends a host scheduler plus `claude -p` and mentions a possible single HTTP MCP on "the host", without naming a machine.
- **Network [verified].** PC `sagae-windows`, WSL `networkingMode=Mirrored`, eth0 192.168.x.x/24. Cluster `example-cluster` nodes are 192.0.2.1, .11 and .20 (proxmox `SKILL.md`). SSH reaches these nodes as root (proxmox `SKILL.md`; `README.md` uses `ssh pve-node`).
- **Exposure [verified].** None exists: `tailscale`, `cloudflared`, `caddy`, `nginx` are absent from PATH. `C:\Program Files\Tailscale` and `WireGuard` are absent. A grep across plugin docs, KB docs and all memories found nothing (node_modules and worktrees excluded).
- **Domain.** `user@example.com` suggests the user owns `example.com` [inferred], but no service uses it locally.
- **If a cluster deployment comes later:** the runner work shows the likely pattern of an unprivileged LXC with nftables, staying LAN-only [inferred]. Adding Tailscale or a proxy would be a new decision for the user.

## 5. Runtimes and how things run

| Runtime or tool | Version or state | Actual use |
|---|---|---|
| node | v26.13.0 via nvm | All the user's own code: proxmox MCP, `pixel-wt`, Orca hook relay |
| bun | 1.4.4 in `~/.bun/bin` | Only third-party `claude-hud` statusline; no bun use in proxmox |
| python3 | 3.14.4 | KB prototypes; `harness.md` notes no `ensurepip` and no uv on default PATH |
| rtk | 1.1.0 | Bash output only (`compression.md`) |
| trail | 0.28.1, pinned wrapper with telemetry off | `~/.local/bin/trail`; full fidelity for TS, JS, JSX, TSX (package README) |
| gh | 2.103.3 | Authenticated; `sagaeforge` lists the private plugin repo and public repos |
| Absent | docker, pnpm, uv, sqlite3, psql, orca | Per task; confirmed where tested |

**Global tools are single hand-installed files in `~/.local/bin`, with pinned packages under `~/.local/share/<tool>/`.** Both are outside any git repo: `pixel-wt` and the `trail` wrapper have no version control, so moving them here is a natural follow-up [inferred; not requested].

**Trap:** nvm's `node` is not on PATH for non-interactive contexts. It broke the proxmox MCP once, and the failure was cached for 15 minutes (`harness.md` section 6, T0, T18). `pixel-wt.service` avoids this by hardcoding the full node path and `Environment=PATH`. Any new unit must do the same.

**Ports in use (`ss -ltnp`) [verified].**

| Port | Owner | Lifetime |
|---|---|---|
| 127.0.0.1:4700-4703 | Pixel Agents, one per worktree; `pixel-wt` owns 4700-4799 | Long-running |
| 127.0.0.1:18933 | KB prototype `kb_http_logged.py` (not contacted) | Scratch |
| *:18090, *:50051, *:37625 | Java, gone minutes later. Probably a Kestra trial, from `server_kestra_local3.log` in the KB scratchpad [inferred] | Transient, bound to all interfaces |
| 127.0.0.1:5xxxx | Node processes, including the Orca hook relay (57489) | Ephemeral |

**Suggestion:** reserve 4800-4899 for sagae-tools. This is my proposal, not an existing convention.

**rtk and trail wiring for instruction 3** (`compression.md`; the KB session is editing this file, and line numbers shifted during the survey, so cite by section).
- A plain `rtk hook claude` in project settings works for subagents and Workflows, but it bypasses `ask` and deny rules under `bypassPermissions` and breaks headless `--allowed-tools` rules. The doc describes an allow-list wrapper candidate that blocked those bypasses. Its files exist today at `/tmp/claude-1000/-home-sagae-sagae-claude-plugins/01842778-1730-486e-854c-25be5911f20a/scratchpad/rtk-mech/candidate/`, on tmpfs, so copy them before a reboot if they are wanted.
- `trail build` plus a hand-registered `.mcp.json` writes nothing outside the repo. Avoid `trail note` and `trail init` without review, because they write to `~/.trail/`. `graft/` is uncommitted, so each worktree needs its own `trail build`.
- Whether "trailing" means Trail-Code: KB `CLAUDE.md` treats this as fact, but `compression.md` says the user never confirmed it.

## 6. Recommended delivery shape

**Recommendation: a local web app on loopback, with a small CLI that starts it and opens it in an Orca tab.** The options below are layers rather than rivals.

| Option | Verdict | Reasoning |
|---|---|---|
| Local web app | **Core** | Graph, table and document views need a real UI. Exact precedent in `pixel-wt`. Also works in a Windows browser |
| CLI + browser | **Launcher for the web app** | `<name> serve`, `open`, `status`, `install`. Matches `pixel-wt` commands. Not a separate product |
| Claude plugin skill | **Later, thin only** | Useful for `open this node`. Wrong home for the app: push-to-main deploys it, install paths change per version, and only Node deps auto-install (`harness.md` section 6) |
| MCP | **Do not build for v1** | The KB plans its own plugin with MCP and skill (`harness.md` section 6). A second one duplicates it. Agents should query the KB directly |
| Desktop (Electron, Tauri) | **Reject** | Orca already gives an Electron shell with a browser tab. Packaging across WSL and Windows adds cost with no gain |

**Design constraints that follow.**
- **Keep a storage adapter seam.** The engine is undecided, so isolate reads behind one interface and build first against a fixture. Native bindings and concurrent-read behaviour differ by engine. DuckDB in particular restricts concurrent access across processes while a writer is open [prior knowledge; verify]. The KB session should confirm this for its chosen engine.
- **Prefer a published read contract from the KB** over reading its internal tables: a stable path or read API, plus schema version. Take the DB path as an absolute configured value, as `harness.md` recommends for plugin servers.
- **Honour KB semantics.** Show sources on every claim. Hide superseded (죽은 데이터) records by default with a toggle, matching the KB's default search. Keep third-party recommendations attributed. Keep derived views in the viewer and never write them back.
- **Read-only by construction.** Open the DB read-only and expose GET routes only.
- **Loopback safety.** Bind `127.0.0.1` and check the `Host` header to resist DNS rebinding [my recommendation].
- **One global instance.** Unlike `pixel-wt`, a single KB means one server, not one per worktree. Use a systemd user unit with a hardcoded node path. Make the Orca tab idempotent with `orca-ide tab list --worktree all` before `tab create --url`.

**Monorepo layout for sagae-tools.**

```text
sagae-tools/
  CLAUDE.md                 Operating rules, adapted from the KB and plugin CLAUDE.md
  README.md                 Korean; tool index and setup
  package.json              Workspaces root, private
  package-lock.json
  .gitignore                node_modules, .env, token, *.token, /graft/
  .claude/settings.json     Project hooks only (guarded rtk wrapper)
  .mcp.json                 trail, hand-registered
  tools/
    <viewer>/               One folder per tool, mirroring plugins/<name>/
      package.json          private, no published version
      README.md             Korean
      src/server/           Read API and storage adapters
      src/web/              UI
      src/cli.mjs           serve, open, status, install
      test/
  packages/                 Create only when a second tool needs shared code
  ops/systemd/              Unit templates installed by each tool's CLI
  docs/adr/                 Design decisions
```

**Package manager and runtime.** Default to npm workspaces with Node: it matches `package-lock.json`, `npm ci`, `node --test` and all existing code, and it avoids betting on Bun compatibility with a DB binding not yet chosen. Bun remains a reasonable choice if the user prefers it. This is a judgment call that the user has not settled. Keep `sagae-tools` private under `sagaeforge`, matching the plugin repo, if it gets a remote. It has no remote and no commits today.

## 7. Name candidates

Local style [verified]: short lowercase words (`trail`, `graft`, `orca`, `rtk`, `proxmox`), or a plain descriptive hyphenated form (`pixel-wt`). All five candidates are unused on PATH. Public registries were not checked, which matters little for a `private: true` package.

| Name | Rationale | Drawback |
|---|---|---|
| **`loupe`** (recommended) | A jeweller's magnifier: you inspect closely and change nothing, which suits a read-only viewer. Short, CLI-friendly, reads well in Korean as 루페 | Slightly less obvious to a first-time reader |
| `sonar` | Pairs with `orca`, an echolocating animal. It reveals what is below the surface without touching it | Evokes SonarQube and monitoring more than reading |
| `lectern` | The stand you read from; a reading-only object, matching "조회해서 가시화" | Longer and less familiar to type |
| `gwan` | 볼 관(觀), to observe. Echoes the user's 관제 and gives the set a Korean identity | Romanization is unclear to others; 관 has many meanings |
| `atlas` | A bound map of a territory; suits a knowledge graph plus browsable pages | Most collision-prone: MongoDB Atlas, Atlassian-like associations |

**Why `loupe`:** it states the tool's defining limit, that it looks and never edits, and sits naturally beside `trail` and `graft` as a plain common noun. `sagae-loupe` works if a prefixed form is ever needed.

## 8. Open questions

1. Which storage engine and path will the KB commit to, and will it publish a read contract? Who owns that contract? This blocks the real adapter, not the UI or a fixture.
2. Will the KB stay on this PC or move to the cluster? This decides loopback-only versus network access and auth.
3. Bun or Node for sagae-tools? No recorded preference exists.
4. Does the user want LAN or remote access at all? Nothing exposes services today.
5. Which UI style? No preference is recorded. Obsidian-like graph and notes, Notion-like database views, or both?
6. Does "trailing" mean Trail-Code? `compression.md` records this as unconfirmed.
7. Should `pixel-wt` and other `~/.local/bin` scripts move into sagae-tools later? Not requested.

## 9. Method and limits

- Nothing was changed outside this scratchpad directory. Commands against live systems: `orca-ide --help`, `worktree list`, `repo list`, `host list`, `automations list`. All are listing calls.
- One network read: `gh repo list sagaeforge`, to learn repo visibility. No writes.
- No Proxmox API or MCP call. Port 18933 was not contacted; I read its script and `/proc` only.
- **Rule breach:** the task said to skip `~/.ssh` entirely, and I ran one `grep` for `Host` lines in `~/.ssh/config`. It returned the three node aliases, which are already public in the proxmox skill. No keys were read, and nothing in this report relies on it; the SSH fact in section 4 is sourced from the proxmox docs instead.
- `~/.claude/.credentials.json` was not touched. Token-like values were redacted in reads, and none appear here.
- `~/.zsh_history` was read only as command-name counts, which showed too little to support any finding.
- KB scratchpad prototypes were listed and skimmed only. A dedicated KB schema survey is better placed to judge them.
- The KB session was active during this survey, so `docs/research/` and its scratchpad can change.
- A temporary `probe.sh` in this directory was created and removed.
