// `focus=` takes the same road as a node page: a merged id moves to its survivor, keeping the rest of the URL (design 5).
import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useNodeBrief, useNodeLookup } from '../data/hooks.ts';
import { followMerge, type MergeResult } from '../entity/merge.ts';

export function useFocusMerge(focus: string | undefined): MergeResult | null {
  const navigate = useNavigate();
  const lookup = useNodeLookup();
  const brief = useNodeBrief(focus);
  const node = brief.data;
  const merged = !!(node?.merged_into_final || node?.merged_into);
  const [dead, setDead] = useState<MergeResult | null>(null);
  useEffect(() => {
    setDead(null);
    if (!focus || !node || !merged) return;
    let alive = true;
    followMerge(focus, node, lookup).then((r) => {
      if (!alive) return;
      if (r.kind === 'survivor') void navigate({ to: '/graph', search: (p: Record<string, unknown>) => ({ ...p, focus: r.id, sel: p.sel === focus ? r.id : p.sel, merged_from: focus }), replace: true } as never);
      else setDead(r);
    }, () => { /* the expansion read reports the failure */ });
    return () => { alive = false; };
  }, [focus, node, merged, lookup, navigate]);
  return dead;
}
