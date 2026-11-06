// Path-prefix proxy, GET and HEAD only. The target URL is built by concatenation, so a request path can never change the host.
import type { Hono } from 'hono';
import { proxy } from 'hono/proxy';
import { Agent } from 'undici';
import type { Config } from './config.js';
import { log } from './log.js';

const dispatcher = new Agent({ connect: { timeout: 1_000 }, headersTimeout: 30_000, bodyTimeout: 0 });
const customFetch = (request: Request) => fetch(request, { dispatcher } as RequestInit);
const DROP = ['authorization', 'cookie', 'host', 'connection', 'keep-alive', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

const ESCAPE = /(^|[/\\]|%2f|%5c)(\.|%2e){1,2}($|[/\\#]|%2f|%5c)/i; // A "." or ".." segment in any encoding, with `\` as a separator and `#` as its end too.

export function mountRoutes(app: Hono, routes: () => Config['routes']) {
  app.all('*', async (c) => {
    // The raw request target: the URL that reaches Hono already has its dot segments resolved.
    const [, path = '', search = ''] = /^([^?]*)(.*)$/s.exec((c.env as { incoming: { url: string } }).incoming.url)!;
    const [name, route] = Object.entries(routes()).find(([, r]) => path === r.path || path.startsWith(`${r.path}/`)) ?? [];
    if (!name || !route) return c.notFound();
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.text('method not allowed', 405);
    if (ESCAPE.test(path)) return c.notFound();
    if (path === route.path) return c.redirect(`${path}/${search}`, 301);
    const started = performance.now();
    const logged = (httpStatus: number) => log('http', { route: name, httpMethod: c.req.method, httpStatus, durationMs: Math.round(performance.now() - started) });
    try {
      const base = `${route.proxy.replace(/\/$/, '')}/`;
      const target = `${base}${path.slice(route.path.length + 1)}${search}`;
      if (!new URL(target).pathname.startsWith(new URL(base).pathname)) return c.notFound(); // The last word on escapes: what fetch will really ask for.
      const headers = new Headers(c.req.raw.headers);
      for (const header of DROP) headers.delete(header);
      for (const [key, value] of Object.entries(route.requestHeaders ?? {})) headers.set(key, value);
      const response = await proxy(target, { method: c.req.method, headers, signal: c.req.raw.signal, redirect: 'manual', customFetch });
      for (const key of [...response.headers.keys()]) if (key === 'set-cookie' || key.startsWith('access-control-')) response.headers.delete(key);
      logged(response.status);
      return response;
    } catch {
      logged(502);
      return c.text('bad gateway', 502);
    }
  });
}
