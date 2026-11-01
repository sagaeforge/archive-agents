// Design 6.2 and 12, secret row: a marker token runs through everything and is found nowhere.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { startMock, type Mock } from '../dev/mcp-mock/mock.ts';
import { createReader } from '../server/collect/mcp.ts';
import { check, status } from '../server/check.ts';
import { loadConfig, loopbackUrl, readToken, resolvePaths } from '../server/config.ts';
import { startLive } from '../server/serve.ts';
import { closeRigs, rig, TOKEN } from './support/rig.ts';

afterEach(closeRigs);
const bin = fileURLToPath(new URL('../bin/relief.mjs', import.meta.url));
// Not spawnSync: the server under test lives in this process and has to keep answering.
const run = async (args: string[], env: NodeJS.ProcessEnv) => {
  try { const r = await promisify(execFile)(process.execPath, [bin, ...args], { env }); return { status: 0, ...r }; } catch (e) { const x = e as { code: number; stdout: string; stderr: string }; return { status: x.code, stdout: x.stdout, stderr: x.stderr }; }
};

function config(mock: Mock | { url: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'relief-secret-'));
  mkdirSync(join(dir, 'tower')); writeFileSync(join(dir, 'tower/token'), TOKEN, { mode: 0o600 });
  writeFileSync(join(dir, 'relief.json'), JSON.stringify({ towerUrl: mock.url }));
  return { dir, env: { ...process.env, TOWER_CONFIG: join(dir, 'tower/tower.json'), RELIEF_CONFIG: dir, RELIEF_STATE: join(dir, 'state') } as NodeJS.ProcessEnv };
}

describe('the marker token', () => {
  it('appears in no snapshot, API response, stdout, status output or change log', async () => {
    const mock = await startMock({ port: 0, token: TOKEN });
    const { dir, env } = config(mock);
    const printed: string[] = [];
    const log = console.log; const err = console.error;
    console.log = (...a) => { printed.push(a.join(' ')); }; console.error = (...a) => { printed.push(a.join(' ')); };
    const s = await startLive({ port: 0, env, dist: join(dir, 'nothing') });
    try {
      await s.live.collectOnce();
      // Upstream text that quotes the token back goes through the same path.
      mock.state.all = { isError: `strange failure with ${TOKEN} inside` };
      await s.live.collectOnce();
      expect(s.live.view().snapshot.sources[0]!.why).toContain('[redacted]');
      mock.state.all = null;
      await s.live.collectOnce();
      const base = `http://127.0.0.1:${s.port}`;
      const bodies = await Promise.all(['/api/snapshot', '/api/metrics', '/api/status'].map(async (p) => { const r = await fetch(base + p); return `${[...r.headers].join()} ${await r.text()}`; }));
      const envWithPort = { ...env, RELIEF_PORT: String(s.port) };
      const out = await run(['status'], envWithPort);
      expect(out.status).toBe(0);
      expect(out.stdout).toContain('pve: ok');
      const chk = await run(['check', '--live'], envWithPort);
      expect(chk.status, chk.stdout).toBe(0);
      const chk2: string[] = [];
      expect(await status({ env: envWithPort, print: (l) => chk2.push(l) })).toBe(0);
      expect(await check({ env, live: true, print: (l) => chk2.push(l) })).toBe(0);
      await s.close();
      const state = readdirSync(join(dir, 'state')).map((f) => readFileSync(join(dir, 'state', f), 'utf8'));
      expect(state.join('\n')).toContain('pve:node:node-1');
      const everything = [...bodies, out.stdout, out.stderr, chk.stdout, chk.stderr, ...chk2, ...printed, ...state].join('\n');
      expect(everything).not.toContain(TOKEN);
      expect(everything).not.toContain(TOKEN.slice(0, 16));
    } finally {
      console.log = log; console.error = err;
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('is not given to anything but the Authorization header', async () => {
    const f = readFileSync(fileURLToPath(new URL('../server/collect/mcp.ts', import.meta.url)), 'utf8');
    expect(f.match(/Bearer \$\{token\}/g)).toHaveLength(1);
    expect(f).not.toMatch(/process\.env/);
  });
});

describe('towerUrl', () => {
  it.each(['http://192.0.2.1:4800/mcp', 'http://example.com/mcp', 'http://127.0.0.1.example.com/mcp', 'ftp://127.0.0.1/mcp', 'http://user:pw@127.0.0.1/mcp', 'http://127.0.0.1/mcp?token=x', 'not a url'])('refuses %s', (url) => {
    expect(() => loopbackUrl(url)).toThrow();
    let read = 0;
    expect(() => createReader({ url, token: () => { read += 1; return TOKEN; } })).toThrow();
    expect(read).toBe(0);
  });
  it.each(['http://127.0.0.1:4800/mcp', 'http://localhost:4800/mcp', 'http://[::1]:4800/mcp'])('accepts %s', (url) => { expect(loopbackUrl(url).href).toBe(url); });
  it('a bad relief.json fails the check and leaves the default in place, and the token is not sent', async () => {
    const { dir, env } = config({ url: 'http://192.0.2.1:4800/mcp' });
    const lines: string[] = [];
    expect(await check({ env, live: true, print: (l) => lines.push(l) })).toBe(1);
    expect(lines.join('\n')).toContain('loopback');
    expect(lines.filter((l) => /^(tower:|tools:|calls )/.test(l))).toEqual([]); // No read was tried, against the default tower or any other.
    const paths = resolvePaths(env);
    expect(loadConfig(paths).error).toBeTruthy();
    writeFileSync(paths.reliefJson, JSON.stringify({ towerUrl: 'http://127.0.0.1:1/mcp', extra: 1 }));
    expect(loadConfig(paths).error).toContain('unknown');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the token file', () => {
  it('is read as tower reads it: trimmed, and under 32 characters is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relief-token-'));
    const f = join(dir, 'token');
    writeFileSync(f, `  ${'x'.repeat(32)}\n`); expect(readToken(f)).toBe('x'.repeat(32));
    writeFileSync(f, 'x'.repeat(31)); expect(readToken(f)).toBeNull();
    expect(readToken(join(dir, 'missing'))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
  it('a 401 reads the file again and connects once more', async () => {
    const r = await rig();
    await r.live.collectOnce();
    expect(r.snap().sources[0]!.state).toBe('ok');
    const next = 'ROTATEDTOKEN0123456789abcdefghijklmnopqrstuvwxyz';
    r.mock.tokens.clear(); r.mock.tokens.add(next);
    writeFileSync(r.tokenFile, next);
    await r.live.collectOnce();
    expect(r.snap().sources[0]!).toMatchObject({ state: 'ok' });
  });
});
