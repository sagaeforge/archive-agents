// The failures the operations audit injected, plus the server log, on the real entry point and
// real sockets. Scenario letters are those of the audit. tools.test.mjs covers the logic in detail.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { createCa } from "./helpers/certs.mjs";
import { ENTRY_POINT, entryPointProcess, startEntryPoint } from "./helpers/entry-point.mjs";
import { LOOPBACK, startFakePve, tempDir } from "./helpers/fake-pve.mjs";

const SECRET = "not-a-real-secret-value";
const TOKEN = `tester@pve!unit=${SECRET}`;
const QUERY_VALUE = "query-value-marker";
const BODY_VALUE = "response-body-marker";
const HOST_TIMEOUT_MS = 8000;
const WAIT = { timeout: 15000 };

const ca = createCa("errors test CA");
const otherCa = createCa("other errors test CA");

const fromTest = (path) => fileURLToPath(new URL(path, import.meta.url));

function caFileIn(t) {
  const caFile = join(tempDir(t), "ca.pem");
  writeFileSync(caFile, ca.cert);
  return caFile;
}

const start = (t, port, env = { PVE_CA_FILE: caFileIn(t) }) => startEntryPoint(t, { token: TOKEN, port, env });
const failure = (message) => ({ isError: true, content: [{ type: "text", text: message }] });

function reply(res, status, reason, body) {
  res.writeHead(status, reason, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Scenario C: a CA that does not match the cluster.

test("a certificate outside the pinned CA is reported as a CA problem, not an outage", async (t) => {
  const server = await startFakePve(t, otherCa.issue(LOOPBACK));
  const { client } = await start(t, server.port);

  const result = await client.callTool({ name: "node_status", arguments: { node: "n1" } });

  assert.equal(result.isError, true);
  const [{ text }] = result.content;
  assert.match(text, /^TLS_VERIFY: No PVE host passed certificate verification \(127\.0\.0\.1: UNABLE_TO_VERIFY_LEAF_SIGNATURE\)/);
  assert.match(text, /CA or certificate problem, not an outage/);
  assert.doesNotMatch(text, /unreachable|use-system-ca/);
  assert.deepEqual(server.requests, []);
});

// Scenario D: no CA file at all. It used to end the process before `initialize`.

test("a missing CA file fails the call, not the server, and needs no restart once it is back", async (t) => {
  const server = await startFakePve(t, ca.issue(LOOPBACK));
  const caFile = join(tempDir(t), "ca.pem");
  const { client } = await start(t, server.port, { PVE_CA_FILE: caFile });

  assert.equal((await client.listTools()).tools.length, 6);
  const missing = await client.callTool({ name: "api_get", arguments: { path: "/version" } });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /^CA_FILE: Cannot read the PVE CA certificate\. ENOENT/);
  assert.ok(missing.content[0].text.includes(caFile));

  writeFileSync(caFile, ca.cert);

  const restored = await client.callTool({ name: "api_get", arguments: { path: "/version" } });
  assert.equal(restored.isError, undefined);
});

// Scenario H2: a node name PVE does not know. Every host stalls on it until the client times out.

const CLUSTER_STATUS = [
  { type: "cluster", id: "cluster", name: "example-cluster", nodes: 3, quorate: 1 },
  { type: "node", id: "node/pve-node", name: "pve-node", online: 1 },
  { type: "node", id: "node/pve-node", name: "pve-node", online: 1 },
  { type: "node", id: "node/pve-node", name: "pve-node", online: 1 },
];

function stallOnNodes(req, res) {
  if (req.url === "/api2/json/cluster/status") reply(res, 200, "OK", { data: CLUSTER_STATUS });
}

const unknownNodeReads = [
  ["node_status", { node: "no-such-node" }, "/api2/json/nodes/no-such-node/status"],
  ["guest_config", { node: "no-such-node", vmid: 100 }, "/api2/json/nodes/no-such-node/qemu/100/config"],
];

for (const [name, args, readUrl] of unknownNodeReads) {
  test(`${name} names a node the cluster does not have without waiting for a timeout`, WAIT, async (t) => {
    const server = await startFakePve(t, ca.issue(LOOPBACK), stallOnNodes);
    const { client } = await start(t, server.port);

    const started = Date.now();
    const result = await client.callTool({ name, arguments: args });
    const elapsed = Date.now() - started;

    assert.deepEqual(
      result,
      failure(
        'NODE_NOT_FOUND: "no-such-node" is not a node of this cluster. Its nodes are pve-node, pve-node, pve-node.',
      ),
    );
    assert.ok(elapsed < HOST_TIMEOUT_MS, `took ${elapsed} ms`);
    assert.deepEqual(
      server.requests.map(({ url }) => url),
      [readUrl, "/api2/json/cluster/status"],
    );
  });
}

// A read PVE has already failed, on a cluster whose /cluster/status stalls on every host.

test("a read that failed comes back without waiting out a lookup that stalls", WAIT, async (t) => {
  const server = await startFakePve(t, ca.issue(LOOPBACK), (req, res) => {
    if (req.url === "/api2/json/nodes/n1/status") reply(res, 500, "pvestatd is down", { data: null });
  });
  const { client } = await start(t, server.port);

  const started = Date.now();
  const result = await client.callTool({ name: "node_status", arguments: { node: "n1" } });
  const elapsed = Date.now() - started;

  assert.deepEqual(result, failure("PVE API 500: pvestatd is down"));
  assert.ok(elapsed < HOST_TIMEOUT_MS, `took ${elapsed} ms`);
});

// Scenario H3: PVE refuses a query value. The status line alone does not say which one.

test("a parameter PVE refuses is named in the error", async (t) => {
  const server = await startFakePve(t, ca.issue(LOOPBACK), (req, res) =>
    reply(res, 400, "Parameter verification failed.", {
      data: null,
      errors: { type: "value 'network' does not have a value in the enumeration 'vm, storage, node, sdn'" },
      message: "Parameter verification failed.\n",
    }),
  );
  const { client } = await start(t, server.port);

  const result = await client.callTool({
    name: "api_get",
    arguments: { path: "/cluster/resources", params: { type: "network" } },
  });

  assert.deepEqual(
    result,
    failure(
      "PVE API 400: Parameter verification failed. (type: value 'network' does not have a value in the enumeration 'vm, storage, node, sdn')",
    ),
  );
});

// A path with its own query or fragment, plus params, as api_get allows.

test("params arrive in one query with the path's own, and a fragment does not arrive at all", async (t) => {
  const server = await startFakePve(t, ca.issue(LOOPBACK));
  const { client } = await start(t, server.port);

  for (const path of ["/x?a=1", "/x#f", "/x?a=1#f"]) {
    await client.callTool({ name: "api_get", arguments: { path, params: { b: "2" } } });
  }

  assert.deepEqual(
    server.requests.map(({ url }) => url),
    ["/api2/json/x?a=1&b=2", "/api2/json/x?b=2", "/api2/json/x?a=1&b=2"],
  );
});

// Something other than PVE answering on the API port, such as a proxy with a login page.

test("a 200 that is not a PVE answer is tried on every host and reported as such, without its body", WAIT, async (t) => {
  const server = await startFakePve(t, ca.issue(LOOPBACK), (req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html>${BODY_VALUE}</html>`);
  });
  const hosts = [LOOPBACK, LOOPBACK, LOOPBACK].join(",");
  const { client, stderr } = await start(t, server.port, { PVE_CA_FILE: caFileIn(t), PVE_HOSTS: hosts });

  const result = await client.callTool({ name: "api_get", arguments: { path: "/version" } });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^BAD_RESPONSE: No PVE host sent a PVE API response \(127\.0\.0\.1: /);
  assert.ok(!result.content[0].text.includes(BODY_VALUE), result.content[0].text);
  assert.equal(server.requests.length, 3);
  const [entry] = await logEntries(stderr, 1);
  assert.equal(entry.status, "BAD_RESPONSE");
});

// Scenario G: a token PVE rejects.

test("a rejected token comes with what to do about it", async (t) => {
  const server = await startFakePve(t, ca.issue(LOOPBACK), (req, res) =>
    reply(res, 401, "Authentication failed!", { data: null }),
  );
  const { client } = await start(t, server.port);

  const result = await client.callTool({ name: "api_get", arguments: { path: "/version" } });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^PVE API 401: Authentication failed!\n.*bootstrap-token\.sh --rotate/);
});

// type=sdn against the shape a real cluster answers with.

test("list_resources finds the SDN zones of a cluster that files them as network entries", async (t) => {
  const zones = ["pve-node", "pve-node", "pve-node"].map((node) => ({
    id: `network/${node}/zone/localnetwork`,
    type: "network",
    "network-type": "zone",
    network: "localnetwork",
    node,
    status: "ok",
  }));
  const server = await startFakePve(t, ca.issue(LOOPBACK), (req, res) => {
    // As PVE does: its own filter finds nothing, however many zones there are.
    const data = req.url.endsWith("?type=sdn") ? [] : [{ id: "qemu/100", type: "qemu" }, ...zones];
    reply(res, 200, "OK", { data });
  });
  const { client } = await start(t, server.port);

  const result = await client.callTool({ name: "list_resources", arguments: { type: "sdn" } });

  assert.deepEqual(JSON.parse(result.content[0].text), zones);
});

// The log

// stderr arrives on its own schedule, so a tool result says nothing about the line for that call.
async function logEntries(stderr, count) {
  const entries = () => stderr().split("\n").filter((line) => line.startsWith("{"));
  for (let i = 0; i < 1000 && entries().length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(entries().length, count, stderr());
  return entries().map((line) => JSON.parse(line));
}

function answerOrReject(req, res) {
  if (req.url.startsWith("/api2/json/denied")) {
    reply(res, 401, "Authentication failed!", { data: null, detail: BODY_VALUE });
  } else {
    reply(res, 200, "OK", { data: { detail: BODY_VALUE } });
  }
}

const loggedCalls = [
  ["cluster_overview", {}],
  ["api_get", { path: "/version", params: { filter: QUERY_VALUE } }],
  ["api_get", { path: `/version?filter=${QUERY_VALUE}` }],
  ["api_get", { path: "/denied" }],
  ["api_get", { path: `/nodes/..?x=${QUERY_VALUE}` }],
];

test("each API call logs one JSON line with the tool, the host and the outcome", WAIT, async (t) => {
  const server = await startFakePve(t, ca.issue(LOOPBACK), answerOrReject);
  const { client, stderr } = await start(t, server.port);

  const before = Date.now();
  for (const [name, args] of loggedCalls) await client.callTool({ name, arguments: args });
  const entries = await logEntries(stderr, 6);

  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry), ["ts", "tool", "host", "path", "ms", "status", "failover"]);
    assert.ok(Date.parse(entry.ts) >= before - 1000, entry.ts);
    assert.ok(Number.isInteger(entry.ms) && entry.ms >= 0, `ms is ${entry.ms}`);
  }
  assert.deepEqual(
    entries.map(({ ts, ms, ...entry }) => entry),
    [
      { tool: "cluster_overview", host: LOOPBACK, path: "/cluster/status", status: 200, failover: false },
      { tool: "cluster_overview", host: LOOPBACK, path: "/cluster/ha/status/current", status: 200, failover: false },
      { tool: "api_get", host: LOOPBACK, path: "/version", status: 200, failover: false },
      { tool: "api_get", host: LOOPBACK, path: "/version", status: 200, failover: false },
      { tool: "api_get", host: LOOPBACK, path: "/denied", status: 401, failover: false },
      { tool: "api_get", host: null, path: "/nodes/..", status: "BAD_REQUEST", failover: false },
    ],
  );
});

test("a node lookup is logged under the tool that needed it", WAIT, async (t) => {
  const server = await startFakePve(t, ca.issue(LOOPBACK), stallOnNodes);
  const { client, stderr } = await start(t, server.port);

  await client.callTool({ name: "node_status", arguments: { node: "no-such-node" } });
  const [lookup] = await logEntries(stderr, 1);

  assert.equal(lookup.tool, "node_status");
  assert.equal(lookup.path, "/cluster/status");
});

// cluster_overview stops at its first failed call, so the second server gets one line less.
const servers = [
  ["a server that answers", () => ca.issue(LOOPBACK), 6],
  ["a server that fails verification", () => otherCa.issue(LOOPBACK), 5],
];

for (const [kind, credentials, count] of servers) {
  test(`with ${kind}, stderr holds no token, query value or response body`, WAIT, async (t) => {
    const server = await startFakePve(t, credentials(), answerOrReject);
    const { client, stderr } = await start(t, server.port);

    for (const [name, args] of loggedCalls) await client.callTool({ name, arguments: args });
    await logEntries(stderr, count);

    for (const forbidden of [TOKEN, SECRET, QUERY_VALUE, BODY_VALUE]) {
      assert.ok(!stderr().includes(forbidden), `found ${forbidden} in:\n${stderr()}`);
    }
  });
}

// The MCP SDK client gives no way to close the real pipe, so these tests speak JSON-RPC to the server
// themselves. stderr is gone from the start here, where Claude Code drops it after connecting.
async function startWithoutStderrReader(t, port, env) {
  const spawned = entryPointProcess(t, { token: TOKEN, port, env });
  const child = spawn(spawned.command, spawned.args, { env: spawned.env, stdio: "pipe" });
  t.after(() => child.kill());
  child.stderr.destroy();
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();

  async function request(id, method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const { value } = await replies.next();
    return JSON.parse(value);
  }

  await request(1, "initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "stderr-test", version: "0.0.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return { child, request };
}

// Without a guard, the first log line after this kills the process.
test("a log reader that goes away does not stop the server", WAIT, async (t) => {
  const server = await startFakePve(t, ca.issue(LOOPBACK));
  const { child, request } = await startWithoutStderrReader(t, server.port, { PVE_CA_FILE: caFileIn(t) });

  for (const id of [2, 3, 4]) {
    const { result } = await request(id, "tools/call", { name: "api_get", arguments: { path: "/version" } });
    assert.equal(result.isError, undefined);
  }
  assert.equal(child.exitCode, null);
});

// PVE_LOG_FILE, the only copy of the log that a Claude Code session keeps.

const logLines = (text) => text.split("\n").filter((line) => line.startsWith("{"));

test("PVE_LOG_FILE keeps the log with nothing reading stderr, as in a Claude Code session", WAIT, async (t) => {
  const logFile = join(tempDir(t), "calls.jsonl");
  const server = await startFakePve(t, ca.issue(LOOPBACK));
  const { request } = await startWithoutStderrReader(t, server.port, {
    PVE_CA_FILE: caFileIn(t),
    PVE_LOG_FILE: logFile,
  });

  for (const id of [2, 3]) {
    await request(id, "tools/call", { name: "api_get", arguments: { path: "/version" } });
  }

  const entries = logLines(readFileSync(logFile, "utf8")).map((line) => JSON.parse(line));
  assert.deepEqual(
    entries.map(({ ts, ms, ...entry }) => entry),
    Array(2).fill({ tool: "api_get", host: LOOPBACK, path: "/version", status: 200, failover: false }),
  );
});

test("PVE_LOG_FILE gets exactly what stderr gets, in a file for this user alone", WAIT, async (t) => {
  const logFile = join(tempDir(t), "calls.jsonl");
  const server = await startFakePve(t, ca.issue(LOOPBACK), answerOrReject);
  const { client, stderr } = await start(t, server.port, { PVE_CA_FILE: caFileIn(t), PVE_LOG_FILE: logFile });

  for (const [name, args] of loggedCalls) await client.callTool({ name, arguments: args });
  await logEntries(stderr, 6);

  assert.deepEqual(logLines(readFileSync(logFile, "utf8")), logLines(stderr()));
  assert.equal(statSync(logFile).mode & 0o777, 0o600);
});

test("PVE_LOG_FILE adds to what is already in the file", WAIT, async (t) => {
  const logFile = join(tempDir(t), "calls.jsonl");
  writeFileSync(logFile, '{"from":"an earlier session"}\n');
  const server = await startFakePve(t, ca.issue(LOOPBACK));
  const { client } = await start(t, server.port, { PVE_CA_FILE: caFileIn(t), PVE_LOG_FILE: logFile });

  await client.callTool({ name: "api_get", arguments: { path: "/version" } });

  const [earlier, added] = logLines(readFileSync(logFile, "utf8")).map((line) => JSON.parse(line));
  assert.deepEqual(earlier, { from: "an earlier session" });
  assert.equal(added.path, "/version");
});

test("a log file that cannot be written fails no call", WAIT, async (t) => {
  const logFile = join(tempDir(t), "no-such-folder", "calls.jsonl");
  const server = await startFakePve(t, ca.issue(LOOPBACK));
  const { client } = await start(t, server.port, { PVE_CA_FILE: caFileIn(t), PVE_LOG_FILE: logFile });

  const result = await client.callTool({ name: "api_get", arguments: { path: "/version" } });

  assert.equal(result.isError, undefined);
  assert.equal(existsSync(logFile), false);
});

// The plugin cache names each install after its commit.

test("the server reports the commit it is installed from", async (t) => {
  const installed = join(tempDir(t), "0123456789ab");
  cpSync(dirname(ENTRY_POINT), join(installed, "server"), { recursive: true });
  symlinkSync(fromTest("../node_modules"), join(installed, "node_modules"));

  const { client } = await startEntryPoint(t, { token: TOKEN, entryPoint: join(installed, "server", "index.mjs") });

  assert.deepEqual(client.getServerVersion(), { name: "proxmox", version: "0123456789ab" });
});
