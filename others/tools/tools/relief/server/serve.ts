// `relief serve`: the live map on 127.0.0.1. tower is one source among others: it may be down, and this process stays up (design 1, criterion 5).
import { createAdaptorServer } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { Server } from 'node:http';
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

/** The socket unit holds the port and hands it over as fd 3. Spent here, so nothing this process starts takes it for its own. */
export function activated(env: NodeJS.ProcessEnv): boolean {
  const yes = env.LISTEN_FDS === '1' && env.LISTEN_PID === String(process.pid);
  for (const name of ['LISTEN_FDS', 'LISTEN_PID', 'LISTEN_FDNAMES']) delete env[name];
  return yes;
}

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
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  const target = activated(env) ? { fd: 3 } : { port: o.port ?? DEFAULT_PORT, host: '127.0.0.1' };
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(target, resolve); });
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
  const s = await startLive({ port: Number(process.env.RELIEF_PORT ?? DEFAULT_PORT) });
  console.log(`relief on http://${s.host}:${s.port}/`);
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => void s.close().then(() => process.exit(0)));
}
