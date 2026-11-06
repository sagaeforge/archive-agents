// Label selection, ported from the S3 overlay (design 6.1). Typed arrays, nodes pre-sorted by size, a 24x16 px collision grid, stop at K.
// The two corrections S3 left open are here: the offset comes from sigma.scaleSize() through `sizeScale`, and selection has hysteresis.
const CELL_W = 24, CELL_H = 16;
export const LABEL_PX = 12;
/** A label already on screen competes as if it were this much bigger, so a small pan does not swap labels every frame. */
export const HYSTERESIS = 1.25;

export type Affine = { a: number; b: number; c: number; d: number; e: number; f: number };
export type Viewport = { width: number; height: number };

export class LabelSelector {
  readonly n: number;
  readonly K: number;
  readonly gx: Float64Array; readonly gy: Float64Array; readonly sizes: Float32Array;
  /** Node indices by size, largest first. */
  readonly order: Int32Array;
  readonly sel: Int32Array; readonly selX: Float32Array; readonly selY: Float32Array;
  selN = 0;
  private priority: Int32Array = new Int32Array(0);
  private prev = new Int32Array(0);
  private readonly width: (i: number) => number;
  private readonly placed: Uint8Array;
  private readonly wasShown: Uint8Array;
  private grid = new Uint8Array(0);
  private gw = 0; private gh = 0;

  constructor(xs: ArrayLike<number>, ys: ArrayLike<number>, sizes: ArrayLike<number>, K: number, width: (i: number) => number) {
    this.n = xs.length; this.K = Math.min(K, this.n); this.width = width;
    this.gx = Float64Array.from(xs); this.gy = Float64Array.from(ys); this.sizes = Float32Array.from(sizes);
    this.order = Int32Array.from({ length: this.n }, (_, i) => i).sort((a, b) => this.sizes[b]! - this.sizes[a]!);
    this.sel = new Int32Array(this.K); this.selX = new Float32Array(this.K); this.selY = new Float32Array(this.K);
    this.placed = new Uint8Array(this.n); this.wasShown = new Uint8Array(this.n);
  }

  setPosition(i: number, x: number, y: number) { this.gx[i] = x; this.gy[i] = y; }
  /** The hovered node and its neighbours go first for as long as the hover lasts (design 6.1). */
  setPriority(indices: readonly number[]) { this.priority = Int32Array.from(indices); }

  private fit(i: number, m: Affine, view: Viewport, sizeScale: number): boolean {
    const x = m.a * this.gx[i]! + m.b * this.gy[i]! + m.c, y = m.d * this.gx[i]! + m.e * this.gy[i]! + m.f;
    if (x < -50 || x > view.width || y < 0 || y > view.height) return false;
    const { grid, gw, gh } = this;
    const tw = this.width(i), off = this.sizes[i]! * sizeScale + 3, ly = y - LABEL_PX * 0.6;
    // The label (with its 2 px backing on each side) sits right of the disc; at the right edge it flips to the left, and one that fits neither way is dropped.
    let lx = x + off;
    if (lx + tw + 2 > view.width) lx = x - off - tw;
    if (lx < 2 && x >= 0) return false;
    if (lx + tw + 2 > view.width || y - (LABEL_PX + 4) / 2 < 0 || y + (LABEL_PX + 4) / 2 > view.height) return false;
    const c0 = Math.max(0, (lx / CELL_W) | 0), c1 = Math.min(gw - 1, ((lx + tw) / CELL_W) | 0);
    const r0 = Math.max(0, (ly / CELL_H) | 0), r1 = Math.min(gh - 1, ((ly + LABEL_PX * 1.2) / CELL_H) | 0);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (grid[r * gw + c]) return false;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) grid[r * gw + c] = 1;
    this.placed[i] = 1;
    const k = this.selN++;
    this.sel[k] = i; this.selX[k] = lx; this.selY[k] = y;
    return true;
  }

  select(m: Affine, view: Viewport, sizeScale: number) {
    const gw = Math.ceil(view.width / CELL_W) + 1, gh = Math.ceil(view.height / CELL_H) + 1;
    if (gw * gh !== this.grid.length) this.grid = new Uint8Array(gw * gh); else this.grid.fill(0);
    this.gw = gw; this.gh = gh;

    // Last frame's labels, largest first, for the merge with `order` below.
    const prev = this.prev;
    for (let k = 0; k < this.selN; k++) this.placed[this.sel[k]!] = 0;
    for (let k = 0; k < prev.length; k++) this.wasShown[prev[k]!] = 0;
    const shown = this.sel.slice(0, this.selN).sort((a, b) => this.sizes[b]! - this.sizes[a]!);
    this.prev = shown;
    for (let k = 0; k < shown.length; k++) this.wasShown[shown[k]!] = 1;
    this.selN = 0;

    const { K, order, sizes, placed, wasShown } = this;
    for (let p = 0; p < this.priority.length && this.selN < K; p++) { const i = this.priority[p]!; if (i >= 0 && !placed[i]) this.fit(i, m, view, sizeScale); }
    let a = 0, b = 0;
    while (this.selN < K) {
      while (a < order.length && (wasShown[order[a]!] || placed[order[a]!])) a++;
      while (b < shown.length && placed[shown[b]!]) b++;
      const fresh = a < order.length ? order[a]! : -1, kept = b < shown.length ? shown[b]! : -1;
      if (fresh < 0 && kept < 0) break;
      if (kept >= 0 && (fresh < 0 || sizes[kept]! * HYSTERESIS >= sizes[fresh]!)) { b++; if (!placed[kept]) this.fit(kept, m, view, sizeScale); }
      else { a++; this.fit(fresh, m, view, sizeScale); }
    }
  }
}
