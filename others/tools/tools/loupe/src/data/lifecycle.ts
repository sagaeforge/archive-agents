// What the app does with envelope signals (design 7.3, 7.4). One place, mounted by the shell.
import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient, type Query, type QueryClient } from '@tanstack/react-query';
import { connection } from './connection.ts';
import { envelopeStore } from './envelopeStore.ts';
import { useMetaPoll } from './hooks.ts';
import { useIsPastView } from '../time/useTimeBasis.ts';

type NewData = { pending: boolean };
let newData: NewData = { pending: false };
const listeners = new Set<() => void>();
const setNewData = (pending: boolean) => { if (newData.pending === pending) return; newData = { pending }; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useNewDataPending = () => useSyncExternalStore(subscribe, () => newData.pending);

const isMeta = (q: Query) => q.queryKey[0] === '/v1/meta';
// Immutable: the display text and everything computed only from it (the 'loupe' keys in hooks.ts).
// The body remainder is not one of them: /body takes the time axes and the record can change (C 4).
export const isImmutable = (q: Query) => (q.queryKey[0] === 'loupe' && q.queryKey[1] !== 'body-rest') || String(q.queryKey[0]).endsWith('/text');
const pinnedBothAxes = (q: Query) => {
  const p = q.queryKey[1] as { as_of_valid?: unknown; as_of_observed?: unknown } | undefined;
  return !!p && typeof p === 'object' && p.as_of_valid !== undefined && p.as_of_observed !== undefined;
};

/** The graph is replaced only when the reader asks: the "new data" control on the screen does it (design 7.3). */
const manualRefresh = (q: Query) => q.meta?.manualRefresh === true;

/** Live view: refetch what is on screen. Past view: mark it stale and leave the screen alone (design 4). */
export function invalidateMoving(qc: QueryClient, past: boolean) {
  return qc.invalidateQueries({ predicate: (q) => !isMeta(q) && !isImmutable(q) && !pinnedBothAxes(q) && !manualRefresh(q), refetchType: past ? 'none' : 'active' });
}

/** After an outage. A live view refetches what is on screen. A past view refetches only what failed and marks the rest stale,
 *  so the screen does not change by itself while an axis is free (design 4). */
export function recoverQueries(qc: QueryClient, past: boolean) {
  const failed = (q: Query) => q.state.status === 'error';
  if (!past) return qc.invalidateQueries({ predicate: (q) => !isMeta(q) && (failed(q) || (!isImmutable(q) && !manualRefresh(q))) });
  void qc.invalidateQueries({ predicate: (q) => !isMeta(q) && failed(q) });
  return qc.invalidateQueries({ predicate: (q) => !isMeta(q) && !failed(q) && !isImmutable(q) && !pinnedBothAxes(q), refetchType: 'none' });
}

export function useKbLifecycle() {
  const qc = useQueryClient();
  const past = useIsPastView();
  useMetaPoll();

  useEffect(() => envelopeStore.onChange((_prev, _next, c) => {
    if (c.epochChanged) {
      // A restore: the cache and any feed position are void. A fresh start, not a refresh.
      setNewData(false);
      void qc.resetQueries({ predicate: (q) => !isMeta(q) });
      return;
    }
    if (c.appliedSeqIncreased) {
      if (past) setNewData(true);
      void invalidateMoving(qc, past);
    }
    // build_id alone means a rebuild: same logical state (C 2.6), so nothing happens.
  }), [qc, past]);

  useEffect(() => { if (!past) setNewData(false); }, [past]);

  useEffect(() => connection.onRecover(() => { void recoverQueries(qc, past); }), [qc, past]);
}
