import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';
import { doc, schema, resolveParam, compileParam, fixturePath } from './contract.ts';
import type { Catalog, CatalogEnvelope, Claim, ClaimPage, Edge, Entity, EntityDetailEnvelope, EntityPage, OverviewEnvelope, ResponseMeta, Snapshot, SnapshotEnvelope } from './client/model/index.ts';

type Fixture = { meta: ResponseMeta; entities: Entity[]; claims: Claim[]; snapshots: Snapshot[]; edges: Edge[]; catalog: Catalog };
type Envelopes = { EntityPage: EntityPage; ClaimPage: ClaimPage; EntityDetailEnvelope: EntityDetailEnvelope; SnapshotEnvelope: SnapshotEnvelope; OverviewEnvelope: OverviewEnvelope; CatalogEnvelope: CatalogEnvelope };
// The cast is sound because every row is checked by ajv just below before any request is served.
const fx = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
const validators = new Map<string, ReturnType<typeof schema>>();
const v = (n: string) => { if (!validators.has(n)) validators.set(n, schema(n)); return validators.get(n)!; };

for (const [name, rows] of [['Entity', fx.entities], ['Claim', fx.claims], ['Snapshot', fx.snapshots], ['Edge', fx.edges], ['Catalog', [fx.catalog]], ['ResponseMeta', [fx.meta]]] as const) {
  const check = v(name);
  for (const r of rows) if (!check(r)) { console.error('fixture invalid', name, check.errors); process.exit(2); }
}

type Env = { Variables: { cursorOffset: number } };
const BUG = process.env.KB_MOCK_BUG;
const problem = (c: Context, status: number, title: string, detail?: string, extra: object = {}) =>
  new Response(JSON.stringify({ type: 'about:blank', title, status, ...(detail ? { detail } : {}), ...extra }), { status, headers: { 'content-type': BUG === 'wrong_error_type' ? 'text/plain' : 'application/problem+json' } });

// Every body is validated against the contract before it leaves. A drifted mock answers 500.
function reply<K extends keyof Envelopes>(c: Context, envelope: K, data: Omit<Envelopes[K], keyof ResponseMeta>) {
  const body: any = { ...fx.meta, ...data };
  if (BUG === 'drop_field' && body.page) delete body.page.has_more; // negative control only
  const check = v(envelope);
  if (!BUG && !check(body)) return problem(c, 500, 'mock response violates contract', JSON.stringify(check.errors?.slice(0, 3)));
  const etag = `"${createHash('sha256').update(fx.meta.build_id + c.req.url).digest('base64url').slice(0, 16)}"`;
  if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-cache', ETag: etag } });
}

const asOf = (c: Context) => {
  const now = new Date().toISOString();
  return { V: c.req.query('as_of_valid') ?? now, O: c.req.query('as_of_observed') ?? now };
};
const t = (s: string) => Date.parse(s);
const claimsAt = (id: string, V: string, O: string) => {
  const seen = fx.claims.filter((x: Claim) => x.entity_id === id && t(x.observed_at) <= t(O) && t(x.valid_from) <= t(V) && (x.valid_to === null || t(V) < t(x.valid_to)));
  const ids = new Set(seen.map((x) => x.id));
  return seen.filter((x) => !(x.superseded_by && ids.has(x.superseded_by))); // a correction replaces what it superseded, once observed
};
const visible = (e: Entity) => e.sensitivity !== 'restricted';
const page = <T,>(c: Context<Env>, rows: T[]) => {
  const limit = Number(c.req.query('limit') ?? 50);
  const off = Number(c.get('cursorOffset') ?? 0);
  const next = off + limit < rows.length ? off + limit : null;
  return { data: rows.slice(off, off + limit), page: { next_cursor: next === null ? null : Buffer.from(`o${next}`).toString('base64url'), has_more: next !== null, total: rows.length } };
};

const handlers: Record<string, (c: Context<Env>) => Response | Promise<Response>> = {
  listEntities: (c) => {
    const type = c.req.query('type'), status = c.req.query('status');
    const rows = fx.entities.filter(visible).filter((e) => (status ? e.status === status : e.status === 'active')).filter((e) => !type || e.type === type);
    return reply(c, 'EntityPage', page(c, rows));
  },
  getEntity: (c) => {
    const e = fx.entities.find((x) => x.id === c.req.param('entity_id' as never));
    if (!e || !visible(e)) return problem(c, 404, 'Entity not found', undefined, { code: 'entity_not_found' });
    const { V, O } = asOf(c);
    return reply(c, 'EntityDetailEnvelope', { data: { ...e, claims: claimsAt(e.id, V, O) } });
  },
  listEntityClaims: (c) => {
    const e = fx.entities.find((x) => x.id === c.req.param('entity_id' as never));
    if (!e || !visible(e)) return problem(c, 404, 'Entity not found', undefined, { code: 'entity_not_found' });
    const { V, O } = asOf(c);
    return reply(c, 'ClaimPage', page(c, claimsAt(e.id, V, O)));
  },
  getSnapshot: (c) => {
    const s = fx.snapshots.find((x) => x.id === c.req.param('snapshot_id' as never));
    return s ? reply(c, 'SnapshotEnvelope', { data: s }) : problem(c, 404, 'Snapshot not found');
  },
  getOverview: (c) => {
    const type = c.req.query('type');
    const nodes = fx.entities.filter(visible).filter((e) => e.status === 'active' && e.type === type);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = fx.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    return reply(c, 'OverviewEnvelope', { data: { nodes, edges, total: { nodes: nodes.length, edges: edges.length }, truncated: false } });
  },
  getSchemaCatalog: (c) => reply(c, 'CatalogEnvelope', { data: fx.catalog }),
};

const app = new Hono<Env>();
if (process.env.KB_ACCESS_LOG) app.use(async (c, next) => { await next(); appendFileSync(process.env.KB_ACCESS_LOG!, `${c.req.method} ${c.req.routePath} ${c.res.status}\n`); });
for (const [path, item] of Object.entries<any>(doc.paths)) {
  const route = path.replace(/\{(\w+)\}/g, ':$1');
  for (const [method, op] of Object.entries<any>(item)) {
    if (method !== 'get') continue;
    const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(resolveParam).map((p: any) => ({ ...p, check: compileParam(p.schema) }));
    const handler = handlers[op.operationId];
    if (!handler) throw new Error('no handler for ' + op.operationId);
    const known = new Set(params.filter((p: any) => p.in === 'query').map((p: any) => p.name));
    app.get(route, (c) => {
      // An unknown query parameter is a client bug. A renamed as_of axis must not be silently ignored.
      for (const name of Object.keys(c.req.queries())) if (!known.has(name)) return problem(c, 400, 'Unknown parameter', name);
      for (const p of params) {
        const values = p.in === 'query' ? c.req.queries(p.name) : p.in === 'path' ? [c.req.param(p.name)] : [c.req.header(p.name)];
        const present = values !== undefined && values.length > 0 && values[0] !== undefined;
        if (!present) { if (p.required) return problem(c, 400, 'Missing parameter', p.name); continue; }
        if (values!.length > 1) return problem(c, 400, 'Repeated parameter', p.name);
        if (!p.check(values![0])) return problem(c, p.in === 'path' ? 404 : 400, 'Invalid parameter', p.name);
      }
      const cursor = c.req.query('cursor');
      if (cursor !== undefined) {
        const m = /^o(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString());
        if (!m) return problem(c, 400, 'Invalid cursor', undefined, { code: 'invalid_cursor' });
        c.set('cursorOffset', Number(m[1]));
      }
      return handler(c);
    });
  }
  app.all(route, (c) => new Response(JSON.stringify({ type: 'about:blank', title: 'Method not allowed', status: 405 }), { status: 405, headers: { 'content-type': 'application/problem+json', Allow: 'GET, HEAD' } }));
}
app.notFound((c) => problem(c, 404, 'Not found'));
app.onError((e, c) => problem(c, 500, 'Mock error', String(e).slice(0, 200)));

const port = Number(process.env.PORT ?? 18401);
serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (i) => console.log(`kb-mock on 127.0.0.1:${i.port}`));
