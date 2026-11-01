// The reads behind the graph screen. They live in src/data/ because this is where the time axes are added (design 4). The export reads take none (C 2.9).
import { keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { getExportGraph, getExportManifest, getGetOverviewQueryKey, useGetFacets, useGetNode, useGetNodeNeighbors, useGetOverview } from '../client/kb.ts';
import type { GetFacetsParams, GetNodeNeighborsParams, GetOverviewParams, NodeDetailEnvelope } from '../client/model/index.ts';
import { asOfFor } from '../time/timeAxes.ts';
import { useTimeBasis } from '../time/useTimeBasis.ts';
import { KbProblem, KbUnavailable } from './kbFetch.ts';

/** The graph replaces itself only when asked (design 7.3): lifecycle.ts leaves queries with this mark alone when `applied_seq` moves. */
export const MANUAL_REFRESH = { manualRefresh: true } as const;

export type GraphFilters = Pick<GetOverviewParams, 'types' | 'rtypes' | 'domain' | 'edge_status'>;
export type GraphLimits = { limit: number; edge_limit: number };

export function useOverview(filters: GraphFilters, limits: GraphLimits) {
  const t = useTimeBasis();
  return useGetOverview({ ...filters, ...limits, ...asOfFor('getOverview', t) }, {
    query: { staleTime: Infinity, placeholderData: keepPreviousData, meta: MANUAL_REFRESH },
  });
}

export function useRefreshOverview() {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries({ queryKey: [getGetOverviewQueryKey()[0]] }), [qc]);
}

/** Contract ceilings for one expansion (C 4.6). */
export const NEIGHBOR_LIMITS = { limit: 500, edge_limit: 2_000 } as const;
export type NeighborFilters = Pick<GetNodeNeighborsParams, 'rtypes' | 'depth' | 'edge_status'>;

export function useNeighborhood(id: string | undefined, filters: NeighborFilters) {
  const t = useTimeBasis();
  return useGetNodeNeighbors(id ?? '', { direction: 'both', ...NEIGHBOR_LIMITS, ...filters, ...asOfFor('getNodeNeighbors', t) }, {
    // Previous data only while one focus replaces another: with no focus there is no expansion, and a disabled query would hold on to it.
    query: { enabled: !!id, staleTime: Infinity, placeholderData: id ? keepPreviousData : undefined, meta: MANUAL_REFRESH },
  });
}

/** Type choices and their counts come from here (design 3). */
export function useGraphFacets(filters: Pick<GetFacetsParams, 'types' | 'domain'>) {
  const t = useTimeBasis();
  return useGetFacets({ ...filters, ...asOfFor('getFacets', t) }, { query: { staleTime: 5 * 60_000, placeholderData: keepPreviousData, select: (r) => r.data } });
}

/** The right panel (design 3): a short read of one node. */
export function useNodeSummary(id: string | undefined) {
  const t = useTimeBasis();
  return useGetNode(id ?? '', { include: 'claims', claim_limit: 5, ...asOfFor('getNode', t) }, { query: { enabled: !!id, staleTime: 60_000, select: (r: NodeDetailEnvelope) => r.data } });
}

// An unpublished export answers 503 not_ready (C 5), and anything else that goes wrong here costs a recomputation, not the screen.
// These are plain calls on purpose: the query retry would sit out the 30 s Retry-After before the overview could stand in.
const orNull = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try { return await read(); } catch (e) {
    if (e instanceof KbProblem || e instanceof KbUnavailable) return null;
    throw e;
  }
};

export const readCoreSha = (signal?: AbortSignal) => orNull(async () => (await getExportManifest({ signal })).data.profiles.core?.sha256 ?? null);
/** `loupe serve` decompresses this (design 10), so it arrives as JSON. Through a server that does not, it is a Blob and `decodeTopology` turns it down. */
export const readCoreExport = (signal?: AbortSignal) => orNull<unknown>(() => getExportGraph({ profile: 'core' }, { signal }));
