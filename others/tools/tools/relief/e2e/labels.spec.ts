// Labels must never hide an object (design 9.5, 17 items 5, 7, 9): a label rectangle may touch only its own anchor and the surface it stands on.
import { expect, test, type Page } from '@playwright/test';
import { BUILT } from './support/ports.ts';

const open = async (page: Page, hash: string) => {
  await page.goto(`${BUILT}/${hash}`);
  await page.waitForSelector('svg.scene g[data-id]');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
};

/**
 * Label rectangles that cover an object's drawn faces (not its bounding box: slabs and their neighbours always share boxes).
 * Allowed: a node's own label on its slab, and any label on the surface of an ancestor.
 */
const covers = () => {
  type P = [number, number];
  const rectHitsPoly = (r: { left: number; top: number; right: number; bottom: number }, poly: P[]) => {
    const inRect = (p: P) => p[0] > r.left + 0.5 && p[0] < r.right - 0.5 && p[1] > r.top + 0.5 && p[1] < r.bottom - 0.5;
    const inPoly = (p: P) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i]!; const [xj, yj] = poly[j]!; if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c; } return c; };
    const corners: P[] = [[r.left + 0.5, r.top + 0.5], [r.right - 0.5, r.top + 0.5], [r.right - 0.5, r.bottom - 0.5], [r.left + 0.5, r.bottom - 0.5]];
    if (poly.some(inRect) || corners.some(inPoly)) return true;
    const seg = (a: P, b: P, c: P, d: P) => { const o = (p: P, q: P, t: P) => Math.sign((q[0] - p[0]) * (t[1] - p[1]) - (q[1] - p[1]) * (t[0] - p[0])); return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b); };
    for (let i = 0; i < poly.length; i++) for (let j = 0; j < 4; j++) if (seg(poly[i]!, poly[(i + 1) % poly.length]!, corners[j]!, corners[(j + 1) % 4]!)) return true;
    return false;
  };
  const objs = [...document.querySelectorAll('svg.scene g[data-id]')] as SVGGElement[];
  const polys = new Map(objs.map((o) => [o, [...o.querySelectorAll('polygon')].map((f) => {
    const m = (f as SVGGraphicsElement).getScreenCTM()!;
    return f.getAttribute('points')!.trim().split(/\s+/).map((q) => { const [x, y] = q.split(',').map(Number); return [m.a * x! + m.e, m.d * y! + m.f] as P; });
  })]));
  const parent = new Map(objs.map((o) => [o.dataset.id!, o.dataset.parent]));
  const out: string[] = [];
  for (const l of document.querySelectorAll('.lb')) {
    const id = (l as SVGGElement).dataset.for!; const r = l.querySelector('rect')!.getBoundingClientRect();
    const anc = new Set<string>(); for (let p = parent.get(id); p; p = parent.get(p)) anc.add(p);
    for (const o of objs) {
      if (anc.has(o.dataset.id!)) continue;
      if (o.dataset.id === id && o.dataset.kind === 'node') continue;
      if (polys.get(o)!.some((poly) => rectHitsPoly(r, poly))) out.push(`${id} covers ${o.dataset.id}`);
    }
  }
  return out;
};

for (const [name, hash] of [['today-3d', '#/?fx=today'], ['today-2d', '#/?fx=today&mode=2d'], ['large-3d', '#/?fx=large'], ['large-2d', '#/?fx=large&mode=2d']] as const) {
  test(`${name}: no label covers an object`, async ({ page }) => {
    await open(page, hash);
    expect(await page.evaluate(covers)).toEqual([]);
  });
}

for (const [name, hash] of [['today-3d', '#/?fx=today'], ['today-2d', '#/?fx=today&mode=2d']] as const) {
  test(`${name}: every object keeps a visible label, none hidden by collision`, async ({ page }) => {
    await open(page, hash);
    const r = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('svg.scene g[data-id]')].map((o) => (o as SVGElement).dataset.id!);
      const labelled = new Set([...document.querySelectorAll('.lb')].map((l) => (l as SVGGElement).dataset.for!));
      const svg = document.querySelector('svg.scene')!;
      return { missing: ids.filter((i) => !labelled.has(i)), objects: ids.length, labels: labelled.size, collision: svg.getAttribute('data-hidden-collision') };
    });
    expect(r.missing).toEqual([]);
    expect(r.labels).toBe(r.objects);
    expect(r.collision).toBe('0');
  });
}

test('large-3d: labels hidden by zoom level and labels hidden by collision are counted apart', async ({ page }) => {
  await open(page, '#/?fx=large');
  const svg = page.locator('svg.scene');
  const lod = Number(await svg.getAttribute('data-hidden-lod')); const col = Number(await svg.getAttribute('data-hidden-collision'));
  console.log(`large-3d hidden by level of detail: ${lod}, by collision: ${col}`);
  expect(lod).toBeGreaterThan(200);
  // every slab keeps its label: collisions may cost a gateway or a segment, never a node
  expect(col).toBeLessThanOrEqual(2);
  for (const n of [1, 2, 3, 4, 5]) await expect(page.locator(`.lb[data-for="pve:node:node-${n}"]`)).toHaveCount(1);
});
