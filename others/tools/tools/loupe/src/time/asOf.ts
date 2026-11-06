// The only place the axis names are written (design 4).
import type {
  GetClaimParams, GetCountsParams, GetEdgeParams, GetFacetsParams, GetNodeNeighborsParams, GetNodeParams,
  GetOverviewParams, GetSeriesParams, ListNodesParams, SearchParams,
} from '../client/model/index.ts';

export type TimeBasis = { valid?: string; observed?: string };

// The keys are written as literals on purpose. A conditional spread would let a renamed axis pass tsc silently,
// and `satisfies` keeps the excess property check that a stored object would lose.
export const asOf = (t: TimeBasis) =>
  ({ as_of_valid: t.valid, as_of_observed: t.observed }) satisfies
    GetNodeParams & ListNodesParams & GetOverviewParams & Partial<SearchParams> & GetNodeNeighborsParams &
    GetClaimParams & GetEdgeParams & GetFacetsParams & GetCountsParams & GetSeriesParams;
// SearchParams has a required `q` (GetFacetsParams stopped needing one in 0.3.2), so it is wrapped in Partial; the excess property check still sees the axis names.
// undefined means "now": the generated code leaves undefined values out of the query string.
