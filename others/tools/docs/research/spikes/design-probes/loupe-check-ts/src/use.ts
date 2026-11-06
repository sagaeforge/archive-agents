import { getGetEntityQueryOptions, getListEntitiesInfiniteQueryOptions, getGetOverviewQueryOptions } from './client/kb.ts';
import { asOf } from './asOf.ts';
const t = { valid: '2025-06-01T00:00:00Z' };
export const a = getGetEntityQueryOptions('ent_acme', asOf(t));
export const b = getListEntitiesInfiniteQueryOptions({ ...asOf(t), type: 'organization', limit: 50 });
export const c = getGetOverviewQueryOptions({ ...asOf(t), type: 'organization' });
