// How Claude Code starts the server. Every other test starts index.mjs with an environment of its own,
// so without this nothing would stand between a line in .mcp.json and every machine.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCa } from "./helpers/certs.mjs";
import { startEntryPoint } from "./helpers/entry-point.mjs";
import { LOOPBACK, startFakePve, tempDir } from "./helpers/fake-pve.mjs";

const { mcpServers } = JSON.parse(readFileSync(fileURLToPath(new URL("../.mcp.json", import.meta.url)), "utf8"));

const TOKEN = "tester@pve!unit=not-a-real-secret";
const LOG_LIMIT_BYTES = 5 * 1024 * 1024;

const ca = createCa("launch test CA");

// The env Claude Code hands a plugin's stdio server, with its path variable expanded.
const shippedEnv = (dataDir) =>
  Object.fromEntries(
    Object.entries(mcpServers.proxmox.env).map(([name, value]) => [name, value.replaceAll("${CLAUDE_PLUGIN_DATA}", dataDir)]),
  );

function caFileIn(t) {
  const caFile = join(tempDir(t), "ca.pem");
  writeFileSync(caFile, ca.cert);
  return caFile;
}

async function callOnce(t, dataDir, extraEnv = { PVE_CA_FILE: caFileIn(t) }) {
  const server = await startFakePve(t, ca.issue(LOOPBACK));
  const { client } = await startEntryPoint(t, { token: TOKEN, port: server.port, env: { ...shippedEnv(dataDir), ...extraEnv } });
  return { server, result: await client.callTool({ name: "api_get", arguments: { path: "/version" } }) };
}

const logLines = (file) => readFileSync(file, "utf8").trim().split("\n");

// Spelled out, so that anything added here has to be argued for. An env entry reaches the server on
// every machine: NODE_TLS_REJECT_UNAUTHORIZED, NODE_OPTIONS or PVE_CA_FILE would undo the CA pin, and
// PVE_API_TOKEN or PVE_HOSTS would send a token somewhere else.
test("the plugin starts one server, by this exact command and environment", () => {
  assert.deepEqual(mcpServers, {
    proxmox: {
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/server/index.mjs"],
      env: { PVE_LOG_FILE: "${CLAUDE_PLUGIN_DATA}/calls.jsonl" },
    },
  });
});

test("started as shipped, the server still sends a host outside the repository CA nothing", async (t) => {
  const dataDir = tempDir(t);
  const { server, result } = await callOnce(t, dataDir, {});

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^TLS_VERIFY: /);
  assert.deepEqual(server.requests, []);
});

test("started as shipped, every call lands in the plugin's data directory, for this user alone", async (t) => {
  const dataDir = tempDir(t);
  const { result } = await callOnce(t, dataDir);

  assert.equal(result.isError, undefined);
  assert.deepEqual(readdirSync(dataDir), ["calls.jsonl"]);
  const log = join(dataDir, "calls.jsonl");
  assert.equal(statSync(log).mode & 0o777, 0o600);
  const [entry, ...rest] = logLines(log).map((line) => JSON.parse(line));
  assert.deepEqual(rest, []);
  assert.equal(entry.tool, "api_get");
  assert.equal(entry.path, "/version");
  assert.equal(entry.status, 200);
});

test("a log at its limit moves aside, and only one older file is kept", async (t) => {
  const dataDir = tempDir(t);
  const log = join(dataDir, "calls.jsonl");
  writeFileSync(`${log}.1`, "the oldest lines\n");
  writeFileSync(log, "");
  truncateSync(log, LOG_LIMIT_BYTES);

  await callOnce(t, dataDir);

  assert.deepEqual(readdirSync(dataDir).sort(), ["calls.jsonl", "calls.jsonl.1"]);
  assert.equal(statSync(`${log}.1`).size, LOG_LIMIT_BYTES);
  assert.equal(logLines(log).length, 1);
  assert.equal(statSync(log).mode & 0o777, 0o600);
});

test("a log another session moved aside first still gets this line", async (t) => {
  const log = join(tempDir(t), "calls.jsonl");
  writeFileSync(log, "");
  truncateSync(log, LOG_LIMIT_BYTES);

  // That session's rename lands between this one's size check and its own rename.
  const { renameSync } = fs;
  fs.renameSync = (from, to) => {
    renameSync(from, to);
    throw Object.assign(new Error("the file has gone"), { code: "ENOENT" });
  };
  syncBuiltinESMExports();
  process.env.PVE_LOG_FILE = log;
  t.after(() => {
    fs.renameSync = renameSync;
    syncBuiltinESMExports();
    delete process.env.PVE_LOG_FILE;
  });

  const { logRequest } = await import(`../server/log.mjs?${randomUUID()}`);
  logRequest({ host: "h", path: "/version", ms: 1, status: 200, failover: false });

  assert.equal(statSync(`${log}.1`).size, LOG_LIMIT_BYTES);
  assert.equal(logLines(log).length, 1);
});

test("a log that cannot move aside stops growing, and the call still works", async (t) => {
  const dataDir = tempDir(t);
  const log = join(dataDir, "calls.jsonl");
  mkdirSync(join(`${log}.1`, "in-the-way"), { recursive: true });
  writeFileSync(log, "");
  truncateSync(log, LOG_LIMIT_BYTES);

  const { result } = await callOnce(t, dataDir);

  assert.equal(result.isError, undefined);
  assert.equal(statSync(log).size, LOG_LIMIT_BYTES);
});

test("a log under its limit stays where it is", async (t) => {
  const dataDir = tempDir(t);
  const log = join(dataDir, "calls.jsonl");
  writeFileSync(log, "");
  truncateSync(log, LOG_LIMIT_BYTES - 1);

  await callOnce(t, dataDir);

  assert.equal(existsSync(`${log}.1`), false);
  assert.ok(statSync(log).size > LOG_LIMIT_BYTES - 1);
});
