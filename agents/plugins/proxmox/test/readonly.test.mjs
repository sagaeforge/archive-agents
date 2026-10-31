// Guards the read-only contract from CLAUDE.md. The expected values are spelled out here rather
// than imported from server code, so that widening the server cannot widen what these tests allow.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createClient, httpsTransport } from "../server/pve.mjs";
import { createCa } from "./helpers/certs.mjs";

const LOOPBACK = "127.0.0.1";
const TOKEN = "tester@pve!unit=not-a-real-secret";
const READ_ONLY_TOOLS = ["api_get", "cluster_overview", "guest_config", "list_resources", "node_status", "recent_tasks"];

const pinnedCa = createCa("pinned test CA");
const otherCa = createCa("other test CA");

function pinnedCaFile(t) {
  const dir = mkdtempSync(join(tmpdir(), "proxmox-mcp-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const caFile = join(dir, "ca.pem");
  writeFileSync(caFile, pinnedCa.cert);
  return caFile;
}

// A local PVE stand-in. `requests` records what actually arrived, not what the client meant to send.
async function startServer(t, credentials) {
  const requests = [];
  const server = https.createServer(credentials, (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const { method, url, headers } = req;
      requests.push({ method, url, headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { served: true } }));
    });
  });
  await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port, requests };
}

test("a client call reaches PVE as one bodyless GET carrying only the token header", async (t) => {
  const server = await startServer(t, pinnedCa.issue(LOOPBACK));
  const transport = httpsTransport({ caFile: pinnedCaFile(t), port: server.port });
  const pve = createClient({ hosts: [LOOPBACK], getToken: () => TOKEN, transport });

  assert.deepEqual(await pve.get("/nodes", { type: "vm" }), { served: true });

  assert.equal(server.requests.length, 1);
  const [{ method, url, headers, body }] = server.requests;
  assert.equal(method, "GET");
  assert.equal(url, "/api2/json/nodes?type=vm");
  assert.equal(body, "");
  const { host, connection, ...sent } = headers; // These two come from Node itself.
  assert.deepEqual(sent, { authorization: `PVEAPIToken=${TOKEN}` });
});

test("the client exposes nothing but get", () => {
  const pve = createClient({ hosts: [LOOPBACK], getToken: () => TOKEN, transport: async () => {} });

  assert.deepEqual(Reflect.ownKeys(pve), ["get"]);
  assert.equal(Object.getPrototypeOf(pve), Object.prototype);
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
  const server = await startServer(t, otherCa.issue(LOOPBACK));
  const transport = httpsTransport({ caFile: pinnedCaFile(t), port: server.port });

  await assert.rejects(transport(LOOPBACK, "/version", TOKEN), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
  assert.deepEqual(server.requests, []);
});

test("a server certified for another address never receives the token", async (t) => {
  const server = await startServer(t, pinnedCa.issue("192.0.2.1"));
  const transport = httpsTransport({ caFile: pinnedCaFile(t), port: server.port });

  await assert.rejects(transport(LOOPBACK, "/version", TOKEN), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  assert.deepEqual(server.requests, []);
});

// Runs the real entry point so a tool registered in index.mjs, not just tools.mjs, is caught too.
test("the server entry point offers exactly the read-only tools", async (t) => {
  const client = new Client({ name: "readonly-test", version: "0.0.0" });
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../server/index.mjs", import.meta.url))],
      env: { PVE_HOSTS: LOOPBACK }, // Listing tools needs no cluster; this keeps the real one out of reach.
    }),
  );

  const { tools } = await client.listTools();

  assert.deepEqual(tools.map((tool) => tool.name).sort(), READ_ONLY_TOOLS);
  for (const tool of tools) {
    assert.deepEqual(tool.annotations, { readOnlyHint: true, openWorldHint: false }, tool.name);
  }
});
