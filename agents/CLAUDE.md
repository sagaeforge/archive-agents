# sagae-claude-plugins

Private Claude Code plugin marketplace (`sagae`). While the `stable` gate is off (`docs/stable-gate.md`), pushing to `main` is a deployment: a machine with auto-update on, which is off by default, fetches the push up to ten minutes after the first message of its next interactive session, and loads it on its next launch or `/reload-plugins`.

## Layout

- `.claude-plugin/marketplace.json`: plugin list
- `plugins/<name>/`: one plugin each, with `.claude-plugin/plugin.json`, `skills/`, `.mcp.json`
- `plugins/proxmox/server/`: Node MCP server. `pve.mjs` is the API client, `tools.mjs` defines tools, `index.mjs` wires them together

## Before pushing

```sh
claude plugin validate . && claude plugin validate plugins/proxmox
(cd plugins/proxmox && npm test)
```

## Rules

- Never set `version` in `plugin.json` or `marketplace.json`. Updates are detected from the commit SHA, and a pinned version silently stops them.
- Never commit secrets. A machine's API token lives only in `~/.config/proxmox-mcp/token`, and the runner's only in `/etc/proxmox-mcp/token` inside its LXC. `certs/pve-root-ca.pem` is a public CA certificate.
- The proxmox server is read-only by design: `pve.mjs` can only send GET and the token has only `PVEAuditor`. Adding write tools needs a separate decision, a separate token with a narrower role, and explicit gating for each tool. Do not widen the existing token.
- New dependencies must be in `package-lock.json`.
- User-facing docs are in Korean; code, comments, and commits are in English.
- The main session does no work itself. Its role is limited to facilitating collaboration between teams: monitoring and coordinating them, and improving itself. All work is started by forming a team in separate sessions.
- The main session never waits in the foreground: no `orchestration check --wait`, `terminal wait`, or `sleep` loops. After starting Orca workers, launch the `team-watcher` subagent in the background and end the turn. Workflows need no watcher. The watcher only reports; the main session reads each batch and does every ack, reply, release, stop, and retry. See `docs/team-operations.md`.
- Continuously find and remove bottlenecks in how teams and agents collaborate. The main session looks for them while it monitors, and fixes the cause in instructions or tooling rather than working around it once.

## Model tiers

Every new agent gets an explicit model and effort, chosen by the nature of its work. Left unset, it inherits the global default, Opus 5.5 at `xhigh`.

| Tier | Work | Model | Effort |
|---|---|---|---|
| Judgment | Design, adversarial review of security or the read-only boundary, completeness critique, merge or deploy verdict | `opus` | `high` |
| Build | Implementation, repair, test writing, team leads, other reviews | `sonnet` | `high` |
| Run | Running commands and tests, measuring, checking docs, mechanical edits | `sonnet` | `medium` |
| Lookup | Search, listing, reading logs, summarizing, watching | `haiku` | `low` |

- Apply this wherever an agent starts: `worker-start` and `agent launch` (`--model`, `--effort`) and the Agent tool. A reused terminal keeps the model it has.
- Use `xhigh`, `max`, or `fable` only when the user asks.
- When a lower tier fails or reports doubt, retry one tier up.

## Running teams

- Treat `start_unknown` and `outcome_unknown` from `worker-start` as unconfirmed, not failed. Read the worker's transcript before acting, and do not relaunch on that state alone. Longer `--timeout-ms` did not prevent them.
- A lead waiting on helpers blocks in `check --wait` and sends no heartbeats meanwhile. Each heartbeat wakes the coordinator, and the wait is itself the liveness signal.
- Probe branches for conflicts while teams work, with `git merge-tree --write-tree <a> <b>`. It touches no checkout, so a conflict surfaces before the final check.

## Node changes

When a node is added, removed, renamed, or readdressed, change every copy of the list in one commit. `npm test` compares only `pve.mjs` with `bootstrap-token.sh`, so it stays green while the others are stale.

- `plugins/proxmox/server/pve.mjs`: `DEFAULT_HOSTS`, which the server and the doctor read
- `plugins/proxmox/scripts/bootstrap-token.sh`: `DEFAULT_PVE_HOSTS`, plus `SSH_HOST` and the usage text if `pve-node` is the node that changes
- `plugins/proxmox/skills/proxmox/SKILL.md`: `description`, the node table, the node count, and the quorum rule
- `plugins/proxmox/test/smoke/live.mjs`: `HOSTS` and `NODES`. Its count has to match the cluster, or `live-smoke` fails
- `infra/runner/nftables.conf`: `PVE_NODES`
- Any other copy: `git grep -nE '<name>|192\\?\.168\\?\.0\\?\.<last octet>\b'` finds tests that pin these lists, including addresses written as escaped regexes, tool descriptions, and examples in the docs. Use the node that changes, or for a new node one that stays
- The node count written out, which that search cannot find: `git grep -nE '노드 3개|세 노드|노드 수가 3|이름 3개|노드가 3건' -- README.md docs/`

Then:

1. Check that the node's certificate chains to `certs/pve-root-ca.pem` and lists its IP in the SAN. The server connects by IP.
2. Run the checks in Before pushing, plus `node --test infra/runner/test/runner.test.mjs`, which `npm test` does not run.
3. If `PVE_NODES` changed, rebuild the runner (러너 재구축 in the README). The LXC keeps the `nftables.conf` that `provision.sh` copied in, so a commit alone does not change its firewall.
4. If `pve-node` changed, fix the SSH alias on each machine that uses `bootstrap-token.sh`.
5. Run `doctor.sh` on each machine and confirm that its check 7 reaches every host.
