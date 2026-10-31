// S5 scale generator. Node 26. Deterministic. Community topology from S3 (communityGraph), typed nodes, contract-shaped payloads.
// usage: node prep/gen-s5.mjs   -> public/data/g-<name>.json (graph), public/payload/<name>-{overview,export,rows}.json, out/payload-sizes.json
import { writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync, zstdCompressSync, constants as Z } from 'node:zlib';
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const dec = new TextDecoder('euc-kr'); const KS = [];
for (let a = 0xB0; a <= 0xC8; a++) for (let b = 0xA1; b <= 0xFE; b++) { const c = dec.decode(new Uint8Array([a, b])); if (/^[가-힣]$/.test(c)) KS.push(c); }
function labelFactory(seed) { // same as S3 gen-data.mjs
  const r = rng(seed); const pool = KS.slice(); for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const W = pool.map((_, i) => 1 / Math.pow(i + 1, 0.75)); const cum = []; let acc = 0; for (const w of W) cum.push(acc += w);
  const pick = () => { const x = r() * acc; let lo = 0, hi = cum.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m + 1; else hi = m; } return pool[lo]; };
  const dict = Array.from({ length: 6000 }, () => { const n = 2 + Math.floor(r() * 3); let w = ''; for (let i = 0; i < n; i++) w += pick(); return w; });
  const range = { Keyword: [2, 5], Topic: [3, 8], Channel: [3, 10], Source: [5, 14], Video: [8, 18], Claim: [10, 20] };
  return (kind) => { const [lo, hi] = range[kind] ?? [2, 20]; const target = lo + Math.floor(r() * (hi - lo + 1)); const words = []; let n = 0;
    while (n < target) { let w = dict[Math.floor(Math.pow(r(), 1.6) * dict.length)]; if (n + w.length > target) w = w.slice(0, target - n); words.push(w); n += w.length; } return words.join(' '); };
}
// world + user types with weights. Label length class borrowed from S3 kinds.
export const TYPES = [['Feature', 'Topic', 0.16], ['Product', 'Source', 0.05], ['Person', 'Channel', 0.08], ['Org', 'Source', 0.06], ['Repo', 'Source', 0.07], ['Concept', 'Topic', 0.14], ['Keyword', 'Keyword', 0.18], ['Channel', 'Channel', 0.05], ['Video', 'Video', 0.12], ['Library', 'Source', 0.05], ['Event', 'Video', 0.04]];
const RTYPES = ['PART_OF', 'USES', 'MENTIONS', 'AUTHORED_BY', 'RELATED_TO', 'SUPERSEDES', 'IMPLEMENTS', 'DEPENDS_ON', 'COVERS', 'PUBLISHED_ON'];
export const PAL = ['#4269d0', '#efb118', '#ff725c', '#6cc5b0', '#3ca951', '#ff8ab7', '#a463f2', '#97bbf5', '#9c6b4e', '#9498a0', '#d6336c'];

export function typedCommunityGraph(n, m, seed) {
  const r = rng(seed); const C = Math.max(8, Math.round(n / 250));
  const sz = Array.from({ length: C }, (_, i) => 1 / Math.pow(i + 1, 0.8)); const tot = sz.reduce((a, b) => a + b, 0);
  const comm = new Int32Array(n); const members = Array.from({ length: C }, () => []);
  let p = 0; for (let c = 0; c < C; c++) { const k = c === C - 1 ? n - p : Math.max(4, Math.round((sz[c] / tot) * n)); for (let i = 0; i < k && p < n; i++, p++) { comm[p] = c; members[c].push(p); } }
  const tw = TYPES.map((t) => t[2]); const tt = tw.reduce((a, b) => a + b, 0);
  const pickT = () => { let x = r() * tt; for (let i = 0; i < tw.length; i++) { x -= tw[i]; if (x <= 0) return i; } return tw.length - 1; };
  const dom = Array.from({ length: C }, pickT); // dominant type per community
  const type = Int8Array.from({ length: n }, (_, i) => (r() < 0.8 ? dom[comm[i]] : pickT()));
  const hub = (arr) => arr[Math.floor(Math.pow(r(), 2.4) * arr.length)];
  const seen = new Set(); const edges = []; let guard = 0;
  while (edges.length < m && guard++ < m * 40) {
    const a = Math.floor(r() * n); const c = r() < 0.85 ? comm[a] : Math.floor(r() * C); const b = hub(members[c]); if (a === b) continue;
    const k = a < b ? a * 100000 + b : b * 100000 + a; if (seen.has(k)) continue; seen.add(k); edges.push(r() < 0.5 ? [a, b] : [b, a]);
  }
  return { n, edges, comm: Array.from(comm), type: Array.from(type), dom };
}
const hex = (r, k) => { let s = ''; for (let i = 0; i < k; i++) s += Math.floor(r() * 16).toString(16); return s; };
export function decorate(gg, seed) { // labels, ids, attributes
  const r = rng(seed); const mk = labelFactory(seed + 1);
  const nodes = gg.type.map((t, i) => ({ id: `e:${TYPES[t][0].toLowerCase()}/${i.toString(36).padStart(5, '0')}-${hex(r, 4)}`, type: TYPES[t][0], label: mk(TYPES[t][1]), origin: r() < 0.9 ? 'external' : 'first_party', status: r() < 0.92 ? 'active' : 'superseded', domain: ['G', 'K', 'T', 'W'][Math.floor(r() * 4)] }));
  const edges = gg.edges.map(([a, b]) => ({ id: `r-${hex(r, 12)}`, src: nodes[a].id, dst: nodes[b].id, rtype: RTYPES[Math.floor(Math.pow(r(), 1.7) * RTYPES.length)] }));
  return { nodes, edges };
}
const col = (cols, items) => ({ columns: cols, rows: items.map((o) => cols.map((c) => o[c])) });
export function shapes(d, n, m) {
  const envelope = { schema_version: '0.1.0', epoch: 1, build_id: 'g-000183422-a1b2', data_as_of: '2026-10-31T09:12:03Z', applied_seq: 183422, as_of: { valid: null, observed: null }, degraded: [], page: { next_cursor: null, total: null, truncated: false } };
  const overview = { ...envelope, data: { meta: { graph: { directed: true, multi: true }, order: 'id_asc', node_total: n, edge_total: m, truncated: false }, nodes: col(['id', 'type', 'label', 'origin', 'status'], d.nodes), edges: col(['id', 'src', 'dst', 'rtype'], d.edges) } };
  const exp = { schema_version: '0.1.0', build_id: 'p-000183422', applied_seq: 183422, epoch: 1, data_as_of: '2026-10-31T09:12:03Z', graph: { directed: true, multi: true }, nodes: col(['id', 'type', 'label', 'origin', 'status', 'domain'], d.nodes), edges: col(['id', 'src', 'dst', 'rtype'], d.edges) };
  const rows = { data: { nodes: d.nodes.map(({ domain, ...x }) => x), edges: d.edges } }; // reference only: object per row, not the contract shape
  return { overview, export: exp, rows };
}
const sizes = {};
if (process.argv[1].endsWith('gen-s5.mjs')) {
  mkdirSync('public/data', { recursive: true }); mkdirSync('public/payload', { recursive: true });
  for (const [name, n, m] of [['20k', 20000, 80000], ['50k', 50000, 200000]]) {
    const t0 = performance.now(); const gg = typedCommunityGraph(n, m, 7); const d = decorate(gg, 100 + n);
    writeFileSync(`public/data/g-${name}.json`, JSON.stringify({ n, edges: gg.edges, comm: gg.comm, type: gg.type }));
    writeFileSync(`public/data/meta-${name}.json`, JSON.stringify({ labels: d.nodes.map((x) => x.label) }));
    const S = shapes(d, n, m); sizes[name] = { n, m: gg.edges.length, genMs: Math.round(performance.now() - t0) };
    for (const [k, obj] of Object.entries(S)) {
      const raw = Buffer.from(JSON.stringify(obj)); writeFileSync(`public/payload/${name}-${k}.json`, raw);
      const best = (f) => { let b = 1e9, o; for (let i = 0; i < 3; i++) { const t = performance.now(); o = f(); b = Math.min(b, performance.now() - t); } return [o, b]; };
      const [gz, gzMs] = best(() => gzipSync(raw)); const [zs, zsMs] = best(() => zstdCompressSync(raw));
      sizes[name][k] = { raw: raw.length, gzip: gz.length, zstd: zs.length, gzipMs: +gzMs.toFixed(0), zstdMs: +zsMs.toFixed(0) };
      writeFileSync(`public/payload/${name}-${k}.json.zst`, zs); writeFileSync(`public/payload/${name}-${k}.json.gz`, gz);
    }
    const tc = {}; gg.type.forEach((t) => (tc[TYPES[t][0]] = (tc[TYPES[t][0]] || 0) + 1)); sizes[name].typeCounts = tc;
    console.log(name, JSON.stringify(sizes[name]));
  }
  writeFileSync('out/payload-sizes.json', JSON.stringify(sizes, null, 1));
}
