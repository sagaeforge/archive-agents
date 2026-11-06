// Process tracking. Every process the suite starts is its own process group and is killed on exit.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sleep } from './util.mjs';

const live = new Set();

export function killGroup(pid, sig) {
  try { process.kill(-pid, sig); return true; } catch { try { process.kill(pid, sig); return true; } catch { return false; } }
}

export function killAllSync() {
  for (const p of live) killGroup(p.pid, 'SIGKILL');
  live.clear();
}
process.on('exit', killAllSync);

export function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

// spawnTracked(cmd, args, { env, cwd, log }) -> { pid, child, exited, exitInfo(), stop(sig), kill(sig), readLog() }
export function spawnTracked(cmd, args, { env = {}, cwd, log, inheritEnv = true } = {}) {
  if (log) mkdirSync(dirname(log), { recursive: true });
  const fd = log ? openSync(log, 'a') : 'ignore';
  const child = spawn(cmd, args, { cwd, detached: true, stdio: ['ignore', fd, fd], env: inheritEnv ? { ...process.env, ...env } : env });
  if (log) closeSync(fd);
  const rec = { pid: child.pid, child };
  live.add(rec);
  let info = null;
  rec.exited = new Promise((resolve) => child.once('exit', (code, signal) => { info = { code, signal, at: performance.now() }; live.delete(rec); resolve(info); }));
  child.on('error', (e) => { info = { error: String(e.message), at: performance.now() }; live.delete(rec); });
  rec.exitInfo = () => info;
  rec.kill = (sig = 'SIGKILL') => killGroup(child.pid, sig);
  rec.signalLeader = (sig) => { try { process.kill(child.pid, sig); return true; } catch { return false; } };
  // Graceful stop: SIGTERM to the leader, SIGKILL to the whole group after graceMs. Returns ms until the leader exited.
  rec.stop = async (graceMs = 4000) => {
    const t0 = performance.now();
    if (!info) {
      rec.signalLeader('SIGTERM');
      await Promise.race([rec.exited, sleep(graceMs)]);
      if (!info) await Promise.race([rec.kill('SIGKILL') && rec.exited, sleep(2000)]);
    }
    killGroup(child.pid, 'SIGKILL'); // stdio children that outlived their parent
    live.delete(rec);
    return Math.round(performance.now() - t0);
  };
  rec.readLog = () => { try { return readFileSync(log, 'utf8'); } catch { return ''; } };
  return rec;
}
