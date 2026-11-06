import Graph from 'graphology';
import Sigma4, { DEFAULT_STYLES, SDFAtlasManager } from 'sigma4';
const ATLASES = []; { const o = SDFAtlasManager.prototype.registerFont; SDFAtlasManager.prototype.registerFont = function (f) { const k = o.call(this, f); ATLASES.push({ m: this, k }); return k; }; }
import { layerDashed } from 'sigma4/rendering';
import Sigma3 from 'sigma3';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import { LabelOverlay } from './overlay.js';

const FONT = '"Malgun Gothic","Noto Sans KR",sans-serif';
const q = new URLSearchParams(location.search);
const P = Object.fromEntries(q.entries());
const num = (k, d) => (P[k] !== undefined ? +P[k] : d);
const raf = () => new Promise((r) => requestAnimationFrame(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { if (!a.length) return null; const s = Float64Array.from(a).sort(); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3); };
const sum = (a) => ({ n: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), p99: pct(a, 0.99), max: a.length ? +Math.max(...a).toFixed(2) : null, mean: a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3) : null });
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const heap = () => { if (window.gc) window.gc(); const m = performance.memory; return m ? { used: m.usedJSHeapSize, total: m.totalJSHeapSize } : null; };
window.onerror = (m, s, l, c, e) => { post('/log', { kind: 'error', m: String(m), stack: e?.stack, url: location.search }); };
window.onunhandledrejection = (e) => { post('/log', { kind: 'rejection', m: String(e.reason), stack: e.reason?.stack, url: location.search }); };

function gpuInfo() {
  const c = document.createElement('canvas'); const gl = c.getContext('webgl2');
  if (!gl) return { webgl2: false };
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const o = { webgl2: true, vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null, maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE), disjoint: !!gl.getExtension('EXT_disjoint_timer_query_webgl2') };
  gl.getExtension('WEBGL_lose_context')?.loseContext(); return o;
}
const env = () => ({ ua: navigator.userAgent, hw: navigator.hardwareConcurrency, dpr: devicePixelRatio, vw: innerWidth, vh: innerHeight, vis: document.visibilityState, focus: document.hasFocus(), gpu: gpuInfo() });

async function loadData(ds, size) {
  const t0 = performance.now(); const res = await fetch(`/data/${ds}-${size}.json`); const data = await res.json(); return { data, fetchMs: performance.now() - t0 };
}
async function loadFonts(strings) {
  if (P.font !== 'noto') return;
  await import('@fontsource/noto-sans-kr/500.css');
  const set = [...new Set(strings.join(''))].filter((c) => c !== ' ').join('');
  // document.fonts.load fetches only the unicode-range subsets these characters need.
  for (let i = 0; i < set.length; i += 200) await document.fonts.load(`500 14px "Noto Sans KR"`, set.slice(i, i + 200));
}
function buildGraph(data, { randomPos = false } = {}) {
  const t0 = performance.now(); const g = new Graph({ type: 'undirected' });
  let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  data.nodes.forEach(([label, x, y, size, color], i) => g.addNode(String(i), { [P.nolabel ? 'l' : 'label']: label, x: randomPos ? rnd() * 1000 : x, y: randomPos ? rnd() * 1000 : y, size, color }));
  data.edges.forEach(([a, b, sup], i) => g.addEdgeWithKey(String(i), String(a), String(b), { size: P.mark ? (sup ? 2 : 1) : 0.5, color: P.mark && sup ? '#d6336c' : P.ec === 'solid' ? '#d3d7de' : 'rgba(110,120,140,0.3)', superseded: sup, dashLen: sup ? 5 : 1e6 }));
  return { g, ms: performance.now() - t0 };
}

function makeReducers(ctx) {
  const v4 = ctx.lib === 4;
  const nodeReducer = (k, d) => {
    if (!ctx.hover) return d;
    if (k === ctx.hover || ctx.nbr.has(k)) return ctx.hoverMode === 'partial' ? { ...d, zIndex: 2, size: d.size * 1.3 } : { ...d, zIndex: 2 };
    return ctx.hoverMode === 'partial' ? d : { ...d, color: '#e4e6ea', label: '' };
  };
  const edgeReducer = (k, d) => {
    if (!ctx.hover) return d;
    if (ctx.inc.has(k)) return { ...d, color: '#d6336c', size: 1.2, zIndex: 2 };
    if (ctx.hoverMode === 'partial') return d;
    return v4 ? { ...d, visibility: 'hidden' } : { ...d, hidden: true };
  };
  return { nodeReducer, edgeReducer };
}
function setHover(ctx, key) {
  const { g, sigma } = ctx; const prevN = ctx.hover ? [ctx.hover, ...ctx.nbr] : []; const prevE = ctx.inc ? [...ctx.inc] : [];
  ctx.hover = key; ctx.nbr = new Set(key ? g.neighbors(key) : []); ctx.inc = new Set(key ? g.edges(key) : []);
  ctx.overlay?.setHover(key, [...ctx.nbr]);
  if (ctx.hoverMode === 'all') { ctx.allN ||= g.nodes(); ctx.allE ||= g.edges(); sigma.refresh({ partialGraph: { nodes: ctx.allN, edges: ctx.allE }, skipIndexation: true }); }
  else if (ctx.hoverMode === 'partial') sigma.refresh({ partialGraph: { nodes: [...prevN, ...(key ? [key] : []), ...ctx.nbr], edges: [...prevE, ...ctx.inc] }, skipIndexation: true });
  else sigma.refresh({ skipIndexation: true });
}

function createSigma(ctx, host, v) {
  const lib = v.startsWith('B') ? 3 : 4; ctx.lib = lib; const { nodeReducer, edgeReducer } = makeReducers(ctx);
  const labelsOn = v === 'B' || v === 'Adef';
  const settings = { renderLabels: labelsOn, renderEdgeLabels: false, hideEdgesOnMove: P.hide === '1', enableCameraRotation: false, labelRenderedSizeThreshold: num('lrt', 6), labelDensity: num('dens', 1), labelGridCellSize: num('cell', 100) };
  if (lib === 3) {
    Object.assign(settings, { labelFont: FONT, labelSize: 12, labelWeight: '500', nodeReducer, edgeReducer });
    return new Sigma3(ctx.g, host, settings);
  }
  const opts = { settings, nodeReducer, edgeReducer };
  const dash = P.dash === '1';
  opts.primitives = dash ? { edges: { layers: [layerDashed({ dashSize: { attribute: 'dashLen', default: 5, mode: 'pixels' }, gapSize: { value: 5, mode: 'pixels' } })] } } : {};
  const nodes = { ...DEFAULT_STYLES.nodes, labelFont: FONT, labelSize: 12 };
  const edges = dash ? { ...DEFAULT_STYLES.edges, dashLen: { attribute: 'dashLen' } } : DEFAULT_STYLES.edges;
  opts.styles = { nodes, edges };
  return new Sigma4(ctx.g, host, opts);
}
function glContexts(sigma, lib) {
  if (lib === 4) return [sigma.getWebGLContext()];
  const out = []; for (const c of Object.values(sigma.getCanvases())) { const gl = c.getContext('webgl2'); if (gl) out.push(gl); } return out;
}
const px = new Uint8Array(4);
const flush = (gls) => { for (const gl of gls) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };

// Deterministic path keyed to wall clock: zoom in, pan a Lissajous, zoom out.
function camAt(t) {
  const ease = (x) => x * x * (3 - 2 * x); const lerp = (a, b, x) => a + (b - a) * x;
  const PX = 0.5 + 0.28 * Math.sin(2 * Math.PI * 1.5 * ((t - 0.3) / 0.4)), PY = 0.5 + 0.22 * Math.sin(2 * Math.PI * 1.0 * ((t - 0.3) / 0.4) + 0.7);
  if (t < 0.3) { const x = ease(t / 0.3); return { x: lerp(0.5, 0.5, x), y: lerp(0.5, 0.5 + 0.22 * Math.sin(0.7), x), ratio: Math.exp(lerp(0, Math.log(0.12), x)), angle: 0 }; }
  if (t < 0.7) return { x: PX, y: PY, ratio: 0.12 + 0.1 * Math.sin(Math.PI * (t - 0.3) / 0.4), angle: 0 };
  const x = ease((t - 0.7) / 0.3); const X = 0.5 + 0.28 * Math.sin(2 * Math.PI * 1.5), Y = 0.5 + 0.22 * Math.sin(2 * Math.PI + 0.7);
  return { x: lerp(X, 0.5, x), y: lerp(Y, 0.5, x), ratio: Math.exp(lerp(Math.log(0.12), 0, x)), angle: 0 };
}

async function path(ctx, ms, sync) {
  const { sigma, gls, overlay } = ctx; const cam = sigma.getCamera(); const rec = { delta: [], js: [], full: [], lbl: [] };
  let bt = 0; let renders = 0;
  const before = () => { bt = performance.now(); };
  const after = () => { const t = performance.now(); rec.js.push(t - bt); renders++; if (sync) { flush(gls); rec.full.push(performance.now() - bt); } if (ctx.labelCount) rec.lbl.push(sigma.getNodeDisplayedLabels().size); };
  sigma.on('beforeRender', before); sigma.on('afterRender', after); overlay?.reset();
  await new Promise((res) => {
    let st = null, last = null;
    const tick = (ts) => { if (st === null) st = ts; const t = (ts - st) / ms; if (t >= 1) return res(); if (last !== null) rec.delta.push(ts - last); last = ts; cam.setState(camAt(t)); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await raf(); sigma.off('beforeRender', before); sigma.off('afterRender', after);
  const dur = rec.delta.reduce((a, b) => a + b, 0);
  const r = { renders, fps: +(rec.delta.length / (dur / 1000)).toFixed(1), rAF: sum(rec.delta), over20: rec.delta.filter((x) => x > 20).length, over34: rec.delta.filter((x) => x > 34).length, over50: rec.delta.filter((x) => x > 50).length, jsRender: sum(rec.js) };
  if (sync) r.cpuGpuFrame = sum(rec.full);
  if (rec.lbl.length) r.labels = sum(rec.lbl);
  if (overlay) { const s = overlay.stats; r.ovSelect = sum(s.selectMs); r.ovDraw = sum(s.drawMs); r.ovTotal = sum(s.selectMs.map((x, i) => x + s.drawMs[i])); r.labels = sum(s.count); r.churnMean = sum(s.churn).mean; }
  return r;
}

const marks = {}; const mark = (k) => { marks[k] = +performance.now().toFixed(0); };
async function bench(host, status) {
  mark('benchStart');
  const v = P.v, ds = P.ds || 'payload', size = P.size || '1k'; ctx0.t = performance.now();
  status('loading ' + v); const { data, fetchMs } = await loadData(ds, size);
  await loadFonts(data.nodes.slice(0, 2000).map((n) => n[0]));
  mark('dataLoaded'); const heap0 = heap(); const { g, ms: buildMs } = buildGraph(data); const heapG = heap(); mark('built');
  const ctx = { g, hover: null, nbr: new Set(), inc: new Set(), hoverMode: P.hm || 'dim', labelCount: v === 'B' || v === 'Adef' }; ctx0.ctx = ctx;
  await raf();
  const t0 = performance.now();
  mark('rafDone'); const sigma = createSigma(ctx, host, v); ctx.sigma = sigma; const t1 = performance.now(); mark('ctor');
  const overlayOn = v === 'A';
  if (overlayOn) { ctx.overlay = new LabelOverlay(sigma, host, g, { K: num('K', 200), tech: P.tech || 'canvas', font: FONT, px: 12, minR: num('minR', 0) }); sigma.on('afterRender', () => ctx.overlay.draw()); ctx.overlay.draw(); }
  ctx.gls = glContexts(sigma, ctx.lib);
  await raf(); await raf(); flush(ctx.gls); const t2 = performance.now();
  const init = { ctorMs: +(t1 - t0).toFixed(1), firstFrameMs: +(t2 - t0).toFixed(1), fetchMs: +fetchMs.toFixed(1), buildMs: +buildMs.toFixed(1), overlayFirstMs: ctx.overlay ? +ctx.overlay.stats.selectMs[0].toFixed(2) + +ctx.overlay.stats.drawMs[0].toFixed(2) : null };
  const canvases = ctx.gls.filter(Boolean).map((gl) => `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`);
  const heap1 = heap();
  mark('firstFrame'); await sleep(300); status('path passive ' + v); mark('pathStart');
  const passive = P.nopath ? null : await path(ctx, 10000, false);
  status('path sync ' + v); await sleep(200);
  const sync = P.nopath || P.nosync ? null : await path(ctx, 10000, true);
  const heap2 = heap();
  // Hover: reducers plus a synchronous refresh, flushed with readPixels.
  status('hover'); ctx.sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 }); await raf(); await raf();
  const byDeg = g.nodes().sort((a, b) => g.degree(b) - g.degree(a)); let sd = 17; const pick = () => byDeg[(sd = (sd * 48271) % 2147483647) % byDeg.length];
  const hvN = num('hv', 10); const nodes = [...byDeg.slice(0, hvN), ...Array.from({ length: hvN }, pick)]; const hv = [], cl = [];
  for (const k of nodes) { let t = performance.now(); setHover(ctx, k); flush(ctx.gls); hv.push(performance.now() - t); await raf(); t = performance.now(); setHover(ctx, null); flush(ctx.gls); cl.push(performance.now() - t); await raf(); }
  mark('hoverDone'); const out = { nav: performance.getEntriesByType('navigation')[0]?.toJSON?.(), marks, P, env: env(), n: g.order, m: g.size, init, canvases, heap: { before: heap0, graph: heapG, loaded: heap1, after: heap2 }, passive, sync, hoverEnter: sum(hv), hoverLeave: sum(cl) };
  await post('/result', out);
  ctx.overlay?.cv?.remove(); sigma.kill();
}
const ctx0 = {};

async function ctorBench(host) {
  // Constructor cost on an empty and a small graph, to separate shader setup from data handling.
  const out = { P, env: env(), runs: [] };
  for (const [lib, label] of [[4, 'sigma4'], [3, 'sigma3'], [4, 'sigma4-again'], [3, 'sigma3-again']]) {
    const g = new Graph({ type: 'undirected' }); g.addNode('a', { x: 0, y: 0, size: 3, color: '#333' }); g.addNode('b', { x: 1, y: 1, size: 3, color: '#333' }); g.addEdge('a', 'b', { size: 1, color: '#999' });
    const d = document.createElement('div'); d.style.cssText = 'position:absolute;inset:0'; host.appendChild(d);
    const t0 = performance.now(); const s = lib === 4 ? new Sigma4(g, d, { settings: { renderLabels: false } }) : new Sigma3(g, d, { renderLabels: false }); const t1 = performance.now();
    flush(glContexts(s, lib)); const t2 = performance.now(); s.kill(); d.remove(); out.runs.push({ label, ctorMs: +(t1 - t0).toFixed(1), flushMs: +(t2 - t1).toFixed(1) });
  }
  await post('/result', out);
}
async function nullBench() {
  await raf(); const d = []; let last = null, st = null;
  await new Promise((res) => { const tick = (ts) => { if (st === null) st = ts; if (ts - st > 10000) return res(); if (last !== null) d.push(ts - last); last = ts; requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  await post('/result', { P, env: env(), nullRaf: sum(d), over20: d.filter((x) => x > 20).length, over34: d.filter((x) => x > 34).length });
}

// Fresh realm per cell without a top-level navigation: Orca holds back the first rAF after a navigation.
async function harness(status) {
  const run = P.run; let i = 0;
  for (;;) {
    const r = await (await fetch('/next?run=' + encodeURIComponent(run))).json();
    if (r.done) break;
    status(`${++i} ${r.q}`); const t0 = performance.now();
    const f = document.createElement('iframe'); f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:#fff'; f.src = '/?' + r.q + '&embedded=1';
    const done = new Promise((res) => { const h = (e) => { if (e.data === 'cell-done') { removeEventListener('message', h); res(); } }; addEventListener('message', h); });
    document.body.appendChild(f);
    await Promise.race([done, sleep(num('cellTimeout', 120000))]);
    f.remove(); await post('/log', { kind: 'cell', q: r.q, ms: Math.round(performance.now() - t0) }); await sleep(700);
  }
  status('RUN DONE'); document.title = 'RUN DONE';
}

async function fa2Bench(host, status) {
  const ds = P.ds || 'payload', size = P.size || '1k', target = num('iters', 300);
  const { data } = await loadData(ds, size); const { g } = buildGraph(data, { randomPos: true });
  const settings = { ...forceAtlas2.inferSettings(g), barnesHutOptimize: g.order > 2000, barnesHutTheta: 0.6, adjustSizes: false };
  const live = P.live === '1'; const ctx = { g, hover: null, nbr: new Set(), inc: new Set() };
  if (live) { ctx.sigma = createSigma(ctx, host, 'A0'); }
  const layout = new FA2Layout(g, { settings });
  let iters = 0; let tStart = 0; const gaps = []; let lastRaf = performance.now(); let running = true;
  const rl = (ts) => { gaps.push(ts - lastRaf); lastRaf = ts; if (running) requestAnimationFrame(rl); }; 
  const done = new Promise((res) => {
    layout.start(); layout.worker.addEventListener('message', () => { iters++; if (iters === 1) tStart = performance.now(); if (iters >= target) res(); });
  });
  tStart = performance.now(); requestAnimationFrame(rl); status('fa2'); await done; const t1 = performance.now(); running = false; layout.stop(); layout.kill(); ctx.sigma?.kill();
  await post('/result', { P, env: env(), n: g.order, m: g.size, fa2: { iters, ms: +(t1 - tStart).toFixed(0), iterPerSec: +(iters / ((t1 - tStart) / 1000)).toFixed(1), mainRaf: sum(gaps), settings: { scalingRatio: settings.scalingRatio, gravity: settings.gravity, barnesHutOptimize: settings.barnesHutOptimize } } });
}

// Atlas check: a grid of single-syllable labels with every label forced visible.
function syllables(n) { const dec = new TextDecoder('euc-kr'); const out = []; for (let a = 0xB0; a <= 0xC8; a++) for (let b = 0xA1; b <= 0xFE; b++) { const c = dec.decode(new Uint8Array([a, b])); if (/^[가-힣]$/.test(c)) out.push(c); } return out.slice(0, n); }
async function atlas(host, status) {
  const lib = +(P.lib || 4), n = num('n', 1200), cols = num('cols', 48); const syl = syllables(n);
  await loadFonts(syl);
  const g = new Graph({ type: 'undirected' }); const rows = Math.ceil(n / cols);
  syl.forEach((s, i) => g.addNode(String(i), { label: s, x: i % cols, y: -Math.floor(i / cols), size: 0.5, color: '#fff' }));
  const settings = { renderLabels: true, labelRenderedSizeThreshold: 0, labelDensity: 100, labelGridCellSize: 8, stagePadding: 24, autoRescale: true };
  let sigma; const reducer = (k, d) => ({ ...d, forceLabel: true, labelVisibility: 'visible' });
  if (lib === 3) { sigma = new Sigma3(g, host, { ...settings, labelFont: FONT, labelSize: 15, nodeReducer: reducer }); }
  else sigma = new Sigma4(g, host, { settings, nodeReducer: reducer, styles: { nodes: { ...DEFAULT_STYLES.nodes, labelFont: FONT, labelSize: 15, labelVisibility: 'visible' }, edges: DEFAULT_STYLES.edges } });
  window.__sigma = sigma; ctx0.sigma = sigma;
  for (let i = 0; i < 90; i++) await raf(); await sleep(1500); sigma.refresh(); await sleep(800);
  const res = { P, env: env(), n, cols, rows };
  if (lib === 4) {
    const al = ATLASES.filter((x) => x.m.getGlyphCount() > 0);
    res.managers = ATLASES.map((x) => ({ glyphs: x.m.getGlyphCount(), pages: x.m.getTextures().map((t) => `${t.width}x${t.height}`) }));
    let G = [], keysTried = []; for (const x of ATLASES) { const T = syl.map((c) => x.m.getGlyph(c.charCodeAt(0), x.k) || null); const c = T.filter(Boolean).length; keysTried.push(x.k + ':' + c); if (c > G.filter(Boolean).length) G = T; } res.keysTried = [...new Set(keysTried)];
    const pageCounts = {}; G.forEach((g) => { if (g) pageCounts[g.atlasIndex] = (pageCounts[g.atlasIndex] || 0) + 1; }); res.pageCounts = pageCounts; res.missingGlyphInfo = G.filter((g) => !g).length;
    const firstOver = G.findIndex((g) => g && g.atlasIndex > 0); res.firstOverflowIndex = firstOver; res.firstOverflowCell = firstOver >= 0 ? { row: Math.floor(firstOver / cols), col: firstOver % cols, ch: syl[firstOver] } : null;
    // A page-1 glyph samples page 0 at its own UV. Find which page-0 glyph sits there.
    const p0 = G.map((g, i) => ({ g, i })).filter((x) => x.g && x.g.atlasIndex === 0);
    res.aliases = [];
    for (let i = firstOver; i >= 0 && i < G.length && res.aliases.length < 14; i++) { const g = G[i]; if (!g || g.atlasIndex === 0) continue; const hit = p0.find((x) => x.g.atlasX === g.atlasX && x.g.atlasY === g.atlasY); res.aliases.push({ i, cell: [Math.floor(i / cols), i % cols], wanted: syl[i], shows: hit ? syl[hit.i] : null, x: g.atlasX, y: g.atlasY }); }
  }
  await post('/result', res); status('ATLAS DONE'); document.title = 'ATLAS DONE'; document.getElementById('status').dataset.done = '1';
}

async function view(host, status) {
  const v = P.v || 'A', ds = P.ds || 'payload', size = P.size || 'full'; const { data } = await loadData(ds, size);
  await loadFonts(data.nodes.map((n) => n[0]));
  const { g } = buildGraph(data); const ctx = { g, hover: null, nbr: new Set(), inc: new Set(), hoverMode: P.hm || 'dim' };
  const sigma = createSigma(ctx, host, v); ctx.sigma = sigma; window.__ctx = ctx;
  if (v === 'A') { ctx.overlay = new LabelOverlay(sigma, host, g, { K: num('K', 200), tech: P.tech || 'canvas', font: FONT, px: 12, minR: num('minR', 0) }); sigma.on('afterRender', () => ctx.overlay.draw()); ctx.overlay.draw(); }
  sigma.on('enterNode', ({ node }) => { ctx.entered = (ctx.entered || 0) + 1; ctx.lastEntered = node; setHover(ctx, node); });
  sigma.on('leaveNode', () => { setHover(ctx, null); });
  window.__cam = (x, y, ratio) => sigma.getCamera().setState({ x, y, ratio, angle: 0 });
  window.__hover = (k) => setHover(ctx, k);
  window.__top = () => g.nodes().sort((a, b) => g.degree(b) - g.degree(a))[0];
  window.__vp = (k) => { const a = g.getNodeAttributes(k); return sigma.graphToViewport({ x: a.x, y: a.y }); };
  window.__p = { P, env: env(), n: g.order, m: g.size };
  if (P.cam) { const [x, y, r] = P.cam.split(',').map(Number); window.__cam(x, y, r); }
  if (P.hovertop) setHover(ctx, window.__top());
  await sleep(600); status('VIEW READY'); document.title = 'VIEW READY'; document.getElementById('status').dataset.done = '1';
}

export async function start(host, setStatus) {
  const status = (s) => setStatus(s); const mode = P.mode || 'bench';
  try {
    if (mode === 'harness') return await harness(status);
    if (mode === 'next') { /* fallthrough */ }
    else if (mode === 'env') { await post('/result', { P, env: env() }); status('ENV DONE'); document.title = 'ENV DONE'; return; }
    else if (mode === 'bench') { if (P.v === 'N') await nullBench(); else await bench(host, status); }
    else if (mode === 'fa2') await fa2Bench(host, status);
    else if (mode === 'ctor') await ctorBench(host);
    else if (mode === 'atlas') return await atlas(host, status);
    else if (mode === 'view') return await view(host, status);
  } catch (e) { await post('/log', { kind: 'caught', m: String(e), stack: e?.stack, url: location.search }); }
  if (P.embedded) { parent.postMessage('cell-done', '*'); return; }
  if (P.run) { const r = await (await fetch('/next?run=' + encodeURIComponent(P.run))).json(); if (r.done) { status('RUN DONE'); document.title = 'RUN DONE'; document.getElementById('status').dataset.done = '1'; return; } status('next: ' + r.q); location.replace('/?' + r.q + '&run=' + encodeURIComponent(P.run)); }
}
