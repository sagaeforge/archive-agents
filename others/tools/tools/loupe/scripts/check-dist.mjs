// Fails the build when the bundle carries a local path. The stamp and any other value baked in at build time must not name the home
// directory or where the KB is checked out: whatever can read /assets can read them (design 9, 10).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const LOCAL = [/\/home\/[A-Za-z0-9._-]+\//, /\/Users\/[A-Za-z0-9._-]+\//, /[A-Za-z]:\\Users\\/, /\/root\//, /\/mnt\/[a-z]\//];

/** @returns {{file: string, match: string}[]} */
export function findLocalPaths(dir) {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|css|html|json|map|txt|svg)$/i.test(name)) continue;
      const text = readFileSync(p, 'utf8');
      for (const re of LOCAL) { const m = re.exec(text); if (m) hits.push({ file: p, match: m[0] }); }
    }
  };
  walk(dir);
  return hits;
}

// Design 11: sigma + graphology stay within 130 KB gz and load with the graph route only.
export const GRAPH_VENDOR_BUDGET_GZ = 130 * 1024;
// A sigma setting name: it can only be in the entry if sigma or the view got into it.
const SIGMA_MARKER = 'hideEdgesOnMove';

/** @returns {{ok: boolean, gzBytes: number, problems: string[]}} */
export function checkGraphBundle(dir) {
  const assets = join(dir, 'assets');
  const files = readdirSync(assets).filter((f) => f.endsWith('.js'));
  const vendor = files.filter((f) => f.startsWith('graph-vendor-'));
  const problems = [];
  if (vendor.length !== 1) problems.push(`expected one graph-vendor chunk, found ${vendor.length}`);
  const gzBytes = vendor.reduce((sum, f) => sum + gzipSync(readFileSync(join(assets, f))).length, 0);
  if (gzBytes > GRAPH_VENDOR_BUDGET_GZ) problems.push(`graph-vendor is ${gzBytes} bytes gz, over ${GRAPH_VENDOR_BUDGET_GZ}`);
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  if (html.includes('graph-vendor')) problems.push('index.html loads graph-vendor: it must wait for the graph route');
  const entry = /src="\.\/assets\/(index-[^"]+\.js)"/.exec(html)?.[1];
  if (!entry) problems.push('no entry script in index.html');
  else {
    // The only way from the entry to the vendor chunk is a dynamic import: no static import, no sigma source in the entry.
    const text = readFileSync(join(assets, entry), 'utf8');
    if (/from\s*["']\.\/graph-vendor/.test(text) || /import\s*["']\.\/graph-vendor/.test(text)) problems.push('the entry imports graph-vendor statically');
    if (text.includes(SIGMA_MARKER)) problems.push('sigma source is in the entry chunk');
  }
  return { ok: problems.length === 0, gzBytes, problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? new URL('../dist/', import.meta.url).pathname;
  const hits = findLocalPaths(dir);
  const graph = checkGraphBundle(dir);
  if (hits.length === 0 && graph.ok) { console.log(`check-dist ok: no local path in ${dir}, graph-vendor ${(graph.gzBytes / 1024).toFixed(1)} KB gz`); process.exit(0); }
  if (hits.length) console.error(`check-dist FAILED: local paths in the bundle\n${hits.map((h) => `  ${h.file}: ${h.match}`).join('\n')}`);
  if (!graph.ok) console.error(`check-dist FAILED: ${graph.problems.join('; ')}`);
  process.exit(1);
}
