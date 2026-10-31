// Node 26. Checks two design assumptions on the S3 full dataset: warm start across builds, and local re-layout.
const path = process.argv[2];
const req = require('node:module').createRequire(path + '/');
const Graph = req('graphology'); const fa2 = req('graphology-layout-forceatlas2'); const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(path + '/../public/data/payload-full.json', 'utf8'));
let s = 12345; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
function build(nodes, edges) { const g = new Graph({ type: 'undirected' }); nodes.forEach((n) => g.addNode(n.id, { x: n.x, y: n.y, size: 1 })); edges.forEach(([a, b]) => { if (a !== b && g.hasNode(a) && g.hasNode(b) && !g.hasEdge(a, b)) g.addEdge(a, b); }); return g; }
const diag = (g) => { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; g.forEachNode((_, p) => { a = Math.min(a, p.x); b = Math.max(b, p.x); c = Math.min(c, p.y); d = Math.max(d, p.y); }); return Math.hypot(b - a, d - c); };
const ratio = (g) => { let t = 0; g.forEachEdge((_, __, ___, ____, p, q) => { t += Math.hypot(p.x - q.x, p.y - q.y); }); return t / g.size / diag(g); };
const median = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
const pct = (a, q) => a.sort((x, y) => x - y)[Math.floor(a.length * q)];
const nodes = data.nodes.map(([l, x, y], i) => ({ id: String(i), x, y })); const edges = data.edges.map(([a, b]) => [String(a), String(b)]);
const g0 = build(nodes, edges); console.log('base', g0.order, g0.size, 'ratio', ratio(g0).toFixed(4));
const settings = { ...fa2.inferSettings(g0), barnesHutOptimize: true, barnesHutTheta: 0.6, adjustSizes: false };
for (const frac of [0.02, 0.1]) {
  const k = Math.round(nodes.length * frac);
  const removed = new Set(); while (removed.size < k) removed.add(String(Math.floor(rnd() * nodes.length)));
  const kept = nodes.filter((n) => !removed.has(n.id));
  const newEdges = edges.filter(([a, b]) => !removed.has(a) && !removed.has(b));
  // New nodes reuse a removed node's edges under a fresh id, so degree stays realistic.
  const added = [...removed].map((id) => ({ id: 'n' + id, x: 0, y: 0 }));
  const place = new Map(kept.map((n) => [n.id, n]));
  for (const [a, b] of edges) { if (removed.has(a) && !removed.has(b)) newEdges.push(['n' + a, b]); if (removed.has(b) && !removed.has(a)) newEdges.push([a, 'n' + b]); }
  for (const n of added) { const nb = newEdges.filter(([a, b]) => a === n.id || b === n.id).map(([a, b]) => place.get(a === n.id ? b : a)).filter(Boolean); if (nb.length) { n.x = nb.reduce((t, p) => t + p.x, 0) / nb.length; n.y = nb.reduce((t, p) => t + p.y, 0) / nb.length; } else { n.x = rnd() * 100; n.y = rnd() * 100; } }
  const g1 = build([...kept, ...added], newEdges);
  const before = new Map(); g1.forEachNode((k, p) => before.set(k, [p.x, p.y]));
  const d0 = diag(g1); let done = 0; const out = [`warm ${frac * 100}% changed, ratio0 ${ratio(g1).toFixed(4)}`];
  for (const cp of [25, 50, 100, 300]) {
    const t = performance.now(); fa2.assign(g1, { iterations: cp - done, settings }); const ms = performance.now() - t; done = cp;
    const mv = []; g1.forEachNode((k, p) => { if (k[0] === 'n') return; const [x, y] = before.get(k); mv.push(Math.hypot(p.x - x, p.y - y) / d0); });
    out.push(`it${cp}: +${ms.toFixed(0)}ms ratio ${ratio(g1).toFixed(4)} move p50 ${median(mv.slice()).toFixed(4)} p95 ${pct(mv.slice(), 0.95).toFixed(4)}`);
  }
  console.log(out.join(' | '));
}
// Cold from a hash-seeded start, to compare with warm start movement scale.
{ const seeded = nodes.map((n) => ({ id: n.id, x: rnd() * 1000, y: rnd() * 1000 })); const g2 = build(seeded, edges); let done = 0; const out = ['cold']; for (const cp of [100, 200, 300]) { const t = performance.now(); fa2.assign(g2, { iterations: cp - done, settings }); const ms = performance.now() - t; done = cp; out.push(`it${cp}: +${ms.toFixed(0)}ms ratio ${ratio(g2).toFixed(4)}`); } console.log(out.join(' | ')); }
// Local re-layout: 200 new nodes around one anchor, everything else pinned, only the local subgraph iterates.
{ const anchor = String(g0.nodes().sort((a, b) => g0.degree(b) - g0.degree(a))[50]); const nb = g0.neighbors(anchor); const a = g0.getNodeAttributes(anchor);
  const sub = new Graph({ type: 'undirected' }); sub.addNode(anchor, { x: a.x, y: a.y, size: 1, fixed: true }); for (const k of nb) { const p = g0.getNodeAttributes(k); sub.addNode(k, { x: p.x, y: p.y, size: 1, fixed: true }); sub.addEdge(anchor, k); }
  for (let i = 0; i < 200; i++) { const id = 'x' + i; sub.addNode(id, { x: a.x + (rnd() - 0.5) * 2, y: a.y + (rnd() - 0.5) * 2, size: 1 }); sub.addEdge(anchor, id); }
  const st = { ...fa2.inferSettings(sub), barnesHutOptimize: false }; const t = performance.now(); fa2.assign(sub, { iterations: 100, settings: st }); console.log('local', sub.order, sub.size, 'degree', nb.length, (performance.now() - t).toFixed(1) + 'ms for 100 iterations'); }
