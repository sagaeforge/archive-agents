// The path from "the screen opened" to coordinates (design 6.2). Everything outside is injected, so the three paths are tested without a browser.
import { coversAll, decideLayout, findBySha, LAYOUT_VERSION, type CachedLayout } from './layoutPlan.ts';
import { layoutInput, seedPositions, type LayoutResult, type PlaceInput, type LayoutInput } from './layoutInput.ts';
import { topologyHash } from './topology.ts';
import type { GraphData, Topology } from './model.ts';
import { topologyOf } from './model.ts';
import type { LayoutStore } from './layoutCache.ts';

export type Point = { x: number; y: number; community: number };
export type Positions = Map<string, Point>;
export type LayoutKind = 'hit' | 'soft' | 'cold';
export type ResolvedLayout = { kind: LayoutKind; source: 'core' | 'overview'; positions: Positions };

export type LayoutDeps = {
  /** `profiles.core.sha256`, or null when nothing is published yet. */
  readManifestSha(): Promise<string | null>;
  /** The `core` export, or null when it cannot be read. */
  readCore(): Promise<Topology | null>;
  store: LayoutStore;
  cold(input: LayoutInput): Promise<LayoutResult>;
  place(input: PlaceInput): Promise<LayoutResult>;
  now?(): number;
  /** Set when a newer load has taken over or the screen is gone. */
  signal?: AbortSignal;
};

export const positionsOf = (ids: readonly string[], xy: Float32Array, community: Int32Array): Positions => {
  const out: Positions = new Map();
  ids.forEach((id, i) => out.set(id, { x: xy[2 * i]!, y: xy[2 * i + 1]!, community: community[i]! }));
  return out;
};
const recordPositions = (r: CachedLayout) => positionsOf(r.ids, r.xy, r.community);

function placeInput(input: LayoutInput, from: Positions): PlaceInput {
  const n = input.ids.length, known = new Float32Array(n * 2).fill(Number.NaN), community = new Int32Array(n).fill(-1);
  input.ids.forEach((id, i) => {
    const p = from.get(id);
    if (p) { known[2 * i] = p.x; known[2 * i + 1] = p.y; community[i] = p.community; }
  });
  return { ...input, known, community };
}

export const seededPositions = (ids: readonly string[]): Positions => {
  const sorted = [...ids].sort();
  return positionsOf(sorted, seedPositions(sorted.length), new Int32Array(sorted.length).fill(-1));
};

/** `onCold` fires as soon as a full computation is known to be needed, so the caller can draw the seed and show progress.
 *  The signal is checked after every wait: a load that lost its place stops there, with no callback and no write. */
export async function resolveLayout(deps: LayoutDeps, overview: GraphData, scope: string, onCold?: (n: number) => void): Promise<ResolvedLayout> {
  const now = deps.now ?? Date.now;
  const live = () => { deps.signal?.throwIfAborted(); };
  live();
  const records = await deps.store.list();
  live();
  const sha = await deps.readManifestSha();
  live();
  const unchanged = findBySha(records, sha);
  // The shortcut trusts the record for what it holds, so it must hold this graph. A node it lacks may be fine (overview only, design 6.2):
  // reading `core` is what tells that from a record of something else.
  if (unchanged && coversAll(overview.nodes.map((n) => n.id), unchanged)) return { kind: 'hit', source: 'core', positions: recordPositions(unchanged) };

  const core = sha ? await deps.readCore() : null;
  live();
  const source = core ? 'core' : 'overview';
  const topology = core ?? topologyOf(overview);
  const hash = await topologyHash(topology, core ? '' : scope);
  live();
  const input = layoutInput(topology);
  const save = (r: LayoutResult) => deps.store.put({ hash, version: LAYOUT_VERSION, sha: core ? sha : null, at: now(), ids: input.ids, xy: r.xy, community: r.community });

  const decision = decideLayout(hash, input.ids, records);
  if (decision.kind === 'hit') {
    await deps.store.put({ ...decision.record, sha: core ? sha : decision.record.sha, at: now() });
    return { kind: 'hit', source, positions: recordPositions(decision.record) };
  }
  if (decision.kind === 'soft') {
    const r = await deps.place(placeInput(input, recordPositions(decision.record)));
    live();
    await save(r);
    return { kind: 'soft', source, positions: positionsOf(input.ids, r.xy, r.community) };
  }
  onCold?.(input.ids.length);
  const r = await deps.cold(input);
  live();
  await save(r);
  return { kind: 'cold', source, positions: positionsOf(input.ids, r.xy, r.community) };
}

/** What is on screen but not in the layout: overview-only nodes, past nodes, an expansion. Nothing here is stored (design 6.2). */
export async function placeDisplayed(deps: Pick<LayoutDeps, 'place'>, g: GraphData, base: Positions): Promise<Positions> {
  if (g.nodes.every((n) => base.has(n.id))) return base;
  const input = layoutInput(topologyOf(g));
  const r = await deps.place(placeInput(input, base));
  const placed: Positions = new Map(base);
  input.ids.forEach((id, i) => { if (!base.has(id)) placed.set(id, { x: r.xy[2 * i]!, y: r.xy[2 * i + 1]!, community: r.community[i]! }); });
  return placed;
}
