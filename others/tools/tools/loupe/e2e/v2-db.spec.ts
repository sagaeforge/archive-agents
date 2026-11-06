// loupe v2 M4, the database view (design v2 11.3 "M4 데이터베이스 표", 4.3, 5.2, 5.3, 5.5, 5.7): a ```loupe-view block of a document shows the first-party records of one
// type as a table, the table can be filtered, and a cell is edited in place. A cell edit is a new version of the whole record: a PUT whose `record.props` is the whole
// property object. It runs in the real app (headless Chromium, built SPA) against loupe serve and kb-mock with the write imitation and the M4 fixtures
// (KB_MOCK_WRITE=1, KB_MOCK_DB=1; dev/kb-mock/db.ts). The save path is the one of the memo window (src/memo/saver.ts) in a per-record form (src/db/rowSaver.ts).
//
// One server pair, stopped in afterAll: kb-mock 'db1' + loupe serve on PORT.authB (the document spec has stopped its own by then: specs run one after another).
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Locator, Page, Route } from '@playwright/test';
import { test, expect, useSessions } from './support/test.ts';
import { login, writeAuthConfig } from './support/oidc.ts';
import { accessLog, base, PORT, root, sock } from './support/ports.ts';
import { startMock, startServe, stop } from './support/procs.ts';
import { DB_DOC, DB_DOC_BODY } from '../dev/kb-mock/db.ts';
import { TASK_REGISTRY_KEY } from '../src/tasks/registry.ts';

const EDITOR_TOKEN = 'kbt_e_e2e-db-editor-token', REVIEWER_TOKEN = 'kbt_r_e2e-db-reviewer-token';
const FIXTURE = 'contract-sample/fixtures/kb.json';
const MOCK = 'db1';
const ORIGIN = base(PORT.authB);
const cfgDir = path.join(root, '.cache/auth/db');
const procs: (ChildProcess | undefined)[] = [];
const sessions: Record<string, string> = {};
// Built from pieces so no source line holds a string that looks like a live key.
const AWS = ['AK', 'IA', 'IOSFODNN7', 'EXAMPLE'].join('');

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  rmSync(cfgDir, { recursive: true, force: true });
  writeAuthConfig(cfgDir);
  for (const [name, token] of [['kb-editor.token', EDITOR_TOKEN], ['kb-reviewer.token', REVIEWER_TOKEN]] as const) { const f = path.join(cfgDir, name); writeFileSync(f, `${token}\n`); chmodSync(f, 0o600); }
  mkdirSync(path.dirname(accessLog(MOCK)), { recursive: true });
  rmSync(accessLog(MOCK), { force: true });
  procs.push(await startMock(MOCK, FIXTURE, { KB_MOCK_WRITE: '1', KB_MOCK_DB: '1', KB_MOCK_EDITOR_TOKEN: EDITOR_TOKEN, KB_MOCK_REVIEWER_TOKEN: REVIEWER_TOKEN }));
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
const kbPuts = () => lines().filter((l) => /^PUT \/v1\/records\/:id/.test(l));

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

/** A KB read as the app does it: the loupe session as Authorization. */
const kbGet = (page: Page, p: string) => page.evaluate(async (u) => {
  const r = await fetch(`/kb${u}`, { headers: { authorization: `Bearer ${sessionStorage.getItem('loupe.session')}` } });
  return { status: r.status, json: await r.json().catch(() => null) as Record<string, any> | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}, p);
const record = async (page: Page, id: string) => (await kbGet(page, `/v1/nodes/${encodeURIComponent(id)}`)).json!.data as { version: number; status: string; props: Record<string, unknown>; label: string };
/** Another writer saves the record: the same text with other props. */
const otherWrites = (page: Page, id: string, expected: number, title: string, props: Record<string, unknown>) => page.evaluate(async ({ i, expected, title, props }) => {
  const r = await fetch(`/kb-write/records/${i}`, { method: 'POST', headers: { authorization: `Bearer ${sessionStorage.getItem('loupe.session')}`, 'content-type': 'application/json', 'x-loupe-write': '1' },
    body: JSON.stringify({ idempotency_key: `loupe:e:other:${i}:v${expected}`, change: 'save', expected_version: expected, record: { type: 'Note', title, body: title, body_format: 'markdown', sensitivity: 'private', props, links: [] } }) });
  await r.text(); // read to the end, or the page's answer is never finished for the test's tap
  return r.status;
}, { i: id, expected, title, props });

const doc = (page: Page) => page.getByTestId('doc-window');
const views = (page: Page) => doc(page).getByTestId('db-view');
const noteView = (page: Page) => views(page).nth(0);
const pageView = (page: Page) => views(page).nth(1);
const row = (view: Locator, id: string) => view.locator(`[data-testid=db-row][data-id="${id}"]`);
const cell = (view: Locator, id: string, col: string) => row(view, id).locator(`[data-testid=db-cell][data-col=${col}]`);
const input = (view: Locator, id: string, col: string) => cell(view, id, col).getByTestId('db-input');
const ids = (view: Locator) => view.locator('[data-testid=db-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
const titles = (view: Locator) => view.locator('[data-testid=db-cell][data-col=title]').allTextContents();
/** Types into a cell and commits it with Enter. */
async function setCell(view: Locator, id: string, col: string, text: string) {
  const box = input(view, id, col);
  await box.fill(text);
  await box.press('Enter');
}
async function openDb(page: Page) {
  await useSessions(page, sessions);
  await page.goto(`${ORIGIN}/#/w/${encodeURIComponent(DB_DOC)}`);
  await expect(page.getByTestId('wm-window')).toBeVisible();
  await page.getByTestId('window-edit-toggle').click();
  await expect(doc(page)).toBeVisible();
  await expect(views(page)).toHaveCount(2);
  await expect(noteView(page).getByTestId('db-count')).toHaveAttribute('data-total', /^\d+$/);
}
const registry = (page: Page) => page.evaluate((k) => JSON.parse(sessionStorage.getItem(k) ?? 'null') as { rejected: { record: string; rule: string; at: string }[] } | null, TASK_REGISTRY_KEY);
/** Every place a typed value could be left: the page as HTML, the value of every field, the three stores, the title and the address. */
const everywhere = (page: Page, needle: string) => page.evaluate((n) => {
  const found: string[] = [];
  if (document.documentElement.outerHTML.includes(n)) found.push('html');
  for (const f of document.querySelectorAll('input,textarea')) if ((f as HTMLInputElement).value.includes(n)) found.push('field');
  for (const [name, store] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]] as const) for (let i = 0; i < store.length; i++) { const k = store.key(i)!; if (k.includes(n) || (store.getItem(k) ?? '').includes(n)) found.push(name); }
  if (document.title.includes(n) || location.href.includes(n)) found.push('title/url');
  return found;
}, needle);

// ---------------------------------------------------------------------------------------------------------------------------------
test.describe('units: the pieces of the database view', () => {
  test('4.3: the view definition is a JSON object in a loupe-view block; a wrong one is refused with a reason', async () => {
    const { parseView, viewSource, COLUMN_LABEL } = await import('../src/db/view.ts');
    const ok = parseView('{"type":"Note","columns":["title","tags","pinned","status"],"sort":"-recorded_at","filter":{"tag":"m4"}}');
    expect(ok).toMatchObject({ ok: true, def: { type: 'Note', columns: ['title', 'tags', 'pinned', 'status'], sort: { key: 'recorded_at', desc: true }, filter: { text: '', tag: 'm4' } } });
    // Without columns a type has its own: a memo has `tags` and `pinned`, a document `tags`, `order` and `icon` (design 2.1).
    expect(parseView('{"type":"Note"}')).toMatchObject({ ok: true, def: { columns: ['title', 'tags', 'pinned', 'status', 'version'] } });
    expect(parseView('{"type":"Page"}')).toMatchObject({ ok: true, def: { columns: ['title', 'tags', 'order', 'icon', 'status', 'version'] } });
    for (const bad of ['', 'not json', '[]', '{"type":"Topic"}', '{"type":"Note","columns":["nope"]}', '{"type":"Note","sort":"nope"}', '{"type":"Note","columns":[]}', '{"type":"Note","extra":1}']) {
      const r = parseView(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
    const again = parseView(viewSource('Page'));
    expect(again).toMatchObject({ ok: true, def: { type: 'Page' } });
    for (const c of ['title', 'type', 'status', 'version', 'recorded_at', 'tags', 'pinned', 'order', 'icon']) expect(COLUMN_LABEL[c as keyof typeof COLUMN_LABEL], c).toBeTruthy();
  });

  test('4.2/4.5: a loupe-view block is a block of its own in a document and stays the same bytes; the memo editor keeps reading it as a code block; the allow-list has it', async () => {
    const { createMarkdownCodec } = await import('../src/editor/index.ts');
    const { disallowedTypes } = await import('../src/editor/safety.ts');
    const docCodec = createMarkdownCodec({ doc: true });
    const parsed = docCodec.parse(DB_DOC_BODY);
    const kinds = parsed.content!.map((n) => n.type);
    expect(kinds.filter((k) => k === 'loupeView')).toHaveLength(2);
    expect(parsed.content!.find((n) => n.type === 'loupeView')!.attrs!.source).toBe('{"type":"Note","columns":["title","tags","pinned","status","version"],"sort":"title"}');
    expect(docCodec.serialize(parsed)).toBe(DB_DOC_BODY);
    expect(disallowedTypes(parsed)).toEqual([]);
    // A fence that is not exactly `loupe-view`, an indented one and a longer fence are what they were: code, or the same block.
    for (const md of ['```loupe-viewer\n{}\n```', '```js\nloupe-view\n```']) {
      expect(docCodec.parse(md).content!.some((n) => n.type === 'loupeView'), md).toBe(false);
      expect(docCodec.serialize(docCodec.parse(md)), md).toBe(md);
    }
    expect(docCodec.parse('    ```loupe-view\n    {}\n    ```').content!.some((n) => n.type === 'loupeView'), 'an indented fence is indented code').toBe(false);
    const long = '````loupe-view\n{"type":"Page"}\n````';
    expect(docCodec.parse(long).content![0]!.type).toBe('loupeView');
    expect(docCodec.serialize(docCodec.parse(long))).toBe(long);
    const memoCodec = createMarkdownCodec();
    expect(memoCodec.parse(DB_DOC_BODY).content!.filter((n) => n.type === 'codeBlock')).toHaveLength(2);
    expect(memoCodec.serialize(memoCodec.parse(DB_DOC_BODY))).toBe(DB_DOC_BODY);
  });

  test('4.3: a cell is read as the value of its column; a wrong one is refused; a new props object keeps every other key', async () => {
    const { parseCell, cellText, nextProps, filterRows, rowFrom } = await import('../src/db/rows.ts');
    expect(parseCell('tags', ' m4, beta ,, 한글 ')).toEqual({ ok: true, value: ['m4', 'beta', '한글'] });
    expect(parseCell('tags', '')).toEqual({ ok: true, value: [] });
    expect(parseCell('order', '5')).toEqual({ ok: true, value: 5 });
    expect(parseCell('order', '-2.5')).toEqual({ ok: true, value: -2.5 });
    expect(parseCell('order', 'abc')).toMatchObject({ ok: false });
    expect(parseCell('order', '')).toMatchObject({ ok: false });
    expect(parseCell('icon', ' 📘 ')).toEqual({ ok: true, value: '📘' });
    expect(parseCell('pinned', 'true')).toEqual({ ok: true, value: true });
    expect(cellText('tags', ['a', 'b'])).toBe('a, b');
    expect(cellText('tags', 'oops')).toBe('');
    expect(cellText('order', 3)).toBe('3');
    expect(cellText('icon', undefined)).toBe('');
    const props = { tags: ['a'], pinned: false, color: 'red' };
    const next = nextProps(props, { pinned: true });
    expect(next).toEqual({ tags: ['a'], pinned: true, color: 'red' });
    expect(next).not.toBe(props);
    expect(props.pinned).toBe(false);
    const rows = [
      { id: 'f-1', type: 'Note', label: '알파 메모', status: 'active', version: 1, recorded_at: '2026-01-01T00:00:00Z', sensitivity: 'private', props: { tags: ['m4', 'alpha'] } },
      { id: 'f-2', type: 'Note', label: '베타 메모', status: 'active', version: 1, recorded_at: '2026-01-02T00:00:00Z', sensitivity: 'private', props: { tags: ['m4'] } },
      { id: 'f-3', type: 'Note', label: 'Gamma', status: 'active', version: 1, recorded_at: '2026-01-03T00:00:00Z', sensitivity: 'private', props: {} },
    ].map(rowFrom);
    expect(filterRows(rows, { text: '', tag: '' })).toHaveLength(3);
    expect(filterRows(rows, { text: '알파', tag: '' }).map((r) => r.id)).toEqual(['f-1']);
    expect(filterRows(rows, { text: 'gamma', tag: '' }).map((r) => r.id)).toEqual(['f-3']);
    expect(filterRows(rows, { text: '', tag: 'M4' }).map((r) => r.id)).toEqual(['f-1', 'f-2']);
    expect(filterRows(rows, { text: '메모', tag: 'alpha' }).map((r) => r.id)).toEqual(['f-1']);
    expect(rowFrom({ id: 'f-9', type: 'Note', label: 'x', status: 'active', version: 1, props: null } as never).props).toEqual({});
  });

  /** The save machine of one record with scripted answers. */
  async function machine(answers: Array<{ t: 'ok'; status: number; body: Record<string, unknown> } | { t: 'problem'; status: number; code?: string; body: Record<string, unknown> } | { t: 'network'; why: 'network' }>, over: { precheck?: boolean } = {}) {
    const { RowSaver } = await import('../src/db/rowSaver.ts');
    const { memoPrecheck } = await import('../src/memo/rules.ts');
    const posts: { path: string; body: Record<string, any> }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const rejected: { record: string; rule: string }[] = [];
    const timers: (() => void)[] = [];
    let loads = 0;
    const saver = new RowSaver('f-x', {
      post: async (p, body) => { posts.push({ path: p, body: body as never }); const a = answers.shift(); if (!a) throw new Error('no scripted answer'); return a.t === 'problem' ? { retryAfterSec: undefined, code: undefined, ...a } : a; },
      readRef: async () => 'network', precheck: () => (over.precheck === false ? null : memoPrecheck()),
      load: async () => { loads++; return { type: 'Note', title: '메모', body: '메모', sensitivity: 'private', props: { tags: ['a'], pinned: false, color: 'red' }, version: 1 }; },
      now: () => new Date('2026-11-06T00:00:00Z'), setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => undefined,
      track: { write: () => undefined, unwrite: () => undefined, rejected: (e) => { rejected.push(e); }, unrejected: () => undefined },
    });
    return { saver, posts, rejected, timers, loads: () => loads };
  }

  test('5.2: a cell edit is one PUT of the whole record whose props are the whole object; the key and expected version follow the record\'s versions', async () => {
    const { saver, posts, loads } = await machine([{ t: 'ok', status: 200, body: { id: 'f-x', version: 2 } }, { t: 'ok', status: 200, body: { id: 'f-x', version: 3 } }]);
    await saver.edit(1, 'pinned', true);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe('/records/f-x');
    expect(posts[0]!.body).toMatchObject({ idempotency_key: 'loupe:e:f-x:v1:save:r1', change: 'save', expected_version: 1, record: { type: 'Note', title: '메모', body: '메모', body_format: 'markdown', sensitivity: 'private', links: [] } });
    expect(posts[0]!.body.record.props).toEqual({ tags: ['a'], pinned: true, color: 'red' });
    expect(saver.get()).toMatchObject({ state: 'idle', version: 2, props: { tags: ['a'], pinned: true, color: 'red' } });
    await saver.edit(2, 'tags', ['a', 'b']);
    expect(posts[1]!.body).toMatchObject({ idempotency_key: 'loupe:e:f-x:v2:save:r1', expected_version: 2 });
    expect(posts[1]!.body.record.props).toEqual({ tags: ['a', 'b'], pinned: true, color: 'red' });
    expect(loads(), 'the record is read once, then the saver knows it').toBe(1);
  });

  test('5.2: a lost answer is resent under the same key with the same bytes; a further edit on the same version takes the next r', async () => {
    const { saver, posts, timers } = await machine([{ t: 'network', why: 'network' }, { t: 'ok', status: 200, body: { id: 'f-x', version: 2, replayed: true } }]);
    await saver.edit(1, 'pinned', true);
    expect(saver.get().state).toBe('offline');
    expect(timers).toHaveLength(1);
    timers[0]!();
    await expect.poll(() => saver.get().state).toBe('idle');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual(posts[0]!.body);
    const later = await machine([{ t: 'network', why: 'network' }, { t: 'network', why: 'network' }, { t: 'ok', status: 200, body: { id: 'f-x', version: 2 } }]);
    await later.saver.edit(1, 'pinned', true);
    await later.saver.edit(1, 'tags', ['z']);
    expect(later.posts.map((p) => p.body.idempotency_key)).toEqual(['loupe:e:f-x:v1:save:r1', 'loupe:e:f-x:v1:save:r2']);
    expect(later.posts[1]!.body.record.props).toEqual({ tags: ['z'], pinned: true, color: 'red' });
  });

  test('5.2: a 409 whose current is my own earlier save is not a conflict: the edit goes on top of it', async () => {
    const { payloadSha } = await import('../src/memo/ids.ts');
    const mine = await payloadSha({ type: 'Note', title: '메모', body: '메모', body_format: 'markdown', sensitivity: 'private', props: { tags: ['a'], pinned: true, color: 'red' }, links: [] });
    const { saver, posts } = await machine([
      { t: 'network', why: 'network' },
      { t: 'problem', status: 409, code: 'version_conflict', body: { code: 'version_conflict', current: { version: 2, status: 'active', payload_sha: mine, props: { tags: ['a'], pinned: true, color: 'red' }, title: '메모', body: '메모' } } },
      { t: 'ok', status: 200, body: { id: 'f-x', version: 3 } },
    ]);
    await saver.edit(1, 'pinned', true);
    expect(saver.get().state).toBe('offline');
    await saver.edit(1, 'tags', ['z']);
    expect(saver.get()).toMatchObject({ state: 'idle', conflict: null, version: 3 });
    expect(posts.at(-1)!.body).toMatchObject({ expected_version: 2 });
    expect(posts.at(-1)!.body.record.props).toEqual({ tags: ['z'], pinned: true, color: 'red' });
  });

  test('5.5/5.7: a value the pre-check matches is not sent; "일반으로 보내기" sends it; the KB\'s 422 drops the value from the saver and leaves the rule id and the record only', async () => {
    const { saver, posts, rejected } = await machine([{ t: 'problem', status: 422, code: 'secret_detected', body: { code: 'secret_detected', stored: false, hits: [{ field: 'record.props[2].value', rule: 'aws-access-token', start: 0, end: 20, start_u16: 0, end_u16: 20 }] } }]);
    await saver.edit(1, 'icon', AWS);
    expect(posts).toHaveLength(0);
    expect(saver.get()).toMatchObject({ state: 'blocked' });
    expect(saver.get().hits.map((h) => h.rule)).toEqual(['aws-access-token']);
    await saver.edit(1, 'icon', AWS, { anyway: true });
    expect(posts).toHaveLength(1);
    expect(saver.get()).toMatchObject({ state: 'rejected' });
    expect(rejected).toEqual([{ record: 'f-x', rule: 'aws-access-token', at: '2026-11-06T00:00:00.000Z' }]);
    expect(JSON.stringify(saver.get()), 'the snapshot never holds the value').not.toContain(AWS);
    expect(saver.get().props, 'what the KB has is what the table shows').toEqual({ tags: ['a'], pinned: false, color: 'red' });
  });

  test('5.3: a 409 that is not mine raises a conflict and sends nothing more; "저쪽 것" takes the other side; "내 것" puts only my cell on top of the other side', async () => {
    const current = { version: 2, status: 'active', payload_sha: 'f'.repeat(64), actor: 'app:loupe', props: { tags: ['their'], pinned: false, color: 'blue' }, title: '저쪽 제목', body: '저쪽 본문' };
    const conflict = { t: 'problem' as const, status: 409, code: 'version_conflict', body: { code: 'version_conflict', current } };
    const a = await machine([conflict]);
    await a.saver.edit(1, 'pinned', true);
    expect(a.saver.get()).toMatchObject({ state: 'conflict', conflict: { current: { version: 2, props: { tags: ['their'] } }, mine: { pinned: true } } });
    expect(a.posts).toHaveLength(1);
    a.saver.takeTheirs();
    expect(a.saver.get()).toMatchObject({ state: 'idle', conflict: null, version: 2, props: { tags: ['their'], pinned: false, color: 'blue' } });
    expect(a.posts).toHaveLength(1);

    const b = await machine([conflict, { t: 'ok', status: 200, body: { id: 'f-x', version: 3 } }]);
    await b.saver.edit(1, 'pinned', true);
    await b.saver.keepMine();
    expect(b.posts).toHaveLength(2);
    expect(b.posts[1]!.body).toMatchObject({ expected_version: 2, idempotency_key: 'loupe:e:f-x:v2:save:r1', record: { title: '저쪽 제목', body: '저쪽 본문' } });
    expect(b.posts[1]!.body.record.props).toEqual({ tags: ['their'], pinned: true, color: 'blue' });
    expect(b.saver.get()).toMatchObject({ state: 'idle', version: 3 });

    const dead = await machine([{ t: 'problem', status: 409, code: 'version_conflict', body: { code: 'version_conflict', current: { version: 2, status: 'dead' } } }]);
    await dead.saver.edit(1, 'pinned', true);
    expect(dead.saver.get()).toMatchObject({ state: 'conflict', conflict: { current: { status: 'dead' } } });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
test.describe('M4 the database view in the real app', () => {
  test('1. a loupe-view block shows the records of its type as a table with the columns of its definition; a record that is not active is not shown', async ({ page, watch }) => {
    await openDb(page);
    const view = noteView(page);
    await expect(view).toHaveAttribute('data-type', 'Note');
    await expect(view.locator('th')).toHaveText(['제목', '태그', '고정', '상태', '판']);
    await expect(view.getByTestId('db-row')).toHaveCount(4);
    expect(new Set(await ids(view))).toEqual(new Set(['f-m4-n1', 'f-m4-n2', 'f-m4-n3', 'f-m4-n4']));
    // The sort of the definition (`title`).
    const shown = await titles(view);
    expect(shown).toEqual([...shown].sort((a, b) => a.localeCompare(b, 'ko')));
    await expect(cell(view, 'f-m4-n1', 'title')).toHaveText('알파 메모');
    await expect(input(view, 'f-m4-n1', 'tags')).toHaveValue('m4, alpha');
    await expect(input(view, 'f-m4-n1', 'pinned')).toBeChecked();
    await expect(input(view, 'f-m4-n2', 'pinned')).not.toBeChecked();
    await expect(cell(view, 'f-m4-n2', 'status')).toHaveText('활성');
    await expect(cell(view, 'f-m4-n2', 'version')).toHaveText('1');
    await expect(row(view, 'f-m4-n5'), 'a dead record is not here').toHaveCount(0);
    await expect(view.getByTestId('db-count')).toHaveAttribute('data-shown', '4');
    await expect(view.getByTestId('db-count')).toHaveAttribute('data-total', '4');
    // The title is text, whatever it says: the hostile one did not become markup.
    await expect(cell(view, 'f-m4-n4', 'title')).toHaveText('<img src=x onerror=alert(1)> 위험한 제목');
    await expect(view.locator('img')).toHaveCount(0);
    // The second block is the document view: other type, other columns.
    const second = pageView(page);
    await expect(second).toHaveAttribute('data-type', 'Page');
    await expect(second.locator('th')).toHaveText(['제목', '태그', '순서', '아이콘']);
    expect(new Set(await ids(second))).toEqual(new Set([DB_DOC, 'f-m4-p1', 'f-m4-p2']));
    // The request asks for the active ones of that type, first-party only.
    const reads = watch.kbPaths().filter((p) => p.startsWith('/v1/nodes?') && p.includes('types=Note'));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((p) => p.includes('origin=first_party') && p.includes('status=active'))).toBe(true);
    // The document itself is in its own table and is not edited from there.
    await expect(input(second, DB_DOC, 'icon')).toBeDisabled();
    await expect(input(second, 'f-m4-p1', 'icon')).toBeEnabled();
  });

  test('2. filters narrow the rows and "필터 지우기" restores them; the state stays while the window is open and is gone with it; the status filter shows the dead ones read-only', async ({ page, watch }) => {
    await openDb(page);
    const view = noteView(page), other = pageView(page);
    const count = view.getByTestId('db-count');
    await view.getByTestId('db-filter-text').fill('알파');
    await expect(view.getByTestId('db-row')).toHaveCount(1);
    await expect(count).toHaveAttribute('data-shown', '1');
    await expect(count).toHaveAttribute('data-total', '4');
    expect(await ids(view)).toEqual(['f-m4-n1']);
    await view.getByTestId('db-filter-text').fill('');
    await view.getByTestId('db-filter-tag').fill('M4');
    expect(new Set(await ids(view))).toEqual(new Set(['f-m4-n1', 'f-m4-n2']));
    await view.getByTestId('db-filter-text').fill('베타');
    expect(await ids(view)).toEqual(['f-m4-n2']);
    await view.getByTestId('db-filter-text').fill('없는 이름');
    await expect(view.getByTestId('db-row')).toHaveCount(0);
    await expect(view.getByTestId('db-empty')).toBeVisible();
    await view.getByTestId('db-filter-clear').click();
    await expect(view.getByTestId('db-row')).toHaveCount(4);
    await expect(view.getByTestId('db-filter-text')).toHaveValue('');
    await expect(view.getByTestId('db-filter-tag')).toHaveValue('');
    // The filter is local to the view: the other table never moved.
    await view.getByTestId('db-filter-text').fill('감마');
    await expect(view.getByTestId('db-row')).toHaveCount(1);
    await expect(other.getByTestId('db-row')).toHaveCount(3);

    // It stays while the window stays open: reading and editing again builds the editor again, and the view finds its filter.
    await page.getByTestId('window-edit-toggle').click();
    await expect(views(page)).toHaveCount(0);
    await page.getByTestId('window-edit-toggle').click();
    await expect(views(page)).toHaveCount(2);
    await expect(noteView(page).getByTestId('db-filter-text')).toHaveValue('감마');
    await expect(noteView(page).getByTestId('db-row')).toHaveCount(1);
    await expect(pageView(page).getByTestId('db-filter-text')).toHaveValue('');

    // The status filter: the dead records, and they are not edited.
    await noteView(page).getByTestId('db-filter-clear').click();
    await noteView(page).getByTestId('db-filter-status').selectOption('dead');
    await expect(noteView(page).getByTestId('db-row')).toHaveCount(1);
    await expect(cell(noteView(page), 'f-m4-n5', 'title')).toHaveText('보관된 메모');
    await expect(cell(noteView(page), 'f-m4-n5', 'status')).toHaveText('보관됨');
    await expect(input(noteView(page), 'f-m4-n5', 'tags')).toBeDisabled();
    expect(watch.kbPaths().some((p) => p.startsWith('/v1/nodes?') && p.includes('types=Note') && p.includes('status=dead'))).toBe(true);
    await noteView(page).getByTestId('db-filter-clear').click();
    await expect(noteView(page).getByTestId('db-filter-status')).toHaveValue('active');
    await expect(noteView(page).getByTestId('db-row')).toHaveCount(4);

    // Closing the window drops the state: the next window starts with no filter.
    await noteView(page).getByTestId('db-filter-text').fill('베타');
    await page.getByRole('button', { name: '닫기' }).click();
    await expect(page.getByTestId('wm-window')).toHaveCount(0);
    await page.goto(`${ORIGIN}/#/`);
    await page.goto(`${ORIGIN}/#/w/${encodeURIComponent(DB_DOC)}`);
    await page.getByTestId('window-edit-toggle').click();
    await expect(views(page)).toHaveCount(2);
    await expect(noteView(page).getByTestId('db-filter-text')).toHaveValue('');
  });

  test('3. a cell edit sends one PUT whose record.props is the whole object, and the KB record is exactly what was sent; the next edit builds on the version it brought', async ({ page, watch }) => {
    await openDb(page);
    const t = tap(page);
    const view = noteView(page);
    const before = await record(page, 'f-m4-n2');
    expect(before.props).toEqual({ tags: ['m4'], pinned: false });
    await setCell(view, 'f-m4-n2', 'tags', 'm4, beta');
    await expect(cell(view, 'f-m4-n2', 'version')).toHaveText('2');
    await answered(t, 1);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ method: 'POST', path: '/kb-write/records/f-m4-n2' });
    expect(t.sent[0]!.body).toMatchObject({ idempotency_key: 'loupe:e:f-m4-n2:v1:save:r1', change: 'save', expected_version: 1, record: { type: 'Note', title: '베타 메모', body: '베타 메모', body_format: 'markdown', sensitivity: 'private' } });
    expect(Object.keys(t.sent[0]!.body!.record.props).sort()).toEqual(['pinned', 'tags']);
    expect(t.sent[0]!.body!.record.props).toEqual({ tags: ['m4', 'beta'], pinned: false });
    expect(t.got[0]).toMatchObject({ status: 200, json: { id: 'f-m4-n2', version: 2 } });
    const after = await record(page, 'f-m4-n2');
    expect(after.version).toBe(2);
    expect(after.props, 'the KB has exactly the props that were sent').toEqual(t.sent[0]!.body!.record.props);
    expect(kbPuts().filter((l) => l.includes(' 200'))).toHaveLength(1);

    // A property the view does not show goes along in the whole object, and a checkbox is one edit as well.
    await input(view, 'f-m4-n3', 'pinned').check();
    await expect(cell(view, 'f-m4-n3', 'version')).toHaveText('2');
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]!.body!.record.props).toEqual({ tags: ['other'], pinned: true, color: 'red' });
    expect((await record(page, 'f-m4-n3')).props).toEqual({ tags: ['other'], pinned: true, color: 'red' });

    // The second edit of a row is on the version the first brought, under its own key.
    await setCell(view, 'f-m4-n2', 'tags', 'beta');
    await expect(cell(view, 'f-m4-n2', 'version')).toHaveText('3');
    expect(t.sent[2]!.body).toMatchObject({ idempotency_key: 'loupe:e:f-m4-n2:v2:save:r1', expected_version: 2 });
    expect(t.sent[2]!.body!.record.props).toEqual({ tags: ['beta'], pinned: false });
    expect((await record(page, 'f-m4-n2')).props).toEqual({ tags: ['beta'], pinned: false });

    // The other table: a number, and an icon with a Korean word; a value that is not a number is not sent.
    const answers = t.got.length;
    await setCell(pageView(page), 'f-m4-p2', 'order', '7');
    await expect.poll(() => t.got.length).toBe(answers + 1);
    expect(t.sent.at(-1)!.body!.record.props).toEqual({ tags: ['m4'], order: 7, icon: '📎' });
    expect((await record(page, 'f-m4-p2')).props).toEqual({ tags: ['m4'], order: 7, icon: '📎' });
    const n = t.sent.length;
    await setCell(pageView(page), 'f-m4-p2', 'order', '일곱');
    await expect(input(pageView(page), 'f-m4-p2', 'order')).toHaveAttribute('aria-invalid', 'true');
    await page.waitForTimeout(300);
    expect(t.sent, 'nothing is sent for a value the column cannot hold').toHaveLength(n);
    await input(pageView(page), 'f-m4-p2', 'order').press('Escape');
    await expect(input(pageView(page), 'f-m4-p2', 'order')).toHaveValue('7');
    await expect(doc(page).getByTestId('memo-chip'), 'the document itself was not touched').not.toContainText('저장 안 됨');
    void watch;
  });

  test('4. the same save path: a lost answer is resent under the same key and the KB replays it; a value the pre-check matches waits for "일반으로 보내기"; the KB\'s 422 leaves no trace of the value', async ({ page, watch }) => {
    await openDb(page);
    const t = tap(page);
    const view = noteView(page), docs = pageView(page);

    // A response lost after the KB applied the save.
    let dropped = 0;
    await page.route(/\/kb-write\/records\/f-m4-n1$/, async (route: Route) => {
      if (dropped++ === 0) { await route.fetch(); await route.abort('connectionreset'); } else await route.continue();
    });
    await input(view, 'f-m4-n1', 'pinned').uncheck();
    await expect(row(view, 'f-m4-n1')).toHaveAttribute('data-state', 'offline');
    await expect(row(view, 'f-m4-n1')).toHaveAttribute('data-state', 'idle');
    await expect(cell(view, 'f-m4-n1', 'version')).toHaveText('2');
    const posts = t.sent.filter((s) => s.path === '/kb-write/records/f-m4-n1');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body!.idempotency_key).toBe(posts[0]!.body!.idempotency_key);
    expect(posts[1]!.raw).toBe(posts[0]!.raw);
    await expect.poll(() => t.got.filter((g) => g.path === '/kb-write/records/f-m4-n1').length).toBe(1);
    expect(t.got.find((g) => g.path === '/kb-write/records/f-m4-n1')).toMatchObject({ status: 200, json: { replayed: true, version: 2 } });
    expect((await record(page, 'f-m4-n1')).version, 'one write in the KB, not two').toBe(2);
    await page.unroute(/\/kb-write\/records\/f-m4-n1$/);

    // The pre-check: a value that looks like a key is not sent.
    const sentBefore = t.sent.length;
    await setCell(docs, 'f-m4-p1', 'icon', AWS);
    const band = doc(page).getByTestId('db-secret');
    await expect(band).toBeVisible();
    await expect(band).toHaveAttribute('data-source', 'precheck');
    await expect(band).toContainText('aws-access-token');
    await expect(band).not.toContainText(AWS);
    await page.waitForTimeout(300);
    expect(t.sent, 'nothing left while the pre-check matches').toHaveLength(sentBefore);
    expect(lines().filter((l) => l.startsWith('PUT /v1/records/:id') && l.includes(' 422'))).toHaveLength(0);

    // "일반으로 보내기": one PUT, and the KB's own scan refuses it (422).
    await band.getByTestId('db-send-anyway').click();
    await expect(doc(page).getByTestId('db-secret')).toHaveAttribute('data-source', 'kb');
    // (the answer lost in the first part never reached the page: one answer for it, one for this)
    await answered(t, 2);
    expect(t.sent).toHaveLength(sentBefore + 1);
    const refused = t.got.at(-1)!;
    expect(refused).toMatchObject({ path: '/kb-write/records/f-m4-p1', status: 422, json: { code: 'secret_detected', stored: false } });
    await expect(doc(page).getByTestId('db-secret')).toContainText('aws-access-token');
    // The value is not drawn again: the cell is what the KB has, and the value is in no field, no store, no band.
    await expect(input(docs, 'f-m4-p1', 'icon')).toHaveValue('📘');
    expect(await everywhere(page, AWS), 'nothing of the value is left').toEqual([]);
    expect((await registry(page))!.rejected).toEqual([expect.objectContaining({ record: 'f-m4-p1', rule: 'aws-access-token' })]);
    const saved = await record(page, 'f-m4-p1');
    expect(saved).toMatchObject({ version: 1, props: { tags: [], order: 1, icon: '📘' } });
    await page.waitForTimeout(500);
    expect(t.sent, 'no resend after the refusal').toHaveLength(sentBefore + 1);
    // The band goes away with "닫기" and the row can be edited again.
    await doc(page).getByTestId('db-secret').getByTestId('db-dismiss').click();
    await expect(doc(page).getByTestId('db-secret')).toHaveCount(0);
    await setCell(docs, 'f-m4-p1', 'icon', '📗');
    await expect(cell(docs, 'f-m4-p1', 'icon')).toBeVisible();
    await expect.poll(async () => (await record(page, 'f-m4-p1')).props.icon).toBe('📗');
    void watch;
  });

  test('5. a 409 on a cell edit raises the conflict band and overwrites nothing; "저쪽 것 가져오기" shows the other side; "내 것으로 덮어쓰기" puts my cell on top of it as a new version', async ({ page, watch }) => {
    await openDb(page);
    const t = tap(page);
    const view = noteView(page);
    // Another writer: v2 of f-m4-n1, with other tags.
    const v = (await record(page, 'f-m4-n1')).version;
    expect(await otherWrites(page, 'f-m4-n1', v, '알파 메모', { tags: ['from-other'], pinned: true })).toBe(200);
    expect(t.sent).toHaveLength(1);
    const theirs = await record(page, 'f-m4-n1');
    expect(theirs.props).toEqual({ tags: ['from-other'], pinned: true });

    await setCell(view, 'f-m4-n1', 'tags', 'm4, mine');
    const band = doc(page).getByTestId('db-conflict');
    await expect(band).toBeVisible();
    await expect(row(view, 'f-m4-n1')).toHaveAttribute('data-state', 'conflict');
    await expect(band).toContainText(`v${theirs.version}`);
    await expect(band).toContainText('from-other');
    await expect(band).toContainText('m4, mine');
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]!.body).toMatchObject({ expected_version: v });
    await answered(t, 2);
    expect(t.got[1]).toMatchObject({ status: 409, json: { code: 'version_conflict' } });
    // Nothing was overwritten, and nothing is sent by itself.
    await page.waitForTimeout(500);
    expect(t.sent).toHaveLength(2);
    expect(await record(page, 'f-m4-n1')).toMatchObject({ version: theirs.version, props: { tags: ['from-other'], pinned: true } });

    // The other side: the row shows what the KB has and nothing is written.
    await band.getByTestId('db-take-theirs').click();
    await expect(doc(page).getByTestId('db-conflict')).toHaveCount(0);
    await expect(input(view, 'f-m4-n1', 'tags')).toHaveValue('from-other');
    await expect(cell(view, 'f-m4-n1', 'version')).toHaveText(String(theirs.version));
    expect(t.sent).toHaveLength(2);

    // A second conflict, and this time my cell goes on top of the other side's version.
    const w = await record(page, 'f-m4-n2');
    expect(await otherWrites(page, 'f-m4-n2', w.version, '베타 메모', { tags: ['their-tag'], pinned: true, color: 'green' })).toBe(200);
    const mark = t.sent.length;
    await setCell(view, 'f-m4-n2', 'tags', 'mine-tag');
    await expect(doc(page).getByTestId('db-conflict')).toBeVisible();
    await doc(page).getByTestId('db-keep-mine').click();
    await expect(doc(page).getByTestId('db-conflict')).toHaveCount(0);
    const last = t.sent.at(-1)!;
    expect(t.sent.length).toBe(mark + 2);
    expect(last.body).toMatchObject({ expected_version: w.version + 1 });
    expect(last.body!.idempotency_key).toBe(`loupe:e:f-m4-n2:v${w.version + 1}:save:r1`);
    expect(last.body!.record.props, 'their other keys stay, only my cell changes').toEqual({ tags: ['mine-tag'], pinned: true, color: 'green' });
    expect(await record(page, 'f-m4-n2')).toMatchObject({ version: w.version + 2, props: { tags: ['mine-tag'], pinned: true, color: 'green' } });
    void watch;
  });

  test('4.3: the slash list has "데이터베이스"; it puts a view block into a new document, and the body keeps the fence', async ({ page, watch }) => {
    await useSessions(page, sessions);
    await page.goto(`${ORIGIN}/#/`);
    await page.getByTestId('doc-new').click();
    await expect(doc(page)).toBeVisible();
    const editor = doc(page).locator('.memo-body [data-testid=editor-content]');
    await editor.click();
    await page.keyboard.type('/데이터');
    const option = page.locator('[data-testid=slash-option][data-command=database]');
    await expect(option).toBeVisible();
    await option.click();
    await expect(views(page)).toHaveCount(1);
    await expect(views(page).first().getByTestId('db-row')).not.toHaveCount(0);
    await expect(doc(page).getByTestId('editor-source')).toContainText('```loupe-view');
    await expect(doc(page).getByTestId('editor-source')).toContainText('"type":"Note"');
    void watch;
  });
});
