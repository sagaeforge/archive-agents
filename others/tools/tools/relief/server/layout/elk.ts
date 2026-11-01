// Floor layout (design 10): ELK `layered` places the root-level objects and routes their lines; slabs are leaves with fixed ports.
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk-api.js';
import type { Box, Entity, Snapshot } from '../model/fact.ts';
import { HEIGHT, SIZE } from './geometry.ts';
import { shelfNode, slabWidth, type Slot } from './shelf.ts';

const elk = new ELK();

export type Layout = { layout: Snapshot['layout']; routes: Snapshot['routes']; ms: number };

export async function layoutSnapshot(s: Pick<Snapshot, 'nodes' | 'edges'>): Promise<Layout> {
  const kids = new Map<string, Entity[]>();
  for (const n of s.nodes) if (n.parent) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)!).push(n);
  const childrenOf = (id: string) => kids.get(id) ?? [];
  const roots = s.nodes.filter((n) => !n.parent);
  const W = slabWidth(roots, childrenOf);
  const slabs = new Map<string, ReturnType<typeof shelfNode>>();
  const portOf = new Set<string>();

  const children: ElkNode[] = roots.map((n) => {
    if (n.kind !== 'node') { const [width, height] = SIZE[n.kind]; return { id: n.id, width, height }; }
    const slab = shelfNode(n, childrenOf, W); slabs.set(n.id, slab);
    for (const p of slab.ports) portOf.add(p.id);
    return {
      id: n.id, width: slab.w, height: slab.h,
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
      ports: slab.ports.map((p) => ({ id: p.id, x: 0, y: p.y, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'WEST' } })),
    };
  });
  const rootIds = new Set(roots.map((n) => n.id));
  const parentOf = new Map(s.nodes.map((n) => [n.id, n.parent]));
  const edges: ElkExtendedEdge[] = [];
  for (const e of s.edges) {
    if (e.kind === 'attached') continue;
    const via = e.facts.via?.value;
    const target = typeof via === 'string' && portOf.has(via) ? via : e.target;
    const target0 = parentOf.get(target) ?? target;
    if (!rootIds.has(e.source) || !rootIds.has(target0)) continue;
    edges.push({ id: e.id, sources: [e.source], targets: [target] });
  }
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '70', 'elk.layered.spacing.nodeNodeBetweenLayers': '120', 'elk.layered.spacing.edgeNodeBetweenLayers': '30',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES', 'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    },
    children, edges,
  };
  const t0 = performance.now();
  const out = await elk.layout(graph);
  const ms = performance.now() - t0;

  const layout: Snapshot['layout'] = {};
  const kindOf = new Map(s.nodes.map((n) => [n.id, n.kind]));
  const put = (id: string, b: Box) => { layout[id] = b; };
  const placeSlots = (slots: Slot[], ox: number, oy: number, z: number) => {
    for (const c of slots) {
      put(c.id, { x: ox + c.x, y: oy + c.y, w: c.w, h: c.h, z, zh: c.zh });
      if (c.children) placeSlots(c.children, ox + c.x, oy + c.y, z + c.zh);
    }
  };
  for (const c of out.children ?? []) {
    const kind = kindOf.get(c.id)!;
    const b = { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0, z: 0, zh: HEIGHT[kind] };
    put(c.id, b);
    const slab = slabs.get(c.id);
    if (slab) placeSlots(slab.children, b.x, b.y, b.zh);
  }
  const routes: Snapshot['routes'] = {};
  for (const e of out.edges ?? []) {
    const sec = (e as ElkExtendedEdge).sections?.[0];
    if (sec) routes[e.id] = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => [round(p.x), round(p.y)] as [number, number]);
  }
  return { layout, routes, ms };
}

const round = (v: number) => Math.round(v * 10) / 10;
