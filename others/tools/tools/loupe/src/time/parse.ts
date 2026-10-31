// Time search params: RFC 3339 UTC with a Z suffix only (design 4). A bad value is an error, never "now".
const RFC3339_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export class TimeParamError extends Error {
  readonly param: string;
  readonly value: unknown;
  constructor(param: string, value: unknown) {
    super(`${param} must be RFC 3339 UTC with Z, got ${JSON.stringify(value)}`);
    this.name = 'TimeParamError';
    this.param = param;
    this.value = value;
  }
}
export function parseTimeParam(param: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !RFC3339_Z.test(value) || Number.isNaN(Date.parse(value))) throw new TimeParamError(param, value);
  // Date.parse accepts 2026-02-31 style overflow in some engines; round-trip to be strict on the date part.
  const d = new Date(value);
  if (d.toISOString().slice(0, 10) !== value.slice(0, 10)) throw new TimeParamError(param, value);
  return value;
}
export type TimeSearch = { as_of_valid?: string; as_of_observed?: string };
export const validateTimeSearch = (s: Record<string, unknown>): TimeSearch => {
  const out: TimeSearch = {};
  const v = parseTimeParam('as_of_valid', s.as_of_valid);
  const o = parseTimeParam('as_of_observed', s.as_of_observed);
  if (v !== undefined) out.as_of_valid = v;
  if (o !== undefined) out.as_of_observed = o;
  return out;
};
export const timeBasisFromSearch = (s: TimeSearch) => ({ valid: s.as_of_valid, observed: s.as_of_observed });
export const isPastView = (s: TimeSearch) => s.as_of_valid !== undefined || s.as_of_observed !== undefined;

/** What a set time basis means, so the band does not call something "past" that is not (design 4).
 *  past: an axis is before the data. valid-only: only the valid axis is set, so the answer is what is known now about that date.
 *  pinned: every set axis is at or after data_as_of, which is the present state held still (a future date, or "지금으로 고정"). */
export type ViewKind = 'live' | 'past' | 'valid-only' | 'pinned';
export function viewKind(s: TimeSearch, dataAsOf: string | null | undefined): ViewKind {
  if (!isPastView(s)) return 'live';
  const limit = dataAsOf ? Date.parse(dataAsOf) : Number.NaN;
  // Without a data_as_of there is no "present" to compare with, so the basis is treated as the past rather than hidden.
  const before = (iso: string | undefined) => iso !== undefined && (Number.isNaN(limit) || Date.parse(iso) < limit);
  if (!before(s.as_of_valid) && !before(s.as_of_observed)) return 'pinned';
  return s.as_of_valid !== undefined && s.as_of_observed === undefined ? 'valid-only' : 'past';
}
export const VIEW_LABEL: Record<Exclude<ViewKind, 'live'>, string> = { past: '과거 보기', 'valid-only': '지금 아는 내용으로 본 시점', pinned: '시점 고정' };
export const TITLE_PREFIX: Record<ViewKind, string> = { live: '', past: '[과거] ', 'valid-only': '[시점] ', pinned: '[시점 고정] ' };
