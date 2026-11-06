// Design 8, 9.12: a rate is a delta of two real counters. First sample, reset and gap give none, and no link gets a packet without one.
import { afterEach, describe, expect, it } from 'vitest';
import { large, today } from '../dev/fixtures/gen.ts';
import { layoutSnapshot } from '../server/layout/elk.ts';
import type { Entity, Relation, Snapshot } from '../server/model/fact.ts';
import { applyRates, MAX_GAP_S, Rates, RESET, WAITING } from '../server/model/rate.ts';
import { keyValues, trafficText } from '../src/model.ts';
import { healthOf } from '../server/model/health.ts';
import { allot, measuredLinks, packetsFor, PACKETS_PER_LANE, PACKETS_TOTAL } from '../src/scene/flow.ts';
import { buildScene } from '../src/scene/paint.ts';
import { closeRigs, rig } from './support/rig.ts';

afterEach(closeRigs);

const AT = '2026-11-01T09:00:00.000Z'; const NOW = Date.parse(AT);
const push = (r: Rates, t: number, i: number, o = i) => r.push('x', { in: i, out: o, t }, AT);

describe('a rate', () => {
  it('needs two samples: the first gives none', () => { const r = new Rates(); push(r, 100, 5000); expect(r.of('x')).toEqual({ why: WAITING }); });
  it('is the delta over the time of the source', () => {
    const r = new Rates(); push(r, 100, 1000, 500); push(r, 115, 16000, 2000);
    expect(r.of('x')).toEqual({ in: 1000, out: 100, at: AT });
  });
  it('a counter that stood still is a rate of 0, in either direction, not a reset', () => {
    const r = new Rates(); r.push('x', { in: 5, out: 5, t: 1 }, AT); r.push('x', { in: 5, out: 9, t: 11 }, AT);
    expect(r.of('x')).toEqual({ in: 0, out: 0.4, at: AT });
    r.push('x', { in: 15, out: 9, t: 21 }, AT);
    expect(r.of('x')).toEqual({ in: 1, out: 0, at: AT });
  });
  it('the gap at its limit still gives a rate', () => { const r = new Rates(); push(r, 100, 0); push(r, 100 + MAX_GAP_S, MAX_GAP_S); expect(r.of('x')).toMatchObject({ in: 1 }); });
  it('a repeat of the same tick changes nothing', () => {
    const r = new Rates(); push(r, 100, 1000); push(r, 110, 2000); const a = r.of('x'); push(r, 110, 2000); expect(r.of('x')).toEqual(a);
  });
  it('in going back alone is a reset, out alone too', () => {
    const a = new Rates(); a.push('x', { in: 900, out: 5, t: 1 }, AT); a.push('x', { in: 1, out: 9, t: 2 }, AT); expect(a.of('x')).toEqual({ why: RESET });
    const b = new Rates(); b.push('x', { in: 5, out: 900, t: 1 }, AT); b.push('x', { in: 9, out: 1, t: 2 }, AT); expect(b.of('x')).toEqual({ why: RESET });
  });
  it('a counter that went back is a reset: no rate, and the next delta counts from there', () => {
    const r = new Rates(); push(r, 100, 900000); push(r, 110, 500);
    expect(r.of('x')).toEqual({ why: RESET });
    push(r, 120, 1500);
    expect(r.of('x')).toMatchObject({ in: 100 });
  });
  it('either direction going back is a reset', () => { const r = new Rates(); r.push('x', { in: 5, out: 900, t: 1 }, AT); r.push('x', { in: 9, out: 1, t: 2 }, AT); expect(r.of('x')).toEqual({ why: RESET }); });
  it('a clock that went back gives none', () => { const r = new Rates(); push(r, 100, 1); push(r, 90, 2); expect(r.of('x')).toEqual({ why: RESET }); });
  it('a long gap says nothing about now', () => { const r = new Rates(); push(r, 100, 1); push(r, 100 + MAX_GAP_S + 1, 9e9); expect(r.of('x')).toEqual({ why: WAITING }); });
  it('a failed read clears the baseline', () => { const r = new Rates(); push(r, 100, 1); push(r, 110, 2); r.gap(); expect(r.of('x')).toBeNull(); push(r, 120, 3); expect(r.of('x')).toEqual({ why: WAITING }); });
  it('an object PVE stopped listing loses its baseline', () => { const r = new Rates(); push(r, 100, 1); r.keep(new Set()); expect(r.of('x')).toBeNull(); });
});

describe('on an object', () => {
  const ent = (over: Partial<Entity> = {}): Entity => ({ id: 'x', kind: 'node', title: 'x', state: 'ok', basis: 'observed', facts: {}, ...over });
  it('a rate is observed, with the source that gave it', () => {
    const r = new Rates(); push(r, 100, 0); push(r, 110, 1000);
    expect(applyRates([ent()], r, 45, NOW)[0]!.facts.netIn).toMatchObject({ value: 100, basis: 'observed', source: 'pve:/cluster/metrics/export', ttlS: 45 });
  });
  it('a gone object and one that is not observed carry none', () => {
    const r = new Rates(); push(r, 100, 0); push(r, 110, 1000);
    expect(applyRates([ent({ gone: true })], r, 45, NOW)[0]!.facts.netIn).toBeUndefined();
    expect(applyRates([ent({ basis: 'declared' })], r, 45, NOW)[0]!.facts.netIn).toBeUndefined();
  });
  it('a rate exactly at its time still stands', () => {
    const r = new Rates(); push(r, 100, 0); push(r, 110, 1000);
    expect(applyRates([ent()], r, 45, NOW + 45_000)[0]!.facts.netIn!.value).toBe(100);
  });
  it('a rate past its time is waiting, never a stale value on the map', () => {
    const r = new Rates(); push(r, 100, 0); push(r, 110, 1000);
    expect(applyRates([ent()], r, 45, NOW + 46_000)[0]!.facts.netIn).toMatchObject({ value: null, why: WAITING });
  });
  it('no rate is a blank with its reason, never 0', () => {
    expect(applyRates([ent()], new Rates(), 45, NOW)[0]!.facts.netIn).toMatchObject({ value: null, basis: 'unknown', why: WAITING });
  });
  it('only nodes and guests carry one', () => { expect(applyRates([ent({ kind: 'gateway' }), ent({ kind: 'workstation' })], new Rates(), 45, NOW).every((e) => !e.facts.netIn)).toBe(true); });
  it('a stale rate reads as stale in the menu', () => {
    const f = { value: 100, basis: 'observed' as const, source: 'x', at: AT, ttlS: 45 };
    expect(trafficText(ent({ facts: { netIn: f, netOut: f } }), NOW + 46_000)).toBe('낡음');
    expect(trafficText(ent({ facts: { netIn: f, netOut: f } }), NOW)).toBe('↓100 B/s ↑100 B/s');
    expect(keyValues(ent({ facts: { netIn: f, netOut: f } }), NOW)).toEqual([{ label: '트래픽', text: '↓100 B/s ↑100 B/s' }]);
  });
});

describe('rate to packets', () => {
  it.each([[0, 0], [0.5, 0], [1, 1], [64, 1], [1000, 1], [9999, 1], [1e4, 2], [1e5, 3], [1e6, 4], [1e7, 5], [1e8, 6], [1e10, 6]])('%d B/s is %d', (r, n) => { expect(packetsFor(r)).toBe(n); });
  it('NaN and negatives are none', () => { expect(packetsFor(NaN)).toBe(0); expect(packetsFor(-5)).toBe(0); });
  it('never passes the cap of a lane', () => { for (let e = 0; e < 16; e++) expect(packetsFor(10 ** e)).toBeLessThanOrEqual(PACKETS_PER_LANE); });
  it('the total is the number the budget of design 13 names', () => { expect(PACKETS_TOTAL).toBe(200); });
  const lanes = (wants: number[]) => wants.map((want, i) => ({ link: `l${Math.floor(i / 2)}`, want }));
  it('under the total everyone gets what they want', () => { expect(allot(lanes([3, 1, 0, 2]))).toEqual([3, 1, 0, 2]); });
  it('a lane can reach its full six', () => { expect(allot(lanes([6, 6]))).toEqual([6, 6]); });
  it('a link with nothing measured gets nothing', () => { expect(allot(lanes([0, 0]))).toEqual([0, 0]); });
  it('every measured link keeps a packet however busy the rest are, and the total holds', () => {
    const wants = Array.from({ length: 298 }, (_, i) => (i < 60 ? 6 : i % 2 ? 0 : 1)); // 149 links, as on a full map
    const got = allot(lanes(wants));
    expect(got.reduce((a, b) => a + b, 0)).toBe(PACKETS_TOTAL);
    for (let l = 0; l < 149; l++) expect(got[2 * l]! + got[2 * l + 1]!, `link ${l}`).toBeGreaterThanOrEqual(1);
  });
  it('more measured links than the total: one each, and the guarantee wins', () => {
    const got = allot(Array.from({ length: 250 }, (_, i) => ({ link: `l${i}`, want: 6 })));
    expect(got.every((n) => n === 1)).toBe(true);
  });
  it('the first packet goes to the busier lane of a link, the listing order', () => { expect(allot([{ link: 'a', want: 1 }, { link: 'a', want: 1 }], 1)).toEqual([1, 0]); });
});

describe('which links are measured', () => {
  const f = (value: number | null) => (value === null ? { value, basis: 'unknown' as const, source: 'x', at: null, ttlS: null, why: 'y' } : { value, basis: 'observed' as const, source: 'x', at: AT, ttlS: 45 });
  const ent = (id: string, kind: Entity['kind'], i: number | null = 10, o: number | null = 20): Entity => ({ id, kind, title: id, state: 'ok', basis: 'observed', facts: { netIn: f(i), netOut: f(o) } });
  const rel = (id: string, kind: Relation['kind'], target: string) => ({ id, kind, target, source: 's', basis: 'observed' as const, facts: {} });
  it('a PC on its LAN link, and no other LAN link', () => {
    const nodes = [ent('pc', 'workstation'), ent('n', 'node'), ent('sw', 'switch')];
    expect([...measuredLinks({ nodes, edges: [rel('a', 'lan', 'pc'), rel('b', 'lan', 'n'), rel('c', 'lan', 'sw')] }, NOW).keys()]).toEqual(['a']);
  });
  it('a PC on a link of another kind is not measured', () => { expect(measuredLinks({ nodes: [ent('pc', 'workstation')], edges: [rel('a', 'forward', 'pc')] }, NOW).size).toBe(0); });
  it('two links of one object: the first takes the rate, or it would count twice', () => {
    expect([...measuredLinks({ nodes: [ent('g', 'vm')], edges: [rel('a', 'attached', 'g'), rel('b', 'attached', 'g')] }, NOW).keys()]).toEqual(['a']);
  });
  it('one direction missing is no measurement', () => {
    expect(measuredLinks({ nodes: [ent('g', 'vm', null, 5)], edges: [rel('a', 'attached', 'g')] }, NOW).size).toBe(0);
    expect(measuredLinks({ nodes: [ent('g', 'vm', 5, null)], edges: [rel('a', 'attached', 'g')] }, NOW).size).toBe(0);
  });
});

describe('on the map', () => {
  const laid = async (s: Snapshot): Promise<Snapshot> => ({ ...s, ...(await layoutSnapshot(s)) });
  const scene = (s: Snapshot, nowMs = NOW) => buildScene(s, { mode: 'iso', S: 1, overlay: 'state', metric: 'cpu', nowMs, sel: null, dim: null, dense: true });
  const packets = (s: Snapshot) => scene(s).prims.flatMap((p) => (p.t === 'packet' ? [p] : []));
  it('a guest\'s rate sits on its link to the bridge, a node\'s on its uplink, and only there', () => {
    const m = measuredLinks(today(), NOW);
    expect([...m.keys()].sort()).toEqual(['e-attach-100', 'e-up-node-1-0', 'e-up-node-2-0', 'e-up-node-3-0']);
  });
  it('no link without a measurement carries a packet, and each says so', async () => {
    const s = await laid(large());
    const measured = measuredLinks(s, NOW);
    for (const p of packets(s)) expect(measured.has(p.edge), p.edge).toBe(true);
    const lines = scene(s).prims.flatMap((p) => (p.t === 'line' && p.edge ? [p] : []));
    const none = lines.filter((p) => !p.measured);
    expect(none.length).toBeGreaterThan(0);
    for (const p of none) expect(p.title).toContain('트래픽 측정 없음');
  });
  it('a stale link has no packet though its old rate is on file', async () => {
    const s = await laid(large());
    expect(packets(s).some((p) => p.edge.startsWith('e-up-node-4'))).toBe(false);
    expect(packets(s).some((p) => p.edge.startsWith('e-up-node-2'))).toBe(true);
    expect(scene(s).prims.find((p) => p.t === 'line' && p.edge === 'e-up-node-4-0')).toMatchObject({ link: 'stale', measured: false });
  });
  it('a down link has no packet', async () => {
    const s = await laid(today());
    const off = { ...s, nodes: s.nodes.map((n) => (n.id === 'pve:qemu:100' ? { ...n, state: 'stopped' as const } : n)) };
    expect(packets(off).some((p) => p.edge === 'e-attach-100')).toBe(false);
  });
  it('the two directions run opposite ways in lanes of their own', async () => {
    const s = await laid(today());
    const up = packets(s).filter((p) => p.edge === 'e-up-node-1-0');
    const inn = up.find((p) => p.lane === 'in'); const out = up.find((p) => p.lane === 'out');
    if (inn && out) expect(inn.d).not.toBe([...out.d].join(''));
    expect(new Set(up.map((p) => p.lane)).size).toBeGreaterThanOrEqual(1);
  });
  it('the whole map stays under the total, whatever the rates', async () => {
    const s = await laid(large({ nodeCount: 9, guestsPerNode: 18, containerHosts: 26 }));
    const busy = { ...s, nodes: s.nodes.map((n) => (n.facts.netIn ? { ...n, facts: { ...n.facts, netIn: { ...n.facts.netIn, value: 1e9 }, netOut: { ...n.facts.netOut!, value: 1e9 } } } : n)) };
    expect(packets(busy).length).toBeLessThanOrEqual(PACKETS_TOTAL);
    expect(packets(busy).length).toBeGreaterThan(150);
  });
});

describe('live', () => {
  it('reads the rate from one metrics read a viewer asks for: no new path, and none without a viewer', async () => {
    let now = Date.now();
    const r = await rig({ now: () => now });
    await r.live.collectOnce();
    r.mock.calls.length = 0;
    await r.live.collectMetrics();
    expect(r.mock.calls).toEqual([]);                                  // nobody is looking
    r.live.touch();
    await r.live.collectMetrics(); await r.live.collectMetrics();
    expect(r.mock.calls.map((c) => c.args.path)).toEqual(['/cluster/metrics/export', '/cluster/metrics/export']);
    expect(r.entity('pve:node:node-1')!.facts.netIn).toMatchObject({ value: 2000, basis: 'observed' });
    expect(r.entity('pve:qemu:100')!.facts.netOut).toMatchObject({ value: 1000, basis: 'observed' });
    now += 1;
  });
  it('a viewer coming back sees rates waiting, not old values, and no stale source', async () => {
    let now = Date.now();
    const r = await rig({ now: () => now });
    await r.live.collectOnce(); r.live.touch();
    await r.live.collectMetrics(); await r.live.collectMetrics();
    expect(r.entity('pve:node:node-1')!.facts.netIn!.value).toBe(2000);
    now += 200_000;                                                  // nobody looked; the fast loop kept reading
    await r.live.collectOnce();
    r.live.touch();
    expect(r.entity('pve:node:node-1')!.facts.netIn).toMatchObject({ value: null, why: WAITING });
    expect(healthOf(r.snap(), now).system.findings.filter((f) => f.level === 'stale')).toEqual([]);
  });
  it('a rate is no change: seq stays', async () => {
    const r = await rig();
    await r.live.collectOnce(); r.live.touch();
    const seq = r.snap().seq;
    await r.live.collectMetrics(); await r.live.collectMetrics();
    r.mock.state.net.rate = 90000;
    await r.live.collectMetrics();
    expect(r.snap().seq).toBe(seq);
  });
  it('a reset on the node shows no rate, and the snapshot never shows a negative', async () => {
    const r = await rig();
    await r.live.collectOnce(); r.live.touch();
    await r.live.collectMetrics(); await r.live.collectMetrics();
    r.mock.state.net.value = 10;
    await r.live.collectMetrics();
    expect(r.entity('pve:node:node-1')!.facts.netIn).toMatchObject({ value: null, why: RESET });
  });
  it('a failed metrics read leaves no rate behind', async () => {
    const r = await rig();
    await r.live.collectOnce(); r.live.touch();
    await r.live.collectMetrics(); await r.live.collectMetrics();
    r.mock.state.over.set('/cluster/metrics/export', { isError: 'PVE API 500: x' });
    await r.live.collectMetrics();
    r.live.touch(); r.mock.state.over.delete('/cluster/metrics/export');
    await r.live.collectMetrics();
    expect(r.entity('pve:node:node-1')!.facts.netIn).toMatchObject({ value: null, why: WAITING });
  });
});
