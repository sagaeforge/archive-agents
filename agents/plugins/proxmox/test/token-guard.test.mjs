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

// A token can end up in a path or a query, by a paste or by a model repeating what it was shown. An
// error reply goes to the model and is kept, so none may repeat what it was refused for.
test("a refused call does not repeat its input, token or not, in the reply", async (t) => {
  const server = await startFakePve(t, ca.issue(LOOPBACK));
  const caFile = join(tempDir(t), "ca.pem");
  writeFileSync(caFile, ca.cert);
  const { client, httpsRequests } = await startEntryPoint(t, { token: TOKEN, port: server.port, env: { PVE_CA_FILE: caFile } });

  const refused = [
    ["api_get", { path: `/nodes/../status?auth=${TOKEN}` }],
    ["api_get", { path: `/nodes/../status?auth=${encodeURIComponent(TOKEN)}` }],
    ["api_get", { path: `/nodes/../status?auth=${everyCharacterEscaped(TOKEN)}` }],
    ["api_get", { path: `/nodes/%2e%2e/status?auth=${everyCharacterEscaped(SECRET)}#${SECRET}` }],
    ["api_get", { path: `/nodes/status ${SECRET}` }],
    ["api_get", { path: `/nodes/%zz/${SECRET}?auth=${TOKEN}` }],
    ["api_get", { path: `${SECRET}?auth=${TOKEN}` }],
    ["node_status", { node: `../${TOKEN}` }],
    ["guest_config", { node: `n1?auth=${TOKEN}`, vmid: 100 }],
  ];
  const forms = [TOKEN, SECRET, encodeURIComponent(TOKEN), everyCharacterEscaped(SECRET), everyCharacterEscaped(TOKEN)];
  for (const [name, args] of refused) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    const [{ text }] = result.content;
    for (const form of forms) assert.ok(!text.includes(form), `${name} repeats ${form}: ${text}`);
    assert.doesNotMatch(text, /auth=|\?|#/, `${name} repeats a query or fragment: ${text}`);
    assert.ok(!text.includes(args.path ?? args.node), `${name} repeats its input: ${text}`);
  }
  assert.deepEqual(httpsRequests(), []);
});

// A name the caller chose can reach a reply by two routes: the server's own wording, and PVE
// repeating the request in its reason. Both are shut here on the real entry point, with the same
// synthetic secret in the node, the path and the parameter.
describe("a reply does not repeat what the caller sent", { concurrency: true }, () => {
  const MEMBERS = [
    { type: "node", id: "node/n1", name: "n1", online: 1 },
    { type: "node", id: "node/n2", name: "n2", online: 1 },
  ];
  const lookup = (res, status, body) => reply(res, status, "x", body);
  // A failed read of the node, and a member list that does not hold it.
  const nodeIsUnknown = (req, res) =>
    req.url.endsWith("/cluster/status") ? lookup(res, 200, { data: MEMBERS }) : lookup(res, 500, { data: null });

  async function ask(t, answer, name, args) {
    const server = await startFakePve(t, ca.issue(LOOPBACK), answer);
    const caFile = join(tempDir(t), "ca.pem");
    writeFileSync(caFile, ca.cert);
    const { client } = await startEntryPoint(t, { token: TOKEN, port: server.port, env: { PVE_CA_FILE: caFile } });
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    return result.content[0].text;
  }

  for (const [name, args] of [
    ["node_status", { node: SECRET }],
    ["guest_config", { node: SECRET, vmid: 100 }],
  ]) {
    test(`${name} names the cluster's nodes and not the node it was given`, async (t) => {
      const text = await ask(t, nodeIsUnknown, name, args);
      assert.match(text, /^NODE_NOT_FOUND: .* Its nodes are n1, n2\.$/);
      assert.ok(!text.includes(SECRET), text);
    });
  }

  // The ways a value can be written down are not a list to complete, so each is a function of the
  // text, and every one is applied to the whole token and to its secret part alone.
  const everyCharacter = (text, hex = (byte) => byte.toString(16).toUpperCase().padStart(2, "0")) =>
    [...Buffer.from(text)].map((byte) => `%${hex(byte)}`).join("");
  const WRITTEN = {
    plain: (text) => text,
    "a dash as %2D": (text) => text.replaceAll("-", "%2D"),
    "a dash as %2d": (text) => text.replaceAll("-", "%2d"),
    "every character encoded": (text) => everyCharacter(text),
    "every character encoded in lower case": (text) => everyCharacter(text, (byte) => byte.toString(16).padStart(2, "0")),
    "encoded twice": (text) => encodeURIComponent(text.replaceAll("-", "%2D")),
    "every character encoded twice": (text) => everyCharacter(everyCharacter(text)),
    "encoded three times, with a broken escape beside it": (text) => `%zz${encodeURIComponent(encodeURIComponent(text.replaceAll("-", "%2D")))}%4`,
    "in capitals": (text) => text.toUpperCase(),
  };
  const WITHHELD = "PVE API 400: PVE's reason was withheld because it repeated the API token.";

  for (const [part, value] of [["token", TOKEN], ["secret", SECRET]]) {
    for (const [how, write] of Object.entries(WRITTEN)) {
      test(`a reason PVE gives that repeats the ${part} with ${how} is withheld`, async (t) => {
        const written = write(value);
        assert.ok(!written.includes(SECRET) || how === "plain", "the case is meant to hide the secret from a plain search");
        const echo = (_req, res) => lookup(res, 400, { errors: { node: `value '${written}' does not match` } });
        const text = await ask(t, echo, "api_get", { path: "/nodes/n1/status", params: { node: SECRET } });
        assert.equal(text, WITHHELD);
      });
    }
  }

  test("a reason PVE gives that repeats the token after the bound is withheld", async (t) => {
    const late = (_req, res) => lookup(res, 400, { errors: { node: `${"a".repeat(5000)} ${encodeURIComponent(SECRET)}` } });
    assert.equal(await ask(t, late, "api_get", { path: "/nodes/n1/status" }), WITHHELD);
  });

  test("a reason PVE gives that is nested past the decoding bound is withheld", async (t) => {
    let nested = "a b";
    for (let round = 0; round < 40; round++) nested = encodeURIComponent(nested);
    const deep = (_req, res) => lookup(res, 400, { errors: { node: nested } });
    assert.equal(await ask(t, deep, "api_get", { path: "/nodes/n1/status" }), WITHHELD);
  });

  test("an ordinary reason passes through unchanged, escapes and all", async (t) => {
    const ordinary = (_req, res) =>
      lookup(res, 400, { errors: { node: "value 'my%20node-1' does not match /^[a-z]+$/", vmid: "100%zz is not valid" } });
    const text = await ask(t, ordinary, "api_get", { path: "/nodes/n1/status", params: { node: SECRET } });
    assert.equal(text, "PVE API 400: x (node: value 'my%20node-1' does not match /^[a-z]+$/; vmid: 100%zz is not valid)");
  });

  test("a reason PVE gives has a bound", async (t) => {
    const long = (_req, res) => lookup(res, 500, { errors: { path: "a".repeat(100_000) } });
    const text = await ask(t, long, "api_get", { path: "/nodes/n1/status" });
    assert.ok(text.length < 2000, `${text.length} characters`);
  });
});
