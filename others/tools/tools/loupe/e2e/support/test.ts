// The shared fixture: records KB requests and everything that must never happen, and fails the test if it did.
import { test as base, expect, type Page, type Response } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { root } from './ports.ts';

// WSL has no Korean font. Noto Sans KR comes from npm and only in tests (design 11); the app itself loads no font.
const fontDir = path.dirname(createRequire(import.meta.url).resolve('@fontsource/noto-sans-kr/package.json'));
const fontCss = ['400', '700'].map((w) => readFileSync(path.join(fontDir, `${w}.css`), 'utf8')).join('\n').replaceAll('url(./files/', 'url(./__e2e-fonts/');

export type Watch = {
  kb: string[]; responses: { url: string; status: number }[]; consoleErrors: string[]; dialogs: string[]; pageErrors: string[]; external: string[];
  csp: () => Promise<string[]>;
  /** Path and query of each KB call, without the /kb prefix. */
  kbPaths: () => string[];
};

export async function watchPage(page: Page): Promise<Watch> {
  const w: Watch = {
    kb: [], responses: [], consoleErrors: [], dialogs: [], pageErrors: [], external: [],
    csp: () => page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []),
    kbPaths: () => w.kb.map((u) => { const x = new URL(u); return x.pathname.replace(/^\/kb/, '') + x.search; }),
  };
  await page.route('**/__e2e-fonts/*', (r) => r.fulfill({ path: path.join(fontDir, 'files', path.basename(new URL(r.request().url()).pathname)), contentType: 'font/woff2' }));
  await page.addInitScript((css) => {
    document.addEventListener('securitypolicyviolation', (e) => { ((window as unknown as { __csp?: string[] }).__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`); });
    const add = () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); };
    if (document.head) add(); else document.addEventListener('DOMContentLoaded', add);
  }, fontCss);
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/kb/')) w.kb.push(u);
    if (!/^(http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/|data:|blob:)/.test(u)) w.external.push(u);
  });
  page.on('response', (r: Response) => { if (r.url().includes('/kb/')) w.responses.push({ url: r.url(), status: r.status() }); });
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) w.consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => w.pageErrors.push(String(e)));
  page.on('dialog', (d) => { w.dialogs.push(d.message()); void d.dismiss(); });
  return w;
}

export async function expectClean(page: Page, w: Watch) {
  expect(w.dialogs, 'no dialog ever opens').toEqual([]);
  expect(w.pageErrors, 'no uncaught error').toEqual([]);
  expect(w.consoleErrors, 'no console error').toEqual([]);
  expect(w.external, 'every request is same origin').toEqual([]);
  expect(await w.csp().catch(() => []), 'no CSP violation').toEqual([]);
}

export const test = base.extend<{ watch: Watch }>({
  watch: async ({ page }, use) => {
    const w = await watchPage(page);
    await use(w);
    await expectClean(page, w);
  },
});
export { expect };

export const hash = (p: string) => `/#${p}`;
export const nodePath = (id: string, query = '') => `/node/${encodeURIComponent(id)}${query}`;
