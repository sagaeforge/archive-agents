import { z } from "zod";
import { runAsTool } from "./log.mjs";
import { PveRequestError } from "./pve.mjs";

const node = z.string().regex(/^[\w.-]+$/).describe("Node name, e.g. pve-node");
const vmid = z.number().int().positive().describe("Guest VMID");

// A PVE call slower than this has stalled: well past a healthy answer, which takes milliseconds, and
// well short of a host timing out.
const STALL_MS = 1000;
const STALLED = Symbol("stalled");

// The outcome of `promise`, or STALLED if it takes too long. The promise itself goes on regardless.
async function orStalled(promise) {
  let timer;
  const stalled = new Promise((resolve) => {
    timer = setTimeout(resolve, STALL_MS, STALLED);
  });
  try {
    return await Promise.race([promise, stalled]);
  } finally {
    clearTimeout(timer);
  }
}

// Only a list that names nodes can prove one missing, so a failed lookup proves nothing.
async function clusterNodes(pve) {
  try {
    const members = await pve.get("/cluster/status");
    return members.filter(({ type }) => type === "node").map(({ name }) => name);
  } catch {
    return [];
  }
}

async function assertClusterNode(pve, node) {
  const nodes = await clusterNodes(pve);
  if (nodes.length > 0 && !nodes.includes(node)) {
    throw new PveRequestError(
      "NODE_NOT_FOUND",
      `"${node}" is not a node of this cluster. Its nodes are ${nodes.sort().join(", ")}.`,
    );
  }
}

// PVE does not refuse a node name it does not know: every host stalls until it times out, which
// takes 24 s and then looks like an outage. So a read that stalls or fails gets its node looked up,
// and a healthy read sends nothing extra. The read stays the answer unless the node is missing, and
// a lookup that stalls holds a finished read back by STALL_MS at most.
async function readFromNode(pve, node, path) {
  const read = pve.get(path);
  const lookUp = () => assertClusterNode(pve, node).then(() => read);

  const settled = read.then(
    () => "answered",
    (err) => (err.status >= 500 ? "failed" : "answered"),
  );
  const first = await orStalled(settled);

  if (first === STALLED) return Promise.race([read, lookUp()]);
  if (first === "failed") await orStalled(lookUp());
  return read;
}

export function registerTools(server, pve) {
  function tool(name, description, inputSchema, handler) {
    server.registerTool(
      name,
      { description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } },
      (args) =>
        runAsTool(name, async () => {
          try {
            const data = await handler(args);
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
          } catch (err) {
            return { isError: true, content: [{ type: "text", text: err.message }] };
          }
        }),
    );
  }

  tool("cluster_overview", "Cluster quorum, node membership, and HA state.", {}, async () => ({
    status: await pve.get("/cluster/status"),
    ha: await pve.get("/cluster/ha/status/current"),
  }));

  tool(
    "list_resources",
    "List cluster resources with live usage across all nodes.",
    {
      type: z
        .enum(["vm", "node", "storage", "sdn"])
        .optional()
        .describe("Filter; vm includes QEMU and LXC, sdn means SDN entries such as network zones"),
    },
    async ({ type }) => {
      if (type !== "sdn") return pve.get("/cluster/resources", { type });
      // PVE 9 lists SDN entries as type "network", which its own type filter neither matches nor accepts.
      const resources = await pve.get("/cluster/resources");
      return resources.filter((resource) => resource.type === "network" || resource.type === "sdn");
    },
  );

  tool("node_status", "CPU, memory, uptime, and version details for one node.", { node }, ({ node }) =>
    readFromNode(pve, node, `/nodes/${node}/status`),
  );

  tool(
    "guest_config",
    "Configuration of one QEMU VM or LXC container.",
    { node, vmid, kind: z.enum(["qemu", "lxc"]).default("qemu") },
    ({ node, vmid, kind }) => readFromNode(pve, node, `/nodes/${node}/${kind}/${vmid}/config`),
  );

  tool(
    "recent_tasks",
    "Most recent cluster task log entries, newest first.",
    { limit: z.number().int().min(1).max(200).default(30) },
    async ({ limit }) => {
      const tasks = await pve.get("/cluster/tasks");
      // PVE groups these by node, so the newest ones overall need sorting before the cut.
      return tasks.toSorted((a, b) => b.starttime - a.starttime).slice(0, limit);
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
