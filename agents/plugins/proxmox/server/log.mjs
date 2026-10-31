// One JSON line on stderr per API call. stdout carries the MCP protocol, so it stays out of this.
import { AsyncLocalStorage } from "node:async_hooks";

const currentTool = new AsyncLocalStorage();

// An 'error' event nobody listens to is fatal. A log reader going away must not stop the tools.
process.stderr.on("error", () => {});

export const runAsTool = (name, handler) => currentTool.run(name, handler);

// The fields are picked one by one, so what is not named here cannot reach the log.
export function logRequest({ host, path, ms, status, failover }) {
  const tool = currentTool.getStore() ?? null;
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), tool, host, path, ms, status, failover })}\n`);
}
