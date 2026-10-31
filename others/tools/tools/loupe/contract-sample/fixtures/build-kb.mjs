// Generates kb.json for the sample spec. Run: node contract-sample/fixtures/build-kb.mjs
// The generator exists so that quote offsets are computed in code points instead of typed by hand.
// Everything here is invented for loupe's own tests. It is not KB data and not a KB fixture (T2 replaces it).
import { createHash } from 'node:crypto';
import { shapeFor030 } from './shape.mjs';
import { writeFileSync } from 'node:fs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const T0 = '2026-10-31T09:12:03Z';
const V = (from = null, to = null, precision = 'day') => ({ from, to, precision: from || to ? precision : null, label: null });
const cps = (s) => [...s];
const quote = (body, exact, ctx = 6) => {
  const all = cps(body);
  const ex = cps(exact);
  let at = -1;
  for (let i = 0; i + ex.length <= all.length; i++) if (all.slice(i, i + ex.length).join('') === exact) { at = i; break; }
  if (at < 0) throw new Error('quote not in body: ' + exact);
  return { exact, prefix: all.slice(Math.max(0, at - ctx), at).join(''), suffix: all.slice(at + ex.length, at + ex.length + ctx).join(''), start: at, end: at + ex.length };
};

// ---- snapshot bodies. The first one has an astral character (an emoji) before the cited text.
const body1 = [
  '# Claude Code 명령어 🚀 목록',
  '',
  '| 명령 | 비고 |',
  '|---|---|',
  '| /hooks | 훅 설정을 연다 |',
  '| /ultraplan | Removed in v2.1.222 |',
  '',
  '한글 본문 끝. 숫자 8,000시간은 쉼표가 있다.',
].join('\n');
const bodyJson = JSON.stringify({ product: 'claude-code', hooks: { events: ['PreToolUse', 'PostToolUse'] }, limits: { page: 500 } }, null, 2);
const bodyHtml = '# Captured page\n\n<script>fetch("/kb/v1/meta")</script>\n<img src=x onerror="alert(1)">\n';
const rawHtml = '<!doctype html><html><body><h1>captured</h1><script>document.title="pwned"</script></body></html>';

const CC = { id: 'src:cc-docs', label: 'Claude Code 문서', trust: 'primary' };
const EX = { id: 'src:example', label: 'Example', trust: 'secondary' };
const snap = (id, url, text, format, rawBody, rawType, extra = {}) => ({
  id, url, final_url: url, source: extra.source ?? CC,
  fetched_at: '2026-10-31T01:00:00Z', http_status: 200, content_type: rawType, raw_sha256: sha(rawBody), text_sha256: sha(text),
  text_format: format, text_chars: cps(text).length, extractor: 'passthrough-nfc@1', ...extra,
});
const snapshots = [
  snap('n-3fa9c01b77aa12ef', 'https://code.claude.com/docs/en/commands.md', body1, 'markdown', body1, 'text/markdown; charset=utf-8'),
  snap('n-json000000000001', 'https://example.test/limits.json', bodyJson, 'json', bodyJson, 'application/json', { source: EX }),
  snap('n-html000000000001', 'https://example.test/captured.html', bodyHtml, 'markdown', rawHtml, 'text/html; charset=utf-8', { source: EX }),
  // image-only PDF: no display body, so /text is 404 (C 4.11)
  snap('n-pdfimage00000001', 'https://example.test/scan.pdf', '', 'pdf_text', '%PDF-1.7 image only', 'application/pdf', { source: EX }),
  // erased by record.redact: metadata still reads, /text and /raw answer 410 content_removed (C 2.3)
  snap('n-removed00000001', 'https://example.test/removed.html', 'gone', 'text', 'gone', 'text/html', { source: EX }),
];
const bodies = {
  'n-3fa9c01b77aa12ef': { text: body1, raw: body1, raw_content_type: 'text/markdown; charset=utf-8' },
  'n-json000000000001': { text: bodyJson, raw: bodyJson, raw_content_type: 'application/json' },
  'n-html000000000001': { text: bodyHtml, raw: rawHtml, raw_content_type: 'text/html; charset=utf-8' },
  'n-pdfimage00000001': { text: '', raw: '%PDF-1.7 image only', raw_content_type: 'application/pdf' },
  'n-removed00000001': { text: 'gone', raw: 'gone', raw_content_type: 'text/html' },
};
const removedSnapshots = ['n-removed00000001'];

// ---- nodes (one row per version)
const base = (o) => ({ origin: 'external', status: 'active', liveness: 'active', verification: null, sensitivity: 'public', domain: 'G', version: 1, merged_into: null, merged_into_final: null, valid: V(), recorded_at: '2026-10-01T00:00:00Z', expired_at: null, author: null, props: {}, ...o });
const nodes = [
  base({ id: 'e:product:claude-code', type: 'Product', label: 'Claude Code', recorded_at: '2025-01-01T00:00:00Z', props: { vendor: 'anthropic' } }),
  base({ id: 'e:feature:claude-code-hooks', type: 'Feature', label: 'Hooks', props: { product: 'claude-code' } }),
  base({ id: 'e:feature:history', type: 'Feature', label: 'history', props: { product: 'claude-code' } }),
  base({ id: 'e:feature:neighbors', type: 'Feature', label: 'neighbors (slug equals a route name)', props: { product: 'claude-code' } }),
  base({ id: 'e:feature:claude-code-ultraplan', type: 'Feature', label: '/ultraplan', status: 'dead', liveness: 'removed', version: 3, valid: V(null, '2026-08-02'), recorded_at: '2026-10-31T01:02:03Z', props: { product: 'claude-code' } }),
  base({ id: 'e:feature:legacy-hooks', type: 'Feature', label: 'Legacy hooks', status: 'superseded', liveness: 'renamed', version: 2, merged_into: 'e:feature:claude-code-hooks', merged_into_final: 'e:feature:claude-code-hooks' }),
  base({ id: 'e:concept:private-note', type: 'Concept', label: 'private concept', sensitivity: 'private' }),
  base({ id: 'f-01JC8ZQ3T9XYZ', type: 'Note', label: '쇼츠 후킹 메모', origin: 'first_party', verification: 'first_party', sensitivity: 'internal', domain: null, author: 'user:sagae', body_format: 'markdown', recorded_at: '2026-10-30T00:00:00Z' }),
  base({ id: 'src:cc-docs', type: 'Source', label: 'Claude Code 문서', domain: null }),
  base({ id: 's:netflix-top10-kr', type: 'Series', label: 'Netflix Top 10 KR', domain: null }),
  ...snapshots.map((s) => base({ id: s.id, type: 'Snapshot', label: s.url, domain: null, recorded_at: s.fetched_at })),
];

// ---- claims
const q1 = quote(body1, '/ultraplan | Removed in v2.1.222');
const q2 = quote(body1, '훅 설정을 연다');
const q3 = quote(body1, '8,000시간');
const ev = (id, snapshot_id, q, extra = {}) => ({ id, snapshot_id, selector_kind: 'text_quote', ...q, json_pointer: null, evidence_state: 'live', support_check: null, last_confirmed_at: '2026-10-31T01:02:03Z', ...extra });
const claim = (o) => base({ type: 'Claim', kind: 'event', stance: 'stated', method: 'llm', verification: 'quote_found', predicate: null, object: null, value: null, unit: null, qualifiers: {}, speaker: null, conflict_group: null, evidence: [], recorded_at: '2026-10-31T01:00:00Z', domain: null, ...o });
const claims = [
  claim({ id: 'c-8k2p4q7m1xab', label: '/ultraplan 제거', subject: 'e:feature:claude-code-ultraplan', statement: 'Claude Code의 /ultraplan 명령은 2.1.222에서 제거됐다.', predicate: 'removed_in', value: '2.1.222', unit: 'version', valid: V('2026-08-02'), recorded_at: '2026-10-31T01:02:03Z', evidence: [ev('ev-01', 'n-3fa9c01b77aa12ef', q1)] }),
  claim({ id: 'c-hook1aaaaaaa', label: 'Hooks 설정', subject: 'e:feature:claude-code-hooks', statement: '/hooks 명령은 훅 설정을 연다.', kind: 'state', predicate: 'opens', value: 'hook settings', evidence: [ev('ev-02', 'n-3fa9c01b77aa12ef', q2)] }),
  claim({ id: 'c-null1bbbbbbb', label: '분류 전', subject: 'e:feature:claude-code-hooks', statement: '훅은 JSON을 표준 입력으로 받는다.', kind: 'state', predicate: null, evidence: [ev('ev-03', 'n-json000000000001', { exact: null, prefix: null, suffix: null, start: null, end: null }, { selector_kind: 'jsonpointer', json_pointer: '/hooks/events/0' })] }),
  // supersession chain with a scheduled switch: 4000 hours until 2027-02-01, then 8000
  claim({ id: 'c-3hd9x0w2raab', label: 'YPP 기준 4000', version: 1, subject: 'e:product:claude-code', statement: 'YPP 진입 기준은 4,000시간/365일이다.', predicate: 'ypp_hours', value: '4000', unit: 'hour', kind: 'state', valid: V('2024-06-01'), recorded_at: '2026-08-01T00:00:00Z', expired_at: '2026-10-15T00:00:00Z', evidence: [ev('ev-04', 'n-3fa9c01b77aa12ef', q3)] }),
  claim({ id: 'c-3hd9x0w2raab', label: 'YPP 기준 4000', version: 2, subject: 'e:product:claude-code', statement: 'YPP 진입 기준은 4,000시간/365일이다.', predicate: 'ypp_hours', value: '4000', unit: 'hour', kind: 'state', valid: V('2024-06-01', '2027-02-01'), recorded_at: '2026-10-15T00:00:00Z', evidence: [ev('ev-04', 'n-3fa9c01b77aa12ef', q3)] }),
  claim({ id: 'c-8k2p4q7m1xcd', label: 'YPP 기준 8000', subject: 'e:product:claude-code', statement: 'YPP 신규 진입 기준은 2027-02-01부터 8,000시간/365일이다.', predicate: 'ypp_hours', value: '8000', unit: 'hour', kind: 'state', valid: V('2027-02-01'), recorded_at: '2026-10-15T00:00:00Z', evidence: [ev('ev-05', 'n-3fa9c01b77aa12ef', q3)] }),
  // retroactive correction: 120 was believed from 2025-06-01, corrected on 2026-06-01 to 150 for the same valid time
  claim({ id: 'c-sub120aaaaaa', label: '커뮤니티 120명', version: 1, subject: 'e:product:claude-code', statement: '한국어 커뮤니티 회원은 120명이다.', predicate: 'members', value: '120', unit: 'person', kind: 'state', valid: V('2025-06-01'), recorded_at: '2025-06-01T00:00:00Z', expired_at: '2026-06-01T00:00:00Z', evidence: [] }),
  claim({ id: 'c-sub120aaaaaa', label: '커뮤니티 120명', version: 2, status: 'superseded', subject: 'e:product:claude-code', statement: '한국어 커뮤니티 회원은 120명이다.', predicate: 'members', value: '120', unit: 'person', kind: 'state', valid: V('2025-06-01'), recorded_at: '2026-06-01T00:00:00Z', evidence: [] }),
  claim({ id: 'c-sub150bbbbbb', label: '커뮤니티 150명', subject: 'e:product:claude-code', statement: '한국어 커뮤니티 회원은 150명이다.', predicate: 'members', value: '150', unit: 'person', kind: 'state', valid: V('2025-06-01'), recorded_at: '2026-06-01T00:00:00Z', evidence: [] }),
  claim({ id: 'c-unver1cccccc', label: '미검증', subject: 'e:feature:claude-code-hooks', statement: '훅은 비동기로도 실행된다.', kind: 'state', predicate: 'async', verification: 'unverified', evidence: [] }),
  claim({ id: 'c-dead1dddddd', label: '죽은 주어의 상태', subject: 'e:feature:claude-code-ultraplan', statement: '/ultraplan은 계획 모드를 연다.', kind: 'state', predicate: 'opens', value: 'plan mode', evidence: [] }),
  claim({ id: 'c-attr1eeeeee', label: '귀속 주장', subject: 'e:feature:history', statement: '문서는 history 명령이 있다고 말한다.', stance: 'attributed', speaker: 'src:cc-docs', kind: 'state', predicate: 'documented', evidence: [] }),
];

// ---- edges (one row per version)
const e = (o) => ({ status: 'active', sensitivity: 'public', version: 1, claim_id: null, valid: V(), recorded_at: '2026-10-01T00:00:00Z', expired_at: null, props: {}, ...o });
const edges = [
  e({ id: 'r-partof000001', src: 'e:feature:claude-code-hooks', dst: 'e:product:claude-code', rtype: 'PART_OF' }),
  e({ id: 'r-partof000002', src: 'e:feature:claude-code-hooks', dst: 'e:product:claude-code', rtype: 'PART_OF', status: 'superseded', version: 2 }),
  e({ id: 'r-partof000003', src: 'e:feature:history', dst: 'e:product:claude-code', rtype: 'PART_OF' }),
  e({ id: 'r-partof000004', src: 'e:feature:neighbors', dst: 'e:product:claude-code', rtype: 'PART_OF' }),
  e({ id: 'r-partof000005', src: 'e:feature:claude-code-ultraplan', dst: 'e:product:claude-code', rtype: 'PART_OF', status: 'dead' }),
  e({ id: 'r-partof000006', src: 'e:feature:legacy-hooks', dst: 'e:product:claude-code', rtype: 'PART_OF' }),
  e({ id: 'r-removed00001', src: 'e:feature:claude-code-ultraplan', dst: 'e:product:claude-code', rtype: 'removed_in', claim_id: 'c-8k2p4q7m1xab' }),
  e({ id: 'r-links0000001', src: 'f-01JC8ZQ3T9XYZ', dst: 'e:product:claude-code', rtype: 'LINKS_TO', sensitivity: 'internal' }),
  e({ id: 'r-links0000002', src: 'e:product:claude-code', dst: 'f-01JC8ZQ3T9XYZ', rtype: 'LINKS_TO', sensitivity: 'internal' }),
  e({ id: 'r-links0000003', src: 'f-01JC8ZQ3T9XYZ', dst: 'e:feature:claude-code-hooks', rtype: 'LINKS_TO', sensitivity: 'internal' }),
  e({ id: 'r-related00001', src: 'e:feature:history', dst: 'e:feature:neighbors', rtype: 'RELATED_TO' }),
  e({ id: 'r-private00001', src: 'e:concept:private-note', dst: 'e:product:claude-code', rtype: 'RELATED_TO', sensitivity: 'private' }),
  e({ id: 'r-supers000001', src: 'c-8k2p4q7m1xcd', dst: 'c-3hd9x0w2raab', rtype: 'SUPERSEDES' }),
  e({ id: 'r-supers000002', src: 'c-sub150bbbbbb', dst: 'c-sub120aaaaaa', rtype: 'SUPERSEDES' }),
];

const series = [{
  id: 's:netflix-top10-kr', metric: 'weekly_rank', unit: 'rank',
  points: [
    { period: '2026-W41', start: '2026-10-05T00:00:00Z', end: '2026-10-12T00:00:00Z', value: '3', observed_at: '2026-10-13T03:00:00Z', last_seen_at: '2026-10-13T03:00:00Z', snapshot_id: null },
    { period: '2026-W42', start: '2026-10-12T00:00:00Z', end: '2026-10-19T00:00:00Z', value: '2', observed_at: '2026-10-20T03:00:00Z', last_seen_at: '2026-10-20T03:00:00Z', snapshot_id: null },
    { period: '2026-W43', start: '2026-10-19T00:00:00Z', end: '2026-10-26T00:00:00Z', value: '1', observed_at: '2026-10-27T03:00:00Z', last_seen_at: '2026-10-30T03:00:00Z', snapshot_id: null },
  ],
  gaps: [{ from: '2026-09-01T00:00:00Z', to: '2026-09-03T00:00:00Z', reason: 'machine_off' }],
}];

// ---- change feed. seq has holes on purpose (hidden events are skipped, C 4.12).
const changes = [
  [183401, 'node.upsert', 'e:product:claude-code', 1, 'Product'],
  [183402, 'node.upsert', 'e:feature:claude-code-hooks', 1, 'Feature'],
  [183403, 'node.upsert', 'e:concept:private-note', 1, 'Concept'],
  [183405, 'claim.assert', 'c-8k2p4q7m1xab', 1, 'Claim'],
  [183408, 'claim.assert', 'c-3hd9x0w2raab', 1, 'Claim'],
  [183410, 'claim.supersede', 'c-3hd9x0w2raab', 2, 'Claim'],
  [183411, 'claim.assert', 'c-8k2p4q7m1xcd', 1, 'Claim'],
  [183415, 'record.put', 'f-01JC8ZQ3T9XYZ', 1, 'Note'],
  [183420, 'series.batch', 's:netflix-top10-kr', 1, 'Series'],
  [183421, 'visibility.revoked', 'e:concept:private-note', null, null],
  [183422, 'claim.assert', 'c-hook1aaaaaaa', 1, 'Claim'],
].map(([seq, kind, id, version, type]) => ({
  seq, at: `2026-10-31T09:${String(seq % 60).padStart(2, '0')}:00Z`, kind, id,
  // visibility.revoked carries no body, version, type or origin (C 4.12)
  ...(kind === 'visibility.revoked' ? {} : { version, type, origin: kind === 'series.batch' ? 'system' : id.startsWith('f-') ? 'first_party' : 'external' }),
}));

// last seq per id, used for single-object ETags
const seqs = {};
for (const c of changes) seqs[c.id] = c.seq;
for (const n of [...nodes, ...claims]) seqs[n.id] ??= 183400;
for (const x of edges) seqs[x.id] ??= 183400;

const schema = {
  node_types: [
    { name: 'Product', group: 'world', count: 1, status: 'stable', properties: [{ name: 'vendor', type: 'string', filterable: true, sortable: false }] },
    { name: 'Feature', group: 'world', count: 5, status: 'stable', properties: [{ name: 'product', type: 'string', filterable: true, sortable: false }] },
    { name: 'Concept', group: 'world', count: 1, status: 'stable', properties: [] },
    { name: 'Note', group: 'user', count: 1, status: 'stable', properties: [] },
    { name: 'Series', group: 'world', count: 1, status: 'stable', properties: [] },
    { name: 'Claim', group: 'evidence', count: claims.length, status: 'stable', properties: [] },
    { name: 'Snapshot', group: 'evidence', count: snapshots.length, status: 'stable', properties: [] },
    { name: 'Source', group: 'evidence', count: 1, status: 'stable', properties: [] },
  ],
  edge_types: [
    { name: 'PART_OF', group: 'structure', count: 6, from: ['Feature'], to: ['Product'] },
    { name: 'LINKS_TO', group: 'user', count: 3, from: ['Note', 'Product'], to: ['Product', 'Note', 'Feature'] },
    { name: 'RELATED_TO', group: 'structure', count: 2, from: ['Feature', 'Concept'], to: ['Feature', 'Product'] },
    { name: 'SUPERSEDES', group: 'claim', count: 2, from: ['Claim'], to: ['Claim'] },
    { name: 'removed_in', group: 'fact', count: 1, from: ['Feature'], to: ['Product'] },
  ],
  predicates: [
    { id: 'removed_in', functional: false, value_kind: 'version', labels: { ko: '제거 버전', en: 'removed in' } },
    { id: 'ypp_hours', functional: true, value_kind: 'number', labels: { ko: 'YPP 시간 기준', en: 'YPP hours' } },
    { id: 'members', functional: true, value_kind: 'number', labels: { ko: '회원 수', en: 'members' } },
    { id: 'opens', functional: false, value_kind: 'text', labels: { ko: '여는 것', en: 'opens' } },
    { id: 'documented', functional: false, value_kind: 'some_future_kind', labels: { ko: '문서화', en: 'documented' } },
  ],
  enums: { origin: ['external', 'first_party'], sensitivity: ['public', 'internal', 'private', 'secret'], status: ['active', 'superseded', 'dead'] },
  sort_keys: { Feature: ['id', 'label', 'recorded_at'], Product: ['id', 'label'], Claim: ['id', 'recorded_at'] },
  filter_keys: ['types', 'origin', 'status', 'domain', 'source', 'author'],
};

const out = {
  _note: 'Invented sample data for loupe tests. Generated by build-kb.mjs. Not KB data.',
  meta: {
    schema_version: '0.2.0-sample', epoch: 1, build_id: 'g-000183422-a1b2', data_as_of: T0, applied_seq: 183422,
    data: { contract: 'v1', kb_version: '0.1.0-sample', limits: { overview_nodes: 100000, overview_edges: 400000, page: 500 }, first_party_open: true },
  },
  schema, nodes, claims, edges, snapshots, bodies, removed_snapshots: removedSnapshots, series, changes, seqs,
  record_bodies: { 'f-01JC8ZQ3T9XYZ': '쇼츠 후킹 메모\n\n[[e:product:claude-code]]와 [[e:feature:claude-code-hooks]]를 본다.\n' },
};
writeFileSync(new URL('./kb.json', import.meta.url), JSON.stringify(shapeFor030(out), null, 1) + '\n');
console.log('wrote kb.json', { nodes: nodes.length, claims: claims.length, edges: edges.length, snapshots: snapshots.length });
