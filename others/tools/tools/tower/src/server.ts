// tower: load config, listen, then start upstreams. Reloads on save and drains on SIGTERM.
import { setTimeout as sleep } from 'node:timers/promises';
import { createAdaptorServer } from '@hono/node-server';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { bearerAuth } from 'hono/bearer-auth';
import { mountAdmin } from './admin.js';
import { lastGood, loadConfig, readToken, saveLastGood, watchConfig } from './config.js';
import { attempt, event, faults } from './log.js';
import { handler, sorted, syncUpstreams } from './merge.js';
import { mountRoutes } from './routes.js';
import { VERSION } from './upstream.js';

let config = lastGood();
const rejected = () => faults.get('config_rejected');
let bearer: ReturnType<typeof bearerAuth> | null = null;

// Boot and every later save take this path, so a typo at either time leaves the last good config running.
function reload() {
  const token = attempt('token_unreadable', readToken);
  bearer = token ? bearerAuth({ token }) : null;
  const next = attempt('config_rejected', () => loadConfig());
  if (next) {
    config = next;
    event('config_applied', undefined, { hash: config.hash });
    attempt('last_good', () => saveLastGood(next.source)); // A disk problem, not a rejection: the new config is live either way.
  }
  syncUpstreams(config.upstreams);
}

const app = createMcpHonoApp({ host: '127.0.0.1' }); // Host and Origin checks on every path, routes included.
// Hono's default prints the error on stderr, past redact. HTTPException is how bearerAuth answers 401, so it stays as it is.
app.onError((err, c) => ('getResponse' in err ? err.getResponse() : (event('http_error', undefined, err.message), c.text('internal error', 500))));
app.use('*', async (c, next) => {
  const [site = '', mode, dest = 'document'] = ['site', 'mode', 'dest'].map((name) => c.req.header(`sec-fetch-${name}`));
  const link = mode === 'navigate' && dest === 'document'; // Only a page load: an iframe, embed or object navigates too, with no click.
  return ['cross-site', 'same-site'].includes(site) && !link ? c.text('forbidden', 403) : next();
});
for (const path of ['/mcp/*', '/admin/*']) app.use(path, async (c, next) => {
  if (!bearer) return c.text('no token configured', 503);
  if (!/^Bearer [\w.~+/-]+=*$/i.test(c.req.header('authorization') ?? '')) return c.text('unauthorized', 401);
  return bearer(c, next);
});
const tally = () => ({ ready: sorted().filter((u) => u.state === 'ready').length, total: sorted().length });
app.get('/healthz', (c) => c.json({ status: 'ok', version: VERSION, uptimeS: Math.round(process.uptime()), config: rejected() ? 'rejected' : 'ok', upstreams: tally() }));
app.all('/mcp', (c) => handler.fetch(c.req.raw, { parsedBody: (c as { get(key: string): unknown }).get('parsedBody') }));
mountAdmin(app, () => ({ config: rejected() ? 'rejected' : 'ok', configError: rejected(), configHash: config.hash, routes: config.routes }));
mountRoutes(app, () => config.routes);

const http = createAdaptorServer({ fetch: app.fetch }) as import('node:http').Server;
const activated = process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid;
for (const name of ['LISTEN_FDS', 'LISTEN_PID', 'LISTEN_FDNAMES']) delete process.env[name];
http.listen(activated ? { fd: 3 } : { port: Number(process.env.TOWER_PORT ?? 4800), host: '127.0.0.1' }, reload);
watchConfig(reload);

// Requests first, upstreams after: a call in flight finishes on a live upstream.
async function shutdown() {
  setTimeout(() => process.exit(0), 6_000);
  await Promise.race([new Promise((resolve) => http.close(resolve)), sleep(1_500)]); // close() ends idle connections too.
  await handler.close();
  http.closeAllConnections();
  await Promise.allSettled(sorted().map((u) => u.close()));
  process.exit(0);
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void shutdown());
