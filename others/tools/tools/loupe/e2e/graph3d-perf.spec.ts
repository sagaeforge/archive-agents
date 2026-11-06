// Measurement, not a gate: first-frame time and frame rate of the 3D home graph at 1,000 and 10,000 nodes (the home draws at most 20 topics
// with 500 neighbours each). Run with LOUPE_PERF=1. Headless Chromium here renders in software (SwiftShader), so the figures bound a real GPU from
// above: compare them between sizes and renderers, not against the 8 ms budget of a GPU window.
import type { Page } from '@playwright/test';
import { test, expect } from './support/test.ts';
import { RESEARCH } from './support/ports.ts';

const PER_TOPIC_EDGES = 4;
type Perf = { stats: { setDataMs: number; digestMs: number; firstFrameMs: number; nodes: number; links: number }; holdAwake(on: boolean): void; renderedFrames: number; pick(x: number, y: number): string | null; draw(): void; viewportOf(id: string): { x: number; y: number } };

/** `topics` topics with `per` neighbours each: nodes = topics * (per + 1), about PER_TOPIC_EDGES edges per neighbour inside its topic. */
async function synthetic(page: Page, topics: number, per: number) {
  const tid = (t: number) => `e:topic:p${t}`, nid = (t: number, j: number) => `e:tool:p${t}-${j}`;
  await page.route('**/kb/v1/nodes?**', async (route) => {
    const res = await route.fetch(); const body = await res.json();
    const tpl = body.data.items[0];
    body.data.items = Array.from({ length: topics }, (_, t) => ({ ...tpl, id: tid(t), label: `주제 ${t}` }));
    await route.fulfill({ response: res, json: body });
  });
  await page.route('**/kb/v1/nodes/*/neighbors**', async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!);
    const t = Number(/^e:topic:p(\d+)$/.exec(id)?.[1] ?? -1);
    const real = new URL(route.request().url()); real.pathname = real.pathname.replace(/nodes\/[^/]+\/neighbors/, 'nodes/e%3Atopic%3Am0c/neighbors');
    const res = await route.fetch({ url: real.toString() }); const body = await res.json();
    const nodes: unknown[][] = [[tid(t), 'Topic', `주제 ${t}`, 'first_party', 'active']], edges: unknown[][] = [];
    for (let j = 0; j < per; j++) {
      nodes.push([nid(t, j), 'Tool', `도구 ${t}-${j}`, 'first_party', 'active']);
      edges.push([`r${t}-${j}-a`, nid(t, j), tid(t), 'IN_TOPIC', 'active']);
      for (let k = 1; k < PER_TOPIC_EDGES; k++) edges.push([`r${t}-${j}-${k}`, nid(t, j), nid(t, (j * (k + 2) + k * 7 + 1) % per), 'RELATED', 'active']);
    }
    body.data.nodes = { columns: ['id', 'type', 'label', 'origin', 'status'], rows: nodes };
    body.data.edges = { columns: ['id', 'src', 'dst', 'rtype', 'status'], rows: edges };
    await route.fulfill({ response: res, json: body });
  });
}

const SIZES = [['260 nodes', 20, 12], ['500 nodes', 20, 24], ['1,000 nodes', 20, 49], ['2,000 nodes', 20, 99], ['3,000 nodes', 20, 149], ['4,000 nodes', 20, 199], ['10,000 nodes', 20, 499]] as const;
const only = process.env.LOUPE_PERF_SIZES?.split(',');

async function open(page: Page, topics: number, per: number, mode: '3d' | '2d') {
  await page.addInitScript((g) => localStorage.setItem('loupe.appearance', JSON.stringify({ theme: 'light', size: 'normal', motion: 'system', graph: g })), mode);
  await synthetic(page, topics, per);
  const t0 = Date.now();
  await page.goto(RESEARCH + '/#/');
  await expect(page.getByTestId('topic-graph')).toHaveAttribute('data-layout', 'ready', { timeout: 200_000 });
  return Date.now() - t0;
}

for (const [name, topics, per] of SIZES) {
  test(`3D at ${name}: first frame and frame rate`, async ({ page }) => {
    test.skip(!process.env.LOUPE_PERF || (!!only && !only.includes(name.replace(/\D/g, ''))), 'measurement only: set LOUPE_PERF=1');
    test.setTimeout(240_000);
    const layoutMs = await open(page, topics, per, '3d');
    // 'ready' also fires for the first neighbour answers: wait until every topic's neighbours are in and a frame has been drawn with them.
    await expect.poll(() => page.evaluate(() => { const s = (window as unknown as { __loupeGraph: Perf }).__loupeGraph.stats; return s.nodes * (s.firstFrameMs > 0 ? 1 : 0); }), { timeout: 120_000 }).toBe(topics * (per + 1));
    const out = await page.evaluate(async () => {
      const v = (window as unknown as { __loupeGraph: Perf }).__loupeGraph;
      const stats = { ...v.stats };
      v.holdAwake(true);
      await new Promise((r) => setTimeout(r, 500));
      const f0 = v.renderedFrames, t = performance.now();
      await new Promise((r) => setTimeout(r, 4000));
      const fps = ((v.renderedFrames - f0) * 1000) / (performance.now() - t);
      v.holdAwake(false);
      // The cost of one pointer pick (projects every node) and of one overlay draw, as the CPU sees them.
      const n = 30; const p0 = performance.now(); for (let i = 0; i < n; i++) v.pick(680, 400); const pickMs = (performance.now() - p0) / n;
      const d0 = performance.now(); for (let i = 0; i < n; i++) v.draw(); const drawMs = (performance.now() - d0) / n;
      return { stats, fps, pickMs, drawMs };
    });
    const line = `${name}: ${JSON.stringify({ ...out, layoutReadyMs: layoutMs })}`;
    console.log('PERF3D ' + line);
    test.info().annotations.push({ type: 'perf', description: line });
    expect(out.stats.nodes).toBe(topics * (per + 1));
    expect(out.fps).toBeGreaterThan(0);
  });

  // The same data and the same software renderer through sigma, so the 3D figures have something to be read against.
  test(`2D at ${name}: first frame and frame rate`, async ({ page }) => {
    test.skip(!process.env.LOUPE_PERF || (!!only && !only.includes(name.replace(/\D/g, ''))), 'measurement only: set LOUPE_PERF=1');
    test.setTimeout(240_000);
    const layoutMs = await open(page, topics, per, '2d');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __loupeGraph: { graph: { order: number } } }).__loupeGraph.graph.order), { timeout: 120_000 }).toBe(topics * (per + 1));
    const out = await page.evaluate(async () => {
      type S = { refresh(o?: object): void; once(e: string, f: () => void): void };
      type V2 = { sigma: S; graph: { order: number; forEachNode(f: (k: string, a: { x: number; y: number; l: string }) => void): void; forEachEdge(f: (k: string, a: object, s: string, t: string) => void): void }; setData(g: object, p: Map<string, object>): void };
      const v = (window as unknown as { __loupeGraph: V2 }).__loupeGraph;
      const frame = () => new Promise<void>((r) => { v.sigma.once('afterRender', r); });
      const nodes: { id: string; label: string; type: string; status: string }[] = [], pos = new Map<string, object>(), edges: object[] = [];
      v.graph.forEachNode((k, a) => { nodes.push({ id: k, label: a.l, type: 'Tool', status: 'active' }); pos.set(k, { x: a.x, y: a.y, community: 0 }); });
      v.graph.forEachEdge((k, _a, s, t) => { edges.push({ id: k, src: s, dst: t, rtype: 'R', status: 'active' }); });
      const t0 = performance.now(); const done = frame(); v.setData({ nodes, edges }, pos); await done;
      const firstFrameMs = performance.now() - t0;
      const n = 30, t1 = performance.now();
      for (let i = 0; i < n; i++) { const f = frame(); v.sigma.refresh(); await f; }
      return { nodes: nodes.length, edges: edges.length, firstFrameMs, fps: (n * 1000) / (performance.now() - t1) };
    });
    const line = `${name}: ${JSON.stringify({ ...out, layoutReadyMs: layoutMs })}`;
    console.log('PERF2D ' + line);
    test.info().annotations.push({ type: 'perf', description: line });
    expect(out.nodes).toBe(topics * (per + 1));
  });
}
