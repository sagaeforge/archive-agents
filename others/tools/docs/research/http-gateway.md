# HTTP gateway track: one entry point, access, lifecycle, KB hosting

Date: 2026-10-31. Scope: the non-MCP half of the gateway and how it stays running.
Local measurements were made on this machine (WSL2, 24 vCPU, Ubuntu 26.04, bun 1.4.4, node 26.13.0) with already-installed runtimes only. No third-party code was installed. Scripts are in `scratchpad/research/bench/`.

## 1. Verdict

1. **One process is enough to start.** Run one Hono app that serves the viewer UI, the viewer backend, the KB read API and `/mcp`. Do not put Caddy, Traefik or Envoy in front.
2. **Why no proxy.** No proxy can host the KB read code. Something must run application code anyway, and that same thing can route. A proxy adds a process and config language without removing either.
3. **One exception.** If the MCP track picks agentgateway for aggregation, use two processes: agentgateway in front (it does route plain HTTP) and the Hono app as its backend. Caddy is still not needed.
4. **KB needs no daemon.** The gateway can host the HTTP read surface. In-process library, per-request CLI spawn and socket-activated service all beat p95 < 200 ms on a synthetic graph (section 5). Latency does not decide this. Coupling does.
5. **Runtime: Node 26, not Bun, if socket activation is wanted.** `Bun.serve({fd:3})` on 1.4.4 silently ignores the fd and binds port 3000 (measured). Node `listen({fd:3})` works, with about 45 ms cold first response.
6. **Socket activation does not wake WSL.** It gives "no process until first hit" only inside a running distro. Nothing here makes a Windows browser boot WSL.
7. **Access: localhost now, Tailscale Serve when another device needs it.** Static bearer token for MCP. No oauth2-proxy or Pomerium.

## 2. Minimal architecture

```
Windows browser ──────────┐
Claude Code (WSL) ────────┤
Other tailnet device ─ tailscale serve (later, optional) ─┤
                          v
             127.0.0.1:8787  (systemd user .socket)
                          v  on first connection
             sagae-gateway: Hono on Node 26, exits after idle
               /             static viewer build (serveStatic)
               /api/viewer   viewer backend (route module, same process)
               /api/kb/v1    KB read surface, implements the KB OpenAPI contract
                             via KbReader: library | CLI | child process
               /mcp/*        MCP servers mounted in-process, or forwarded
               /healthz
             middleware: Host/Origin allow-list, bearer auth on /mcp, request log
```

All of it is library use, not a hand-written proxy. Hono 4.13.14 exports `bearer-auth`, `cors`, `logger`, `proxy`, `secure-headers`, `serve-static`, `ip-restriction`, `timeout` and `streaming` (checked with `npm view hono exports`). `@hono/node-server` exports `createAdaptorServer` ([source](https://github.com/honojs/node-server/blob/main/src/index.ts)) and `serveStatic`.

Viewer backend and KB read API as route modules means one crash domain. That is acceptable for read-only personal use. A separate process can come later without changing URLs.

### Comparison

| Option | Latest release | License | Activity | Runtime, no-Docker | Hosts KB code? | Static UI | MCP aware | Fit |
|---|---|---|---|---|---|---|---|---|
| **Hono** + `@hono/node-server` | hono 4.13.14, 2026-10-25; node-server 2.1.5 | MIT | pushed 2026-10-30 | npm package on Node or Bun, no Docker | **Yes** | Yes | Via `@hono/mcp` 0.3.5 or SDK | **Adopt** |
| **agentgateway** | v1.7.0, 2026-10-27 | Apache-2.0 | pushed 2026-10-30 | Binary, [install script or manual download](https://agentgateway.dev/docs/standalone/latest/documentation/setup/install/binary.md); no Docker needed | No | [Not listed in docs](https://agentgateway.dev/docs/standalone/latest/llms.txt) | Yes, stdio and OpenAPI targets | **Adapt**, only if MCP track picks it |
| **Caddy** | v2.11.7, 2026-10-03 | Apache-2.0 | pushed 2026-10-30 | Single binary, .deb release assets | No | Yes | No | Reject for now; first choice if a proxy is ever needed |
| **Traefik** | v3.7.17, 2026-10-30 | MIT | pushed 2026-10-30 | Release tarball | No | Not verified | [MCP governance is Hub-only, paid](https://doc.traefik.io/traefik/features/) | Reject |
| **Envoy** | v1.40.2, 2026-10-27 | Apache-2.0 | pushed 2026-10-30 | Not checked | No | No (prior knowledge) | Envoy AI Gateway v1.2.0 is separate; standalone mode not verified | Reject: config cost |
| **Pingora** | 0.9.0, 2026-09-09 | Apache-2.0 | pushed 2026-10-31 | Rust library; you write and compile a proxy. No cargo here | Only by writing Rust | No | No | Reject |
| **River** (Pingora proxy) | v0.5.0, 2024-08-30 | Apache-2.0 | last push 2024-09-06 | Not checked | No | Not checked | No | Reject: dormant |

Metadata comes from the GitHub and npm APIs on 2026-10-31.

Caddy facts, for later use:
- [Flushes `text/event-stream` immediately](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) and supports unix-socket upstreams.
- Has socket activation through `bind fd/3`. The source confirms the `fd` and `fdgram` networks ([listeners.go](https://github.com/caddyserver/caddy/blob/master/listeners.go)), and [named sockets merged for v2.11.1](https://github.com/caddyserver/caddy/pull/7243). The [conventions page](https://caddyserver.com/docs/conventions) does not list them.

agentgateway can mix an MCP route and a plain host route on one listener ([routes doc](https://agentgateway.dev/docs/standalone/latest/documentation/configuration/routes.md)). It also has [API key auth](https://agentgateway.dev/docs/standalone/latest/documentation/configuration/security/apikey-authn.md), JWT, CORS and access logs. Not verified: whether API keys work with `Authorization: Bearer`, and whether it can accept a systemd-passed socket. Its [MCP auth](https://agentgateway.dev/docs/standalone/latest/documentation/mcp/mcp-authn.md) validates tokens from an external authorization server.

### One process or proxy plus MCP gateway

| Layout | Processes | Operating cost | When |
|---|---|---|---|
| Hono only | 1 | One codebase, one unit pair | Default. MCP servers are few and mounted in-process, or at separate `/mcp/<name>` paths |
| agentgateway → Hono | 2 | One YAML, plus Hono. Front is always on, Hono can stay socket-activated at `host: 127.0.0.1:8788` | MCP track wants tool aggregation or stdio supervision |
| Caddy → Hono | 2 | Caddyfile plus one more binary to update | Only for LAN-wide TLS or several unrelated apps. Tailscale Serve covers TLS |
| Caddy → agentgateway → Hono | 3 | Three configs for one user | Never |

Keep separate `/mcp/<name>` paths until a single merged endpoint is shown to be needed. Claude Code handles several entries natively (`claude mcp add` per path).

### MCP protocol effect on the gateway

- Current revision is [2026-07-28](https://modelcontextprotocol.io/specification/versioning). [Streamable HTTP](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http) dropped the GET stream and protocol sessions. Each message is one POST.
- This suits idle exit: a restart loses no session state. Older revisions up to 2025-11-25 had `Mcp-Session-Id`, so mount any legacy-era server in stateless mode, or expect session loss on idle exit.
- `Mcp-Method` and `Mcp-Name` headers let an intermediary route or log without parsing bodies.
- `subscriptions/listen` is a long-lived SSE stream. Count open streams as activity in the idle timer. I did not determine whether Claude Code opens one.
- The spec requires `Origin` validation (403 if present and invalid), says local servers should bind to 127.0.0.1, and says servers should authenticate.
- Servers should send `X-Accel-Buffering: no` and periodic `:` SSE comments on long streams.

**Bun pitfall if Bun is used anywhere:** [Bun.serve closes idle connections after 10 s by default](https://bun.com/docs/guides/http/sse), and a quiet SSE stream counts as idle. Use `server.timeout(req, 0)` or set `idleTimeout`. [Field reports](https://github.com/oven-sh/bun/issues/27479) put the maximum at 255 s, with 0 disabling it.

## 3. Access and auth

### Reachability

| Mode | Setup | Reachable from | Verdict |
|---|---|---|---|
| **Localhost** | None. This host already has `networkingMode=Mirrored` in `.wslconfig` | Windows browser, WSL tools | **Adopt now** |
| **Tailscale Serve** | Install Tailscale, then `tailscale serve --bg 8787` | Own tailnet devices only | **Next step** when phone or laptop access is wanted |
| **Cloudflare Tunnel + Access** | Domain on Cloudflare, `cloudflared` | Public internet behind Access | Only if a Claude cloud connector is wanted |

Localhost notes:
- In [mirrored mode](https://learn.microsoft.com/en-us/windows/wsl/networking) Windows and WSL reach each other over `127.0.0.1`. In NAT mode `localhost` forwarding also works, with [`localhostForwarding` default true](https://learn.microsoft.com/en-us/windows/wsl/wsl-config).
- Bind `127.0.0.1` explicitly. Microsoft notes `::1` is not supported for Linux reaching Windows; do not assume it the other way either.
- Mirrored mode lets [Windows ports block Linux binds](https://learn.microsoft.com/en-us/windows/wsl/wsl-config) (see `ignoredPorts`). Pick a quiet port.
- Mirrored mode also allows LAN access once Hyper-V firewall rules are opened. A `127.0.0.1` bind avoids that.

Tailscale Serve notes:
- [Provisions TLS for the tailnet name and adds `Tailscale-User-Login`](https://tailscale.com/kb/1312/serve). It strips client-supplied copies, so a backend bound to localhost can trust the header.
- [`--bg` persists across reboots; `--set-path` maps paths](https://tailscale.com/docs/reference/tailscale-cli/serve).
- Serve is config on `tailscaled`, not a process of ours, but `tailscaled` is itself always on.
- Tailscale is not installed in WSL, and not at the default Windows path. I could not confirm from primary sources whether Serve on the Windows host reaches a WSL `127.0.0.1` service in mirrored mode, or whether `tailscaled` inside WSL is the better placement. Test before relying on it.

Cloud connector note:
- [Claude custom connectors connect from Anthropic's cloud](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), so a tailnet or localhost server fails. [Hostnames resolving to private or CGNAT addresses are rejected](https://claude.com/docs/connectors/building/troubleshooting).
- Claude Code in WSL has no such limit because it connects locally.
- For public exposure: Cloudflare Access [Managed OAuth](https://blog.cloudflare.com/managed-oauth-for-access) or Anthropic's [MCP tunnels](https://claude.com/docs/connectors/mcp-tunnels/overview) (documented as subject to change).
- [Secure MCP servers](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/) requires a hostname proxied through Cloudflare DNS, and Managed OAuth only for servers that validate the Access JWT.
- Not determined: free-plan seat limits and whether these features are on the free plan.

### What Claude Code requires

From the [Claude Code MCP docs](https://code.claude.com/docs/en/mcp):
- `--transport http` is the recommended remote transport. SSE is deprecated. WebSocket goes through `add-json`.
- Static auth: `claude mcp add --transport http sagae http://127.0.0.1:8787/mcp --header "Authorization: Bearer $TOKEN"`. With a configured `Authorization` header, Claude Code does not fall back to OAuth.
- `.mcp.json` headers support `${VAR}` expansion. `headersHelper` runs a command per connection and re-runs on 401 or 403.
- OAuth needs RFC 9728 metadata, then RFC 8414. Dynamic registration is the default; pre-configured `--client-id`, `--callback-port` and CIMD are also supported.
- Reconnect: up to 5 attempts mid-session, up to 3 retries on first connection. Connection refused during a WSL restart recovers within that window only if the gateway returns quickly.
- Tool calls abort after 5 minutes of silence on HTTP. Output limit defaults to 25,000 tokens.

[MCP authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization) is optional. So a static bearer token is valid for a personal setup. A public OAuth setup must implement Protected Resource Metadata and audience-bound tokens.

### Auth choice

| Layer | Choice | Reason |
|---|---|---|
| All routes | Host and Origin allow-list | Blocks DNS rebinding from any site in the Windows browser. Required for MCP, cheap for the rest |
| `/mcp/*` | Static bearer token via `hono/bearer-auth`, stored in an `EnvironmentFile` mode 600 | Works with Claude Code today with no IdP |
| Viewer UI and APIs, localhost | No login | Read-only, loopback-bound, same-user machine |
| Viewer UI and APIs, Tailscale | Check `Tailscale-User-Login` | Identity for free, no login page |
| **oauth2-proxy** v7.15.5, 2026-10-01, MIT | **Reject for now** | Needs an OIDC provider. Its [`skip_jwt_bearer_tokens`](https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview/) only passes verified JWTs, not static tokens |
| **Pomerium** v0.33.6, 2026-10-27, Apache-2.0 | **Reject for now** | [Linux tarball, no Docker needed, but the sample config expects an IdP](https://www.pomerium.com/docs/deploy/core). Real [MCP gateway features](https://www.pomerium.com/docs/capabilities/mcp) serve multi-user, upstream OAuth cases. Revisit if the setup goes public |

## 4. Lifecycle on WSL2

### Facts that shape the design

- ["systemd services will NOT keep your WSL instance alive."](https://learn.microsoft.com/en-us/windows/wsl/systemd)
- [`[general] instanceIdleTimeout`](https://learn.microsoft.com/en-us/windows/wsl/wsl-config) defaults to 15000 ms; -1 disables it. `[wsl2] vmIdleTimeout` defaults to 60000 ms and is Windows 11 only.
- `wsl --shutdown` stops all distros at once ([wsl-config](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)).
- [WSL issue 13291](https://github.com/microsoft/WSL/issues/13291): `vmIdleTimeout=-1` alone was not enough. The thread's fix sets both keys, and a maintainer edited his message to match.
- Field reports say [a `wsl.exe` client must exist or the distro stops within seconds](https://github.com/microsoft/WSL/discussions/9245). Common fix: a logon task running `wsl.exe -d <distro> --exec sleep infinity`, unticking the 3-day task limit.

Observed on this host: systemd on, `Linger=no`, no idle keys in `.wslconfig`, `autoMemoryReclaim=Gradual`, memory cap 48 GB. The installed WSL version was not checked; latest release is 3.0.3 (2026-10-09).

### What happens when

| Event | Result |
|---|---|
| Last WSL client exits | Distro stops after about 15 s by default. Gateway and socket unit die. |
| Viewer tab keeps polling | Inference, not documented: polling does not count as a client, so the tab starts failing. Show an "offline" state. |
| `wsl --shutdown` or Windows reboot | Everything stops. Nothing restarts until something launches WSL. |
| WSL restarts | Enabled socket units come back if the user manager runs, which needs `loginctl enable-linger sagae`. |
| Connection to a stopped WSL | Inference: a socket unit is a listener inside the VM, so nothing is listening and the connection fails. I found no primary statement that a localhost connection boots WSL. Assume it does not. Not tested, because testing from inside WSL requires stopping it. |
| Windows sleep or hibernate | Not researched. |

### Service manager

| Option | Verdict | Reason |
|---|---|---|
| **systemd user units + linger** | **Adopt** | Already running here. Socket activation, restart, journald, no new dependency. Same model in a Proxmox LXC |
| **systemd socket activation** | **Adopt**, via Node | Fits the KB's minimal-always-on principle |
| **pm2** 7.1.1, 2026-10-23 | **Reject** | Its own daemon, and [`pm2 startup` is itself systemd](https://pm2.keymetrics.io/docs/usage/startup/) on this host, so it adds a layer. No socket activation benefit. npm metadata lists AGPL-3.0 |

Sketch:

```ini
# ~/.config/systemd/user/sagae-gateway.socket
[Socket]
ListenStream=127.0.0.1:8787
[Install]
WantedBy=sockets.target

# ~/.config/systemd/user/sagae-gateway.service
[Service]
ExecStart=%h/.local/bin/node %h/sagae-tools/apps/gateway/dist/main.js
EnvironmentFile=%h/.config/sagae-gateway/env
Restart=on-failure
```

```ts
const server = createAdaptorServer({ fetch: app.fetch });
if (process.env.LISTEN_FDS === "1") server.listen({ fd: 3 });
else server.listen(8787, "127.0.0.1");
```

- Idle exit is app code: exit 0 when no request or open stream for N minutes. Set N above the 30-60 s poll, for example 10 minutes. The socket stays armed by systemd.
- With `Accept=no`, [one service handles all connections](https://www.freedesktop.org/software/systemd/man/latest/systemd.socket.html).
- Node is under nvm here, so use a stable symlink rather than a versioned path.
- The Hono adapter path was not tested, because nothing third-party could be installed. A bare `node:http` server with `listen({fd:3})` was.

### Bun and socket activation

- Measured on bun 1.4.4: `Bun.serve({fd:3})` logged `3000 localhost` and clients timed out, 10 of 10. It ignored the fd without an error.
- Matches open issues: [#22559](https://github.com/oven-sh/bun/issues/22559) and PR [#44013](https://github.com/oven-sh/bun/pull/44013).
- Workaround tested: a shell shim starts Bun on a private port and execs [`systemd-socket-proxyd`](https://www.freedesktop.org/software/systemd/man/latest/systemd-socket-proxyd.html). 7 of 10 runs took 16-19 ms; 3 took about 1.02 s, cause not diagnosed. It works but adds a moving part.
- Tradeoff: Bun starts faster and uses less memory (below), but Node gives working activation with no shim. Hono keeps the switch to a few lines, so this is reversible once #44013 lands.

### Keep-alive policy

1. **Level 0, default.** No keep-alive. The gateway works whenever a WSL session is open, which matches daily use with Claude Code.
2. **Level 1, if the viewer must work with no terminal.** Set `[general] instanceIdleTimeout=-1` and `[wsl2] vmIdleTimeout=-1`, plus a logon task that boots the distro. Cost: these are global, and the VM stays resident. Weigh this against the KB principle, because it trades one small process for a whole always-on VM.
3. **Level 2, if it must work with the PC off.** Move to a Proxmox LXC.

### Moving to Proxmox LXC later

- Same units, converted to system units with `User=`. Socket activation behaves the same, and a real always-on host removes the WSL problems above.
- Tailscale in LXC: [pass through `/dev/net/tun`](https://tailscale.com/docs/features/containers/lxc/lxc-unprivileged), for example `pct set CTID --dev0 /dev/net/tun`.
- **KB data must move with the gateway when using a local DB.** [SQLite WAL requires all processes on one host and does not work over a network filesystem](https://www.sqlite.org/wal.html). If the DB stays in WSL, the KB would then need a network read path.
- Keep the DB on ext4 inside WSL, never under `/mnt/c`.

## 5. KB integration: can the gateway host the read surface?

**Yes.** Measured on a synthetic SQLite graph: 10k nodes, 50k edges, 4.4 MB. A neighbor request returned 200 edges plus nodes, about 69 KB JSON. Client and server were in the same VM with a warm page cache.

| Path | p50 | p95 | Notes |
|---|---|---|---|
| In-process, `bun:sqlite`, sequential | 1.0 ms | 1.7 ms | n=1000 |
| In-process, 8 concurrent | 3.4 ms | 5.7 ms | n=800 |
| In-process via one extra HTTP hop | 1.5 ms | 2.1 ms | A proxy costs about 0.4 ms |
| Overview dump, all nodes and edges, in-process | 13.6 ms | 20.3 ms | 2.1 MB JSON, n=30. Sync, blocks the event loop |
| Spawn CLI per request, Bun | 9.6 ms | 11.1 ms | n=100 |
| Spawn CLI, Bun, 8 concurrent | 26.0 ms | 40.8 ms | n=200 |
| Spawn CLI per request, Node | 24.9 ms | 28.8 ms | n=100 |
| Spawn CLI per request, Python stdlib | 24.4 ms | 40.8 ms | n=100, no third-party imports |
| Socket-activated Node, first request | about 45 ms (41.7-47.7) | n/a | One cold start, then in-process speed |

Runtime startup alone, `-e 0` style: node 22 ms, bun 6 ms, python3 14 ms. Fresh-process RSS with SQLite open and a listener: Node 61 MiB, Bun 18 MiB.

**These numbers are an upper bound on what the plumbing allows, not a KB forecast.** They exclude FTS, Korean tokenizing, bitemporal filters, contract validation and heavy CLI imports. All paths have well over 150 ms of headroom left for those.

### Options

| Option | Fits | Weakness | Verdict |
|---|---|---|---|
| **In-process library** | KB in TS, compatible with the gateway runtime | Ties versions and crash domain. A sync query blocks the event loop, MCP streams included. `bun:sqlite` code will not run on Node | **Preferred** if KB is TS. Use a Worker for heavy queries |
| **Long-lived child over stdio** (`kb serve --stdio`) | Any KB language | KB must ship a small loop. Not in the original list | **Preferred** if KB is Python or Rust. Warm handle, no port, no daemon: the gateway starts and reaps it |
| **Per-request CLI spawn** | Any language, simplest contract | Startup cost is unbounded if the CLI imports grow. Spawn storms on facets and polling | **Fallback**. Set a startup budget of about 50 ms in KB CI |
| **Socket-activated KB service** | KB wants HTTP but no daemon | One more unit pair and port, and the KB owns HTTP after all | Works, but adds nothing over the two above while the gateway exists |

Design rule: put a `KbReader` interface in the gateway with one method per contract operation, returning contract JSON. Implementations swap without touching routes. Test every implementation against KB-owned fixtures.

### Constraints this imposes on the KB ADR

- **Storage engine concurrency decides whether a held read handle is safe.**
  - [SQLite WAL](https://www.sqlite.org/wal.html): readers and one writer coexist. Handle occasional `SQLITE_BUSY`.
  - [DuckDB](https://duckdb.org/docs/2.0/connect/concurrency.html): either one read-write process, or many read-only processes with no writer. A gateway holding a read handle would block ingest there, so it must open per request or read a snapshot.
  - Other engines: check the same way before choosing in-process.
- **Query path must be read-only by construction.** Open read-only, since the viewer is read-only by requirement.
- **Version check at startup.** The gateway should compare the contract version with what the library or CLI reports, and fail closed.
- **Overview responses are large.** At 2.1 MB for the synthetic graph, prefer a precomputed or compressed overview. Keep this out of per-request spawn.

## 6. Build order

1. Hono app with `/healthz`, Host/Origin check, static UI, fixture-backed `/api/kb/v1`, and `KbReader` returning KB fixtures. Nothing else depends on the real KB.
2. systemd socket and service units, plus `loginctl enable-linger`.
3. Mount the first MCP server with a bearer token. Verify with Claude Code.
4. Real `KbReader` when the KB ships.
5. Tailscale Serve when another device needs access. Test placement first.
6. Re-decide agentgateway with the MCP track.

## 7. Open questions

1. What language and storage engine does the KB use? This picks library versus stdio child, and decides whether a held read handle is safe.
2. Does the MCP track adopt agentgateway? This decides one process versus two.
3. Does the user want the viewer available with no WSL terminal open? This decides keep-alive level 0 or 1.
4. Is a Claude cloud connector needed? If yes, public exposure and OAuth enter scope.
5. If the KB ships TS on `bun:sqlite`, the gateway runtime conflicts with the Node choice. Resolve this with `node:sqlite` or the proxyd shim, or wait for Bun #44013.

## 8. Not verified

- agentgateway, Caddy, Traefik, Envoy and Pomerium were not run; claims come from docs and source.
- Hono's Node adapter with `listen({fd:3})`, `hono/proxy` SSE passthrough, and Hono MCP mounting on revision 2026-07-28.
- Tailscale placement on WSL. Latency from a Windows browser through mirrored networking.
- Whether Traefik serves static files (prior knowledge says no). Envoy AI Gateway standalone mode.
- Cloudflare free-plan limits and Tailscale pricing.
- Whether Claude Code accepts plain `http://` to loopback with a bearer header was not stated in the section read; expected to work, confirm in step 3.
