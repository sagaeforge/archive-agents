// `relief open`: the dedicated Chrome window (design 11). The window lives on the Windows side, so WSL only hands it a fixed script and a local URL.
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from './config.ts';

const SCRIPT = fileURLToPath(new URL('../scripts/chrome.ps1', import.meta.url));

export type OpenCommand = { file: string; args: string[] };

/** The URL is built here from a port, never taken as text: this command opens relief and nothing else. */
export function openCommand(env: NodeJS.ProcessEnv, winPath: (p: string) => string): OpenCommand {
  const port = Number(env.RELIEF_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RELIEF_PORT is not a port');
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', winPath(SCRIPT), '-Url', `http://127.0.0.1:${port}/`] };
}

const wslpath = (p: string) => execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim();

export type OpenOptions = { env?: NodeJS.ProcessEnv; print?: (l: string) => void; dryRun?: boolean; winPath?: (p: string) => string; run?: (c: OpenCommand) => void };

export function open(o: OpenOptions = {}): number {
  const print = o.print ?? console.log;
  let c: OpenCommand;
  try { c = openCommand(o.env ?? process.env, o.winPath ?? wslpath); } catch (e) { print(`relief: ${(e as Error).message.slice(0, 200)}`); return 1; }
  if (o.dryRun) { print([c.file, ...c.args].join(' ')); return 0; }
  (o.run ?? ((x) => { spawn(x.file, x.args, { stdio: 'ignore', detached: true }).on('error', () => print('relief: powershell.exe not found: this opens a window from WSL only')).unref(); }))(c);
  return 0;
}
