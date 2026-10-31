---
name: proxmox
description: Inspect the sagae internal Proxmox VE cluster (example-cluster; nodes pve-node, pve-node, pve-node) through the proxmox MCP tools. Use for questions about VMs, LXC containers, node health, storage, quorum, HA, or recent cluster tasks.
---

# Proxmox cluster

Three-node PVE 9 cluster `example-cluster` on the internal network.

| Node | Address |
|---|---|
| pve-node | 192.0.2.1 |
| pve-node | 192.0.2.1 |
| pve-node | 192.0.2.1 |

## Choosing a tool

Prefer these, in order:

1. `cluster_overview` for quorum and HA.
2. `list_resources` to find guests and which node holds them. Run this before `guest_config`, which needs the node.
3. `node_status`, `guest_config`, `recent_tasks` for detail.
4. `api_get` for any other read, such as `/nodes/<node>/disks/list` or `/nodes/<node>/qemu/<vmid>/snapshot`.

## Rules

- The MCP token holds only `PVEAuditor`, and the server issues only GET requests. A 403 means the role lacks that permission, not that the request needs retrying.
- For changes (start, stop, migrate, delete), do not fall back to `ssh root@...` on your own. Show the exact command and get the user's approval for that specific action. SSH reaches these nodes as root, so nothing else stands between a mistake and the cluster.
- Quorum needs two of three nodes. Before suggesting a reboot or maintenance, check `cluster_overview` and confirm the other two nodes are online.

## When a tool reports an error

API failures start with a code or with `PVE API <status>`. Act on that, not on a general sense that the cluster is down.

| Error | Meaning | What to do |
|---|---|---|
| `NODE_NOT_FOUND` | The cluster has no node by that name. The message lists the ones it has. | Use a listed name. |
| `TLS_VERIFY` | The hosts answered, but no certificate verified against the pinned CA. The cluster is not down. | Compare `certs/pve-root-ca.pem` (or `PVE_CA_FILE`) with the cluster CA, and check the node certificates for expiry. Never turn verification off. |
| `TIMEOUT` | No host answered, after 8 s each. | Check that this machine can reach 192.168.x.x/24. With `api_get`, also check any node name in the path: only `node_status` and `guest_config` detect a wrong one. |
| `REFUSED` | The hosts are up but refuse port 8006. | Check `PVE_HOSTS`, then whether `pveproxy` is running on the nodes. |
| `BAD_RESPONSE` | Every host answered 200, but with something that is not a PVE API response, such as a proxy's login page. | Check `PVE_HOSTS` and what answers on port 8006. |
| `UNREACHABLE` | The hosts failed in different ways, or the connection was lost. | Read the reason given for each host in the message. |
| `BAD_REQUEST` | Refused before anything was sent: the path is malformed, or the token file holds invalid characters. | Fix the path (absolute, no `..`, no spaces or control characters) or the token file. Retrying unchanged will fail again. |
| `CA_FILE` | The CA file cannot be read. | Restore `certs/pve-root-ca.pem` or correct `PVE_CA_FILE`. The next call picks it up without a restart. |
| `NO_TOKEN` | This machine has no token file. | Ask the user how to provide one. Read the note below before offering to run `scripts/bootstrap-token.sh`. |
| `PVE API 400` | PVE refused a parameter. The message names it. | Fix that parameter. |
| `PVE API 401` | The token was rejected: revoked, rotated or expired. | Read the note below, get the user's approval, then run `scripts/bootstrap-token.sh --rotate` from this plugin on this machine. It says so if the token file also needs `--keep-old`. |
| `PVE API 403` | The role lacks that permission. | Do not retry. Tell the user which permission the message names. |

`scripts/bootstrap-token.sh` changes tokens on the cluster, so it runs only with the user's approval. Check first which version this plugin has, with `grep -c -- --rotate scripts/bootstrap-token.sh` from the plugin directory. A count of 0 means the old version, which issues the one token all machines share. Do not run that version. On a machine with no token file it reissues the shared token, so every other machine gets 401, and `--rotate` reports nothing to do and changes nothing. Ask the user to copy a working token file from another machine instead, to `~/.config/proxmox-mcp/token` or the path in the error, with mode 600.

## Server log

Each API call writes one JSON line to the server's stderr: time, tool, host, path, duration, status and whether it failed over. Tokens, response bodies and query values never go in it. This is how to see which node answered and how long it took.

As of Claude Code 2.1.316, Claude Code stops reading a server's stderr once it has connected, so in a session those lines are lost and nothing here can show them. To keep them, the user starts Claude Code with `PVE_LOG_FILE` set to an absolute path in a folder that exists. The server appends the same lines to that file, which it creates with mode 600 and never trims.
