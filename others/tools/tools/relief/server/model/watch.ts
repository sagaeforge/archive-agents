// What relief remembers between reads (design 9.14): the objects it has seen, kept in state.json. An object that vanishes or a guest that dies leaves no value to compare,
// so "no warnings" would read as healthy. The memory turns the absence into a finding.
import { z } from 'zod';
import type { Task } from '../collect/pve.ts';
import type { Alert, Entity } from './fact.ts';

export type Known = { kind: 'node' | 'vm' | 'lxc'; title: string; running: boolean; at: string };
export type Missing = { id: string; kind: string; title: string; since: string };
export type Watch = { known: Record<string, Known>; missing: Record<string, Missing>; crashed: Record<string, string> };
export const emptyWatch = (): Watch => ({ known: {}, missing: {}, crashed: {} });

/** Far past a real cluster. What it stops is a file or a churn that grows without end. */
export const MAX_WATCHED = 5000;
const text = z.string().max(200);
const Saved = z.strictObject({
  known: z.record(text, z.strictObject({ kind: z.enum(['node', 'vm', 'lxc']), title: text, running: z.boolean(), at: text })),
  missing: z.record(text, z.strictObject({ id: text, kind: text, title: text, since: text })),
  crashed: z.record(text, text),
});

/** What state.json holds under `watch`, or null if it is not that. The file can be damaged or hand-edited: nothing downstream should have to care. */
export function parseWatch(v: unknown): Watch | null {
  const r = Saved.safeParse(v);
  if (!r.success) return null;
  const size = Math.max(Object.keys(r.data.known).length, Object.keys(r.data.missing).length, Object.keys(r.data.crashed).length);
  return size > MAX_WATCHED ? null : r.data;
}

/** Keeps the most recently seen when ids churn past the cap, and what they cost goes with them. */
function capped(w: Watch): Watch {
  const ids = Object.keys(w.known);
  if (ids.length <= MAX_WATCHED) return w;
  const out: Watch = { known: { ...w.known }, missing: { ...w.missing }, crashed: { ...w.crashed } };
  for (const id of ids.sort((a, b) => w.known[a]!.at.localeCompare(w.known[b]!.at)).slice(0, ids.length - MAX_WATCHED)) { delete out.known[id]; delete out.missing[id]; delete out.crashed[id]; }
  return out;
}

/** Drops an object from memory. Something still on the map stays: the next read would only bring it back. */
export function forget(w: Watch, id: string, present: ReadonlySet<string>): { watch: Watch; reply: { result: 'removed'; kind: string; title: string } | { result: 'unknown' } | { result: 'present' } } {
  const k = w.known[id];
  if (!k) return { watch: w, reply: { result: 'unknown' } };
  if (present.has(id)) return { watch: w, reply: { result: 'present' } };
  const out: Watch = { known: { ...w.known }, missing: { ...w.missing }, crashed: { ...w.crashed } };
  delete out.known[id]; delete out.missing[id]; delete out.crashed[id];
  return { watch: out, reply: { result: 'removed', kind: k.kind, title: k.title } };
}

const WATCHED = new Set<Entity['kind']>(['node', 'vm', 'lxc']);
const STOPS = new Set(['qmstop', 'qmshutdown', 'vzstop', 'vzshutdown', 'qmsuspend', 'vzsuspend']);
const DESTROYS = new Set(['qmdestroy', 'vzdestroy']);
const GRACE_S = 60; // A task can start a little before the read that saw the guest last running.

const vmidOf = (id: string) => id.split(':')[2] ?? '';
const hostOf = (e: Entity) => e.parent?.split(':')[2] ?? '';
const since = (t: Task, at: string) => t.start >= Date.parse(at) / 1000 - GRACE_S;
const stopTask = (e: Entity, tasks: readonly Task[], at: string) => tasks.some((t) => since(t, at) && ((t.id === vmidOf(e.id) && STOPS.has(t.type)) || (t.type === 'stopall' && t.node === hostOf(e))));
const destroyTask = (id: string, tasks: readonly Task[], at: string) => tasks.some((t) => since(t, at) && t.id === vmidOf(id) && DESTROYS.has(t.type));

/** One good inventory read. Never called with a failed one: only a read that answered can say something is not there. */
export function advance(w: Watch, nodes: readonly Entity[], tasks: readonly Task[], at: string): Watch {
  const next: Watch = { known: { ...w.known }, missing: { ...w.missing }, crashed: { ...w.crashed } };
  const here = new Set<string>();
  for (const e of nodes) {
    if (!WATCHED.has(e.kind) || e.gone) continue;
    here.add(e.id);
    delete next.missing[e.id];
    const prev = w.known[e.id];
    const running = e.state === 'running' || e.state === 'starting';
    if (e.kind !== 'node') {
      if (running) delete next.crashed[e.id];
      else if (e.state === 'stopped' && prev?.running && !stopTask(e, tasks, prev.at)) next.crashed[e.id] = at;
      else if (next.crashed[e.id] && stopTask(e, tasks, w.known[e.id]?.at ?? at)) delete next.crashed[e.id];
    }
    next.known[e.id] = { kind: e.kind as Known['kind'], title: e.title, running, at: running || !prev ? at : prev.at };
  }
  for (const [id, k] of Object.entries(next.known)) {
    if (here.has(id)) continue;
    if (destroyTask(id, tasks, k.at)) { delete next.known[id]; delete next.missing[id]; delete next.crashed[id]; continue; }
    next.missing[id] ??= { id, kind: k.kind, title: k.title, since: at };
  }
  return capped(next);
}

export type Expected = ReadonlyMap<string, 'running' | 'stopped'>;

/** The alerts of a guest: what the person declared overrides what relief inferred. */
export function applyWatch(nodes: readonly Entity[], w: Watch, expected: Expected): Entity[] {
  return nodes.map((e) => {
    if (e.kind !== 'vm' && e.kind !== 'lxc') return e;
    const want = expected.get(vmidOf(e.id));
    const alert: Alert | null = want === 'running' ? (e.state === 'stopped' ? { level: 'problem', text: '실행 예정인데 중지' } : null)
      : want === 'stopped' || e.state !== 'stopped' || !w.crashed[e.id] ? null : { level: 'warn', text: '예상 밖 중지' };
    return alert ? { ...e, alerts: [...(e.alerts ?? []), alert] } : e;
  });
}
