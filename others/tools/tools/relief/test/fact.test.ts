import { describe, expect, it } from 'vitest';
import { basisNote, freshness, reviewPassed, staleIds, validateSnapshot, type Fact, type Snapshot } from '../server/model/fact.ts';
import { large, today } from '../dev/fixtures/gen.ts';

const NOW = Date.parse('2026-11-01T09:00:00.000Z');
const obs = (ageS: number, ttlS: number | null = 45): Fact<number> => ({ value: 1, basis: 'observed', source: 'pve:/x', at: new Date(NOW - ageS * 1000).toISOString(), ttlS });

describe('freshness table (design 4)', () => {
  it.each([[0, 'fresh'], [45, 'fresh'], [45.5, 'stale'], [600, 'stale']] as const)('age %s s with ttl 45 is %s', (age, want) => {
    expect(freshness(obs(age), NOW)).toBe(want);
  });
  it('only observed facts with a ttl go stale', () => {
    expect(freshness({ value: 1, basis: 'declared', source: 'edge.json#/x', at: '2020-01-01', ttlS: null }, NOW)).toBe('n/a');
    expect(freshness({ value: 1, basis: 'derived', source: 'rule:same-subnet', at: '2020-01-01T00:00:00Z', ttlS: null }, NOW)).toBe('n/a');
    expect(freshness({ value: null, basis: 'unknown', source: 'x', at: null, ttlS: null }, NOW)).toBe('n/a');
  });
  it('an observed fact without a readable time is stale, not fresh', () => {
    expect(freshness({ ...obs(0), at: null }, NOW)).toBe('stale');
  });
  it('a declared fact past its review date keeps its basis and gains a note', () => {
    const f: Fact<string> = { value: 'x', basis: 'declared', source: 'edge.json#/lines/0', at: '2026-11-01', ttlS: null, reviewBy: '2026-10-15' };
    expect(reviewPassed(f, NOW)).toBe(true);
    expect(basisNote(f, NOW)).toBe('선언 · 2026-11-01 · 검토일 지남');
    expect(reviewPassed({ ...f, reviewBy: '2027-02-01' }, NOW)).toBe(false);
  });
  it('panel wording follows the table', () => {
    expect(basisNote(obs(12), NOW)).toBe('관측 · 12초 전');
    expect(basisNote(obs(240, 900), NOW)).toBe('관측 · 4분 전');
    expect(basisNote(obs(100), NOW)).toBe('관측 · 1분 전 · 낡음');
    expect(basisNote({ value: 1, basis: 'derived', source: 'rule:same-subnet', at: null, ttlS: null }, NOW)).toBe('추정 · same-subnet');
    expect(basisNote({ value: null, basis: 'unknown', source: 'x', at: null, ttlS: null, why: 'guest agent 응답 없음' }, NOW)).toBe('미확인 · guest agent 응답 없음');
  });
  it('age comes from the fact, not from the snapshot clock', () => {
    const s = today();
    s.takenAt = new Date(NOW).toISOString();
    const n = s.nodes.find((x) => x.id === 'pve:node:node-1')!;
    n.facts.state = obs(500);
    expect(staleIds(s, NOW).has(n.id)).toBe(true);
  });
  it('a stale node dims everything on it, and only that node', () => {
    const s = large();
    const stale = staleIds(s, NOW);
    expect(stale.has('pve:node:node-4')).toBe(true);
    for (const n of s.nodes.filter((x) => x.parent === 'pve:node:node-4')) expect(stale.has(n.id), n.id).toBe(true);
    expect(stale.has('pve:node:node-1')).toBe(false);
    expect(s.nodes.filter((x) => x.parent === 'pve:node:node-1').every((x) => !stale.has(x.id))).toBe(true);
  });
  it('today has nothing stale', () => { expect(staleIds(today(), NOW).size).toBe(0); });
});

describe('validateSnapshot', () => {
  it('accepts the generated shapes', () => {
    expect(validateSnapshot(today())).toEqual([]);
    expect(validateSnapshot(large())).toEqual([]);
  });
  it('rejects a fact without a basis, a dangling parent, an unknown fact with a value', () => {
    const s: Snapshot = today();
    delete (s.nodes[0]!.facts.state as { basis?: string }).basis;
    s.nodes[1]!.parent = 'nope';
    const bad = validateSnapshot(s);
    expect(bad.some((b) => b.includes('not a fact'))).toBe(true);
    expect(bad.some((b) => b.includes('parent nope missing'))).toBe(true);
    const t = today();
    (t.nodes[0]!.facts.state as { value: unknown }).value = 'x'; (t.nodes[0]!.facts.state as { basis: string }).basis = 'unknown';
    expect(validateSnapshot(t).some((b) => b.includes('unknown fact carries a value'))).toBe(true);
  });
});
