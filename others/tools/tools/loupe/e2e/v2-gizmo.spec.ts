// M0d: the graph filter gizmo (design v2 2.3). The kb-mock M0c and M0d topics hold ten nodes: four topic-axis, two documents, two memos,
// one piece of knowledge and one secret object name.
import type { Page } from '@playwright/test';
import { test, expect } from './support/test.ts';
import { RESEARCH } from './support/ports.ts';

const KIND = {
  topic: ['e:topic:m0c', 'f-m0c-spec', 'e:topic:m0d', 'f-m0d-spec'],
  document: ['f-m0c-page', 'f-m0d-page'],
  knowledge: ['e:tool:m0d-sigma'],
  memo: ['f-m0c-note', 'f-m0d-note'],
  secret: ['s-m0d-token'],
};
const ANCHORS = ['e:topic:m0c', 'e:topic:m0d'];
const sorted = (xs: string[]) => [...xs].sort();
const EVERYTHING = sorted(Object.values(KIND).flat());

/** What sigma holds, and what the accessibility list offers: the two must always agree. */
async function shown(page: Page) {
  return page.evaluate(() => {
    const g = (window as unknown as { __loupeGraph: { graph: { nodes(): string[]; edges(): string[]; extremities(e: string): [string, string] } } }).__loupeGraph.graph;
    const list = [...document.querySelectorAll('[data-testid="graph-node-list"] [data-id]')].map((e) => e.getAttribute('data-id')!);
    return { nodes: g.nodes().sort(), list: list.sort(), edges: g.edges().map((e) => g.extremities(e)) };
  });
}
async function expectShown(page: Page, ids: string[]) {
  await expect.poll(async () => (await shown(page)).nodes).toEqual(sorted(ids));
  const s = await shown(page);
  expect(s.list, 'the accessibility list follows the canvas').toEqual(sorted(ids));
  for (const [a, b] of s.edges) { expect(ids, `edge end ${a}`).toContain(a); expect(ids, `edge end ${b}`).toContain(b); }
}
const axis = (page: Page, k: string) => page.getByTestId(`gizmo-axis-${k}`);
const summaryOf = (page: Page) => page.getByTestId('gizmo-summary');
async function home(page: Page) {
  await page.goto(RESEARCH + '/#/');
  await expect(page.getByTestId('topic-graph')).toHaveAttribute('data-layout', 'ready');
  await expectShown(page, EVERYTHING);
}

test('each kind alone shows exactly its nodes (and the topic anchors) and says so in words', async ({ page }) => {
  await home(page);
  await expect(summaryOf(page)).toHaveText('보이는 것: 전체');
  const label = { topic: '주제', document: '문서', knowledge: '지식', memo: '메모', secret: '비밀 객체' } as const;
  for (const k of ['topic', 'document', 'knowledge', 'memo', 'secret'] as const) {
    await axis(page, k).click();
    // The topic axis shows its own nodes; any other axis keeps the topics behind it as anchors.
    await expectShown(page, k === 'topic' ? KIND.topic : [...KIND[k], ...ANCHORS]);
    await expect(summaryOf(page)).toHaveText(`보이는 것: ${label[k]}`);
    await expect(axis(page, k)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('gizmo-all')).toHaveAttribute('aria-pressed', 'false');
  }
  await page.getByTestId('gizmo-all').click();
  await expectShown(page, EVERYTHING);
});

test('Shift adds and removes: documents + memos, knowledge + topics', async ({ page }) => {
  await home(page);
  await axis(page, 'document').click();
  await axis(page, 'memo').click({ modifiers: ['Shift'] });
  await expectShown(page, [...KIND.document, ...KIND.memo, ...ANCHORS]);
  await expect(summaryOf(page)).toHaveText('보이는 것: 문서 + 메모');
  await axis(page, 'knowledge').click();
  await axis(page, 'topic').click({ modifiers: ['Shift'] });
  await expectShown(page, [...KIND.knowledge, ...KIND.topic]);
  await expect(summaryOf(page)).toHaveText('보이는 것: 주제 + 지식');
  await axis(page, 'topic').click({ modifiers: ['Shift'] });
  await expectShown(page, [...KIND.knowledge, ...ANCHORS]);
});

test('turning the topic axis off leaves the topics as dashed anchors and draws no edge to a hidden node', async ({ page }) => {
  await home(page);
  const full = (await shown(page)).edges.length;
  expect(full).toBe(9);
  await axis(page, 'topic').click({ modifiers: ['Shift'] });
  const visible = [...KIND.document, ...KIND.knowledge, ...KIND.memo, ...KIND.secret, ...ANCHORS];
  await expectShown(page, visible);
  const s = await shown(page);
  expect(s.nodes).toEqual(expect.arrayContaining(ANCHORS));
  expect(s.nodes).not.toContain('f-m0c-spec');
  // The two spec edges went with the specs: nothing points at a node that is not drawn.
  expect(s.edges).toHaveLength(7);
  for (const [a, b] of s.edges) { expect(s.nodes).toContain(a); expect(s.nodes).toContain(b); }
  const rings = page.getByTestId('graph-anchors');
  await expect(rings).toHaveAttribute('data-anchors', ANCHORS.join(','));
  await axis(page, 'topic').click({ modifiers: ['Shift'] });
  await expectShown(page, EVERYTHING);
  await expect(rings).toHaveAttribute('data-anchors', '');
});

test('documents only keeps one edge: the page to its topic', async ({ page }) => {
  await home(page);
  await axis(page, 'document').click();
  await expectShown(page, [...KIND.document, ...ANCHORS]);
  expect((await shown(page)).edges).toHaveLength(2);
});

test('the keyboard alone reaches every result: Alt+G, 0 to 5, Shift+digit', async ({ page }) => {
  await home(page);
  await page.keyboard.press('Alt+g');
  await expect(page.getByTestId('gizmo-all')).toBeFocused();
  const key = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'];
  const kinds = ['topic', 'document', 'knowledge', 'memo', 'secret'] as const;
  for (const [i, k] of kinds.entries()) {
    await page.keyboard.press(key[i]!);
    await expectShown(page, k === 'topic' ? KIND.topic : [...KIND[k], ...ANCHORS]);
  }
  await page.keyboard.press('Digit2'); await page.keyboard.press(`Shift+${key[3]}`);
  await expectShown(page, [...KIND.document, ...KIND.memo, ...ANCHORS]);
  await expect(summaryOf(page)).toHaveText('보이는 것: 문서 + 메모');
  await page.keyboard.press('Digit3'); await page.keyboard.press('Shift+Digit1');
  await expectShown(page, [...KIND.knowledge, ...KIND.topic]);
  await page.keyboard.press('Digit0');
  await expectShown(page, EVERYTHING);
  // The gizmo is one Tab stop; the arrows walk its controls, and Enter picks.
  await page.keyboard.press('ArrowRight');
  await expect(axis(page, 'topic')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(axis(page, 'document')).toBeFocused();
  await page.keyboard.press('Enter');
  await expectShown(page, [...KIND.document, ...ANCHORS]);
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('gizmo-all')).toBeFocused();
  await page.keyboard.press('Enter');
  await expectShown(page, EVERYTHING);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('[data-testid=gizmo]'))).toBeNull();
});

test('hover or focus expands the axes with their names and a direct pick', async ({ page }) => {
  await home(page);
  const pick = page.getByRole('button', { name: '메모만', exact: true });
  await expect(pick).toBeHidden();
  await page.getByTestId('gizmo').hover();
  await expect(pick).toBeVisible();
  for (const name of ['주제만', '문서만', '지식만', '메모만', '비밀 객체만']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await pick.click();
  await expectShown(page, [...KIND.memo, ...ANCHORS]);
  await page.mouse.move(700, 400);
  // The pick keeps focus, and focus keeps it open; Escape lets go.
  await expect(pick).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pick).toBeHidden();
  await page.keyboard.press('Alt+g');
  await expect(pick).toBeVisible();
});

test('a long press on a touch pointer adds the axis instead of choosing it alone', async ({ page }) => {
  await home(page);
  await axis(page, 'document').click();
  await axis(page, 'memo').dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true });
  await page.waitForTimeout(700);
  await axis(page, 'memo').dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true });
  await axis(page, 'memo').dispatchEvent('click');
  await expectShown(page, [...KIND.document, ...KIND.memo, ...ANCHORS]);
});

test('the filter is not in the address, only in this tab, and costs no KB request', async ({ page, watch }) => {
  await home(page);
  await page.waitForLoadState('networkidle');
  const url = page.url();
  const requests = watch.kb.length;
  expect(requests).toBeGreaterThan(0);
  await axis(page, 'document').click();
  await axis(page, 'memo').click({ modifiers: ['Shift'] });
  await axis(page, 'secret').click();
  await axis(page, 'topic').click({ modifiers: ['Shift'] });
  await page.keyboard.press('Alt+g'); await page.keyboard.press('Digit3'); await page.keyboard.press('Digit0');
  await expectShown(page, EVERYTHING);
  await axis(page, 'knowledge').click();
  await expectShown(page, [...KIND.knowledge, ...ANCHORS]);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  expect(page.url()).toBe(url);
  expect(decodeURIComponent(page.url())).not.toMatch(/gizmo|filter|kind|knowledge|document|memo|topic=/i);
  expect(watch.kb.length, 'no KB request between before and after the filter').toBe(requests);
  const stored = await page.evaluate(() => ({ session: JSON.stringify({ ...sessionStorage }), local: JSON.stringify({ ...localStorage }) }));
  expect(stored.session).toContain('knowledge');
  expect(stored.local).not.toMatch(/knowledge|gizmo/);
  // A reload in this tab brings the same view back from sessionStorage.
  await page.reload();
  await expect(page.getByTestId('topic-graph')).toHaveAttribute('data-layout', 'ready');
  await expectShown(page, [...KIND.knowledge, ...ANCHORS]);
  await expect(summaryOf(page)).toHaveText('보이는 것: 지식');
});

test('a node of a filtered list still opens its window', async ({ page }) => {
  await home(page);
  await axis(page, 'memo').click();
  await expectShown(page, [...KIND.memo, ...ANCHORS]);
  const note = page.getByTestId('graph-node-list').locator('[data-id="f-m0c-note"]');
  await note.focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('wm-window')).toHaveCount(1);
});
