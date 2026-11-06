// One Canvas 2D sheet over sigma, redrawn on every afterRender (design 6.1). sigma 4 draws wrong syllables past its first atlas page, so sigma's own
// labels are off. fillRect then fillText: strokeText drops to 56-60 fps and JS timers do not show it, so it must not come back.
import { LABEL_PX, LabelSelector, type Affine } from './labels.ts';
import { labelBudget, type GraphProfile } from './gpuProfile.ts';

export const LABEL_FONT = `500 ${LABEL_PX}px "Malgun Gothic","Noto Sans KR",sans-serif`;

export type OverlayNodes = { keys: string[]; xs: Float32Array; ys: Float32Array; sizes: Float32Array; labels: string[] };
type Projector = {
  graphToViewport(p: { x: number; y: number }): { x: number; y: number };
  scaleSize(size?: number): number;
};

export class LabelOverlay {
  readonly canvas: HTMLCanvasElement;
  /** Time spent per draw, read by the bench (design 11). */
  stats: { ms: number[]; count: number[] } = { ms: [], count: [] };
  recordStats = false;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly measure: CanvasRenderingContext2D;
  private selector: LabelSelector | null = null;
  private nodes: OverlayNodes | null = null;
  private widths = new Float32Array(0);
  private indexOf = new Map<string, number>();
  private hover: string[] = [];
  private w = 0; private h = 0;
  private readonly sigma: Projector;
  private readonly host: HTMLElement;
  private readonly profile: GraphProfile;

  constructor(sigma: Projector, host: HTMLElement, profile: GraphProfile) {
    this.sigma = sigma; this.host = host; this.profile = profile;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
    this.canvas.dataset.testid = 'graph-labels';
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.measure = document.createElement('canvas').getContext('2d')!;
    this.measure.font = LABEL_FONT;
    this.resize();
  }

  get budget() { return labelBudget(this.w, this.h, this.profile); }
  /** Where each drawn label sits, by node key: the check that a label is still beside its node. */
  placements() {
    const s = this.selector;
    return s ? Array.from(s.sel.subarray(0, s.selN), (i, k) => ({ key: this.nodes!.keys[i]!, x: s.selX[k]!, y: s.selY[k]! })) : [];
  }
  get drawnLabels() { return this.selector ? Array.from(this.selector.sel.subarray(0, this.selector.selN), (i) => this.nodes!.labels[i]!) : []; }

  private rebuild() {
    const n = this.nodes;
    if (!n) { this.selector = null; return; }
    this.selector = new LabelSelector(n.xs, n.ys, n.sizes, this.budget, (i) => this.width(i));
    this.applyHover();
  }

  setNodes(nodes: OverlayNodes) {
    this.nodes = nodes;
    this.widths = new Float32Array(nodes.keys.length);
    this.indexOf = new Map(nodes.keys.map((k, i) => [k, i]));
    this.rebuild();
  }

  /** `nodes` stays the source: a resize rebuilds the selector from it, so a position written only to the selector would come undone. */
  setPositions(keys: readonly string[], xs: ArrayLike<number>, ys: ArrayLike<number>) {
    const n = this.nodes;
    if (!n) return;
    keys.forEach((key, k) => {
      const i = this.indexOf.get(key);
      if (i === undefined) return;
      n.xs[i] = xs[k]!; n.ys[i] = ys[k]!;
      this.selector?.setPosition(i, xs[k]!, ys[k]!);
    });
  }

  setHover(keys: readonly string[]) { this.hover = [...keys]; this.applyHover(); }
  private applyHover() {
    const s = this.selector;
    if (!s) return;
    const rest = this.hover.slice(1).map((k) => this.indexOf.get(k) ?? -1).sort((a, b) => (s.sizes[b] ?? 0) - (s.sizes[a] ?? 0));
    s.setPriority(this.hover.length ? [this.indexOf.get(this.hover[0]!) ?? -1, ...rest] : []);
  }

  private width(i: number) {
    let w = this.widths[i]!;
    if (w === 0) { w = this.measure.measureText(this.nodes!.labels[i]!).width; this.widths[i] = w; }
    return w;
  }

  resize() {
    const r = this.host.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.rebuild();
  }

  private affine(): Affine {
    // Three probes per frame, so the per-node work stays out of sigma.
    const { sigma } = this;
    const p0 = sigma.graphToViewport({ x: 0, y: 0 }), p1 = sigma.graphToViewport({ x: 1000, y: 0 }), p2 = sigma.graphToViewport({ x: 0, y: 1000 });
    return { a: (p1.x - p0.x) / 1000, b: (p2.x - p0.x) / 1000, c: p0.x, d: (p1.y - p0.y) / 1000, e: (p2.y - p0.y) / 1000, f: p0.y };
  }

  draw() {
    const { ctx, selector: s, nodes } = this;
    const t0 = this.recordStats ? performance.now() : 0;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!s || !nodes) return;
    s.select(this.affine(), { width: this.w, height: this.h }, this.sigma.scaleSize(1));
    const n = s.selN;
    ctx.font = LABEL_FONT; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,.82)';
    const h = LABEL_PX + 4;
    for (let i = 0; i < n; i++) ctx.fillRect(s.selX[i]! - 2, s.selY[i]! - h / 2, this.widths[s.sel[i]!]! + 4, h);
    ctx.fillStyle = '#222';
    for (let i = 0; i < n; i++) ctx.fillText(nodes.labels[s.sel[i]!]!, s.selX[i]!, s.selY[i]!);
    if (this.recordStats) { this.stats.ms.push(performance.now() - t0); this.stats.count.push(n); }
  }

  remove() { this.canvas.remove(); }
}
