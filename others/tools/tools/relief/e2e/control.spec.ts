// The control room (design 9.8, 9.9, 9.10): summary, cards, trends, history, service checks, both themes, every kind on one map.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startMock } from '../dev/mcp-mock/mock.ts';
import { startLive } from '../server/serve.ts';
import { audit } from './support/audit.ts';
import { clickObject } from './support/pick.ts';
import { BUILT, root, shotDir } from './support/ports.ts';

const TOKEN = 'e2e-synthetic-token-0123456789abcdefghijklmnop';
const PORT = { live: 4823, mock: 4824 };
const open = async (page: Page, hash: string) => {
  await page.goto(`${BUILT}/${hash}`);
  await page.waitForSelector('svg.scene g[data-id]');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
};

/** Text contrast against the nearest opaque background, as WCAG computes it. A selector that finds nothing is a failure: a skipped check proves nothing. */
const contrast = (required: string[]) => {
  const parse = (c: string) => { const m = c.match(/[\d.]+/g)!.map(Number); return { r: m[0]!, g: m[1]!, b: m[2]!, a: m[3] ?? 1 }; };
  const lum = ({ r, g, b }: { r: number; g: number; b: number }) => { const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const probe = document.createElement('canvas').getContext('2d')!;
  const flat = (css: string) => { probe.clearRect(0, 0, 1, 1); probe.fillStyle = '#000'; probe.fillStyle = css; probe.fillRect(0, 0, 1, 1); const d = probe.getImageData(0, 0, 1, 1).data; return { r: d[0]!, g: d[1]!, b: d[2]!, a: d[3]! / 255 }; };
  const under = (el: Element | null): { r: number; g: number; b: number } => { for (let e = el; e; e = e.parentElement) { const c = flat(getComputedStyle(e).backgroundColor); if (c.a === 1) return c; } return { r: 255, g: 255, b: 255 }; };
  const out: [string, number][] = [];
  for (const sel of required) {
    const el = document.querySelector(sel);
    if (!el) { out.push([`missing ${sel}`, 0]); continue; }
    out.push([sel, ratio(lum(flat(getComputedStyle(el).color)), lum(under(el)))]);
  }
  const pill = document.querySelector('.lb rect'); const text = document.querySelector('.lb text');
  if (pill && text) { const p = parse(getComputedStyle(pill).fill); const u = under(document.querySelector('.map')); const m = { r: p.r * p.a + u.r * (1 - p.a), g: p.g * p.a + u.g * (1 - p.a), b: p.b * p.a + u.b * (1 - p.a) }; out.push(['.lb text', ratio(lum(parse(getComputedStyle(text).fill)), lum(m))]); }
  // Every text token on every surface it can land on, whether or not this screen happens to show the pair.
  const root = getComputedStyle(document.documentElement); const v = (n: string) => flat(root.getPropertyValue(n).trim());
  for (const t of ['--text', '--text-2', '--text-3']) for (const bg of ['--surface', '--surface-2', '--bg']) out.push([`${t} on ${bg}`, ratio(lum(v(t)), lum(v(bg)))]);
  out.push(['--on-accent on --accent', ratio(lum(v('--on-accent')), lum(v('--accent')))]);
  out.push(['--accent on --surface', ratio(lum(v('--accent')), lum(v('--surface')))]);
  return out;
};
const BASE = ['.brand', '.verdict', '.stat dt', '.stat b', '.seg button:not(.on)', '.seg button.on', '.legend', '.legend .hint', '.tabs button', '.card > h3', '.tiers i', '.tiers span', '.holes span', '.synthetic', '.find', '.plain', 'kbd'];

for (const [theme, hash] of [['dark', ''], ['light', '&theme=light']] as const) {
  for (const [name, h] of [['today', '#/?fx=today'], ['large', '#/?fx=large']] as const) {
    test(`${name} ${theme}: clean labels, sufficient contrast`, async ({ page }) => {
      await open(page, h + hash);
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      const a = await page.evaluate(audit);
      expect(a.overlaps).toEqual([]); expect(a.clipped).toEqual([]); expect(a.noBasis).toBe(0); expect(a.panelOverflow).toBe(false);
      for (const [sel, r] of await page.evaluate(contrast, [...BASE, ...(name === 'large' ? ['.finds b', '.finds span'] : [])])) expect(r, sel).toBeGreaterThanOrEqual(4.5);
      await page.screenshot({ path: join(shotDir, `${name}-${theme}.png`) });
    });
    test(`${name} ${theme}: the selected row of the list, the modal, the palette and the history read as well`, async ({ page }) => {
      await open(page, `${h}${hash}&sel=pve:node:node-1`);
      await page.getByTestId('tab-list').click();
      for (const [sel, r] of await page.evaluate(contrast, ['.tree li.on .t', '.tree li.on .m', '.tree li:not(.on) .m'])) expect(r, sel).toBeGreaterThanOrEqual(4.5);
      await page.getByTestId('map').focus(); await page.keyboard.press('Enter');
      await page.getByTestId('chart-cpu').waitFor();
      for (const [sel, r] of await page.evaluate(contrast, ['.modal .sub', '.modal .card > h3', '.facts .k', '.facts .v', '.meter em', '.chart .line', '.traffic', '.traffic b', '.modal-close'])) expect(r, sel).toBeGreaterThanOrEqual(4.5);
      await page.keyboard.press('Escape');
      await page.keyboard.press('/');
      await page.getByTestId('palette-input').fill('노드');
      for (const [sel, r] of await page.evaluate(contrast, ['.palette input', '.palette li.on .t', '.palette li.on .m', '.palette li:not(.on) .m'])) expect(r, sel).toBeGreaterThanOrEqual(4.5);
      await page.keyboard.press('Escape');
      await page.keyboard.press('h');
      await page.getByTestId('history').waitFor();
      for (const [sel, r] of await page.evaluate(contrast, ['.history h2', '.filters label'])) expect(r, sel).toBeGreaterThanOrEqual(4.5);
    });
  }
}

test('dark is the default, the choice is kept, and the key does what the button does', async ({ page }) => {
  await open(page, '#/?fx=today');
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await theme()).toBe('dark');
  const dark = await bg();
  await page.getByTestId('theme').click();
  expect(await theme()).toBe('light');
  expect(await bg()).not.toBe(dark);
  await page.reload(); await page.waitForSelector('svg.scene g[data-id]');
  expect(await theme()).toBe('light');
  await page.keyboard.press('t');
  expect(await theme()).toBe('dark');
});

test('colours reach the SVG through tokens that resolve', async ({ page }) => {
  await open(page, '#/?fx=today');
  const fill = await page.evaluate(() => getComputedStyle(document.querySelector('g[data-kind="vm"] [data-face="top"]')!).fill);
  expect(fill).not.toBe('none'); expect(fill).not.toBe('rgb(0, 0, 0)');
});

test('the summary counts what is wrong and the panel lists it', async ({ page }) => {
  await open(page, '#/?fx=large');
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'problem');
  await expect(page.getByTestId('stat-problems')).toContainText('3');
  await expect(page.getByTestId('stat-warnings')).toContainText('1');
  await expect(page.getByTestId('stat-stale')).toContainText('1');
  await expect(page.getByTestId('stat-last')).toContainText('전');
  const first = page.getByTestId('findings').getByRole('button').first();
  await expect(first).toContainText('서비스 응답 없음');
  await first.click();
  await expect(page.getByTestId('object')).toHaveAttribute('data-obj', 'pve:node:node-1');
  await expect(page.getByTestId('alerts')).toContainText('서비스 응답 없음');
  await expect(page.getByTestId('services').locator('li[data-status="down"]')).toContainText('응답 없음');
  await expect(page.getByTestId('services').locator('li[data-status="up"]')).toContainText('3 ms');
  await expect(page.locator('svg.scene g[data-id="pve:node:node-1"]')).toHaveAttribute('data-alert', 'problem');
  await expect(page.locator('.lb.alert[data-for="pve:node:node-1"]')).toHaveCount(1);
});

test('a calm map says so, and counts what it could not compare', async ({ page }) => {
  await open(page, '#/?fx=today');
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'healthy');
  await expect(page.getByTestId('findings-none')).toBeVisible();
  await expect(page.getByTestId('stat-blanks')).toBeVisible();
});

test('the modal opens with its trends: one window, four charts, limits, a table, hover', async ({ page }) => {
  const asks: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/trend')) asks.push(new URL(r.url()).search); });
  await open(page, '#/?fx=today');
  expect(asks).toEqual([]);                                      // nothing is read until a panel asks
  await clickObject(page, 'pve:node:node-2');
  const t = page.getByTestId('trends');
  await expect(t.getByTestId('chart-cpu').locator('polyline.c-line')).toHaveCount(1);
  await expect(t.getByTestId('chart-net').locator('polyline.c-line')).toHaveCount(2);
  await expect(t.getByTestId('limit-cpu')).toHaveCount(1); await expect(t.getByTestId('limit-disk')).toHaveCount(1);
  expect(asks).toHaveLength(1);
  await t.getByTestId('tf-day').click();
  await expect(t).toHaveAttribute('data-tf', 'day');
  await expect.poll(() => asks.at(-1)).toContain('tf=day');
  await t.getByTestId('chart-cpu').locator('svg').hover();
  await expect(t.locator('.c-tip')).toContainText('CPU');
  await t.getByText('표로 보기').click();
  await expect(t.getByTestId('trend-table').locator('tbody tr')).toHaveCount(70);
  expect(await page.locator('.modal-body').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
});

test('a value PVE does not give is "해당 없음", not a flat line and not a blank', async ({ page }) => {
  await open(page, '#/?fx=today&sel=pve:qemu:100&open=1');
  await expect(page.getByTestId('chart-disk')).toHaveAttribute('data-empty', '1');
  await expect(page.getByTestId('chart-disk')).toContainText('해당 없음');
  await expect(page.getByTestId('chart-disk').locator('polyline')).toHaveCount(0);
  await expect(page.locator('.meter[data-check="disk"]')).toHaveAttribute('data-verdict', 'na');
  await expect(page.locator('.meter[data-check="disk"] .track i')).toHaveCount(0);
  await expect(page.locator('.meter[data-check="disk"]')).toContainText('해당 없음');
  await expect(page.locator('.meter[data-check="cpu"]')).toHaveAttribute('data-verdict', 'under');
});

test('live: every kind stands on the map, the history links to objects, a service that does not answer is a problem', async ({ page }) => {
  test.setTimeout(60_000);
  const dir = mkdtempSync(join(tmpdir(), 'relief-e2e-'));
  mkdirSync(join(dir, 'tower'));
  writeFileSync(join(dir, 'tower/token'), TOKEN, { mode: 0o600 });
  writeFileSync(join(dir, 'relief.json'), JSON.stringify({ towerUrl: `http://127.0.0.1:${PORT.mock}/mcp`, thresholds: { cpu: 3, sustainS: 15 } }));
  const example = JSON.parse(readFileSync(join(root, 'fixtures/edge.example.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(dir, 'edge.json'), JSON.stringify({ ...example, services: [{ title: '관리 화면', host: 'node-1', protocol: 'tcp', port: 8006 }] }));
  const env = { ...process.env, TOWER_CONFIG: join(dir, 'tower/tower.json'), RELIEF_CONFIG: dir, RELIEF_STATE: join(dir, 'state') } as NodeJS.ProcessEnv;
  const mock = await startMock({ port: PORT.mock, token: TOKEN });
  const server = await startLive({ port: PORT.live, env, dist: join(root, 'dist'), period: { fastS: 5, activeS: 5, idleS: 5, minTtlS: 15, guestTickS: 1, edgeS: 1, healthS: 1 } });
  try {
    await page.goto(`http://127.0.0.1:${PORT.live}/`);
    await page.waitForSelector('svg.scene g[data-kind="vm"]');
    const node = page.locator('svg.scene g[data-id="pve:node:node-1"]');
    // 192.0.2.10 is documentation space: nothing answers, so the connect times out. That is the "down" this test wants.
    await expect(node).toHaveAttribute('data-alert', 'problem', { timeout: 15_000 });
    await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'problem');
    await expect(page.getByTestId('synthetic')).toHaveCount(0);
    await page.getByTestId('stat-warnings').waitFor();
    await expect(page.getByTestId('stat-warnings')).not.toHaveText(/경고\s*0/, { timeout: 25_000 }); // cpu 3% held 15 s: the mock's 5% crosses it
    const counts = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('svg.scene g[data-kind]')].map((g) => [(g as SVGGElement).dataset.kind!, g.querySelectorAll('polygon').length])));
    for (const k of ['wan', 'modem', 'domain', 'gateway', 'switch', 'wifi', 'clients', 'segment', 'node', 'workstation', 'bmc', 'bridge', 'storage', 'vm']) expect(counts[k], k).toBeGreaterThan(0);
    await page.waitForTimeout(600);
    const a = await page.evaluate(audit);
    expect(a.overlaps).toEqual([]); expect(a.clipped).toEqual([]); expect(a.noBasis).toBe(0);
    await page.screenshot({ path: join(shotDir, 'live-kinds.png') });
    // A guest comes: the history shows it, newest first, and the link opens it.
    mock.state.guests.push({ vmid: 101, node: 'node-2', name: 'guest-b', status: 'running', type: 'qemu' });
    await page.waitForSelector('svg.scene g[data-id="pve:qemu:101"]', { timeout: 15_000 });
    await page.getByTestId('page-history').click();
    const link = page.getByTestId('change-link').filter({ hasText: 'guest-b' }).first();
    await expect(link).toBeVisible({ timeout: 8_000 });
    await link.click();                                            // back to the map, onto the object
    await expect(page.locator('svg.scene g[data-id="pve:qemu:101"]')).toHaveAttribute('data-flash', '1');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('object')).toHaveAttribute('data-obj', 'pve:qemu:101');
    await page.getByTestId('trends').waitFor();
    await expect(page.getByTestId('trends').getByTestId('chart-cpu').locator('polyline.c-line')).toHaveCount(1);
    expect(mock.calls.some((c) => c.args.path === '/nodes/node-2/qemu/101/rrddata')).toBe(true);
    expect(mock.calls.filter((c) => String(c.args.path).endsWith('/rrddata')).length).toBe(1);
  } finally {
    await server.close(); await mock.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
