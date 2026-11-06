// Design 1, 19: the button copies the exact text it shows, for a node and for a guest.
import { expect, test, type Page } from '@playwright/test';
import { clickObject } from './support/pick.ts';
import { BUILT } from './support/ports.ts';

type Snap = { nodes: { id: string; kind: string; facts: Record<string, unknown> }[] };
const asCopy = (page: Page) => page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BUILT).origin });

/** A guest in the synthetic large map gets an observed IPv4 and a declared user, so the e2e has one to click. */
async function patchGuest(page: Page, id: string, user: string | null) {
  await page.route('**/api/snapshot?fixture=large', async (route) => {
    const res = await route.fetch();
    const snap = (await res.json()) as Snap;
    const g = snap.nodes.find((n) => n.id === id)!;
    g.facts.ip = { value: ['192.0.2.77'], basis: 'observed', source: 'pve:/nodes/qemu/agent/network-get-interfaces', at: new Date().toISOString(), ttlS: 600 };
    if (user) g.facts.sshUser = { value: user, basis: 'declared', source: 'edge.json#/guests/0', at: '2026-11-01', ttlS: null };
    await route.fulfill({ response: res, json: snap });
  });
}
const open = async (page: Page, hash: string) => { await page.goto(`${BUILT}/${hash}`); await page.waitForSelector('svg.scene g[data-id]'); };

test('a node: click, then the clipboard holds the text on the button', async ({ page }) => {
  await asCopy(page);
  await open(page, '#/?fx=large');
  await clickObject(page, 'pve:node:node-2');
  const btn = page.getByTestId('ssh-copy');
  await expect(btn).toBeVisible();
  const shown = (await page.getByTestId('ssh-text').textContent())!;
  expect(shown).toBe('ssh node-2');
  await btn.focus();
  await page.keyboard.press('Enter');                       // keyboard reachable
  await expect(btn).toHaveAttribute('data-state', 'done');
  await expect(btn).toContainText('복사됨');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
});

test('a guest: the line carries the declared user and the observed IPv4', async ({ page }) => {
  await asCopy(page);
  const id = await (async () => { const r = await page.request.get(`${BUILT}/api/snapshot?fixture=large`); const s = (await r.json()) as Snap; return s.nodes.find((n) => n.kind === 'vm')!.id; })();
  await patchGuest(page, id, 'ops');
  await open(page, `#/?fx=large&sel=${encodeURIComponent(id)}&open=1`);
  const btn = page.getByTestId('ssh-copy');
  await expect(btn).toBeVisible();
  const shown = (await page.getByTestId('ssh-text').textContent())!;
  expect(shown).toBe('ssh ops@192.0.2.77');
  await btn.click();
  await expect(btn).toHaveAttribute('data-state', 'done');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
});

test('a denied clipboard does not break the page', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) } }); document.execCommand = () => false; });
  await open(page, '#/?fx=large');
  await clickObject(page, 'pve:node:node-2');
  await page.getByTestId('ssh-copy').click();
  await expect(page.getByTestId('ssh-failed')).toBeVisible();
  await expect(page.getByTestId('ssh-text')).toHaveText('ssh node-2');
});

test('a guest with no address shows no button and says why', async ({ page }) => {
  await open(page, '#/?fx=today&sel=pve:qemu:100&open=1');
  await expect(page.getByTestId('object')).toContainText('VM 100');
  await expect(page.getByTestId('ssh-copy')).toHaveCount(0);
  await expect(page.getByTestId('ssh-none')).toContainText('guest agent 응답 없음');
});
