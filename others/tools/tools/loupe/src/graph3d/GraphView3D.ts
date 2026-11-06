// The 3D home graph: 3d-force-graph 1.80.1 on three 0.186.1, driven directly like GraphView drives sigma. The screen sees the methods it
// already uses on GraphView (setData, setPositions, select, setHover, focusOn, fit, viewportOf, kill) and nothing about three.
//
// What differs from 2D, on purpose:
//  - No physics. Positions are the stored layout (x, y) plus a z derived from the Louvain community and the node id, so nothing moves on
//    its own (WCAG 2.2.2) and a filter does not shake the nodes that stay. cooldownTicks is 0.
//  - Picking is ours. three-render-objects raycasts every node mesh and link line on each pointer move; at 10k nodes and 40k links that is the
//    wrong cost. Nodes are projected once per pointer frame instead and the nearest one under the pointer wins.
//  - Hover, selection, anchor rings and labels are a Canvas 2D sheet over the WebGL canvas. The meshes are never recoloured by a hover.
//  - The render loop sleeps when nothing moves, and wakes on camera input, data changes and camera moves.
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import { degrees, drawnEdges, nodeSize, type GraphData } from '../graph/model.ts';
import type { Positions } from '../graph/layoutFlow.ts';
import { communityColor } from '../graph/view.ts';
import { LABEL_FONT } from '../graph/overlay.ts';
import { LABEL_PX } from '../graph/labels.ts';
import { MiniGraph } from './miniGraph.ts';

const EDGE_COLOR = '#c9ced6', EDGE_DASHED = '#e1e4e9', EDGE_ACCENT = '#d6336c', ANCHOR_COLOR = '#c4cad3';
const MAX_BASE_LABELS = 14, MIN_PICK_PX = 7, CLICK_SLOP_PX = 5, IDLE_MS = 1200;

export type ViewEvents3D = { onSelect(id: string | null): void; onHover(id: string | null): void };
type N = { id: string; x: number; y: number; z: number; val: number; color: string; r: number };
type L = { source: string; target: string };
type Screen = { x: number; y: number; r: number; w: number };

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

export class GraphView3D {
  readonly kind = '3d' as const;
  readonly graph = new MiniGraph();
  /** Timings the bench reads, in ms from the call of setData: until it returned, until every mesh exists, until a frame is drawn with them. */
  readonly stats = { setDataMs: 0, digestMs: 0, firstFrameMs: 0, nodes: 0, links: 0 };
  private readonly fg: ForceGraph3DInstance;
  private readonly host: HTMLElement;
  private readonly events: ViewEvents3D;
  private readonly labels: HTMLCanvasElement; private readonly rings: HTMLCanvasElement;
  private readonly lctx: CanvasRenderingContext2D; private readonly rctx: CanvasRenderingContext2D;
  private readonly measure: CanvasRenderingContext2D;
  private readonly observer: ResizeObserver;
  private nodes: N[] = [];
  private data: GraphData = { nodes: [], edges: [] };
  private index = new Map<string, number>();
  private order: string[] = [];
  private anchors = new Set<string>();
  private hover: string | null = null;
  private selected: string | null = null;
  private pointer: { x: number; y: number } | null = null;
  private down: { x: number; y: number } | null = null;
  private pointerHover: string | null = null;
  private moved = false;
  private fitted = false;
  private drawQueued = false; private pickQueued = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAwake = false;
  private w = 1; private h = 1;
  private shown: { key: string; x: number; y: number }[] = [];
  private killed = false;
  private readonly cleanups: (() => void)[] = [];
  /** Labels drawn in the last frame, in draw order. Tests and the bench read it. */
  drawnLabels: string[] = [];

  constructor(host: HTMLElement, events: ViewEvents3D) {
    this.host = host; this.events = events;
    const r = host.getBoundingClientRect();
    this.w = Math.max(1, Math.round(r.width)); this.h = Math.max(1, Math.round(r.height));
    this.fg = new ForceGraph3D(host, { controlType: 'orbit', rendererConfig: { antialias: true, alpha: true, powerPreference: 'high-performance' } });
    const fg = this.fg;
    fg.width(this.w).height(this.h).showNavInfo(false).backgroundColor('rgba(0,0,0,0)')
      .numDimensions(3).cooldownTicks(0).warmupTicks(0).enableNodeDrag(false).enablePointerInteraction(false)
      .nodeLabel(() => '').linkLabel(() => '')
      .nodeRelSize(3).nodeOpacity(1).linkWidth(0).linkOpacity(0.55)
      .linkColor((l: object) => (l as L & { color: string }).color);
    const dom = fg.renderer().domElement;
    dom.style.display = 'block';
    this.labels = this.sheet('graph-labels'); this.rings = this.sheet('graph-anchors');
    this.rings.dataset.anchors = '';
    this.lctx = this.labels.getContext('2d')!; this.rctx = this.rings.getContext('2d')!;
    this.measure = document.createElement('canvas').getContext('2d')!;
    this.measure.font = LABEL_FONT;
    this.sizeSheets();

    const controls = fg.controls() as { addEventListener(t: string, f: () => void): void; removeEventListener(t: string, f: () => void): void };
    const onCamera = () => { this.wake(); this.requestDraw(); };
    // `start` is a person's input (drag, wheel): from then on the camera is theirs and new positions do not refit it.
    const onStart = () => { this.moved = true; this.wake(); };
    controls.addEventListener('change', onCamera); controls.addEventListener('start', onStart); controls.addEventListener('end', onCamera);
    this.cleanups.push(() => { controls.removeEventListener('change', onCamera); controls.removeEventListener('start', onStart); controls.removeEventListener('end', onCamera); });

    const on = <K extends keyof HTMLElementEventMap>(t: K, f: (e: HTMLElementEventMap[K]) => void) => { dom.addEventListener(t, f as EventListener); this.cleanups.push(() => { dom.removeEventListener(t, f as EventListener); }); };
    on('pointermove', (e) => { const p = this.local(e); this.pointer = p; this.requestPick(); });
    on('pointerleave', () => { this.pointer = null; this.requestPick(); });
    on('pointerdown', (e) => { this.down = this.local(e); });
    on('pointerup', (e) => {
      const d = this.down, p = this.local(e);
      this.down = null;
      if (!d || Math.hypot(p.x - d.x, p.y - d.y) > CLICK_SLOP_PX) return;
      this.events.onSelect(this.pick(p.x, p.y));
    });
    this.observer = new ResizeObserver(() => {
      const b = host.getBoundingClientRect();
      this.w = Math.max(1, Math.round(b.width)); this.h = Math.max(1, Math.round(b.height));
      fg.width(this.w).height(this.h); this.sizeSheets(); this.wake(); this.requestDraw();
    });
    this.observer.observe(host);
  }

  private sheet(testid: string) {
    const c = document.createElement('canvas');
    c.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none';
    c.dataset.testid = testid;
    if (testid === 'graph-anchors') c.setAttribute('aria-hidden', 'true');
    this.host.appendChild(c);
    return c;
  }
  private sizeSheets() {
    const dpr = window.devicePixelRatio || 1;
    for (const [c, ctx] of [[this.labels, this.lctx], [this.rings, this.rctx]] as const) {
      c.width = Math.round(this.w * dpr); c.height = Math.round(this.h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }
  private local(e: PointerEvent) { const b = this.fg.renderer().domElement.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }

  // The loop sleeps IDLE_MS after the last thing that needed a frame. Always on while a bench holds it awake.
  private wake(ms = IDLE_MS) {
    if (this.killed) return;
    this.fg.resumeAnimation();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = this.keepAwake ? null : setTimeout(() => { if (!this.killed) this.fg.pauseAnimation(); this.idleTimer = null; }, ms);
  }
  /** Bench: render every frame until released. */
  holdAwake(on: boolean) { this.keepAwake = on; this.wake(); }
  /** Frames three has rendered so far. */
  get renderedFrames() { return this.fg.renderer().info.render.frame; }

  /** Everything on the canvas comes from `g`. The frame comes from `positions`, all of them, so a filter does not move what stays. */
  setData(g: GraphData, positions: Positions) {
    const t0 = performance.now();
    this.data = g;
    this.hover = this.pointerHover = null;
    const edges = drawnEdges(g), degree = degrees(edges);
    // One scale from the whole position set, so the same node keeps its place when the shown set changes.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of positions.values()) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
    const span = Math.max(maxX - minX, maxY - minY, 1e-9), cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const radius = 200 + 12 * Math.sqrt(positions.size), k = (2 * radius) / span;
    this.graph.clear();
    const nodes: N[] = [];
    for (const n of g.nodes) {
      const p = positions.get(n.id);
      if (!p) continue;
      const size = nodeSize(degree.get(n.id) ?? 0);
      const z = (hash(n.id) - 0.5) * radius * 0.5 + (p.community >= 0 ? ((p.community % 5) - 2) * radius * 0.12 : 0);
      const node: N = { id: n.id, x: (p.x - cx) * k, y: -(p.y - cy) * k, z, val: size, color: this.anchors.has(n.id) ? ANCHOR_COLOR : communityColor(p.community), r: Math.cbrt(size) * 3 };
      nodes.push(node);
      this.graph.addNode(n.id, n.label, size);
    }
    const links: (L & { color: string })[] = [];
    for (const e of edges) {
      if (!this.graph.hasNode(e.src) || !this.graph.hasNode(e.dst)) continue;
      this.graph.addEdge(e.id, e.src, e.dst);
      if (e.drawn) links.push({ source: e.src, target: e.dst, color: e.dashed ? EDGE_DASHED : EDGE_COLOR });
    }
    this.nodes = nodes; this.index = new Map(nodes.map((n, i) => [n.id, i])); this.order = nodes.map((n) => n.id);
    // Meshes are drawn per node and per link: fewer sphere facets once the count is large (measured in e2e/graph3d-perf.spec.ts).
    this.fg.nodeResolution(nodes.length > 3000 ? 4 : nodes.length > 800 ? 6 : 8);
    this.fg.nodeVal('val').nodeColor('color').nodeId('id').graphData({ nodes: nodes as never, links: links as never });
    this.refreshSelection();
    this.stats.nodes = nodes.length; this.stats.links = links.length;
    this.stats.setDataMs = performance.now() - t0;
    this.wake();
    if (!this.fitted || !this.moved) { this.fit(true); this.fitted = true; this.moved = false; }
    this.requestDraw();
    this.timeFirstFrame(t0, nodes);
  }

  /** three-forcegraph builds the meshes a tick after graphData (kapsule debounces), so "first frame" waits for the last node's mesh and then
   *  for a render after it. The bench reads `stats`. */
  private timeFirstFrame(t0: number, nodes: N[]) {
    this.stats.digestMs = 0; this.stats.firstFrameMs = 0;
    let after = -1;
    const poll = () => {
      if (this.killed || this.nodes !== nodes) return;
      const built = nodes.length === 0 || (nodes[nodes.length - 1] as unknown as { __threeObj?: unknown }).__threeObj !== undefined;
      if (built && after < 0) { this.stats.digestMs = performance.now() - t0; after = this.renderedFrames; }
      else if (after >= 0 && this.renderedFrames > after) { this.stats.firstFrameMs = performance.now() - t0; return; }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }

  /** The one swap at the end of a cold layout. */
  setPositions(positions: Positions) { this.setData(this.data, positions); }

  private refreshSelection() { if (this.selected && !this.graph.hasNode(this.selected)) this.selected = null; }

  setHover(key: string | null) { if (key !== this.hover) { this.hover = key; this.requestDraw(); } }
  get hoverId() { return this.hover; }
  select(id: string | null) { if (id !== this.selected) { this.selected = id; this.refreshSelection(); this.requestDraw(); } }
  get selectedId() { return this.selected; }

  /** Anchors keep their place but fade, so the topic that anchors a cluster reads as context (design v2 2.3). */
  setAnchors(ids: string[]) {
    this.anchors = new Set(ids);
    this.rings.dataset.anchors = ids.join(',');
    for (const n of this.nodes) if (this.anchors.has(n.id)) n.color = ANCHOR_COLOR;
    this.fg.refresh();
    this.wake(); this.requestDraw();
  }

  private ms() { return document.documentElement.dataset.motion === 'reduce' ? 0 : 300; }
  focusOn(id: string) {
    const n = this.nodes[this.index.get(id) ?? -1];
    if (!n) return;
    const d = Math.hypot(n.x, n.y, n.z) || 1, back = 1 + 120 / d;
    this.fg.cameraPosition({ x: n.x * back, y: n.y * back, z: n.z * back }, { x: n.x, y: n.y, z: n.z }, this.ms());
    this.wake(this.ms() + IDLE_MS);
  }
  /** Fits a sphere around the shown nodes, from the direction the camera already looks. zoomToFit is not used: it measures the meshes, which
   *  three-forcegraph builds a tick after graphData, so right after setData it fits the previous graph. */
  fit(instant = false) {
    const ns = this.nodes;
    if (ns.length === 0) return;
    let cx = 0, cy = 0, cz = 0;
    for (const n of ns) { cx += n.x; cy += n.y; cz += n.z; }
    cx /= ns.length; cy /= ns.length; cz /= ns.length;
    let R = 1;
    for (const n of ns) R = Math.max(R, Math.hypot(n.x - cx, n.y - cy, n.z - cz) + n.r);
    const cam = this.fg.camera() as unknown as { fov: number; aspect: number; position: { x: number; y: number; z: number } };
    const halfV = (cam.fov * Math.PI) / 360, halfH = Math.atan(Math.tan(halfV) * (this.w / this.h));
    const dist = (R * 1.12) / Math.sin(Math.min(halfV, halfH));
    let dx = cam.position.x - cx, dy = cam.position.y - cy, dz = cam.position.z - cz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) { dx = 0; dy = 0; dz = 1; } else { dx /= len; dy /= len; dz /= len; }
    const ms = instant ? 0 : this.ms();
    this.fg.cameraPosition({ x: cx + dx * dist, y: cy + dy * dist, z: cz + dz * dist }, { x: cx, y: cy, z: cz }, ms);
    this.wake(ms + IDLE_MS);
    this.requestDraw();
  }

  // Projection. One matrix per call, then twelve multiplications per node.
  private project(into: Screen[], only?: readonly number[]) {
    const cam = this.fg.camera() as unknown as { updateMatrixWorld(): void; matrixWorldInverse: { elements: number[] }; projectionMatrix: { elements: number[] }; };
    cam.updateMatrixWorld();
    const v = cam.matrixWorldInverse.elements, p = cam.projectionMatrix.elements;
    const m = new Float64Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += p[k * 4 + r]! * v[c * 4 + k]!; m[c * 4 + r] = s; }
    const hw = this.w / 2, hh = this.h / 2, pr = p[5]! * hh;
    const out = (i: number) => {
      const n = this.nodes[i]!;
      const w = m[3]! * n.x + m[7]! * n.y + m[11]! * n.z + m[15]!;
      if (w <= 1e-6) return null;
      const x = (m[0]! * n.x + m[4]! * n.y + m[8]! * n.z + m[12]!) / w, y = (m[1]! * n.x + m[5]! * n.y + m[9]! * n.z + m[13]!) / w;
      return { x: (x + 1) * hw, y: (1 - y) * hh, r: (n.r * pr) / w, w };
    };
    if (only) { for (const i of only) { const s = out(i); if (s) into[i] = s; } return; }
    for (let i = 0; i < this.nodes.length; i++) { const s = out(i); if (s) into[i] = s; }
  }

  /** Viewport position of a node. Tests and the bench use it to aim. */
  viewportOf(id: string) {
    const i = this.index.get(id);
    if (i === undefined) return { x: Number.NaN, y: Number.NaN };
    const s: Screen[] = []; this.project(s, [i]);
    return s[i] ? { x: s[i].x, y: s[i].y } : { x: Number.NaN, y: Number.NaN };
  }

  private pick(px: number, py: number): string | null {
    const s: Screen[] = [];
    this.project(s);
    let best = -1, bw = Infinity;
    for (let i = 0; i < s.length; i++) {
      const q = s[i];
      if (!q) continue;
      const r = Math.max(q.r, MIN_PICK_PX), dx = q.x - px, dy = q.y - py;
      if (dx * dx + dy * dy <= r * r && q.w < bw) { best = i; bw = q.w; }
    }
    return best < 0 ? null : this.nodes[best]!.id;
  }
  private requestPick() {
    if (this.pickQueued) return;
    this.pickQueued = true;
    requestAnimationFrame(() => {
      this.pickQueued = false;
      if (this.killed || this.down) return;
      const id = this.pointer ? this.pick(this.pointer.x, this.pointer.y) : null;
      this.host.style.cursor = id ? 'pointer' : '';
      if (id === this.pointerHover) return;
      this.pointerHover = id;
      this.setHover(id);
      this.events.onHover(id);
    });
  }

  private requestDraw() {
    if (this.drawQueued || this.killed) return;
    this.drawQueued = true;
    requestAnimationFrame(() => { this.drawQueued = false; if (!this.killed) this.draw(); });
  }

  private draw() {
    const { lctx: c, rctx: rc, w, h } = this;
    c.clearRect(0, 0, w, h); rc.clearRect(0, 0, w, h);
    this.drawnLabels = []; this.shown = [];
    if (this.nodes.length === 0) return;
    const focus = [...new Set([this.hover, this.selected])].filter((k): k is string => !!k && this.graph.hasNode(k));
    const ring = new Set(focus), near = new Set<string>();
    for (const f of focus) for (const nb of this.graph.neighbors(f)) near.add(nb);
    // Only what is drawn is projected: the focus, its neighbours, the anchors and the best-connected nodes.
    const want = new Set<string>([...focus, ...near, ...this.anchors, ...this.topDegree()]);
    const idx = [...want].map((k) => this.index.get(k)).filter((i): i is number => i !== undefined);
    const s: Screen[] = []; this.project(s, idx);
    // Edges of the focus, in the accent colour (the meshes keep their colour).
    c.strokeStyle = EDGE_ACCENT; c.lineWidth = 1.2; c.beginPath();
    for (const f of focus) { const a = s[this.index.get(f)!]; if (!a) continue; for (const nb of this.graph.neighbors(f)) { const b = s[this.index.get(nb)!]; if (b) { c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); } } }
    c.stroke();
    rc.strokeStyle = '#5b6573'; rc.lineWidth = 1.5; rc.setLineDash([4, 3]);
    for (const id of this.anchors) { const q = s[this.index.get(id) ?? -1]; if (q) { rc.beginPath(); rc.arc(q.x, q.y, Math.max(q.r, 3) + 4, 0, Math.PI * 2); rc.stroke(); } }
    rc.setLineDash([]); rc.strokeStyle = '#1f2933'; rc.lineWidth = 2;
    for (const id of ring) { const q = s[this.index.get(id)!]; if (q) { rc.beginPath(); rc.arc(q.x, q.y, Math.max(q.r, 3) + 3, 0, Math.PI * 2); rc.stroke(); } }
    // Labels: focus first, then its neighbours, then the best-connected, each only if it does not cover one already placed.
    c.font = LABEL_FONT; c.textBaseline = 'middle';
    const placed: { l: number; t: number; r: number; b: number }[] = [];
    const lh = LABEL_PX + 4;
    const order = [...focus, ...[...near].filter((k) => !ring.has(k)), ...this.topDegree().filter((k) => !ring.has(k) && !near.has(k))];
    for (const key of order) {
      const q = s[this.index.get(key) ?? -1];
      if (!q || q.x < 0 || q.y < 0 || q.x > w || q.y > h) continue;
      const text = this.graph.label(key), tw = this.measure.measureText(text).width;
      const box = { l: q.x + Math.max(q.r, 3) + 3 - 2, t: q.y - lh / 2, r: q.x + Math.max(q.r, 3) + 3 + tw + 2, b: q.y + lh / 2 };
      if (!ring.has(key) && placed.some((p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t)) continue;
      placed.push(box);
      c.fillStyle = 'rgba(255,255,255,.82)'; c.fillRect(box.l, box.t, box.r - box.l, lh);
      c.fillStyle = '#222'; c.fillText(text, box.l + 2, q.y);
      this.drawnLabels.push(text); this.shown.push({ key, x: q.x, y: q.y });
    }
  }

  private top: string[] | null = null; private topFor = 0;
  private topDegree(): string[] {
    if (!this.top || this.topFor !== this.nodes.length) {
      this.topFor = this.nodes.length;
      this.top = [...this.order].sort((a, b) => this.graph.degree(b) - this.graph.degree(a) || (a < b ? -1 : 1)).slice(0, MAX_BASE_LABELS);
    }
    return this.top;
  }

  kill() {
    if (this.killed) return;
    this.killed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.observer.disconnect();
    for (const f of this.cleanups) f();
    const gl = this.fg.renderer();
    this.fg._destructor();
    // three-render-objects disposes the renderer but leaves the context open: release it now, not at garbage collection.
    gl.forceContextLoss();
    this.host.replaceChildren();
    this.host.style.cursor = '';
  }
}
