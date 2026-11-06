// Interaction (design 9.2, 9.4, 9.6): the 3D/2D round trip keeps the selection, the keyboard table, search and the list.
import { expect, test, type Page } from '@playwright/test';
import { audit } from './support/audit.ts';
import { clickObject } from './support/pick.ts';
import { BUILT } from './support/ports.ts';

const open = async (page: Page, hash: string) => {
  await page.goto(`${BUILT}/${hash}`);
  await page.waitForSelector('svg.scene g[data-id]');
  await page.evaluate(() => document.fonts.ready);
};
const hash = (page: Page) => page.evaluate(() => location.hash);
const sel = (page: Page) => page.evaluate(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('sel'));
const selected = (page: Page) => page.locator('svg.scene g[data-selected="1"]').getAttribute('data-id');

test('3D to 2D and back keeps the selection and the overlay', async ({ page }) => {
  await open(page, '#/?fx=large&overlay=basis');
  await clickObject(page, 'pve:node:node-2');
  await expect(page.getByTestId('object')).toContainText('노드 2');
  expect(await sel(page)).toBe('pve:node:node-2');
  await page.keyboard.press('Escape'); // The details are a modal now, and it holds the page until it closes.
  await page.getByTestId('mode-2d').click();
  await expect(page.getByTestId('mode-2d')).toHaveAttribute('aria-pressed', 'true');
  expect(await selected(page)).toBe('pve:node:node-2');
  await page.getByTestId('map').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('object')).toContainText('노드 2');
  await page.keyboard.press('Escape');
  expect(await hash(page)).toContain('overlay=basis');
  await page.keyboard.press('2');                       // the key does the same as the button
  await expect(page.getByTestId('mode-iso')).toHaveAttribute('aria-pressed', 'true');
  expect(await selected(page)).toBe('pve:node:node-2');
  expect(await hash(page)).toContain('sel=pve:node:node-2');
  await page.keyboard.press('Enter');
  expect(await hash(page)).toContain('open=1');
});

test('a copied link opens the same screen', async ({ page }) => {
  await open(page, '#/?fx=today&mode=2d&overlay=fresh&sel=pve:qemu:100&open=1');
  await expect(page.getByTestId('mode-2d')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('overlay-fresh')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('object')).toContainText('VM 100');
});

test('keyboard table', async ({ page }) => {
  await open(page, '#/?fx=large');
  await page.getByTestId('map').focus();
  // arrows: first press selects the first slab, then siblings in the screen direction
  await page.keyboard.press('ArrowDown');
  const first = await sel(page);
  expect(first).toMatch(/^pve:node:/);
  await page.keyboard.press('ArrowDown');
  const second = await sel(page);
  expect(second).not.toBe(first);
  // ] first child, [ parent
  await page.keyboard.press(']');
  const child = await sel(page);
  expect(child).not.toBe(second);
  await page.keyboard.press('[');
  expect(await sel(page)).toBe(second);
  // Enter opens the panel, Esc closes it, a second Esc clears the selection
  await expect(page.getByTestId('object')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('object')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('object')).toHaveCount(0);
  expect(await sel(page)).toBe(second);
  await page.keyboard.press('Escape');
  expect(await sel(page)).toBeNull();
  // 2 projection, 1 3 4 5 overlays
  await page.keyboard.press('2'); await expect(page.getByTestId('mode-2d')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('2'); await expect(page.getByTestId('mode-iso')).toHaveAttribute('aria-pressed', 'true');
  for (const [k, o] of [['3', 'load'], ['4', 'basis'], ['5', 'fresh'], ['1', 'state']] as const) {
    await page.keyboard.press(k);
    await expect(page.getByTestId(`overlay-${o}`)).toHaveAttribute('aria-pressed', 'true');
  }
  // + - 0 zoom and fit: zoom in changes the viewBox, 0 restores it
  const vb = () => page.locator('svg.scene').getAttribute('viewBox');
  const fit = await vb();
  await page.keyboard.press('+'); await page.keyboard.press('+');
  const zoomed = await vb();
  expect(zoomed).not.toBe(fit);
  await page.keyboard.press('0');
  expect(await vb()).toBe(fit);
  await page.keyboard.press('-');
  expect(await vb()).toBe(fit);                          // already at the widest view: the zoom floor is the fit
  // / and Ctrl+K focus search; Esc leaves it
  await page.keyboard.press('/'); await expect(page.getByTestId('palette-input')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByTestId('palette-input')).toHaveCount(0);
  await page.keyboard.press('Control+k'); await expect(page.getByTestId('palette-input')).toBeFocused();
  // typing in the palette does not trigger the shortcuts
  await page.keyboard.type('2'); await expect(page.getByTestId('mode-iso')).toHaveAttribute('aria-pressed', 'true');
});

test('Tab moves between the bar, the map and the panel', async ({ page }) => {
  await open(page, '#/?fx=today');
  const order: string[] = [];
  for (let i = 0; i < 18; i++) { // The bar has grown: page tabs, panel and theme. The map and the panel still follow it in that order.
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => { const a = document.activeElement as HTMLElement; return a.closest('header') ? 'bar' : a.closest('main') ? 'map' : a.closest('aside') ? 'panel' : a.tagName; }));
  }
  const compact = order.filter((v, i) => v !== order[i - 1]);
  expect(compact.slice(0, 3)).toEqual(['bar', 'map', 'panel']);
});

test('search dims what does not match, in the map and in the list', async ({ page }) => {
  await open(page, '#/?fx=large');
  await page.getByTestId('tab-list').click();
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-input').fill('결제');
  await page.waitForTimeout(400);
  expect(await hash(page)).toContain('q=');
  const ops = await page.evaluate(() => [...document.querySelectorAll('svg.scene g[data-id]')].map((g) => Number(g.getAttribute('opacity'))));
  expect(ops.filter((o) => o <= 0.25).length).toBeGreaterThan(100);
  expect(ops.some((o) => o === 1)).toBe(true);
  const items = await page.getByRole('treeitem').count();
  expect(items).toBeGreaterThan(0); expect(items).toBeLessThan(120);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('palette')).toHaveCount(0);
  expect(await sel(page)).toMatch(/^pve:/);
  await expect.poll(() => hash(page)).not.toContain('q=');
});

test('the list is the whole snapshot as a tree, each item with a name, state and basis', async ({ page }) => {
  await open(page, '#/?fx=large');
  await page.getByTestId('tab-list').click();
  await expect(page.getByRole('tree')).toBeVisible();
  expect(await page.getByRole('treeitem').count()).toBe(299);
  const labels = await page.getByRole('treeitem').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  expect(labels.every((l) => /근거 (관측|추정|선언|미확인)$/.test(l))).toBe(true);
  await page.getByRole('treeitem').nth(8).press('Enter');
  expect(await sel(page)).not.toBeNull();
});

test('dragging pans the map and does not select', async ({ page }) => {
  await open(page, '#/?fx=large');
  for (let i = 0; i < 3; i++) await page.keyboard.press('+');
  const vb = async () => (await page.locator('svg.scene').getAttribute('viewBox'))!.split(' ').map(Number);
  const a = await vb();
  await page.mouse.move(600, 400); await page.mouse.down(); await page.mouse.move(520, 360, { steps: 5 }); await page.mouse.up();
  const b = await vb();
  expect(b[0]).toBeGreaterThan(a[0]!);  // dragging left moves the camera right
  expect(await sel(page)).toBeNull();
});

test('a zoomed view still has clean labels and the leaf names appear', async ({ page }) => {
  await open(page, '#/?fx=large');
  const before = (await page.evaluate(audit)).labels;
  for (let i = 0; i < 6; i++) await page.keyboard.press('+');
  const a = await page.evaluate(audit);
  expect(a.overlaps).toEqual([]); expect(a.clipped).toEqual([]);
  expect(a.labels).toBeGreaterThan(0);
  expect(a.labels).not.toBe(before);
});

test('reduced motion is respected', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await open(page, '#/?fx=today');
  const t = await page.locator('svg.scene g[data-id]').first().evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(t).toBe('0s');
  await ctx.close();
});
