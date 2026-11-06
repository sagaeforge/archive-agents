const path = process.argv[2]; const req = require('node:module').createRequire(path + '/');
const Graph = req('graphology'); const fa2 = req('graphology-layout-forceatlas2'); const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(path + '/../public/data/payload-full.json', 'utf8'));
const rng = (seed) => { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const run = (sched, seed) => { const g = new Graph({ type: 'undirected' }); const r = rng(seed); data.nodes.forEach((_, i) => g.addNode(i, { x: r() * 1000, y: r() * 1000 })); data.edges.forEach(([a, b]) => g.addEdge(a, b));
  const settings = { ...fa2.inferSettings(g), barnesHutOptimize: true, barnesHutTheta: 0.6, adjustSizes: false }; const t0 = performance.now(); let d = 0; for (const c of sched) { fa2.assign(g, { iterations: c - d, settings }); d = c; }
  const ms = performance.now() - t0; let a = 1e12, b = -1e12, c = 1e12, e = -1e12; g.forEachNode((_, p) => { a = Math.min(a, p.x); b = Math.max(b, p.x); c = Math.min(c, p.y); e = Math.max(e, p.y); }); const dg = Math.hypot(b - a, e - c); let s = 0; g.forEachEdge((_, __, ___, ____, p, q) => { s += Math.hypot(p.x - q.x, p.y - q.y); }); return { ms: Math.round(ms), ratio: +(s / g.size / dg).toFixed(4) }; };
for (const seed of [11, 7]) for (const sched of [[50, 100, 200, 300], [100, 200, 300], [300]]) console.log('seed', seed, JSON.stringify(sched), JSON.stringify(run(sched, seed)));
