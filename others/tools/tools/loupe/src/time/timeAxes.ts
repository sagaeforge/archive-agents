// Which operations take the time axes (design 4, C 2.9). Excluded operations answer 400 as_of_unsupported if one is sent.
// `npm run contract:check` compares this table with the spec and with the C 2.9 exclusion set.
import { asOf, type TimeBasis } from './asOf.ts';

export const TIME_AXIS_OPERATIONS = {
  getOverview: true, listNodes: true, getNode: true, getNodeNeighbors: true, getClaim: true, getEdge: true,
  search: true, getFacets: true, getCounts: true, getSeries: true, listNodeClaims: true, listNodeEdges: true,
  // C 4 gives /body the T parameters: the remainder of a long record belongs to the same time basis as its head.
  getNodeBody: true,
  // C 2.9 exclusion set (0.2.0 added /history: it already returns every version). /body is not in it.
  getNodeHistory: false, listChanges: false, getSnapshot: false, getSnapshotText: false, getSnapshotRaw: false, getMeta: false, getSchema: false,
  getExportManifest: false, getExportGraph: false, getOpsFreshness: false, listOpsTickets: false, listOpsRuns: false, getOpsMetrics: false,
} as const satisfies Record<string, boolean>;

export type OperationId = keyof typeof TIME_AXIS_OPERATIONS;
export type TimeAwareOperation = { [K in OperationId]: (typeof TIME_AXIS_OPERATIONS)[K] extends true ? K : never }[OperationId];

/** Wrapper for generated hooks: adds the axes only to operations that accept them. */
export const asOfFor = (op: TimeAwareOperation, t: TimeBasis) => asOf(t);
