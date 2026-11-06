// loupe v2 M2, documents (design v2 11.3 "M2 문서", 2.7, 4.2, 4.4, 4.5, 5.2, 5.3, 5.6): a document is created and edited in the real app (headless Chromium, built SPA)
// against loupe serve and kb-mock with the write imitation (KB_MOCK_WRITE=1). The save path is the M1 one (src/memo/saver.ts), reused for `Page`.
//
// One server pair, stopped in afterAll: kb-mock 'd1' + loupe serve on PORT.authB (the memo spec has stopped its own by then: specs run one after another).
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Page, Route } from '@playwright/test';
import { test, expect, useSessions } from './support/test.ts';
import { login, writeAuthConfig } from './support/oidc.ts';
import { accessLog, base, PORT, root, sock } from './support/ports.ts';
import { startMock, startServe, stop } from './support/procs.ts';

const EDITOR_TOKEN = 'kbt_e_e2e-doc-editor', REVIEWER_TOKEN = 'kbt_r_e2e-doc-reviewer';
const FIXTURE = 'contract-sample/fixtures/kb.json';
const MOCK = 'd1';
const ORIGIN = base(PORT.authB);
const cfgDir = path.join(root, '.cache/auth/doc');
const procs: (ChildProcess | undefined)[] = [];
const sessions: Record<string, string> = {};
const CLAIM = 'c-8k2p4q7m1xab', CLAIM_B = 'c-hook1aaaaaaa';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  rmSync(cfgDir, { recursive: true, force: true });
  writeAuthConfig(cfgDir);
  for (const [name, token] of [['kb-editor.token', EDITOR_TOKEN], ['kb-reviewer.token', REVIEWER_TOKEN]] as const) { const f = path.join(cfgDir, name); writeFileSync(f, `${token}\n`); chmodSync(f, 0o600); }
  mkdirSync(path.dirname(accessLog(MOCK)), { recursive: true });
  rmSync(accessLog(MOCK), { force: true });
  procs.push(await startMock(MOCK, FIXTURE, { KB_MOCK_WRITE: '1', KB_MOCK_EDITOR_TOKEN: EDITOR_TOKEN, KB_MOCK_REVIEWER_TOKEN: REVIEWER_TOKEN }));
  procs.push(await startServe(MOCK, PORT.authB, { LOUPE_CONFIG_DIR: cfgDir }));
  sessions[ORIGIN] = await login(ORIGIN);
});
test.afterAll(async () => {
  await Promise.all(procs.map(stop));
  rmSync(sock(MOCK), { force: true });
  rmSync(cfgDir, { recursive: true, force: true });
});

/** What the KB saw, one line per request: `METHOD route status[ scope=…]`. */
const lines = () => (existsSync(accessLog(MOCK)) ? readFileSync(accessLog(MOCK), 'utf8').split('\n').filter(Boolean) : []);
const kbWrites = () => lines().filter((l) => /^(POST|PUT) \/v1\/records/.test(l));

type Sent = { method: string; path: string; body: Record<string, any> | null; raw: string | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Got = { path: string; status: number; json: Record<string, any> | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
function tap(page: Page) {
  const sent: Sent[] = [], got: Got[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/kb-write/')) { let body = null; try { body = JSON.parse(r.postData() ?? 'null'); } catch { /* not JSON */ } sent.push({ method: r.method(), path: u.pathname, body, raw: r.postData() }); }
  });
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/kb-write/')) void r.json().then((json) => got.push({ path: u.pathname, status: r.status(), json }), () => got.push({ path: u.pathname, status: r.status(), json: null }));
  });
  return { sent, got };
}
const answered = (t: ReturnType<typeof tap>, n: number) => expect.poll(() => t.got.length, { message: `${n} /kb-write/ answers read` }).toBeGreaterThanOrEqual(n);

const doc = (page: Page) => page.getByTestId('doc-window');
// The live editor. (An older version is shown by a second, read-only editor outside `.memo-body`.)
const editor = (page: Page) => doc(page).locator('.memo-body [data-testid=editor-content]');
const chip = (page: Page) => doc(page).getByTestId('memo-chip');
const source = (page: Page) => doc(page).getByTestId('editor-source');
async function openDoc(page: Page) {
  await useSessions(page, sessions);
  await page.goto(`${ORIGIN}/#/`);
  await page.getByTestId('doc-new').click();
  await expect(doc(page)).toBeVisible();
  await expect(editor(page)).toBeVisible();
  await editor(page).click();
}
/** A KB read as the app does it: the loupe session as Authorization. */
const kbGet = (page: Page, p: string) => page.evaluate(async (u) => {
  const r = await fetch(`/kb${u}`, { headers: { authorization: `Bearer ${sessionStorage.getItem('loupe.session')}` } });
  return { status: r.status, json: await r.json().catch(() => null) as Record<string, any> | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}, p);
/** A paste at the editor, the way v2-editor.spec.ts does it. */
async function paste(page: Page, data: { html?: string; text?: string }) {
  await editor(page).click();
  await page.evaluate(({ html, text }) => {
    const dt = new DataTransfer();
    if (html !== undefined) dt.setData('text/html', html);
    if (text !== undefined) dt.setData('text/plain', text);
    document.querySelector('[data-testid=doc-window] .memo-body [data-testid=editor-content]')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, data);
}
const blocks = (page: Page) => editor(page).locator(':scope > *').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));

// ---------------------------------------------------------------------------------------------------------------------------------
test.describe('units: the pieces a document adds', () => {
  test('a document without a first line gets the stamp with its own name, a memo keeps the old one', async () => {
    const { titleOf } = await import('../src/memo/title.ts');
    expect(titleOf('', new Date('2026-11-04T00:14:00Z'), '문서')).toBe('문서 2026-11-04 09:14');
    expect(titleOf('', new Date('2026-11-04T00:14:00Z'))).toBe('메모 2026-11-04 09:14');
    expect(titleOf('## 둘째 절\n본문', new Date(), '문서')).toBe('둘째 절');
  });

  test('4.4 and 4.5: a claim on a line of its own is a claim quote block in a document and stays one line of Markdown, byte for byte; the memo editor still reads it as a link', async () => {
    const { createMarkdownCodec } = await import('../src/editor/index.ts');
    const { disallowedTypes } = await import('../src/editor/safety.ts');
    const md = `앞 문단\n\n[[${CLAIM}]]\n\n뒤 문단 [[${CLAIM_B}]] 글 속 링크`;
    const docCodec = createMarkdownCodec({ doc: true });
    const parsed = docCodec.parse(md);
    expect(parsed.content!.map((n) => n.type)).toEqual(['paragraph', 'claimQuote', 'paragraph']);
    expect(parsed.content![1]!.attrs).toMatchObject({ id: CLAIM });
    expect(docCodec.serialize(parsed)).toBe(md);
    expect(disallowedTypes(parsed)).toEqual([]);
    const memoCodec = createMarkdownCodec();
    expect(memoCodec.parse(md).content!.map((n) => n.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(memoCodec.serialize(memoCodec.parse(md))).toBe(md);
    // A claim id of the wrong shape is a link in a paragraph, not a quote.
    expect(docCodec.parse('[[c-short]]').content![0]!.type).toBe('paragraph');
  });

  test('4.4: what the "[[" and "/" triggers see in the text before the cursor', async () => {
    const { findTrigger } = await import('../src/editor/suggest.ts');
    expect(findTrigger('[[cla')).toEqual({ kind: 'link', query: 'cla', length: 5 });
    expect(findTrigger('앞 글 [[')).toEqual({ kind: 'link', query: '', length: 2 });
    expect(findTrigger('[[done]] 그리고 [[x')).toEqual({ kind: 'link', query: 'x', length: 3 });
    expect(findTrigger('/')).toEqual({ kind: 'slash', query: '', length: 1 });
    expect(findTrigger('글 /제목 2')).toEqual({ kind: 'slash', query: '제목 2', length: 5 });
    expect(findTrigger('and/or')).toBeNull();
    expect(findTrigger('[[done]]')).toBeNull();
    expect(findTrigger('평문')).toBeNull();
  });

  test('the slash list is filtered by label and by keyword', async () => {
    const { filterSlash } = await import('../src/editor/suggest.ts');
    expect(filterSlash('제목').map((i) => i.id)).toEqual(['heading1', 'heading2', 'heading3']);
    expect(filterSlash('h2').map((i) => i.id)).toEqual(['heading2']);
    expect(filterSlash('주장').map((i) => i.id)).toEqual(['claim']);
    expect(filterSlash('없는명령')).toEqual([]);
    expect(filterSlash('').length).toBeGreaterThan(6);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
test.describe('criterion 1: create, slash menu, save through the M1 path', () => {
  test('a new document: text, a block from the slash menu, one save as a private Page under a create key; saving again changes nothing, an edit goes by PUT', async ({ page, watch }) => {
    const t = tap(page);
    await openDoc(page);
    await expect(doc(page).getByTestId('memo-mode-plain')).toHaveCount(0);
    await page.keyboard.type('첫 문단');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/제목 2');
    const menu = page.getByRole('listbox', { name: '블록 넣기' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('option').first()).toHaveAttribute('data-command', 'heading2');
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await page.keyboard.type('둘째 절');
    await expect(editor(page).locator('h2')).toHaveText('둘째 절');
    await expect(chip(page)).toContainText('저장 안 됨');

    const before = kbWrites().length;
    await doc(page).getByTestId('memo-save').click();
    await expect(chip(page)).toContainText('저장됨 v1');
    expect(kbWrites().slice(before)).toEqual(['POST /v1/records 201 scope=editor']);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.path).toBe('/kb-write/records');
    expect(t.sent[0]!.body).toMatchObject({ change: 'save', record: { type: 'Page', title: '첫 문단', body: '첫 문단\n\n## 둘째 절', body_format: 'markdown', sensitivity: 'private' } });
    expect(t.sent[0]!.body!.idempotency_key).toMatch(/^loupe:c:[0-9a-f-]{36}$/);
    await answered(t, 1);
    const id = t.got[0]!.json!.id as string;
    expect(t.got[0]).toMatchObject({ status: 201, json: { version: 1 } });
    // Nothing changed: no save to send.
    await expect(doc(page).getByTestId('memo-save')).toBeDisabled();
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(300);
    expect(kbWrites().slice(before)).toHaveLength(1);

    await page.keyboard.press('Enter');
    await page.keyboard.type('셋째');
    await page.keyboard.press('Control+s');
    await expect(chip(page)).toContainText('저장됨 v2');
    expect(t.sent[1]!.path).toBe(`/kb-write/records/${id}`);
    expect(t.sent[1]!.body).toMatchObject({ expected_version: 1, record: { type: 'Page', title: '첫 문단' } });
    expect(t.sent[1]!.body!.idempotency_key).toBe(`loupe:e:${id}:v1:save:r1`);
    expect(kbWrites().slice(before)).toEqual(['POST /v1/records 201 scope=editor', `PUT /v1/records/:id 200 scope=editor`]);
    void watch;
  });

  test('a response lost after the KB applied the save is resent under the same key and does not make a second version', async ({ page, watch }) => {
    const t = tap(page);
    let dropped = 0;
    await page.route(/\/kb-write\/records$/, async (route: Route) => {
      if (dropped++ === 0) { await route.fetch(); await route.abort('connectionreset'); } else await route.continue();
    });
    await openDoc(page);
    await page.keyboard.type('응답을 잃는 문서');
    await doc(page).getByTestId('memo-save').click();
    await expect(chip(page)).toContainText('끊김');
    await expect(chip(page)).toContainText('저장됨 v1');
    const posts = t.sent.filter((s) => s.path === '/kb-write/records');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body!.idempotency_key).toBe(posts[0]!.body!.idempotency_key);
    await expect.poll(() => t.got.filter((g) => g.path === '/kb-write/records').length).toBe(1);
    const id = t.got.find((g) => g.path === '/kb-write/records')!.json!.id as string;
    expect(t.got.find((g) => g.path === '/kb-write/records')).toMatchObject({ status: 201, json: { replayed: true, version: 1 } });
    const history = await kbGet(page, `/v1/nodes/${encodeURIComponent(id)}/history`);
    expect(history.status).toBe(200);
    expect(history.json!.data.versions, 'one version in the KB').toHaveLength(1);
    void watch;
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
test.describe('criterion 2: the drag handle reorders blocks and the Markdown keeps its structure', () => {
  test('dragging the handle of the first block under the last moves it; the Markdown is the same blocks in the new order and parses to the same structure', async ({ page, watch }) => {
    await openDoc(page);
    await page.keyboard.type('하나');
    await page.keyboard.press('Enter');
    await page.keyboard.type('둘');
    await page.keyboard.press('Enter');
    await page.keyboard.type('셋');
    expect(await blocks(page)).toEqual(['하나', '둘', '셋']);
    const paragraphs = editor(page).locator('p');
    await paragraphs.nth(0).hover();
    const handle = page.getByTestId('editor-drag-handle');
    await expect(handle).toBeVisible();
    const last = (await paragraphs.nth(2).boundingBox())!;
    await handle.dragTo(paragraphs.nth(2), { targetPosition: { x: 12, y: last.height - 2 } });
    await expect.poll(() => blocks(page)).toEqual(['둘', '셋', '하나']);
    await expect.poll(async () => (await source(page).textContent()) ?? '').toBe('둘\n\n셋\n\n하나');
    // The text the editor would save parses back to the same three blocks, in that order.
    const { createMarkdownCodec } = await import('../src/editor/index.ts');
    const codec = createMarkdownCodec({ doc: true });
    const again = codec.parse((await source(page).textContent()) ?? '');
    expect(again.content!.map((n) => [n.type, n.content?.[0]?.text])).toEqual([['paragraph', '둘'], ['paragraph', '셋'], ['paragraph', '하나']]);
    expect(codec.serialize(again)).toBe('둘\n\n셋\n\n하나');
    void watch;
  });

  test('Alt+ArrowUp and Alt+ArrowDown move the block under the cursor (the keyboard way to the same reorder)', async ({ page, watch }) => {
    await openDoc(page);
    await page.keyboard.type('가');
    await page.keyboard.press('Enter');
    await page.keyboard.type('나');
    await page.keyboard.press('Enter');
    await page.keyboard.type('다');
    await page.keyboard.press('Alt+ArrowUp');
    await page.keyboard.press('Alt+ArrowUp');
    expect(await blocks(page)).toEqual(['다', '가', '나']);
    await page.keyboard.press('Alt+ArrowDown');
    expect(await blocks(page)).toEqual(['가', '다', '나']);
    await expect.poll(async () => (await source(page).textContent()) ?? '').toBe('가\n\n다\n\n나');
    void watch;
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
test.describe('criterion 3: "[[" picks a link and the link opens in a window', () => {
  test('"[[" opens the picker, a pick becomes an inline link node with the id, the save keeps [[id]], a click opens the target in a window', async ({ page, watch }) => {
    const t = tap(page);
    await openDoc(page);
    await page.keyboard.type('참고 ');
    await page.keyboard.type('[[');
    const picker = page.getByRole('listbox', { name: '링크 고르기' });
    await expect(picker).toBeVisible();
    await page.keyboard.type('claude');
    const option = picker.locator('[data-testid=pick-option][data-id="e:product:claude-code"]');
    await expect(option).toBeVisible();
    await option.click();
    await expect(picker).toHaveCount(0);
    const link = editor(page).locator('.wiki-link[data-wiki-id="e:product:claude-code"]');
    await expect(link).toHaveCount(1);
    await expect(editor(page)).not.toContainText('[[');
    await expect.poll(async () => (await source(page).textContent()) ?? '').toBe('참고 [[e:product:claude-code]]');
    await doc(page).getByTestId('memo-save').click();
    await expect(chip(page)).toContainText('저장됨 v1');
    expect(t.sent[0]!.body!.record.body).toBe('참고 [[e:product:claude-code]]');
    // The window of the document stays, and the click opens the target in a window of its own.
    await link.click();
    await expect(page.locator('[data-testid=wm-window][data-id="e:product:claude-code"]')).toBeVisible();
    await expect(page.getByTestId('wm-window')).toHaveCount(2);
    void watch;
  });

  test('closing the picker with Escape leaves the words and no "[[" behind (every [[...]] of a saved body is a resolved id)', async ({ page, watch }) => {
    await openDoc(page);
    await page.keyboard.type('[[아무거나');
    await expect(page.getByRole('listbox', { name: '링크 고르기' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox', { name: '링크 고르기' })).toHaveCount(0);
    await expect.poll(async () => (await source(page).textContent()) ?? '').toBe('아무거나');
    await expect(editor(page).locator('.wiki-link')).toHaveCount(0);
    // Escape closed the picker only: the window is still there.
    await expect(doc(page)).toBeVisible();
    void watch;
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
test.describe('criterion 4: the claim quote block', () => {
  test('/주장 인용 picks a claim; the block shows the claim and its source, and saves as a line of its own [[c-…]]', async ({ page, watch }) => {
    const t = tap(page);
    await openDoc(page);
    await page.keyboard.type('/주장');
    await page.getByRole('listbox', { name: '블록 넣기' }).getByRole('option').first().click();
    const picker = page.getByRole('listbox', { name: '링크 고르기' });
    await expect(picker).toBeVisible();
    await page.keyboard.type('ultraplan');
    await picker.locator(`[data-testid=pick-option][data-id="${CLAIM}"]`).click();
    const quote = editor(page).locator('[data-testid=claim-quote]');
    await expect(quote).toHaveCount(1);
    await expect(quote).toHaveAttribute('data-claim-id', CLAIM);
    await expect(quote).toContainText('/ultraplan 명령은 2.1.222에서 제거됐다');
    await expect(quote.getByTestId('claim-quote-source')).toContainText('Claude Code 문서');
    await expect(quote.getByTestId('claim-quote-source')).toContainText('https://code.claude.com/docs/en/commands.md');
    await expect(quote).toHaveAttribute('contenteditable', 'false');
    // Text can follow the block.
    await page.keyboard.type('위 주장에 대한 내 생각');
    await doc(page).getByTestId('memo-save').click();
    await expect(chip(page)).toContainText('저장됨 v1');
    expect(t.sent[0]!.body!.record.body).toBe(`[[${CLAIM}]]\n\n위 주장에 대한 내 생각`);
    void watch;
  });

  test('paste cannot forge a claim quote or its source: HTML markup makes none, a pasted [[c-…]] line shows the KB\'s own source', async ({ page, watch }) => {
    await openDoc(page);
    await paste(page, { text: `[[${CLAIM}]]\n\n본문`, html: `<p>pasted</p><div data-type="claim-quote" data-claim-id="c-forged000000" class="claim-quote"><blockquote>FORGED STATEMENT</blockquote><p data-testid="claim-quote-source">FORGED SOURCE</p></div>` });
    // HTML wins on the clipboard: it is read by the schema, which has no rule for the quote, so no block and no fake claim id.
    await expect(editor(page).locator('[data-testid=claim-quote]')).toHaveCount(0);
    await expect(editor(page).locator('[data-claim-id="c-forged000000"]')).toHaveCount(0);
    await expect(editor(page).locator('[data-testid=claim-quote-source]')).toHaveCount(0);
    // A plain-text paste is Markdown: the line becomes a block whose text comes from the KB, not from the paste.
    await paste(page, { text: `\n\n[[${CLAIM_B}]]\n\n` });
    const quote = editor(page).locator('[data-testid=claim-quote]');
    await expect(quote).toHaveCount(1);
    await expect(quote).toContainText('/hooks 명령은 훅 설정을 연다');
    await expect(quote.getByTestId('claim-quote-source')).toContainText('Claude Code 문서');
    // The forged markup is ordinary text (a paragraph, a plain quotation): the one quote block is the pasted line's, and the forged words are not in it.
    const types = await editor(page).locator(':scope > *').evaluateAll((els) => els.map((e) => (e.matches('[data-testid=claim-quote]') || e.querySelector('[data-testid=claim-quote]') ? 'claim-quote' : e.tagName.toLowerCase())));
    expect(types.filter((x) => x === 'claim-quote')).toHaveLength(1);
    expect(types.every((x) => ['p', 'blockquote', 'claim-quote'].includes(x))).toBe(true);
    await expect(quote).not.toContainText('FORGED');
    await expect(editor(page)).toContainText('FORGED STATEMENT');
    const { disallowedTypes } = await import('../src/editor/safety.ts');
    const { createMarkdownCodec } = await import('../src/editor/index.ts');
    expect(disallowedTypes(createMarkdownCodec({ doc: true }).parse((await source(page).textContent()) ?? ''))).toEqual([]);
    void watch;
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
test.describe('criterion 5: version tabs, undo and the size chip', () => {
  test('an older version opens read-only, the current one keeps its editing history, "이 판으로 되돌리기" makes a new version', async ({ page, watch }) => {
    const t = tap(page);
    await openDoc(page);
    await expect(doc(page).getByRole('tablist', { name: '판' })).toHaveCount(0);
    await page.keyboard.type('첫 판 글');
    await doc(page).getByTestId('memo-save').click();
    await expect(chip(page)).toContainText('저장됨 v1');
    await page.waitForTimeout(700);
    await page.keyboard.type(' 둘째 판');
    await page.keyboard.press('Control+s');
    await expect(chip(page)).toContainText('저장됨 v2');
    await answered(t, 2);
    const tabs = doc(page).getByRole('tablist', { name: '판' });
    await expect(tabs.getByRole('tab')).toHaveCount(2);
    await expect(tabs.getByRole('tab', { name: /^현재/ })).toHaveAttribute('aria-selected', 'true');

    // An edit that is not saved yet, then a look at v1.
    await page.waitForTimeout(700);
    await page.keyboard.type(' 셋째 줄');
    await expect(chip(page)).toContainText('저장 안 됨');
    await tabs.getByRole('tab', { name: 'v1' }).click();
    await expect(tabs.getByRole('tab', { name: 'v1' })).toHaveAttribute('aria-selected', 'true');
    const readonly = doc(page).getByTestId('version-readonly');
    await expect(readonly).toBeVisible();
    await expect(readonly).toContainText('읽기 전용');
    const old = readonly.locator('[data-testid=editor-content]');
    await expect(old).toHaveAttribute('contenteditable', 'false');
    await expect(old).toHaveText('첫 판 글');
    // Nothing typed there lands in it, and the live editor is not on screen.
    await old.click();
    await page.keyboard.type('쓰기');
    await expect(old).toHaveText('첫 판 글');
    await expect(editor(page)).toBeHidden();
    await expect(doc(page).getByTestId('version-revert')).toBeDisabled();
    expect(kbWrites().length).toBeGreaterThan(0);

    // Back on the current tab the edit is there and Ctrl+Z undoes it: the history of this version was kept.
    await tabs.getByRole('tab', { name: /^현재/ }).click();
    await expect(editor(page)).toBeVisible();
    await expect(editor(page)).toContainText('첫 판 글 둘째 판 셋째 줄');
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Control+z');
    await expect(editor(page)).toHaveText('첫 판 글 둘째 판');
    await expect(chip(page)).toContainText('저장됨 v2');

    // Reverting to v1 is a new version (v3) with the v1 text.
    await tabs.getByRole('tab', { name: 'v1' }).click();
    await doc(page).getByTestId('version-revert').click();
    await expect(chip(page)).toContainText('저장됨 v3');
    await expect(tabs.getByRole('tab')).toHaveCount(3);
    await expect(tabs.getByRole('tab', { name: /^현재/ })).toHaveAttribute('aria-selected', 'true');
    await expect(editor(page)).toHaveText('첫 판 글');
    const last = t.sent[t.sent.length - 1]!;
    expect(last.body).toMatchObject({ expected_version: 2, record: { body: '첫 판 글' } });
    void watch;
  });

  test('4.4: the size chip follows the text, turns yellow at 48 KB, gives the warning at 64 KB, and a body of 1 MiB cannot be saved', async ({ page, watch }) => {
    const t = tap(page);
    await openDoc(page);
    const size = doc(page).getByTestId('editor-size');
    await page.keyboard.type('작은 문서');
    await expect(size).toHaveAttribute('data-level', 'ok');
    await expect(size).toHaveText(/^0\.0 KB$/);
    await expect.poll(async () => Number(await size.getAttribute('data-bytes'))).toBe(Buffer.byteLength('작은 문서'));
    const hangul = '가나다라마바사아자차';
    await paste(page, { text: hangul.repeat(1700) });
    await expect(size).toHaveAttribute('data-level', 'note');
    await expect(size).toContainText('KB');
    await expect(doc(page).getByText('이 크기를 넘으면 당분간 loupe에서 다시 열 수 없다. 나눠 쓰기를 권한다')).toHaveCount(0);
    await paste(page, { text: hangul.repeat(700) });
    await expect(size).toHaveAttribute('data-level', 'block');
    await expect(doc(page).getByText('이 크기를 넘으면 당분간 loupe에서 다시 열 수 없다. 나눠 쓰기를 권한다')).toBeVisible();
    // Under 1 MiB it still saves.
    await expect(doc(page).getByTestId('memo-save')).toBeEnabled();
    await paste(page, { text: hangul.repeat(34000) });
    await expect(size).toHaveAttribute('data-level', 'max', { timeout: 20_000 });
    await expect(chip(page)).toContainText('1 MiB');
    await expect(doc(page).getByTestId('memo-save')).toBeDisabled();
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(300);
    expect(t.sent, 'nothing is sent for a body over the limit').toHaveLength(0);
    void watch;
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
test.describe('criterion 6: the trash window', () => {
  test('a document archived from its window is listed in the trash window with status dead; restoring brings it back and the list updates', async ({ page, watch }) => {
    const t = tap(page);
    await openDoc(page);
    await page.keyboard.type('휴지통에 갈 문서');
    await doc(page).getByTestId('memo-save').click();
    await expect(chip(page)).toContainText('저장됨 v1');
    await answered(t, 1);
    const id = t.got[0]!.json!.id as string;
    await doc(page).getByTestId('doc-archive').click();
    await expect(page.getByTestId('wm-window')).toHaveCount(0);
    expect(lines().filter((l) => l.startsWith('POST /v1/records/:id/tombstone'))).toEqual(['POST /v1/records/:id/tombstone 200 scope=editor']);
    expect(t.sent.at(-1)).toMatchObject({ path: `/kb-write/records/${id}/tombstone`, body: { change: 'save', expected_version: 1 } });
    expect((await kbGet(page, `/v1/nodes/${encodeURIComponent(id)}`)).json!.data).toMatchObject({ status: 'dead' });

    await page.getByTestId('trash-open').click();
    const trash = page.getByTestId('trash-window');
    await expect(trash).toBeVisible();
    const row = trash.locator(`[data-testid=trash-row][data-id="${id}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('휴지통에 갈 문서');
    await expect(row).toContainText('문서');
    const listed = await kbGet(page, '/v1/nodes?origin=first_party&status=dead&types=Page,Note,TopicSpec,Review');
    expect(listed.json!.data.items.map((n: { id: string }) => n.id)).toContain(id);

    await row.getByTestId('trash-restore').click();
    await expect(row).toHaveCount(0);
    await expect(trash.getByTestId('trash-empty')).toBeVisible();
    const put = t.sent.at(-1)!;
    expect(put.path).toBe(`/kb-write/records/${id}`);
    expect(put.body).toMatchObject({ change: 'save', expected_version: 2, record: { type: 'Page', title: '휴지통에 갈 문서', body: '휴지통에 갈 문서', sensitivity: 'private' } });
    expect(lines().filter((l) => l.startsWith('PUT /v1/records/:id'))).toContain('PUT /v1/records/:id 200 scope=editor');
    const after = await kbGet(page, `/v1/nodes/${encodeURIComponent(id)}`);
    expect(after.json!.data).toMatchObject({ status: 'active', version: 3, body: '휴지통에 갈 문서' });
    const dead = await kbGet(page, '/v1/nodes?origin=first_party&status=dead&types=Page,Note,TopicSpec,Review');
    expect(dead.json!.data.items.map((n: { id: string }) => n.id)).not.toContain(id);

    // The restored document opens again, and its history shows the archive and the restore as versions.
    await page.goto(`${ORIGIN}/#/w/${encodeURIComponent(id)}`);
    await expect(page.getByTestId('wm-window')).toContainText('휴지통에 갈 문서');
    void watch;
  });

  test('an empty trash says so, and a record that is still active is not in it', async ({ page, watch }) => {
    await useSessions(page, sessions);
    await page.goto(`${ORIGIN}/#/`);
    await page.getByTestId('trash-open').click();
    const trash = page.getByTestId('trash-window');
    await expect(trash).toBeVisible();
    await expect(trash.getByTestId('trash-empty')).toBeVisible();
    await expect(trash.getByTestId('trash-row')).toHaveCount(0);
    void watch;
  });
});
