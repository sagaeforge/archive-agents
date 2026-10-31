import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { PveApiError, buildPath, createClient, httpsTransport, loadToken } from "../server/pve.mjs";
import { createCa } from "./helpers/certs.mjs";
import { LOOPBACK, listen, startFakePve, tempDir } from "./helpers/fake-pve.mjs";

const ok = (data) => ({ status: 200, reason: "OK", body: JSON.stringify({ data }) });
const client = (transport) => createClient({ hosts: ["a", "b"], getToken: () => "t", transport });

test("buildPath rejects traversal and relative paths", () => {
  assert.throws(() => buildPath("/nodes/../access"));
  assert.throws(() => buildPath("nodes"));
});

test("buildPath encodes params and drops undefined", () => {
  assert.equal(buildPath("/x", { type: "vm", skip: undefined }), "/x?type=vm");
  assert.equal(buildPath("/x", { q: "a b&c" }), "/x?q=a+b%26c");
});

test("get unwraps the data envelope", async () => {
  assert.deepEqual(await client(async () => ok([1])).get("/version"), [1]);
});

test("get fails over and then sticks to the working host", async () => {
  const calls = [];
  const c = client(async (host) => {
    calls.push(host);
    if (host === "a") throw new Error("down");
    return ok(host);
  });
  assert.equal(await c.get("/x"), "b");
  assert.equal(await c.get("/x"), "b");
  assert.deepEqual(calls, ["a", "b", "b"]);
});

test("HTTP errors surface without trying other hosts", async () => {
  let calls = 0;
  const c = client(async () => {
    calls++;
    return { status: 403, reason: "Permission check failed", body: "" };
  });
  await assert.rejects(c.get("/x"), (e) => e instanceof PveApiError && e.status === 403);
  assert.equal(calls, 1);
});

test("get reports every host when all are unreachable", async () => {
  const c = client(async (host) => {
    throw new Error(`${host} down`);
  });
  await assert.rejects(c.get("/x"), /a: a down; b: b down/);
});

test("loadToken prefers env and explains a missing file", () => {
  assert.equal(loadToken({ PVE_API_TOKEN: " x\n" }), "x");
  assert.throws(() => loadToken({ PVE_TOKEN_FILE: "/nonexistent" }), /bootstrap-token/);
});

// A stalled host, on real sockets. Without the timeout it would hang the call and keep get() from
// reaching the next host. readonly.test.mjs pins the 8 s value, so these shorten it to stay quick.

const TOKEN = "tester@pve!unit=not-a-real-secret";
const SHORT_TIMEOUT_MS = 50;
const GIVE_UP_MS = 5000;

const ca = createCa("transport test CA");
const credentials = ca.issue(LOOPBACK);

function transportTo(t, port) {
  const caFile = join(tempDir(t), "ca.pem");
  writeFileSync(caFile, ca.cert);
  return httpsTransport({ caFile, port });
}

// Only for the stalled port: a healthy host keeps the full timeout, however slow the machine is.
function shortenTimeout(t, stalledPort) {
  const { request } = https;
  t.mock.method(https, "request", (options, callback) =>
    request(options.port === stalledPort ? { ...options, timeout: SHORT_TIMEOUT_MS } : options, callback),
  );
}

// Turns a promise that never settles into a failure instead of a hung test run.
const settling = (promise) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(reject, GIVE_UP_MS, new Error("still pending")).unref()),
  ]);

const stalls = [
  ["the TLS handshake", () => net.createServer()],
  ["the response", () => https.createServer(credentials, () => {})],
  [
    "the response body",
    () =>
      https.createServer(credentials, (req, res) => {
        res.writeHead(200, { "content-length": "2" });
        res.write("{");
      }),
  ],
];

for (const [phase, createServer] of stalls) {
  test(`the transport gives up on a host that stalls during ${phase}`, async (t) => {
    const port = await listen(t, createServer());
    const transport = transportTo(t, port);
    shortenTimeout(t, port);

    await assert.rejects(settling(transport(LOOPBACK, "/version", TOKEN)), { message: "timeout after 8000ms" });
  });
}

test("get fails over past a host that stalls", async (t) => {
  const stalled = await listen(t, https.createServer(credentials, () => {}));
  const healthy = await startFakePve(t, credentials);
  // Real hosts share one port. Here each needs its own, so the host name picks the transport.
  const transports = { stalled: transportTo(t, stalled), healthy: transportTo(t, healthy.port) };
  shortenTimeout(t, stalled);
  const pve = createClient({
    hosts: ["stalled", "healthy"],
    getToken: () => TOKEN,
    transport: (host, path, token) => transports[host](LOOPBACK, path, token),
  });

  assert.deepEqual(await settling(pve.get("/version")), { served: true });
});
