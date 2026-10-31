import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
const base = readFileSync('gen/oatf/src/gen/schema.d.ts','utf8');
const muts = [
 ['ClaimValue collapses to any', s=>s.replace(/ClaimValue: components\["schemas"\]\["TextValue"\][^;]*;/, 'ClaimValue: any;')],
 ['Discriminated union becomes plain object with string tag', s=>s.replace(/ClaimValue: components\["schemas"\]\["TextValue"\][^;]*;/, 'ClaimValue: { value_type: string; value: unknown; entity_id?: string; items?: unknown[] };')],
 ['merged_into loses null (3.0-style type-array misread)', s=>s.replace('merged_into: string | null;','merged_into: string;')],
 ['merged_into becomes optional', s=>s.replace('merged_into: string | null;','merged_into?: string | null;')],
 ['next_cursor loses null', s=>s.replace('next_cursor: string | null;','next_cursor: string;')],
 ['date-time becomes Date', s=>s.replace('Timestamp: string;','Timestamp: Date;')],
 ['source oneOf-null dropped', s=>s.replace('source: components["schemas"]["SourceRef"] | null;','source: components["schemas"]["SourceRef"];')],
 ['enum null dropped', s=>s.replace('"correction" | "update" | "merge" | null','"correction" | "update" | "merge"')],
 ['const widened to string', s=>s.replace('value_type: "text";','value_type: string;')],
 ['Problem has no extension members', s=>s.replace(/(Problem: \{[\s\S]*?)\[key: string\]: unknown;/, '$1')],
 ['Query params accept anything', s=>s.replace(/as_of_valid\?: components\["parameters"\]\["AsOfValid"\];/,'as_of_valid?: components["parameters"]["AsOfValid"]; [k: string]: unknown;')],
 ['Required query param made optional', s=>s.replace(/(\/v1\/overview[\s\S]*?query: \{[\s\S]*?)type: string;/, '$1type?: string;')],
];
let caught=0;
for (const [name,fn] of muts) {
  const m = fn(base);
  if (m===base) { console.log('NOOP   ', name); continue; }
  writeFileSync('gen/control/src/gen/schema.d.ts', m);
  const r = spawnSync('node',['tests/typetest.mjs','gen/control','gen/oatf/node_modules/typescript/lib/tsc.js','c'],{encoding:'utf8'});
  const fails=[...r.stdout.matchAll(/FAIL (T\d+)/g)].map(x=>x[1]);
  const others=(r.stdout.match(/OTHER/g)||[]).length;
  if (fails.length) caught++;
  console.log(fails.length?'CAUGHT ':'MISSED ', name,'->',fails.join(' '), others?`(other ${others})`:'');
}
console.log(`caught ${caught}/${muts.length}`);
