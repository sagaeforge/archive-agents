import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkGraphBundle, GRAPH_VENDOR_BUDGET_GZ } from '../scripts/check-dist.mjs';
import { parseBenchResult } from '../scripts/lib/bench-result.mjs';
import { createKbMock } from '../dev/kb-mock/app.ts';
import { invalidateMoving } from '../src/data/lifecycle.ts';
import { MANUAL_REFRESH } from '../src/data/graph.ts';
import { toggleInList } from '../src/graph/FilterPanel.tsx';
import { DEFAULT_PROFILE, labelBudget, profileFor, RADEON_PROFILE } from '../src/graph/gpuProfile.ts';
import { HYSTERESIS, LabelSelector } from '../src/graph/labels.ts';
import { evictions, memoryLayoutStore, type LayoutStore } from '../src/graph/layoutCache.ts';
import { coldLayout, placeNew } from '../src/graph/layoutCore.ts';
import { placeDisplayed, resolveLayout, type LayoutDeps } from '../src/graph/layoutFlow.ts';
import { layoutInput, seedPositions } from '../src/graph/layoutInput.ts';
import { decideLayout, findBySha, isValidLayout, KEEP_LAYOUTS, LAYOUT_VERSION, SOFT_MISS_COVERAGE, type CachedLayout } from '../src/graph/layoutPlan.ts';
import { decodeGraph, decodeTopology, degrees, drawnEdges, mergeGraphs, nodeSize, relationsOf, topologyOf, truncationOf, type GraphData, type Topology } from '../src/graph/model.ts';
import { topologyHash } from '../src/graph/topology.ts';
import { SearchParamError, validateGraphSearch } from '../src/routes/search.ts';

const edge = (id: string, src: string, dst: string, status = 'active', rtype = 'USES') => ({ id, src, dst, rtype, status });
const node = (id: string, label = id) => ({ id, label, type: 'Tool', status: 'active' });
const graph = (ids: string[], edges: ReturnType<typeof edge>[]): GraphData => ({ nodes: ids.map((i) => node(i)), edges });

describe('graph model (design 6.1, 7.3)', () => {
  it('decodes by column name and ignores what it does not know', () => {
    const g = decodeGraph({ nodes: { columns: ['future', 'label', 'id', 'type', 'status'], rows: [[1, '가', 'a', 'Tool', 'active']] }, edges: { columns: ['rtype', 'status', 'dst', 'src', 'id'], rows: [['USES', 'superseded', 'b', 'a', 'r']] } });
    expect(g).toEqual({ nodes: [node('a', '가')], edges: [edge('r', 'a', 'b', 'superseded')] });
  });
  it('an edge without a status column counts as active', () => {
    expect(decodeGraph({ nodes: { columns: ['id'], rows: [] }, edges: { columns: ['id', 'src', 'dst', 'rtype'], rows: [['r', 'a', 'b', 'USES']] } }).edges[0]!.status).toBe('active');
  });
  it('takes only ids and ends from an export, and refuses anything else', () => {
    expect(decodeTopology({ nodes: { columns: ['id', 'label'], rows: [['a', 'secret label']] }, edges: { columns: ['id', 'src', 'dst'], rows: [['r', 'a', 'a']] } })).toEqual({ ids: ['a'], pairs: [['a', 'a']] });
    expect(decodeTopology(new Blob(['x']))).toBeNull();
    expect(decodeTopology(null)).toBeNull();
  });
  it('merges an expansion without relabelling what is on screen', () => {
    const merged = mergeGraphs(graph(['a'], []), { nodes: [node('a', 'other'), node('b')], edges: [edge('r', 'a', 'b')] });
    expect(merged.nodes.map((n) => n.label)).toEqual(['a', 'b']);
    expect(merged.edges).toHaveLength(1);
  });
  it('tells which of nodes and edges were cut from the totals (design 3)', () => {
    const g = graph(['a', 'b'], [edge('r', 'a', 'b')]);
    expect(truncationOf({ node_total: 2, edge_total: 5, truncated: true }, g)).toMatchObject({ any: true, nodes: false, edges: true });
    expect(truncationOf({ node_total: 9, edge_total: 1, truncated: true }, g)).toMatchObject({ nodes: true, edges: false });
  });
  it('keeps every parallel edge and draws one line per pair, in either direction', () => {
    const d = drawnEdges(graph(['a', 'b'], [edge('r1', 'a', 'b'), edge('r2', 'a', 'b', 'active', 'PART_OF'), edge('r3', 'b', 'a')]));
    expect(d.map((e) => e.id)).toEqual(['r1', 'r2', 'r3']);
    expect(d.filter((e) => e.drawn).map((e) => e.id)).toEqual(['r1']);
  });
  it('dashes a pair only when all of it is superseded, and leaves out dead edges and missing ends', () => {
    const d = drawnEdges(graph(['a', 'b', 'c'], [edge('r1', 'a', 'b', 'superseded'), edge('r2', 'a', 'c', 'superseded'), edge('r3', 'c', 'a'), edge('r4', 'b', 'c', 'dead'), edge('r5', 'a', 'z')]));
    expect(d.find((e) => e.id === 'r1')).toMatchObject({ drawn: true, dashed: true });
    expect(d.find((e) => e.id === 'r2')).toMatchObject({ drawn: true, dashed: false });
    expect(d.map((e) => e.id)).not.toContain('r4');
    expect(d.map((e) => e.id)).not.toContain('r5');
  });
  it('counts distinct neighbours, so parallel edges do not grow a node', () => {
    const d = degrees(drawnEdges(graph(['a', 'b'], [edge('r1', 'a', 'b'), edge('r2', 'a', 'b'), edge('r3', 'b', 'a')])));
    expect(d.get('a')).toBe(1);
    expect(nodeSize(0)).toBe(2);
    expect(nodeSize(10_000)).toBe(12);
  });
  it('lists every parallel edge in the panel with its direction', () => {
    const r = relationsOf({ nodes: [node('a', '가'), node('b', '나')], edges: [edge('r1', 'a', 'b'), edge('r2', 'b', 'a', 'superseded', 'PART_OF')] }, 'a');
    expect(r).toEqual([
      { id: 'r2', rtype: 'PART_OF', direction: 'in', peer: 'b', peerLabel: '나', status: 'superseded' },
      { id: 'r1', rtype: 'USES', direction: 'out', peer: 'b', peerLabel: '나', status: 'active' },
    ]);
  });
});

describe('topology hash (design 6.2)', () => {
  const t: Topology = { ids: ['b', 'a'], pairs: [['a', 'b'], ['b', 'a']] };
  it('does not depend on order', async () => {
    expect(await topologyHash(t)).toBe(await topologyHash({ ids: ['a', 'b'], pairs: [['b', 'a'], ['a', 'b']] }));
  });
  it('is the same for a publish that only changes labels and statuses', async () => {
    const a = topologyOf({ nodes: [node('a', 'x'), node('b')], edges: [edge('r', 'a', 'b')] });
    const b = topologyOf({ nodes: [node('a', 'renamed'), node('b')], edges: [edge('other', 'a', 'b', 'superseded')] });
    expect(await topologyHash(a)).toBe(await topologyHash(b));
  });
  it('tells direction, a new node and a new edge apart, and the scope keeps filters apart', async () => {
    const base = await topologyHash(t);
    expect(await topologyHash({ ids: ['a', 'b'], pairs: [['a', 'b']] })).not.toBe(base);
    expect(await topologyHash({ ...t, ids: ['a', 'b', 'c'] })).not.toBe(base);
    expect(await topologyHash(t, 'types=Tool')).not.toBe(base);
    expect(await topologyHash({ ids: ['a'], pairs: [] })).not.toBe(await topologyHash({ ids: [], pairs: [] }));
  });
});

const record = (over: Partial<CachedLayout> & { ids: string[] }): CachedLayout => {
  const n = over.ids.length;
  return { hash: 'h', version: LAYOUT_VERSION, sha: null, at: 1, xy: new Float32Array(n * 2), community: new Int32Array(n), ...over };
};
const ids = (n: number, prefix = 'n') => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`);

describe('which path a layout takes (design 6.2)', () => {
  it('same hash is a hit', () => {
    expect(decideLayout('h', ['a'], [record({ ids: ['a'] })]).kind).toBe('hit');
  });
  it('the threshold is at least 90% of the current nodes', () => {
    expect(SOFT_MISS_COVERAGE).toBe(0.9);
    const old = record({ hash: 'old', ids: ids(90) });
    expect(decideLayout('new', ids(100), [old])).toMatchObject({ kind: 'soft', coverage: 0.9 });
    expect(decideLayout('new', ids(101), [old]).kind).toBe('cold');
  });
  it('soft miss looks at the most recent layout only', () => {
    const covering = record({ hash: 'a', ids: ids(100), at: 1 }), recent = record({ hash: 'b', ids: ['x'], at: 2 });
    expect(decideLayout('new', ids(100), [covering, recent]).kind).toBe('cold');
  });
  it('no cached layout, or one from another layout version, is cold', () => {
    expect(decideLayout('h', ['a'], []).kind).toBe('cold');
    expect(decideLayout('h', ['a'], [record({ ids: ['a'], version: LAYOUT_VERSION + 1 })]).kind).toBe('cold');
    expect(findBySha([record({ ids: ['a'], sha: 's', version: LAYOUT_VERSION + 1 })], 's')).toBeNull();
  });
  it('keeps the newest five', () => {
    expect(KEEP_LAYOUTS).toBe(5);
    const all = Array.from({ length: 7 }, (_, i) => record({ hash: `h${i}`, ids: [], at: i }));
    expect(evictions(all).sort()).toEqual(['h0', 'h1']);
  });
});

const chain = (ids_: string[]): Topology => ({ ids: ids_, pairs: ids_.slice(1).map((id, i) => [ids_[i]!, id] as const) });
const spy = (seed: CachedLayout[] = []) => {
  const calls = { manifest: 0, core: 0, cold: 0, place: 0 };
  const store = memoryLayoutStore(seed);
  const deps = (sha: string | null, core: Topology | null, s: LayoutStore = store): LayoutDeps => ({
    readManifestSha: async () => { calls.manifest++; return sha; },
    readCore: async () => { calls.core++; return core; },
    store: s,
    cold: async (i) => { calls.cold++; return coldLayout(i); },
    place: async (i) => { calls.place++; return placeNew(i); },
    now: () => calls.cold + calls.place + calls.core,
  });
  return { calls, deps, store };
};
const view = (t: Topology): GraphData => ({ nodes: t.ids.map((i) => node(i)), edges: t.pairs.map(([a, b], i) => edge(`r${i}`, a, b)) });

describe('layout flow (design 6.2)', () => {
  const core = chain(ids(60));
  it('computes once, then an unchanged manifest reads the cache without downloading the export', async () => {
    const { calls, deps } = spy();
    const seen: number[] = [];
    const first = await resolveLayout(deps('s1', core), view(core), '', (n) => seen.push(n));
    expect(first).toMatchObject({ kind: 'cold', source: 'core' });
    expect(seen).toEqual([60]);
    const again = await resolveLayout(deps('s1', core), view(core), '');
    expect(again.kind).toBe('hit');
    expect(calls).toMatchObject({ core: 1, cold: 1, place: 0 });
    expect(again.positions).toEqual(first.positions);
  });
  it('a new publish with the same topology is a hit and does not recompute', async () => {
    const { calls, deps } = spy();
    await resolveLayout(deps('s1', core), view(core), '');
    expect((await resolveLayout(deps('s2', core), view(core), '')).kind).toBe('hit');
    expect(calls).toMatchObject({ core: 2, cold: 1, place: 0 });
    // The new value is remembered: the third open does not download.
    await resolveLayout(deps('s2', core), view(core), '');
    expect(calls.core).toBe(2);
  });
  it('a small change is a soft miss: existing nodes do not move at all and new ones are placed', async () => {
    const { calls, deps } = spy();
    const first = await resolveLayout(deps('s1', core), view(core), '');
    const next: Topology = { ids: [...core.ids, 'new1'], pairs: [...core.pairs, ['new1', core.ids[5]!]] };
    const soft = await resolveLayout(deps('s2', next), view(next), '');
    expect(soft.kind).toBe('soft');
    expect(calls).toMatchObject({ cold: 1, place: 1 });
    for (const [id, p] of first.positions) expect(soft.positions.get(id)).toEqual(p);
    expect(soft.positions.get('new1')!.x).toEqual(expect.any(Number));
    expect(Number.isNaN(soft.positions.get('new1')!.x)).toBe(false);
    // The new node takes its neighbour's community (design 6.2).
    expect(soft.positions.get('new1')!.community).toBe(first.positions.get(core.ids[5]!)!.community);
    // And that layout is cached for the next open.
    expect((await resolveLayout(deps('s2', next), view(next), '')).kind).toBe('hit');
  });
  it('a big change is cold', async () => {
    const { deps } = spy();
    await resolveLayout(deps('s1', core), view(core), '');
    const next = chain(ids(40, 'other'));
    expect((await resolveLayout(deps('s2', next), view(next), '')).kind).toBe('cold');
  });
  it('without a published export the overview is the input and the filter is in the key', async () => {
    const { calls, deps } = spy();
    const g = view(core);
    expect(await resolveLayout(deps(null, null), g, 'a')).toMatchObject({ kind: 'cold', source: 'overview' });
    expect(calls.core).toBe(0);
    expect((await resolveLayout(deps(null, null), g, 'a')).kind).toBe('hit');
    // Same picture, other filter: another key, and the coordinates carry over through the soft path.
    expect((await resolveLayout(deps(null, null), g, 'b')).kind).toBe('soft');
  });
  it('an export that cannot be read falls back to the overview', async () => {
    const { deps } = spy();
    expect(await resolveLayout(deps('s1', null), view(core), '')).toMatchObject({ source: 'overview', kind: 'cold' });
  });
  it('a store that fails only costs a recomputation', async () => {
    const { calls, deps } = spy();
    const broken: LayoutStore = { list: async () => [], put: async () => { /* writes nowhere, like the IndexedDB store on failure */ } };
    await resolveLayout(deps('s1', core, broken), view(core), '');
    expect((await resolveLayout(deps('s1', core, broken), view(core), '')).kind).toBe('cold');
    expect(calls.cold).toBe(2);
  });
  it('stores ids, coordinates and communities, and no label', async () => {
    const { deps, store } = spy();
    const g: GraphData = { nodes: core.ids.map((i) => node(i, `라벨 ${i}`)), edges: view(core).edges };
    await resolveLayout(deps('s1', core), g, '');
    const [r] = await store.list();
    expect(Object.keys(r!).sort()).toEqual(['at', 'community', 'hash', 'ids', 'sha', 'version', 'xy']);
    expect(JSON.stringify(r)).not.toContain('라벨');
  });
  it('places displayed nodes the layout lacks, keeps the rest, and stores nothing', async () => {
    const { calls, deps, store } = spy();
    const { positions } = await resolveLayout(deps('s1', core), view(core), '');
    const before = (await store.list()).length;
    const g: GraphData = { nodes: [...view(core).nodes, node('past')], edges: [...view(core).edges, edge('rx', 'past', core.ids[0]!)] };
    const placed = await placeDisplayed(deps('s1', core), g, positions);
    expect(placed.has('past')).toBe(true);
    for (const [id, p] of positions) expect(placed.get(id)).toEqual(p);
    expect(calls.place).toBe(1);
    expect((await store.list()).length).toBe(before);
    expect(await placeDisplayed(deps('s1', core), view(core), positions)).toBe(positions);
  });
});

describe('a superseded load touches nothing (design 6.2)', () => {
  const core = chain(ids(60));
  const stages = ['after the store read', 'after the manifest', 'after the export', 'after the layout'] as const;
  it.each(stages)('aborted %s: no onCold after that point, no write, a rejection', async (stage) => {
    const { deps } = spy();
    const puts: string[] = [], controller = new AbortController(), base = deps('s1', core);
    const store: LayoutStore = {
      list: async () => { const r = await base.store.list(); if (stage === stages[0]) controller.abort(); return r; },
      put: async (r) => { puts.push(r.hash); },
    };
    const colds: number[] = [];
    const d: LayoutDeps = {
      ...base, store, signal: controller.signal,
      readManifestSha: async () => { const r = await base.readManifestSha(); if (stage === stages[1]) controller.abort(); return r; },
      readCore: async () => { const r = await base.readCore(); if (stage === stages[2]) controller.abort(); return r; },
      cold: async (i) => { const r = await base.cold(i); if (stage === stages[3]) controller.abort(); return r; },
    };
    await expect(resolveLayout(d, view(core), '', (n) => colds.push(n))).rejects.toThrow();
    expect(puts).toEqual([]);
    expect(colds).toEqual(stage === stages[3] ? [60] : []);
  });
  it('a soft miss aborted during placement writes nothing', async () => {
    const { deps, store } = spy();
    await resolveLayout(deps('s1', core), view(core), '');
    const next: Topology = { ids: [...core.ids, 'new1'], pairs: [...core.pairs, ['new1', core.ids[5]!]] };
    const controller = new AbortController(), base = deps('s2', next);
    const before = (await store.list()).length;
    const d: LayoutDeps = { ...base, signal: controller.signal, place: async (i) => { const r = await base.place(i); controller.abort(); return r; } };
    await expect(resolveLayout(d, view(next), '')).rejects.toThrow();
    expect((await store.list()).length).toBe(before);
  });
  it('a load already aborted never reads', async () => {
    const { calls, deps } = spy();
    await expect(resolveLayout({ ...deps('s1', core), signal: AbortSignal.abort() }, view(core), '')).rejects.toThrow();
    expect(calls).toMatchObject({ manifest: 0, core: 0, cold: 0 });
  });
});

describe('a record is checked against the graph it is for', () => {
  const core = chain(ids(60));
  const foreign = (over: Partial<CachedLayout>) => record({ ids: ids(60, 'other'), xy: new Float32Array(120), community: new Int32Array(60), ...over });
  it('the same hash with other ids is not a hit', () => {
    expect(decideLayout('h', ids(60), [foreign({ hash: 'h' })]).kind).toBe('cold');
    expect(decideLayout('h', ids(3), [record({ hash: 'h', ids: ids(4), xy: new Float32Array(8), community: new Int32Array(4) })]).kind).toBe('soft');
  });
  it('the same sha with foreign ids is a miss: read, recompute, nothing re-placed', async () => {
    const { calls, deps, store } = spy([foreign({ hash: 'stale', sha: 's1' })]);
    const r = await resolveLayout(deps('s1', core), view(core), '');
    expect(r.kind).toBe('cold');
    expect(calls).toMatchObject({ core: 1, cold: 1, place: 0 });
    expect(await placeDisplayed(deps('s1', core), view(core), r.positions)).toBe(r.positions);
    expect((await resolveLayout(deps('s1', core), view(core), '')).kind).toBe('hit');
    expect((await store.list()).find((x) => x.sha === 's1' && x.at > 1)!.ids).toEqual([...core.ids].sort());
  });
  it('the same sha and hash with foreign ids is overwritten', async () => {
    const { deps, store } = spy();
    await resolveLayout(deps('s1', core), view(core), '');
    const [good] = await store.list();
    const spoiled = { ...good!, ids: ids(60, 'other').sort() };
    const { calls, deps: d2, store: s2 } = spy([spoiled]);
    expect((await resolveLayout(d2('s1', core), view(core), '')).kind).toBe('cold');
    expect(calls.place).toBe(0);
    const after = await s2.list();
    expect(after).toHaveLength(1);
    expect(after[0]!.ids).toEqual([...core.ids].sort());
  });
  it('a node of a partly foreign record does not pass as a hit', async () => {
    const mixed = [...ids(59), 'other'].sort();
    const { calls, deps } = spy([record({ hash: 'stale', sha: 's1', ids: mixed, xy: new Float32Array(120), community: new Int32Array(60) })]);
    const r = await resolveLayout(deps('s1', core), view(core), '');
    expect(r.kind).toBe('soft');
    expect(calls.core).toBe(1);
  });
  it('a filtered overview is still a hit without a download', async () => {
    const { calls, deps } = spy();
    await resolveLayout(deps('s1', core), view(core), '');
    const part: GraphData = { nodes: view(core).nodes.slice(0, 10), edges: [] };
    expect((await resolveLayout(deps('s1', core), part, '')).kind).toBe('hit');
    expect(calls.core).toBe(1);
  });
});

describe('a cached layout is checked before it is believed', () => {
  const good = () => record({ hash: 'g', sha: 's1', ids: ['a', 'b'], xy: new Float32Array([1, 2, 3, 4]), community: new Int32Array([0, 1]) });
  const bad: [string, (r: any) => void][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ['ids is not a list', (r) => { r.ids = 5; }],
    ['ids holds a non-string', (r) => { r.ids = ['a', 7]; }],
    ['ids repeat', (r) => { r.ids = ['a', 'a']; }],
    ['xy is short', (r) => { r.xy = new Float32Array([1, 2]); }],
    ['xy is long', (r) => { r.xy = new Float32Array(6); }],
    ['xy is a plain array', (r) => { r.xy = [1, 2, 3, 4]; }],
    ['xy holds NaN', (r) => { r.xy[1] = Number.NaN; }],
    ['xy holds Infinity', (r) => { r.xy[2] = Number.POSITIVE_INFINITY; }],
    ['xy holds -Infinity', (r) => { r.xy[3] = Number.NEGATIVE_INFINITY; }],
    ['community is short', (r) => { r.community = new Int32Array(1); }],
    ['community is missing', (r) => { delete r.community; }],
    ['at is not a number', (r) => { r.at = 'yesterday'; }],
    ['sha is not a string', (r) => { r.sha = 9; }],
  ];
  it('takes a good record', () => { expect(isValidLayout(good())).toBe(true); });
  it('takes an empty one and turns down what is not a record', () => {
    expect(isValidLayout(record({ ids: [] }))).toBe(true);
    for (const v of [null, undefined, 5, 'x', {}]) expect(isValidLayout(v)).toBe(false);
  });
  it.each(bad)('turns down a record where %s', (_, spoil) => { const r = good(); spoil(r); expect(isValidLayout(r)).toBe(false); });
  it.each(bad)('a matching record where %s is a miss, not a hit', (_, spoil) => {
    const r = good(); spoil(r);
    expect(decideLayout('g', ['a', 'b'], [r]).kind).toBe('cold');
    expect(findBySha([r], 's1')).toBeNull();
  });
  it('a bad recent record is not soft-miss material, and does not hide a good older one', () => {
    const old = { ...good(), hash: 'old', at: 1 }, recent = { ...good(), hash: 'new', at: 2, xy: new Float32Array([Number.NaN, 0, 0, 0]) };
    expect(decideLayout('other', ['a', 'b'], [old, recent])).toMatchObject({ kind: 'soft', record: { hash: 'old' } });
  });
  it('an old layout version stays valid and unused: the version is the plan\'s business', () => {
    const r = { ...good(), version: LAYOUT_VERSION + 1 };
    expect(isValidLayout(r)).toBe(true);
    expect(decideLayout('g', ['a', 'b'], [r]).kind).toBe('cold');
  });
  it('eviction drops bad records first, whatever their age, and survives an unreadable `at`', () => {
    const fine = Array.from({ length: 5 }, (_, i) => ({ ...good(), hash: `h${i}`, at: i + 1 }));
    const broken = { ...good(), hash: 'broken', at: 'nope' as unknown as number, xy: new Float32Array(1) };
    expect(evictions([broken, ...fine])).toEqual(['broken']);
    expect(evictions([{ ...good(), hash: 'fresh-bad', at: 99, xy: new Float32Array([Number.NaN, 0, 0, 0]) }, ...fine.slice(0, 2)])).toEqual(['fresh-bad']);
  });
  const core = chain(ids(60));
  it.each(bad.filter(([n]) => !/^(sha)/.test(n)))('the flow recomputes and overwrites a record where %s', async (_, spoil) => {
    const { calls, deps, store } = spy();
    await resolveLayout(deps('s1', core), view(core), '');
    const [r] = await store.list();
    spoil(r!);
    const again = await resolveLayout(deps('s1', core), view(core), '');
    expect(again.kind).toBe('cold');
    expect(calls.cold).toBe(2);
    for (const p of again.positions.values()) { expect(Number.isFinite(p.x)).toBe(true); expect(Number.isFinite(p.y)).toBe(true); }
    const after = await store.list();
    expect(after).toHaveLength(1);
    expect(isValidLayout(after[0])).toBe(true);
    expect((await resolveLayout(deps('s1', core), view(core), '')).kind).toBe('hit');
  });
});

describe('layout computation (design 6.2)', () => {
  const t = chain(ids(30));
  it('is deterministic', () => {
    const a = coldLayout(layoutInput(t)), b = coldLayout(layoutInput({ ids: [...t.ids].reverse(), pairs: [...t.pairs].reverse() }));
    expect(a.xy).toEqual(b.xy);
    expect(a.community).toEqual(b.community);
  });
  it('dedupes parallel edges and self loops before the layout', () => {
    expect([...layoutInput({ ids: ['b', 'a'], pairs: [['a', 'b'], ['b', 'a'], ['a', 'b'], ['a', 'a'], ['a', 'gone']] }).edges]).toEqual([0, 1]);
  });
  it('copes with nothing to do', () => {
    expect(coldLayout(layoutInput({ ids: [], pairs: [] })).xy).toHaveLength(0);
    expect(coldLayout(layoutInput({ ids: ['a'], pairs: [] })).community).toHaveLength(1);
    expect(coldLayout(layoutInput({ ids: ['a', 'b'], pairs: [] })).community).toEqual(new Int32Array([0, 1]));
  });
  it('the seed is the same every time', () => { expect(seedPositions(4)).toEqual(seedPositions(4)); });
  it('fixed nodes stay exactly where they were, and a chain of new nodes still gets a community', () => {
    const input = layoutInput({ ids: ['a', 'b', 'x', 'y'], pairs: [['a', 'b'], ['x', 'a'], ['y', 'x']] });
    const known = new Float32Array([10, 20, 30, 40, Number.NaN, Number.NaN, Number.NaN, Number.NaN]);
    const out = placeNew({ ...input, known, community: new Int32Array([7, 7, -1, -1]) });
    expect([...out.xy.slice(0, 4)]).toEqual([10, 20, 30, 40]);
    expect(out.xy.slice(4).every(Number.isFinite)).toBe(true);
    expect([...out.community]).toEqual([7, 7, 7, 7]);
  });
  it('a new node with no neighbour lands in the frame and has no community', () => {
    const input = layoutInput({ ids: ['a', 'b', 'z'], pairs: [['a', 'b']] });
    const out = placeNew({ ...input, known: new Float32Array([0, 0, 100, 100, Number.NaN, Number.NaN]), community: new Int32Array([1, 1, -1]) });
    expect(out.xy.slice(4).every(Number.isFinite)).toBe(true);
    expect(out.community[2]).toBe(-1);
  });
});

describe('Radeon static profile (design 6.1.1)', () => {
  it.each([
    ['ANGLE (AMD, AMD Radeon(TM) Graphics (0x0000164E) Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    ['AMD Radeon Graphics (0x164E)'],
    ['ANGLE (AMD, RADEON RX 7900, OpenGL)'],
  ])('%s gets the Radeon profile', (s) => {
    expect(profileFor(s)).toBe(RADEON_PROFILE);
    expect(profileFor(s)).toMatchObject({ hideEdgesOnMove: true, antialiasEdges: false, maxLabels: 100, allow20k: false });
  });
  it.each([
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 SUPER (0x00002702) Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'],
    ['ANGLE (Intel, Intel(R) UHD Graphics, D3D11)'],
    [null], [undefined], [''],
  ])('%s gets the default profile', (s) => {
    expect(profileFor(s)).toBe(DEFAULT_PROFILE);
    expect(profileFor(s)).toMatchObject({ hideEdgesOnMove: false, antialiasEdges: true, maxLabels: 400, allow20k: true });
  });
  it('K follows the viewport under each ceiling (design 6.1)', () => {
    expect(labelBudget(2279, 1281, DEFAULT_PROFILE)).toBe(Math.round((2279 * 1281) / 15000));
    expect(labelBudget(5000, 4000, DEFAULT_PROFILE)).toBe(400);
    expect(labelBudget(2279, 1281, RADEON_PROFILE)).toBe(100);
    expect(labelBudget(300, 300, RADEON_PROFILE)).toBe(6);
  });
});

describe('label selection (design 6.1)', () => {
  const identity = { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 };
  const view_ = { width: 1000, height: 600 };
  const sel = (s: LabelSelector) => [...s.sel.subarray(0, s.selN)];
  it('takes larger nodes first and stops at K', () => {
    const xs = [10, 200, 400, 600], ys = [20, 120, 220, 320];
    const s = new LabelSelector(xs, ys, [1, 4, 3, 2], 2, () => 40);
    s.select(identity, view_, 1);
    expect(sel(s)).toEqual([1, 2]);
  });
  it('rejects a collision and skips what is off screen', () => {
    const s = new LabelSelector([100, 110, 5000], [100, 100, 100], [5, 4, 9], 5, () => 40);
    s.select(identity, view_, 1);
    expect(sel(s)).toEqual([0]);
  });
  it('offsets the label by the node radius from sigma.scaleSize', () => {
    const s = new LabelSelector([100], [100], [5], 1, () => 40);
    s.select(identity, view_, 2);
    expect(s.selX[0]).toBe(100 + 5 * 2 + 3);
  });
  it('keeps a label on screen against a slightly larger neighbour (hysteresis)', () => {
    // Node 1 is bigger, but only node 0 fits at first because 1 starts off screen.
    const s = new LabelSelector([100, -500], [100, 100], [5, 5 * (HYSTERESIS - 0.05)], 1, () => 40);
    s.select(identity, view_, 1);
    expect(sel(s)).toEqual([0]);
    s.setPosition(1, 110, 100);
    s.select(identity, view_, 1);
    expect(sel(s)).toEqual([0]);
  });
  it('does not keep a label against a much larger one', () => {
    const s = new LabelSelector([100, -500], [100, 100], [5, 5 * (HYSTERESIS + 0.5)], 2, () => 40);
    s.select(identity, view_, 1);
    s.setPosition(1, 110, 100);
    s.select(identity, view_, 1);
    expect(sel(s)).toEqual([1]);
  });
  it('gives a hovered node and its neighbours the first places, then goes back', () => {
    const s = new LabelSelector([100, 110, 700], [100, 100, 300], [9, 1, 2], 2, () => 40);
    s.setPriority([1]);
    s.select(identity, view_, 1);
    expect(sel(s)[0]).toBe(1);
    s.setPriority([]);
    s.select(identity, view_, 1);
    s.select(identity, view_, 1);
    expect(sel(s)).toContain(0);
  });
});

describe('graph search params (design 1, 3)', () => {
  it('keeps what is valid', () => {
    expect(validateGraphSearch({ types: 'Tool,Feature', rtypes: 'USES', domain: 'G', focus: 'e:tool:a', sel: 'e:tool:b', depth: 2, view: '20k', edge_status: 'active,superseded' }))
      .toEqual({ types: 'Tool,Feature', rtypes: 'USES', domain: 'G', focus: 'e:tool:a', sel: 'e:tool:b', depth: 2, view: '20k', edge_status: 'active,superseded' });
    expect(validateGraphSearch({ depth: '1' })).toEqual({ depth: 1 });
    expect(validateGraphSearch({})).toEqual({});
  });
  it.each([
    [{ types: 'Tool&limit=1' }], [{ rtypes: 'a b' }], [{ domain: ',' }], [{ focus: '../../v1/ops' }], [{ sel: '..' }], [{ depth: 3 }], [{ view: '50k' }], [{ edge_status: 'dead' }],
  ])('refuses %j', (s) => { expect(() => validateGraphSearch(s)).toThrow(SearchParamError); });
});

describe('filter toggles', () => {
  const all = ['A', 'B', 'C'];
  it('unchecks from all, adds back, and returns to no parameter', () => {
    expect(toggleInList(undefined, all, 'B')).toBe('A,C');
    expect(toggleInList('A,C', all, 'B')).toBeUndefined();
    expect(toggleInList('A', all, 'C')).toBe('A,C');
  });
  it('turning everything off goes back to the default call rather than asking for nothing', () => {
    expect(toggleInList('A', all, 'A')).toBeUndefined();
  });
});

describe('kb-mock graph reads (C 2.7, 4.3, 4.6)', () => {
  const app = createKbMock({});
  const json = async (path: string) => (await app.request(`http://127.0.0.1${path}`)).json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  it('overview edges have a status column and edge_status widens edges only', async () => {
    const plain = await json('/v1/overview');
    expect(plain.data.edges.columns).toContain('status');
    const wide = await json('/v1/overview?edge_status=active,superseded');
    expect(wide.data.meta.node_total).toBe(plain.data.meta.node_total);
    const statuses = new Set(wide.data.edges.rows.map((r: unknown[]) => r[wide.data.edges.columns.indexOf('status')]));
    expect([...statuses].every((s) => s === 'active' || s === 'superseded')).toBe(true);
    expect(wide.data.meta.edge_total).toBeGreaterThanOrEqual(plain.data.meta.edge_total);
  });
  it('neighbor edges have a status column too', async () => {
    const o = await json('/v1/overview');
    const id = o.data.nodes.rows[0][0] as string;
    const n = await json(`/v1/nodes/${encodeURIComponent(id)}/neighbors?edge_status=all`);
    expect(n.data.edges.columns).toContain('status');
  });
});

describe('a new publish leaves the graph alone (design 7.3)', () => {
  it('the invalidation skips queries marked for a manual refresh', async () => {
    const qc = new QueryClient();
    const cache = qc.getQueryCache();
    const manual = cache.build(qc, { queryKey: ['/v1/overview', {}], meta: MANUAL_REFRESH });
    const plain = cache.build(qc, { queryKey: ['/v1/nodes/x', {}] });
    manual.setData({ a: 1 }); plain.setData({ a: 1 });
    await invalidateMoving(qc, false);
    expect(manual.state.isInvalidated).toBe(false);
    expect(plain.state.isInvalidated).toBe(true);
  });
});

describe('graph bundle guard (design 11)', () => {
  const dist = (entry: string, html = '<script src="./assets/index-a.js"></script>', vendor = 'x'.repeat(1000)) => {
    const dir = mkdtempSync(join(tmpdir(), 'loupe-dist-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), html);
    writeFileSync(join(dir, 'assets/index-a.js'), entry);
    writeFileSync(join(dir, 'assets/graph-vendor-a.js'), vendor);
    return dir;
  };
  const check = (dir: string) => { try { return checkGraphBundle(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
  it('passes a lazy chunk within the budget', () => {
    expect(GRAPH_VENDOR_BUDGET_GZ).toBe(130 * 1024);
    expect(check(dist('import("./graph-vendor-a.js")')).ok).toBe(true);
  });
  it('fails a static import, a preload in the document, and sigma in the entry', () => {
    expect(check(dist('import{a}from"./graph-vendor-a.js"')).ok).toBe(false);
    expect(check(dist('x', '<script src="./assets/index-a.js"></script><link href="./assets/graph-vendor-a.js">')).ok).toBe(false);
    expect(check(dist('const s={hideEdgesOnMove:!1}')).ok).toBe(false);
  });
  it('fails a chunk over the budget', () => {
    expect(check(dist('x', undefined, Array.from({ length: 200_000 }, () => Math.random().toString(36)).join(''))).ok).toBe(false);
  });
});

describe('bench server input', () => {
  const full = { label: 'rtx', size: '10k', env: { renderer: 'r', profile: 'default' }, init: { firstFrameMs: 1 }, sync: { cpuGpu: { p95: 2 }, overlay: { p95: 0 } }, passive: { over20: 0 }, hoverEnter: { p95: 3 }, click: { p95: 4 } };
  it.each(['not json', '', '[]', 'null', '5', '{}', '{"sync":{}}', JSON.stringify({ ...full, env: undefined }), '{"error":5}'])('refuses %s', (b) => { expect(parseBenchResult(b).ok).toBe(false); });
  it('takes a result and a reported failure', () => {
    expect(parseBenchResult(JSON.stringify(full))).toMatchObject({ ok: true, line: expect.stringContaining('first frame 1 ms') });
    expect(parseBenchResult('{"error":"boom"}')).toEqual({ ok: true, line: 'failed: boom' });
  });
});
