// loupe serve in front of kb-mock on a Unix socket (design 10, 11 "통합"). Real sockets, real HTTP.
// Sockets go under LOUPE_SOCKET_DIR (default: a fresh directory in the OS temp dir). TCP uses 127.0.0.1:4832 and 4834.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdaptorServer } from '@hono/node-server';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http, { type Server } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { createKbMock } from '../dev/kb-mock/app.ts';
import { createLoupeApp, unsafeSegment } from '../server/serve.ts';
import { login, startIdp, writeAuthConfig, type Idp } from '../e2e/support/oidc.ts';

// Unix socket paths are limited to 107 bytes, so the names are short and sit directly in the socket directory.
const sockDir = process.env.LOUPE_SOCKET_DIR ?? os.tmpdir();
const sockPath = (name: string) => path.join(sockDir, `${process.pid % 10000}${name}`);
const cache = new URL('../.cache/', import.meta.url).pathname;
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(path.join(cache, 'serve-test-'));
const dist = path.join(dir, 'dist');
// Every /kb request goes through a real login against a test OpenID provider (design v2 6, M0b): the guard stays on.
const authDir = path.join(dir, 'auth');
let idp: Idp;
const tokens = new Map<number, string>();
const authCfg = () => ({ dir: authDir, issuer: idp.url, log: () => undefined });
/** fetch with this port's session. */
const kfetch = (u: string, init: RequestInit = {}) => { const h = new Headers(init.headers); const t = tokens.get(Number(new URL(u).port)); if (t) h.set('authorization', `Bearer ${t}`); return fetch(u, { ...init, headers: h }); };
const servers: net.Server[] = [];
const listen = (s: net.Server, ...args: unknown[]) => new Promise<void>((res, rej) => { s.once('error', rej); (s.listen as (...a: unknown[]) => void)(...args, res); servers.push(s); });
const unixMock = async (name: string, opts = {}) => { const p = sockPath(name); await listen(createAdaptorServer({ fetch: createKbMock(opts).fetch }) as net.Server, p); return p; };
const serve = async (kb: Parameters<typeof createLoupeApp>[0]['kb'], port: number, extra = {}) => {
  await listen(createAdaptorServer({ fetch: createLoupeApp({ kb, dist, port, auth: authCfg(), ...extra }).fetch }) as net.Server, port, '127.0.0.1');
  const origin = `http://localhost:${port}`;
  tokens.set(port, await login(origin));
  return origin;
};
// A raw request lets a test set Host, which fetch forbids. It carries the port's session unless `session` is false.
const raw = (port: number, p: string, headers: Record<string, string> = {}, method = 'GET', session = true) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
  const t = tokens.get(port);
  // The socket is on 127.0.0.1; the Host is the default origin's, localhost:<port> (design v2 6.3).
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `localhost:${port}`, ...(session && t ? { authorization: `Bearer ${t}` } : {}), ...headers } }, (res) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(c) })); });
  req.on('error', reject); req.end();
});

let base: string, baseEnc: string, mockSock: string, baseDecoding: string;
// A KB stand-in that routes on the decoded path, as Starlette does. Hono keeps %2F encoded, so kb-mock cannot show this class of bug.
const decodedSeen: string[] = [];
const decodingKb = async (name: string) => {
  const p = sockPath(name);
  await listen(http.createServer((req, res) => {
    decodedSeen.push(req.url ?? '');
    const decoded = decodeURIComponent((req.url ?? '').split('?')[0]!);
    if (/^\/v1\/snapshots\/[^/]+\/raw$/.test(decoded)) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>raw capture</h1>'); } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }
  }) as net.Server, p);
  return p;
};
beforeAll(async () => {
  idp = await startIdp();
  writeAuthConfig(authDir);
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>t</title>');
  writeFileSync(path.join(dist, 'assets', 'app-abc.js'), 'console.log(1)');
  writeFileSync(path.join(dist, '.secret'), 'no');
  mockSock = await unixMock('k.sock');
  base = await serve({ kind: 'unix', path: mockSock }, 4832);
  const enc = await unixMock('e.sock', { exportStyle: 'encoding' });
  baseEnc = await serve({ kind: 'unix', path: enc }, 4834);
  baseDecoding = await serve({ kind: 'unix', path: await decodingKb('w.sock') }, 4833);
});
afterAll(async () => { await idp.stop(); for (const s of servers) s.close(); rmSync(dir, { recursive: true, force: true }); for (const n of ['s.sock']) rmSync(sockPath(n), { force: true }); });

describe('proxy over the Unix socket', () => {
  it('relays /kb/v1/meta with the KB body and the allowed headers only', async () => {
    const r = await kfetch(`${base}/kb/v1/meta`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: { contract: string } }).data.contract).toBe('v1');
    expect(r.headers.get('etag')).toMatch(/^"1-\d+-g-/);
    expect(r.headers.get('vary')).toBeNull(); // Vary is not in the pass list
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox; frame-ancestors 'none'");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it('does not forward the browser Host and passes If-None-Match so the KB can answer 304', async () => {
    const first = await kfetch(`${base}/kb/v1/schema`);
    const etag = first.headers.get('etag')!;
    const again = await kfetch(`${base}/kb/v1/schema`, { headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);
  });
  it('carries Hangul and percent-encoded ids unchanged', async () => {
    const j = (await (await kfetch(`${base}/kb/v1/search?q=${encodeURIComponent('훅')}`)).json()) as { data: { items: unknown[] } };
    expect(j.data.items.length).toBeGreaterThan(0);
    const one = await kfetch(`${base}/kb/v1/nodes/${encodeURIComponent('e:feature:claude-code-hooks')}`);
    expect(one.status).toBe(200);
    const hostile = await kfetch(`${base}/kb/v1/nodes/${encodeURIComponent('a/../b?as_of_valid=2020-01-01T00:00:00Z#x')}`);
    expect(hostile.status).toBe(404);
  });
  it('carries KB problems through with their status', async () => {
    const r = await kfetch(`${base}/kb/v1/nodes?limit=501`);
    expect(r.status).toBe(400);
    expect(r.headers.get('content-type')).toMatch(/problem\+json/);
  });
  it('/raw is an attachment and its HTML cannot run as a document', async () => {
    const r = await kfetch(`${base}/kb/v1/snapshots/n-html000000000001/raw`);
    expect(r.headers.get('content-type')).toMatch(/^text\/html/);
    expect(r.headers.get('content-disposition')).toBe('attachment');
    expect(r.headers.get('content-security-policy')).toContain('sandbox');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('the three Phase 1 continuation paths are on the allow-list', async () => {
    for (const tail of ['claims', 'edges', 'body']) {
      const r = await kfetch(`${base}/kb/v1/nodes/e%3Anope%3Anone/${tail}`);
      expect(r.status).toBe(404);
      expect((await r.json()).code).toBe('not_found');
    }
  });
  it('HEAD works', async () => { const r = await kfetch(`${base}/kb/v1/meta`, { method: 'HEAD' }); expect(r.status).toBe(200); expect(await r.text()).toBe(''); });
  it('decompresses the export in both spellings of the contract', async () => {
    for (const b of [base, baseEnc]) {
      const r = await kfetch(`${b}/kb/v1/export/graph?profile=core`);
      expect(r.headers.get('content-type')).toBe('application/json');
      expect(r.headers.get('content-encoding')).toBeNull();
      const j = (await r.json()) as { graph: { directed: boolean }; nodes: { columns: string[] } };
      expect(j.graph.directed).toBe(true); expect(j.nodes.columns).toContain('merged_into');
    }
    // a raw zstd client gets the same bytes the mock made
    const direct = await raw(4832, '/kb/v1/export/graph?profile=full');
    expect(() => zstdDecompressSync(direct.body)).toThrow(); // already decompressed
    expect(JSON.parse(direct.body.toString('utf8')).nodes.rows.length).toBeGreaterThan(10);
  });
});

describe('what the proxy refuses', () => {
  it.each(['/kb/v1/ops/metrics', '/kb/v1/ops/freshness', '/kb/v1/nodes/%2e%2e', '/kb/v2/meta', '/kb/', '/kb/v1', '/kb/v1/nodes/a/b/c', '/kb/healthz', '/kb/v1/meta/extra'])('%s is 404 path_not_allowed', async (p) => {
    const r = await raw(4832, p);
    expect(r.status).toBe(404);
  });
  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('%s is 405', async (m) => { expect((await raw(4832, '/kb/v1/meta', {}, m)).status).toBe(405); });
  it('foreign Host and Origin are 403', async () => {
    expect((await raw(4832, '/', { host: 'evil.example' })).status).toBe(403);
    expect((await raw(4832, '/kb/v1/meta', { origin: 'http://evil.example' })).status).toBe(403);
    expect((await raw(4832, '/kb/v1/meta', { origin: 'null' })).status).toBe(403);
    // v2 6.3: another local port or `127.0.0.1` is another origin, refused even with a session; localhost:<port> is the origin.
    expect((await raw(4832, '/kb/v1/meta', { origin: 'http://localhost:4810' })).status).toBe(403);
    expect((await raw(4832, '/kb/v1/meta', { origin: 'http://127.0.0.1:4832' })).status).toBe(403);
    expect((await raw(4832, '/kb/v1/meta', { host: '127.0.0.1:4832' })).status).toBe(403);
    expect((await raw(4832, '/kb/v1/meta', { origin: 'http://localhost:4832' })).status).toBe(200);
  });
  it('cross-site no-cors is 403, a link navigation reaches the app but not the data', async () => {
    expect((await raw(4832, '/kb/v1/meta', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' })).status).toBe(403);
    expect((await raw(4832, '/kb/v1/meta', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' })).status).toBe(403);
    expect((await raw(4832, '/', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })).status).toBe(200);
    // v2 6.3 drops v1's navigate pass on the data paths.
    expect((await raw(4832, '/kb/v1/meta', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })).status).toBe(403);
    expect((await raw(4832, '/kb/v1/meta', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' })).status).toBe(200);
  });
  it('without a session /kb/* is 401 and reaches nothing', async () => {
    const r = await raw(4832, '/kb/v1/meta', {}, 'GET', false);
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body.toString()).code).toBe('session_required');
    expect((await raw(4832, '/kb/v1/meta', { authorization: 'Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 'GET', false)).status).toBe(401);
    expect((await raw(4832, '/k%62/v1/meta', {}, 'GET', false)).status).toBe(404);
  });
  it('request headers outside the allow-list are not forwarded', async () => {
    // The mock would reject a bad Authorization with 401 only if it required a token; here we check Host instead:
    const r = await raw(4832, '/kb/v1/meta', { 'x-forwarded-host': 'evil.example', cookie: 'a=b' });
    expect(r.status).toBe(200);
  });
});

describe('paths the KB router would decode (round 1)', () => {
  it('the /raw route keeps its Content-Disposition, and the same document cannot be reached around it with %2F', async () => {
    decodedSeen.length = 0;
    const ok = await raw(4833, '/kb/v1/snapshots/n-1/raw');
    expect(ok.status).toBe(200);
    expect(ok.headers['content-disposition']).toBe('attachment');
    for (const p of ['/kb/v1/snapshots/n-1%2Fraw', '/kb/v1/snapshots/n-1%2fraw', '/kb/v1/nodes/x%2Fclaims', '/kb/v1/nodes/..%2Fops%2Fmetrics', '/kb/v1/snapshots/n-1%5Craw', '/kb/v1/nodes/a%00b']) {
      const r = await raw(4833, p);
      expect(r.status, p).toBe(404);
      expect(JSON.parse(r.body.toString()).code, p).toBe('path_not_allowed');
      expect(r.headers['content-security-policy'], p).toContain('sandbox');
    }
    expect(decodedSeen, 'only the allowed request reached the KB').toEqual(['/v1/snapshots/n-1/raw']);
  });
  it('a path the router matches to nothing still gets the checks and the headers', async () => {
    for (const p of ['/kb/v1/nodes/%0a', '/kb/v1/nodes/%0d%0a', '/kb/v1/nodes/%E2%80%A8', '/index.html%0d', '/assets/index%0a.js', '/healthz%0a']) {
      const own = await raw(4832, p);
      expect(own.headers['x-content-type-options'], p).toBe('nosniff');
      expect(own.headers['referrer-policy'], p).toBe('no-referrer');
      expect(String(own.headers['content-security-policy']), p).toContain('frame-ancestors');
      const foreign = await raw(4832, p, { host: 'evil.example' });
      expect(foreign.status, `${p} with a foreign Host`).toBe(403);
      expect(foreign.headers['x-content-type-options'], p).toBe('nosniff');
      const site = await raw(4832, p, { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' });
      expect(site.status, `${p} cross-site`).toBe(403);
    }
  });
  it('unsafeSegment names exactly what the router could decode into another route', () => {
    for (const p of ['/v1/nodes/a%2Fb', '/v1/nodes/..', '/v1/nodes/%2e%2e', '/v1/nodes/a%5Cb', '/v1/nodes/a%0Ab', '/v1/nodes/%E0%A4%A']) expect(unsafeSegment(p), p).toBe(true);
    for (const p of ['/v1/nodes/e%3Afeature%3Aa', '/v1/nodes/%ED%95%9C%EA%B8%80', '/v1/snapshots/n-1/raw', '/v1/nodes/a.b']) expect(unsafeSegment(p), p).toBe(false);
  });
});

describe('static files', () => {
  it('serves index.html with no-cache, assets immutable, and never dot files or traversal', async () => {
    const idx = await raw(4832, '/');
    expect(idx.status).toBe(200); expect(idx.headers['cache-control']).toBe('no-cache'); expect(idx.headers['content-type']).toMatch(/text\/html/);
    // The full app policy, not only frame-ancestors: a dedicated worker takes its policy from its own response (design 9).
    const csp = String(idx.headers['content-security-policy']);
    for (const d of ["default-src 'none'", "script-src 'self'", "connect-src 'self'", "worker-src 'self'", "frame-ancestors 'none'"]) expect(csp).toContain(d);
    expect(csp).not.toContain('sandbox');
    const a = await raw(4832, '/assets/app-abc.js');
    expect(a.headers['cache-control']).toContain('immutable');
    expect((await raw(4832, '/.secret')).status).toBe(404);
    expect((await raw(4832, '/assets/../.secret')).status).toBe(404);
    expect((await raw(4832, '/%2e%2e/etc/passwd')).status).toBe(404);
    expect((await raw(4832, '/nope.html')).status).toBe(404);
  });
  it('/healthz does not touch the KB', async () => {
    expect((await raw(4832, '/healthz')).body.toString()).toBe('ok\n');
  });
});

describe('failure mapping (design 7.4)', () => {
  // The port is known only after listen, and the app needs it for its origin, so the app is made then and a login follows.
  const listenOn = async (target: Parameters<typeof createLoupeApp>[0]['kb'], extra = {}) => {
    let app: ReturnType<typeof createLoupeApp> | undefined;
    const s = createAdaptorServer({ fetch: (r: Request) => app!.fetch(r) }) as Server;
    const port = await new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as net.AddressInfo).port)));
    app = createLoupeApp({ kb: target, dist, port, auth: authCfg(), ...extra });
    tokens.set(port, await login(`http://localhost:${port}`));
    return { port, close: () => s.close() };
  };
  const status = async (target: Parameters<typeof createLoupeApp>[0]['kb'], extra = {}) => {
    const s = await listenOn(target, extra);
    try { const r = await raw(s.port, '/kb/v1/meta'); return { status: r.status, code: JSON.parse(r.body.toString()).code as string }; } finally { s.close(); }
  };
  it('missing socket file is 502 kb_socket_missing', async () => { expect(await status({ kind: 'unix', path: sockPath('x.sock') })).toEqual({ status: 502, code: 'kb_socket_missing' }); });
  it('a file with no listener is 502 kb_socket_refused', async () => {
    const p = sockPath('s.sock'); writeFileSync(p, '');
    expect(await status({ kind: 'unix', path: p })).toEqual({ status: 502, code: 'kb_socket_refused' });
  });
  it('a socket the user may not open is 502 kb_socket_denied', async () => {
    const p = await unixMock('d.sock'); chmodSync(p, 0o000);
    expect(await status({ kind: 'unix', path: p })).toEqual({ status: 502, code: 'kb_socket_denied' });
  });
  it('a KB that never answers is 504 kb_timeout', async () => {
    const p = sockPath('h.sock');
    await listen(net.createServer((sock) => { sock.on('data', () => undefined); }), p);
    expect(await status({ kind: 'unix', path: p }, { firstByteMs: 150 })).toEqual({ status: 504, code: 'kb_timeout' });
  });
  it('a connection reset before any header is retried once for GET', async () => {
    const p = sockPath('r.sock');
    const kb = createAdaptorServer({ fetch: createKbMock().fetch }) as Server;
    let n = 0;
    await listen(net.createServer((sock) => { if (n++ === 0) sock.destroy(); else kb.emit('connection', sock); }), p);
    expect(await status({ kind: 'unix', path: p })).toEqual({ status: 200, code: undefined });
    expect(n).toBe(2);
  });
  it('503 not_ready and 429-style KB answers pass through untouched', async () => {
    const p = await unixMock('n.sock', { notReadyMs: 60_000 });
    const s = await listenOn({ kind: 'unix', path: p });
    try { const r = await raw(s.port, '/kb/v1/meta'); expect(r.status).toBe(503); expect(r.headers['retry-after']).toBeTruthy(); expect(JSON.parse(r.body.toString()).code).toBe('not_ready'); } finally { s.close(); }
  });
  it('TCP target: a bearer token from the token source is added, and only for TCP', async () => {
    const tcp = createAdaptorServer({ fetch: createKbMock({ token: 'viewer-token' }).fetch }) as Server;
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r)); servers.push(tcp);
    const kbPort = (tcp.address() as net.AddressInfo).port;
    expect((await status({ kind: 'tcp', https: false, host: '127.0.0.1', port: kbPort }, { token: 'viewer-token' })).status).toBe(200);
    expect((await status({ kind: 'tcp', https: false, host: '127.0.0.1', port: kbPort })).code).toBe('token_required');
  });
  it('TCP connect to a closed port fails fast with a mapped error', async () => {
    const t0 = Date.now();
    const r = await status({ kind: 'tcp', https: false, host: '127.0.0.1', port: 1 }, { connectMs: 300 });
    expect(r.status).toBeGreaterThanOrEqual(502); expect(Date.now() - t0).toBeLessThan(3000);
  });
});
