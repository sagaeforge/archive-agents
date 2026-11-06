// Design 9.12: a dot says both ends are alive. It never claims a rate, and a blank never moves.
import { describe, expect, it } from 'vitest';
import { large, today } from '../dev/fixtures/gen.ts';
import { layoutSnapshot } from '../server/layout/elk.ts';
import type { Entity, Relation, Snapshot } from '../server/model/fact.ts';
import { staleIds } from '../server/model/fact.ts';
import { PACKET_SPEED, packetTiming } from '../src/scene/flow.ts';
import { buildScene } from '../src/scene/paint.ts';
import { fold, keyValues, paletteHits, searchMatches } from '../src/model.ts';
import { linkState, objectHealth } from '../server/model/health.ts';
import { placeMenu } from '../src/ui/menu.tsx';
import { readChanges } from '../server/changes.ts';
import { createApi } from '../server/app.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = Date.parse('2026-11-01T09:00:00.000Z');
const ok = (value: unknown) => ({ value, basis: 'observed' as const, source: 'pve:x', at: new Date(NOW).toISOString(), ttlS: 45 });
const under = { value: '임계 미만 · 90%', basis: 'derived' as const, source: 'rule:threshold', at: null, ttlS: null };
const good = { state: ok('online'), cpu: ok(0.1), mem: ok(0.1), disk: ok(0.1), checkCpu: under, checkMem: under, checkDisk: under };
const ent = (id: string, over: Partial<Entity> = {}): Entity => ({ id, kind: 'node', title: id, state: 'ok', basis: 'observed', facts: good, ...over });
const rel = (over: Partial<Relation> = {}): Relation => ({ id: 'e', source: 'a', target: 'b', kind: 'lan', basis: 'observed', facts: {}, ...over });
const healthFor = (es: Entity[], stale: string[] = []) => new Map(es.map((e) => [e.id, objectHealth(e, { stale: stale.includes(e.id), nowMs: NOW })]));
const state = (a: Partial<Entity>, b: Partial<Entity> = {}, r: Partial<Relation> = {}, stale: string[] = []) => { const es = [ent('a', a), ent('b', b)]; return linkState(rel(r), new Map(es.map((e) => [e.id, e])), healthFor(es, stale)); };

describe('the state of a link', () => {
  it('both ends healthy is healthy', () => { expect(state({})).toBe('healthy'); });
  it('an end with no verdict makes it unknown: a declared router is not known to be up', () => {
    expect(state({}, { basis: 'declared', kind: 'gateway', facts: {} })).toBe('unknown');
    expect(state({}, { facts: { ...good, checkCpu: { ...under, value: null, basis: 'unknown' } } })).toBe('unknown');
  });
  it.each([['stopped'], ['error'], ['stopping']] as const)('an end that is %s is down', (st) => { expect(state({ state: st })).toBe('down'); });
  it('a gone end, or a service that does not answer, is down', () => {
    expect(state({ gone: true })).toBe('down');
    expect(state({ alerts: [{ level: 'problem', text: 'x' }] })).toBe('down');
  });
  it('a threshold warning or a drift is a warning: still connected, and worth a look', () => {
    expect(state({ alerts: [{ level: 'warn', text: 'x' }] })).toBe('warning');
    expect(state({ warnings: ['x'] })).toBe('warning');
    expect(state({ alerts: [{ level: 'warn', text: 'x' }] }, { state: 'stopped' })).toBe('down');
  });
  it('a stale end makes the link stale, and down outranks it', () => {
    expect(state({}, {}, {}, ['a'])).toBe('stale');
    expect(state({ state: 'stopped' }, {}, {}, ['b'])).toBe('down');
  });
  it('what nobody can vouch for is unknown, never alive', () => {
    expect(state({ state: 'unknown' })).toBe('unknown');
    expect(state({ basis: 'unknown' })).toBe('unknown');
    expect(state({ basis: 'derived', kind: 'gateway', state: 'ok' })).toBe('unknown');
    expect(state({ kind: 'segment', basis: 'derived', facts: {} }, { kind: 'segment', basis: 'derived', facts: {} })).toBe('unknown');
    expect(state({}, {}, { basis: 'unknown' })).toBe('unknown');
    expect(linkState(rel(), new Map([['a', ent('a')]]), healthFor([ent('a')]))).toBe('unknown');
  });
  it('an end with no verdict is unknown', () => {
    const es = [ent('a'), ent('b')];
    expect(linkState(rel(), new Map(es.map((e) => [e.id, e])), new Map())).toBe('unknown');
  });
  it('a segment is a name for observed bridges, so it does not break a link', () => { expect(state({ kind: 'segment', basis: 'derived', facts: {} })).toBe('healthy'); });
  it('an uplink follows the bridge it comes in through', () => {
    const es = [ent('a'), ent('b'), ent('br', { kind: 'bridge', state: 'stopped' })];
    expect(linkState(rel({ facts: { via: { value: 'br', basis: 'observed', source: 'pve:x', at: null, ttlS: null } } }), new Map(es.map((e) => [e.id, e])), healthFor(es))).toBe('down');
  });
});

describe('a packet', () => {
  it('moves at one speed: the count carries the rate, the speed nothing', () => {
    const a = packetTiming('x', [[0, 0], [900, 0]]); const b = packetTiming('other', [[0, 0], [900, 0]]);
    expect(a.dur).toBe(900 / PACKET_SPEED); expect(b.dur).toBe(a.dur);
    expect(packetTiming('x', [[0, 0], [1800, 0]]).dur).toBe(a.dur * 2);
  });
  it('in runs from source to target, out back', async () => {
    const s = await laid(today());
    const sc = buildScene(s, { mode: 'iso', S: 1, overlay: 'state', metric: 'cpu', nowMs: NOW, sel: null, dim: null, dense: false });
    const dots = sc.prims.flatMap((p) => (p.t === 'packet' ? [p] : []));
    const start = (d: string) => Number(d.slice(1).split(' ')[0]); const end = (d: string) => Number(d.split('L').at(-1)!.split(' ')[0]);
    const inn = dots.find((p) => p.lane === 'in')!; const out = dots.find((p) => p.edge === inn.edge && p.lane === 'out');
    expect(inn).toBeTruthy();
    if (out) expect(Math.sign(end(inn.d) - start(inn.d))).toBe(Math.sign(end(out.d) - start(out.d)) * -1);
  });
  it('a stale node leaves its links static on the large map', async () => {
    const s = await laid(large());
    const sc = buildScene(s, { mode: 'iso', S: 1, overlay: 'state', metric: 'cpu', nowMs: NOW, sel: null, dim: null, dense: true });
    const stale = staleIds(s, NOW);
    expect(stale.has('pve:node:node-4')).toBe(true);
    const dots = sc.prims.flatMap((p) => (p.t === 'packet' ? [p.edge] : []));
    expect(dots.some((e) => e.startsWith('e-up-node-4'))).toBe(false);
    expect(dots.some((e) => e.startsWith('e-up-node-2'))).toBe(true);
  });
});
const laid = async (s: Snapshot): Promise<Snapshot> => ({ ...s, ...(await layoutSnapshot(s)) });

describe('Korean search', () => {
  it('matches a syllable on its way: a lone consonant and a partial syllable', () => {
    expect(fold('결제').includes(fold('결ㅈ'))).toBe(true);
    expect(fold('결제').includes(fold('ㄱ'))).toBe(true);
    expect(fold('데이터베이스').includes(fold('데이ㅌ'))).toBe(true);
  });
  it('is the same text whichever way it was composed', () => { expect(fold('결제'.normalize('NFD'))).toBe(fold('결제')); });
  it('finds by name, kind and address', () => {
    const s = today();
    expect([...searchMatches(s, '저장소')!]).toHaveLength(6);
    expect(searchMatches(s, 'storage')!.size).toBe(6);
    expect(searchMatches(s, '192.0.2.11')!.size).toBeGreaterThan(0);
    expect(searchMatches(s, '   ')).toBeNull();
  });
  it('a name beats a kind, and the start of a name its middle', async () => {
    const s = await laid(today());
    expect(paletteHits(s, '노드')[0]!.title.startsWith('노드')).toBe(true);
    expect(paletteHits(s, 'qqq')).toEqual([]);
  });
});

describe('the menu', () => {
  const map = { w: 1000, h: 700 };
  it('stands beside the object when there is room', () => { expect(placeMenu({ x: 100, y: 100, w: 50, h: 50 }, 80, map).x).toBe(162); });
  it('goes to the other side at the edge, and stays inside', () => {
    expect(placeMenu({ x: 900, y: 100, w: 50, h: 50 }, 80, map).x).toBeLessThan(900);
    for (const box of [{ x: -300, y: -300, w: 40, h: 40 }, { x: 2000, y: 2000, w: 40, h: 40 }, { x: 0, y: 0, w: 1000, h: 700 }]) {
      const p = placeMenu(box, 80, map);
      expect(p.x).toBeGreaterThanOrEqual(4); expect(p.y).toBeGreaterThanOrEqual(4); expect(p.x + 196).toBeLessThanOrEqual(996); expect(p.y + 80).toBeLessThanOrEqual(696);
    }
  });
  it('shows at most three values, and a blank as a blank', () => {
    const f = (value: unknown) => ({ value, basis: 'observed' as const, source: 'x', at: null, ttlS: null });
    expect(keyValues(ent('n', { facts: { cpu: f(0.5), mem: f(0.2), disk: f(0.1), address: f('192.0.2.1') } })).map((v) => v.text)).toEqual(['50%', '20%']);
    expect(keyValues(ent('v', { kind: 'vm', facts: { cpu: { value: null, basis: 'unknown', source: 'x', at: null, ttlS: null, why: 'y' } } }))[0]!.text).toBe('미확인');
  });
});

describe('history filters', () => {
  const file = () => { const f = join(mkdtempSync(join(tmpdir(), 'relief-log-')), 'changes.jsonl'); writeFileSync(f, [{ at: NOWISO, added: ['a'], changed: ['b'] }, { at: NOWISO, added: ['c'] }, { at: NOWISO, source: 'pve', state: 'failing' }].map((l) => JSON.stringify(l)).join('\n') + '\n'); return f; };
  const NOWISO = new Date(NOW).toISOString();
  it('by kind keeps those rows, and drops an entry with none left', () => {
    const p = readChanges(file(), { limit: 10, type: 'added' });
    expect(p.items.map((i) => i.rows.map((r) => r.id))).toEqual([['c'], ['a']]);
  });
  it('by object', () => { expect(readChanges(file(), { limit: 10, id: 'b' }).items.map((i) => i.rows)).toEqual([[{ type: 'changed', id: 'b' }]]); });
  it('the route refuses what is no kind', async () => {
    const r = await createApi().request('http://127.0.0.1:4815/api/changes?type=drop', { headers: { host: '127.0.0.1:4815' } });
    expect(r.status).toBe(400);
  });
});
