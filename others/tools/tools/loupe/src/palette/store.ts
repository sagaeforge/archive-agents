import { useSyncExternalStore } from 'react';

let open = false;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const setPaletteOpen = (v: boolean) => { if (open !== v) { open = v; listeners.forEach((l) => l()); } };
export const togglePalette = () => setPaletteOpen(!open);
export const usePaletteOpen = () => useSyncExternalStore(subscribe, () => open);
