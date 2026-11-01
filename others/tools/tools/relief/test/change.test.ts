// Design 8 and 12, change row: what counts as a change, when a guest shows as coming up, and how often PVE is read.
import { describe, expect, it, afterEach } from 'vitest';
import { closeRigs, rig } from './support/rig.ts';
import { activeTask, guestState, STUCK_S, YOUNG_S } from '../server/model/normalize.ts';
import type { Resource, Task } from '../server/collect/pve.ts';
import { createApi } from '../server/app.ts';
import { diff, entityHash, hashesOf } from '../server/model/diff.ts';
import { PERIOD } from '../server/live.ts';
import { today } from '../dev/fixtures/gen.ts';
import { networkOf, sameDefaultGateway, sameSubnet } from '../server/model/rules.ts';
import { layoutSnapshot } from '../server/layout/elk.ts';

afterEach(closeRigs);

const NOW = 1_793_500_000_000;
const sec = NOW / 1000;
const g = (over: Partial<Resource> = {}): Resource => ({ id: 'qemu/100', type: 'qemu', vmid: 100, node: 'node-1', status: 'stopped', ...over });
const t = (type: string, over: Partial<Task> = {}): Task => ({ node: 'node-1', type, id: '100', start: sec - 2, end: null, ok: null, ...over });

describe('the state table', () => {
  it.each([
    ['qmcreate', 'creating'], ['vzcreate', 'creating'], ['qmclone', 'creating'],
    ['qmstart', 'starting'], ['vzstart', 'starting'],
    ['qmstop', 'stopping'], ['qmshutdown', 'stopping'], ['vzstop', 'stopping'], ['vzshutdown', 'stopping'],
    ['qmigrate', 'migrating'], ['vzmigrate', 'migrating'],
  ])('a running %s is %s', (type, want) => { expect(guestState(g(), [t(type)], NOW)).toMatchObject({ state: want, task: type }); });
  it('running and stopped come from status', () => {
    expect(guestState(g({ status: 'running', uptime: 9000 }), [], NOW).state).toBe('running');
    expect(guestState(g(), [], NOW).state).toBe('stopped');
    expect(guestState(g({ status: 'paused' }), [], NOW).state).toBe('unknown');
  });
  it('a finished task says nothing, a failed one is an error', () => {
    expect(guestState(g(), [t('qmstart', { end: sec - 1, ok: true })], NOW).state).toBe('stopped');
    expect(guestState(g(), [t('qmstart', { end: sec - 1, ok: false })], NOW).state).toBe('error');
  });
  it('the latest lifecycle task decides', () => {
    expect(guestState(g(), [t('qmstart', { start: sec - 90, end: sec - 80, ok: false }), t('qmstart', { start: sec - 20, end: sec - 10, ok: true })], NOW).state).toBe('stopped');
  });
  it('a failed console session is no guest error, and shows as a task while it runs', () => {
    expect(guestState(g(), [t('vncproxy', { end: sec - 1, ok: false })], NOW).state).toBe('stopped');
    expect(guestState(g({ status: 'running', uptime: 9000 }), [t('vncproxy')], NOW)).toEqual({ state: 'running', task: 'vncproxy' });
  });
  it('a start that ended between two reads still shows: a young guest is coming up', () => {
    expect(guestState(g({ status: 'running', uptime: YOUNG_S - 1 }), [], NOW).state).toBe('starting');
    expect(guestState(g({ status: 'running', uptime: YOUNG_S }), [], NOW).state).toBe('running');
  });
  it('startall lights stopped guests of that node only', () => {
    const all = t('startall', { id: '' });
    expect(guestState(g(), [all], NOW).state).toBe('starting');
    expect(guestState(g({ status: 'running', uptime: 9000 }), [all], NOW).state).toBe('running');
    expect(guestState(g({ node: 'node-2' }), [all], NOW).state).toBe('stopped');
  });
  it('a task the node lost stops counting', () => {
    expect(guestState(g(), [t('qmstart', { start: sec - STUCK_S - 1 })], NOW).state).toBe('stopped');
  });
});

describe('the 5 s pace', () => {
  it('follows lifecycle tasks, not a console session that never ended', () => {
    expect(activeTask([t('qmstart')], NOW)).toBe(true);
    expect(activeTask([t('startall', { id: '' })], NOW)).toBe(true);
    expect(activeTask([t('vncshell', { id: '' })], NOW)).toBe(false);
    expect(activeTask([t('qmstart', { start: sec - STUCK_S - 1 })], NOW)).toBe(false);
    expect(activeTask([t('qmstart', { end: sec, ok: true })], NOW)).toBe(false);
  });
  it('the mock cluster carries such a session, and the pace stays 15 s', async () => {
    const r = await rig();
    r.mock.state.tasks[1]!.starttime = Math.floor(Date.now() / 1000) - 5;
    r.live.touch();
    await r.live.collectOnce();
    const period = (r.live as unknown as { fastPeriodS(): number }).fastPeriodS();
    expect(period).toBe(PERIOD.fastS);
    r.mock.state.tasks.push({ node: 'node-1', id: '100', type: 'qmstart', starttime: Math.floor(Date.now() / 1000) - 1 });
    await r.live.collectOnce();
    expect((r.live as unknown as { fastPeriodS(): number }).fastPeriodS()).toBe(PERIOD.activeS);
  });
  it('no viewer for 2 minutes slows it to 60 s', async () => {
    let now = Date.now();
    const r = await rig({ now: () => now });
    r.live.touch();
    await r.live.collectOnce();
    const p = () => (r.live as unknown as { fastPeriodS(): number }).fastPeriodS();
    expect(p()).toBe(15);
    now += 121_000;
    expect(p()).toBe(60);
    r.live.touch();
    expect(p()).toBe(15);
  });
});

describe('seq', () => {
  it('holds when only metrics move, and the served revision moves on', async () => {
    const r = await rig();
    await r.live.collectOnce();
    const a = r.live.view();
    const lines = r.file('changes.jsonl').trim().split('\n').length;
    r.mock.state.cpu = 0.77;
    await r.live.collectOnce();
    const b = r.live.view();
    expect(b.snapshot.seq).toBe(a.snapshot.seq);
    expect(b.etag).not.toBe(a.etag);
    expect(r.entity('pve:node:node-1')?.facts.cpu?.value).toBe(0.77);
    expect(r.file('changes.jsonl').trim().split('\n')).toHaveLength(lines);
  });
  it('moves on a state change, and the log says what', async () => {
    const r = await rig();
    await r.live.collectOnce();
    const a = r.snap().seq;
    r.mock.state.guests[0]!.status = 'stopped';
    await r.live.collectOnce();
    expect(r.snap().seq).toBeGreaterThan(a);
    const states = r.file('changes.jsonl').trim().split('\n').flatMap((l) => (JSON.parse(l) as { state?: unknown[] }).state ?? []);
    expect(states).toContainEqual({ id: 'pve:qemu:100', from: 'running', to: 'stopped' });
  });
  it('moves on a new guest, which takes its slot without moving anyone', async () => {
    const r = await rig();
    await r.live.collectOnce();
    const before = r.snap().layout;
    const a = r.snap().seq;
    r.mock.state.guests.push({ vmid: 50, node: 'node-1', name: 'guest-b', status: 'running', type: 'lxc', uptime: 9000 });
    await r.live.collectOnce();
    expect(r.snap().seq).toBeGreaterThan(a);
    expect(r.entity('pve:lxc:50')?.kind).toBe('lxc');
    for (const id of Object.keys(before)) expect(r.snap().layout[id], id).toEqual(before[id]);
  });
  it('the hash ignores `at` and counters, and reads everything else', () => {
    const s = today();
    const vm = s.nodes.find((n) => n.kind === 'vm')!;
    const h = entityHash(vm);
    expect(entityHash({ ...vm, facts: { ...vm.facts, cpu: { ...vm.facts.cpu!, value: 0.99, at: 'x' }, state: { ...vm.facts.state!, at: 'y' } } })).toBe(h);
    expect(entityHash({ ...vm, state: 'stopped' })).not.toBe(h);
    expect(entityHash({ ...vm, title: 'other' })).not.toBe(h);
    expect(entityHash({ ...vm, parent: 'pve:node:node-2' })).not.toBe(h);
    expect(diff(hashesOf(s.nodes, s.edges), hashesOf(s.nodes, s.edges), {}, {})).toEqual({ added: [], removed: [], changed: [], state: [] });
  });
  it('the change log is cut at its limit', async () => {
    const r = await rig();
    const l = r.live as unknown as { changeLines: number; log(x: object): void };
    l.log({ a: 1 }); l.changeLines = 5600; l.log({ a: 2 });
    expect(r.file('changes.jsonl').trim().split('\n')).toHaveLength(2);
    expect(l.changeLines).toBe(2);
  });
});

describe('coming up, through the API', () => {
  it('a task appears and the next read says starting, with its task in the panel', async () => {
    const r = await rig();
    r.mock.state.guests[0]!.status = 'stopped';
    await r.live.collectOnce();
    expect(r.entity('pve:qemu:100')?.state).toBe('stopped');
    r.mock.state.tasks.unshift({ node: 'node-1', id: '100', type: 'qmstart', starttime: Math.floor(Date.now() / 1000), pid: 1, saved: '0' });
    await r.live.collectOnce();
    const api = createApi({ live: r.live });
    const res = await api.request('http://127.0.0.1:4815/api/snapshot', { headers: { host: '127.0.0.1:4815' } });
    const s = await res.json() as { nodes: { id: string; state: string; facts: Record<string, { value: unknown }> }[]; origin: string };
    const vm = s.nodes.find((n) => n.id === 'pve:qemu:100')!;
    expect(s.origin).toBe('live');
    expect(vm.state).toBe('starting');
    expect(vm.facts.task!.value).toBe('qmstart');
  });
  it('answers 304 until something is published, and serves no fixture next to live data', async () => {
    const r = await rig();
    await r.live.collectOnce();
    const api = createApi({ live: r.live });
    const hdr = { host: '127.0.0.1:4815' };
    const a = await api.request('http://127.0.0.1:4815/api/snapshot', { headers: hdr });
    const etag = a.headers.get('etag')!;
    const b = await api.request('http://127.0.0.1:4815/api/snapshot', { headers: { ...hdr, 'if-none-match': etag } });
    expect(b.status).toBe(304);
    await r.live.collectOnce();
    expect((await api.request('http://127.0.0.1:4815/api/snapshot', { headers: { ...hdr, 'if-none-match': etag } })).status).toBe(200);
    expect((await api.request('http://127.0.0.1:4815/api/snapshot?fixture=large', { headers: hdr })).status).toBe(404);
  });
  it('metrics are read only while the overlay asks', async () => {
    const r = await rig();
    const a = r.live as unknown as { metricsAdapter(): { read(s: AbortSignal): Promise<unknown> } };
    const sig = new AbortController().signal;
    expect(await a.metricsAdapter().read(sig)).toBeNull();
    expect(r.mock.calls).toEqual([]);
    r.live.viewMetrics();
    expect(await a.metricsAdapter().read(sig)).toMatchObject({ 'pve:node:node-1': { cpu: 0.05, mem: 0.25 } });
    expect(r.mock.calls.map((c) => c.args.path)).toEqual(['/cluster/metrics/export']);
  });
});

describe('call counts', () => {
  it('fast 3, slow 3 per node + 3, guest 3: a full collection is 18 calls on three nodes and one guest', async () => {
    const r = await rig();
    await r.live.collectOnce();
    expect(r.mock.calls).toHaveLength(3 + 3 * 3 + 3 + 3);
    expect(r.reader.record.total).toBe(r.mock.calls.length);
    expect(r.live.status().calls.byLabel.proxmox_list_resources).toBe(1);
  });
  it('the active pace plus the browser poll stays inside the 10 s budget', () => { expect(PERIOD.activeS + 5).toBeLessThan(10); });
  it('a quiet guest is not read again until its round', async () => {
    const r = await rig();
    await r.live.collectOnce();
    const n = r.mock.calls.filter((c) => c.name === 'proxmox_guest_config').length;
    await r.live.collectOnce();
    expect(r.mock.calls.filter((c) => c.name === 'proxmox_guest_config')).toHaveLength(n);
  });
  it('a failed guest waits 30 minutes, a good one 10', async () => {
    let now = Date.now();
    const r = await rig({ now: () => now });
    r.mock.state.guests[0]!.agent = false;
    await r.live.collectOnce();
    const count = () => r.mock.calls.filter((c) => c.name === 'proxmox_guest_config').length;
    expect(count()).toBe(1);
    now += 20 * 60_000; await r.live.collectOnce();
    expect(count()).toBe(1);
    now += 11 * 60_000; await r.live.collectOnce();
    expect(count()).toBe(2);
  });
});

describe('derivation rules', () => {
  const wire = (o: Partial<{ cidr: string | null; gateway: string | null }>) => ({ node: 'n', iface: 'vmbr0', cidr: null, gateway: null, ...o });
  it('make nothing from nothing', () => {
    expect(sameSubnet([]).size).toBe(0);
    expect(sameDefaultGateway([wire({})]).size).toBe(0);
  });
  it('group by network and by gateway', () => {
    expect([...sameSubnet([wire({ cidr: '192.0.2.10/24' }), wire({ cidr: '192.0.2.20/24' }), wire({ cidr: '198.51.100.1/24' })].slice(0, 3)).keys()]).toEqual(['192.0.2.0/24', '198.51.100.0/24']);
    expect(networkOf('192.0.2.200/25')).toBe('192.0.2.128/25');
    expect(networkOf('fe80::1/64')).toBeNull();
    expect(networkOf('999.0.0.1/24')).toBeNull();
  });
  it('the live map has one gateway, one segment and three uplinks on the mock', async () => {
    const r = await rig();
    await r.live.collectOnce();
    const s = r.snap();
    expect(s.nodes.filter((n) => n.kind === 'gateway').map((n) => n.basis)).toEqual(['derived']);
    expect(s.nodes.filter((n) => n.kind === 'segment').map((n) => n.id)).toEqual(['net:seg:192.0.2.0/24']);
    expect(s.edges.filter((e) => e.kind === 'uplink')).toHaveLength(3);
    expect(s.edges.filter((e) => e.kind === 'attached').map((e) => e.source)).toEqual(['pve:br:node-1:vmbr0']);
    expect(s.edges.filter((e) => e.kind === 'mounts').map((e) => e.target)).toEqual(['pve:st:node-1:local-lvm']);
    expect(Object.keys((await layoutSnapshot(s)).routes).length).toBeGreaterThan(3);
    expect(s.nodes.length).toBe(1 + 1 + 1 + 3 + 3 + 6 + 1); // same 16-object shape as the fixture
  });
});
