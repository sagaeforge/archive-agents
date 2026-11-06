import type { GetEntityParams, ListEntitiesParams, GetOverviewParams, ListEntityClaimsParams } from './client/model/index.ts';
export type TimeBasis = { valid?: string; observed?: string };
export const asOf = (t: TimeBasis) =>
  ({ ...(t.valid ? { as_of_valid: t.valid } : {}), ...(t.observed ? { as_of_observed: t.observed } : {}) }) satisfies GetEntityParams & ListEntitiesParams & ListEntityClaimsParams & Partial<GetOverviewParams>;
