// Step 1 of the contract flow: fixtures against the spec (ajv 8.20.0), plus the coverage and code point checks.
// Three fixtures: kb.json (Phase 0 sample), kb-research.json (Phase 1, built from docs/research) and kb-hostile.json (rendering tests).
// KB_FIXTURES=<file> checks one file with the checks that fit its name.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { schema, fixturePath } from '../dev/kb-mock/spec.ts';
import { checkHostile, checkIntegrity, checkQuotes, checkResearch, newReport } from './lib/fixture-checks.ts';

const dirOf = new URL('../contract-sample/fixtures/', import.meta.url).pathname;
const docsDir = process.env.RESEARCH_DIR ?? new URL('../../../docs/research/', import.meta.url).pathname;
const files = process.env.KB_FIXTURES ? [fixturePath] : ['kb.json', 'kb-research.json', 'kb-hostile.json'].map((n) => dirOf + n);
let bad = 0, n = 0;
const summary: Record<string, unknown> = {};
const allMissing: string[] = [];

function schemaChecks(label: string, f: any): void {
  const sets: [string, string, unknown[]][] = [
    ['nodes', 'Node', f.nodes], ['claims', 'Claim', f.claims], ['edges', 'Edge', f.edges], // citing_claims is derived from the claims by the server (kb-mock adds it), so a stored row gets an empty one for the check.
    ['snapshots', 'Snapshot', f.snapshots.map((r: object) => ({ citing_claims: [], ...r }))],
    ['series', 'Series', f.series], ['changes', 'Change', f.changes], ['schema', 'SchemaCatalog', [f.schema]], ['meta.data', 'Meta', [{ ...f.meta.data, changes_cursor: 'x', counts: { nodes: 1, edges: 1, claims: 1 } }]],
  ];
  for (const [what, name, rows] of sets) {
    const v = schema(name);
    rows.forEach((r, i) => { n++; if (!v(r)) { bad++; console.error(`[${label}] ${what}[${i}] ${v.errors?.[0]?.instancePath} ${v.errors?.[0]?.message}`); } });
  }
  // A version row is identified by (id, version).
  const seen = new Set<string>();
  for (const r of [...f.nodes, ...f.claims, ...f.edges]) { const k = `${r.id}#${r.version}`; if (seen.has(k)) { bad++; console.error(`[${label}] duplicate row`, k); } seen.add(k); }
}

for (const path of files) {
  const label = basename(path);
  const f: any = JSON.parse(readFileSync(path, 'utf8'));
  schemaChecks(label, f);
  if (label === 'kb-research.json' || label === 'kb-hostile.json') {
    const r = newReport(label);
    checkQuotes(f, r);
    checkIntegrity(f, r);
    const cov = label === 'kb-research.json' ? checkResearch(f, r, { docsDir }) : checkHostile(f, r);
    bad += r.bad;
    for (const [k, v] of Object.entries(cov)) if (!v) allMissing.push(`${label}:${k}`);
    summary[label] = { ...r.counts, cases_covered: Object.values(cov).filter(Boolean).length, cases: Object.keys(cov).length, notes: r.notes };
    continue;
  }
  const sampleMissing = validateSample(f);
  allMissing.push(...sampleMissing);
  summary[label] = { phase0_cases: 'see coverage_missing' };
}

function validateSample(f: any): string[] {
  // Quote offsets are code points on the display body (C 2.11). prefix and suffix must agree with them.
  const body = (id: string): string[] => [...(f.bodies[id]?.text ?? '')];
  for (const c of f.claims) for (const ev of c.evidence ?? []) {
    if (ev.selector_kind !== 'text_quote' || ev.start == null) continue;
    const cp = body(ev.snapshot_id);
    if (cp.slice(ev.start, ev.end).join('') !== ev.exact) { bad++; console.error('quote offset mismatch', c.id, ev.id); }
    if (ev.prefix && cp.slice(Math.max(0, ev.start - [...ev.prefix].length), ev.start).join('') !== ev.prefix) { bad++; console.error('prefix mismatch', c.id, ev.id); }
    if (ev.suffix && cp.slice(ev.end, ev.end + [...ev.suffix].length).join('') !== ev.suffix) { bad++; console.error('suffix mismatch', c.id, ev.id); }
  }
  for (const s of f.snapshots) if ([...f.bodies[s.id].text].length !== s.text_chars) { bad++; console.error('text_chars mismatch', s.id); }

  const astral = (id: string) => [...(f.bodies[id]?.text ?? '')].some((ch) => (ch.codePointAt(0) as number) > 0xffff);
  const claimIds = new Set(f.claims.map((c: any) => c.id));
  const cover = {
    supersession: f.edges.some((e: any) => e.rtype === 'SUPERSEDES'),
    retroactive_correction: f.claims.some((c: any) => c.valid?.from && c.valid.from < c.recorded_at.slice(0, 10) && f.claims.some((d: any) => d.id !== c.id && d.valid?.from === c.valid.from && d.predicate === c.predicate)),
    dead: f.nodes.some((x: any) => x.status === 'dead'),
    merged: f.nodes.some((x: any) => x.merged_into),
    hangul_body: Object.values<any>(f.bodies).some((b) => /[가-힣]/.test(b.text)),
    astral_before_quote: f.claims.some((c: any) => (c.evidence ?? []).some((e: any) => e.start != null && [...f.bodies[e.snapshot_id].text].slice(0, e.start).some((ch: string) => (ch.codePointAt(0) as number) > 0xffff))) && astral('n-3fa9c01b77aa12ef'),
    jsonpointer_evidence: f.claims.some((c: any) => (c.evidence ?? []).some((e: any) => e.selector_kind === 'jsonpointer')),
    predicate_null_claim: f.claims.some((c: any) => c.predicate === null),
    parallel_edges: f.edges.some((a: any) => f.edges.some((b: any) => a.id < b.id && a.src === b.src && a.dst === b.dst)),
    bidirectional_edges: f.edges.some((a: any) => f.edges.some((b: any) => a.src === b.dst && a.dst === b.src)),
    no_slash_in_ids: [...f.nodes, ...f.claims, ...f.edges].every((x: any) => !/[\/?#\s]/.test(x.id)),
    slug_history_and_neighbors: f.nodes.some((x: any) => x.id.endsWith(':history')) && f.nodes.some((x: any) => x.id.endsWith(':neighbors')),
    merged_into_final: f.nodes.some((x: any) => x.merged_into && x.merged_into_final),
    future_effective_both_active: f.claims.filter((c: any) => c.status === 'active' && c.expired_at == null && c.predicate === 'ypp_hours').length === 2,
    removed_snapshot: f.removed_snapshots.length > 0,
    image_only_pdf_snapshot: f.snapshots.some((x: any) => x.text_chars === 0),
    visibility_revoked_feed_item: f.changes.some((c: any) => c.kind === 'visibility.revoked'),
    system_origin_feed_item: f.changes.some((c: any) => c.origin === 'system'),
    captured_html_snapshot: Object.values<any>(f.bodies).some((b) => /^text\/html/.test(b.raw_content_type)),
    hidden_sensitivity: f.nodes.some((x: any) => x.sensitivity === 'private'),
    unverified_claim: f.claims.some((c: any) => c.verification === 'unverified'),
    first_party_with_body: f.nodes.some((x: any) => x.origin === 'first_party' && f.record_bodies[x.id]),
    attributed_stance: f.claims.some((c: any) => c.stance === 'attributed'),
    claim_ids_unique_kinds: f.edges.filter((e: any) => e.rtype === 'SUPERSEDES').every((e: any) => claimIds.has(e.src) && claimIds.has(e.dst)),
  };
  // The Phase 1 cases (quote not found, quote across a /text window, truncated:true by default, 50 / 200 / 20 from docs/research)
  // are checked on kb-research.json by scripts/lib/fixture-checks.ts. A merge cycle is not a valid state and is rejected there.
  const missing = Object.entries(cover).filter(([, v]) => !v).map(([k]) => k);
  return missing;
}

console.log(JSON.stringify({ checked: n, bad, coverage_missing: allMissing, fixtures: summary }));
process.exit(bad || allMissing.length ? 1 : 0);
