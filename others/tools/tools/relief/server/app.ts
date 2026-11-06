// GET-only HTTP surface. Takes no tool name and no path: the live side answers from memory (design 6.3).
import { Hono } from 'hono';
import { fixtureTrend } from '../dev/fixtures/gen.ts';
import { isChangeType, isCursor, PAGE_DEFAULT, PAGE_MAX } from './changes.ts';
import { isTimeframe } from './collect/allowlist.ts';
import { guard } from './guard.ts';
import type { Live } from './live.ts';
import { isFixture, loadFixture, type FixtureName } from './snapshot.ts';

export type ApiOptions = { fixture?: FixtureName; live?: Pick<Live, 'touch' | 'view' | 'viewMetrics' | 'status' | 'trend' | 'changes'> };

export function createApi({ fixture: defaultFixture = 'today', live }: ApiOptions = {}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const r = guard((n) => c.req.header(n), c.req.path);
    if (r) return c.json({ error: r.code, message: r.message }, r.status);
    await next();
  });
  app.get('/api/snapshot', async (c) => {
    const q = c.req.query('fixture');
    if (live) {
      if (q !== undefined) return c.json({ error: 'unknown_fixture' }, 404); // Synthetic data is never served next to the real map.
      live.touch();
      const { snapshot, etag } = live.view();
      if (c.req.header('if-none-match') === etag) return c.body(null, 304, { etag, 'cache-control': 'no-cache' });
      return c.json(snapshot, 200, { etag, 'cache-control': 'no-cache' });
    }
    if (q !== undefined && !isFixture(q)) return c.json({ error: 'unknown_fixture' }, 404);
    const snap = await loadFixture(q ?? defaultFixture);
    return c.json(snap, 200, { 'cache-control': 'no-store' });
  });
  app.get('/api/metrics', (c) => c.json(live?.viewMetrics() ?? { at: null, values: {} }, 200, { 'cache-control': 'no-store' }));
  // The id names an object already on the map. Both answers are built from memory or the allowlist: nothing in the query reaches a path.
  app.get('/api/trend', async (c) => {
    const id = c.req.query('id'); const tf = c.req.query('tf') ?? 'hour'; const q = c.req.query('fixture');
    if (!id || id.length > 200 || !isTimeframe(tf)) return c.json({ error: 'bad_request' }, 400);
    const noStore = { 'cache-control': 'no-store' };
    if (live) {
      if (q !== undefined) return c.json({ error: 'unknown_fixture' }, 404);
      const t = await live.trend(id, tf);
      return t ? c.json(t, 200, noStore) : c.json({ error: 'unknown_object' }, 404);
    }
    if (q !== undefined && !isFixture(q)) return c.json({ error: 'unknown_fixture' }, 404);
    const snap = await loadFixture(q ?? defaultFixture);
    return snap.nodes.some((n) => n.id === id) ? c.json(fixtureTrend(id, tf, Date.now()), 200, noStore) : c.json({ error: 'unknown_object' }, 404);
  });
  app.get('/api/changes', (c) => {
    const num = (v: string | undefined) => (v === undefined ? undefined : /^\d{1,7}$/.test(v) ? Number(v) : NaN);
    const limit = num(c.req.query('limit')) ?? PAGE_DEFAULT; const cursor = c.req.query('before');
    const before = cursor !== undefined && isCursor(cursor) ? Number(cursor) : undefined;
    const type = c.req.query('type'); const id = c.req.query('id');
    if (Number.isNaN(limit) || limit < 1 || limit > PAGE_MAX || (cursor !== undefined && before === undefined) || (type !== undefined && !isChangeType(type)) || (id !== undefined && id.length > 200)) return c.json({ error: 'bad_request' }, 400);
    return c.json(live?.changes({ limit, before, type, id }) ?? { items: [], next: null, total: 0 }, 200, { 'cache-control': 'no-store' });
  });
  app.get('/api/status', (c) => c.json(live?.status() ?? { fixture: true }, 200, { 'cache-control': 'no-store' }));
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));
  return app;
}
