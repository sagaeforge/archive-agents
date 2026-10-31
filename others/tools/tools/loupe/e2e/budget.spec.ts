// The section 11 rows that apply to Phase 1 screens, measured in the browser through loupe serve. kb-mock stands in for the KB, so these
// show what the viewer and the proxy cost, and the design says the verdict belongs to the real KB. GPU rows are not here (SwiftShader, design 11).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './support/test.ts';
import { logDir, RESEARCH } from './support/ports.ts';
import { settled } from './support/app.ts';

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]! * 10) / 10; };
const out: Record<string, unknown> = {};
const ids = ['e:library:sigma-js', 'e:project:sagae-gateway', 'e:spike:s1-aggregation', 'e:tool:orval', 'e:library:graphology'];
const N = 40;
const IN_BROWSER = async (urls: string[]) => {
  const ms: number[] = [];
  for (const u of urls) { const t0 = performance.now(); await (await fetch(u, { cache: 'no-store', credentials: 'omit' })).text(); ms.push(performance.now() - t0); }
  return ms;
};

test.afterAll(() => {
  mkdirSync(logDir, { recursive: true });
  writeFileSync(path.join(logDir, 'budgets.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out));
});

test('detail, neighbors and search stay under 200 ms at p95; the warm overview under 2 s', async ({ page }) => {
  await page.goto(`${RESEARCH}/`);
  await page.getByTestId('home-entity').first().waitFor();
  const rows: Record<string, string[]> = {
    detail: ids.map((id) => `kb/v1/nodes/${encodeURIComponent(id)}?include=claims%2Cedges%2Cbacklinks%2Cbody&claim_limit=50&edge_limit=200`),
    neighbors: ids.map((id) => `kb/v1/nodes/${encodeURIComponent(id)}/neighbors?depth=1&direction=both&limit=200`),
    search: ['mcp', 'sigma', '게이트웨이', 'graph', '포트'].map((q) => `kb/v1/search?q=${encodeURIComponent(q)}&kinds=entity%2Crecord&limit=12`),
    'overview (warm)': ['kb/v1/overview?limit=10000&edge_limit=50000'],
  };
  for (const [name, urls] of Object.entries(rows)) {
    const list = Array.from({ length: N }, (_, i) => urls[i % urls.length]!);
    await page.evaluate(IN_BROWSER, list.slice(0, 5));
    const ms = await page.evaluate(IN_BROWSER, list);
    out[name] = { n: ms.length, p50_ms: pct(ms, 0.5), p95_ms: pct(ms, 0.95), budget_ms: name.startsWith('overview') ? 2000 : 200 };
    expect(pct(ms, 0.95), name).toBeLessThan(name.startsWith('overview') ? 2000 : 200);
  }
});

test('screen timings: entity, quote, palette and the first rendered Markdown', async ({ page, context }) => {
  void context;
  // Entity: navigation to first claims on screen, in a page that already runs (the common case)
  await page.goto(`${RESEARCH}/`);
  await page.getByTestId('home-entity').first().waitFor();
  const entity: number[] = [];
  for (let i = 0; i < 15; i++) {
    const id = ids[i % ids.length]!;
    const ms = await page.evaluate(async (hash) => {
      const t0 = performance.now();
      location.hash = hash;
      await new Promise<void>((res) => { const tick = () => { if (document.querySelector(`main[data-id="${decodeURIComponent(hash.split('/').pop()!)}"] [data-testid=claim-card]`)) res(); else requestAnimationFrame(tick); }; tick(); });
      return performance.now() - t0;
    }, `#/node/${encodeURIComponent(id)}`);
    entity.push(ms);
    await page.evaluate(() => { location.hash = '#/'; });
    await page.getByTestId('home').waitFor();
  }
  out['entity page, navigation to claims'] = { n: entity.length, p50_ms: pct(entity, 0.5), p95_ms: pct(entity, 0.95) };

  // A cold deep link to a quote: load to painted highlight
  const quote: number[] = [];
  for (let i = 0; i < 8; i++) {
    await page.goto('about:blank');
    const t0 = Date.now();
    await page.goto(`${RESEARCH}/#/source/n-b0b5bb5257562d33?claim=c-9c513f2de839`);
    await page.waitForFunction(() => (CSS.highlights?.get('loupe-quote')?.size ?? 0) > 0);
    quote.push(Date.now() - t0);
  }
  out['deep link to a quote, load to highlight'] = { n: quote.length, p50_ms: pct(quote, 0.5), p95_ms: pct(quote, 0.95) };

  // Palette: last key to the first result on screen. The debounce is 150 ms of that.
  await page.goto(`${RESEARCH}/`);
  await page.getByTestId('home-entity').first().waitFor();
  const palette: number[] = [];
  for (const q of ['sigma', 'orval', 'hono', 'mcp', 'graphology', 'cmdk', 'typescript', 'gephi']) {
    await page.keyboard.press('Control+k');
    await page.getByTestId('palette-input').waitFor();
    await page.keyboard.type(q);
    const t0 = Date.now();
    await page.getByTestId('palette-hit').first().waitFor();
    palette.push(Date.now() - t0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('palette-input')).toHaveCount(0);
  }
  out['palette, last key to first result (150 ms debounce included)'] = { n: palette.length, p50_ms: pct(palette, 0.5), p95_ms: pct(palette, 0.95) };

  // First render of Markdown, worker start and Shiki included
  await page.goto('about:blank');
  await page.goto(`${RESEARCH}/#/source/n-b0b5bb5257562d33`);
  await page.getByTestId('source-text').waitFor();
  await settled(page);
  const t0 = Date.now();
  await page.getByTestId('tab-rendered').click();
  await page.getByTestId('rendered').waitFor({ timeout: 15_000 });
  out['rendered tab, 100k characters, cold worker'] = { ms: Date.now() - t0 };
});
