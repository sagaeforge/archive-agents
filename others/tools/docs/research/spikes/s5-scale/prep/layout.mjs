// Node FA2 precompute + render-file builder. usage: node prep/layout.mjs <name> [runs] [iters]   (name: 20k | 50k | sub10k)
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module'; import os from 'node:os';
import { TYPES, PAL, typedCommunityGraph } from './gen-s5.mjs';
const require = createRequire(import.meta.url);
const Graph = require('graphology'); const fa2 = require('graphology-layout-forceatlas2'); const louvain = require('graphology-communities-louvain');
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const name = process.argv[2], runs = +(process.argv[3] || 3), iters = +(process.argv[4] || 300);
let gg, labels;
if (name === 'sub10k') { // induced subgraph of the 50k graph that a type filter leaves
  const G = JSON.parse(readFileSync('public/data/g-50k.json')); const L = JSON.parse(readFileSync('public/data/meta-50k.json')).labels;
  const KEEP = new Set(process.env.KEEP ? process.env.KEEP.split(',') : ['Feature', 'Event']); const keepIdx = new Set(TYPES.map((t, i) => (KEEP.has(t[0]) ? i : -1)).filter((i) => i >= 0));
  const map = new Map(); G.type.forEach((t, i) => { if (keepIdx.has(t)) map.set(i, map.size); });
  const edges = G.edges.filter(([a, b]) => map.has(a) && map.has(b)).map(([a, b]) => [map.get(a), map.get(b)]);
  const ids = [...map.keys()]; gg = { n: ids.length, edges, type: ids.map((i) => G.type[i]), comm: ids.map((i) => G.comm[i]) }; labels = ids.map((i) => L[i]);
  console.log('sub10k keep', [...KEEP].join('+'), 'nodes', gg.n, 'edges', edges.length);
} else { gg = JSON.parse(readFileSync(`public/data/g-${name}.json`)); labels = JSON.parse(readFileSync(`public/data/meta-${name}.json`)).labels; }
const build = () => { const g = new Graph({ type: 'undirected', multi: false }); const r = rng(11); for (let i = 0; i < gg.n; i++) g.addNode(i, { x: r() * 1000, y: r() * 1000 }); for (const [a, b] of gg.edges) { if (!g.hasEdge(a, b)) g.addEdge(a, b); } return g; };
const metric = (g) => { let minx = 1e12, maxx = -1e12, miny = 1e12, maxy = -1e12; g.forEachNode((_, a) => { minx = Math.min(minx, a.x); maxx = Math.max(maxx, a.x); miny = Math.min(miny, a.y); maxy = Math.max(maxy, a.y); }); const diag = Math.hypot(maxx - minx, maxy - miny); let s = 0; g.forEachEdge((_, __, a, b, A, B) => { s += Math.hypot(A.x - B.x, A.y - B.y); }); return s / g.size / diag; };
const res = []; let g;
for (let k = 0; k < runs; k++) {
  g = build(); const settings = { ...fa2.inferSettings(g), barnesHutOptimize: g.order > 2000, barnesHutTheta: 0.6, adjustSizes: false };
  const la0 = os.loadavg()[0]; const t0 = performance.now(); fa2.assign(g, { iterations: iters, settings }); const ms = performance.now() - t0;
  res.push({ ms: Math.round(ms), ratio: +metric(g).toFixed(4), load1: +la0.toFixed(2), load1After: +os.loadavg()[0].toFixed(2), settings: { scalingRatio: settings.scalingRatio, gravity: settings.gravity, slowDown: settings.slowDown } });
  console.log(name, 'run', k, JSON.stringify(res[k]));
}
const t = performance.now(); const lv = louvain.detailed(g, { randomWalk: false, rng: rng(5) }); const lvMs = Math.round(performance.now() - t);
const deg = new Int32Array(gg.n); g.forEachEdge((_, __, a, b) => { deg[+a]++; deg[+b]++; });
const r = rng(99); const nodes = []; for (let i = 0; i < gg.n; i++) { const a = g.getNodeAttributes(i); nodes.push([labels[i], +a.x.toFixed(2), +a.y.toFixed(2), +(2 + Math.min(10, Math.sqrt(deg[i]) * 0.9)).toFixed(2), PAL[gg.type[i]]]); }
const edges = []; g.forEachEdge((_, __, a, b) => edges.push([+a, +b, r() < 0.08 ? 1 : 0]));
writeFileSync(`public/data/s5-${name}.json`, JSON.stringify({ ds: 's5', size: name, nodes, edges }));
const summary = { name, n: gg.n, m: g.size, iters, runs: res, bestMs: Math.min(...res.map((x) => x.ms)), medianMs: res.map((x) => x.ms).sort((a, b) => a - b)[Math.floor(res.length / 2)], louvain: { ms: lvMs, communities: lv.count, modularity: +lv.modularity.toFixed(3) }, node: process.version, cpus: os.cpus().length };
writeFileSync(`out/layout-${name}.json`, JSON.stringify(summary, null, 1)); console.log(JSON.stringify(summary));
