// S2 spike server. Throwaway. Hono + node-server + MCP SDK v2, socket-activation aware.
import { appendFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createAdaptorServer } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import * as z from 'zod';
const tBody = performance.now();   // ESM imports are hoisted, so this is the end of module loading

const env = process.env;
const IDLE_MS = Number(env.IDLE_MS ?? 0);          // 0 disables idle exit
const SHUTDOWN = env.SHUTDOWN ?? 'graceful';       // graceful | naive
const KEEPALIVE_MS = env.KEEPALIVE_MS ? Number(env.KEEPALIVE_MS) : undefined;
const LOG = env.S2_LOG;
const STATIC_ROOT = env.STATIC_ROOT ?? '../static';
const FAIL_AT_START = env.FAIL_AT_START === '1';
const bootId = randomUUID().slice(0, 8);
const log = (o) => { if (LOG) appendFileSync(LOG, JSON.stringify({ t: Date.now(), pid: process.pid, bootId, ...o }) + '\n'); };
if (FAIL_AT_START || (env.FAIL_FLAG && existsSync(env.FAIL_FLAG))) { log({ ev: 'fail-at-start' }); process.exit(1); }

// ---- blocking workloads -------------------------------------------------
function spin(ms) { const e = performance.now() + ms; while (performance.now() < e); }
const db = new DatabaseSync(':memory:');
const stmt = db.prepare('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<?) SELECT count(*) n FROM c');
let sqliteRowsPerMs = 0;
function sqliteBlock(ms) {
  if (!sqliteRowsPerMs) { const t = performance.now(); stmt.get(200000); sqliteRowsPerMs = 200000 / (performance.now() - t); }
  stmt.get(Math.round(ms * sqliteRowsPerMs));
}
let worker, seq = 0; const pending = new Map();
function viaWorker(ms) {
  worker ??= (() => { const w = new Worker(new URL('./worker.mjs', import.meta.url)); w.unref();
    w.on('message', ({ id }) => { pending.get(id)?.(); pending.delete(id); }); return w; })();
  return new Promise((res) => { const id = ++seq; pending.set(id, res); worker.ref(); worker.postMessage({ id, ms }); }).finally(() => { if (!pending.size) worker.unref(); });
}
async function block(ms, mode) {
  const t = performance.now();
  if (mode === 'spin') spin(ms); else if (mode === 'sqlite') sqliteBlock(ms); else if (mode === 'worker') await viaWorker(ms);
  return performance.now() - t;
}

// ---- MCP ----------------------------------------------------------------
let mcpCalls = 0;
function makeMcp() {
  const s = new McpServer({ name: 's2-control', version: '0.0.1' }, env.NO_LISTCHANGED === '1' ? { capabilities: { tools: { listChanged: false } } } : undefined);
  s.registerTool('ping', { description: 'Trivial probe. Returns the serving process id and boot id.', inputSchema: z.object({}) },
    async () => { mcpCalls++; log({ ev: 'tool', name: 'ping' });
      return { content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, bootId, mcpCalls, up_ms: Math.round(performance.now()) }) }] }; });
  s.registerTool('block', { description: 'Blocks for ms using spin, sqlite or worker.', inputSchema: z.object({ ms: z.number(), mode: z.string() }) },
    async ({ ms, mode }) => { const took = await block(ms, mode); return { content: [{ type: 'text', text: JSON.stringify({ took }) }] }; });
  return s;
}
const mcp = createMcpHandler(() => makeMcp(), { legacy: 'stateless', onerror: (e) => log({ ev: 'mcp-error', msg: String(e) }) });

// ---- app ----------------------------------------------------------------
const app = createMcpHonoApp({ host: '127.0.0.1' });
const loopDelay = monitorEventLoopDelay({ resolution: 5 }); loopDelay.enable();
let firstAt = 0;
app.use('*', async (c, next) => {
  if (LOG && c.req.path === '/mcp') {
    const b = c.get('parsedBody');
    log({ ev: 'req', m: c.req.method, p: c.req.path, rpc: Array.isArray(b) ? b.map((x) => x.method) : b?.method,
      h: { ua: c.req.header('user-agent'), accept: c.req.header('accept'), proto: c.req.header('mcp-protocol-version'),
           sess: c.req.header('mcp-session-id'), mcpMethod: c.req.header('mcp-method'), conn: c.req.header('connection') } });
  }
  await next();
  if (LOG && c.req.path === '/mcp') log({ ev: 'res', m: c.req.method, status: c.res.status, ct: c.res.headers.get('content-type') });
});
app.get('/healthz', (c) => { firstAt ||= performance.now();
  return c.json({ ok: true, pid: process.pid, bootId, up_ms: performance.now(), import_ms: tBody - performance.nodeTiming.bootstrapComplete, boot_ms: performance.nodeTiming.bootstrapComplete, listen_ms: tListening, first_ms: firstAt, active }); });
app.get('/stats', (c) => c.json({ pid: process.pid, active, rss: process.memoryUsage().rss, lag_p50: loopDelay.percentile(50) / 1e6, lag_p99: loopDelay.percentile(99) / 1e6, lag_max: loopDelay.max / 1e6 }));
app.get('/lagreset', (c) => { loopDelay.reset(); return c.text('ok'); });
app.get('/sse', (c) => { const every = Number(c.req.query('every') ?? 100); return streamSSE(c, async (s) => { let n = 0;
  while (!s.aborted) { await s.writeSSE({ data: JSON.stringify({ n: n++, t: Date.now() }) }); await s.sleep(every); } }); });
app.get('/block', async (c) => c.json({ took: await block(Number(c.req.query('ms') ?? 200), c.req.query('mode') ?? 'spin') }));
app.get('/static/*', serveStatic({ root: STATIC_ROOT, rewriteRequestPath: (p) => p.replace(/^\/static/, '') }));
app.all('/mcp', (c) => mcp.fetch(c.req.raw, { parsedBody: c.get('parsedBody') }));

// ---- server + socket activation ----------------------------------------
const server = createAdaptorServer({ fetch: app.fetch });
if (KEEPALIVE_MS !== undefined) server.keepAliveTimeout = KEEPALIVE_MS;
if (env.KA_BUFFER !== undefined) server.keepAliveTimeoutBuffer = Number(env.KA_BUFFER);
if (env.CONN_CLOSE === '1') server.prependListener('request', (req, res) => res.setHeader('connection', 'close'));
let active = 0, closing = false, idleTimer = null;
const arm = () => { if (IDLE_MS > 0 && !closing && active === 0) { clearTimeout(idleTimer); idleTimer = setTimeout(() => shutdown('idle'), IDLE_MS); } };
const disarm = () => clearTimeout(idleTimer);
server.on('connection', () => { arm(); });            // accepted but no request yet still resets the clock
const longStreams = new Set();
server.prependListener('request', (req, res) => {
  // In IGNORE_LISTEN mode a POST carrying mcp-method: subscriptions/listen does not count as activity.
  const ignored = env.IGNORE_LISTEN === '1' && req.headers['mcp-method'] === 'subscriptions/listen';
  if (ignored) { longStreams.add(res); res.once('close', () => { longStreams.delete(res); log({ ev: 'listen-stream-closed' }); }); log({ ev: 'listen-stream-open' }); arm(); return; }
  active++; disarm();
  res.once('close', () => { active--; arm(); }); });
function shutdown(reason) {
  if (closing) return; closing = true;
  log({ ev: 'shutdown', reason, active });
  if (SHUTDOWN === 'naive') process.exit(0);
  server.close(() => { log({ ev: 'closed' }); process.exit(0); });
  server.closeIdleConnections();
  if (env.IGNORE_LISTEN === '1') for (const r of longStreams) r.destroy();
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('sigterm'));
process.on('SIGINT', () => shutdown('sigint'));

function activatedFd() {
  const n = Number(env.LISTEN_FDS ?? 0), pid = Number(env.LISTEN_PID ?? 0);
  if (n < 1) return null;
  if (pid && pid !== process.pid) { log({ ev: 'listen-pid-mismatch', pid }); return null; }
  return 3;
}
let tListening = 0;
const fd = activatedFd();
const target = fd !== null ? { fd } : { port: Number(env.PORT ?? 18200), host: '127.0.0.1' };
log({ ev: 'boot', target, listenFds: env.LISTEN_FDS ?? null, listenPid: env.LISTEN_PID ?? null, fdNames: env.LISTEN_FDNAMES ?? null });
delete env.LISTEN_FDS; delete env.LISTEN_PID; delete env.LISTEN_FDNAMES;
server.listen(target, () => { tListening = performance.now(); log({ ev: 'listening', up_ms: tListening, addr: server.address() }); arm(); });
server.on('error', (e) => { log({ ev: 'server-error', msg: String(e) }); process.exit(2); });
