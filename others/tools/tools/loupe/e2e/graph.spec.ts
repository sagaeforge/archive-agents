// The graph screen in headless Chromium, through loupe serve. SwiftShader proves it works; no frame time here means anything (design 11).
import { test, expect, hash } from './support/test.ts';
import type { Page } from '@playwright/test';
import { rewriteKb, settled } from './support/app.ts';
import { HOSTILE, RESEARCH } from './support/ports.ts';
import type { GraphView } from '../src/graph/view.ts';

type W = { __loupeGraph: GraphView };
const G = RESEARCH;
const stage = (page: Page) => page.getByTestId('graph-screen');
const ready = async (page: Page, kind?: string) => {
  await expect(stage(page)).toHaveAttribute('data-layout', kind ?? /^(hit|soft|cold)$/, { timeout: 15_000 });
  await expect(stage(page)).toHaveAttribute('data-nodes', /^[1-9]/);
};
const nodeCount = async (page: Page) => Number(await stage(page).getAttribute('data-nodes'));
const coords = (page: Page) => page.evaluate(() => {
  const v = (window as unknown as W).__loupeGraph;
  return Object.fromEntries(v.graph.nodes().map((k) => [k, [v.graph.getNodeAttribute(k, 'x'), v.graph.getNodeAttribute(k, 'y')]]));
}) as Promise<Record<string, [number, number]>>;
const clickNode = async (page: Page, id?: string) => {
  const box = (await page.getByTestId('graph-canvas').boundingBox())!;
  const target = await page.evaluate((want) => {
    const v = (window as unknown as W).__loupeGraph;
    const id = want ?? [...v.graph.nodes()].sort((a, b) => v.graph.degree(b) - v.graph.degree(a))[0]!;
    return { id, ...v.viewportOf(id) };
  }, id);
  await page.mouse.move(box.x + target.x, box.y + target.y);
  await page.mouse.click(box.x + target.x, box.y + target.y);
  return target.id;
};
const clearCache = (page: Page) => page.evaluate(() => new Promise<void>((res) => { const r = indexedDB.deleteDatabase('loupe-layout'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
const open = async (page: Page, path = '/graph', base = G) => { await page.goto(`${base}${hash(path)}`); };
const edgePaths = (paths: string[]) => paths.filter((p) => p.startsWith('/v1/export/graph?'));

test('renders the overview from the contract, with the explicit limits and no remote or CSP trouble', async ({ page, watch }) => {
  await open(page);
  await ready(page);
  expect(await nodeCount(page)).toBeGreaterThan(10);
  const overview = watch.kbPaths().find((p) => p.startsWith('/v1/overview'))!;
  expect(overview).toContain('limit=10000');
  expect(overview).toContain('edge_limit=50000');
  expect(await page.title()).toContain('그래프');
  // Sigma's own labels are off and the overlay drew real labels.
  const state = await page.evaluate(() => { const v = (window as unknown as W).__loupeGraph; return { labels: v.overlay.drawnLabels, K: v.overlay.budget, renderLabels: v.sigma.getSetting('renderLabels'), edgeLabels: v.sigma.getSetting('renderEdgeLabels'), rotation: v.sigma.getSetting('enableCameraRotation'), attr: v.graph.getNodeAttributes(v.graph.nodes()[0]!) }; });
  expect(state.labels.length).toBeGreaterThan(0);
  expect(state.labels.length).toBeLessThanOrEqual(state.K);
  expect(state).toMatchObject({ renderLabels: false, edgeLabels: false, rotation: false });
  expect(state.attr, 'label text stays out of the `label` attribute (design 6.1)').not.toHaveProperty('label');
  expect(state.attr).toHaveProperty('l');
  const painted = await page.evaluate(() => { const c = document.querySelector<HTMLCanvasElement>('[data-testid=graph-labels]')!; const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
  expect(painted, 'the overlay put pixels on its canvas').toBeGreaterThan(100);
});

test('sigma and graphology load on the graph route only', async ({ page, watch }) => {
  void watch;
  const scripts: string[] = [];
  page.on('response', (r) => { if (r.url().endsWith('.js')) scripts.push(r.url()); });
  await page.goto(`${G}/`);
  await settled(page);
  expect(scripts.filter((u) => u.includes('graph-vendor'))).toEqual([]);
  await page.getByTestId('graph-link').click();
  await ready(page);
  expect(scripts.filter((u) => u.includes('graph-vendor'))).toHaveLength(1);
});

test('cold, then a hit that reads coordinates from IndexedDB without downloading the export', async ({ page, watch }) => {
  await open(page); await ready(page); await clearCache(page);
  await page.reload();
  await ready(page, 'cold');
  await expect(stage(page)).toHaveAttribute('data-source', 'core');
  const first = await coords(page);
  const before = edgePaths(watch.kbPaths()).length;
  expect(before).toBeGreaterThan(0);
  await page.reload();
  await ready(page, 'hit');
  expect(edgePaths(watch.kbPaths()).length, 'same manifest value: no download').toBe(before);
  expect(watch.kbPaths().filter((p) => p.startsWith('/v1/export/graph/manifest')).length).toBeGreaterThan(0);
  expect(await coords(page)).toEqual(first);
  const stored = await page.evaluate(() => new Promise<{ keys: string[]; hasLabel: boolean; n: number }>((res) => {
    const o = indexedDB.open('loupe-layout');
    o.onsuccess = () => { const q = o.result.transaction('layouts').objectStore('layouts').getAll(); q.onsuccess = () => { o.result.close(); const r = q.result[0]; res({ keys: Object.keys(r).sort(), hasLabel: JSON.stringify(r.ids).includes(' '), n: q.result.length }); }; };
  }));
  expect(stored.keys).toEqual(['at', 'community', 'hash', 'ids', 'sha', 'version', 'xy']);
  expect(stored.n).toBeLessThanOrEqual(5);
});

test('a filter changes what is shown and moves nothing', async ({ page, watch }) => {
  await open(page); await ready(page);
  const before = await coords(page);
  const all = await nodeCount(page);
  const box = page.getByTestId('graph-filter-type').locator('input').first();
  await box.uncheck();
  await expect(page).toHaveURL(/types=/);
  await expect.poll(() => nodeCount(page)).toBeLessThan(all);
  expect(watch.kbPaths().filter((p) => p.startsWith('/v1/overview')).at(-1)).toMatch(/types=/);
  const after = await coords(page);
  for (const [id, xy] of Object.entries(after)) expect(xy).toEqual(before[id]);
  await page.reload();
  await ready(page);
  expect(await nodeCount(page), 'the filter is in the URL').toBeLessThan(all);
});

test('moving the time basis keeps the coordinates (design 6.2)', async ({ page, watch }) => {
  await open(page); await ready(page);
  const before = await coords(page);
  await open(page, '/graph?as_of_observed=2026-10-31T23:00:00Z');
  await expect(page.getByTestId('time-band')).toBeVisible();
  await expect.poll(() => watch.kbPaths().some((p) => p.startsWith('/v1/overview') && p.includes('as_of_observed='))).toBe(true);
  await ready(page);
  const after = await coords(page);
  const shared = Object.keys(after).filter((id) => before[id]);
  expect(shared.length).toBeGreaterThan(0);
  for (const id of shared) expect(after[id], id).toEqual(before[id]);
});

test('selecting a node opens the panel, its link reaches the entity page, and the time basis travels', async ({ page, watch }) => {
  const T = '2026-10-31T23:00:00Z';
  await open(page, `/graph?as_of_observed=${T}`); await ready(page);
  const id = await clickNode(page);
  await expect(page.getByTestId('graph-panel')).toHaveAttribute('data-id', id);
  await expect(page).toHaveURL(new RegExp(`sel=${encodeURIComponent(id).replace(/%/g, '%')}`));
  await expect(page.getByTestId('graph-relation').first()).toBeVisible();
  await expect(page.getByTestId('time-mark').first()).toBeVisible();
  await expect(page.getByTestId('time-band')).toBeVisible();
  const dims = await page.evaluate(() => { const v = (window as unknown as W).__loupeGraph; return v.graph.nodes().filter((k) => (v.sigma.getNodeDisplayData(k)?.color ?? '') === '#e4e6ea').length; });
  expect(dims, 'a click dims the rest').toBeGreaterThan(0);
  for (const p of watch.kbPaths().filter((x) => /^\/v1\/(overview|facets)/.test(x))) expect(p).toContain('as_of_observed=');
  for (const p of watch.kbPaths().filter((x) => /^\/v1\/(export|schema|meta)/.test(x))) expect(p).not.toContain('as_of');
  await page.getByTestId('graph-panel-open').click();
  await expect(page.getByTestId('node-id')).toHaveText(id);
  await expect(page).toHaveURL(/as_of_observed=/);
});

test('the URL reproduces a selection, and clicking the stage clears it', async ({ page, watch }) => {
  void watch;
  await open(page); await ready(page);
  const id = await clickNode(page);
  const url = page.url();
  await page.goto('about:blank'); await page.goto(url);
  await ready(page);
  await expect(page.getByTestId('graph-panel')).toHaveAttribute('data-id', id);
  await page.getByTestId('graph-panel-close').click();
  await expect(page.getByTestId('graph-panel')).toHaveCount(0);
});

test('neighbour expansion adds nodes around the focus and leaves the others where they were', async ({ page, watch }) => {
  await open(page); await ready(page);
  const fx = await page.evaluate(() => { const v = (window as unknown as W).__loupeGraph; return [...v.graph.nodes()].sort((a, b) => v.graph.degree(b) - v.graph.degree(a))[0]!; });
  const mine = fx.split(':')[1]!;
  const typeName = mine[0]!.toUpperCase() + mine.slice(1);
  const all = await nodeCount(page);
  await open(page, `/graph?types=${typeName}`);
  await expect.poll(() => nodeCount(page)).toBeLessThan(all);
  await ready(page);
  const before = await coords(page);
  const small = await nodeCount(page);
  await open(page, `/graph?types=${typeName}&focus=${encodeURIComponent(fx)}`);
  await expect.poll(() => nodeCount(page), { timeout: 15_000 }).toBeGreaterThan(small);
  await expect(page.getByTestId('graph-panel')).toHaveAttribute('data-id', fx);
  expect(watch.kbPaths().some((p) => p.includes('/neighbors?') && p.includes('depth=1') && p.includes('direction=both'))).toBe(true);
  const after = await coords(page);
  for (const [id, xy] of Object.entries(before)) expect(after[id], id).toEqual(xy);
});

test('an expansion that brings a node no layout knows places it locally and moves nothing', async ({ page, watch }) => {
  void watch;
  await open(page); await ready(page);
  const fx = await page.evaluate(() => { const v = (window as unknown as W).__loupeGraph; return v.graph.nodes()[0]!; });
  const before = await coords(page);
  await rewriteKb(page, /\/neighbors/, (b) => {
    const nc: string[] = b.data.nodes.columns, ec: string[] = b.data.edges.columns;
    b.data.nodes.rows.push(nc.map((c) => ({ id: 'e:tool:expanded', label: '펼친 노드', type: 'Tool', origin: 'external', status: 'active' } as Record<string, string>)[c] ?? null));
    b.data.edges.rows.push(ec.map((c) => ({ id: 'r-expanded', src: fx, dst: 'e:tool:expanded', rtype: 'USES', status: 'active' } as Record<string, string>)[c] ?? null));
    return b;
  });
  await open(page, `/graph?focus=${encodeURIComponent(fx)}`);
  await expect(stage(page)).toHaveAttribute('data-placed', '1', { timeout: 15_000 });
  const after = await coords(page);
  expect(after).toHaveProperty(['e:tool:expanded']);
  for (const [id, xy] of Object.entries(before)) expect(after[id], id).toEqual(xy);
});

test('the panel expands a node, depth reaches the KB, and the time axes go with it', async ({ page, watch }) => {
  await open(page); await ready(page);
  await clickNode(page);
  await page.getByTestId('graph-panel-expand').click();
  await expect(page).toHaveURL(/focus=/);
  await expect.poll(() => watch.kbPaths().some((p) => p.includes('/neighbors?'))).toBe(true);
  const url = new URL(page.url());
  const h = url.hash.replace(/$/, '&depth=2&as_of_observed=2026-10-31T23:00:00Z');
  await page.goto(`${url.origin}/${h}`);
  await expect.poll(() => watch.kbPaths().some((p) => p.includes('/neighbors?') && p.includes('depth=2') && p.includes('as_of_observed='))).toBe(true);
  await ready(page);
});

test('superseded edges come on request and are dashed; parallel edges stay as keys and draw once', async ({ page, watch }) => {
  await open(page); await ready(page);
  await page.getByTestId('graph-superseded').check();
  await expect(page).toHaveURL(/edge_status=active%2Csuperseded|edge_status=active,superseded/);
  await expect.poll(() => watch.kbPaths().filter((p) => p.startsWith('/v1/overview')).at(-1)).toMatch(/edge_status=active%2Csuperseded/);
  await ready(page);
  await expect.poll(() => page.evaluate(() => { const v = (window as unknown as W).__loupeGraph; return v.graph.edges().filter((e) => v.graph.getEdgeAttribute(e, 'dashLen') === 5).length; })).toBeGreaterThan(0);
  const multi = await page.evaluate(() => { const v = (window as unknown as W).__loupeGraph; return { multi: v.graph.multi, type: v.graph.type, merged: v.graph.edges().filter((e) => v.graph.getEdgeAttribute(e, 'merged')).length, solid: v.graph.edges().filter((e) => v.graph.getEdgeAttribute(e, 'dashLen') === 1e6).length }; });
  expect(multi).toMatchObject({ multi: true, type: 'directed' });
  expect(multi.merged, 'the fixture has parallel edges').toBeGreaterThan(0);
  expect(multi.solid).toBeGreaterThan(0);
});

test('truncation shows N / total, and 20k asks first and only then widens the limits', async ({ page, watch }) => {
  await rewriteKb(page, /\/v1\/overview/, (b) => { b.data.meta.truncated = true; b.data.meta.node_total = 34567; b.data.meta.edge_total = 9; return b; });
  await open(page); await ready(page);
  await expect(page.getByTestId('graph-truncated-text')).toContainText('34,567');
  await expect(page.getByTestId('graph-truncated-text')).not.toContainText('엣지');
  await page.getByTestId('graph-wide').click();
  await expect(page.getByTestId('graph-wide-warning')).toContainText('1.6초');
  expect(watch.kbPaths().some((p) => p.includes('limit=20000'))).toBe(false);
  await page.getByTestId('graph-wide-confirm').click();
  await expect.poll(() => watch.kbPaths().some((p) => p.includes('limit=20000') && p.includes('edge_limit=100000'))).toBe(true);
  await expect(page.getByTestId('graph-wide-warning')).toHaveCount(0);
});

test('a deep link to the 20k view still asks before it reads', async ({ page, watch }) => {
  await open(page, '/graph?view=20k');
  await expect(page.getByTestId('graph-wide-warning')).toBeVisible();
  await ready(page);
  expect(watch.kbPaths().some((p) => p.includes('limit=20000'))).toBe(false);
  await page.getByTestId('graph-wide-cancel').click();
  await expect(page).not.toHaveURL(/view=20k/);
});

const fakeRenderer = (page: Page, renderer: string) => page.addInitScript((r) => {
  const real = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function (p: number) { return p === 0x9246 ? r : real.call(this, p); };
}, renderer);

test('the Radeon profile applies from the renderer string: no 20k view, K at most 100, edges hide on move', async ({ page, watch }) => {
  void watch;
  await fakeRenderer(page, 'ANGLE (AMD, AMD Radeon(TM) Graphics (0x0000164E) Direct3D11 vs_5_0 ps_5_0, D3D11)');
  await rewriteKb(page, /\/v1\/overview/, (b) => { b.data.meta.truncated = true; b.data.meta.node_total = 34567; return b; });
  await page.setViewportSize({ width: 2200, height: 1300 });
  await open(page, '/graph?view=20k'); await ready(page);
  await expect(stage(page)).toHaveAttribute('data-profile', 'radeon');
  await expect(page.getByTestId('graph-radeon')).toBeVisible();
  await expect(page.getByTestId('graph-wide-blocked')).toBeVisible();
  await expect(page.getByTestId('graph-wide')).toHaveCount(0);
  await expect(page.getByTestId('graph-wide-warning')).toHaveCount(0);
  expect(watch.kbPaths().some((p) => p.includes('limit=20000'))).toBe(false);
  const s = await page.evaluate(() => { const v = (window as unknown as W).__loupeGraph; return { hide: v.sigma.getSetting('hideEdgesOnMove'), aa: v.sigma.getSetting('antialiasEdges'), K: v.overlay.budget }; });
  expect(s).toEqual({ hide: true, aa: false, K: 100 });
});

test('the default profile on the RTX renderer keeps the measured settings', async ({ page, watch }) => {
  void watch;
  await fakeRenderer(page, 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 SUPER (0x00002702) Direct3D11 vs_5_0 ps_5_0, D3D11)');
  await open(page); await ready(page);
  await expect(stage(page)).toHaveAttribute('data-profile', 'default');
  const s = await page.evaluate(() => { const v = (window as unknown as W).__loupeGraph; return { hide: v.sigma.getSetting('hideEdgesOnMove'), aa: v.sigma.getSetting('antialiasEdges') }; });
  expect(s).toEqual({ hide: false, aa: true });
});

test('a soft miss keeps every existing coordinate and places the new node', async ({ page, watch }) => {
  void watch;
  await open(page); await ready(page);
  const before = await coords(page);
  await page.route((u) => u.pathname.endsWith('/kb/v1/export/graph/manifest'), async (route) => {
    const res = await route.fetch(); const b = await res.json();
    b.data.profiles.core.sha256 = 'f'.repeat(64);
    await route.fulfill({ response: res, json: b });
  });
  await page.route((u) => u.pathname.endsWith('/kb/v1/export/graph'), async (route) => {
    const res = await route.fetch(); const b = await res.json();
    b.nodes.rows.push(b.nodes.columns.map((c: string) => (c === 'id' ? 'e:tool:brand-new' : null)));
    await route.fulfill({ response: res, json: b });
  });
  await rewriteKb(page, /\/v1\/overview/, (b) => {
    const cols: string[] = b.data.nodes.columns;
    b.data.nodes.rows.push(cols.map((c) => ({ id: 'e:tool:brand-new', label: '새 노드', type: 'Tool', origin: 'external', status: 'active' } as Record<string, string>)[c] ?? null));
    return b;
  });
  await page.reload();
  await ready(page, 'soft');
  const after = await coords(page);
  expect(after).toHaveProperty(['e:tool:brand-new']);
  for (const [id, xy] of Object.entries(before)) expect(after[id], id).toEqual(xy);
});

test('a node in the overview and not in core is placed locally and not stored', async ({ page, watch }) => {
  void watch;
  await open(page); await ready(page);
  await rewriteKb(page, /\/v1\/overview/, (b) => {
    const cols: string[] = b.data.nodes.columns;
    b.data.nodes.rows.push(cols.map((c) => ({ id: 'e:tool:only-here', label: '여기만', type: 'Tool', origin: 'external', status: 'active' } as Record<string, string>)[c] ?? null));
    return b;
  });
  await page.reload();
  await ready(page, 'hit');
  await expect(stage(page)).toHaveAttribute('data-placed', '1');
});

test('with no published export the overview is the input', async ({ page, watch }) => {
  void watch;
  const answer = { status: 503, contentType: 'application/problem+json', headers: { 'Retry-After': '30' }, body: JSON.stringify({ type: 'about:blank', title: 'not ready', status: 503, code: 'not_ready' }) };
  await page.route((u) => u.pathname.includes('/kb/v1/export/'), (r) => r.fulfill(answer));
  await open(page); await ready(page);
  await expect(stage(page)).toHaveAttribute('data-source', 'overview');
});

test('without IndexedDB the graph still draws', async ({ page, watch }) => {
  void watch;
  await page.addInitScript(() => { IDBFactory.prototype.open = () => { throw new Error('no indexeddb'); }; });
  await open(page); await ready(page, 'cold');
  await page.reload();
  await ready(page, 'cold');
});

test('a layout worker that fails says so and the graph stays on screen', async ({ page, watch }) => {
  void watch;
  await page.addInitScript(() => {
    IDBFactory.prototype.open = () => { throw new Error('no indexeddb'); };
    const Real = window.Worker;
    window.Worker = class extends Real {
      constructor(url: string | URL, opts?: WorkerOptions) { super(url, opts); if (opts?.name === 'layout') this.postMessage = () => { setTimeout(() => this.onerror?.(new ErrorEvent('error', { message: 'boom' }))); }; }
    };
  });
  await open(page);
  await expect(page.getByTestId('graph-layout-error')).toContainText('boom', { timeout: 15_000 });
  await expect(stage(page)).toHaveAttribute('data-nodes', /^[1-9]/);
});

test('new data shows a control and does not replace the graph by itself', async ({ page, watch }) => {
  await open(page); await ready(page);
  // The next envelope to arrive is ahead of the overview on screen, as a poll would be after a publish.
  await rewriteKb(page, /\/v1\/(nodes|facets|meta|schema)/, (b) => { b.applied_seq += 5; return b; });
  await clickNode(page);
  await expect(page.getByTestId('graph-new-data')).toBeVisible({ timeout: 10_000 });
  const reads = () => watch.kbPaths().filter((p) => p.startsWith('/v1/overview')).length;
  const n = reads();
  await page.waitForTimeout(500);
  expect(reads(), 'no automatic refetch').toBe(n);
  await page.getByTestId('graph-new-data').getByRole('button').click();
  await expect.poll(reads).toBeGreaterThan(n);
});

test('a merged focus moves to the survivor and keeps the time basis', async ({ page, watch }) => {
  void watch;
  await rewriteKb(page, /\/v1\/nodes\/e%3Atool%3Agone$/, (b) => { b.data.merged_into = 'e:library:sigma-js'; b.data.merged_into_final = 'e:library:sigma-js'; return b; });
  await page.route((u) => /\/kb\/v1\/nodes\/e%3Atool%3Agone$/.test(u.pathname), async (route) => {
    const res = await route.fetch({ url: route.request().url().replace('e%3Atool%3Agone', 'e%3Alibrary%3Asigma-js') });
    const b = await res.json();
    b.data.id = 'e:tool:gone'; b.data.merged_into = 'e:library:sigma-js'; b.data.merged_into_final = 'e:library:sigma-js';
    await route.fulfill({ response: res, json: b });
  });
  await page.route((u) => /\/kb\/v1\/nodes\/e%3Atool%3Agone\/neighbors$/.test(u.pathname), (r) => r.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'not found', status: 404, code: 'not_found' }) }));
  await open(page, `/graph?focus=${encodeURIComponent('e:tool:gone')}&as_of_observed=2026-10-31T23:00:00Z`);
  await expect(page).toHaveURL(/focus=e%3Alibrary%3Asigma-js|focus=e:library:sigma-js/);
  await expect(page).toHaveURL(/as_of_observed=/);
  await expect(page.getByTestId('graph-merged-notice')).toBeVisible();
});

test('hostile ids and params in a graph link are errors and reach no KB read', async ({ page, watch }) => {
  for (const bad of ['/graph?focus=..%2F..%2Fv1%2Fops%2Fmetrics', '/graph?types=Tool%26limit%3D1', '/graph?view=50k', '/graph?depth=9']) {
    await open(page, bad);
    await expect(page.getByTestId('route-error')).toBeVisible();
  }
  expect(watch.kbPaths().filter((p) => p.startsWith('/v1/overview') || p.includes('/neighbors'))).toEqual([]);
});

test('hostile labels reach the canvas as text', async ({ page, watch }) => {
  void watch;
  await open(page, '/graph', HOSTILE); await ready(page);
  const script = '<script>alert("label")</script>', entities = '&lt;b&gt;굵게&lt;/b&gt; <b>굵게</b> &#x3C;i&#x3E;';
  const seen = await page.evaluate(() => {
    const v = (window as unknown as W).__loupeGraph;
    return { labels: Object.fromEntries(v.graph.nodes().map((k) => [k, v.graph.getNodeAttribute(k, 'l')])), drawn: v.overlay.drawnLabels };
  });
  // The strings arrive byte for byte: neither decoded, escaped nor stripped on the way to the canvas.
  expect(seen.labels['e:concept:script-in-label']).toBe(script);
  expect(seen.labels['e:concept:html-entities']).toBe(entities);
  expect(seen.drawn.length).toBeGreaterThan(0);
  for (const label of seen.drawn) expect(Object.values(seen.labels)).toContain(label);
  // The canvas host holds canvases and sigma's own layers, and no label became an element.
  const host = await page.getByTestId('graph-canvas').evaluate((el) => ({
    tags: [...new Set([...el.querySelectorAll('*')].map((e) => e.tagName))],
    text: el.textContent,
  }));
  expect(host.tags.filter((t) => !['CANVAS', 'DIV'].includes(t))).toEqual([]);
  expect(host.text).not.toContain('<script>');
  const id = await clickNode(page, 'e:concept:script-in-label');
  await expect(page.getByTestId('graph-panel')).toHaveAttribute('data-id', id);
  // In the panel the same string is text: one text node, no element from it, nothing ran.
  await expect.poll(() => page.getByTestId('graph-panel-title').evaluate((el) => el.textContent)).toBe(script);
  expect(await page.getByTestId('graph-panel-title').evaluate((el) => el.children.length)).toBe(0);
  expect(await page.locator('main').locator('script, img, iframe, object, embed, style, link, base, form').count()).toBe(0);
});

// ---- Defects found by review: each failed before its fix.
const firstNode = (page: Page) => page.evaluate(() => (window as unknown as W).__loupeGraph.graph.nodes()[0]!);
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Holds a KB response back, so a race can be staged instead of hoped for. */
const delay = (page: Page, test_: (path: string) => boolean, ms: number) => page.route((u) => test_(u.pathname), async (route) => {
  const res = await route.fetch().catch(() => null);
  if (!res) return;
  await later(ms);
  await route.fulfill({ response: res }).catch(() => undefined);
});
const coldStart = async (page: Page, path = '/graph') => {
  await open(page); await ready(page); await clearCache(page);
  await page.goto('about:blank');
  await open(page, path);
};
const detachedLabels = (page: Page) => page.evaluate(() => {
  const v = (window as unknown as W).__loupeGraph;
  const list = v.overlay.placements();
  const off = list.filter((p) => { const q = v.viewportOf(p.key); return Math.abs(q.y - p.y) > 1 || p.x < q.x || p.x - q.x > 40; });
  return { drawn: list.length, detached: off.length };
});

test('an expansion that lands during the manifest read does not fail the layout', async ({ page, watch }) => {
  void watch;
  await open(page); await ready(page);
  const fx = await firstNode(page);
  await delay(page, (p) => p.endsWith('/kb/v1/export/graph/manifest'), 900);
  await delay(page, (p) => p.endsWith('/neighbors'), 250);
  await clearCache(page);
  await page.goto('about:blank');
  await open(page, `/graph?focus=${encodeURIComponent(fx)}`);
  await ready(page, 'cold');
  await expect(page.getByTestId('graph-layout-error')).toHaveCount(0);
  await expect(stage(page)).toHaveAttribute('data-source', 'core');
});

test('a filter during the export read does not fail the layout, even for a moment', async ({ page, watch }) => {
  void watch;
  // The failure this guards against heals itself on the next data change, so the end state cannot show it.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __layouts: string[] }).__layouts = seen;
    new MutationObserver(() => { const v = document.querySelector('[data-testid=graph-screen]')?.getAttribute('data-layout'); if (v && seen.at(-1) !== v) seen.push(v); })
      .observe(document, { subtree: true, attributes: true, childList: true, attributeFilter: ['data-layout'] });
  });
  let exports = 0;
  await page.route((u) => u.pathname.endsWith('/kb/v1/export/graph'), async (route) => {
    exports++;
    const res = await route.fetch().catch(() => null);
    if (!res) return;
    await later(900);
    await route.fulfill({ response: res }).catch(() => undefined);
  });
  await open(page); await ready(page); await clearCache(page);
  await page.goto('about:blank');
  exports = 0;
  await open(page);
  await expect.poll(() => exports).toBe(1);
  await page.getByTestId('graph-filter-type').locator('input').first().uncheck();
  await expect(page).toHaveURL(/types=/);
  await ready(page, 'cold');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as unknown as { __layouts: string[] }).__layouts), 'no failed state on the way').not.toContain('failed');
  expect(exports, 'the shared read is not repeated').toBe(1);
  await expect(stage(page)).toHaveAttribute('data-source', 'core');
});

test('the seed is drawn for the data of the moment when an expansion lands first', async ({ page, watch }) => {
  void watch;
  await open(page); await ready(page);
  const fx = await firstNode(page);
  await rewriteKb(page, /\/neighbors/, (b) => {
    const nc: string[] = b.data.nodes.columns;
    b.data.nodes.rows.push(nc.map((c) => ({ id: 'e:tool:expanded', label: '펼친 노드', type: 'Tool', origin: 'external', status: 'active' } as Record<string, string>)[c] ?? null));
    return b;
  });
  await delay(page, (p) => p.endsWith('/kb/v1/export/graph'), 600);
  await clearCache(page);
  await page.goto('about:blank');
  await open(page, `/graph?focus=${encodeURIComponent(fx)}`);
  await ready(page, 'cold');
  expect(await page.evaluate(() => (window as unknown as W).__loupeGraph.graph.hasNode('e:tool:expanded'))).toBe(true);
});

test('a failed layout can be tried again', async ({ page, watch }) => {
  void watch;
  await page.addInitScript(() => {
    IDBFactory.prototype.open = () => { throw new Error('no indexeddb'); };
    const Real = window.Worker;
    let failures = 1;
    window.Worker = class extends Real {
      constructor(url: string | URL, opts?: WorkerOptions) {
        super(url, opts);
        if (opts?.name !== 'layout') return;
        const send = this.postMessage.bind(this) as (m: unknown) => void;
        this.postMessage = (m: unknown) => { if (failures-- > 0) setTimeout(() => this.onerror?.(new ErrorEvent('error', { message: 'boom' }))); else send(m); };
      }
    };
  });
  await open(page);
  await expect(page.getByTestId('graph-layout-error')).toContainText('boom', { timeout: 15_000 });
  await page.getByTestId('graph-layout-retry').click();
  await ready(page, 'cold');
  await expect(page.getByTestId('graph-layout-error')).toHaveCount(0);
});

test('labels stay beside their nodes after a cold open, a click and a resize', async ({ page, watch }) => {
  void watch;
  await coldStart(page);
  await ready(page, 'cold');
  await expect.poll(() => detachedLabels(page)).toMatchObject({ detached: 0 });
  await clickNode(page);
  await expect(page.getByTestId('graph-panel')).toBeVisible();
  await page.waitForTimeout(300);
  const afterClick = await detachedLabels(page);
  expect(afterClick.drawn).toBeGreaterThan(0);
  expect(afterClick.detached, 'the panel resizes the stage').toBe(0);
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.waitForTimeout(300);
  expect((await detachedLabels(page)).detached).toBe(0);
});

test('a cache hit has the same labels in place after a resize (control)', async ({ page, watch }) => {
  void watch;
  await open(page); await ready(page);
  await page.reload();
  await ready(page, 'hit');
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.waitForTimeout(300);
  expect((await detachedLabels(page)).detached).toBe(0);
});

test('closing the panel returns the graph to the overview', async ({ page, watch }) => {
  void watch;
  await open(page); await ready(page);
  const all = await nodeCount(page);
  const fx = await firstNode(page);
  await rewriteKb(page, /\/neighbors/, (b) => {
    const nc: string[] = b.data.nodes.columns;
    b.data.nodes.rows.push(nc.map((c) => ({ id: 'e:tool:expanded', label: '펼친 노드', type: 'Tool', origin: 'external', status: 'active' } as Record<string, string>)[c] ?? null));
    b.data.truncated = true; b.data.node_total = 999;
    return b;
  });
  await open(page, `/graph?focus=${encodeURIComponent(fx)}`);
  await expect.poll(() => nodeCount(page), { timeout: 15_000 }).toBe(all + 1);
  await expect(page.getByTestId('graph-neighbors-truncated')).toBeVisible();
  await page.getByTestId('graph-panel-close').click();
  await expect(page).not.toHaveURL(/focus=/);
  await expect.poll(() => nodeCount(page)).toBe(all);
  await expect(page.getByTestId('graph-neighbors-truncated')).toHaveCount(0);
  await expect(page.getByTestId('graph-panel')).toHaveCount(0);
});

const corrupt = (page: Page, how: string) => page.evaluate((kind) => new Promise<void>((res, rej) => {
  const o = indexedDB.open('loupe-layout');
  o.onerror = () => { rej(o.error); };
  o.onsuccess = () => {
    const tx = o.result.transaction('layouts', 'readwrite'), store = tx.objectStore('layouts'), all = store.getAll();
    all.onsuccess = () => {
      for (const r of all.result) {
        if (kind === 'ids') r.ids = 5;
        if (kind === 'short') r.xy = r.xy.slice(0, 4);
        if (kind === 'nan') r.xy[0] = Number.NaN;
        if (kind === 'infinity') r.xy[1] = Number.POSITIVE_INFINITY;
        if (kind === 'foreign') r.ids = r.ids.map((id: string) => `foreign:${id}`);
        store.put(r);
      }
    };
    tx.oncomplete = () => { o.result.close(); res(); };
  };
}), how);
const storedOk = (page: Page) => page.evaluate(() => new Promise<boolean>((res) => {
  const o = indexedDB.open('loupe-layout');
  o.onsuccess = () => {
    const q = o.result.transaction('layouts').objectStore('layouts').getAll();
    q.onsuccess = () => { o.result.close(); res(q.result.length > 0 && q.result.every((r) => Array.isArray(r.ids) && r.xy.length === r.ids.length * 2 && r.xy.every(Number.isFinite))); };
  };
}));

for (const how of ['ids', 'short', 'nan', 'infinity', 'foreign']) {
  test(`a cached layout with bad ${how} is a miss, recomputed and overwritten`, async ({ page, watch }) => {
    void watch;
    await open(page); await ready(page);
    await corrupt(page, how);
    await page.reload();
    await ready(page, 'cold');
    await expect(page.getByTestId('graph-layout-error')).toHaveCount(0);
    await expect(stage(page), 'nothing was placed around a stale record').toHaveAttribute('data-placed', '0');
    const xy = await coords(page);
    expect(Object.values(xy).flat().every(Number.isFinite)).toBe(true);
    expect(await storedOk(page), 'the bad record is gone from the store').toBe(true);
    await page.reload();
    await ready(page, 'hit');
  });
}

// ---- A load that has been superseded must leave no mark. Each race is staged: the first export or the first layout is held until the action is done.
type Instrumented = { __held?: boolean; __go?: () => void; __puts: number; __terminated: number };
const instrument = (page: Page) => page.addInitScript(() => {
  const w = window as unknown as Instrumented;
  w.__puts = 0; w.__terminated = 0;
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...a: Parameters<typeof put>) { w.__puts++; return put.apply(this, a); };
  let hold = false;
  try { hold = sessionStorage.getItem('hold-cold') === '1'; sessionStorage.removeItem('hold-cold'); } catch { /* about:blank */ }
  const Real = window.Worker;
  window.Worker = class extends Real {
    constructor(url: string | URL, opts?: WorkerOptions) {
      super(url, opts);
      if (opts?.name !== 'layout') return;
      const send = this.postMessage.bind(this) as (m: unknown) => void, stop = this.terminate.bind(this);
      this.postMessage = (m: { kind?: string }) => {
        if (hold && m.kind === 'cold') { hold = false; w.__held = true; w.__go = () => { send(m); }; } else send(m);
      };
      this.terminate = () => { w.__terminated++; stop(); };
    }
  };
});
const newDataRoutes = (page: Page) => page.route((u) => /\/kb\/v1\/(facets|meta|schema|export\/graph\/manifest)/.test(u.pathname), async (route) => {
  const res = await route.fetch().catch(() => null);
  if (!res) return;
  const b = await res.json();
  b.applied_seq += 5;
  await later(250);
  await route.fulfill({ response: res, json: b }).catch(() => undefined);
});
const instrumented = (page: Page) => page.evaluate(() => { const w = window as unknown as Instrumented; return { puts: w.__puts, terminated: w.__terminated, held: !!w.__held }; });

for (const phase of ['export', 'layout'] as const) {
  for (const action of ['retry', 'filter', 'retry+filter', 'leave'] as const) {
    test(`${action} during the ${phase}: the old load leaves no mark`, async ({ page, watch }) => {
      void watch;
      await instrument(page);
      await open(page); await ready(page);
      const final = await coords(page);
      const stageId = await firstNode(page);
      let exports = 0;
      let release = () => { /* set when the export is held */ };
      await page.route((u) => u.pathname.endsWith('/kb/v1/export/graph'), async (route) => {
        const held = phase === 'export' && ++exports === 1;
        const res = await route.fetch().catch(() => null);
        if (!res) return;
        if (held) await new Promise<void>((r) => { release = r; });
        await route.fulfill({ response: res }).catch(() => undefined);
      });
      if (action.includes('retry')) await newDataRoutes(page);
      await clearCache(page);
      if (phase === 'layout') await page.evaluate(() => { sessionStorage.setItem('hold-cold', '1'); });
      await page.goto('about:blank');
      await open(page);
      if (phase === 'export') await expect.poll(() => exports).toBe(1);
      else await expect.poll(async () => (await instrumented(page)).held).toBe(true);

      if (action.includes('retry')) await page.getByTestId('graph-new-data').getByRole('button').click({ timeout: 8_000 });
      if (action.includes('filter')) {
        await page.getByTestId('graph-filter-type').locator('input').first().uncheck();
        await expect(page).toHaveURL(/types=/);
      }
      if (action === 'leave') {
        await page.getByTestId('brand').click();
        await expect(page.getByTestId('graph-screen')).toHaveCount(0);
      } else if (action.includes('retry')) {
        await ready(page, 'cold');
      }

      // The old load gets its chance to speak up.
      release();
      await page.evaluate(() => { (window as unknown as Instrumented).__go?.(); });
      await page.waitForTimeout(700);

      if (action === 'leave') {
        expect((await instrumented(page)).puts, 'nothing is stored by a screen that is gone').toBe(0);
        if (phase === 'layout') expect((await instrumented(page)).terminated).toBeGreaterThan(0);
        await page.getByTestId('graph-link').click();
        await ready(page, 'cold');
      }
      await expect(stage(page)).toHaveAttribute('data-layout', 'cold', { timeout: 15_000 });
      await expect(page.getByTestId('graph-progress')).toHaveCount(0);
      await expect(page.getByTestId('graph-layout-error')).toHaveCount(0);
      const shown = await coords(page);
      expect(Object.keys(shown).length).toBeGreaterThan(0);
      for (const [id, xy] of Object.entries(shown)) expect(xy, `${id} is at its layout position, not its seed`).toEqual(final[id]);
      const after = await instrumented(page);
      expect(after.puts, 'one load wrote one layout').toBe(1);
      if (phase === 'layout' && action.includes('retry')) expect(after.terminated, 'the dropped computation was stopped').toBeGreaterThan(0);
      void stageId;
    });
  }
}

test('no horizontal scroll and the stage keeps its size on a narrow window', async ({ page, watch }) => {
  void watch;
  await page.setViewportSize({ width: 480, height: 800 });
  await open(page); await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const box = (await page.getByTestId('graph-canvas').boundingBox())!;
  expect(box.width).toBeGreaterThan(300);
  expect(box.height).toBeGreaterThan(200);
});
