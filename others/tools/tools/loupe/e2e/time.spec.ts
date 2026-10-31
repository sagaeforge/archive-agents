// Time travel (design 4, section 11 "시간 전파").
import { test, expect } from './support/test.ts';
import { RESEARCH } from './support/ports.ts';
import { operations } from '../dev/kb-mock/spec.ts';
import { TIME_AXIS_OPERATIONS, type OperationId } from '../src/time/timeAxes.ts';
import { fixture, rewriteKb, settled } from './support/app.ts';

const VALID = '2026-10-28T00:00:00Z', OBSERVED = '2026-10-31T12:00:00Z';
const AXES = `as_of_valid=${VALID}&as_of_observed=${OBSERVED}`;
const SIGMA = 'e%3Alibrary%3Asigma-js';

const templates = operations().map((o) => ({ op: o.operationId as OperationId, re: new RegExp(`^${o.path.replace(/\{\w+\}/g, '[^/]+')}$`) }));
const opOf = (pathname: string) => templates.find((t) => t.re.test(pathname))?.op;

function audit(paths: string[]) {
  const seen = new Set<string>();
  for (const p of paths) {
    const u = new URL(p, 'http://x');
    const op = opOf(u.pathname);
    expect(op, `known operation: ${p}`).toBeTruthy();
    seen.add(op!);
    if (TIME_AXIS_OPERATIONS[op!]) {
      expect(u.searchParams.get('as_of_valid'), p).toBe(VALID);
      expect(u.searchParams.get('as_of_observed'), p).toBe(OBSERVED);
    } else {
      expect(u.searchParams.has('as_of_valid'), p).toBe(false);
      expect(u.searchParams.has('as_of_observed'), p).toBe(false);
    }
  }
  return seen;
}

test('a journey from a deep link carries both axes on every time-aware read and none on the C 2.9 set', async ({ page, watch }) => {
  await page.goto(`${RESEARCH}/#/node/${SIGMA}?${AXES}&status=all`);
  await expect(page.getByTestId('time-band')).toBeVisible();
  await expect(page.getByTestId('claim-card').first()).toBeVisible();
  // relation, then back, through links that carry only an id
  await page.locator('[data-testid=edges-out] [data-testid=edge-link]').first().click();
  await expect(page).toHaveURL(/as_of_valid=/);
  await expect(page.getByTestId('entity-page')).toBeVisible();
  await settled(page);
  // palette search and a recent item, then a superseded claim's history
  await page.keyboard.press('/');
  await page.keyboard.type('sigma', { delay: 15 });
  await expect(page.getByTestId('palette-hit').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('node-title')).toHaveText('sigma.js');
  await page.getByTestId('brand').click();
  await expect(page.getByTestId('home-entity').first()).toBeVisible();
  await expect(page).toHaveURL(/as_of_observed=/);
  await page.goto(`${RESEARCH}/#/node/c-4c2e31e4ac9b?${AXES}`);
  await expect(page.getByTestId('claim-page')).toBeVisible();
  // the quote: claim with axes, snapshot and text without
  await page.getByTestId('evidence-link').click();
  await expect(page.getByTestId('source-text')).toBeVisible();
  await settled(page);
  await expect(page).toHaveURL(/as_of_valid=/);

  const seen = audit(watch.kbPaths());
  for (const op of ['getNode', 'getNodeNeighbors', 'search', 'listNodes', 'getClaim', 'getSnapshot', 'getSnapshotText', 'getSchema', 'getMeta']) expect([...seen]).toContain(op);
  expect(watch.responses.filter((r) => r.status === 400), 'the KB never refused an axis').toEqual([]);
});

test('history, the one claim read without axes, gets none', async ({ page, watch }) => {
  await page.goto(`${RESEARCH}/#/node/${SIGMA}?${AXES}`);
  await page.goto(`${RESEARCH}/#/node/${SIGMA}?status=all`);
  await page.reload();
  await page.getByTestId('claim-card').first().waitFor();
  await page.locator('[data-claim=c-4c2e31e4ac9b] [data-testid=find-successor]').click();
  await expect(page.locator('[data-claim=c-4c2e31e4ac9b] [data-testid=successor]')).toBeVisible();
  const h = watch.kbPaths().filter((p) => p.includes('/history'));
  expect(h.length).toBe(1);
  expect(h[0]).not.toContain('as_of');
});

test('the band, the frame, the tab title and the marker all survive a reload', async ({ page, watch }) => {
  await page.goto(`${RESEARCH}/#/node/${SIGMA}?${AXES}`);
  const check = async () => {
    await expect(page.getByTestId('time-band')).toContainText('2026-10-28');
    await expect(page.getByTestId('time-band')).toContainText('2026-10-31 21:00 KST');
    await expect(page.getByTestId('time-frame')).toBeVisible();
    await expect(page).toHaveTitle(/^\[과거\] /);
    await expect(page.getByTestId('claim-group').first().getByTestId('time-mark')).toBeVisible();
  };
  await check();
  await page.reload();
  await check();
  // UTC original in the title attribute (design 4)
  await expect(page.getByTestId('time-band').locator('span').nth(1)).toHaveAttribute('title', OBSERVED);
  // The band stays in view while the page scrolls
  await page.mouse.wheel(0, 2000);
  await expect(page.getByTestId('time-band')).toBeInViewport();
  void watch;
});

test('the frame does not take clicks', async ({ page, watch }) => {
  await page.goto(`${RESEARCH}/#/node/${SIGMA}?${AXES}`);
  await page.locator('[data-testid=edges-out] [data-testid=edge-link]').first().click();
  await expect(page).not.toHaveURL(/sigma-js/);
  void watch;
});

test('a retroactive correction shows on the observed axis alone', async ({ page, watch }) => {
  const at = async (observed: string) => {
    await page.goto(`${RESEARCH}/#/node/${SIGMA}?as_of_valid=${VALID}&as_of_observed=${observed}`);
    await expect(page.locator('[data-predicate=atlas_glyphs_per_page] [data-testid=claim-value]').first()).toBeVisible();
    return page.locator('[data-predicate=atlas_glyphs_per_page] [data-testid=claim-value]').allTextContents();
  };
  expect(await at(OBSERVED)).toEqual(['576']);
  expect(await at('2026-10-31T16:00:00Z')).toEqual(['289']);
  await page.goto(`${RESEARCH}/#/node/${SIGMA}?as_of_valid=2026-10-20T00:00:00Z`);
  await expect(page.getByTestId('claims')).toBeVisible();
  await expect(page.locator('[data-predicate=atlas_glyphs_per_page]')).toHaveCount(0);
  void watch;
});

test('a card moves the observed axis to its own recorded_at', async ({ page, watch }) => {
  const old = fixture('kb-research.json').claims.filter((c: { id: string }) => c.id === 'c-1e442c5458f5')[0];
  await page.goto(`${RESEARCH}/#/node/${SIGMA}`);
  const card = page.locator('[data-claim=c-1e442c5458f5]');
  await card.hover();
  await card.getByTestId('to-observed').click();
  await expect(page).toHaveURL(new RegExp(`as_of_observed=${old.recorded_at.replaceAll(':', '(:|%3A)')}`));
  await expect(page.getByTestId('time-band')).toBeVisible();
  void watch;
});

test('the palette moves time, pins now, and returns', async ({ page, watch }) => {
  await page.goto(`${RESEARCH}/#/node/${SIGMA}`);
  await page.getByTestId('claim-card').first().waitFor();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('2026-10-28');
  await page.getByTestId('cmd-valid').click();
  await expect(page).toHaveURL(/as_of_valid=2026-10-28T00(:|%3A)00(:|%3A)00Z/);
  await expect(page.getByTestId('time-band')).toContainText('유효 2026-10-28');

  await page.keyboard.press('Control+k');
  await page.keyboard.type('현재로');
  await page.getByTestId('cmd-present').click();
  await expect(page).not.toHaveURL(/as_of_/);

  await page.keyboard.press('Control+k');
  await page.keyboard.type('지금으로');
  await page.getByTestId('cmd-pin').click();
  // data_as_of of the fixture, so the link is reproducible
  await expect(page).toHaveURL(/as_of_observed=2026-10-31T23(:|%3A)00(:|%3A)00Z/);
  await expect(page.getByTestId('time-band')).toBeVisible();
  void watch;
});

test('the chip clears both axes, and a link copy carries them', async ({ page, context, watch }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${RESEARCH}/#/node/${SIGMA}?${AXES}`);
  await page.getByTestId('claim-card').first().waitFor();
  await page.getByTestId('time-band').getByTestId('copy-link').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('as_of_observed=');
  await page.getByTestId('time-chip').click();
  await expect(page.getByTestId('time-valid')).toHaveValue('2026-10-28');
  await expect(page.getByTestId('time-observed')).toHaveValue('2026-10-31T21:00');
  await page.getByTestId('time-present').click();
  await expect(page.getByTestId('time-band')).toHaveCount(0);
  await expect(page).not.toHaveTitle(/과거/);
  void watch;
});

test('a bad time value is an error screen, never silently now', async ({ page, watch }) => {
  for (const q of ['as_of_valid=yesterday', 'as_of_observed=2026-02-31T00:00:00Z', 'as_of_valid=2026-10-28', 'as_of_valid=2026-10-28T09:00:00%2B09:00']) {
    await page.goto(`${RESEARCH}/`);
    await page.goto(`${RESEARCH}/#/node/${SIGMA}?${q}`);
    await page.reload();
    await expect(page.getByTestId('route-error'), q).toBeVisible();
    await expect(page.getByTestId('claim-card')).toHaveCount(0);
  }
  // And the way out really leaves
  await page.getByTestId('go-home').click();
  await expect(page.getByTestId('route-error')).toHaveCount(0);
  await expect(page.getByTestId('home')).toBeVisible();
  void watch;
});

test('the source folds its citing claims in a past view and says they are current', async ({ page, watch }) => {
  await page.goto(`${RESEARCH}/#/source/n-198da44f5f7ce10d?${AXES}`);
  await expect(page.getByTestId('citing-now')).toHaveText('현재 기준');
  await expect(page.getByTestId('citing-past')).not.toHaveAttribute('open');
  await page.goto(`${RESEARCH}/#/source/n-198da44f5f7ce10d`);
  await expect(page.getByTestId('citing-row').first()).toBeVisible();
  await expect(page.getByTestId('citing-now')).toHaveCount(0);
  void watch;
});

test('polling in a past view changes nothing on screen: a new applied_seq only raises the chip', async ({ page, watch }) => {
  await page.clock.install();
  let bump = 0;
  await rewriteKb(page, /^\/kb\/v1\/meta/, (b) => { b.applied_seq += bump; });
  await page.goto(`${RESEARCH}/#/node/${SIGMA}?${AXES}`);
  await page.getByTestId('claim-card').first().waitFor();
  await settled(page);
  const before = await page.locator('main').textContent();
  const reads = () => watch.kbPaths().filter((p) => p.startsWith('/v1/nodes/')).length;
  const n = reads();
  bump = 5;
  await page.clock.fastForward(46_000);
  await expect(page.getByTestId('new-data')).toBeVisible();
  await settled(page);
  expect(await page.locator('main').textContent()).toBe(before);
  expect(reads(), 'no screen query refetched').toBe(n);
});

test('in the present a new applied_seq refreshes the screen and raises no chip', async ({ page, watch }) => {
  await page.clock.install();
  let bump = 0;
  await rewriteKb(page, /^\/kb\/v1\/meta/, (b) => { b.applied_seq += bump; });
  await page.goto(`${RESEARCH}/#/node/${SIGMA}`);
  await page.getByTestId('claim-card').first().waitFor();
  await settled(page);
  const reads = () => watch.kbPaths().filter((p) => p.startsWith('/v1/nodes/')).length;
  const n = reads();
  bump = 5;
  await page.clock.fastForward(46_000);
  await expect.poll(reads).toBeGreaterThan(n);
  await expect(page.getByTestId('new-data')).toHaveCount(0);
});
