// Round 1 of the review fixes. Each block names the defect it pins. Everything here is logic that can run without a browser;
// the screens that need one are in e2e/round1.spec.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InfiniteQueryObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getGetSnapshotTextQueryOptions } from '../src/client/kb.ts';
import { createKbMock } from '../dev/kb-mock/app.ts';
import { CONTRACT_STAMP } from '../src/client/stamp.ts';
import { configureKb, kbFetch, KbProblem, KbUnavailable } from '../src/data/kbFetch.ts';
import { connection } from '../src/data/connection.ts';
import { envelopeStore } from '../src/data/envelopeStore.ts';
import { noticeStore } from '../src/data/notices.ts';
import { CURSOR_RESTART_NOTICE, makeQueryClient, retryPolicy } from '../src/data/queryClient.ts';
import { isImmutable, recoverQueries } from '../src/data/lifecycle.ts';
import { bodyRestKey, canSortByRecorded, firstWindowMax, pollInterval, readBodyRest, runCheckAll, sortKeysFor, textReader, verdictOptions } from '../src/data/hooks.ts';
import { describeError } from '../src/lib/errors.ts';
import { TIME_AXIS_OPERATIONS } from '../src/time/timeAxes.ts';
import { viewKind } from '../src/time/parse.ts';
import { chipPatch } from '../src/app/TimeControls.tsx';
import { verifyEvidence } from '../src/quote/verify.ts';
import { checkSummary, domainText, relationCount } from '../src/entity/labels.ts';
import { firstObservedAt, recordedAfter, supersedeOutcome, SUPERSEDE_LABEL } from '../src/entity/claimState.ts';
import { mergeRedirectSearch } from '../src/entity/merge.ts';
import { farEnd, withoutBacklinked } from '../src/entity/RelationsPanel.tsx';
import { citingSearch, pickEvidence } from '../src/source/SourceScreen.tsx';
import { validateSourceSearch } from '../src/routes/search.ts';
import { noEntityMessage } from '../src/palette/Palette.tsx';
import { checkStamp } from '../scripts/lib/stamp-check.mjs';
import { findLocalPaths } from '../scripts/check-dist.mjs';
import type { ClaimDetail, EdgeRef, Evidence, SchemaCatalog } from '../src/client/model/index.ts';

const calls: string[] = [];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> | Response;
const mock = createKbMock();
const viaMock = (url: string, init?: RequestInit) => mock.request(url.replace('/kb/', '/'), init);
beforeEach(() => {
  calls.length = 0; envelopeStore.reset(); connection.reset(); noticeStore.clear();
  fetchImpl = viaMock;
  configureKb({ base: () => 'http://localhost/kb', fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { const u = String(input); calls.push(u.replace('http://localhost/kb', '')); return fetchImpl(u, init); }) as typeof fetch });
});
afterEach(() => { connection.reset(); });

const problem = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: 'about:blank', title: code, status, code }), { status, headers: { 'content-type': 'application/problem+json', ...headers } });
const ev = (o: Partial<Evidence>): Evidence => ({ id: 'ev-1', snapshot_id: 'n-1', selector_kind: 'text_quote', evidence_state: 'live', ...o });
const textWindow = (text: string) => (url: string): Response => {
  const q = new URL(url, 'http://x').searchParams;
  const start = Number(q.get('start') ?? 0), max = Number(q.get('max_chars') ?? 20000), chars = [...text];
  const end = Math.min(chars.length, start + max);
  return new Response(JSON.stringify({ schema_version: '0.3.0-sample', epoch: 1, build_id: 'g-1', data_as_of: null, applied_seq: 1, as_of: { valid: null, observed: null }, degraded: [], data: { text: chars.slice(start, end).join(''), start, end, total_chars: chars.length, text_format: 'text' } }), { status: 200, headers: { 'content-type': 'application/json' } });
};

describe('contract 0.3.0 and the stamp (defect: sample pinned to 0.2.0)', () => {
  it('the client is generated from the KB openapi.yaml, not from a sample', () => {
    expect(CONTRACT_STAMP.input).toBe('docs/contracts/openapi.yaml');
    expect(CONTRACT_STAMP.schemaVersion).toMatch(/^0\.3\.\d+$/);
    expect(CONTRACT_STAMP.specVersion).toBe(CONTRACT_STAMP.schemaVersion);
    expect(CONTRACT_STAMP.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(CONTRACT_STAMP.proseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => readFileSync(new URL('../contract-sample/openapi.sample.yaml', import.meta.url))).toThrow();
    expect(readFileSync(new URL('../orval.config.mjs', import.meta.url), 'utf8')).not.toContain('openapi.sample');
  });
  it('the stamp names no local path (defect: the bundle carried /home/…)', () => {
    const text = readFileSync(new URL('../src/client/stamp.ts', import.meta.url), 'utf8');
    expect(text).not.toMatch(/\/home\/|\/Users\/|[A-Za-z]:\\/);
    expect(CONTRACT_STAMP.proseDocument).toBe('docs/contracts/data-interface-v0.md');
    expect(JSON.stringify(CONTRACT_STAMP)).not.toContain('sampleSource');
  });
  it('a changed prose contract or openapi.yaml fails the stamp check; an unchanged one passes', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
    const files = { openapi: path.join(dir, 'openapi.yaml'), prose: path.join(dir, 'data-interface-v0.md') };
    const full = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
    writeFileSync(files.openapi, 'openapi: 3.1.1\n'); writeFileSync(files.prose, '# prose\n');
    const stamp = { inputSha256: full(files.openapi), proseSha256: full(files.prose) };
    expect(checkStamp(stamp, files)).toEqual([]);
    writeFileSync(files.prose, '# prose, changed\n');
    expect(checkStamp(stamp, files).join()).toContain('data-interface-v0.md changed');
    writeFileSync(files.prose, '# prose\n'); writeFileSync(files.openapi, 'openapi: 3.1.1\ninfo: {}\n');
    expect(checkStamp(stamp, files).join()).toContain('openapi.yaml changed');
    writeFileSync(files.openapi, 'openapi: 3.1.1\n');
    expect(checkStamp(stamp, { ...files, prose: path.join(dir, 'gone.md') }).join()).toContain('is missing');
  });
  it('check-dist finds a local path in a bundle and passes a clean one', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dist-'));
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'assets', 'ok.js'), 'const a="docs/contracts/openapi.yaml"');
    expect(findLocalPaths(dir)).toEqual([]);
    writeFileSync(path.join(dir, 'assets', 'bad.js'), 'x={document:"/home/someone/kb/docs/contracts/data-interface-v0.md"}');
    expect(findLocalPaths(dir).map((h) => h.match)).toEqual(['/home/someone/']);
  });
});

describe('/body takes the time axes (defect: remainder joined to a head of another time)', () => {
  it('the table says so, and the remainder read carries both axes', async () => {
    expect(TIME_AXIS_OPERATIONS.getNodeBody).toBe(true);
    await readBodyRest('f-01JC8ZQ3T9XYZ', 0, { valid: '2026-10-28T00:00:00Z', observed: '2026-10-31T12:00:00Z' });
    const u = new URL(calls[0]!, 'http://x');
    expect(u.pathname).toBe('/v1/nodes/f-01JC8ZQ3T9XYZ/body');
    expect(u.searchParams.get('as_of_valid')).toBe('2026-10-28T00:00:00Z');
    expect(u.searchParams.get('as_of_observed')).toBe('2026-10-31T12:00:00Z');
    await readBodyRest('f-01JC8ZQ3T9XYZ', 0, {});
    expect(new URL(calls[1]!, 'http://x').searchParams.has('as_of_observed')).toBe(false);
  });
  it('the key holds both axes, so a remainder loaded in the present is not reused in the past', () => {
    const now = bodyRestKey('f-1', 5, {}), past = bodyRestKey('f-1', 5, { observed: '2026-10-15T00:00:00Z' });
    expect(JSON.stringify(now)).not.toBe(JSON.stringify(past));
    expect(JSON.stringify(bodyRestKey('f-1', 5, { valid: '2026-01-01T00:00:00Z' }))).not.toBe(JSON.stringify(now));
  });
  it('the remainder is not immutable and is invalidated like any moving read; the display text stays immutable', async () => {
    const qc = new QueryClient();
    const key = (k: readonly unknown[]) => qc.getQueryCache().build(qc, { queryKey: k });
    expect(isImmutable(key(['loupe', 'body-rest', 'f-1', 5, null, null]))).toBe(false);
    expect(isImmutable(key(['loupe', 'text-windows', 'n-1', 0, 1]))).toBe(true);
    expect(isImmutable(key(['loupe', 'verdict', 'n-1']))).toBe(true);
    expect(isImmutable(key(['/v1/snapshots/n-1/text', {}]))).toBe(true);
    expect(isImmutable(key(['/v1/nodes/n-1', {}]))).toBe(false);
  });
});

describe('retry on the path from claim to quote (defect: blanket retry:false)', () => {
  it('hooks.ts opts out of the global policy in one place only: queries made of reads that already retry', () => {
    const src = readFileSync(new URL('../src/data/hooks.ts', import.meta.url), 'utf8');
    expect(src.match(/retry:\s*false/g)).toHaveLength(1);
    expect(src).toMatch(/const retryInside = \{ retry: false as const \}/);
    // the leaf reads (claim, text window, the reader behind the verdict) carry no override at all
    for (const leaf of ['useClaim', 'useTextWindows', 'const textReader']) expect(src.slice(src.indexOf(leaf), src.indexOf(leaf) + 700).split('\n\n')[0]).not.toMatch(/retry/);
  });
  it('a 503 not_ready on the first text read is waited out and the verdict still arrives', async () => {
    let n = 0;
    const win = textWindow('앞 인용구 뒤');
    fetchImpl = (url) => (++n === 1 ? problem(503, 'not_ready', { 'retry-after': '1' }) : win(url));
    const qc = makeQueryClient();
    const v = await qc.fetchQuery(verdictOptions(qc, ev({ exact: '인용구', start: 2, end: 5 })));
    expect(v).toEqual({ kind: 'match', start: 2, end: 5 });
    expect(n).toBe(2);
  });
  it('429 is retried and a 404 is not', async () => {
    expect(retryPolicy(0, new KbProblem({ type: 'x', title: 't', status: 429 }))).toBe(true);
    expect(retryPolicy(0, new KbProblem({ type: 'x', title: 't', status: 503, code: 'not_ready' }))).toBe(true);
    expect(retryPolicy(0, new KbProblem({ type: 'x', title: 't', status: 404 }))).toBe(false);
    expect(retryPolicy(0, new KbProblem({ type: 'x', title: 't', status: 400, code: 'bad_param' }))).toBe(false);
    let n = 0;
    fetchImpl = (url) => (++n < 2 ? problem(429, 'rate_limited', { 'retry-after': '1' }) : textWindow('abc')(url));
    const r = await makeQueryClient().fetchQuery(getGetSnapshotTextQueryOptions('n-1', { start: 0, max_chars: 10 }));
    expect(r.data.text).toBe('abc');
    expect(n).toBe(2);
    n = 0;
    fetchImpl = () => { n++; return problem(404, 'not_found'); };
    await expect(makeQueryClient().fetchQuery(getGetSnapshotTextQueryOptions('n-1', { start: 0, max_chars: 10 }))).rejects.toBeInstanceOf(KbProblem);
    expect(n).toBe(1);
  });
});

describe('"인용 전체 확인" counts what it checked (defect: 3건 확인했다 with no verdict)', () => {
  it('every read failing is 3 failed and 0 ok, never "3건 확인했다"', async () => {
    fetchImpl = () => problem(429, 'rate_limited', { 'retry-after': '0' });
    // no retries here: the point is the tally, and the retry policy has its own test
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const evs = [1, 2, 3].map((i) => ev({ id: `ev-${i}`, exact: 'x', start: 0, end: 1 }));
    const t = await runCheckAll(qc, evs);
    expect(t).toEqual({ total: 3, ok: 0, failed: 3, notFound: 0 });
    expect(checkSummary(t, false)).toBe('3건 중 3건은 읽지 못해 확인하지 못했다');
    expect(checkSummary(t, false)).not.toContain('확인했다');
  });
  it('successes, a quote not found and a failure are counted apart, and unread claims are named', async () => {
    const win = textWindow('가나다라마바');
    fetchImpl = (url) => (new URL(url, 'http://x').pathname.includes('n-bad') ? problem(503, 'read_timeout') : win(url));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const t = await runCheckAll(qc, [ev({ id: 'a', exact: '나다', start: 1, end: 3 }), ev({ id: 'b', exact: '없는말', start: 0, end: 3 }), ev({ id: 'c', snapshot_id: 'n-bad', exact: 'x', start: 0, end: 1 })]);
    expect(t).toEqual({ total: 3, ok: 2, failed: 1, notFound: 1 });
    expect(checkSummary(t, true)).toBe('3건 중 1건은 읽지 못해 확인하지 못했다. 1건은 인용을 찾지 못했다. 아직 읽지 않은 주장은 포함하지 않았다');
    expect(checkSummary({ total: 8, ok: 8, failed: 0, notFound: 1 }, false)).toBe('8건 확인했다. 1건은 인용을 찾지 못했다');
    expect(checkSummary({ total: 2, ok: 2, failed: 0, notFound: 0 }, false)).toBe('2건 확인했다');
  });
});

describe('what a superseded card may say (defects: 대체됨 and 철회 together; 철회 for an inherited status)', () => {
  const base = { successor: null, mergedInto: null };
  it('exactly one outcome', () => {
    expect(supersedeOutcome({ ...base, successor: 'c-next', subjectStatus: 'active' })).toBe('replaced');
    expect(supersedeOutcome({ ...base, subjectStatus: 'active' })).toBe('withdrawn');
    expect(supersedeOutcome({ ...base, mergedInto: 'c-x', subjectStatus: 'active' })).toBe('merged');
  });
  it('a status inherited from a superseded or dead subject is not a withdrawal; an unread subject is unknown', () => {
    expect(supersedeOutcome({ ...base, subjectStatus: 'superseded' })).toBe('by-subject');
    expect(supersedeOutcome({ ...base, subjectStatus: 'dead' })).toBe('by-subject');
    expect(supersedeOutcome({ ...base, subjectStatus: undefined })).toBe('unknown');
    // 0.3.1: the claim states the basis of its status, and that settles it without reading the subject
    expect(supersedeOutcome({ ...base, subjectStatus: undefined, statusBasis: 'subject' })).toBe('by-subject');
    expect(supersedeOutcome({ ...base, subjectStatus: 'superseded', statusBasis: 'own' })).toBe('withdrawn');
    expect(supersedeOutcome({ ...base, successor: 'c-next', subjectStatus: undefined, statusBasis: 'subject' })).toBe('replaced');
    expect(SUPERSEDE_LABEL['by-subject']).not.toContain('철회');
    expect(SUPERSEDE_LABEL.replaced).toBe('대체됨'); expect(SUPERSEDE_LABEL.withdrawn).toBe('철회');
  });
});

describe('when a superseded claim was first observed (defect: the button jumped to the replacement time)', () => {
  it('the earliest version, whatever the order', () => {
    expect(firstObservedAt([{ recorded_at: '2026-11-01T00:31:05Z' }, { recorded_at: '2026-10-31T10:41:05Z' }])).toBe('2026-10-31T10:41:05Z');
    expect(firstObservedAt([])).toBeUndefined();
    expect(firstObservedAt(undefined)).toBeUndefined();
  });
  it('a version recorded after the observed axis is marked in a past view', () => {
    expect(recordedAfter('2026-11-01T00:31:00Z', '2026-10-31T12:00:00Z')).toBe(true);
    expect(recordedAfter('2026-10-31T00:00:00Z', '2026-10-31T12:00:00Z')).toBe(false);
    expect(recordedAfter('2026-11-01T00:31:00Z', undefined)).toBe(false);
  });
});

describe('connection recovery in a past view (defect: the screen changed without action)', () => {
  const setup = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let label = 'old', fetches = 0;
    const opts = (key: string, axes: object) => ({ queryKey: [key, axes], queryFn: async () => { fetches++; return label; }, staleTime: Infinity });
    const half = new QueryObserver(qc, opts('half', { as_of_observed: '2026-01-01T00:00:00Z' }));
    const unsub = half.subscribe(() => undefined);
    return { qc, half, unsub, setLabel: (l: string) => { label = l; }, fetches: () => fetches };
  };
  it('live: an active read is refetched', async () => {
    const s = setup(); await s.half.refetch(); const before = s.fetches();
    s.setLabel('new'); await recoverQueries(s.qc, false);
    expect(s.fetches()).toBe(before + 1); expect(s.half.getCurrentResult().data).toBe('new'); s.unsub();
  });
  it('past: a read with a free axis is only marked stale, and a failed one is refetched', async () => {
    const s = setup(); await s.half.refetch(); const before = s.fetches();
    s.setLabel('new'); await recoverQueries(s.qc, true);
    expect(s.fetches()).toBe(before); expect(s.half.getCurrentResult().data).toBe('old');
    expect(s.qc.getQueryCache().find({ queryKey: ['half', { as_of_observed: '2026-01-01T00:00:00Z' }] })?.state.isInvalidated).toBe(true);
    // a failed read in the same view is asked again
    let ok = false;
    const bad = new QueryObserver(s.qc, { queryKey: ['bad', {}], queryFn: async () => { if (!ok) throw new Error('down'); return 'back'; }, retry: false });
    const u2 = bad.subscribe(() => undefined); await bad.refetch().catch(() => undefined);
    expect(bad.getCurrentResult().status).toBe('error');
    ok = true; await recoverQueries(s.qc, true); await new Promise((r) => setTimeout(r, 20));
    expect(bad.getCurrentResult().data).toBe('back'); u2(); s.unsub();
  });
});

describe('400 cursor_mismatch restarts from page 1 and says so (defect: only a card)', () => {
  it('the list is read again from its first page and a notice is raised', async () => {
    const qc = makeQueryClient();
    const pages: (string | undefined)[] = [];
    let mismatched = false;
    const obs = new InfiniteQueryObserver<{ items: number[]; next: string | null }, Error, { pages: { items: number[]; next: string | null }[] }, readonly string[], string | undefined>(qc, {
      queryKey: ['claims'], initialPageParam: undefined as string | undefined, gcTime: Infinity,
      queryFn: async ({ pageParam }) => {
        pages.push(pageParam);
        if (pageParam === 'c2' && !mismatched) { mismatched = true; throw new KbProblem({ type: 'x', title: 'cursor_mismatch', status: 400, code: 'cursor_mismatch' }); }
        return pageParam ? { items: [3, 4], next: null } : { items: [1, 2], next: 'c2' };
      },
      getNextPageParam: (p) => p.next ?? undefined,
    });
    const unsub = obs.subscribe(() => undefined);
    await obs.refetch();
    await obs.fetchNextPage();
    await new Promise((r) => setTimeout(r, 50));
    expect(pages).toEqual([undefined, 'c2', undefined]);
    expect(noticeStore.get().map((n) => n.text)).toEqual([CURSOR_RESTART_NOTICE]);
    expect(obs.getCurrentResult().data?.pages).toHaveLength(1);
    unsub();
  });
});

describe('a body that calls itself an envelope is checked as one (defect: no as_of skipped the check)', () => {
  const noAsOf = () => new Response(JSON.stringify({ schema_version: '0.3.0-sample', data: { id: 'e:x', label: '베타' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  it('with axes sent, a missing as_of is as_of_mismatch', async () => {
    fetchImpl = noAsOf;
    const e = await kbFetch('/v1/nodes/e%3Ax?as_of_observed=2026-01-01T00%3A00%3A00Z').catch((x) => x);
    expect(e).toBeInstanceOf(KbProblem); expect((e as KbProblem).code).toBe('as_of_mismatch');
    expect(describeError(e).title).toBe('시점을 확인할 수 없다');
  });
  it('with no axes sent it is accepted, and the store is not touched by a body without applied_seq', async () => {
    fetchImpl = noAsOf;
    await expect(kbFetch('/v1/nodes/e%3Ax')).resolves.toBeTruthy();
    expect(envelopeStore.get().meta).toBeNull();
  });
});

describe('a denied socket is a configuration error (defect: "retrying will not help" and a retry every 30 s)', () => {
  const denied = new KbUnavailable('proxy', 'denied', 502, 'kb_socket_denied');
  it('nothing retries it, the connection reads as down at once, and the poll stops', () => {
    expect(retryPolicy(0, denied)).toBe(false);
    expect(retryPolicy(0, new KbUnavailable('proxy', 'x', 502, 'kb_socket_refused'))).toBe(true);
    expect(pollInterval()).toBe(45_000);
    connection.fail({ reason: 'proxy', status: 502, code: 'kb_socket_denied' });
    expect(connection.get().down).toBe(true);
    expect(connection.canRetry()).toBe(false);
    expect(pollInterval()).toBe(false);
  });
  it('another failure still needs two in a row and keeps polling every 30 s', () => {
    connection.fail({ reason: 'network', status: undefined, code: undefined });
    expect(connection.get().down).toBe(false);
    connection.fail({ reason: 'network', status: undefined, code: undefined });
    expect(pollInterval()).toBe(30_000);
  });
  it('the error text promises no retry', () => {
    const info = describeError(denied);
    expect(info.retry).toBe(false);
    expect(info.detail).toContain('다시 시도해도 같다');
  });
});

describe('merge redirect keeps the filters (defect: status and include_unverified dropped)', () => {
  it('time basis, status and include_unverified survive; unrelated params do not', () => {
    expect(mergeRedirectSearch({ as_of_valid: 'V', as_of_observed: 'O', status: 'all', include_unverified: true, stray: 1 }, 'e:product:old'))
      .toEqual({ as_of_valid: 'V', as_of_observed: 'O', status: 'all', include_unverified: true, merged_from: 'e:product:old' });
  });
});

describe('relations use the peer (defect: a merged far end showed the old slug)', () => {
  const edge = (o: Partial<EdgeRef>): EdgeRef => ({ id: 'r-1', rtype: 'USES', src: 'e:a:me', dst: 'e:product:old', status: 'active', ...o });
  it('peer wins over the stored end and the neighbors table', () => {
    const map = new Map([['e:product:old', { id: 'e:product:old', label: '옛 이름', type: 'Product', status: 'active' }]]);
    expect(farEnd(edge({ peer: { id: 'e:product:new', type: 'Product', label: '새 제품 이름' } }), 'e:product:old', map)).toEqual({ id: 'e:product:new', label: '새 제품 이름', type: 'Product' });
    expect(farEnd(edge({}), 'e:product:old', map)).toEqual({ id: 'e:product:old', label: '옛 이름', type: 'Product' });
    expect(farEnd(edge({}), 'e:product:zzz', new Map())).toEqual({ id: 'e:product:zzz', label: 'zzz', type: undefined });
  });
  it('a note link is listed once, under the backlinks; an edge with no backlink stays', () => {
    const incoming = [edge({ id: 'r-1', rtype: 'LINKS_TO', src: 'f-note', dst: 'e:a:me' }), edge({ id: 'r-2', rtype: 'USES', src: 'e:b:x', dst: 'e:a:me' }), edge({ id: 'r-3', rtype: 'LINKS_TO', src: 'f-other', dst: 'e:a:me' })];
    const kept = withoutBacklinked(incoming, [{ id: 'f-note', type: 'Note', label: '메모', rtype: 'LINKS_TO' }]);
    expect(kept.map((e) => e.id)).toEqual(['r-2', 'r-3']);
    expect(withoutBacklinked(incoming, [])).toHaveLength(3);
  });
  it('the header link counts what is loaded and marks a cut list', () => {
    expect(relationCount({ out: [1, 2], in: [3] })).toBe('3');
    expect(relationCount({ out: [1], in: [], truncated: true })).toBe('1+');
    expect(relationCount(undefined)).toBe('0');
  });
});

describe('domain is an array (defect: values ran together)', () => {
  it('values are joined with a separator; empty and missing give nothing', () => {
    expect(domainText(['G', 'H'])).toBe('G · H');
    expect(domainText(['G'])).toBe('G');
    expect(domainText([])).toBe('');
    expect(domainText(undefined)).toBe('');
    expect(domainText(null)).toBe('');
  });
});

describe('sorting the home list (defect: sort_keys["*"] ignored)', () => {
  const schema = (sort_keys: Record<string, string[]>) => ({ sort_keys } as unknown as SchemaCatalog);
  it('several types use the * entry, one type its own', () => {
    const s = schema({ '*': ['id', 'label', 'recorded_at'], Feature: ['id'] });
    expect(canSortByRecorded(s, ['Feature', 'Product', 'Note'])).toBe(true);
    expect(sortKeysFor(s, ['Feature', 'Product'])).toEqual(['id', 'label', 'recorded_at']);
    expect(canSortByRecorded(s, ['Feature'])).toBe(false);
    expect(canSortByRecorded(schema({ Feature: ['id', 'recorded_at'] }), ['Feature'])).toBe(true);
    expect(canSortByRecorded(schema({ Feature: ['id', 'recorded_at'], Product: ['id', 'recorded_at'] }), ['Feature', 'Product'])).toBe(false);
    expect(canSortByRecorded(s, [])).toBe(false);
  });
});

describe('the first text window never exceeds the contract maximum (defect: limit_too_large)', () => {
  it('a quote of 198,100 characters asks for 200,000, not 201,100', () => {
    expect(firstWindowMax(198_100 - 0 + 3_000)).toBe(200_000);
    expect(firstWindowMax(0)).toBe(20_000);
    expect(firstWindowMax(50_000)).toBe(50_000);
  });
});

describe('step 2 runs when the offsets make no window (defect: 확인하지 못했다)', () => {
  const doc = '가나다라마 인용구는 여기에 있다 바사아';
  const reader = (calls: number[][] = []) => async (start: number, max: number) => {
    calls.push([start, max]);
    if (max <= 0) throw new KbProblem({ type: 'x', title: 'bad', status: 400, code: 'bad_param' });
    const chars = [...doc], end = Math.min(chars.length, start + max);
    return { text: chars.slice(start, end).join(''), start, end, total_chars: chars.length };
  };
  it('end <= start skips step 1 and finds the quote by search', async () => {
    const calls: number[][] = [];
    const v = await verifyEvidence(ev({ exact: '인용구는 여기에', start: 1000, end: 100 }), reader(calls));
    expect(v.kind).toBe('corrected');
    expect(calls.every((c) => c[1]! > 0)).toBe(true);
  });
  it('and not found there is 인용 찾지 못함, not an error', async () => {
    expect((await verifyEvidence(ev({ exact: '없는 인용', start: 50, end: 10 }), reader())).kind).toBe('not-found');
    expect((await verifyEvidence(ev({ exact: '없는 인용', start: 5, end: 5 }), reader())).kind).toBe('not-found');
  });
});

describe('the time chip changes only what was edited (defect: 적용 moved the basis)', () => {
  it('no edit is an empty patch, one edit patches one axis, a cleared input removes its axis', () => {
    expect(chipPatch({ valid: false, observed: false }, { valid: '2026-01-15', observed: '2026-01-15T21:30:00' })).toEqual({ patch: {}, bad: false });
    expect(chipPatch({ valid: true, observed: false }, { valid: '2026-02-01', observed: 'ignored' })).toEqual({ patch: { as_of_valid: '2026-02-01T00:00:00Z' }, bad: false });
    expect(chipPatch({ valid: false, observed: true }, { valid: '', observed: '' })).toEqual({ patch: { as_of_observed: undefined }, bad: false });
    expect(chipPatch({ valid: true, observed: false }, { valid: '2026-13-40', observed: '' }).bad).toBe(true);
  });
});

describe('what the band calls a set time basis (defects: 과거 for a future date and for the held present)', () => {
  const DATA = '2026-11-01T08:00:00Z';
  it('live, past, valid-only and pinned', () => {
    expect(viewKind({}, DATA)).toBe('live');
    expect(viewKind({ as_of_valid: '2026-10-28T00:00:00Z' }, DATA)).toBe('valid-only');
    expect(viewKind({ as_of_observed: '2026-10-31T12:00:00Z' }, DATA)).toBe('past');
    expect(viewKind({ as_of_valid: '2026-10-28T00:00:00Z', as_of_observed: '2026-10-31T12:00:00Z' }, DATA)).toBe('past');
    expect(viewKind({ as_of_valid: '2030-01-01T00:00:00Z' }, DATA)).toBe('pinned');
    expect(viewKind({ as_of_observed: DATA }, DATA)).toBe('pinned');
    expect(viewKind({ as_of_valid: '2030-01-01T00:00:00Z', as_of_observed: '2026-10-31T12:00:00Z' }, DATA)).toBe('past');
  });
  it('without a data_as_of nothing is called pinned', () => {
    expect(viewKind({ as_of_observed: DATA }, null)).toBe('past');
  });
});

describe('the palette says what it searched (defect: 일치하는 항목이 없다)', () => {
  it('names the scope, and in a past view the time', () => {
    expect(noEntityMessage({})).toContain('이름이 일치하는 엔티티가 없다');
    expect(noEntityMessage({ observed: '2026-10-31T00:00:00Z' })).toContain('관측 2026-10-31 09:00 KST');
    expect(noEntityMessage({ valid: '2026-10-28T00:00:00Z' })).toContain('유효 2026-10-28');
  });
});

describe('a citing row opens its own position (defect: the second citation highlighted the first)', () => {
  const claim = { id: 'c-two', evidence: [ev({ id: 'ev-a', snapshot_id: 'n-1', start: 10, end: 20, exact: '인용구😀문장' }), ev({ id: 'ev-b', snapshot_id: 'n-1', start: 40, end: 43, exact: '가나다' }), ev({ id: 'ev-z', snapshot_id: 'n-2', start: 40, end: 43 })] } as unknown as ClaimDetail;
  it('the loaded claim links by evidence id; another claim links by position', () => {
    expect(citingSearch({ id: 'c-two', start: 40, end: 43 }, claim, 'n-1')).toEqual({ claim: 'c-two', ev: 'ev-b' });
    expect(citingSearch({ id: 'c-two', start: 10, end: 20 }, claim, 'n-1')).toEqual({ claim: 'c-two', ev: 'ev-a' });
    expect(citingSearch({ id: 'c-other', start: 7, end: 9 }, claim, 'n-1')).toEqual({ claim: 'c-other', pos: '7-9' });
    expect(citingSearch({ id: 'c-other', start: null, end: null }, claim, 'n-1')).toEqual({ claim: 'c-other' });
  });
  it('pickEvidence takes ev, then the position, then the first in this snapshot', () => {
    expect(pickEvidence(claim, 'n-1', 'ev-b')?.id).toBe('ev-b');
    expect(pickEvidence(claim, 'n-1', undefined, '40-43')?.id).toBe('ev-b');
    expect(pickEvidence(claim, 'n-1', undefined, '1-2')?.id).toBe('ev-a');
    expect(pickEvidence(claim, 'n-1', undefined)?.id).toBe('ev-a');
    expect(pickEvidence(claim, 'n-1', 'ev-nope')).toBeUndefined();
    expect(pickEvidence(claim, 'n-2', undefined, '40-43')?.id).toBe('ev-z');
  });
  it('the route accepts pos as two numbers and refuses anything else', () => {
    expect(validateSourceSearch({ claim: 'c-1', pos: '40-43' }).pos).toBe('40-43');
    expect(() => validateSourceSearch({ pos: '40-43/../x' })).toThrow();
    expect(() => validateSourceSearch({ pos: '-5' })).toThrow();
  });
});
