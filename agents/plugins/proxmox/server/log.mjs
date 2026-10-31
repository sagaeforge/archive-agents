// One JSON line on stderr per API call. stdout carries the MCP protocol, so it stays out of this.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, renameSync, statSync } from "node:fs";

const currentTool = new AsyncLocalStorage();

// Claude Code stops reading a server's stderr once it has connected, so in a session only this file
// keeps the log. .mcp.json points it at the plugin's data directory, which Claude Code creates.
const logFile = process.env.PVE_LOG_FILE;

// At about 130 bytes a line, this is some 40,000 calls. One older file stays next to the log, so the
// two never hold much more than twice this.
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// The caller of a tool chooses the path, so it is the one field here that can hold anything. PVE's
// paths have no "=" or UUID in them, and a whole token has both while its secret alone is a UUID.
const TOKEN_SHAPED = /=|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i;

// An 'error' event nobody listens to is fatal. A log reader going away must not stop the tools.
process.stderr.on("error", () => {});

export const runAsTool = (name, handler) => currentTool.run(name, handler);

function keep(line) {
  if (!logFile) return;
  try {
    // Sessions share this file. Two that rotate at once lose some of the older file, nothing more.
    if (statSync(logFile, { throwIfNoEntry: false })?.size >= MAX_LOG_BYTES) renameSync(logFile, `${logFile}.1`);
    appendFileSync(logFile, line, { mode: 0o600 });
  } catch {
    // The call this line describes is over, and its outcome must not change because of a log.
  }
}

// The fields are picked one by one, so what is not named here cannot reach the log.
export function logRequest({ host, path, ms, status, failover }) {
  const tool = currentTool.getStore() ?? null;
  const safePath = TOKEN_SHAPED.test(path) ? "<redacted>" : path;
  const line = `${JSON.stringify({ ts: new Date().toISOString(), tool, host, path: safePath, ms, status, failover })}\n`;
  process.stderr.write(line);
  keep(line);
}
