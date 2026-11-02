// Design 7.3 and 12: TCP connect and nothing more, declared LAN hosts only, and no call at all without a `services` list.
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEdge, type EdgeFile } from '../server/collect/edge.ts';
import { applyServices, isLanAddress, runChecks, targetsOf, tcpProbe, type Probe, type Target } from '../server/collect/health.ts';
import type { Entity } from '../server/model/fact.ts';
import { checkNoFake } from '../server/model/rules.ts';
import { healthOf } from '../server/model/health.ts';
import { closeRigs, rig, type Rig } from './support/rig.ts';

afterEach(closeRigs);

const example = () => JSON.parse(readFileSync(new URL('../fixtures/edge.example.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const NODE = 'pve:node:node-1';
const svc = (title: string, host: string, port: number) => ({ title, host, protocol: 'tcp', port });
const file = (services: unknown): EdgeFile => { const e = parseEdge(JSON.stringify({ ...example(), services })); if (e.kind !== 'ok') throw new Error(e.kind); return e.file; };
const entity = (id: string, address?: string): Entity => ({ id, kind: 'node', title: id, state: 'ok', basis: 'observed', facts: address ? { address: { value: address, basis: 'observed', source: 'pve:/cluster/status', at: '2026-11-01T00:00:00.000Z', ttlS: 45 } } : {} });

describe('the probe', () => {
  const listen = (onData: (b: Buffer) => void, banner?: string) => new Promise<{ server: Server; port: number; closed: Promise<void> }>((resolve) => {
    let done: () => void; const closed = new Promise<void>((r) => { done = r; });
    const server = createServer((s) => { if (banner) s.write(banner); s.on('data', onData); s.on('error', () => {}); s.on('close', () => done()); });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, closed }));
  });
  it('connects, sends 0 bytes, and closes', async () => {
    const got: Buffer[] = [];
    const s = await listen((b) => got.push(b));
    const r = await tcpProbe('127.0.0.1', s.port, 1000);
    await s.closed;
    s.server.close();
    expect(r.up).toBe(true); expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Buffer.concat(got)).toHaveLength(0);
  });
  it('reads no banner: a service that talks first changes nothing', async () => {
    const got: Buffer[] = [];
    const s = await listen((b) => got.push(b), 'SSH-2.0-example\r\n');
    expect((await tcpProbe('127.0.0.1', s.port, 1000)).up).toBe(true);
    await s.closed; s.server.close();
    expect(got).toEqual([]);
  });
  it('a closed port is down, with the reason', async () => {
    const s = await listen(() => {}); const { port } = s;
    await new Promise<void>((r) => s.server.close(() => r()));
    const r = await tcpProbe('127.0.0.1', port, 700);
    expect(r.up).toBe(false); expect(r.latencyMs).toBeNull(); expect(r.why).toBeTruthy();
  });
  it('gives up at the timeout', async () => {
    const t0 = Date.now();
    const r = await tcpProbe('192.0.2.1', 9, 150); // RFC 5737: nothing answers there.
    expect(r.up).toBe(false); expect(Date.now() - t0).toBeLessThan(1500);
  });
  it('takes an IPv4 literal only: no name is ever resolved', async () => {
    for (const a of ['localhost', 'host.example.com', '::1', '']) expect(await tcpProbe(a, 80, 100)).toMatchObject({ up: false, why: '주소가 IPv4가 아니다' });
  });
  it('the module can do nothing but connect', () => {
    const t = readFileSync(fileURLToPath(new URL('../server/collect/health.ts', import.meta.url)), 'utf8');
    expect(t.match(/from 'node:[a-z]+'/g)).toEqual(["from 'node:net'"]);
    expect(t).not.toMatch(/\.write\(|\.end\(|\.pipe\(|\.on\('data'|\bfetch\(|node:http|node:dgram|node:dns|node:tls|lookup/);
  });
  it('only health.ts opens a socket', () => {
    const root = fileURLToPath(new URL('../server/', import.meta.url));
    for (const f of ['live.ts', 'app.ts', 'serve.ts', 'check.ts', 'collect/edge.ts', 'collect/trend.ts', 'collect/wanip.ts']) expect(readFileSync(join(root, f), 'utf8'), f).not.toMatch(/\bconnect\(\{ host|createConnection|new Socket/);
  });
});

describe('what may be a target', () => {
  it.each(['10.x.x.x', '10.x.x.x', '172.x.x.x', '172.x.x.x', '192.0.2.1', '192.0.2.10', '198.51.100.7', '203.0.113.200'])('%s is on a LAN or in the documentation ranges', (a) => { expect(isLanAddress(a)).toBe(true); });
  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '11.0.0.1', '192.167.0.1', '192.0.3.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', 'example.com', ''])('%s is refused', (a) => { expect(isLanAddress(a)).toBe(false); });

  it('a declared host goes by its lease, inside the LAN', () => {
    const t = targetsOf(file([svc('관리', 'node-1', 8006)]), [entity(NODE)]);
    expect(t).toEqual([{ id: 'node-1:8006', title: '관리', port: 8006, entity: NODE, address: '192.0.2.11' }]);
  });
  it('an observed address beats the lease and loses its prefix', () => {
    expect(targetsOf(file([svc('관리', 'node-1', 8006)]), [entity(NODE, '192.0.2.77/24')])[0]!.address).toBe('192.0.2.77');
  });
  it('a public address is refused, and never reaches a probe', async () => {
    const f = file([svc('관리', 'node-1', 8006)]);
    const t = targetsOf(f, [entity(NODE, '8.8.8.8')]);
    expect(t[0]).toMatchObject({ address: null, refused: 'LAN 주소가 아니다' });
    const probe = vi.fn<Probe>();
    expect((await runChecks(t, probe, () => 'x')).size).toBe(0);
    expect(probe).not.toHaveBeenCalled();
  });
  it('an address outside lanCidr is refused even when private', () => {
    expect(targetsOf(file([svc('관리', 'node-1', 8006)]), [entity(NODE, '10.x.x.x')])[0]).toMatchObject({ refused: 'LAN 대역 밖이다' });
  });
  it('an undeclared host cannot get in: the file is refused, and the planner refuses it again', () => {
    const r = parseEdge(JSON.stringify({ ...example(), services: [svc('x', 'nobody', 80)] }));
    expect(r).toMatchObject({ kind: 'bad' });
    const f = file([]); f.services = [{ title: 'x', host: 'nobody', protocol: 'tcp', port: 80 }];
    expect(targetsOf(f, [])[0]).toMatchObject({ address: null, refused: '선언되지 않은 호스트' });
  });
  it('a host with no address stays blank', () => {
    const e = example(); (e.hosts as { key: string; lease?: unknown }[]).find((h) => h.key === 'node-1')!.lease = undefined;
    const r = parseEdge(JSON.stringify({ ...e, services: [svc('관리', 'node-1', 8006)] }));
    expect(r.kind === 'ok' && targetsOf(r.file, [entity(NODE)])[0]).toMatchObject({ refused: '주소 미확인' });
  });
  it.each([
    ['udp', { title: 'a', host: 'node-1', protocol: 'udp', port: 53 }], ['a port of 0', { title: 'a', host: 'node-1', protocol: 'tcp', port: 0 }], ['a port past 65535', { title: 'a', host: 'node-1', protocol: 'tcp', port: 70000 }],
    ['an address of its own', { title: 'a', host: 'node-1', protocol: 'tcp', port: 80, address: '8.8.8.8' }], ['a url', { title: 'a', host: 'node-1', protocol: 'tcp', port: 80, url: 'http://x' }],
  ])('the schema refuses %s', (_n, s) => { expect(parseEdge(JSON.stringify({ ...example(), services: [s] }))).toMatchObject({ kind: 'bad' }); });
  it('the same host and port twice is a mistake in the file', () => {
    expect(parseEdge(JSON.stringify({ ...example(), services: [svc('a', 'node-1', 80), svc('b', 'node-1', 80)] }))).toMatchObject({ kind: 'bad' });
  });
});

describe('the checks', () => {
  it('run at most four at a time', async () => {
    let now = 0; let peak = 0;
    const probe: Probe = async () => { now++; peak = Math.max(peak, now); await new Promise((r) => setTimeout(r, 5)); now--; return { up: true, latencyMs: 1 }; };
    const list: Target[] = Array.from({ length: 12 }, (_, i) => ({ id: `h:${i}`, title: 't', port: i + 1, entity: null, address: '192.0.2.1' }));
    expect((await runChecks(list, probe, () => 'x')).size).toBe(12);
    expect(peak).toBe(4);
  });
  it('a host with no object reports on the router', () => {
    const e = example(); (e.hosts as unknown[]).push({ key: 'nas', title: 'NAS', kind: 'other', lease: { address: '192.0.2.60', seenAt: '2026-11-01' } });
    const r = parseEdge(JSON.stringify({ ...e, services: [svc('백업', 'nas', 22)] }));
    const gw: Entity = { ...entity('decl:gateway:edge'), kind: 'gateway' };
    expect(r.kind === 'ok' && targetsOf(r.file, [gw])[0]).toMatchObject({ entity: gw.id, address: '192.0.2.60' });
  });
  it('down is a problem on the object, unknown is neither up nor down', () => {
    const t: Target[] = [{ id: 'a', title: '가', port: 1, entity: NODE, address: '192.0.2.1' }, { id: 'b', title: '나', port: 2, entity: NODE, address: null, refused: '주소 미확인' }];
    const e = applyServices([entity(NODE)], t, new Map([['a', { at: '2026-11-01T00:00:00.000Z', result: { up: false, latencyMs: null, why: '연결 거부' } }]]), 180)[0]!;
    expect(e.services!.map((s) => s.status.value)).toEqual(['down', null]);
    expect(e.services![1]!.status).toMatchObject({ basis: 'unknown', why: '주소 미확인' });
    expect(e.alerts).toEqual([{ level: 'problem', text: '서비스 응답 없음 · 가' }]);
  });
});

describe('live', () => {
  const up: Probe = async () => ({ up: true, latencyMs: 4 });
  const on = async (r: Rig, services: unknown | undefined, probe: Probe) => {
    const edgePath = join(r.dir, 'edge.json');
    const body = example(); if (services !== undefined) body.services = services;
    writeFileSync(edgePath, JSON.stringify(body));
    r.reopen({ edgePath, probe });
    await r.live.collectOnce();
  };
  const src = (r: Rig) => r.snap().sources.find((s) => s.id === 'health')!;
  it('no `services` list: the source is none and 0 calls are made', async () => {
    const r = await rig(); const probe = vi.fn<Probe>();
    await on(r, undefined, probe);
    expect(probe).not.toHaveBeenCalled();
    expect(src(r)).toMatchObject({ state: 'none', why: '출처 없음' });
    expect(r.snap().nodes.some((n) => n.services)).toBe(false);
  });
  it('no edge file: 0 calls as well', async () => {
    const r = await rig(); const probe = vi.fn<Probe>();
    r.reopen({ probe });
    await r.live.collectOnce();
    expect(probe).not.toHaveBeenCalled();
    expect(src(r).state).toBe('none');
  });
  it('an empty list is "0 declared": no check ran, so it is no `ok`', async () => {
    const r = await rig(); const probe = vi.fn<Probe>();
    await on(r, [], probe);
    expect(probe).not.toHaveBeenCalled();
    expect(src(r)).toMatchObject({ state: 'none', count: 0, why: '0개 선언' });
  });
  it('a list with nothing to probe is no `ok` either', async () => {
    const r = await rig(); const probe = vi.fn<Probe>();
    r.mock.state.over.set('/cluster/status', { json: [{ type: 'node', name: 'node-1', ip: '8.8.8.8', online: 1 }] });
    await on(r, [svc('관리', 'node-1', 8006)], probe);
    expect(src(r)).toMatchObject({ state: 'none', count: 0, why: '검사할 대상 없음' });
    expect(checkNoFake(r.snap())).toEqual([]);
  });
  it('the source counts what was probed', async () => {
    const r = await rig();
    const e = example(); (e.hosts as { key: string; lease?: unknown }[]).find((h) => h.key === 'workstation')!.lease = undefined;
    await on(r, [svc('관리', 'node-1', 8006), svc('다른', 'node-2', 22)], up);
    expect(src(r)).toMatchObject({ state: 'ok', count: 2 });
  });
  it('an empty list never shows as waiting', async () => {
    const r = await rig();
    const edgePath = join(r.dir, 'edge.json');
    writeFileSync(edgePath, JSON.stringify({ ...example(), services: [] }));
    r.reopen({ edgePath, probe: up });
    (r.live as unknown as { prepare(): Promise<void> }).prepare();
    await new Promise((res) => setTimeout(res, 50));
    expect(src(r).state).toBe('none');
  });
  it('a new read of the file does not undo a check that ran', async () => {
    const r = await rig();
    await on(r, [svc('관리', 'node-1', 8006)], up);
    await r.live.collectOnce();
    expect(src(r).state).toBe('ok');
    const off = r.reopen({ edgePath: join(r.dir, 'edge.json'), probe: up }) as unknown as { health: { state: string; why?: string }; setEdge(x: unknown): void };
    off.health = { state: 'none', why: '0개 선언' };
    off.setEdge({ kind: 'ok', file: { ...example(), services: [svc('관리', 'node-1', 8006)] } });
    expect(off.health.state).toBe('none');                           // only "no source yet" turns to waiting
  });
  it('a list not probed yet is pending, not off', async () => {
    const r = await rig();
    const edgePath = join(r.dir, 'edge.json');
    writeFileSync(edgePath, JSON.stringify({ ...example(), services: [svc('관리', 'node-1', 8006)] }));
    r.reopen({ edgePath, probe: up });
    (r.live as unknown as { prepare(): Promise<void> }).prepare();
    await new Promise((res) => setTimeout(res, 50));
    expect(src(r)).toMatchObject({ state: 'pending', why: '첫 수집 대기' });
  });
  it('shows on the host with its latency, and the source counts the list', async () => {
    const r = await rig();
    await on(r, [svc('관리', 'node-1', 8006)], up);
    expect(r.entity(NODE)!.services).toEqual([expect.objectContaining({ title: '관리', port: 8006, latencyMs: 4, status: expect.objectContaining({ value: 'up', basis: 'observed', source: 'health:tcp', ttlS: 180 }) })]);
    expect(src(r)).toMatchObject({ state: 'ok', count: 1 });
    expect(checkNoFake(r.snap())).toEqual([]);
    expect(r.live.status().sources.map((s) => s.id)).toContain('health');
  });
  it('the probe gets the declared target and nothing else', async () => {
    const r = await rig(); const probe = vi.fn<Probe>(up);
    await on(r, [svc('관리', 'node-1', 8006)], probe);
    expect(probe.mock.calls.map((c) => c.slice(0, 2))).toEqual([['192.0.2.10', 8006]]); // The mock's /cluster/status address: observed wins over the lease.
  });
  it('down is a problem in the summary, and the source stays ok', async () => {
    const r = await rig();
    await on(r, [svc('관리', 'node-1', 8006)], async () => ({ up: false, latencyMs: null, why: '연결 거부' }));
    expect(src(r).state).toBe('ok');
    expect(healthOf(r.snap(), Date.now()).system.problems).toBe(1);
  });
  it('a down service with no object and no router still reaches the pill', async () => {
    const r = await rig();
    const e = example(); delete e.router; delete e.modem; delete e.switches; delete e.wifi; delete e.clients; delete e.dnsRecords; delete e.lines; delete e.natLayers; delete e.portForwards;
    (e.hosts as unknown[]).push({ key: 'nas', title: 'NAS', kind: 'other', lease: { address: '192.0.2.60', seenAt: '2026-11-01' } });
    (e as { services: unknown[] }).services = [svc('백업', 'nas', 22)];
    r.mock.state.over.set('/nodes/node-1/network', { json: [] }); r.mock.state.over.set('/nodes/node-2/network', { json: [] }); r.mock.state.over.set('/nodes/node-3/network', { json: [] });
    const edgePath = join(r.dir, 'edge.json'); writeFileSync(edgePath, JSON.stringify(e));
    r.reopen({ edgePath, probe: async () => ({ up: false, latencyMs: null, why: '응답 없음' }) });
    await r.live.collectOnce();
    expect(r.snap().nodes.some((n) => n.services)).toBe(false);
    expect(r.snap().unplaced).toHaveLength(1);
    expect(healthOf(r.snap(), Date.now()).system).toMatchObject({ state: 'problem', problems: 1 });
  });
  it('a latency is no change, a change of answer is one line of history', async () => {
    const r = await rig(); let now: Awaited<ReturnType<Probe>> = { up: true, latencyMs: 1 };
    await on(r, [svc('관리', 'node-1', 8006)], async () => now);
    const seq = r.snap().seq;
    now = { up: true, latencyMs: 9 }; await r.live.collectOnce();
    expect(r.snap().seq).toBe(seq); expect(r.file('changes.jsonl')).not.toContain('"services"');
    now = { up: false, latencyMs: null, why: '응답 없음' }; await r.live.collectOnce();
    expect(r.file('changes.jsonl')).toContain('"to":"응답 없음"');
  });
  it('the log names the object and the answer, not what edge.json says about the service', async () => {
    const r = await rig(); let now: Awaited<ReturnType<Probe>> = { up: true, latencyMs: 1 };
    await on(r, [svc('비밀스러운-이름', 'node-1', 8006)], async () => now);
    now = { up: false, latencyMs: null }; await r.live.collectOnce();
    const log = r.file('changes.jsonl');
    expect(log).toContain(NODE); expect(log).not.toContain('비밀스러운-이름'); expect(log).not.toContain('8006');
  });
  it('a public observed address is shown as blank with no call', async () => {
    const r = await rig(); const probe = vi.fn<Probe>(up);
    r.mock.state.over.set('/cluster/status', { json: [{ type: 'node', name: 'node-1', ip: '8.8.8.8', online: 1 }] });
    await on(r, [svc('관리', 'node-1', 8006)], probe);
    expect(probe).not.toHaveBeenCalled();
    expect(r.entity(NODE)!.services![0]!.status).toMatchObject({ basis: 'unknown', why: 'LAN 주소가 아니다' });
    expect(healthOf(r.snap(), Date.now()).system.blanks).toBeGreaterThanOrEqual(1);
  });
});
