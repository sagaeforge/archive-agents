// Guards the read-only contract from CLAUDE.md. The expected values are spelled out here rather
// than imported from server code, so that widening the server cannot widen what these tests allow.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createClient, httpsTransport } from "../server/pve.mjs";
import { createCa } from "./helpers/certs.mjs";
import { LOOPBACK, startFakePve, tempDir } from "./helpers/fake-pve.mjs";

const TOKEN = "tester@pve!unit=not-a-real-secret";
const AUTHORIZATION = `PVEAPIToken=${TOKEN}`;

// Tool name to input names. An input is a way to steer a request, so a new one has to fail too.
const READ_ONLY_TOOLS = {
  api_get: ["params", "path"],
  cluster_overview: [],
  guest_config: ["kind", "node", "vmid"],
  list_resources: ["type"],
  node_status: ["node"],
  recent_tasks: ["limit"],
};

const fromTest = (path) => fileURLToPath(new URL(path, import.meta.url));
const SERVER_DIR = fromTest("../server");
const ENTRY_POINT = join(SERVER_DIR, "index.mjs");
const DIAL_FAKE_PVE = new URL("./helpers/dial-fake-pve.mjs", import.meta.url).href;

const pinnedCa = createCa("pinned test CA");
const otherCa = createCa("other test CA");

function pinnedCaFile(t) {
  const caFile = join(tempDir(t), "ca.pem");
  writeFileSync(caFile, pinnedCa.cert);
  return caFile;
}

// Runs the real entry point. Its home is throwaway, so the fake token in there is the only one it
// can find, and PVE_HOSTS keeps the real cluster out of reach.
async function startEntryPoint(t, port, env = { PVE_CA_FILE: pinnedCaFile(t) }) {
  const home = tempDir(t);
  const tokenDir = join(home, ".config", "proxmox-mcp");
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(join(tokenDir, "token"), `${TOKEN}\n`);
  const log = join(home, "https-requests");
  writeFileSync(log, "");

  const client = new Client({ name: "readonly-test", version: "0.0.0" });
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", DIAL_FAKE_PVE, ENTRY_POINT],
      env: { HOME: home, USERPROFILE: home, PVE_HOSTS: LOOPBACK, FAKE_PVE_PORT: port, FAKE_PVE_LOG: log, ...env },
    }),
  );
  return {
    client,
    httpsRequests: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

test("a client call reaches PVE as one bodyless GET carrying only the token header", async (t) => {
  const server = await startFakePve(t, pinnedCa.issue(LOOPBACK));
  const transport = httpsTransport({ caFile: pinnedCaFile(t), port: server.port });
  const pve = createClient({ hosts: [LOOPBACK], getToken: () => TOKEN, transport });

  assert.deepEqual(await pve.get("/nodes", { type: "vm" }), { served: true });

  assert.equal(server.requests.length, 1);
  const [{ method, url, headers, body }] = server.requests;
  assert.equal(method, "GET");
  assert.equal(url, "/api2/json/nodes?type=vm");
  assert.equal(body, "");
  const { host, connection, ...sent } = headers; // These two come from Node itself.
  assert.deepEqual(sent, { authorization: AUTHORIZATION });
});

test("a method handed to the client or the transport changes nothing on the wire", async (t) => {
  const server = await startFakePve(t, pinnedCa.issue(LOOPBACK));
  const transport = httpsTransport({ caFile: pinnedCaFile(t), port: server.port });
  const pve = createClient({ hosts: [LOOPBACK], getToken: () => TOKEN, transport });

  for (const method of ["POST", { method: "POST" }]) {
    await pve.get("/version", undefined, method);
    await transport(LOOPBACK, "/version", TOKEN, method);
  }

  assert.deepEqual(
    server.requests.map(({ method }) => method),
    ["GET", "GET", "GET", "GET"],
  );
});

test("the client hands the transport a host, a path and a token, and nothing else", async () => {
  const sent = [];
  const transport = async (...request) => {
    sent.push(request);
    return { status: 200, reason: "OK", body: '{"data":null}' };
  };
  const pve = createClient({ hosts: [LOOPBACK], getToken: () => TOKEN, transport });

  await pve.get("/version", { full: "1" }, "POST");

  assert.deepEqual(sent, [[LOOPBACK, "/version?full=1", TOKEN]]);
});

test("the client exposes nothing but get", () => {
  const pve = createClient({ hosts: [LOOPBACK], getToken: () => TOKEN, transport: async () => {} });

  assert.deepEqual(Reflect.ownKeys(pve), ["get"]);
  assert.equal(Object.getPrototypeOf(pve), Object.prototype);
});

// Requests can only be sampled, and no sample proves "never". What decides it is pinned as text.

test("the server names one request method, the GET literal", () => {
  const lines = readdirSync(SERVER_DIR).flatMap(
    (file) => readFileSync(join(SERVER_DIR, file), "utf8").match(/.*method.*/gi) ?? [],
  );

  assert.deepEqual(
    lines.map((line) => line.trim()),
    ['method: "GET",'],
  );
});

// A client widened here sends nothing a test could observe until a tool calls the addition.
test("index.mjs hands the tools the client exactly as createClient made it", () => {
  const source = readFileSync(ENTRY_POINT, "utf8");

  assert.match(source, /^const pve = createClient\(.*\);$/m);
  assert.match(source, /^registerTools\(server, pve\);$/m);
  assert.equal(source.replace(/"[^"]*"/g, "").match(/\bpve\b/g).length, 2); // Any third use could widen it.
});

test("httpsTransport talks to the PVE API port by default", async (t) => {
  const transport = httpsTransport({ caFile: pinnedCaFile(t) });
  let port;
  t.mock.method(https, "request", (options) => {
    port = options.port;
    throw new Error("no real request");
  });

  await assert.rejects(transport(LOOPBACK, "/version", TOKEN), /no real request/);
  assert.equal(port, 8006);
});

test("a server outside the pinned CA never receives the token", async (t) => {
  const server = await startFakePve(t, otherCa.issue(LOOPBACK));
  const transport = httpsTransport({ caFile: pinnedCaFile(t), port: server.port });

  await assert.rejects(transport(LOOPBACK, "/version", TOKEN), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
  assert.deepEqual(server.requests, []);
});

test("a server certified for another address never receives the token", async (t) => {
  const server = await startFakePve(t, pinnedCa.issue("192.0.2.1"));
  const transport = httpsTransport({ caFile: pinnedCaFile(t), port: server.port });

  await assert.rejects(transport(LOOPBACK, "/version", TOKEN), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  assert.deepEqual(server.requests, []);
});

// The real entry point, so that what index.mjs wires is covered and not just the parts it wires.

test("the server entry point offers exactly the read-only tools", async (t) => {
  const { client } = await startEntryPoint(t);

  const { tools } = await client.listTools();

  assert.deepEqual(Object.keys(client.getServerCapabilities()), ["tools"]);
  assert.deepEqual(
    Object.fromEntries(tools.map(({ name, inputSchema }) => [name, Object.keys(inputSchema.properties).sort()])),
    READ_ONLY_TOOLS,
  );
  for (const { name, annotations, inputSchema } of tools) {
    assert.deepEqual(annotations, { readOnlyHint: true, openWorldHint: false }, name);
    assert.equal(inputSchema.additionalProperties, undefined, name);
  }
});

// Every tool, then requests that name a write, with the API paths each has to arrive as.
const toolCalls = [
  ["cluster_overview", {}, ["/cluster/status", "/cluster/ha/status/current"]],
  ["list_resources", {}, ["/cluster/resources"]],
  ["list_resources", { type: "vm" }, ["/cluster/resources?type=vm"]],
  ["node_status", { node: "n1" }, ["/nodes/n1/status"]],
  ["guest_config", { node: "n1", vmid: 100 }, ["/nodes/n1/qemu/100/config"]],
  ["guest_config", { node: "n1", vmid: 101, kind: "lxc" }, ["/nodes/n1/lxc/101/config"]],
  ["recent_tasks", {}, ["/cluster/tasks"]],
  ["api_get", { path: "/version" }, ["/version"]],
  ["api_get", { path: "/nodes/n1/disks/list", params: { type: "unused" } }, ["/nodes/n1/disks/list?type=unused"]],
  ["api_get", { path: "/nodes/n1/qemu/100/status/stop" }, ["/nodes/n1/qemu/100/status/stop"]],
  ["api_get", { path: "/nodes/n1/qemu/100/status/stop", method: "POST" }, ["/nodes/n1/qemu/100/status/stop"]],
  ["api_get", { path: "/version", params: { method: "POST" } }, ["/version?method=POST"]],
];

test("every tool reaches PVE as bodyless GETs carrying only the token header", async (t) => {
  const server = await startFakePve(t, pinnedCa.issue(LOOPBACK), []);
  const { client } = await startEntryPoint(t, server.port);

  for (const [name, args] of toolCalls) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, `${name}: ${result.content[0].text}`);
  }

  assert.deepEqual(
    server.requests.map(({ method, url, body, headers: { host, connection, ...sent } }) => ({ method, url, body, sent })),
    toolCalls
      .flatMap(([, , paths]) => paths)
      .map((path) => ({
        method: "GET",
        url: `/api2/json${path}`,
        body: "",
        sent: { authorization: AUTHORIZATION },
      })),
  );
});

const untrustedServers = [
  ["outside the pinned CA", otherCa.issue(LOOPBACK)],
  ["certified for another address", pinnedCa.issue("192.0.2.1")],
];

for (const [reason, credentials] of untrustedServers) {
  test(`the entry point sends a server ${reason} nothing`, async (t) => {
    const server = await startFakePve(t, credentials);
    const { client } = await startEntryPoint(t, server.port);

    const result = await client.callTool({ name: "api_get", arguments: { path: "/version" } });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /All PVE hosts unreachable/);
    assert.deepEqual(server.requests, []);
  });
}

test("by default the entry point dials the API port and trusts only the repository CA", async (t) => {
  const server = await startFakePve(t, pinnedCa.issue(LOOPBACK));
  const { client, httpsRequests } = await startEntryPoint(t, server.port, {});

  const result = await client.callTool({ name: "api_get", arguments: { path: "/version" } });

  assert.equal(result.isError, true);
  assert.deepEqual(server.requests, []);
  assert.deepEqual(httpsRequests(), [
    {
      host: LOOPBACK,
      port: 8006,
      path: "/api2/json/version",
      method: "GET",
      ca: readFileSync(fromTest("../certs/pve-root-ca.pem"), "utf8"),
      timeout: 8000,
      headers: { Authorization: AUTHORIZATION },
    },
  ]);
});
