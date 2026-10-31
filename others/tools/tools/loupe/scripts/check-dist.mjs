// Fails the build when the bundle carries a local path. The stamp and any other value baked in at build time must not name the home
// directory or where the KB is checked out: whatever can read /assets can read them (design 9, 10).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? new URL('../dist/', import.meta.url).pathname;
  const hits = findLocalPaths(dir);
  if (hits.length === 0) { console.log(`check-dist ok: no local path in ${dir}`); process.exit(0); }
  console.error(`check-dist FAILED: local paths in the bundle\n${hits.map((h) => `  ${h.file}: ${h.match}`).join('\n')}`);
  process.exit(1);
}
