// `relief serve`: the live map on 127.0.0.1. tower is one source among others: it may be down, and this process stays up (design 1, criterion 5).
import { serve as listen } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApi } from './app.ts';
import { createReader } from './collect/mcp.ts';
import { DEFAULT_PORT, loadConfig, readToken, resolvePaths } from './config.ts';
import { APP_CSP } from './guard.ts';
import { Live, type LiveOptions } from './live.ts';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

/** This machine's own addresses: how the workstation gets an observed one (design 7.1). */
const localIps = () => Object.values(networkInterfaces()).flat().flatMap((i) => (i && i.family === 'IPv4' && !i.internal ? [i.address] : []));

export type ServeOptions = { port?: number; dist?: string; env?: NodeJS.ProcessEnv; period?: LiveOptions['period'] };

export async function startLive(o: ServeOptions = {}) {
  const env = o.env ?? process.env;
  const paths = resolvePaths(env);
  const cfg = loadConfig(paths);
  const reader = createReader({ url: cfg.towerUrl, token: () => readToken(paths.tokenFile) });
  const live = new Live({ reader, stateDir: paths.stateDir, period: o.period, fault: cfg.error, edgePath: paths.edgeJson, wanUrl: cfg.publicIpUrl, wanFault: cfg.publicIpError, localIps });
  await live.start();
  const app = new Hono();
  app.use('*', async (c, next) => { await next(); c.header('Content-Security-Policy', APP_CSP); c.header('X-Content-Type-Options', 'nosniff'); });
  app.route('/', createApi({ live }));
  app.use('*', serveStatic({ root: o.dist ?? DIST }));
  const port = o.port ?? DEFAULT_PORT;
  const server = await new Promise<ReturnType<typeof listen>>((resolve) => { const s = listen({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => resolve(s)); });
  return {
    live, port: (server.address() as { port: number }).port, host: (server.address() as { address: string }).address,
    close: async () => {
      await live.stop();
      await reader.close();
      await new Promise<void>((r) => { server.close(() => r()); (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); });
    },
  };
}

export async function serve() {
  const port = Number(process.env.RELIEF_PORT ?? DEFAULT_PORT);
  const s = await startLive({ port });
  console.log(`relief on http://127.0.0.1:${s.port}/`);
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => void s.close().then(() => process.exit(0)));
}
