// kb-mock: a stand-in for the KB read API, dev only. It follows the KB's openapi.yaml (the stamp in src/client says which one) and checks its own responses against it.
// It enforces the rules that design section 8 names: C 2.3 errors, 2.4 cursors, 2.5 ETag and 304, 2.7 default filters,
// 2.9 time axes, plus unknown-parameter rejection (appendix B 16, a guess).
// Every JSON body is validated against the spec before it is sent: a drifted mock answers 500, never a wrong 200.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import { Hono, type Context } from 'hono';
import { topicFixtures as m0cFixtures, topicEdges } from './topics.ts';
import { gizmoFixtures, gizmoEdges } from './gizmo.ts';
import { editorFixtures } from './editor.ts';
import { createRecordStore, registerWriteRoutes, writeMeta, type WriteOptions } from './write.ts';
import { writtenView } from './docs.ts';
import { databaseRows, seedDatabase } from './db.ts';
import { CLAIM_IDS, claimCountOf, edgesOf, isTaskTopic, registerTaskRoutes, taskNodes, taskSpecs } from './tasks.ts';
import { fixturePath as defaultFixture, schemaOf, compileParam, operations, type Op } from './spec.ts';

type Row = Record<string, any>;
export type MockOptions = {
  topics?: boolean;
  /** M0f: the task center's fixtures and its five first-party read routes (design v2 11.2). Off by default, so every other read and test stays as it was. */
  tasks?: boolean;
  /** M1: the first-party write path (POST/PUT records, tombstone, /v1/writes/{ref}) and the 9th-revision `meta.write` (design v2 11.2). Off by default. See dev/kb-mock/write.ts. */
  write?: WriteOptions;
  /** M4: the database view's fixtures (a document with two view blocks and the records they list). Needs `write`. See dev/kb-mock/db.ts. */
  db?: boolean;
  fixturePath?: string;
  /** Negative controls for the contract flow. Schemathesis or the mock tests must fail on each of these. */
  bug?: 'drop_field' | 'wrong_error_type' | 'ignore_as_of' | 'no_cursor_check' | 'leak_private' | undefined;
  token?: string | undefined;
  notReadyMs?: number;
  /** Export has not been published yet: manifest and file answer 503 not_ready (C 5). */
  exportUnpublished?: boolean;
  epoch?: number | undefined;
  /** 0.2.0 sends application/zstd with no Content-Encoding. 'encoding' is the 0.1.0 spelling the proxy still accepts. */
  exportStyle?: 'ctype' | 'encoding';
  totalNull?: boolean;
  onAccess?: ((line: string) => void) | undefined;
};

const NON_WORLD = new Set(['Claim', 'Snapshot', 'Source', 'Document', 'Ticket']);
const ALLOWED_VERIFICATION = new Set(['quote_found', 'parser_derived', 'first_party']);
const SENS = ['public', 'internal', 'private', 'secret'];
const ts = (s: string) => Date.parse(s); // a bare YYYY-MM-DD is 00:00Z
const cp = (s: string) => [...s];
const byIdAsc = (a: Row, b: Row) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sha1 = (s: string, n = 12) => createHash('sha1').update(s).digest('hex').slice(0, n);

/** `/v1/meta` `data.write` in the single shape of ADR-0005 8.1 (design v2 2.8). A summary the settings window reads; this mock writes nothing. */
const MOCK_WRITE_STATE = {
  fp_gate: true,
  editor_routes: ['POST /v1/records', 'PUT /v1/records/{id}'],
  private_open: true,
  hitl: { available: true, trust_store: 'ready', rp_ids: [{ rp_id: 'localhost', allowed_origins: ['http://localhost:4812', 'http://localhost:4830'], registered: true }] },
  secret_rules: { version: 'fp-secret-rules-v1', sha: '0'.repeat(64) },
};

export function createKbMock(opts: MockOptions = {}): Hono {
  const fx: any = JSON.parse(readFileSync(opts.fixturePath ?? defaultFixture, 'utf8'));
  const bug = opts.bug;
  const epoch = opts.epoch ?? fx.meta.epoch;
  const now = ts(fx.meta.data_as_of);
  const startedAt = Date.now();
  const removed = new Set<string>(fx.removed_snapshots ?? []);
  const changesCursor = (seq: number) => Buffer.from(JSON.stringify({ e: epoch, s: seq })).toString('base64url');

  // ---- data
  const nodeRows: Row[] = [...fx.nodes, ...fx.claims];
  const byId = new Map<string, Row[]>();
  for (const r of nodeRows) (byId.get(r.id) ?? byId.set(r.id, []).get(r.id)!).push(r);
  for (const l of byId.values()) l.sort((a, b) => a.version - b.version);
  const edgeById = new Map<string, Row[]>();
  for (const r of fx.edges) (edgeById.get(r.id) ?? edgeById.set(r.id, []).get(r.id)!).push(r);
  for (const l of edgeById.values()) l.sort((a, b) => a.version - b.version);
  const latest = (id: string) => byId.get(id)?.at(-1);
  const snapById = new Map<string, Row>(fx.snapshots.map((s: Row) => [s.id, s]));
  const finalOf = (id: string): string[] => nodeRows.filter((r) => r.merged_into_final === id).map((r) => r.id).filter((v, i, a) => a.indexOf(v) === i);

  // ---- visibility (C 2.7, 2.8, 2.9)
  type Ctx = { V: number | null; O: number; vStr: string | null; oStr: string | null };
  const NOW: Ctx = { V: null, O: now, vStr: null, oStr: null };
  const ctxOf = (q: URLSearchParams, hasAxes: boolean): Ctx => {
    const vStr = hasAxes ? q.get('as_of_valid') : null, oStr = hasAxes ? q.get('as_of_observed') : null;
    // Default read: observed axis is now, valid axis is not applied (C 2.9, KB ADR 7.4).
    return { vStr, oStr, O: oStr && bug !== 'ignore_as_of' ? ts(oStr) : now, V: vStr && bug !== 'ignore_as_of' ? ts(vStr) : null };
  };
  const covers = (r: Row, c: Ctx) =>
    ts(r.recorded_at) <= c.O && (r.expired_at == null || ts(r.expired_at) > c.O) &&
    (c.V === null || ((r.valid?.from == null || ts(r.valid.from) <= c.V) && (r.valid?.to == null || ts(r.valid.to) > c.V)));
  const sensRank = (v: string | undefined) => SENS.indexOf(v ?? 'public');
  // Sensitivity is judged on the latest version of the id (KB ADR 1.3, C 2.7). Hidden and absent look the same.
  const hidden = (id: string) => bug !== 'leak_private' && sensRank(latest(id)?.sensitivity) > 1;
  const pick = (id: string, c: Ctx): Row | undefined => byId.get(id)?.find((r) => covers(r, c));
  const heads = (c: Ctx): Row[] => [...byId.keys()].filter((id) => !hidden(id)).map((id) => pick(id, c)).filter((r): r is Row => !!r);
  // state and howto claims inherit dead or superseded from their subject unless the subject was merged (C 2.7).
  const effStatus = (r: Row, c: Ctx): string => {
    if (r.type !== 'Claim' || r.kind === 'event') return r.status;
    const s = pick(r.subject, c) ?? latest(r.subject);
    if (s && (s.status === 'dead' || s.status === 'superseded') && !s.merged_into) return s.status;
    return r.status;
  };
  const outRow = (r: Row, c: Ctx) => (r.type === 'Claim' ? { ...r, status: effStatus(r, c) } : r);
  const sourcesOf = (r: Row): string[] => r.type === 'Snapshot' ? [snapById.get(r.id)?.source.id].filter(Boolean) : r.type === 'Claim' ? [...new Set<string>((r.evidence ?? []).map((e: Row) => snapById.get(e.snapshot_id)?.source.id).filter(Boolean))] : [];

  type Axis = 'type' | 'origin' | 'status' | 'domain' | 'source';
  type Filters = { types: Set<string> | null; origin: Set<string> | null; domain: Set<string> | null; source: Set<string> | null; author: Set<string> | null; status: string; unverified: boolean; exprs: [string, string, string][] };
  const list = (v: string | null) => (v ? new Set(v.split(',').filter(Boolean)) : null);
  const filtersOf = (q: URLSearchParams): Filters => ({
    types: list(q.get('types') ?? q.get('type')), origin: list(q.get('origin')), domain: list(q.get('domain')), source: list(q.get('source')), author: list(q.get('author')),
    status: q.get('status') ?? 'active', unverified: q.get('include_unverified') === 'true',
    exprs: q.getAll('filter').map((x) => { const [n, o, ...v] = x.split(':'); return [n ?? '', o ?? '', v.join(':')] as [string, string, string]; }),
  });
  const OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'prefix'];
  const filterable = new Set<string>((fx.schema.node_types as Row[]).flatMap((t) => (t.properties as Row[]).filter((p) => p.filterable).map((p) => p.name)));
  const badFilter = (f: Filters) => f.exprs.find(([n, o]) => !filterable.has(n) || !OPS.includes(o));
  const cmp = (a: string, b: string) => (a !== '' && b !== '' && !Number.isNaN(Number(a)) && !Number.isNaN(Number(b)) ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0);
  const exprOk = (r: Row, [n, o, v]: [string, string, string]) => {
    const x = String(r.props?.[n] ?? '');
    return o === 'eq' ? x === v : o === 'ne' ? x !== v : o === 'lt' ? cmp(x, v) < 0 : o === 'lte' ? cmp(x, v) <= 0 : o === 'gt' ? cmp(x, v) > 0 : o === 'gte' ? cmp(x, v) >= 0 : o === 'in' ? v.split(',').includes(x) : x.startsWith(v);
  };
  const passes = (r: Row, f: Filters, c: Ctx, o: { listing: boolean; defaultTypes?: boolean; skip?: Axis }): boolean => {
    if (o.skip !== 'type' && (f.types ? !f.types.has(r.type) : o.defaultTypes && NON_WORLD.has(r.type))) return false;
    if (o.skip !== 'origin' && f.origin && !f.origin.has(r.origin)) return false;
    if (o.skip !== 'domain' && f.domain && !(r.domain ?? []).some((d: string) => f.domain!.has(d))) return false;
    if (o.skip !== 'source' && f.source && !sourcesOf(r).some((x) => f.source!.has(x))) return false;
    if (f.author && !f.author.has(r.author ?? '')) return false;
    if (o.listing && r.merged_into) return false;
    if (o.skip !== 'status' && f.status !== 'all' && effStatus(r, c) !== f.status) return false;
    if (!f.unverified && r.type === 'Claim' && !ALLOWED_VERIFICATION.has(r.verification)) return false;
    return f.exprs.every((e) => exprOk(r, e));
  };
  // Edge sensitivity is the maximum of both ends and the claim (C 2.7). Hidden ends never leak through edges.in.
  const edgeVisible = (e: Row) => sensRank(e.sensitivity) <= 1 && !hidden(e.src) && !hidden(e.dst) && (!e.claim_id || !hidden(e.claim_id));
  const edgeHeads = (c: Ctx, status: string): Row[] =>
    [...edgeById.keys()].map((id) => edgeById.get(id)!.find((r) => covers(r, c))).filter((r): r is Row => !!r && edgeVisible(r) && (status === 'all' || r.status === status));
  // `edge_status` is a comma list and falls back to `status` (C 2.7). It narrows edges only: the node set does not change.
  const edgeHeadsIn = (c: Ctx, q: URLSearchParams, status: string): Row[] => {
    const wanted = (q.get('edge_status') ?? status).split(',');
    return edgeHeads(c, 'all').filter((e) => wanted.includes('all') || wanted.includes(e.status));
  };
  const edgeRef = (e: Row) => ({ id: e.id, rtype: e.rtype, src: e.src, dst: e.dst, status: e.status, claim_id: e.claim_id ?? null });

  // ---- responses
  const problem = (c: Context, status: number, code: string, title: string, detail?: string, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ type: `https://kb.local/problems/${code.replace(/_/g, '-')}`, title, status, ...(detail ? { detail } : {}), code, instance: new URL(c.req.url).pathname }), {
      status, headers: { 'content-type': bug === 'wrong_error_type' ? 'text/plain' : 'application/problem+json', ...headers },
    });

  const validators = new Map<string, ReturnType<typeof schemaOf>>();
  const respValidator = (op: Op) => {
    let v = validators.get(op.operationId);
    if (!v) { v = schemaOf(op.op.responses['200'].content['application/json'].schema); validators.set(op.operationId, v); }
    return v;
  };
  const instant = (v: string | null) => (v === null ? null : new Date(ts(v)).toISOString().replace('.000Z', 'Z'));
  const matches = (c: Context, etag: string) => (c.req.header('if-none-match') ?? '').split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
  const dataEtag = `"${epoch}-${fx.meta.applied_seq}-${fx.meta.build_id}"`;

  type Out = { data: unknown; page?: { next_cursor: string | null; total: number | null; truncated: boolean }; etag?: string | null };
  const envelope = (op: Op, c: Context, ctx: Ctx, out: Out): Response => {
    const body: Row = {
      schema_version: fx.meta.schema_version, epoch, build_id: fx.meta.build_id, data_as_of: fx.meta.data_as_of, applied_seq: fx.meta.applied_seq,
      // Envelope.as_of is date-time, while as_of_valid also takes YYYY-MM-DD. The echo is the normalized instant (guess).
      as_of: { valid: instant(ctx.vStr), observed: instant(ctx.oStr) }, degraded: [], data: out.data, ...(out.page ? { page: out.page } : {}),
    };
    if (bug === 'drop_field') delete body.applied_seq;
    if (!bug) {
      const check = respValidator(op);
      if (!check(body)) return problem(c, 500, 'internal', 'mock response violates the KB spec', JSON.stringify(check.errors?.slice(0, 3)));
    }
    const headers: Record<string, string> = { 'content-type': 'application/json', 'cache-control': 'no-cache', vary: 'Authorization' };
    if (out.etag !== null) {
      const etag = out.etag ?? dataEtag;
      if (matches(c, etag)) return new Response(null, { status: 304, headers: { ETag: etag, vary: 'Authorization' } });
      headers.ETag = etag;
    }
    return new Response(JSON.stringify(body), { status: 200, headers });
  };

  // ---- cursors (C 2.4): opaque base64url {k: sort key or rank position, h: filter hash, e: epoch}
  const filterHash = (q: URLSearchParams) => {
    const pairs = [...q.entries()].filter(([k]) => k !== 'cursor' && k !== 'limit' && k !== 'edge_limit').sort(([a, x], [b, y]) => (a + x).localeCompare(b + y));
    return sha1(JSON.stringify(pairs));
  };
  const encodeCursor = (k: string, h: string) => Buffer.from(JSON.stringify({ k, h, e: epoch })).toString('base64url');
  type CursorResult = { ok: true; after: string | null } | { ok: false; res: Response };
  const readCursor = (c: Context, q: URLSearchParams): CursorResult => {
    const raw = q.get('cursor');
    if (raw === null) return { ok: true, after: null };
    let cur: any;
    try { cur = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { cur = null; }
    if (!cur || typeof cur.k !== 'string' || typeof cur.h !== 'string' || typeof cur.e !== 'number') return { ok: false, res: problem(c, 400, 'bad_param', 'invalid cursor', 'cursor is not a cursor this server issued') };
    if (cur.e !== epoch) return { ok: false, res: problem(c, 410, 'epoch_changed', 'epoch changed', 'resync through the export') };
    if (cur.h !== filterHash(q) && bug !== 'no_cursor_check') return { ok: false, res: problem(c, 400, 'cursor_mismatch', 'cursor does not match filters', 'cursor was made with different filters') };
    return { ok: true, after: cur.k };
  };
  const paginate = <T,>(c: Context, q: URLSearchParams, rows: T[], key: (r: T) => string, limit: number, total: number | null | 'rows' = 'rows', desc = false): { items: T[]; page: NonNullable<Out['page']> } | Response => {
    const cur = readCursor(c, q);
    if (!cur.ok) return cur.res;
    const dir = desc ? -1 : 1;
    const sorted = [...rows].sort((a, b) => dir * (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    const rest = cur.after === null ? sorted : sorted.filter((r) => (desc ? key(r) < cur.after! : key(r) > cur.after!));
    const items = rest.slice(0, limit);
    const more = rest.length > items.length;
    const last = items.at(-1);
    const t = total === 'rows' ? rows.length : total;
    return { items, page: { next_cursor: more && last ? encodeCursor(key(last), filterHash(q)) : null, total: opts.totalNull ? null : t, truncated: more } };
  };
  const limitOf = (q: URLSearchParams, def: number) => Number(q.get('limit') ?? def);

  // ---- text helpers (code points, C 2.11, 4.8)
  const nfc = (s: string) => s.normalize('NFC');
  const tokensOf = (qs: string) => nfc(qs).toLowerCase().split(/\s+/).filter(Boolean);
  const has = (hay: string, tokens: string[]) => tokens.every((t) => nfc(hay).toLowerCase().includes(t));
  const highlightsOf = (snippet: string, tokens: string[]) => {
    const hay = cp(snippet.toLowerCase()), out: { start: number; end: number }[] = [];
    for (const t of tokens) {
      const needle = cp(t);
      for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((ch, j) => hay[i + j] === ch)) { out.push({ start: i, end: i + needle.length }); i += needle.length - 1; }
    }
    return out.sort((a, b) => a.start - b.start);
  };
  const locate = (text: string, token: string) => {
    const low = cp(text.toLowerCase()), needle = cp(token);
    for (let i = 0; i + needle.length <= low.length; i++) if (needle.every((ch, j) => low[i + j] === ch)) return { at: i, len: needle.length };
    return { at: 0, len: needle.length };
  };
  const snippetAround = (text: string, tokens: string[]) => {
    const chars = cp(text);
    const { at, len } = locate(text, tokens[0] ?? '');
    const from = Math.max(0, at - 20), to = Math.min(chars.length, at + len + 40);
    return `${from > 0 ? '…' : ''}${chars.slice(from, to).join('')}${to < chars.length ? '…' : ''}`;
  };
  const window = (text: string, q: URLSearchParams) => {
    const chars = cp(text), start = Number(q.get('start') ?? 0), max = Number(q.get('max_chars') ?? 20000);
    return { chars, start, end: Math.min(chars.length, start + max), text: chars.slice(start, start + max).join('') };
  };

  // ---- export files, built once (C 5)
  const nodeGroup = (type: string) => (fx.schema.node_types as Row[]).find((t) => t.name === type)?.group ?? 'world';
  const edgeGroup = (rtype: string) => (fx.schema.edge_types as Row[]).find((t) => t.name === rtype)?.group ?? 'fact';
  const graphFile = (profile: 'core' | 'full') => {
    const core = profile === 'core';
    const all = [...byId.keys()].filter((id) => !hidden(id)).map((id) => latest(id)!);
    const ns = all.filter((r) => (core ? ['world', 'user'].includes(nodeGroup(r.type)) || r.type === 'Series' : !['Ticket'].includes(r.type)))
      .filter((r) => (core ? r.status === 'active' && !r.merged_into : r.type !== 'Claim' || ALLOWED_VERIFICATION.has(r.verification)));
    const ids = new Set(ns.map((r) => r.id));
    const fin = (id: string) => (core ? (latest(id)?.merged_into_final ?? id) : id);
    const es = [...edgeById.values()].map((l) => l.at(-1)!).filter(edgeVisible).filter((e) => (core ? e.status === 'active' && ['structure', 'user', 'change', 'fact'].includes(edgeGroup(e.rtype)) : true))
      .map((e): Row => ({ ...e, src: fin(e.src), dst: fin(e.dst) })).filter((e) => ids.has(e.src) && ids.has(e.dst));
    const file = {
      schema_version: fx.meta.schema_version, build_id: `p-${String(fx.meta.applied_seq).padStart(9, '0')}`, applied_seq: fx.meta.applied_seq, epoch, data_as_of: fx.meta.data_as_of,
      graph: { directed: true, multi: true },
      nodes: { columns: ['id', 'type', 'label', 'origin', 'status', 'domain', 'merged_into'], rows: ns.sort(byIdAsc).map((r) => [r.id, r.type, r.label, r.origin, r.status, r.domain ?? [], r.merged_into ?? null]) },
      edges: { columns: ['id', 'src', 'dst', 'rtype'], rows: es.sort(byIdAsc).map((e) => [e.id, e.src, e.dst, e.rtype]) },
    };
    const bytes = zstdCompressSync(Buffer.from(JSON.stringify(file)));
    return { file, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const exports = { core: graphFile('core'), full: graphFile('full') };

  // ---- handlers. Each gets the parsed query and the time context.
  type H = (c: Context, q: URLSearchParams, ctx: Ctx, op: Op) => Response;
  const idParam = (c: Context) => c.req.param('id' as never) as string;
  const H: Record<string, H> = {
    getMeta: (c, _q, ctx, op) => {
      const hs = heads(NOW);
      const degraded: string[] = [];
      return envelope(op, c, ctx, {
        etag: `"${epoch}-${fx.meta.applied_seq}-${fx.meta.build_id}-${sha1(JSON.stringify(degraded), 8)}"`,
        data: { ...fx.meta.data, ...(fx.meta.data.first_party_open ? { write: opts.write ? writeMeta(opts.write) : MOCK_WRITE_STATE } : {}), changes_cursor: changesCursor(fx.meta.applied_seq), counts: { nodes: hs.filter((r) => !NON_WORLD.has(r.type)).length, edges: edgeHeads(NOW, 'all').length, claims: hs.filter((r) => r.type === 'Claim').length } },
      });
    },
    getSchema: (c, _q, ctx, op) => envelope(op, c, ctx, { data: fx.schema }),
    getOverview: (c, q, ctx, op) => {
      const f = filtersOf(q);
      const nodes = heads(ctx).filter((r) => passes(r, f, ctx, { listing: true, defaultTypes: true })).sort(byIdAsc);
      const limit = limitOf(q, 50000), edgeLimit = Number(q.get('edge_limit') ?? 200000);
      const rank = new Map(nodes.map((r, i) => [r.id, i]));
      const rt = list(q.get('rtypes'));
      const closed = edgeHeadsIn(ctx, q, f.status).filter((e) => (!rt || rt.has(e.rtype)) && rank.has(e.src) && rank.has(e.dst));
      // An edge travels with the later of its two ends, so the union of pages is closed (C 2.12).
      const byLater = new Map<number, Row[]>();
      for (const e of closed) { const k = Math.max(rank.get(e.src)!, rank.get(e.dst)!); (byLater.get(k) ?? byLater.set(k, []).get(k)!).push(e); }
      const cur = readCursor(c, q);
      if (!cur.ok) return cur.res;
      let i = cur.after === null ? 0 : nodes.findIndex((r) => r.id > cur.after!);
      if (i < 0) i = nodes.length;
      const pageNodes: Row[] = [], pageEdges: Row[] = [];
      while (i < nodes.length && pageNodes.length < limit) {
        const add = byLater.get(i) ?? [];
        if (pageNodes.length > 0 && pageEdges.length + add.length > edgeLimit) break;
        pageNodes.push(nodes[i]!); pageEdges.push(...add); i++;
      }
      const more = i < nodes.length;
      return envelope(op, c, ctx, {
        data: {
          meta: { graph: { directed: true, multi: true }, order: 'id_asc', node_total: nodes.length, edge_total: closed.length, truncated: more },
          nodes: { columns: ['id', 'type', 'label', 'origin', 'status'], rows: pageNodes.map((r) => [r.id, r.type, r.label, r.origin, effStatus(r, ctx)]) },
          edges: { columns: ['id', 'src', 'dst', 'rtype', 'status'], rows: pageEdges.sort(byIdAsc).map((e) => [e.id, e.src, e.dst, e.rtype, e.status]) },
        },
        page: { next_cursor: more ? encodeCursor(pageNodes.at(-1)!.id, filterHash(q)) : null, total: opts.totalNull ? null : nodes.length, truncated: more },
      });
    },
    listNodes: (c, q, ctx, op) => {
      const f = filtersOf(q);
      if (badFilter(f)) return problem(c, 400, 'bad_param', 'invalid filter', 'filter is name:op:value with a filterable property and op in eq, ne, lt, lte, gt, gte, in, prefix');
      const rows = heads(ctx).filter((r) => passes(r, f, ctx, { listing: true }));
      const sort = q.get('sort') ?? 'id';
      const sortKey = sort.replace(/^-/, '');
      const allowed = new Set(Object.values<string[]>(fx.schema.sort_keys).flat());
      if (!allowed.has(sortKey)) return problem(c, 400, 'bad_param', 'invalid sort', `sort must be one of ${[...allowed].join(', ')}`);
      // Only sort=id is stable across pages (C 2.4). Other keys page by (value, id) and may skip or repeat under change.
      const key = (r: Row) => (sortKey === 'id' ? r.id : `${String(r[sortKey] ?? '')}\u0000${r.id}`);
      const p = paginate(c, q, rows, key, limitOf(q, 100), 'rows', sort.startsWith('-'));
      if (p instanceof Response) return p;
      return envelope(op, c, ctx, { data: { items: p.items.map((r) => outRow(r, ctx)) }, page: p.page });
    },
    getNode: (c, q, ctx, op) => {
      const id = idParam(c);
      const all = byId.get(id);
      if (!all || hidden(id)) return problem(c, 404, 'not_found', 'not found');
      // Direct lookup always answers for superseded, dead and merged ids (C 2.7). With a time axis the row must cover it.
      const row = q.has('as_of_valid') || q.has('as_of_observed') ? pick(id, ctx) : (pick(id, ctx) ?? all.at(-1));
      if (!row) return problem(c, 404, 'not_found', 'not found at that time');
      const include = new Set((q.get('include') ?? 'claims,edges').split(',').filter(Boolean));
      for (const i of include) if (!['claims', 'edges', 'backlinks', 'body'].includes(i)) return problem(c, 400, 'bad_param', 'invalid include', i);
      const f = filtersOf(q);
      const data: Row = { ...outRow(row, ctx) };
      // The final target of a merge also carries the claims and edges of the ids merged into it (C 2.7).
      const ids = new Set([id, ...(row.merged_into ? [] : finalOf(id))]);
      if (include.has('claims')) {
        const limit = Number(q.get('claim_limit') ?? 50);
        const cl = heads(ctx).filter((r) => r.type === 'Claim' && ids.has(r.subject) && passes(r, f, ctx, { listing: false })).sort(byIdAsc);
        data.claims = cl.slice(0, limit).map((r) => outRow(r, ctx));
        data.claims_truncated = cl.length > limit;
      }
      const es = edgeHeads(ctx, f.status);
      if (include.has('edges')) {
        const limit = Number(q.get('edge_limit') ?? 100);
        const mine = es.filter((e) => ids.has(e.src) || ids.has(e.dst)).sort(byIdAsc);
        const cut = mine.slice(0, limit);
        data.edges = { out: cut.filter((e) => ids.has(e.src)).map(edgeRef), in: cut.filter((e) => ids.has(e.dst) && !ids.has(e.src)).map(edgeRef), truncated: mine.length > limit };
      }
      if (include.has('backlinks')) {
        const bl = es.filter((e) => ids.has(e.dst) && ['LINKS_TO', 'MENTIONS'].includes(e.rtype)).sort(byIdAsc);
        data.backlinks = bl.slice(0, 100).map((e) => { const s = latest(e.src)!; return { id: s.id, type: s.type, label: s.label, rtype: e.rtype }; });
        data.backlinks_truncated = bl.length > 100;
      }
      if (include.has('body')) {
        const b: string | undefined = fx.meta.data.first_party_open ? fx.record_bodies[id] : undefined;
        data.body = b ? cp(b).slice(0, 200000).join('') : null;
        data.body_chars = b ? cp(b).length : null;
      }
      return envelope(op, c, ctx, { data });
    },
    listNodeClaims: (c, q, ctx, op) => {
      const id = idParam(c);
      if (!byId.has(id) || hidden(id)) return problem(c, 404, 'not_found', 'not found');
      const f = filtersOf(q);
      const ids = new Set([id, ...(latest(id)?.merged_into ? [] : finalOf(id))]);
      const rows = heads(ctx).filter((r) => r.type === 'Claim' && ids.has(r.subject) && passes(r, f, ctx, { listing: false }));
      const p = paginate(c, q, rows, (r) => r.id, limitOf(q, 100));
      if (p instanceof Response) return p;
      return envelope(op, c, ctx, { data: { items: p.items.map((r) => outRow(r, ctx)) }, page: p.page });
    },
    listNodeEdges: (c, q, ctx, op) => {
      const id = idParam(c);
      if (!byId.has(id) || hidden(id)) return problem(c, 404, 'not_found', 'not found');
      const f = filtersOf(q), dir = q.get('direction') ?? 'both', rt = list(q.get('rtypes'));
      const ids = new Set([id, ...(latest(id)?.merged_into ? [] : finalOf(id))]);
      const rows = edgeHeads(ctx, f.status).filter((e) => (!rt || rt.has(e.rtype)) && ((dir !== 'in' && ids.has(e.src)) || (dir !== 'out' && ids.has(e.dst))));
      const p = paginate(c, q, rows, (r) => r.id, limitOf(q, 100));
      if (p instanceof Response) return p;
      return envelope(op, c, ctx, { data: { items: p.items.map(edgeRef) }, page: p.page });
    },
    getNodeBody: (c, q, ctx, op) => {
      const id = idParam(c);
      const row = latest(id);
      const b: string | undefined = fx.record_bodies[id];
      if (!row || hidden(id) || b === undefined || !fx.meta.data.first_party_open) return problem(c, 404, 'not_found', 'not found');
      const w = window(b, q);
      if (w.start > w.chars.length) return problem(c, 400, 'bad_param', 'start is beyond the body');
      return envelope(op, c, ctx, { data: { text: w.text, start: w.start, end: w.end, total_chars: w.chars.length, body_format: row.body_format ?? null } });
    },
    getNodeNeighbors: (c, q, ctx, op) => {
      const id = idParam(c);
      if (!byId.has(id) || hidden(id)) return problem(c, 404, 'not_found', 'not found');
      const f = filtersOf(q);
      const depth = Number(q.get('depth') ?? 1), dir = q.get('direction') ?? 'both', limit = limitOf(q, 200), rt = list(q.get('rtypes'));
      const es = edgeHeadsIn(ctx, q, f.status).filter((e) => !rt || rt.has(e.rtype));
      const ok = (nid: string) => { const r = pick(nid, ctx); return !!r && passes(r, f, ctx, { listing: true, defaultTypes: true }); };
      const reached = new Set([id]); let frontier = [id];
      for (let d = 0; d < depth; d++) {
        const next: string[] = [];
        for (const e of es) for (const [a, b, allowed] of [[e.src, e.dst, dir !== 'in'], [e.dst, e.src, dir !== 'out']] as const)
          if (allowed && frontier.includes(a) && !reached.has(b) && ok(b)) { reached.add(b); next.push(b); }
        frontier = next;
      }
      // limit counts nodes and cuts by id ascending; the root stays (C 4.6)
      const sorted = [...reached].sort();
      const kept = new Set([id, ...sorted.filter((x) => x !== id).slice(0, Math.max(0, limit - 1))]);
      const ns = [...kept].sort().map((nid) => pick(nid, ctx) ?? latest(nid)!);
      const closedAll = es.filter((e) => reached.has(e.src) && reached.has(e.dst));
      const closed = es.filter((e) => kept.has(e.src) && kept.has(e.dst)).sort(byIdAsc);
      return envelope(op, c, ctx, { data: {
        nodes: { columns: ['id', 'type', 'label', 'origin', 'status'], rows: ns.map((r) => [r.id, r.type, r.label, r.origin, effStatus(r, ctx)]) },
        edges: { columns: ['id', 'src', 'dst', 'rtype', 'status'], rows: closed.map((e) => [e.id, e.src, e.dst, e.rtype, e.status]) },
        truncated: kept.size < reached.size, node_total: reached.size, edge_total: closedAll.length,
      } });
    },
    getNodeHistory: (c, q, ctx, op) => {
      const id = idParam(c);
      if (!byId.has(id) || hidden(id)) return problem(c, 404, 'not_found', 'not found');
      const versions = byId.get(id)!.map((r) => ({ version: r.version, label: r.label, status: r.status, recorded_at: r.recorded_at, expired_at: r.expired_at ?? null }));
      const sup = fx.edges.filter((e: Row) => e.rtype === 'SUPERSEDES');
      const supersededBy = new Map<string, string>(sup.map((e: Row) => [e.dst, e.src]));
      const claimIds = new Set<string>(fx.claims.map((x: Row) => x.id));
      const slot = (r: Row) => sha1(`${r.subject}|${r.predicate}|${JSON.stringify(r.qualifiers ?? {})}`, 6);
      // A chain is every version of every claim with the same subject, predicate and qualifiers (the slot).
      const base: Row[] = claimIds.has(id) ? [latest(id)!] : fx.claims.filter((x: Row) => x.subject === id);
      const slots = new Map<string, Row>();
      for (const r of base) if (r.predicate && !hidden(r.id)) slots.set(`${r.predicate}|${slot(r)}`, r);
      const pred = q.get('predicate');
      const chains = [...slots.values()].filter((r) => !pred || r.predicate === pred).map((r) => {
        const ids = [...claimIds].filter((x) => { const l = latest(x)!; return !hidden(x) && l.subject === r.subject && l.predicate === r.predicate && slot(l) === slot(r); });
        const items = ids.flatMap((x) => byId.get(x)!.map((v) => ({ id: v.id, version: v.version, status: v.status, value: v.value ?? null, unit: v.unit ?? null, valid: v.valid, recorded_at: v.recorded_at, expired_at: v.expired_at ?? null, superseded_by: v === latest(x) ? (supersededBy.get(x) ?? null) : null })))
          .sort((a, b) => (a.recorded_at < b.recorded_at ? -1 : a.recorded_at > b.recorded_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version));
        return { predicate: r.predicate, slot: slot(r), items };
      }).sort((a, b) => (a.slot < b.slot ? -1 : 1));
      const inChain = new Set(chains.flatMap((ch) => ch.items.map((i) => i.id)));
      const edges = sup.filter((e: Row) => inChain.has(e.src) || inChain.has(e.dst)).filter(edgeVisible).map(edgeRef);
      return envelope(op, c, ctx, { data: { id, versions, chains, edges } });
    },
    getClaim: (c, q, ctx, op) => {
      const id = idParam(c);
      const all = byId.get(id);
      if (!all || all[0]?.type !== 'Claim' || hidden(id)) return problem(c, 404, 'not_found', 'not found');
      const row = q.has('as_of_valid') || q.has('as_of_observed') ? pick(id, ctx) : (pick(id, ctx) ?? all.at(-1));
      return row ? envelope(op, c, ctx, { data: { ...outRow(row, ctx), versions: all } }) : problem(c, 404, 'not_found', 'not found at that time');
    },
    getEdge: (c, q, ctx, op) => {
      const id = idParam(c);
      const all = edgeById.get(id);
      if (!all || !edgeVisible(all.at(-1)!)) return problem(c, 404, 'not_found', 'not found');
      const row = q.has('as_of_valid') || q.has('as_of_observed') ? all.find((r) => covers(r, ctx)) : (all.find((r) => covers(r, ctx)) ?? all.at(-1));
      if (!row) return problem(c, 404, 'not_found', 'not found at that time');
      const cl = row.claim_id && !hidden(row.claim_id) ? (pick(row.claim_id, ctx) ?? latest(row.claim_id)) : null;
      return envelope(op, c, ctx, { data: { ...row, versions: all, claim: cl ? outRow(cl, ctx) : null } });
    },
    search: (c, q, ctx, op) => {
      const f = filtersOf(q);
      const kinds = new Set((q.get('kinds') ?? 'claim,record,entity,passage').split(','));
      const tokens = tokensOf(q.get('q') ?? '');
      if (tokens.length === 0) return problem(c, 400, 'bad_param', 'q has no token after normalization');
      const KIND_ORDER = ['claim', 'record', 'entity', 'passage'];
      const hits: { kindIdx: number; item: Row }[] = [];
      for (const r of heads(ctx)) {
        const kind = r.type === 'Claim' ? 'claim' : r.id.startsWith('f-') ? 'record' : ['Snapshot', 'Source', 'Series'].includes(r.type) ? null : 'entity';
        if (!kind || !kinds.has(kind) || !passes(r, f, ctx, { listing: true })) continue;
        const title = r.type === 'Claim' ? r.statement : r.label;
        const hay = `${title} ${r.value ?? ''}`;
        if (!has(hay, tokens)) continue;
        const snippet = snippetAround(hay, tokens);
        const src = r.evidence?.[0] ? snapById.get(r.evidence[0].snapshot_id)?.source : undefined;
        const common = { id: r.id, kind, type: r.type, title, snippet, highlights: highlightsOf(snippet, tokens), highlight_unit: 'codepoint', origin: r.origin, status: effStatus(r, ctx), recorded_at: r.recorded_at };
        const extra = kind === 'claim' ? { subject: r.subject, verification: r.verification ?? null, source: src ? { id: src.id, label: src.label } : { id: 'src:unknown', label: 'unknown' } }
          : kind === 'record' ? { author: r.author ?? null, sensitivity: r.sensitivity }
          : { liveness: r.liveness ?? null };
        hits.push({ kindIdx: KIND_ORDER.indexOf(kind), item: { ...common, ...extra } });
      }
      if (kinds.has('passage'))
        for (const s of fx.snapshots as Row[]) {
          const text: string = fx.bodies[s.id].text;
          const node = latest(s.id)!;
          if (hidden(s.id) || removed.has(s.id) || !has(text, tokens) || !passes({ ...node, status: 'active', origin: 'external' }, f, ctx, { listing: true, skip: 'type' }) || (f.types && !f.types.has('Snapshot'))) continue;
          const { at, len } = locate(text, tokens[0]!);
          const snippet = snippetAround(text, tokens);
          hits.push({ kindIdx: 3, item: { id: s.id, kind: 'passage', type: 'Snapshot', title: s.url, snippet, highlights: highlightsOf(snippet, tokens), highlight_unit: 'codepoint', origin: 'external', status: 'active', snapshot_id: s.id, start: at, end: at + len, source: { id: s.source.id, label: s.source.label }, recorded_at: s.fetched_at } });
        }
      // total: null when only default filters apply and there is no as-of (C 2.4, 4.8); exact otherwise.
      const exact = ['types', 'origin', 'status', 'domain', 'source', 'author'].some((k) => q.has(k)) || q.has('as_of_valid') || q.has('as_of_observed');
      const p = paginate(c, q, hits, (h) => `${h.kindIdx}|${h.item.id}`, limitOf(q, 50), exact ? 'rows' : null);
      if (p instanceof Response) return p;
      return envelope(op, c, ctx, { data: { items: p.items.map((h) => h.item) }, page: p.page });
    },
    getFacets: (c, q, ctx, op) => {
      const f = filtersOf(q);
      const tokens = q.has('q') ? tokensOf(q.get('q')!) : null;
      if (tokens && tokens.length === 0) return problem(c, 400, 'bad_param', 'q has no token after normalization');
      const text = (r: Row) => `${r.type === 'Claim' ? r.statement : r.label} ${r.value ?? ''}`;
      const base = heads(ctx).filter((r) => !tokens || has(text(r), tokens));
      const matching = (skip?: Axis) => base.filter((r) => passes(r, f, ctx, { listing: true, defaultTypes: true, ...(skip ? { skip } : {}) }));
      // Each axis counts with its own filter removed, so a multi-select UI can be driven directly (C 4.9).
      const count = (axis: Axis, get: (r: Row) => string[]) => {
        const m = new Map<string, number>();
        for (const r of matching(axis)) for (const k of get(r)) m.set(k, (m.get(k) ?? 0) + 1);
        return [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([value, n]) => ({ value, ...(axis === 'source' ? { label: (fx.snapshots as Row[]).find((s) => s.source.id === value)?.source.label } : {}), count: n }));
      };
      return envelope(op, c, ctx, { data: { total: matching().length, facets: {
        type: count('type', (r) => [r.type]), origin: count('origin', (r) => [r.origin]), status: count('status', (r) => [effStatus(r, ctx)]),
        source: count('source', sourcesOf), domain: count('domain', (r) => r.domain ?? []),
      } } });
    },
    getCounts: (c, q, ctx, op) => {
      const f = filtersOf(q);
      const bucket = q.get('bucket') ?? 'week', field = q.get('field') ?? 'recorded_at';
      const startOf = (iso: string | null) => {
        if (!iso) return null;
        const d = new Date(ts(iso));
        if (bucket === 'month') d.setUTCDate(1);
        if (bucket === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
        d.setUTCHours(0, 0, 0, 0);
        return d.toISOString().replace('.000Z', 'Z');
      };
      const m = new Map<string, number>();
      for (const r of heads(ctx).filter((r) => passes(r, f, ctx, { listing: true, defaultTypes: true }))) {
        const s = startOf(field === 'valid_from' ? (r.valid?.from ?? null) : r.recorded_at);
        if (s) m.set(s, (m.get(s) ?? 0) + 1);
      }
      return envelope(op, c, ctx, { data: { bucket, field, series: [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([start, count]) => ({ start, count })) } });
    },
    getSeries: (c, q, ctx, op) => {
      const id = idParam(c);
      const s = (fx.series as Row[]).find((x) => x.id === id);
      if (!s || hidden(id)) return problem(c, 404, 'not_found', 'not found');
      const from = q.get('from') ? ts(q.get('from')!) : -Infinity, to = q.get('to') ? ts(q.get('to')!) : Infinity;
      const points = (s.points as Row[]).filter((p) => ts(p.observed_at) <= ctx.O && (ctx.V === null || ts(p.start) <= ctx.V) && ts(p.end) > from && ts(p.start) < to);
      return envelope(op, c, ctx, { data: { ...s, points } });
    },
    getSnapshot: (c, _q, ctx, op) => {
      const id = idParam(c);
      const s = snapById.get(id);
      if (!s || hidden(id)) return problem(c, 404, 'not_found', 'not found');
      const citing = heads(NOW).filter((r) => r.type === 'Claim' && r.status === 'active').flatMap((r) => (r.evidence ?? []).filter((e: Row) => e.snapshot_id === id).map((e: Row) => ({ id: r.id, start: e.start ?? null, end: e.end ?? null })));
      return envelope(op, c, ctx, { data: { ...s, citing_claims: citing } });
    },
    getSnapshotText: (c, q, ctx, op) => {
      const id = idParam(c);
      const s = snapById.get(id);
      if (!s || hidden(id)) return problem(c, 404, 'not_found', 'not found');
      if (removed.has(id)) return problem(c, 410, 'content_removed', 'content removed');
      if (s.text_chars === 0) return problem(c, 404, 'not_found', 'no display body');
      const w = window(fx.bodies[id].text, q);
      if (w.start > w.chars.length) return problem(c, 400, 'bad_param', 'start is beyond the text', `total_chars is ${w.chars.length}`);
      return envelope(op, c, ctx, { etag: `"${id}"`, data: { text: w.text, start: w.start, end: w.end, total_chars: w.chars.length, text_format: s.text_format } });
    },
    getSnapshotRaw: (c) => {
      const id = idParam(c);
      const b = fx.bodies[id];
      if (!b || hidden(id)) return problem(c, 404, 'not_found', 'not found');
      if (removed.has(id)) return problem(c, 410, 'content_removed', 'content removed');
      const etag = `"${id}"`;
      if (matches(c, etag)) return new Response(null, { status: 304, headers: { ETag: etag } });
      const bytes = Buffer.from(b.raw);
      // A Range header that is not a single byte range is ignored (RFC 9110); one that is out of bounds is 416.
      const range = /^bytes=\d+-\d*$/.test(c.req.header('range') ?? '') ? c.req.header('range') : undefined;
      const base = { 'content-type': b.raw_content_type, ETag: etag, 'accept-ranges': 'bytes' };
      if (range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range);
        const a = m ? Number(m[1]) : NaN, z = m && m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1;
        if (!m || a >= bytes.length || z < a) return problem(c, 416, 'range_not_satisfiable', 'range not satisfiable', undefined, { 'content-range': `bytes */${bytes.length}` });
        return new Response(bytes.subarray(a, z + 1), { status: 206, headers: { ...base, 'content-range': `bytes ${a}-${z}/${bytes.length}` } });
      }
      return new Response(bytes, { status: 200, headers: base });
    },
    listChanges: (c, q, ctx, op) => {
      const raw = q.get('cursor');
      let after = 0;
      if (raw !== null) {
        let cur: any;
        try { cur = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { cur = null; }
        if (!cur || typeof cur.e !== 'number' || typeof cur.s !== 'number') return problem(c, 400, 'bad_param', 'invalid cursor');
        if (cur.e !== epoch || cur.s > fx.meta.applied_seq) return problem(c, 410, 'epoch_changed', 'epoch changed or cursor ahead of applied_seq', 'resync through the export');
        after = cur.s;
      }
      const kinds = list(q.get('kinds'));
      // Hidden events are skipped, but a revocation is shown to every scope so the consumer can drop its copy (C 4.12).
      const rows = (fx.changes as Row[]).filter((x) => x.seq > after && (x.kind === 'visibility.revoked' || !hidden(x.id)) && (!kinds || kinds.has(x.kind))).sort((a, b) => a.seq - b.seq);
      const limit = limitOf(q, 500);
      const items = rows.slice(0, limit);
      // next_cursor is a string even at the tail, and an empty tail returns the same cursor (C 4.12).
      const last = items.at(-1)?.seq ?? after;
      return envelope(op, c, ctx, { data: { items }, page: { next_cursor: changesCursor(last), total: null, truncated: rows.length > items.length } });
    },
    getExportManifest: (c, _q, ctx, op) => {
      if (opts.exportUnpublished) return problem(c, 503, 'not_ready', 'export has not been published', undefined, { 'Retry-After': '30' });
      const profile = (k: 'core' | 'full') => ({ path: `/v1/export/graph?profile=${k}`, bytes: exports[k].bytes.length, sha256: exports[k].sha256, nodes: exports[k].file.nodes.rows.length, edges: exports[k].file.edges.rows.length });
      return envelope(op, c, ctx, { data: { build_id: exports.core.file.build_id, applied_seq: fx.meta.applied_seq, epoch, generated_at: fx.meta.data_as_of, changes_cursor: changesCursor(fx.meta.applied_seq), profiles: { core: profile('core'), full: profile('full') } } });
    },
    getExportGraph: (c, q) => {
      if (opts.exportUnpublished) return problem(c, 503, 'not_ready', 'export has not been published', undefined, { 'Retry-After': '30' });
      const e = exports[(q.get('profile') ?? 'core') as 'core' | 'full'];
      const etag = `"${e.sha256}"`;
      if (matches(c, etag)) return new Response(null, { status: 304, headers: { ETag: etag } });
      const headers: Record<string, string> = opts.exportStyle === 'encoding' ? { 'content-type': 'application/json', 'content-encoding': 'zstd' } : { 'content-type': 'application/zstd' };
      return new Response(e.bytes, { status: 200, headers: { ...headers, ETag: etag } });
    },
    getOpsFreshness: (c, _q, ctx, op) => envelope(op, c, ctx, { etag: null, data: { classes: [{ class: 'docs', total: 2, stale: 0 }], sources: [{ source_id: 'src:cc-docs', class: 'docs', last_ok_at: fx.meta.data_as_of, state: 'ok', stale: false }], gaps: [] } }),
    listOpsTickets: (c, _q, ctx, op) => envelope(op, c, ctx, { etag: null, data: { items: [] }, page: { next_cursor: null, total: 0, truncated: false } }),
    listOpsRuns: (c, _q, ctx, op) => envelope(op, c, ctx, { etag: null, data: { items: [] }, page: { next_cursor: null, total: 0, truncated: false } }),
    getOpsMetrics: (c, _q, ctx, op) => envelope(op, c, ctx, { etag: null, data: { items: [{ name: 'claims_total', dims: {}, value: fx.claims.length, at: fx.meta.data_as_of }] } }),
  };

  // New fixture IDs and explicitly typed queries only: v1 responses are untouched.
  if (opts.topics !== false) {
    const topicFixtures = [...m0cFixtures, ...gizmoFixtures];
    for (const operation of ['listNodes', 'getNode', 'getNodeNeighbors', 'search']) {
      const original = H[operation]!;
      H[operation] = (c, q, ctx, op) => {
        const id = c.req.param('id');
        const row = topicFixtures.find(n => n.id === id);
        const types = (q.get('types') ?? '').split(',');
        const typed = types.some(t => ['Topic', 'TopicSpec', 'Page', 'Note'].includes(t));
        const page = { next_cursor:null, total:null, truncated:false };
        if (operation === 'getNode' && row) return envelope(op,c,ctx,{data:row,etag:null});
        // M0a: readable by ID only, so no list, search or graph count changes.
        if (operation === 'getNode' && editorFixtures.some(n => n.id === id)) return envelope(op,c,ctx,{data:editorFixtures.find(n => n.id === id)!,etag:null});
        if (operation === 'getNodeNeighbors' && gizmoFixtures.some(n => n.id === id)) return envelope(op,c,ctx,{data:{
          nodes:{columns:['id','label','type','status'],rows:gizmoFixtures.map(n=>[n.id,n.label,n.type,n.status])},
          edges:{columns:['id','src','dst','rtype','status'],rows:gizmoEdges.map(e=>[e.id,e.src,e.dst,e.rtype,e.status])},
          truncated:false,node_total:gizmoFixtures.length,edge_total:gizmoEdges.length,
        },etag:null});
        if (operation === 'getNodeNeighbors' && row) return envelope(op,c,ctx,{data:{
          nodes:{columns:['id','label','type','status'],rows:m0cFixtures.map(n=>[n.id,n.label,n.type,n.status])},
          edges:{columns:['id','src','dst','rtype','status'],rows:topicEdges.map(e=>[e.id,e.src,e.dst,e.rtype,e.status])},
          truncated:false,node_total:4,edge_total:3,
        },etag:null});
        if (operation === 'listNodes' && typed) return envelope(op,c,ctx,{data:{items:topicFixtures.filter(n=>types.includes(n.type))},page,etag:null});
        if (operation === 'search' && typed) {
          const needle=(q.get('q')??'').normalize('NFC').toLowerCase();
          return envelope(op,c,ctx,{data:{items:topicFixtures.filter(n=>types.includes(n.type)&&n.label.toLowerCase().includes(needle)).map(n=>({
            id:n.id,kind:n.id.startsWith('f-')?'record':'entity',type:n.type,title:n.label,snippet:n.body??n.label,highlights:[],highlight_unit:'codepoint',origin:n.origin,status:n.status,recorded_at:n.recorded_at,sensitivity:n.sensitivity,author:null,liveness:null,
          }))},page,etag:null});
        }
        return original(c,q,ctx,op);
      };
    }
  }

  // M0f: the task center's fixtures. Task nodes are readable by ID, and one exact query (`types=TopicSpec`) lists the specs to follow (none
  // unless `tasks` is on, so the task center has nothing to follow and reads nothing first-party); every other typed read, the graph and the
  // palette stay as they were.
  if (opts.topics !== false) {
    const page = { next_cursor: null, total: null, truncated: false };
    const outer = { ...H };
    H.getNode = (c, q, ctx, op) => { const row = opts.tasks ? taskNodes.find((n) => n.id === idParam(c)) : undefined; return row ? envelope(op, c, ctx, { data: row, etag: null }) : outer.getNode!(c, q, ctx, op); };
    H.listNodes = (c, q, ctx, op) => q.get('types') === 'TopicSpec' ? envelope(op, c, ctx, { data: { items: opts.tasks ? taskSpecs : [] }, page, etag: null }) : outer.listNodes!(c, q, ctx, op);
    H.listNodeEdges = (c, q, ctx, op) => {
      if (!opts.tasks || !isTaskTopic(idParam(c))) return outer.listNodeEdges!(c, q, ctx, op);
      const items = edgesOf(idParam(c));
      return envelope(op, c, ctx, { data: { items }, page: { next_cursor: null, total: items.length, truncated: false }, etag: null });
    };
    H.listNodeClaims = (c, q, ctx, op) => {
      if (!opts.tasks || !isTaskTopic(idParam(c))) return outer.listNodeClaims!(c, q, ctx, op);
      const items = CLAIM_IDS.slice(0, claimCountOf(idParam(c))).map((id) => pick(id, ctx)).filter((r): r is Row => !!r).map((r) => outRow(r, ctx));
      return envelope(op, c, ctx, { data: { items }, page: { next_cursor: null, total: items.length, truncated: false }, etag: null });
    };
  }

  // M2: what the write imitation accepted can be read back by ID, followed through its versions, and listed when dead (the trash window). The typed
  // fixture reads above stay as they were: only a written ID, a `/history` of one, and `status=dead` for first-party records come here first.
  const writeStore = opts.write ? createRecordStore() : undefined;
  if (writeStore) {
    const written = writtenView(writeStore);
    const outer = { ...H };
    H.getNode = (c, q, ctx, op) => {
      const at = q.get('as_of_observed');
      const row = written.detail(idParam(c), at ? ts(at) : undefined);
      return row ? envelope(op, c, ctx, { data: row, etag: null }) : outer.getNode!(c, q, ctx, op);
    };
    H.getNodeHistory = (c, q, ctx, op) => {
      const row = written.history(idParam(c));
      return row ? envelope(op, c, ctx, { data: row, etag: null }) : outer.getNodeHistory!(c, q, ctx, op);
    };
    if (opts.db) seedDatabase(writeStore);
    H.listNodes = (c, q, ctx, op) => {
      // M4: the list a database block reads (db.ts); anything else it does not recognise goes on to the reads below.
      const rows = opts.db ? databaseRows(written, q) : null;
      if (rows) return envelope(op, c, ctx, { data: { items: rows }, page: { next_cursor: null, total: null, truncated: false }, etag: null });
      if (q.get('status') !== 'dead' || q.get('origin') !== 'first_party') return outer.listNodes!(c, q, ctx, op);
      const types = list(q.get('types') ?? q.get('type'));
      return envelope(op, c, ctx, { data: { items: written.list('dead', types) }, page: { next_cursor: null, total: null, truncated: false }, etag: null });
    };
  }

  // ---- routing and the common checks
  const app = new Hono();
  // Over HTTP the Host header is always there. app.request() in tests has none, so the URL host stands in.
  const hostOf = (c: Context) => c.req.header('host') ?? new URL(c.req.url).host;
  const hostOk = (h: string | undefined) => { const name = (h ?? '').replace(/:\d+$/, ''); return name === '127.0.0.1' || name === 'localhost'; };
  const started = () => Date.now() - startedAt;

  app.use(async (c, next) => {
    await next();
    // A write route that read a token names its scope, so a test can count the editor tokens that reached a reviewer path.
    const scope = (c as unknown as { get(k: string): unknown }).get('scope');
    opts.onAccess?.(`${c.req.method} ${c.req.routePath} ${c.res.status}${scope ? ` scope=${String(scope)}` : ''}`);
  });

  for (const op of operations()) {
    if (op.method !== 'get') continue;
    const route = op.path.replace(/\{(\w+)\}/g, ':$1');
    // The reviewer paths (GET /v1/actions/{id}, GET /v1/hitl) are first-party routes, not KB reads. The KB's openapi.yaml now lists them in `paths`
    // (it used to keep them outside), and tasks.ts serves them when `tasks` is on. They have no read handler here, and a contract that grows
    // one is not a startup error. Without `tasks` they answer 404.
    if (!H[op.operationId] && op.op.security?.some((s: Record<string, unknown>) => 'reviewerBearer' in s)) continue;
    const handler = H[op.operationId];
    if (!handler) throw new Error(`no handler for ${op.operationId}`);
    const known = new Map<string, { in: string; required: boolean; check: (x: unknown) => boolean; schema: any }>();
    for (const p of op.params) if (p.in === 'query' || p.in === 'header') known.set(p.name, { in: p.in, required: !!p.required, check: compileParam(p.schema.type === 'array' ? p.schema.items : p.schema), schema: p.schema });
    const hasAxes = known.has('as_of_valid') && known.has('as_of_observed');
    app.get(route, (c) => {
      if (!hostOk(hostOf(c))) return problem(c, 403, 'host_rejected', 'host rejected');
      if (opts.token && c.req.header('authorization') !== `Bearer ${opts.token}`) return problem(c, c.req.header('authorization') ? 401 : 401, c.req.header('authorization') ? 'token_invalid' : 'token_required', 'token required');
      if (opts.notReadyMs && started() < opts.notReadyMs) return problem(c, 503, 'not_ready', 'starting', undefined, { 'Retry-After': String(Math.max(1, Math.ceil((opts.notReadyMs - started()) / 1000))) });
      const q = new URL(c.req.url).searchParams;
      // C 2.9: where the axes do not apply they are refused, never ignored.
      if (!hasAxes && (q.has('as_of_valid') || q.has('as_of_observed'))) return problem(c, 400, 'as_of_unsupported', 'as_of is not supported here', `${op.path} does not take as_of_valid or as_of_observed`);
      for (const name of new Set(q.keys())) if (!known.has(name) || known.get(name)!.in !== 'query') return problem(c, 400, 'bad_param', 'unknown parameter', name);
      for (const [name, p] of known) {
        const vals = p.in === 'header' ? [c.req.header(name)].filter((x): x is string => x !== undefined) : q.getAll(name);
        if (vals.length === 0) { if (p.required) return problem(c, 400, 'bad_param', 'missing parameter', name); continue; }
        if (vals.length > 1 && p.schema.type !== 'array') return problem(c, 400, 'bad_param', 'repeated parameter', name);
        for (const v of vals) if (!p.check(v)) {
          const n = Number(v);
          if (p.schema.type === 'integer' && Number.isInteger(n) && p.schema.maximum !== undefined && n > p.schema.maximum && /limit|max_chars/.test(name)) return problem(c, 400, 'limit_too_large', 'limit too large', `${name} maximum is ${p.schema.maximum}`);
          return problem(c, 400, 'bad_param', 'invalid parameter', name);
        }
      }
      for (const n of ['as_of_valid', 'as_of_observed', 'from', 'to']) { const v = q.get(n); if (v !== null && Number.isNaN(ts(v))) return problem(c, 400, 'bad_param', 'invalid time', n); }
      return handler(c, q, ctxOf(q, hasAxes), op);
    });
    app.all(route, (c) => problem(c, 405, 'method_not_allowed', 'method not allowed', undefined, { Allow: 'GET, HEAD' }));
  }
  // M1 write routes, before the M0f reads so that `GET /v1/writes/{ref}` of a write made here is answered here and any other ref falls through.
  if (opts.write) registerWriteRoutes(app, { hostOk: (c) => hostOk(hostOf(c)), options: opts.write, ...(writeStore ? { records: writeStore } : {}) });
  // M0f read routes outside the OpenAPI file's `paths` (they sit under x-first-party-paths there, or in ADR-0005). Same checks as above.
  if (opts.topics !== false && opts.tasks) registerTaskRoutes(app, {
    gate: (c) => {
      if (!hostOk(hostOf(c))) return problem(c, 403, 'host_rejected', 'host rejected');
      if (opts.token && c.req.header('authorization') !== `Bearer ${opts.token}`) return problem(c, 401, c.req.header('authorization') ? 'token_invalid' : 'token_required', 'token required');
      if (opts.notReadyMs && started() < opts.notReadyMs) return problem(c, 503, 'not_ready', 'starting', undefined, { 'Retry-After': String(Math.max(1, Math.ceil((opts.notReadyMs - started()) / 1000))) });
      return null;
    },
    problem: (c, status, code, title, detail) => problem(c, status, code, title, detail),
    json: (_c, data, pg) => new Response(JSON.stringify({
      schema_version: fx.meta.schema_version, epoch, build_id: fx.meta.build_id, data_as_of: fx.meta.data_as_of, applied_seq: fx.meta.applied_seq,
      as_of: { valid: null, observed: null }, degraded: [], data, ...(pg ? { page: pg } : {}),
    }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', vary: 'Authorization' } }),
  });
  app.notFound((c) => (hostOk(hostOf(c)) ? problem(c, 404, 'not_found', 'not found') : problem(c, 403, 'host_rejected', 'host rejected')));
  app.onError((e, c) => problem(c, 500, 'internal', 'internal error', String(e).slice(0, 200)));
  return app;
}
