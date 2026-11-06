// Builds kb-research.json: the Phase 1 fixture (design section 12). Run: node contract-sample/fixtures/research/build.mjs
// Input: docs/research of this repository (RESEARCH_DIR overrides the default relative location). Output: ../kb-research.json,
// the same shape as kb.json, so `KB_FIXTURES=<path> npm run mock` serves it. The generator exists so that quote offsets are computed
// in code points instead of typed by hand, and so that the snapshot bodies are the real documents. It never invents document text.
import { readFileSync, writeFileSync } from 'node:fs';
import { shapeFor030 } from '../shape.mjs';
import { sha256, sha1, cps, nfc, V, quoteAt, occurrences, jsonPointer, ts, addSeconds } from './lib.mjs';
import { ENTITIES } from './entities.mjs';
import { REPORT_CLAIMS } from './claims-reports.mjs';
import { VERIFY_CLAIMS } from './claims-verify.mjs';
import { SPIKE_CLAIMS, SPIKE_DOC_CLAIMS, autoSpikeClaims } from './claims-spikes.mjs';
import { EDGES, NOTES } from './edges-notes.mjs';

const docsDir = process.env.RESEARCH_DIR ?? new URL('../../../../../docs/research/', import.meta.url).pathname;
const OUT = process.env.OUT ?? new URL('../kb-research.json', import.meta.url).pathname;
const DATA_AS_OF = '2026-10-31T23:00:00Z';
const LAN = [/192\.168\.\d+\.\d+/g, '<LAN-IP>']; // CLAUDE.md of the task: drop any LAN address

// ---- sources and snapshots. `at` is when the document reached the KB. The documents are all dated 2026-10-31 and carry no
// fetch time, so the times are assigned here in dependency order (reports, then the verifications of them, then the spike log).
const SRC = {
  research: { id: 'src:sagae-research', label: 'sagae-tools 조사 보고서', trust: 'secondary' },
  verification: { id: 'src:sagae-verification', label: 'sagae-tools 적대적 검증 보고서', trust: 'secondary' },
  spikes: { id: 'src:sagae-spikes', label: 'sagae-tools 스파이크 기록', trust: 'primary' },
  upstream: { id: 'src:upstream-docs', label: '업스트림 문서 사본', trust: 'primary' },
};
const SNAPS = {
  KC: ['understand-kb-contract.md', '2026-10-31T09:10:00Z', 'research'],
  TT: ['understand-token-tooling.md', '2026-10-31T09:32:00Z', 'research'],
  OV: ['oss-viewers.md', '2026-10-31T10:05:00Z', 'research'],
  UB: ['ui-blocks.md', '2026-10-31T10:41:00Z', 'research'],
  TR: ['trends.md', '2026-10-31T11:12:00Z', 'research'],
  HG: ['http-gateway.md', '2026-10-31T11:48:00Z', 'research'],
  MG: ['mcp-gateways.md', '2026-10-31T12:22:00Z', 'research'],
  MS: ['mcp-servers.md', '2026-10-31T12:57:00Z', 'research'],
  VV: ['verify-viewer.md', '2026-10-31T15:31:00Z', 'verification'],
  VG: ['verify-gateway.md', '2026-10-31T16:12:00Z', 'verification'],
  SP_PROXY: ['spikes/s1-aggregation/c3-mcpuse/proxy.md', '2026-10-31T14:05:00Z', 'upstream'],
  SP_HONO: ['spikes/s1-aggregation/logs/sdk-hono.md', '2026-10-31T14:15:00Z', 'upstream'],
  SP_TOOLS: ['spikes/s1-aggregation/logs/sdk-tools.md', '2026-10-31T14:30:00Z', 'upstream'],
  SP_AGW: ['spikes/s1-aggregation/c1-agentgateway/README-mcp-v1.7.0.md', '2026-10-31T14:40:00Z', 'upstream'],
  SP_1MCP: ['spikes/s1-aggregation/c4-1mcp/README-v0.39.7.md', '2026-10-31T14:55:00Z', 'upstream'],
  JP_SUMMARY: ['spikes/s3-graph/out/data-summary.json', '2026-10-31T17:27:09Z', 'spikes'],
  JP_BENCH: ['spikes/s1-aggregation/results/bench.json', '2026-10-31T18:05:41Z', 'spikes'],
  JP_ORCA: ['spikes/s3-graph/out/summary-orca.json', '2026-10-31T18:36:20Z', 'spikes'],
  JP_FASTMCP: ['spikes/s1-aggregation/results/c2-fastmcp.json', '2026-10-31T17:50:00Z', 'spikes'],
  SR: ['spike-results.md', '2026-10-31T22:43:27Z', 'spikes'],
};

const snaps = {}; // key -> {id, ...snapshot row fields, text, raw}
const provenance = {};
for (const [key, [path, at, src]] of Object.entries(SNAPS)) {
  let raw = readFileSync(new URL(path, 'file://' + docsDir), 'utf8');
  const redactions = [];
  const hits = raw.match(LAN[0])?.length ?? 0;
  if (hits) { raw = raw.replace(LAN[0], LAN[1]); redactions.push({ pattern: 'LAN IPv4 address', replacement: LAN[1], count: hits }); }
  const isJson = path.endsWith('.json');
  const text = isJson ? nfc(JSON.stringify(JSON.parse(raw), null, 2)) : nfc(raw);
  const id = 'n-' + sha1('snap:' + path, 16);
  snaps[key] = {
    id, key, path, at, text, raw,
    row: {
      id, url: `repo://sagae-tools/docs/research/${path}`, final_url: `repo://sagae-tools/docs/research/${path}`, source: SRC[src],
      fetched_at: at, http_status: 200, content_type: isJson ? 'application/json' : 'text/markdown; charset=utf-8',
      raw_sha256: sha256(raw), text_sha256: sha256(text), text_format: isJson ? 'json' : 'markdown', text_chars: cps(text).length,
      extractor: isJson ? 'json-normalize@1' : 'passthrough-nfc@1',
    },
  };
  provenance[id] = { path: `docs/research/${path}`, redactions, nfc_changed: !isJson && nfc(raw) !== raw };
}

// ---- entity rows
const entById = new Map(ENTITIES.map((e) => [e.id, e]));
const base = (o) => ({
  origin: 'external', status: 'active', liveness: 'active', verification: null, sensitivity: 'public', domain: null, version: 1,
  merged_into: null, merged_into_final: null, valid: V(), recorded_at: '2026-10-31T08:00:00Z', expired_at: null, author: null, props: {}, ...o,
});

// ---- claims, pass 1: resolve text, evidence and times
const all = [...REPORT_CLAIMS, ...VERIFY_CLAIMS, ...SPIKE_CLAIMS, ...autoSpikeClaims(snaps.SR.text), ...SPIKE_DOC_CLAIMS];
const warnings = [];
const perSnapCount = {};
const defs = all.map((d) => {
  const s = snaps[d.snap];
  if (!s) throw new Error(`unknown snapshot ${d.snap}`);
  const n = (perSnapCount[d.snap] = (perSnapCount[d.snap] ?? 0) + 1);
  const subj = entById.get(d.s);
  if (!subj) throw new Error(`unknown subject ${d.s}`);
  const id = d.id ?? 'c-' + sha1([d.s, d.p, d.q ?? d.miss ?? d.jp, d.v, d.snap].join('|'));
  let evidence = [], verification = d.ver ?? 'quote_found', value = d.v ?? null;
  if (d.jp) {
    const doc = JSON.parse(s.text);
    const got = jsonPointer(doc, d.jp);
    if (got === undefined) throw new Error(`json pointer ${d.jp} not in ${d.snap}`);
    value = String(got);
    evidence = [{ selector_kind: 'jsonpointer', exact: null, prefix: null, suffix: null, start: null, end: null, json_pointer: d.jp }];
    verification = d.ver ?? 'parser_derived';
  } else if (d.miss) {
    // The quote an extractor produced that cannot be found in the display body: offsets stay null.
    if (s.text.includes(d.miss)) throw new Error(`miss quote is present: ${d.miss}`);
    evidence = [{ selector_kind: 'text_quote', exact: d.miss, prefix: null, suffix: null, start: null, end: null, json_pointer: null, support_check: 'unsupported' }];
    verification = d.ver ?? 'needs_review';
  } else if (d.q) {
    if (occurrences(s.text, d.q) > 1) warnings.push(`ambiguous quote (${occurrences(s.text, d.q)}x) ${d.snap}: ${d.q.slice(0, 60)}`);
    evidence = [{ selector_kind: 'text_quote', ...quoteAt(s.text, d.q), json_pointer: null }];
  } else verification = d.ver ?? 'unverified';
  return { ...d, id, subj, evidence, verification, value, recorded_at: addSeconds(s.at, 5 * n) };
});
const byKey = new Map(defs.filter((d) => d.key).map((d) => [d.key, d]));
for (const d of defs) if (d.sup && !byKey.has(d.sup)) throw new Error(`sup ${d.sup} not found`);

// ---- claims, pass 2: rows
const FUNCTIONAL_QUALIFIER_FREE = true; // chains are keyed by subject + predicate + qualifiers
const claimRows = [];
const supersedes = [];
const evId = (d, i) => 'ev-' + sha1(d.id + ':' + i, 8);
for (const d of defs) {
  const sens = d.sens ?? d.subj.sens ?? 'public';
  const method = d.jp || d.auto ? 'deterministic' : d.s === 'e:tool:rtk' && d.stance === 'attributed' && d.speaker === 'user:sagae' ? 'human' : 'llm';
  const row = (over) => base({
    id: d.id, type: 'Claim', label: d.t, subject: d.s, predicate: d.p ?? null, object: null, value: d.value, unit: d.u ?? null, qualifiers: d.qual ?? {},
    statement: d.t, kind: d.k, stance: d.stance ?? 'stated', speaker: d.speaker ?? null, method, conflict_group: d.cg ?? null,
    verification: d.verification, sensitivity: sens, domain: d.subj.domain, valid: V(d.from ?? null, d.to ?? null),
    recorded_at: d.recorded_at, version: 1,
    evidence: d.evidence.map((e, i) => ({ id: evId(d, i), snapshot_id: snaps[d.snap].id, evidence_state: 'live', support_check: null, last_confirmed_at: d.recorded_at, ...e })),
    ...over,
  });
  if (d.sup) {
    const by = byKey.get(d.sup);
    // retroactive correction: v1 is what was believed until `by` was recorded, v2 is the same claim after it was overturned
    claimRows.push(row({ expired_at: by.recorded_at }));
    claimRows.push(row({ version: 2, status: 'superseded', recorded_at: by.recorded_at }));
    supersedes.push({ src: by.id, dst: d.id, at: by.recorded_at });
  } else claimRows.push(row({}));
}
const claimById = new Map(claimRows.map((r) => [r.id + '#' + r.version, r]));

// ---- node rows (entities)
const firstClaimAt = {};
for (const d of defs) firstClaimAt[d.s] = !firstClaimAt[d.s] || ts(d.recorded_at) < ts(firstClaimAt[d.s]) ? d.recorded_at : firstClaimAt[d.s];
const nodeRows = [];
for (const e of ENTITIES) {
  const rec = addSeconds(firstClaimAt[e.id] ?? '2026-10-31T08:00:00Z', -60);
  const sens = e.sens ?? 'public';
  const raised = e.id === 'e:concept:gateway-token-storage' ? '2026-10-31T17:50:00Z' : null;
  const mk = (over) => base({
    id: e.id, type: e.type, label: e.label, domain: e.domain, props: e.props, sensitivity: sens, recorded_at: rec,
    ...(e.liveness ? { liveness: e.liveness } : {}), ...(e.valid ? { valid: V(e.valid[0], e.valid[1]) } : {}), ...over,
  });
  if (e.v2) {
    const { valid, ...patch } = e.v2.patch;
    nodeRows.push(mk({ expired_at: e.v2.at }));
    nodeRows.push(mk({ version: 2, recorded_at: e.v2.at, ...patch, ...(valid ? { valid: V(valid[0], valid[1]) } : {}) }));
  } else if (raised) {
    // sensitivity raised after the fact: the old version is hidden with the id (C 2.7), the feed carries visibility.revoked
    nodeRows.push(mk({ sensitivity: 'internal', expired_at: raised }));
    nodeRows.push(mk({ version: 2, recorded_at: raised }));
  } else nodeRows.push(mk({}));
}

// ---- notes (first_party)
const recordBodies = {};
const noteRows = [];
for (const n of NOTES) {
  const mk = (over) => base({
    id: n.id, type: 'Note', label: n.label, origin: 'first_party', verification: 'first_party', sensitivity: n.sens, domain: null, author: n.author,
    on_behalf_of: n.on_behalf_of ?? null, generated_by: n.generated_by ?? null, body_format: 'markdown', recorded_at: n.at, ...over,
  });
  if (n.v2) { noteRows.push(mk({ expired_at: n.v2.at })); noteRows.push(mk({ version: 2, recorded_at: n.v2.at })); }
  else noteRows.push(mk({}));
  recordBodies[n.id] = nfc(n.body + (n.v2?.add ?? ''));
}

// ---- snapshot and source nodes
const sourceRows = Object.values(SRC).map((s) => base({ id: s.id, type: 'Source', label: s.label, domain: null, recorded_at: '2026-10-31T08:00:00Z' }));
const snapshotRows = Object.values(snaps).map((s) => base({ id: s.id, type: 'Snapshot', label: s.row.url, domain: null, recorded_at: s.at }));

// ---- edges
const sensOf = (id) => [...nodeRows, ...claimRows, ...noteRows].filter((r) => r.id === id).at(-1)?.sensitivity ?? 'public';
const SENS = ['public', 'internal', 'private', 'secret'];
const maxSens = (...ids) => SENS[Math.max(...ids.map((i) => SENS.indexOf(sensOf(i))))];
const recAt = (id) => [...nodeRows, ...noteRows].filter((r) => r.id === id).at(-1)?.recorded_at ?? '2026-10-31T08:00:00Z';
const edgeRows = [];
const mkEdge = (src, rtype, dst, o = {}) => {
  const id = 'r-' + sha1([src, rtype, dst].join('|'));
  const claim = o.claimKey ? byKey.get(o.claimKey) : null;
  const at = o.at ?? claim?.recorded_at ?? (ts(recAt(src)) > ts(recAt(dst)) ? recAt(src) : recAt(dst));
  const row = (over) => ({ id, src, dst, rtype, status: o.status ?? 'active', sensitivity: maxSens(src, dst, ...(claim ? [claim.id] : [])), version: 1, claim_id: claim?.id ?? null, valid: V(), recorded_at: at, expired_at: null, props: {}, ...over });
  if (o.closedBy) {
    const closer = byKey.get(o.closedBy);
    edgeRows.push(row({ expired_at: closer.recorded_at }));
    edgeRows.push(row({ version: 2, status: 'superseded', recorded_at: closer.recorded_at }));
  } else edgeRows.push(row({}));
};
for (const e of EDGES) mkEdge(e.src, e.rtype, e.dst, e);
for (const s of supersedes) mkEdge(s.src, 'SUPERSEDES', s.dst, { at: s.at });
for (const n of NOTES) {
  for (const t of n.links) mkEdge(n.id, 'LINKS_TO', t, { at: n.at });
  for (const f of n.backlinksFrom) mkEdge(f, 'LINKS_TO', n.id, { at: n.at }); // reverse direction, written by the entity side
}
const seenEdge = new Set();
for (const e of edgeRows) { const k = e.id + '#' + e.version; if (seenEdge.has(k)) throw new Error('duplicate edge ' + k); seenEdge.add(k); }

// ---- change feed. Hidden records are left out of the feed and leave holes in seq (C 4.12); a raised sensitivity appears as visibility.revoked.
// The holes: one seq is skipped for each hidden record that was ever written.
const heads = (rows) => { const m = new Map(); for (const r of rows) if (!m.has(r.id) || m.get(r.id).version < r.version) m.set(r.id, r); return [...m.values()]; };
const nodeAll = [...nodeRows, ...claimRows, ...noteRows];
const hiddenNow = new Set(heads(nodeAll).filter((r) => SENS.indexOf(r.sensitivity) > 1).map((r) => r.id));
const events = nodeAll.map((r) => ({
  at: r.recorded_at, id: r.id, version: r.version, type: r.type, sens: r.sensitivity,
  kind: r.type === 'Claim' ? (r.version > 1 ? 'claim.supersede' : 'claim.assert') : r.origin === 'first_party' ? 'record.put' : 'node.upsert',
  origin: r.origin, hidden: hiddenNow.has(r.id),
}));
events.push({ at: '2026-10-31T17:50:00Z', id: 'e:concept:gateway-token-storage', kind: 'visibility.revoked' });
events.sort((a, b) => ts(a.at) - ts(b.at) || (a.id < b.id ? -1 : 1));
let seq = 183400;
const changes = [];
const seqs = {};
for (const ev of events) {
  seq += 1;
  seqs[ev.id] = seq;
  if (ev.hidden) continue; // hidden record: the seq is consumed and nothing is listed
  changes.push({ seq, at: ev.at, kind: ev.kind, id: ev.id, ...(ev.kind === 'visibility.revoked' ? {} : { version: ev.version, type: ev.type, origin: ev.origin }) });
}
const appliedSeq = seq;

// ---- schema catalog
const edgeGroup = (r) => ({
  PART_OF: 'structure', CONTAINS: 'structure', LINKS_TO: 'user', SUPERSEDES: 'claim', RENAMED_TO: 'change',
}[r] ?? 'fact');
const visible = (r) => SENS.indexOf(r.sensitivity) <= 1;
const headNodes = heads([...nodeRows, ...claimRows, ...noteRows, ...sourceRows, ...snapshotRows]).filter(visible);
const countType = (t) => headNodes.filter((r) => r.type === t && r.status === 'active' && !r.merged_into).length;
const headEdges = heads(edgeRows).filter(visible);
const GROUP = { Claim: 'evidence', Snapshot: 'evidence', Source: 'evidence', Note: 'user', Spike: 'world' };
const PROPS = {
  Tool: ['license', 'verdict', 'repo'], Library: ['license', 'verdict'], Project: ['phase'], Product: ['vendor'], Spec: ['kind'], Feature: ['spec'], Component: ['lines'],
};
const nodeTypes = [...new Set([...ENTITIES.map((e) => e.type), 'Note', 'Claim', 'Snapshot', 'Source'])].map((name) => ({
  name, group: GROUP[name] ?? 'world', count: countType(name), status: 'stable',
  properties: (PROPS[name] ?? []).map((p) => ({ name: p, type: 'string', filterable: true, sortable: false })),
}));
const edgeTypes = [...new Set(edgeRows.map((e) => e.rtype))].sort().map((name) => {
  const rows = headEdges.filter((e) => e.rtype === name);
  const typeOf = (id) => [...nodeRows, ...claimRows, ...noteRows].find((r) => r.id === id)?.type;
  return { name, group: edgeGroup(name), count: rows.length, from: [...new Set(rows.map((e) => typeOf(e.src)).filter(Boolean))].sort(), to: [...new Set(rows.map((e) => typeOf(e.dst)).filter(Boolean))].sort() };
});
const FUNCTIONAL = new Set(['latest_version', 'risk_level', 'verdict', 'atlas_glyphs_per_page', 'fit', 'recommended_primary', 'release_date', 'maintenance_risk', 'latest_public_version', 'node_cold_start_ms', 'webgl_fallback', 'types_only_mode']);
const KO = {
  latest_version: '최신 버전', risk_level: '위험 등급', verdict: '판정', atlas_glyphs_per_page: '아틀라스 쪽당 글리프', fit: '적합성', recommended_primary: '1순위 권고',
  release_date: '게시일', maintenance_risk: '유지보수 위험', latest_public_version: '공개 최신 버전', port: '포트', measurement: '측정 항목', webgl_fallback: 'WebGL 대체 경로',
  removed_in: '제거된 개정', node_cold_start_ms: 'Node 콜드 스타트(ms)', cold_start_p50_ms: '콜드 스타트 p50(ms)', types_only_mode: '타입 전용 모드',
};
const kindOf = (id, unit) => (/version/.test(id) ? 'version' : unit === 'date' || /date/.test(id) ? 'date' : unit && /^(ms|MB|fps|line|glyph|process|row|page|edge|syllable|community|char|person|hour)$/.test(unit) ? 'number' : 'text');
const preds = new Map();
for (const d of defs) if (d.p && !preds.has(d.p)) preds.set(d.p, { id: d.p, functional: FUNCTIONAL.has(d.p), value_kind: kindOf(d.p, d.u), labels: { ko: KO[d.p] ?? d.p.replace(/_/g, ' '), en: d.p.replace(/_/g, ' ') } });
const schema = {
  node_types: nodeTypes, edge_types: edgeTypes, predicates: [...preds.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
  enums: { origin: ['external', 'first_party'], sensitivity: ['public', 'internal', 'private', 'secret'], status: ['active', 'superseded', 'dead'] },
  sort_keys: Object.fromEntries(nodeTypes.map((t) => [t.name, ['id', 'label', 'recorded_at']])),
  filter_keys: ['types', 'origin', 'status', 'domain', 'source', 'author'],
};

// ---- assemble
const out = {
  _note: 'Phase 1 fixture for loupe tests. Generated by research/build.mjs from docs/research of this repository. Not KB data. Timestamps are assigned (see _provenance).',
  _provenance: {
    generator: 'contract-sample/fixtures/research/build.mjs',
    documents: provenance,
    timestamps: 'fetched_at and recorded_at are assigned by the generator in dependency order on 2026-10-31. The documents carry no fetch time.',
    sensitivity: 'public, internal, private and secret records exist. private is hidden from default reads, secret is never served.',
  },
  meta: {
    schema_version: '0.2.0-sample', epoch: 1, build_id: `g-${String(appliedSeq).padStart(9, '0')}-r1ch`, data_as_of: DATA_AS_OF, applied_seq: appliedSeq,
    data: { contract: 'v1', kb_version: '0.2.0-sample-research', limits: { overview_nodes: 50000, overview_edges: 200000, page: 500 }, first_party_open: true },
  },
  schema,
  nodes: [...nodeRows, ...noteRows, ...sourceRows, ...snapshotRows],
  claims: claimRows,
  edges: edgeRows,
  snapshots: Object.values(snaps).map((s) => s.row),
  bodies: Object.fromEntries(Object.values(snaps).map((s) => [s.id, { text: s.text, raw: s.raw, raw_content_type: s.row.content_type }])),
  removed_snapshots: [],
  series: [],
  changes,
  seqs,
  record_bodies: recordBodies,
  // Names the generator gave to the cases of the task list, so that a test can find them by name (checked by scripts/lib/research-checks.ts).
  cases: {},
};

// ---- named cases of the task list (design section 12). The checker proves each one from the data, not from this table.
const idOf = (key) => byKey.get(key)?.id;
const subjectClaims = (subject) => [...new Set(claimRows.filter((r) => r.subject === subject).map((r) => r.id))];
const hubCounts = {};
for (const r of claimRows) if (r.status === 'active' && !r.expired_at) hubCounts[r.subject] = (hubCounts[r.subject] ?? 0) + 1;
const hub = Object.entries(hubCounts).sort((a, b) => b[1] - a[1])[0];
const groups = {};
for (const d of defs) if (d.cg) (groups[d.cg] ??= []).push(d.id);
out.cases = {
  retroactive_correction: {
    note: 'verify-viewer.md overturns ui-blocks.md. valid.from is the same on both sides, recorded_at differs, so as_of_observed changes what is believed.',
    headline: { subject: 'e:library:sigma-js', predicate: 'atlas_glyphs_per_page', old_claim: idOf('sigma-cap-old'), new_claim: idOf('sigma-cap-new'), old_recorded_at: byKey.get('sigma-cap-old').recorded_at, corrected_at: byKey.get('sigma-cap-new').recorded_at },
    time_travel: { before_correction: { as_of_observed: '2026-10-31T12:00:00Z', as_of_valid: '2026-10-28', shows: '576' }, after_correction: { as_of_observed: '2026-10-31T16:00:00Z', as_of_valid: '2026-10-28', shows: '289' }, before_valid_start: { as_of_valid: '2026-10-20', shows: 'nothing for this predicate' } },
    others: defs.filter((d) => d.sup).map((d) => ({ subject: d.s, predicate: d.p, old: d.id, new: byKey.get(d.sup).id })).filter((p) => p.old !== out.cases?.x),
  },
  merged_entity: { id: 'e:tool:1mcp-app', merged_into: 'e:tool:1mcp-agent', merged_into_final: 'e:tool:1mcp', chain: ['e:tool:1mcp-app', 'e:tool:1mcp-agent', 'e:tool:1mcp'] },
  superseded_claims: [...new Set(claimRows.filter((r) => r.status === 'superseded').map((r) => r.id))],
  dead_entity: { id: 'e:feature:mcp-session-id', dead_at: '2026-10-31T12:23:00Z', claims: subjectClaims('e:feature:mcp-session-id') },
  null_predicate_claims: [...new Set(claimRows.filter((r) => r.predicate === null).map((r) => r.id))],
  conflicting_claims: groups,
  unlocatable_quote_claim: { id: idOf('sigma-cap-512'), verification: 'needs_review', hidden_by_default: true },
  unverified_claim_without_evidence: defs.filter((d) => d.verification === 'unverified').map((d) => d.id),
  sensitivity: {
    public: 'e:library:sigma-js', internal: 'f-01JD2K7Q9T4M8A', private: 'e:concept:gateway-token-storage', secret: 'e:concept:agentgateway-session-key',
    hidden_by_default: ['e:concept:gateway-token-storage', 'f-01JD2K7S8X2D5E', 'e:concept:agentgateway-session-key'],
    claims: { private: subjectClaims('e:concept:gateway-token-storage'), secret: subjectClaims('e:concept:agentgateway-session-key') },
  },
  first_party_pages: NOTES.map((n) => ({ id: n.id, label: n.label, sensitivity: n.sens, versions: n.v2 ? 2 : 1 })),
  window_crossing_quote: { claim: idOf('window-crossing'), snapshot: snaps.SR.id, window: [0, 20000] },
  truncated_claims_by_default: { entity: hub[0], active_claims: hub[1], default_claim_limit: 50 },
  jsonpointer_claims: defs.filter((d) => d.jp).map((d) => d.id),
  attributed_claims: defs.filter((d) => d.stance === 'attributed').map((d) => d.id),
  merged_claims_visible_on_final: subjectClaims('e:tool:1mcp-agent').concat(subjectClaims('e:tool:1mcp-app'), subjectClaims('e:tool:1mcp')),
  korean_body_snapshot: snaps.MS.id,
  json_snapshots: Object.values(snaps).filter((s) => s.row.text_format === 'json').map((s) => s.id),
};
writeFileSync(OUT, JSON.stringify(shapeFor030(out), null, 1) + '\n');
console.log('wrote', OUT);
console.log(JSON.stringify({
  entities: ENTITIES.length, claim_ids: new Set(claimRows.map((r) => r.id)).size, claim_rows: claimRows.length, nodes: out.nodes.length, edges: new Set(edgeRows.map((e) => e.id)).size,
  snapshots: out.snapshots.length, notes: noteRows.length, changes: changes.length, warnings: warnings.length,
}));
for (const w of warnings) console.warn('warn:', w);
