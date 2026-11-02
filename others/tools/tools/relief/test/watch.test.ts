// Design 9.14: an object that vanishes or dies leaves no value to compare. The memory of what was there turns that into a finding, across a restart.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEdge } from '../server/collect/edge.ts';
import type { Task } from '../server/collect/pve.ts';
import type { Entity } from '../server/model/fact.ts';
import { healthOf } from '../server/model/health.ts';
import { advance, applyWatch, emptyWatch, type Watch } from '../server/model/watch.ts';
import { closeRigs, rig, type Rig } from './support/rig.ts';

afterEach(closeRigs);

const AT = '2026-11-01T09:00:00.000Z'; const T = Date.parse(AT) / 1000; const LATER = '2026-11-01T09:01:00.000Z';
const vm = (state: Entity['state'], over: Partial<Entity> = {}): Entity => ({ id: 'pve:qemu:100', kind: 'vm', title: 'v', parent: 'pve:node:n1', state, basis: 'observed', facts: {}, ...over });
const task = (type: string, over: Partial<Task> = {}): Task => ({ node: 'n1', type, id: '100', start: T + 10, end: T + 11, ok: true, ...over });
const seen = (state: Entity['state']) => advance(emptyWatch(), [vm(state)], [], AT);
const alerts = (w: Watch, state: Entity['state'], want?: 'running' | 'stopped') => applyWatch([vm(state)], w, new Map(want ? [['100', want]] : []))[0]!.alerts;

describe('a guest that stopped', () => {
  it('from running, with no task, is a warning', () => {
    const w = advance(seen('running'), [vm('stopped')], [], LATER);
    expect(alerts(w, 'stopped')).toEqual([{ level: 'warn', text: '예상 밖 중지' }]);
  });
  it.each(['qmstop', 'qmshutdown', 'vzstop', 'vzshutdown'])('a %s explains it', (type) => {
    expect(alerts(advance(seen('running'), [vm('stopped')], [task(type)], LATER), 'stopped')).toBeUndefined();
  });
  it('a stopall on its own node explains it, on another does not', () => {
    expect(alerts(advance(seen('running'), [vm('stopped')], [task('stopall', { id: '' })], LATER), 'stopped')).toBeUndefined();
    expect(alerts(advance(seen('running'), [vm('stopped')], [task('stopall', { id: '', node: 'n2' })], LATER), 'stopped')).toHaveLength(1);
  });
  it('a stop task of another guest, or an old one, explains nothing', () => {
    expect(alerts(advance(seen('running'), [vm('stopped')], [task('qmstop', { id: '101' })], LATER), 'stopped')).toHaveLength(1);
    expect(alerts(advance(seen('running'), [vm('stopped')], [task('qmstop', { start: T - 3600 })], LATER), 'stopped')).toHaveLength(1);
  });
  it('a task up to a minute before the last read that saw it running counts, an older one does not', () => {
    expect(alerts(advance(seen('running'), [vm('stopped')], [task('qmstop', { start: T - 60 })], LATER), 'stopped')).toBeUndefined();
    expect(alerts(advance(seen('running'), [vm('stopped')], [task('qmstop', { start: T - 61 })], LATER), 'stopped')).toHaveLength(1);
  });
  it('a task seen one read later clears it', () => {
    const w = advance(seen('running'), [vm('stopped')], [], LATER);
    expect(alerts(advance(w, [vm('stopped')], [task('qmshutdown')], LATER), 'stopped')).toBeUndefined();
  });
  it('clears when it runs again, and stays until then', () => {
    const w = advance(seen('running'), [vm('stopped')], [], LATER);
    expect(advance(w, [vm('stopped')], [], LATER).crashed['pve:qemu:100']).toBeDefined();
    expect(advance(w, [vm('running')], [], LATER).crashed).toEqual({});
  });
  it('stopped since relief first saw it is neutral', () => { expect(alerts(advance(seen('stopped'), [vm('stopped')], [], LATER), 'stopped')).toBeUndefined(); });
  it('a node is no guest: it cannot crash this way', () => {
    const n = (s: Entity['state']): Entity => ({ ...vm(s), id: 'pve:node:n1', kind: 'node', parent: undefined as never });
    expect(advance(advance(emptyWatch(), [n('running')], [], AT), [n('stopped')], [], LATER).crashed).toEqual({});
  });
});

describe('expected', () => {
  const crashed = advance(seen('running'), [vm('stopped')], [], LATER);
  it('running but stopped is a problem, whatever the tasks say', () => {
    expect(alerts(emptyWatch(), 'stopped', 'running')).toEqual([{ level: 'problem', text: '실행 예정인데 중지' }]);
    expect(alerts(crashed, 'stopped', 'running')).toEqual([{ level: 'problem', text: '실행 예정인데 중지' }]);
  });
  it('running and running is nothing', () => { expect(alerts(emptyWatch(), 'running', 'running')).toBeUndefined(); });
  it('stopped overrides a stop with no task', () => { expect(alerts(crashed, 'stopped', 'stopped')).toBeUndefined(); });
  it('the file takes it, and refuses anything else; the login name is now optional', () => {
    const file = (g: unknown) => JSON.stringify({ schema: 1, declaredAt: '2026-11-01', guests: [g] });
    expect(parseEdge(file({ key: 'g', vmid: 100, expected: 'running' })).kind).toBe('ok');
    expect(parseEdge(file({ key: 'g', vmid: 100, expected: 'maybe' })).kind).toBe('bad');
  });
  it('an LXC takes it too, and a node never does', () => {
    const ct = vm('stopped', { id: 'pve:lxc:100', kind: 'lxc' });
    expect(applyWatch([ct], emptyWatch(), new Map([['100', 'running']]))[0]!.alerts).toHaveLength(1);
    expect(applyWatch([vm('stopped', { id: 'pve:node:100', kind: 'node' })], emptyWatch(), new Map([['100', 'running']]))[0]!.alerts).toBeUndefined();
  });
  it('another guest is not affected', () => { expect(applyWatch([vm('stopped', { id: 'pve:qemu:101' })], emptyWatch(), new Map([['100', 'running']]))[0]!.alerts).toBeUndefined(); });
});

describe('an object that vanished', () => {
  const start = (e: Entity) => advance(emptyWatch(), [e], [], AT);
  it('is missing from the next good read, with when', () => {
    expect(advance(start(vm('running')), [], [], LATER).missing).toEqual({ 'pve:qemu:100': { id: 'pve:qemu:100', kind: 'vm', title: 'v', since: LATER } });
  });
  it('keeps its first time', () => {
    const a = advance(start(vm('running')), [], [], LATER);
    expect(advance(a, [], [], '2026-11-01T09:05:00.000Z').missing['pve:qemu:100']!.since).toBe(LATER);
  });
  it('clears when it comes back', () => { expect(advance(advance(start(vm('running')), [], [], LATER), [vm('running')], [], LATER).missing).toEqual({}); });
  it('a destroy task explains it, and it is forgotten', () => {
    for (const type of ['qmdestroy', 'vzdestroy']) { const w = advance(start(vm('running')), [], [task(type)], LATER); expect(w.missing).toEqual({}); expect(w.known).toEqual({}); }
  });
  it('a destroy task of another guest, an old one, or another kind of task explains nothing', () => {
    for (const t of [task('qmdestroy', { id: '101' }), task('qmdestroy', { start: T - 3600 }), task('qmstop')]) expect(Object.keys(advance(start(vm('running')), [], [t], LATER).missing)).toEqual(['pve:qemu:100']);
  });
  it('a gone outline does not count as there', () => { expect(Object.keys(advance(start(vm('running')), [vm('running', { gone: true })], [], LATER).missing)).toEqual(['pve:qemu:100']); });
  it('only nodes and guests are remembered', () => { expect(start(vm('ok', { id: 'pve:st:n:x', kind: 'storage' })).known).toEqual({}); });
});

describe('live', () => {
  const pill = (r: Rig) => healthOf(r.snap(), Date.now()).system;
  it('a vanished node is a problem, and stays one over a restart', async () => {
    const r = await rig();
    await r.live.collectOnce();
    const list = (r.mock.state.over.get('proxmox_list_resources'));
    expect(list).toBeUndefined();
    const all = await (async () => { const c = r.reader.read({ tool: 'proxmox_list_resources' }); return (await c) as { id: string; node?: string }[]; })();
    r.mock.state.over.set('proxmox_list_resources', { json: all.filter((x) => x.node !== 'node-3') });
    await r.live.collectOnce();
    expect(r.snap().missing?.map((m) => m.id)).toEqual(['pve:node:node-3']);
    expect(pill(r)).toMatchObject({ state: 'problem', problems: 1 });
    await r.live.stop();
    r.reopen();
    await r.live.collectOnce();
    expect(r.snap().missing?.map((m) => m.id)).toEqual(['pve:node:node-3']);
    r.mock.state.over.delete('proxmox_list_resources');
    await r.live.collectOnce();
    expect(r.snap().missing).toBeUndefined();
  });
  it('a failed read says nothing is missing', async () => {
    const r = await rig();
    await r.live.collectOnce();
    r.mock.state.all = { isError: 'TIMEOUT: x' };
    await r.live.collectOnce();
    expect(r.snap().missing).toBeUndefined();
  });
  it('a guest that dies with no task is a warning on the object and in the pill', async () => {
    const r = await rig();
    await r.live.collectOnce();
    r.mock.state.guests[0]!.status = 'stopped';
    await r.live.collectOnce();
    expect(r.entity('pve:qemu:100')!.alerts).toEqual([{ level: 'warn', text: '예상 밖 중지' }]);
    expect(pill(r).findings.some((f) => f.why === '예상 밖 중지')).toBe(true);
    r.mock.state.guests[0]!.status = 'running';
    await r.live.collectOnce();
    expect(r.entity('pve:qemu:100')!.alerts).toBeUndefined();
  });
  it('expected running from the file makes a stopped guest a problem', async () => {
    const r = await rig();
    const edgePath = join(r.dir, 'edge.json');
    writeFileSync(edgePath, JSON.stringify({ schema: 1, declaredAt: '2026-11-01', guests: [{ key: 'g', vmid: 100, expected: 'running' }] }));
    r.mock.state.guests[0]!.status = 'stopped';
    r.reopen({ edgePath });
    await r.live.collectOnce();
    expect(r.entity('pve:qemu:100')!.alerts).toEqual([{ level: 'problem', text: '실행 예정인데 중지' }]);
    expect(pill(r).state).toBe('problem');
    expect(r.entity('pve:qemu:100')!.facts.expected).toMatchObject({ value: 'running', basis: 'declared' });
  });
  it.each([['proxmox_recent_tasks', '태스크'], ['/cluster/status', '클러스터 상태']])('%s answering 403 blocks healthy while it lasts', async (key, name) => {
    const r = await rig();
    await r.live.collectOnce();
    r.mock.state.over.set(key, { isError: 'PVE API 403: no' });
    await r.live.collectOnce();
    const pve = r.snap().sources.find((s) => s.id === 'pve')!;
    expect(pve).toMatchObject({ state: 'ok', partial: [{ name, why: 'PVE API 403' }] });
    expect(pill(r).state).toBe('stale');
    r.mock.state.over.delete(key);
    await r.live.collectOnce();
    expect(r.snap().sources.find((s) => s.id === 'pve')!.partial).toBeUndefined();
  });
});
