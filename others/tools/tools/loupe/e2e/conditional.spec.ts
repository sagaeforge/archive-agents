// Section 11 "조건부 GET". The design left this for a real browser to settle: scripts see a 304 as a 200 with a body.
import { chromium } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, useSessions } from './support/test.ts';
import { accessLog, RESEARCH } from './support/ports.ts';
import { settled } from './support/app.ts';

const log = () => readFileSync(accessLog('r'), 'utf8').split('\n').filter(Boolean);
const overviewUrl = 'kb/v1/overview?limit=10000&edge_limit=50000';

// No watch fixture here: a Playwright route turns the browser's HTTP cache off.
test('the overview revalidates: the server answers 304 and the script reads 200 with the body', async ({ page }) => {
  await page.goto(`${RESEARCH}/`);
  await page.getByTestId('home-entity').first().waitFor();
  const before = log().length;
  const first = await page.evaluate(([u, c]) => fetch(u!, { cache: c as RequestCache, credentials: 'omit', referrerPolicy: 'no-referrer', headers: { authorization: `Bearer ${sessionStorage.getItem('loupe.session')}` } }).then(async (r) => ({ status: r.status, body: await r.text() })), [overviewUrl, 'no-cache']);
  const second = await page.evaluate(([u, c]) => fetch(u!, { cache: c as RequestCache, credentials: 'omit', referrerPolicy: 'no-referrer', headers: { authorization: `Bearer ${sessionStorage.getItem('loupe.session')}` } }).then(async (r) => ({ status: r.status, body: await r.text() })), [overviewUrl, 'no-cache']);
  const seen = log().slice(before).filter((l) => l.includes('/v1/overview'));
  expect(seen).toEqual(['GET /v1/overview 200', 'GET /v1/overview 304']);
  expect(second.status).toBe(200);
  expect(second.body.length).toBeGreaterThan(1000);
  expect(first.body).toBe(second.body);
});

test('the meta poll revalidates too, so an idle tab costs a 304', async ({ page }) => {
  await page.clock.install();
  await page.goto(`${RESEARCH}/#/status`);
  await expect(page.getByTestId('kb-status')).toHaveText('연결됨');
  await settled(page);
  const before = log().length;
  await page.clock.fastForward(46_000);
  await expect.poll(() => log().slice(before).filter((l) => l.startsWith('GET /v1/meta')).length).toBe(1);
  expect(log().slice(before).filter((l) => l.startsWith('GET /v1/meta'))).toEqual(['GET /v1/meta 304']);
  await expect(page.getByTestId('kb-status')).toHaveText('연결됨');
});

test('detail reads are no-store: every read goes to the KB and none is revalidated', async ({ page, watch }) => {
  await page.goto(`${RESEARCH}/#/node/e%3Alibrary%3Asigma-js`);
  await page.getByTestId('claim-card').first().waitFor();
  await settled(page);
  const before = log().length;
  await page.reload();
  await page.getByTestId('claim-card').first().waitFor();
  await settled(page);
  const seen = log().slice(before).filter((l) => l.startsWith('GET /v1/nodes/:id '));
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.filter((l) => l.endsWith(' 304'))).toEqual([]);
  void watch;
});

test('the disk cache holds the overview and no body', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'loupe-profile-'));
  try {
    const ctx = await chromium.launchPersistentContext(dir, { headless: true });
    await useSessions(ctx);
    const page = await ctx.newPage();
    await page.goto(`${RESEARCH}/#/source/n-198da44f5f7ce10d?claim=c-1e442c5458f5`);
    await page.getByTestId('source-text').waitFor();
    await settled(page);
    await page.goto(`${RESEARCH}/#/node/e%3Alibrary%3Asigma-js`);
    await page.getByTestId('claim-card').first().waitFor();
    await page.evaluate(([u]) => fetch(u!, { cache: 'no-cache', credentials: 'omit', headers: { authorization: `Bearer ${sessionStorage.getItem('loupe.session')}` } }).then((r) => r.text()), [overviewUrl]);
    await settled(page);
    await ctx.close();
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
    const cacheRoots = [path.join(dir, 'Default/Cache'), path.join(dir, 'Default/Code Cache')].filter(existsSync);
    expect(cacheRoots.length, 'the profile has a disk cache').toBeGreaterThan(0);
    cacheRoots.forEach(walk);
    const blobs = files.map((f) => readFileSync(f).toString('latin1'));
    const inCache = (needle: string) => blobs.some((b) => b.includes(needle));
    expect(inCache('/kb/v1/overview'), 'positive control: the overview is cached').toBe(true);
    for (const body of ['/kb/v1/nodes/', '/kb/v1/snapshots/', '/kb/v1/claims/', '/kb/v1/search']) expect(inCache(body), body).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
