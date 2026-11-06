// loupe v2 M1, the UI half (design v2 11.2 "M1 메모 쓰기", 2.5, 2.7, 4.2, 5.2, 5.3, 5.5, 5.7, 5.9): a memo is written, checked, saved and followed in the real app
// (headless Chromium, built SPA), against loupe serve and kb-mock with the write imitation (KB_MOCK_WRITE=1). The server half is e2e/v2-security.spec.ts.
//
// Servers (stopped in afterAll): A = kb-mock 'm1' + loupe serve on PORT.authB; B = kb-mock 'm2' (private_open false) + loupe serve on PORT.auth.
// Both read their KB tokens from a config directory of their own.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Page, Route } from '@playwright/test';
import { test, expect, useSessions } from './support/test.ts';
import { login, writeAuthConfig } from './support/oidc.ts';
import { accessLog, base, PORT, RESEARCH, root, sock } from './support/ports.ts';
import { startMock, startServe, stop } from './support/procs.ts';
import { mockRules } from '../dev/kb-mock/write.ts';
import { rulesSha } from '../server/precheck.ts';
import { TASK_REGISTRY_KEY } from '../src/tasks/registry.ts';

const EDITOR_TOKEN = 'kbt_e_e2e-editor-token', REVIEWER_TOKEN = 'kbt_r_e2e-reviewer-token';
const FIXTURE = 'contract-sample/fixtures/kb.json';
type Server = { mock: string; port: number; origin: string };
const A: Server = { mock: 'm1', port: PORT.authB, origin: base(PORT.authB) };
const B: Server = { mock: 'm2', port: PORT.auth, origin: base(PORT.auth) };
const cfgDir = path.join(root, '.cache/auth/memo');
// Built from pieces so no source line holds a string that looks like a live key.
const AWS = ['AK', 'IA', 'IOSFODNN7', 'EXAMPLE'].join('');
const procs: (ChildProcess | undefined)[] = [];
// One login per server: loupe serve rate-limits login starts.
const sessions: Record<string, string> = {};

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  rmSync(cfgDir, { recursive: true, force: true });
  writeAuthConfig(cfgDir);
  for (const [name, token] of [['kb-editor.token', EDITOR_TOKEN], ['kb-reviewer.token', REVIEWER_TOKEN]] as const) { const f = path.join(cfgDir, name); writeFileSync(f, `${token}\n`); chmodSync(f, 0o600); }
  mkdirSync(path.dirname(accessLog(A.mock)), { recursive: true });
  for (const n of [A.mock, B.mock]) rmSync(accessLog(n), { force: true });
  const env = { KB_MOCK_WRITE: '1', KB_MOCK_EDITOR_TOKEN: EDITOR_TOKEN, KB_MOCK_REVIEWER_TOKEN: REVIEWER_TOKEN };
  procs.push(await startMock(A.mock, FIXTURE, env), await startMock(B.mock, FIXTURE, { ...env, KB_MOCK_PRIVATE_OPEN: '0' }));
  procs.push(await startServe(A.mock, A.port, { LOUPE_CONFIG_DIR: cfgDir }), await startServe(B.mock, B.port, { LOUPE_CONFIG_DIR: cfgDir }));
  for (const o of [A, B]) sessions[o.origin] = await login(o.origin);
});
test.afterAll(async () => {
  await Promise.all(procs.map(stop));
  for (const n of [A.mock, B.mock]) rmSync(sock(n), { force: true });
  rmSync(cfgDir, { recursive: true, force: true });
});

/** What the KB saw, one line per request: `METHOD route status[ scope=…]`. */
const lines = (mock: string) => (existsSync(accessLog(mock)) ? readFileSync(accessLog(mock), 'utf8').split('\n').filter(Boolean) : []);
const kbWrites = (mock: string) => lines(mock).filter((l) => /^(POST|PUT) \/v1\/records/.test(l));

type Sent = { method: string; path: string; body: Record<string, any> | null; raw: string | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Got = { path: string; status: number; json: Record<string, any> | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
/** Every /kb-write/ request and answer of the page, and every search request. */
function tap(page: Page) {
  const sent: Sent[] = [], got: Got[] = [], search: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/kb-write/')) { let body = null; try { body = JSON.parse(r.postData() ?? 'null'); } catch { /* not JSON */ } sent.push({ method: r.method(), path: u.pathname, body, raw: r.postData() }); }
    if (u.pathname === '/kb/v1/search') search.push(u.pathname + u.search);
  });
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/kb-write/')) void r.json().then((json) => got.push({ path: u.pathname, status: r.status(), json }), () => got.push({ path: u.pathname, status: r.status(), json: null }));
  });
  return { sent, got, search };
}

/** tap() fills `got` after r.json() settles, which can come after the window shows the answer. Wait for n answers before reading them. */
const answered = (t: ReturnType<typeof tap>, n: number) => expect.poll(() => t.got.length, { message: `${n} /kb-write/ answers read` }).toBeGreaterThanOrEqual(n);

const memo = (page: Page) => page.getByTestId('memo-window');
const editor = (page: Page) => memo(page).locator('[data-testid=editor-content]');
const chip = (page: Page) => memo(page).getByTestId('memo-chip');
async function open(page: Page, o = A) {
  await useSessions(page, sessions);
  await page.goto(`${o.origin}/#/`);
  await page.getByTestId('memo-new').click();
  await expect(memo(page)).toBeVisible();
}
async function openWithEditor(page: Page, o = A) {
  await open(page, o);
  await expect(editor(page)).toBeVisible();
  await editor(page).click();
}
const registry = (page: Page) => page.evaluate((k) => JSON.parse(sessionStorage.getItem(k) ?? 'null') as { writes: string[]; rejected: { record: string; rule: string; at: string }[] } | null, TASK_REGISTRY_KEY);
const whole = (page: Page) => page.evaluate(() => document.documentElement.outerHTML);
async function everywhere(page: Page, needle: string) {
  return page.evaluate(async (n) => {
    const out: string[] = [];
    if (document.documentElement.outerHTML.includes(n)) out.push('dom');
    if (document.title.includes(n)) out.push('title');
    if (decodeURIComponent(location.href).includes(n)) out.push('url');
    for (const [name, s] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]] as const) for (let i = 0; i < s.length; i++) { const k = s.key(i)!; if (k.includes(n) || (s.getItem(k) ?? '').includes(n)) out.push(name); }
    const dbs = await (indexedDB.databases?.() ?? Promise.resolve([]));
    for (const d of dbs) if (d.name?.includes(n)) out.push('indexedDB');
    return out;
  }, needle);
}
/** The task center, opened, as a list of [kind, state]. */
async function taskItems(page: Page) {
  if (!(await page.getByTestId('task-list').isVisible())) await page.getByTestId('task-pill').click();
  await expect(page.getByTestId('task-list')).toBeVisible();
  return page.getByTestId('task-item').evaluateAll((els) => els.map((e) => ({ kind: e.getAttribute('data-kind'), state: e.getAttribute('data-state'), tone: e.getAttribute('data-tone'), text: e.textContent ?? '' })));
}

// ---------------------------------------------------------------------------------------------------------------------------------
test.describe('title rule and rule fixture', () => {
  test('2.5: the first line is the title, trimmed of Markdown marks, cut at 60 graphemes; an empty first line gets the time', async () => {
    const { titleOf } = await import('../src/memo/title.ts');
    expect(titleOf('# 회의 메모\n본문', new Date())).toBe('회의 메모');
    expect(titleOf('- 할 일\n둘째', new Date())).toBe('할 일');
    expect(titleOf('> 인용\n', new Date())).toBe('인용');
    expect(titleOf('\\[mock:spool] 느린 저장\n본문', new Date())).toBe('[mock:spool] 느린 저장');
    const long = '가'.repeat(70);
    expect(titleOf(long, new Date())).toBe(`${'가'.repeat(60)}…`);
    expect(titleOf('e\u0301'.repeat(61), new Date())).toBe(`${'e\u0301'.repeat(60)}…`);
    expect([...titleOf('👨‍👩‍👧'.repeat(61), new Date())].length, 'the KB takes at most 300 characters').toBeLessThanOrEqual(300);
    expect(titleOf('#\n본문', new Date('2026-11-04T00:14:00Z'))).toBe('메모 2026-11-04 09:14');
    expect(titleOf('', new Date('2026-11-04T00:14:00Z'))).toBe('메모 2026-11-04 09:14');
  });

  test('5.7: the rule set the memo window carries has the hash kb-mock publishes in /v1/meta, so the precheck turns on', async () => {
    const { MEMO_RULES } = await import('../src/memo/rules.ts');
    expect(MEMO_RULES.version).toBe(mockRules.version);
    expect(await rulesSha(MEMO_RULES)).toBe(await rulesSha(mockRules));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
test.describe('criterion 1: the save path', () => {
  test('a new memo is saved once, as a private Note under a loupe:c: key, and an edit goes by PUT under a loupe:e: key at the version it saw', async ({ page, watch }) => {
    const t = tap(page);
    await openWithEditor(page);
    await expect(chip(page)).toHaveText('');
    await page.keyboard.type('# 첫 메모');
    await expect(chip(page)).toContainText('저장 안 됨');
    const before = kbWrites(A.mock).length;
    await memo(page).getByTestId('memo-save').click();
    await expect(chip(page)).toContainText('저장됨 v1');
    expect(kbWrites(A.mock).slice(before)).toEqual(['POST /v1/records 201 scope=editor']);
    expect(t.sent).toHaveLength(1);
    const first = t.sent[0]!;
    expect(first.path).toBe('/kb-write/records');
    expect(first.body).toMatchObject({ change: 'save', record: { type: 'Note', title: '첫 메모', body_format: 'markdown', sensitivity: 'private' } });
    expect(first.body!.idempotency_key).toMatch(/^loupe:c:[0-9a-f-]{36}$/);
    expect(first.body).not.toHaveProperty('on_secret');
    expect(first.body).not.toHaveProperty('expected_version');
    await answered(t, 1);
    const id = t.got[0]!.json!.id as string;
    expect(t.got[0]).toMatchObject({ status: 201, json: { version: 1, actor: 'app:loupe' } });

    await page.keyboard.press('Enter');
    await page.keyboard.type('둘째 줄');
    await page.keyboard.press('Control+s');
    await expect(chip(page)).toContainText('저장됨 v2');
    const second = t.sent[1]!;
    expect(second.path).toBe(`/kb-write/records/${id}`);
    expect(second.body).toMatchObject({ change: 'save', expected_version: 1, record: { title: '첫 메모', sensitivity: 'private' } });
    expect(second.body!.idempotency_key).toBe(`loupe:e:${id}:v1:save:r1`);
    expect(second.body!.record.body).toContain('둘째 줄');
    await expect(page.getByTestId('memo-conflict')).toHaveCount(0);
    void watch;
  });

  test('a response lost after the KB applied the save is resent under the same key: the answer is a replay and there is no second version', async ({ page, watch }) => {
    const t = tap(page);
    let dropped = 0;
    await page.route(/\/kb-write\/records$/, async (route: Route) => {
      if (dropped++ === 0) { await route.fetch(); await route.abort('connectionreset'); } else await route.continue();
    });
    await openWithEditor(page);
    await page.keyboard.type('응답을 잃는 메모');
    await memo(page).getByTestId('memo-save').click();
    await expect(chip(page)).toContainText('끊김');
    await expect(editor(page)).toContainText('응답을 잃는 메모');
    await expect(chip(page)).toContainText('저장됨 v1');
    const posts = t.sent.filter((s) => s.path === '/kb-write/records');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body!.idempotency_key).toBe(posts[0]!.body!.idempotency_key);
    expect(posts[1]!.raw).toBe(posts[0]!.raw);
    await expect.poll(() => t.got.filter((g) => g.path === '/kb-write/records').length).toBe(1);
    expect(t.got.find((g) => g.path === '/kb-write/records')).toMatchObject({ status: 201, json: { replayed: true, version: 1 } });
    // One write in the KB: the next edit at v1 becomes v2, not v3.
    await page.keyboard.type(' 더');
    await page.keyboard.press('Control+s');
    await expect(chip(page)).toContainText('저장됨 v2');
    void watch;
  });

  test('saves are serial: a save asked for while one is in flight waits, then sends the last text on the version the first answer brought', async ({ page, watch }) => {
    const t = tap(page);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    await page.route(/\/kb-write\/records$/, async (route: Route) => { await gate; await route.continue(); });
    await openWithEditor(page);
    await page.keyboard.type('하나');
    await memo(page).getByTestId('memo-save').click();
    await expect(chip(page)).toContainText('저장 중');
    await page.keyboard.type(' 둘');
    await page.keyboard.press('Control+s');
    await page.keyboard.type(' 셋');
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(500);
    expect(t.sent, 'the second save waits for the first').toHaveLength(1);
    release();
    await expect(chip(page)).toContainText('저장됨 v2');
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]!.body).toMatchObject({ expected_version: 1 });
    expect(t.sent[1]!.body!.record.body).toContain('하나 둘 셋');
    void watch;
  });

  test('Alt+N and Ctrl+M open a memo window with the editor ready', async ({ page }) => {
    await useSessions(page, sessions);
    await page.goto(`${A.origin}/#/`);
    await expect(page.getByTestId('home')).toBeVisible();
    await page.keyboard.press('Alt+n');
    await expect(memo(page)).toBeVisible();
    await expect(editor(page)).toBeFocused();
    await page.keyboard.press('Control+m');
    await expect(memo(page)).toHaveCount(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
test.describe('criterion 2: the precheck and the general / secret switch', () => {
  test('a rule-vector in the memo blocks the save: no kb-write/ and no /kb/v1/search request while blocked; "보안 정보로 바꾸기" leaves the marker nowhere', async ({ page, watch }) => {
    await open(page);
    const t = tap(page);
    await editor(page).click();
    await page.keyboard.type(`배포 키 ${AWS} 끝`);
    await expect(chip(page)).toContainText('저장 전 검사에 걸림');
    const block = memo(page).getByTestId('memo-secret');
    await expect(block).toContainText('aws-access-token');
    await expect(block).not.toContainText(AWS);
    await expect(memo(page).getByTestId('memo-save')).toBeDisabled();
    // Only the marked span is painted.
    await expect(memo(page).locator('.memo-hit')).toHaveText(AWS);
    await page.keyboard.press('Control+s');
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(700);
    expect(t.sent, 'no kb-write/ request while blocked').toEqual([]);
    expect(t.search, 'no search request while blocked').toEqual([]);

    await block.getByTestId('memo-to-secret').click();
    await expect(memo(page).getByTestId('memo-secret')).toHaveCount(0);
    expect(await everywhere(page, AWS), 'the marker is in no DOM, title, URL or storage').toEqual([]);
    expect(await whole(page)).not.toContain(AWS);
    await editor(page).click();
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    expect(await everywhere(page, AWS), 'undo does not bring it back').toEqual([]);
    await expect(editor(page)).toContainText('배포 키');
    await expect(memo(page).getByTestId('memo-secret-note')).toContainText('비밀 창');

    await memo(page).getByTestId('memo-save').click();
    await expect(chip(page)).toContainText('저장됨 v1');
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.raw).not.toContain(AWS);
    expect(t.search).toEqual([]);
    void watch;
  });

  test('"고치기" returns to editing and the save opens once the span is gone', async ({ page }) => {
    await openWithEditor(page);
    const t = tap(page);
    await page.keyboard.type(`키 ${AWS}`);
    await expect(memo(page).getByTestId('memo-secret')).toBeVisible();
    await memo(page).getByTestId('memo-fix').click();
    await expect(editor(page)).toBeFocused();
    for (let i = 0; i < AWS.length; i++) await page.keyboard.press('Backspace');
    await expect(memo(page).getByTestId('memo-secret')).toHaveCount(0);
    await expect(memo(page).getByTestId('memo-save')).toBeEnabled();
    expect(t.sent).toEqual([]);
  });

  test('the general / secret switch: new memo is general by default; "보안 정보" clears the text and its undo history, locks the input and shows the way to the secret window; Alt+S switches back', async ({ page }) => {
    await openWithEditor(page);
    const t = tap(page);
    await expect(memo(page).getByTestId('memo-mode-plain')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.type('지워질 글 SWITCHMARK');
    await memo(page).getByTestId('memo-mode-secret').click();
    await expect(memo(page).getByTestId('memo-mode-secret')).toHaveAttribute('aria-pressed', 'true');
    await expect(editor(page)).toHaveCount(0);
    await expect(memo(page).getByTestId('memo-secret-locked')).toContainText('보안 정보는 비밀 창에서 넣는다');
    await expect(memo(page).getByTestId('memo-open-secret')).toBeDisabled();
    await expect(memo(page).getByTestId('memo-save')).toBeDisabled();
    expect(await everywhere(page, 'SWITCHMARK')).toEqual([]);
    await page.keyboard.press('Alt+s');
    await expect(memo(page).getByTestId('memo-mode-plain')).toHaveAttribute('aria-pressed', 'true');
    await expect(editor(page)).toBeVisible();
    await editor(page).click();
    await page.keyboard.press('Control+z');
    expect(await everywhere(page, 'SWITCHMARK')).toEqual([]);
    await expect(editor(page)).not.toContainText('SWITCHMARK');
    expect(t.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
test.describe('criterion 3 and 5: states, and what the task registry gets', () => {
  test('202 spooled: the chip says sending and the reason, the ref goes to the registry (kind 저장 대기), and a committed write turns the chip into the saved version', async ({ page, watch }) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    // The task center reads the ref once when the registry changes (it passes); every read after that, the window's own poll, waits for the test.
    let reads = 0;
    await page.route(/\/kb\/v1\/writes\//, async (route) => { if (reads++ > 0) await gate; await route.continue(); });
    await open(page);
    const t = tap(page);
    await editor(page).click();
    await page.keyboard.type('[mock:spool] 느린 저장');
    await memo(page).getByTestId('memo-save').click();
    await expect(chip(page)).toContainText('보내는 중');
    await answered(t, 1);
    expect(t.got.find((g) => g.path === '/kb-write/records')).toMatchObject({ status: 202, json: { spooled: true, version: null } });
    const ref = t.got.find((g) => g.path === '/kb-write/records')!.json!.write_ref as string;
    expect((await registry(page))!.writes).toEqual([ref]);
    const items = await taskItems(page);
    expect(items.filter((i) => i.kind === 'write-wait')).toEqual([expect.objectContaining({ state: 'pending' })]);
    release();
    await expect(chip(page)).toContainText('저장됨 v1');
    await expect.poll(async () => (await registry(page))!.writes).toEqual([]);
    expect(t.sent.filter((s) => s.path === '/kb-write/records'), 'one create, no resend').toHaveLength(1);
    void watch;
  });

  test('202 then failed: the window says so, offers the copy of the draft and the discard, and a discard sends DELETE through /kb-write/writes/{ref}/discard', async ({ page, context, watch }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: A.origin });
    await open(page);
    const t = tap(page);
    await editor(page).click();
    await page.keyboard.type('[mock:fail] 실패할 저장');
    await page.keyboard.press('Enter');
    await page.keyboard.type('내 사본 본문');
    await memo(page).getByTestId('memo-save').click();
    await expect(chip(page)).toContainText('저장 실패');
    const band = memo(page).getByTestId('memo-failed');
    await expect(band).toContainText('version_conflict');
    expect((await registry(page))!.writes).toHaveLength(1);
    const items = await taskItems(page);
    expect(items.find((i) => i.kind === 'write-wait')).toMatchObject({ state: 'failed', tone: 'error' });
    await band.getByTestId('memo-copy').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('내 사본 본문');
    await band.getByTestId('memo-discard').click();
    await expect.poll(() => t.sent.filter((s) => s.path.endsWith('/discard')).length).toBe(1);
    await expect(memo(page).getByTestId('memo-failed')).toHaveCount(0);
    await expect(editor(page)).toContainText('내 사본 본문');
    await expect(chip(page)).toContainText('저장 안 됨');
    expect((await registry(page))!.writes).toEqual([]);
    void watch;
  });

  test('a 422 from the KB: only the marked span is painted, the rule id is named, the value is not drawn again, the registry gets a rejected entry (kind 저장 거절); "비밀 아님 · 격리 보관" resends the same key with on_secret, then the record, the editor and its history are gone everywhere', async ({ page, watch }) => {
    await open(page);
    const t = tap(page);
    await editor(page).click();
    await page.keyboard.type(`메모 ${AWS} 끝`);
    await expect(memo(page).getByTestId('memo-secret')).toBeVisible();
    await memo(page).getByTestId('memo-send-anyway').click();
    await expect(chip(page)).toContainText('저장 거절');
    const card = memo(page).getByTestId('memo-secret');
    await expect(card).toHaveAttribute('data-source', 'kb');
    await expect(card).toContainText('aws-access-token');
    await answered(t, 1);
    expect(t.got.find((g) => g.path === '/kb-write/records')).toMatchObject({ status: 422, json: { code: 'secret_detected', stored: false } });
    await expect(memo(page).locator('.memo-hit')).toHaveText(AWS);
    // Outside the editor the value is nowhere: not in the card, the window head, the chip, the title, the task center.
    const outside = await page.evaluate((n) => {
      const clone = document.documentElement.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('[data-testid=editor-content],[data-testid=editor-size]').forEach((e) => e.remove());
      return clone.outerHTML.includes(n) || document.title.includes(n);
    }, AWS);
    expect(outside).toBe(false);
    const rejected = (await registry(page))!.rejected;
    expect(rejected).toEqual([expect.objectContaining({ rule: 'aws-access-token', record: expect.stringMatching(/^f-/) })]);
    const items = await taskItems(page);
    expect(items.find((i) => i.kind === 'write-reject')).toMatchObject({ tone: 'error' });
    expect(items.find((i) => i.kind === 'write-reject')!.text).not.toContain(AWS);

    const firstKey = t.sent[0]!.body!.idempotency_key as string;
    await memo(page).getByTestId('memo-quarantine').click();
    await expect(memo(page)).toHaveCount(0);
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]!.body).toMatchObject({ idempotency_key: firstKey, change: 'save', on_secret: 'quarantine' });
    await answered(t, 2);
    expect(t.got[1]).toMatchObject({ status: 201, json: { quarantined: true, sensitivity: 'secret' } });
    expect((await registry(page))!.rejected).toEqual([expect.objectContaining({ rule: 'aws-access-token', record: t.got[1]!.json!.id })]);
    await taskItems(page);
    await expect(page.locator(`[data-testid=task-item][data-kind=write-reject][data-key="rejected:${t.got[1]!.json!.id}"]`)).toBeVisible();
    await page.keyboard.press('Control+z');
    expect(await everywhere(page, AWS), 'nothing of the value is left').toEqual([]);
    await page.waitForTimeout(500);
    expect(t.sent, 'no resend after the quarantine').toHaveLength(2);
    void watch;
  });

  test('a 409 whose current has a real new version raises the conflict band; "내 것으로 덮어쓰기" saves on top of the other side', async ({ page, watch }) => {
    await openWithEditor(page);
    const t = tap(page);
    await page.keyboard.type('충돌 메모');
    await memo(page).getByTestId('memo-save').click();
    await expect(chip(page)).toContainText('저장됨 v1');
    await answered(t, 1);
    const id = t.got[0]!.json!.id as string;
    // Another writer: v2.
    const other = await page.evaluate(async (i) => {
      const r = await fetch(`/kb-write/records/${i}`, { method: 'POST', headers: { authorization: `Bearer ${sessionStorage.getItem('loupe.session')}`, 'content-type': 'application/json', 'x-loupe-write': '1' }, body: JSON.stringify({ idempotency_key: 'loupe:e:other:v1:save:r1', change: 'save', expected_version: 1, record: { type: 'Note', title: '충돌 메모', body: '저쪽이 고친 글', body_format: 'markdown', sensitivity: 'private', props: {}, links: [] } }) });
      return r.status;
    }, id);
    expect(other).toBe(200);
    await page.keyboard.type(' 내 변경');
    await memo(page).getByTestId('memo-save').click();
    const band = memo(page).getByTestId('memo-conflict');
    await expect(band).toBeVisible();
    await expect(chip(page)).toContainText('충돌');
    await expect(band).toContainText('v2');
    await expect(band).toContainText('저쪽이 고친 글');
    await expect(editor(page)).toContainText('내 변경');
    await band.getByTestId('memo-keep-mine').click();
    await expect(chip(page)).toContainText('저장됨 v3');
    await expect(memo(page).getByTestId('memo-conflict')).toHaveCount(0);
    const last = t.sent.at(-1)!;
    expect(last.body).toMatchObject({ expected_version: 2 });
    expect(last.body!.idempotency_key).toBe(`loupe:e:${id}:v2:save:r1`);
    void watch;
  });

  test('self-save recognition: a response lost on an edit, then a further edit, gives a 409 whose current is my own save, and no conflict band', async ({ page, watch }) => {
    await openWithEditor(page);
    const t = tap(page);
    await page.keyboard.type('자기 저장');
    await memo(page).getByTestId('memo-save').click();
    await expect(chip(page)).toContainText('저장됨 v1');
    await answered(t, 1);
    const id = t.got[0]!.json!.id as string;
    let dropped = 0;
    await page.route(new RegExp(`/kb-write/records/${id}$`), async (route: Route) => {
      if (dropped++ === 0) { await route.fetch(); await route.abort('connectionreset'); } else await route.continue();
    });
    await page.keyboard.type(' 둘');
    await memo(page).getByTestId('memo-save').click();
    await expect(chip(page)).toContainText('끊김');
    // Edit again before the automatic resend: the next send is a different content on the version the KB has already left behind.
    await page.keyboard.type(' 셋');
    await page.keyboard.press('Control+s');
    await expect(chip(page)).toContainText('저장됨 v3');
    expect(t.got.map((g) => g.status), 'the KB answered a 409 on the way').toContain(409);
    await expect(memo(page).getByTestId('memo-conflict')).toHaveCount(0);
    expect(t.sent.at(-1)!.body).toMatchObject({ expected_version: 2 });
    void watch;
  });

  test('the KB cannot be reached: the window says so, keeps the text and sends it when the KB is back', async ({ page, watch }) => {
    await openWithEditor(page);
    const t = tap(page);
    await page.route(/\/kb-write\//, (route) => route.abort('connectionrefused'));
    await page.keyboard.type('끊긴 동안 쓴 글');
    await memo(page).getByTestId('memo-save').click();
    await expect(chip(page)).toContainText('끊김');
    await expect(memo(page)).toHaveAttribute('data-status', 'offline');
    await expect(editor(page)).toContainText('끊긴 동안 쓴 글');
    await page.unroute(/\/kb-write\//);
    await expect(chip(page)).toContainText('저장됨 v1');
    expect(t.sent.length).toBeGreaterThanOrEqual(2);
    expect(new Set(t.sent.map((s) => s.body!.idempotency_key)).size, 'every resend has the same key').toBe(1);
    void watch;
  });

  test('a 401 token answer: "KB 쓰기 권한 없음", the draft stays, and the way to the settings window is offered', async ({ page, watch }) => {
    await openWithEditor(page);
    await page.route(/\/kb-write\//, (route) => route.fulfill({ status: 401, contentType: 'application/problem+json', body: JSON.stringify({ type: 'https://kb.local/problems/token-invalid', title: 'token invalid', status: 401, code: 'token_invalid' }) }));
    await page.keyboard.type('토큰이 틀린 동안');
    await memo(page).getByTestId('memo-save').click();
    await expect(chip(page)).toContainText('KB 쓰기 권한 없음');
    await expect(editor(page)).toContainText('토큰이 틀린 동안');
    await memo(page).getByTestId('memo-open-settings').click();
    await expect(page.locator('[data-testid=wm-window][data-id="loupe:settings"]')).toBeVisible();
    void watch;
  });

  test('private_open false: the window says the KB takes no private records yet and sends nothing', async ({ page }) => {
    await open(page, B);
    const t = tap(page);
    await expect(memo(page).getByTestId('memo-closed')).toContainText('KB가 아직 비공개 기록을 받지 않는다');
    await expect(editor(page)).toBeVisible();
    await editor(page).click();
    await page.keyboard.type('닫힌 동안');
    await expect(memo(page).getByTestId('memo-save')).toBeDisabled();
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(300);
    expect(t.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
test.describe('criterion 4: minimizing a window does not lose what is typed in it', () => {
  test('a memo: type, minimize, restore from the dock: the text is there, the chip still says unsaved, and the save works', async ({ page, watch }) => {
    await openWithEditor(page);
    await page.keyboard.type('내렸다 올릴 글');
    await expect(chip(page)).toContainText('저장 안 됨');
    await page.getByTestId('wm-window').getByRole('button', { name: '내리기', exact: true }).click();
    await expect(page.getByTestId('wm-window')).toHaveCount(0);
    const dock = page.getByTestId('window-dock');
    await expect(dock).toContainText('내렸다 올릴 글');
    await expect(dock).toContainText('저장 안 됨');
    await dock.getByRole('button').click();
    await expect(page.getByTestId('wm-window')).toHaveCount(1);
    await expect(editor(page)).toContainText('내렸다 올릴 글');
    await expect(chip(page)).toContainText('저장 안 됨');
    await editor(page).click();
    await page.keyboard.press('Alt+m');
    await expect(page.getByTestId('wm-window')).toHaveCount(0);
    await dock.getByRole('button').click();
    await expect(editor(page)).toContainText('내렸다 올릴 글');
    await memo(page).getByTestId('memo-save').click();
    await expect(chip(page)).toContainText('저장됨 v1');
    void watch;
  });

  test('a record opened for editing: unsaved edits survive minimize and restore', async ({ page, watch }) => {
    await page.goto(`${RESEARCH}/#/w/${encodeURIComponent('f-m0c-note')}`);
    await page.getByTestId('window-edit-toggle').click();
    const ed = page.locator('[data-testid=wm-window] [data-testid=editor-content]');
    await expect(ed).toBeVisible();
    await ed.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' 내린 뒤에도 남는 글');
    await page.getByRole('button', { name: '내리기', exact: true }).click();
    await expect(page.getByTestId('wm-window')).toHaveCount(0);
    await page.getByTestId('window-dock').getByRole('button').click();
    await expect(ed).toContainText('내린 뒤에도 남는 글');
    void watch;
  });
});
