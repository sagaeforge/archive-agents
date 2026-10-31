import { createServer } from 'node:http';
const [nm, undiciPath, root] = process.argv.slice(2);
const { Agent } = await import(undiciPath);
const { proxy } = await import(`${nm}/hono/dist/helper/proxy/index.js`);
const { createAdaptorServer } = await import(`${nm}/@hono/node-server/dist/index.mjs`);
const { serveStatic } = await import(`${nm}/@hono/node-server/dist/serve-static.mjs`);
const { createMcpHonoApp } = await import(`${nm}/@modelcontextprotocol/hono/dist/index.mjs`);
const ORIGIN = 18978, GW = 18979, DEAD = 18977;
let aborted = 0;
const origin = createServer((req, res) => {
  if (req.url.startsWith('/echo')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ url: req.url, auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null, host: req.headers.host, added: req.headers['x-added'] ?? null })); }
  if (req.url.startsWith('/slowhead')) { return setTimeout(() => res.end('late'), 2500); }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  let n = 0; const iv = setInterval(() => { res.write(`data: ${n++}\n\n`); if (n > 5) { clearInterval(iv); res.end(); } }, 300);
  req.on('close', () => { if (n <= 5) { aborted++; clearInterval(iv); } });
}).listen(ORIGIN, '127.0.0.1');
const agent = new Agent({ connect: { timeout: 1000 }, headersTimeout: 30000, bodyTimeout: 0 });
const customFetch = (r) => fetch(r, { dispatcher: agent });
const app = createMcpHonoApp();
const mount = (prefix, target, add = {}) => app.all(`${prefix}/*`, async (c) => {
  if (!['GET', 'HEAD'].includes(c.req.method)) return c.text('method not allowed', 405);
  const u = new URL(c.req.url); const to = target + u.pathname.slice(prefix.length) + u.search;
  const h = new Headers(c.req.raw.headers); h.delete('authorization'); h.delete('cookie'); h.delete('host');
  for (const [k, v] of Object.entries(add)) h.set(k, v);
  try { return await proxy(to, { raw: c.req.raw, headers: h, customFetch }); } catch (e) { return c.json({ error: 'bad gateway', code: e.cause?.code ?? e.name }, 502); }
});
mount('/kb', `http://127.0.0.1:${ORIGIN}`, { 'x-added': 'cfg' });
mount('/dead', `http://127.0.0.1:${DEAD}`);
const strip = (p) => p.replace(/^\/app/, '') || '/';
app.use('/app/*', serveStatic({ root, rewriteRequestPath: strip }));
app.get('/app/*', (c, next) => { if (/\.[a-z0-9]+$/i.test(c.req.path)) return next(); return serveStatic({ root, path: 'index.html' })(c, next); });
const server = createAdaptorServer({ fetch: app.fetch }); await new Promise((r) => server.listen(GW, '127.0.0.1', r));
const base = `http://127.0.0.1:${GW}`;
const show = (o) => console.log(JSON.stringify(o));
{ // SSE passes incrementally?
  const s = performance.now(); const res = await fetch(`${base}/kb/events?x=1`); const rd = res.body.getReader(); const dec = new TextDecoder(); const at = [];
  for (;;) { const { done, value } = await rd.read(); if (done) break; at.push([Math.round(performance.now() - s), dec.decode(value).trim()]); }
  show({ t: 'sse', status: res.status, ct: res.headers.get('content-type'), chunks: at });
}
{ // client disconnect reaches origin?
  const ac = new AbortController(); const res = await fetch(`${base}/kb/events`, { signal: ac.signal }); const rd = res.body.getReader(); await rd.read(); ac.abort(); await new Promise((r) => setTimeout(r, 300)); show({ t: 'abort', originSawClose: aborted });
}
{ const r = await fetch(`${base}/kb/echo?q=한글`, { headers: { authorization: 'Bearer secret', cookie: 'a=b' } }); show({ t: 'headers', body: await r.json() }); }
{ const s = performance.now(); const r = await fetch(`${base}/dead/x`); show({ t: 'dead', status: r.status, ms: Math.round(performance.now() - s), body: await r.text() }); }
{ const r = await fetch(`${base}/kb/echo`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }); show({ t: 'post', status: r.status }); }
for (const p of ['/app/', '/app/assets/a.js', '/app/entity/%ED%95%9C%EA%B8%80', '/app/deep/link', '/app/assets/missing.js', '/app/../../etc/passwd', '/app/%2e%2e/%2e%2e/etc/passwd', '/mcpx']) {
  const r = await fetch(base + p, { redirect: 'manual' }); show({ t: 'static', p, status: r.status, ct: r.headers.get('content-type'), body: (await r.text()).slice(0, 24) });
}
{ const http = await import('node:http'); const bad = (headers, path = '/app/') => new Promise((res) => { http.get({ host: '127.0.0.1', port: GW, path, headers }, (r) => { r.resume(); res(r.statusCode); }); });
  show({ t: 'hostOrigin', badHostStatic: await bad({ host: 'evil.example' }), badOriginStatic: await bad({ origin: 'http://evil.example' }), badOriginProxy: await bad({ origin: 'http://evil.example' }, '/kb/echo'), localOriginOtherPort: await bad({ origin: 'http://localhost:5173' }) });
}
process.exit(0);
