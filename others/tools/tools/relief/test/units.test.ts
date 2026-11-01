// Design 11 and 14, Phase 5: the units as files, socket activation as a process, and the window command. Nothing here touches the user manager or opens a window.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { open, openCommand } from '../server/open.ts';
import { activated } from '../server/serve.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const service = readFileSync(here('../../../ops/systemd/relief.service'), 'utf8');
const socketUnit = readFileSync(here('../../../ops/systemd/relief.socket'), 'utf8');
const line = (t: string, k: string) => t.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1);

describe('the unit files', () => {
  it('the socket holds the loopback port, and is what gets enabled', () => {
    expect(line(socketUnit, 'ListenStream')).toBe('127.0.0.1:4815');
    expect(line(socketUnit, 'WantedBy')).toBe('sockets.target');
  });
  it('the service restarts without limit and is started by the socket alone', () => {
    expect(line(service, 'StartLimitIntervalSec')).toBe('0');
    expect(line(service, 'Restart')).toBe('always');
    expect(line(service, 'Requires')).toBe('relief.socket');
    expect(service.split('\n').filter((l) => !l.startsWith('#')).join('\n')).not.toContain('[Install]');
  });
  it('names real absolute paths: a bare PATH has no node', () => {
    const [node] = line(service, 'ExecStart')!.split(' ');
    const dir = line(service, 'WorkingDirectory')!;
    for (const p of [node!, dir]) { expect(isAbsolute(p), p).toBe(true); expect(existsSync(p), p).toBe(true); }
    expect(existsSync(join(dir, 'bin/relief.mjs'))).toBe(true);
    expect(line(service, 'ExecStart')).toMatch(/ bin\/relief\.mjs serve$/);
  });
  it('depends on no tower unit, and carries no secret by file', () => {
    const body = service.split('\n').filter((l) => !l.startsWith('#')).join('\n');
    expect(body).not.toMatch(/tower/i);
    expect(service).not.toMatch(/EnvironmentFile|TOKEN/);
    expect(socketUnit).not.toMatch(/tower/i);
  });
});

describe('the shim', () => {
  it('runs the CLI with the same node as the service, with a bare PATH', () => {
    const shim = here('../../../ops/bin/relief');
    expect(readFileSync(shim, 'utf8')).toContain(line(service, 'ExecStart')!.split(' ')[0]!);
    const r = spawnSync(shim, ['help'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('relief open');
  });
});

describe('activated', () => {
  it('takes fd 3 only when the variables name this process, and spends them', () => {
    const env: NodeJS.ProcessEnv = { LISTEN_FDS: '1', LISTEN_PID: String(process.pid), LISTEN_FDNAMES: 'x' };
    expect(activated(env)).toBe(true);
    expect(env).toEqual({});
    expect(activated({ LISTEN_FDS: '1', LISTEN_PID: '1' })).toBe(false);
    expect(activated({ LISTEN_FDS: '2', LISTEN_PID: String(process.pid) })).toBe(false);
    expect(activated({})).toBe(false);
  });
});

describe('a held socket across server lives', () => {
  const closers: (() => void)[] = [];
  afterEach(() => { for (const c of closers.splice(0)) c(); });

  const dirWith = () => {
    const dir = mkdtempSync(join(tmpdir(), 'relief-hold-'));
    mkdirSync(join(dir, 'tower'));
    writeFileSync(join(dir, 'relief.json'), '{}');
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  /** Bare PATH, as a unit has it. Port 0 means a server that ignores fd 3 fails the test without taking the real port. */
  const holder = (dir: string) => {
    const [node] = line(service, 'ExecStart')!.split(' ');
    const h = spawn('python3', [here('./support/hold-socket.py'), '--', node!, 'bin/relief.mjs', 'serve'], {
      cwd: line(service, 'WorkingDirectory')!, stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', HOME: dir, RELIEF_PORT: '0', TOWER_CONFIG: join(dir, 'tower/tower.json'), RELIEF_CONFIG: dir, RELIEF_STATE: join(dir, 'state') },
    }) as unknown as ChildProcessWithoutNullStreams;
    closers.push(() => h.stdin.end()); // The holder takes its server down with it when stdin closes. A SIGKILL here would orphan that server.
    return h;
  };
  const next = (h: ChildProcessWithoutNullStreams, word: string) => new Promise<string>((res, rej) => {
    const on = (d: Buffer) => { const l = d.toString().split('\n').find((x) => x.startsWith(word)); if (l) { h.stdout.off('data', on); res(l); } };
    h.stdout.on('data', on);
    setTimeout(() => rej(new Error(`no ${word}`)), 15_000).unref();
  });
  const get = (port: number, path: string) => new Promise<{ status: number; body: string }>((res, rej) => {
    const s = net.connect(port, '127.0.0.1');
    let raw = '';
    s.on('connect', () => s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
    s.on('data', (d) => { raw += d.toString(); });
    s.on('end', () => res({ status: Number(raw.split(' ')[1]), body: raw.slice(raw.indexOf('\r\n\r\n') + 4) }));
    s.on('error', rej);
    s.setTimeout(15_000, () => { s.destroy(); rej(new Error('timeout')); });
  });

  it('serves from fd 3, and a request that waits through a stop is answered by the next server', async () => {
    const h = holder(dirWith());
    const port = Number((await next(h, 'port')).split(' ')[1]);
    h.stdin.write('start\n');
    await next(h, 'started');
    expect((await get(port, '/api/snapshot')).status).toBe(200);
    expect(JSON.parse((await get(port, '/api/snapshot')).body).origin).toBe('live');
    h.stdin.write('stop\n');
    expect(await next(h, 'stopped')).toBe('stopped 0');
    // No server now: the kernel still takes the connection, because the holder has the socket.
    const waiting = get(port, '/api/status');
    await new Promise((r) => setTimeout(r, 200));
    h.stdin.write('start\n');
    await next(h, 'started');
    const r = await waiting;
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).sources[0].id).toBe('pve');
  });
});

describe('relief open', () => {
  const win = (p: string) => `C:${p}`;
  it('builds one fixed command to a local URL', () => {
    const c = openCommand({}, win);
    expect(c.file).toBe('powershell.exe');
    expect(c.args.at(-1)).toBe('http://127.0.0.1:4815/');
    expect(c.args.join(' ')).toMatch(/-File C:.*scripts\/chrome\.ps1 -Url/);
    expect(openCommand({ RELIEF_PORT: '4900' }, win).args.at(-1)).toBe('http://127.0.0.1:4900/');
  });
  it.each(['abc', '0', '70000', '1;calc'])('refuses the port %s', (p) => {
    expect(() => openCommand({ RELIEF_PORT: p }, win)).toThrow();
    const out: string[] = [];
    expect(open({ env: { RELIEF_PORT: p }, winPath: win, print: (l) => out.push(l), run: () => { throw new Error('ran'); } })).toBe(1);
  });
  it('--print shows the command and runs nothing', () => {
    const out: string[] = []; let ran = 0;
    expect(open({ env: {}, winPath: win, dryRun: true, print: (l) => out.push(l), run: () => { ran += 1; } })).toBe(0);
    expect(ran).toBe(0);
    expect(out[0]).toContain('powershell.exe');
  });
  it('without --print it runs that one command', () => {
    const seen: string[] = [];
    expect(open({ env: {}, winPath: win, run: (c) => seen.push(c.file) })).toBe(0);
    expect(seen).toEqual(['powershell.exe']);
  });
  it('the window script is relief\'s own: its own profile, an app window, a checked URL, nothing of loupe', () => {
    const t = readFileSync(here('../scripts/chrome.ps1'), 'utf8');
    expect(t).toContain('relief-chrome'); expect(t).toContain('--app=$Url'); expect(t).toContain('ValidatePattern');
    expect(t).not.toMatch(/loupe/i);
    expect(readFileSync(here('../server/open.ts'), 'utf8')).not.toMatch(/from '.*loupe/);
  });
});

describe('systemd itself', () => {
  it('accepts the unit files', () => {
    const r = spawnSync('systemd-analyze', ['--user', 'verify', here('../../../ops/systemd/relief.socket'), here('../../../ops/systemd/relief.service')], { encoding: 'utf8' });
    expect(r.stderr).not.toMatch(/relief\.(socket|service):\d+/);
    expect(r.status).toBe(0);
  });
});
