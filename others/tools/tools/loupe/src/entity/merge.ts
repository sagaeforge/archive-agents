// merged_into keeps deep links alive (design 5). At most 5 hops, a cycle is an error, and a missing survivor is a tombstone.
import { KbProblem } from '../data/kbFetch.ts';

export type MergeNode = { id?: string; merged_into?: string | null; merged_into_final?: string | null };
export type MergeLookup = (id: string) => Promise<MergeNode>;
export type MergeResult =
  | { kind: 'survivor'; id: string; path: string[] }
  | { kind: 'cycle'; path: string[] }
  | { kind: 'too-deep'; path: string[] }
  | { kind: 'gone'; id: string; path: string[] };

export const MAX_MERGE_HOPS = 5;

/** The URL search after a merge redirect. The time basis and the filters are part of the screen state (completion criterion 2), so they stay. */
export function mergeRedirectSearch(prev: Record<string, unknown>, from: string): Record<string, unknown> {
  return {
    as_of_valid: prev.as_of_valid, as_of_observed: prev.as_of_observed,
    status: prev.status, include_unverified: prev.include_unverified,
    merged_from: from,
  };
}
const nextOf = (n: MergeNode) => n.merged_into_final || n.merged_into || null;

export async function followMerge(startId: string, first: MergeNode, lookup: MergeLookup, maxHops = MAX_MERGE_HOPS): Promise<MergeResult> {
  const path = [startId];
  let node = first;
  for (let hop = 1; ; hop++) {
    const next = nextOf(node);
    const at = path.at(-1)!;
    if (!next) return { kind: 'survivor', id: at, path };
    if (path.includes(next)) return { kind: 'cycle', path: [...path, next] };
    if (hop > maxHops) return { kind: 'too-deep', path };
    path.push(next);
    try {
      node = await lookup(next);
    } catch (e) {
      if (e instanceof KbProblem && e.status === 404) return { kind: 'gone', id: next, path };
      throw e;
    }
  }
}
