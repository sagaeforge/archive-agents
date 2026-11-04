// Section 11: remote resources, deep link injection, document navigation, cross-site requests.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { test, expect, watchPage, expectClean, bearerFor } from './support/test.ts';
import { accessLog, crossSiteUrl, HOSTILE, PORT, RESEARCH } from './support/ports.ts';
import { settled } from './support/app.ts';

const metaHits = () => readFileSync(accessLog('h'), 'utf8').split('\n').filter((l) => l === 'GET /v1/meta 200').length;

test.describe('deep link injection', () => {
  const links = [
    '/node/e%3Afeature%2Fa%3Fas_of_valid%3D2020-01-01T00%3A00%3A00Z%23',
    '/source/n-1%2F..%2F..%2Fnodes%2Fe%3Afeature%2Fb',
    '/node/..%2F..%2F..%2Fv1%2Fops%2Fmetrics',
    '/node/..',
    '/source/..%2F..',
  ];
  for (const link of links) {
    test(link, async ({ page, watch }) => {
      await page.goto(`${RESEARCH}/#${link}`);
      await expect(page.getByTestId('route-error').or(page.getByTestId('not-visible-page'))).toBeVisible();
      await expect(page.getByTestId('time-band'), 'a query hidden in the id cannot become a time basis').toHaveCount(0);
      await settled(page);
      const paths = watch.kbPaths();
      expect(paths.filter((p) => p !== '/v1/meta' && p !== '/v1/schema'), 'the id reached no KB request').toEqual([]);
      expect(paths.filter((p) => /as_of|ops|admin/.test(p))).toEqual([]);
    });
  }
  test('an unknown id with reserved characters percent-encoded stays one path segment', async ({ page, watch }) => {
    await page.goto(`${RESEARCH}/#/node/e%3Anope%3Aha%25ha`);
    await expect(page.getByTestId('not-visible-page')).toBeVisible();
    expect(watch.kbPaths().filter((p) => p.startsWith('/v1/nodes/')).every((p) => p.split('?')[0]!.split('/').length === 4)).toBe(true);
  });
  test('a hidden and an absent id answer the same', async ({ page, watch }) => {
    const texts: string[] = [];
    for (const id of ['e:concept:gateway-token-storage', 'e:concept:agentgateway-session-key', 'e:concept:never-existed']) {
      await page.goto(`${RESEARCH}/`);
      await page.goto(`${RESEARCH}/#/node/${encodeURIComponent(id)}`);
      await page.reload();
      await expect(page.getByTestId('not-visible-page')).toContainText('없거나 볼 수 없음');
      texts.push((await page.locator('main').textContent())!.replace(id, 'ID'));
    }
    expect(new Set(texts).size).toBe(1);
    void watch;
  });
  test('merged_from from the URL cannot claim a merge the KB does not know', async ({ page, watch }) => {
    await page.goto(`${RESEARCH}/#/node/${encodeURIComponent('e:library:sigma-js')}?merged_from=${encodeURIComponent('e:tool:orval')}`);
    await expect(page.getByTestId('node-title')).toHaveText('sigma.js');
    await settled(page);
    await expect(page.getByTestId('merge-notice')).toHaveCount(0);
    void watch;
  });
});

test.describe('document navigation', () => {
  const RAW = '/kb/v1/snapshots/n-hostile000000004/raw';
  test('the captured page carries the sandbox CSP, nosniff and attachment', async ({ request }) => {
    const r = await request.get(`${HOSTILE}${RAW}`, { headers: bearerFor(HOSTILE) });
    expect(r.status()).toBe(200);
    const h = r.headers();
    expect(h['content-type']).toContain('text/html');
    expect(h['content-security-policy']).toContain('sandbox');
    expect(h['content-security-policy']).toContain("default-src 'none'");
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['content-disposition']).toBe('attachment');
  });
  // No watch fixture: Chrome's own JSON viewer logs that the sandbox blocked its script, which is the sandbox working.
  // A typed address sends Sec-Fetch-Site: none, which v2 6.3 refuses on /kb/* before the session is even looked at (403).
  test('going there runs nothing: a navigation is refused and carries no session anyway', async ({ page }) => {
    const before = metaHits();
    const res = await page.goto(`${HOSTILE}${RAW}`).catch(() => null);
    if (res) {
      expect([401, 403]).toContain(res.status());
      expect(res.headers()['content-security-policy']).toContain('sandbox');
    }
    await page.waitForTimeout(250);
    expect(metaHits(), 'its fetch never ran').toBe(before);
  });
  test('with the attachment removed, the sandbox alone still stops the script', async ({ page, context }) => {
    // Stripping Content-Disposition makes the browser render it, so this tests the second line of defence by itself.
    const external: string[] = [];
    await context.route(/evil\.example\.test/, (r) => { external.push(r.request().url()); return r.abort(); });
    await page.route(`${HOSTILE}${RAW}`, async (route) => {
      // A navigation carries no session (design v2 6.1); the harness adds it so the second line of defence can be seen alone.
      const res = await route.fetch({ headers: { ...route.request().headers(), ...bearerFor(HOSTILE) } });
      const headers = { ...res.headers() };
      delete headers['content-disposition'];
      await route.fulfill({ response: res, headers });
    });
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
    const before = metaHits();
    await page.goto(`${HOSTILE}${RAW}`);
    await page.waitForTimeout(400);
    expect(dialogs).toEqual([]);
    expect(metaHits(), 'its fetch never ran').toBe(before);
    expect(external, 'its redirect never left').toEqual([]);
    expect(await page.locator('h1').textContent()).toBe('raw capture');
    expect(await page.evaluate(() => document.cookie).catch(() => '')).toBe('');
  });
  test('the raw link is a download and the page never renders raw bytes', async ({ page, watch }) => {
    await page.goto(`${HOSTILE}/#/source/n-hostile000000004`);
    await expect(page.getByTestId('raw-download')).toBeVisible();
    await expect(page.getByTestId('source-text')).not.toContainText('raw capture');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('raw-download').click()]);
    // The bytes come with the session header and leave as an octet-stream Blob (design v2 6.1, design 9).
    expect(dl.url()).toMatch(/^blob:/);
    expect(dl.suggestedFilename()).toBe('n-hostile000000004.raw');
    const saved = await dl.path();
    expect(readFileSync(saved, 'utf8')).toContain('raw capture');
    void watch;
  });
});

test.describe('cross-site requests', () => {
  const raw = (headers: Record<string, string>) => new Promise<number>((res, rej) => {
    const r = http.get({ host: '127.0.0.1', port: PORT.research, path: '/kb/v1/meta', headers: { host: `localhost:${PORT.research}`, ...bearerFor(RESEARCH), ...headers } }, (m) => { m.resume(); res(m.statusCode!); });
    r.on('error', rej);
  });
  test('a foreign Host is 403', async () => { expect(await raw({ Host: 'evil.example' })).toBe(403); });
  test('a foreign Origin is 403', async () => { expect(await raw({ Origin: 'https://evil.example' })).toBe(403); });
  test('Fetch Metadata headers on the wire', async () => {
    expect(await raw({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' })).toBe(403);
    expect(await raw({ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' })).toBe(403);
    // v2 6.3: no navigate pass on the data paths, even with a session.
    expect(await raw({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })).toBe(403);
    expect(await raw({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' })).toBe(200);
  });
  test('a real page on another site gets 403 from no-cors, and its link still works', async ({ page }) => {
    const statuses: number[] = [];
    page.on('response', (r) => { if (r.url().includes('/kb/v1/meta')) statuses.push(r.status()); });
    await page.goto(crossSiteUrl());
    // A no-cors GET carries no Origin: only Fetch Metadata can refuse this one.
    await page.evaluate((u) => { void fetch(u, { mode: 'no-cors' }).catch(() => undefined); }, `${RESEARCH}/kb/v1/meta`);
    await expect.poll(() => statuses).toEqual([403]);
    await page.evaluate((u) => { location.href = u; }, `${RESEARCH}/#/node/e%3Alibrary%3Asigma-js`);
    await expect(page.getByTestId('node-title')).toHaveText('sigma.js');
  });
});

test('the document itself: frame-ancestors, nosniff and no referrer', async ({ request }) => {
  const h = (await request.get(`${RESEARCH}/`)).headers();
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('no-referrer');
  const html = (await (await request.get(`${RESEARCH}/`)).text()).replaceAll('&#39;', "'");
  expect(html).toMatch(/http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self';/);
});

test('no remote font, script or stylesheet: every request of a full visit stays on this origin', async ({ page, context }) => {
  const w = await watchPage(page);
  await page.goto(`${RESEARCH}/#/source/n-198da44f5f7ce10d?view=rendered`);
  await expect(page.getByTestId('rendered')).toBeVisible();
  await settled(page);
  const all = await page.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name));
  expect(all.length).toBeGreaterThan(3);
  expect(all.filter((u) => !u.startsWith(RESEARCH) && !u.startsWith('data:') && !u.startsWith('blob:'))).toEqual([]);
  await expectClean(page, w);
  void context;
});
