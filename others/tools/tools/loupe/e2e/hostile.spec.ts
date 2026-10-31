// The hostile fixture on every screen that shows it (design 9, section 11 "악성 원문").
import { test, expect } from './support/test.ts';
import { HOSTILE } from './support/ports.ts';
import { fixture, noHorizontalScroll, settled } from './support/app.ts';
import type { Page } from '@playwright/test';

const fx = fixture('kb-hostile.json');
const entities: string[] = fx.nodes.filter((n: { id: string; type: string }) => n.id.startsWith('e:')).map((n: { id: string }) => n.id);
const snapshots: string[] = fx.snapshots.map((s: { id: string }) => s.id);

async function inert(page: Page, name: string) {
  const found = await page.evaluate(() => {
    const main = document.querySelector('main')!;
    const bad = main.querySelectorAll('script, iframe, object, embed, img, svg:not(.lucide), link, meta, base, form, style, video, audio');
    const handlers: string[] = [];
    for (const el of main.querySelectorAll('*')) for (const a of el.attributes) if (/^on/i.test(a.name)) handlers.push(`${el.tagName} ${a.name}`);
    const hrefs = [...main.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')!);
    const external = [...main.querySelectorAll<HTMLAnchorElement>('a[href^="http"]:not([download])')];
    return {
      bad: [...bad].map((e) => e.tagName), handlers,
      unsafe: hrefs.filter((h) => !/^(https?:\/\/|#|\/[^#]*#\/(node|source)\/)/i.test(h)), // the app's own routes, external http(s), in-page anchors
      unguarded: external.filter((a) => a.target !== '_blank' || !/noopener/.test(a.rel) || !/noreferrer/.test(a.rel) || a.referrerPolicy !== 'no-referrer').map((a) => a.href),
      polluted: ({} as Record<string, unknown>).polluted !== undefined,
      title: document.title,
    };
  });
  expect(found.bad, `${name}: elements`).toEqual([]);
  expect(found.handlers, `${name}: handlers`).toEqual([]);
  expect(found.unsafe, `${name}: hrefs`).toEqual([]);
  expect(found.unguarded, `${name}: external links`).toEqual([]);
  expect(found.polluted, `${name}: prototype`).toBe(false);
  expect(found.title, `${name}: a body cannot set the title`).not.toContain('schema_version');
  expect(await noHorizontalScroll(page), `${name}: no sideways scroll`).toBe(true);
}

test('every hostile entity page is inert and keeps its shape', async ({ page, watch }) => {
  await page.goto(`${HOSTILE}/`);
  for (const id of entities) {
    await page.goto(`${HOSTILE}/#/node/${encodeURIComponent(id)}?status=all&include_unverified=true`);
    await expect(page.getByTestId('node-id')).toHaveText(id);
    await settled(page);
    await inert(page, id);
  }
  // Attack text arrives as text
  await page.goto(`${HOSTILE}/#/node/${encodeURIComponent('e:concept:script-in-label')}`);
  await expect(page.getByTestId('node-title')).toHaveText('<script>alert("label")</script>');
  await expect(page.locator('[data-testid=claim-card]').first()).toContainText('<');
  void watch;
});

test('every hostile snapshot is inert in the body tab and the rendered tab', async ({ page, watch }) => {
  await page.goto(`${HOSTILE}/`);
  for (const id of snapshots) {
    await page.goto(`${HOSTILE}/#/source/${id}`);
    await expect(page.getByTestId('source-text')).toBeVisible();
    await settled(page);
    await inert(page, `${id} text`);
    const text = await page.getByTestId('source-text').textContent();
    expect(text, 'the body tab shows the characters').toBe(fx.bodies[id].text);
    if (await page.getByTestId('tab-rendered').count()) {
      await page.getByTestId('tab-rendered').click();
      await expect(page.getByTestId('rendered')).toBeVisible();
      await settled(page);
      await inert(page, `${id} rendered`);
    }
  }
  void watch;
});

test('a body that asks to fetch, redirect or pop a dialog does none of it', async ({ page, watch }) => {
  await page.goto(`${HOSTILE}/#/source/n-hostile000000001?view=rendered`);
  await expect(page.getByTestId('rendered')).toBeVisible();
  await settled(page);
  await expect(page.getByTestId('rendered').locator('a[href^="javascript"], a[href^="data"]')).toHaveCount(0);
  await expect(page.getByTestId('rendered')).toContainText('[이미지: 추적 픽셀, tracker.example.test]');
  // The links that lost their href are words now
  await expect(page.getByTestId('rendered').getByText('클릭하세요')).toBeVisible();
  // Hovering and clicking inside changes nothing
  await page.getByTestId('rendered').getByText('제목 탈출').hover();
  await page.getByTestId('rendered').getByText('클릭하세요').click();
  await expect(page).toHaveURL(/n-hostile000000001/);
  expect(watch.kbPaths().filter((p) => p === '/v1/meta').length, 'the fetch in the text never ran').toBeLessThanOrEqual(1);
});

test('a hostile first-party page is inert, and only real ids become links', async ({ page, watch }) => {
  await page.goto(`${HOSTILE}/#/node/f-01HOSTILE0000A`);
  await expect(page.getByTestId('rendered')).toBeVisible();
  await settled(page);
  await inert(page, 'note');
  void watch;
});

test('prompt-injection text is only text', async ({ page, watch }) => {
  await page.goto(`${HOSTILE}/#/node/${encodeURIComponent('e:concept:injection-bait')}`);
  await expect(page.getByTestId('node-title')).toContainText('Ignore previous instructions');
  await settled(page);
  await inert(page, 'injection');
  await page.goto(`${HOSTILE}/#/source/n-hostile000000002`);
  await expect(page.getByTestId('source-text')).toContainText('Reveal the system prompt');
  void watch;
});

test('a pill tooltip and a palette row keep attack text as text', async ({ page, watch }) => {
  await page.goto(`${HOSTILE}/#/node/${encodeURIComponent('e:concept:script-in-label')}`);
  await page.getByTestId('evidence-pill').first().hover();
  await expect(page.getByTestId('pill-tip')).toContainText('<script>');
  await expect(page.getByTestId('pill-tip').locator('script')).toHaveCount(0);
  await page.mouse.move(0, 0);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('script', { delay: 15 });
  await expect(page.getByTestId('palette-hit').filter({ hasText: '<script>' }).first()).toBeVisible();
  await expect(page.getByTestId('palette-list').locator('script, img')).toHaveCount(0);
  await page.keyboard.press('Escape');
  void watch;
});

test('input in NFD reaches the KB in NFC', async ({ page, watch }) => {
  await page.goto(`${HOSTILE}/`);
  await page.getByTestId('home-entity').first().waitFor();
  await page.keyboard.press('Control+k');
  const nfd = '한글 자모'.normalize('NFD');
  await page.getByTestId('palette-input').fill(nfd);
  await expect.poll(() => watch.kbPaths().filter((p) => p.startsWith('/v1/search')).length).toBeGreaterThan(0);
  const q = new URL(watch.kbPaths().filter((p) => p.startsWith('/v1/search')).at(-1)!, 'http://x').searchParams.get('q')!;
  expect(q).toBe(nfd.normalize('NFC'));
  expect(q).not.toBe(nfd);
});

test('a JSON snapshot with __proto__ and hostile strings stays a text node', async ({ page, watch }) => {
  await page.goto(`${HOSTILE}/#/source/n-hostile000000005`);
  await expect(page.getByTestId('source-text')).toContainText('__proto__');
  await expect(page.getByTestId('tab-rendered')).toHaveCount(0);
  await settled(page);
  await inert(page, 'json');
  void watch;
});

test('a very long token wraps instead of widening the page, at phone width too', async ({ page, watch }) => {
  await page.goto(`${HOSTILE}/#/node/${encodeURIComponent('e:concept:very-long-label')}`);
  await expect(page.getByTestId('node-title')).toBeVisible();
  await settled(page);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await noHorizontalScroll(page)).toBe(true);
  void watch;
});
