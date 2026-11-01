// S6 stability as a regression: adding a guest must not move anything that was already placed (design 10, 12).
import { describe, expect, it } from 'vitest';
import { large } from '../dev/fixtures/gen.ts';
import { layoutSnapshot } from '../server/layout/elk.ts';
import type { Snapshot } from '../server/model/fact.ts';

const moved = (a: Snapshot['layout'], b: Snapshot['layout']) => {
  const out: { id: string; d: number }[] = [];
  for (const [id, p] of Object.entries(a)) {
    const q = b[id]; if (!q) { out.push({ id, d: Infinity }); continue; }
    const d = Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y), Math.abs(p.w - q.w), Math.abs(p.h - q.h), Math.abs(p.z - q.z), Math.abs(p.zh - q.zh));
    if (d > 0.5) out.push({ id, d });
  }
  return out;
};

describe('stability', () => {
  it.each([1, 2, 3, 4, 5])('one guest added to node %i moves 0 objects', async (i) => {
    const before = await layoutSnapshot(large());
    const after = await layoutSnapshot(large({ addGuests: { [`pve:node:node-${i}`]: 1 } }));
    expect(Object.keys(before.layout).length).toBe(299);
    expect(Object.keys(after.layout).length).toBe(300);
    expect(moved(before.layout, after.layout)).toEqual([]);
  });
  it('the new guest gets a slot of its own on its node', async () => {
    const after = await layoutSnapshot(large({ addGuests: { 'pve:node:node-2': 1 } }));
    const added = Object.keys(after.layout).filter((id) => id.startsWith('pve:qemu:9'));
    expect(added).toHaveLength(1);
    const g = after.layout[added[0]!]!; const n = after.layout['pve:node:node-2']!;
    expect(g.x).toBeGreaterThanOrEqual(n.x); expect(g.x + g.w).toBeLessThanOrEqual(n.x + n.w);
  });
  it('the same input lays out the same way twice', async () => {
    expect(moved((await layoutSnapshot(large())).layout, (await layoutSnapshot(large())).layout)).toEqual([]);
  });
  it('a big jump (12 guests on one node) is allowed to rearrange; it is reported, not hidden', async () => {
    const a = await layoutSnapshot(large()); const b = await layoutSnapshot(large({ addGuests: { 'pve:node:node-2': 12 } }));
    console.log(`12 guests on node-2: ${moved(a.layout, b.layout).length} of ${Object.keys(a.layout).length} objects moved`);
    expect(Object.keys(b.layout).length).toBe(311);
  });
});
