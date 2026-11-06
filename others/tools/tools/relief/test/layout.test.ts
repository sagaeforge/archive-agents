import { describe, expect, it } from 'vitest';
import { large, today } from '../dev/fixtures/gen.ts';
import { layoutSnapshot } from '../server/layout/elk.ts';

describe('layout', () => {
  it('places every entity and keeps children on their parent', async () => {
    const s = large();
    const { layout } = await layoutSnapshot(s);
    for (const n of s.nodes) expect(layout[n.id], n.id).toBeDefined();
    for (const n of s.nodes.filter((x) => x.parent)) {
      const p = layout[n.parent!]!; const c = layout[n.id]!;
      expect(c.z).toBe(p.z + p.zh);
      expect(c.x).toBeGreaterThanOrEqual(p.x); expect(c.y).toBeGreaterThanOrEqual(p.y);
      expect(c.x + c.w).toBeLessThanOrEqual(p.x + p.w + 0.01); expect(c.y + c.h).toBeLessThanOrEqual(p.y + p.h + 0.01);
    }
  });
  it('lands an uplink on the west edge at its bridge (design 17, item 1)', async () => {
    const s = today();
    const { layout, routes } = await layoutSnapshot(s);
    const e = s.edges.find((x) => x.kind === 'uplink')!;
    const br = layout[String(e.facts.via!.value)]!; const slab = layout[e.target]!;
    const end = routes[e.id]!.at(-1)!;
    expect(end[0]).toBeCloseTo(slab.x, 0);
    expect(end[1]).toBeCloseTo(br.y + br.h / 2, 0);
  });
});
