// One JSON line on stderr per API call. stdout carries the MCP protocol, so it stays out of this.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, renameSync, statSync } from "node:fs";

const currentTool = new AsyncLocalStorage();

// Off unless set. tower's proxmox upstream env sets it to keep a file next to stderr; the directory
// must already exist.
const logFile = process.env.PVE_LOG_FILE;

// At about 130 bytes a line, this is some 40,000 calls. One older file stays next to the log, so the
// two never hold much more than twice this. That takes a limit on a line as well, and the path is the
// one field of any length.
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_PATH_LENGTH = 1024;

// The caller of a tool chooses the path, so it is the one field here that can hold anything. PVE's
// paths have no "=" or UUID in them, and a whole token has both while its secret alone is a UUID.
const TOKEN_SHAPED = /=|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i;

// An encoded token is still that token, however many times it was encoded. A round that changes the
// text shortens it, so this ends. Escapes that do not decode cannot be judged, so they count.
function holdsToken(path) {
  try {
    for (let text = path, previous; text !== previous; previous = text, text = decodeURIComponent(text)) {
      if (TOKEN_SHAPED.test(text)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

// An 'error' event nobody listens to is fatal. A log reader going away must not stop the tools.
process.stderr.on("error", () => {});

export const runAsTool = (name, handler) => currentTool.run(name, handler);

// Sessions share this file, so another can get here first, and this line still belongs in the new
// file. If two rename at once, the second can put a nearly empty file over the older one. That costs
// history and never a call. Any other failure stops here, so the log cannot grow past its limit.
function moveAside() {
  try {
    renameSync(logFile, `${logFile}.1`);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

function keep(line) {
  if (!logFile) return;
  try {
    const stat = statSync(logFile, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) return; // Opening a FIFO nobody reads would block the whole server.
    if (stat?.size >= MAX_LOG_BYTES) moveAside();
    appendFileSync(logFile, line, { mode: 0o600 });
  } catch {
    // The call this line describes is over, and its outcome must not change because of a log.
  }
}

// The fields are picked one by one, so what is not named here cannot reach the log.
export function logRequest({ host, path, ms, status, failover }) {
  const tool = currentTool.getStore() ?? null;
  const safePath = path.length > MAX_PATH_LENGTH || holdsToken(path) ? "<redacted>" : path;
  const line = `${JSON.stringify({ ts: new Date().toISOString(), tool, host, path: safePath, ms, status, failover })}\n`;
  process.stderr.write(line);
  keep(line);
}
