# Network map data inventory (read-only, 2026-11-01)

No token, address, MAC or hostname appears here. Node names in the original are replaced with `<node>` for this repo copy. Tool = `mcp__plugin_tower_tower__proxmox_*` (token role `PVEAuditor` at `/`, confirmed by `GET /access/acl`; GET-only client, `plugins/proxmox/skills/proxmox/SKILL.md:27`).

## Headline
The cluster is nearly empty: 3 nodes, quorate, **1 QEMU VM, 0 LXC**. Docker, router, WAN, VPN, DNS server, reverse proxy and metrics collectors are **not described anywhere readable** (and Docker/guest IPs are not reachable). A 2.5D map today = 3 nodes + their bridges + 1 VM + storage + a gateway node inferred from node config. Everything beyond that needs new data.

## Q1 Compute
| Fact | Call | Result |
|---|---|---|
| Quorum, node membership, online flags | `cluster_overview` | 3 nodes online, quorate=1, cluster config version 3. HA: quorum OK, fencing standby |
| VMs/LXCs | `list_resources type=vm` | 1 entry: qemu/100, running, 4 vCPU, 16 GiB, 64 GiB disk, uptime ~8.6 d, netin/netout counters, on <node>. No LXC rows |
| Node load, uptime | `/cluster/metrics/export` (also `node_status`) | per node: uptime, cpu, mem, swap, disk, net_in/net_out; per guest and storage too. One call covers whole cluster, ~9 KB |
| Tags | `guest_config`, `/cluster/options` | VM has no `tags` key; `allowed-tags` empty. Nothing to group by |
| HA resources | `/cluster/ha/resources` | `[]` (VM `ha.managed=0`) |
| Backup jobs | `/cluster/backup` | `[]` |
| Storage | `list_resources storage`, `/nodes/<node>/storage` | `local` (dir) and `local-lvm` (lvmthin) per node |
| Freshness | status `cluster_overview` / `list_resources` | live snapshot, server latency 2-30 ms (calls.jsonl, 43 calls). Node metrics ~10 s tick; `rrddata` hour = 1-min buckets, 70 points |
| Change feed | `recent_tasks` | **Pull only, no events/webhook.** Last 5 tasks: 3x aptupdate, startall, vncshell. Poll `recent_tasks` (limit up to 200, newest first) and diff `list_resources` |

## Q2 Network
| Fact | Endpoint | Status |
|---|---|---|
| SDN zones, vnets | `/cluster/sdn/zones`, `/cluster/sdn/vnets` | available, **empty** (`list_resources type=sdn` shows only the implicit `localnetwork` zone x3). `/cluster/sdn/ipams` has only the builtin `pve` ipam; `/cluster/sdn/dns` empty |
| Node bridges, bonds, VLANs | `/nodes/{node}/network` (all 3) | available. Each node: one Linux bridge `vmbr0` (static IPv4 /24 + default gateway) over one NIC; the other NICs (2-3 per node) are present but unused. **No bonds, no VLAN interfaces** |
| Guest NIC -> bridge -> VLAN | `guest_config` qemu/100 | `net0` virtio on `vmbr0`, `firewall=1`, **no `tag=`** (no VLAN). Per-NIC counters in `/nodes/{n}/netstat` (vmid, dev, in/out) |
| Guest IPs | `/nodes/<node>/qemu/100/agent/network-get-interfaces` | **BLOCKED (500)** `QEMU guest agent is not running` (config has `agent=1`, the agent inside the VM is not running). `agent/get-osinfo` same. No LXC to ask |
| Firewall rules | `/cluster/firewall/rules`, `/nodes/<node>/firewall/rules`, `/nodes/<node>/qemu/100/firewall/rules`, `/cluster/firewall/groups` | available, **all empty**; options only a digest (firewall effectively unconfigured though services pve-firewall/proxmox-firewall run) |
| Routes | none in PVE API | only the default gateway field in node network config. No routing table endpoint |
| DNS/hosts | `/nodes/{n}/dns`, `/nodes/{n}/hosts` | available: search domain + one public resolver; hosts file lists node itself only |

403s hit: `GET /nodes/<node>/syslog` -> `PVE API 403: Permission check failed (/nodes/<node>, Sys.Syslog)`. No 403 on any network endpoint above. Not tried: `/nodes/{n}/journal` (same family, expect the same 403).

## Q3 Docker inside guests
- Proxmox API: **cannot** see Docker. QEMU guest agent has no Docker endpoint (and is not running anyway); LXC would only expose the container, not inner Docker.
- Existing Docker API / Portainer / agent: none in KB (searches 'docker portainer' no hit), docs (`grep` of docs/design, docs/research: Docker mentioned only as candidate dependency) or plugins. `docs/research/brief.md:12`: Docker Engine was installed on this WSL box 2026-10-31, `docker ps` now works with 0 containers (rc=0).
- No SSH/port probing done (out of scope). Smallest fix: see Gaps.

## Q4 External edge
- KB `kb_search` (EN+KO: router, gateway, WAN, VPN, tunnel, DNS, reverse proxy, firewall; proxmox homelab) returned only unrelated external articles and agent-harvest work notes; **no network-topology record**.
- `docs/research/understand-ecosystem.md:11,92,193`: no Tailscale, WireGuard, reverse proxy or tunnel exists; only access rule on record is "internal LAN /24 must be reachable". A domain is suspected owned (`:94`, inferred).
- Only edge facts derivable: the gateway address is the same /24 default gateway on every node (one router-ish hop, make, model, WAN unknown). Nodes share an internal DNS suffix.
- `/home/user/sagae-setup` is an empty git repo (no commits) - holds nothing.

## Q5 Monitoring
- `/cluster/metrics/server` -> `[]`: no InfluxDB/Graphite/OTel metric server is configured in PVE.
- No Prometheus/node_exporter in any doc; `docs/design/tower.md:76` lists Prometheus as explicitly *not* built.
- Built-in PVE stats (Q1, `rrddata`, `/cluster/metrics/export`, `status/current` with pressure and blockstat) are readable and enough for node/guest load.
- A Datadog MCP is attached to this session but nothing says it monitors the sagae cluster; not queried (unrelated product, would need its own check).
- Notification endpoints in PVE: types gotify/sendmail/smtp/webhook listed (builtin types, 4 entries) - irrelevant for map.

## Q6 Limits and size
- No rate limit enforced by the client (`plugins/proxmox/server/pve.mjs`: 8 s request timeout, GET only, failover across hosts; `tools.mjs:10` 1 s stall guard). PVE API daemon has no documented per-token limit; observed 43 calls, 2-30 ms typical, two 3 s failures (guest-agent 500).
- Sizes (characters, tower result): `cluster_overview` ~1 KB; `list_resources type=vm` ~0.6 KB per guest (1 guest now, ~60 per 100 guests estimated); node network ~1 KB/node; `metrics/export` ~9 KB total at 1 VM; `rrddata hour` per node/guest 40-45 KB; **`/nodes/{n}/report` 60 KB and exceeds the tool result limit - do not poll; likely contains config, was not read.**
- Full inventory poll for current size (cluster_overview + list_resources + 3x network + metrics/export + sdn) ~15 KB, ~15 calls. Suggested cadence: compute 10-30 s, network config 5-10 min.

## Gaps and smallest fixes
1. Guest IPs: install and start qemu-guest-agent in VM 100 (token already has the read rights).
2. Docker containers: need a Docker view per Docker host. Smallest: Docker Engine API read-only via a socket proxy (e.g. tecnativa docker-socket-proxy, CONTAINERS=1) or Portainer read token per host; not present today.
3. External edge: no readable source. Smallest: a hand-written `edge` record/KB fact (router model, WAN, domain, tunnels), or read-only API/SNMP token from the router.
4. Firewall/route/VLAN truth is empty because it is unconfigured; nothing to fix, map shows flat /24.
5. History/events: no change feed; only polling `recent_tasks`. Fix only if latency matters (PVE metric server push or webhook notification).
6. Syslog/journal: grant `Sys.Syslog` only if logs are wanted.

## Evidence index
- Tool calls dated 2026-11-01 via tower; names listed above.
- SKILL.md:27 (role), pve.mjs:10 (timeout), tools.mjs:10 (stall), tower.md:76 (Prometheus), understand-ecosystem.md:11,92,94,193, brief.md:12.
