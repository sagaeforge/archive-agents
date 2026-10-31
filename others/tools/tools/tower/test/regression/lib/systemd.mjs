// Transient user units for the one scenario that needs real socket activation and Restart=always (tower SIGKILL).
// Everything is created with systemd-run --user --collect and stopped again; nothing is enabled, linked or written
// to a unit directory, and linger is never touched.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const units = new Set();

function stopSync(unit) {
  for (const u of [`${unit}.socket`, `${unit}.service`]) { try { execFileSync('systemctl', ['--user', 'stop', u], { stdio: 'ignore', timeout: 10000 }); } catch {} }
  try { execFileSync('systemctl', ['--user', 'reset-failed', `${unit}.socket`, `${unit}.service`], { stdio: 'ignore', timeout: 5000 }); } catch {}
}
process.on('exit', () => { for (const u of units) stopSync(u); });

export async function systemdAvailable() {
  try { const { stdout } = await run('systemctl', ['--user', 'is-system-running'], { timeout: 4000 }).catch((e) => ({ stdout: e.stdout ?? '' })); return /running|degraded/.test(stdout); } catch { return false; }
}

// socket + service pair listening on 127.0.0.1:port, passing the socket as fd 3 to `cmd`.
export async function startSocketUnit({ unit, port, cmd, args, env, cwd, logFile }) {
  const socket = [`ListenStream=127.0.0.1:${port}`, 'NoDelay=true'];
  const service = ['Restart=always', 'RestartSec=1', 'StartLimitIntervalSec=0', 'TimeoutStopSec=8', `WorkingDirectory=${cwd}`];
  return startTransient({ unit, socket, service, cmd, args, env, logFile });
}

// The same thing with the properties given by the caller, for a test that reads them from the unit files.
export async function startTransient({ unit, socket, service, cmd, args, env, logFile }) {
  const argv = ['--user', '--collect', '--quiet', `--unit=${unit}`,
    ...socket.map((p) => `--socket-property=${p}`), ...service.flatMap((p) => ['-p', p]),
    '-p', `StandardOutput=append:${logFile}`, '-p', `StandardError=append:${logFile}`,
    ...Object.entries(env).flatMap(([k, v]) => ['-E', `${k}=${v}`]), cmd, ...args];
  units.add(unit);
  await run('systemd-run', argv, { timeout: 10000 });
  return {
    unit,
    async mainPid() { const { stdout } = await run('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', `${unit}.service`], { timeout: 5000 }); return Number(stdout.trim()); },
    async state(kind = 'socket') { const { stdout } = await run('systemctl', ['--user', 'show', '-p', 'ActiveState', '--value', `${unit}.${kind}`], { timeout: 5000 }).catch(() => ({ stdout: '' })); return stdout.trim(); },
    async stopService() { await run('systemctl', ['--user', 'stop', `${unit}.service`], { timeout: 15000 }); },
    stop() { stopSync(unit); units.delete(unit); },
  };
}
