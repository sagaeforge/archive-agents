// Builds benchmark graphs. Node 26. Deterministic (seeded PRNG).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Graph = require('graphology');
const fa2 = require('graphology-layout-forceatlas2');
const louvain = require('graphology-communities-louvain');

const SRC = process.argv[2];
const OUT = new URL('../public/data/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// KS X 1001 Hangul block, counted from the euc-kr codec (2,350 syllables).
const dec = new TextDecoder('euc-kr');
const KS = [];
for (let a = 0xB0; a <= 0xC8; a++) for (let b = 0xA1; b <= 0xFE; b++) { const c = dec.decode(new Uint8Array([a, b])); if (/^[가-힣]$/.test(c)) KS.push(c); }

function labelFactory(seed) {
  const r = rng(seed);
  // Zipf-weighted syllable pick over a shuffled KS X 1001 list: frequent head, rare tail, as Korean text has.
  const pool = KS.slice(); for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const W = pool.map((_, i) => 1 / Math.pow(i + 1, 0.75)); const cum = []; let acc = 0; for (const w of W) cum.push(acc += w);
  const pick = () => { const x = r() * acc; let lo = 0, hi = cum.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m + 1; else hi = m; } return pool[lo]; };
  // A small dictionary of pseudo-words so words repeat between labels.
  const dict = Array.from({ length: 6000 }, () => { const n = 2 + Math.floor(r() * 3); let w = ''; for (let i = 0; i < n; i++) w += pick(); return w; });
  const range = { Keyword: [2, 5], Topic: [3, 8], Channel: [3, 10], Source: [5, 14], Video: [8, 18], Claim: [10, 20] };
  return (kind) => {
    const [lo, hi] = range[kind] ?? [2, 20];
    const target = lo + Math.floor(r() * (hi - lo + 1));
    const words = []; let n = 0;
    while (n < target) { let w = dict[Math.floor(Math.pow(r(), 1.6) * dict.length)]; if (n + w.length > target) w = w.slice(0, target - n); words.push(w); n += w.length; }
    return words.join(' ');
  };
}

const KINDS = ['Channel', 'Source', 'Keyword', 'Topic', 'Claim', 'Video'];
const PAL = ['#4269d0', '#efb118', '#ff725c', '#6cc5b0', '#3ca951', '#ff8ab7', '#a463f2', '#97bbf5', '#9c6b4e', '#9498a0'];

function payloadGraph(raw, n, m) {
  // Keeps the preserved topology for full size; folds node ids modulo n for smaller sizes so edge count is honoured.
  const idx = new Map(raw.nodes.map((x, i) => [x.id, i]));
  const seen = new Set(); const edges = [];
  for (const e of raw.edges) {
    const a = idx.get(e.a) % n, b = idx.get(e.b) % n; if (a === b) continue;
    const k = a < b ? a * 100000 + b : b * 100000 + a; if (seen.has(k)) continue; seen.add(k);
    edges.push([a, b]); if (edges.length >= m) break;
  }
  return { n, edges, kind: raw.nodes.slice(0, n).map((x) => x.k), comm: null };
}
function communityGraph(n, m, seed) {
  const r = rng(seed); const C = Math.max(8, Math.round(n / 250));
  const sz = Array.from({ length: C }, (_, i) => 1 / Math.pow(i + 1, 0.8)); const tot = sz.reduce((a, b) => a + b, 0);
  const comm = new Int32Array(n); const members = Array.from({ length: C }, () => []);
  let p = 0; for (let c = 0; c < C; c++) { const k = c === C - 1 ? n - p : Math.max(4, Math.round((sz[c] / tot) * n)); for (let i = 0; i < k && p < n; i++, p++) { comm[p] = c; members[c].push(p); } }
  const hub = (arr) => arr[Math.floor(Math.pow(r(), 2.4) * arr.length)]; // heavy-tail: low index in a community is a hub
  const seen = new Set(); const edges = []; let guard = 0;
  while (edges.length < m && guard++ < m * 40) {
    const a = Math.floor(r() * n); const c = r() < 0.85 ? comm[a] : Math.floor(r() * C); const b = hub(members[c]); if (a === b) continue;
    const k = a < b ? a * 100000 + b : b * 100000 + a; if (seen.has(k)) continue; seen.add(k); edges.push([a, b]);
  }
  return { n, edges, comm: Array.from(comm), kind: Array.from({ length: n }, () => KINDS[Math.floor(r() * 6)]) };
}

function layout(gg, iters) {
  const g = new Graph({ type: 'undirected', multi: false });
  const r = rng(11);
  for (let i = 0; i < gg.n; i++) g.addNode(i, { x: r() * 1000, y: r() * 1000 });
  for (const [a, b] of gg.edges) g.addEdge(a, b);
  const settings = { ...fa2.inferSettings(g), barnesHutOptimize: gg.n > 2000, barnesHutTheta: 0.6, adjustSizes: false };
  const checkpoints = [];
  const metric = () => { // mean edge length divided by bbox diagonal: smaller means tighter clusters
    let minx = 1e12, maxx = -1e12, miny = 1e12, maxy = -1e12; g.forEachNode((_, a) => { minx = Math.min(minx, a.x); maxx = Math.max(maxx, a.x); miny = Math.min(miny, a.y); maxy = Math.max(maxy, a.y); });
    const diag = Math.hypot(maxx - minx, maxy - miny); let s = 0; g.forEachEdge((_, __, a, b, A, B) => { s += Math.hypot(A.x - B.x, A.y - B.y); }); return s / g.size / diag;
  };
  const t0 = performance.now(); let done = 0;
  for (const cp of [50, 100, 200, 300, 500, 1000].filter((c) => c <= iters)) { fa2.assign(g, { iterations: cp - done, settings }); done = cp; checkpoints.push({ iters: cp, ms: +(performance.now() - t0).toFixed(0), edgeLenRatio: +metric().toFixed(4) }); }
  const t1 = performance.now();
  let lv = null; { const t = performance.now(); const res = louvain.detailed(g, { randomWalk: false, rng: rng(5) }); lv = { ms: +(performance.now() - t).toFixed(1), communities: res.count, modularity: +res.modularity.toFixed(3) }; }
  const xy = gg.edges.length ? [] : [];
  g.forEachNode((k, a) => { xy[+k] = [+a.x.toFixed(2), +a.y.toFixed(2)]; });
  return { xy, layoutMs: +(t1 - t0).toFixed(0), checkpoints, louvain: lv, settings };
}

const raw = JSON.parse(gunzipSync(readFileSync(SRC)).toString());
const sizes = { '1k': [1000, 5000], '5k': [5000, 25000], full: [10000, 51354] };
const summary = {};
for (const ds of ['payload', 'community']) for (const [name, [n, m]] of Object.entries(sizes)) {
  const gg = ds === 'payload' ? payloadGraph(raw, n, name === 'full' ? raw.edges.length : m) : communityGraph(n, m, 7);
  const mk = labelFactory(42 + n);
  const deg = new Int32Array(n); for (const [a, b] of gg.edges) { deg[a]++; deg[b]++; }
  const r = rng(99);
  const iters = name === 'full' ? 1000 : 500;
  const L = layout(gg, iters);
  const nodes = []; for (let i = 0; i < n; i++) { const c = gg.comm ? gg.comm[i] % PAL.length : KINDS.indexOf(gg.kind[i]); nodes.push([mk(gg.kind[i]), L.xy[i][0], L.xy[i][1], +(2 + Math.min(10, Math.sqrt(deg[i]) * 0.9)).toFixed(2), PAL[c]]); }
  const edges = gg.edges.map(([a, b]) => [a, b, r() < 0.08 ? 1 : 0]); // 8% superseded
  const out = JSON.stringify({ ds, size: name, nodes, edges });
  writeFileSync(`${OUT}${ds}-${name}.json`, out);
  const syl = new Set(); let maxS = 0, minS = 99; const hist = {}; for (const x of nodes) { const s = [...x[0]].filter((c) => c !== ' '); s.forEach((c) => syl.add(c)); maxS = Math.max(maxS, s.length); minS = Math.min(minS, s.length); const b = s.length <= 5 ? '2-5' : s.length <= 10 ? '6-10' : s.length <= 15 ? '11-15' : '16-20'; hist[b] = (hist[b] || 0) + 1; }
  const maxDeg = Math.max(...deg);
  summary[`${ds}-${name}`] = { n, m: edges.length, distinctSyllables: syl.size, minS, maxS, hist, maxDeg, jsonBytes: out.length, gzBytes: gzipSync(out).length, layoutMs: L.layoutMs, checkpoints: L.checkpoints, louvain: L.louvain, barnesHut: L.settings.barnesHutOptimize, sl: L.settings.scalingRatio, grav: L.settings.gravity };
  console.log(ds, name, JSON.stringify(summary[`${ds}-${name}`]));
}
writeFileSync(new URL('../out/data-summary.json', import.meta.url).pathname, JSON.stringify(summary, null, 1));
