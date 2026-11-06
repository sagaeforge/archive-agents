// Brings a fixture to the shape of contract 0.3.x just before it is written. The builders keep their own scalar `domain`;
// the 0.3.0 changes that are pure shape (domain array, overview_types, limits.concurrent) live here, in one place.
const NON_OVERVIEW_GROUPS = new Set(['evidence']);

/** domain: string -> [string], null or missing -> [] (0.3.0 allows no null). */
export const domainArray = (d) => (Array.isArray(d) ? d : d == null || d === '' ? [] : [d]);

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { openapiPath } from '../../scripts/lib/contract-paths.mjs';

/** The mock says it is the contract version it was built against, marked as sample data. */
const specVersion = () => String(parse(readFileSync(openapiPath, 'utf8')).info.version);

export function shapeFor030(out, sampleVersion = `${specVersion()}-sample`) {
  for (const r of [...out.nodes, ...out.claims]) r.domain = domainArray(r.domain);
  out.meta.schema_version = sampleVersion;
  out.meta.data.kb_version = String(out.meta.data.kb_version).replace(/^\d+\.\d+\.\d+/, sampleVersion.replace(/-sample$/, ''));
  // The contract floor for the concurrent read limit is 12; the default is 16 (0.3.0, change log).
  out.meta.data.limits = { ...out.meta.data.limits, concurrent: 16 };
  // Types the default overview shows: everything except the evidence group (the KB reads this from its type files).
  out.schema.overview_types = out.schema.node_types.filter((t) => !NON_OVERVIEW_GROUPS.has(t.group)).map((t) => t.name);
  return out;
}
