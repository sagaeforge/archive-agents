// loupe v2 M0e (design v2 2.8): the avatar with its connection dot and menu, the settings window with nine cards, the read-only status
// behind a session, the appearance settings, and the lock. The stopgap lock button of M0c is gone. This file owns its own kb-mock and
// loupe serve (it stops the KB and locks the session), one pair per test, so nothing it does reaches the shared harness.
import type { ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect, signIn } from './support/test.ts';
import { accessLog, base, PORT, sock } from './support/ports.ts';
import { startMock, startServe, stop, tcpOpen, waitFor } from './support/procs.ts';

const ORIGIN = base(PORT.offline);
const FIXTURE = 'contract-sample/fixtures/kb-research.json';
const CARDS = ['account', 'lock', 'devices', 'kb', 'defaults', 'shortcuts', 'appearance', 'secret', 'breakglass'];
let mock: ChildProcess, serve: ChildProcess;

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ page }) => {
  rmSync(accessLog('o'), { force: true });
  mock = await startMock('o', FIXTURE);
  serve = await startServe('o', PORT.offline);
  await signIn(page, ORIGIN);
});
test.afterEach(async () => {
  await stop(mock); await stop(serve); rmSync(sock('o'), { force: true });
  await waitFor(async () => !(await tcpOpen(PORT.offline)), 3000, 'port free');
});

const session = (page: Page) => page.evaluate(() => sessionStorage.getItem('loupe.session'));
const get = (path: string, token: string | null) => fetch(`${ORIGIN}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
async function openSettingsFromMenu(page: Page) {
  await page.getByTestId('avatar').click();
  await page.getByTestId('menu-settings').click();
  await expect(page.getByTestId('wm-window').filter({ has: page.getByTestId('settings-card').first() })).toHaveCount(1);
}

test('the avatar stands in the top right with a green dot and a menu, and the stopgap lock button is gone', async ({ page, watch }) => {
  await page.goto(`${ORIGIN}/#/`);
  await expect(page.getByTestId('avatar')).toBeVisible();
  await expect(page.getByTestId('lock-button')).toHaveCount(0);
  await expect(page.locator('.workspace-lock')).toHaveCount(0);
  const box = (await page.getByTestId('avatar').boundingBox())!;
  expect(box.x + box.width, 'top right').toBeGreaterThan(1360 - 80);
  expect(box.y, 'top right').toBeLessThan(50);
  await expect(page.getByTestId('avatar-dot')).toHaveAttribute('data-state', 'ok');
  await page.getByTestId('avatar').click();
  const menu = page.getByRole('menu', { name: '계정 메뉴' });
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('menu-account')).toContainText('허용 계정');
  await expect(page.getByTestId('menu-session')).toContainText(/유휴 \d+분/);
  await expect(page.getByTestId('menu-session')).toContainText(/최대 \d+시간/);
  await expect(page.getByTestId('menu-kb')).toContainText('연결됨');
  await expect(page.getByTestId('menu-settings')).toContainText('Ctrl+,');
  await expect(page.getByTestId('menu-lock')).toContainText('Ctrl+Alt+L');
  // The account is named by words only: never an e-mail address.
  expect(await menu.innerText()).not.toMatch(/@/);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId('avatar')).toBeFocused();
  void watch;
});

test('settings open from the menu and from Ctrl+, as a window with nine cards, and change nothing that is security', async ({ page, watch }) => {
  const writes: string[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && r.method() !== 'HEAD') writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.goto(`${ORIGIN}/#/`);
  await openSettingsFromMenu(page);
  const win = page.getByTestId('wm-window').filter({ has: page.getByTestId('settings-card').first() });
  await expect(win).toHaveAttribute('role', 'region');
  await expect(win).toHaveAttribute('aria-label', '설정 창');
  await expect(page.getByTestId('settings-card')).toHaveCount(9);
  expect(await page.getByTestId('settings-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-card')))).toEqual(CARDS);
  // The window is dragged and lowered like the others; there is no side list inside it.
  await expect(win.getByTestId('wm-titlebar')).toBeVisible();
  await expect(win.locator('nav, [role=tablist]')).toHaveCount(0);
  // Read-only status: the figures come from the status path.
  await expect(page.getByTestId('settings-kb-state')).toHaveText('연결됨');
  await expect(page.locator('[data-card=kb]')).toContainText('data_as_of');
  await expect(page.locator('[data-card=kb] [data-row=fp_gate] dd')).toHaveText('켜짐');
  await expect(page.locator('[data-card=kb] [data-row=editor_routes] dd')).toHaveText('2개');
  await expect(page.locator('[data-card=kb] [data-row=private_open] dd')).toHaveText('열림');
  await expect(page.locator('[data-card=kb]')).toContainText('fp-secret-rules-v1');
  await expect(page.locator('[data-card=account]')).toContainText('허용 계정 1');
  await expect(page.locator('[data-card=account]')).toContainText('loupe google-enroll');
  await expect(page.locator('[data-card=breakglass]')).toContainText('loupe breakglass open');
  await expect(page.locator('[data-card=devices]')).toContainText('sudo kb reviewer enroll');
  // Security cards carry no control that could change anything: text and terminal commands only.
  for (const id of ['account', 'kb', 'secret', 'breakglass']) {
    await expect(page.locator(`[data-card=${id}]`).locator('input, select, textarea, button'), `${id} card has no control`).toHaveCount(0);
  }
  // Closing and opening again by keyboard.
  await win.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(page.getByTestId('settings-card')).toHaveCount(0);
  await page.locator('main').click({ position: { x: 600, y: 400 } });
  await page.keyboard.press('Control+,');
  await expect(page.getByTestId('settings-card')).toHaveCount(9);
  // The address and the title name no settings; the layout holds an id only.
  expect(page.url()).toBe(`${ORIGIN}/#/`);
  await expect(page).toHaveTitle('loupe · 설정');
  expect(writes, 'opening settings writes nothing').toEqual([]);
  void watch;
});

test('the status polls carry no activity mark and never touch /kb-write', async ({ page, watch }) => {
  const marks: boolean[] = [];
  const paths: string[] = [];
  page.on('request', (r) => { const u = new URL(r.url()); paths.push(u.pathname); if (u.pathname === '/auth/status/detail') marks.push(r.headers()['x-loupe-activity'] === '1'); });
  await page.clock.install();
  await page.goto(`${ORIGIN}/#/`);
  await openSettingsFromMenu(page);
  await expect.poll(() => marks.length).toBeGreaterThan(0);
  const n = marks.length;
  await page.clock.fastForward(35_000);
  await expect.poll(() => marks.length, 'the open window refreshes its status').toBeGreaterThan(n);
  expect(marks.slice(n).some(Boolean), 'a refresh without input carries no activity mark').toBe(false);
  expect(paths.some((p) => p.startsWith('/kb-write'))).toBe(false);
  void watch;
});

test('with the KB out of reach the avatar dot is red and the settings KB card says disconnected', async ({ page, watch }) => {
  await page.clock.install();
  await page.goto(`${ORIGIN}/#/`);
  await expect(page.getByTestId('avatar-dot')).toHaveAttribute('data-state', 'ok');
  await stop(mock);
  rmSync(sock('o'), { force: true });
  for (let i = 0; i < 4; i++) {
    await page.clock.fastForward(46_000);
    if ((await page.getByTestId('avatar-dot').getAttribute('data-state')) === 'down') break;
    await page.waitForTimeout(300);
  }
  await expect(page.getByTestId('avatar-dot')).toHaveAttribute('data-state', 'down');
  await page.getByTestId('avatar').click();
  await expect(page.getByTestId('menu-kb')).toContainText('끊김');
  await page.getByTestId('menu-settings').click();
  await expect(page.getByTestId('settings-kb-state')).toHaveText('끊김');
  await expect(page.getByTestId('settings-kb-state')).toHaveAttribute('data-state', 'down');
  // The server's own view agrees, and it still answers the status while the KB is gone.
  await expect(page.locator('[data-card=kb] [data-row=fp_gate] dd')).toHaveText('—');
  await expect(page.locator('[data-card=kb] [data-row=private_open] dd')).toHaveText('—');
  void watch;
});

test('the theme choice persists after a reload and stays in this browser only', async ({ page, watch }) => {
  const kbWrites: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/kb')) kbWrites.push(r.method()); });
  await page.goto(`${ORIGIN}/#/`);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  const paint = () => page.evaluate(() => getComputedStyle(document.querySelector('main.workspace')!).backgroundColor);
  const light = await paint();
  await openSettingsFromMenu(page);
  await page.getByTestId('theme-dark').check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const stored = await page.evaluate(() => localStorage.getItem('loupe.appearance'));
  expect(JSON.parse(stored ?? 'null')).toMatchObject({ theme: 'dark' });
  expect(await paint(), 'the dark theme repaints the stage').not.toBe(light);
  await page.getByTestId('size-large').check();
  await page.getByTestId('motion-reduce').check();
  await expect(page.locator('html')).toHaveAttribute('data-text-size', 'large');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');

  await page.reload();
  // Applied before the app paints, not after the settings window is opened again.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-text-size', 'large');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await expect(page.getByTestId('avatar')).toBeVisible();
  await openSettingsFromMenu(page);
  await expect(page.getByTestId('theme-dark')).toBeChecked();
  await expect(page.getByTestId('size-large')).toBeChecked();
  await expect(page.getByTestId('motion-reduce')).toBeChecked();
  await page.getByTestId('theme-light').check();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(kbWrites.every((m) => m === 'GET'), 'appearance never goes to the server').toBe(true);
  void watch;
});

test('locking from the menu clears the session on the server and in the tab, and keeps the tab', async ({ page, watch }) => {
  await page.goto(`${ORIGIN}/#/`);
  await expect(page.getByTestId('avatar')).toBeVisible();
  const token = (await session(page))!;
  expect(token).toBeTruthy();
  expect((await get('/auth/session', token)).status).toBe(200);
  await page.evaluate(() => { (window as unknown as { __mem: string }).__mem = 'unsaved draft'; });
  await page.getByTestId('avatar').click();
  await page.getByTestId('menu-lock').click();
  await expect(page.getByTestId('session-cover')).toHaveAttribute('data-why', 'locked');
  expect(await session(page)).toBeNull();
  expect((await get('/auth/session', token)).status, 'the server forgot the session').toBe(401);
  expect((await get('/auth/status/detail', token)).status, 'the status needs a session').toBe(401);
  expect((await get('/kb/v1/meta', token)).status).toBe(401);
  expect(await page.evaluate(() => (window as unknown as { __mem: string }).__mem)).toBe('unsaved draft');
  void watch;
});

test('Ctrl+Alt+L locks from the workspace too', async ({ page, watch }) => {
  await page.goto(`${ORIGIN}/#/`);
  await expect(page.getByTestId('avatar')).toBeVisible();
  const token = (await session(page))!;
  await page.locator('main').click({ position: { x: 600, y: 400 } });
  await page.keyboard.press('Control+Alt+KeyL');
  await expect(page.getByTestId('session-cover')).toHaveAttribute('data-why', 'locked');
  expect((await get('/auth/session', token)).status).toBe(401);
  void watch;
});

test('the lock card locks too, and the status request without a session is a 401 from the browser', async ({ page, watch }) => {
  await page.goto(`${ORIGIN}/#/`);
  await openSettingsFromMenu(page);
  const noSession = await page.evaluate(async () => (await fetch('/auth/status/detail', { cache: 'no-store' })).status);
  expect(noSession).toBe(401);
  const token = (await session(page))!;
  await page.getByTestId('settings-lock').click();
  await expect(page.getByTestId('session-cover')).toHaveAttribute('data-why', 'locked');
  expect((await get('/auth/session', token)).status).toBe(401);
  void watch;
});
