// What the database views of the open windows keep outside React, so a view that is re-rendered, hidden or built again (the edit toggle of a window builds its editor again)
// finds its filter and its save machines where it left them (design v2 2.7: a window keeps its state while it is open). Both are keyed by the window; the shell releases a
// window's part when the window is closed (`retain`). Nothing here is persisted: a filter is not a record and not a thing to restore after a reload.
// This file is small on purpose: the shell loads it with the first screen. The save machines are made in savers.ts, which only the editor chunk loads.
import { useSyncExternalStore } from 'react';

export type Filter = { text: string; tag: string; status: 'active' | 'dead' };
const keyOf = (scope: string, source: string) => `${scope}\u0000${source}`;

const filters = new Map<string, Filter>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export const filterStore = {
  /** The filter the person set in this view of this window, or `initial` (the view's own, from its definition). `initial` must be the same object between calls. */
  get: (scope: string, source: string, initial: Filter): Filter => filters.get(keyOf(scope, source)) ?? initial,
  set(scope: string, source: string, patch: Partial<Filter>, initial: Filter) {
    const k = keyOf(scope, source);
    filters.set(k, { ...(filters.get(k) ?? initial), ...patch });
    emit();
  },
  /** "필터 지우기": nothing narrows, and the status is the default one. */
  clear(scope: string, source: string) { filters.set(keyOf(scope, source), { text: '', tag: '', status: 'active' }); emit(); },
};
/** The view's filter as React state; it is the same object until a setter changes it. */
export function useFilter(scope: string, source: string, initial: Filter): Filter {
  return useSyncExternalStore(subscribe, () => filterStore.get(scope, source, initial));
}

const held = new Map<string, { scope: string; dispose: () => void }>();
/** Keeps something that belongs to a window (a save machine) until the window closes: `make` runs once per key, and the thing it returns is released by `dispose`. */
export function holdFor<T extends { dispose: () => void }>(scope: string, id: string, make: () => T): T {
  const k = keyOf(scope, id);
  let h = held.get(k) as { scope: string; dispose: () => void; value: T } | undefined;
  if (!h) { const value = make(); h = { scope, dispose: () => value.dispose(), value }; held.set(k, h); }
  return h.value;
}

/** The shell calls this with the ids of the windows that are open: everything kept for another window goes. */
export function retain(open: ReadonlySet<string>) {
  let changed = false;
  for (const k of [...filters.keys()]) if (!open.has(k.slice(0, k.indexOf('\u0000')))) { filters.delete(k); changed = true; }
  for (const [k, h] of [...held]) if (!open.has(h.scope)) { h.dispose(); held.delete(k); }
  if (changed) emit();
}
