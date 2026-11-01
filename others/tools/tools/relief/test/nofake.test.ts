// No-fake (design 1 criterion 3, 12): switch a source off and nothing that stands on it may remain, and its layer must say "no source".
import { describe, expect, it } from 'vitest';
import { generate, large, today } from '../dev/fixtures/gen.ts';
import { checkNoFake } from '../server/model/rules.ts';
import { tierCards } from '../src/model.ts';

const NOW = Date.parse('2026-11-01T09:00:00.000Z');
const state = (s: ReturnType<typeof generate>, id: string) => s.sources.find((x) => x.id === id)!.state;

const combos = [false, true].flatMap((pve) => [false, true].flatMap((edge) => [false, true].map((docker) => ({ pve, edge, docker }))));

describe.each(['today', 'large'] as const)('%s', (name) => {
  it.each(combos)('pve=$pve edge=$edge docker=$docker: no object stands on a missing source', (o) => {
    const s = generate({ name, ...o });
    expect(checkNoFake(s)).toEqual([]);
    if (!o.docker) { expect(s.nodes.filter((n) => n.kind === 'container')).toHaveLength(0); expect(state(s, 'docker')).toBe('none'); }
    if (!o.edge) { expect(s.nodes.filter((n) => n.basis === 'declared')).toHaveLength(0); expect(state(s, 'edge')).toBe('none'); }
    if (!o.pve) {
      expect(s.nodes.filter((n) => ['node', 'vm', 'lxc', 'bridge', 'storage'].includes(n.kind))).toHaveLength(0);
      expect(state(s, 'pve')).toBe('none');
      // a rule with no input makes nothing
      expect(s.nodes.filter((n) => n.basis === 'derived')).toHaveLength(0);
    }
  });
  it('without an edge source the WAN is a blank box, never a declared line', () => {
    const wan = generate({ name, edge: false }).nodes.filter((n) => n.kind === 'wan');
    expect(wan).toHaveLength(1);
    expect(wan[0]!.basis).toBe('unknown'); expect(wan[0]!.title).toContain('미확인');
  });
});

describe('the checker itself', () => {
  it('catches a container whose source is off', () => {
    const s = large(); s.sources.find((x) => x.id === 'docker')!.state = 'none';
    expect(checkNoFake(s).length).toBeGreaterThan(0);
  });
  it('catches an observed fact that names a source with no status', () => {
    const s = today(); s.sources = s.sources.filter((x) => x.id !== 'pve');
    expect(checkNoFake(s).length).toBeGreaterThan(0);
  });
});

describe('0 and unknown are different (design 4)', () => {
  it('a failing source that never read says it has no value', () => {
    const s = today(); const p = s.sources.find((x) => x.id === 'pve')!; p.state = 'failing'; p.why = 'tower 응답 없음'; p.at = null;
    expect(find(s, '노드')).toBe('수집 실패 · tower 응답 없음 · 값 없음');
  });
  const find = (s: ReturnType<typeof today>, tier: string) => tierCards(s, NOW).find((c) => c.tier === tier)!.text;
  it('today: Docker has no source, guests were read and there are none beyond the VM', () => {
    const s = today();
    expect(find(s, 'Docker')).toBe('출처 없음');
    expect(find(s, '외부')).toContain('출처 없음');
    expect(find(s, '게스트')).toBe('QEMU 1 · LXC 0');
  });
  it('a source that was read and found empty says 0, not "no source"', () => {
    const s = generate({ name: 'large', guestsPerNode: 0, containerHosts: 0 });
    expect(find(s, 'Docker')).toBe('0개 관측');
    expect(find(s, '게스트')).toContain('0개 관측');
  });
  it('a failing source says failure and keeps its last value', () => {
    const s = today(); const p = s.sources.find((x) => x.id === 'pve')!; p.state = 'failing'; p.why = 'tower 응답 없음';
    expect(find(s, '노드')).toBe('수집 실패 · tower 응답 없음 · 12초 전');
  });
});
