// What this tab follows beyond what the KB lists (design v2 7.2, 5.9, 3): research specs with their `existing:true` flag, write references,
// action ids, saves the KB refused (record, rule and time only: never a value or a title) and records a phone handed over (M11).
// M1 writes here when it makes a request; this step only reads. Ids and rule names only, never a title or a body.
import { parseKbId } from '../ids.ts';

export const TASK_REGISTRY_KEY = 'loupe.tasks.v1';
const CAP = 50;
export type Registry = {
  research: { spec: string; existing: boolean }[];
  writes: string[];
  actions: string[];
  rejected: { record: string; rule: string; at: string }[];
  handoff: { id: string; at: string }[];
};
export const emptyRegistry = (): Registry => ({ research: [], writes: [], actions: [], rejected: [], handoff: [] });

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): string | null => (typeof v === 'string' && parseKbId(v).ok ? v : null);
const rule = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(v) ? v : null);
const time = (v: unknown): string | null => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null);
const many = <T>(v: unknown, one: (x: unknown) => T | null): T[] => (Array.isArray(v) ? v.slice(0, CAP).map(one).filter((x): x is T => x !== null) : []);
const uniq = <T,>(xs: T[], key: (x: T) => string) => xs.filter((x, i) => xs.findIndex((y) => key(y) === key(x)) === i);

/** Anything that is not the expected shape is dropped; storage is untrusted input like any other. */
export function parseRegistry(raw: string | null): Registry {
  let v: unknown;
  try { v = JSON.parse(raw ?? 'null'); } catch { return emptyRegistry(); }
  if (!isRec(v)) return emptyRegistry();
  return {
    research: uniq(many(v.research, (x) => { const s = isRec(x) ? id(x.spec) : null; return s ? { spec: s, existing: isRec(x) && x.existing === true } : null; }), (x) => x.spec),
    writes: uniq(many(v.writes, id), (x) => x),
    actions: uniq(many(v.actions, id), (x) => x),
    rejected: uniq(many(v.rejected, (x) => { if (!isRec(x)) return null; const r = id(x.record), u = rule(x.rule), at = time(x.at); return r && u && at ? { record: r, rule: u, at } : null; }), (x) => x.record),
    handoff: uniq(many(v.handoff, (x) => { if (!isRec(x)) return null; const i = id(x.id), at = time(x.at); return i && at ? { id: i, at } : null; }), (x) => x.id),
  };
}
export function readRegistry(): Registry {
  try { return parseRegistry(globalThis.sessionStorage?.getItem(TASK_REGISTRY_KEY) ?? null); } catch { return emptyRegistry(); }
}

// ---- M1: what a save adds to the registry (design v2 5.2, 5.9, 3). Ids and rule names only: never a title, a body or a value.
function update(edit: (r: Registry) => Registry): void {
  try {
    const store = globalThis.sessionStorage;
    if (!store) return;
    const next = edit(readRegistry());
    store.setItem(TASK_REGISTRY_KEY, JSON.stringify({ ...next, writes: next.writes.slice(0, CAP), rejected: next.rejected.slice(0, CAP) }));
  } catch { /* storage denied: the write is still followed by the window that made it */ }
}
/** A 202 (`spooled`/`held`): the task list follows the ref until the KB commits it, or it fails and the person discards it. */
export const trackWrite = (ref: string) => update((r) => ({ ...r, writes: uniq([ref, ...r.writes], (x) => x) }));
export const untrackWrite = (ref: string) => update((r) => ({ ...r, writes: r.writes.filter((x) => x !== ref) }));
/** A save the KB refused (422) or stored as `secret` (quarantine): the record, the rule and the time. One entry per record. */
export const trackRejected = (e: { record: string; rule: string; at: string }) => update((r) => ({ ...r, rejected: [e, ...r.rejected.filter((x) => x.record !== e.record)] }));
export const untrackRejected = (record: string) => update((r) => ({ ...r, rejected: r.rejected.filter((x) => x.record !== record) }));
