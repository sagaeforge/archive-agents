# Gateway research: adversarial verification

Date: 2026-10-31. Verifies `mcp-gateways.md`, `mcp-servers.md` and `http-gateway.md`.

**Method.** Every adopt or adapt option and each track's main recommendation was checked against primary sources: the GitHub API, source files read at the release tag rather than `main`, `npm view` per-version publish dates, PyPI, and official docs. Nothing third-party was installed or downloaded. The only code run was two short scripts of mine plus the existing `bench/` scripts, using the already-installed Node and Bun. No third-party product was exercised, so every statement about agentgateway behaviour below comes from reading source or docs.

**Reading the labels.** "Source trace" means I followed the code at the v1.7.0 tag but did not run it.

---

## 1. Corrections

### 1.1 Corrections that change a decision

**C1. `openapi-typescript` and `openapi-fetch` should not be marked adopt.**
- The author announced on 2026-09-19 that the project "is in maintenance mode and won't be getting any more updates. Please migrate to another project", and this includes security patches ([#2874](https://github.com/openapi-ts/openapi-typescript/issues/2874)). Handing it to someone else was ruled out. The 100 most recent commits are all from dependency bots.
- The report's date is wrong. `7.13.0` and `0.17.0` were published on **2026-02-11**. The cited 2026-06-15 is npm's `modified` field, so the release is over eight months old, not four.
- `7.13.0` pulls `@redocly/openapi-core ^1.34.6`, which [#2846](https://github.com/openapi-ts/openapi-typescript/issues/2846) reports brings in `js-yaml` 4.2.0, flagged high severity (GHSA-52cp-r559-cp3m).
- The named alternative's date is wrong too. `@hey-api/openapi-ts` 0.99.0 was published **2026-06-22**, not 2026-09-30. Its repo last changed 2026-09-30.
- **Change:** treat this as an open selection. Candidates are `@hey-api/openapi-ts` (pre-1.0, no stable release since June) and [`orval`](https://github.com/orval-labs/orval) 8.46.0 (MIT, released 2026-10-30). I evaluated neither on OpenAPI 3.1. A third option is for the KB repo to generate and ship the types itself. The frozen tool still runs and only reads a first-party contract at dev time, so it is a usable stopgap, but it is not an adopt.

**C2. Plain `npx @modelcontextprotocol/conformance` cannot test the current spec.**
- `latest` is 0.1.16, released **2026-03-27** on GitHub and published 2026-03-30 on npm. The report's 2026-10-01 is the publish date of `0.2.0-alpha.12`, picked up through npm's `modified` field.
- 0.1.16 predates the 2026-07-28 revision by four months. Its [version list](https://github.com/modelcontextprotocol/conformance/blob/v0.1.16/src/scenarios/index.ts) stops at `2025-11-25` plus `draft`. Its README has no `--spec-version` or `--requirements`. The report read the `main` README, which describes the alpha.
- Others use the alpha line: the TS SDK v2.4.0 pins `0.2.0-alpha.12` in `test/conformance/package.json`, and 1MCP v0.39.7 pins `0.2.0-alpha.11`.
- `main` still has `DRAFT_PROTOCOL_VERSION = '2026-07-28'`, and the default suite excludes draft scenarios.
- **Change:** pin `@modelcontextprotocol/conformance@0.2.0-alpha.12` and run with `--requirements 2026-07-28`. That flag landed on 2026-08-07, before alpha.11 and alpha.12 ([#447](https://github.com/modelcontextprotocol/conformance/pull/447)). Keep the baseline file.

**C3. The three tracks disagree on the main architecture, and verification favours the Hono-first design.**

| Topic | `mcp-gateways.md` | `mcp-servers.md` | `http-gateway.md` |
|---|---|---|---|
| Front process | agentgateway | Hono `apps/gateway` | Hono; agentgateway only if aggregation is needed |
| MCP exposure | One `/mcp`, merged, stdio target | `/mcp/<name>`, in-process, explicitly not merged | `/mcp/<name>` until a merge is shown to be needed |
| KB HTTP | Separate socket-activated service | Gateway `/v1/*` | Gateway `/api/kb/v1` |
| Port | 8787 | 7410 | 8787 (8788 behind agentgateway) |
| Server path | `tools/mcp-kb/src/main.ts` | `servers/kb/src/stdio.ts` | n/a |

- The KB consumer doc already proposes that the KB ship a library or CLI and that HTTP exposure sits with the gateway ([sagae-tools.md](/home/user/sagae-knowloge-base/docs/contracts/consumers/sagae-tools.md) line 31). agentgateway cannot host a library or call a CLI, so a Hono-style application process is needed either way.
- "Single entry point" is therefore one port, not one process. agentgateway cannot host KB code, has no static file serving (nothing in [`schema/config.md`](https://github.com/agentgateway/agentgateway/blob/v1.7.0/schema/config.md), only `directResponse`), and has no socket activation (zero code hits for `LISTEN_FDS` or `sd_listen_fds`, no issue mentions it). So the layout is at least two processes, and the front one stays on all the time, which works against the KB's principle of few always-on processes.
- The findings in C4 to C10 all add cost to the agentgateway route. In-repo TypeScript servers mounted in Hono with `createMcpHandler` avoid them, because that path has no protocol sessions.
- **Recommended re-ranking, for the orchestrator to decide:** Hono first (`http-gateway.md` plus `mcp-servers.md`), with agentgateway deferred until third-party servers actually need aggregating.
- **Tell the user:** this reads "one entry point" as one port with several MCP URLs, which narrows part (a) of the working interpretation.

**C4. agentgateway's stdio cost is higher than reported, and the "keep stateful mode" mitigation does not cover it.** Source trace.
- Modern-protocol requests take `serve_stateless` even in stateful mode (`if !protocol.uses_sessions()`, [`streamablehttp.rs`](https://github.com/agentgateway/agentgateway/blob/v1.7.0/crates/agentgateway/src/mcp/streamablehttp.rs) lines 187-189). That path calls `build_new_connections`, which spawns each stdio target.
- So Claude Code's `server/discover` probe should spawn and tear down every stdio target, and the `initialize` fallback then spawns them again.
- Claude Code's session recovery sends two concurrent `initialize` calls, then a third, and leaks the extra sessions ([#96733](https://github.com/anthropics/claude-code/issues/96733), open). Each one would spawn all stdio targets, and those children would live until the TTL expires.
- A stdio child that dies is not respawned. `send_message` returns an error once `is_alive()` is false, so that target stays dead for the session. 1MCP has opt-in stdio recovery (README at the tag), which the report did not mention.
- **Change:** do not route in-repo servers through stdio targets. Use HTTP targets or Hono mounts.

**C5. A low `sessionTtl` is not a free mitigation.**
- The default is 30 minutes ([`mcp/mod.rs`](https://github.com/agentgateway/agentgateway/blob/v1.7.0/crates/agentgateway/src/mcp/mod.rs)). The report's sketch uses 10 minutes.
- An idle gap longer than the TTL sends the client through session recovery, which hits #96733. [#95018](https://github.com/anthropics/claude-code/issues/95018) (open) reports that recovery covers `tools/call` only, so the first resource read fails with `Connection closed`. The KB design delivers snapshot bodies as resources.
- Status: inferred from the issue reports, not observed on this setup. Keep the default until a test says otherwise.

**C6. "stdio targets are legacy-negotiated... Harmless for dual-era clients" understates the effect.**
- [The README](https://github.com/agentgateway/agentgateway/blob/v1.7.0/crates/agentgateway/src/mcp/README.md) says that when multiplexing, an error from any target on `server/discover` is returned to the client. One stdio target therefore drops the whole backend to legacy sessions, for every target on it.
- `subscriptions/listen` is rejected for stdio and SSE upstreams.
- So the report's own sketch, a stdio target on `/mcp`, puts that route on sessions. The benefit `http-gateway.md` cites for idle exit ("a restart loses no session state") then does not apply.
- [#3995](https://github.com/agentgateway/agentgateway/issues/3995) is confirmed open, and a maintainer calls it working as intended: "We cannot/do not translate the modern API down to the legacy API". Expect no fix.

**C7. `Origin` handling exists. The report is wrong that it was not found.**
- [`mcp/dns_rebinding.rs`](https://github.com/agentgateway/agentgateway/blob/v1.7.0/crates/agentgateway/src/mcp/dns_rebinding.rs) implements Host and Origin validation, enabled by `dnsRebindingProtection: true` on an MCP backend. It is **off by default**. [#1855](https://github.com/agentgateway/agentgateway/issues/1855) was opened 2026-05-18 and closed 2026-08-14.
- **Change:** set it on every MCP backend. A CEL rule is not needed.
- Limits: it covers MCP backends only, so plain `host:` routes stay unprotected. The allowed hosts are hard-coded to `localhost`, `127.0.0.1` and `::1`, so it may reject traffic arriving through Tailscale Serve. Test that before adding Tailscale.

**C8. `bindAddress: 127.0.0.1` is not enough to stay on loopback.** Source trace.
- Besides the listener, the stats port **15020** and readiness port **15021** default to the wildcard address ([`config.rs`](https://github.com/agentgateway/agentgateway/blob/v1.7.0/crates/agentgateway/src/config.rs) lines 356-369). The report covers only the listener and admin port.
- The admin port (localhost:15000) has no authentication by default, and I found no `Host` check in `ui.rs`, `admin.rs`, `hyper_helpers.rs` or `accept.rs`. It can write the config, and a config can name a stdio command.
- Plain cross-origin writes are blocked: `/api/config` needs JSON, `/api/config/raw` needs `application/yaml`, and CORS is an allow-list. DNS rebinding makes a request same-origin, so those guards do not apply to it. The report's bearer-key argument does not cover this port, and in mirrored mode a Windows browser can reach it.
- `POST /quitquitquit` has no content-type guard.
- Status: not exercised, and browser-side local-network protections were not assessed. Treat it as plausibly exploitable because the fix is one line.
- **Change:** `config.adminAddr: "off"` or a `unix:` path, plus `config.storage.mode: readOnly`. Quote `"off"`.

**C9. Running from a tracked YAML will write a secret into it.**
- v1.7.0 `ensure_session_key` generates an AES key and writes it back to `config.session.key` when the file is writable and storage mode is `file` (`config.rs`, `persist_session_key`). The report notes only "changed session encryption".
- The rewrite can also drop comments, because the fallback path re-serialises the whole document.
- **Change:** set `SESSION_KEY` from the systemd `EnvironmentFile`. `storage.mode: readOnly` also stops the write, but sessions then stay unencrypted unless `SESSION_KEY` is set as well.

**C10. Multiplexing rewrites resource URIs. The report says they are untouched.**
- With more than one target, or `prefixMode: always`, URIs are exposed as `<target>+<uri>`, for example `kb+kb://snapshot/1` (`resource_uri` in [`handler.rs`](https://github.com/agentgateway/agentgateway/blob/v1.7.0/crates/agentgateway/src/mcp/handler.rs)). A raw URI without the prefix fails with `invalid resource URI`. The docs' phrase "retain target routing information and are unaffected" is easy to misread.
- `resource_link` is not rewritten; there are no matches for it in `handler.rs`, `session.rs` or `mergestream.rs`. So `mcp-servers.md` rules that put `kb://snapshot/{id}` and `resource_uri` in tool results would return URIs that the same endpoint then rejects.
- Instructions are merged into one string. Claude Code truncates server instructions at [4,096 characters](https://code.claude.com/docs/en/mcp), so later servers lose theirs ([#4236](https://github.com/agentgateway/agentgateway/issues/4236), open).
- Single-target backends pass through unchanged. **Keep one target per route.**
- Merged lists are sent with `ttlMs: 0` and `cacheScope: private` (`handler.rs`), so client caching of tool lists is off. Effect on Claude Code not determined.

### 1.2 Corrections to facts and risks

**C11. 1MCP telemetry is not in the released version.** Product Usage Telemetry landed on `main` on 2026-10-29 ([#705](https://github.com/1mcp-app/agent/commit/b137a4a15)). The v0.39.7 README does not mention it, and the only file at that tag with "telemetry" in its path is an ADR. The risk applies to a future 0.40+ upgrade. Set `DO_NOT_TRACK=1` then.

**C12. New 1MCP risk: an old SDK is a runtime dependency.** v0.39.7 pins `@modelcontextprotocol/sdk` **1.30.0**, inside the affected ranges of GHSA-6qxp-vccf-f47h (high), GHSA-46jr-4wx8-v453 (high), GHSA-22jm-h49p-29qw (high), GHSA-f897-62hf-6gxq (high), GHSA-rvq5-wwqv-78pq and GHSA-6prh-2h8m-c8cw ([advisories](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories)). Whether 1MCP reaches those code paths is not determined.

**C13. mcpproxy-go is not dual-era on HTTP.** This resolves the report's open question. At v0.72.0 the client-facing Streamable HTTP surface is pinned to legacy versions, and the upstream hop is too: "mcpproxy does not yet serve the 2026-07-28 era on the upstream hop" ([`server.go`](https://github.com/smart-mcp-proxy/mcpproxy-go/blob/v0.72.0/internal/server/server.go) `clientFacingStreamableOptions`, `connection_lifecycle.go`). It still works for dual-era clients such as Claude Code, as a legacy server.

**C14. FastMCP.**
- [#5267](https://github.com/PrefectHQ/fastmcp/issues/5267) is **closed** (2026-09-25, completed), not an open bug.
- #5260 is still open and [PR #5263](https://github.com/PrefectHQ/fastmcp/pull/5263) is unmerged, so that one is not "addressed".
- "Would need a stdlib venv" does not work as stated: `ensurepip` is missing here, confirmed with `python3 -m ensurepip`. This also contradicts `mcp-servers.md`, which recorded the gap. Installing `python3-venv` is the likely fix and needs sudo.

**C15. ext-apps.** The `latest` mismatch is explained: 2.1.0 was a version bump reverted the same day (commit `Revert "Bump version to 2.1.0 (#833)" (#835)`), with no tag or GitHub release. It went up 75 minutes **after** 2.0.4, not before. Never pin 2.1.0.

**C16. Licenses.** npm reports MIT for ext-apps and conformance, but both repos' `LICENSE` is the MCP transition text: new code Apache-2.0, older contributions MIT, docs CC-BY-4.0. This is compatible with personal use.

**C17. Hono v5 is in release candidate, and no report mentions it.** `next` is `5.0.0-rc.1` (2026-10-10). `@modelcontextprotocol/hono` 2.0.2 peers `hono ^4.11.4`, so stay on v4 until that widens. `@hono/node-server` 2.1.5 already allows `^4 || ^5.0.0-0`.

**C18. Security advisories no report mentions.** All are patched at the recommended versions, so these are floors, not blockers.
- agentgateway: [GHSA-qm3r-hhvc-62cp](https://github.com/agentgateway/agentgateway/security/advisories/GHSA-qm3r-hhvc-62cp) and [GHSA-7hv4-jgp9-mgx2](https://github.com/agentgateway/agentgateway/security/advisories/GHSA-7hv4-jgp9-mgx2) were fixed in v1.7.0, and [GHSA-mvgg-jvj2-4frq](https://github.com/agentgateway/agentgateway/security/advisories/GHSA-mvgg-jvj2-4frq) (high) in v1.4.0. Session reuse across routes has now appeared twice, so avoid relying on route-level MCP policy to separate tools of different trust.
- Hono `serveStatic` middleware bypass, fixed in `hono` 4.13.11 and `@hono/node-server` 2.1.3. This is relevant because the plan puts middleware in front of static files.
- TS SDK: GHSA-jm63-cq47-j5jp, GHSA-46jr-4wx8-v453 and GHSA-rvq5-wwqv-78pq, all fixed by 2.3.0.

**C19. Claude Code reconnection is more limited than `http-gateway.md` states.**
- The docs add background retries of "up to about half an hour". Independent runs on 2.1.310 ([#101280](https://github.com/anthropics/claude-code/issues/101280), open) measured 8 background attempts over about 10-13 minutes, then permanent loss of the tools.
- A server that is down when the session starts is never retried. Socket activation helps here, since the port accepts connections with no process running. A plain agentgateway daemon does not.

**C20. Host and Origin allow-list is not a Hono middleware.** `http-gateway.md` calls the stack "all library use", but Hono ships no Host check. Use `hostHeaderValidationResponse` and `originValidationResponse` from `@modelcontextprotocol/server`, as [the SDK docs](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/docs/serving/web-standard.md) show. The same report's table also says "Via `@hono/mcp` 0.3.5", which `mcp-servers.md` rejects as SDK v1. Use `@modelcontextprotocol/hono`.

**C21. Cold-start figure.** The Node result reproduces, but "about 45 ms" is optimistic. The report's own script gave 55-72 ms across 20 runs at load average 12, and a bare `node:http` server under `timeout` gave 70-81 ms. All of it is well under 200 ms. Those numbers exclude importing the MCP SDK, Zod and Hono, so a real gateway will be slower by an unmeasured amount.

**C22. Spec wording.**
- `Mcp-Name` is required only for `tools/call`, `resources/read` and `prompts/get`, not on every POST.
- "Parsing the body is required" holds for servers and aggregators. The spec's headers exist so [intermediaries can route without parsing](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), so `http-gateway.md` is also right.

**C23. Smaller items.**
- `#76257` in `mcp-servers.md` is closed as not planned by a stale bot. It was not fixed.
- Tailscale latest is v1.104.4 (2026-10-28), BSD-3-Clause, which fills in the report's "unknown". Identity headers are not added for tagged devices, and the CLI docs say "only `http://127.0.0.1` is supported for proxies".
- WSL installed is 3.0.3.0, the latest. systemd is 259.9.
- systemd's license is per-file SPDX, and GitHub reports GPL-2.0, so "LGPL-2.1-or-later" is imprecise. This does not matter for a component already in the OS.
- The Python `mcp` version check holds: 2.3.0, 2026-10-02.

---

## 2. What each recommendation should now say

### Track 1: `mcp-gateways.md` (agentgateway as the single entry point): partly refuted

The version, license, activity and Docker-free claims hold. So does "no custom gateway". Refuted or insufficient: the hardening list (C7, C8, C9), the `sessionTtl` advice (C5), stdio as the KB path (C4, C6) and the "single entry point" framing (C3). The fallback remains reasonable, with C11 and C12 added.

If agentgateway is used, this hardened shape replaces the sketch. Every key was checked against the v1.7.0 schema, but the file was not run.

```yaml
config:
  adminAddr: "off"              # or unix:/path/to/socket
  statsAddr: 127.0.0.1:15020    # or "off"
  readinessAddr: "off"
  storage: { mode: readOnly }   # blocks UI writes and key write-back
  # SESSION_KEY comes from the systemd EnvironmentFile
gateways:
  default: { port: 8787, bindAddress: 127.0.0.1 }
routes:
- matches: [{ path: { pathPrefix: /mcp/kb } }]
  policies:
    apiKey:
      mode: strict
      location: { header: { name: authorization, prefix: 'Bearer ' } }
      keys: [{ keyHash: 'sha256:<hex>' }]   # the repo holds only a hash
  backends:
  - mcp:
      dnsRebindingProtection: true
      targets:                              # one HTTP target per route
      - name: kb
        mcp: { host: http://127.0.0.1:8788/mcp/kb }
- matches: [{ path: { pathPrefix: / } }]
  backends: [{ host: 127.0.0.1:8788 }]
```

### Track 2: `mcp-servers.md` (official SDK v2, per-server mounts): stands, with two fixes

The SDK, Hono adapter, Inspector, plugin constraints and MCP Apps deferral all hold. Fix C1 and C2. Also add the `resource_uri` caveat from C10 if a server ever sits behind a multi-target backend. Bun behaviour remains unproven, so the spike stays the right first step.

### Track 3: `http-gateway.md` (one Hono app on Node 26): stands best

Versions, exports, WSL settings and both local measurements hold. Apply C19, C20 and C21, and resolve its "not verified" list as follows:
- agentgateway API keys do work with `Authorization: Bearer`, using `location.header`.
- No socket activation was found in agentgateway.
- `@hono/node-server` 2.1.5 exports `createAdaptorServer` and it returns an `http.Server`, so `listen({fd:3})` is a Node call. This has still not been run through Hono.

---

## 3. Claims that held up

| Claim | Evidence |
|---|---|
| agentgateway v1.7.0, 2026-10-27, Apache-2.0 | [Release](https://github.com/agentgateway/agentgateway/releases/tag/v1.7.0); `LICENSE` at tag |
| 96 MB binary with sha256 asset, no Docker | Asset `agentgateway-linux-amd64` is 96,163,224 bytes; [install page](https://agentgateway.dev/docs/standalone/latest/setup/install/binary/) shows `--version` and checksum check, with a musl target |
| Very active, Linux Foundation project | Over 300 commits since 2026-10-01; README at tag. `howardjohn` leads with 1,320 commits, next 205 |
| OpenAPI 3.1 unsupported | [#119](https://github.com/agentgateway/agentgateway/issues/119) open; `openapiv3 = "2.2"` in `Cargo.toml` |
| `sessionTtl`, `bindAddress`, `failureMode`, `prefixMode`, `condition`, `mcpAuthorization`, route attachment | Schema at tag. An unset `routes[].gateways` attaches to `default`, so the sketch's shape is valid |
| Static `host:` loopback unaffected by the v1.7.0 change | `dynamic` is a separate backend kind; the v1.7.0 example uses `host: 127.0.0.1:8080` |
| Hot reload except `config:` | [Config docs](https://agentgateway.dev/docs/standalone/latest/configuration/overview/) |
| No tool search; no conformance results | Zero code hits; [#2707](https://github.com/agentgateway/agentgateway/issues/2707) open |
| 1MCP v0.39.7, Apache-2.0, dual-era, conformance work, packaged binary | [Changelog](https://github.com/1mcp-app/agent/blob/v0.39.7/CHANGELOG.md); `1mcp-linux-x64.tar.gz`; #459 closed 2026-10-29 |
| 1MCP lazy mode does not reduce processes; bus factor one | README at tag; `xizhibei` 598 commits, next human 11 |
| Caddy v2.11.7, Apache-2.0, `.deb`, `fd` networks, SSE flush | Release assets; `listeners.go` at tag; [PR #7243](https://github.com/caddyserver/caddy/pull/7243) merged for v2.11.1; [docs](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) |
| mcpproxy-go v0.72.0, MIT | Release; dominant maintainer `Dumbris` |
| FastMCP 4.1.4, Apache-2.0, 3.10+ including 3.14, 200-500 ms, fresh session per call | PyPI; [proxy docs](https://gofastmcp.com/servers/providers/proxy) |
| TS SDK 2.4.0 (2026-10-23), mixed license, Bun named in README, `legacy: 'stateless'`, no Host check on bare handler | npm exact date; files at `v2.4.0` |
| `@modelcontextprotocol/hono` 2.0.2 (2026-10-02), peers, DNS rebinding protection | npm exact date; `docs/serving/hono.md` |
| Inspector 2.13.0, Node 22.19+, plaintext secrets without a keychain, `--format json` | npm; README and `clients/cli/README.md` at tag |
| mcp-use 2.12.2, MIT, Node 22.22.2+, pins SDK 2.3.1 and ext-apps 2.0.3 | npm |
| Hono 4.13.14 (2026-10-25), node-server 2.1.5 (2026-10-13), MIT, listed exports | npm exact dates |
| `Bun.serve({fd:3})` ignores the fd | Reproduced 5 of 5: logs `bun listening 3000 localhost`, clients time out. [PR #44013](https://github.com/oven-sh/bun/pull/44013) open; Bun 1.4.4 is latest |
| Node `listen({fd:3})` works | Reproduced 5 of 5 |
| systemd running at system and user level, `Linger=no`, mirrored networking | Read locally |
| WSL timeouts, defaults and sections | [wsl-config](https://learn.microsoft.com/en-us/windows/wsl/wsl-config); [systemd page](https://learn.microsoft.com/en-us/windows/wsl/systemd) |
| Spec 2026-07-28 is current; `-32020`, `-32022`, Base64 sentinel, Origin 403, compatibility matrix | [Release](https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2026-07-28); spec pages |
| Claude Code is dual-era | [Docs](https://code.claude.com/docs/en/mcp): asks servers about the newer revision and connects to others "as v1 does" |
| Claude Code limits: 4,096 and 16,384 chars, 25,000 tokens, 500,000 chars, 5-minute HTTP idle | Same docs |
| Changelog 2.1.302 entry | [Changelog](https://code.claude.com/docs/en/changelog) |
| Plugin dependency rules | [plugins/loading](https://code.claude.com/docs/en/plugins/loading): "git, GitHub, folder, workspace, or linked dependency gets no install" |
| Claude Code does not render MCP Apps | [Client matrix](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/extensions/client-matrix.mdx); docs on `ui://` |

---

## 4. Could not determine

- **Idle memory** of agentgateway and 1MCP. Measuring needs execution.
- **Claude Code through agentgateway with a static key.** No report found either way. Issues show Claude Code reaching it only through OAuth, and [#3668](https://github.com/agentgateway/agentgateway/issues/3668) is an open failure in that path, which matters if the setup ever goes public.
- **Whether C4 happens as read.** It may be short-circuited somewhere I did not trace. Count child processes in the smoke test.
- **Child teardown after TTL.** The source chain looks complete: the reaper drops the entry, the sender closes, the loop breaks, then `proc.close()` runs. Not run, so it stays on the smoke-test list.
- **Whether the admin path in C8 is exploitable** from a current browser.
- **Whether tool `_meta` such as `anthropic/alwaysLoad` survives agentgateway.** I saw `rewrite_tool_list_ui_meta` but did not trace ordinary keys.
- **Whether `dnsRebindingProtection` rejects Tailscale Serve traffic.**
- **Bun on SDK v2.** README support only. No Bun-specific open issue surfaced.
- **Hono with `listen({fd:3})`, and Hono proxying SSE.** Not run.
- **Whether Claude Code supports Tasks.** The client matrix says yes, while open issue #102347 asks for it. No decision depends on this.
- **Whether a localhost connection wakes a stopped WSL.** Reasonable inference only.
- **OpenAPI 3.1 handling** in any generator, until the KB contract exists.
- **Not re-checked, because they sit outside adopt/adapt or are conditional:** rejected candidates, Cloudflare options, cloud connector rules, DuckDB and SQLite statements, the WSL #13291 thread details, and 1MCP preset behaviour.
