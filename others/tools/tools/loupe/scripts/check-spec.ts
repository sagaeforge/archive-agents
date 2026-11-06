// Spec checks the generated types cannot do (design 4 and 8), against the contract the KB publishes:
//  1. every operation is a GET,
//  2. openapi.yaml and the table in section 4 of the prose contract list the same paths, operation ids and time parameter (T),
//  3. no operation has only one time axis, and the operations without axes are exactly the section 2.9 exclusion set,
//  4. src/time/timeAxes.ts says the same operation by operation,
//  5. the stamp in src/client matches the live files (the contract:guard rule).
import { readFileSync } from 'node:fs';
import { doc, operations } from '../dev/kb-mock/spec.ts';
import { TIME_AXIS_OPERATIONS } from '../src/time/timeAxes.ts';
import { prosePath, openapiPath } from './lib/contract-paths.mjs';
import { checkStamp } from './lib/stamp-check.mjs';
import { CONTRACT_STAMP } from '../src/client/stamp.ts';

const problems: string[] = [];
const ops = operations();
const byPath = new Map(ops.map((o) => [o.path, o]));
const hasAxes = (o: (typeof ops)[number]) => o.params.some((p) => p.name === 'as_of_valid') && o.params.some((p) => p.name === 'as_of_observed');

for (const o of ops) if (o.method !== 'get') problems.push(`non-GET operation: ${o.method} ${o.path}`);
for (const o of ops.filter((x) => x.params.some((p) => p.name === 'as_of_valid') !== x.params.some((p) => p.name === 'as_of_observed'))) problems.push(`only one time axis on ${o.path}`);

// The prose table (section 4): | `/v1/...` | `operationId` | data | page | parameters |
const prose = readFileSync(prosePath, 'utf8');
const rows = [...prose.matchAll(/^\| `(\/v1\/[^`]+)` \| `(\w+)` \|(.*)$/gm)].map((m) => {
  const cols = m[3]!.split('|').map((c) => c.trim());
  const params = cols[cols.length - 2] ?? '';
  return { path: m[1]!, operationId: m[2]!, takesTime: /(^|,\s*)T(,|$)/.test(params) };
});
if (rows.length === 0) problems.push('the section 4 table was not found in the prose contract');
for (const r of rows) {
  const o = byPath.get(r.path);
  if (!o) { problems.push(`prose path missing from openapi.yaml: ${r.path}`); continue; }
  if (o.operationId !== r.operationId) problems.push(`operationId differs on ${r.path}: prose ${r.operationId}, openapi ${o.operationId}`);
  if (hasAxes(o) !== r.takesTime) problems.push(`time parameter differs on ${r.path}: prose says T=${r.takesTime}, openapi says ${hasAxes(o)}`);
}
for (const o of ops) if (!rows.some((r) => r.path === o.path)) problems.push(`openapi path not in the prose table: ${o.path}`);

// Section 2.9 "적용하지 않는 곳" (0.3.0): these must answer 400 as_of_unsupported, so they cannot take the axes.
const EXCLUDED = new Set([
  '/v1/nodes/{id}/history', '/v1/changes', '/v1/snapshots/{id}', '/v1/snapshots/{id}/text', '/v1/snapshots/{id}/raw', '/v1/meta', '/v1/schema',
  '/v1/export/graph/manifest', '/v1/export/graph', '/v1/ops/freshness', '/v1/ops/tickets', '/v1/ops/runs', '/v1/ops/metrics',
]);
const withoutAxes = ops.filter((o) => !hasAxes(o));
for (const o of ops.filter((x) => EXCLUDED.has(x.path) && hasAxes(x))) problems.push(`excluded by section 2.9 but takes the axes: ${o.path}`);
for (const o of withoutAxes) if (!EXCLUDED.has(o.path)) problems.push(`no time axes on ${o.path} but it is not in the section 2.9 exclusion set`);

// The client-side table must match the spec operation by operation.
for (const o of ops) {
  const t = (TIME_AXIS_OPERATIONS as Record<string, boolean>)[o.operationId];
  if (t === undefined) problems.push(`timeAxes.ts has no entry for ${o.operationId}`);
  else if (t !== hasAxes(o)) problems.push(`timeAxes.ts says ${o.operationId}=${t} but the spec says ${hasAxes(o)}`);
}
for (const k of Object.keys(TIME_AXIS_OPERATIONS)) if (!ops.some((o) => o.operationId === k)) problems.push(`timeAxes.ts has ${k}, which is not in the spec`);

// Marks the KB puts on the spec are annotations only; count them so a diff in review shows a change.
const marks = { provisional: 0 };
const walk = (n: unknown) => {
  if (Array.isArray(n)) return n.forEach(walk);
  if (!n || typeof n !== 'object') return;
  for (const [k, v] of Object.entries(n)) { if (k === 'x-provisional') marks.provisional++; walk(v); }
};
walk(doc);

const drift = checkStamp(CONTRACT_STAMP, { openapi: openapiPath, prose: prosePath });
for (const d of drift) problems.push(`stamp: ${d}`);

console.log(JSON.stringify({
  contract: doc.info?.version, operations: ops.length, with_axes: ops.length - withoutAxes.length, without_axes: withoutAxes.map((o) => o.operationId).sort(),
  prose_rows: rows.length, marks, problems,
}, null, 1));
process.exit(problems.length ? 1 : 0);
