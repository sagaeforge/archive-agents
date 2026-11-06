// The layout key (design 6.2): the sha256 of the sorted node ids and edge end pairs. Labels and statuses are not in it, so a publish that only
// changes those is a hit. build_id is never used: it changes on a rebuild, which changes nothing logical (C 2.1, 2.6).
import type { Topology } from './model.ts';

export function topologyText({ ids, pairs }: Topology): string {
  const nodes = [...ids].sort();
  const edges = pairs.map(([a, b]) => `${a}\t${b}`).sort();
  return `${nodes.join('\n')}\u0000${edges.join('\n')}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `scope` is the filter hash, used only when the overview stands in for an unpublished `core` (design 6.2). */
export const topologyHash = (t: Topology, scope = '') => sha256Hex(scope ? `${topologyText(t)}\u0000${scope}` : topologyText(t));
