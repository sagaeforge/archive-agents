// What the shell needs to know about the memo windows without loading them: whether one holds unsaved text (the dock chip, the close question,
// the tab warning) and what to call it. The memo window writes here; nothing of the text is kept.
import { useSyncExternalStore } from 'react';

export type MemoInfo = { dirty: boolean; label: string; askClose: boolean };
let infos: ReadonlyMap<string, MemoInfo> = new Map();
const listeners = new Set<() => void>();
const disposers = new Map<string, () => void>();
const emit = () => listeners.forEach((l) => l());
const DEFAULT: MemoInfo = { dirty: false, label: '메모', askClose: false };

export const memoStore = {
  get: () => infos,
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  info: (id: string): MemoInfo => infos.get(id) ?? DEFAULT,
  set(id: string, patch: Partial<MemoInfo>) {
    const prev = infos.get(id) ?? DEFAULT, next = { ...prev, ...patch };
    if (prev.dirty === next.dirty && prev.label === next.label && prev.askClose === next.askClose && infos.has(id)) return;
    infos = new Map(infos).set(id, next);
    emit();
  },
  /** The window registers what releases its draft; `drop` runs it. */
  attach(id: string, dispose: () => void) { disposers.set(id, dispose); },
  drop(id: string) {
    disposers.get(id)?.(); disposers.delete(id);
    if (!infos.has(id)) return;
    const m = new Map(infos); m.delete(id); infos = m; emit();
  },
  /** The window asks before it closes with text that is not in the KB (design v2 2.7). True means it may close now. */
  requestClose(id: string): boolean {
    if (!memoStore.info(id).dirty) return true;
    memoStore.set(id, { askClose: true });
    return false;
  },
};
export const useMemoInfos = () => useSyncExternalStore(memoStore.subscribe, memoStore.get);
