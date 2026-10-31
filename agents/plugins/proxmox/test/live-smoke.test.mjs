// Runs the real smoke script as a process against a fake PVE, and reads what it leaves behind. GitHub
// keeps all of that, so LEAK, which sits in every free-text field the fake answers with, must never
// show up in it. The token here is fake and PVE_HOSTS keeps the real cluster out of reach.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCa } from "./helpers/certs.mjs";
import { LOOPBACK, listen, tempDir } from "./helpers/fake-pve.mjs";

const SMOKE = fileURLToPath(new URL("./smoke/live.mjs", import.meta.url));
const DIAL_FAKE_PVE = new URL("./helpers/dial-fake-pve.mjs", import.meta.url).href;

const SECRET = "not-a-real-secret";
const TOKEN = `tester@pve!smoke=${SECRET}`;
const LEAK = "LEAKED";
const TOOLS = ["api_get", "cluster_overview", "guest_config", "list_resources", "node_status", "recent_tasks"];
const NODES = ["pve-node", "pve-node", "pve-node"];
const DAY_S = 86_400;

const ca = createCa("fake cluster CA");
const otherCa = createCa("some other CA");

const inDays = (days) => Math.floor(Date.now() / 1000) + days * DAY_S;
const CLUSTER = { type: "cluster", name: LEAK, nodes: NODES.length, quorate: 1 };
const NODE_ENTRIES = NODES.map((name) => ({ type: "node", name, node: name, ip: LEAK }));
const GUEST = { type: "qemu", node: NODES[0], vmid: 100, name: LEAK };
const GUEST_CONFIG = `/nodes/${GUEST.node}/qemu/${GUEST.vmid}/config`;

const certificates = (notafter) => [{ notafter, subject: LEAK, pem: LEAK }];
const certificateRoutes = (notafter) =>
  Object.fromEntries(NODES.map((node) => [`/nodes/${node}/certificates/info`, certificates(notafter)]));

const HEALTHY = {
  "/version": { version: LEAK, release: LEAK },
  "/cluster/status": [CLUSTER, ...NODE_ENTRIES],
  "/cluster/ha/status/current": [{ id: LEAK }],
  "/cluster/resources": [...NODE_ENTRIES, GUEST, { type: "network", id: LEAK }],
  "/cluster/resources?type=sdn": [],
  "/cluster/resources?type=vm": [GUEST],
  "/cluster/tasks": [{ upid: LEAK, starttime: 1 }],
  "/access/permissions": { "/": { "Sys.Audit": 1 }, "/vms": { "VM.Audit": 1 } },
  [GUEST_CONFIG]: { digest: LEAK, name: LEAK },
  ...Object.fromEntries(NODES.map((node) => [`/nodes/${node}/status`, { pveversion: LEAK }])),
  ...certificateRoutes(inDays(400)),
};

// A route is the data to answer with, or a function that writes the response itself.
async function startCluster(t, overrides = {}) {
  const routes = { ...HEALTHY, ...overrides };
  const requests = [];
  const server = https.createServer(ca.issue(LOOPBACK), (req, res) => {
    const path = req.url.replace("/api2/json", "");
    requests.push({ method: req.method, path });
    const route = routes[path];
    if (typeof route === "function") return route(res, server);
    res.writeHead(route === undefined ? 404 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: route }));
  });
  return { port: await listen(t, server), requests };
}

function runSmoke(t, port, env = {}) {
  const dir = tempDir(t);
  const [caFile, tokenFile, summaryFile] = ["ca.pem", "token", "summary"].map((name) => join(dir, name));
  writeFileSync(caFile, ca.cert);
  writeFileSync(tokenFile, `${TOKEN}\n`);
  writeFileSync(summaryFile, "");

  const processEnv = {
    HOME: dir,
    PATH: process.env.PATH,
    NODE_OPTIONS: `--import=${DIAL_FAKE_PVE}`,
    FAKE_PVE_PORT: port,
    FAKE_PVE_LOG: join(dir, "https-requests"),
    PVE_HOSTS: LOOPBACK,
    PVE_CA_FILE: caFile,
    PVE_TOKEN_FILE: tokenFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    ...env,
  };
  return new Promise((resolve) => {
    execFile(process.execPath, [SMOKE], { env: processEnv }, (error, stdout, stderr) =>
      resolve({ status: error?.code ?? 0, stdout, stderr, summary: readFileSync(summaryFile, "utf8") }),
    );
  });
}

function assertNothingEscaped({ stdout, stderr, summary }) {
  assert.equal(stderr, "");
  for (const output of [stdout, summary]) {
    assert.doesNotMatch(output, new RegExp(LEAK));
    assert.ok(!output.includes(SECRET), "the token reached the output");
  }
}

// Only a real pass gets this far, so nothing else here has to repeat it.
function assertPassed(result) {
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^live smoke: PASS$/m);
  assertNothingEscaped(result);
}

function assertFailed(result, verdict) {
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stdout.endsWith(`live smoke: ${verdict}\n`), result.stdout);
  assert.match(result.summary, new RegExp(`^### Live smoke: ${verdict}$`, "m"));
  assertNothingEscaped(result);
}

// A port something was just listening on, so nothing is.
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Every test owns its fake and its directory, and spends nearly all its time waiting for a process.
describe("live smoke", { concurrency: true }, () => {
  test("a healthy cluster passes every tool, with GET only and nothing from a response in the output", async (t) => {
    const { port, requests } = await startCluster(t);
    const result = await runSmoke(t, port);

    assertPassed(result);
    for (const name of [...TOOLS, "certificates"]) {
      assert.match(result.stdout, new RegExp(`^PASS ${name} \\d+ ms `, "m"));
    }
    assert.match(result.stdout, /^host 127\.0\.0\.1: answered in \d+ ms$/m);
    assert.match(result.stdout, /^PASS cluster_overview \d+ ms nodes=3 quorate=1$/m);
    assert.deepEqual([...new Set(requests.map(({ method }) => method))], ["GET"]);
    assert.ok(requests.some(({ path }) => path === GUEST_CONFIG));
  });

  test("the step summary repeats the verdict and the lines", async (t) => {
    const { port } = await startCluster(t);
    const { stdout, summary } = await runSmoke(t, port);

    assert.match(summary, /^### Live smoke: PASS$/m);
    for (const line of stdout.trim().split("\n")) assert.ok(summary.includes(line), line);
  });

  test("what the server writes to stderr stays out of the output", async (t) => {
    const noisy = join(tempDir(t), "noisy.mjs");
    writeFileSync(noisy, `if (process.argv[1].endsWith("index.mjs")) console.error(${JSON.stringify(LEAK)});\n`);
    const { port } = await startCluster(t);
    const NODE_OPTIONS = `--import=${DIAL_FAKE_PVE} --import=${pathToFileURL(noisy).href}`;

    assertPassed(await runSmoke(t, port, { NODE_OPTIONS }));
  });

  const WRONG_ANSWERS = [
    ["cluster_overview", "too few nodes", { "/cluster/status": [{ ...CLUSTER, nodes: 2 }, ...NODE_ENTRIES] }],
    ["cluster_overview", "a node under another name", { "/cluster/status": [CLUSTER, ...NODE_ENTRIES.slice(1), { type: "node", name: LEAK }] }],
    ["cluster_overview", "no HA status", { "/cluster/ha/status/current": null }],
    ["list_resources", "too few nodes", { "/cluster/resources": [GUEST, ...NODE_ENTRIES.slice(1)] }],
    ["node_status", "a node with no pveversion", { [`/nodes/${NODES[2]}/status`]: { uptime: LEAK } }],
    ["guest_config", "no guests", { "/cluster/resources?type=vm": [] }],
    ["guest_config", "a config with no digest", { [GUEST_CONFIG]: { name: LEAK } }],
    ["recent_tasks", "no list of tasks", { "/cluster/tasks": LEAK }],
    ["api_get", "no version", { "/version": { release: LEAK } }],
    ["certificates", "a node with no certificates", { [`/nodes/${NODES[1]}/certificates/info`]: [] }],
  ];

  for (const [tool, wrong, overrides] of WRONG_ANSWERS) {
    test(`${tool} with ${wrong} fails as PLUGIN and names only that check`, async (t) => {
      const { port } = await startCluster(t, overrides);
      const result = await runSmoke(t, port);

      assertFailed(result, "FAIL PLUGIN: 1 failed");
      assert.deepEqual(result.stdout.match(/^FAIL \w+/gm), [`FAIL ${tool}`]);
    });
  }

  test("a PVE error shows its status and none of PVE's words", async (t) => {
    const refuse = (res) => {
      res.writeHead(500, LEAK, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: { path: LEAK } }));
    };
    const { port } = await startCluster(t, { [GUEST_CONFIG]: refuse });
    const result = await runSmoke(t, port);

    assertFailed(result, "FAIL PLUGIN: 1 failed");
    assert.match(result.stdout, /^FAIL guest_config \d+ ms: PVE API 500$/m);
  });

  test("a body that is no JSON stays out of the output, though the parse error quotes it", async (t) => {
    const notJson = (res) => {
      res.writeHead(200);
      res.end(`${LEAK} is no JSON`);
    };
    const { port } = await startCluster(t, { "/cluster/tasks": notJson });
    const result = await runSmoke(t, port);

    assertFailed(result, "FAIL PLUGIN: 1 failed");
    assert.match(result.stdout, /^FAIL recent_tasks \d+ ms: /m);
  });

  test("a privilege beyond .Audit fails, by count and not by name", async (t) => {
    const permissions = { "/": { "Sys.Audit": 1, [`${LEAK}.Modify`]: 1 } };
    const { port } = await startCluster(t, { "/access/permissions": permissions });
    const result = await runSmoke(t, port);

    assertFailed(result, "FAIL PLUGIN: 1 failed");
    assert.match(result.stdout, /^FAIL api_get \d+ ms: the token holds 1 privileges beyond \.Audit$/m);
  });

  test("no privileges at all do not pass as all .Audit", async (t) => {
    for (const permissions of [{}, { "/": {} }]) {
      const { port } = await startCluster(t, { "/access/permissions": permissions });
      const result = await runSmoke(t, port);

      assertFailed(result, "FAIL PLUGIN: 1 failed");
      assert.match(result.stdout, /^FAIL api_get \d+ ms: the token holds no privileges$/m);
    }
  });

  test("hosts that refuse the connection read as INFRA, and no tool is called", async (t) => {
    const result = await runSmoke(t, await closedPort());

    assertFailed(result, "FAIL INFRA: no host answered");
    assert.match(result.stdout, /^host 127\.0\.0\.1: ECONNREFUSED$/m);
    assert.doesNotMatch(result.stdout, /^(?:PASS|FAIL) /m);
  });

  test("a host that accepts and then says nothing reads as INFRA", async (t) => {
    const silent = net.createServer();
    const port = await listen(t, silent);
    const result = await runSmoke(t, port, { FAKE_PVE_TIMEOUT_MS: "50" });

    assertFailed(result, "FAIL INFRA: no host answered");
    assert.match(result.stdout, /^host 127\.0\.0\.1: ETIMEDOUT$/m);
  });

  test("one host down is no failure, and it shows", async (t) => {
    const { port } = await startCluster(t);
    const down = "127.0.0.2"; // The fake listens on 127.0.0.1 only.
    const result = await runSmoke(t, port, { PVE_HOSTS: `${down},${LOOPBACK}` });

    assertPassed(result);
    assert.match(result.stdout, /^host 127\.0\.0\.2: ECONNREFUSED$/m);
    assert.match(result.stdout, /^host 127\.0\.0\.1: answered in \d+ ms$/m);
  });

  test("a certificate that fails verification reads as PLUGIN, because a host answered", async (t) => {
    const { port, requests } = await startCluster(t);
    const caFile = join(tempDir(t), "other-ca.pem");
    writeFileSync(caFile, otherCa.cert);
    const result = await runSmoke(t, port, { PVE_CA_FILE: caFile });

    assertFailed(result, "FAIL PLUGIN: 7 failed");
    assert.match(result.stdout, /^host 127\.0\.0\.1: [A-Z_]+$/m);
    assert.deepEqual(requests, []);
  });

  test("no token reads as INFRA, and nothing is sent", async (t) => {
    const { port, requests } = await startCluster(t);
    const result = await runSmoke(t, port, { PVE_TOKEN_FILE: join(tempDir(t), "missing") });

    assertFailed(result, "FAIL INFRA: no API token on this machine");
    assert.deepEqual(requests, []);
  });

  test("a cluster that goes away after the first probe reads as INFRA", async (t) => {
    const vanish = (res, server) => {
      server.close();
      server.closeAllConnections();
    };
    const { port } = await startCluster(t, { "/cluster/status": vanish });
    const result = await runSmoke(t, port);

    assertFailed(result, "FAIL INFRA: no host answered");
    assert.match(result.stdout, /^host 127\.0\.0\.1: answered in \d+ ms$/m);
    assert.match(result.stdout, /^FAIL cluster_overview /m);
  });

  test("the weekly run fails 30 days before a certificate expires, and a deployment does not", async (t) => {
    const { port } = await startCluster(t, certificateRoutes(inDays(29)));

    const weekly = await runSmoke(t, port, { GITHUB_EVENT_NAME: "schedule" });
    assertFailed(weekly, "FAIL PLUGIN: 1 failed");
    assert.match(weekly.stdout, /^FAIL certificates \d+ ms: a certificate expires in 2\d days$/m);

    const push = await runSmoke(t, port, { GITHUB_EVENT_NAME: "push" });
    assertPassed(push);
    assert.match(push.stdout, /^PASS certificates \d+ ms soonest expiry in 2\d days$/m);
  });

  test("the weekly run passes while certificates have longer than that", async (t) => {
    const { port } = await startCluster(t, certificateRoutes(inDays(31)));
    assertPassed(await runSmoke(t, port, { GITHUB_EVENT_NAME: "schedule" }));
  });

  test("an expired certificate fails any run, and the soonest of them decides", async (t) => {
    const soonest = `/nodes/${NODES[1]}/certificates/info`;
    const { port } = await startCluster(t, { [soonest]: [...certificates(inDays(400)), ...certificates(inDays(-1))] });
    const result = await runSmoke(t, port, { GITHUB_EVENT_NAME: "push" });

    assertFailed(result, "FAIL PLUGIN: 1 failed");
    assert.match(result.stdout, /^FAIL certificates \d+ ms: a certificate expires in -\d+ days$/m);
  });
});
