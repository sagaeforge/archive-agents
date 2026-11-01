// Change detection (design 8): a hash per object, without the values that move on their own.
import { createHash } from 'node:crypto';
import type { Entity, Relation, State } from './fact.ts';

/** Counters. In the hash they would make every read a change. */
const VOLATILE = new Set(['cpu', 'mem', 'disk']);

const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
};

const stable = (facts: Entity['facts']) => Object.fromEntries(Object.entries(facts).filter(([k]) => !VOLATILE.has(k)).map(([k, f]) => [k, [f.value, f.basis]]));

export const entityHash = (e: Entity) => createHash('sha256').update(canonical({ id: e.id, kind: e.kind, title: e.title, parent: e.parent ?? null, state: e.state, basis: e.basis, facts: stable(e.facts) })).digest('hex');
const relationHash = (r: Relation) => createHash('sha256').update(canonical({ id: r.id, source: r.source, target: r.target, kind: r.kind, basis: r.basis, facts: stable(r.facts) })).digest('hex');

export type Hashes = Record<string, string>;
export type StateMap = Record<string, State>;

export const hashesOf = (nodes: Entity[], edges: Relation[]): Hashes => Object.fromEntries([
  ...nodes.filter((n) => !n.gone).map((n) => [n.id, entityHash(n)] as const),
  ...edges.map((e) => [`edge:${e.id}`, relationHash(e)] as const),
]);

export type Change = { added: string[]; removed: string[]; changed: string[]; state: { id: string; from: State; to: State }[] };

export function diff(prev: Hashes, next: Hashes, prevState: StateMap, nextState: StateMap): Change {
  const added = Object.keys(next).filter((k) => !(k in prev));
  const removed = Object.keys(prev).filter((k) => !(k in next));
  const changed = Object.keys(next).filter((k) => k in prev && prev[k] !== next[k]);
  const state = changed.flatMap((id) => (prevState[id] && nextState[id] && prevState[id] !== nextState[id] ? [{ id, from: prevState[id], to: nextState[id] }] : []));
  return { added, removed, changed, state };
}

export const isEmpty = (c: Change) => !c.added.length && !c.removed.length && !c.changed.length;
