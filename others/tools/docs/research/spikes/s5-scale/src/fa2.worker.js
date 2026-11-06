// Own FA2 worker: one assign() call, coordinates handed over once at the end (loupe 6.2 design).
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
onmessage = ({ data: { n, edges, iters } }) => {
  const t0 = performance.now(); const g = new Graph({ type: 'undirected', multi: false }); const r = rng(11);
  for (let i = 0; i < n; i++) g.addNode(i, { x: r() * 1000, y: r() * 1000 });
  for (let i = 0; i < edges.length; i += 2) if (!g.hasEdge(edges[i], edges[i + 1])) g.addEdge(edges[i], edges[i + 1]);
  const settings = { ...forceAtlas2.inferSettings(g), barnesHutOptimize: g.order > 2000, barnesHutTheta: 0.6, adjustSizes: false };
  const t1 = performance.now(); forceAtlas2.assign(g, { iterations: iters, settings }); const t2 = performance.now();
  const xy = new Float32Array(n * 2); let minx = 1e12, maxx = -1e12, miny = 1e12, maxy = -1e12;
  g.forEachNode((k, a) => { const i = +k; xy[2 * i] = a.x; xy[2 * i + 1] = a.y; minx = Math.min(minx, a.x); maxx = Math.max(maxx, a.x); miny = Math.min(miny, a.y); maxy = Math.max(maxy, a.y); });
  const diag = Math.hypot(maxx - minx, maxy - miny); let s = 0; g.forEachEdge((_, __, a, b, A, B) => { s += Math.hypot(A.x - B.x, A.y - B.y); });
  postMessage({ xy, buildMs: Math.round(t1 - t0), assignMs: Math.round(t2 - t1), totalMs: Math.round(performance.now() - t0), ratio: +(s / g.size / diag).toFixed(4) }, [xy.buffer]);
};
