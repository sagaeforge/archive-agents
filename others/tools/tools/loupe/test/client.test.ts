// The typed client against kb-mock, through kbFetch. Mirrors the S4 typed client checks and adds the design 7 rules.
// kb-mock is reached with app.request() as the transport (design 7.2 "transport swap").
import { beforeEach, describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { CONTRACT_STAMP } from '../src/client/stamp.ts';
import { createKbMock } from '../dev/kb-mock/app.ts';
import { asOfConfirmed, configureKb, kbConfig, kbFetch, KbProblem, KbUnavailable } from '../src/data/kbFetch.ts';
import { connection } from '../src/data/connection.ts';
import { invalidateMoving } from '../src/data/lifecycle.ts';
import { envelopeStore } from '../src/data/envelopeStore.ts';
import { retryPolicy } from '../src/data/queryClient.ts';
import {
  getGetNodeQueryOptions, getGetMetaQueryOptions, getGetSchemaQueryOptions, getListNodesInfiniteQueryOptions, getListNodesQueryOptions, getGetSnapshotTextQueryOptions,
  getGetNodeUrl, getGetOverviewQueryOptions, getListChangesQueryOptions, getGetNodeHistoryQueryOptions, getGetExportManifestQueryOptions, listNodeClaims,
} from '../src/client/kb.ts';
import type { NodeDetailEnvelope } from '../src/client/model/index.ts';
import { asOf } from '../src/time/asOf.ts';
import { asOfFor } from '../src/time/timeAxes.ts';

const calls: string[] = [];
const useApp = (app = createKbMock()) => configureKb({
  base: () => 'http://localhost/kb',
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url.replace('http://localhost/kb', ''));
    // loupe serve strips /kb before the KB sees the path
    return app.request(url.replace('/kb/', '/'), init);
  }) as typeof fetch,
});
const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => { calls.length = 0; envelopeStore.reset(); useApp(); });

describe('typed client through kbFetch', () => {
  it('reads the envelope into the store and returns the body', async () => {
    const r = await qc().fetchQuery(getGetMetaQueryOptions());
    expect(r.data.contract).toBe('v1');
    const st = envelopeStore.get();
    expect(st.meta?.schema_version).toBe(`${CONTRACT_STAMP.schemaVersion}-sample`);
    expect(st.meta?.applied_seq).toBe(r.applied_seq);
  });

  it('puts an id with ":" and every reserved character in one encoded path segment', () => {
    expect(getGetNodeUrl('e:feature:claude-code-hooks')).toBe('/v1/nodes/e%3Afeature%3Aclaude-code-hooks');
    const hostile = 'a/../b?as_of_valid=2020-01-01#x';
    const u = getGetNodeUrl(hostile);
    expect(u).toBe(`/v1/nodes/${encodeURIComponent(hostile)}`);
    expect(new URL(u, 'http://x').pathname.split('/')).toHaveLength(4);
    expect(new URL(u, 'http://x').search).toBe('');
  });

  it('a hostile id never changes the KB request path or query', async () => {
    const e = await qc().fetchQuery(getGetNodeQueryOptions('e:a/b?as_of_valid=2020-01-01T00:00:00Z#x')).catch((x) => x);
    expect(e).toBeInstanceOf(KbProblem); expect((e as KbProblem).status).toBe(404);
    expect(calls[0]).toMatch(/^\/v1\/nodes\/e%3Aa%2Fb%3Fas_of_valid%3D2020-01-01T00%3A00%3A00Z%23x$/);
  });

  it('time axes: the same entity answers 120 or 150 depending on the observed axis (retroactive correction)', async () => {
    const at = async (observed: string) => {
      const r: NodeDetailEnvelope = await qc().fetchQuery(getGetNodeQueryOptions('e:product:claude-code', { include: 'claims', ...asOf({ valid: '2025-06-01T00:00:00Z', observed }) }));
      return r.data.claims?.map((c) => c.value);
    };
    expect(await at('2025-06-01T00:00:00Z')).toEqual(['120']);
    expect(await at('2026-06-01T00:00:00Z')).toEqual(['150']);
    expect(calls[0]).toContain('as_of_valid=2025-06-01T00%3A00%3A00Z');
    expect(calls[0]).toContain('as_of_observed=2025-06-01T00%3A00%3A00Z');
  });

  it('an undefined axis is left out of the query string', async () => {
    await qc().fetchQuery(getListNodesQueryOptions({ ...asOf({}) }));
    expect(calls[0]).toBe('/v1/nodes');
  });

  it('operations outside the time list get no axes, and the KB would refuse them', async () => {
    expect(asOfFor('getNode', { valid: '2026-01-01T00:00:00Z' })).toEqual({ as_of_valid: '2026-01-01T00:00:00Z', as_of_observed: undefined });
    const e = await qc().fetchQuery(getListChangesQueryOptions({ ...(asOf({ observed: '2026-01-01T00:00:00Z' }) as object) })).catch((x) => x);
    expect(e).toBeInstanceOf(KbProblem); expect((e as KbProblem).code).toBe('as_of_unsupported'); // the type level would not let a caller write this; the cast above forces it
  });

  it('infinite list follows page.next_cursor to the end without a cast', async () => {
    const c = qc();
    const opts = getListNodesInfiniteQueryOptions({ limit: 4 }, { query: { getNextPageParam: (last) => last.page?.next_cursor ?? undefined, initialPageParam: undefined } });
    let data = await c.fetchInfiniteQuery({ ...opts, initialPageParam: undefined } as never) as { pages: { data: { items: { id: string }[] }; page: { next_cursor: string | null } }[] };
    for (let i = 0; i < 20 && data.pages.at(-1)!.page.next_cursor; i++) {
      data = await c.fetchInfiniteQuery({ ...opts, pages: data.pages.length + 1, initialPageParam: undefined } as never) as typeof data;
    }
    const ids = data.pages.flatMap((p) => p.data.items.map((x) => x.id));
    expect(ids.length).toBeGreaterThan(8);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('404, 400 and 410 become KbProblem with the RFC 9457 code', async () => {
    const nf = await qc().fetchQuery(getGetNodeQueryOptions('e:nope:none')).catch((x) => x);
    expect(nf).toBeInstanceOf(KbProblem); expect(nf.code).toBe('not_found'); expect(nf.problem.status).toBe(404);
    const a = await qc().fetchQuery(getListNodesQueryOptions({ limit: 2 }));
    const mismatch = await qc().fetchQuery(getListNodesQueryOptions({ limit: 2, type: 'Feature', cursor: a.page!.next_cursor! })).catch((x) => x);
    expect(mismatch.code).toBe('cursor_mismatch');
    const gone = await qc().fetchQuery(getListNodesQueryOptions({ cursor: Buffer.from(JSON.stringify({ k: 'x', h: 'y', e: 9 })).toString('base64url') })).catch((x) => x);
    expect(gone.code).toBe('epoch_changed'); expect(gone.status).toBe(410);
  });

  it('a non problem+json error body (text/plain) does not break the client', async () => {
    useApp(createKbMock({ bug: 'wrong_error_type' }));
    const e = await qc().fetchQuery(getGetNodeQueryOptions('e:nope:none')).catch((x) => x);
    expect(e).toBeInstanceOf(KbProblem); expect(e.status).toBe(404); expect(e.code).toBeUndefined();
  });

  it('502 and 504 from loupe serve, network errors and timeouts are KbUnavailable; 503 is KbProblem', async () => {
    const respond = (status: number, code: string) => configureKb({ fetch: (async () => new Response(JSON.stringify({ type: 'x', title: code, status, code }), { status, headers: { 'content-type': 'application/problem+json', 'retry-after': '2' } })) as typeof fetch });
    respond(502, 'kb_socket_missing');
    const e502 = await qc().fetchQuery(getGetMetaQueryOptions()).catch((x) => x);
    expect(e502).toBeInstanceOf(KbUnavailable); expect(e502.code).toBe('kb_socket_missing');
    respond(504, 'kb_timeout');
    expect(await qc().fetchQuery(getGetMetaQueryOptions()).catch((x) => x)).toBeInstanceOf(KbUnavailable);
    respond(503, 'not_ready');
    const e503 = await qc().fetchQuery(getGetMetaQueryOptions()).catch((x) => x);
    expect(e503).toBeInstanceOf(KbProblem); expect(e503.retryAfterSec).toBe(2);
    configureKb({ fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    const net = await qc().fetchQuery(getGetMetaQueryOptions()).catch((x) => x);
    expect(net).toBeInstanceOf(KbUnavailable); expect(net.reason).toBe('network');
    configureKb({ timeoutMs: 30, fetch: ((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'TimeoutError'))))) as typeof fetch });
    const to = await qc().fetchQuery(getGetMetaQueryOptions()).catch((x) => x);
    expect(to).toBeInstanceOf(KbUnavailable); expect(to.reason).toBe('timeout');
  });

  it('the caller abort is not reported as unavailable', async () => {
    const ctl = new AbortController();
    configureKb({ fetch: ((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal?.reason)))) as typeof fetch });
    const p = kbFetch('/v1/meta', { signal: ctl.signal }).catch((x) => x);
    ctl.abort();
    const e = await p;
    expect(e).not.toBeInstanceOf(KbUnavailable); expect(e).not.toBeInstanceOf(KbProblem);
  });

  it('retry policy follows design 7.3', () => {
    const problem = (status: number, code?: string) => new KbProblem({ type: 'x', title: 't', status, ...(code ? { code } : {}) });
    expect(retryPolicy(0, problem(404, 'not_found'))).toBe(false);
    expect(retryPolicy(0, problem(503, 'not_ready'))).toBe(true);
    expect(retryPolicy(1, problem(503, 'not_ready'))).toBe(false);
    expect(retryPolicy(0, problem(429))).toBe(true);
    expect(retryPolicy(0, new KbUnavailable('network', 'x'))).toBe(true);
    expect(retryPolicy(1, new KbUnavailable('network', 'x'))).toBe(false);
  });

  it('caches by cache mode: only overview and changes may use the HTTP cache', async () => {
    const seen: Record<string, RequestCache | undefined> = {};
    configureKb({ fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { seen[String(input).replace('http://localhost/kb', '').split('?')[0]!] = init?.cache; return createKbMock().request(String(input).replace('/kb/', '/'), init); }) as typeof fetch });
    await qc().fetchQuery(getGetOverviewQueryOptions());
    await qc().fetchQuery(getListChangesQueryOptions());
    await qc().fetchQuery(getGetMetaQueryOptions());
    await qc().fetchQuery(getGetSchemaQueryOptions());
    await qc().fetchQuery(getGetNodeQueryOptions('e:product:claude-code'));
    await qc().fetchQuery(getGetSnapshotTextQueryOptions('n-3fa9c01b77aa12ef'));
    expect(seen).toEqual({ '/v1/overview': 'no-cache', '/v1/changes': 'no-cache', '/v1/meta': 'no-cache', '/v1/schema': 'no-cache', '/v1/nodes/e%3Aproduct%3Aclaude-code': 'no-store', '/v1/snapshots/n-3fa9c01b77aa12ef/text': 'no-store' });
  });

  it('applied_seq increase and epoch change are reported once each', async () => {
    const events: string[] = [];
    const off = envelopeStore.onChange((_p, _n, c) => { if (c.appliedSeqIncreased) events.push('seq'); if (c.epochChanged) events.push('epoch'); if (c.buildIdChanged) events.push('build'); });
    envelopeStore.update({ schema_version: '0.2.0', epoch: 1, build_id: 'g-1', data_as_of: 'x', applied_seq: 10, as_of: {}, degraded: [] });
    envelopeStore.update({ schema_version: '0.2.0', epoch: 1, build_id: 'g-2', data_as_of: 'x', applied_seq: 12, as_of: {}, degraded: [] });
    envelopeStore.update({ schema_version: '0.2.0', epoch: 2, build_id: 'g-2', data_as_of: 'x', applied_seq: 12, as_of: {}, degraded: [] });
    off();
    expect(events).toEqual(['seq', 'build', 'epoch']);
  });

  it('two KbUnavailable in a row cut the connection; any KB answer restores it and reports the recovery', async () => {
    connection.reset();
    const recovered: number[] = [];
    const off = connection.onRecover(() => recovered.push(1));
    configureKb({ fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    await kbFetch('/v1/meta').catch(() => undefined);
    expect(connection.get()).toMatchObject({ failures: 1, down: false });
    await kbFetch('/v1/meta').catch(() => undefined);
    expect(connection.get()).toMatchObject({ failures: 2, down: true, last: { reason: 'network' } });
    useApp();
    await kbFetch('/v1/nodes/e%3Anope%3Anone').catch(() => undefined); // a 404 is the KB answering
    expect(connection.get().down).toBe(false);
    expect(recovered).toEqual([1]);
    off();
  });

  it('the envelope must confirm the time basis: parsed instants, not strings', async () => {
    expect(asOfConfirmed('/v1/nodes', { valid: null, observed: null })).toBe(true);
    expect(asOfConfirmed('/v1/nodes?as_of_valid=2026-10-28', { valid: '2026-10-28T00:00:00Z', observed: null })).toBe(true);
    expect(asOfConfirmed('/v1/nodes?as_of_observed=2026-10-28T00%3A00%3A00Z', { valid: null, observed: '2026-10-28T00:00:00.000Z' })).toBe(true);
    expect(asOfConfirmed('/v1/nodes?as_of_observed=2026-10-28T00%3A00%3A00Z', { valid: null, observed: null })).toBe(false);
    expect(asOfConfirmed('/v1/nodes', { valid: '2026-10-28T00:00:00Z', observed: null })).toBe(false);
    const app = createKbMock({ bug: 'ignore_as_of' });
    expect((await app.request('http://localhost/v1/nodes?as_of_valid=2026-10-28T00:00:00Z')).status).toBe(200);
    configureKb({ fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await createKbMock().request(String(input).replace('/kb/', '/'), init);
      const body = await res.json();
      return new Response(JSON.stringify({ ...body, as_of: { valid: null, observed: null } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch });
    const e = await kbFetch('/v1/nodes?as_of_valid=2026-10-28T00%3A00%3A00Z').catch((x) => x as KbProblem);
    expect(e).toBeInstanceOf(KbProblem); expect((e as KbProblem).code).toBe('as_of_mismatch');
  });

  it('a 503 does not count as cut off: the KB answered', async () => {
    connection.reset();
    configureKb({ fetch: (async () => new Response(JSON.stringify({ type: 'x', title: 't', status: 503, code: 'read_timeout' }), { status: 503, headers: { 'content-type': 'application/problem+json' } })) as typeof fetch });
    await kbFetch('/v1/meta').catch(() => undefined);
    await kbFetch('/v1/meta').catch(() => undefined);
    expect(connection.get().failures).toBe(0);
  });

  it('applied_seq increase invalidates what moves, live and past alike, and refetches only in a live view', async () => {
    const c = qc();
    const live = getGetNodeQueryOptions('e:product:claude-code', { include: 'claims' });
    const oneAxis = getGetNodeQueryOptions('e:product:claude-code', { include: 'claims', ...asOf({ valid: '2026-01-01T00:00:00Z' }) });
    const pinned = getGetNodeQueryOptions('e:product:claude-code', { include: 'claims', ...asOf({ valid: '2026-01-01T00:00:00Z', observed: '2026-10-31T00:00:00Z' }) });
    const text = getGetSnapshotTextQueryOptions('n-3fa9c01b77aa12ef', { start: 0, max_chars: 5 });
    const meta = getGetMetaQueryOptions();
    for (const o of [live, oneAxis, pinned, text, meta]) await c.fetchQuery(o as never);
    await invalidateMoving(c, true);
    const invalid = (o: { queryKey: readonly unknown[] }) => c.getQueryState(o.queryKey)?.isInvalidated;
    expect(invalid(live)).toBe(true); expect(invalid(oneAxis)).toBe(true);
    expect(invalid(pinned)).toBe(false); expect(invalid(text)).toBe(false); expect(invalid(meta)).toBe(false);
  });

  it('claims and edges continue through their cursors with the filters of the first page', async () => {
    const seen: string[] = [];
    useApp(createKbMock({ fixturePath: new URL('../contract-sample/fixtures/kb-research.json', import.meta.url).pathname }));
    const base = kbConfig.fetch;
    configureKb({ fetch: ((u: string, i?: RequestInit) => { seen.push(String(u)); return base(u, i); }) as typeof fetch });
    let page = await listNodeClaims('e:spike:s1-aggregation', { limit: 20 });
    const ids = page.data.items.map((x) => x.id);
    while (page.page.next_cursor) { page = await listNodeClaims('e:spike:s1-aggregation', { limit: 20, cursor: page.page.next_cursor }); ids.push(...page.data.items.map((x) => x.id)); }
    expect(ids).toHaveLength(55); expect(new Set(ids).size).toBe(55);
    const wrong = await listNodeClaims('e:spike:s1-aggregation', { limit: 20, status: 'all', cursor: (await listNodeClaims('e:spike:s1-aggregation', { limit: 20 })).page.next_cursor! }).catch((x) => x);
    expect(wrong.code).toBe('cursor_mismatch');
  });

  it('typed history, manifest and text come back with their data shape', async () => {
    const h = await qc().fetchQuery(getGetNodeHistoryQueryOptions('c-3hd9x0w2raab'));
    expect(h.data.chains[0]!.items[0]!.id).toBe('c-3hd9x0w2raab');
    const m = await qc().fetchQuery(getGetExportManifestQueryOptions());
    expect(m.data.changes_cursor).toBeTruthy();
    const t = await qc().fetchQuery(getGetSnapshotTextQueryOptions('n-3fa9c01b77aa12ef', { start: 0, max_chars: 5 }));
    expect([...t.data.text]).toHaveLength(5);
  });
});
