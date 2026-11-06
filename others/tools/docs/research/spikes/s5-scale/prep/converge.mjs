// Ratio versus iterations in Node, one run per scale (not timing evidence). usage: node prep/converge.mjs 20k 50k
import { readFileSync, writeFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url); const Graph = require('graphology'); const fa2 = require('graphology-layout-forceatlas2');
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const out = {};
for (const name of process.argv.slice(2)) {
  const gg = JSON.parse(readFileSync(`public/data/g-${name}.json`)); const g = new Graph({ type: 'undirected', multi: false }); const r = rng(11);
  for (let i = 0; i < gg.n; i++) g.addNode(i, { x: r() * 1000, y: r() * 1000 }); for (const [a, b] of gg.edges) if (!g.hasEdge(a, b)) g.addEdge(a, b);
  const settings = { ...fa2.inferSettings(g), barnesHutOptimize: true, barnesHutTheta: 0.6, adjustSizes: false };
  const metric = () => { let minx = 1e12, maxx = -1e12, miny = 1e12, maxy = -1e12; g.forEachNode((_, a) => { minx = Math.min(minx, a.x); maxx = Math.max(maxx, a.x); miny = Math.min(miny, a.y); maxy = Math.max(maxy, a.y); }); const diag = Math.hypot(maxx - minx, maxy - miny); let s = 0; g.forEachEdge((_, __, a, b, A, B) => { s += Math.hypot(A.x - B.x, A.y - B.y); }); return s / g.size / diag; };
  let done = 0; out[name] = []; for (const cp of [50, 100, 200, 300, 500, 800]) { fa2.assign(g, { iterations: cp - done, settings }); done = cp; out[name].push({ iters: cp, ratio: +metric().toFixed(4) }); console.log(name, JSON.stringify(out[name].at(-1))); }
}
writeFileSync('out/converge.json', JSON.stringify(out, null, 1));
