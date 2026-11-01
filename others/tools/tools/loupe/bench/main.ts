// The S3/S5 bench, ported to the production view (design 11). It drives GraphView, the overlay and the static profile as they ship, on the data the
// bench server made from the same shapes the overview returns. Manual and on a real GPU: SwiftShader numbers mean nothing.
import { decodeGraph, type GraphData } from '../src/graph/model.ts';
import { positionsOf } from '../src/graph/layoutFlow.ts';
import { labelBudget, profileFor, readWebglRenderer } from '../src/graph/gpuProfile.ts';
import { GraphView } from '../src/graph/view.ts';

const q = new URLSearchParams(location.search);
const raf = () => new Promise<number>((r) => requestAnimationFrame(r));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const status = (s: string) => { document.getElementById('status')!.textContent = s; };
const pct = (a: number[], p: number) => { if (!a.length) return null; const s = Float64Array.from(a).sort(); return +s[Math.min(s.length - 1, Math.floor(p * s.length))]!.toFixed(3); };
const sum = (a: number[]) => ({ n: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), p99: pct(a, 0.99), max: a.length ? +Math.max(...a).toFixed(2) : null });
const over = (a: number[], ms: number) => a.filter((x) => x > ms).length;
const heap = () => { const w = window as unknown as { gc?: () => void }; w.gc?.(); const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory; return { used: m?.usedJSHeapSize ?? null, gc: !!w.gc }; };

// Deterministic path keyed to wall clock, from the spike: zoom in, pan a Lissajous, zoom out.
function camAt(t: number) {
  const ease = (x: number) => x * x * (3 - 2 * x), lerp = (a: number, b: number, x: number) => a + (b - a) * x;
  const PX = 0.5 + 0.28 * Math.sin(2 * Math.PI * 1.5 * ((t - 0.3) / 0.4)), PY = 0.5 + 0.22 * Math.sin(2 * Math.PI * ((t - 0.3) / 0.4) + 0.7);
  if (t < 0.3) { const x = ease(t / 0.3); return { x: 0.5, y: lerp(0.5, 0.5 + 0.22 * Math.sin(0.7), x), ratio: Math.exp(lerp(0, Math.log(0.12), x)), angle: 0 }; }
  if (t < 0.7) return { x: PX, y: PY, ratio: 0.12 + 0.1 * Math.sin((Math.PI * (t - 0.3)) / 0.4), angle: 0 };
  const x = ease((t - 0.7) / 0.3), X = 0.5 + 0.28 * Math.sin(2 * Math.PI * 1.5), Y = 0.5 + 0.22 * Math.sin(2 * Math.PI + 0.7);
  return { x: lerp(X, 0.5, x), y: lerp(Y, 0.5, x), ratio: Math.exp(lerp(Math.log(0.12), 0, x)), angle: 0 };
}

const px = new Uint8Array(4);
async function path(view: GraphView, gl: WebGL2RenderingContext, ms: number, sync: boolean) {
  const { sigma, overlay } = view, cam = sigma.getCamera(), delta: number[] = [], js: number[] = [], full: number[] = [];
  let bt = 0;
  const before = () => { bt = performance.now(); };
  const after = () => { const t = performance.now(); js.push(t - bt); if (sync) { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); full.push(performance.now() - bt); } };
  sigma.on('beforeRender', before); sigma.on('afterRender', after);
  overlay.stats = { ms: [], count: [] }; overlay.recordStats = true;
  // camera.setState alone does not count as moving, so `hideEdgesOnMove` would never apply. This is the flag a real drag sets (sigma render: `moving`).
  const captor = sigma.getMouseCaptor();
  captor.isMoving = true;
  await new Promise<void>((res) => {
    let st: number | null = null, last: number | null = null;
    const tick = (ts: number) => { st ??= ts; const t = (ts - st) / ms; if (t >= 1) { res(); return; } if (last !== null) delta.push(ts - last); last = ts; cam.setState(camAt(t)); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  captor.isMoving = false;
  await raf();
  sigma.off('beforeRender', before); sigma.off('afterRender', after); overlay.recordStats = false;
  const dur = delta.reduce((a, b) => a + b, 0);
  return { fps: +(delta.length / (dur / 1000)).toFixed(1), rAF: sum(delta), over20: over(delta, 20), over34: over(delta, 34), jsRender: sum(js), ...(sync ? { cpuGpu: sum(full) } : {}), overlay: sum(overlay.stats.ms), labels: sum(overlay.stats.count) };
}

async function nullRaf(ms: number) {
  const d: number[] = []; let last: number | null = null, st: number | null = null;
  await new Promise<void>((res) => { const tick = (ts: number) => { st ??= ts; if (ts - st > ms) { res(); return; } if (last !== null) d.push(ts - last); last = ts; requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  return sum(d);
}

async function main() {
  const size = q.get('size') ?? '10k', label = q.get('label') ?? 'run';
  const host = document.getElementById('stage')!;
  const renderer = readWebglRenderer(), profile = profileFor(renderer);
  const env = { ua: navigator.userAgent, dpr: devicePixelRatio, vw: innerWidth, vh: innerHeight, vis: document.visibilityState, focus: document.hasFocus(), hw: navigator.hardwareConcurrency, renderer, profile: profile.name };
  status('null rAF');
  const nullFrame = q.get('null') === '0' ? null : await nullRaf(5000);

  status('loading');
  const t0Load = performance.now();
  const file = await (await fetch(`data/${size}.json`, { cache: 'no-store' })).json() as { nodes: never; edges: never; ids: string[]; xy: number[]; community: number[] };
  const fetchMs = performance.now() - t0Load;
  const t0Decode = performance.now();
  const g: GraphData = decodeGraph(file);
  const positions = positionsOf(file.ids, Float32Array.from(file.xy), Int32Array.from(file.community));
  const decodeMs = performance.now() - t0Decode;
  const heap0 = heap();
  await raf();

  const t0 = performance.now();
  const view = new GraphView(host, profile, { onSelect: () => undefined });
  const t1 = performance.now();
  view.setData(g, positions);
  const t2 = performance.now();
  const gl = view.sigma.getWebGLContext();
  await raf(); await raf();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const firstFrameMs = performance.now() - t0;
  const heap1 = heap();
  await sleep(300);

  status('path passive'); const passive = await path(view, gl, 10_000, false);
  await sleep(200);
  status('path sync'); const sync = await path(view, gl, 10_000, true);
  const heap2 = heap();

  status('hover');
  view.sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
  await raf(); await raf();
  const byDegree = view.graph.nodes().sort((a, b) => view.graph.degree(b) - view.graph.degree(a));
  let seed = 17; const pick = () => byDegree[(seed = (seed * 48271) % 2147483647) % byDegree.length]!;
  const targets = [...byDegree.slice(0, 10), ...Array.from({ length: 10 }, pick)];
  const enter: number[] = [], leave: number[] = [];
  for (const k of targets) {
    let t = performance.now(); view.setHover(k); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); enter.push(performance.now() - t); await raf();
    t = performance.now(); view.setHover(null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); leave.push(performance.now() - t); await raf();
  }
  status('click');
  const click: number[] = [];
  for (const k of targets.slice(0, 10)) {
    let t = performance.now(); view.select(k); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); click.push(performance.now() - t); await raf();
    t = performance.now(); view.select(null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); await raf();
  }

  status('swap');
  const moved = new Map(positions);
  const t3 = performance.now();
  view.setPositions(moved);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  await raf();
  const swapMs = performance.now() - t3;

  const out = {
    label, size, env, nullFrame, n: view.graph.order, m: view.graph.size, K: labelBudget(innerWidth, innerHeight, profile),
    nav: performance.getEntriesByType('navigation')[0]?.toJSON?.(),
    init: { fetchMs: +fetchMs.toFixed(1), decodeMs: +decodeMs.toFixed(1), ctorMs: +(t1 - t0).toFixed(1), setDataMs: +(t2 - t1).toFixed(1), firstFrameMs: +firstFrameMs.toFixed(1), swapMs: +swapMs.toFixed(1) },
    heap: { before: heap0, loaded: heap1, after: heap2 }, passive, sync, hoverEnter: sum(enter), hoverLeave: sum(leave), click: sum(click), visEnd: document.visibilityState, focusEnd: document.hasFocus(),
  };
  await fetch('result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out) });
  document.title = 'BENCH DONE'; status(`done: first frame ${out.init.firstFrameMs} ms`);
  if (q.get('kill') === '1') view.kill();
}
main().catch(async (e: unknown) => {
  status(`failed: ${String(e)}`); document.title = 'BENCH FAILED';
  await fetch('result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: String(e), stack: (e as Error)?.stack }) });
});
