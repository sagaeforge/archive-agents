import { useSyncExternalStore } from 'react';

let open = false;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const setPaletteOpen = (v: boolean) => { if (open !== v) { open = v; listeners.forEach((l) => l()); } };
export const togglePalette = () => setPaletteOpen(!open);
export const usePaletteOpen = () => useSyncExternalStore(subscribe, () => open);

const isEditable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

// Ctrl+K and / belong to the page, not to a screen: the session probe and the lazy screens mount after the load event, and a key
// pressed in that gap would be lost. The listener is installed once, when this module loads, and only flips the open flag.
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); togglePalette(); return; }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditable(e.target)) { e.preventDefault(); setPaletteOpen(true); }
  });
}
