// Screenshots of every screen and state, for a person to read. Not assertions about pixels.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect, hash, nodePath } from './support/test.ts';
import { HOSTILE, RESEARCH, SAMPLE, shotsDir } from './support/ports.ts';
import { rewriteKb } from './support/app.ts';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
mkdirSync(shotsDir, { recursive: true });
const shot = async (page: Page, name: string, fullPage = false) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shotsDir, `${name}.png`), fullPage });
};
const go = async (page: Page, origin: string, p: string, ready: string) => {
  await page.goto(`${origin}/`);
  await page.goto(`${origin}${hash(p)}`);
  await page.reload();
  await expect(page.locator(ready).first()).toBeVisible();
};

test('home and palette', async ({ page, watch }) => {
  await go(page, RESEARCH, '/', '[data-testid=home-entity]');
  await shot(page, '01-home');
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await shot(page, '02-palette-empty');
  await page.getByTestId('palette-input').pressSequentially('sigma');
  await expect(page.getByTestId('palette-hit').first()).toBeVisible();
  await shot(page, '03-palette-results');
  await page.getByTestId('palette-input').fill('2026-10-28');
  await expect(page.getByTestId('cmd-valid')).toBeVisible();
  await shot(page, '04-palette-date');
  await page.getByTestId('palette-input').fill('없는말없는말');
  await expect(page.getByTestId('palette-empty')).toBeVisible();
  await shot(page, '05-palette-empty-result');
  void watch;
});

test('entity pages', async ({ page, watch }) => {
  await go(page, RESEARCH, nodePath('e:library:sigma-js'), '[data-testid=claim-card]');
  await shot(page, '10-entity');
  await shot(page, '10-entity-full', true);
  await go(page, RESEARCH, nodePath('e:project:sagae-gateway'), '[data-testid=conflict-group]');
  await page.getByTestId('conflict-group').first().scrollIntoViewIfNeeded();
  await shot(page, '11-entity-conflict');
  await go(page, RESEARCH, nodePath('e:library:sigma-js', '?status=all&include_unverified=true'), '[data-testid=claim-card]');
  await shot(page, '12-entity-all-status-full', true);
  await go(page, RESEARCH, nodePath('f-01JD2K7Q9T4M8A'), '[data-testid=record-body]');
  await expect(page.getByTestId('rendered')).toBeVisible();
  await shot(page, '13-first-party');
  await go(page, RESEARCH, nodePath('e:feature:mcp-session-id'), '[data-testid=entity-page]');
  await shot(page, '14-dead-entity');
  await go(page, RESEARCH, nodePath('e:tool:1mcp-app'), '[data-testid=merge-notice]');
  await shot(page, '15-merged');
  await go(page, RESEARCH, nodePath('e:spike:s1-aggregation'), '[data-testid=claims-truncated]');
  await page.getByTestId('claims-truncated').scrollIntoViewIfNeeded();
  await shot(page, '16-truncated');
  await go(page, RESEARCH, nodePath('c-ecfb958d5519'), '[data-testid=claim-page]');
  await shot(page, '17-claim');
  void watch;
});

const AXES = 'as_of_valid=2026-10-28T00:00:00Z&as_of_observed=2026-10-31T12:00:00Z';

test('past view', async ({ page, watch }) => {
  await go(page, RESEARCH, nodePath('e:library:sigma-js', `?${AXES}`), '[data-testid=claim-card]');
  await shot(page, '30-past-entity');
  await page.getByTestId('time-chip').click();
  await expect(page.getByTestId('time-form')).toBeVisible();
  await shot(page, '31-time-chip-open');
  await page.keyboard.press('Escape');
  await go(page, RESEARCH, `/source/n-198da44f5f7ce10d?claim=c-4c2e31e4ac9b&${AXES}`, '[data-testid=quote-marker]');
  await shot(page, '32-past-source');
  void watch;
});

test('states', async ({ page, watch }) => {
  await go(page, RESEARCH, '/status', '[data-testid=kb-schema-version]');
  await shot(page, '40-status');
  await go(page, RESEARCH, nodePath('e:concept:never-existed'), '[data-testid=not-visible-page]');
  await shot(page, '41-not-visible');
  await go(page, RESEARCH, '/node/..%2F..%2Fadmin', '[data-testid=route-error]');
  await shot(page, '42-bad-id');
  await go(page, RESEARCH, nodePath('e:library:sigma-js', '?as_of_valid=yesterday'), '[data-testid=route-error]');
  await shot(page, '43-bad-time');
  await go(page, RESEARCH, '/schema', '[data-testid=not-found-route]');
  await shot(page, '44-no-route');
  await go(page, SAMPLE, '/source/n-removed00000001', '[data-testid=error-card]');
  await shot(page, '45-content-removed');
  await go(page, SAMPLE, '/source/n-pdfimage00000001', '[data-testid=source-page]');
  await shot(page, '46-no-display-body');
  void watch;
});

test('source failures', async ({ page, watch }) => {
  await go(page, RESEARCH, '/source/n-198da44f5f7ce10d?claim=c-32aeb9f6c200', '[data-testid=recorded-quote]');
  await shot(page, '47-quote-not-found');
  await rewriteKb(page, /^\/kb\/v1\/claims\//, (b) => { b.data.evidence[0].start += 7; b.data.evidence[0].end += 7; });
  await go(page, RESEARCH, '/source/n-198da44f5f7ce10d?claim=c-1e442c5458f5', '[data-testid=quote-marker]');
  await shot(page, '48-quote-corrected');
  void watch;
});

test('contract block', async ({ page, watch }) => {
  await rewriteKb(page, /^\/kb\/v1\//, (b) => { b.schema_version = '1.0.0'; });
  await go(page, RESEARCH, nodePath('e:library:sigma-js'), '[data-testid=contract-block]');
  await shot(page, '49-contract-block');
  void watch;
});

test('merge error and tombstone', async ({ page, watch }) => {
  await page.route(/\/kb\/v1\/nodes\/e%3Atool%3A1mcp\?/, (r) => r.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ type: 'x', title: 'not found', status: 404, code: 'not_found' }) }));
  await go(page, RESEARCH, nodePath('e:tool:1mcp-app'), '[data-testid=tombstone]');
  await shot(page, '50-tombstone');
  void watch;
});

test('hostile', async ({ page, watch }) => {
  await go(page, HOSTILE, nodePath('e:concept:script-in-label', '?status=all&include_unverified=true'), '[data-testid=claim-card]');
  await shot(page, '60-hostile-entity');
  await go(page, HOSTILE, nodePath('e:concept:very-long-label'), '[data-testid=claim-card]');
  await shot(page, '61-hostile-long-label');
  await go(page, HOSTILE, '/source/n-hostile000000001?claim=c-d8f242df84e3', '[data-testid=quote-marker]');
  await shot(page, '62-hostile-source');
  await page.getByTestId('tab-rendered').click();
  await expect(page.getByTestId('rendered')).toBeVisible();
  await shot(page, '63-hostile-rendered');
  void watch;
});

test('phone width', async ({ page, watch }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await go(page, RESEARCH, nodePath('e:library:sigma-js'), '[data-testid=claim-card]');
  await shot(page, '70-phone-entity');
  await go(page, RESEARCH, '/source/n-198da44f5f7ce10d?claim=c-1e442c5458f5', '[data-testid=quote-marker]');
  await shot(page, '71-phone-source');
  void watch;
});

test('source', async ({ page, watch }) => {
  await go(page, RESEARCH, `/source/n-198da44f5f7ce10d?claim=c-1e442c5458f5`, '[data-testid=quote-marker]');
  await shot(page, '20-source-quote');
  await page.getByTestId('tab-rendered').click();
  await expect(page.getByTestId('rendered')).toBeVisible();
  await shot(page, '21-source-rendered');
  await go(page, RESEARCH, `/source/n-b0b5bb5257562d33?claim=c-9c513f2de839`, '[data-testid=quote-marker]');
  await shot(page, '22-source-window');
  await go(page, RESEARCH, `/source/n-96a3766fdc63a8cf?claim=c-b34742117968`, '[data-testid=quote-pointer]');
  await shot(page, '23-source-json');
  void watch;
});
