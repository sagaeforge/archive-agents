// The token never leaves the Authorization header. A tool result goes to the model, stdout carries
// those results, and stderr and the log file are kept, so every way a call can go is run here on the
// real entry point, and all of what comes out is searched. These speak JSON-RPC to the server
// themselves, because the MCP SDK client shows neither the raw stdout nor anything that is not a reply.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { describe, test } from "node:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { createCa } from "./helpers/certs.mjs";
import { ENTRY_POINT, entryPointProcess, startEntryPoint } from "./helpers/entry-point.mjs";
import { LOOPBACK, listen, startFakePve, tempDir } from "./helpers/fake-pve.mjs";

// Made at run time, so the repository holds nothing shaped like a token.
const SECRET = randomUUID();
const TOKEN = `tester@pve!unit=${SECRET}`;
const NOTHING_LISTENS = "127.0.0.2";

const ca = createCa("token guard CA");
const otherCa = createCa("some other CA");

// Every tool, including the calls that stop before anything is sent.
const CALLS = [
  ["cluster_overview", {}],
  ["list_resources", {}],
  ["list_resources", { type: "sdn" }],
  ["node_status", { node: "n1" }],
  ["guest_config", { node: "n1", vmid: 100 }],
  ["recent_tasks", { limit: 1 }],
  ["api_get", { path: "/version", params: { full: "1" } }],
  ["api_get", { path: "/nodes/../access" }],
];

function reply(res, status, reason, body) {
  res.writeHead(status, reason, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const refuse = (status, reason) => (_req, res) => reply(res, status, reason, { data: null });

// Starts the real server, makes every call and stops it, so that all of its output is in.
async function runCalls(t, { port, token = TOKEN, env = {} }) {
  const logFile = join(tempDir(t), "calls.jsonl");
  const spawned = entryPointProcess(t, { token, port, env: { PVE_LOG_FILE: logFile, ...env } });
  const child = spawn(spawned.command, spawned.args, { env: spawned.env, stdio: "pipe" });
  t.after(() => child.kill());

  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
  const closed = new Promise((resolve) => child.on("close", resolve));

  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const stdout = [];
  async function request(id, method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const { value } = await lines.next();
    stdout.push(value);
    return JSON.parse(value);
  }

  await request(0, "initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "token-guard", version: "0.0.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const results = [];
  for (const [index, [name, args]] of CALLS.entries()) {
    const { result } = await request(index + 1, "tools/call", { name, arguments: args });
    results.push(result.content[0].text);
  }

  child.stdin.end();
  child.kill();
  await closed;
  return { results, stdout: stdout.join("\n"), stderr, logged: readFileSync(logFile, "utf8") };
}

function assertTokenStayedIn({ stdout, stderr, logged }, secrets) {
  for (const [where, text] of Object.entries({ stdout, stderr, logged })) {
    for (const secret of [...secrets, "PVEAPIToken", "Authorization"]) {
      assert.ok(!text.includes(secret), `${secret} reached ${where}:\n${text}`);
    }
  }
}

// `shows` proves the run got to where it was meant to: a result has to say so.
const WAYS_A_CALL_GOES = [
  ["PVE answers", { answer: [], shows: /^\[\]$/ }],
  ["PVE rejects the token", { answer: refuse(401, "Authentication failed!"), shows: /^PVE API 401: / }],
  ["the role lacks a permission", { answer: refuse(403, "Permission check failed"), shows: /^PVE API 403: / }],
  ["PVE fails", { answer: refuse(500, "pvestatd is down"), shows: /^PVE API 500: / }],
  [
    "something else answers",
    {
      answer: (_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>a login page</html>");
      },
      shows: /^BAD_RESPONSE: /,
    },
  ],
  [
    "the connection drops mid-body",
    {
      answer: (_req, res) => {
        res.writeHead(200, { "content-length": "100" });
        res.write("{");
        setImmediate(() => res.destroy());
      },
      shows: /^UNREACHABLE: /,
    },
  ],
  ["the certificate is outside the CA", { credentials: otherCa, shows: /^TLS_VERIFY: / }],
  ["every host refuses", { env: { PVE_HOSTS: NOTHING_LISTENS }, shows: /^REFUSED: / }],
  ["the token cannot go in a header", { token: "tester@pve!unit=café", shows: /^BAD_REQUEST: / }],
];

describe("the token stays out of everything the server says", { concurrency: true }, () => {
  for (const [way, { answer = [], credentials = ca, token = TOKEN, env = {}, shows }] of WAYS_A_CALL_GOES) {
    test(`when ${way}`, async (t) => {
      const server = await startFakePve(t, credentials.issue(LOOPBACK), answer);
      const caFile = join(tempDir(t), "ca.pem");
      writeFileSync(caFile, ca.cert);

      const output = await runCalls(t, { port: server.port, token, env: { PVE_CA_FILE: caFile, ...env } });

      assert.ok(output.results.some((text) => shows.test(text)), output.results.join("\n"));
      assertTokenStayedIn(output, [token, token.slice(token.indexOf("=") + 1)]);
    });
  }

  test("when a host accepts and then says nothing", async (t) => {
    const port = await listen(t, net.createServer());
    const caFile = join(tempDir(t), "ca.pem");
    writeFileSync(caFile, ca.cert);

    const output = await runCalls(t, { port, env: { PVE_CA_FILE: caFile, FAKE_PVE_TIMEOUT_MS: "20" } });

    assert.ok(output.results.some((text) => /^TIMEOUT: /.test(text)), output.results.join("\n"));
    assertTokenStayedIn(output, [TOKEN, SECRET]);
  });
});

test("every line on stdout is a JSON-RPC reply, and nothing in the server writes there", async (t) => {
  const server = await startFakePve(t, ca.issue(LOOPBACK), refuse(401, "Authentication failed!"));
  const { stdout } = await runCalls(t, { port: server.port });

  for (const line of stdout.split("\n")) assert.equal(JSON.parse(line).jsonrpc, "2.0");
  const serverDir = dirname(ENTRY_POINT);
  for (const file of readdirSync(serverDir)) {
    assert.doesNotMatch(readFileSync(join(serverDir, file), "utf8"), /console\.(?:log|info|debug)|process\.stdout/, file);
  }
});

const everyCharacterEscaped = (text) => [...text].map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");

test("a token pasted into a path is not written down", async (t) => {
  const logFile = join(tempDir(t), "calls.jsonl");
  const server = await startFakePve(t, ca.issue(LOOPBACK));
  const caFile = join(tempDir(t), "ca.pem");
  writeFileSync(caFile, ca.cert);
  const { client, stderr } = await startEntryPoint(t, {
    token: TOKEN,
    port: server.port,
    env: { PVE_CA_FILE: caFile, PVE_LOG_FILE: logFile },
  });

  const hidden = [
    `/nodes/${TOKEN}/status`,
    `/nodes/${SECRET}/status`,
    `/nodes/${TOKEN.replace(SECRET, "not-a-uuid")}/status`,
    `/nodes/${encodeURIComponent(TOKEN)}/status`,
    `/nodes/${everyCharacterEscaped(SECRET)}/status`,
    `/nodes/${encodeURIComponent(everyCharacterEscaped(TOKEN))}/status`,
    "/nodes/%2525zz/status", // Decodes once, as PVE would, and then no further, so nothing can be said about it.
    `/${"a".repeat(1024)}`, // The bound on the log files holds only if a line has one.
  ];
  const shown = ["/nodes/n1/status", "/access/users/root%40pam", `/${"a".repeat(1023)}`];
  for (const path of [...hidden, ...shown]) await client.callTool({ name: "api_get", arguments: { path } });

  const entries = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(entries.map(({ path }) => path), [...hidden.map(() => "<redacted>"), ...shown]);
  for (const text of [readFileSync(logFile, "utf8"), stderr()]) assert.ok(!text.includes(SECRET), text);
});
