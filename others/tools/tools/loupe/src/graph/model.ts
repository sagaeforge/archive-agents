// What the graph screen knows about a graph, with no renderer in it. Overview, neighbors and export all arrive as column tables (design 7.3).
import { decodeColumns, type ColumnTable } from '../data/columns.ts';

export type GraphNode = { id: string; label: string; type: string; status: string };
export type GraphEdge = { id: string; src: string; dst: string; rtype: string; status: string };
export type GraphData = { nodes: GraphNode[]; edges: GraphEdge[] };
export type Pair = readonly [string, string];
/** The input of a layout: ids and edge ends, nothing a person would read (design 6.2). */
export type Topology = { ids: string[]; pairs: Pair[] };

const text = (v: unknown, fallback = '') => (v === null || v === undefined ? fallback : String(v));

export function decodeGraph(data: { nodes: ColumnTable; edges: ColumnTable }): GraphData {
  const nodes = decodeColumns(data.nodes, ['id', 'label', 'type', 'status'] as const)
    .map((r) => ({ id: text(r.id), label: text(r.label, text(r.id)), type: text(r.type), status: text(r.status) }));
  const edges = decodeColumns(data.edges, ['id', 'src', 'dst', 'rtype', 'status'] as const)
    .map((r) => ({ id: text(r.id), src: text(r.src), dst: text(r.dst), rtype: text(r.rtype), status: text(r.status, 'active') }));
  return { nodes, edges };
}

/** An export has more columns than the layout may use: only ids and ends get through. */
export function decodeTopology(file: unknown): Topology | null {
  const f = file as { nodes?: ColumnTable; edges?: ColumnTable } | null | undefined;
  if (!f || !Array.isArray(f.nodes?.rows) || !Array.isArray(f.edges?.rows)) return null;
  const ids = decodeColumns(f.nodes, ['id'] as const).map((r) => text(r.id));
  const pairs = decodeColumns(f.edges, ['src', 'dst'] as const).map((r): Pair => [text(r.src), text(r.dst)]);
  return { ids, pairs };
}

export const topologyOf = (g: GraphData): Topology => ({ ids: g.nodes.map((n) => n.id), pairs: g.edges.map((e): Pair => [e.src, e.dst]) });

/** The overview plus an expansion. The first copy of a node wins, so an expansion never relabels what is on screen. */
export function mergeGraphs(base: GraphData, extra: GraphData | null | undefined): GraphData {
  if (!extra) return base;
  const nodes = new Map(base.nodes.map((n) => [n.id, n]));
  for (const n of extra.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
  const edges = new Map(base.edges.map((e) => [e.id, e]));
  for (const e of extra.edges) if (!edges.has(e.id)) edges.set(e.id, e);
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** `truncated` alone does not say what was cut: the totals against the received rows do (design 3). */
export function truncationOf(meta: { node_total: number; edge_total: number; truncated: boolean }, received: GraphData) {
  return {
    any: meta.truncated, nodes: meta.node_total > received.nodes.length, edges: meta.edge_total > received.edges.length,
    nodeTotal: meta.node_total, edgeTotal: meta.edge_total, nodeRows: received.nodes.length, edgeRows: received.edges.length,
  };
}

export type DrawnEdge = GraphEdge & { drawn: boolean; dashed: boolean };
const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** The KB is a directed multigraph and every edge keeps its key. Parallel edges are merged for drawing only (design 6.1): one line per pair,
 *  solid if any edge of the pair is not superseded. An edge whose end is not on the canvas is left out: it has nowhere to go. */
export function drawnEdges(g: GraphData): DrawnEdge[] {
  const present = new Set(g.nodes.map((n) => n.id));
  const pairs = new Map<string, DrawnEdge[]>();
  for (const e of g.edges) {
    // Design 5: merged and dead edges are not shown. Only `edge_status` can bring them here.
    if (!present.has(e.src) || !present.has(e.dst) || e.status === 'dead') continue;
    const k = pairKey(e.src, e.dst);
    const row: DrawnEdge = { ...e, drawn: false, dashed: false };
    const list = pairs.get(k);
    if (list) list.push(row); else pairs.set(k, [row]);
  }
  const out: DrawnEdge[] = [];
  for (const list of pairs.values()) {
    const head = list[0]!;
    head.drawn = true;
    head.dashed = list.every((e) => e.status === 'superseded');
    out.push(...list);
  }
  return out;
}

/** Same formula as the S3 data. The label priority is this value too (design 6.1). */
export const nodeSize = (degree: number) => 2 + Math.min(10, Math.sqrt(degree) * 0.9);

/** Distinct neighbours per node: parallel edges must not make a node look bigger. */
export function degrees(edges: readonly DrawnEdge[]): Map<string, number> {
  const d = new Map<string, number>();
  for (const e of edges) {
    if (!e.drawn) continue;
    d.set(e.src, (d.get(e.src) ?? 0) + 1);
    if (e.src !== e.dst) d.set(e.dst, (d.get(e.dst) ?? 0) + 1);
  }
  return d;
}

export type Relation = { id: string; rtype: string; direction: 'out' | 'in'; peer: string; peerLabel: string; status: string };

/** Edge labels are not drawn: the selection panel lists them (design 6.1). Every parallel edge is listed: they are merged on the canvas only. */
export function relationsOf(g: GraphData, id: string): Relation[] {
  const labels = new Map(g.nodes.map((n) => [n.id, n.label]));
  const out: Relation[] = [];
  for (const e of g.edges) {
    if (e.src === id) out.push({ id: e.id, rtype: e.rtype, direction: 'out', peer: e.dst, peerLabel: labels.get(e.dst) ?? e.dst, status: e.status });
    else if (e.dst === id) out.push({ id: e.id, rtype: e.rtype, direction: 'in', peer: e.src, peerLabel: labels.get(e.src) ?? e.src, status: e.status });
  }
  return out.sort((a, b) => (a.rtype < b.rtype ? -1 : a.rtype > b.rtype ? 1 : a.peerLabel < b.peerLabel ? -1 : 1));
}
