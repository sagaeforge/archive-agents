// The URL is the source of the time basis. There is no copy in screen state (design 4).
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useSyncExternalStore } from 'react';
import { envelopeStore } from '../data/envelopeStore.ts';
import { isPastView, timeBasisFromSearch, viewKind, type TimeSearch, type ViewKind } from './parse.ts';
import type { TimeBasis } from './asOf.ts';

export function useTimeSearch(): TimeSearch {
  const s = useSearch({ strict: false }) as TimeSearch;
  return s;
}
export const useTimeBasis = (): TimeBasis => timeBasisFromSearch(useTimeSearch());
export const useIsPastView = () => isPastView(useTimeSearch());
export function useViewKind(): ViewKind {
  const s = useTimeSearch();
  const env = useSyncExternalStore(envelopeStore.subscribe, envelopeStore.get);
  return viewKind(s, env.meta?.data_as_of);
}

type Patch = { as_of_valid?: string | undefined; as_of_observed?: string | undefined };

export function useTimeNavigate() {
  const navigate = useNavigate();
  return useCallback((patch: Patch) => {
    // Explicit undefined removes an axis: retainSearchParams only restores keys that are absent.
    // The reader's place on the page stays: a source page keeps its quote on screen when the basis changes.
    void navigate({ to: '.', search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }), resetScroll: false } as never);
  }, [navigate]);
}
