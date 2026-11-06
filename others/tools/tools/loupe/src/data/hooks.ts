// The only door to the generated hooks (design 4). Every read that takes the time axes gets them here, from the URL, through the
// per-operation table. Screens never name an axis. ESLint keeps src/client/kb.ts out of everything but src/data/.
import { useCallback, useMemo, useState } from 'react';
import { keepPreviousData, queryOptions, useInfiniteQuery, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  getGetNodeNeighborsQueryOptions, getGetNodeQueryOptions, getGetSnapshotTextQueryOptions, getNodeBody, getSnapshotText, useGetClaim, useGetMeta, useGetNode, useGetNodeHistory, useGetNodeNeighbors, useGetSchema,
  useGetSnapshot, useListNodeClaimsInfinite, useListNodeEdgesInfinite, useListNodes, useSearch as useKbSearch,
} from '../client/kb.ts';
import type { EdgeRefListEnvelope, Evidence, GetNodeParams, NodeDetailEnvelope, SchemaCatalog } from '../client/model/index.ts';
import type { TimeBasis } from '../time/asOf.ts';
import { asOfFor } from '../time/timeAxes.ts';
import { useTimeBasis } from '../time/useTimeBasis.ts';
import { readAllText, runLimited, verifyEvidence, type ReadText, type Verdict } from '../quote/verify.ts';
import { cpLength } from '../quote/codepoints.ts';
import { decodeColumns } from './columns.ts';
import { connection } from './connection.ts';

export type NodeFilters = { status?: GetNodeParams['status']; include_unverified?: boolean };

export const META_POLL_MS = 45_000;
export const RETRY_POLL_MS = 30_000;
const FIVE_MIN = 5 * 60_000;

/** The 45 s poll doubles as the connection check (design 7.3). The timer pauses in a hidden tab. While cut off it retries every 30 s (7.4). */
export const pollInterval = (): number | false => (!connection.canRetry() ? false : connection.get().down ? RETRY_POLL_MS : META_POLL_MS);
export const useMetaPoll = () => useGetMeta({ query: { refetchInterval: pollInterval, staleTime: 0 } });

export const useSchemaCatalog = () => useGetSchema({ query: { staleTime: FIVE_MIN, select: (r) => r.data } });

export const NODE_INCLUDE = 'claims,edges,backlinks,body';
export const CLAIM_LIMIT = 50;
export const EDGE_LIMIT = 200;

export function useNodeDetail(id: string, filters: NodeFilters) {
  const t = useTimeBasis();
  return useGetNode(id, { include: NODE_INCLUDE, claim_limit: CLAIM_LIMIT, edge_limit: EDGE_LIMIT, ...filters, ...asOfFor('getNode', t) });
}

/** The label of a single id, for places that only need a name. `include` has no empty form, so this asks for one claim. */
const briefParams = (t: ReturnType<typeof useTimeBasis>) => ({ include: 'claims', claim_limit: 1, ...asOfFor('getNode', t) });

export function useNodeBrief(id: string | undefined) {
  const t = useTimeBasis();
  return useGetNode(id ?? '', briefParams(t), { query: { enabled: !!id, staleTime: 60_000, select: (r: NodeDetailEnvelope) => r.data } });
}

/** At most 8 labels when the palette opens (design 2). There is no bulk read yet (appendix B 19). */
export function useLabels(ids: readonly string[], enabled: boolean) {
  const t = useTimeBasis();
  return useQueries({
    queries: ids.map((id) => getGetNodeQueryOptions(id, briefParams(t), { query: { enabled, staleTime: 60_000 } })),
    combine: (rs) => rs.map((r, i) => ({ id: ids[i]!, label: r.data?.data.label ?? null, type: r.data?.data.type ?? null })),
  });
}

/** A lookup for the merge walk. Same keys as useNodeBrief, so a hop is cached. */
export function useNodeLookup() {
  const qc = useQueryClient();
  const t = useTimeBasis();
  const valid = t.valid, observed = t.observed;
  return useCallback(
    async (id: string) => (await qc.fetchQuery(getGetNodeQueryOptions(id, briefParams({ valid, observed }), { query: { staleTime: 60_000 } }))).data,
    [qc, valid, observed],
  );
}

export function useClaimsRest(id: string, filters: NodeFilters, enabled: boolean) {
  const t = useTimeBasis();
  const q = useListNodeClaimsInfinite(id, { limit: 200, ...filters, ...asOfFor('listNodeClaims', t) }, {
    query: { enabled, initialPageParam: undefined, getNextPageParam: (p) => p.page.next_cursor ?? undefined },
  });
  return { ...q, items: useMemo(() => q.data?.pages.flatMap((p) => p.data.items) ?? [], [q.data]), total: q.data?.pages[0]?.page.total ?? null };
}

export function useEdgesRest(id: string, filters: NodeFilters, enabled: boolean) {
  const t = useTimeBasis();
  const params = { limit: 500, ...filters, ...asOfFor('listNodeEdges', t) };
  const query = { enabled, initialPageParam: undefined, getNextPageParam: (p: EdgeRefListEnvelope) => p.page.next_cursor ?? undefined };
  // Two reads, one per direction: after a merge an edge's end may be an older id, so the direction cannot be told from the row.
  const out = useListNodeEdgesInfinite(id, { ...params, direction: 'out' }, { query });
  const inc = useListNodeEdgesInfinite(id, { ...params, direction: 'in' }, { query });
  const outItems = useMemo(() => out.data?.pages.flatMap((p) => p.data.items) ?? [], [out.data]);
  const inItems = useMemo(() => inc.data?.pages.flatMap((p) => p.data.items) ?? [], [inc.data]);
  return {
    items: useMemo(() => ({ out: outItems, in: inItems }), [outItems, inItems]),
    error: out.error ?? inc.error,
    isFetching: out.isFetching || inc.isFetching,
    hasNext: out.hasNextPage || inc.hasNextPage,
    fetchNext: async () => { await Promise.all([out.hasNextPage ? out.fetchNextPage() : null, inc.hasNextPage ? inc.fetchNextPage() : null]); },
    refetch: async () => { await Promise.all([out.refetch(), inc.refetch()]); },
  };
}

export type NeighborInfo = { id: string; label: string; type: string; status: string };
/** Since 0.3.0 an `EdgeRef` carries `peer`; this table is the fallback for an edge that does not (appendix B 12). */
export function useNeighborLabels(id: string, filters: NodeFilters, enabled = true) {
  const t = useTimeBasis();
  const q = useGetNodeNeighbors(id, { depth: 1, direction: 'both', limit: 200, ...filters, ...asOfFor('getNodeNeighbors', t) }, { query: { enabled } });
  const map = useMemo(() => {
    const m = new Map<string, NeighborInfo>();
    const table = q.data?.data.nodes;
    if (table) for (const r of decodeColumns(table, ['id', 'label', 'type', 'status'] as const)) m.set(String(r.id), { id: String(r.id), label: String(r.label ?? r.id), type: String(r.type ?? ''), status: String(r.status ?? '') });
    return m;
  }, [q.data]);
  return { ...q, map };
}

export function useClaim(id: string | undefined) {
  const t = useTimeBasis();
  return useGetClaim(id ?? '', asOfFor('getClaim', t), { query: { enabled: !!id } });
}

/** `superseded_by` lives only on /history, so a card reads it when it is opened (design 3). /history takes no axes (C 2.9). */
export const useClaimHistory = (id: string, enabled: boolean) => useGetNodeHistory(id, undefined, { query: { enabled, staleTime: 60_000 } });

export const useSnapshot = (id: string) => useGetSnapshot(id);

export const TEXT_WINDOW = 20_000;
type WindowParam = { start: number; max: number };
/** C 4.11: a window is at most 200,000 characters. The first window is the one that must reach the quote, and the next page covers the rest. */
export const MAX_TEXT_WINDOW = 200_000;
export const firstWindowMax = (minChars: number) => Math.min(MAX_TEXT_WINDOW, Math.max(TEXT_WINDOW, minChars));

/** Only /text is immutable: `citing_claims` on /v1/snapshots/{id} may still grow (design 5). */
export function useTextWindows(id: string, from: number, minChars: number, enabled: boolean) {
  const q = useInfiniteQuery({
    queryKey: ['loupe', 'text-windows', id, from, minChars],
    enabled,
    staleTime: Infinity,
    initialPageParam: { start: from, max: firstWindowMax(minChars) } as WindowParam,
    queryFn: ({ pageParam, signal }) => getSnapshotText(id, { start: pageParam.start, max_chars: pageParam.max }, { signal }),
    getNextPageParam: (last): WindowParam | undefined => (last.data.end < last.data.total_chars ? { start: last.data.end, max: TEXT_WINDOW } : undefined),
    getPreviousPageParam: (first): WindowParam | undefined => {
      if (first.data.start <= 0) return undefined;
      const start = Math.max(0, first.data.start - TEXT_WINDOW);
      return { start, max: first.data.start - start };
    },
  });
  const pages = q.data?.pages;
  const view = useMemo(() => {
    if (!pages?.length) return null;
    const first = pages[0]!.data, last = pages.at(-1)!.data;
    return { text: pages.map((p) => p.data.text).join(''), start: first.start, end: last.end, total: last.total_chars, format: first.text_format ?? 'text' };
  }, [pages]);
  return { ...q, view };
}

/** Queries built from reads that already follow the retry policy (see textReader) do not retry as a whole: it would multiply every wait
 *  (a 429 with Retry-After would be waited out once inside and then again outside, four times over). */
const retryInside = { retry: false as const };

export const textReader = (qc: QueryClient, id: string): ReadText => async (start, maxChars) =>
  (await qc.fetchQuery(getGetSnapshotTextQueryOptions(id, { start, max_chars: maxChars }, { query: { staleTime: Infinity } }))).data;

/** The whole display body, one 200k window at a time, for the rendered tab. */
export function useFullText(id: string, enabled: boolean) {
  const qc = useQueryClient();
  return useQuery({ queryKey: ['loupe', 'full-text', id], enabled, staleTime: Infinity, gcTime: 60_000, ...retryInside, queryFn: () => readAllText(textReader(qc, id)) });
}

export const verdictOptions = (qc: QueryClient, ev: Evidence) => queryOptions({
  queryKey: ['loupe', 'verdict', ev.snapshot_id, ev.id, ev.start, ev.end, ev.exact],
  staleTime: Infinity,
  ...retryInside,
  queryFn: (): Promise<Verdict> => verifyEvidence(ev, textReader(qc, ev.snapshot_id)),
});

/** Lazy: `enabled` turns on when a pill opens. The result is shared with "check all" through the query key. */
export function useVerdict(ev: Evidence | undefined, enabled: boolean) {
  const qc = useQueryClient();
  return useQuery({ ...verdictOptions(qc, ev ?? ({ id: '', snapshot_id: '', selector_kind: 'text_quote' } as Evidence)), enabled: enabled && !!ev });
}

export type CheckTally = { total: number; ok: number; failed: number; notFound: number };

/** Runs the check on each evidence, four at a time. A read that fails is counted as failed, never as checked (design 5). */
export async function runCheckAll(qc: QueryClient, evs: readonly Evidence[], onStep?: (t: CheckTally) => void): Promise<CheckTally> {
  const t: CheckTally = { total: evs.length, ok: 0, failed: 0, notFound: 0 };
  await runLimited(evs, 4, async (ev) => {
    try {
      const v = await qc.fetchQuery(verdictOptions(qc, ev));
      if (v.kind === 'not-found') t.notFound++;
      t.ok++;
    } catch { t.failed++; }
    onStep?.({ ...t });
  });
  return { ...t };
}

export function useCheckAll() {
  const qc = useQueryClient();
  return useCallback((evs: readonly Evidence[], onStep?: (t: CheckTally) => void) => runCheckAll(qc, evs, onStep), [qc]);
}

export function useEntitySearch(raw: string) {
  const t = useTimeBasis();
  const q = raw.normalize('NFC').trim();
  return useKbSearch({ q, kinds: 'entity,record', limit: 12, ...asOfFor('search', t) }, {
    query: { enabled: q.length > 0, placeholderData: keepPreviousData, staleTime: 30_000 },
  });
}

/** Types in the `world` and `user` groups, from the catalog: nothing here names a type. */
export const browsableTypes = (s: SchemaCatalog | undefined) => s?.node_types.filter((t) => t.group === 'world' || t.group === 'user').map((t) => t.name) ?? [];
/** C 4: with several types only the `*` entry of sort_keys is allowed; with one type, that type's own entry. */
export const sortKeysFor = (s: SchemaCatalog, types: readonly string[]): readonly string[] => {
  const keys = s.sort_keys as Record<string, string[] | undefined>;
  return (types.length === 1 ? keys[types[0]!] : keys['*']) ?? [];
};
export const canSortByRecorded = (s: SchemaCatalog, types: readonly string[]) => types.length > 0 && sortKeysFor(s, types).includes('recorded_at');

export function useRecentlyRecorded(limit: number) {
  const t = useTimeBasis();
  const schema = useSchemaCatalog();
  const types = browsableTypes(schema.data);
  const sort = schema.data && canSortByRecorded(schema.data, types) ? '-recorded_at' : undefined;
  const q = useListNodes({ types: types.join(','), limit, ...(sort ? { sort } : {}), ...asOfFor('listNodes', t) }, { query: { enabled: types.length > 0 } });
  return { ...q, sorted: !!sort, isPending: schema.isPending || q.isPending, error: schema.error ?? q.error };
}

/** The rest of a body longer than the first 200,000 characters (C 4.5). /body takes the time axes (C 4), so the remainder
 *  is read for the same basis as the head: the key carries both axes and a basis change asks again. */
export const bodyRestKey = (id: string, start: number, t: TimeBasis) => ['loupe', 'body-rest', id, start, t.valid ?? null, t.observed ?? null] as const;
export const readBodyRest = (id: string, start: number, t: TimeBasis, signal?: AbortSignal) =>
  getNodeBody(id, { start, max_chars: 200_000, ...asOfFor('getNodeBody', t) }, { signal });

export function useBodyRest(id: string, loaded: string | null | undefined, total: number | null | undefined) {
  const t = useTimeBasis();
  const start = loaded ? cpLength(loaded) : 0;
  const more = total != null && start < total;
  const key = bodyRestKey(id, start, t);
  // The reader asks for the remainder; a different basis or head is a different question and needs a new ask.
  const keyText = JSON.stringify(key);
  const [asked, setAsked] = useState<string | null>(null);
  const q = useInfiniteQuery({
    queryKey: key,
    enabled: asked === keyText,
    initialPageParam: start,
    queryFn: ({ pageParam, signal }) => readBodyRest(id, pageParam, t, signal),
    getNextPageParam: (last) => (last.data.end < last.data.total_chars ? last.data.end : undefined),
  });
  return { ...q, more, asked: asked === keyText, request: () => setAsked(keyText), text: q.data?.pages.map((p) => p.data.text).join('') ?? '' };
}

/** Topic-only home reads. Each topic expands one hop using the existing contract ceilings. */
export function useTopicGraph() {
  const t=useTimeBasis();
  const topics=useListNodes({types:'Topic',limit:20,...asOfFor('listNodes',t)});
  const ids=topics.data?.data.items.map(n=>n.id)??[];
  const neighbors=useQueries({queries:ids.map(id=>getGetNodeNeighborsQueryOptions(id,{depth:1,direction:'both',limit:500,edge_limit:2000,...asOfFor('getNodeNeighbors',t)}))});
  return {topics,neighbors};
}
/** TopicSpec, Page and Note records are one typed search and the entities another: two requests per pause, and TopicSpec and private
 *  records stay out of the v1 entity search contract. The entity query is called last so it is the last request sent. */
export function usePaletteSearch(raw:string, workspace:boolean) {
  const t=useTimeBasis(); const q=raw.normalize('NFC').trim();
  const records=useKbSearch({q,types:'TopicSpec,Page,Note',kinds:'record',limit:24,...asOfFor('search',t)},{query:{enabled:workspace&&!!q,placeholderData:keepPreviousData,staleTime:30_000}});
  const entities=useEntitySearch(raw);
  const all=workspace?[records,entities]:[entities];
  // No data at all (not even an empty page) means the search has not answered: the caller must be able to tell that from "nothing found".
  const answered=all.some(r=>r.data);
  const items=all.flatMap(r=>r.data?.data.items??[]);
  return {data:answered?{data:{items}}:undefined,isFetching:all.some(r=>r.isFetching),isPlaceholderData:all.some(r=>r.isPlaceholderData),isError:all.some(r=>r.isError),error:all.find(r=>r.error)?.error};
}
