// The graph against the live KB through a running `loupe serve`. Off unless LOUPE_LIVE_URL is set, because the suite must not need a live KB (design 11).
//   LOUPE_LIVE_URL=http://127.0.0.1:4813 npx playwright test e2e/graph-live.spec.ts
import { test, expect, hash } from './support/test.ts';
import type { GraphView } from '../src/graph/view.ts';

const LIVE = process.env.LOUPE_LIVE_URL;
test.skip(!LIVE, 'set LOUPE_LIVE_URL to run against the live KB');
type W = { __loupeGraph: GraphView };

test('the overview, a hit, the panel and an expansion all work on the live KB', async ({ page, watch }) => {
  test.setTimeout(90_000);
  const stage = page.getByTestId('graph-screen');
  await page.goto(`${LIVE}${hash('/graph')}`);
  await expect(stage).toHaveAttribute('data-layout', /^(hit|soft|cold)$/, { timeout: 30_000 });
  await expect(stage).toHaveAttribute('data-source', 'core');
  const overview = await (await page.request.get(`${LIVE}/kb/v1/overview?limit=10000&edge_limit=50000`)).json();
  await expect(stage).toHaveAttribute('data-nodes', String(overview.data.nodes.rows.length));
  await page.reload();
  await expect(stage).toHaveAttribute('data-layout', 'hit', { timeout: 30_000 });
  expect(watch.kbPaths().filter((p) => p.startsWith('/v1/export/graph?')).length, 'at most the first open downloaded the export').toBeLessThanOrEqual(1);

  const target = await page.evaluate(() => { const v = (window as unknown as W).__loupeGraph; const id = [...v.graph.nodes()].sort((a, b) => v.graph.degree(b) - v.graph.degree(a))[0]!; return { id, ...v.viewportOf(id) }; });
  const box = (await page.getByTestId('graph-canvas').boundingBox())!;
  await page.mouse.move(box.x + target.x, box.y + target.y);
  await page.mouse.click(box.x + target.x, box.y + target.y);
  await expect(page.getByTestId('graph-panel')).toHaveAttribute('data-id', target.id);
  await expect(page.getByTestId('graph-relation').first()).toBeVisible();

  await page.getByTestId('graph-panel-expand').click();
  await expect.poll(() => watch.kbPaths().some((p) => p.includes('/neighbors?'))).toBe(true);
  await expect(page.getByTestId('graph-panel')).toHaveAttribute('data-id', target.id);
  await page.getByTestId('graph-filter-type').locator('input').first().uncheck();
  await expect(page).toHaveURL(/types=/);
  await expect.poll(async () => Number(await stage.getAttribute('data-nodes'))).toBeLessThan(overview.data.nodes.rows.length);

  await page.getByTestId('graph-panel-open').click();
  await expect(page.getByTestId('node-id')).toHaveText(target.id);
  void watch;
});
