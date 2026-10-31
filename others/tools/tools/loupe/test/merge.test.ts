import { describe, expect, it } from 'vitest';
import { followMerge, MAX_MERGE_HOPS, type MergeNode } from '../src/entity/merge.ts';
import { KbProblem, KbUnavailable } from '../src/data/kbFetch.ts';

const graph = (g: Record<string, MergeNode>) => async (id: string) => {
  const n = g[id];
  if (!n) throw new KbProblem({ type: 'x', title: 'not found', status: 404, code: 'not_found' });
  return n;
};

describe('following merged_into (design 5)', () => {
  it('goes straight to merged_into_final when the KB gives it', async () => {
    const seen: string[] = [];
    const r = await followMerge('a', { merged_into: 'b', merged_into_final: 'c' }, async (id) => { seen.push(id); return { merged_into: null }; });
    expect(r).toEqual({ kind: 'survivor', id: 'c', path: ['a', 'c'] });
    expect(seen).toEqual(['c']);
  });
  it('walks merged_into when there is no final', async () => {
    expect(await followMerge('a', { merged_into: 'b' }, graph({ b: { merged_into: 'c' }, c: {} }))).toEqual({ kind: 'survivor', id: 'c', path: ['a', 'b', 'c'] });
  });
  it('a cycle is an error', async () => {
    expect((await followMerge('a', { merged_into: 'b' }, graph({ b: { merged_into: 'a' } }))).kind).toBe('cycle');
    expect((await followMerge('a', { merged_into: 'a' }, graph({}))).kind).toBe('cycle');
  });
  it('stops after 5 hops', async () => {
    const g: Record<string, MergeNode> = {};
    for (let i = 1; i < 20; i++) g[`n${i}`] = { merged_into: `n${i + 1}` };
    const r = await followMerge('n0', { merged_into: 'n1' }, graph(g));
    expect(r.kind).toBe('too-deep');
    expect(r.path).toHaveLength(MAX_MERGE_HOPS + 1);
  });
  it('exactly 5 hops is fine', async () => {
    const g: Record<string, MergeNode> = { n5: {} };
    for (let i = 1; i < 5; i++) g[`n${i}`] = { merged_into: `n${i + 1}` };
    expect(await followMerge('n0', { merged_into: 'n1' }, graph(g))).toMatchObject({ kind: 'survivor', id: 'n5' });
  });
  it('a hidden or missing survivor is a tombstone', async () => {
    expect(await followMerge('a', { merged_into: 'b' }, graph({}))).toEqual({ kind: 'gone', id: 'b', path: ['a', 'b'] });
  });
  it('anything else is not a merge verdict: it propagates', async () => {
    await expect(followMerge('a', { merged_into: 'b' }, async () => { throw new KbUnavailable('network', 'down'); })).rejects.toBeInstanceOf(KbUnavailable);
  });
});
