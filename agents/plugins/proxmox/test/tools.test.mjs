import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createClient } from "../server/pve.mjs";
import { registerTools } from "../server/tools.mjs";

const NODE = "pve-node";

// Records every pve.get call and answers from `responses`, keyed by API path. It refuses a third
// argument, which could only be a way for a tool to steer the client, such as a method.
function fakePve(responses = {}) {
  const calls = [];
  return {
    calls,
    async get(...args) {
      assert.ok(args.length <= 2, `pve.get takes a path and params, got ${JSON.stringify(args)}`);
      const [path, params] = args;
      calls.push({ path, params });
      return responses[path];
    },
  };
}

async function connect(t, pve) {
  const server = new McpServer({ name: "proxmox-test", version: "0.0.0" });
  registerTools(server, pve);
  const client = new Client({ name: "tools-test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(() => client.close());
  return client;
}

const call = (client, name, args) => client.callTool({ name, arguments: args });
const success = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const failure = (message) => ({ isError: true, content: [{ type: "text", text: message }] });

// cluster_overview

test("cluster_overview combines cluster status and HA state", async (t) => {
  const pve = fakePve({ "/cluster/status": [{ name: "n1" }], "/cluster/ha/status/current": [{ id: "quorum" }] });
  const client = await connect(t, pve);

  assert.deepEqual(
    await call(client, "cluster_overview", {}),
    success({ status: [{ name: "n1" }], ha: [{ id: "quorum" }] }),
  );
  assert.deepEqual(pve.calls, [
    { path: "/cluster/status", params: undefined },
    { path: "/cluster/ha/status/current", params: undefined },
  ]);
});

test("cluster_overview ignores unknown arguments", async (t) => {
  const pve = fakePve({ "/cluster/status": [], "/cluster/ha/status/current": [] });
  const client = await connect(t, pve);

  assert.deepEqual(await call(client, "cluster_overview", { path: "/access" }), success({ status: [], ha: [] }));
  assert.deepEqual(
    pve.calls.map(({ path }) => path),
    ["/cluster/status", "/cluster/ha/status/current"],
  );
});

test("cluster_overview fails when the HA half of the overview fails", async (t) => {
  const pve = {
    async get(path) {
      if (path === "/cluster/status") return [];
      throw new Error("PVE API 403: HA denied");
    },
  };
  const client = await connect(t, pve);

  assert.deepEqual(await call(client, "cluster_overview", {}), failure("PVE API 403: HA denied"));
});

// list_resources

test("list_resources passes no filter when type is omitted", async (t) => {
  const pve = fakePve({ "/cluster/resources": [{ id: "qemu/100" }] });
  const client = await connect(t, pve);

  assert.deepEqual(await call(client, "list_resources", {}), success([{ id: "qemu/100" }]));
  assert.deepEqual(pve.calls, [{ path: "/cluster/resources", params: { type: undefined } }]);
});

// sdn is left out on purpose: PVE returns nothing for it today, and that is not behaviour to pin.
for (const type of ["vm", "node", "storage"]) {
  test(`list_resources forwards type=${type}`, async (t) => {
    const pve = fakePve({ "/cluster/resources": [] });
    const client = await connect(t, pve);

    assert.deepEqual(await call(client, "list_resources", { type }), success([]));
    assert.deepEqual(pve.calls, [{ path: "/cluster/resources", params: { type } }]);
  });
}

// node_status

test("node_status reads the status of the named node", async (t) => {
  const pve = fakePve({ [`/nodes/${NODE}/status`]: { pveversion: "9.2.2" } });
  const client = await connect(t, pve);

  assert.deepEqual(await call(client, "node_status", { node: NODE }), success({ pveversion: "9.2.2" }));
  assert.deepEqual(pve.calls, [{ path: `/nodes/${NODE}/status`, params: undefined }]);
});

// guest_config

test("guest_config defaults to a QEMU guest", async (t) => {
  const pve = fakePve({ [`/nodes/${NODE}/qemu/100/config`]: { name: "vm" } });
  const client = await connect(t, pve);

  assert.deepEqual(await call(client, "guest_config", { node: NODE, vmid: 100 }), success({ name: "vm" }));
  assert.deepEqual(pve.calls, [{ path: `/nodes/${NODE}/qemu/100/config`, params: undefined }]);
});

test("guest_config reads an LXC guest when asked", async (t) => {
  const pve = fakePve({ [`/nodes/${NODE}/lxc/101/config`]: { hostname: "ct" } });
  const client = await connect(t, pve);

  assert.deepEqual(
    await call(client, "guest_config", { node: NODE, vmid: 101, kind: "lxc" }),
    success({ hostname: "ct" }),
  );
  assert.deepEqual(pve.calls, [{ path: `/nodes/${NODE}/lxc/101/config`, params: undefined }]);
});

// recent_tasks

const newestFirst = (count) => Array.from({ length: count }, (_, i) => ({ upid: `task-${i}`, starttime: count - i }));

test("recent_tasks returns the first 30 entries by default", async (t) => {
  const tasks = newestFirst(31);
  const client = await connect(t, fakePve({ "/cluster/tasks": tasks }));

  assert.deepEqual(await call(client, "recent_tasks", {}), success(tasks.slice(0, 30)));
});

test("recent_tasks accepts the limits at both ends of its range", async (t) => {
  const tasks = newestFirst(201);
  const client = await connect(t, fakePve({ "/cluster/tasks": tasks }));

  assert.deepEqual(await call(client, "recent_tasks", { limit: 1 }), success(tasks.slice(0, 1)));
  assert.deepEqual(await call(client, "recent_tasks", { limit: 200 }), success(tasks.slice(0, 200)));
});

test("recent_tasks returns everything when there are fewer entries than the limit", async (t) => {
  const tasks = newestFirst(2);
  const client = await connect(t, fakePve({ "/cluster/tasks": tasks }));

  assert.deepEqual(await call(client, "recent_tasks", { limit: 5 }), success(tasks));
});

// api_get

test("api_get forwards the path and its query parameters", async (t) => {
  const pve = fakePve({ "/nodes/n1/disks/list": [{ devpath: "/dev/sda" }] });
  const client = await connect(t, pve);

  assert.deepEqual(
    await call(client, "api_get", { path: "/nodes/n1/disks/list", params: { type: "unused" } }),
    success([{ devpath: "/dev/sda" }]),
  );
  assert.deepEqual(pve.calls, [{ path: "/nodes/n1/disks/list", params: { type: "unused" } }]);
});

test("api_get works without query parameters", async (t) => {
  const pve = fakePve({ "/version": { release: "9.2" } });
  const client = await connect(t, pve);

  assert.deepEqual(await call(client, "api_get", { path: "/version" }), success({ release: "9.2" }));
  assert.deepEqual(pve.calls, [{ path: "/version", params: undefined }]);
});

// Input rejection: the arguments never reach the client.

const invalidArguments = [
  ["list_resources", "an unknown type", { type: "bogus" }],
  ["node_status", "a missing node", {}],
  ["node_status", "an empty node", { node: "" }],
  ["node_status", "a node containing a slash", { node: "../access" }],
  ["node_status", "a node containing a newline", { node: `${NODE}\n` }],
  ["guest_config", "a missing vmid", { node: NODE }],
  ["guest_config", "a zero vmid", { node: NODE, vmid: 0 }],
  ["guest_config", "a negative vmid", { node: NODE, vmid: -1 }],
  ["guest_config", "a fractional vmid", { node: NODE, vmid: 1.5 }],
  ["guest_config", "a string vmid", { node: NODE, vmid: "100" }],
  ["guest_config", "an unknown kind", { node: NODE, vmid: 100, kind: "docker" }],
  ["guest_config", "a node containing a slash", { node: "a/b", vmid: 100 }],
  ["recent_tasks", "a limit below the range", { limit: 0 }],
  ["recent_tasks", "a limit above the range", { limit: 201 }],
  ["recent_tasks", "a fractional limit", { limit: 1.5 }],
  ["api_get", "a missing path", {}],
  ["api_get", "a non-string path", { path: 1 }],
  ["api_get", "non-string query parameters", { path: "/version", params: { limit: 1 } }],
];

for (const [name, reason, args] of invalidArguments) {
  test(`${name} rejects ${reason}`, async (t) => {
    const pve = fakePve();
    const client = await connect(t, pve);

    const result = await call(client, name, args);

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, new RegExp(`Invalid arguments for tool ${name}`));
    assert.deepEqual(pve.calls, []);
  });
}

// cluster_overview has no parameters to validate, so the protocol layer is its only input check.
test("cluster_overview rejects arguments that are not an object", async (t) => {
  const pve = fakePve();
  const client = await connect(t, pve);

  await assert.rejects(call(client, "cluster_overview", "nope"), /arguments/);
  assert.deepEqual(pve.calls, []);
});

// Paths the schema lets through still have to pass the real client, before any transport call.

const traversalAttempts = [
  ["api_get", { path: "/nodes/../access" }],
  ["api_get", { path: "nodes/n1/status" }],
  ["node_status", { node: ".." }],
  ["guest_config", { node: "..", vmid: 100 }],
];

for (const [name, args] of traversalAttempts) {
  test(`${name} refuses the path built from ${JSON.stringify(args)}`, async (t) => {
    const sent = [];
    const pve = createClient({
      hosts: ["a"],
      getToken: () => "t",
      transport: async (...request) => {
        sent.push(request);
        return { status: 200, reason: "OK", body: '{"data":null}' };
      },
    });
    const client = await connect(t, pve);

    const result = await call(client, name, args);

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid API path/);
    assert.deepEqual(sent, []);
  });
}

// Client failures become tool errors instead of protocol failures.

const validArguments = {
  cluster_overview: {},
  list_resources: {},
  node_status: { node: NODE },
  guest_config: { node: NODE, vmid: 100 },
  recent_tasks: {},
  api_get: { path: "/version" },
};

for (const [name, args] of Object.entries(validArguments)) {
  test(`${name} reports a client failure as an isError result`, async (t) => {
    const pve = {
      async get() {
        throw new Error("All PVE hosts unreachable (a: down)");
      },
    };
    const client = await connect(t, pve);

    assert.deepEqual(await call(client, name, args), failure("All PVE hosts unreachable (a: down)"));
  });
}
