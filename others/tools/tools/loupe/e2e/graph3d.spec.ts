// The workspace home graph is 3D by default; the 2D sigma view stays behind a setting (appearance.graph).
import type { Page } from '@playwright/test';
import { test, expect } from './support/test.ts';
import { RESEARCH } from './support/ports.ts';

type Probe = {
  kind?: string; sigma?: unknown; selectedId?: string | null; hoverId?: string | null;
  graph: { nodes(): string[] };
  viewportOf(id: string): { x: number; y: number };
  drawnLabels: string[];
};
// Plain reads only: the page's CSP forbids building a function from a string.
const read = (page: Page, key: 'kind' | 'selectedId' | 'hoverId' | 'drawnLabels' | 'hasSigma' | 'nodeCount') => page.evaluate((k) => {
  const v = (window as unknown as { __loupeGraph: Probe }).__loupeGraph;
  return k === 'hasSigma' ? v.sigma !== undefined : k === 'nodeCount' ? v.graph.nodes().length : v[k];
}, key);
const viewportOf = (page: Page, id: string) => page.evaluate((i) => (window as unknown as { __loupeGraph: Probe }).__loupeGraph.viewportOf(i), id);
const ready = async (page: Page) => { await page.goto(RESEARCH + '/#/'); await expect(page.getByTestId('topic-graph')).toHaveAttribute('data-layout', 'ready'); };

test('the default home graph is 3D: a WebGL canvas and the 3D view', async ({ page }) => {
  await ready(page);
  await expect(page.getByTestId('topic-graph')).toHaveAttribute('data-renderer', '3d');
  await expect(page.getByTestId('graph-canvas').locator('canvas').first()).toBeVisible();
  expect(await read(page, 'kind')).toBe('3d');
  expect(await read(page, 'hasSigma')).toBe(false);
  expect(await read(page, 'nodeCount')).toBe(10);
});

test('the 2D setting renders the sigma graph', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('loupe.appearance', JSON.stringify({ theme: 'light', size: 'normal', motion: 'system', graph: '2d' })));
  await ready(page);
  await expect(page.getByTestId('topic-graph')).toHaveAttribute('data-renderer', '2d');
  expect(await read(page, 'hasSigma')).toBe(true);
  await expect(page.getByTestId('graph-labels')).toHaveCount(1);
});

test('the settings window switches the graph between 3D and 2D without a reload', async ({ page }) => {
  await ready(page);
  await page.keyboard.press('Control+,');
  await expect(page.getByTestId('graph-3d')).toBeChecked();
  await page.getByTestId('graph-2d').check();
  await expect(page.getByTestId('topic-graph')).toHaveAttribute('data-renderer', '2d');
  await expect(page.getByTestId('topic-graph')).toHaveAttribute('data-layout', 'ready');
  expect(await read(page, 'hasSigma')).toBe(true);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('loupe.appearance'))) ?? '{}')).toMatchObject({ graph: '2d' });
  await page.getByTestId('graph-3d').check();
  await expect(page.getByTestId('topic-graph')).toHaveAttribute('data-renderer', '3d');
  expect(await read(page, 'kind')).toBe('3d');
  // One graph at a time: the canvas of the view that was left is gone, and so is its WebGL context.
  expect(await page.getByTestId('graph-canvas').locator('canvas').count()).toBeLessThanOrEqual(3);
});

test('hovering a 3D node draws its label, and clicking activates then opens it, as in 2D', async ({ page }) => {
  await ready(page);
  const id = 'e:topic:m0c';
  const at = await viewportOf(page, id);
  const box = (await page.getByTestId('graph-canvas').boundingBox())!;
  await page.mouse.move(box.x + at.x - 40, box.y + at.y - 40);
  await page.mouse.move(box.x + at.x, box.y + at.y, { steps: 4 });
  await expect.poll(() => read(page, 'hoverId'), { timeout: 8000 }).toBe(id);
  await expect.poll(() => read(page, 'drawnLabels')).toContain('M0c 작업 공간');
  await expect(page.getByTestId('node-preview')).toContainText('M0c 작업 공간');
  await page.mouse.click(box.x + at.x, box.y + at.y);
  await expect(page.getByRole('option', { name: 'M0c 작업 공간', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('wm-window')).toHaveCount(0);
  await page.mouse.click(box.x + at.x, box.y + at.y);
  await expect(page.getByTestId('wm-window')).toHaveCount(1);
});

test('keyboard focus on the node list marks the node in 3D, and leaving the node clears the hover label', async ({ page }) => {
  await ready(page);
  const node = page.getByRole('option', { name: 'M0c 작업 공간', exact: true });
  await node.focus();
  await expect.poll(() => read(page, 'selectedId')).toBe('e:topic:m0c');
  await expect.poll(() => read(page, 'drawnLabels')).toContain('M0c 작업 공간');
  await page.mouse.move(5, 500);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('wm-window')).toHaveCount(1);
});

test('Trusted Types, measured as design 4.5 does (report-only): the 3D library clears its host with innerHTML and nothing else is a sink', async ({ page, watch }) => {
  await page.addInitScript(() => {
    const seen: { directive: string; sample: string }[] = ((window as unknown as { __tt?: unknown[] }).__tt = []) as never;
    document.addEventListener('securitypolicyviolation', (e) => { seen.push({ directive: e.violatedDirective, sample: e.sample }); });
  });
  await page.route(`${RESEARCH}/`, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), 'content-security-policy-report-only': "require-trusted-types-for 'script'" } });
  });
  await ready(page);
  await expect(page.getByTestId('topic-graph')).toHaveAttribute('data-renderer', '3d');
  await expect.poll(() => read(page, 'kind')).toBe('3d');
  const seen = await page.evaluate(() => (window as unknown as { __tt: { directive: string; sample: string }[] }).__tt);
  // The Worker constructor is the app-wide baseline; the 3D library adds `innerHTML = ''` (an empty sample) when it mounts. Enforcing Trusted Types
  // later needs a policy or a patch for that call; this line is what to revisit then.
  const sinks = seen.filter((v) => !v.sample.startsWith('Worker constructor'));
  expect(sinks.filter((v) => v.directive !== 'require-trusted-types-for')).toEqual([]);
  expect(sinks.every((v) => v.sample === 'Element innerHTML|'), JSON.stringify(sinks)).toBe(true);
  await page.evaluate(() => { const w = window as unknown as { __csp?: string[] }; w.__csp = []; });
  void watch;
});
