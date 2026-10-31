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

Errors start with a code or with `PVE API <status>`. Act on that, not on a general sense that the cluster is down.

| Error | Meaning | What to do |
|---|---|---|
| `NODE_NOT_FOUND` | The cluster has no node by that name. The message lists the ones it has. | Use a listed name. |
| `TLS_VERIFY` | The hosts answered, but no certificate verified against the pinned CA. The cluster is not down. | Compare `certs/pve-root-ca.pem` (or `PVE_CA_FILE`) with the cluster CA, and check the node certificates for expiry. Never turn verification off. |
| `TIMEOUT` | No host answered, after 8 s each. | Check that this machine can reach 192.168.x.x/24. With `api_get`, also check any node name in the path: only `node_status` and `guest_config` detect a wrong one. |
| `REFUSED` | The hosts are up but refuse port 8006. | Check `PVE_HOSTS`, then whether `pveproxy` is running on the nodes. |
| `UNREACHABLE` | The hosts failed in different ways, or the connection was lost. | Read the reason given for each host in the message. |
| `BAD_REQUEST` | Refused before anything was sent: the path is malformed, or the token file holds invalid characters. | Fix the path (absolute, no `..`, no spaces or control characters) or the token file. Retrying unchanged will fail again. |
| `CA_FILE` | The CA file cannot be read. | Restore `certs/pve-root-ca.pem` or correct `PVE_CA_FILE`. The next call picks it up without a restart. |
| `NO_TOKEN` | This machine has no token file. | Get the user's approval, then run `scripts/bootstrap-token.sh` from this plugin. It changes tokens on the cluster. |
| `PVE API 400` | PVE refused a parameter. The message names it. | Fix that parameter. |
| `PVE API 401` | The token was rejected: revoked, rotated or expired. | Get the user's approval, then run `scripts/bootstrap-token.sh --rotate` from this plugin on this machine. |
| `PVE API 403` | The role lacks that permission. | Do not retry. Tell the user which permission the message names. |
