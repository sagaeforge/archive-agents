// Own Hangul label overlay. Selection is a typed-array walk, nodes pre-sorted by size.
const CW = 24, CH = 16; // collision cell, CSS px
export class LabelOverlay {
  constructor(sigma, host, graph, { K, tech, font, px, minR }) {
    Object.assign(this, { sigma, host, K, tech, font, px, minR });
    const n = graph.order; this.n = n;
    const keys = graph.nodes(); this.keys = keys; this.gx = new Float64Array(n); this.gy = new Float64Array(n); this.sz = new Float32Array(n); this.labels = new Array(n); this.widths = new Float32Array(n);
    keys.forEach((k, i) => { const a = graph.getNodeAttributes(k); this.gx[i] = a.x; this.gy[i] = a.y; this.sz[i] = a.size; this.labels[i] = a.l ?? a.label; });
    this.order = Int32Array.from(keys.keys()).sort((a, b) => this.sz[b] - this.sz[a]);
    this.indexOf = new Map(keys.map((k, i) => [k, i]));
    this.sel = new Int32Array(Math.min(K, n)); this.selX = new Float32Array(K); this.selY = new Float32Array(K); this.selN = 0; this.prev = new Set();
    this.priority = null; this.stats = { selectMs: [], drawMs: [], count: [], churn: [] };
    if (tech === 'dom') {
      this.el = document.createElement('div'); this.el.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;contain:strict;';
      host.appendChild(this.el); this.pool = [];
      for (let i = 0; i < K; i++) { const s = document.createElement('span'); s.style.cssText = `position:absolute;left:0;top:0;white-space:nowrap;font:500 ${px}px ${font};color:#222;text-shadow:0 0 2px #fff,0 0 2px #fff;will-change:transform;display:none`; this.el.appendChild(s); this.pool.push({ s, id: -1 }); }
    } else {
      this.cv = document.createElement('canvas'); this.cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
      host.appendChild(this.cv); this.ctx = this.cv.getContext('2d');
      this.sprites = new Map();
    }
    this.mctx = document.createElement('canvas').getContext('2d'); this.mctx.font = `500 ${px}px ${font}`;
    this.resize(); this.bc = new Float64Array(6);
  }
  resize() {
    const r = this.host.getBoundingClientRect(); this.w = r.width; this.h = r.height; this.dpr = window.devicePixelRatio || 1;
    if (this.cv) { this.cv.width = Math.round(this.w * this.dpr); this.cv.height = Math.round(this.h * this.dpr); this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }
    this.gw = Math.ceil(this.w / CW) + 1; this.gh = Math.ceil(this.h / CH) + 1; this.grid = new Uint8Array(this.gw * this.gh);
  }
  width(i) { let w = this.widths[i]; if (w === 0) { w = this.mctx.measureText(this.labels[i]).width; this.widths[i] = w; } return w; }
  select() {
    const { sigma, gx, gy, sz, order, grid, gw, K, w, h, minR } = this;
    // Full affine from three probes so per-node work stays out of sigma.
    const p0 = sigma.graphToViewport({ x: 0, y: 0 }), p1 = sigma.graphToViewport({ x: 1000, y: 0 }), p2 = sigma.graphToViewport({ x: 0, y: 1000 });
    const a = (p1.x - p0.x) / 1000, b = (p2.x - p0.x) / 1000, c = p0.x, d = (p1.y - p0.y) / 1000, e = (p2.y - p0.y) / 1000, f = p0.y;
    const scale = 1 / Math.sqrt(sigma.getCamera().getState().ratio);
    grid.fill(0); let got = 0; const px = this.px;
    const list = this.priority || order, L = list.length;
    for (let o = 0; o < L && got < K; o++) {
      const i = list[o]; const x = a * gx[i] + b * gy[i] + c, y = d * gx[i] + e * gy[i] + f;
      if (x < -50 || x > w || y < 0 || y > h) continue;
      const r = sz[i] * scale; if (!this.priority && r < minR) break; // sorted by size
      const tw = this.width(i), lx = x + r + 3, ly = y - px * 0.6;
      const c0 = Math.max(0, lx / CW | 0), c1 = Math.min(gw - 1, (lx + tw) / CW | 0), r0 = Math.max(0, ly / CH | 0), r1 = Math.min(this.gh - 1, (ly + px * 1.2) / CH | 0);
      let hit = false; for (let rr = r0; rr <= r1 && !hit; rr++) for (let cc = c0; cc <= c1; cc++) if (grid[rr * gw + cc]) { hit = true; break; }
      if (hit) continue;
      for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) grid[rr * gw + cc] = 1;
      this.sel[got] = i; this.selX[got] = lx; this.selY[got] = y; got++;
    }
    this.selN = got;
  }
  draw() {
    const t0 = performance.now(); this.select(); const t1 = performance.now();
    const n = this.selN;
    if (this.tech === 'canvas' || this.tech === 'fill' || this.tech === 'fillbg') {
      const ctx = this.ctx; ctx.clearRect(0, 0, this.w, this.h); ctx.font = `500 ${this.px}px ${this.font}`; ctx.textBaseline = 'middle';
      if (this.tech === 'canvas') { ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.9)'; for (let i = 0; i < n; i++) ctx.strokeText(this.labels[this.sel[i]], this.selX[i], this.selY[i]); }
      if (this.tech === 'fillbg') { ctx.fillStyle = 'rgba(255,255,255,.82)'; const h = this.px + 4; for (let i = 0; i < n; i++) ctx.fillRect(this.selX[i] - 2, this.selY[i] - h / 2, this.widths[this.sel[i]] + 4, h); }
      ctx.fillStyle = '#222'; for (let i = 0; i < n; i++) ctx.fillText(this.labels[this.sel[i]], this.selX[i], this.selY[i]);
    } else if (this.tech === 'sprite') {
      const ctx = this.ctx; ctx.clearRect(0, 0, this.w, this.h); const dpr = this.dpr, px = this.px;
      for (let i = 0; i < n; i++) {
        const id = this.sel[i]; let sp = this.sprites.get(id);
        if (!sp) { const w = Math.ceil(this.width(id)) + 8, h = px + 10; const c = new OffscreenCanvas(w * dpr, h * dpr); const x = c.getContext('2d'); x.scale(dpr, dpr); x.font = `500 ${px}px ${this.font}`; x.textBaseline = 'middle'; x.lineJoin = 'round'; x.lineWidth = 3; x.strokeStyle = 'rgba(255,255,255,.9)'; x.strokeText(this.labels[id], 4, h / 2); x.fillStyle = '#222'; x.fillText(this.labels[id], 4, h / 2); sp = { c, w, h }; if (this.sprites.size > 3000) this.sprites.delete(this.sprites.keys().next().value); this.sprites.set(id, sp); }
        ctx.drawImage(sp.c, this.selX[i] - 4, this.selY[i] - sp.h / 2, sp.w, sp.h);
      }
    } else { // pooled DOM spans
      for (let i = 0; i < this.pool.length; i++) {
        const p = this.pool[i];
        if (i < n) { const id = this.sel[i]; if (p.id !== id) { p.s.textContent = this.labels[id]; p.id = id; } p.s.style.display = 'block'; p.s.style.transform = `translate3d(${this.selX[i] | 0}px,${(this.selY[i] - this.px * 0.6) | 0}px,0)`; }
        else if (p.id !== -2) { p.s.style.display = 'none'; p.id = -2; }
      }
    }
    const t2 = performance.now();
    const s = this.stats; s.selectMs.push(t1 - t0); s.drawMs.push(t2 - t1); s.count.push(n);
    let same = 0; const cur = new Set(); for (let i = 0; i < n; i++) { const id = this.sel[i]; cur.add(id); if (this.prev.has(id)) same++; } s.churn.push(n ? 1 - same / n : 0); this.prev = cur;
  }
  reset() { this.stats = { selectMs: [], drawMs: [], count: [], churn: [] }; }
  setHover(key, nbrs) { if (!key) { this.priority = null; return; } const arr = [this.indexOf.get(key), ...nbrs.map((k) => this.indexOf.get(k)).sort((a, b) => this.sz[b] - this.sz[a])]; this.priority = arr; }
}
