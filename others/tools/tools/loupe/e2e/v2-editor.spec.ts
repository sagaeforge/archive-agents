// M0a editor in a window (design v2 4.2 items 5-6, 4.5): lazy chunk, hostile paste, hostile foreign body, Trusted Types violations.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from './support/test.ts';
import { RESEARCH } from './support/ports.ts';
import { createMarkdownCodec } from '../src/editor/index.ts';
import { disallowedTypes } from '../src/editor/safety.ts';

type Paste = { id: string; html?: string; text?: string; keeps?: string[]; absent?: string[] };
const fixtures = new URL('../test/fixtures/editor/', import.meta.url);
const pastes = JSON.parse(readFileSync(new URL('malicious-paste.json', fixtures), 'utf8')) as Paste[];
const codec = createMarkdownCodec();
const EDITOR = '[data-testid=editor-content]';
// Elements that may never exist inside the editor. ProseMirror's own `img.ProseMirror-separator` (an empty hack after an inline atom, no src) is not content.
const FORBIDDEN = 'img:not(.ProseMirror-separator),img[src],svg,iframe,frame,object,embed,video,audio,source,script,style,link,meta,base,form,input,button,textarea,select,canvas,picture';

/** Design 4.5 "Trusted Types": the target policy is measured in report-only mode, so a sink the editor uses without a policy is counted, not blocked. */
async function measureTrustedTypes(page: Page) {
  // The home draws its graph behind the editor window. The default 3D graph's library assigns innerHTML = '' when it mounts, which would count as an
  // editor sink: this measurement is about the editor, so it runs with the 2D graph. The 3D sinks are measured in graph3d.spec.ts.
  await page.addInitScript(() => localStorage.setItem('loupe.appearance', JSON.stringify({ theme: 'light', size: 'normal', motion: 'system', graph: '2d' })));
  await page.addInitScript(() => {
    const seen: { directive: string; sample: string }[] = ((window as unknown as { __tt?: unknown[] }).__tt = []) as never;
    document.addEventListener('securitypolicyviolation', (e) => { seen.push({ directive: e.violatedDirective, sample: e.sample }); });
  });
  await page.route(`${RESEARCH}/`, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), 'content-security-policy-report-only': "require-trusted-types-for 'script'" } });
  });
}
/** CSP violations are 0. Trusted Types sinks are 0 for the editor: the two `new Worker(url)` calls of the v1 Markdown and graph-layout workers are a
 *  known app-wide baseline (not editor code), so they are the only sink samples tolerated, and then removed from the shared CSP record. */
async function expectNoViolations(page: Page, watch: { csp: () => Promise<string[]> }) {
  const seen = await page.evaluate(() => (window as unknown as { __tt: { directive: string; sample: string }[] }).__tt);
  expect(seen.filter(v => v.directive !== 'require-trusted-types-for'), 'CSP violations').toEqual([]);
  expect(seen.filter(v => v.directive === 'require-trusted-types-for' && !v.sample.startsWith('Worker constructor')), 'Trusted Types sinks used by the editor').toEqual([]);
  expect((await watch.csp()).filter(v => !v.startsWith('require-trusted-types-for')), 'CSP violations').toEqual([]);
  await page.evaluate(() => { const w = window as unknown as { __csp?: string[] }; w.__csp = (w.__csp ?? []).filter(v => !v.startsWith('require-trusted-types-for')); });
}
async function openEditor(page: Page, id: string) {
  await page.goto(`${RESEARCH}/#/w/${encodeURIComponent(id)}`);
  const toggle = page.getByTestId('window-edit-toggle');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator(EDITOR)).toBeVisible();
}
async function paste(page: Page, data: { html?: string; text?: string }) {
  await page.locator(EDITOR).click();
  await page.evaluate(({ html, text, selector }) => {
    const dt = new DataTransfer();
    if (html !== undefined) dt.setData('text/html', html);
    if (text !== undefined) dt.setData('text/plain', text);
    document.querySelector(selector)!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { ...data, selector: EDITOR });
}
/** Everything a hostile document could turn into inside the editor's DOM. (A React node view wrapper carries Tiptap's own fixed `style`; no author text reaches it.) */
async function domAudit(page: Page) {
  return page.evaluate(({ selector, forbidden }) => {
    const root = document.querySelector(selector)!;
    const handlers: string[] = [];
    for (const el of [root, ...root.querySelectorAll('*')]) for (const a of el.attributes) if (/^on/i.test(a.name) || (a.name === 'style' && !el.hasAttribute('data-node-view-wrapper')) || a.name === 'srcdoc') handlers.push(`${el.tagName} ${a.name}`);
    return {
      forbidden: [...root.querySelectorAll(forbidden)].map(e => e.tagName),
      handlers,
      hrefs: [...root.querySelectorAll('a')].map(a => a.getAttribute('href')),
      pwned: (window as unknown as { __pwned?: unknown }).__pwned,
      text: root.textContent ?? '',
    };
  }, { selector: EDITOR, forbidden: FORBIDDEN });
}
const savedMarkdown = async (page: Page) => (await page.getByTestId('editor-source').textContent()) ?? '';

test.describe('M0a editor window', () => {
  test('the editor chunk is fetched only when a window switches to editing', async ({ page, watch }) => {
    const scripts: { url: string; editor: Promise<boolean> }[] = [];
    page.on('response', (r) => { if (/\/assets\/.*\.js$/.test(r.url())) scripts.push({ url: r.url(), editor: r.text().then(t => t.includes('ProseMirror'), () => false) }); });
    await page.goto(`${RESEARCH}/#/w/f-m0c-note`);
    await expect(page.getByTestId('wm-window')).toHaveCount(1);
    await expect(page.getByTestId('window-edit-toggle')).toHaveText('편집');
    await page.waitForLoadState('networkidle');
    // The read window is up: no script that carries the editor has been fetched.
    expect((await Promise.all(scripts.map(async s => (await s.editor) ? s.url : null))).filter(Boolean)).toEqual([]);
    await page.getByTestId('window-edit-toggle').click();
    await expect(page.locator(EDITOR)).toBeVisible();
    const loaded = (await Promise.all(scripts.map(async s => (await s.editor) ? s.url : null))).filter(Boolean);
    expect(loaded.length, 'the editor chunk is fetched when the window switches to editing').toBeGreaterThan(0);
    // The editor shows the record's body, and nothing was written: the source is still the body as read.
    await expect(page.locator(EDITOR)).toContainText('창 배치를 기억한다.');
    expect(await savedMarkdown(page)).toBe('창 배치를 기억한다.\n제목과 본문은 저장하지 않는다.');
    expect(await page.evaluate(() => performance.getEntriesByType('resource').filter(e => /\.css$/.test(e.name)).length)).toBeGreaterThan(0);
    void watch;
  });

  test('the Trusted Types measurement is live: a bare innerHTML sink is counted', async ({ page, watch }) => {
    await measureTrustedTypes(page);
    await page.goto(`${RESEARCH}/#/`);
    await page.evaluate(() => { document.createElement('div').innerHTML = '<b>probe</b>'; });
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __tt: { sample: string }[] }).__tt)).map(v => v.sample)).toContain('Element innerHTML|<b>probe</b>');
    await page.evaluate(() => { const w = window as unknown as { __csp?: string[] }; w.__csp = []; });
  });

  for (const sample of pastes.filter(p => p.html !== undefined)) {
    test(`HTML paste ${sample.id}: only allow-listed content reaches the document`, async ({ page, watch }) => {
      await measureTrustedTypes(page);
      await openEditor(page, 'f-m0c-note');
      await paste(page, { html: sample.html!, text: sample.text });
      await expect.poll(async () => (await domAudit(page)).text).toContain(sample.keeps![0]);
      const audit = await domAudit(page);
      expect(audit.forbidden, 'no element outside the allow-list').toEqual([]);
      expect(audit.handlers, 'no event handler, style or srcdoc attribute').toEqual([]);
      expect(audit.hrefs.filter(h => !/^https?:\/\//.test(h ?? '')), 'only http and https hrefs').toEqual([]);
      expect(audit.pwned).toBeUndefined();
      for (const kept of sample.keeps ?? []) expect(audit.text, `keeps ${kept}`).toContain(kept);
      for (const gone of sample.absent ?? []) expect(audit.text, `drops ${gone}`).not.toContain(gone);
      // The saved Markdown: touch the document so it is serialized, then read it back through the schema.
      await page.keyboard.type('!');
      await expect.poll(() => savedMarkdown(page)).toContain('!');
      expect(disallowedTypes(codec.parse(await savedMarkdown(page)))).toEqual([]);
      await expectNoViolations(page, watch);
    });
  }

  for (const sample of pastes.filter(p => p.html === undefined)) {
    test(`plain-text paste ${sample.id}: parsed as Markdown, raw HTML and bad links stay text`, async ({ page, watch }) => {
      await measureTrustedTypes(page);
      await openEditor(page, 'f-m0c-note');
      await paste(page, { text: sample.text! });
      await expect.poll(async () => (await domAudit(page)).text).toContain('title');
      const audit = await domAudit(page);
      expect(audit.forbidden).toEqual([]);
      expect(audit.handlers).toEqual([]);
      expect(audit.hrefs.filter(h => !/^https?:\/\//.test(h ?? ''))).toEqual([]);
      expect(audit.hrefs).toContain('https://example.com/');
      expect(await page.locator(`${EDITOR} h1`).textContent()).toBe('title');
      // The raw HTML the author typed is visible as characters, not executed.
      expect(audit.text).toContain('<script>alert(\'md\')</script>');
      await page.keyboard.type('!');
      await expect.poll(() => savedMarkdown(page)).toContain('!');
      expect(disallowedTypes(codec.parse(await savedMarkdown(page)))).toEqual([]);
      await expectNoViolations(page, watch);
    });
  }

  test('a hostile body written by another author opens as inert text and saves inside the allow-list', async ({ page, watch }) => {
    await measureTrustedTypes(page);
    const hostile = readFileSync(new URL('hostile-body.md', fixtures), 'utf8');
    await openEditor(page, 'f-m0a-hostile');
    await expect(page.locator(`${EDITOR} h1`)).toHaveText('Hostile body written by another author');
    // Untouched: the source is the body byte for byte (design 4.1 item 2).
    expect(await savedMarkdown(page)).toBe(hostile);
    const audit = await domAudit(page);
    expect(audit.forbidden).toEqual([]);
    expect(audit.handlers).toEqual([]);
    expect(audit.hrefs.filter(h => !/^https?:\/\//.test(h ?? '')), 'bad links are plain text').toEqual([]);
    expect(audit.pwned).toBeUndefined();
    expect(audit.text, 'the attack text is visible as characters').toContain('window.__pwned = 1');
    // A node view is a text child: the wiki chip carries the id, and the invalid ones are marked as no link.
    await expect(page.locator(`${EDITOR} .wiki-link[data-wiki-id="e:topic:m0c"]`)).toHaveText('e:topic:m0c');
    // Edit it and read the saved Markdown back through the schema.
    await page.locator(`${EDITOR} h1`).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' edited');
    await expect.poll(() => savedMarkdown(page)).toContain('another author edited');
    const saved = await savedMarkdown(page);
    expect(disallowedTypes(codec.parse(saved))).toEqual([]);
    for (const attack of ['<script>window.__pwned = 1', 'onerror="alert(\'body-onerror\')"', '![tracker](https://evil.example/block-image.png)'])
      expect(saved, `the author's text is kept as written: ${attack}`).toContain(attack);
    // Design 4.5 "링크": a link that is not http or https loses the link and keeps its text.
    expect(saved).toContain('Link attempts: js data file [fine](https://example.com/ok).');
    expect(saved).not.toContain("(javascript:alert('body-js'))");
    await expectNoViolations(page, watch);
  });

  test('an image is refused: files dropped or pasted say that the KB stores no attachments', async ({ page, watch }) => {
    await measureTrustedTypes(page);
    await openEditor(page, 'f-m0c-note');
    await paste(page, { html: '<p>pic</p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">' });
    await expect(page.getByTestId('editor-notice')).toHaveText('KB는 첨부를 저장하지 않는다');
    expect((await domAudit(page)).forbidden).toEqual([]);
    await page.evaluate((selector) => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'a.png', { type: 'image/png' }));
      document.querySelector(selector)!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, EDITOR);
    await expect(page.getByTestId('editor-notice')).toBeVisible();
    expect((await domAudit(page)).forbidden).toEqual([]);
    await expectNoViolations(page, watch);
  });

  test('the drag handle shows for a block and the size line follows the saved text', async ({ page, watch }) => {
    await openEditor(page, 'f-m0c-page');
    await page.locator(`${EDITOR} p`).first().hover();
    await expect(page.getByTestId('editor-drag-handle')).toBeVisible();
    await expect(page.getByTestId('editor-size')).toHaveAttribute('data-bytes', String(Buffer.byteLength('# 작업 공간\n문서를 창에서 읽는다.')));
    void watch;
  });
});
