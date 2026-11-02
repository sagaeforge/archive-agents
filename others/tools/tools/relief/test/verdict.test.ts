// Design 9.14: one function says how something is. Healthy needs evidence, missing is not "not applicable", and no surface works it out for itself.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generate, large, today } from '../dev/fixtures/gen.ts';
import type { Entity, Fact, Snapshot } from '../server/model/fact.ts';
import { healthOf, objectHealth } from '../server/model/health.ts';
import { DEFAULT_LIMITS } from '../server/model/threshold.ts';
import { holes } from '../src/model.ts';

const NOW = Date.parse('2026-11-01T09:00:00.000Z'); const AT = new Date(NOW).toISOString();
const obs = (value: unknown): Fact<unknown> => ({ value, basis: 'observed', source: 'pve:/cluster/resources', at: AT, ttlS: 45 });
const below = { value: '임계 미만 · 90%', basis: 'derived' as const, source: 'rule:threshold', at: AT, ttlS: null };
const blank = (why = '비교 불가 · 표본 0/45 s'): Fact<unknown> => ({ value: null, basis: 'unknown', source: 'rule:threshold', at: null, ttlS: null, why });
const facts = (over: Record<string, Fact<unknown>> = {}) => ({ state: obs('online'), cpu: obs(0.1), mem: obs(0.1), disk: obs(0.1), checkCpu: below, checkMem: below, checkDisk: below, ...over });
const ent = (over: Partial<Entity> = {}): Entity => ({ id: 'x', kind: 'node', title: 'x', state: 'ok', basis: 'observed', facts: facts(), ...over });
const of = (e: Entity, stale = false) => objectHealth(e, { stale, limits: DEFAULT_LIMITS, nowMs: NOW });
const system = (nodes: Entity[], over: Partial<Snapshot> = {}) => healthOf({ nodes, sources: [{ id: 'pve', state: 'ok', count: 1, at: AT }], takenAt: AT, limits: DEFAULT_LIMITS, ...over }, NOW).system;

describe('an object', () => {
  it('is healthy with every required check fresh and under its limit', () => { expect(of(ent())).toMatchObject({ state: 'healthy', word: '정상', required: 4, met: 4, missing: [] }); });
  it('one blank required check is unknown, with what is missing', () => { expect(of(ent({ facts: facts({ checkMem: blank() }) }))).toMatchObject({ state: 'unknown', word: '미확인', met: 3, missing: ['메모리'] }); });
  it('a check that is not there at all is missing too', () => {
    const f = facts(); delete (f as Record<string, unknown>).checkCpu;
    expect(of(ent({ facts: f })).missing).toEqual(['CPU']);
  });
  it('a problem alert is a problem, never "정상"', () => { expect(of(ent({ alerts: [{ level: 'problem', text: 'x' }] }))).toMatchObject({ state: 'problem', word: '문제' }); });
  it('an error state is a problem', () => { expect(of(ent({ state: 'error' })).state).toBe('problem'); });
  it('a warning alert, a drift, and a value over its limit not yet held are warnings', () => {
    expect(of(ent({ alerts: [{ level: 'warn', text: 'x' }] })).state).toBe('warning');
    expect(of(ent({ warnings: ['x'] })).state).toBe('warning');
    expect(of(ent({ facts: facts({ cpu: obs(0.99) }) }))).toMatchObject({ state: 'warning', pending: ['CPU 99% · 지속 확인 중'] });
    expect(of(ent({ facts: facts({ cpu: obs(0.99), checkCpu: blank() }) }))).toMatchObject({ state: 'warning', pending: ['CPU 99% · 지속 확인 중'] });
  });
  it('a sustained warning is not counted as pending as well', () => {
    expect(of(ent({ facts: facts({ cpu: obs(0.99), checkCpu: { ...below, value: '임계 초과 · 90% · 45초 지속' } }), alerts: [{ level: 'warn', text: 'CPU 임계 초과' }] })).pending).toEqual([]);
  });
  it('stale outranks unknown and healthy, and is outranked by problem and warning', () => {
    expect(of(ent(), true)).toMatchObject({ state: 'stale', word: '낡음' });
    expect(of(ent({ facts: facts({ checkCpu: blank() }) }), true).state).toBe('stale');
    expect(of(ent({ state: 'error' }), true).state).toBe('problem');
    expect(of(ent({ warnings: ['x'] }), true).state).toBe('warning');
  });
  it('a required value past its time makes it stale without the map saying so', () => {
    const old = { ...obs(0.1), at: new Date(NOW - 60_000).toISOString() };
    expect(of(ent({ facts: facts({ cpu: old }) })).state).toBe('stale');
  });
  it('a stopped guest is known: its metrics do not apply, and it says so', () => {
    expect(of(ent({ kind: 'vm', state: 'stopped', facts: { state: obs('stopped') } }))).toMatchObject({ state: 'healthy', word: '중지', required: 1, notApplicable: ['CPU', '메모리', '디스크'] });
  });
  it('a QEMU disk does not apply, an LXC disk is required', () => {
    const vm = ent({ kind: 'vm', state: 'running', facts: facts({ disk: { ...blank('QEMU'), source: 'pve:x' }, checkDisk: blank() }) });
    expect(of(vm)).toMatchObject({ state: 'healthy', required: 3, notApplicable: ['디스크'], missing: [] });
    expect(of({ ...vm, kind: 'lxc' })).toMatchObject({ state: 'unknown', missing: ['디스크'] });
  });
  it('a QEMU disk with a real value is required after all', () => {
    expect(of(ent({ kind: 'vm', state: 'running', facts: facts({ checkDisk: blank() }) })).missing).toEqual(['디스크']);
  });
  it('Docker on a guest does not apply', () => {
    const vm = ent({ kind: 'vm', state: 'running', facts: facts({ docker: { ...blank('출처 없음'), source: 'docker:' } }) });
    expect(of(vm)).toMatchObject({ state: 'healthy', notApplicable: ['Docker'] });
  });
  it('a declared object has no checks: no verdict, and it says what it is', () => {
    expect(of(ent({ kind: 'gateway', basis: 'declared', facts: {} }))).toMatchObject({ state: 'unknown', word: '선언', monitored: false, required: 0 });
    expect(of(ent({ kind: 'segment', basis: 'derived', facts: {} })).word).toBe('추정');
  });
  it('a service counts: blank is missing, down is a problem through its alert', () => {
    const svc = (value: 'up' | null): Entity['services'] => [{ title: '관리', port: 1, latencyMs: null, status: value ? { ...obs(value), source: 'health:tcp' } as Fact<'up' | 'down'> : blank('첫 검사 대기') as Fact<'up' | 'down'> }];
    expect(of(ent({ services: svc('up') })).state).toBe('healthy');
    expect(of(ent({ services: svc(null) }))).toMatchObject({ state: 'unknown', missing: ['관리'] });
  });
  it('a state nobody knows is missing, whatever the fact says', () => {
    expect(of(ent({ state: 'unknown' }))).toMatchObject({ state: 'unknown', missing: ['상태'], met: 3 });
    expect(of(ent({ facts: facts({ state: { ...blank('x'), source: 'pve:x' } }) })).missing).toEqual(['상태']);
  });
  it('exactly at the limit counts as over, in a blank check and a finished one', () => {
    expect(of(ent({ facts: facts({ cpu: obs(0.9) }) })).pending).toHaveLength(1);
    expect(of(ent({ facts: facts({ cpu: obs(0.9), checkCpu: blank() }) })).pending).toHaveLength(1);
    expect(of(ent({ facts: facts({ cpu: obs(0.89) }) })).pending).toEqual([]);
  });
  it('a bridge that is off is a warning, one that is up is not', () => {
    const br = (state: Entity['state']) => ent({ kind: 'bridge', state, facts: { state: obs('up') } });
    expect(of(br('stopped')).state).toBe('warning');
    expect(of(br('ok')).state).toBe('healthy');
    expect(of(ent({ state: 'stopped' })).state).not.toBe('warning');
  });
  it('a stopped guest still says what is wrong with it before it says stopped', () => {
    const g = (over: Partial<Entity>) => ent({ kind: 'vm', state: 'stopped', facts: { state: obs('stopped') }, ...over });
    expect(of(g({ alerts: [{ level: 'problem', text: 'x' }] })).word).toBe('문제');
    expect(of(g({ warnings: ['x'] })).word).toBe('경고');
    expect(of(g({}), true).word).toBe('낡음');
  });
  it('a declared host whose service answers has evidence of its own', () => {
    const status = { ...obs('up'), source: 'health:tcp' } as Fact<'up' | 'down'>;
    expect(of(ent({ kind: 'gateway', basis: 'declared', facts: {}, services: [{ title: 'a', port: 1, latencyMs: 1, status }] }))).toMatchObject({ state: 'healthy', word: '정상', monitored: false });
  });
  it('what it is doing has a word of its own: an error says 오류, a running object says nothing', () => {
    expect(of(ent({ state: 'error' })).life).toBe('오류');
    expect(of(ent({ state: 'starting' }))).toMatchObject({ life: '기동 중', busy: true });
    expect(of(ent())).toMatchObject({ life: '', busy: false });
  });
  it('gone says so', () => { expect(of(ent({ gone: true })).word).toBe('사라짐'); });
});

describe('the whole system', () => {
  const eighteen = Array.from({ length: 6 }, (_, i) => ent({ id: `n${i}`, kind: 'vm', state: 'running', facts: facts({ disk: { ...blank('q'), source: 'pve:x' } }) }));
  it('is healthy only with every required check met', () => {
    expect(system(eighteen)).toMatchObject({ state: 'healthy', text: '이상 없음', required: 18, met: 18, blanks: 0 });
  });
  it('17 of 18 blank is not "이상 없음"', () => {
    const nodes = eighteen.map((e, i) => (i === 0 ? e : { ...e, facts: facts({ disk: e.facts.disk!, checkCpu: blank(), checkMem: blank(), state: e.facts.state! }) }));
    expect(system(nodes.map((e, i) => (i === 0 ? { ...e, facts: facts({ disk: e.facts.disk!, checkCpu: blank() }) } : e)))).toMatchObject({ state: 'unknown', text: '미확인 11/18', blanks: 11 });
  });
  it('one blank is enough', () => { expect(system([ent({ id: 'a' }), ent({ id: 'b', facts: facts({ checkCpu: blank() }) })])).toMatchObject({ state: 'unknown', text: '미확인 1/8', met: 7 }); });
  it('nothing to check is no evidence', () => {
    expect(system([ent({ kind: 'gateway', basis: 'declared', facts: {} })])).toMatchObject({ state: 'unknown', required: 0 });
    expect(system([]).state).toBe('unknown');
  });
  it('a problem and a warning outrank a blank; stale outranks a blank', () => {
    expect(system([ent({ id: 'a', facts: facts({ checkCpu: blank() }) }), ent({ id: 'b', state: 'error' })]).state).toBe('problem');
    expect(system([ent({ id: 'a', facts: facts({ checkCpu: blank() }) }), ent({ id: 'b', warnings: ['x'] })]).state).toBe('warning');
    expect(system([ent()], { sources: [{ id: 'pve', state: 'failing', count: 1, at: AT }] })).toMatchObject({ state: 'stale', text: '낡음 1' });
  });
  it('first read not done says that', () => { expect(system([ent()], { sources: [{ id: 'pve', state: 'pending', count: null, at: null }] })).toMatchObject({ state: 'unknown', text: '첫 수집 대기' }); });
  it('no source says that', () => { expect(system([ent()], { sources: [] })).toMatchObject({ state: 'unknown', text: '확인 불가' }); });
  it('not applicable is counted apart from missing', () => { expect(system(eighteen)).toMatchObject({ blanks: 0, notApplicable: 6 }); });
  it('a source that failed is named, with its reason, and one with no status still shows', () => {
    const f = system([ent()], { sources: [{ id: 'pve', state: 'failing', count: 1, at: AT, why: 'tower 응답 없음' }] }).findings;
    expect(f).toEqual([{ level: 'stale', title: 'Proxmox', why: 'tower 응답 없음' }]);
    const old = { ...obs('x'), source: 'docker:h', at: new Date(NOW - 90_000).toISOString() };
    expect(system([ent({ kind: 'gateway', basis: 'declared', facts: { a: old } })]).findings).toEqual([{ level: 'stale', title: 'Docker', why: '값이 낡았다' }]);
    expect(system([ent()], { sources: [{ id: 'pve', state: 'ok', count: 1, at: AT }, { id: 'store', state: 'failing', count: null, at: null }, { id: 'new', state: 'failing', count: null, at: null }] }).findings.map((x) => x.title)).toEqual(['상태 저장', 'new']);
  });
  it('a service past its time makes the health source stale', () => {
    const status = { ...obs('up'), source: 'health:tcp', at: new Date(NOW - 200_000).toISOString(), ttlS: 180 } as Fact<'up' | 'down'>;
    expect(system([ent({ services: [{ title: 'a', port: 1, latencyMs: 1, status }] })]).findings.map((f) => f.title)).toEqual(['서비스 검사']);
  });
  it('a screen ages at the limit and not before, and an unreadable time is old', () => {
    expect(healthOf({ nodes: [ent()], sources: [{ id: 'pve', state: 'ok', count: 1, at: new Date(NOW + 180_000).toISOString() }], takenAt: AT, limits: DEFAULT_LIMITS }, NOW + 180_000).system.text).not.toBe('낡은 화면');
    expect(system([ent()], { takenAt: 'nonsense' }).text).toBe('낡은 화면');
  });
  it('last collection is the newest time of a source that collects: a declaration date does not count', () => {
    const later = new Date(NOW + 1000).toISOString();
    expect(system([ent()], { sources: [{ id: 'pve', state: 'ok', count: 1, at: AT }, { id: 'edge', state: 'ok', count: 1, at: later }, { id: 'wan-ip', state: 'ok', count: 1, at: '2026-11-01' }] }).lastAt).toBe(AT);
    expect(system([ent()], { sources: [{ id: 'pve', state: 'ok', count: 1, at: AT }, { id: 'wan-ip', state: 'ok', count: 1, at: later }] }).lastAt).toBe(later);
    expect(system([ent()], { sources: [] }).lastAt).toBeNull();
  });
  it('a gone object counts for nothing', () => { expect(system([ent({ id: 'a' }), ent({ id: 'b', gone: true, facts: {} })]).required).toBe(4); });
  it('the fixtures read as they should', () => {
    expect(healthOf(today(), NOW).system.state).toBe('healthy');
    expect(healthOf(large(), NOW).system.state).toBe('problem');
    expect(healthOf(generate({ name: 'today', pve: false }), NOW).system.state).toBe('unknown');
  });
});

describe('what a snapshot says beside its objects', () => {
  const svc = (value: 'up' | 'down' | null) => ({ title: 'x', port: 1, latencyMs: null, status: (value ? { ...obs(value), source: 'health:tcp' } : blank('y')) as Fact<'up' | 'down'> });
  it('a known object that is missing is a problem', () => {
    expect(system([ent()], { missing: [{ id: 'a', kind: 'node', title: '노드 2', since: AT }] })).toMatchObject({ state: 'problem', text: '문제 1', findings: [{ level: 'problem', title: '노드 2', why: '사라짐' }] });
  });
  it('a service with no object still counts: down is a problem, blank blocks healthy, up is evidence', () => {
    expect(system([ent()], { unplaced: [svc('down')] }).state).toBe('problem');
    expect(system([ent()], { unplaced: [svc(null)] })).toMatchObject({ state: 'unknown', blanks: 1, required: 5, met: 4 });
    expect(system([ent()], { unplaced: [svc('up')] })).toMatchObject({ state: 'healthy', required: 5, met: 5 });
  });
  it('a read the source needs blocks healthy, and says which', () => {
    const b = system([ent()], { sources: [{ id: 'pve', state: 'ok', count: 1, at: AT, partial: [{ name: '태스크', why: 'PVE API 403' }] }] });
    expect(b).toMatchObject({ state: 'stale', text: '낡음 1', stale: 1 });
    expect(b.findings).toEqual([{ level: 'stale', title: 'Proxmox 태스크', why: 'PVE API 403' }]);
  });
});

describe('the list of blanks agrees', () => {
  it('what does not apply is not listed, what is missing is', () => {
    const vm = ent({ id: 'v', kind: 'vm', state: 'running', facts: facts({ disk: { ...blank('QEMU'), source: 'pve:x' }, docker: { ...blank('출처 없음'), source: 'docker:' }, ip: { ...blank('agent'), source: 'pve:x' } }) });
    expect(holes({ ...today(), nodes: [vm] }).map((h) => h.key)).toEqual(['ip']);
  });
  it('an LXC disk with no value is a blank, as the verdict says', () => {
    const ct = ent({ id: 'c', kind: 'lxc', state: 'running', facts: facts({ disk: { ...blank('x'), source: 'pve:x' } }) });
    expect(holes({ ...today(), nodes: [ct] }).map((h) => h.key)).toEqual(['disk']);
  });
});

describe('no surface works it out for itself', () => {
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const code = walk(src).filter((f) => /\.tsx?$/.test(f));
  it.each(code.map((f) => [f.slice(src.length), f]))('%s reads no raw signal of health', (_n, f) => {
    const t = readFileSync(f!, 'utf8').replace(/\/\/.*$/gm, '');
    expect(t).not.toMatch(/\.alerts\b(?<!health\.alerts|h\.alerts|hp\.alerts)/);
    expect(t).not.toMatch(/\be(ntity)?\.warnings\b|\bn\.warnings\b/);
    expect(t).not.toMatch(/\.state === 'error'/);
    expect(t).not.toMatch(/이상 없음/);
    expect(t).not.toMatch(/staleIds/);
    expect(t).not.toMatch(/\bsummarize\b|\bstateWord\b|\balertLevel\b/);
    expect(t).not.toMatch(/\b[cenht]\.state [!=]== '(ok|running|stopped|stopping|starting|creating|error|unknown)'/);
    expect(t).not.toMatch(/function (linkState|endState|objectHealth)\b/);
  });
  it('the surfaces do read it', () => {
    for (const f of ['App.tsx', 'scene/paint.ts', 'model.ts']) expect(readFileSync(join(src, f), 'utf8'), f).toMatch(/\bhealthOf\(/);
    for (const f of ['ui/menu.tsx', 'ui/detail.tsx', 'ui/panel.tsx', 'ui/tree.tsx', 'scene/paint.ts']) expect(readFileSync(join(src, f), 'utf8'), f).toMatch(/ObjectHealth|SystemHealth/);
  });
});
