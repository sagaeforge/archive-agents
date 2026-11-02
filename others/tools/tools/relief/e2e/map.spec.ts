// The map as the main surface (design 9.4, 9.6, 9.9, 9.11, 9.12): menu, modal, palette, camera, live links, history, marker.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startMock } from '../dev/mcp-mock/mock.ts';
import { startLive } from '../server/serve.ts';
import { audit } from './support/audit.ts';
import { clickObject } from './support/pick.ts';
import { BUILT, root } from './support/ports.ts';

const open = async (page: Page, hash: string) => {
  await page.goto(`${BUILT}/${hash}`);
  await page.waitForSelector('svg.scene g[data-id]');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
};
const VM = 'pve:qemu:100';
const obj = (page: Page, id: string) => page.locator(`svg.scene g[data-id="${id}"]`);
const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const hoverOn = async (page: Page, id: string) => {
  const p = await page.evaluate((want) => {
    for (const f of document.querySelectorAll(`svg.scene g[data-id="${CSS.escape(want)}"] polygon`)) {
      const r = f.getBoundingClientRect();
      for (let i = 1; i < 16; i++) for (let j = 1; j < 16; j++) { const x = r.left + (r.width * i) / 16; const y = r.top + (r.height * j) / 16; if ((document.elementFromPoint(x, y)?.closest('[data-id]') as HTMLElement | null)?.dataset.id === want) return [x, y] as const; }
    }
    return null;
  }, id);
  await page.mouse.move(p![0], p![1]);
};
const centreInMap = (page: Page, id: string) => page.evaluate((want) => {
  const b = document.querySelector(`svg.scene g[data-id="${CSS.escape(want)}"] [data-face="top"]`)!.getBoundingClientRect();
  const m = document.querySelector('[data-testid="map"]')!.getBoundingClientRect();
  return { dx: Math.abs(b.x + b.width / 2 - (m.x + m.width / 2)), dy: Math.abs(b.y + b.height / 2 - (m.y + m.height / 2)), w: b.width };
}, id);

test.describe('status menu', () => {
  test('hover shows name, state and at most three values, beside the object and inside the map', async ({ page }) => {
    await open(page, '#/?fx=today');
    await hoverOn(page, VM);
    const m = page.getByTestId('status-menu');
    await expect(m).toHaveAttribute('data-for', VM);
    await expect(m).toContainText('VM 100'); await expect(m.locator('.st')).toHaveText('정상');
    expect(await m.locator('.kv').count()).toBeLessThanOrEqual(3);
    const box = (await m.boundingBox())!; const o = (await obj(page, VM).boundingBox())!; const map = (await page.getByTestId('map').boundingBox())!;
    expect(overlap(box, o)).toBe(false);
    expect(box.x).toBeGreaterThanOrEqual(map.x); expect(box.y).toBeGreaterThanOrEqual(map.y);
    expect(box.x + box.width).toBeLessThanOrEqual(map.x + map.width); expect(box.y + box.height).toBeLessThanOrEqual(map.y + map.height);
    await page.mouse.move(2, 2);
    await expect(m).toHaveCount(0);
  });
  test('a stale object says so in the menu', async ({ page }) => {
    await open(page, '#/?fx=large');
    await hoverOn(page, 'pve:node:node-4');
    await expect(page.getByTestId('status-menu').locator('.st')).toHaveText('낡음');
    await expect(page.getByTestId('status-menu').locator('.kv', { hasText: '트래픽' })).toContainText('낡음');
  });
  test('follows pan and zoom', async ({ page }) => {
    await open(page, '#/?fx=today');
    await page.getByTestId('map').focus();
    await page.keyboard.press('ArrowDown');
    const m = page.getByTestId('status-menu');
    await expect(m).toBeVisible();
    const id = (await m.getAttribute('data-for'))!;
    const a = (await m.boundingBox())!;
    await page.keyboard.press('+'); await page.keyboard.press('+');
    await expect.poll(async () => (await m.boundingBox())!.x !== a.x || (await m.boundingBox())!.y !== a.y).toBe(true);
    const b = (await m.boundingBox())!; const o = (await obj(page, id).locator('[data-face="top"]').first().boundingBox())!;
    expect(Math.hypot(b.x - (o.x + o.width / 2), b.y - (o.y + o.height / 2))).toBeLessThan(700);
    const map = (await page.getByTestId('map').boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(map.x + map.width + 0.5);
  });
  test('the keyboard shows it too, and it goes when the modal opens', async ({ page }) => {
    await open(page, '#/?fx=large');
    await page.getByTestId('map').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('status-menu')).toHaveAttribute('data-for', /^pve:node:/);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('status-menu')).toHaveCount(0);
  });
});

test.describe('modal', () => {
  test('a click opens it centred, Esc closes it and focus goes back', async ({ page }) => {
    await open(page, '#/?fx=today');
    await clickObject(page, VM);
    const d = page.getByRole('dialog');
    await expect(d).toBeVisible(); await expect(d).toContainText('VM 100');
    await expect(d.getByTestId('load-card')).toBeVisible(); await expect(d.getByTestId('trends')).toBeVisible();
    const b = (await d.boundingBox())!; const v = page.viewportSize()!;
    expect(Math.abs(b.x + b.width / 2 - v.width / 2)).toBeLessThan(2); expect(Math.abs(b.y + b.height / 2 - v.height / 2)).toBeLessThan(2);
    await expect(page.locator('aside').getByTestId('object')).toHaveCount(0);   // details are not in the panel any more
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    await expect(page.getByTestId('map')).toBeFocused();
  });
  test('Enter opens it, Tab stays inside, and focus returns to what had it', async ({ page }) => {
    await open(page, '#/?fx=large');
    await page.getByTestId('map').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const d = page.getByTestId('modal');
    await expect(d).toBeFocused();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="modal"]'))).toBe(true);
    }
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="modal"]'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('map')).toBeFocused();
  });
  test('a finding in the panel opens it, and closing returns to that button', async ({ page }) => {
    await open(page, '#/?fx=large');
    const b = page.getByTestId('findings').getByRole('button').first();
    await b.click();
    await expect(page.getByTestId('modal')).toBeVisible();
    await page.getByTestId('modal-close').click();
    await expect(b).toBeFocused();
  });
  test('the shortcuts sleep behind it', async ({ page }) => {
    await open(page, '#/?fx=today&sel=pve:qemu:100&open=1');
    await page.keyboard.press('2');
    await expect(page.getByTestId('mode-iso')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('palette', () => {
  test('Ctrl+Space opens it, a Korean query finds, arrows move, Enter flies and highlights', async ({ page }) => {
    await open(page, '#/?fx=large');
    await page.keyboard.press('Control+Space');
    const input = page.getByTestId('palette-input');
    await expect(input).toBeFocused();
    await input.fill('결제');
    const list = page.getByTestId('palette-list');
    await expect(list.getByRole('option').first()).toContainText('결제');
    await page.keyboard.press('ArrowDown');
    await expect(list.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
    const id = (await list.getByRole('option').nth(1).getAttribute('data-hit'))!;
    const before = await page.locator('svg.scene').getAttribute('viewBox');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('palette')).toHaveCount(0);
    await expect(obj(page, id)).toHaveAttribute('data-flash', '1');
    expect(await page.locator('svg.scene').getAttribute('viewBox')).not.toBe(before);
    const c = await centreInMap(page, id);
    expect(c.dx).toBeLessThan(40); expect(c.dy).toBeLessThan(60);
    await expect(page.getByTestId('status-menu')).toHaveAttribute('data-for', id);
    await expect(obj(page, id)).not.toHaveAttribute('data-flash', '1', { timeout: 4000 });
  });
  test('`/` is the fallback, kinds and addresses match too', async ({ page }) => {
    await open(page, '#/?fx=today');
    await page.keyboard.press('/');
    const input = page.getByTestId('palette-input');
    await input.fill('192.0.2.1');
    await expect(page.getByTestId('palette-list').getByRole('option').first()).toBeVisible();
    await input.fill('게이트');
    await expect(page.getByTestId('palette-list')).toContainText('게이트웨이');
    await input.fill('저장소');
    await expect(page.getByTestId('palette-list').getByRole('option')).toHaveCount(6);
    await input.fill('없는이름');
    await expect(page.getByTestId('palette-empty')).toBeVisible();
    await page.keyboard.press('Enter');                                        // no hit, nothing to fly to
    await expect(page.getByTestId('palette')).toBeVisible();
  });
  test('during composition Enter belongs to the IME, and a syllable on its way matches', async ({ page }) => {
    await open(page, '#/?fx=large');
    await page.keyboard.press('Control+Space');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '결', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.imeSetComposition', { text: '결ㅈ', selectionStart: 2, selectionEnd: 2 });
    await expect(page.getByTestId('palette-list').getByRole('option').first()).toContainText('결제');
    await page.getByTestId('palette-input').dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
    await expect(page.getByTestId('palette')).toBeVisible();
    await cdp.send('Input.insertText', { text: '결제' });
    await expect(page.getByTestId('palette-input')).toHaveValue(/결제/);
  });
  test('Esc closes it, clears the dimming, and the top bar has no search box', async ({ page }) => {
    await open(page, '#/?fx=large');
    await expect(page.locator('header input')).toHaveCount(0);
    await page.getByTestId('palette-open').click();
    await page.getByTestId('palette-input').fill('결제');
    await expect.poll(() => page.evaluate(() => location.hash)).toContain('q=');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('palette')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => location.hash)).not.toContain('q=');
  });
});

test.describe('camera', () => {
  test('moves in steps: the view passes between where it was and where it lands', async ({ page }) => {
    await open(page, '#/?fx=large');
    const box = () => page.locator('svg.scene').getAttribute('viewBox');
    const start = await box();
    await page.keyboard.press('/');
    await page.getByTestId('palette-input').fill('노드 5');
    await page.evaluate(() => {
      const s = document.querySelector('svg.scene')!; (window as unknown as { seen: string[] }).seen = [];
      new MutationObserver(() => (window as unknown as { seen: string[] }).seen.push(s.getAttribute('viewBox')!)).observe(s, { attributes: true, attributeFilter: ['viewBox'] });
    });
    await page.keyboard.press('Enter');
    await expect(obj(page, 'pve:node:node-5')).toHaveAttribute('data-flash', '1');
    const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
    expect(new Set(seen).size).toBeGreaterThan(4);
    expect(await box()).not.toBe(start);
    await page.keyboard.press('0');
    await expect.poll(box).toBe(start);
  });
});

test.describe('links', () => {
  const packets = (page: Page) => page.locator('svg.scene rect.packet');
  test('a measured link carries moving packets on its own cable, one speed, at most six a lane', async ({ page }) => {
    await open(page, '#/?fx=large');
    expect(await packets(page).count()).toBeGreaterThan(20);
    const r = await page.evaluate(() => [...document.querySelectorAll('rect.packet')].map((c) => { const a = c.getAnimations()[0]!; return { state: a.playState, name: (a as CSSAnimation).animationName, key: `${(c as SVGElement).dataset.packetFor}|${(c as SVGElement).dataset.lane}` }; }));
    expect(r.every((x) => x.state === 'running' && x.name === 'packet')).toBe(true);
    const lanes = new Map<string, number>(); for (const x of r) lanes.set(x.key, (lanes.get(x.key) ?? 0) + 1);
    expect(Math.max(...lanes.values())).toBeLessThanOrEqual(6);
    const pos = () => packets(page).first().boundingBox();
    const a = await pos(); await page.waitForTimeout(250); const b = await pos();
    expect(Math.hypot(a!.x - b!.x, a!.y - b!.y)).toBeGreaterThan(1);
  });
  test('a packet sits on its cable, not somewhere else on the map', async ({ page }) => {
    await open(page, '#/?fx=today');
    const off = await page.evaluate(async () => {
      const out: number[] = [];
      for (const c of document.querySelectorAll('rect.packet')) {
        const id = (c as SVGElement).dataset.packetFor!;
        const line = document.querySelector(`polyline[data-edge="${CSS.escape(id)}"]`) as SVGPolylineElement | null;
        if (!line) continue;
        const box = c.getBoundingClientRect(); const m = line.getScreenCTM()!;
        const p = [...line.points].map((q) => [m.a * q.x + m.e, m.d * q.y + m.f]);
        const cx = box.x + box.width / 2; const cy = box.y + box.height / 2;
        let best = 1e9;
        for (let i = 1; i < p.length; i++) { const [ax, ay] = p[i - 1]!; const [bx, by] = p[i]!; const t = Math.max(0, Math.min(1, ((cx - ax!) * (bx! - ax!) + (cy - ay!) * (by! - ay!)) / ((bx! - ax!) ** 2 + (by! - ay!) ** 2 || 1))); best = Math.min(best, Math.hypot(cx - ax! - t * (bx! - ax!), cy - ay! - t * (by! - ay!))); }
        out.push(best);
      }
      return out;
    });
    expect(off.length).toBeGreaterThan(0);
    for (const d of off) expect(d).toBeLessThan(6);
  });
  test('a stale link is static and looks different, by line style as well as colour', async ({ page }) => {
    await open(page, '#/?fx=large');
    const stale = page.locator('polyline.edge[data-edge="e-up-node-4-0"]');
    await expect(stale).toHaveAttribute('data-link', 'stale');
    await expect(page.locator('rect.packet[data-packet-for="e-up-node-4-0"]')).toHaveCount(0);
    const live = page.locator('polyline.edge[data-edge="e-up-node-2-0"]');
    await expect(live).toHaveAttribute('data-link', /healthy|warning/);
    const look = (l: typeof live) => l.evaluate((e) => { const c = getComputedStyle(e); return { stroke: c.stroke, dash: c.strokeDasharray }; });
    const a = await look(stale); const b = await look(live);
    expect(a.stroke).not.toBe(b.stroke); expect(a.dash).not.toBe(b.dash);
    await expect(page.locator('polyline.edge[data-link=stale] title').first()).toContainText('낡음');
  });
  test('an unknown link does not move: the blank WAN says nothing', async ({ page }) => {
    await open(page, '#/?fx=today');
    await expect(page.locator('polyline.edge[data-link="unknown"]').first()).toBeVisible();
    await expect(page.locator('polyline.edge.derived[data-link="unknown"]').first()).toBeAttached(); // a guessed gateway vouches for nothing
    const unknown = await page.locator('polyline.edge[data-link="unknown"]').evaluateAll((e) => e.map((x) => (x as SVGElement).dataset.edge));
    for (const id of unknown) await expect(page.locator(`rect.packet[data-packet-for="${id}"]`)).toHaveCount(0);
  });
  test('a link with no measurement says so, and carries nothing', async ({ page }) => {
    await open(page, '#/?fx=large');
    const none = page.locator('polyline.edge[data-measured="0"]');
    expect(await none.count()).toBeGreaterThan(0);
    await expect(none.first().locator('title')).toContainText('트래픽 측정 없음');
    for (const id of await none.evaluateAll((e) => e.map((x) => (x as SVGElement).dataset.edge))) await expect(page.locator(`rect.packet[data-packet-for="${id}"]`)).toHaveCount(0);
    await expect(page.getByTestId('legend-none')).toContainText('트래픽 측정 없음');
  });
  test('the rate shows in the menu and the modal', async ({ page }) => {
    await open(page, '#/?fx=today');
    await hoverOn(page, VM);
    await expect(page.getByTestId('status-menu').locator('.kv', { hasText: '트래픽' })).toContainText(/↓.+↑/);
    await clickObject(page, VM);
    await expect(page.getByTestId('traffic')).toContainText(/↓.+↑/);
    await page.keyboard.press('Escape');
    await clickObject(page, 'net:gw:192.0.2.1');
    await expect(page.getByTestId('traffic')).toContainText('트래픽 측정 없음');
  });
  test('reduced motion: nothing moves, and the same packets stand still as rate marks', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await open(page, '#/?fx=large');
    expect(await page.evaluate(() => document.getAnimations().filter((a) => (a as CSSAnimation).animationName === 'packet').length)).toBe(0);
    expect(await packets(page).count()).toBeGreaterThan(20);
    const a = await packets(page).first().boundingBox(); await page.waitForTimeout(250);
    expect(await packets(page).first().boundingBox()).toEqual(a);
    const spots = await packets(page).evaluateAll((e) => e.slice(0, 40).map((x) => getComputedStyle(x).offsetDistance));
    expect(new Set(spots).size).toBeGreaterThan(1);
    await expect(page.locator('polyline.edge[data-link="stale"]').first()).toBeAttached();
    await page.keyboard.press('/');
    await page.getByTestId('palette-input').fill('노드 5');
    await page.keyboard.press('Enter');
    await expect(obj(page, 'pve:node:node-5')).toHaveAttribute('data-flash', '1');
    await ctx.close();
  });
  test('a hidden tab pauses them', async ({ page }) => {
    await open(page, '#/?fx=large');
    const states = () => page.evaluate(() => [...new Set(document.getAnimations().filter((a) => (a as CSSAnimation).animationName === 'packet').map((a) => a.playState))]);
    expect(await states()).toEqual(['running']);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(states).toEqual(['paused']);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(states).toEqual(['running']);
  });
  test('the legend states what a packet means', async ({ page }) => {
    await open(page, '#/?fx=today');
    await expect(page.getByTestId('legend-flow')).toContainText('측정 트래픽');
    await expect(page.getByTestId('legend-flow')).toHaveAttribute('title', /10 KB\/s까지 1개/);
    await expect(page.getByTestId('legend-links')).toContainText('낡음');
  });
});

test.describe('the summary never says healthy when it does not know', () => {
  test('a server that stops answering turns the pill to disconnected, and it comes back', async ({ page }) => {
    await open(page, '#/?fx=today');
    await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'healthy');
    await page.route('**/api/snapshot*', (r) => r.abort());
    await expect(page.getByTestId('verdict')).toHaveText('연결 끊김', { timeout: 12_000 });
    await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'stale');
    await page.unroute('**/api/snapshot*');
    await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'healthy', { timeout: 12_000 });
  });
});

test('one object reads the same on every surface', async ({ page }) => {
  await open(page, '#/?fx=large');
  const id = 'pve:node:node-1';                                             // up, with a problem alert: it must never say healthy
  await hoverOn(page, id);
  await expect(page.getByTestId('status-menu').locator('.st')).toHaveText('문제');
  await page.mouse.move(2, 2);
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'problem');
  await page.getByTestId('tab-list').click();
  await expect(page.locator(`[data-tree="${id}"]`)).toHaveAttribute('data-health', 'problem');
  await expect(page.locator(`[data-tree="${id}"]`)).toContainText('문제');
  await expect(obj(page, id)).toHaveAttribute('data-alert', 'problem');
  await page.locator(`[data-tree="${id}"]`).click();
  await expect(page.getByTestId('modal-health')).toHaveText('문제');
  await expect(page.getByTestId('modal-health')).toHaveAttribute('data-health', 'problem');
});

test('a link to an object that is gone leaves the keyboard working', async ({ page }) => {
  await page.goto(`${BUILT}/#/?fx=today&sel=pve:qemu:999&open=1`);
  await page.waitForSelector('svg.scene g[data-id]');
  await expect(page.getByTestId('modal')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => location.hash)).not.toContain('open=1');
  await page.getByTestId('map').focus();
  await page.keyboard.press('2');
  await expect(page.getByTestId('mode-2d')).toHaveAttribute('aria-pressed', 'true');
});

test('walking through objects sends one read, not one each', async ({ page }) => {
  const asks: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/trend')) asks.push(r.url()); });
  await open(page, '#/?fx=today&sel=pve:qemu:100&open=1');
  await page.getByTestId('trends').waitFor();
  for (let i = 0; i < 6; i++) await page.getByTestId(i % 2 ? 'tf-hour' : 'tf-day').click();
  await page.waitForTimeout(500);
  expect(asks.length).toBeLessThanOrEqual(2);
});

test.describe('panel', () => {
  test('is the overall state and collapses with its key, and the map takes the room', async ({ page }) => {
    await open(page, '#/?fx=today');
    const aside = page.locator('aside');
    await expect(aside.getByTestId('tiers')).toBeVisible(); await expect(aside.getByTestId('holes')).toBeVisible();
    const before = (await page.getByTestId('map').boundingBox())!.width;
    await page.keyboard.press('p');
    await expect(aside).toBeHidden();
    await expect.poll(async () => (await page.getByTestId('map').boundingBox())!.width).toBeGreaterThan(before + 200);
    expect((await page.getByTestId('map').boundingBox())!.width).toBe(page.viewportSize()!.width);
    expect(await page.evaluate(() => location.hash)).toContain('panel=0');
    await page.getByTestId('panel-toggle').click();
    await expect(aside).toBeVisible();
  });
  test('a row is short: no sentence of source and age', async ({ page }) => {
    await open(page, '#/?fx=today');
    const lines = await page.getByTestId('holes').locator('li').allInnerTexts();
    for (const l of lines) expect(l.length).toBeLessThan(26);
    await expect(page.getByTestId('holes').getByRole('button').first()).toHaveAttribute('title', /.+/);
  });
});

test('the fixture is marked as synthetic', async ({ page }) => {
  await open(page, '#/?fx=today');
  await expect(page.getByTestId('synthetic')).toHaveText('합성 fixture');
});

test('the labels stay clean with the flow on', async ({ page }) => {
  await open(page, '#/?fx=large');
  const a = await page.evaluate(audit);
  expect(a.overlaps).toEqual([]); expect(a.clipped).toEqual([]); expect(a.elements).toBeLessThan(3000);
});

test('live: no badge, a history page with filters, and its link flies to the object', async ({ page }) => {
  test.setTimeout(70_000);
  const TOKEN = 'e2e-synthetic-token-0123456789abcdefghijklmnop'; const PORT = { live: 4825, mock: 4826 };
  const dir = mkdtempSync(join(tmpdir(), 'relief-e2e-'));
  mkdirSync(join(dir, 'tower'));
  writeFileSync(join(dir, 'tower/token'), TOKEN, { mode: 0o600 });
  writeFileSync(join(dir, 'relief.json'), JSON.stringify({ towerUrl: `http://127.0.0.1:${PORT.mock}/mcp`, thresholds: { sustainS: 15 } }));
  writeFileSync(join(dir, 'edge.json'), readFileSync(join(root, 'fixtures/edge.example.json')));
  const env = { ...process.env, TOWER_CONFIG: join(dir, 'tower/tower.json'), RELIEF_CONFIG: dir, RELIEF_STATE: join(dir, 'state') } as NodeJS.ProcessEnv;
  const mock = await startMock({ port: PORT.mock, token: TOKEN });
  const server = await startLive({ port: PORT.live, env, dist: join(root, 'dist'), period: { fastS: 1, activeS: 1, idleS: 1, minTtlS: 3, guestTickS: 1, edgeS: 1, metricsS: 1 } });
  try {
    await page.goto(`http://127.0.0.1:${PORT.live}/`);
    await page.waitForSelector('svg.scene g[data-kind="vm"]');
    await expect(page.getByTestId('synthetic')).toHaveCount(0);
    await expect(page.getByText('실제 클러스터')).toHaveCount(0);
    await expect(page.locator('rect.packet').first()).toBeAttached({ timeout: 30_000 }); // a rate, and both ends with a verdict: 15 s of samples
    const carrying = await page.locator('rect.packet').evaluateAll((e) => [...new Set(e.map((x) => (x as SVGElement).dataset.packetFor))]);
    for (const id of carrying) expect(id).toMatch(/^e-(up|attach)-/);          // measured links only: never WAN, router, Wi-Fi or PC
    mock.state.guests.push({ vmid: 101, node: 'node-2', name: 'guest-b', status: 'running', type: 'qemu' });
    await page.waitForSelector('svg.scene g[data-id="pve:qemu:101"]', { timeout: 8_000 });
    await page.keyboard.press('h');
    await expect(page.getByTestId('history')).toBeVisible();
    await expect(page.locator('main')).toBeHidden(); await expect(page.locator('aside')).toBeHidden();
    const rows = page.getByTestId('change');
    await expect(rows.first()).toBeVisible();
    const all = await rows.count();
    await page.getByTestId('history-type').selectOption('added');
    await expect(page.locator('[data-testid="change"] li[data-type]').first()).toHaveAttribute('data-type', 'added');
    await expect.poll(async () => page.locator('[data-testid="change"] li[data-type]:not([data-type="added"])').count()).toBe(0);
    await page.getByTestId('history-object').selectOption('pve:qemu:101');
    await expect(page.getByTestId('change-link')).toHaveCount(1);
    await expect(page.getByTestId('change-link')).toHaveText('guest-b');
    expect(await rows.count()).toBeLessThanOrEqual(all);
    await page.getByTestId('change-link').click();
    await expect(page.locator('main')).toBeVisible();
    await expect(obj(page, 'pve:qemu:101')).toHaveAttribute('data-flash', '1');
    // An object that goes while its modal is open closes the modal and leaves the keyboard working, and the pill says something went.
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('modal')).toBeVisible();
    mock.state.guests.pop();
    await expect(page.getByTestId('modal')).toHaveCount(0, { timeout: 8_000 });
    await expect.poll(() => page.evaluate(() => location.hash)).not.toContain('open=1');
    await expect(page.getByTestId('verdict')).toHaveAttribute('data-verdict', 'problem', { timeout: 8_000 });
    await page.getByTestId('map').focus();
    await page.keyboard.press('2');
    await expect(page.getByTestId('mode-2d')).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await server.close(); await mock.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
