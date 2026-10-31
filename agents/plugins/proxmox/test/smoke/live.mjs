// Calls all six tools on the real cluster, through the server started the way .mcp.json starts it.
// CI runs this on the runner LXC. It needs a token and the cluster, so it stays out of npm test.
//
// GitHub keeps Actions logs, so nothing from a response reaches the output. Every line is made of
// counts, names written in this file, and error codes. See docs/live-smoke.md.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { httpsTransport, loadToken } from "../../server/pve.mjs";
import { registerTools } from "../../server/tools.mjs";

const PLUGIN_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HOSTS = (process.env.PVE_HOSTS || "192.0.2.1,192.0.2.1,192.0.2.1").split(",");
const CA_FILE = process.env.PVE_CA_FILE || join(PLUGIN_ROOT, "certs", "pve-root-ca.pem");
const NODES = ["pve-node", "pve-node", "pve-node"];
const TASK_LIMIT = 5;
const EXPIRY_WARNING_DAYS = 30;
const DAY_MS = 86_400_000;

// How a connection ends when nothing is there. A failed certificate check is not on this list: a host
// answered, and the cause can be the CA in this very commit, so it must not read as an outage.
const NO_ANSWER = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"]);

const NO_HOST_ANSWERED = "FAIL INFRA: no host answered";

const lines = [];

function say(line) {
  console.log(line);
  lines.push(line);
}

// Its message gets printed, so it only ever holds text from this file.
class CheckFailed extends Error {}

function expect(condition, message) {
  if (!condition) throw new CheckFailed(message);
}

// The opening of a tool error names its kind. The rest stays out of the log: it can hold PVE's own
// words, and a JSON parse error quotes the response it choked on.
const errorKind = (text) =>
  /^(?:PVE API \d{3}|[A-Z_]{2,}(?=:)|All PVE hosts unreachable)/.exec(text)?.[0] ?? "tool error";

const describe = (err) => (err instanceof CheckFailed ? err.message : `unexpected ${err.name} ${err.code ?? ""}`.trim());

// PVE's own filter never matches SDN entries (G-9), so a server that leaves the job to it always finds
// none. W4 filters them in the server. Asking the code under test which one it is turns the check on
// with that merge, without anyone having to remember. This can go once W4 is on main.
async function serverFiltersSdn() {
  const tools = {};
  const server = { registerTool: (name, _config, handler) => (tools[name] = handler) };
  registerTools(server, { get: async (_path, params) => (params?.type ? [] : [{ type: "network" }]) });
  const { content } = await tools.list_resources({ type: "sdn" });
  return JSON.parse(content[0].text).length > 0;
}

// Each one takes the tool caller and returns the facts to print.
const CHECKS = {
  async cluster_overview(call) {
    const { status, ha } = await call("cluster_overview");
    const cluster = status.find(({ type }) => type === "cluster");
    const names = status.filter(({ type }) => type === "node").map(({ name }) => name);
    expect(cluster?.nodes === NODES.length, `the cluster does not report ${NODES.length} nodes`);
    expect(
      NODES.every((node) => names.includes(node)),
      "a node is missing from the cluster",
    );
    expect(Array.isArray(ha), "no HA status");
    return `nodes=${names.length} quorate=${Number(cluster.quorate)}`;
  },

  async list_resources(call) {
    const resources = await call("list_resources");
    const nodes = resources.filter(({ type }) => type === "node").length;
    expect(nodes >= NODES.length, `only ${nodes} nodes listed`);

    const sdn = await call("list_resources", { type: "sdn" });
    if (!(await serverFiltersSdn())) return `nodes=${nodes} sdn=unchecked, needs W4`;
    expect(sdn.length >= 1, "no SDN entries listed");
    return `nodes=${nodes} sdn=${sdn.length}`;
  },

  async node_status(call) {
    for (const node of NODES) {
      const { pveversion } = await call("node_status", { node });
      expect(pveversion, `${node} reports no pveversion`);
    }
    return `nodes=${NODES.length}`;
  },

  async guest_config(call) {
    const [guest] = await call("list_resources", { type: "vm" });
    expect(guest, "no guest to read");
    const config = await call("guest_config", { node: guest.node, vmid: guest.vmid, kind: guest.type });
    expect("digest" in config, "the config has no digest");
    return `keys=${Object.keys(config).length}`;
  },

  async recent_tasks(call) {
    const tasks = await call("recent_tasks", { limit: TASK_LIMIT });
    expect(Array.isArray(tasks) && tasks.length <= TASK_LIMIT, `no list of at most ${TASK_LIMIT} tasks`);
    return `tasks=${tasks.length}`;
  },

  async api_get(call) {
    const { version } = await call("api_get", { path: "/version" });
    expect(version, "/version reports no version");

    const paths = await call("api_get", { path: "/access/permissions" });
    const held = new Set(Object.values(paths).flatMap((privileges) => Object.keys(privileges)));
    const excess = [...held].filter((privilege) => !privilege.endsWith(".Audit")).length;
    expect(held.size > 0, "the token holds no privileges");
    expect(excess === 0, `the token holds ${excess} privileges beyond .Audit`);
    return `privileges=${held.size}`;
  },

  // Only the weekly run fails with weeks left. A green run alerts nobody, but a certificate that is
  // still good is no reason to stop a deployment.
  async certificates(call) {
    const limit = process.env.GITHUB_EVENT_NAME === "schedule" ? EXPIRY_WARNING_DAYS : 0;
    const expiries = [];
    for (const node of NODES) {
      const certificates = await call("api_get", { path: `/nodes/${node}/certificates/info` });
      expect(certificates.length > 0, `${node} lists no certificates`);
      expiries.push(...certificates.map(({ notafter }) => notafter));
    }
    const days = Math.floor((Math.min(...expiries) * 1000 - Date.now()) / DAY_MS);
    expect(days >= limit, `a certificate expires in ${days} days`);
    return `soonest expiry in ${days} days`;
  },
};

async function runChecks() {
  const { command, args } = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".mcp.json"), "utf8")).mcpServers.proxmox;
  const client = new Client({ name: "live-smoke", version: "0.0.0" });
  let failed = 0;

  async function call(name, toolArgs = {}) {
    const { isError, content } = await client.callTool({ name, arguments: toolArgs });
    const [{ text }] = content;
    if (isError) throw new CheckFailed(errorKind(text));
    return JSON.parse(text);
  }

  try {
    await client.connect(
      new StdioClientTransport({
        command,
        args: args.map((arg) => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT)),
        env: process.env,
        stderr: "ignore", // Whatever the server writes there is not this script's to vouch for.
      }),
    );
    for (const [name, check] of Object.entries(CHECKS)) {
      const started = Date.now();
      try {
        const facts = await check(call);
        say(`PASS ${name} ${Date.now() - started} ms ${facts}`);
      } catch (err) {
        say(`FAIL ${name} ${Date.now() - started} ms: ${describe(err)}`);
        failed++;
      }
    }
  } catch (err) {
    say(`FAIL server: ${describe(err)}`);
    failed++;
  } finally {
    await client.close();
  }
  return failed;
}

// One direct GET per host, past the server. The verdict then rests on what the hosts did and not on
// how the server words a failure, and it costs one timeout, not one for every call of every check.
async function probeHosts(token) {
  const transport = httpsTransport({ caFile: CA_FILE });
  return Promise.all(
    HOSTS.map(async (host) => {
      const started = Date.now();
      try {
        await transport(host, "/version", token);
        return { host, answered: true, result: `answered in ${Date.now() - started} ms` };
      } catch (err) {
        const code = err.code ?? (err.message.startsWith("timeout") ? "ETIMEDOUT" : err.name);
        return { host, answered: !NO_ANSWER.has(code), result: code };
      }
    }),
  );
}

const anyAnswered = (probes) => probes.some(({ answered }) => answered);

async function smoke() {
  let token;
  try {
    token = loadToken();
  } catch {
    return "FAIL INFRA: no API token on this machine";
  }

  const probes = await probeHosts(token);
  for (const { host, result } of probes) say(`host ${host}: ${result}`);
  if (!anyAnswered(probes)) return NO_HOST_ANSWERED;

  const failed = await runChecks();
  if (failed === 0) return "PASS";
  // The cluster can go away after the first probe, and then the checks are not what failed.
  return anyAnswered(await probeHosts(token)) ? `FAIL PLUGIN: ${failed} failed` : NO_HOST_ANSWERED;
}

const verdict = await smoke().catch((err) => `FAIL PLUGIN: ${describe(err)}`);
say(`live smoke: ${verdict}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const report = `### Live smoke: ${verdict}\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
}
process.exitCode = verdict === "PASS" ? 0 : 1;
