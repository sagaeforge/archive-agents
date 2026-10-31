import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import {
  PveApiError,
  PveRequestError,
  buildPath,
  classifyTransportError,
  createClient,
  httpsTransport,
  loadToken,
} from "../server/pve.mjs";
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

// A path can carry its own query, and api_get takes params on top of that.

const pathsParamsJoin = [
  ["a query", "/x?a=1", "/x?a=1&b=2"],
  ["a query with several pairs", "/x?a=1&c=3", "/x?a=1&c=3&b=2"],
  ["an empty query", "/x?", "/x?b=2"], // PVE answers 400 to /x?&b=2.
  ["a query that ends in a separator", "/x?a=1&", "/x?a=1&b=2"],
  ["an ampersand and no query", "/x&", "/x&?b=2"],
  ["a fragment", "/x#f", "/x?b=2"],
  ["a query and a fragment", "/x?a=1#f", "/x?a=1&b=2"],
  ["a fragment holding a question mark", "/x#f?c=3", "/x?b=2"],
];

for (const [what, path, expected] of pathsParamsJoin) {
  test(`buildPath adds params to a path with ${what}`, () => {
    assert.equal(buildPath(path, { b: "2" }), expected);
  });
}

test("buildPath cuts a fragment even with no params to add", () => {
  assert.equal(buildPath("/x#f"), "/x");
  assert.equal(buildPath("/x?a=1#f"), "/x?a=1");
});

test("buildPath leaves a path's query alone when every param is undefined", () => {
  assert.equal(buildPath("/x?a=1", { b: undefined }), "/x?a=1");
});

test("get unwraps the data envelope", async () => {
  assert.deepEqual(await client(async () => ok([1])).get("/version"), [1]);
});

test("get takes null data for an answer, as PVE sends for a call with nothing to return", async () => {
  assert.equal(await client(async () => ok(null)).get("/x"), null);
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

test("a missing token has its own code", () => {
  assert.throws(() => loadToken({ PVE_TOKEN_FILE: "/nonexistent" }), { code: "NO_TOKEN" });
});

// A tool caller sees this text without having loaded the skill, and until every machine has its own
// token the script it names takes the shared token away from the others.
test("a missing token leaves the next step to the user and says why", () => {
  assert.throws(
    () => loadToken({ PVE_TOKEN_FILE: "/nonexistent" }),
    (err) => {
      assert.match(err.message, /^NO_TOKEN: API token not found at \/nonexistent\. Ask the user how to provide one\. /);
      assert.match(err.message, /Do not run scripts\/bootstrap-token\.sh from this plugin without their approval: /);
      assert.match(err.message, /changes tokens on the cluster/);
      assert.match(err.message, /if machines still share one token, it locks the others out/);
      return true;
    },
  );
});

// buildPath judges what PVE will decode, not the text it is handed.

const unsafePaths = [
  ["a traversal before a query", "/nodes/..?x=1"],
  ["a traversal before a fragment", "/nodes/..#f"],
  ["an encoded traversal", "/nodes/%2e%2e/access"],
  ["an upper-case encoded traversal", "/nodes/%2E%2E/access"],
  ["a half-encoded traversal", "/nodes/.%2e/access"],
  ["a traversal behind an encoded slash", "/nodes/..%2faccess"],
  ["a traversal behind a backslash", "/nodes/..\\access"],
  ["a traversal behind an encoded backslash", "/nodes/..%5caccess"],
  ["malformed percent-encoding", "/nodes/%zz"],
  ["cut-off percent-encoding", "/nodes/%e"],
  ["a space", "/x y"],
  ["a line break", "/x\r\nFoo: bar"],
  ["an encoded line break", "/x%0d%0aFoo:%20bar"],
  ["a tab", "/x\ty"],
  ["a NUL", "/x\0"],
  ["an encoded NUL", "/x%00"],
  ["a DEL", "/x\x7f"],
  ["a non-ASCII character", "/café"],
  ["a space in the query", "/x?a=b c"],
];

for (const [reason, path] of unsafePaths) {
  test(`buildPath rejects ${reason}`, () => {
    assert.throws(() => buildPath(path), { code: "BAD_REQUEST", message: `BAD_REQUEST: Invalid API path: ${path}` });
  });
}

const safePaths = [
  "/version",
  "/nodes/pve-node/qemu/100/config",
  "/nodes/a..b/status",
  "/nodes/n1/storage/local/content/local:iso%2Ffoo%20bar.iso",
  "/cluster/resources?type=vm",
  "/x?next=../up",
  "/x?next=%2e%2e",
  "/x?ratio=100%",
];

for (const path of safePaths) {
  test(`buildPath leaves ${path} alone`, () => {
    assert.equal(buildPath(path), path);
  });
}

test("a path buildPath rejects never reaches a host", async () => {
  let calls = 0;
  const c = client(async () => {
    calls++;
    return ok(null);
  });

  await assert.rejects(c.get("/nodes/%2e%2e/access"), { code: "BAD_REQUEST" });
  assert.equal(calls, 0);
});

// Why a call failed

const transportCodes = [
  ["REFUSED", ["ECONNREFUSED"]],
  ["TIMEOUT", ["ETIMEDOUT"]],
  ["BAD_REQUEST", ["ERR_UNESCAPED_CHARACTERS", "ERR_INVALID_CHAR"]],
  [
    "TLS_VERIFY",
    [
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "CERT_HAS_EXPIRED",
      "CERT_NOT_YET_VALID",
      "CERT_SIGNATURE_FAILURE",
      "CERT_UNTRUSTED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "HOSTNAME_MISMATCH",
      "INVALID_CA",
      "INVALID_PURPOSE",
      "PATH_LENGTH_EXCEEDED",
      "CRL_HAS_EXPIRED",
    ],
  ],
  ["UNREACHABLE", ["ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "EPROTO", undefined]],
];

for (const [expected, codes] of transportCodes) {
  for (const code of codes) {
    test(`a transport error with code ${code} is ${expected}`, () => {
      assert.equal(classifyTransportError(Object.assign(new Error("failed"), { code })), expected);
    });
  }
}

const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};

const commonFailures = [
  [
    "ECONNREFUSED",
    "connect ECONNREFUSED",
    "REFUSED: Every PVE host refused the connection (a: connect ECONNREFUSED; b: connect ECONNREFUSED).",
  ],
  ["ETIMEDOUT", "timeout", "TIMEOUT: No PVE host answered in time (a: timeout; b: timeout)."],
  ["ECONNRESET", "socket hang up", "UNREACHABLE: All PVE hosts unreachable (a: socket hang up; b: socket hang up)."],
  [
    "CERT_HAS_EXPIRED",
    "certificate has expired",
    "TLS_VERIFY: No PVE host passed certificate verification (a: CERT_HAS_EXPIRED; b: CERT_HAS_EXPIRED).",
  ],
];

for (const [code, message, expected] of commonFailures) {
  test(`hosts that all fail with ${code} are reported with what they have in common`, async () => {
    const c = client(async () => fail(code, message));

    await assert.rejects(c.get("/x"), (err) => {
      assert.ok(err instanceof PveRequestError);
      assert.equal(err.code, expected.split(":")[0]);
      assert.ok(err.message.startsWith(expected), err.message);
      return true;
    });
  });
}

test("a TLS failure is called a CA problem, without Node's advice to trust the system store", async () => {
  const c = client(async () => fail("UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify; try --use-system-ca"));

  await assert.rejects(c.get("/x"), ({ message }) => {
    assert.match(message, /CA or certificate problem, not an outage/);
    assert.doesNotMatch(message, /use-system-ca|unreachable/);
    return true;
  });
});

test("hosts that fail in different ways are unreachable, each with its own reason", async () => {
  const c = client(async (host) =>
    host === "a" ? fail("UNABLE_TO_VERIFY_LEAF_SIGNATURE", "bad certificate") : fail("ETIMEDOUT", "timeout after 8000ms"),
  );

  await assert.rejects(c.get("/x"), (err) => {
    assert.equal(err.code, "UNREACHABLE");
    assert.match(err.message, /\(a: UNABLE_TO_VERIFY_LEAF_SIGNATURE; b: timeout after 8000ms\)/);
    return true;
  });
});

test("a call that no host served keeps what each host did, for callers that report by host", async () => {
  const c = client(async (host) =>
    host === "a" ? fail("UNABLE_TO_VERIFY_LEAF_SIGNATURE", "bad certificate") : fail("ETIMEDOUT", "timeout after 8000ms"),
  );

  await assert.rejects(c.get("/x"), (err) => {
    assert.deepEqual(err.failures, [
      { code: "TLS_VERIFY", detail: "a: UNABLE_TO_VERIFY_LEAF_SIGNATURE" },
      { code: "TIMEOUT", detail: "b: timeout after 8000ms" },
    ]);
    return true;
  });
});

test("a failure with no message still names its code", async () => {
  const c = client(async () => fail("ECONNREFUSED", ""));

  await assert.rejects(c.get("/x"), /\(a: ECONNREFUSED; b: ECONNREFUSED\)/);
});

test("a host failing TLS verification does not stop the next host from answering", async () => {
  const c = client(async (host) => (host === "a" ? fail("CERT_HAS_EXPIRED", "expired") : ok(host)));

  assert.equal(await c.get("/x"), "b");
});

const requestFaults = [
  ["a request Node refuses to send", () => fail("ERR_UNESCAPED_CHARACTERS", "unescaped characters"), "BAD_REQUEST"],
  ["a CA file that cannot be read", () => { throw new PveRequestError("CA_FILE", "no file"); }, "CA_FILE"],
];

for (const [fault, failure, code] of requestFaults) {
  test(`${fault} fails at once, since no other host would fare better`, async () => {
    let calls = 0;
    const c = client(async () => {
      calls++;
      return failure();
    });

    await assert.rejects(c.get("/x"), { code });
    assert.equal(calls, 1);
  });
}

const failedWith = (status, reason, body = "") => client(async () => ({ status, reason, body }));

test("a 401 says the token was rejected and how to replace it", async () => {
  await assert.rejects(failedWith(401, "Authentication failed!").get("/x"), (err) => {
    assert.ok(err instanceof PveApiError);
    assert.equal(err.status, 401);
    assert.match(err.message, /^PVE API 401: Authentication failed!\n/);
    assert.match(err.message, /bootstrap-token\.sh --rotate/);
    return true;
  });
});

// The script changes tokens on the cluster, and this text is all a caller without the skill sees.
test("a 401 sends nobody to the token script without the user's approval", async () => {
  await assert.rejects(failedWith(401, "Authentication failed!").get("/x"), /--rotate from this plugin, with the user's approval\./);
});

// Before per-machine tokens the script takes --rotate for a host name, finds the token file and exits 0.
test("a 401 says what to do when the token script cannot rotate", async () => {
  await assert.rejects(
    failedWith(401, "Authentication failed!").get("/x"),
    /If that reports nothing to do, this version of the script cannot rotate, so ask the user for a working token file instead\./,
  );
});

test("a 403 says retrying will not help, and keeps the permission PVE named", async () => {
  await assert.rejects(failedWith(403, "Permission check failed (/nodes/n1, Sys.Syslog)").get("/x"), (err) => {
    assert.match(err.message, /^PVE API 403: Permission check failed \(\/nodes\/n1, Sys\.Syslog\)\n/);
    assert.match(err.message, /retrying will not help/);
    return true;
  });
});

test("other statuses carry no advice", async () => {
  await assert.rejects(failedWith(500, "Configuration file does not exist").get("/x"), {
    message: "PVE API 500: Configuration file does not exist",
  });
});

// The shape of a real PVE 9 response to /cluster/resources?type=network.
const REJECTED_PARAMETER = JSON.stringify({
  data: null,
  errors: { type: "value 'network' does not have a value in the enumeration 'vm, storage, node, sdn'" },
  message: "Parameter verification failed.\n",
});

test("a 400 names what PVE objected to", async () => {
  await assert.rejects(failedWith(400, "Parameter verification failed.", REJECTED_PARAMETER).get("/x"), {
    message:
      "PVE API 400: Parameter verification failed. (type: value 'network' does not have a value in the enumeration 'vm, storage, node, sdn')",
  });
});

test("a 400 lists every parameter PVE objected to", async () => {
  const body = JSON.stringify({ errors: { node: "invalid format", vmid: "out of range" } });

  await assert.rejects(failedWith(400, "Parameter verification failed.", body).get("/x"), {
    message: "PVE API 400: Parameter verification failed. (node: invalid format; vmid: out of range)",
  });
});

const bodiesWithoutDetails = [
  ["an empty body", ""],
  ["a body that is not JSON", "<html>"],
  ["a body of null", "null"],
  ["a body without errors", '{"data":null}'],
  ["null errors", '{"errors":null}'],
  ["errors as text", '{"errors":"nope"}'],
  ["no errors listed", '{"errors":{}}'],
];

for (const [reason, body] of bodiesWithoutDetails) {
  test(`a failure with ${reason} keeps the status line`, async () => {
    await assert.rejects(failedWith(400, "Bad", body).get("/x"), { message: "PVE API 400: Bad" });
  });
}

// A 200 that did not come from PVE, such as a proxy's login page. The body must not reach the error.

const BODY_MARKER = "proxy-login-marker";

const bodiesNotFromPve = [
  ["HTML", `<html>${BODY_MARKER}</html>`],
  ["an empty body", ""],
  ["a body of null", "null"],
  ["a number", "1"],
  ["text", `"${BODY_MARKER}"`],
  ["a list", `["${BODY_MARKER}"]`],
  ["an object without data", `{"login":"${BODY_MARKER}"}`],
];

for (const [what, body] of bodiesNotFromPve) {
  test(`a 200 with ${what} is no answer, on any host`, async () => {
    const calls = [];
    const c = client(async (host) => {
      calls.push(host);
      return { status: 200, reason: "OK", body };
    });

    await assert.rejects(c.get("/x"), (err) => {
      assert.ok(err instanceof PveRequestError);
      assert.equal(err.code, "BAD_RESPONSE");
      assert.equal(
        err.message,
        "BAD_RESPONSE: No PVE host sent a PVE API response (a: a 200 without a PVE API body; b: a 200 without a PVE API body). Something other than PVE may be answering, such as a proxy. Check PVE_HOSTS and what listens on port 8006.",
      );
      return true;
    });
    assert.deepEqual(calls, ["a", "b"]);
  });
}

test("a host that sends something other than PVE is passed over, and stays passed over", async () => {
  const calls = [];
  const c = client(async (host) => {
    calls.push(host);
    return host === "a" ? { status: 200, reason: "OK", body: "<html>" } : ok(host);
  });

  assert.equal(await c.get("/x"), "b");
  assert.equal(await c.get("/x"), "b");
  assert.deepEqual(calls, ["a", "b", "b"]);
});

test("every host gets its turn while the ones before it send something other than PVE", async () => {
  const calls = [];
  const c = createClient({
    hosts: ["a", "b", "c"],
    getToken: () => "t",
    transport: async (host) => {
      calls.push(host);
      return host === "c" ? ok(host) : { status: 200, reason: "OK", body: "<html>" };
    },
  });

  assert.equal(await c.get("/x"), "c");
  assert.deepEqual(calls, ["a", "b", "c"]);
});

test("a host that sent something other than PVE is not the one tried first next time", async () => {
  const calls = [];
  let down = true;
  const c = client(async (host) => {
    calls.push(host);
    if (!down) return ok(host);
    return host === "a" ? fail("ETIMEDOUT", "timeout") : { status: 200, reason: "OK", body: "<html>" };
  });

  await assert.rejects(c.get("/x"), { code: "UNREACHABLE" });
  down = false;

  assert.equal(await c.get("/x"), "a");
  assert.deepEqual(calls, ["a", "b", "a"]);
});

test("a host that sends something other than PVE and one that fails are unreachable, each with its reason", async () => {
  const c = client(async (host) =>
    host === "a" ? { status: 200, reason: "OK", body: "<html>" } : fail("ETIMEDOUT", "timeout after 8000ms"),
  );

  await assert.rejects(c.get("/x"), {
    code: "UNREACHABLE",
    message: /\(a: a 200 without a PVE API body; b: timeout after 8000ms\)/,
  });
});

// One entry per call, with the outcome and without anything a client could not safely print.

function logged(transport, { getToken = () => "t" } = {}) {
  const entries = [];
  const pve = createClient({ hosts: ["a", "b"], getToken, transport, log: (entry) => entries.push(entry) });
  return { pve, entries };
}

function withoutTime(entries) {
  return entries.map(({ ms, ...entry }) => {
    assert.ok(Number.isInteger(ms) && ms >= 0, `ms is ${ms}`);
    return entry;
  });
}

test("a successful call logs the host that answered", async () => {
  const { pve, entries } = logged(async () => ok(1));

  await pve.get("/version");

  assert.deepEqual(withoutTime(entries), [{ host: "a", failover: false, status: 200, path: "/version" }]);
});

test("a call logs its path without query or fragment", async () => {
  const { pve, entries } = logged(async () => ok(1));

  await pve.get("/nodes/n1/tasks?secret=one#two", { other: "three" });

  assert.deepEqual(withoutTime(entries), [{ host: "a", failover: false, status: 200, path: "/nodes/n1/tasks" }]);
});

test("a call logs a failover, and the next call starts on the working host", async () => {
  const { pve, entries } = logged(async (host) => (host === "a" ? fail("ETIMEDOUT", "timeout") : ok(host)));

  await pve.get("/x");
  await pve.get("/x");

  assert.deepEqual(withoutTime(entries), [
    { host: "b", failover: true, status: 200, path: "/x" },
    { host: "b", failover: false, status: 200, path: "/x" },
  ]);
});

test("a call logs the HTTP status of a failure", async () => {
  const { pve, entries } = logged(async () => ({ status: 403, reason: "No", body: "" }));

  await assert.rejects(pve.get("/x"));

  assert.deepEqual(withoutTime(entries), [{ host: "a", failover: false, status: 403, path: "/x" }]);
});

test("a call logs the code of a failure on every host", async () => {
  const { pve, entries } = logged(async () => fail("ECONNREFUSED", "refused"));

  await assert.rejects(pve.get("/x"));

  assert.deepEqual(withoutTime(entries), [{ host: "b", failover: true, status: "REFUSED", path: "/x" }]);
});

test("a call that never left logs no host", async () => {
  const { pve, entries } = logged(async () => ok(1));

  await assert.rejects(pve.get("/x y?secret=one"));

  assert.deepEqual(withoutTime(entries), [{ host: null, failover: false, status: "BAD_REQUEST", path: "/x y" }]);
});

test("a call without a token logs why it never left", async () => {
  const getToken = () => {
    throw new PveRequestError("NO_TOKEN", "no token");
  };
  const { pve, entries } = logged(async () => ok(1), { getToken });

  await assert.rejects(pve.get("/x"));

  assert.deepEqual(withoutTime(entries), [{ host: null, failover: false, status: "NO_TOKEN", path: "/x" }]);
});

test("a call that got no PVE answer logs that, not the 200 it came with", async () => {
  const { pve, entries } = logged(async () => ({ status: 200, reason: "OK", body: "<html>" }));

  await assert.rejects(pve.get("/x"), { code: "BAD_RESPONSE" });

  assert.deepEqual(withoutTime(entries), [{ host: "b", failover: true, status: "BAD_RESPONSE", path: "/x" }]);
});

test("a call that got past a host sending something other than PVE logs a failover", async () => {
  const { pve, entries } = logged(async (host) => (host === "a" ? { status: 200, reason: "OK", body: "<html>" } : ok(1)));

  await pve.get("/x");

  assert.deepEqual(withoutTime(entries), [{ host: "b", failover: true, status: 200, path: "/x" }]);
});

// `ms` is how long the whole call took, so it has to come from the clock and cover every host tried.
test("a call logs how long it took across the hosts it tried", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { pve, entries } = logged(async (host) => {
    t.mock.timers.tick(host === "a" ? 300 : 40);
    return host === "a" ? fail("ETIMEDOUT", "timeout") : ok(1);
  });

  await pve.get("/x");

  assert.equal(entries[0].ms, 340);
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

test("get reports a host that stalls as a timeout", async (t) => {
  const stalled = await listen(t, https.createServer(credentials, () => {}));
  shortenTimeout(t, stalled);
  const pve = createClient({ hosts: [LOOPBACK], getToken: () => TOKEN, transport: transportTo(t, stalled) });

  await assert.rejects(settling(pve.get("/version")), {
    code: "TIMEOUT",
    message: /^TIMEOUT: No PVE host answered in time \(127\.0\.0\.1: timeout after 8000ms\)/,
  });
});

// A connection lost mid-body leaves nothing to time out, so only its own error can end the request.

const cutOffs = [
  ["a clean close", (socket) => socket.end()],
  ["a reset", (socket) => socket.destroy()],
];

const cuttingOffServer = (cut) =>
  https.createServer(credentials, (req, res) => {
    res.writeHead(200, { "content-length": "2" });
    res.write("{", () => cut(res.socket));
  });

for (const [how, cut] of cutOffs) {
  test(`the transport gives up on a response cut off by ${how}`, async (t) => {
    const port = await listen(t, cuttingOffServer(cut));

    await assert.rejects(settling(transportTo(t, port)(LOOPBACK, "/version", TOKEN)), { code: "ECONNRESET" });
  });

  test(`get fails over past a response cut off by ${how}`, async (t) => {
    const cutOff = await listen(t, cuttingOffServer(cut));
    const healthy = await startFakePve(t, credentials);
    const transports = { cutOff: transportTo(t, cutOff), healthy: transportTo(t, healthy.port) };
    const pve = createClient({
      hosts: ["cutOff", "healthy"],
      getToken: () => TOKEN,
      transport: (host, path, token) => transports[host](LOOPBACK, path, token),
    });

    assert.deepEqual(await settling(pve.get("/version")), { served: true });
  });
}

// Other failures, on real sockets.

async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("get reports a closed port as a refused connection", async (t) => {
  const pve = createClient({ hosts: [LOOPBACK], getToken: () => TOKEN, transport: transportTo(t, await closedPort()) });

  await assert.rejects(pve.get("/version"), {
    code: "REFUSED",
    message: /^REFUSED: Every PVE host refused the connection \(127\.0\.0\.1: connect ECONNREFUSED/,
  });
});

test("get reports an expired node certificate as a TLS failure, before the token is sent", async (t) => {
  const server = await startFakePve(t, ca.issue(LOOPBACK, { expired: true }));
  const pve = createClient({ hosts: [LOOPBACK], getToken: () => TOKEN, transport: transportTo(t, server.port) });

  await assert.rejects(pve.get("/version"), {
    code: "TLS_VERIFY",
    message: /^TLS_VERIFY: No PVE host passed certificate verification \(127\.0\.0\.1: CERT_HAS_EXPIRED\)/,
  });
  assert.deepEqual(server.requests, []);
});

test("a token Node refuses to send fails at once, and stays out of the error", async (t) => {
  const server = await startFakePve(t, credentials);
  const pve = createClient({
    hosts: [LOOPBACK, LOOPBACK],
    getToken: () => `${TOKEN}\nsecond line`,
    transport: transportTo(t, server.port),
  });

  await assert.rejects(pve.get("/version"), (err) => {
    assert.equal(err.code, "BAD_REQUEST");
    assert.ok(!err.message.includes(TOKEN.split("=")[1]), err.message);
    return true;
  });
  assert.deepEqual(server.requests, []);
});

test("httpsTransport can be created before its CA file exists, and picks it up once it does", async (t) => {
  const server = await startFakePve(t, credentials);
  const caFile = join(tempDir(t), "ca.pem");
  const transport = httpsTransport({ caFile, port: server.port });

  await assert.rejects(transport(LOOPBACK, "/version", TOKEN), {
    code: "CA_FILE",
    message: new RegExp(`^CA_FILE: Cannot read the PVE CA certificate\\. ENOENT.*${caFile}`),
  });
  assert.deepEqual(server.requests, []);

  writeFileSync(caFile, ca.cert);

  assert.equal((await transport(LOOPBACK, "/version", TOKEN)).status, 200);
});
