// What the specs need to know about the running app.
import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { root } from './ports.ts';

export const fixture = (name: string) => JSON.parse(readFileSync(path.join(root, 'contract-sample/fixtures', name), 'utf8'));
export const claimRow = (fx: { claims: { id: string; version: number }[] }, id: string) => fx.claims.filter((c) => c.id === id).sort((a, b) => b.version - a.version)[0] as never as { id: string; statement: string; evidence: { id: string; snapshot_id: string; exact: string | null; start: number | null; end: number | null }[] };

export async function settled(page: Page) {
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('loading')).toHaveCount(0);
  await expect(page.locator('main')).toBeVisible();
}

export const highlights = (page: Page) => page.evaluate(() => {
  const h = CSS.highlights?.get('loupe-quote');
  return h ? [...h.values()].map((r) => (r as Range).toString()) : [];
});

/** What a person sees, minus what a session only remembers: a pill's verdict is a cached check, not screen state. */
export const fingerprint = (page: Page) => page.evaluate(() => {
  const main = document.querySelector('main')!.cloneNode(true) as HTMLElement;
  main.querySelectorAll('[data-testid=verdict]').forEach((e) => e.remove());
  const h = CSS.highlights?.get('loupe-quote');
  return {
    title: document.title,
    band: document.querySelector('[data-testid=time-band]')?.textContent ?? null,
    frame: !!document.querySelector('[data-testid=time-frame]'),
    screen: document.querySelector('main')!.getAttribute('data-testid'),
    text: main.textContent,
    highlights: h ? [...h.values()].map((r) => (r as Range).toString()) : [],
  };
});

export const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

export async function setTime(page: Page, t: { valid?: string; observed?: string }) {
  await page.getByTestId('time-chip').click();
  if (t.valid !== undefined) await page.getByTestId('time-valid').fill(t.valid);
  if (t.observed !== undefined) await page.getByTestId('time-observed').fill(t.observed);
  await page.getByTestId('time-apply').click();
}

/** Rewrites one JSON response from the KB, for states the fixtures cannot hold on purpose. */
export async function rewriteKb(page: Page, match: RegExp, edit: (body: Record<string, any>, url: URL) => unknown) { // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.route((u) => u.pathname.startsWith('/kb/') && match.test(u.pathname + u.search), async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const out = edit(body, new URL(route.request().url()));
    await route.fulfill({ response: res, json: out ?? body });
  });
}
