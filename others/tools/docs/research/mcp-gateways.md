# MCP gateways and aggregators: research report

Date: 2026-10-31. Track: MCP gateways and aggregators for sagae-tools (solo developer, WSL2, no Docker).

Evidence labels:
- **[doc]** the project's docs, README or release notes
- **[src]** I read the source on the default branch through the GitHub API
- **[meta]** GitHub, npm or PyPI metadata
- **[vendor]** the vendor's own marketing claim, not independently checked
- **[inference]** my reasoning, not a stated fact

Nothing was installed or executed. **No memory figure in this report is measured.** I found no published idle RSS for any candidate, so that criterion stays open until a measuring stage.

---

## 1. Bottom line

- **Primary: agentgateway v1.7.0.** It is the only candidate that does both jobs in one no-Docker binary: MCP aggregation and ordinary HTTP routing.
- **Fallback: 1MCP v0.39.7 for MCP, plus Caddy v2.11.7 for HTTP.** No other no-Docker candidate does ordinary HTTP routing, so the fallback has to be two pieces.
- **Custom gateway: not justified.** Section 7 lists each gap found. All have a configuration or small-tool answer that is cheaper than owning a protocol translator.
- **The gateway does not remove the KB's process question.** agentgateway only routes. It cannot host KB read logic, so a KB read API remains a process somewhere. Section 6 gives ways to keep that process on-demand.

Three things to know before adopting agentgateway:

1. Its OpenAPI-to-MCP target cannot read OpenAPI 3.1, and the KB contract is 3.1.
2. It spawns stdio children per session, for every target that passes the condition. Nothing is pooled.
3. It has no tool-search feature. Claude Code's built-in tool search covers this for Claude Code only.

---

## 2. MCP specification as of October 2026

**Current revision: `2026-07-28`** ([versioning](https://modelcontextprotocol.io/specification/versioning), [release tag](https://github.com/modelcontextprotocol/specification/releases/tag/2026-07-28)). The [draft changelog](https://modelcontextprotocol.io/specification/draft/changelog) has no entries yet. The prior revision is `2025-11-25`.

### What changed ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog))

| Area | Change |
|---|---|
| Statelessness | `initialize` handshake and `Mcp-Session-Id` removed. Each request carries version and client capabilities in `_meta`. `tools/list` and similar no longer vary per connection. |
| Discovery | New mandatory `server/discover`. Mismatch returns `UnsupportedProtocolVersionError` (-32022). |
| Transport | HTTP GET stream and `resources/subscribe` replaced by `subscriptions/listen`. SSE resumability (`Last-Event-ID`) removed; a broken stream loses the in-flight request. |
| Server-to-client | Server-initiated requests replaced by Multi Round-Trip Requests: `InputRequiredResult`, then a client retry with `inputResponses`. All results carry a required `resultType`. |
| Tasks | Moved out of core into extension `io.modelcontextprotocol/tasks`. `tasks/result` replaced by polling `tasks/get` plus `tasks/update`. |
| Extensions | `extensions` field added to client and server capabilities. MCP Apps is `io.modelcontextprotocol/ui`. |
| Routing headers | `Mcp-Method` and `Mcp-Name` required on POST. `x-mcp-header` mirrors tool params into `Mcp-Param-*`. |
| Caching | `ttlMs` and `cacheScope` required on list results and `resources/read`. Deterministic `tools/list` order is a SHOULD. |
| Schema | `inputSchema` and `outputSchema` loosened to any JSON Schema 2020-12 keyword. |
| Auth | Dynamic Client Registration deprecated in favour of Client ID Metadata Documents. `iss` validation (RFC 9207). Credentials keyed by issuer. |
| Deprecated | Roots, Sampling, Logging, HTTP+SSE transport. Minimum window twelve months. |
| Observability | OpenTelemetry trace context conventions documented for `_meta`. |

### Ecosystem position

- Tier 1 SDKs ship the revision. Latest seen: TypeScript `@modelcontextprotocol/server` 2.4.0 (2026-10-23), Python `mcp` 2.3.0 (2026-10-02). [meta] ([TS releases](https://github.com/modelcontextprotocol/typescript-sdk/releases))
- Claude Code handles the new revision, with visible edges. Changelog 2.1.302 fixes servers that negotiate `2026-07-28` but omit `resultType`, `ttlMs` or `cacheScope` ([changelog](https://code.claude.com/docs/en/changelog)). Open issues: [Tasks extension unsupported](https://github.com/anthropics/claude-code/issues/102347), [`allOf`/`if`/`then` root schemas dropped](https://github.com/anthropics/claude-code/issues/95504).
- Roadmap ([post](https://blog.modelcontextprotocol.io/posts/mcp-roadmap/)): extend the Streamable HTTP model to local servers, including over stdio. Server Card `.well-known` metadata is still in progress. Expect another transport shift on the stdio side.

### What this means for a gateway

- **Dual-era is mandatory.** The [compatibility matrix](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning) shows modern-to-legacy and legacy-to-modern both fail without a dual-era party. A gateway is the natural translator. A legacy-only gateway only works while clients keep falling back.
- **Parsing the body is required.** Any server that processes the body MUST validate headers against it (-32020). Intermediaries acting on headers SHOULD reject versions that do not require validation ([transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)). A plain reverse proxy can pass MCP through but cannot safely aggregate or filter it.
- **Prefixing has a new cost.** [inference] A gateway that renames tools must rewrite the body and `Mcp-Name` together.
- **Non-ASCII names use a Base64 sentinel in `Mcp-Name`.** This applies directly to Korean resource URIs from the KB, so it needs a smoke test.
- **Sessions go away for modern pairs, so no session store is needed in principle.** Legacy clients and servers still need sessions, so gateways keep both paths.
- **Three relays are easy to miss:** `subscriptions/listen` fan-out, `input_required` retries, and task handles. [Bifrost currently fails `input_required`](https://github.com/maximhq/bifrost/issues/9241) on upstream calls.
- **Merged lists need a defensible `ttlMs` and `cacheScope`.** With per-client filtering the scope must be `private`. [inference]
- **Local servers still need `Origin` validation and loopback binding.** Both come from the transport's Security section.

---

## 3. Comparison of serious candidates

All "no Docker" answers mean no Docker needed to run on Linux or WSL2. "Spec" means support for `2026-07-28`.

| Criterion | agentgateway | 1MCP | mcpproxy-go | FastMCP proxy | MCPJungle | Bifrost |
|---|---|---|---|---|---|---|
| Version, date [meta] | v1.7.0, 10-27 | v0.39.7, 10-30 | v0.72.0, 10-27 | 4.1.4, 10-26 | 0.4.7, 10-30 | transports/v2.4.0, 10-29 |
| License | Apache-2.0 | Apache-2.0 | MIT | Apache-2.0 | MPL-2.0 | Apache-2.0 |
| Runtime | Rust binary, 96 MB on disk | Node, or packaged binary | Go binary | Python 3.10+ | Go binary, SQLite | Go binary, npx wrapper |
| No Docker | Yes | Yes | Yes (scanners are Docker) | Yes | Yes | Yes per vendor |
| stdio + HTTP upstreams | Yes | Yes | Yes | Yes | Yes | Yes |
| Spec | Yes, with gaps | Yes, conformance harness | Unconfirmed | Yes | No evidence | Partial |
| Namespacing | `prefixMode` | Not confirmed in sources read | Not confirmed in sources read | Yes | `server__tool` | Not checked |
| Per-client filtering | CEL on identity | Presets, tag filters | Agent tokens; filter not confirmed | Code | Groups; ACL in enterprise mode | Virtual keys |
| stdio start | On session; per session | At startup | Not documented | On request; fresh session | Per call by default | Not documented |
| Auth | JWT, API key, OAuth metadata | OAuth 2.1, off by default | OAuth, agent tokens | Code | Static tokens; enterprise mode | Virtual keys |
| Config in repo | YAML file | `mcp.json` + `config.toml` | JSON in `~/.mcpproxy` | Code | JSON, loaded into DB | `config.json` + UI |
| Hot reload | Yes, except `config:` | Yes, 500 ms debounce | Not documented | Restart | Not documented | Not documented |
| Logs, metrics | OTel metrics, logs, traces | Logs, health; metrics not documented | Activity UI | Code | `/metrics` | Telemetry plugin |
| Resources, prompts | Yes | Yes in principle | Not documented | Yes | Prompts yes, resources not mentioned | No, tools only |
| Non-MCP HTTP routes | **Yes, first-class** | No | No | `custom_route` possible (not verified in fetched pages) | No | No |
| REST to MCP | OpenAPI 3.0 only | No | No | OpenAPI (not verified here) | No | No |
| Token-cutting | None found | `tool_list`/`tool_schema`/`tool_invoke`, tool search | BM25 `retrieve_tools` | BM25 search transform | Tool groups | Code Mode |
| Maintenance | Linux Foundation; 100+ commits in October (query cap) | One dominant maintainer | One dominant maintainer | Prefect-backed | One dominant maintainer | Vendor-driven |
| Verdict | **Adopt** | **Fallback** | Runner-up | Escape hatch | Reject | Reject |

---

## 4. Deep notes on the shortlist

### agentgateway (primary)

**Why it wins**

- Releases include Linux binaries, and [standalone mode is driven by a flat YAML file](https://github.com/agentgateway/agentgateway). The [config model](https://agentgateway.dev/docs/standalone/latest/configuration/overview/) has `gateways`, `routes` and `mcp` as siblings. `config:` is the only section not reloaded dynamically.
- It does HTTP and MCP together. [Routes](https://github.com/agentgateway/agentgateway/blob/main/examples/traffic-http/config.yaml) match path, method, query and headers, and send to `host:` backends. [MCP targets can sit under `routes[].backends[].mcp`](https://agentgateway.dev/docs/standalone/main/mcp/connect/virtual/). So `/mcp`, `/api/kb` and `/` can share one port.
- Federation prefixes tools and prompts, leaves resource URIs untouched, and has `failureMode: failOpen`.
- `condition` (CEL) removes a target before it is contacted. `mcpAuthorization` filters results after ([README](https://github.com/agentgateway/agentgateway/blob/main/crates/agentgateway/src/mcp/README.md)). Rules can combine tool name and claims ([example](https://github.com/agentgateway/agentgateway/blob/main/examples/mcp-authorization/config.yaml)).
- Dual-era negotiation is implemented on rmcp 3.1 with legacy fallback. [src]
- The examples directory shows growth paths for later Proxmox hosting: `traffic-oidc`, `traffic-tailscale-auth`, `traffic-unified-gateway`, `mcp-apps`.
- It carries an LLM gateway the user does not need. That is unused weight, not a blocker.

**Risks found**

| Finding | Evidence | Mitigation |
|---|---|---|
| **OpenAPI target is 3.0 only.** Uses the `openapiv3` crate. | [Issue #119](https://github.com/agentgateway/agentgateway/issues/119), open since 2025-05. [src] | Do not auto-map the KB API. Write a small curated MCP server, which also gives far fewer tool definitions. Or generate a downlevelled 3.0 file for the gateway only. |
| **stdio spawns per session, not pooled.** `build_new_connections` runs at `initialize` and spawns every selected target. Stateless mode builds connections per request. | [src] `streamablehttp.rs`, `upstream/mod.rs` | Keep stateful mode for stdio. Set `config.mcp.sessionTtl` low. Use `condition` to narrow targets. Move frequently used servers to Streamable HTTP. |
| Idle teardown of children not confirmed. The reaper drops the session entry; I did not trace the child kill. | [src], partial | Check with a process listing in the smoke test. |
| **stdio targets are legacy-negotiated.** Modern clients fall back to `initialize`. | [README](https://github.com/agentgateway/agentgateway/blob/main/crates/agentgateway/src/mcp/README.md) | Harmless for dual-era clients. Would matter if a modern-only client appears. |
| **One legacy HTTP target breaks modern clients for the whole backend.** With `failOpen`, its tools are hidden from them. | [Issue #3995](https://github.com/agentgateway/agentgateway/issues/3995), open | Put legacy HTTP upstreams on their own route, or keep every in-repo HTTP server modern. |
| One failing stdio target fails `initialize` for the whole backend by default. Unpinned `mcp-server-time` breaks under SDK 2.x. | [Example](https://github.com/agentgateway/agentgateway/blob/main/examples/mcp-multiplex/config.yaml) | Use `failOpen`. Pin every server version. |
| **No `Origin` handling found** in `streamablehttp.rs` or by code search. Absence from search is weak evidence. | [src] | Bind to loopback and require a bearer key. A browser-driven rebinding attack cannot attach that header. [inference] Confirm with a test; add a CEL rule on `Origin` if needed. |
| **Default bind is all interfaces.** Admin defaults to localhost:15000. | [src] `local.rs`, `config.rs` | Always set `bindAddress: 127.0.0.1`. |
| No published conformance results. | [Issue #2707](https://github.com/agentgateway/agentgateway/issues/2707), open | Run a Claude Code smoke test before relying on it. |
| Fast release cadence with behaviour changes. v1.7.0 changed session encryption, loopback rules for dynamic backends, and error bodies. | [v1.7.0 notes](https://github.com/agentgateway/agentgateway/releases/tag/v1.7.0) | Pin the version and sha256. Read notes before upgrading. |
| Dynamic backends now reject loopback. | Same notes | Should not affect static `host:` backends. [inference] Use static hosts. |
| Hot reload does not cover `config:`. | [config docs](https://agentgateway.dev/docs/standalone/latest/configuration/overview/) | Restart for `sessionTtl` changes. |

**Sketch (untested).** Route-to-gateway attachment keys must be checked against the [schema](https://agentgateway.dev/schema/config). This shows shape only.

```yaml
config:
  mcp: { sessionTtl: 10m }
gateways:
  default: { port: 8787, bindAddress: 127.0.0.1 }
routes:
- matches: [{ path: { pathPrefix: /mcp } }]
  backends:
  - mcp:
      failureMode: failOpen
      targets:
      - name: kb
        stdio: { cmd: bun, args: [run, tools/mcp-kb/src/main.ts] }
- matches: [{ path: { pathPrefix: /api/kb } }]
  backends: [{ host: 127.0.0.1:8791 }]
- matches: [{ path: { pathPrefix: / } }]
  backends: [{ host: 127.0.0.1:8790 }]
```

### 1MCP (fallback, MCP half)

- Dual-era since [0.39.0](https://github.com/1mcp-app/agent/blob/main/CHANGELOG.md) (2026-10-09): cross-era translation, a conformance harness, and visible tool search. [Issue #459](https://github.com/1mcp-app/agent/issues/459) closed 2026-10-29.
- [Configuration](https://docs.1mcp.app/guide/essentials/configuration): `mcp.json` plus `config.toml`, hot reload on by default, OAuth 2.1 behind `--enable-auth`.
- Lazy mode reduces schema payload only. The docs say it does not reduce backend connections or processes, and static servers load at startup. So every stdio backend stays running. This is the mirror image of agentgateway's cost.
- Per-client filtering uses [preset URLs](https://docs.1mcp.app/commands/preset/url). The docs contradict themselves on unknown presets (HTTP 400 versus [falling back to all servers](https://docs.1mcp.app/commands/preset/)). Test this before trusting it as a security boundary.
- Telemetry is **on by default** outside CI ([README](https://github.com/1mcp-app/agent)). Set `DO_NOT_TRACK=1` or run `1mcp telemetry disable`.
- `xizhibei` has 598 commits; the next contributor has 11. Bus factor is one, with a very high release rate.
- Pair with [Caddy](https://github.com/caddyserver/caddy) v2.11.7 (Apache-2.0, 2026-10-03) for HTTP. This adds a second process.

### mcpproxy-go (runner-up, not chosen)

- Single Go binary with embedded UI. New tools are quarantined until approved. BM25 `retrieve_tools` search ([README](https://github.com/smart-mcp-proxy/mcpproxy-go)).
- Its [upgrade plan](https://github.com/smart-mcp-proxy/mcpproxy-go/blob/main/specs/058-mcp-2026-upgrade/plan.md) staged 2026-07-28 behind legacy pins. I could not confirm the current released state. It depends on mcp-go v1.0.0.
- Its own blog concedes that [pure BM25 degrades at scale](https://mcpproxy.app/blog/2026-03-19-bm25-accuracy-hybrid-search/). It has no HTTP routing. One dominant maintainer.
- Worth revisiting if quarantine matters, for example when running many third-party servers.

### FastMCP proxy (escape hatch)

- [`create_proxy`](https://gofastmcp.com/servers/providers/proxy) takes a multi-server config, namespaces components, connects lazily, and uses a fresh backend session per request. Version 4 is dual-era ([upgrade guide](https://gofastmcp.com/getting-started/upgrading/from-fastmcp-3)).
- It offers [BM25 search transforms](https://gofastmcp.com/servers/transforms/transforms), with a known [bug on task-enabled tools](https://github.com/PrefectHQ/fastmcp/issues/5267). Issue #5260 was [addressed by a PR](https://github.com/PrefectHQ/fastmcp/pull/5263), merge state not checked.
- It is a library, so using it means owning a small program. The docs warn of 200-500 ms proxied call latency over HTTP.
- Use only if a concrete transform is ever needed. uv is not on PATH, so it would need a stdlib venv.

---

## 5. Rejected, with the reason

| Project | Latest [meta] | Reason |
|---|---|---|
| **MCPJungle** | 0.4.7, 2026-10-30 | Closest near miss: Go binary, tool groups, `/metrics`. But no `server/discover` in the repo, and it pins mcp-go 0.58 (2026-08-11), while 2026-07-28 notes appear from [v1.0.0](https://github.com/mark3labs/mcp-go/releases). Config lives in a DB, not a declarative file. [README](https://github.com/mcpjungle/MCPJungle) says OAuth is unavailable; per-client ACLs need enterprise mode. stdio spawns per call by default. |
| **Bifrost** | transports/v2.4.0, 2026-10-29 | LLM gateway first. [Tools only](https://docs.getbifrost.ai/mcp/overview), no resources or prompts. No general HTTP routing documented. `input_required` [not relayed](https://github.com/maximhq/bifrost/issues/9241). npm wrapper is 1.6.3 while transports are 2.4.0. Code Mode is interesting; the 92.8% figure is [vendor]. |
| **LiteLLM** | v1.106.6, 2026-10-28 | Heavy Python LLM proxy. Two supply-chain compromises this year: [March](https://github.com/jctommasi/litellm-pwn-detect) (third-party analysis) and [October 21, v1.107.0](https://docs.litellm.ai/blog/security-incident-oct-21-2026) (official post-mortem). A gateway holds every credential, so this alone rules it out here. stdio needs `LITELLM_ENABLE_MCP_STDIO=true`. |
| **IBM ContextForge** | v1.1.0, 2026-10-20 | Requires Python `>=3.12,<3.14`; this machine has 3.14.4 and no uv. [meta] Dual-era support [still open](https://github.com/IBM/mcp-context-forge/issues/6218). Large surface: FastAPI, 40+ plugins, required secrets. REST-to-MCP is strong but oversized for one developer. |
| **Docker MCP Gateway** | tag v0.44.3, date not determined | Runs servers as containers and needs a Docker engine ([README](https://github.com/docker/mcp-gateway), [docs](https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/)). No Docker on this machine. |
| **Microsoft MCP Gateway** | tag v1.0.0, date not determined | [Kubernetes-native](https://github.com/microsoft/mcp-gateway): StatefulSets, Redis or Cosmos DB. |
| **Kong** | OSS 3.9.4, 2026-10-12 | [AI MCP Proxy](https://developer.konghq.com/plugins/ai-mcp-proxy/) needs 3.12+ and an enterprise AI license. |
| **Envoy AI Gateway, now Agent Router** | v1.2.0, 2026-10-07 | [Renamed](https://github.com/theagentrouter/agent-router). `aigw run` exists but is framed as an OpenAI-compatible router. MCP in standalone mode not verified. Kubernetes and Envoy shape. |
| **Obot** | v0.27.0, 2026-10-20 | [Control plane](https://github.com/obot-platform/obot) hosting servers as Docker or Kubernetes workloads. |
| **Pomerium** | v0.33.6, 2026-10-27 | Has a Linux binary and [`mcp_tool` policy](https://www.pomerium.com/docs/capabilities/mcp), but works per route; aggregation not documented; stdio not covered; needs an IdP. A possible identity front later if exposed beyond loopback. |
| **MetaMCP** | v2.4.22, 2025-12-19 | Docker Compose plus Postgres ([README](https://github.com/metatool-ai/metamcp)). No release in over ten months, last push June 2026. |
| **ToolHive** | v0.59.0, 2026-10-28 | [Runs servers via Docker or Podman](https://github.com/stacklok/toolhive). |
| **MCPHub** | v1.1.14, 2026-10-29 | Actively tracks the spec. Node, UI-first; semantic routing is [vector-based](https://github.com/samanhappy/mcphub). No HTTP routing. Not evaluated in depth; a fair third MCP-only choice. |
| **mcp-proxy variants** | sparfenyuk v0.13.0; TBXark v1.1.0; punkpeye v6.7.21 | Bridges rather than gateways. [TBXark](https://github.com/tbxark/mcp-proxy) aggregates in Go but lacks the policy and routing side. Useful as stdio-to-HTTP adapters only. |
| **mcpo** | v0.0.20, 2026-02-27 | MCP-to-OpenAPI one-way. No release in eight months. |
| **Unla, Lasso, mcp-hub, Archestra** | various | Not evaluated in depth. Unla and Lasso did not surface a reason to outrank the above; mcp-hub is stale (last push 2025-10); Archestra's platform scope is too large for this need. |

---

## 6. Interactions with the two tools

### Can the gateway be the KB's single always-on process?

Partly. The gateway can be the only *always-on* process, but it cannot *be* the KB API. agentgateway has no application logic, so reads must run in something else.

| Option | How | Fit |
|---|---|---|
| A. stdio MCP target | KB MCP server spawned per session, reaped after TTL | Good for agents. No help for the viewer's HTTP. |
| B. systemd socket activation | Gateway routes to a `host:` port; systemd starts the KB read server on first connect; it exits when idle | Best match for "no daemon". systemd **is running** on this WSL2 machine (`systemctl is-system-running` = running; `[boot] systemd=true`). Adds cold-start latency against the p95 target. Unmeasured. |
| C. Viewer backend reads the store directly | Viewer owns a read-only connection through a KB library | Bypasses the HTTP contract. Conflicts with the OpenAPI plan unless the library is the contract. |

Recommendation: A for agents and B for HTTP, sharing one read core. The KB ADR owns this decision. The gateway works with all three.

### OpenAPI 3.1 contract

Do not rely on agentgateway's OpenAPI target for the KB. Beyond the 3.1 gap, mapping a full API to tools inflates tool definitions. A curated KB MCP server with a handful of read tools is better on both counts.

### Token cost of tool definitions

- [Claude Code tool search](https://code.claude.com/docs/en/mcp) is on by default and defers MCP tool definitions. `alwaysLoad` works per server, and tool-level `_meta` `anthropic/alwaysLoad` needs v2.1.285+.
- So agentgateway's lack of tool search costs nothing for Claude Code. It would matter for clients without tool search.
- One side effect of aggregation: all tools appear as one server, so per-server `alwaysLoad` becomes all-or-nothing. Whether agentgateway forwards tool `_meta` is unverified.
- The cheapest token control on the gateway is exposing fewer tools through `condition` and `mcpAuthorization`.

### Viewer polling

At 30-60 s polling, gateway overhead should be irrelevant, but that is unmeasured. Avoid `/` catch-all surprises by giving the viewer its own prefix if the MCP path needs to stay stable. Static assets can pass through the same route.

---

## 7. Is a custom gateway justified?

**No.** Each gap against the working interpretation:

| Gap | Answer without a custom gateway |
|---|---|
| OpenAPI 3.1 not readable | Curated MCP server, or a downlevelled 3.0 file |
| stdio spawned per session | `sessionTtl`, `condition`, or HTTP for hot servers |
| No tool search | Client handles it for Claude Code; filter tools otherwise |
| `Origin` handling unconfirmed | Loopback bind plus bearer key, then test |
| KB daemon avoidance | Socket activation; not a gateway concern at all |
| Mixed legacy HTTP target breaks modern clients | Separate route |

A custom gateway would have to own dual-era translation, MRTR relay, `subscriptions/listen` fan-out, header-body validation and task routing. The spec changed that surface heavily three months ago, and the roadmap signals more transport change. That is the opposite of what a solo developer should own.

Custom code that **is** justified: the KB MCP server and a small on-demand KB read service. Those are tools, not gateways.

**Revisit only if:** a Claude Code smoke test fails with no upstream fix, and 1MCP plus Caddy also fails. Even then, prefer a thin FastMCP or SDK program scoped to the failing behaviour.

---

## 8. Checks for the next stage

These need execution, so they were out of scope here.

1. Idle RSS of agentgateway and 1MCP, with zero and three stdio targets.
2. Claude Code smoke test through agentgateway: list, call, prefix, reconnect, gateway restart.
3. A Korean resource URI through `Mcp-Name` Base64 encoding.
4. Child process count over two sessions and after `sessionTtl` expires.
5. `Origin` probe against the loopback port, with and without the key.
6. A mixed config serving MCP and two HTTP routes on one port, plus hot reload of a route.
7. Whether tool `_meta` such as `anthropic/alwaysLoad` passes through.
8. Socket-activated cold-start time against the 200 ms p95 target.

## 9. Could not determine

- Idle memory for every candidate.
- Dates for Docker and Microsoft tags (tags only, no GitHub Releases entry).
- Whether agentgateway relays Tasks and MRTR end to end. Extension capability merging exists in source; behaviour was not traced.
- mcpproxy-go's released protocol state, its stdio start behaviour and hot reload.
- Bifrost stdio start behaviour and whether the binary runs without its npx wrapper on WSL2.
- Whether 1MCP's `/mcp?preset=` rejects or falls open on an unknown preset.
- 1MCP metrics and namespacing, in the pages read.
- Whether the telemetry default in 1MCP's README applies to released 0.39.7 or only to the 0.40 beta line (commit landed 2026-10-29).
