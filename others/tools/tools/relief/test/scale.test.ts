// Budgets of design 13 that a unit run can check: layout time and SVG element count at 500+ objects.
import { describe, expect, it } from 'vitest';
import { large } from '../dev/fixtures/gen.ts';
import { layoutSnapshot } from '../server/layout/elk.ts';
import { estimateWidth, placeLabels } from '../src/scene/labels.ts';
import { buildScene, sceneBounds } from '../src/scene/paint.ts';

describe('547 objects', () => {
  it('lays out within 200 ms and paints within 3,000 SVG elements', async () => {
    const s = large({ nodeCount: 9, guestsPerNode: 18, containerHosts: 26 });
    expect(s.nodes.length).toBeGreaterThanOrEqual(500);
    await layoutSnapshot(s); // warm the JIT: the budget is for a steady process, not the first call
    const t = await layoutSnapshot(s);
    console.log(`layout ${s.nodes.length} objects: ${t.ms.toFixed(0)} ms`);
    expect(t.ms).toBeLessThan(200);
    const full = { ...s, ...t };
    const b = sceneBounds(full, 'iso'); const S = Math.min(1100 / (b[2] - b[0] + 48), 800 / (b[3] - b[1] + 88)) * 0.96;
    const sc = buildScene(full, { mode: 'iso', S, overlay: 'state', metric: 'cpu', nowMs: Date.now(), sel: null, dim: null, dense: true });
    const { placed } = placeLabels(sc.labels, sc.shapes, { x: -2000, y: -2000, w: 4000, h: 4000 }, { leaf: false, container: false }, estimateWidth);
    const elements = sc.prims.reduce((n, p) => n + (p.t === 'obj' ? 1 + p.faces.length + 1 : 1), 0) + placed.length * 3;
    console.log(`svg elements (estimate): ${elements}`);
    expect(elements).toBeLessThan(3000);
  });
});
