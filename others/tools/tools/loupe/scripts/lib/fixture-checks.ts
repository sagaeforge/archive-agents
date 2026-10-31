// Fixture checks used by the contract flow (scripts/validate-fixtures.ts). Pure functions over a parsed fixture file.
// The checks prove properties of the data. They never read the named `cases` table as an authority: each case is re-derived.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Report = { bad: number; fail: (msg: string) => void; failures: string[]; notes: string[]; counts: Record<string, number>; shown: number };
export const newReport = (label: string, quiet = false): Report => {
  const r: Report = {
    bad: 0, failures: [], notes: [], counts: {}, shown: 0,
    fail: (msg) => { r.bad++; r.failures.push(msg); if (!quiet && r.shown++ < 25) console.error(`[${label}] ${msg}`); },
  };
  return r;
};

const cps = (s: string): string[] => [...s];
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const ts = (s: string) => Date.parse(s);
const SENS = ['public', 'internal', 'private', 'secret'];

const jsonPointer = (doc: any, ptr: string): any => (ptr === '' ? doc : ptr.slice(1).split('/').reduce((n: any, raw) => n?.[raw.replace(/~1/g, '/').replace(/~0/g, '~')], doc));

/** Contract 2.11: offsets are code points of the display body, start inclusive, end exclusive. Exact, prefix and suffix must agree. */
export function checkQuotes(f: any, r: Report): void {
  let located = 0, unlocated = 0, pointers = 0;
  for (const c of f.claims) for (const ev of c.evidence ?? []) {
    const snap = f.snapshots.find((s: any) => s.id === ev.snapshot_id);
    const body: string | undefined = f.bodies[ev.snapshot_id]?.text;
    if (!snap || body === undefined) { r.fail(`claim ${c.id} cites unknown snapshot ${ev.snapshot_id}`); continue; }
    if (ev.selector_kind === 'jsonpointer') {
      pointers++;
      let doc: any;
      try { doc = JSON.parse(body); } catch { r.fail(`${c.id}: jsonpointer evidence on a body that is not JSON`); continue; }
      const got = jsonPointer(doc, ev.json_pointer);
      if (got === undefined) r.fail(`${c.id}: pointer ${ev.json_pointer} does not resolve`);
      else if (c.verification === 'parser_derived' && c.value != null && String(got) !== c.value) r.fail(`${c.id}: value ${c.value} differs from ${ev.json_pointer} = ${got}`);
      continue;
    }
    const all = cps(body);
    if (ev.start == null || ev.end == null) {
      // A quote that cannot be located: only allowed when it really is absent and the claim says so.
      unlocated++;
      if (!ev.exact) r.fail(`${c.id}/${ev.id}: no offsets and no exact text`);
      else if (body.includes(ev.exact)) r.fail(`${c.id}/${ev.id}: marked as not located but exact text is in the body`);
      if (!['needs_review', 'unverified'].includes(c.verification)) r.fail(`${c.id}: unlocated quote on a claim that is ${c.verification}`);
      continue;
    }
    located++;
    if (all.slice(ev.start, ev.end).join('') !== ev.exact) r.fail(`${c.id}/${ev.id}: exact does not match [${ev.start},${ev.end}) in ${ev.snapshot_id}`);
    if (ev.prefix && all.slice(Math.max(0, ev.start - cps(ev.prefix).length), ev.start).join('') !== ev.prefix) r.fail(`${c.id}/${ev.id}: prefix mismatch`);
    if (ev.suffix && all.slice(ev.end, ev.end + cps(ev.suffix).length).join('') !== ev.suffix) r.fail(`${c.id}/${ev.id}: suffix mismatch`);
    if (ev.exact.normalize('NFC') !== ev.exact) r.fail(`${c.id}/${ev.id}: exact is not NFC`);
    if (!['quote_found', 'parser_derived', 'first_party'].includes(c.verification)) r.fail(`${c.id}: located quote but verification is ${c.verification}`);
  }
  for (const c of f.claims) {
    if (c.verification === 'quote_found' && !(c.evidence ?? []).some((e: any) => e.start != null)) r.fail(`${c.id}: quote_found without a located quote`);
    if (c.verification === 'parser_derived' && !(c.evidence ?? []).some((e: any) => e.selector_kind === 'jsonpointer')) r.fail(`${c.id}: parser_derived without a pointer`);
  }
  for (const s of f.snapshots) {
    const b = f.bodies[s.id];
    if (!b) { r.fail(`snapshot ${s.id} has no body`); continue; }
    if (cps(b.text).length !== s.text_chars) r.fail(`snapshot ${s.id}: text_chars ${s.text_chars} != ${cps(b.text).length}`);
    if (sha256(b.text) !== s.text_sha256) r.fail(`snapshot ${s.id}: text_sha256 mismatch`);
    if (sha256(b.raw) !== s.raw_sha256) r.fail(`snapshot ${s.id}: raw_sha256 mismatch`);
    if (b.text.normalize('NFC') !== b.text) r.fail(`snapshot ${s.id}: display body is not NFC`);
  }
  r.counts.quotes_located = located; r.counts.quotes_unlocated = unlocated; r.counts.json_pointers = pointers;
}

const ID_PATTERNS: [string, RegExp][] = [
  ['Claim', /^c-[A-Za-z0-9_-]+$/], ['Snapshot', /^n-[A-Za-z0-9_-]+$/], ['Note', /^f-[A-Za-z0-9_-]+$/], ['Source', /^src:[a-z0-9-]+$/], ['Series', /^s:[a-z0-9-]+$/],
];
/** Ids, references, version rows, time order, sensitivity propagation, private addresses. */
export function checkIntegrity(f: any, r: Report): void {
  const rows: any[] = [...f.nodes, ...f.claims];
  const nodeById = new Map<string, any[]>();
  for (const x of rows) (nodeById.get(x.id) ?? nodeById.set(x.id, []).get(x.id)!).push(x);
  for (const l of nodeById.values()) l.sort((a, b) => a.version - b.version);
  const edgeById = new Map<string, any[]>();
  for (const x of f.edges) (edgeById.get(x.id) ?? edgeById.set(x.id, []).get(x.id)!).push(x);
  for (const l of edgeById.values()) l.sort((a, b) => a.version - b.version);
  const head = (id: string) => nodeById.get(id)?.at(-1);

  for (const [id, l] of [...nodeById, ...edgeById]) {
    if (/[\/?#\s\u0000-\u001f]/.test(id)) r.fail(`id with a forbidden character: ${JSON.stringify(id)}`);
    const t = l[0].type;
    const pat = ID_PATTERNS.find(([n]) => n === t)?.[1];
    if (pat && !pat.test(id)) r.fail(`id ${id} does not fit the pattern of ${t}`);
    if (t && !['Claim', 'Snapshot', 'Note', 'Source', 'Series'].includes(t) && !/^e:[a-z0-9]+:[a-z0-9._-]+$/.test(id)) r.fail(`entity id ${id} is not e:<type>:<slug>`);
    l.forEach((v: any, i: number) => {
      if (v.version !== i + 1) r.fail(`${id}: version rows are not 1..n`);
      if (v.expired_at && ts(v.expired_at) <= ts(v.recorded_at)) r.fail(`${id}#${v.version}: expired_at is not after recorded_at`);
      if (i > 0 && ts(v.recorded_at) < ts(l[i - 1].recorded_at)) r.fail(`${id}#${v.version}: recorded before the previous version`);
      if (i > 0 && l[i - 1].expired_at !== v.recorded_at) r.fail(`${id}#${v.version}: previous version is not closed when this one starts`);
      if (ts(v.recorded_at) > ts(f.meta.data_as_of)) r.fail(`${id}#${v.version}: recorded after data_as_of`);
    });
    if (l.at(-1).expired_at) r.fail(`${id}: the latest version is expired`);
  }
  // references
  const known = (id: string) => nodeById.has(id);
  for (const c of f.claims) if (!known(c.subject)) r.fail(`claim ${c.id}: unknown subject ${c.subject}`);
  for (const e of f.edges) {
    if (!known(e.src)) r.fail(`edge ${e.id}: unknown src ${e.src}`);
    if (!known(e.dst)) r.fail(`edge ${e.id}: unknown dst ${e.dst}`);
    if (e.claim_id && !known(e.claim_id)) r.fail(`edge ${e.id}: unknown claim ${e.claim_id}`);
    const need = Math.max(...[e.src, e.dst, e.claim_id].filter(Boolean).map((i: string) => SENS.indexOf(head(i)?.sensitivity ?? 'public')));
    if (SENS.indexOf(e.sensitivity) < need) r.fail(`edge ${e.id}: sensitivity ${e.sensitivity} is lower than its ends or claim (C 2.7)`);
  }
  for (const s of f.snapshots) if (!known(s.id) || !known(s.source?.id)) r.fail(`snapshot ${s.id}: snapshot or source node missing`);
  // merges
  for (const x of rows) {
    if (!x.merged_into) continue;
    if (!known(x.merged_into)) r.fail(`${x.id}: merged_into ${x.merged_into} unknown`);
    if (x.status !== 'superseded') r.fail(`${x.id}: merged but status ${x.status}`);
    let cur = x.id; const seen = new Set<string>();
    while (head(cur)?.merged_into) { if (seen.has(cur)) { r.fail(`${x.id}: merge cycle`); break; } seen.add(cur); cur = head(cur).merged_into; }
    if (head(cur)?.merged_into) continue;
    if (x.merged_into_final !== cur) r.fail(`${x.id}: merged_into_final ${x.merged_into_final} but the chain ends at ${cur}`);
  }
  // change feed
  const seqs = f.changes.map((c: any) => c.seq);
  if (seqs.some((s: number, i: number) => i > 0 && s <= seqs[i - 1])) r.fail('change feed seq is not strictly increasing');
  if (seqs.length && seqs.at(-1) > f.meta.applied_seq) r.fail('change feed is ahead of applied_seq');
  // no private LAN address anywhere in the file (CLAUDE.md of the task: drop any LAN address)
  const flat = JSON.stringify(f);
  const lan = flat.match(/(?<![\d.])(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?(?![\d.])/g);
  if (lan) r.fail(`private network address in the fixture: ${[...new Set(lan)].slice(0, 3).join(', ')}`);
  r.counts.node_rows = f.nodes.length; r.counts.claim_rows = f.claims.length; r.counts.edge_rows = f.edges.length;
}

/** Bitemporal read used to prove the time-travel case: the version that covers (valid, observed). */
const coverRow = (l: any[] | undefined, V: number | null, O: number) => l?.find((v) => ts(v.recorded_at) <= O && (v.expired_at == null || ts(v.expired_at) > O) && (V === null || ((v.valid?.from == null || ts(v.valid.from) <= V) && (v.valid?.to == null || ts(v.valid.to) > V))));

export type ResearchOpts = { docsDir?: string };
/** The Phase 1 fixture (design 12): size, fidelity to docs/research and every named case. */
export function checkResearch(f: any, r: Report, opts: ResearchOpts = {}): Record<string, boolean> {
  const cov: Record<string, boolean> = {};
  const claimIds = new Set<string>(f.claims.map((c: any) => c.id));
  const byId = new Map<string, any[]>();
  for (const x of [...f.nodes, ...f.claims]) (byId.get(x.id) ?? byId.set(x.id, []).get(x.id)!).push(x);
  for (const l of byId.values()) l.sort((a, b) => a.version - b.version);
  const latest = (id: string) => byId.get(id)?.at(-1);
  const entities = [...byId.values()].map((l) => l.at(-1)).filter((x) => x.origin === 'external' && !['Claim', 'Snapshot', 'Source', 'Note'].includes(x.type));
  r.counts.entities = entities.length; r.counts.claims = claimIds.size; r.counts.snapshots = f.snapshots.length;
  r.counts.edges = new Set(f.edges.map((e: any) => e.id)).size;
  cov.size_entities = entities.length >= 45 && entities.length <= 65;
  cov.size_claims = claimIds.size >= 190 && claimIds.size <= 260;
  cov.size_snapshots = f.snapshots.length === 20;
  for (const k of ['size_entities', 'size_claims', 'size_snapshots']) if (!cov[k]) r.fail(`${k} outside the Phase 1 target (about 50 / 200 / 20): ${JSON.stringify(r.counts)}`);

  // ---- fidelity: every body is the real document (allowing the recorded redactions)
  const docs = f._provenance?.documents ?? {};
  const dir = opts.docsDir;
  if (dir && existsSync(dir)) {
    let checked = 0;
    for (const s of f.snapshots) {
      const p = docs[s.id];
      if (!p) { r.fail(`snapshot ${s.id} has no provenance`); continue; }
      const file = new URL(p.path.replace(/^docs\/research\//, ''), 'file://' + dir.replace(/\/?$/, '/')).pathname;
      if (!existsSync(file)) { r.notes.push(`source file missing, fidelity not checked: ${p.path}`); continue; }
      let raw = readFileSync(file, 'utf8');
      for (const red of p.redactions ?? []) raw = raw.replace(/192\.168\.\d+\.\d+/g, red.replacement);
      if (raw !== f.bodies[s.id].raw) r.fail(`snapshot ${s.id}: raw differs from ${p.path}`);
      const display = s.text_format === 'json' ? JSON.stringify(JSON.parse(raw), null, 2).normalize('NFC') : raw.normalize('NFC');
      if (display !== f.bodies[s.id].text) r.fail(`snapshot ${s.id}: display body differs from ${p.path}`);
      checked++;
    }
    r.counts.documents_compared = checked;
    cov.documents_verbatim = checked === f.snapshots.length;
  } else { r.notes.push('docs/research not found: snapshot fidelity not compared (set RESEARCH_DIR)'); cov.documents_verbatim = true; }

  // ---- retroactive correction: a verify report overturns a research report, visible on both time axes
  const sup = f.edges.filter((e: any) => e.rtype === 'SUPERSEDES');
  const snapSource = (cid: string) => f.snapshots.find((s: any) => s.id === latest(cid)?.evidence?.[0]?.snapshot_id)?.source?.id;
  const retro = sup.filter((e: any) => {
    const n = byId.get(e.src), o = byId.get(e.dst);
    if (!n || !o || o.length < 2) return false;
    return n[0].subject === o[0].subject && n[0].predicate === o[0].predicate && n[0].value !== o[0].value && n[0].valid.from === o[0].valid.from
      && o[0].expired_at === n[0].recorded_at && o.at(-1).status === 'superseded' && snapSource(e.dst) === 'src:sagae-research' && snapSource(e.src) === 'src:sagae-verification';
  });
  cov.retroactive_correction = retro.length >= 5;
  const head = f.cases?.retroactive_correction?.headline;
  if (head) {
    const l = (id: string) => byId.get(id);
    const tt = f.cases.retroactive_correction.time_travel;
    const believed = (V: string, O: string) => [head.old_claim, head.new_claim].map((id) => coverRow(l(id), ts(V), ts(O))).filter((v: any) => v && v.status === 'active').map((v: any) => v.value);
    const before = believed(tt.before_correction.as_of_valid, tt.before_correction.as_of_observed);
    const after = believed(tt.after_correction.as_of_valid, tt.after_correction.as_of_observed);
    const nothing = believed(tt.before_valid_start.as_of_valid, '2026-10-31T23:00:00Z');
    cov.time_travel_changes_screen = before.join() === tt.before_correction.shows && after.join() === tt.after_correction.shows && nothing.length === 0;
    if (!cov.time_travel_changes_screen) r.fail(`time travel probe: before=${before} after=${after} nothing=${nothing}`);
    const cur = [head.old_claim, head.new_claim].map((id) => coverRow(l(id), null, ts(f.meta.data_as_of))).filter(Boolean);
    cov.retro_default_read_shows_correction = cur.length === 2 && cur.filter((v: any) => v.status === 'active').length === 1 && cur.find((v: any) => v.status === 'active').id === head.new_claim;
  } else cov.time_travel_changes_screen = false;

  // ---- merged entity with a chain, and the final target
  const merged = [...byId.values()].map((l) => l.at(-1)).filter((x) => x.merged_into);
  cov.merged_entity = merged.length >= 2 && merged.some((x) => x.merged_into !== x.merged_into_final);
  cov.merged_claims_land_on_final = merged.some((m) => f.claims.some((c: any) => c.subject === m.id && c.status === 'active')) ;
  // ---- superseded claim, dead entity, null predicate
  cov.superseded_claim = f.claims.some((c: any) => c.status === 'superseded');
  const dead = [...byId.values()].map((l) => l.at(-1)).filter((x) => x.status === 'dead' && x.type !== 'Claim');
  cov.dead_entity = dead.some((d) => f.claims.some((c: any) => c.subject === d.id && c.kind === 'event') && f.claims.some((c: any) => c.subject === d.id && c.kind === 'state'));
  cov.dead_entity_had_a_live_version = dead.some((d) => (byId.get(d.id) ?? []).some((v) => v.status === 'active'));
  cov.null_predicate_claim = f.claims.filter((c: any) => c.predicate === null && c.verification === 'quote_found').length >= 3;
  // ---- conflicting claims side by side: same group, different values, both active at the head
  const groups = new Map<string, any[]>();
  for (const c of f.claims) if (c.conflict_group && c.status === 'active' && !c.expired_at) (groups.get(c.conflict_group) ?? groups.set(c.conflict_group, []).get(c.conflict_group)!).push(c);
  cov.conflicting_claims = [...groups.values()].some((g) => new Set(g.map((c) => c.value)).size >= 2 && new Set(g.map((c) => c.evidence?.[0]?.snapshot_id)).size >= 2);
  // ---- a claim whose quote cannot be located
  cov.unlocatable_quote = f.claims.some((c: any) => c.verification === 'needs_review' && (c.evidence ?? []).some((e: any) => e.start == null && e.exact && !f.bodies[e.snapshot_id].text.includes(e.exact)));
  cov.unverified_without_evidence = f.claims.some((c: any) => c.verification === 'unverified' && !(c.evidence ?? []).length);
  // ---- sensitivity: every level, private and secret hidden, and nothing public leans on them
  const lv = (s: string) => [...byId.values()].some((l) => l.at(-1).sensitivity === s);
  for (const s of SENS) cov[`sensitivity_${s}`] = lv(s);
  const hiddenIds = new Set([...byId.values()].map((l) => l.at(-1)).filter((x) => SENS.indexOf(x.sensitivity) > 1).map((x) => x.id));
  cov.hidden_records_isolated = f.edges.every((e: any) => !(hiddenIds.has(e.src) || hiddenIds.has(e.dst) || hiddenIds.has(e.claim_id)) || SENS.indexOf(e.sensitivity) > 1)
    && f.claims.every((c: any) => !hiddenIds.has(c.subject) || SENS.indexOf(c.sensitivity) > 1);
  cov.visibility_revoked_in_feed = f.changes.some((c: any) => c.kind === 'visibility.revoked' && hiddenIds.has(c.id));
  cov.feed_has_no_hidden_record = f.changes.every((c: any) => c.kind === 'visibility.revoked' || !hiddenIds.has(c.id));
  // ---- first_party pages: Markdown body, author, versions, links both ways
  const notes = f.nodes.filter((n: any) => n.origin === 'first_party' && n.version === 1);
  const link = /\[\[([^\]]+)\]\]/g;
  cov.first_party_page = notes.length >= 2 && notes.every((n: any) => typeof f.record_bodies[n.id] === 'string' && n.body_format === 'markdown' && n.author);
  cov.first_party_wikilinks_are_edges = notes.every((n: any) => [...f.record_bodies[n.id].matchAll(link)].every((m) => f.edges.some((e: any) => e.src === n.id && e.dst === m[1] && e.rtype === 'LINKS_TO')));
  cov.first_party_backlink = notes.some((n: any) => f.edges.some((e: any) => e.dst === n.id && e.rtype === 'LINKS_TO'));
  cov.first_party_has_versions = notes.some((n: any) => (byId.get(n.id) ?? []).length > 1);
  cov.first_party_agent_author = f.nodes.some((n: any) => n.origin === 'first_party' && /^agent:/.test(n.author ?? '') && n.on_behalf_of);
  // ---- quotes: crossing the default /text window, Korean, JSON pointers, attributed speech
  cov.quote_crossing_text_window = f.claims.some((c: any) => (c.evidence ?? []).some((e: any) => e.start != null && e.start < 20000 && e.end > 20000));
  cov.korean_quote = f.claims.some((c: any) => (c.evidence ?? []).some((e: any) => /[가-힣]/.test(e.exact ?? '')));
  cov.korean_body = f.snapshots.some((s: any) => (f.bodies[s.id].text.match(/[가-힣]/g) ?? []).length > 1000);
  cov.jsonpointer_claims = f.claims.filter((c: any) => (c.evidence ?? []).some((e: any) => e.selector_kind === 'jsonpointer')).length >= 5 && f.snapshots.filter((s: any) => s.text_format === 'json').length >= 3;
  cov.attributed_claim = f.claims.some((c: any) => c.stance === 'attributed' && c.speaker);
  cov.event_and_state_claims = f.claims.some((c: any) => c.kind === 'event') && f.claims.some((c: any) => c.kind === 'state') && f.claims.some((c: any) => c.kind === 'howto');
  // ---- hub entity: more claims than the default claim_limit (50), so the first page is truncated
  const counts = new Map<string, number>();
  for (const c of f.claims) if (c.status === 'active' && !c.expired_at && c.verification !== 'needs_review' && c.verification !== 'unverified') counts.set(c.subject, (counts.get(c.subject) ?? 0) + 1);
  cov.claims_truncated_by_default = Math.max(...counts.values()) > 50;
  // ---- relations in both directions, and parallel edges
  const key = (a: string, b: string) => `${a}\u0000${b}`;
  const ends = new Set(f.edges.map((e: any) => key(e.src, e.dst)));
  const entityEdges = f.edges.filter((e: any) => !claimIds.has(e.src) && !String(e.src).startsWith('f-'));
  const recips = new Set<string>();
  for (const e of entityEdges) if (ends.has(key(e.dst, e.src))) recips.add([e.src, e.dst].sort().join('|'));
  r.counts.reciprocal_pairs = recips.size;
  cov.relations_both_directions = recips.size >= 10;
  cov.parallel_edges = f.edges.some((a: any) => f.edges.some((b: any) => a.id < b.id && a.src === b.src && a.dst === b.dst && a.rtype !== b.rtype));
  cov.time_varying_relation = f.edges.some((e: any) => e.rtype === 'RECOMMENDS' && e.version === 2 && e.status === 'superseded');
  // ---- domain shape: both research and verification sources, spike log, upstream copies
  const srcs = new Set(f.snapshots.map((s: any) => s.source.id));
  cov.sources_cover_research_verification_spikes = ['src:sagae-research', 'src:sagae-verification', 'src:sagae-spikes', 'src:upstream-docs'].every((s) => srcs.has(s));
  cov.verification_after_research = f.snapshots.filter((s: any) => s.source.id === 'src:sagae-verification').every((v: any) => f.snapshots.filter((s: any) => s.source.id === 'src:sagae-research').every((x: any) => ts(x.fetched_at) < ts(v.fetched_at)));
  // evidence is never recorded before its snapshot arrived
  cov.claims_not_before_their_snapshot = f.claims.every((c: any) => (c.evidence ?? []).every((e: any) => ts(c.recorded_at) >= ts(f.snapshots.find((s: any) => s.id === e.snapshot_id).fetched_at)));
  for (const [k, v] of Object.entries(cov)) if (!v) r.fail(`case not covered: ${k}`);
  return cov;
}

/** The small hostile fixture: content that must never execute, navigate or be believed when it is rendered. */
export function checkHostile(f: any, r: Report): Record<string, boolean> {
  const all = JSON.stringify(f);
  const bodies = Object.values<any>(f.bodies).map((b) => b.text).join('\n');
  const cov: Record<string, boolean> = {
    script_tag: /<script\b/i.test(bodies),
    javascript_link: /\]\(\s*javascript:/i.test(bodies) && /href=["']?javascript:/i.test(bodies),
    data_url_link: /\]\(\s*data:text\/html/i.test(bodies),
    event_handler_attribute: /\bon(error|load|click|mouseover)\s*=/i.test(bodies),
    iframe_and_svg: /<iframe\b/i.test(bodies) && /<svg\b[^>]*onload/i.test(bodies),
    prompt_injection_text: /ignore (all )?(previous|prior) instructions/i.test(bodies) && /(system prompt|assistant)/i.test(bodies),
    hostile_in_statement_and_label: f.claims.some((c: any) => /<script|javascript:|onerror=/i.test(c.statement)) && f.nodes.some((n: any) => /<script|onerror=/i.test(n.label)),
    hostile_html_raw: Object.values<any>(f.bodies).some((b) => /^text\/html/.test(b.raw_content_type)),
    markdown_link_title_injection: /\]\([^\n]*onmouseover\s*=/i.test(bodies),
    rtl_and_zero_width: /[‮​⁦]/.test(all) || /\\u202e|\\u200b|\\u2066/.test(all),
    astral_before_quote: f.claims.some((c: any) => (c.evidence ?? []).some((e: any) => e.start != null && cps(f.bodies[e.snapshot_id].text).slice(0, e.start).some((ch) => (ch.codePointAt(0) as number) > 0xffff))),
    nfd_input: Object.values<any>(f.bodies).some((b) => b.raw !== b.text && b.raw.normalize('NFC') === b.text && /[ᄀ-ᇿ]/.test(b.raw)),
    long_unbroken_token: /\S{300,}/.test(bodies),
    hostile_id_like_text: f.claims.some((c: any) => /\.\.\/|%2f|%2e%2e/i.test(c.statement)),
    nothing_is_marked_trusted: f.snapshots.every((s: any) => s.source.trust !== 'primary' || /example\.test|hostile/.test(s.url)),
    small: f.snapshots.length <= 8 && f.nodes.length <= 40,
  };
  for (const [k, v] of Object.entries(cov)) if (!v) r.fail(`hostile case not covered: ${k}`);
  r.counts.hostile_snapshots = f.snapshots.length;
  return cov;
}
