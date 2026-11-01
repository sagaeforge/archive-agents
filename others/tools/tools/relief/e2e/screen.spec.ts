// Screen checks (design 12): label overlap and clipping, basis on every object, screenshots of today and large.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { audit } from './support/audit.ts';
import { clickObject } from './support/pick.ts';
import { BUILT, shotDir } from './support/ports.ts';

mkdirSync(shotDir, { recursive: true });
const open = async (page: Page, hash: string) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BUILT}/${hash}`);
  await page.waitForSelector('svg.scene g[data-id]');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return errors;
};

const CASES = [
  { name: 'today-3d', hash: '#/?fx=today', objects: 16, minLabels: 8 },
  { name: 'today-2d', hash: '#/?fx=today&mode=2d', objects: 16, minLabels: 10 },
  { name: 'large-3d', hash: '#/?fx=large', objects: 299, minLabels: 8 },
  { name: 'large-2d', hash: '#/?fx=large&mode=2d', objects: 299, minLabels: 5 },
] as const;

for (const c of CASES) {
  test(`${c.name}: 0 overlaps, 0 clipped labels, basis on every object`, async ({ page }) => {
    const errors = await open(page, c.hash);
    const a = await page.evaluate(audit);
    await page.screenshot({ path: path.join(shotDir, `${c.name}.png`) });
    expect(errors).toEqual([]);
    expect(a.overlaps).toEqual([]);
    expect(a.clipped).toEqual([]);
    expect(a.overflow).toEqual([]);
    expect(a.orphans).toEqual([]);
    expect(a.far).toEqual([]);
    expect(a.offFace).toEqual([]);
    expect(a.noBasis).toBe(0);
    expect(a.noAria).toBe(0);
    expect(a.objects).toBe(c.objects); // exactly the snapshot's objects: nothing is drawn for an empty Docker layer
    expect(a.labels).toBeGreaterThanOrEqual(c.minLabels);
    expect(a.panelOverflow).toBe(false);
  });
}

test('every overlay keeps basis and clean labels', async ({ page }) => {
  await open(page, '#/?fx=large');
  for (const o of ['state', 'load', 'basis', 'fresh']) {
    await page.getByTestId(`overlay-${o}`).click();
    await expect(page.getByTestId(`overlay-${o}`)).toHaveAttribute('aria-pressed', 'true');
    const a = await page.evaluate(audit);
    expect(a.noBasis, o).toBe(0); expect(a.overlaps, o).toEqual([]); expect(a.clipped, o).toEqual([]);
  }
  await page.getByTestId('overlay-load').click();
  await page.screenshot({ path: path.join(shotDir, 'large-load.png') });
  expect(await page.locator('svg.scene [data-face="load"]').count()).toBeGreaterThan(50);
  await page.getByTestId('overlay-basis').click();
  await page.screenshot({ path: path.join(shotDir, 'large-basis.png') });
});

test('today shows honest blanks: no source, not zero, and no invented objects', async ({ page }) => {
  await open(page, '#/?fx=today');
  const tiers = await page.getByTestId('tiers').innerText();
  expect(tiers).toMatch(/Docker\s+출처 없음/);
  expect(tiers).toMatch(/QEMU 1 · LXC 0/);
  expect(await page.locator('svg.scene [data-kind="container"]').count()).toBe(0);
  expect(await page.locator('svg.scene [data-kind="wan"]').getAttribute('data-basis')).toBe('unknown');
  expect(await page.locator('svg.scene [data-kind="gateway"]').getAttribute('data-basis')).toBe('derived');
  await expect(page.locator('.lb', { hasText: 'Docker 계층' })).toHaveCount(0);
  await clickObject(page, 'pve:qemu:100');
  const panel = page.getByTestId('object');
  await expect(panel).toContainText('VM 100');
  await expect(panel.locator('[data-fact="ip"]')).toContainText('미확인 · guest agent 응답 없음');
  await expect(panel.locator('[data-fact="state"]')).toContainText('관측 · ');
  await page.screenshot({ path: path.join(shotDir, 'today-vm100-panel.png') });
});

test('large: the failed node and everything on it read as stale', async ({ page }) => {
  await open(page, '#/?fx=large');
  const op = (id: string) => page.locator(`svg.scene g[data-id="${id}"]`).getAttribute('opacity');
  expect(await op('pve:node:node-4')).toBe('0.5');
  expect(await op('pve:node:node-1')).toBe('1');
  const kids = await page.evaluate(() => [...document.querySelectorAll('svg.scene g[data-id]')].filter((g) => (g as SVGGElement).dataset.id!.includes('node-4') || false).length);
  expect(kids).toBeGreaterThan(0);
  await clickObject(page, 'pve:node:node-4');
  await expect(page.getByTestId('object')).toContainText('낡음');
});

test('the Docker plane: absent while the layer is empty, the layer stays in the panel', async ({ page }) => {
  await open(page, '#/?fx=today');
  expect(await page.locator('svg.scene [data-id="plane-docker"], svg.scene .plane').count()).toBe(0);
  await expect(page.getByTestId('tiers')).toContainText('출처 없음');
  expect(await page.getByTestId('holes').innerText()).toContain('Docker');
  // large has Docker hosts: their pads and containers are drawn, and still no empty-layer plane
  await open(page, '#/?fx=large');
  expect(await page.locator('svg.scene [data-kind="container"]').count()).toBe(188);
  expect(await page.locator('svg.scene [data-id="plane-docker"]').count()).toBe(0);
});
