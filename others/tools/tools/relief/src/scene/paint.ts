// Snapshot -> Prim[] (design 10). The renderer is a consumer of this list; swapping SVG for Canvas later touches nothing else.
import { HEADER } from '../../server/layout/geometry.ts';
import { BASIS_LABEL, type Basis, type Box, type Entity, type Kind, type Snapshot, type State } from '../../server/model/fact.ts';
import { healthOf, linkState, wireState, type LinkState, type ObjectHealth } from '../../server/model/health.ts';
import { allot, measuredLinks, packetsFor, packetTiming, type Measured } from './flow.ts';
import { rateText } from '../ui/chart.ts';
import { formOf, RISE } from './forms.ts';
import { bboxOf } from './geom.ts';
import { paintOrder, project, pts, type Mode, type Pt, type Rect } from './project.ts';
import { BASIS_MATERIAL, freshMaterial, HOLLOW, KIND_MATERIAL, LINE, loadColor, metricOf, NEUTRAL, paint, STATE_LABEL, STATE_MATERIAL, STRIPES, type Metric, type Overlay } from './style.ts';

export type Face = { face: 'top' | 'left' | 'right' | 'load'; pts: string; fill: string; fillOpacity?: number; stroke: string; sw: number; dash?: boolean };
export type Prim =
  | { t: 'poly'; cls: string; pts: string; fill: string; stroke: string; dash?: boolean; sw?: number; id?: string; kind?: string; basis?: Basis; state?: State; title?: string }
  | { t: 'line'; cls: string; pts: string; edge?: string; link?: LinkState; measured?: boolean; title?: string }
  /** One packet in one lane of a measured link. In paint order, so a block in front of the cable hides it. `at` is where it rests with motion off. */
  | { t: 'packet'; edge: string; lane: 'in' | 'out'; d: string; dur: number; delay: number; at: number }
  /** Many marks in one element: the budget counts elements (design 13). */
  | { t: 'path'; cls: string; d: string }
  | { t: 'obj'; id: string; kind: Kind; basis: Basis; state: State; opacity: number; faces: Face[]; detail: string; halo?: string; alert?: 'warn' | 'problem'; flash?: boolean; title: string; aria: string; selected: boolean; parent?: string };

export type LabelCand = {
  id: string; text: string; pr: number; kind: string; leaf: boolean; color?: string; alert?: boolean;
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

export type SceneOpts = { mode: Mode; S: number; overlay: Overlay; metric: Metric; nowMs: number; sel: string | null; dim: ReadonlySet<string> | null; dense: boolean; flash?: string | null };
export type Scene = { prims: Prim[]; labels: LabelCand[]; shapes: Shape[]; bounds: [number, number, number, number] };

const LEAF = new Set<Kind>(['vm', 'lxc', 'container', 'bridge', 'storage']);
const RANK: Partial<Record<Kind, number>> = { node: 0, wan: 1, gateway: 1, tunnel: 1, proxy: 1, segment: 1, modem: 1, domain: 1, switch: 1, wifi: 1, clients: 1, vm: 2, lxc: 2, bridge: 3, storage: 3, container: 6 };

export const PAD = 40;

/** How thick the board under the map reads, how high a cable lies above whatever it runs on, and how far a lane sits off the middle of its cable. */
const BOARD = 12; const CABLE_Z = 3; const LANE = 1.4;
const LINK_WORD: Record<LinkState, string> = { healthy: '양 끝 정상', warning: '경고', down: '끊김', stale: '낡음', unknown: '모름' };
export const NO_TRAFFIC = '트래픽 측정 없음';

/** Every lane that wants packets, the cap shared over them, busiest first. */
function laneShares(s: Snapshot, health: ReadonlyMap<string, ObjectHealth>, byId: ReadonlyMap<string, Entity>, nowMs: number) {
  const measured = measuredLinks(s, nowMs);
  const lanes: { key: string; link: string; rate: number; want: number }[] = [];
  const edges = new Map(s.edges.map((e) => [e.id, e]));
  for (const [id, m] of measured as Map<string, Measured>) {
    const st = linkState(edges.get(id)!, byId, health);
    if (st === 'healthy' || st === 'warning') for (const lane of ['in', 'out'] as const) lanes.push({ key: `${id}|${lane}`, link: id, rate: m[lane], want: packetsFor(m[lane]) });
  }
  lanes.sort((a, b) => b.rate - a.rate);
  const given = allot(lanes);
  return { measured, count: new Map(lanes.map((l, i) => [l.key, given[i]!])) };
}

/** Bounds of everything the floor and the blocks can reach at S = 1, so the view can be fitted without painting twice. */
export function sceneBounds(s: Snapshot, mode: Mode): [number, number, number, number] {
  const P = project(mode, 1);
  let b: [number, number, number, number] = [1e9, 1e9, -1e9, -1e9];
  const grow = (p: Pt) => { b = [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])]; };
  const kind = new Map(s.nodes.map((n) => [n.id, n.kind]));
  for (const r of boardRuns(s)) for (const [x, y] of [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]] as Pt[]) { grow(P(x, y)); grow(P(x, y, -BOARD)); }
  for (const [id, o] of Object.entries(s.layout)) {
    const rise = RISE[kind.get(id) ?? 'vm'] ?? 0;
    for (const [x, y] of [[o.x, o.y], [o.x + o.w, o.y], [o.x + o.w, o.y + o.h], [o.x, o.y + o.h]] as Pt[]) grow(P(x, y, o.z + o.zh + rise));
  }
  return b;
}

/**
 * The board follows what stands on it: square cells around every root object and cable, merged into runs, so the map reads as a terraced model
 * and the view is fitted to the objects and not to the corners of their bounding rectangle. Runs, not cells: one row is one sub-path.
 */
const CELL = 40;
export type Run = { x0: number; y0: number; x1: number; y1: number };
function boardCells(s: Snapshot): Map<number, Set<number>> {
  const rows = new Map<number, Set<number>>();
  const mark = (x0: number, y0: number, x1: number, y1: number) => {
    for (let j = Math.floor(y0 / CELL); j < Math.ceil(y1 / CELL); j++) { const row = rows.get(j) ?? rows.set(j, new Set()).get(j)!; for (let i = Math.floor(x0 / CELL); i < Math.ceil(x1 / CELL); i++) row.add(i); }
  };
  for (const o of Object.values(s.layout)) if (o.z === 0) mark(o.x - PAD, o.y - PAD, o.x + o.w + PAD, o.y + o.h + PAD);
  for (const r of Object.values(s.routes)) for (let i = 1; i < r.length; i++) { const [a, b] = [r[i - 1]!, r[i]!]; mark(Math.min(a[0], b[0]) - 20, Math.min(a[1], b[1]) - 20, Math.max(a[0], b[0]) + 20, Math.max(a[1], b[1]) + 20); }
  return rows;
}
const runsOf = (ids: Iterable<number>) => { const out: [number, number][] = []; for (const i of [...ids].sort((a, b) => a - b)) { const l = out.at(-1); if (l && l[1] === i) l[1] = i + 1; else out.push([i, i + 1]); } return out; };
export function boardRuns(s: Snapshot): Run[] {
  const out: Run[] = [];
  for (const [j, row] of boardCells(s)) for (const [a, b] of runsOf(row)) out.push({ x0: a * CELL, y0: j * CELL, x1: b * CELL, y1: (j + 1) * CELL });
  return out.length ? out : [{ x0: 0, y0: 0, x1: 240, y1: 240 }];
}
/** The two rims that face the viewer: where a row has no cell in front of it, or a column none to its right. */
function boardSides(s: Snapshot) {
  const rows = boardCells(s); const left: Run[] = []; const right: Run[] = [];
  for (const [j, row] of rows) {
    const below = rows.get(j + 1) ?? new Set<number>();
    for (const [a, b] of runsOf([...row].filter((i) => !below.has(i)))) left.push({ x0: a * CELL, y0: (j + 1) * CELL, x1: b * CELL, y1: (j + 1) * CELL });
    for (const i of row) if (!row.has(i + 1)) right.push({ x0: (i + 1) * CELL, y0: j * CELL, x1: (i + 1) * CELL, y1: (j + 1) * CELL });
  }
  return { left, right };
}

export function floorRect(s: Snapshot): Rect {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const o of Object.values(s.layout)) { x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y); x1 = Math.max(x1, o.x + o.w); y1 = Math.max(y1, o.y + o.h); }
  if (x0 > x1) return { x: 0, y: 0, w: 240, h: 240 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function stateSuffix(n: Entity, h: ObjectHealth): string {
  if (n.gone) return ' · 사라짐';
  const st = h.life ? ` · ${h.life}` : '';
  return st + (h.stale ? ' · 낡음' : '') + (h.drift.length ? ' · 어긋남' : '') + (h.state === 'problem' && h.alerts.length ? ' · 문제' : h.state === 'warning' && !h.drift.length ? ' · 경고' : '');
}

const d = (p: Pt[]) => `M${p.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}`;
const closed = (p: Pt[]) => `${d(p)}Z`;

/** A footprint and what it throws to the screen right, away from the light: a hexagon on the plane z. */
const shadowOf = (P: (x: number, y: number, z?: number) => Pt, b: Box, z: number, grow: number) => {
  const L = Math.min(16, b.zh * 0.55) + grow; const x0 = b.x - grow; const y0 = b.y - grow; const x1 = b.x + b.w + grow; const y1 = b.y + b.h + grow;
  return closed([P(x0, y0, z), P(x0 + L, y0 - L, z), P(x1 + L, y0 - L, z), P(x1 + L, y1 - L, z), P(x1, y1, z), P(x0, y1, z)]);
};

export function buildScene(s: Snapshot, o: SceneOpts): Scene {
  const P = project(o.mode, o.S);
  const byId = new Map(s.nodes.map((n) => [n.id, n]));
  const kids = new Map<string, Entity[]>();
  for (const n of s.nodes) if (n.parent) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)!).push(n);
  const health = healthOf(s, o.nowMs).objects;
  const prims: Prim[] = []; const labels: LabelCand[] = []; const shapes: Shape[] = [];
  let bounds: [number, number, number, number] = [1e9, 1e9, -1e9, -1e9];
  const grow = (pp: Pt[]) => { for (const [x, y] of pp) bounds = [Math.min(bounds[0], x), Math.min(bounds[1], y), Math.max(bounds[2], x), Math.max(bounds[3], y)]; };
  const topOf = new Map<string, Pt[]>();

  const materialOf = (n: Entity, kindKey: Kind | 'dockerhost'): string => {
    switch (o.overlay) {
      case 'basis': return BASIS_MATERIAL[n.basis];
      case 'fresh': return n.basis === 'observed' ? freshMaterial(n, o.nowMs) : NEUTRAL;
      case 'load': return NEUTRAL;
      default: return STATE_MATERIAL[n.state] ?? KIND_MATERIAL[kindKey];
    }
  };

  const box = (n: Entity, kindKey: Kind | 'dockerhost') => {
    const b = s.layout[n.id]; if (!b) return;
    const { x, y, w, h, z, zh } = b;
    const iso = o.mode === 'iso';
    const hollow = n.basis === 'unknown' || !!n.gone;
    const material = materialOf(n, kindKey);
    const top = [P(x, y, z + zh), P(x + w, y, z + zh), P(x + w, y + h, z + zh), P(x, y + h, z + zh)];
    const left = [P(x, y + h, z + zh), P(x + w, y + h, z + zh), P(x + w, y + h, z), P(x, y + h, z)];
    const right = [P(x + w, y, z + zh), P(x + w, y + h, z + zh), P(x + w, y + h, z), P(x + w, y, z)];
    grow(top); if (iso) { grow(left); grow(right); }
    const dash = n.basis === 'derived' || hollow;
    const selected = o.sel === n.id || o.flash === n.id;
    const hp = health.get(n.id)!;
    const warned = hp.drift.length > 0;
    const flagged = warned || hp.state === 'problem';
    const stroke = selected ? LINE.select : flagged ? LINE.warn : hollow ? LINE.hollow : n.basis === 'derived' ? paint(material, 't') : LINE.rim;
    const sw = selected ? 2.4 : flagged ? 1.8 : dash ? 1.2 : 0.6;
    const faces: Face[] = [];
    const mk = (face: Face['face'], p: Pt[], color: string, opacity?: number): Face => ({ face, pts: pts(p), fill: color, stroke, sw, dash, ...(opacity != null ? { fillOpacity: opacity } : {}) });
    const shown: Pt[][] = iso ? [top, left, right] : [top];
    let detail = '';
    if (hollow) {
      for (const [f, p] of [['left', left], ['right', right], ['top', top]] as const) if (iso || f === 'top') faces.push(mk(f, p, HOLLOW, 0.55));
    } else if (iso) {
      const form = formOf(kindKey, b, P, o.S, o.dense);
      for (const p of form.parts) {
        const fill = p.face === 'top' && p.main && n.basis === 'declared' ? STRIPES : paint(p.material ?? material, p.tone);
        const face = mk(p.face, p.pts, fill, n.basis === 'derived' ? 0.62 : undefined);
        // A flagged object is outlined once, on its main top. Selection outlines everything: it asks for the object, not for attention.
        faces.push(flagged && !selected && !(p.main && p.face === 'top') ? { ...face, stroke: LINE.rim, sw: 0.6 } : face);
        shown.push(p.pts); grow(p.pts);
      }
      detail = form.detail;
    } else {
      faces.push(mk('top', top, n.basis === 'declared' ? STRIPES : paint(material, 't'), n.basis === 'derived' ? 0.62 : undefined));
    }
    if (o.overlay === 'load' && !hollow) {
      const v = metricOf(n, o.metric);
      if (v != null) {
        const f = Math.max(0.04, Math.min(1, v));
        const bar = [P(x, y, z + zh), P(x + w * f, y, z + zh), P(x + w * f, y + h, z + zh), P(x, y + h, z + zh)];
        faces.push({ face: 'load', pts: pts(bar), fill: loadColor(v), stroke: 'none', sw: 0 });
      }
    }
    const st = hp.stale;
    const dim = o.dim && !o.dim.has(n.id) ? 0.22 : 1;
    const label = STATE_LABEL[n.state];
    const glows = hp.state === 'problem' || hp.state === 'warning' || hp.busy;
    const alertText = [...hp.alerts.map((a) => a.text), ...hp.pending].join(', ');
    prims.push({
      t: 'obj', id: n.id, kind: n.kind, basis: n.basis, state: n.state, opacity: (st ? 0.5 : 1) * dim, faces, detail, selected,
      ...(glows ? { halo: closed([P(x - 6, y - 6, z), P(x + w + 6, y - 6, z), P(x + w + 6, y + h + 6, z), P(x - 6, y + h + 6, z)]) } : {}),
      ...(hp.state === 'problem' ? { alert: 'problem' as const } : hp.state === 'warning' ? { alert: 'warn' as const } : {}),
      ...(o.flash === n.id ? { flash: true } : {}),
      title: `${n.title}${label ? ` · ${label}` : ''}${st ? ' · 낡음' : ''}${warned ? ' · 어긋남' : ''}${alertText ? ` · ${alertText}` : ''} · ${BASIS_LABEL[n.basis]}`,
      aria: `${n.title}, ${label || '상태 없음'}${st ? ', 낡음' : ''}${warned ? `, 어긋남 ${hp.drift.join(', ')}` : ''}${alertText ? `, ${alertText}` : ''}, 근거 ${BASIS_LABEL[n.basis]}`,
      ...(n.parent ? { parent: n.parent } : {}),
    });
    topOf.set(n.id, top);
    shapes.push({ id: n.id, polys: shown, bbox: bboxOf(shown) });
  };

  /** How many packets each lane of each measured link gets, once, for the whole map: the cap is shared before anything is drawn. */
  const shares = laneShares(s, health, byId, o.nowMs);
  const measured = shares.measured;
  /** Two lanes of one cable: `in` runs towards the object, source to target, `out` back, each a step to its own side. A link with no share gets nothing. */
  const packets = (id: string, floor: readonly (readonly [number, number])[], z: number): Prim[] => {
    const out: Prim[] = [];
    for (const lane of ['in', 'out'] as const) {
      const n = shares.count.get(`${id}|${lane}`) ?? 0;
      if (!n) continue;
      const side = lane === 'in' ? LANE : -LANE;
      const path = floor.map(([x, y]) => P(x + side, y - side, z));
      const timing = packetTiming(id + lane, floor);
      for (let k = 0; k < n; k++) out.push({ t: 'packet', edge: id, lane, d: d(lane === 'in' ? path : [...path].reverse()), dur: timing.dur, delay: Math.round((timing.delay - (timing.dur * k) / n) * 100) / 100, at: Math.round(((k + 0.5) / n) * 100) });
    }
    return out;
  };

  /** Soft contact shadows of one level, in one or two elements however many objects stand there. */
  const shadows = (list: Box[], z: number) => {
    if (o.mode !== 'iso' || !list.length) return;
    if (!o.dense) prims.push({ t: 'path', cls: 'shadow soft', d: list.map((b) => shadowOf(P, b, z, 3)).join('') });
    prims.push({ t: 'path', cls: 'shadow', d: list.map((b) => shadowOf(P, b, z, 0)).join('') });
  };

  /** Cables on a slab: out of the bridge, down a lane, along the row below the guest, up to its face. Iso axes only, and lying on the slab under everything standing on it. */
  const slabWires = (n: Entity, zt: number) => {
    const b = s.layout[n.id]!; const z = zt + 1; const groups = new Map<LinkState, string[]>(); const lanes: Prim[] = [];
    const add = (st: LinkState, line: string) => (groups.get(st) ?? groups.set(st, []).get(st)!).push(line);
    for (const c of kids.get(n.id) ?? []) if (c.kind === 'bridge') { const cb = s.layout[c.id]; if (cb) add(wireState(c, health.get(c.id)), d([P(b.x, cb.y + cb.h / 2, z), P(cb.x, cb.y + cb.h / 2, z)])); }
    for (const e of s.edges) {
      if (e.kind !== 'attached' || byId.get(e.target)?.parent !== n.id) continue;
      const a = s.layout[e.source]; const t = s.layout[e.target];
      if (!a || !t) continue;
      const lane = a.x + a.w + 10; const ay = a.y + a.h / 2; const cx = t.x + t.w / 2; const row = t.y + t.h + 5;
      const floor: Pt[] = [[a.x + a.w, ay], [lane, ay], [lane, row], [cx, row], [cx, t.y + t.h]];
      const st = linkState(e, byId, health);
      add(st, d(floor.map(([x, y]) => P(x, y, z))));
      lanes.push(...packets(e.id, floor, z));
    }
    for (const [st, lines] of groups) prims.push({ t: 'path', cls: `attach ${st}`, d: lines.join('') });
    prims.push(...lanes);
  };

  const place = (n: Entity) => {
    const b = s.layout[n.id]; if (!b) return;
    const sub = kids.get(n.id) ?? [];
    const key: Kind | 'dockerhost' = n.kind === 'vm' && sub.length ? 'dockerhost' : n.kind;
    box(n, key);
    if (!sub.length) return;
    const zt = b.z + b.zh;
    if (n.kind === 'node') {
      shadows(sub.flatMap((c) => s.layout[c.id] ?? []), zt);
      slabWires(n, zt);
    }
    const rects = sub.map((c) => ({ c, ...(s.layout[c.id] ?? { x: 0, y: 0, w: 0, h: 0 }) }));
    for (const r of paintOrder(rects)) place(r.c);
  };

  // The board, the floor lines, the cables and shadows on it, then the blocks back to front.
  const board = boardRuns(s);
  const corners = (r: Run, z = 0): Pt[] => [P(r.x0, r.y0, z), P(r.x1, r.y0, z), P(r.x1, r.y1, z), P(r.x0, r.y1, z)];
  for (const r of board) grow(corners(r));
  if (o.mode === 'iso') {
    const { left, right } = boardSides(s);
    const wall = (r: Run) => closed([P(r.x0, r.y0), P(r.x1, r.y1), P(r.x1, r.y1, -BOARD), P(r.x0, r.y0, -BOARD)]);
    prims.push({ t: 'path', cls: 'board left', d: left.map(wall).join('') }, { t: 'path', cls: 'board right', d: right.map(wall).join('') });
  }
  prims.push({ t: 'path', cls: 'board top', d: board.map((r) => closed(corners(r))).join('') });
  const lines: string[] = [];
  for (const r of board) {
    lines.push(d([P(r.x0, r.y0), P(r.x1, r.y0)]));
    for (let x = Math.ceil(r.x0 / 80) * 80; x <= r.x1; x += 80) lines.push(d([P(x, r.y0), P(x, r.y1)]));
  }
  prims.push({ t: 'path', cls: 'grid', d: lines.join('') });
  const routed = s.edges.flatMap((e) => { const r = s.routes[e.id]; return r && r.length >= 2 ? [{ e, r }] : []; });
  if (o.mode === 'iso' && routed.length) prims.push({ t: 'path', cls: 'cable-shadow', d: routed.map(({ r }) => d(r.map(([x, y]) => P(x + 2, y - 2)))).join('') });
  const roots = s.nodes.filter((n) => !n.parent).map((n) => ({ n, ...(s.layout[n.id] ?? { x: 0, y: 0, w: 0, h: 0, z: 0, zh: 0 }) }));
  shadows(roots.filter((r) => s.layout[r.n.id]), 0);
  for (const { e, r } of routed) {
    const screen = r.map(([x, y]) => P(x, y, CABLE_Z));
    const st = linkState(e, byId, health); const rate = measured.get(e.id);
    prims.push({ t: 'line', cls: `edge ${e.basis}`, pts: pts(screen), edge: e.id, link: st, measured: !!rate, title: `${LINK_WORD[st]} · ${rate ? `수신 ${rateText(rate.in)} · 송신 ${rateText(rate.out)} · 측정` : NO_TRAFFIC}` });
    prims.push(...packets(e.id, r, CABLE_Z));
  }
  for (const r of paintOrder(roots)) place(r.n);

  // No Docker plane is drawn while Docker has no source and no objects: the layer shows in the side panel only (design 9.1).

  // Label candidates. Labels stay screen-horizontal; priority decides who shows (design 9.5).
  const ancestors = (id: string) => { const out: string[] = []; for (let p = byId.get(id)?.parent; p; p = byId.get(p)?.parent) out.push(p); return out; };
  for (const n of s.nodes) {
    const top = topOf.get(n.id); const b = s.layout[n.id]; const shape = shapes.find((x) => x.id === n.id);
    if (!top || !b || !shape) continue;
    const cx = top.reduce((a, p) => a + p[0], 0) / 4; const cy = top.reduce((a, p) => a + p[1], 0) / 4;
    // A PC's mat is too small to hold its label and its tower: only a node has a free strip.
    const slab = n.kind === 'node';
    // A slab keeps a free strip along its north edge, so its label stands on its own face; if the pill does not fit, it stands beside the slab.
    const strip = (fx: number): Pt => P(b.x + b.w * fx, b.y + HEADER / 2, b.z + b.zh);
    const h = health.get(n.id)!;
    const alerted = h.state === 'problem' || h.state === 'warning';
    let text = n.title + stateSuffix(n, h);
    if (n.kind === 'node' && o.dense) text += ` · 게스트 ${(kids.get(n.id) ?? []).filter((c) => c.kind === 'vm' || c.kind === 'lxc').length}`;
    const pr = o.sel === n.id ? -1 : (RANK[n.kind] ?? 4);
    labels.push({
      id: n.id, text, pr, kind: n.kind, leaf: LEAF.has(n.kind), ...(alerted ? { alert: true } : {}), box: shape.bbox, own: ancestors(n.id), onOwn: slab,
      ...(slab ? { strips: [strip(0.34), strip(0.18), strip(0.5)] } : {}),
      anchor: slab ? strip(0.34) : [cx, cy], top,
    });
  }
  return { prims, labels, shapes, bounds };
}
