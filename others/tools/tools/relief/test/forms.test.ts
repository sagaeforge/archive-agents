// Design 9.10: each kind reads as its own thing, colours are tokens, and the charts draw no value that is not there.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generate, large, today } from '../dev/fixtures/gen.ts';
import { layoutSnapshot } from '../server/layout/elk.ts';
import type { Box, Kind, Snapshot } from '../server/model/fact.ts';
import { formOf, RISE } from '../src/scene/forms.ts';
import { boardRuns, buildScene, sceneBounds, type SceneOpts } from '../src/scene/paint.ts';
import { project } from '../src/scene/project.ts';
import { niceMax, rateText, runs } from '../src/ui/chart.ts';
import { HEIGHT, SIZE } from '../server/layout/geometry.ts';

const NOW = Date.parse('2026-11-01T09:00:00.000Z');
const laid = async (s: Snapshot): Promise<Snapshot> => ({ ...s, ...(await layoutSnapshot(s)) });
const opts = (over: Partial<SceneOpts> = {}): SceneOpts => ({ mode: 'iso', S: 1, overlay: 'state', metric: 'cpu', nowMs: NOW, sel: null, dim: null, dense: false, ...over });
const KINDS = Object.keys(SIZE) as Kind[];
const boxOf = (k: Kind): Box => ({ x: 400, y: 100, w: k === 'node' ? 240 : SIZE[k][0], h: k === 'node' ? 160 : SIZE[k][1], z: 0, zh: HEIGHT[k] });

describe('forms', () => {
  it('every kind has a form of its own: no two kinds draw the same outline', () => {
    const seen = new Map<string, string>();
    for (const k of KINDS) {
      const b = boxOf(k); const f = formOf(k, b, project('iso', 1), 1);
      const sig = `${f.parts.map((p) => `${p.face}${p.pts.length}${p.material ?? ''}`).join()}|${f.detail.split('M').length}`;
      expect(seen.get(sig), `${k} looks like ${seen.get(sig)}`).toBeUndefined();
      seen.set(sig, k);
    }
    expect(seen.size).toBe(KINDS.length);
  });
  it('more than a cuboid, for every kind outside the guest row', () => {
    for (const k of KINDS) {
      const f = formOf(k, boxOf(k), project('iso', 1), 1);
      expect(f.parts.length > 3 || f.detail.length > 0, k).toBe(true);
    }
  });
  it('a form stays inside its footprint: the paint order of boxes holds for it', () => {
    const P = project('iso', 1);
    for (const k of KINDS.filter((x) => x !== 'domain')) {
      const b = boxOf(k); const f = formOf(k, b, (x, y, z = 0) => { expect(x, k).toBeGreaterThanOrEqual(b.x - 0.01); expect(x, k).toBeLessThanOrEqual(b.x + b.w + 0.01); expect(y, k).toBeGreaterThanOrEqual(b.y - 0.01); expect(y, k).toBeLessThanOrEqual(b.y + b.h + 0.01); return P(x, y, z); }, 1);
      expect(f.parts.length).toBeGreaterThan(0);
    }
  });
  it('rises above its box only as far as the fit of the view knows', () => {
    const P = project('iso', 1);
    for (const k of KINDS) {
      const b = boxOf(k); let top = 0;
      formOf(k, b, (x, y, z = 0) => { top = Math.max(top, z); return P(x, y, z); }, 1);
      expect(top, k).toBeLessThanOrEqual(b.z + b.zh + (RISE[k] ?? 0) + 0.01);
    }
  });
  it('a rack stands on every node, with its unit lines', async () => {
    const sc = buildScene(await laid(today()), opts());
    const n = sc.prims.find((p) => p.t === 'obj' && p.kind === 'node')!;
    expect(n.t === 'obj' && n.faces.filter((f) => f.fill.includes('rack')).length).toBe(3);
    expect(n.t === 'obj' && n.detail.split('M').length).toBeGreaterThan(9);
  });
  it('a dense overview drops the lines of a guest and keeps its shape', () => {
    const P = project('iso', 1);
    expect(formOf('vm', boxOf('vm'), P, 0.3, true).detail).toBe('');
    expect(formOf('vm', boxOf('vm'), P, 0.8, true).detail).not.toBe('');
    expect(formOf('vm', boxOf('vm'), P, 0.3, false).detail).not.toBe('');
  });
});

describe('light and basis', () => {
  it('three faces, three tokens: top, left, right', async () => {
    const sc = buildScene(await laid(today()), opts());
    const vm = sc.prims.find((p) => p.t === 'obj' && p.kind === 'vm')!;
    if (vm.t !== 'obj') throw new Error();
    expect(vm.faces.map((f) => [f.face, f.fill])).toEqual([['left', 'var(--m-vm-l)'], ['right', 'var(--m-vm-r)'], ['top', 'var(--m-vm-t)']]);
  });
  it('a declared object is striped on its main top, a derived one dashed, whatever the overlay', async () => {
    const s = await laid(large());
    for (const overlay of ['state', 'load', 'basis', 'fresh'] as const) {
      const sc = buildScene(s, opts({ overlay }));
      for (const p of sc.prims) {
        if (p.t !== 'obj' || p.faces.length === 0) continue;
        if (p.basis === 'declared') expect(p.faces.some((f) => f.fill === 'url(#declared)'), p.id).toBe(true);
        if (p.basis === 'derived') expect(p.faces.every((f) => f.dash), p.id).toBe(true);
      }
    }
  });
  it('a contact shadow lies under each level, in the 3D view only', async () => {
    const s = await laid(today());
    expect(buildScene(s, opts()).prims.filter((p) => p.t === 'path' && p.cls === 'shadow').length).toBe(4); // the floor and three nodes
    expect(buildScene(s, opts({ mode: '2d' })).prims.some((p) => p.t === 'path' && p.cls.startsWith('shadow'))).toBe(false);
  });
  it('a problem glows and is outlined once; a quiet object does neither', async () => {
    const s = await laid(today());
    const marked = { ...s, nodes: s.nodes.map((n) => (n.id === 'pve:node:node-1' ? { ...n, alerts: [{ level: 'problem' as const, text: 'x' }] } : n)) };
    const sc = buildScene(marked, opts());
    const a = sc.prims.find((p) => p.t === 'obj' && p.id === 'pve:node:node-1')!; const b = sc.prims.find((p) => p.t === 'obj' && p.id === 'pve:node:node-2')!;
    if (a.t !== 'obj' || b.t !== 'obj') throw new Error();
    expect(a.halo).toBeTruthy(); expect(a.alert).toBe('problem'); expect(a.faces.filter((f) => f.stroke === 'var(--st-critical)')).toHaveLength(1);
    expect(b.halo).toBeUndefined(); expect(b.alert).toBeUndefined();
    expect(sc.labels.find((l) => l.id === 'pve:node:node-1')?.text).toContain('문제');
  });
});

describe('cables', () => {
  it('run along the iso axes, on the floor and on a slab', async () => {
    const s = await laid(large());
    for (const r of Object.values(s.routes)) for (let i = 1; i < r.length; i++) expect(r[i]![0] === r[i - 1]![0] || r[i]![1] === r[i - 1]![1]).toBe(true);
    const P = project('iso', 1);
    const sc = buildScene(s, opts());
    const paths = sc.prims.filter((p) => p.t === 'path' && p.cls.startsWith('attach'));
    expect(paths.length).toBeGreaterThan(0);
    const dx = P(1, 0)[0]; const dy = P(1, 0)[1];
    for (const p of paths) {
      if (p.t !== 'path') continue;
      for (const sub of p.d.split('M').filter(Boolean)) {
        const pts = sub.split('L').map((q) => q.split(' ').map(Number) as [number, number]);
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i]![0] - pts[i - 1]![0]; const b = pts[i]![1] - pts[i - 1]![1];
          expect(Math.abs(Math.abs(b * dx) - Math.abs(a * dy)), sub).toBeLessThan(Math.abs(a) + 2);
        }
      }
    }
  });
  it('lie above the floor they cross', async () => {
    const s = await laid(today());
    const sc = buildScene(s, opts());
    const e = sc.prims.find((p) => p.t === 'line' && p.cls.startsWith('edge'));
    const r = Object.values(s.routes)[0]!;
    if (e?.t !== 'line') throw new Error();
    expect(Number(e.pts.split(' ')[0]!.split(',')[1])).toBeCloseTo(project('iso', 1)(r[0]![0], r[0]![1], 3)[1], 0);
    expect(sc.prims.some((p) => p.t === 'path' && p.cls === 'cable-shadow')).toBe(true);
  });
});

describe('the board', () => {
  it('holds every root object and is no bigger than they need', async () => {
    const s = await laid(today());
    const runs = boardRuns(s);
    for (const [id, o] of Object.entries(s.layout)) {
      if (o.z !== 0) continue;
      const c = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
      expect(runs.some((r) => c.x >= r.x0 && c.x <= r.x1 && c.y >= r.y0 && c.y <= r.y1), id).toBe(true);
    }
    const b = sceneBounds(s, 'iso');
    expect(Number.isFinite(b[0])).toBe(true);
  });
  it('an empty map still has a board', () => { expect(boardRuns({ ...generate({ name: 'today' }), layout: {}, routes: {} })).toHaveLength(1); });
});

describe('colours are tokens', () => {
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const files = [...readdirSync(join(src, 'scene')).map((f) => join(src, 'scene', f)), ...readdirSync(join(src, 'ui')).map((f) => join(src, 'ui', f)), join(src, 'App.tsx')];
  it.each(files.map((f) => [f.slice(src.length), f]))('%s names no literal colour', (_n, f) => {
    expect(readFileSync(f!, 'utf8').replace(/\/\/.*$/gm, '')).not.toMatch(/#[0-9a-f]{3,8}\b(?!\/)|rgba?\(/i);
  });
  it('styles.css spends raw colours in the two token blocks alone', () => {
    const css = readFileSync(join(src, 'styles.css'), 'utf8');
    const rest = css.slice(css.indexOf('*{box-sizing'));
    expect(rest).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(css).toContain(':root[data-theme=light]');
  });
});

describe('the charts', () => {
  it('a hole breaks the line: no value is drawn across it', () => {
    expect(runs([1, 2, null, null, 3])).toEqual([[[0, 1], [1, 2]], [[4, 3]]]);
    expect(runs([null, null])).toEqual([]);
  });
  it('a rate axis has a round top above the data and starts at zero', () => {
    expect(niceMax(0)).toBe(1000); expect(niceMax(47_000)).toBe(50_000); expect(niceMax(120_000)).toBe(200_000); expect(niceMax(500)).toBe(500);
  });
  it('rates read in the unit that fits', () => { expect(rateText(950)).toBe('950 B/s'); expect(rateText(1500)).toBe('1.5 KB/s'); expect(rateText(47_000)).toBe('47 KB/s'); expect(rateText(2_300_000)).toBe('2.3 MB/s'); });
});
