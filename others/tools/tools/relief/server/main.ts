// Serves the built app and the fixture API on 127.0.0.1. `npm run build` first. Port: RELIEF_PORT, default 4818 (4816 is the Vite dev server, design 11).
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApi } from './app.ts';
import { SAFE_HEADERS } from './guard.ts';

export async function startServer(port: number, dist = 'dist') {
  const app = new Hono();
  app.use('*', async (c, next) => { await next(); for (const [k, v] of Object.entries(SAFE_HEADERS)) c.header(k, v); });
  app.route('/', createApi());
  app.use('*', serveStatic({ root: dist }));
  return new Promise<{ close: () => Promise<void> }>((resolve) => {
    const s = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => resolve({ close: () => new Promise<void>((r) => { s.close(() => r()); (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); }) }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.RELIEF_PORT ?? 4818);
  await startServer(port, process.env.RELIEF_DIST ?? 'dist');
  console.log(`relief fixture server on http://127.0.0.1:${port}/`);
}
