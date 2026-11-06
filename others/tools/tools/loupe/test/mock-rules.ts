// The contract rules kb-mock must enforce (design 8: C 2.3, 2.4, 2.5, 2.7, 2.9). Returns the names of the rules that fail.
// The mock tests expect an empty list; the negative controls (KB_MOCK_BUG) expect a non-empty one.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Hono } from 'hono';

export async function checkMockRules(app: Hono): Promise<string[]> {
  const failed: string[] = [];
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await app.request(`http://127.0.0.1${path}`, { headers });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { res, json, text };
  };
  const rule = async (name: string, f: () => Promise<boolean> | boolean) => { try { if (!(await f())) failed.push(name); } catch { failed.push(name + ' (threw)'); } };

  // 2.1 envelope
  await rule('2.1 envelope fields', async () => {
    const { json } = await get('/v1/meta');
    return ['schema_version', 'epoch', 'build_id', 'data_as_of', 'applied_seq', 'as_of', 'degraded', 'data'].every((k) => k in json);
  });
  // 2.3 errors
  await rule('2.3 404 is problem+json with code', async () => { const { res, json } = await get('/v1/nodes/e:nope:none'); return res.status === 404 && /problem\+json/.test(res.headers.get('content-type') ?? '') && json.code === 'not_found'; });
  await rule('2.3 405 is problem+json', async () => { const res = await app.request('http://127.0.0.1/v1/meta', { method: 'POST' }); return res.status === 405 && /problem\+json/.test(res.headers.get('content-type') ?? ''); });
  await rule('2.3 limit over max is 400 limit_too_large', async () => { const { res, json } = await get('/v1/nodes?limit=501'); return res.status === 400 && json.code === 'limit_too_large'; });
  await rule('2.3 unknown parameter is 400 bad_param', async () => { const { res, json } = await get('/v1/nodes?as_of_vaild=2026-01-01T00:00:00Z'); return res.status === 400 && json.code === 'bad_param'; });
  await rule('2.3 host_rejected 403', async () => { const res = await app.request('http://evil.example/v1/meta'); return res.status === 403; });
  await rule('2.3 q without a token is bad_param', async () => { const { res, json } = await get('/v1/search?q=%20'); return res.status === 400 && json.code === 'bad_param'; });
  // 2.4 cursors
  await rule('2.4 cursor from other filters is cursor_mismatch', async () => {
    const a = await get('/v1/nodes?limit=2');
    const { res, json } = await get(`/v1/nodes?limit=2&type=Feature&cursor=${a.json.page.next_cursor}`);
    return res.status === 400 && json.code === 'cursor_mismatch';
  });
  await rule('2.4 other epoch is 410 epoch_changed', async () => {
    const cur = Buffer.from(JSON.stringify({ k: 'x', h: 'y', e: 99 })).toString('base64url');
    const { res, json } = await get(`/v1/nodes?cursor=${cur}`);
    return res.status === 410 && json.code === 'epoch_changed';
  });
  await rule('2.4 keyset paging: no duplicate, no gap, ends with null', async () => {
    const all = (await get('/v1/nodes?limit=100')).json.data.items.map((r: any) => r.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const { json } = await get(`/v1/nodes?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...json.data.items.map((r: any) => r.id));
      cursor = json.page.next_cursor;
      if (cursor === null) break;
    }
    return cursor === null && seen.length === all.length && new Set(seen).size === seen.length;
  });
  // 2.5 ETag
  await rule('2.5 data ETag is epoch-applied_seq-build_id and 304 matches', async () => {
    const { res } = await get('/v1/schema');
    const etag = res.headers.get('etag') ?? '';
    if (!/^"1-\d+-g-[\w-]+"$/.test(etag)) return false;
    const again = await get('/v1/schema', { 'If-None-Match': etag });
    return again.res.status === 304;
  });
  await rule('2.5 text ETag is the snapshot id', async () => (await get('/v1/snapshots/n-3fa9c01b77aa12ef/text')).res.headers.get('etag') === '"n-3fa9c01b77aa12ef"');
  await rule('2.5 ops have no ETag', async () => (await get('/v1/ops/runs')).res.headers.get('etag') === null);
  // 2.7 default filters
  await rule('2.7 superseded hidden by default, shown by status=all', async () => {
    const def = (await get('/v1/nodes?type=Claim&limit=100')).json.data.items.map((r: any) => r.id);
    const all = (await get('/v1/nodes?type=Claim&status=all&include_unverified=true&limit=100')).json.data.items.map((r: any) => r.id);
    return !def.includes('c-sub120aaaaaa') && all.includes('c-sub120aaaaaa');
  });
  await rule('2.7 unverified hidden unless include_unverified', async () => {
    const def = (await get('/v1/nodes?type=Claim&limit=100')).json.data.items.map((r: any) => r.id);
    const inc = (await get('/v1/nodes?type=Claim&include_unverified=true&limit=100')).json.data.items.map((r: any) => r.id);
    return !def.includes('c-unver1cccccc') && inc.includes('c-unver1cccccc');
  });
  await rule('2.7 state claim of a dead subject is dead, event claim stays active', async () => {
    const def = (await get('/v1/nodes?type=Claim&limit=100')).json.data.items.map((r: any) => r.id);
    return !def.includes('c-dead1dddddd') && def.includes('c-8k2p4q7m1xab');
  });
  await rule('2.7 merged node leaves lists but direct lookup answers with merged_into', async () => {
    const list = (await get('/v1/nodes?limit=100')).json.data.items.map((r: any) => r.id);
    const { res, json } = await get('/v1/nodes/e:feature:legacy-hooks');
    return !list.includes('e:feature:legacy-hooks') && res.status === 200 && json.data.merged_into === 'e:feature:claude-code-hooks' && json.data.status === 'superseded';
  });
  await rule('2.7 sensitivity above internal is 404 and absent from lists, edges and the feed', async () => {
    const direct = (await get('/v1/nodes/e:concept:private-note')).res.status;
    const list = (await get('/v1/nodes?status=all&limit=100')).json.data.items.map((r: any) => r.id);
    const edges = (await get('/v1/nodes/e:product:claude-code?include=edges')).json.data.edges;
    const leaked = [...edges.out, ...edges.in].some((e: any) => e.src === 'e:concept:private-note' || e.dst === 'e:concept:private-note');
    const feed = (await get('/v1/changes')).json.data.items.filter((i: any) => i.id === 'e:concept:private-note');
    return direct === 404 && !list.includes('e:concept:private-note') && !leaked && feed.every((i: any) => i.kind === 'visibility.revoked');
  });
  // 2.9 time
  const retro = async (obs: string) => (await get(`/v1/nodes/e:product:claude-code?include=claims&as_of_valid=2025-06-01T00:00:00Z&as_of_observed=${obs}`)).json?.data?.claims?.map((c: any) => c.value) ?? [];
  await rule('2.9 retroactive correction: observed 2025-06-01 sees 120', async () => (await retro('2025-06-01T00:00:00Z')).includes('120'));
  await rule('2.9 retroactive correction: observed 2026-06-01 sees 150', async () => { const v = await retro('2026-06-01T00:00:00Z'); return v.includes('150') && !v.includes('120'); });
  await rule('2.9 default read applies the observed axis only (future-effective claim visible)', async () => {
    const v = (await get('/v1/nodes/e:product:claude-code?include=claims')).json.data.claims.map((c: any) => c.id);
    return v.includes('c-3hd9x0w2raab') && v.includes('c-8k2p4q7m1xcd');
  });
  await rule('2.9 valid axis picks one of the two future-effective claims', async () => {
    const v = (await get('/v1/nodes/e:product:claude-code?include=claims&as_of_valid=2026-12-01')).json.data.claims.map((c: any) => c.id);
    return v.includes('c-3hd9x0w2raab') && !v.includes('c-8k2p4q7m1xcd');
  });
  await rule('2.9 as_of is echoed in the envelope', async () => { const { json } = await get('/v1/nodes?as_of_valid=2026-01-01T00:00:00Z'); return json.as_of.valid === '2026-01-01T00:00:00Z' && json.as_of.observed === null; });
  for (const path of ['/v1/changes', '/v1/snapshots/n-3fa9c01b77aa12ef', '/v1/snapshots/n-3fa9c01b77aa12ef/text', '/v1/snapshots/n-3fa9c01b77aa12ef/raw', '/v1/meta', '/v1/schema', '/v1/nodes/e:product:claude-code/history', '/v1/export/graph/manifest', '/v1/export/graph', '/v1/ops/runs'])
    await rule(`2.9 ${path} refuses as_of with as_of_unsupported`, async () => { const { res, json } = await get(`${path}?as_of_observed=2026-01-01T00:00:00Z`); return res.status === 400 && json.code === 'as_of_unsupported'; });
  return failed;
}
