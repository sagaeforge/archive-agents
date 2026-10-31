// Section 11 "오프라인" and design 7.4. This file owns its own kb-mock and loupe serve, because it stops them.
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test, expect, watchPage } from './support/test.ts';
import { accessLog, base, PORT, shotsDir, sock } from './support/ports.ts';
import { startMock, startServe, stop, tcpOpen, waitFor } from './support/procs.ts';
import { settled } from './support/app.ts';

mkdirSync(shotsDir, { recursive: true });
const ORIGIN = base(PORT.offline);
const FIXTURE = 'contract-sample/fixtures/kb-research.json';
const SIGMA = '/#/node/e%3Alibrary%3Asigma-js';
let mock: ChildProcess, serve: ChildProcess;
const startAll = async () => { mock = await startMock('o', FIXTURE); serve = await startServe('o', PORT.offline); };

test.describe.configure({ mode: 'serial' });
test.beforeEach(async () => { rmSync(accessLog('o'), { force: true }); await startAll(); });
test.afterEach(async () => { await stop(mock); await stop(serve); rmSync(sock('o'), { force: true }); await waitFor(async () => !(await tcpOpen(PORT.offline)), 3000, 'port free'); });

test('stopping the KB raises the band within the limit, keeps the screen, and restarting it clears the band', async ({ page, watch }) => {
  await page.clock.install();
  await page.goto(`${ORIGIN}${SIGMA}`);
  await page.getByTestId('claim-card').first().waitFor();
  await settled(page);
  await expect(page.getByTestId('offline-band')).toHaveCount(0);

  await stop(mock);
  rmSync(sock('o'), { force: true });
  const t0 = Date.now();
  await page.clock.fastForward(46_000); // the next poll
  await expect(page.getByTestId('offline-band')).toBeVisible({ timeout: 5_000 });
  const raisedIn = Date.now() - t0;
  expect(raisedIn, 'band within 5 s of the failing poll').toBeLessThan(5_000);
  await expect(page.getByTestId('offline-band')).toHaveAttribute('data-code', 'kb_socket_missing');
  await expect(page.getByTestId('offline-band')).toContainText('마지막 성공');
  await expect(page.getByTestId('offline-band')).toContainText('마지막 자료');
  await expect(page.locator('[data-testid=header-status] .dot')).toHaveAttribute('data-state', 'down');

  // What was on screen stays. A new read fails with a card and does not take the page down.
  await expect(page.getByTestId('node-title')).toHaveText('sigma.js');
  await page.locator('[data-testid=edges-out] [data-far="e:library:graphology"] [data-testid=edge-link]').click();
  await expect(page.getByTestId('error-card')).toBeVisible({ timeout: 6_000 });
  await expect(page.getByTestId('error-card')).toHaveAttribute('data-code', 'kb_socket_missing');

  // Back up: the 30 s retry finds it, the band goes and the failed screen reads again.
  mock = await startMock('o', FIXTURE);
  await page.clock.fastForward(31_000);
  await expect(page.getByTestId('offline-band')).toHaveCount(0, { timeout: 6_000 });
  await expect(page.getByTestId('node-title')).toHaveText('graphology', { timeout: 6_000 });
  await expect(page.getByTestId('error-card')).toHaveCount(0);
  void watch;
});

test('losing loupe serve itself says the WSL may have stopped', async ({ page, watch }) => {
  await page.clock.install();
  await page.goto(`${ORIGIN}${SIGMA}`);
  await page.getByTestId('claim-card').first().waitFor();
  await settled(page);
  await stop(serve);
  await page.clock.fastForward(46_000);
  await expect(page.getByTestId('offline-band')).toBeVisible({ timeout: 8_000 });
  await expect(page.getByTestId('offline-band')).toContainText('WSL이 멈췄을 수 있다');
  await expect(page.getByTestId('node-title')).toHaveText('sigma.js');
  void watch;
});

test('a first load with the KB already down says so, with the proxy code', async ({ page }) => {
  const w = await watchPage(page);
  await stop(mock);
  rmSync(sock('o'), { force: true });
  await page.goto(`${ORIGIN}/#/status`);
  await expect(page.getByTestId('kb-status')).toContainText('사용 불가', { timeout: 8_000 });
  await expect(page.getByTestId('kb-status')).toContainText('kb_socket_missing');
  await expect(page.getByTestId('offline-band')).toBeVisible();
  expect(w.dialogs).toEqual([]);
});

test('one failed read is not an outage: the band needs two in a row', async ({ page, watch }) => {
  await page.goto(`${ORIGIN}${SIGMA}`);
  await page.getByTestId('claim-card').first().waitFor();
  await settled(page);
  let failed = 0;
  await page.route(/\/kb\/v1\/nodes\/e%3Alibrary%3Agraphology/, async (route) => {
    if (failed++ === 0) await route.fulfill({ status: 502, contentType: 'application/problem+json', body: JSON.stringify({ type: 'x', title: 'x', status: 502, code: 'kb_upstream_error' }) });
    else await route.continue();
  });
  await page.locator('[data-testid=edges-out] [data-far="e:library:graphology"] [data-testid=edge-link]').click();
  await expect(page.getByTestId('node-title')).toHaveText('graphology', { timeout: 6_000 });
  await expect(page.getByTestId('offline-band')).toHaveCount(0);
  void watch;
});

test('a picture of the band, for the reader', async ({ page, watch }) => {
  await page.clock.install();
  await page.goto(`${ORIGIN}${SIGMA}`);
  await page.getByTestId('claim-card').first().waitFor();
  await settled(page);
  await stop(mock);
  rmSync(sock('o'), { force: true });
  await page.clock.fastForward(46_000);
  await expect(page.getByTestId('offline-band')).toBeVisible({ timeout: 5_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(shotsDir, '51-offline-band.png') });
  await page.locator('[data-testid=edges-out] [data-far="e:library:graphology"] [data-testid=edge-link]').click();
  await expect(page.getByTestId('error-card')).toBeVisible({ timeout: 6_000 });
  await page.screenshot({ path: path.join(shotsDir, '52-offline-error-card.png') });
  void watch;
});
