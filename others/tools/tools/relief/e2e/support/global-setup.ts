// Builds the app, serves it from the fixture server (4819), starts the Vite dev server (4816) and `relief serve` (4822, no tower) for the Host and Origin checks.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../../server/main.ts';
import { startLive } from '../../server/serve.ts';
import { PORT, root } from './ports.ts';

const viteBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js');
// A closed loopback port can hang instead of refusing on this host, so every probe has a short timeout.
const open = (port: number) => new Promise<boolean>((res) => { const s = net.connect(port, '127.0.0.1'); const t = setTimeout(() => { s.destroy(); res(false); }, 400); s.on('connect', () => { clearTimeout(t); s.destroy(); res(true); }); s.on('error', () => { clearTimeout(t); res(false); }); });

export default async function globalSetup() {
  if (process.env.RELIEF_E2E_BUILD !== '0') execFileSync(process.execPath, [viteBin, 'build'], { cwd: root, stdio: 'ignore' });
  for (const p of [PORT.dev, PORT.built, PORT.serve]) if (await open(p)) throw new Error(`port ${p} is already in use`);
  const built = await startServer(PORT.built, path.join(root, 'dist'));
  const dev = spawn(process.execPath, [viteBin], { cwd: root, stdio: 'ignore' });
  const t0 = Date.now();
  while (!(await open(PORT.dev))) { if (Date.now() - t0 > 15_000) throw new Error('vite dev did not start'); await new Promise((r) => setTimeout(r, 100)); }
  // No token file: it reaches for no tower at all, and the HTTP surface is what is under test.
  const dir = mkdtempSync(path.join(tmpdir(), 'relief-e2e-serve-'));
  writeFileSync(path.join(dir, 'relief.json'), '{}');
  const env = { ...process.env, TOWER_CONFIG: path.join(dir, 'tower/tower.json'), RELIEF_CONFIG: dir, RELIEF_STATE: path.join(dir, 'state') } as NodeJS.ProcessEnv;
  const live = await startLive({ port: PORT.serve, env, dist: path.join(root, 'dist') });
  return async () => { dev.kill('SIGTERM'); await built.close(); await live.close(); rmSync(dir, { recursive: true, force: true }); };
}
