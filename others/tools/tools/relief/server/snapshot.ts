// Serves a fixture as a snapshot: lays it out once, and shifts its clock so the data always looks as fresh as when it was recorded.
import { readFileSync } from 'node:fs';
import type { Fact, Snapshot } from './model/fact.ts';
import { validateSnapshot } from './model/fact.ts';
import { layoutSnapshot } from './layout/elk.ts';
import { large } from '../dev/fixtures/gen.ts';

// `scale` is generated, not stored: 547 objects for the 500-object measurement (design 14, Phase 1).
export const FIXTURES = ['today', 'large', 'scale'] as const;
export type FixtureName = (typeof FIXTURES)[number];
export const isFixture = (v: unknown): v is FixtureName => typeof v === 'string' && (FIXTURES as readonly string[]).includes(v);

const dir = new URL('../fixtures/', import.meta.url);
const cache = new Map<FixtureName, Promise<Snapshot>>();

async function build(name: FixtureName): Promise<Snapshot> {
  const raw = name === 'scale'
    ? large({ nodeCount: 9, guestsPerNode: 18, containerHosts: 26 })
    : (JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8')) as Snapshot);
  const bad = validateSnapshot(raw);
  if (bad.length) throw new Error(`fixture ${name}: ${bad.slice(0, 3).join('; ')}`);
  const { layout, routes } = await layoutSnapshot(raw);
  return { ...raw, layout, routes };
}

const isTime = (v: string | null | undefined): v is string => typeof v === 'string' && v.includes('T');
const shiftIso = (v: string, ms: number) => new Date(Date.parse(v) + ms).toISOString();

/** Moves every timestamp by the same amount. Dates without a time (declarations) stay where they are. */
export function rebase(s: Snapshot, nowMs: number): Snapshot {
  const ms = nowMs - Date.parse(s.takenAt);
  const fact = (f: Fact<unknown>): Fact<unknown> => (isTime(f.at) ? { ...f, at: shiftIso(f.at, ms) } : f);
  const facts = (m: Record<string, Fact<unknown>>) => Object.fromEntries(Object.entries(m).map(([k, f]) => [k, fact(f)]));
  return {
    ...s,
    takenAt: new Date(nowMs).toISOString(),
    nodes: s.nodes.map((n) => ({ ...n, facts: facts(n.facts) })),
    edges: s.edges.map((e) => ({ ...e, facts: facts(e.facts) })),
    sources: s.sources.map((x) => (isTime(x.at) ? { ...x, at: shiftIso(x.at, ms) } : x)),
  };
}

export function loadFixture(name: FixtureName, nowMs = Date.now()): Promise<Snapshot> {
  let p = cache.get(name);
  if (!p) { p = build(name); cache.set(name, p); p.catch(() => cache.delete(name)); }
  return p.then((s) => rebase(s, nowMs));
}
