// Guards the read-only contract from CLAUDE.md. The expected values are spelled out here rather
// than imported from server code, so that widening the server cannot widen what these tests allow.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createClient, httpsTransport } from "../server/pve.mjs";
import { createCa } from "./helpers/certs.mjs";
import { ENTRY_POINT, startEntryPoint as runEntryPoint } from "./helpers/entry-point.mjs";
import { LOOPBACK, listen, startFakePve, tempDir } from "./helpers/fake-pve.mjs";

const TOKEN = "tester@pve!unit=not-a-real-secret";
const AUTHORIZATION = `PVEAPIToken=${TOKEN}`;

// Each tool's whole input schema, as a client receives it. An input is a way to steer a request, so a
// new one has to fail, and so does a wider one: the node pattern is all that keeps percent-encoded
// segments out of a path, and an enum is the list of what a tool can ask PVE for.
const toolInput = (properties, required) => ({
  type: "object",
  properties,
  ...(required && { required }),
  $schema: "http://json-schema.org/draft-07/schema#",
});
const NODE_INPUT = { type: "string", pattern: "^[\\w.-]+$", description: "Node name, e.g. pve-node" };
const READ_ONLY_TOOLS = {
  api_get: toolInput(
    {
      path: { type: "string", description: "API path after /api2/json, starting with /" },
      params: {
        description: "Query parameters",
        type: "object",
        propertyNames: { type: "string" },
        additionalProperties: { type: "string" },
      },
    },
    ["path"],
  ),
  cluster_overview: toolInput({}),
  guest_config: toolInput(
    {
      node: NODE_INPUT,
      vmid: { type: "integer", exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Guest VMID" },
      kind: { default: "qemu", type: "string", enum: ["qemu", "lxc"] },
    },
    ["node", "vmid"],
  ),
  list_resources: toolInput({
    type: {
      description: "Filter; vm includes QEMU and LXC, sdn means SDN entries such as network zones",
      type: "string",
      enum: ["vm", "node", "storage", "sdn"],
    },
  }),
  node_status: toolInput({ node: NODE_INPUT }, ["node"]),
  recent_tasks: toolInput({ limit: { default: 30, type: "integer", minimum: 1, maximum: 200 } }),
};

const fromTest = (path) => fileURLToPath(new URL(path, import.meta.url));
const SERVER_DIR = dirname(ENTRY_POINT);

const pinnedCa = createCa("pinned test CA");
const otherCa = createCa("other test CA");

function pinnedCaFile(t) {
  const caFile = join(tempDir(t), "ca.pem");
  writeFileSync(caFile, pinnedCa.cert);
  return caFile;
}

const startEntryPoint = (t, port, env = { PVE_CA_FILE: pinnedCaFile(t) }) =>
  runEntryPoint(t, { token: TOKEN, port, env });

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
  assert.deepEqual(Object.fromEntries(tools.map(({ name, inputSchema }) => [name, inputSchema])), READ_ONLY_TOOLS);
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
  ["list_resources", { type: "sdn" }, ["/cluster/resources"]],
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
    assert.match(result.content[0].text, /^TLS_VERIFY: /);
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

// The real list, in the real order, on the real entry point. FAKE_PVE_HOST keeps every address on this
// machine, and a host that cuts each connection makes the client walk the whole list.
test("with no PVE_HOSTS the entry point tries the three cluster hosts, in order", async (t) => {
  const port = await listen(t, net.createServer((socket) => socket.destroy()));
  const { client, httpsRequests } = await startEntryPoint(t, port, { PVE_HOSTS: "", FAKE_PVE_HOST: LOOPBACK });

  const result = await client.callTool({ name: "api_get", arguments: { path: "/version" } });

  assert.equal(result.isError, true);
  assert.deepEqual(
    httpsRequests().map(({ host }) => host),
    ["192.0.2.1", "192.0.2.1", "192.0.2.1"],
  );
});

test("the entry point takes the token from PVE_TOKEN_FILE and reads it for every call", async (t) => {
  const tokenFile = join(tempDir(t), "token");
  const server = await startFakePve(t, pinnedCa.issue(LOOPBACK));
  const { client } = await startEntryPoint(t, server.port, { PVE_CA_FILE: pinnedCaFile(t), PVE_TOKEN_FILE: tokenFile });

  // A rotation swaps this file under a running server, which must not need a restart.
  for (const token of ["rotated@pve!first=one", "rotated@pve!second=two"]) {
    writeFileSync(tokenFile, `${token}\n`);
    await client.callTool({ name: "api_get", arguments: { path: "/version" } });
  }

  assert.deepEqual(
    server.requests.map(({ headers }) => headers.authorization),
    ["PVEAPIToken=rotated@pve!first=one", "PVEAPIToken=rotated@pve!second=two"],
  );
});
