// The real server against dev/mcp-mock, in a browser: the two Phase 2 items that need a VM start or a tower stop are proved here and left to the owner on the real thing.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startMock, type Mock } from '../dev/mcp-mock/mock.ts';
import { startWanMock } from '../dev/mcp-mock/wan.ts';
import { startLive } from '../server/serve.ts';
import { audit } from './support/audit.ts';
import { root, shotDir } from './support/ports.ts';

const TOKEN = 'e2e-synthetic-token-0123456789abcdefghijklmnop';
const PORT = { live: 4820, mock: 4821 };
const URL_ = `http://127.0.0.1:${PORT.live}/`;

type Period = NonNullable<Parameters<typeof startLive>[0]>['period'];

async function setup(period?: Period) {
  const dir = mkdtempSync(join(tmpdir(), 'relief-e2e-'));
  mkdirSync(join(dir, 'tower'));
  writeFileSync(join(dir, 'tower/token'), TOKEN, { mode: 0o600 });
  writeFileSync(join(dir, 'relief.json'), JSON.stringify({ towerUrl: `http://127.0.0.1:${PORT.mock}/mcp` }));
  const env = { ...process.env, TOWER_CONFIG: join(dir, 'tower/tower.json'), RELIEF_CONFIG: dir, RELIEF_STATE: join(dir, 'state') } as NodeJS.ProcessEnv;
  const mock = await startMock({ port: PORT.mock, token: TOKEN });
  const server = await startLive({ port: PORT.live, env, dist: join(root, 'dist'), ...(period ? { period } : {}) });
  return { mock, server, stop: async (m: Mock) => { await server.close(); await m.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); } };
}

const obj = (page: Page, id: string) => page.locator(`svg.scene g[data-id="${id}"]`);
const reads = (m: Mock) => m.calls.filter((c) => c.name === 'proxmox_list_resources').length;

test('a VM start shows as starting within 20 s of idle, at real periods, in the worst case of the cycle', async ({ page }) => {
  test.setTimeout(60_000);
  const { mock, stop } = await setup();
  try {
    mock.state.guests.push({ vmid: 101, node: 'node-2', name: 'guest-b', status: 'stopped', type: 'qemu' });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(URL_);
    await expect(obj(page, 'pve:qemu:101')).toHaveAttribute('aria-label', /중지/, { timeout: 25_000 });
    await expect(page.getByTestId('live')).toHaveCount(0); // The real map carries no badge: only synthetic data is marked.
    await expect(page.getByText('합성 fixture')).toHaveCount(0);
    // Right after a read is the worst moment: the next one is a whole period away.
    const n = reads(mock);
    await expect.poll(() => reads(mock), { intervals: [20], timeout: 20_000 }).toBeGreaterThan(n);
    await page.waitForTimeout(250); // Inside the read its sibling, the task list, can still catch the task, and the number means nothing.
    const t0 = Date.now();
    mock.state.tasks.unshift({ upid: 'UPID:node-2:1:1:1:qmstart:101:root@pam:', node: 'node-2', id: '101', type: 'qmstart', user: 'root@pam', starttime: Math.floor(t0 / 1000), pid: 7, saved: '0' });
    await expect(obj(page, 'pve:qemu:101')).toHaveAttribute('aria-label', /기동 중/, { timeout: 22_000 });
    const took = Date.now() - t0;
    console.log(`idle start-to-screen: ${took} ms`);
    expect(took).toBeLessThan(20_000);
    // The task ends, the guest runs, the label follows at the active pace. Again right after a read, the worst moment.
    const m = reads(mock);
    await expect.poll(() => reads(mock), { intervals: [20], timeout: 8_000 }).toBeGreaterThan(m);
    await page.waitForTimeout(250);
    mock.state.tasks[0] = { ...mock.state.tasks[0], endtime: Math.floor(Date.now() / 1000), status: 'OK' };
    delete mock.state.tasks[0]!.pid;
    mock.state.guests[1]!.status = 'running'; mock.state.guests[1]!.uptime = 600;
    const t1 = Date.now();
    await expect(obj(page, 'pve:qemu:101')).toHaveAttribute('aria-label', /실행/, { timeout: 12_000 });
    console.log(`task-seen to screen: ${Date.now() - t1} ms`);
    expect(Date.now() - t1).toBeLessThan(10_000);
    expect(errors).toEqual([]);
  } finally { await stop(mock); }
});

test('tower down: the map stays and goes stale; tower back: it recovers by itself', async ({ page }) => {
  test.setTimeout(60_000);
  const fast = { fastS: 1, activeS: 1, idleS: 1, minTtlS: 3, guestTickS: 1 };
  const first = await setup(fast);
  let mock = first.mock;
  try {
    await page.goto(URL_);
    await expect(obj(page, 'pve:qemu:100')).toHaveAttribute('aria-label', /실행/, { timeout: 8_000 });
    await page.waitForTimeout(1500);
    const a = await page.evaluate(audit);
    expect(a.overlaps).toEqual([]); expect(a.clipped).toEqual([]); expect(a.orphans).toEqual([]); expect(a.noBasis).toBe(0);
    await mock.close();
    await expect(page.getByTestId('source-failing')).toContainText('tower 응답 없음', { timeout: 12_000 });
    await expect(obj(page, 'pve:qemu:100')).toHaveAttribute('aria-label', /낡음/, { timeout: 12_000 });
    await expect(obj(page, 'pve:node:node-1')).toHaveAttribute('aria-label', /낡음/);
    await expect(obj(page, 'pve:qemu:100')).toHaveAttribute('aria-label', /실행/); // last state stays, never "stopped"
    mock = await startMock({ port: PORT.mock, token: TOKEN });
    await expect(page.getByTestId('source-failing')).toHaveCount(0, { timeout: 12_000 });
    await expect(obj(page, 'pve:qemu:100')).not.toHaveAttribute('aria-label', /낡음/, { timeout: 8_000 });
  } finally { await first.stop(mock); }
});

test('a guest that goes leaves the map; first start with tower down draws the blank box and says so', async ({ page }) => {
  test.setTimeout(45_000);
  const fast = { fastS: 1, activeS: 1, idleS: 1, minTtlS: 3, guestTickS: 1 };
  const first = await setup(fast);
  let mock = first.mock;
  try {
    await page.goto(URL_);
    await expect(obj(page, 'pve:qemu:100')).toBeVisible({ timeout: 8_000 });
    mock.state.guests = [];
    await expect(obj(page, 'pve:qemu:100')).toHaveCount(0, { timeout: 10_000 });
  } finally { await first.stop(mock); }
  const dir = mkdtempSync(join(tmpdir(), 'relief-e2e-'));
  writeFileSync(join(dir, 'relief.json'), JSON.stringify({ towerUrl: `http://127.0.0.1:${PORT.mock}/mcp` }));
  const env = { ...process.env, TOWER_CONFIG: join(dir, 'tower/tower.json'), RELIEF_CONFIG: dir, RELIEF_STATE: join(dir, 'state') } as NodeJS.ProcessEnv;
  const s = await startLive({ port: PORT.live, env, dist: join(root, 'dist') });
  try {
    await page.goto(URL_);
    await expect(page.getByTestId('source-failing')).toContainText('tower 토큰 없음');
    await expect(obj(page, 'decl:wan:none')).toBeVisible();
    await expect(page.getByTestId('tiers')).toContainText('수집 실패 · tower 토큰 없음 · 값 없음');
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the edge file: adding it declares, deleting it reverts, a wrong A record warns while every source stays ok', async ({ page }) => {
  test.setTimeout(60_000);
  const wan = await startWanMock('203.0.113.99');
  const dir = mkdtempSync(join(tmpdir(), 'relief-e2e-'));
  mkdirSync(join(dir, 'tower'));
  writeFileSync(join(dir, 'tower/token'), TOKEN, { mode: 0o600 });
  writeFileSync(join(dir, 'relief.json'), JSON.stringify({ towerUrl: `http://127.0.0.1:${PORT.mock}/mcp`, publicIpUrl: wan.url }));
  const env = { ...process.env, TOWER_CONFIG: join(dir, 'tower/tower.json'), RELIEF_CONFIG: dir, RELIEF_STATE: join(dir, 'state') } as NodeJS.ProcessEnv;
  const mock = await startMock({ port: PORT.mock, token: TOKEN });
  const server = await startLive({ port: PORT.live, env, dist: join(root, 'dist'), period: { fastS: 1, activeS: 1, idleS: 1, minTtlS: 3, guestTickS: 1, edgeS: 1 } });
  try {
    await page.goto(URL_);
    const wanBox = 'svg.scene g[data-kind="wan"]';
    await expect(page.locator(wanBox)).toHaveAttribute('data-basis', 'unknown', { timeout: 8_000 });
    await page.getByTestId('overlay-basis').click();
    writeFileSync(join(dir, 'edge.json'), readFileSync(join(root, 'fixtures/edge.example.json')));
    await expect(page.locator(wanBox)).toHaveAttribute('data-basis', 'declared', { timeout: 9_000 });
    await expect(obj(page, 'decl:domain:site')).toHaveAttribute('aria-label', /어긋남 A 레코드 낡음 가능/, { timeout: 9_000 });
    await expect(page.getByTestId('tiers')).toContainText('어긋남 ');
    await expect(page.getByTestId('source-failing')).toHaveCount(0);
    const a = await page.evaluate(audit);
    expect(a.overlaps).toEqual([]); expect(a.clipped).toEqual([]); expect(a.orphans).toEqual([]); expect(a.noBasis).toBe(0);
    await page.screenshot({ path: join(shotDir, 'live-edge-basis.png') });
    await obj(page, 'decl:domain:site').click({ force: true });
    await expect(page.getByTestId('warnings')).toContainText('A 레코드 낡음 가능');
    await expect(page.locator('[data-fact="record"]')).toContainText('203.0.113.10');
    await expect(page.locator('[data-fact="publicIp"]')).toContainText('203.0.113.99');
    rmSync(join(dir, 'edge.json'));
    await expect(page.locator(wanBox)).toHaveAttribute('data-basis', 'unknown', { timeout: 9_000 });
    await expect(obj(page, 'decl:domain:site')).toHaveCount(0);
  } finally {
    await server.close(); await mock.close().catch(() => {}); await wan.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
