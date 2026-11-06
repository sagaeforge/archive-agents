// Section 10 rows 23-26: HTTP safety and the proxy routes. All requests that matter go over a raw socket,
// because fetch() normalises the path and rewrites Host before it reaches the wire.
import { P } from '../harness/env.mjs';
import { alphaCfg } from '../lib/fixtures.mjs';
import { connectFetch, jsonBody, rawRequest } from '../lib/http.mjs';
import { MODERN } from '../lib/mcp.mjs';
import { startOrigin, startTrap } from '../lib/origin.mjs';
import { ms, now, sleep } from '../lib/util.mjs';

const DISCOVER = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} } } });
const mcpPost = (headers = {}, extra = {}) => ({ method: 'POST', path: '/mcp', body: DISCOVER, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN, 'mcp-method': 'server/discover', ...headers }, ...extra });
const routes = () => ({
  app: { path: '/app', proxy: `http://127.0.0.1:${P.origin}`, requestHeaders: { 'X-Added': 'cfg' } },
  dead: { path: '/dead', proxy: `http://127.0.0.1:${P.never}` },
  pub: { path: '/pub', proxy: `http://127.0.0.1:${P.origin}/public`, requestHeaders: { 'X-Added': 'cfg' } },
});

async function http(ctx, g, req) { return rawRequest({ port: g.port, timeoutMs: 8000, ...req }); }

export const scenarios = [
  {
    order: 23, row: 23, id: 'auth-matrix', timeoutMs: 90000,
    title: 'Host, Origin, bearer on every path; no token -> 503',
    async run(ctx) {
      const origin = await startOrigin(P.origin); ctx.onCleanup(() => origin.close());
      await ctx.http('alpha', P.alpha);
      const spec = { upstreams: { alpha: alphaCfg() }, routes: routes() };
      const g = ctx.gateway(spec);
      await g.start();
      const T = g.token;
      const B = { Authorization: `Bearer ${T}` };
      const row = async (name, req, expect, extra) => {
        const r = await http(ctx, g, req);
        const ok = Array.isArray(expect) ? expect.includes(r.status) : r.status === expect;
        ctx.check(name, ok && (extra ? extra(r) : true), `${r.status}${r.error ? ` ${r.error}` : ''}${r.connectTimeout ? ' connect-timeout' : ''} want ${expect}`);
        return r;
      };
      // /mcp
      await row('/mcp good bearer -> 200', mcpPost(B), 200);
      await row('/mcp no bearer -> 401', mcpPost(), 401);
      await row('/mcp wrong bearer -> 401', mcpPost({ Authorization: 'Bearer ' + 'f'.repeat(64) }), 401);
      await row('/mcp token only in the query string -> 401', { ...mcpPost(), path: `/mcp?token=${T}` }, 401);
      await row('/mcp Basic scheme -> 401', mcpPost({ Authorization: `Basic ${T}` }), 401);
      await row('/mcp bad Host with a good bearer -> 403', mcpPost(B, { host: 'evil.example' }), 403);
      await row('/mcp bad Origin with a good bearer -> 403', mcpPost({ ...B, Origin: 'http://evil.example' }), 403);
      await row('/mcp localhost Origin on another port -> 200', mcpPost({ ...B, Origin: 'http://localhost:5173' }), 200);
      await row('/mcp bad Host without a bearer -> 403', mcpPost({}, { host: 'evil.example' }), 403);
      // /admin
      await row('/admin/status good bearer -> 200 JSON', { path: '/admin/status', headers: B }, 200, (r) => !!jsonBody(r));
      await row('/admin/status no bearer -> 401', { path: '/admin/status' }, 401);
      await row('/admin/status bad Host -> 403', { path: '/admin/status', headers: B, host: 'evil.example' }, 403);
      await row('/admin/status bad Origin -> 403', { path: '/admin/status', headers: { ...B, Origin: 'http://evil.example' } }, 403);
      // /healthz
      await row('/healthz no bearer -> 200, status ok, no names or pids', { path: '/healthz' }, 200, (r) => { const j = jsonBody(r) ?? {}; return j.status === 'ok' && !/pid|token|command/i.test(r.body) && !r.body.includes(T); });
      await row('/healthz bad Host -> 403', { path: '/healthz', host: 'evil.example' }, 403);
      await row('/healthz bad Origin -> 403', { path: '/healthz', headers: { Origin: 'http://evil.example' } }, 403);
      // routes
      await row('route without bearer -> 200 (open by design)', { path: '/app/echo' }, 200);
      await row('route bad Host -> 403', { path: '/app/echo', host: 'evil.example' }, 403);
      await row('route bad Origin -> 403', { path: '/app/echo', headers: { Origin: 'http://evil.example' } }, 403);
      // token missing or too short: closed, not open
      await g.stop();
      for (const mode of ['none', 'short']) {
        const g2 = ctx.gateway(spec, { tokenMode: mode, name: `gw-${mode}` });
        await g2.start();
        const probe = async (name, req, expect) => { const r = await http(ctx, g2, req); ctx.check(name, r.status === expect, `${r.status} want ${expect}`); };
        const auth = mode === 'short' ? { Authorization: `Bearer ${g2.token}` } : {};
        await probe(`token ${mode}: /mcp -> 503`, mcpPost(auth), 503);
        await probe(`token ${mode}: /admin/status -> 503`, { path: '/admin/status', headers: auth }, 503);
        await probe(`token ${mode}: /healthz still 200`, { path: '/healthz' }, 200);
        await g2.stop();
      }
      ctx.docResult('some paths covered in S1', null, 'not comparable: see per-check results');
    },
  },
  {
    order: 24, row: 24, id: 'sec-fetch', timeoutMs: 60000,
    title: 'cross-site or same-site non-navigate requests -> 403; navigate and no header pass',
    async run(ctx) {
      await ctx.http('alpha', P.alpha);
      const g = ctx.gateway({ upstreams: { alpha: alphaCfg() }, routes: {} });
      await g.start();
      const B = { Authorization: `Bearer ${g.token}` };
      const cases = [
        ['cross-site', 'no-cors', 403], ['cross-site', 'cors', 403], ['same-site', 'no-cors', 403], ['same-site', 'cors', 403], ['cross-site', 'websocket', 403],
        ['cross-site', 'navigate', 200], ['same-site', 'navigate', 200], ['same-origin', 'cors', 200], ['none', 'navigate', 200], [null, null, 200],
      ];
      for (const [site, mode, want] of cases) {
        const sf = { ...(site ? { 'Sec-Fetch-Site': site } : {}), ...(mode ? { 'Sec-Fetch-Mode': mode } : {}) };
        const label = site ? `${site}/${mode}` : 'no sec-fetch headers';
        const h = await http(ctx, g, { path: '/healthz', headers: sf });
        ctx.check(`/healthz ${label} -> ${want}`, h.status === want, `${h.status}`);
        const m = await http(ctx, g, mcpPost({ ...B, ...sf }));
        ctx.check(`/mcp ${label} -> ${want}`, m.status === want, `${m.status}`);
      }
      // A cross-site page reaches these with no click, so navigate alone does not pass. A page load does.
      for (const [site, dest, want] of [['cross-site', 'iframe', 403], ['cross-site', 'embed', 403], ['cross-site', 'object', 403], ['cross-site', 'frame', 403], ['same-site', 'iframe', 403], ['cross-site', 'document', 200], ['same-site', 'document', 200], ['same-origin', 'iframe', 200], ['none', 'document', 200]]) {
        const h = await http(ctx, g, { path: '/healthz', headers: { 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': dest } });
        ctx.check(`/healthz ${site}/navigate/${dest} -> ${want}`, h.status === want, `${h.status}`);
      }
      ctx.docResult('none in S1', null, 'not comparable');
    },
  },
  {
    order: 25, row: 25, id: 'proxy', timeoutMs: 90000,
    title: 'proxy: SSE, 502, header stripping, 301, prefix removal, set-cookie removal',
    async run(ctx) {
      const origin = await startOrigin(P.origin); ctx.onCleanup(() => origin.close());
      const g = ctx.gateway({ upstreams: {}, routes: routes() });
      await g.start();
      const echo = await http(ctx, g, { path: '/app/echo?q=%ED%95%9C%EA%B8%80', headers: { Authorization: 'Bearer secret', Cookie: 'a=b' } });
      const j = jsonBody(echo) ?? {};
      ctx.check('GET /app/echo -> 200 from the origin', echo.status === 200 && !!j.url, `${echo.status} ${echo.body.slice(0, 60)}`);
      ctx.check('the /app prefix is stripped, query kept byte for byte', j.url === '/echo?q=%ED%95%9C%EA%B8%80', String(j.url));
      ctx.check('authorization and cookie are removed from the request', j.auth === null && j.cookie === null, `auth=${j.auth} cookie=${j.cookie}`);
      ctx.check('Host is the target\'s, requestHeaders are added', j.host === `127.0.0.1:${P.origin}` && j.added === 'cfg', `host=${j.host} added=${j.added}`);
      ctx.check('set-cookie and access-control-* are removed from the response', !echo.headers['set-cookie'] && !Object.keys(echo.headers).some((k) => k.startsWith('access-control-')), Object.keys(echo.headers).join(','));
      ctx.check('other response headers pass through', echo.headers['x-origin-header']?.[0] === 'keep');
      const redir = await http(ctx, g, { path: '/app' });
      ctx.check('GET /app -> 301 to /app/', redir.status === 301 && /\/app\/$/.test(redir.headers.location?.[0] ?? ''), `${redir.status} ${redir.headers.location?.[0]}`);
      const post = await http(ctx, g, { method: 'POST', path: '/app/echo', body: '{}', headers: { 'Content-Type': 'application/json' } });
      ctx.check('POST -> 405', post.status === 405, String(post.status));
      const head = await http(ctx, g, { method: 'HEAD', path: '/app/echo' });
      ctx.check('HEAD -> 200', head.status === 200, String(head.status));
      const dead = await http(ctx, g, { path: '/dead/x' });
      ctx.check('dead target -> 502 within 3 s', dead.status === 502 && dead.ms <= 3000, `${dead.status} in ${dead.ms} ms`);
      // SSE passes in pieces
      const t0 = now();
      const chunks = [];
      const res = await connectFetch(`${g.base}/app/events`, { signal: AbortSignal.timeout(8000) }).catch((e) => ({ error: String(e) }));
      if (res.body) { const rd = res.body.getReader(); for (;;) { const { done } = await rd.read().catch(() => ({ done: true })); if (done) break; chunks.push(ms(t0)); } }
      ctx.check('SSE arrives incrementally (>= 5 chunks spread over >= 1 s, first within 1 s)', res.status === 200 && chunks.length >= 5 && chunks.at(-1) - chunks[0] >= 1000 && chunks[0] <= 1000, `status=${res.status} chunks at ${chunks.join(',')}`);
      // client abort reaches the origin
      const before = origin.state.aborted;
      const ac = new AbortController();
      const res2 = await connectFetch(`${g.base}/app/events`, { signal: ac.signal }).catch(() => null);
      if (res2?.body) { await res2.body.getReader().read().catch(() => {}); ac.abort(); }
      await sleep(700);
      ctx.check('client disconnect reaches the origin', origin.state.aborted > before, `aborted ${before} -> ${origin.state.aborted}`);
      ctx.docResult('probes only [P]', null, 'not comparable');
    },
  },
  {
    order: 26, row: 26, id: 'path-escape', timeoutMs: 90000,
    title: 'raw-socket path escapes, host switch and bearer bypass forms',
    async run(ctx) {
      const origin = await startOrigin(P.origin); ctx.onCleanup(() => origin.close());
      const trap = await startTrap(P.evil); ctx.onCleanup(() => trap.close());
      await ctx.http('alpha', P.alpha);
      const g = ctx.gateway({ upstreams: { alpha: alphaCfg() }, routes: routes() });
      await g.start();
      const control = await http(ctx, g, { path: '/app/echo' });
      ctx.check('control: a normal request is proxied', control.status === 200 && jsonBody(control)?.url === '/echo', `${control.status}`);
      const hitsBase = () => origin.state.hits.length;
      const traversal = ['/app/../x', '/app/%2e%2e/x', '/app/%2E%2E/x', '/app/./x', '/app/%2e/x', '/app/a/../b', '/app/a/%2e%2e/%2e%2e/b'];
      for (const p of traversal) {
        const h0 = hitsBase();
        const r = await http(ctx, g, { path: p });
        ctx.check(`escape ${p} -> 404, nothing forwarded`, r.status === 404 && hitsBase() === h0, `${r.status} forwarded=${hitsBase() - h0}`);
      }
      for (const p of ['/app/..%2fx', '/app/%2e%2e%2fx', '/app/..%5cx']) {
        const h0 = hitsBase();
        const r = await http(ctx, g, { path: p });
        ctx.check(`escape ${p} -> 404, nothing forwarded`, r.status === 404 && hitsBase() === h0, `${r.status} forwarded=${hitsBase() - h0}`);
      }
      // fetch() drops a fragment and then resolves the dot segment in front of it, so `#` ends a segment just as `/` does.
      for (const p of ['/app/..#', '/app/.#', '/app/%2e%2e#x', '/app/a/..#b', '/pub/..#', '/pub/.#', '/pub/%2e%2e#x', '/pub/..', '/pub/%2e/x']) {
        const h0 = hitsBase();
        const r = await http(ctx, g, { path: p });
        ctx.check(`escape ${p} -> 404, nothing forwarded`, r.status === 404 && hitsBase() === h0, `${r.status} forwarded=${hitsBase() - h0}`);
      }
      const fragment = await http(ctx, g, { path: '/pub/x#frag' });
      ctx.check('control: a fragment after a real segment stays under the target path', origin.state.hits.at(-1)?.url === '/public/x', `${fragment.status} ${origin.state.hits.at(-1)?.url}`);
      for (const p of [`/app//127.0.0.1:${P.evil}/x`, '/app//evil.example/x', `/app/\\127.0.0.1:${P.evil}/x`, `//127.0.0.1:${P.evil}/x`]) {
        const h0 = hitsBase();
        const r = await http(ctx, g, { path: p });
        const last = origin.state.hits.at(-1);
        const stayed = r.status === 404 || (hitsBase() === h0 + 1 && last?.host === `127.0.0.1:${P.origin}`);
        ctx.check(`host switch ${p} stays on the target host`, stayed && trap.hits.length === 0, `${r.status} trap hits ${trap.hits.length}`);
      }
      for (const p of ['/mcp/', '//mcp', '/./mcp', '/mcp%2f', '/%6dcp', '/MCP', '/admin/../admin/status', '/admin//status', '/healthz/../admin/status', '/app/../mcp', '/mcp;x=1', '/admin/status/', '/admin%2fstatus']) {
        const r = await http(ctx, g, p.startsWith('/mcp') && !p.includes('..') ? mcpPost({}, { path: p }) : { path: p });
        ctx.check(`bypass ${p} without a bearer -> 401 or 404, never 2xx`, r.status === 401 || r.status === 404, `${r.status}`);
      }
      ctx.docResult('fetch() normalised these, so S1 results are void', null, 'not comparable');
    },
  },
];
