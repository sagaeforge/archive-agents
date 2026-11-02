// Not a mobile version: a check that this screen does not block one (design 9.13). A tablet width and a phone width, with a finger.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { BUILT } from './support/ports.ts';

const VM = 'pve:qemu:100';
const open = async (browser: Browser, width: number, height: number, hash = '#/?fx=today') => {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`${BUILT}/${hash}`);
  await page.waitForSelector('svg.scene g[data-id]');
  await page.waitForTimeout(250);
  return { ctx, page };
};
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 && document.body.scrollWidth <= document.body.clientWidth + 1);
const tapOn = async (page: Page, id: string) => {
  const p = await page.evaluate((want) => {
    const g = document.querySelector(`svg.scene g[data-id="${CSS.escape(want)}"]`)!;
    for (const f of g.querySelectorAll('polygon')) {
      const r = f.getBoundingClientRect();
      for (let i = 1; i < 10; i++) for (let j = 1; j < 10; j++) { const x = r.left + (r.width * i) / 10; const y = r.top + (r.height * j) / 10; if ((document.elementFromPoint(x, y)?.closest('[data-id]') as HTMLElement | null)?.dataset.id === want) return [x, y] as const; }
    }
    return null;
  }, id);
  await page.touchscreen.tap(p![0], p![1]);
};

for (const [name, w, h] of [['tablet', 820, 1180], ['phone', 430, 932]] as const) {
  test.describe(`${name} (${w} px)`, () => {
    test('the modal opens and fits, the palette opens from a visible button, nothing scrolls sideways', async ({ browser }) => {
      const { ctx, page } = await open(browser, w, h);
      expect(await noSideScroll(page)).toBe(true);
      await tapOn(page, VM);
      await expect(page.getByTestId('status-menu')).toHaveAttribute('data-for', VM);
      await tapOn(page, VM);
      const m = page.getByTestId('modal');
      await expect(m).toBeVisible();
      const b = (await m.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(w);
      await page.getByTestId('trends').waitFor();
      await page.getByTestId('chart-cpu').waitFor();
      expect(await page.locator('.modal-body').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
      expect(await noSideScroll(page)).toBe(true);
      await page.getByTestId('modal-close').tap();
      await expect(m).toHaveCount(0);
      await page.getByTestId('palette-open').tap();
      const p = page.getByTestId('palette');
      await expect(p).toBeVisible();
      const q = (await p.boundingBox())!;
      expect(q.x).toBeGreaterThanOrEqual(0); expect(q.x + q.width).toBeLessThanOrEqual(w);
      await page.getByTestId('palette-input').fill('저장소');
      await expect(page.getByTestId('palette-list').getByRole('option').first()).toBeVisible();
      expect(await noSideScroll(page)).toBe(true);
      await ctx.close();
    });
    test('the panel folds away by itself and opens over the map when asked', async ({ browser }) => {
      const { ctx, page } = await open(browser, w, h);
      await expect(page.locator('aside')).toBeHidden();
      expect((await page.getByTestId('map').boundingBox())!.width).toBe(w);
      await page.getByTestId('panel-toggle').tap();
      await expect(page.locator('aside')).toBeVisible();
      expect((await page.locator('aside').boundingBox())!.width).toBeLessThanOrEqual(w);
      expect((await page.getByTestId('map').boundingBox())!.width).toBe(w);
      expect(await noSideScroll(page)).toBe(true);
      await ctx.close();
    });
  });
}

test('a finger: the first tap shows the menu, its button opens the modal', async ({ browser }) => {
  const { ctx, page } = await open(browser, 820, 1180);
  await tapOn(page, VM);
  await expect(page.getByTestId('modal')).toHaveCount(0);
  await page.getByTestId('menu-open').tap();
  await expect(page.getByTestId('modal')).toBeVisible();
  await ctx.close();
});

test('a tap on nothing clears it, and another object starts again', async ({ browser }) => {
  const { ctx, page } = await open(browser, 820, 1180);
  await tapOn(page, VM);
  await tapOn(page, 'pve:node:node-2');
  await expect(page.getByTestId('status-menu')).toHaveAttribute('data-for', 'pve:node:node-2');
  await expect(page.getByTestId('modal')).toHaveCount(0);
  await ctx.close();
});

test('what a hover says on a desktop, a button says on glass', async ({ browser }) => {
  const { ctx, page } = await open(browser, 430, 932, '#/?fx=today&sel=pve:qemu:100&open=1');
  await page.getByTestId('object').waitFor();
  await expect(page.getByTestId('fact-note')).toHaveCount(0);
  await page.getByTestId('facts-notes').tap();
  await expect(page.locator('[data-fact="ip"] [data-testid="fact-note"]')).toContainText('guest agent 응답 없음');
  await ctx.close();
});

test('a mouse still opens the modal on its first click', async ({ page }) => {
  await page.goto(`${BUILT}/#/?fx=today`);
  await page.waitForSelector('svg.scene g[data-id]');
  const b = (await page.locator(`g[data-id="${VM}"] [data-face="top"]`).first().boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(page.getByTestId('modal')).toBeVisible();
});

test('two fingers zoom the map', async ({ browser }) => {
  const { ctx, page } = await open(browser, 820, 1180);
  const cdp = await ctx.newCDPSession(page);
  const box = (await page.getByTestId('map').boundingBox())!;
  const c = [box.x + box.width / 2, box.y + box.height / 2] as const;
  const at = (d: number) => [{ x: c[0] - d, y: c[1], id: 1 }, { x: c[0] + d, y: c[1], id: 2 }];
  const before = await page.locator('svg.scene').getAttribute('viewBox');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(40) });
  for (const d of [60, 90, 130, 170]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(d) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => page.locator('svg.scene').getAttribute('viewBox')).not.toBe(before);
  await ctx.close();
});
