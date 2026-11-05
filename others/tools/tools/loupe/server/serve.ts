// loupe serve (design 10): static files, a read-only proxy for /kb/*, and the headers that keep captured pages harmless.
// Binds 127.0.0.1 only. Does not log paths or queries (?q= carries search terms).
import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createZstdDecompress } from 'node:zlib';
import type { Server } from 'node:http';
import { APP_CSP_HEADER, KB_CSP_HEADER } from './csp.ts';
import { DEFAULT_KB_URL, kbRequest, mapFailure, parseKbUrl, readTokenFile, type Target } from './upstream.ts';
import { createAuth, problem, type AuthOptions } from './auth/index.ts';
import { kbStatus } from './status.ts';
import { configDir } from './auth/files.ts';
import { check, kindOf, loopbackAlias, originForHost } from './auth/guard.ts';

export type ServeConfig = {
  kb: Target;
  /** Directory with the built SPA. */
  dist: string;
  token?: string | undefined;
  firstByteMs?: number | undefined;
  connectMs?: number | undefined;
  /** The local port. The default origin allowlist is http://localhost:<port>; loupe.json may list more (design v2 6.3). The socket stays on 127.0.0.1. */
  port: number;
  auth: Omit<AuthOptions, 'port'>;
};

// /kb/* paths loupe calls. /v1/ops/* is not in the list on purpose (design 10).
const SEG = '[^/]+';
const KB_ALLOW = [
  '/v1/meta', '/v1/schema', '/v1/overview', '/v1/nodes', `/v1/nodes/${SEG}`, `/v1/nodes/${SEG}/claims`, `/v1/nodes/${SEG}/edges`, `/v1/nodes/${SEG}/body`,
  `/v1/nodes/${SEG}/neighbors`, `/v1/nodes/${SEG}/history`,
  `/v1/claims/${SEG}`, `/v1/edges/${SEG}`, '/v1/search', '/v1/facets', '/v1/counts', `/v1/series/${SEG}`,
  `/v1/snapshots/${SEG}`, `/v1/snapshots/${SEG}/text`, `/v1/snapshots/${SEG}/raw`, '/v1/changes', '/v1/export/graph/manifest', '/v1/export/graph',
].map((p) => new RegExp(`^${p}$`));
// The allowlist looks at the percent-encoded path, but the KB's router decodes it. A segment is refused when what it decodes to could
// reach a different route: `.` or `..`, a `/` or `\` (so `n-1%2Fraw` cannot be read as `n-1/raw`, which would skip the /raw header),
// or a control character. Public ids hold none of these (C 2.10), so no legitimate request is refused.
export const unsafeSegment = (pathname: string) => pathname.split('/').some((s) => {
  try { const d = decodeURIComponent(s); return d === '.' || d === '..' || /[/\\\u0000-\u001f\u007f]/.test(d); } catch { return true; }
});

/**
 * The /kb-write/* routes loupe serve answers. There are none until M1 (design v2 5.1); when they come they carry record writes
 * only: like /auth/*, no entry may change the allowed account, the break-glass path, a token or the idle limit.
 */
export const KB_WRITE_ROUTES: readonly { readonly method: string; readonly path: string }[] = [];

const PASS_RESPONSE = ['etag', 'retry-after', 'cache-control', 'content-type', 'content-encoding', 'content-length'];
const PASS_REQUEST = ['accept', 'accept-encoding', 'if-none-match'];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

export function createLoupeApp(cfg: ServeConfig): Hono {
  const app = new Hono();
  const firstByteMs = cfg.firstByteMs ?? 7_000, connectMs = cfg.connectMs ?? 1_000;
  const auth = createAuth({ ...cfg.auth, port: cfg.port, kb: (origin) => kbStatus({ kb: cfg.kb, token: cfg.token, firstByteMs, connectMs }, origin) });

  // 1. The checks of design v2 6.3, the session and the security headers wrap the whole app (below), so they also cover a path the
  //    router matches to nothing.

  app.get('/healthz', () => new Response('ok\n', { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }));

  // 2. KB proxy
  app.all('/kb/*', async (c) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    // The target is cut from the raw URL as a string. c.req.path would decode Hangul and node:http would throw on it.
    const raw = c.req.raw.url;
    const rest = raw.slice(raw.indexOf('/', raw.indexOf('//') + 2));
    const target = rest.slice('/kb'.length);
    const qi = target.indexOf('?');
    const pathname = qi < 0 ? target : target.slice(0, qi);
    if (!KB_ALLOW.some((r) => r.test(pathname)) || unsafeSegment(pathname)) return problem(404, 'path_not_allowed', 'Path is not served');

    const headers: Record<string, string> = {};
    for (const k of PASS_REQUEST) { const v = c.req.header(k); if (v) headers[k] = v; }
    // Host stays unset: Node's default (localhost for sockets) passes the KB allow-list.
    if (cfg.token && cfg.kb.kind === 'tcp') headers.authorization = `Bearer ${cfg.token}`;

    let up;
    try {
      up = await kbRequest(cfg.kb, { method: c.req.method, path: target, headers, signal: c.req.raw.signal, firstByteMs, connectMs });
    } catch (e) {
      if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
      const m = mapFailure(e);
      return problem(m.status, m.code, m.title);
    }

    const out = new Headers();
    for (const k of PASS_RESPONSE) { const v = up.headers[k]; if (typeof v === 'string') out.set(k, v); }
    if (/\/raw$/.test(pathname)) out.set('Content-Disposition', 'attachment');
    const status = up.statusCode ?? 502;
    if (c.req.method === 'HEAD' || status === 304 || status === 204) { up.resume(); return new Response(null, { status, headers: out }); }

    let body: Readable = up;
    // The browser cannot inflate zstd (design 10). Both spellings of the contract are handled.
    const ce = String(up.headers['content-encoding'] ?? '').toLowerCase(), ct = String(up.headers['content-type'] ?? '').toLowerCase();
    if (pathname === '/v1/export/graph' && status === 200 && (ce === 'zstd' || ct.startsWith('application/zstd'))) {
      const dec = createZstdDecompress();
      up.on('error', (e) => dec.destroy(e));
      body = up.pipe(dec);
      out.delete('content-encoding'); out.delete('content-length');
      out.set('content-type', 'application/json');
    }
    c.req.raw.signal.addEventListener('abort', () => up.destroy(), { once: true });
    return new Response(Readable.toWeb(body) as ReadableStream, { status, headers: out });
  });

  // 3. Static files. No SPA fallback: the hash router needs none.
  app.on(['GET', 'HEAD'], '*', (c) => {
    const pathname = new URL(c.req.url).pathname;
    let rel: string;
    try { rel = decodeURIComponent(pathname); } catch { return new Response('not found', { status: 404 }); }
    const segs = rel.split('/').filter((s, i, a) => !(s === '' && i !== a.length - 1));
    if (segs.some((s) => s.startsWith('.') || s.includes('\0') || s.includes('\\'))) return new Response('not found', { status: 404 });
    const file = path.join(cfg.dist, rel.endsWith('/') || rel === '' ? path.join(rel, 'index.html') : rel);
    if (!file.startsWith(path.resolve(cfg.dist) + path.sep)) return new Response('not found', { status: 404 });
    let st;
    try { st = statSync(file); } catch { return new Response('not found', { status: 404 }); }
    if (!st.isFile()) return new Response('not found', { status: 404 });
    const headers = new Headers({
      'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(st.size),
      'cache-control': /(^|\/)assets\//.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (c.req.method === 'HEAD') return new Response(null, { headers });
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers });
  });

  // Hono's router can fail to match a path (one whose decoded form holds a line terminator, for example), and then no middleware runs
  // and its default 404 goes out bare. So the checks and the headers wrap `fetch` itself and apply to every request (design 10, row 전체).
  const inner = app.fetch.bind(app);
  app.fetch = async (...args: Parameters<typeof inner>) => {
    const req = args[0];
    const p = rawPath(req.url);
    let decoded = p;
    try { decoded = decodeURIComponent(p); } catch { /* the static handler answers 404 */ }
    const kind = kindOf(p, req.method);
    const data = kind !== 'static';
    const header = (name: string) => req.headers.get(name) ?? undefined;
    let res: Response;
    if (kindOf(decoded, req.method) !== kind) {
      // `/k%62/…` or `/%61uth/…`: the router would decode it into a data path that the checks above did not classify as one.
      res = problem(404, 'path_not_allowed', 'Path is not served');
    } else if (kind === 'static' && (req.method === 'GET' || req.method === 'HEAD') && loopbackAlias(header, auth.origins())) {
      // sessionStorage and the redirect URI belong to the allowlisted origin, so another loopback name is sent there (6.3).
      res = new Response(null, { status: 308, headers: { location: loopbackAlias(header, auth.origins())! + req.url.slice(req.url.indexOf('/', req.url.indexOf('//') + 2)) } });
    } else {
      const origin = originForHost(header('host'), auth.origins());
      const deny = check(kind, req.method, header, origin, p);
      if (deny || !origin) res = problem(deny?.status ?? 403, deny?.code ?? 'host_rejected', deny?.title ?? 'Host is not an allowed origin');
      else if (p.startsWith('/auth/')) res = await auth.handle(req, p, origin);
      else if (p === '/kb' || p.startsWith('/kb/') || p === '/kb-write' || p.startsWith('/kb-write/')) {
        if (!auth.sessionOf(req)) res = problem(401, 'session_required', 'Sign in first');
        // The write path arrives with M1. Until then it has the checks and the session, and nothing behind them.
        else if (p.startsWith('/kb-write')) res = problem(404, 'path_not_allowed', 'Path is not served');
        else res = await inner(...args);
      } else res = await inner(...args);
    }
    return secured(res, data);
  };
  return app;
}

/** The path as it was sent, without decoding or normalizing. */
const rawPath = (url: string) => { const i = url.indexOf('/', url.indexOf('//') + 2); const p = i < 0 ? '/' : url.slice(i); const q = p.search(/[?#]/); return q < 0 ? p : p.slice(0, q); };

function secured(res: Response, data: boolean): Response {
  // A Response from fetch() or Response.error() has immutable headers, so the headers are copied into a new one.
  const headers = new Headers(res.headers);
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  // Captured text/html must not run script when it is opened as a document: the sandbox CSP is mandatory on /kb/* (design 9),
  // and /auth/* gets it too: none of it is a page.
  // Elsewhere the full app policy is sent as well, because a dedicated worker takes its policy from its own response.
  headers.set('Content-Security-Policy', data ? KB_CSP_HEADER : APP_CSP_HEADER);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServeConfig {
  const token = env.KB_TOKEN_FILE ? readTokenFile(env.KB_TOKEN_FILE) : undefined;
  return {
    kb: parseKbUrl(env.KB_URL ?? DEFAULT_KB_URL),
    dist: path.resolve(env.LOUPE_DIST ?? new URL('../dist/', import.meta.url).pathname),
    token,
    firstByteMs: env.LOUPE_FIRST_BYTE_MS ? Number(env.LOUPE_FIRST_BYTE_MS) : undefined,
    connectMs: env.LOUPE_CONNECT_MS ? Number(env.LOUPE_CONNECT_MS) : undefined,
    port: Number(env.LOUPE_PORT ?? 4812),
    auth: {
      dir: configDir(env),
      // A test provider on this machine (e2e). Unset, it is Google.
      issuer: env.LOUPE_OIDC_ISSUER || undefined,
      idleMs: env.LOUPE_SESSION_IDLE_MS ? Number(env.LOUPE_SESSION_IDLE_MS) : undefined,
      socketActivated: env.LISTEN_PID === String(process.pid) && Number(env.LISTEN_FDS) >= 1,
      secretFd: env.LISTEN_PID === String(process.pid) && (env.LISTEN_FDNAMES ?? '').split(':').includes('secret'),
    },
  };
}

/** Socket activation first (S2 rules), then 127.0.0.1:LOUPE_PORT (default 4812). */
export function listen(server: Server, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    if (env.LISTEN_PID === String(process.pid) && Number(env.LISTEN_FDS) >= 1) {
      server.listen({ fd: 3 }, () => resolve('fd:3'));
    } else {
      const port = Number(env.LOUPE_PORT ?? 4812);
      server.listen(port, '127.0.0.1', () => resolve(`127.0.0.1:${port}`));
    }
  });
}

export async function serve(env: NodeJS.ProcessEnv = process.env) {
  const cfg = configFromEnv(env);
  const server = createAdaptorServer({ fetch: createLoupeApp(cfg).fetch }) as Server;
  let where: string;
  try { where = await listen(server, env); } catch (e) {
    // KB ADR-0005 rev 9: a held port is refused, never worked around. Another process on 4812 could receive the Google redirect.
    // Under socket activation the inherited fd is ours and is not a conflict; this branch is the plain listen.
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`loupe serve: 127.0.0.1:${env.LOUPE_PORT ?? 4812} is already held by another process. Refusing to start; no other port is tried. Stop that process, or start loupe through loupe.socket.`);
      process.exit(1);
    }
    throw e;
  }
  console.log(`loupe serve on ${where}, kb ${cfg.kb.kind === 'unix' ? `unix:${cfg.kb.path}` : `${cfg.kb.host}:${cfg.kb.port}`}, dist ${cfg.dist}`);
  const stop = () => { server.close(); server.closeAllConnections(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return server;
}
