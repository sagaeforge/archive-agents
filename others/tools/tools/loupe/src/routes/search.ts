// Search params per route. The URL is the source of truth for the screen (design 1, criterion 2): filters and the quote live here, cursors do not.
import { parseKbId } from '../ids.ts';
import type { TimeSearch } from '../time/parse.ts';

export class SearchParamError extends Error {
  readonly param: string;
  constructor(param: string, value: unknown) {
    super(`${param}: ${JSON.stringify(value)}`);
    this.name = 'SearchParamError';
    this.param = param;
  }
}

const STATUS = ['active', 'superseded', 'dead', 'all'] as const;
export type StatusFilter = (typeof STATUS)[number];
const idParam = (name: string, v: unknown): string | undefined => {
  if (v === undefined) return undefined;
  const r = typeof v === 'string' ? parseKbId(v) : null;
  if (!r?.ok) throw new SearchParamError(name, v);
  return r.id;
};

export type NodeSearch = TimeSearch & { status?: StatusFilter; include_unverified?: true; merged_from?: string };
export function validateNodeSearch(s: Record<string, unknown>): Pick<NodeSearch, 'status' | 'include_unverified' | 'merged_from'> {
  const out: Pick<NodeSearch, 'status' | 'include_unverified' | 'merged_from'> = {};
  if (s.status !== undefined) {
    if (!STATUS.includes(s.status as StatusFilter)) throw new SearchParamError('status', s.status);
    out.status = s.status as StatusFilter;
  }
  if (s.include_unverified !== undefined) {
    if (s.include_unverified !== true && s.include_unverified !== 'true') throw new SearchParamError('include_unverified', s.include_unverified);
    out.include_unverified = true;
  }
  const merged = idParam('merged_from', s.merged_from);
  if (merged) out.merged_from = merged;
  return out;
}

export type SourceView = 'text' | 'rendered';
/** `pos=<start>-<end>` picks the evidence of a claim by its recorded position, for a link that knows the position but not the evidence id. */
export const parsePos = (v: unknown): { start: number; end: number } | null => {
  const m = typeof v === 'string' ? /^(\d{1,12})-(\d{1,12})$/.exec(v) : null;
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
};
export type SourceSearch = TimeSearch & { claim?: string; ev?: string; pos?: string; view?: SourceView };
export function validateSourceSearch(s: Record<string, unknown>): Pick<SourceSearch, 'claim' | 'ev' | 'pos' | 'view'> {
  const out: Pick<SourceSearch, 'claim' | 'ev' | 'pos' | 'view'> = {};
  if (s.pos !== undefined) {
    if (!parsePos(s.pos)) throw new SearchParamError('pos', s.pos);
    out.pos = s.pos as string;
  }
  const claim = idParam('claim', s.claim);
  const ev = idParam('ev', s.ev);
  if (claim) out.claim = claim;
  if (ev) out.ev = ev;
  if (s.view !== undefined) {
    if (s.view !== 'text' && s.view !== 'rendered') throw new SearchParamError('view', s.view);
    if (s.view === 'rendered') out.view = 'rendered';
  }
  return out;
}
