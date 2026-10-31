// The doctor's ten checks. They only look: nothing here writes a file, runs a command that changes
// anything, or reaches PVE except by GET through the server's own client. Only Node's built-ins and
// pve.mjs are imported, because the marketplace clone this can run from has no node_modules.
//
// Each check returns a status, a summary and sometimes details and an action. Those end up on screen,
// so they are built from fixed text and values picked one by one, and never from a whole file, a
// response body or a command's stderr. Certificate subjects stay out too: they carry the cluster UUID,
// which looks like a token value.
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PveApiError, connectionSettings, createClient, httpsTransport, loadToken, tokenFile } from "../server/pve.mjs";

const MARKETPLACE = "sagae";
const PLUGIN = `proxmox@${MARKETPLACE}`;
const REPO = "sagaeforge/sagae-claude-plugins";

const NODE_MAJOR = 22;
const SHARED_TOKEN_ID = "mcp";
const MACHINE_TOKEN_DAYS = 365;
const RUNNER_TOKEN_DAYS = 180;
const EXPIRY_WARNING_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 20000;

const INSTALL_NODE = `Install Node ${NODE_MAJOR} or newer with npm, on the PATH Claude Code starts with: the server runs as plain "node".`;
const REGISTER = `claude plugin marketplace add ${REPO}`;
const REREGISTER = `claude plugin marketplace remove ${MARKETPLACE}, then ${REGISTER} and claude plugin install ${PLUGIN}. Removing a marketplace removes its plugin too.`;
const UPDATE = `claude plugin marketplace update ${MARKETPLACE} && claude plugin update ${PLUGIN}, then /reload-plugins in a session.`;
const REINSTALL = `claude plugin uninstall ${PLUGIN} && claude plugin install ${PLUGIN}`;
const BOOTSTRAP = "With the user's approval, run scripts/bootstrap-token.sh";
const ROTATE = `${BOOTSTRAP} --rotate. It says so if the token file also needs --keep-old.`;
const RENEW = "Renew it before it expires. A new CA also has to replace certs/pve-root-ca.pem in the repository.";
const HOST_ADVICE = {
  TLS_VERIFY: "Compare the pinned CA (certs/pve-root-ca.pem or PVE_CA_FILE) with the cluster CA, and check the node certificates for expiry. Never turn verification off.",
  CA_FILE: "Restore certs/pve-root-ca.pem or correct PVE_CA_FILE.",
  NETWORK: "Check that this machine can reach the hosts on port 8006, and PVE_HOSTS.",
  SERVER_ERROR: "The port and certificate are fine, so look at pveproxy and pvedaemon on that node.",
};

// The updater's own ssh settings, so a failure here means updates fail too. They also rule out the
// two ways a read could touch this machine: a prompt, and a new line in known_hosts.
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ALLOW_PROTOCOL: "https:ssh",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes",
};
// Without this, gh writes down when it last looked for a new version of itself.
const GH_ENV = { GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1" };

const result = (status) => (summary, rest) => ({ status, summary, ...rest });
const pass = result("pass");
const warn = result("warn");
const fail = result("fail");
const skip = result("skip");

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const shortSha = (sha) => sha.slice(0, 12);
const listOf = (items, shown = 8) =>
  items.length > shown ? `${items.slice(0, shown).join(", ")} and ${items.length - shown} more` : items.join(", ");

// stderr is dropped on purpose: git's can repeat a URL with credentials in it.
function run(command, args, env) {
  return new Promise((resolve) => {
    execFile(command, args, { env: { ...process.env, ...env }, timeout: COMMAND_TIMEOUT_MS }, (err, stdout) =>
      resolve({ ok: !err, missing: err?.code === "ENOENT", stdout }),
    );
  });
}

// Undefined when the file is not there. A broken file is named without its content, because a JSON
// parser's message quotes what it choked on and settings.json can hold secrets.
function readJson(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
}

// What a failed PVE call came to, with nothing in it that PVE or anything else sent back.
function describeFailure(err) {
  if (err instanceof PveApiError) return `PVE API ${err.status}`;
  return err.code ?? err.message;
}

// pass, warn within EXPIRY_WARNING_DAYS of `notAfter`, or fail once it has gone by.
export function expiryStatus(notAfter, now) {
  if (notAfter <= now) return "fail";
  return notAfter - now < EXPIRY_WARNING_DAYS * DAY_MS ? "warn" : "pass";
}

// The ID in a token, or undefined if the text is not shaped like one. Anything that does not fit is
// never echoed: it could be the secret on its own. The first "=" ends the ID, so no group holds what
// follows it.
export const tokenIdOf = (text) => text.trim().match(/^([\w.-]+@[\w.-]+![A-Za-z][\w.-]+)=\S+$/)?.[1];

// The role cannot read a token's real expiry (PVE answers 403), so it is worked out from the month in
// the token's ID. Counting from the first of that month gives the earliest date it can fall on.
// Undefined for an ID that names no month.
export function rotationDue(id) {
  const [, year, month] = id.match(/-(\d{4})(\d{2})(?:-\d+)?$/) ?? [];
  if (!year || month < 1 || month > 12) return undefined;
  const days = id.startsWith("ci-runner-") ? RUNNER_TOKEN_DAYS : MACHINE_TOKEN_DAYS;
  return Date.UTC(Number(year), Number(month) - 1, 1) + days * DAY_MS;
}

async function checkToolchain() {
  const [node, npm] = await Promise.all([run("node", ["--version"]), run("npm", ["--version"])]);
  if (!node.ok || !npm.ok) {
    return fail(`${node.ok ? "npm" : "node"} is not on PATH, or does not run.`, { action: INSTALL_NODE });
  }
  const versions = `node ${node.stdout.trim()}, npm ${npm.stdout.trim()}`;
  const major = Number(node.stdout.match(/\d+/)?.[0]);
  if (major >= NODE_MAJOR) return pass(`${versions}.`);
  return warn(`${versions}: older than Node ${NODE_MAJOR}.`, { action: INSTALL_NODE });
}

function checkMarketplace(state) {
  const entry = readJson(join(state.pluginsDir, "known_marketplaces.json"))?.[MARKETPLACE];
  if (!entry) return fail(`Marketplace "${MARKETPLACE}" is not registered.`, { action: REGISTER });

  const { repo, url = "", ref } = entry.source ?? {};
  if (repo !== REPO && !new RegExp(`[/:]${REPO}(\\.git)?/?$`).test(url)) {
    return fail(`Marketplace "${MARKETPLACE}" does not follow ${REPO}.`, { action: REREGISTER });
  }
  state.marketplace = entry;
  state.settings = readJson(join(state.configDir, "settings.json"));

  // In Claude Code's own order: a value declared in settings wins, and a third-party marketplace is off by default.
  const declared = state.settings?.extraKnownMarketplaces?.[MARKETPLACE]?.autoUpdate;
  const autoUpdate = declared ?? entry.autoUpdate ?? false;

  const summary = `${REPO}, ref ${ref ?? "default branch"}, auto-update ${autoUpdate ? "on" : "off"}.`;
  if (autoUpdate) return pass(summary);
  return warn(summary, { action: `In a session: /plugin > Marketplaces > ${MARKETPLACE} > Enable auto-update.` });
}

// How this machine reaches the remote, read as a plain file: git is not run inside the clone.
function cloneOrigin(cloneDir) {
  try {
    return readFileSync(join(cloneDir, ".git", "config"), "utf8").match(/\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/)?.[1];
  } catch {
    return undefined;
  }
}

// The commit the remote has for the marketplace's ref, null if it has no such ref, or undefined if the
// remote could not be read. The URL stays in here because it can carry credentials.
async function remoteCommit({ source, installLocation }) {
  const url = cloneOrigin(installLocation) ?? source.url ?? `https://github.com/${source.repo}.git`;
  const names = source.ref ? [`refs/heads/${source.ref}`, `refs/tags/${source.ref}^{}`, `refs/tags/${source.ref}`] : ["HEAD"];
  const { ok, stdout } = await run("git", ["ls-remote", "--", url, ...names], GIT_ENV);
  if (!ok) return undefined;
  const refs = new Map(stdout.split("\n").map((line) => line.split("\t").reverse()));
  return names.map((name) => refs.get(name)).find(Boolean) ?? null;
}

async function checkInstalledCommit(state) {
  const installs = readJson(join(state.pluginsDir, "installed_plugins.json"))?.plugins?.[PLUGIN] ?? [];
  const install = installs.find(({ scope }) => scope === "user") ?? installs[0];
  if (!install) return fail(`${PLUGIN} is not installed.`, { action: `claude plugin install ${PLUGIN}` });
  state.install = install;

  if (!state.marketplace) return skip("Not compared: no marketplace to compare with.");
  const installed = install.gitCommitSha;
  if (!installed) return warn("The install records no commit, so it cannot be compared.", { action: REINSTALL });

  const ref = state.marketplace.source.ref ?? "HEAD";
  const remote = await remoteCommit(state.marketplace);
  if (remote === undefined) {
    return warn(`Installed ${shortSha(installed)}, but the remote could not be read.`, {
      action: "Check the network and this machine's GitHub access. Background updates fail silently, so it may be falling behind.",
    });
  }
  if (remote === null) {
    return warn(`Installed ${shortSha(installed)}, but the remote has no ref ${ref}.`, { action: REREGISTER });
  }
  if (remote !== installed) {
    return fail(`Installed ${shortSha(installed)} is not ${shortSha(remote)}, the remote's ${ref}.`, { action: UPDATE });
  }
  const current = `Installed ${shortSha(installed)} is the remote's ${ref}`;
  if (state.settings?.enabledPlugins?.[PLUGIN] !== false) return pass(`${current}.`);
  return warn(`${current}, but the plugin is disabled.`, { action: `claude plugin enable ${PLUGIN}` });
}

function checkDependencies({ install }) {
  if (!install) return skip("Not checked: nothing is installed.");
  const manifest = readJson(join(install.installPath, "package.json"));
  if (!manifest) return fail(`The install at ${install.installPath} is gone or incomplete.`, { action: REINSTALL });

  const names = Object.keys(manifest.dependencies ?? {});
  const missing = names.filter((name) => !existsSync(join(install.installPath, "node_modules", name, "package.json")));
  if (missing.length > 0) return fail(`Missing from node_modules: ${listOf(missing)}.`, { action: REINSTALL });
  return pass(`node_modules has all ${names.length} dependencies.`);
}

function checkTokenFile(state) {
  const { PVE_API_TOKEN: fromEnv } = process.env;
  if (fromEnv) {
    // The server prefers this to the file, so the file says nothing about what it would send.
    state.tokenId = tokenIdOf(fromEnv);
    if (!state.tokenId) return fail("PVE_API_TOKEN is set, but does not hold a token.", { action: "Correct or unset PVE_API_TOKEN." });
    return pass(`${state.tokenId}, from PVE_API_TOKEN instead of a file.`);
  }

  const file = tokenFile();
  let stats;
  let text;
  try {
    stats = statSync(file);
    text = readFileSync(file, "utf8");
  } catch {
    return fail(`No readable token file at ${file}.`, { action: `${BOOTSTRAP}.` });
  }
  state.tokenId = tokenIdOf(text);
  if (!state.tokenId) {
    return fail(`${file} does not hold a token.`, { action: `${BOOTSTRAP} --rotate --keep-old.` });
  }
  const mode = (stats.mode & 0o777).toString(8);
  if (stats.mode & 0o077) {
    return warn(`${state.tokenId}, but mode ${mode} lets others read the file.`, { action: `chmod 600 ${file}` });
  }
  return pass(`${state.tokenId}, mode ${mode}.`);
}

function checkTokenAge({ tokenId, now }) {
  if (!tokenId) return skip("Not checked: no usable token.");
  const id = tokenId.slice(tokenId.indexOf("!") + 1);
  if (id === SHARED_TOKEN_ID) {
    return warn(`"${SHARED_TOKEN_ID}" is the token every machine shares, so replacing it anywhere locks the others out.`, {
      action: `${BOOTSTRAP} --rotate --keep-old on each machine, as the README describes.`,
    });
  }
  const due = rotationDue(id);
  if (due === undefined) return skip(`Not calculated: ${id} names no issue month.`);
  if (expiryStatus(due, now) === "pass") return pass(`Rotate by ${day(due)}.`);
  return warn(`Rotation is due by ${day(due)}.`, { action: ROTATE });
}

// /access/domains is the one read PVE serves without credentials, since the login page needs it. So a
// host can prove its port and certificate without being sent the token, and this works on a machine
// that does not have one yet. A rejected call is still an answer over verified TLS, but a 5xx is
// not a working host: the server's client would stop at it instead of moving on to the next.
async function probeHost(host, transport) {
  const client = createClient({ hosts: [host], getToken: () => "", transport });
  try {
    await client.get("/access/domains");
    return { host, line: `ok ${host}` };
  } catch (err) {
    if (err instanceof PveApiError) {
      const line = `HTTP ${err.status} ${host}`;
      return err.status >= 500 ? { host, line, problem: "SERVER_ERROR" } : { host, line };
    }
    const [failure] = err.failures ?? [];
    return { host, line: `${describeFailure(err)} ${failure?.detail ?? host}`, problem: err.code in HOST_ADVICE ? err.code : "NETWORK" };
  }
}

async function checkHosts(state) {
  const { hosts, transport } = state;
  const answers = await Promise.all(hosts.map((host) => probeHost(host, transport)));
  const working = answers.filter(({ problem }) => !problem).map(({ host }) => host);
  const details = answers.map(({ line }) => line);

  if (working.length > 0) state.client = createClient({ hosts: working, getToken: loadToken, transport });
  const summary = `${working.length} of ${hosts.length} hosts answered over verified TLS.`;
  if (working.length === hosts.length) return pass(summary, { details });

  const action = [...new Set(answers.map(({ problem }) => HOST_ADVICE[problem]).filter(Boolean))].join(" ");
  return (working.length > 0 ? warn : fail)(summary, { details, action });
}

async function checkPermissions(state) {
  if (!state.tokenId) return skip("Not checked: no usable token.");
  if (!state.client) return skip("Not checked: no host answered.");

  let version;
  let held;
  try {
    ({ version } = await state.client.get("/version"));
    // A privilege is held whatever its value: 0 only means that it does not propagate.
    const paths = await state.client.get("/access/permissions");
    held = [...new Set(Object.values(paths).flatMap((privileges) => Object.keys(privileges)))].sort();
  } catch (err) {
    return fail(`The token could not be tested: ${describeFailure(err)}.`, err.status === 401 ? { action: ROTATE } : {});
  }
  state.apiWorks = true;

  const excess = held.filter((privilege) => !privilege.endsWith(".Audit"));
  if (excess.length > 0) {
    return fail(`The token can do more than read: ${listOf(excess)}.`, {
      action: "Stop using this token now: delete it on a node, then issue a PVEAuditor token with scripts/bootstrap-token.sh.",
    });
  }
  if (held.length === 0) return fail("The token holds no privileges, so every tool will come back empty.", { action: ROTATE });
  return pass(`PVE ${version}. The token holds ${held.length} privileges, all .Audit.`);
}

// One row per node, with its soonest expiry, or the reason that could not be read.
async function nodeCertificates(client) {
  const members = await client.get("/cluster/status");
  // PVE does not keep these in any one order, and a report should read the same from run to run.
  const nodes = members.filter(({ type }) => type === "node").sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(
    nodes.map(async ({ name, online }) => {
      if (!online) return { name, problem: "offline" };
      try {
        const certificates = await client.get(`/nodes/${name}/certificates/info`);
        const expiry = Math.min(...certificates.map(({ notafter }) => notafter * 1000));
        return Number.isFinite(expiry) ? { name, expiry } : { name, problem: "no certificates listed" };
      } catch (err) {
        return { name, problem: describeFailure(err) };
      }
    }),
  );
}

async function checkCertificates(state) {
  let caExpiry;
  try {
    caExpiry = Date.parse(new X509Certificate(readFileSync(state.caFile)).validTo);
  } catch {
    return fail(`No readable certificate at ${state.caFile}.`, { action: HOST_ADVICE.CA_FILE });
  }

  let rows = [{ name: "CA", expiry: caExpiry }];
  if (state.apiWorks) {
    try {
      rows = [...rows, ...(await nodeCertificates(state.client))];
    } catch (err) {
      rows = [...rows, { name: "nodes", problem: describeFailure(err) }];
    }
  }
  const details = rows.map(({ name, expiry, problem }) => `${name}: ${problem ?? `until ${day(expiry)}`}`);

  const unread = rows.filter(({ problem }) => problem).map(({ name }) => name);
  const dated = rows.filter(({ problem }) => !problem);
  const inState = (status) => dated.filter(({ expiry }) => expiryStatus(expiry, state.now) === status).map(({ name }) => name);
  const expired = inState("fail");
  const expiring = inState("warn");

  const actions = [];
  if (expired.length + expiring.length > 0) actions.push(RENEW);
  if (unread.length > 0) actions.push("Check those nodes and run the doctor again.");
  const rest = { details, ...(actions.length > 0 && { action: actions.join(" ") }) };

  if (expired.length > 0) return fail(`Expired: ${expired.join(", ")}.`, rest);
  if (expiring.length > 0) return warn(`Expiring within ${EXPIRY_WARNING_DAYS} days: ${expiring.join(", ")}.`, rest);
  if (unread.length > 0) return warn(`Could not read: ${unread.join(", ")}.`, rest);
  if (!state.apiWorks) return skip("The CA has not expired. Node certificates were not checked: no working token and host.", rest);
  return pass(`Soonest expiry ${day(Math.min(...dated.map(({ expiry }) => expiry)))}.`, rest);
}

async function readGitHub(path) {
  const { ok, missing, stdout } = await run("gh", ["api", "--method", "GET", path], GH_ENV);
  if (!ok) return { missing };
  try {
    return { data: JSON.parse(stdout) };
  } catch {
    return {};
  }
}

async function checkGitHub() {
  const [runners, runs] = await Promise.all([
    readGitHub(`repos/${REPO}/actions/runners`),
    readGitHub(`repos/${REPO}/actions/workflows/ci.yml/runs?branch=main&per_page=1`),
  ]);
  if (runners.missing) return skip("Not checked: gh is not installed.");
  if (!runners.data && !runs.data) return skip("Not checked: gh could not read the repository. Is it logged in?");

  const facts = [];
  const actions = [];

  if (runners.data) {
    const all = runners.data.runners ?? [];
    const offline = all.filter(({ status }) => status !== "online");
    // None at all is what a repository looks like before its runner is set up, so it is not a fault.
    facts.push(all.length === 0 ? "no runner registered" : `${all.length - offline.length} of ${all.length} runners online`);
    if (offline.length > 0) actions.push("Rebuild the runner with infra/runner/provision.sh.");
  }

  if (runs.data) {
    const [last] = runs.data.workflow_runs ?? [];
    if (!last) {
      facts.push("no CI run on main yet");
    } else if (last.status !== "completed") {
      facts.push(`CI on main is ${last.status}`);
    } else {
      facts.push(`last CI on main: ${last.conclusion}`);
      if (last.conclusion !== "success") actions.push(`Look at it with: gh run list -R ${REPO} --branch main`);
    }
  }

  const summary = `${facts.join("; ")}.`;
  return actions.length > 0 ? warn(summary, { action: actions.join(" ") }) : pass(summary);
}

const CHECKS = [
  ["toolchain", "Node and npm", checkToolchain],
  ["marketplace", "Marketplace", checkMarketplace],
  ["installed-commit", "Installed commit", checkInstalledCommit],
  ["dependencies", "Dependencies", checkDependencies],
  ["token-file", "Token file", checkTokenFile],
  ["token-age", "Token rotation", checkTokenAge],
  ["hosts", "Hosts", checkHosts],
  ["permissions", "Token permissions", checkPermissions],
  ["certificates", "Certificates", checkCertificates],
  ["github", "GitHub", checkGitHub],
];

export async function runDoctor() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const { hosts, caFile } = connectionSettings();
  const state = {
    now: Date.now(),
    configDir,
    pluginsDir: process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR || join(configDir, "plugins"),
    hosts,
    caFile,
    transport: httpsTransport({ caFile }),
  };

  const checks = [];
  for (const [index, [name, title, check]] of CHECKS.entries()) {
    let outcome;
    try {
      outcome = await check(state);
    } catch (err) {
      outcome = fail(`The check could not finish: ${err.message}`);
    }
    checks.push({ id: index + 1, name, title, ...outcome });
  }

  const has = (status) => checks.some((check) => check.status === status);
  const exitCode = has("fail") ? 2 : has("warn") ? 1 : 0;
  return { status: ["pass", "warn", "fail"][exitCode], exitCode, checks };
}
