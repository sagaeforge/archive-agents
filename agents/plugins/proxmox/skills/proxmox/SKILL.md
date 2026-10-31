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

If tools report a missing token, run `scripts/bootstrap-token.sh` from this plugin.
