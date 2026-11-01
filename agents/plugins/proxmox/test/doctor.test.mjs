// Runs the real doctor.sh against a throwaway home, fake git, gh and npm, and a fake PVE over real TLS.
// PATH holds nothing beyond the sandbox, so no run can reach the real cluster, repository or tools.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { expiryStatus, rotationDue, tokenIdOf } from "../scripts/doctor-checks.mjs";
import { connectionSettings } from "../server/pve.mjs";
import { createCa } from "./helpers/certs.mjs";
import { LOOPBACK, startFakePve, tempDir } from "./helpers/fake-pve.mjs";

const fromTest = (path) => fileURLToPath(new URL(path, import.meta.url));
const PLUGIN_ROOT = fromTest("..");
const SCRIPTS = join(PLUGIN_ROOT, "scripts");
const DOCTOR = join(SCRIPTS, "doctor.sh");
const FAKES = fromTest("./fakes");
const DIAL_FAKE_PVE = new URL("./helpers/dial-fake-pve.mjs", import.meta.url).href;

const REPO = "sagaeforge/sagae-claude-plugins";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const TAG_OBJECT = "c".repeat(40);
const DAY_MS = 24 * 60 * 60 * 1000;
const LONG_VALIDITY = { validForMs: 3650 * DAY_MS };

const MONTH = new Date().toISOString().slice(0, 7).replace("-", "");
// Made at run time, in the shape real ones have: the repository then holds nothing that looks like a
// token, and the pattern test below is looking for what a leak would really look like.
const SECRET = randomUUID();
const TOKEN_ID = `claude-mcp@pve!m-test-${MONTH}`;
const TOKEN = `${TOKEN_ID}=${SECRET}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const pinnedCa = createCa("doctor test CA", LONG_VALIDITY);
const otherCa = createCa("some other CA", LONG_VALIDITY);

const inDays = (days) => Math.floor((Date.now() + days * DAY_MS) / 1000);

// As PVE lists them. The CA subject carries the cluster UUID, so printing one would fail every test.
const nodeCertificates = (days = 400) => [
  { filename: "pve-root-ca.pem", notafter: inDays(3000), subject: `/CN=PVE/OU=${randomUUID()}/O=PVE Cluster Manager CA` },
  { filename: "pve-ssl.pem", notafter: inDays(days), subject: "/OU=PVE Cluster Node/CN=node.example" },
];

const clusterStatus = (offline = []) => [
  { type: "cluster", name: "test", quorate: 1 },
  ...["n1", "n2", "n3"].map((name) => ({ type: "node", name, online: offline.includes(name) ? 0 : 1 })),
];

const AUDIT_ONLY = { "/": { "Sys.Audit": 1, "VM.Audit": 1, "VM.GuestAgent.Audit": 1 }, "/vms": { "VM.Audit": 1 } };

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const refusal = (status) => (_req, res) => reply(res, status, { data: null });

// Holds to what PVE does about credentials: only /access/domains is open.
function servePve(acceptedToken, routes) {
  const answers = {
    "/access/domains": [{ realm: "pam", type: "pam" }],
    "/version": { version: "9.2.2", release: "9.2", repoid: "b9984c6d90a4bd80" },
    "/access/permissions": AUDIT_ONLY,
    "/cluster/status": clusterStatus(),
    "/nodes/n1/certificates/info": nodeCertificates(),
    "/nodes/n2/certificates/info": nodeCertificates(),
    "/nodes/n3/certificates/info": nodeCertificates(),
    ...routes,
  };
  return (req, res) => {
    const path = req.url.replace("/api2/json", "");
    if (path !== "/access/domains" && req.headers.authorization !== `PVEAPIToken=${acceptedToken}`) {
      return refusal(401)(req, res);
    }
    const answer = answers[path];
    if (answer === undefined) return refusal(404)(req, res);
    if (typeof answer === "function") return answer(req, res);
    return reply(res, 200, { data: answer });
  };
}

const REAL_TOOLS = ["bash", "dirname", "readlink"];
const realToolPaths = execFileSync("sh", ["-c", 'for tool; do command -v "$tool" || exit 1; done', "sh", ...REAL_TOOLS], {
  encoding: "utf8",
})
  .trim()
  .split("\n");

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

// `null` for a setting leaves that thing out of the sandbox.
function buildSandbox(t, port, scenario) {
  const {
    token = TOKEN,
    tokenMode = 0o600,
    tokenPathIsDirectory = false,
    ca = pinnedCa,
    marketplace = { source: { source: "github", repo: REPO }, autoUpdate: true },
    settings = { enabledPlugins: { "proxmox@sagae": true } },
    install = { scope: "user", gitCommitSha: SHA },
    installGone = false,
    originUrl = `git@github.com:${REPO}.git`,
    remoteRefs = [
      [SHA, "HEAD"],
      [SHA, "refs/heads/main"],
    ],
    dependencies = ["@modelcontextprotocol/sdk", "zod"],
    installedDependencies = dependencies,
    runners = [{ name: "pve-runner-01", status: "online" }],
    runs = [{ status: "completed", conclusion: "success" }],
    without = [],
    nodeVersion = "v26.0.0",
    separateConfigDir = false,
    separatePluginsDir = false,
    env = {},
    prepare = () => {},
  } = scenario;

  const dir = tempDir(t);
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  const configDir = join(separateConfigDir ? join(home, "config-elsewhere") : home, ".claude");
  const pluginsDir = separatePluginsDir ? join(home, "plugins-elsewhere") : join(configDir, "plugins");
  const clone = join(pluginsDir, "marketplaces", "sagae");
  const installPath = join(pluginsDir, "cache", "sagae", "proxmox", SHA.slice(0, 12));
  const tokenFile = join(home, ".config", "proxmox-mcp", "token");
  mkdirSync(bin);
  mkdirSync(state);
  mkdirSync(pluginsDir, { recursive: true });

  // node is the shim too, so that a test's outcome does not hang on the Node running the tests.
  for (const name of ["git", "gh", "npm", "node"].filter((tool) => !without.includes(tool))) {
    copyFileSync(join(FAKES, name), join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  REAL_TOOLS.forEach((name, i) => symlinkSync(realToolPaths[i], join(bin, name)));

  writeJson(join(pluginsDir, "known_marketplaces.json"), marketplace ? { sagae: { installLocation: clone, ...marketplace } } : {});
  if (settings) writeJson(join(configDir, "settings.json"), settings);

  const installs = install ? [install].flat().map((entry) => ({ installPath, ...entry })) : [];
  writeJson(join(pluginsDir, "installed_plugins.json"), { version: 2, plugins: { "proxmox@sagae": installs } });
  if (!installGone) {
    writeJson(join(installPath, "package.json"), { dependencies: Object.fromEntries(dependencies.map((name) => [name, "*"])) });
    for (const name of installedDependencies) writeJson(join(installPath, "node_modules", name, "package.json"), {});
  }

  if (originUrl) {
    mkdirSync(join(clone, ".git"), { recursive: true });
    writeFileSync(join(clone, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${originUrl}\n\tfetch = +refs/heads/main:refs/remotes/origin/main\n`);
  }

  mkdirSync(dirname(tokenFile), { recursive: true });
  if (tokenPathIsDirectory) {
    mkdirSync(tokenFile);
  } else if (token !== null) {
    writeFileSync(tokenFile, `${token}\n`);
    chmodSync(tokenFile, tokenMode);
  }

  writeFileSync(join(state, "remote-refs"), remoteRefs.map((row) => `${row.join("\t")}\n`).join(""));
  if (runners) writeJson(join(state, "gh-runners.json"), { total_count: runners.length, runners });
  if (runs) writeJson(join(state, "gh-runs.json"), { total_count: runs.length, workflow_runs: runs });

  const caFile = join(state, "ca.pem");
  writeFileSync(caFile, ca.cert);
  const requestLog = join(state, "https-requests");
  writeFileSync(requestLog, "");

  prepare({ home, pluginsDir, configDir, installPath, tokenFile });

  return {
    home,
    state,
    requestLog,
    env: {
      HOME: home,
      PATH: bin,
      FAKE_STATE: state,
      FAKE_PVE_PORT: port,
      FAKE_PVE_LOG: requestLog,
      NODE_OPTIONS: `--import=${DIAL_FAKE_PVE}`,
      PVE_HOSTS: LOOPBACK,
      PVE_CA_FILE: caFile,
      ...(separateConfigDir && { CLAUDE_CONFIG_DIR: configDir }),
      ...(separatePluginsDir && { CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginsDir }),
      FAKE_NODE_VERSION: nodeVersion,
      REAL_NODE: process.execPath,
      ...env,
    },
  };
}

// Every path under `dir` with what would show a change to it: mode, size, mtime and content.
function snapshot(dir, found = {}) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stats = lstatSync(path);
    found[path] = [stats.mode, stats.size, stats.mtimeMs];
    if (stats.isDirectory()) snapshot(path, found);
    else found[path].push(createHash("sha256").update(readFileSync(path)).digest("hex"));
  }
  return found;
}

// Paths belong in a report, and the directory a checkout or a temp file sits in can have a UUID in its
// name. The scan is after what the doctor adds, so those come out first.
const withoutPaths = (output) => output.replaceAll(PLUGIN_ROOT, "").replaceAll(tmpdir(), "");

function assertNoTokenValue(output) {
  assert.ok(!output.includes(SECRET), "the output holds the secret");
  assert.doesNotMatch(output, UUID);
  assert.doesNotMatch(output, /PVEAPIToken/);
  assert.doesNotMatch(output, /=[0-9a-f-]{20,}/);
}

function spawnScript(script, args, env) {
  return new Promise((resolve) => {
    execFile(script, args, { env, timeout: 30000 }, (err, stdout, stderr) =>
      resolve({ status: err ? err.code : 0, stdout, stderr }),
    );
  });
}

// One full run. The rules every run has to keep are asserted here, so that every scenario in this
// file holds them and not only the ones written about them.
async function runDoctor(t, scenario = {}) {
  const { args = ["--json"], script = DOCTOR, certificate = (scenario.ca ?? pinnedCa).issue(LOOPBACK), pve = {} } = scenario;
  const server = await startFakePve(t, certificate, servePve(scenario.acceptedToken ?? scenario.token ?? TOKEN, pve));
  const sandbox = buildSandbox(t, server.port, scenario);

  const before = snapshot(sandbox.home);
  const { status, stdout, stderr } = await spawnScript(script, args, sandbox.env);

  assert.deepEqual(snapshot(sandbox.home), before, "a run changed something under the home directory");
  assert.deepEqual(server.requests.filter(({ method }) => method !== "GET"), []);
  assertNoTokenValue(withoutPaths(stdout + stderr));

  const logged = readFileSync(join(sandbox.state, "https-requests"), "utf8");
  return {
    status,
    stdout,
    stderr,
    server,
    report: args.includes("--json") && stdout ? JSON.parse(stdout) : undefined,
    commands: existsSync(join(sandbox.state, "commands.log"))
      ? readFileSync(join(sandbox.state, "commands.log"), "utf8").trim().split("\n").sort()
      : [],
    dialed: logged
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

function assertStatuses(report, exceptions = {}) {
  const statuses = Object.fromEntries(report.checks.map(({ id, status }) => [id, status]));
  const expected = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, exceptions[i + 1] ?? "pass"]));
  assert.deepEqual(statuses, expected, JSON.stringify(report.checks, null, 2));
}

const check = ({ checks }, id) => checks.find((entry) => entry.id === id);
const wantedAt = (id, field, pattern) => (report) => assert.match(check(report, id)[field], pattern);

// A check's other states, each with the statuses it should lead to and the exit code.
function scenarios(list) {
  for (const { name, statuses, exitCode, expect = () => {}, ...scenario } of list) {
    test(name, async (t) => {
      const run = await runDoctor(t, scenario);
      assertStatuses(run.report, statuses);
      assert.equal(run.status, exitCode);
      assert.equal(run.report.exitCode, exitCode);
      expect(run.report, run);
    });
  }
}

test("a healthy machine passes all ten checks and exits 0", async (t) => {
  const { status, report, stdout } = await runDoctor(t);

  assert.equal(status, 0);
  assert.equal(report.status, "pass");
  assert.equal(report.exitCode, 0);
  assertStatuses(report);
  assert.deepEqual(
    report.checks.map(({ name }) => name),
    ["toolchain", "marketplace", "installed-commit", "dependencies", "token-file", "token-age", "hosts", "permissions", "certificates", "github"],
  );
  assert.ok(stdout.includes(TOKEN_ID), "check 5 shows the ID");
});

// The four situations the design requires to fail, each at its own item and nowhere it should not.

test("no token file fails the token check, and what needs a token is skipped", async (t) => {
  const { status, report, server } = await runDoctor(t, { token: null });

  assert.equal(status, 2);
  assertStatuses(report, { 5: "fail", 6: "skip", 8: "skip", 9: "skip" });
  assert.match(check(report, 5).action, /scripts\/bootstrap-token\.sh\.$/);
  // The hosts are still proved, which is what a new machine needs before it has a token.
  assert.deepEqual(server.requests.map(({ url }) => url), ["/api2/json/access/domains"]);
});

test("a CA that does not match fails the hosts check, and no request gets through", async (t) => {
  const { status, report, server } = await runDoctor(t, { ca: otherCa, certificate: pinnedCa.issue(LOOPBACK) });

  assert.equal(status, 2);
  assertStatuses(report, { 7: "fail", 8: "skip", 9: "skip" });
  assert.match(check(report, 7).details[0], /^TLS_VERIFY 127\.0\.0\.1: UNABLE_TO_VERIFY_LEAF_SIGNATURE$/);
  assert.match(check(report, 7).action, /pinned CA/);
  assert.deepEqual(server.requests, []);
});

test("an install behind the remote fails the commit check", async (t) => {
  const { status, report } = await runDoctor(t, { remoteRefs: [[OTHER_SHA, "HEAD"]] });

  assert.equal(status, 2);
  assertStatuses(report, { 3: "fail" });
  assert.match(check(report, 3).summary, new RegExp(`${SHA.slice(0, 12)}.*${OTHER_SHA.slice(0, 12)}`));
  assert.match(check(report, 3).action, /claude plugin marketplace update sagae && claude plugin update proxmox@sagae/);
});

test("a token that can do more than read fails the permissions check", async (t) => {
  const permissions = { "/": { "Sys.Audit": 1, "VM.PowerMgmt": 1 }, "/vms": { "Sys.Modify": 1 } };
  const { status, report } = await runDoctor(t, { pve: { "/access/permissions": permissions } });

  assert.equal(status, 2);
  assertStatuses(report, { 8: "fail" });
  assert.match(check(report, 8).summary, /Sys\.Modify, VM\.PowerMgmt\.$/);
  assert.doesNotMatch(check(report, 8).summary, /Sys\.Audit/);
  assert.match(check(report, 8).action, /^Stop using this token now/);
});

// What leaves the doctor. runDoctor checks this on every run, and the runs here are the ones most
// likely to leak: unusual token files, every kind of failure, and both output formats.

const leakScenarios = {
  healthy: {},
  "a token holding only a secret": { token: SECRET },
  "a token with no ID": { token: `=${SECRET}` },
  "a token with a mangled ID": { token: `not a token=${SECRET}` },
  "a rejected token": { acceptedToken: "other@pve!id=other" },
  "PVE answering 500": { pve: { "/version": refusal(500), "/access/permissions": refusal(500) } },
  "a wrong CA": { ca: otherCa, certificate: pinnedCa.issue(LOOPBACK) },
  "a shared token": { token: `claude-mcp@pve!mcp=${SECRET}` },
  "a token in the environment": { token: null, env: { PVE_API_TOKEN: TOKEN } },
  "a broken PVE_API_TOKEN": { token: null, env: { PVE_API_TOKEN: SECRET } },
};

for (const [name, scenario] of Object.entries(leakScenarios)) {
  for (const args of [[], ["--json"]]) {
    test(`no token value in the ${args.length ? "JSON" : "text"} output: ${name}`, async (t) => {
      const { stdout, stderr } = await runDoctor(t, { ...scenario, args });

      assert.notEqual(stdout, "");
      assertNoTokenValue(withoutPaths(stdout + stderr));
    });
  }
}

test("the leak check looks past paths but not past what is printed in them", () => {
  assert.doesNotThrow(() => assertNoTokenValue(withoutPaths(`${join(PLUGIN_ROOT, "x")} ${join(tmpdir(), "y")}`)));
  assert.throws(() => assertNoTokenValue(withoutPaths(join(PLUGIN_ROOT, SECRET))));
});

test("the token leak check itself catches a printed token", () => {
  assert.throws(() => assertNoTokenValue(`token is ${SECRET}`));
  assert.throws(() => assertNoTokenValue(randomUUID()));
  assert.throws(() => assertNoTokenValue("Authorization: PVEAPIToken=x"));
});

test("a host that fails verification is never sent the token", async (t) => {
  const { dialed } = await runDoctor(t, { ca: otherCa, certificate: pinnedCa.issue(LOOPBACK) });

  assert.deepEqual(dialed.map(({ headers }) => headers.Authorization), ["PVEAPIToken="]);
});

// Staying read-only. runDoctor compares every file under the home and refuses any request but GET.

test("a healthy run makes exactly these PVE requests", async (t) => {
  const { server } = await runDoctor(t);
  const seen = server.requests.map(({ method, url, headers }) => `${method} ${url} ${headers.authorization}`).sort();
  const authorized = (path) => `GET /api2/json${path} PVEAPIToken=${TOKEN}`;

  assert.deepEqual(
    seen,
    [
      "GET /api2/json/access/domains PVEAPIToken=",
      authorized("/access/permissions"),
      authorized("/cluster/status"),
      authorized("/nodes/n1/certificates/info"),
      authorized("/nodes/n2/certificates/info"),
      authorized("/nodes/n3/certificates/info"),
      authorized("/version"),
    ].sort(),
  );
});

test("a healthy run starts exactly these commands, and all of them only read", async (t) => {
  const { commands } = await runDoctor(t);

  assert.deepEqual(
    commands,
    [
      `gh api --method GET repos/${REPO}/actions/runners`,
      `gh api --method GET repos/${REPO}/actions/workflows/ci.yml/runs?branch=main&per_page=1`,
      `git ls-remote -- git@github.com:${REPO}.git HEAD refs/heads/stable`,
      "npm --version",
    ].sort(),
  );
});

test("the doctor's sources can only read", () => {
  const checks = readFileSync(join(SCRIPTS, "doctor-checks.mjs"), "utf8");
  const entry = readFileSync(join(SCRIPTS, "doctor.mjs"), "utf8");

  assert.deepEqual(
    [...checks.matchAll(/^import .* from "(.+)";$/gm)].map(([, source]) => source).sort(),
    ["../server/pve.mjs", "node:child_process", "node:crypto", "node:fs", "node:os", "node:path"],
  );
  assert.match(checks, /^import \{ existsSync, readFileSync, statSync \} from "node:fs";$/m);
  assert.deepEqual([...entry.matchAll(/\bimport\b.*$/gm)].map(([line]) => line), ['import("./doctor-checks.mjs");']);
  for (const source of [checks, entry]) {
    assert.doesNotMatch(source, /\b(writeFile|appendFile|createWriteStream|rename|unlink|rmdir|mkdir|chmod|chown|truncate|copyFile|symlink|spawn|exec|execSync)(Sync)?\(/);
  }
  assert.deepEqual([...checks.matchAll(/\brun\("([^"]+)"/g)].map(([, command]) => command).sort(), ["gh", "git", "node", "npm"]);
  assert.match(checks, /run\("gh", \["api", "--method", "GET", path\], GH_ENV\)/);
  assert.match(checks, /run\("git", \["ls-remote", "--", url, \.\.\.names\], GIT_ENV\)/);
  assert.equal([...checks.matchAll(/\bexecFile\(/g)].length, 1);
});

test("the commands run in the modes that cannot prompt or leave state of their own behind", () => {
  const checks = readFileSync(join(SCRIPTS, "doctor-checks.mjs"), "utf8");

  assert.match(checks, /GIT_TERMINAL_PROMPT: "0"/);
  assert.match(checks, /GIT_ALLOW_PROTOCOL: "https:ssh"/);
  assert.match(checks, /-o BatchMode=yes .*-o StrictHostKeyChecking=yes/);
  assert.match(checks, /GH_NO_UPDATE_NOTIFIER: "1"/);
  assert.match(checks, /GH_TELEMETRY: "false"/);
  assert.match(checks, /run\("npm", \["--version"\], NPM_ENV\)/);
  assert.match(checks, /NPM_ENV = \{ NODE_DISABLE_COMPILE_CACHE: "1" \}/);
});

// Exit codes and output.

test("a warning alone exits 1", async (t) => {
  const { status, report } = await runDoctor(t, { tokenMode: 0o640 });

  assert.equal(status, 1);
  assert.equal(report.status, "warn");
});

test("a failure outranks a warning", async (t) => {
  const { status, report } = await runDoctor(t, { tokenMode: 0o640, remoteRefs: [[OTHER_SHA, "HEAD"]] });

  assert.equal(status, 2);
  assert.equal(report.status, "fail");
});

test("a skipped check alone leaves the exit code at 0", async (t) => {
  const { status, report } = await runDoctor(t, { without: ["gh"] });

  assert.equal(status, 0);
  assert.equal(report.status, "pass");
  assertStatuses(report, { 10: "skip" });
});

test("the text report shows every check, its advice and a tally", async (t) => {
  const { status, stdout } = await runDoctor(t, { args: [], token: `claude-mcp@pve!mcp=${SECRET}` });

  assert.equal(status, 1);
  for (const id of Array.from({ length: 10 }, (_, i) => i + 1)) {
    assert.match(stdout, new RegExp(`^ *${id}  (pass|warn|fail|skip)  `, "m"));
  }
  assert.match(stdout, /^ 6 {2}warn {2}Token rotation/m);
  assert.match(stdout, /^ +-> With the user's approval, run scripts\/bootstrap-token\.sh --rotate --keep-old/m);
  assert.match(stdout, /^ +ok 127\.0\.0\.1$/m);
  assert.match(stdout, /^9 pass, 1 warn, 0 fail, 0 skip\. Exit code 1\.$/m);
});

test("--help prints the usage and runs no check", async (t) => {
  const { status, stdout, server, commands } = await runDoctor(t, { args: ["--help"] });

  assert.equal(status, 0);
  assert.match(stdout, /^Usage: doctor\.sh \[--json\]/);
  assert.match(stdout, /0 healthy, 1 warnings, 2 failures/);
  assert.deepEqual(server.requests, []);
  assert.deepEqual(commands, []);
});

test("an unknown argument is refused with exit 2", async (t) => {
  const { status, stdout, stderr, server } = await runDoctor(t, { args: ["--fix"] });

  assert.equal(status, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /^Usage: doctor\.sh/);
  assert.deepEqual(server.requests, []);
});

// doctor.sh and its way into Node.

function copyPlugin(t, leaveOut = []) {
  const root = join(tempDir(t), "proxmox");
  for (const part of ["scripts", "server", "certs"]) cpSync(join(PLUGIN_ROOT, part), join(root, part), { recursive: true });
  for (const path of leaveOut) rmSync(join(root, path));
  return join(root, "scripts", "doctor.sh");
}

test("the doctor runs from a checkout with no node_modules, like the marketplace clone", async (t) => {
  const { status, report } = await runDoctor(t, { script: copyPlugin(t) });

  assert.equal(status, 0, JSON.stringify(report));
  assertStatuses(report);
});

test("a doctor that cannot even load exits 2, not the 1 of a warning", async (t) => {
  const { status, stdout, stderr } = await runDoctor(t, { script: copyPlugin(t, ["server/pve.mjs"]) });

  assert.equal(status, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /^doctor: /);
});

// Node exits 1 for a script it cannot load, and 1 means warnings here.
for (const [problem, breakIt] of [
  ["is missing", (script) => rmSync(script)],
  ["does not parse", (script) => writeFileSync(script, "this is not ( JavaScript\n")],
]) {
  test(`a doctor.mjs that ${problem} exits 2, not the 1 of a warning`, async (t) => {
    const script = copyPlugin(t);
    breakIt(join(dirname(script), "doctor.mjs"));

    const { status, stdout, stderr } = await runDoctor(t, { script });

    assert.equal(status, 2);
    assert.equal(stdout, "");
    assert.match(stderr, /^doctor: cannot load /);
  });
}

test("doctor.sh works through a link to it", async (t) => {
  const link = join(tempDir(t), "doctor");
  symlinkSync(DOCTOR, link);

  const { status, report } = await runDoctor(t, { script: link });

  assert.equal(status, 0, JSON.stringify(report));
  assertStatuses(report);
});

test("with no node on PATH, doctor.sh answers the first check itself", async (t) => {
  const { status, stdout } = await runDoctor(t, { args: [], without: ["node"] });

  assert.equal(status, 2);
  assert.match(stdout, /^ 1 {2}fail {2}Node and npm {2}node is not on PATH/);
  assert.match(stdout, /Install Node 26 or newer/);
});

test("with no node on PATH, --json is still JSON", async (t) => {
  const { status, report } = await runDoctor(t, { without: ["node"] });

  assert.equal(status, 2);
  assert.equal(report.status, "fail");
  assert.equal(report.exitCode, 2);
  assert.deepEqual(
    report.checks.map(({ id, name, status: checkStatus }) => [id, name, checkStatus]),
    [[1, "toolchain", "fail"]],
  );
});

test("a node below the plugin's minimum stops at doctor.sh", async (t) => {
  const { status, report, server } = await runDoctor(t, { nodeVersion: "v18.20.0" });

  assert.equal(status, 2);
  assert.match(check(report, 1).summary, /^node 18 is older than the plugin's minimum, Node 26\.$/);
  assert.deepEqual(server.requests, []);
});

test("something on PATH that is not node counts as no node", async (t) => {
  const { status, report } = await runDoctor(t, { nodeVersion: "oops" });

  assert.equal(status, 2);
  assert.match(check(report, 1).summary, /^node is not on PATH/);
});

test("doctor.sh's minimum is the one in package.json", () => {
  const [, major] = readFileSync(DOCTOR, "utf8").match(/^MIN_NODE_MAJOR=(\d+)/m);
  const { engines } = JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8"));

  assert.equal(engines.node, `>=${major}`);
});

test("doctor.sh is executable", () => {
  assert.notEqual(lstatSync(DOCTOR).mode & 0o111, 0);
});

test("the doctor looks where the server looks", () => {
  const { hosts, caFile } = connectionSettings({});

  assert.deepEqual(hosts, ["192.0.2.1", "192.0.2.1", "192.0.2.1"]);
  assert.equal(caFile, join(PLUGIN_ROOT, "certs", "pve-root-ca.pem"));
  assert.ok(existsSync(caFile));
  assert.deepEqual(connectionSettings({ PVE_HOSTS: "a,b", PVE_CA_FILE: "/ca" }), { hosts: ["a", "b"], caFile: "/ca" });
});

// 1: Node and npm

scenarios([
  {
    name: "a Node below 26 fails the first check, even past doctor.sh",
    // doctor.sh stops an older Node before doctor.mjs runs, so this runs doctor.mjs directly.
    script: process.execPath,
    args: [join(SCRIPTS, "doctor.mjs"), "--json"],
    nodeVersion: "v22.0.0",
    statuses: { 1: "fail" },
    exitCode: 2,
    expect: wantedAt(1, "summary", /^node v22\.0\.0, npm 11\.20\.0: older than Node 26\.$/),
  },
  {
    name: "Node 26 passes",
    nodeVersion: "v26.0.0",
    statuses: {},
    exitCode: 0,
  },
  {
    name: "a missing npm fails the first check",
    without: ["npm"],
    statuses: { 1: "fail" },
    exitCode: 2,
    expect: wantedAt(1, "summary", /^npm is not on PATH/),
  },
]);

// 2: Marketplace

scenarios([
  {
    name: "a machine without the marketplace fails, and has nothing to compare with",
    marketplace: null,
    statuses: { 2: "fail", 3: "skip" },
    exitCode: 2,
    expect: wantedAt(2, "action", /^claude plugin marketplace add sagaeforge\/sagae-claude-plugins$/),
  },
  {
    name: "a marketplace following another repository fails",
    marketplace: { source: { source: "github", repo: "someone/else" }, autoUpdate: true },
    statuses: { 2: "fail", 3: "skip" },
    exitCode: 2,
    expect: wantedAt(2, "action", /removes its plugin too/),
  },
  {
    name: "a repository with a similar name is another repository",
    marketplace: { source: { source: "git", url: `https://github.com/${REPO}-fork.git` }, autoUpdate: true },
    statuses: { 2: "fail", 3: "skip" },
    exitCode: 2,
  },
  {
    name: "the marketplace may be registered by its git URL",
    marketplace: { source: { source: "git", url: `https://github.com/${REPO}.git` }, autoUpdate: true },
    statuses: {},
    exitCode: 0,
  },
  {
    name: "auto-update off warns",
    marketplace: { source: { source: "github", repo: REPO }, autoUpdate: false },
    statuses: { 2: "warn" },
    exitCode: 1,
    expect: wantedAt(2, "action", /Enable auto-update/),
  },
  {
    name: "auto-update left unset is off, as for any third-party marketplace",
    marketplace: { source: { source: "github", repo: REPO } },
    statuses: { 2: "warn" },
    exitCode: 1,
    expect: wantedAt(2, "summary", /auto-update off\.$/),
  },
  {
    name: "settings.json decides auto-update over known_marketplaces.json when it says yes",
    marketplace: { source: { source: "github", repo: REPO }, autoUpdate: false },
    settings: { enabledPlugins: { "proxmox@sagae": true }, extraKnownMarketplaces: { sagae: { autoUpdate: true } } },
    statuses: {},
    exitCode: 0,
  },
  {
    name: "settings.json decides auto-update over known_marketplaces.json when it says no",
    marketplace: { source: { source: "github", repo: REPO }, autoUpdate: true },
    settings: { enabledPlugins: { "proxmox@sagae": true }, extraKnownMarketplaces: { sagae: { autoUpdate: false } } },
    statuses: { 2: "warn" },
    exitCode: 1,
  },
  ...[
    ["ssh", `git@github.com:${REPO}.git`],
    ["an ssh URL", `ssh://git@github.com/${REPO}.git`],
    ["a URL with no .git", `https://github.com/${REPO}`],
    ["a URL with credentials", `https://someone:hunter2@github.com/${REPO}.git`],
  ].map(([form, url]) => ({
    name: `the marketplace may be registered by ${form}`,
    marketplace: { source: { source: "git", url }, autoUpdate: true },
    statuses: {},
    exitCode: 0,
  })),
  ...[
    ["another host", `https://example.invalid/${REPO}.git`],
    ["another host over ssh", `git@example.invalid:${REPO}.git`],
    ["a path that ends the same way", `https://github.com/someone/${REPO}.git`],
  ].map(([where, url]) => ({
    name: `the same path on ${where} is another repository`,
    marketplace: { source: { source: "git", url }, autoUpdate: true },
    statuses: { 2: "fail", 3: "skip" },
    exitCode: 2,
  })),
]);

// stable on the remote is how a machine can tell that the gate is in use.

const followingStable = { source: { source: "github", repo: REPO, ref: "stable" }, autoUpdate: true };
const gateInUse = [
  [SHA, "HEAD"],
  [SHA, "refs/heads/main"],
  [SHA, "refs/heads/stable"],
];

scenarios([
  {
    name: "with stable on the remote, a machine on the default branch warns, and is told to move",
    remoteRefs: gateInUse,
    statuses: { 2: "warn" },
    exitCode: 1,
    expect: (report) => {
      assert.match(check(report, 2).summary, /ref default branch, .* so this machine skips the gate\.$/);
      assert.match(check(report, 2).action, /then claude plugin marketplace add sagaeforge\/sagae-claude-plugins#stable and /);
      assert.match(check(report, 2).action, /enable that again afterwards/);
    },
  },
  {
    name: "with stable on the remote, a machine on main warns too",
    marketplace: { source: { source: "github", repo: REPO, ref: "main" }, autoUpdate: true },
    remoteRefs: gateInUse,
    statuses: { 2: "warn" },
    exitCode: 1,
    expect: wantedAt(2, "summary", /ref main, .* skips the gate\.$/),
  },
  {
    name: "with stable on the remote, the gate outranks auto-update, which registering again turns off anyway",
    marketplace: { source: { source: "github", repo: REPO }, autoUpdate: false },
    remoteRefs: gateInUse,
    statuses: { 2: "warn" },
    exitCode: 1,
    expect: wantedAt(2, "action", /#stable/),
  },
  {
    name: "with stable on the remote, a machine following stable passes",
    marketplace: followingStable,
    remoteRefs: gateInUse,
    statuses: {},
    exitCode: 0,
  },
  {
    name: "with no stable on the remote, a machine on the default branch passes, as it must while the gate is off",
    statuses: {},
    exitCode: 0,
    expect: wantedAt(2, "summary", /ref default branch, auto-update on\.$/),
  },
  {
    name: "with stable on the remote, the registration hint names it",
    marketplace: null,
    remoteRefs: gateInUse,
    statuses: { 2: "fail", 3: "skip" },
    exitCode: 2,
    expect: wantedAt(2, "action", /^claude plugin marketplace add sagaeforge\/sagae-claude-plugins#stable$/),
  },
  {
    name: "with stable on the remote, the hint for a wrong repository names it too",
    marketplace: { source: { source: "github", repo: "someone/else" }, autoUpdate: true },
    remoteRefs: gateInUse,
    statuses: { 2: "fail", 3: "skip" },
    exitCode: 2,
    expect: wantedAt(2, "action", /marketplace add sagaeforge\/sagae-claude-plugins#stable and /),
  },
  {
    name: "with no stable on the remote, the hint for a wrong repository leaves it out",
    marketplace: { source: { source: "github", repo: "someone/else" }, autoUpdate: true },
    statuses: { 2: "fail", 3: "skip" },
    exitCode: 2,
    expect: wantedAt(2, "action", /marketplace add sagaeforge\/sagae-claude-plugins and /),
  },
  {
    name: "when stable cannot be looked up, the registration hint covers both ways",
    marketplace: null,
    env: { FAKE_GIT_DOWN: "1" },
    statuses: { 2: "fail", 3: "skip" },
    exitCode: 2,
    expect: wantedAt(2, "action", /^claude plugin marketplace add sagaeforge\/sagae-claude-plugins#stable \(without #stable if .*\)$/),
  },
  {
    name: "when the remote cannot be read, a machine is not told it skips the gate",
    env: { FAKE_GIT_DOWN: "1" },
    statuses: { 3: "warn" },
    exitCode: 1,
  },
]);

test("the doctor asks the remote about stable once, in the read it needs anyway", async (t) => {
  const { commands } = await runDoctor(t, { remoteRefs: gateInUse });
  assert.equal(commands.filter((command) => command.startsWith("git ")).length, 1);
});

test("a hint with #stable is copied from a repository that has it, by HTTPS when nothing is registered", async (t) => {
  const { commands } = await runDoctor(t, { marketplace: null, remoteRefs: gateInUse });
  assert.ok(commands.includes(`git ls-remote -- https://github.com/${REPO}.git HEAD refs/heads/stable`), commands.join("\n"));
});

test("the marketplace check reports the ref the machine follows", async (t) => {
  const { report } = await runDoctor(t, {
    marketplace: { source: { source: "github", repo: REPO, ref: "stable" }, autoUpdate: true },
    remoteRefs: [[SHA, "refs/heads/stable"]],
  });
  const { report: unpinned } = await runDoctor(t);

  assert.equal(check(report, 2).summary, `${REPO}, ref stable, auto-update on.`);
  assert.equal(check(unpinned, 2).summary, `${REPO}, ref default branch, auto-update on.`);
});

test("a broken file fails its check, leaves the rest running, and is not quoted", async (t) => {
  const { status, report, stdout } = await runDoctor(t, {
    prepare: ({ pluginsDir }) => writeFileSync(join(pluginsDir, "known_marketplaces.json"), '{"quoted-by-the-parser": oops'),
  });

  assert.equal(status, 2);
  assertStatuses(report, { 2: "fail", 3: "skip" });
  assert.match(check(report, 2).summary, /known_marketplaces\.json is not valid JSON\.$/);
  assert.doesNotMatch(stdout, /quoted-by-the-parser/);
});

test("a broken settings.json is not quoted either", async (t) => {
  const { status, report, stdout } = await runDoctor(t, {
    prepare: ({ configDir }) => writeFileSync(join(configDir, "settings.json"), '{"env": {"SOME_KEY": "quoted-by-the-parser"'),
  });

  assert.equal(status, 2);
  assertStatuses(report, { 2: "fail" });
  assert.doesNotMatch(stdout, /quoted-by-the-parser/);
});

test("Claude Code's directory overrides are followed", async (t) => {
  const moved = await runDoctor(t, { separateConfigDir: true });
  const pluginsMoved = await runDoctor(t, { separatePluginsDir: true });

  assertStatuses(moved.report);
  assertStatuses(pluginsMoved.report);
});

// 3: Installed commit

scenarios([
  {
    name: "a plugin that is not installed fails, and there are no dependencies to look at",
    install: null,
    statuses: { 3: "fail", 4: "skip" },
    exitCode: 2,
    expect: wantedAt(3, "action", /^claude plugin install proxmox@sagae$/),
  },
  {
    name: "an install with no recorded commit cannot be compared",
    install: { scope: "user" },
    statuses: { 3: "warn" },
    exitCode: 1,
  },
  {
    name: "an unreachable remote is a warning, because nothing is known about the install",
    env: { FAKE_GIT_DOWN: "1" },
    statuses: { 3: "warn" },
    exitCode: 1,
    expect: wantedAt(3, "summary", /the remote could not be read\.$/),
  },
  {
    name: "a remote branch ref is compared, not HEAD",
    marketplace: followingStable,
    remoteRefs: [
      [OTHER_SHA, "HEAD"],
      [OTHER_SHA, "refs/heads/main"],
      [SHA, "refs/heads/stable"],
    ],
    statuses: {},
    exitCode: 0,
  },
  {
    name: "a stale install on a ref fails against that ref",
    marketplace: followingStable,
    remoteRefs: [
      [SHA, "HEAD"],
      [OTHER_SHA, "refs/heads/stable"],
    ],
    statuses: { 3: "fail" },
    exitCode: 2,
    expect: wantedAt(3, "summary", /the remote's stable\.$/),
  },
  {
    name: "a branch wins over a tag of the same name, as in a clone",
    marketplace: followingStable,
    remoteRefs: [
      [SHA, "refs/heads/stable"],
      [OTHER_SHA, "refs/tags/stable"],
    ],
    statuses: {},
    exitCode: 0,
  },
  {
    name: "an annotated tag compares by the commit it points to",
    marketplace: followingStable,
    remoteRefs: [
      [TAG_OBJECT, "refs/tags/stable"],
      [SHA, "refs/tags/stable^{}"],
    ],
    statuses: {},
    exitCode: 0,
  },
  {
    name: "a lightweight tag compares directly",
    marketplace: followingStable,
    remoteRefs: [[SHA, "refs/tags/stable"]],
    statuses: {},
    exitCode: 0,
  },
  {
    name: "a ref the remote does not have warns",
    marketplace: followingStable,
    remoteRefs: [[SHA, "HEAD"]],
    statuses: { 3: "warn" },
    exitCode: 1,
    expect: wantedAt(3, "summary", /the remote has no ref stable\.$/),
  },
  {
    name: "a disabled plugin warns even when it is current",
    settings: { enabledPlugins: { "proxmox@sagae": false } },
    statuses: { 3: "warn" },
    exitCode: 1,
    expect: wantedAt(3, "action", /^claude plugin enable proxmox@sagae$/),
  },
  ...[
    ["a settings.json with no entry for it", {}],
    ["no settings.json at all", null],
  ].map(([what, settings]) => ({
    name: `${what} leaves the plugin unloaded, so it warns like a disabled one`,
    settings,
    statuses: { 3: "warn" },
    exitCode: 1,
    expect: wantedAt(3, "summary", /but the plugin is disabled\.$/),
  })),
  {
    name: "an entry that lists versions counts as enabled",
    settings: { enabledPlugins: { "proxmox@sagae": ["1.0.0"] } },
    statuses: {},
    exitCode: 0,
  },
  {
    name: "an install outside the user's scope keeps its entry elsewhere, so this file says nothing about it",
    install: { scope: "project", gitCommitSha: SHA },
    settings: {},
    statuses: {},
    exitCode: 0,
  },
  {
    name: "a user install is the one compared",
    install: [
      { scope: "project", gitCommitSha: OTHER_SHA },
      { scope: "user", gitCommitSha: SHA },
    ],
    statuses: {},
    exitCode: 0,
  },
  {
    name: "any install is compared when none is the user's",
    install: { scope: "project", gitCommitSha: OTHER_SHA },
    statuses: { 3: "fail" },
    exitCode: 2,
  },
]);

test("with no clone to read, the remote is reached by HTTPS", async (t) => {
  const { commands, report } = await runDoctor(t, { originUrl: null });

  assertStatuses(report);
  assert.ok(commands.includes(`git ls-remote -- https://github.com/${REPO}.git HEAD refs/heads/stable`), commands.join("\n"));
});

test("a ref is asked for by its full names, so a branch elsewhere cannot match", async (t) => {
  const { commands } = await runDoctor(t, { marketplace: followingStable, remoteRefs: [[SHA, "refs/heads/stable"]] });

  assert.ok(
    commands.includes(`git ls-remote -- git@github.com:${REPO}.git refs/heads/stable refs/tags/stable^{} refs/tags/stable`),
    commands.join("\n"),
  );
});

test("credentials in the remote URL never reach the output", async (t) => {
  const originUrl = `https://someone:hunter2@github.com/${REPO}.git`;
  const failing = await runDoctor(t, { originUrl, env: { FAKE_GIT_DOWN: "1" } });
  const working = await runDoctor(t, { originUrl });

  assert.ok(failing.commands.some((command) => command.includes("hunter2")), "the URL was used");
  for (const { stdout, stderr } of [failing, working]) assert.doesNotMatch(stdout + stderr, /hunter2/);
});

// 4: Dependencies

scenarios([
  {
    name: "an install without node_modules fails the dependencies check",
    installedDependencies: [],
    statuses: { 4: "fail" },
    exitCode: 2,
    expect: (report) => {
      assert.match(check(report, 4).summary, /@modelcontextprotocol\/sdk, zod\.$/);
      assert.match(check(report, 4).action, /^claude plugin uninstall proxmox@sagae && claude plugin install proxmox@sagae$/);
    },
  },
  {
    name: "a half-finished node_modules fails with what is missing",
    installedDependencies: ["zod"],
    statuses: { 4: "fail" },
    exitCode: 2,
    expect: wantedAt(4, "summary", /^Missing from node_modules: @modelcontextprotocol\/sdk\.$/),
  },
  {
    name: "an install whose directory is gone fails",
    installGone: true,
    statuses: { 4: "fail" },
    exitCode: 2,
  },
]);

// 5: Token file

const OWNER_ONLY = { 5: "fail", 6: "skip", 8: "skip", 9: "skip" };

for (const [name, token] of Object.entries({
  "an empty file": "",
  "a bare secret": SECRET,
  "no realm": `claude-mcp!id=${SECRET}`,
  "no token ID": `claude-mcp@pve=${SECRET}`,
  "an empty secret": `${TOKEN_ID}=`,
  "two lines": `${TOKEN}\n${TOKEN}`,
})) {
  test(`a token file holding ${name} fails, without being tried or quoted`, async (t) => {
    const { status, report, server } = await runDoctor(t, { token });

    assert.equal(status, 2);
    assertStatuses(report, OWNER_ONLY);
    assert.match(check(report, 5).summary, /token does not hold a token\.$/);
    assert.deepEqual(server.requests.map(({ url }) => url), ["/api2/json/access/domains"]);
  });
}

scenarios([
  {
    name: "a directory where the token should be fails",
    tokenPathIsDirectory: true,
    statuses: OWNER_ONLY,
    exitCode: 2,
  },
  {
    name: "a token others can read warns and says how to fix it",
    tokenMode: 0o644,
    statuses: { 5: "warn" },
    exitCode: 1,
    expect: (report) => {
      assert.match(check(report, 5).summary, /mode 644 lets others read the file\.$/);
      assert.match(check(report, 5).action, /^chmod 600 .*\/token$/);
    },
  },
  {
    name: "a token only the group can read warns too",
    tokenMode: 0o640,
    statuses: { 5: "warn" },
    exitCode: 1,
  },
  {
    name: "a stricter mode than 600 is no problem",
    tokenMode: 0o400,
    statuses: {},
    exitCode: 0,
  },
  {
    name: "a token in the environment is what the server would use, so the missing file is fine",
    token: null,
    acceptedToken: TOKEN,
    env: { PVE_API_TOKEN: TOKEN },
    statuses: {},
    exitCode: 0,
    expect: wantedAt(5, "summary", /from PVE_API_TOKEN instead of a file\.$/),
  },
  {
    name: "a broken token in the environment fails even with a good file",
    env: { PVE_API_TOKEN: "nonsense" },
    statuses: OWNER_ONLY,
    exitCode: 2,
    expect: wantedAt(5, "action", /PVE_API_TOKEN/),
  },
]);

test("PVE_TOKEN_FILE is followed, as the server follows it", async (t) => {
  const elsewhere = join(tempDir(t), "runner-token");
  writeFileSync(elsewhere, `${TOKEN}\n`, { mode: 0o600 });

  const { report } = await runDoctor(t, { token: null, env: { PVE_TOKEN_FILE: elsewhere } });

  assertStatuses(report);
});

// 6: Token rotation

scenarios([
  {
    name: "the shared token warns, and exits 1",
    token: `claude-mcp@pve!mcp=${SECRET}`,
    statuses: { 6: "warn" },
    exitCode: 1,
    expect: wantedAt(6, "action", /--rotate --keep-old/),
  },
  {
    name: "an old machine token warns that rotation is due",
    token: `claude-mcp@pve!m-test-202001=${SECRET}`,
    statuses: { 6: "warn" },
    exitCode: 1,
    expect: (report) => {
      assert.match(check(report, 6).summary, /^Rotation is due by 2020-12-31\.$/);
      assert.match(check(report, 6).action, /--rotate\. It says so/);
    },
  },
  {
    name: "a token ID with no month cannot be dated, which is not a fault",
    token: `claude-mcp@pve!chosen-by-hand=${SECRET}`,
    statuses: { 6: "skip" },
    exitCode: 0,
  },
]);

test("rotationDue counts from the first of the month in the ID", () => {
  assert.equal(rotationDue("m-sagae-windows-202610"), Date.UTC(2026, 9, 1) + 365 * DAY_MS);
  assert.equal(rotationDue("m-sagae-windows-202610-2"), Date.UTC(2026, 9, 1) + 365 * DAY_MS);
  assert.equal(rotationDue("ci-runner-202611"), Date.UTC(2026, 10, 1) + 180 * DAY_MS);
  assert.equal(rotationDue("m-host-202612"), Date.UTC(2026, 11, 1) + 365 * DAY_MS);
});

test("rotationDue finds no date in an ID that names no month", () => {
  for (const id of ["mcp", "chosen-by-hand", "m-host-202613", "m-host-202600", "m-host-20261", "202610"]) {
    assert.equal(rotationDue(id), undefined, id);
  }
});

// 7: Hosts

// Nothing listens on this loopback address, so it refuses the connection at once.
const DOWN = "127.0.0.2";
const html = (_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html>a proxy's login page</html>");
};

scenarios([
  {
    name: "one host down of two warns, because the server can fail over",
    env: { PVE_HOSTS: `${DOWN},${LOOPBACK}` },
    statuses: { 7: "warn" },
    exitCode: 1,
    expect: (report) => {
      const { summary, details, action } = check(report, 7);
      assert.equal(summary, "1 of 2 hosts answered over verified TLS.");
      assert.match(details[0], /^REFUSED 127\.0\.0\.2: connect ECONNREFUSED/);
      assert.equal(details[1], `ok ${LOOPBACK}`);
      assert.match(action, /port 8006/);
    },
  },
  {
    name: "every host down fails, and nothing is tried after that",
    env: { PVE_HOSTS: DOWN },
    statuses: { 7: "fail", 8: "skip", 9: "skip" },
    exitCode: 2,
    expect: wantedAt(8, "summary", /no host answered/),
  },
  {
    name: "an expired node certificate is told apart from a wrong CA",
    certificate: pinnedCa.issue(LOOPBACK, { expired: true }),
    statuses: { 7: "fail", 8: "skip", 9: "skip" },
    exitCode: 2,
    expect: (report) => assert.deepEqual(check(report, 7).details, [`TLS_VERIFY ${LOOPBACK}: CERT_HAS_EXPIRED`]),
  },
  {
    name: "a certificate for another address fails verification",
    certificate: pinnedCa.issue("192.0.2.1"),
    statuses: { 7: "fail", 8: "skip", 9: "skip" },
    exitCode: 2,
    expect: (report) => assert.deepEqual(check(report, 7).details, [`TLS_VERIFY ${LOOPBACK}: ERR_TLS_CERT_ALTNAME_INVALID`]),
  },
  {
    name: "a host that answers with something other than PVE does not count",
    pve: { "/access/domains": html },
    statuses: { 7: "fail", 8: "skip", 9: "skip" },
    exitCode: 2,
    expect: (report) => {
      assert.match(check(report, 7).details[0], /^BAD_RESPONSE /);
      assert.doesNotMatch(JSON.stringify(report), /login page/);
    },
  },
  {
    name: "a host answering 500 does not count as working",
    pve: { "/access/domains": refusal(500) },
    statuses: { 7: "fail", 8: "skip", 9: "skip" },
    exitCode: 2,
    expect: (report) => {
      assert.deepEqual(check(report, 7).details, [`HTTP 500 ${LOOPBACK}`]);
      assert.match(check(report, 7).action, /pveproxy and pvedaemon/);
    },
  },
  {
    name: "a refusal still proves the port and the certificate",
    pve: { "/access/domains": refusal(401) },
    statuses: {},
    exitCode: 0,
    expect: (report) => assert.deepEqual(check(report, 7).details, [`HTTP 401 ${LOOPBACK}`]),
  },
  {
    name: "a missing CA file fails the hosts and certificates checks and says which file",
    env: { PVE_CA_FILE: "/nonexistent/ca.pem" },
    statuses: { 7: "fail", 8: "skip", 9: "fail" },
    exitCode: 2,
    expect: (report) => {
      assert.match(check(report, 7).details[0], /^CA_FILE /);
      assert.match(check(report, 7).action, /^Restore certs\/pve-root-ca\.pem/);
      assert.match(check(report, 9).summary, /\/nonexistent\/ca\.pem/);
    },
  },
]);

test("each failure gets its own advice when hosts fail differently", async (t) => {
  const { report } = await runDoctor(t, {
    ca: otherCa,
    certificate: pinnedCa.issue(LOOPBACK),
    env: { PVE_HOSTS: `${LOOPBACK},${DOWN}` },
  });

  assert.match(check(report, 7).action, /pinned CA.*port 8006/);
});

test("the checks after the hosts use only the hosts that answered", async (t) => {
  const { dialed, report } = await runDoctor(t, { env: { PVE_HOSTS: `${DOWN},${LOOPBACK}` } });

  assert.equal(report.exitCode, 1);
  const toDownHost = dialed.filter(({ host }) => host === DOWN).map(({ path }) => path);
  assert.deepEqual(toDownHost, ["/api2/json/access/domains"]);
});

test("the probe never sends the token, even to a host that verified", async (t) => {
  const { server } = await runDoctor(t);
  const [probe] = server.requests.filter(({ url }) => url.endsWith("/access/domains"));

  assert.equal(probe.headers.authorization, "PVEAPIToken=");
});

// 8: Token permissions

scenarios([
  {
    name: "a rejected token fails the permissions check, and node certificates go unread",
    acceptedToken: "other@pve!id=other",
    statuses: { 8: "fail", 9: "skip" },
    exitCode: 2,
    expect: (report) => {
      assert.match(check(report, 8).summary, /PVE API 401\.$/);
      assert.match(check(report, 8).action, /--rotate/);
    },
  },
  {
    name: "a privilege held without propagation is still held",
    pve: { "/access/permissions": { "/": { "Sys.Audit": 1, "Sys.Modify": 0 } } },
    statuses: { 8: "fail" },
    exitCode: 2,
    expect: wantedAt(8, "summary", /Sys\.Modify/),
  },
  {
    name: "a token with no privileges at all fails",
    pve: { "/access/permissions": {} },
    statuses: { 8: "fail" },
    exitCode: 2,
    expect: wantedAt(8, "summary", /no privileges/),
  },
  {
    name: "permissions that cannot be read are not a pass",
    pve: { "/access/permissions": refusal(403) },
    statuses: { 8: "fail", 9: "skip" },
    exitCode: 2,
    expect: (report) => {
      assert.match(check(report, 8).summary, /PVE API 403\.$/);
      assert.equal(check(report, 8).action, undefined);
    },
  },
  {
    name: "an answer that is not a permission list is not a pass",
    pve: { "/access/permissions": null },
    statuses: { 8: "fail", 9: "skip" },
    exitCode: 2,
  },
  {
    name: "a /version failure is not a pass",
    pve: { "/version": refusal(500) },
    statuses: { 8: "fail", 9: "skip" },
    exitCode: 2,
  },
]);

test("a long list of excess privileges is cut short", async (t) => {
  const privileges = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`Sys.Write${String(i).padStart(2, "0")}`, 1]));
  const { report } = await runDoctor(t, { pve: { "/access/permissions": { "/": privileges } } });

  assert.match(check(report, 8).summary, /Sys\.Write07 and 4 more\.$/);
});

test("the permissions check reports the PVE version and the count", async (t) => {
  const { report } = await runDoctor(t);

  assert.equal(check(report, 8).summary, "PVE 9.2.2. The token holds 3 privileges, all .Audit.");
});

// 9: Certificates (G-13)

const onlyN2 = (certificates) => ({ "/nodes/n2/certificates/info": certificates });

scenarios([
  {
    name: "a node certificate within 30 days warns and names the node",
    pve: onlyN2(nodeCertificates(10)),
    statuses: { 9: "warn" },
    exitCode: 1,
    expect: (report) => {
      assert.equal(check(report, 9).summary, "Expiring within 30 days: n2.");
      assert.match(check(report, 9).action, /^Renew it before it expires/);
    },
  },
  {
    name: "an expired node certificate fails, even if TLS still works through another host",
    pve: onlyN2(nodeCertificates(-1)),
    statuses: { 9: "fail" },
    exitCode: 2,
    expect: wantedAt(9, "summary", /^Expired: n2\.$/),
  },
  {
    name: "a certificate with more than 30 days left is fine",
    pve: onlyN2(nodeCertificates(31)),
    statuses: {},
    exitCode: 0,
  },
  {
    name: "the soonest certificate on a node is the one that counts",
    pve: onlyN2([...nodeCertificates(), { filename: "pveproxy-ssl.pem", notafter: inDays(5) }]),
    statuses: { 9: "warn" },
    exitCode: 1,
  },
  {
    name: "an offline node is named, and not asked",
    pve: { "/cluster/status": clusterStatus(["n2"]), "/nodes/n2/certificates/info": refusal(500) },
    statuses: { 9: "warn" },
    exitCode: 1,
    expect: (report, { server }) => {
      assert.equal(check(report, 9).summary, "Could not read: n2.");
      assert.ok(check(report, 9).details.includes("n2: offline"));
      assert.ok(!server.requests.some(({ url }) => url.includes("/nodes/n2/")));
    },
  },
  {
    name: "a node whose certificates cannot be read warns with the reason",
    pve: onlyN2(refusal(403)),
    statuses: { 9: "warn" },
    exitCode: 1,
    expect: (report) => assert.ok(check(report, 9).details.includes("n2: PVE API 403")),
  },
  {
    name: "a node that lists no certificates warns",
    pve: onlyN2([]),
    statuses: { 9: "warn" },
    exitCode: 1,
    expect: (report) => assert.ok(check(report, 9).details.includes("n2: no certificates listed")),
  },
  {
    name: "a cluster status that cannot be read warns",
    pve: { "/cluster/status": refusal(500) },
    statuses: { 9: "warn" },
    exitCode: 1,
    expect: (report) => assert.ok(check(report, 9).details.includes("nodes: PVE API 500")),
  },
  {
    name: "an expiring certificate outranks one that cannot be read, and both get advice",
    pve: { ...onlyN2(refusal(403)), "/nodes/n3/certificates/info": nodeCertificates(5) },
    statuses: { 9: "warn" },
    exitCode: 1,
    expect: (report) => {
      assert.equal(check(report, 9).summary, "Expiring within 30 days: n3.");
      assert.match(check(report, 9).action, /Renew it.*Check those nodes/);
    },
  },
]);

test("a CA within 30 days warns, and is checked without any token", async (t) => {
  const ca = createCa("CA expiring soon", { validForMs: 10 * DAY_MS });
  const { status, report } = await runDoctor(t, { ca, token: null });

  assert.equal(status, 2); // For the missing token.
  assertStatuses(report, { 5: "fail", 6: "skip", 8: "skip", 9: "warn" });
  assert.equal(check(report, 9).summary, "Expiring within 30 days: CA.");
});

test("an expired CA fails both the hosts check and the certificates check", async (t) => {
  const { status, report } = await runDoctor(t, { ca: createCa("CA past its date", { expired: true }) });

  assert.equal(status, 2);
  assertStatuses(report, { 7: "fail", 8: "skip", 9: "fail" });
  assert.equal(check(report, 9).summary, "Expired: CA.");
});

test("the certificates check lists each date it read", async (t) => {
  const { report } = await runDoctor(t);
  const [ca, ...nodes] = check(report, 9).details;

  assert.match(check(report, 9).summary, /^Soonest expiry \d{4}-\d{2}-\d{2}\.$/);
  assert.match(ca, /^CA: until \d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(nodes.map((line) => line.split(":")[0]), ["n1", "n2", "n3"]);
});

test("the nodes are listed in the same order whatever order PVE gives them in", async (t) => {
  const { report } = await runDoctor(t, { pve: { "/cluster/status": clusterStatus().reverse() } });

  assert.deepEqual(check(report, 9).details.slice(1).map((line) => line.split(":")[0]), ["n1", "n2", "n3"]);
});

test("a CA file that holds no certificate fails the certificates check", async (t) => {
  const { report } = await runDoctor(t, { env: { PVE_CA_FILE: fromTest("./doctor.test.mjs") } });

  assert.equal(check(report, 9).status, "fail");
  assert.match(check(report, 9).action, /^Restore certs\/pve-root-ca\.pem/);
});

test("a machine that could not read node certificates does not claim to have", async (t) => {
  const { report } = await runDoctor(t, { token: null });

  assert.match(check(report, 9).summary, /^The CA has not expired\. Node certificates were not checked/);
});

test("expiryStatus turns at 30 days and at the moment of expiry", () => {
  const now = Date.UTC(2028, 5, 1);

  assert.equal(expiryStatus(now + 30 * DAY_MS, now), "pass");
  assert.equal(expiryStatus(now + 30 * DAY_MS - 1, now), "warn");
  assert.equal(expiryStatus(now + 1, now), "warn");
  assert.equal(expiryStatus(now, now), "fail");
  assert.equal(expiryStatus(now - 1, now), "fail");
});

// 10: GitHub

const OFFLINE_RUNNER = { name: "pve-runner-01", status: "offline" };

scenarios([
  {
    name: "gh not logged in is skipped, because it is optional",
    env: { FAKE_GH_DOWN: "1" },
    statuses: { 10: "skip" },
    exitCode: 0,
  },
  {
    name: "no runner registered is what a repository looks like before W7, so it passes",
    runners: [],
    statuses: {},
    exitCode: 0,
    expect: wantedAt(10, "summary", /^no runner registered; last CI on main: success\.$/),
  },
  {
    name: "an offline runner warns and points at the rebuild",
    runners: [OFFLINE_RUNNER],
    statuses: { 10: "warn" },
    exitCode: 1,
    expect: (report) => {
      assert.match(check(report, 10).summary, /^0 of 1 runners online/);
      assert.match(check(report, 10).action, /infra\/runner\/provision\.sh/);
    },
  },
  {
    name: "a failed CI on main warns",
    runs: [{ status: "completed", conclusion: "failure" }],
    statuses: { 10: "warn" },
    exitCode: 1,
    expect: wantedAt(10, "summary", /last CI on main: failure\.$/),
  },
  {
    name: "a cancelled CI is not a success",
    runs: [{ status: "completed", conclusion: "cancelled" }],
    statuses: { 10: "warn" },
    exitCode: 1,
  },
  {
    name: "a CI still running is not a problem",
    runs: [{ status: "in_progress", conclusion: null }],
    statuses: {},
    exitCode: 0,
    expect: wantedAt(10, "summary", /CI on main is in_progress\.$/),
  },
  {
    name: "a repository with no CI run yet is not a problem",
    runs: [],
    statuses: {},
    exitCode: 0,
    expect: wantedAt(10, "summary", /no CI run on main yet\.$/),
  },
  {
    name: "runners that cannot be read leave the CI result standing",
    runners: null,
    statuses: {},
    exitCode: 0,
    expect: wantedAt(10, "summary", /^last CI on main: success\.$/),
  },
  {
    name: "CI that cannot be read leaves the runners standing",
    runs: null,
    runners: [OFFLINE_RUNNER],
    statuses: { 10: "warn" },
    exitCode: 1,
  },
  {
    name: "neither being readable is skipped",
    runs: null,
    runners: null,
    statuses: { 10: "skip" },
    exitCode: 0,
  },
  {
    name: "both problems are reported together",
    runs: [{ status: "completed", conclusion: "failure" }],
    runners: [OFFLINE_RUNNER],
    statuses: { 10: "warn" },
    exitCode: 1,
    expect: wantedAt(10, "action", /provision\.sh.*gh run list/),
  },
]);

test("tokenIdOf gives the ID and never what follows the first =", () => {
  assert.equal(tokenIdOf(`${TOKEN}\n`), TOKEN_ID);
  assert.equal(tokenIdOf("claude-mcp@pve!mcp=a=b"), "claude-mcp@pve!mcp");
  assert.equal(tokenIdOf("  claude-mcp@pve!mcp=secret  "), "claude-mcp@pve!mcp");
  for (const text of ["", "secret", "=secret", "user@pve=secret", "user!id=secret", "user@pve!1id=secret", "user@pve!id=", "user@pve!id=a b"]) {
    assert.equal(tokenIdOf(text), undefined, text);
  }
});
