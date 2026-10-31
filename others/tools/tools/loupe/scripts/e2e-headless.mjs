// Phase 0 confirmation: an empty app reads kb-mock over a Unix socket through loupe serve, in headless Chromium.
// Starts and stops everything itself. Ports: loupe serve 4830. Sockets: $LOUPE_SOCKET_DIR (default .cache/sock).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const viteBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root, '.cache/ms-playwright');
const { chromium } = await import('playwright');

const sockDir = process.env.LOUPE_SOCKET_DIR ?? path.join(root, '.cache/sock');
const logDir = process.env.LOUPE_LOG_DIR ?? path.join(root, '.cache/logs');
mkdirSync(sockDir, { recursive: true }); mkdirSync(logDir, { recursive: true });
const sock = path.join(sockDir, 'e.s'); // short: a socket path has a 108-byte limit
const access = path.join(logDir, 'e2e-access.log');
const PORT = Number(process.env.LOUPE_E2E_PORT ?? 4830);
const base = `http://127.0.0.1:${PORT}`;
rmSync(access, { force: true });

const children = [];
const start = (args, env, name) => {
  const c = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = []; c.stdout.on('data', (d) => chunks.push(d)); c.stderr.on('data', (d) => chunks.push(d));
  c.logs = () => Buffer.concat(chunks).toString();
  c.name = name; children.push(c); return c;
};
const waitFor = async (f, ms = 8000, what = 'condition') => { const t0 = Date.now(); for (;;) { try { if (await f()) return; } catch { /* retry */ } if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`); await new Promise((r) => setTimeout(r, 100)); } };
// A closed loopback port can hang instead of refusing on this host, so every probe has a short timeout.
const tcpOpen = (port) => new Promise((res) => { const s = net.connect(port, '127.0.0.1'); const t = setTimeout(() => { s.destroy(); res(false); }, 400); s.on('connect', () => { clearTimeout(t); s.destroy(); res(true); }); s.on('error', () => { clearTimeout(t); res(false); }); });
const results = [];
const check = (name, ok, info) => { results.push({ name, ok: !!ok, ...(info !== undefined ? { info } : {}) }); if (!ok) process.exitCode = 1; };

let browser;
try {
  if (process.env.LOUPE_E2E_BUILD !== '0') {
    await new Promise((res, rej) => spawn(process.execPath, [viteBin, 'build'], { cwd: root, stdio: 'ignore' }).on('exit', (c) => (c === 0 ? res() : rej(new Error('vite build failed')))));
  }
  check('dist built', existsSync(path.join(root, 'dist/index.html')));
  check('port is free', !(await tcpOpen(PORT)), PORT);

  // kb-mock listens on the Unix socket only: there is no TCP route to it.
  const mock = start(['dev/kb-mock/main.ts'], { KB_MOCK_SOCKET: sock, KB_ACCESS_LOG: access }, 'kb-mock');
  await waitFor(() => existsSync(sock), 8000, 'kb-mock socket');
  const serve = start(['bin/loupe.mjs', 'serve'], { KB_URL: `unix:${sock}`, LOUPE_PORT: String(PORT) }, 'loupe serve');
  await waitFor(() => tcpOpen(PORT), 8000, 'loupe serve');
  check('kb-mock has no TCP listener', !(await tcpOpen(4811)) || process.env.KB_MOCK_PORT === '4811');

  // WSL has no libnss3 or libasound: scripts/setup-browser-libs.sh unpacks them without root.
  const libs = path.join(root, '.cache/libs-x/usr/lib/x86_64-linux-gnu');
  const env = existsSync(libs) ? { ...process.env, LD_LIBRARY_PATH: [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } : process.env;
  browser = await chromium.launch({ headless: true, env });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const requests = [], consoleErrors = [], cspViolations = [], dialogs = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => { (window.__csp ??= []).push(e.violatedDirective); }));

  await page.goto(`${base}/#/status`);
  await page.waitForSelector('[data-testid=kb-status]');
  await page.waitForFunction(() => document.querySelector('[data-testid=kb-status]')?.textContent?.includes('연결됨'), null, { timeout: 8000 });
  const text = (id) => page.locator(`[data-testid=${id}]`).innerText();
  const meta = { version: await text('kb-schema-version'), verdict: await text('kb-version-verdict'), seq: await text('kb-applied-seq'), asOf: await text('kb-data-as-of'), epoch: await text('kb-epoch') };
  check('empty app shows the KB envelope read over the socket', meta.version === '0.2.0-sample' && meta.seq === '183422' && meta.epoch === '1', meta);
  check('schema_version verdict against the generated client is ok', meta.verdict === 'ok');
  check('sample badge is shown for sample data', await page.locator('[data-testid=sample-badge]').isVisible());
  check('the app made exactly one same-origin KB request path', requests.filter((u) => u.includes('/kb/')).every((u) => u.startsWith(`${base}/kb/v1/`)), requests.filter((u) => u.includes('/kb/')));
  check('every request is same origin', requests.every((u) => u.startsWith(base) || u.startsWith('data:')), requests.filter((u) => !u.startsWith(base)));
  check('no CSP violation event', ((await page.evaluate(() => window.__csp ?? [])).length) === 0);
  check('no console errors', consoleErrors.length === 0, consoleErrors);
  const log = existsSync(access) ? readFileSync(access, 'utf8') : '';
  check('kb-mock saw GET /v1/meta on the socket (no /kb prefix: loupe serve stripped it)', /^GET \/v1\/meta 200$/m.test(log), log.trim().split('\n').slice(0, 3));

  // Headers on the document itself
  const doc = await ctx.request.get(`${base}/`);
  check('index.html carries frame-ancestors and nosniff', /frame-ancestors 'none'/.test(doc.headers()['content-security-policy'] ?? '') && doc.headers()['x-content-type-options'] === 'nosniff');
  const meta404 = await ctx.request.get(`${base}/kb/v1/ops/metrics`);
  check('/kb/v1/ops/* is blocked', meta404.status() === 404);
  const rawHtml = await ctx.request.get(`${base}/kb/v1/snapshots/n-html000000000001/raw`);
  check('captured HTML is served with sandbox CSP, nosniff and attachment', /sandbox/.test(rawHtml.headers()['content-security-policy'] ?? '') && rawHtml.headers()['x-content-type-options'] === 'nosniff' && rawHtml.headers()['content-disposition'] === 'attachment');
  // Navigating to the captured page must not run its script (design 9)
  const nav = await ctx.newPage();
  nav.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  await nav.goto(`${base}/kb/v1/snapshots/n-html000000000001/raw`).catch(() => undefined);
  await nav.waitForTimeout(300);
  check('navigating to captured HTML does not run its script', (await nav.title()) !== 'pwned' && dialogs.length === 0, await nav.title().catch(() => null));
  await nav.close();

  // Hash routes
  const probe = async (hash) => { await page.goto(`${base}/#${hash}`); await page.waitForTimeout(250); return page; };
  await probe('/node/e%3Afeature%3Aclaude-code-hooks');
  await page.waitForSelector('[data-testid=node-id]');
  check('a valid id route renders the decoded id', (await page.locator('[data-testid=node-id]').innerText()) === 'e:feature:claude-code-hooks');
  const before = requests.length;
  for (const bad of ['/node/ent_a%3Fas_of_valid%3D2020-01-01T00%3A00%3A00Z%23', '/node/..%2F..%2F..%2Fadmin%2Fstatus', '/node/n-1%2F..%2F..%2Fnodes%2Fe%3Afeature%3Ab', '/node/..']) {
    await probe(bad);
    check(`hostile deep link ${bad} shows an error, no id`, (await page.locator('[data-testid=route-error]').count()) === 1);
  }
  check('hostile deep links caused no KB request other than /v1/meta polling', requests.slice(before).filter((u) => u.includes('/kb/')).every((u) => u.includes('/v1/meta')), requests.slice(before).filter((u) => u.includes('/kb/')));
  await probe('/?as_of_valid=yesterday');
  check('a bad time parameter is an error, not silently now', (await page.locator('[data-testid=route-error]').count()) === 1);
  await probe('/?as_of_observed=2026-01-01T00:00:00Z');
  check('a valid past time shows the time band and survives a reload', (await page.locator('[data-testid=time-band]').count()) === 1 && (await (async () => { await page.reload(); await page.waitForTimeout(250); return page.locator('[data-testid=time-band]').count(); })()) === 1);

  // KB goes away: the proxy answers 502 kb_socket_missing and the app says so
  mock.kill('SIGTERM');
  await waitFor(() => !existsSync(sock), 5000, 'socket removal');
  await page.goto(`${base}/#/status`); await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-testid=kb-status]')?.textContent?.includes('사용 불가'), null, { timeout: 12000 });
  check('with the KB down the app says unavailable, with the proxy code', (await text('kb-status')).includes('kb_socket_missing'), await text('kb-status'));
  check('no alert dialogs at any point', dialogs.length === 0, dialogs);
} catch (e) {
  check('script completed', false, String(e?.stack ?? e).split('\n').slice(0, 4).join(' | '));
} finally {
  await browser?.close().catch(() => undefined);
  for (const c of children) { c.kill('SIGTERM'); }
  await new Promise((r) => setTimeout(r, 400));
  rmSync(sock, { force: true });
}
console.log(JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, failures: results.filter((r) => !r.ok) }, null, 1));
console.log(results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`).join('\n'));
process.exit(process.exitCode ?? 0);
