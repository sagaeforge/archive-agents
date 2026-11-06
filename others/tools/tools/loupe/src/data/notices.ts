// Short notices the data layer raises for the shell to show (design 7.3). Not state of any screen: a list that restarted from page 1 says so once.
import { useSyncExternalStore } from 'react';

export type Notice = { id: number; text: string };
let notices: readonly Notice[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const noticeStore = {
  get: () => notices,
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  push(text: string) { notices = [...notices.filter((n) => n.text !== text), { id: ++seq, text }]; emit(); },
  dismiss(id: number) { notices = notices.filter((n) => n.id !== id); emit(); },
  clear() { notices = []; emit(); },
};
export const useNotices = () => useSyncExternalStore(noticeStore.subscribe, noticeStore.get);
