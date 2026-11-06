// Follows merged_into and replaces the URL with the survivor, keeping the time basis (design 5). `merged_from` makes the notice reproducible.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useNodeLookup } from '../data/hooks.ts';
import { connection } from '../data/connection.ts';
import { followMerge, mergeRedirectSearch, type MergeNode, type MergeResult } from './merge.ts';

export type MergeState = { active: false } | { active: true; result: MergeResult | null; error: unknown; retry: () => void };

export function useMergeRedirect(id: string, node: MergeNode | undefined): MergeState {
  const navigate = useNavigate();
  const lookup = useNodeLookup();
  const target = node?.merged_into_final || node?.merged_into || null;
  const [outcome, setOutcome] = useState<{ result: MergeResult | null; error: unknown }>({ result: null, error: null });
  // The walk depends on the node object, which does not change when a failed read recovers. This counter is how it is asked to run again.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  const failed = outcome.error !== null;
  useEffect(() => (failed ? connection.onRecover(retry) : undefined), [failed, retry]);

  useEffect(() => {
    if (!node || !target) return;
    let alive = true;
    setOutcome({ result: null, error: null });
    followMerge(id, node, lookup).then((result) => {
      if (!alive) return;
      if (result.kind === 'survivor') {
        void navigate({ to: '/node/$id', params: { id: result.id }, search: (prev: Record<string, unknown>) => mergeRedirectSearch(prev, id), replace: true } as never);
      } else setOutcome({ result, error: null });
    }, (error: unknown) => { if (alive) setOutcome({ result: null, error }); });
    return () => { alive = false; };
  }, [id, node, target, lookup, navigate, attempt]);

  return target ? { active: true, ...outcome, retry } : { active: false };
}
