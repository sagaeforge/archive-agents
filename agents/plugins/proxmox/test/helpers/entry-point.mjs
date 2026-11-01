// Runs the real server entry point against a test's fake PVE. Its home is throwaway, so the fake
// token in there is the only one it can find, and PVE_HOSTS keeps the real cluster out of reach.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LOOPBACK, tempDir } from "./fake-pve.mjs";

export const ENTRY_POINT = fileURLToPath(new URL("../../server/index.mjs", import.meta.url));
const DIAL_FAKE_PVE = new URL("./dial-fake-pve.mjs", import.meta.url).href;

// What to spawn. `requestLog` is the file dial-fake-pve.mjs records requests in.
export function entryPointProcess(t, { token, port, env = {}, entryPoint = ENTRY_POINT }) {
  const home = tempDir(t);
  const tokenDir = join(home, ".config", "proxmox-mcp");
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(join(tokenDir, "token"), `${token}\n`);
  const requestLog = join(home, "https-requests");
  writeFileSync(requestLog, "");

  return {
    requestLog,
    command: process.execPath,
    args: ["--import", DIAL_FAKE_PVE, entryPoint],
    env: { HOME: home, USERPROFILE: home, PVE_HOSTS: LOOPBACK, FAKE_PVE_PORT: port, FAKE_PVE_LOG: requestLog, ...env },
  };
}

export async function startEntryPoint(t, options) {
  const { requestLog, ...spawned } = entryPointProcess(t, options);
  const transport = new StdioClientTransport({ ...spawned, stderr: "pipe" });
  const stderr = [];
  transport.stderr.on("data", (chunk) => stderr.push(chunk));

  const client = new Client({ name: "entry-point-test", version: "0.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  return {
    client,
    home: spawned.env.HOME,
    stderr: () => Buffer.concat(stderr).toString("utf8"),
    httpsRequests: () =>
      readFileSync(requestLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}
