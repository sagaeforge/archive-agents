// Snapshot -> Prim[] (design 10). The renderer is a consumer of this list; swapping SVG for Canvas later touches nothing else.
import { HEADER } from '../../server/layout/geometry.ts';
import { BASIS_LABEL, staleIds, type Basis, type Entity, type Kind, type Snapshot, type State } from '../../server/model/fact.ts';
import { bboxOf } from './geom.ts';
import { paintOrder, project, pts, shade, tint, type Mode, type Pt, type Rect } from './project.ts';
import { BASIS_COLOR, freshColor, KIND_COLOR, loadColor, metricOf, NEUTRAL, STATE_COLOR, STATE_LABEL, type Metric, type Overlay } from './style.ts';

export type Face = { face: 'top' | 'left' | 'right' | 'load'; pts: string; fill: string; fillOpacity?: number; stroke: string; sw: number; dash?: boolean };
export type Prim =
  | { t: 'poly'; cls: string; pts: string; fill: string; stroke: string; dash?: boolean; sw?: number; id?: string; kind?: string; basis?: Basis; state?: State; title?: string }
  | { t: 'line'; cls: string; pts: string; edge?: string }
  | { t: 'obj'; id: string; kind: Kind; basis: Basis; state: State; opacity: number; faces: Face[]; title: string; aria: string; selected: boolean; parent?: string };

export type LabelCand = {
  id: string; text: string; pr: number; kind: string; leaf: boolean; color?: string;
  /** Screen box of the object, and the ids of its ancestors: a label may stand on an ancestor's surface, never on anything else. */
  box: Rect; own: string[];
  /** A slab's label may sit on its own free strip. */
  onOwn: boolean; strips?: Pt[];
  /** Where the leader line lands: on the object's top face. */
  anchor: Pt | null;
  /** The object's top face, for the "label point lies on its own face" check. */
  top: Pt[];
};
/** Drawn faces of one object on screen: what a label must not cover. */
export type Shape = { id: string; polys: Pt[][]; bbox: Rect };

export type SceneOpts = { mode: Mode; S: number; overlay: Overlay; metric: Metric; nowMs: number; sel: string | null; dim: ReadonlySet<string> | null; dense: boolean };
export type Scene = { prims: Prim[]; labels: LabelCand[]; shapes: Shape[]; bounds: [number, number, number, number] };

const _OUTSIDE = new Set<Kind>(['wan', 'modem', 'domain', 'gateway', 'tunnel', 'proxy', 'switch', 'wifi', 'clients', 'segment']);
const LEAF = new Set<Kind>(['vm', 'lxc', 'container', 'bridge', 'storage']);
const RANK: Partial<Record<Kind, number>> = { node: 0, wan: 1, gateway: 1, tunnel: 1, proxy: 1, segment: 1, modem: 1, domain: 1, switch: 1, wifi: 1, clients: 1, vm: 2, lxc: 2, bridge: 3, storage: 3, container: 6 };

export const PAD = 40;

/** Bounds of everything the floor and the blocks can reach at S = 1, so the view can be fitted without painting twice. */
export function sceneBounds(s: Snapshot, mode: Mode): [number, number, number, number] {
  const P = project(mode, 1);
  let b: [number, number, number, number] = [1e9, 1e9, -1e9, -1e9];
  const grow = (p: Pt) => { b = [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])]; };
  const g = floorRect(s);
  for (const [x, y] of [[g.x - PAD, g.y - PAD], [g.x + g.w + PAD, g.y - PAD], [g.x + g.w + PAD, g.y + g.h + PAD], [g.x - PAD, g.y + g.h + PAD]] as Pt[]) grow(P(x, y));
  for (const o of Object.values(s.layout)) for (const [x, y] of [[o.x, o.y], [o.x + o.w, o.y], [o.x + o.w, o.y + o.h], [o.x, o.y + o.h]] as Pt[]) grow(P(x, y, o.z + o.zh));
  return b;
}

export function floorRect(s: Snapshot): Rect {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const o of Object.values(s.layout)) { x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y); x1 = Math.max(x1, o.x + o.w); y1 = Math.max(y1, o.y + o.h); }
  if (x0 > x1) return { x: 0, y: 0, w: 240, h: 240 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function stateSuffix(n: Entity, stale: boolean): string {
  if (n.gone) return ' · 사라짐';
  const st = n.state === 'creating' || n.state === 'starting' || n.state === 'error' || n.state === 'stopped' || n.state === 'stopping' || n.state === 'migrating' ? ` · ${STATE_LABEL[n.state]}` : '';
  return st + (stale ? ' · 낡음' : '');
}

export function buildScene(s: Snapshot, o: SceneOpts): Scene {
  const P = project(o.mode, o.S);
  const byId = new Map(s.nodes.map((n) => [n.id, n]));
  const kids = new Map<string, Entity[]>();
  for (const n of s.nodes) if (n.parent) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)!).push(n);
  const stale = staleIds(s, o.nowMs);
  const prims: Prim[] = []; const overlay: Prim[] = []; const labels: LabelCand[] = []; const shapes: Shape[] = [];
  let bounds: [number, number, number, number] = [1e9, 1e9, -1e9, -1e9];
  const grow = (pp: Pt[]) => { for (const [x, y] of pp) bounds = [Math.min(bounds[0], x), Math.min(bounds[1], y), Math.max(bounds[2], x), Math.max(bounds[3], y)]; };
  const topOf = new Map<string, Pt[]>();

  const fillFor = (n: Entity, kindKey: Kind | 'dockerhost'): string => {
    const base = KIND_COLOR[kindKey];
    if (n.basis === 'unknown' || n.gone) return '#ffffff';
    switch (o.overlay) {
      case 'basis': return BASIS_COLOR[n.basis];
      case 'fresh': return n.basis === 'observed' ? freshColor(n, o.nowMs) : NEUTRAL;
      case 'load': return NEUTRAL;
      default: return STATE_COLOR[n.state] ?? base;
    }
  };

  const box = (n: Entity, kindKey: Kind | 'dockerhost') => {
    const b = s.layout[n.id]; if (!b) return;
    const { x, y, w, h, z, zh } = b;
    const hollow = n.basis === 'unknown' || !!n.gone;
    const base = fillFor(n, kindKey);
    const fill = n.basis === 'derived' ? tint(base, 0.55) : base;
    const top = [P(x, y, z + zh), P(x + w, y, z + zh), P(x + w, y + h, z + zh), P(x, y + h, z + zh)];
    const left = [P(x, y + h, z + zh), P(x + w, y + h, z + zh), P(x + w, y + h, z), P(x, y + h, z)];
    const right = [P(x + w, y, z + zh), P(x + w, y + h, z + zh), P(x + w, y + h, z), P(x + w, y, z)];
    grow(top); if (o.mode === 'iso') { grow(left); grow(right); }
    const dash = n.basis === 'derived' || hollow;
    const selected = o.sel === n.id;
    const stroke = selected ? '#0b3fbf' : hollow ? '#7c8798' : n.basis === 'derived' ? shade(base, 0.7) : 'rgba(255,255,255,.55)';
    const sw = selected ? 2.4 : dash ? 1.2 : 0.6;
    const faces: Face[] = [];
    const mk = (face: Face['face'], p: Pt[], color: string, opacity?: number): Face => ({ face, pts: pts(p), fill: color, stroke, sw, dash, ...(opacity != null ? { fillOpacity: opacity } : {}) });
    if (hollow) {
      for (const [f, p] of [['left', left], ['right', right], ['top', top]] as const) if (o.mode === 'iso' || f === 'top') faces.push(mk(f, p, '#ffffff', 0.55));
    } else {
      if (o.mode === 'iso') { faces.push(mk('left', left, shade(fill, 0.8))); faces.push(mk('right', right, shade(fill, 0.66))); }
      faces.push(mk('top', top, n.basis === 'declared' ? 'url(#declared)' : fill));
      if (o.overlay === 'load') {
        const v = metricOf(n, o.metric);
        if (v != null) {
          const f = Math.max(0.04, Math.min(1, v));
          const bar = [P(x, y, z + zh), P(x + w * f, y, z + zh), P(x + w * f, y + h, z + zh), P(x, y + h, z + zh)];
          faces.push({ face: 'load', pts: pts(bar), fill: loadColor(v), stroke: 'none', sw: 0 });
        }
      }
    }
    const st = stale.has(n.id);
    const dim = o.dim && !o.dim.has(n.id) ? 0.22 : 1;
    const label = STATE_LABEL[n.state];
    prims.push({
      t: 'obj', id: n.id, kind: n.kind, basis: n.basis, state: n.state, opacity: (st ? 0.5 : 1) * dim, faces, selected,
      title: `${n.title}${label ? ` · ${label}` : ''}${st ? ' · 낡음' : ''} · ${BASIS_LABEL[n.basis]}`,
      aria: `${n.title}, ${label || '상태 없음'}${st ? ', 낡음' : ''}, 근거 ${BASIS_LABEL[n.basis]}`,
      ...(n.parent ? { parent: n.parent } : {}),
    });
    topOf.set(n.id, top);
    const polys = o.mode === 'iso' ? [top, left, right] : [top];
    shapes.push({ id: n.id, polys, bbox: bboxOf(polys) });
  };

  const wire = (a: Pt, b: Pt, cls: string) => overlay.push({ t: 'line', cls, pts: pts([a, b]) });

  const place = (n: Entity) => {
    const b = s.layout[n.id]; if (!b) return;
    const sub = kids.get(n.id) ?? [];
    const key: Kind | 'dockerhost' = n.kind === 'vm' && sub.length ? 'dockerhost' : n.kind;
    box(n, key);
    if (!sub.length) return;
    const zt = b.z + b.zh;
    if (n.kind === 'node') {
      for (const e of s.edges) {
        if (e.kind !== 'attached') continue;
        const a = s.layout[e.source]; const t = s.layout[e.target];
        if (a && t && byId.get(e.target)?.parent === n.id) wire(P(a.x + a.w / 2, a.y + a.h / 2, zt), P(t.x + t.w / 2, t.y + t.h / 2, zt + t.zh), 'attach');
      }
      for (const c of sub) if (c.kind === 'bridge') { const cb = s.layout[c.id]; if (cb) wire(P(b.x, cb.y + cb.h / 2, zt), P(cb.x, cb.y + cb.h / 2, zt), 'attach'); }
    }
    const rects = sub.map((c) => ({ c, ...(s.layout[c.id] ?? { x: 0, y: 0, w: 0, h: 0 }) }));
    for (const r of paintOrder(rects)) place(r.c);
  };

  // Ground, floor lines, blocks back to front, then the lines that must not hide behind blocks.
  const g = floorRect(s);
  const ground = [P(g.x - PAD, g.y - PAD), P(g.x + g.w + PAD, g.y - PAD), P(g.x + g.w + PAD, g.y + g.h + PAD), P(g.x - PAD, g.y + g.h + PAD)];
  grow(ground);
  prims.push({ t: 'poly', cls: 'ground', pts: pts(ground), fill: '#f8f9fb', stroke: '#d6dbe3' });
  for (let t = 0; t <= g.w + 2 * PAD; t += 80) prims.push({ t: 'line', cls: 'grid', pts: pts([P(g.x + t - PAD, g.y - PAD), P(g.x + t - PAD, g.y + g.h + PAD)]) });
  for (let t = 0; t <= g.h + 2 * PAD; t += 80) prims.push({ t: 'line', cls: 'grid', pts: pts([P(g.x - PAD, g.y + t - PAD), P(g.x + g.w + PAD, g.y + t - PAD)]) });
  for (const e of s.edges) {
    const r = s.routes[e.id]; if (!r || r.length < 2) continue;
    prims.push({ t: 'line', cls: `edge ${e.basis}`, pts: pts(r.map(([x, y]) => P(x, y))), edge: e.id });
  }
  const roots = s.nodes.filter((n) => !n.parent).map((n) => ({ n, ...(s.layout[n.id] ?? { x: 0, y: 0, w: 0, h: 0 }) }));
  for (const r of paintOrder(roots)) place(r.n);
  prims.push(...overlay);

  // No Docker plane is drawn while Docker has no source and no objects: the layer shows in the side panel only (design 9.1).

  // Label candidates. Labels stay screen-horizontal; priority decides who shows (design 9.5).
  const ancestors = (id: string) => { const out: string[] = []; for (let p = byId.get(id)?.parent; p; p = byId.get(p)?.parent) out.push(p); return out; };
  for (const n of s.nodes) {
    const top = topOf.get(n.id); const b = s.layout[n.id]; const shape = shapes.find((x) => x.id === n.id);
    if (!top || !b || !shape) continue;
    const cx = top.reduce((a, p) => a + p[0], 0) / 4; const cy = top.reduce((a, p) => a + p[1], 0) / 4;
    const slab = n.kind === 'node' || n.kind === 'workstation';
    // A slab keeps a free strip along its north edge, so its label stands on its own face; if the pill does not fit, it stands beside the slab.
    const strip = (fx: number): Pt => P(b.x + b.w * fx, b.y + HEADER / 2, b.z + b.zh);
    let text = n.title + stateSuffix(n, stale.has(n.id));
    if (n.kind === 'node' && o.dense) text += ` · 게스트 ${(kids.get(n.id) ?? []).filter((c) => c.kind === 'vm' || c.kind === 'lxc').length}`;
    const pr = o.sel === n.id ? -1 : (RANK[n.kind] ?? 4);
    labels.push({
      id: n.id, text, pr, kind: n.kind, leaf: LEAF.has(n.kind), box: shape.bbox, own: ancestors(n.id), onOwn: slab,
      ...(slab ? { strips: [strip(0.5), strip(0.25), strip(0.75)] } : {}),
      anchor: slab ? strip(0.5) : [cx, cy], top,
    });
  }
  return { prims, labels, shapes, bounds };
}
