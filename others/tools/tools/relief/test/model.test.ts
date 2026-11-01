import { describe, expect, it } from 'vitest';
import { large, today } from '../dev/fixtures/gen.ts';
import { layoutSnapshot } from '../server/layout/elk.ts';
import type { Snapshot } from '../server/model/fact.ts';
import { project } from '../src/scene/project.ts';
import { holes, neighbour, searchMatches, treeRows } from '../src/model.ts';
import { DEFAULT_VIEW, formatHash, parseHash } from '../src/state.ts';

const laid = async (s: Snapshot): Promise<Snapshot> => ({ ...s, ...(await layoutSnapshot(s)) });

describe('url hash state (design 9.4)', () => {
  it('round-trips', () => {
    const v = { ...DEFAULT_VIEW, mode: '2d' as const, overlay: 'load' as const, metric: 'mem' as const, sel: 'pve:qemu:100', open: true, fx: 'large' as const, q: '결제' };
    expect(parseHash(formatHash(v))).toEqual(v);
  });
  it('writes nothing for the default and survives garbage', () => {
    expect(formatHash(DEFAULT_VIEW)).toBe('#/');
    expect(parseHash('#/?mode=sideways&overlay=x&fx=../../etc')).toEqual(DEFAULT_VIEW);
    expect(parseHash('').sel).toBeNull();
  });
  it('the spec example link parses', () => {
    expect(parseHash('#/?mode=iso&overlay=load&sel=pve:qemu:100')).toMatchObject({ mode: 'iso', overlay: 'load', sel: 'pve:qemu:100', open: false });
  });
});

describe('search (NFC)', () => {
  it('matches a decomposed Hangul query against composed titles', () => {
    const s = large();
    const composed = s.nodes.find((n) => n.title.startsWith('결제'))!;
    const hits = searchMatches(s, '결제'.normalize('NFD'));
    expect(hits?.has(composed.id)).toBe(true);
  });
  it('finds by address and returns null for an empty query', () => {
    const s = today();
    expect(searchMatches(s, '192.0.2.11')?.has('pve:node:node-1')).toBe(true);
    expect(searchMatches(s, '  ')).toBeNull();
  });
});

describe('tree', () => {
  it('lists every object once, children under parents', () => {
    const s = large(); const rows = treeRows(s, null);
    expect(rows).toHaveLength(299);
    const idx = new Map(rows.map((r, i) => [r.id, i]));
    for (const n of s.nodes.filter((x) => x.parent)) expect(idx.get(n.parent!)!).toBeLessThan(idx.get(n.id)!);
  });
  it('a filtered tree keeps the ancestors of a match', () => {
    const s = large(); const id = s.nodes.find((n) => n.kind === 'container')!.id;
    const ids = treeRows(s, new Set([id])).map((r) => r.id);
    expect(ids).toContain(id); expect(ids.length).toBe(3);
  });
});

describe('holes', () => {
  it('today: VM 100 has an unknown IP and OS with the reason, and the map says what to do', () => {
    const h = holes(today());
    const ip = h.find((x) => x.key === 'ip')!;
    expect(ip.why).toBe('guest agent 응답 없음'); expect(ip.ids).toEqual(['pve:qemu:100']); expect(ip.action).toContain('qemu-guest-agent');
  });
});

describe('keyboard navigation', () => {
  it('arrows move among siblings in the screen direction; [ and ] go to the parent and the first child', async () => {
    const s = await laid(large());
    const ids = s.nodes.filter((n) => n.kind === 'node').map((n) => n.id);
    expect(neighbour(s, null, 'right', 'iso')).toBe(ids[0]);
    // Moving down the screen reaches a sibling that lies lower on the screen.
    const down = neighbour(s, ids[0]!, 'down', 'iso')!;
    expect(down).not.toBe(ids[0]);
    const cy = (id: string) => { const b = s.layout[id]!; return project('iso', 1)(b.x + b.w / 2, b.y + b.h / 2, b.z + b.zh)[1]; };
    expect(cy(down)).toBeGreaterThan(cy(ids[0]!));
    const child = neighbour(s, ids[0]!, ']', 'iso')!;
    expect(s.nodes.find((n) => n.id === child)!.parent).toBe(ids[0]);
    expect(neighbour(s, child, '[', 'iso')).toBe(ids[0]);
    expect(neighbour(s, ids[0]!, '[', 'iso')).toBeNull();
  });
  it('stays put when nothing lies that way', async () => {
    const s = await laid(today());
    const id = 'pve:node:node-1';
    const dirs = ['left', 'right', 'up', 'down'] as const;
    for (const d of dirs) { const n = neighbour(s, id, d, '2d'); expect(typeof n).toBe('string'); }
  });
});
