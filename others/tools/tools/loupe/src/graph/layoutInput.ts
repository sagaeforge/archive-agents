// The layout's input and seed. Kept apart from layoutCore.ts so the main thread can draw a seed without loading FA2 and Louvain, which belong in the worker chunk.
import type { Pair, Topology } from './model.ts';

export const SPREAD = 1000;

/** Sorted ids and each undirected pair once, as indices: what S3 measured. Self loops have no force and are dropped. */
export type LayoutInput = { ids: string[]; edges: Int32Array };
export type LayoutResult = { xy: Float32Array; community: Int32Array };
/** For placement: `known` holds the fixed coordinates, NaN for a node still to place. `community` is -1 for those. */
export type PlaceInput = LayoutInput & { known: Float32Array; community: Int32Array };

export function layoutInput(t: Topology): LayoutInput {
  const ids = [...new Set(t.ids)].sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const keys = new Set<number>();
  for (const [src, dst] of t.pairs as readonly Pair[]) {
    const a = index.get(src), b = index.get(dst);
    if (a === undefined || b === undefined || a === b) continue;
    keys.add(Math.min(a, b) * n + Math.max(a, b));
  }
  // Sorted: FA2 depends on edge order, and the same topology must give the same picture however the rows arrived.
  const sorted = Float64Array.from(keys).sort();
  const edges = new Int32Array(sorted.length * 2);
  sorted.forEach((key, i) => { edges[2 * i] = Math.floor(key / n); edges[2 * i + 1] = key % n; });
  return { ids, edges };
}

export function seededRandom(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The start of the layout, which is also what a cold open draws until the result arrives (design 6.2). */
export function seedPositions(n: number): Float32Array {
  const r = seededRandom(11), xy = new Float32Array(n * 2);
  for (let i = 0; i < n * 2; i++) xy[i] = r() * SPREAD;
  return xy;
}
