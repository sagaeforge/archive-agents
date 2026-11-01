// GET-only HTTP surface. Takes no tool name and no path: the live side answers from memory (design 6.3).
import { Hono } from 'hono';
import { guard } from './guard.ts';
import type { Live } from './live.ts';
import { isFixture, loadFixture, type FixtureName } from './snapshot.ts';

export type ApiOptions = { fixture?: FixtureName; live?: Pick<Live, 'touch' | 'view' | 'viewMetrics' | 'status'> };

export function createApi({ fixture: defaultFixture = 'today', live }: ApiOptions = {}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const r = guard((n) => c.req.header(n));
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
  app.get('/api/status', (c) => c.json(live?.status() ?? { fixture: true }, 200, { 'cache-control': 'no-store' }));
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));
  return app;
}
