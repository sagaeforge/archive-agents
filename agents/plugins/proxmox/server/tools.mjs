import { z } from "zod";

const node = z.string().regex(/^[\w.-]+$/).describe("Node name, e.g. pve-node");
const vmid = z.number().int().positive().describe("Guest VMID");

export function registerTools(server, pve) {
  function tool(name, description, inputSchema, handler) {
    server.registerTool(
      name,
      { description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } },
      async (args) => {
        try {
          const data = await handler(args);
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: err.message }] };
        }
      },
    );
  }

  tool("cluster_overview", "Cluster quorum, node membership, and HA state.", {}, async () => ({
    status: await pve.get("/cluster/status"),
    ha: await pve.get("/cluster/ha/status/current"),
  }));

  tool(
    "list_resources",
    "List cluster resources with live usage across all nodes.",
    { type: z.enum(["vm", "node", "storage", "sdn"]).optional().describe("Filter; vm includes QEMU and LXC") },
    ({ type }) => pve.get("/cluster/resources", { type }),
  );

  tool("node_status", "CPU, memory, uptime, and version details for one node.", { node }, ({ node }) =>
    pve.get(`/nodes/${node}/status`),
  );

  tool(
    "guest_config",
    "Configuration of one QEMU VM or LXC container.",
    { node, vmid, kind: z.enum(["qemu", "lxc"]).default("qemu") },
    ({ node, vmid, kind }) => pve.get(`/nodes/${node}/${kind}/${vmid}/config`),
  );

  tool(
    "recent_tasks",
    "Most recent cluster task log entries, newest first.",
    { limit: z.number().int().min(1).max(200).default(30) },
    async ({ limit }) => {
      const tasks = await pve.get("/cluster/tasks");
      return tasks.slice(0, limit);
    },
  );

  tool(
    "api_get",
    "Read any Proxmox API path not covered by another tool, e.g. /nodes/pve-node/disks/list. GET only.",
    {
      path: z.string().describe("API path after /api2/json, starting with /"),
      params: z.record(z.string(), z.string()).optional().describe("Query parameters"),
    },
    ({ path, params }) => pve.get(path, params),
  );
}
