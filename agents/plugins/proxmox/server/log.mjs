// One JSON line on stderr per API call. stdout carries the MCP protocol, so it stays out of this.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";

const currentTool = new AsyncLocalStorage();

// Claude Code stops reading a server's stderr once it has connected, so in a session only this file
// keeps the log. Whether and where to keep one is each machine's choice, so by default nothing does.
const logFile = process.env.PVE_LOG_FILE;

// An 'error' event nobody listens to is fatal. A log reader going away must not stop the tools.
process.stderr.on("error", () => {});

export const runAsTool = (name, handler) => currentTool.run(name, handler);

function keep(line) {
  try {
    if (logFile) appendFileSync(logFile, line, { mode: 0o600 });
  } catch {
    // The call this line describes is over, and its outcome must not change because of a log.
  }
}

// The fields are picked one by one, so what is not named here cannot reach the log.
export function logRequest({ host, path, ms, status, failover }) {
  const tool = currentTool.getStore() ?? null;
  const line = `${JSON.stringify({ ts: new Date().toISOString(), tool, host, path, ms, status, failover })}\n`;
  process.stderr.write(line);
  keep(line);
}
