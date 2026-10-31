import { readFileSync } from 'node:fs';
import { schema, fixturePath } from './contract.ts';
const f = JSON.parse(readFileSync(fixturePath, 'utf8'));
const sets: [string, string, unknown[]][] = [
  ['entities', 'Entity', f.entities], ['claims', 'Claim', f.claims], ['snapshots', 'Snapshot', f.snapshots],
  ['edges', 'Edge', f.edges], ['catalog', 'Catalog', [f.catalog]], ['meta', 'ResponseMeta', [f.meta]],
];
let bad = 0, n = 0;
for (const [label, name, rows] of sets) {
  const v = schema(name);
  for (const [i, r] of rows.entries()) { n++; if (!v(r)) { bad++; console.error(`${label}[${i}]`, v.errors?.[0]?.instancePath, v.errors?.[0]?.message); } }
}
// Coverage demanded by consumer doc L75.
const has = { supersession: f.claims.some((c: any) => c.superseded_by), retroactive: f.claims.some((c: any) => c.supersede_reason === 'correction'), dead: f.entities.some((e: any) => e.status === 'dead'), merged: f.entities.some((e: any) => e.merged_into), hangul: /[가-힣]/.test(f.snapshots[0]?.body ?? ''), quote: f.claims.some((c: any) => c.source?.quote) };
// Quote offsets are code points on the display body.
for (const c of f.claims) { const q = c.source?.quote; if (!q) continue; const body = f.snapshots.find((s: any) => s.id === c.source.snapshot_id)?.body ?? ''; const cps = [...body]; const got = cps.slice(q.start, q.end).join(''); if (got !== q.exact) { bad++; console.error('quote mismatch', c.id, JSON.stringify(got), JSON.stringify(q.exact)); } }
console.log(JSON.stringify({ checked: n, bad, coverage: has }));
process.exit(bad || Object.values(has).includes(false) ? 1 : 0);
