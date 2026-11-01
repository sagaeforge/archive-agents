// The computation behind the layout worker (design 6.2). Pure and deterministic: ids are sorted by the caller, and every random number comes
// from a fixed seed, because the seed changes the quality (0.0685 against 0.0762, N=2) and the same input must give the same picture.
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import louvain from 'graphology-communities-louvain';
import { seededRandom, seedPositions, SPREAD, type LayoutInput, type LayoutResult, type PlaceInput } from './layoutInput.ts';

export const COLD_ITERATIONS = 300;
export const LOCAL_ITERATIONS = 100;

const faSettings = (g: Graph) => ({ ...forceAtlas2.inferSettings(g), barnesHutOptimize: g.order > 2000, barnesHutTheta: 0.6, adjustSizes: false });

export function coldLayout({ ids, edges }: LayoutInput): LayoutResult {
  const n = ids.length, seed = seedPositions(n);
  const g = new Graph({ type: 'undirected', multi: false });
  for (let i = 0; i < n; i++) g.addNode(i, { x: seed[2 * i], y: seed[2 * i + 1] });
  for (let i = 0; i < edges.length; i += 2) g.addEdge(edges[i], edges[i + 1]);
  if (n > 1) forceAtlas2.assign(g, { iterations: COLD_ITERATIONS, settings: faSettings(g) });
  const xy = new Float32Array(n * 2), community = new Int32Array(n);
  g.forEachNode((k, a) => { const i = Number(k); xy[2 * i] = a.x as number; xy[2 * i + 1] = a.y as number; });
  // Louvain runs after the layout, in the same worker, with a fixed rng. It has nothing to do on a graph with no edges.
  if (g.size > 0) {
    const mapping = louvain(g, { rng: seededRandom(29) });
    for (const k of Object.keys(mapping)) community[Number(k)] = mapping[k]!;
  } else community.forEach((_, i) => { community[i] = i; });
  return { xy, community };
}

const adjacency = (n: number, edges: Int32Array) => {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < edges.length; i += 2) { adj[edges[i]!]!.push(edges[i + 1]!); adj[edges[i + 1]!]!.push(edges[i]!); }
  return adj;
};

/** A new node takes the majority community of its neighbours (design 6.2 [가정]). Run twice so a chain of new nodes still gets one. */
function inheritCommunities(adj: number[][], unknown: readonly number[], community: Int32Array) {
  for (let pass = 0; pass < 2; pass++) {
    for (const i of unknown) {
      if (community[i] !== -1) continue;
      const votes = new Map<number, number>();
      for (const j of adj[i]!) if (community[j]! >= 0) votes.set(community[j]!, (votes.get(community[j]!) ?? 0) + 1);
      let best = -1, most = 0;
      for (const [c, v] of votes) if (v > most || (v === most && c < best)) { best = c; most = v; }
      community[i] = best;
    }
  }
}

/** Soft miss, overview-only nodes, past nodes and neighbour expansion all come here: new nodes move, existing nodes are `fixed` and do not (design 6.2). */
export function placeNew({ ids, edges, known, community }: PlaceInput): LayoutResult {
  const n = ids.length;
  const xy = known.slice(), groups = community.slice();
  const isNew = (i: number) => Number.isNaN(known[2 * i]);
  const unknown: number[] = [];
  for (let i = 0; i < n; i++) if (isNew(i)) unknown.push(i);
  if (unknown.length === 0) return { xy, community: groups };

  const adj = adjacency(n, edges);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (isNew(i)) continue;
    const x = known[2 * i]!, y = known[2 * i + 1]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) { minX = 0; maxX = SPREAD; minY = 0; maxY = SPREAD; }
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY), r = seededRandom(17);

  const g = new Graph({ type: 'undirected', multi: false });
  const addFixed = (i: number) => { if (!g.hasNode(i)) g.addNode(i, { x: known[2 * i], y: known[2 * i + 1], fixed: true }); };
  for (const i of unknown) {
    const anchors = adj[i]!.filter((j) => !isNew(j));
    let x: number, y: number;
    if (anchors.length > 0) {
      x = anchors.reduce((s, j) => s + known[2 * j]!, 0) / anchors.length + (r() - 0.5) * w * 0.02;
      y = anchors.reduce((s, j) => s + known[2 * j + 1]!, 0) / anchors.length + (r() - 0.5) * h * 0.02;
    } else { x = minX + r() * w; y = minY + r() * h; }
    g.addNode(i, { x, y });
    for (const j of anchors) addFixed(j);
  }
  for (const i of unknown) for (const j of adj[i]!) if (g.hasNode(j) && !g.hasEdge(i, j)) g.addEdge(i, j);
  forceAtlas2.assign(g, { iterations: LOCAL_ITERATIONS, settings: faSettings(g) });
  for (const i of unknown) {
    const a = g.getNodeAttributes(i) as { x: number; y: number };
    xy[2 * i] = a.x; xy[2 * i + 1] = a.y;
  }
  inheritCommunities(adj, unknown, groups);
  return { xy, community: groups };
}
