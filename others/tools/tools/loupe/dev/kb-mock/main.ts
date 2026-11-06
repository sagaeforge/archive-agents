// Starts kb-mock on a Unix socket (KB_MOCK_SOCKET) and/or a loopback port (KB_MOCK_PORT, default 4811 when no socket).
import { createAdaptorServer } from '@hono/node-server';
import { appendFileSync, chmodSync, existsSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { createKbMock, type MockOptions } from './app.ts';

const env = process.env;
const accessLog = env.KB_ACCESS_LOG;
const opts: MockOptions = {
  bug: (env.KB_MOCK_BUG || undefined) as MockOptions['bug'],
  exportUnpublished: env.KB_MOCK_EXPORT_UNPUBLISHED === '1',
  token: env.KB_MOCK_TOKEN || undefined,
  notReadyMs: Number(env.KB_MOCK_NOT_READY_MS ?? 0),
  epoch: env.KB_MOCK_EPOCH ? Number(env.KB_MOCK_EPOCH) : undefined,
  exportStyle: env.KB_MOCK_EXPORT_STYLE === 'encoding' ? 'encoding' : 'ctype',
  totalNull: env.KB_MOCK_TOTAL_NULL === '1',
  // The task center's fixtures (design v2 11.2, M0f): `KB_MOCK_TASKS=1 npm run mock`. See dev/kb-mock/tasks.ts.
  tasks: env.KB_MOCK_TASKS === '1',
  // The first-party write path (design v2 11.2, M1): `KB_MOCK_WRITE=1`. Tokens come from KB_MOCK_EDITOR_TOKEN / KB_MOCK_REVIEWER_TOKEN; `KB_MOCK_PRIVATE_OPEN=0` closes `private`.
  write: env.KB_MOCK_WRITE === '1' ? { editorToken: env.KB_MOCK_EDITOR_TOKEN || 'kbt_e_mock-editor', reviewerToken: env.KB_MOCK_REVIEWER_TOKEN || 'kbt_r_mock-reviewer', privateOpen: env.KB_MOCK_PRIVATE_OPEN !== '0' } : undefined,
  // The database view's fixtures (design v2 11.3, M4): `KB_MOCK_DB=1` with `KB_MOCK_WRITE=1`. See dev/kb-mock/db.ts.
  db: env.KB_MOCK_DB === '1',
  onAccess: accessLog ? (line) => appendFileSync(accessLog, line + '\n') : undefined,
};
const app = createKbMock(opts);
const servers: net.Server[] = [];

const socket = env.KB_MOCK_SOCKET;
if (socket) {
  // Remove a stale socket file, but never one that something still listens on.
  if (existsSync(socket)) {
    const alive = await new Promise<boolean>((res) => { const s = net.connect(socket); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
    if (alive) { console.error(`kb-mock: ${socket} is in use`); process.exit(1); }
    unlinkSync(socket);
  }
  const s = createAdaptorServer({ fetch: app.fetch });
  await new Promise<void>((res) => s.listen(socket, res));
  chmodSync(socket, 0o600);
  servers.push(s as unknown as net.Server);
  console.log(`kb-mock on unix:${socket}`);
}
const port = env.KB_MOCK_PORT ? Number(env.KB_MOCK_PORT) : socket ? 0 : 4811;
if (port || !socket) {
  const s = createAdaptorServer({ fetch: app.fetch });
  await new Promise<void>((res) => s.listen(port, '127.0.0.1', res));
  servers.push(s as unknown as net.Server);
  console.log(`kb-mock on 127.0.0.1:${(s.address() as net.AddressInfo).port}`);
}
const stop = () => { for (const s of servers) s.close(); if (socket && existsSync(socket)) unlinkSync(socket); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
