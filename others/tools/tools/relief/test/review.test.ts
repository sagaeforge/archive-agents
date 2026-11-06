// Regressions from review. Each one failed on the code before its fix.
import http from 'node:http';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startMock } from '../dev/mcp-mock/mock.ts';
import { createReader } from '../server/collect/mcp.ts';
import { freshness } from '../server/model/fact.ts';
import { startLive } from '../server/serve.ts';
import { closeRigs, rig, TOKEN, type Rig } from './support/rig.ts';

afterEach(closeRigs);

const pve = (r: Rig) => r.snap().sources.find((s) => s.id === 'pve')!;
const store = (r: Rig) => r.snap().sources.find((s) => s.id === 'store');
const internals = (r: Rig) => r.live as unknown as { build(i: boolean): Promise<void>; applyFast(x: unknown): Promise<void>; fastAdapter(): { read(s: AbortSignal): Promise<unknown> }; metricsAdapter(): { read(s: AbortSignal): Promise<unknown> } };

describe('one failed write or build does not freeze the map', () => {
  it('a state directory lost for one cycle: the map keeps moving, the fault shows and clears, stop still saves', async () => {
    const r = await rig();
    await r.live.collectOnce();
    const a = r.snap().seq;
    // Something that cannot be written through, and that mkdir cannot fix.
    renameSync(r.stateDir, `${r.stateDir}.away`);
    writeFileSync(r.stateDir, 'not a directory');
    r.mock.state.guests.push({ vmid: 200, node: 'node-2', name: 'guest-c', status: 'running', type: 'qemu', uptime: 9000 });
    await r.live.collectOnce();
    expect(r.entity('pve:qemu:200')).toBeDefined();
    expect(r.snap().seq).toBeGreaterThan(a);
    expect(store(r)).toMatchObject({ state: 'failing', why: '상태 저장 실패' });
    expect(pve(r).state).toBe('ok');
    rmSync(r.stateDir);
    renameSync(`${r.stateDir}.away`, r.stateDir);
    r.mock.state.guests.push({ vmid: 201, node: 'node-2', name: 'guest-d', status: 'running', type: 'qemu', uptime: 9000 });
    await r.live.collectOnce();
    expect(r.entity('pve:qemu:201')).toBeDefined();
    expect(store(r)).toBeUndefined();
    await expect(r.live.stop()).resolves.toBeUndefined();
    expect(r.file('state.json')).toContain('guest-d');
  });
  it('one build that throws: the source says so, the next build works, stop resolves', async () => {
    const r = await rig();
    await r.live.collectOnce();
    const real = internals(r).build;
    internals(r).build = () => Promise.reject(new Error('layout broke'));
    r.mock.state.guests.push({ vmid: 200, node: 'node-2', name: 'guest-c', status: 'running', type: 'qemu', uptime: 9000 });
    await internals(r).applyFast(await internals(r).fastAdapter().read(new AbortController().signal));
    expect(pve(r)).toMatchObject({ state: 'failing', why: '스냅샷 생성 실패' });
    expect(r.entity('pve:qemu:200')).toBeUndefined();
    internals(r).build = real;
    await r.live.collectOnce();
    expect(pve(r).state).toBe('ok');
    expect(r.entity('pve:qemu:200')).toBeDefined();
    await expect(r.live.stop()).resolves.toBeUndefined();
    expect(r.file('state.json')).toContain('guest-c');
  });
  it('an unusable state directory at start is a fault, not a crash', async () => {
    const r = await rig();
    const bad = join(r.dir, 'file');
    writeFileSync(bad, 'x');
    const live = r.reopen({ stateDir: join(bad, 'sub') });
    await live.collectOnce();
    expect(pve(r).state).toBe('ok');
    expect(store(r)).toMatchObject({ state: 'failing' });
  });
});

describe('a QEMU disk stays unknown', () => {
  const metrics = (disk_used: number) => ({ json: { data: [{ id: 'qemu/100', metric: 'cpu_current', value: 0.5 }, { id: 'qemu/100', metric: 'disk_used', value: disk_used }, { id: 'qemu/100', metric: 'disk_total', value: 100 }, { id: 'lxc/101', metric: 'disk_used', value: 0 }, { id: 'lxc/101', metric: 'disk_total', value: 100 }] } });
  it('a metric of 0 is not an observation', async () => {
    const r = await rig();
    r.live.viewMetrics();
    r.mock.state.over.set('/cluster/metrics/export', metrics(0));
    const { values: v } = await internals(r).metricsAdapter().read(new AbortController().signal) as { values: Record<string, { cpu?: number; disk?: number }> };
    expect(v['pve:qemu:100']).toEqual({ cpu: 0.5 });
    expect(v['pve:lxc:101']).toEqual({ disk: 0 }); // An LXC reports its real use, and 0 is a value there.
  });
  it('a real value passes', async () => {
    const r = await rig();
    r.live.viewMetrics();
    r.mock.state.over.set('/cluster/metrics/export', metrics(25));
    const { values: v } = await internals(r).metricsAdapter().read(new AbortController().signal) as { values: Record<string, { disk?: number }> };
    expect(v['pve:qemu:100']!.disk).toBe(0.25);
  });
});

describe('a guest with no agent', () => {
  it('is not stale while it waits for its 30-minute retry', async () => {
    let now = Date.now();
    const r = await rig({ now: () => now });
    r.mock.state.guests[0]!.agent = false;
    r.live.touch();
    await r.live.collectOnce();
    now += 31 * 60_000;
    r.live.touch();
    await internals(r).applyFast(await internals(r).fastAdapter().read(new AbortController().signal));
    const g = r.entity('pve:qemu:100')!;
    expect(g.facts.nic!.basis).toBe('observed');
    expect(freshness(g.facts.nic!, now)).toBe('fresh');
    expect(freshness(g.facts.cores!, now)).toBe('fresh');
  });
  it('still goes stale when the retry never comes', async () => {
    let now = Date.now();
    const r = await rig({ now: () => now });
    r.mock.state.guests[0]!.agent = false;
    await r.live.collectOnce();
    now += 91 * 60_000;
    expect(freshness(r.entity('pve:qemu:100')!.facts.nic!, now)).toBe('stale');
  });
});

describe('the reader stays on loopback', () => {
  it('a redirect is not followed: the target sees nothing', async () => {
    const target = await startMock({ port: 0, token: TOKEN });
    let hits = 0;
    const redirector = http.createServer((req, res) => { hits += 1; res.writeHead(307, { location: target.url }); res.end(); });
    await new Promise<void>((res) => redirector.listen(0, '127.0.0.1', () => res()));
    const { port } = redirector.address() as { port: number };
    const reader = createReader({ url: `http://127.0.0.1:${port}/mcp`, token: () => TOKEN });
    await expect(reader.read({ tool: 'proxmox_list_resources' })).rejects.toMatchObject({ why: 'tower 응답 없음' });
    expect(hits).toBeGreaterThan(0);
    expect(target.requests.value).toBe(0);
    await reader.close(); redirector.close(); await target.close();
  });
});

describe('the reader takes no redirect at all', () => {
  it('not even within the origin, which the SDK alone would follow with the token', async () => {
    const other: string[] = [];
    const srv = http.createServer((req, res) => {
      if (req.url === '/mcp') { res.writeHead(307, { location: '/elsewhere' }); res.end(); return; }
      other.push(req.url ?? ''); res.writeHead(404); res.end();
    });
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
    const { port } = srv.address() as { port: number };
    const reader = createReader({ url: `http://127.0.0.1:${port}/mcp`, token: () => TOKEN });
    await expect(reader.read({ tool: 'proxmox_list_resources' })).rejects.toMatchObject({ scope: 'source' });
    expect(other).toEqual([]);
    await reader.close(); srv.close();
  });
});

describe('the fast read', () => {
  it('a source-wide failure on /cluster/status alone fails the source, and nothing moves', async () => {
    const r = await rig();
    await r.live.collectOnce();
    const at = pve(r).at;
    r.mock.state.over.set('/cluster/status', { isError: 'upstream proxmox is down: restarting' });
    await new Promise((res) => setTimeout(res, 5));
    await internals(r).applyFast(await internals(r).fastAdapter().read(new AbortController().signal));
    expect(pve(r)).toMatchObject({ state: 'failing', why: 'proxmox 업스트림 다운', at });
  });
  it('the same on the task list', async () => {
    const r = await rig();
    await r.live.collectOnce();
    r.mock.state.over.set('proxmox_recent_tasks', { isError: 'TIMEOUT: no host' });
    await internals(r).applyFast(await internals(r).fastAdapter().read(new AbortController().signal));
    expect(pve(r)).toMatchObject({ state: 'failing', why: 'PVE TIMEOUT' });
  });
});

describe('relief serve', () => {
  it('binds 127.0.0.1 and nothing wider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relief-bind-'));
    mkdirSync(join(dir, 'tower'));
    const s = await startLive({ port: 0, dist: dir, env: { TOWER_CONFIG: join(dir, 'tower/tower.json'), RELIEF_CONFIG: dir, RELIEF_STATE: join(dir, 'state') } });
    expect(s.host).toBe('127.0.0.1');
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
