import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { getRequestListener } from '@hono/node-server';
import { createApi } from './server/app.ts';
import { guard, META_CSP } from './server/guard.ts';

// Dev: Vite plays the part of `relief serve`. The same guard runs before everything, Vite's own files included.
const reliefApi = (): Plugin => ({
  name: 'relief-api',
  configureServer(server) {
    const api = getRequestListener(createApi().fetch);
    server.middlewares.use((req, res, next) => {
      const r = guard((n) => { const v = req.headers[n]; return Array.isArray(v) ? v[0] : v; }, req.url ?? '/');
      if (r) { res.statusCode = r.status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: r.code, message: r.message })); return; }
      if (req.url?.startsWith('/api/')) { void api(req, res); return; }
      next();
    });
  },
});

// Build only: the dev server needs Vite's inline scripts. `server/main.ts` also sends the policy as a header.
const cspMeta = (): Plugin => ({
  name: 'relief-csp-meta', apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: META_CSP }, injectTo: 'head-prepend' }],
});

export default defineConfig({
  // Relative assets and hash state: the build runs under any mount path (design 11).
  base: './',
  plugins: [react(), reliefApi(), cspMeta()],
  server: { host: '127.0.0.1', port: 4816, strictPort: true, allowedHosts: ['127.0.0.1', 'localhost'] },
  preview: { host: '127.0.0.1', port: 4818, strictPort: true },
  build: { target: 'es2023', sourcemap: false },
});
