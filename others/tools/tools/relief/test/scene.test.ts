import { describe, expect, it } from 'vitest';
import { large, today } from '../dev/fixtures/gen.ts';
import { layoutSnapshot } from '../server/layout/elk.ts';
import type { Snapshot } from '../server/model/fact.ts';
import { estimateWidth, inPolygon, PILL_H, placeLabels } from '../src/scene/labels.ts';
import { buildScene, sceneBounds, type SceneOpts } from '../src/scene/paint.ts';
import { paintOrder, project } from '../src/scene/project.ts';
import { loadColor } from '../src/scene/style.ts';

const NOW = Date.parse('2026-11-01T09:00:00.000Z');
const laid = async (s: Snapshot): Promise<Snapshot> => ({ ...s, ...(await layoutSnapshot(s)) });
const opts = (S: number, over: Partial<SceneOpts> = {}): SceneOpts => ({ mode: 'iso', S, overlay: 'state', metric: 'cpu', nowMs: NOW, sel: null, dim: null, dense: false, ...over });
const fitS = (s: Snapshot, mode: 'iso' | '2d', w = 1100, h = 800) => { const b = sceneBounds(s, mode); return Math.min(w / (b[2] - b[0] + 48), h / (b[3] - b[1] + 88)) * 0.96; };

describe('projection', () => {
  it('iso: x - y goes right, x + y goes down, z goes up', () => {
    const P = project('iso', 1);
    expect(P(0, 0, 0)).toEqual([0, 0]);
    const [x, y] = P(10, 10, 0); expect(x).toBeCloseTo(0); expect(y).toBeCloseTo(10);
    expect(P(0, 0, 5)[1]).toBe(-5);
    const [a] = P(10, 0, 0); const [b] = P(0, 10, 0); expect(a).toBeGreaterThan(0); expect(b).toBeLessThan(0);
  });
  it('2d: the floor as it is, z ignored', () => {
    expect(project('2d', 2)(3, 4, 99)).toEqual([6, 8]);
  });
});

describe('paint order (back to front)', () => {
  const r = (x: number, y: number, w = 10, h = 10) => ({ x, y, w, h });
  it('puts a box behind another first', () => {
    const a = r(0, 0); const b = r(20, 0); const c = r(0, 20);
    const o = paintOrder([b, c, a]);
    expect(o.indexOf(a)).toBeLessThan(o.indexOf(b)); expect(o.indexOf(a)).toBeLessThan(o.indexOf(c));
  });
  it('never loses a box and never puts a box in front of one it hides, on the real layout', async () => {
    const s = await laid(large());
    const roots = s.nodes.filter((n) => !n.parent).map((n) => ({ id: n.id, ...s.layout[n.id]! }));
    const o = paintOrder(roots);
    expect(o).toHaveLength(roots.length);
    const before = (a: typeof roots[0], b: typeof roots[0]) => (a.x + a.w <= b.x && a.y < b.y + b.h && b.y < a.y + a.h) || (a.y + a.h <= b.y && a.x < b.x + b.w && b.x < a.x + a.w);
    for (let i = 0; i < o.length; i++) for (let j = 0; j < i; j++) expect(before(o[i]!, o[j]!), `${o[i]!.id} drawn after ${o[j]!.id}`).toBe(false);
  });
});

describe('scene', () => {
  it('every object carries its basis, and the load overlay fills by value', async () => {
    const s = await laid(today());
    const sc = buildScene(s, opts(1, { overlay: 'load' }));
    const objs = sc.prims.filter((p) => p.t === 'obj');
    expect(objs).toHaveLength(s.nodes.length);
    for (const p of objs) expect(['observed', 'derived', 'declared', 'unknown']).toContain(p.basis);
    const node = objs.find((p) => p.id === 'pve:node:node-1')!;
    expect(node.t === 'obj' && node.faces.some((f) => f.face === 'load')).toBe(true);
    expect(loadColor(0.3)).not.toBe(loadColor(0.9));
  });
  it('marks a stale object dim and an unknown one hollow', async () => {
    const s = await laid(large());
    const sc = buildScene(s, opts(1));
    const stale = sc.prims.find((p) => p.t === 'obj' && p.id === 'pve:node:node-4');
    const fresh = sc.prims.find((p) => p.t === 'obj' && p.id === 'pve:node:node-1');
    expect(stale?.t === 'obj' && stale.opacity).toBe(0.5); expect(fresh?.t === 'obj' && fresh.opacity).toBe(1);
    const t = buildScene(await laid(today()), opts(1));
    const wan = t.prims.find((p) => p.t === 'obj' && p.kind === 'wan');
    expect(wan?.t === 'obj' && wan.faces.every((f) => f.fill === '#ffffff' && f.dash)).toBe(true);
  });
  it('draws no Docker plane for an empty layer', async () => {
    for (const s of [today(), large()]) {
      const sc = buildScene(await laid(s), opts(1));
      expect(sc.prims.some((p) => p.t === 'poly' && p.id === 'plane-docker')).toBe(false);
      expect(sc.labels.some((l) => l.id === 'plane-docker')).toBe(false);
    }
  });
  it('2d draws the top face only', async () => {
    const sc = buildScene(await laid(today()), opts(1, { mode: '2d' }));
    for (const p of sc.prims) if (p.t === 'obj') expect(p.faces.every((f) => f.face === 'top' || f.face === 'load')).toBe(true);
  });
});

describe.each([['today', today], ['large', large]] as const)('labels on %s', (_name, gen) => {
  it.each(['iso', '2d'] as const)('%s: no two placed labels overlap, none leave the view, node labels sit on their own slab', async (mode) => {
    const s = await laid(gen());
    const S = fitS(s, mode);
    const dense = s.nodes.length >= 60;
    const sc = buildScene(s, opts(S, { mode, dense }));
    const b = sceneBounds(s, mode);
    const cx = ((b[0] + b[2]) / 2) * S; const cy = ((b[1] + b[3]) / 2) * S;
    const view = { x: cx - 550, y: cy - 400, w: 1100, h: 800 };
    const { placed } = placeLabels(sc.labels, sc.shapes, view, { leaf: !dense, container: !dense }, estimateWidth);
    expect(placed.length).toBeGreaterThan(0);
    for (let i = 0; i < placed.length; i++) {
      const a = placed[i]!;
      expect(a.x).toBeGreaterThanOrEqual(view.x); expect(a.x + a.w).toBeLessThanOrEqual(view.x + view.w);
      for (let j = i + 1; j < placed.length; j++) {
        const c = placed[j]!;
        expect(a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h, `${a.id} / ${c.id}`).toBe(false);
      }
    }
    // Design 17, item 9: a node label point lies on the node's own top face, so it cannot read as another slab's label.
    // A slab's label stands on its own face, or beside it with a leader line to its face: never bare on another slab.
    for (const l of placed) {
      const cand = sc.labels.find((c) => c.id === l.id)!;
      if (cand.kind === 'node') expect(l.lead ? inPolygon(l.anchor!, cand.top) : inPolygon(l.at, cand.top), l.id).toBe(true);
    }
    // Every node gets a label at fit zoom.
    for (const n of s.nodes.filter((x) => x.kind === 'node')) expect(placed.some((l) => l.id === n.id), n.id).toBe(true);
  });
  it('a lower priority label gives way to a higher one', () => {
    const view = { x: 0, y: 0, w: 400, h: 200 };
    // Two labels that want the same single spot: the higher priority gets it. A view this small leaves no other spot.
    const mk = (id: string, pr: number) => ({ id, text: id, pr, anchor: null, top: [], leaf: false, kind: 'node', box: { x: 190, y: 90, w: 20, h: 20 }, own: [], onOwn: true, strips: [[200, 100]] as [number, number][] });
    const tight = { x: 150, y: 88, w: 100, h: PILL_H + 6 };
    const { placed, hidden } = placeLabels([mk('low', 4), mk('high', 0)], [], tight, { leaf: true, container: true }, estimateWidth);
    expect(placed.map((p) => p.id)).toEqual(['high']); expect(hidden).toEqual(['low']);
  });
});
