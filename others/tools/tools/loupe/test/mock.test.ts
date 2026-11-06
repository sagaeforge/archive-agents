import { describe, expect, it } from 'vitest';
import { createKbMock } from '../dev/kb-mock/app.ts';
import { checkMockRules } from './mock-rules.ts';

describe('kb-mock enforces the contract rules', () => {
  it('passes every rule', async () => { expect(await checkMockRules(createKbMock())).toEqual([]); });
});

// Negative controls: the rule set must notice each planted bug.
describe('negative controls (KB_MOCK_BUG)', () => {
  for (const bug of ['ignore_as_of', 'no_cursor_check', 'leak_private', 'drop_field', 'wrong_error_type'] as const)
    it(`${bug} is caught`, async () => { expect((await checkMockRules(createKbMock({ bug }))).length).toBeGreaterThan(0); });
});

describe('other mock behaviors', () => {
  const app = createKbMock();
  const get = (p: string) => app.request(`http://localhost${p}`);
  it('overview pages are closed by union and cover everything', async () => {
    const full = await (await get('/v1/overview?limit=100')).json() as any;
    const nodes: string[] = [], edges: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const j = await (await get(`/v1/overview?limit=2${cursor ? `&cursor=${cursor}` : ''}`)).json() as any;
      nodes.push(...j.data.nodes.rows.map((r: string[]) => r[0])); edges.push(...j.data.edges.rows.map((r: string[]) => r[0]));
      const have = new Set(nodes);
      for (const r of j.data.edges.rows) expect(have.has(r[1]) && have.has(r[2])).toBe(true);
      cursor = j.page.next_cursor;
      if (!cursor) break;
    }
    expect(nodes.sort()).toEqual(full.data.nodes.rows.map((r: string[]) => r[0]).sort());
    expect(edges.sort()).toEqual(full.data.edges.rows.map((r: string[]) => r[0]).sort());
  });
  it('search highlights are code point offsets into the snippet', async () => {
    const j = await (await get(`/v1/search?q=${encodeURIComponent('훅')}`)).json() as any;
    const hit = j.data.items.find((i: any) => i.kind === 'claim');
    const cps = [...hit.snippet];
    for (const h of hit.highlights) expect(cps.slice(h.start, h.end).join('')).toBe('훅');
  });
  it('text windows are in code points and continue until end = total_chars', async () => {
    const a = await (await get('/v1/snapshots/n-3fa9c01b77aa12ef/text?start=0&max_chars=10')).json() as any;
    expect([...a.data.text]).toHaveLength(10);
    const b = await (await get(`/v1/snapshots/n-3fa9c01b77aa12ef/text?start=${a.data.total_chars - 5}&max_chars=100`)).json() as any;
    expect(b.data.end).toBe(b.data.total_chars);
  });
  it('removed snapshot keeps metadata, text and raw are 410 content_removed; image-only pdf text is 404', async () => {
    expect((await get('/v1/snapshots/n-removed00000001')).status).toBe(200);
    for (const p of ['text', 'raw']) { const r = await get(`/v1/snapshots/n-removed00000001/${p}`); expect(r.status).toBe(410); expect(((await r.json()) as any).code).toBe('content_removed'); }
    expect((await get('/v1/snapshots/n-pdfimage00000001/text')).status).toBe(404);
  });
  it('raw honors a byte range and answers 416 past the end', async () => {
    const r = await app.request('http://localhost/v1/snapshots/n-html000000000001/raw', { headers: { Range: 'bytes=0-4' } });
    expect(r.status).toBe(206); expect(await r.text()).toBe('<!doc');
    const bad = await app.request('http://localhost/v1/snapshots/n-html000000000001/raw', { headers: { Range: 'bytes=9999-' } });
    expect(bad.status).toBe(416);
  });
  it('change feed: tail returns the same cursor, revoked item has no body, cursor ahead of applied_seq is 410', async () => {
    const first = await (await get('/v1/changes')).json() as any;
    const revoked = first.data.items.find((i: any) => i.kind === 'visibility.revoked');
    expect(Object.keys(revoked).sort()).toEqual(['at', 'id', 'kind', 'seq']);
    const tail = await (await get(`/v1/changes?cursor=${first.page.next_cursor}`)).json() as any;
    expect(tail.data.items).toEqual([]); expect(tail.page.next_cursor).toBe(first.page.next_cursor);
    const ahead = Buffer.from(JSON.stringify({ e: 1, s: 99999999 })).toString('base64url');
    expect((await get(`/v1/changes?cursor=${ahead}`)).status).toBe(410);
    const meta = await (await get('/v1/meta')).json() as any;
    expect(meta.data.changes_cursor).toBe(first.page.next_cursor);
  });
  it('export: zstd bytes, sha256 and bytes of the manifest are of the compressed file, merged nodes follow the profile', async () => {
    const { createHash } = await import('node:crypto');
    const { zstdDecompressSync } = await import('node:zlib');
    const m = await (await get('/v1/export/graph/manifest')).json() as any;
    for (const profile of ['core', 'full'] as const) {
      const r = await get(`/v1/export/graph?profile=${profile}`);
      expect(r.headers.get('content-type')).toBe('application/zstd'); expect(r.headers.get('content-encoding')).toBeNull();
      const bytes = Buffer.from(await r.arrayBuffer());
      expect(bytes.length).toBe(m.data.profiles[profile].bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(m.data.profiles[profile].sha256);
      expect(r.headers.get('etag')).toBe(`"${m.data.profiles[profile].sha256}"`);
      const file = JSON.parse(zstdDecompressSync(bytes).toString('utf8'));
      const ids = file.nodes.rows.map((x: string[]) => x[0]);
      expect(ids.includes('e:feature:legacy-hooks')).toBe(profile === 'full');
      for (const e of file.edges.rows) expect(ids.includes(e[1]) && ids.includes(e[2])).toBe(true);
    }
  });
  it('export is 503 not_ready before the first publication', async () => {
    const a = createKbMock({ exportUnpublished: true });
    for (const p of ['/v1/export/graph/manifest', '/v1/export/graph']) { const r = await a.request(`http://localhost${p}`); expect(r.status).toBe(503); expect(r.headers.get('retry-after')).toBeTruthy(); }
  });
  it('a merge target carries the claims and edges of the merged id (C 2.7)', async () => {
    const j = await (await get('/v1/nodes/e:feature:claude-code-hooks?include=edges')).json() as any;
    expect([...j.data.edges.out, ...j.data.edges.in].some((e: any) => e.src === 'e:feature:legacy-hooks')).toBe(true);
  });
  it('history: chains hold every version, predicate filter narrows, versions list the id', async () => {
    const j = await (await get('/v1/nodes/c-3hd9x0w2raab/history')).json() as any;
    expect(j.data.chains).toHaveLength(1);
    expect(j.data.chains[0].items.map((i: any) => `${i.id}:${i.version}`)).toEqual(['c-3hd9x0w2raab:1', 'c-3hd9x0w2raab:2', 'c-8k2p4q7m1xcd:1']);
    expect(j.data.chains[0].items[1].superseded_by).toBe('c-8k2p4q7m1xcd');
    const none = await (await get('/v1/nodes/e:product:claude-code/history?predicate=nothing')).json() as any;
    expect(none.data.chains).toEqual([]);
  });
  it('facets count each axis without its own filter', async () => {
    const j = await (await get('/v1/facets?types=Feature&q=claude')).json() as any;
    const typeCounts = Object.fromEntries(j.data.facets.type.map((x: any) => [x.value, x.count]));
    expect(typeCounts.Product).toBe(1); // the type axis ignores types=Feature
    expect(j.data.total).toBe(typeCounts.Feature ?? 0);
  });
  it('filter ops: repeated filter is AND, in and prefix work', async () => {
    const j = await (await get('/v1/nodes?type=Feature&filter=product:eq:claude-code&filter=product:prefix:claude')).json() as any;
    expect(j.data.items.length).toBeGreaterThan(0);
    expect((await get('/v1/nodes?filter=nosuch:eq:x')).status).toBe(400);
    expect((await get('/v1/nodes?filter=product:in:claude-code,other')).status).toBe(200);
  });
  it('NOT_READY gates every route until its time is over', async () => {
    const a = createKbMock({ notReadyMs: 60_000 });
    const r = await a.request('http://localhost/v1/meta'); expect(r.status).toBe(503); expect(r.headers.get('retry-after')).toBeTruthy();
  });
  it('token mode: 401 token_required and token_invalid', async () => {
    const a = createKbMock({ token: 's3cret' });
    expect(((await (await a.request('http://localhost/v1/meta')).json()) as any).code).toBe('token_required');
    expect(((await (await a.request('http://localhost/v1/meta', { headers: { Authorization: 'Bearer nope' } })).json()) as any).code).toBe('token_invalid');
    expect((await a.request('http://localhost/v1/meta', { headers: { Authorization: 'Bearer s3cret' } })).status).toBe(200);
  });
});
