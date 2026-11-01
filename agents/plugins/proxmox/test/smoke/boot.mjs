// Starts the server the way a new machine gets it: a fresh copy with production dependencies only,
// launched the way tower starts it (node server/index.mjs), with no token to find and no cluster to reach. It
// needs the registry for that install, so it stays out of npm test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PLUGIN_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TOOLS = ["api_get", "cluster_overview", "guest_config", "list_resources", "node_status", "recent_tasks"];
const INSTALL_TIMEOUT_MS = 180_000;
const SERVER_TIMEOUT_MS = 20_000;
const NO_CLUSTER = "192.0.2.1"; // TEST-NET-1. Nothing in here should dial out, and this cannot.

function installedCopy(root) {
  const plugin = join(root, "plugin");
  cpSync(PLUGIN_ROOT, plugin, { recursive: true, filter: (source) => basename(source) !== "node_modules" });
  const { status } = spawnSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: plugin,
    stdio: "inherit",
    timeout: INSTALL_TIMEOUT_MS,
  });
  assert.equal(status, 0, "production install failed");
  return plugin;
}

const root = mkdtempSync(join(tmpdir(), "proxmox-boot-"));
let serverLog = "";
let client;
try {
  const plugin = installedCopy(root);
  const home = join(root, "home");
  mkdirSync(home);

  const transport = new StdioClientTransport({
    // The way tower starts its proxmox upstream: node, with the path of the server.
    command: process.execPath,
    args: [join(plugin, "server", "index.mjs")],
    cwd: home, // The server must not depend on where it is started from.
    env: { HOME: home, USERPROFILE: home, PVE_HOSTS: NO_CLUSTER },
    stderr: "pipe",
  });
  transport.stderr.on("data", (chunk) => (serverLog += chunk));

  client = new Client({ name: "boot-smoke", version: "0.0.0" });
  await client.connect(transport, { timeout: SERVER_TIMEOUT_MS });
  const { tools } = await client.listTools(undefined, { timeout: SERVER_TIMEOUT_MS });

  assert.deepEqual(tools.map(({ name }) => name).sort(), TOOLS);
  console.log(`boot smoke: ${tools.length} tools from a production install`);
} catch (err) {
  // Throwing would end this process at once, and the SDK is still stopping a server that hung.
  if (serverLog) console.error(`server stderr:\n${serverLog}`);
  console.error(err);
  process.exitCode = 1;
} finally {
  await client?.close();
  rmSync(root, { recursive: true, force: true });
}
