// Design 9.8 and 12: a warning needs a run of samples, one spike does not alarm, and missing data has no verdict.
import { afterEach, describe, expect, it } from 'vitest';
import { generate } from '../dev/fixtures/gen.ts';
import { loadConfig, type Paths } from '../server/config.ts';
import type { Entity, Snapshot } from '../server/model/fact.ts';
import { checkNoFake, } from '../server/model/rules.ts';
import { applyChecks, DEFAULT_LIMITS, Samples } from '../server/model/threshold.ts';
import { holes } from '../src/model.ts';
import { healthOf, SCREEN_MAX_S } from '../server/model/health.ts';
import { closeRigs, rig, type Rig } from './support/rig.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

afterEach(closeRigs);

const VM = 'pve:qemu:100'; const NODE = 'pve:node:node-1';
const NOW = Date.parse('2026-11-01T09:00:00.000Z');
const summarize = (s: Parameters<typeof healthOf>[0], now: number, o: { offline?: boolean } = {}) => healthOf(s, now, o).system;
const fact = (value: unknown) => ({ value, basis: 'observed' as const, source: 'pve:/cluster/resources', at: new Date(NOW).toISOString(), ttlS: 45 });
const vm = (cpu: unknown, over: Partial<Entity> = {}): Entity => ({ id: 'pve:qemu:1', kind: 'vm', title: 'a', state: 'running', basis: 'observed', facts: { cpu: fact(cpu), mem: fact(0.1), disk: fact(0.1) }, ...over });
const iso = (s: number) => new Date(NOW + s * 1000).toISOString();

const run = (values: unknown[], at = 0) => {
  const s = new Samples();
  values.forEach((v, i) => s.push([vm(v)], iso(at + i * 15 - (values.length - 1) * 15), 45));
  return s;
};
const checked = (s: Samples, e = vm(0.1), nowMs = NOW) => applyChecks([e], s, DEFAULT_LIMITS, nowMs)[0]!;

describe('a warning', () => {
  it('needs every sample of the run over the limit', () => {
    const e = checked(run([0.95, 0.95, 0.95, 0.95]));
    expect(e.alerts).toEqual([{ level: 'warn', text: 'CPU 임계 초과' }]);
    expect(e.facts.checkCpu).toMatchObject({ basis: 'derived', source: 'rule:threshold' });
    expect(e.facts.checkCpu!.value).toContain('임계 초과');
  });
  it('one spike does not alarm, wherever it falls', () => {
    for (const r of [[0.99, 0.1, 0.1, 0.1], [0.1, 0.99, 0.1, 0.1], [0.1, 0.1, 0.1, 0.99]]) {
      const e = checked(run(r));
      expect(e.alerts).toBeUndefined();
      expect(e.facts.checkCpu!.value).toContain('임계 미만');
    }
  });
  it('three of four is still no warning', () => { expect(checked(run([0.1, 0.95, 0.95, 0.95])).alerts).toBeUndefined(); });
  it('the rule is time, not a count: four samples at the 4 s pace are a 12 s blip', () => {
    const s = new Samples(); for (const i of [12, 8, 4, 0]) s.push([vm(0.95)], iso(-i), 45);
    expect(checked(s).alerts).toBeUndefined();
    expect(checked(s).facts.checkCpu!.why).toContain('표본 12/45 s');
  });
  it('and twelve of them, over 45 s, are a warning', () => {
    const s = new Samples(); for (let i = 48; i >= 0; i -= 4) s.push([vm(0.95)], iso(-i), 45);
    expect(checked(s).alerts).toHaveLength(1);
  });
  it('a slow pace holds too: two samples 60 s apart cover the window', () => {
    const s = new Samples(); for (const i of [60, 0]) s.push([vm(0.95)], iso(-i), 45);
    expect(checked(s, vm(0.1), NOW).alerts).toHaveLength(1);
  });
  it('the limit itself counts as over', () => { expect(checked(run([0.9, 0.9, 0.9, 0.9])).alerts).toHaveLength(1); });
  it('ends with the first sample under the limit', () => { expect(checked(run([0.95, 0.95, 0.95, 0.95, 0.1])).alerts).toBeUndefined(); });
  it('follows the limits it is given', () => {
    const s = new Samples(); for (const i of [15, 0]) s.push([vm(0.5)], iso(-i), 45);
    expect(applyChecks([vm(0.5)], s, { cpu: 0.4, mem: 0.9, disk: 0.9, sustainS: 15 }, NOW)[0]!.alerts).toHaveLength(1);
  });
});

describe('which objects are compared', () => {
  const full = run([0.95, 0.95, 0.95, 0.95]);
  it.each(['running', 'starting', 'stopping', 'migrating'] as const)('a guest that is %s has a verdict', (state) => { expect(checked(full, vm(0.95, { state })).facts.checkCpu!.value).toContain('임계 초과'); });
  it('a node and a storage have one whatever their state word', () => {
    const f = { disk: fact(0.1) };
    const s = new Samples(); for (let i = 3; i >= 0; i--) s.push([vm(0.1, { kind: 'storage', facts: f })], iso(-i * 15), 45);
    expect(checked(s, vm(0.1, { kind: 'storage', state: 'ok', facts: f })).facts.checkDisk!.basis).toBe('derived');
    expect(checked(full, vm(0.1, { kind: 'node', state: 'ok' })).facts.checkCpu!.basis).toBe('derived');
  });
  it('a guest in no known state says that, a stopped one says it is stopped', () => {
    expect(checked(full, vm(0.1, { state: 'unknown' })).facts.checkCpu!.why).toBe('비교 불가 · 상태를 모른다');
    expect(checked(full, vm(0.1, { state: 'stopped' })).facts.checkCpu!.why).toBe('비교 불가 · 실행 중이 아니다');
  });
  it('a gone object and one that is not observed get no checks', () => {
    expect(checked(full, vm(0.1, { gone: true })).facts.checkCpu).toBeUndefined();
    expect(checked(full, vm(0.1, { basis: 'declared' })).facts.checkCpu).toBeUndefined();
  });
  it('a gone object takes no sample, so its run ends', () => {
    const s = run([0.95, 0.95]);
    s.push([vm(0.95, { gone: true })], iso(15), 45);
    expect(s.run('pve:qemu:1')).toEqual([]);
  });
  it('a sample exactly at its time still speaks', () => {
    const s = new Samples(); for (const i of [45, 30, 15, 0]) s.push([vm(0.95)], iso(-i), 45);
    expect(checked(s, vm(0.95), NOW + 45_000).facts.checkCpu!.basis).toBe('derived');
  });
});

describe('missing data is "비교 불가", never healthy', () => {
  const blank = (e: Entity) => { expect(e.facts.checkCpu).toMatchObject({ basis: 'unknown', value: null }); expect(e.facts.checkCpu!.why).toMatch(/^비교 불가/); expect(e.alerts).toBeUndefined(); };
  it('too few samples', () => { const e = checked(run([0.1, 0.1])); blank(e); expect(e.facts.checkCpu!.why).toContain('표본 15/45 s'); });
  it('no samples at all', () => blank(checked(new Samples())));
  it('a hole inside the run', () => blank(checked(run([0.1, null, 0.1, 0.1]))));
  it('a value that is no number', () => blank(checked(run([0.1, 0.1, 'x', 0.1]))));
  it('samples too old to speak for now', () => blank(checked(run([0.1, 0.1, 0.1, 0.1]), vm(0.1), NOW + 46_000)));
  it('a failed read breaks the run', () => { const s = run([0.95, 0.95, 0.95, 0.95]); s.gap(); blank(checked(s)); });
  it('a stopped guest has nothing to compare', () => blank(checked(run([0, 0, 0, 0]), vm(0, { state: 'stopped' }))));
  it('a value PVE does not give keeps its reason', () => {
    const e = vm(0.1); e.facts.cpu = { value: null, basis: 'unknown', source: 'pve:x', at: null, ttlS: null, why: 'PVE가 주지 않는다' };
    expect(checked(run([0.1, 0.1, 0.1, 0.1]), e).facts.checkCpu!.why).toBe('비교 불가 · PVE가 주지 않는다');
  });
});

describe('live', () => {
  let clock = NOW;
  const timed = () => { clock = Date.now(); return rig({ now: () => clock }); };
  const high = async (r: Rig, n: number, cpu = 0.95) => { r.mock.state.cpu = cpu; for (let i = 0; i < n; i++) { clock += 15_000; await r.live.collectOnce(); } };
  const nodeOf = (r: Rig) => r.entity(NODE)!;
  it('warns only after the run, on the object and in the summary', async () => {
    const r = await timed();
    await high(r, 3);
    expect(nodeOf(r).alerts).toBeUndefined();
    expect(summarize(r.snap(), clock).findings.every((f) => f.why.includes('지속 확인 중'))).toBe(true); // shown, and not yet called a warning
    await high(r, 1);
    expect(nodeOf(r).alerts).toContainEqual({ level: 'warn', text: 'CPU 임계 초과' });
    expect(summarize(r.snap(), clock).findings.some((f) => f.why === 'CPU 임계 초과')).toBe(true);
  });
  it('a failed read in the run starts it over, and shows no verdict until it fills', async () => {
    const r = await timed();
    await high(r, 3);
    r.mock.state.all = { isError: 'TIMEOUT: x' };
    await r.live.collectOnce();
    expect(nodeOf(r).facts.checkCpu!.basis).toBe('unknown');
    r.mock.state.all = null;
    await high(r, 1);
    expect(nodeOf(r).alerts).toBeUndefined();
    expect(nodeOf(r).facts.checkCpu!.why).toContain('표본 0/45 s');
  });
  it('a metric that moves is no change: seq stays, and the history gets one line per crossing', async () => {
    const r = await timed();
    await high(r, 4, 0.05);
    const seq = r.snap().seq; const before = r.file('changes.jsonl').length;
    await high(r, 4, 0.95);
    expect(r.snap().seq).toBe(seq);
    await high(r, 2, 0.96); await high(r, 1, 0.97);
    const added = r.file('changes.jsonl').slice(before);
    expect(added.match(/임계 초과","on":true/g)?.length).toBeGreaterThan(0);
    expect(added.split('\n').filter(Boolean)).toHaveLength(1);
    await high(r, 1, 0.05);
    expect(r.file('changes.jsonl').slice(before)).toContain('"on":false');
  });
  it('the first verdict under the limit is no event, and neither is a hole', async () => {
    const r = await timed();
    await high(r, 4, 0.05);
    r.mock.state.all = { isError: 'TIMEOUT: x' }; await r.live.collectOnce(); r.mock.state.all = null;
    await high(r, 4, 0.05);
    expect(r.file('changes.jsonl')).not.toContain('alerts');
  });
  it('the checks are derived facts on a source that exists, and the snapshot says its limits', async () => {
    const r = await timed();
    await high(r, 4, 0.05);
    expect(checkNoFake(r.snap())).toEqual([]);
    expect(r.snap().limits).toEqual(DEFAULT_LIMITS);
    expect(r.entity(VM)!.facts.checkDisk).toMatchObject({ basis: 'unknown', why: '비교 불가 · QEMU 게스트의 사용량은 PVE가 주지 않는다' });
  });
  it('relief.json limits reach the object', async () => {
    const r = await timed();
    r.reopen({ limits: { cpu: 0.04, mem: 0.99, disk: 0.99, sustainS: 15 } });
    await high(r, 2, 0.05);
    expect(nodeOf(r).alerts).toContainEqual({ level: 'warn', text: 'CPU 임계 초과' });
  });
});

describe('relief.json', () => {
  const paths = (body: unknown): Paths => { const d = mkdtempSync(join(tmpdir(), 'relief-cfg-')); const f = join(d, 'relief.json'); writeFileSync(f, JSON.stringify(body)); return { tokenFile: '', reliefJson: f, edgeJson: '', stateDir: '' }; };
  it('takes percent and fills the rest with the defaults', () => {
    expect(loadConfig(paths({ thresholds: { cpu: 80, sustainS: 90 } })).thresholds).toEqual({ cpu: 0.8, mem: 0.9, disk: 0.85, sustainS: 90 });
  });
  it.each([[{ cpu: 0 }], [{ cpu: 101 }], [{ cpu: '90' }], [{ sustainS: 1 }], [{ sustainS: 2.5 }], [{ sustain: 4 }], [{ swap: 90 }], ['90']])('%j is its own error and stops nothing', (t) => {
    const c = loadConfig(paths({ thresholds: t }));
    expect(c.thresholdsError).toBe('thresholds 설정 오류'); expect(c.thresholds).toBeUndefined(); expect(c.error).toBeUndefined();
  });
  it('the health interval is bounded', () => {
    expect(loadConfig(paths({ healthIntervalS: 120 })).healthS).toBe(120);
    expect(loadConfig(paths({ healthIntervalS: 1 })).healthError).toBe('healthIntervalS 설정 오류');
  });
});

describe('the summary (design 9.10)', () => {
  const s = (over: Partial<Snapshot> = {}): Snapshot => ({ ...generate({ name: 'today' }), ...over });
  const NOWISH = Date.parse('2026-11-01T09:00:00.000Z');
  it('no inventory is "blind", never clear', () => {
    expect(summarize(generate({ name: 'today', pve: false }), NOWISH).state).toBe('unknown');
    const failing = s(); failing.sources.find((x) => x.id === 'pve')!.state = 'failing'; failing.sources.find((x) => x.id === 'pve')!.at = null;
    expect(summarize(failing, NOWISH).state).toBe('unknown');
  });
  const allBlank = (a: Snapshot) => ({ ...a, nodes: a.nodes.map((n) => ({ ...n, facts: Object.fromEntries(Object.entries(n.facts).map(([k, f]) => [k, k.startsWith('check') ? { value: null, basis: 'unknown' as const, source: 'rule:threshold', at: null, ttlS: null, why: '비교 불가 · 표본 0/45 s' } : f])) })) });
  it('every check blank is no evidence: not "이상 없음"', () => {
    const b = summarize(allBlank(s()), NOWISH);
    expect(b.state).toBe('unknown'); expect(b.text).toMatch(/^미확인 \d+\/\d+$/);
  });
  it('a value over its limit shows before the warning has held, even with every check blank', () => {
    const a = allBlank(s());
    a.nodes = a.nodes.map((n) => (n.id === NODE ? { ...n, facts: { ...n.facts, cpu: { ...n.facts.cpu!, value: 0.99 } } } : n));
    const b = summarize(a, NOWISH);
    expect(b.state).toBe('warning'); expect(b.findings[0]!.why).toBe('CPU 99% · 지속 확인 중');
  });
  it('a warning that fired is not counted twice', () => {
    const a = s();
    a.nodes = a.nodes.map((n) => (n.id === NODE ? { ...n, alerts: [{ level: 'warn', text: 'CPU 임계 초과' }], facts: { ...n.facts, cpu: { ...n.facts.cpu!, value: 0.99 }, checkCpu: { value: '임계 초과', basis: 'derived', source: 'rule:threshold', at: null, ttlS: null } } } : n));
    expect(summarize(a, NOWISH).warnings).toBe(1);
  });
  it('a screen that lost its server says so, whatever it last saw', () => {
    expect(summarize(s(), NOWISH, { offline: true })).toMatchObject({ state: 'stale', text: '연결 끊김' });
  });
  it('a snapshot too old is no present state', () => {
    expect(summarize(s(), NOWISH + (SCREEN_MAX_S + 1) * 1000)).toMatchObject({ state: 'stale', text: '낡은 화면' });
    expect(summarize(s(), NOWISH).state).toBe('healthy');
  });
  it('counts problems, warnings and stale sources apart', () => {
    const a = s();
    a.nodes[1] = { ...a.nodes[1]!, state: 'error' };
    a.nodes[2] = { ...a.nodes[2]!, alerts: [{ level: 'warn', text: 'CPU 임계 초과' }], warnings: ['계획 밖 주소'] };
    a.sources.find((x) => x.id === 'pve')!.state = 'failing';
    const b = summarize(a, NOWISH);
    expect(b).toMatchObject({ state: 'problem', problems: 1, warnings: 2, stale: 1 });
  });
  it('a blank check stays out of the verdict and in the count, and off the list of holes', () => {
    const a = s();
    a.nodes = a.nodes.map((n) => (n.id === VM ? { ...n, facts: { ...n.facts, checkCpu: { value: null, basis: 'unknown', source: 'rule:threshold', at: null, ttlS: null, why: '비교 불가 · 값이 없다' } } } : n));
    const b = summarize(a, NOWISH);
    expect(b.blanks).toBeGreaterThanOrEqual(1);
    expect(holes(a).some((h) => h.key === 'checkCpu')).toBe(false);
  });
});
