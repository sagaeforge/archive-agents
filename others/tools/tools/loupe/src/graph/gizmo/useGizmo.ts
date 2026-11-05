import { useCallback, useEffect, useState } from 'react';
import { ALL, decodeSelection, encodeSelection, isAll, only, toggle, type Axis, type Selection } from './model.ts';

/** This tab's sessionStorage only (design v2 2.3). Nothing in the address, nothing in localStorage, nothing sent to the KB. */
export const GIZMO_KEY = 'loupe.gizmo.v2';

export function useGizmo() {
  const [selection, set] = useState<Selection>(() => { try { return decodeSelection(sessionStorage.getItem(GIZMO_KEY)); } catch { return ALL; } });
  useEffect(() => {
    try { if (isAll(selection)) sessionStorage.removeItem(GIZMO_KEY); else sessionStorage.setItem(GIZMO_KEY, encodeSelection(selection)); } catch { /* storage denied */ }
  }, [selection]);
  return {
    selection,
    only: useCallback((a: Axis) => { set(only(a)); }, []),
    toggle: useCallback((a: Axis) => { set((s) => toggle(s, a)); }, []),
    all: useCallback(() => { set(ALL); }, []),
  };
}
export type Gizmo = ReturnType<typeof useGizmo>;
