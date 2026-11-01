import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PveApiError, PveRequestError, createClient } from "../server/pve.mjs";
import { registerTools } from "../server/tools.mjs";

const NODE = "pve-node";

// Records every pve.get call and answers from `responses`, keyed by API path. An answer can be a
// function, to fail or to stall. It refuses a third argument, which could only be a way for a tool
// to steer the client, such as a method.
function fakePve(responses = {}) {
  const calls = [];
  return {
    calls,
    async get(...args) {
      assert.ok(args.length <= 2, `pve.get takes a path and params, got ${JSON.stringify(args)}`);
      const [path, params] = args;
      calls.push({ path, params });
      const answer = responses[path];
      return typeof answer === "function" ? answer() : answer;
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

for (const type of ["vm", "node", "storage"]) {
  test(`list_resources forwards type=${type}`, async (t) => {
    const pve = fakePve({ "/cluster/resources": [] });
    const client = await connect(t, pve);

    assert.deepEqual(await call(client, "list_resources", { type }), success([]));
    assert.deepEqual(pve.calls, [{ path: "/cluster/resources", params: { type } }]);
  });
}

// The entries of a real PVE 9 listing, cut down, plus the type older versions use for SDN zones.
const ZONE = { id: `network/${NODE}/zone/localnetwork`, type: "network", "network-type": "zone", network: "localnetwork" };
const OLD_ZONE = { id: `sdn/${NODE}/localnetwork`, type: "sdn", sdn: "localnetwork" };
const RESOURCES = [
  { id: "qemu/100", type: "qemu" },
  { id: `node/${NODE}`, type: "node" },
  { id: `storage/${NODE}/local`, type: "storage" },
  ZONE,
  OLD_ZONE,
];

test("list_resources filters type=sdn itself, because PVE's filter finds nothing", async (t) => {
  const pve = fakePve({ "/cluster/resources": RESOURCES });
  const client = await connect(t, pve);

  assert.deepEqual(await call(client, "list_resources", { type: "sdn" }), success([ZONE, OLD_ZONE]));
  assert.deepEqual(pve.calls, [{ path: "/cluster/resources", params: undefined }]);
});

test("list_resources reports a cluster without SDN entries as an empty list", async (t) => {
  const client = await connect(t, fakePve({ "/cluster/resources": [{ id: "qemu/100", type: "qemu" }] }));

  assert.deepEqual(await call(client, "list_resources", { type: "sdn" }), success([]));
});

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

// Telling a node the cluster does not have from one that is slow or failing. PVE stalls on a name it
// does not know, so the lookup has to start before the read gives up. Time is mocked here so that
// the delay can be pinned exactly; errors.test.mjs goes through it for real.

const STALL_MS = 1000;
const NO_HANG = { timeout: 5000 }; // These reads never end by themselves, so a regression must not hang the run.
const CLUSTER = [
  { type: "cluster", id: "cluster", name: "example-cluster", nodes: 2, quorate: 1 },
  { type: "node", id: "node/pve-node", name: "pve-node", online: 1 },
  { type: "node", id: `node/${NODE}`, name: NODE, online: 1 },
];
const unknownNode = (name) =>
  failure(`NODE_NOT_FOUND: That is not a node of this cluster. Its nodes are pve-node, pve-node.`);

const stall = () => new Promise(() => {});
const paths = (pve) => pve.calls.map(({ path }) => path);

const turn = () => new Promise(setImmediate);

// Lets the MCP exchange run. A condition that never comes true fails instead of hanging.
async function until(condition) {
  for (let i = 0; i < 1000 && !condition(); i++) await turn();
  assert.ok(condition(), `gave up waiting for ${condition}`);
}

function mockTime(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
}

// Starts a tool call and brings it to the moment its lookup has been sent. The result comes wrapped
// because the call is still running: an async function would wait for a promise it returns.
async function stallRead(t, client, pve, name, args) {
  mockTime(t);
  const result = call(client, name, args);
  await until(() => pve.calls.length === 1);
  t.mock.timers.tick(STALL_MS);
  await until(() => pve.calls.length === 2);
  return { result };
}

const nodeReads = [
  ["node_status", (node) => ({ node }), (node) => `/nodes/${node}/status`],
  ["guest_config", (node) => ({ node, vmid: 100 }), (node) => `/nodes/${node}/qemu/100/config`],
  ["guest_config", (node) => ({ node, vmid: 101, kind: "lxc" }), (node) => `/nodes/${node}/lxc/101/config`],
];

for (const [name, args, pathOf] of nodeReads) {
  const label = `${name} ${pathOf("x")}`;

  test(`${label} sends a healthy read alone, however long the wait after it`, async (t) => {
    const pve = fakePve({ [pathOf(NODE)]: { ok: true } });
    const client = await connect(t, pve);
    mockTime(t);

    assert.deepEqual(await call(client, name, args(NODE)), success({ ok: true }));
    t.mock.timers.tick(10 * STALL_MS);
    await turn();

    assert.deepEqual(paths(pve), [pathOf(NODE)]);
  });

  test(`${label} looks the node up once the read has stalled for the delay, not before`, NO_HANG, async (t) => {
    const pve = fakePve({ "/cluster/status": CLUSTER, [pathOf("ghost")]: stall });
    const client = await connect(t, pve);
    mockTime(t);

    const result = call(client, name, args("ghost"));
    await until(() => pve.calls.length === 1);
    t.mock.timers.tick(STALL_MS - 1);
    await turn();
    assert.deepEqual(paths(pve), [pathOf("ghost")]);

    t.mock.timers.tick(1);

    assert.deepEqual(await result, unknownNode("ghost"));
    assert.deepEqual(paths(pve), [pathOf("ghost"), "/cluster/status"]);
  });

  test(`${label} looks the node up at once when PVE answers with a server error`, async (t) => {
    const pve = fakePve({
      "/cluster/status": CLUSTER,
      [pathOf("ghost")]: () => {
        throw new PveApiError(500, "hostname lookup 'ghost' failed");
      },
    });
    const client = await connect(t, pve);

    assert.deepEqual(await call(client, name, args("ghost")), unknownNode("ghost"));
  });

  test(`${label} waits for a stalled read of a node the cluster has`, NO_HANG, async (t) => {
    let finish;
    const pve = fakePve({
      "/cluster/status": CLUSTER,
      [pathOf(NODE)]: () => new Promise((resolve) => (finish = resolve)),
    });
    const client = await connect(t, pve);

    const { result } = await stallRead(t, client, pve, name, args(NODE));
    await turn(); // The lookup comes back and clears the node, and the call still has to wait.
    finish({ ok: true });

    assert.deepEqual(await result, success({ ok: true }));
  });

  test(`${label} keeps PVE's own error for a node the cluster has`, async (t) => {
    const pve = fakePve({
      "/cluster/status": CLUSTER,
      [pathOf(NODE)]: () => {
        throw new PveApiError(500, "Configuration file does not exist");
      },
    });
    const client = await connect(t, pve);

    assert.deepEqual(await call(client, name, args(NODE)), failure("PVE API 500: Configuration file does not exist"));
    assert.deepEqual(paths(pve), [pathOf(NODE), "/cluster/status"]);
  });
}

test("a stalled read is not held back by a lookup that stalls too", NO_HANG, async (t) => {
  let finish;
  const path = `/nodes/${NODE}/status`;
  const pve = fakePve({ "/cluster/status": stall, [path]: () => new Promise((resolve) => (finish = resolve)) });
  const client = await connect(t, pve);

  const { result } = await stallRead(t, client, pve, "node_status", { node: NODE });
  finish({ ok: true });

  assert.deepEqual(await result, success({ ok: true }));
});

// This wait is the same one the node check exists to remove, so it has a limit too. On a cluster that
// is already failing, the lookup can stall on every host.
test("a stalled lookup holds a failed read back by the delay and no longer", NO_HANG, async (t) => {
  const path = `/nodes/${NODE}/status`;
  const pve = fakePve({
    "/cluster/status": stall,
    [path]: () => {
      throw new PveApiError(500, "pvestatd is down");
    },
  });
  const client = await connect(t, pve);
  mockTime(t);

  let finished = false;
  const result = call(client, "node_status", { node: NODE }).finally(() => {
    finished = true;
  });
  await until(() => pve.calls.length === 2);
  t.mock.timers.tick(STALL_MS - 1);
  await turn();
  assert.equal(finished, false);

  t.mock.timers.tick(1);

  assert.deepEqual(await result, failure("PVE API 500: pvestatd is down"));
});

test("a lookup that answers in time still finds a failed read's node missing", NO_HANG, async (t) => {
  let answerLookup;
  const path = "/nodes/ghost/status";
  const pve = fakePve({
    "/cluster/status": () => new Promise((resolve) => (answerLookup = resolve)),
    [path]: () => {
      throw new PveApiError(500, "hostname lookup 'ghost' failed");
    },
  });
  const client = await connect(t, pve);
  mockTime(t);

  const result = call(client, "node_status", { node: "ghost" });
  await until(() => pve.calls.length === 2);
  t.mock.timers.tick(STALL_MS - 1);
  await turn();
  answerLookup(CLUSTER);

  assert.deepEqual(await result, unknownNode("ghost"));
});

test("a lookup that comes back late for a failed read changes nothing, and does no harm", NO_HANG, async (t) => {
  let answerLookup;
  const path = "/nodes/ghost/status";
  const pve = fakePve({
    "/cluster/status": () => new Promise((resolve) => (answerLookup = resolve)),
    [path]: () => {
      throw new PveApiError(500, "pvestatd is down");
    },
  });
  const client = await connect(t, pve);
  const unhandled = [];
  const record = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  t.after(() => process.off("unhandledRejection", record));
  mockTime(t);

  const result = call(client, "node_status", { node: "ghost" });
  await until(() => pve.calls.length === 2);
  t.mock.timers.tick(STALL_MS);
  assert.deepEqual(await result, failure("PVE API 500: pvestatd is down"));

  answerLookup(CLUSTER); // Says the node is missing, with nobody left to tell.
  await turn();

  assert.deepEqual(unhandled, []);
});

test("a stalled read keeps its own failure when the lookup stalls too", NO_HANG, async (t) => {
  let abandon;
  const path = `/nodes/${NODE}/status`;
  const pve = fakePve({
    "/cluster/status": stall,
    [path]: () => new Promise((_, reject) => (abandon = reject)),
  });
  const client = await connect(t, pve);

  const { result } = await stallRead(t, client, pve, "node_status", { node: NODE });
  abandon(new PveRequestError("TIMEOUT", "No PVE host answered in time"));

  assert.deepEqual(await result, failure("TIMEOUT: No PVE host answered in time"));
});

// The client cannot be told to stop, so the read goes on to time out on every host after the tool
// has answered. An unhandled rejection at that point would end the server.
test("a read left behind for a missing node can fail later without harm", NO_HANG, async (t) => {
  let abandon;
  const path = "/nodes/ghost/status";
  const pve = fakePve({
    "/cluster/status": CLUSTER,
    [path]: () => new Promise((_, reject) => (abandon = reject)),
  });
  const client = await connect(t, pve);
  const unhandled = [];
  const record = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  t.after(() => process.off("unhandledRejection", record));

  const { result } = await stallRead(t, client, pve, "node_status", { node: "ghost" });
  assert.deepEqual(await result, unknownNode("ghost"));

  abandon(new PveRequestError("TIMEOUT", "No PVE host answered in time"));
  await turn();

  assert.deepEqual(unhandled, []);
});

test("the cluster's own name does not pass for a node", async (t) => {
  const path = "/nodes/example-cluster/status";
  const pve = fakePve({
    "/cluster/status": CLUSTER,
    [path]: () => {
      throw new PveApiError(500, "hostname lookup failed");
    },
  });
  const client = await connect(t, pve);

  assert.deepEqual(await call(client, "node_status", { node: "example-cluster" }), unknownNode("example-cluster"));
});

// A lookup that cannot say which nodes exist must not get a real node called missing.

const inconclusiveLookups = [
  ["fails", () => { throw new PveRequestError("TIMEOUT", "no answer"); }],
  ["returns no list", () => null],
  ["lists no nodes", () => [{ type: "cluster", name: "example-cluster" }]],
  ["returns an empty list", () => []],
];

for (const [outcome, lookup] of inconclusiveLookups) {
  test(`a failed read keeps its own error when the lookup ${outcome}`, async (t) => {
    const path = `/nodes/${NODE}/status`;
    const pve = fakePve({
      "/cluster/status": lookup,
      [path]: () => {
        throw new PveApiError(500, "pvestatd is down");
      },
    });
    const client = await connect(t, pve);

    assert.deepEqual(await call(client, "node_status", { node: NODE }), failure("PVE API 500: pvestatd is down"));
  });
}

// These are about the request or the token. A lookup would fail the same way, or could not help.

const unrelatedFailures = [
  ["a 400", () => new PveApiError(400, "Parameter verification failed.")],
  ["a 401", () => new PveApiError(401, "Authentication failed!")],
  ["a 403", () => new PveApiError(403, "Permission check failed")],
  ["a refused path", () => new PveRequestError("BAD_REQUEST", "Invalid API path")],
  ["a missing token", () => new PveRequestError("NO_TOKEN", "API token not found")],
  ["a TLS failure", () => new PveRequestError("TLS_VERIFY", "No PVE host passed certificate verification")],
  ["refused connections", () => new PveRequestError("REFUSED", "Every PVE host refused the connection")],
  ["a response that is not PVE's", () => new PveRequestError("BAD_RESPONSE", "No PVE host sent a PVE API response")],
];

for (const [failing, error] of unrelatedFailures) {
  test(`${failing} sends no lookup`, async (t) => {
    const expected = error();
    const path = `/nodes/${NODE}/status`;
    const pve = fakePve({
      "/cluster/status": CLUSTER,
      [path]: () => {
        throw expected;
      },
    });
    const client = await connect(t, pve);

    assert.deepEqual(await call(client, "node_status", { node: NODE }), failure(expected.message));
    assert.deepEqual(paths(pve), [path]);
  });
}

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

// The order of a real PVE 9 listing: running tasks first, then one node at a time.
const TASKS_BY_NODE = [
  { upid: "running", node: "a", starttime: 50 },
  { upid: "a-new", node: "a", starttime: 90 },
  { upid: "a-old", node: "a", starttime: 10 },
  { upid: "b-new", node: "b", starttime: 100 },
  { upid: "b-mid", node: "b", starttime: 90 },
  { upid: "b-old", node: "b", starttime: 20 },
];

const upids = (result) => JSON.parse(result.content[0].text).map(({ upid }) => upid);

test("recent_tasks returns the newest tasks of the whole cluster, newest first", async (t) => {
  const client = await connect(t, fakePve({ "/cluster/tasks": TASKS_BY_NODE }));

  assert.deepEqual(upids(await call(client, "recent_tasks", {})), [
    "b-new",
    "a-new", // Same start as b-mid, so PVE's order stands.
    "b-mid",
    "running",
    "b-old",
    "a-old",
  ]);
});

test("recent_tasks sorts before it cuts", async (t) => {
  const client = await connect(t, fakePve({ "/cluster/tasks": TASKS_BY_NODE }));

  assert.deepEqual(upids(await call(client, "recent_tasks", { limit: 2 })), ["b-new", "a-new"]);
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
  ["api_get", { path: "/nodes/..?x=1" }],
  ["api_get", { path: "/nodes/%2e%2e/access" }],
  ["api_get", { path: "/x\r\nFoo: bar" }],
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
