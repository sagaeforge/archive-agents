// Contract-format ids (design 7.1, KB ADR 7.5). Ids are untrusted input: deep links and tool results carry them.
export type KbIdKind = 'entity' | 'claim' | 'snapshot' | 'edge' | 'record' | 'series' | 'source' | 'ticket' | 'unknown';

// Prefixes from KB ADR 7.5. `src:` must be tested before `s:`.
const KINDS: [string, KbIdKind][] = [['e:', 'entity'], ['src:', 'source'], ['s:', 'series'], ['c-', 'claim'], ['n-', 'snapshot'], ['r-', 'edge'], ['f-', 'record'], ['t-', 'ticket']];
export const classifyId = (id: string): KbIdKind => KINDS.find(([p]) => id.startsWith(p))?.[1] ?? 'unknown';

export type IdResult = { ok: true; id: string } | { ok: false; reason: 'empty' | 'too-long' | 'forbidden-char' | 'dot-segment' };

// Contract 0.2.0 (C 2.10): public ids contain no `/`, `?`, `#`, whitespace or control characters, and `:` is allowed.
// Design 7.1 accepted `/` until the contract caught up; it has (CTR-01), so `/` is refused now. An id that is `.` or `..`
// is refused too: encodeURIComponent leaves it alone and a proxy may collapse it as a path segment.
export function parseKbId(raw: string): IdResult {
  if (raw.length === 0) return { ok: false, reason: 'empty' };
  if (raw.length > 512) return { ok: false, reason: 'too-long' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f/?#\\\s]/u.test(raw)) return { ok: false, reason: 'forbidden-char' };
  if (raw === '.' || raw === '..') return { ok: false, reason: 'dot-segment' };
  return { ok: true, id: raw };
}
/** For the links we build. The router decodes `%2F`, so the id travels as one encoded segment. */
export const encodeKbId = (id: string) => encodeURIComponent(id);
export class IdParamError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`invalid id (${reason})`);
    this.name = 'IdParamError';
    this.reason = reason;
  }
}
export function mustParseKbId(raw: string): string {
  const r = parseKbId(raw);
  if (!r.ok) throw new Error(`invalid id: ${r.reason}`);
  return r.id;
}
