// GET-only HTTP surface. Phase 1 serves a fixture; the route shape is the one Phase 2 keeps.
import { Hono } from 'hono';
import { guard } from './guard.ts';
import { isFixture, loadFixture, type FixtureName } from './snapshot.ts';

export function createApi(defaultFixture: FixtureName = 'today') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const r = guard((n) => c.req.header(n));
    if (r) return c.json({ error: r.code, message: r.message }, r.status);
    await next();
  });
  app.get('/api/snapshot', async (c) => {
    const q = c.req.query('fixture');
    if (q !== undefined && !isFixture(q)) return c.json({ error: 'unknown_fixture' }, 404);
    const snap = await loadFixture(q ?? defaultFixture);
    return c.json(snap, 200, { 'cache-control': 'no-store' });
  });
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));
  return app;
}
