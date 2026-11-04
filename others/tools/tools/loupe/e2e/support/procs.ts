// Spawning kb-mock and loupe serve. Node runs the TypeScript directly. Closed loopback ports can hang on this host, so probes carry a timeout.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { accessLog, authDir, IDP, logDir, root, sock, sockDir } from './ports.ts';

export const tcpOpen = (port: number) => new Promise<boolean>((res) => {
  const s = net.connect(port, '127.0.0.1');
  const t = setTimeout(() => { s.destroy(); res(false); }, 400);
  s.on('connect', () => { clearTimeout(t); s.destroy(); res(true); });
  s.on('error', () => { clearTimeout(t); res(false); });
});
export async function waitFor(f: () => boolean | Promise<boolean>, ms: number, what: string) {
  const t0 = Date.now();
  for (;;) {
    if (await f()) return;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 80));
  }
}

const node = process.execPath;
function run(args: string[], env: Record<string, string>) {
  return spawn(node, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] });
}

export async function startMock(name: string, fixture: string, extra: Record<string, string> = {}): Promise<ChildProcess> {
  mkdirSync(sockDir, { recursive: true }); mkdirSync(logDir, { recursive: true });
  const socket = sock(name);
  rmSync(socket, { force: true });
  const c = run(['dev/kb-mock/main.ts'], { KB_FIXTURES: fixture, KB_MOCK_SOCKET: socket, KB_ACCESS_LOG: accessLog(name), ...extra });
  await waitFor(() => existsSync(socket), 8000, `kb-mock ${name}`);
  return c;
}
export async function startServe(name: string, port: number, extra: Record<string, string> = {}): Promise<ChildProcess> {
  const c = run(['bin/loupe.mjs', 'serve'], { KB_URL: `unix:${sock(name)}`, LOUPE_PORT: String(port), LOUPE_CONFIG_DIR: authDir, LOUPE_OIDC_ISSUER: IDP, ...extra });
  await waitFor(() => tcpOpen(port), 8000, `loupe serve ${port}`);
  return c;
}
export async function stop(c: ChildProcess | undefined) {
  if (!c || c.exitCode !== null) return;
  await new Promise<void>((res) => { c.once('exit', () => res()); c.kill('SIGTERM'); setTimeout(() => { c.kill('SIGKILL'); res(); }, 1500).unref(); });
}
