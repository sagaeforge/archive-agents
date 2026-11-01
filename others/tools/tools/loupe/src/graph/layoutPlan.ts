// Which of the three paths a layout takes (design 6.2). Pure: the store and the worker are elsewhere.
export const LAYOUT_VERSION = 1;
/** [가정] in the design: changes up to 10% moved existing nodes little in two measurements. Real publishes will tell. */
export const SOFT_MISS_COVERAGE = 0.9;
export const KEEP_LAYOUTS = 5;

/** Ids, coordinates and communities only: no label reaches the disk (design 5). `sha` is the manifest value it was read for, or null. */
export type CachedLayout = { hash: string; version: number; sha: string | null; at: number; ids: string[]; xy: Float32Array; community: Int32Array };

export type Decision = { kind: 'hit'; record: CachedLayout } | { kind: 'soft'; record: CachedLayout; coverage: number } | { kind: 'cold' };

/** What comes back from IndexedDB is whatever was written, by any earlier build. A record that fails here reads as a miss (design 6.2). */
export function isValidLayout(r: unknown): r is CachedLayout {
  if (!r || typeof r !== 'object') return false;
  const { hash, version, sha, at, ids, xy, community } = r as Partial<Record<keyof CachedLayout, unknown>>;
  if (typeof hash !== 'string' || typeof version !== 'number' || !Number.isFinite(at) || typeof at !== 'number' || (sha !== null && typeof sha !== 'string')) return false;
  if (!Array.isArray(ids) || !(xy instanceof Float32Array) || !(community instanceof Int32Array)) return false;
  if (xy.length !== ids.length * 2 || community.length !== ids.length) return false;
  if (!ids.every((id) => typeof id === 'string') || new Set(ids).size !== ids.length) return false;
  return xy.every(Number.isFinite);
}
export const usable = (records: readonly CachedLayout[]) => records.filter((r) => isValidLayout(r) && r.version === LAYOUT_VERSION);
const newest = (records: readonly CachedLayout[]) => records.reduce<CachedLayout | null>((best, r) => (!best || r.at > best.at ? r : best), null);

export function coverageOf(ids: readonly string[], record: CachedLayout): number {
  if (ids.length === 0) return 0;
  const known = new Set(record.ids);
  let hit = 0;
  for (const id of ids) if (known.has(id)) hit++;
  return hit / ids.length;
}

/** A hit needs the record to be the layout of these ids. A hash only says what was written next to them. */
export const sameIds = (ids: readonly string[], record: CachedLayout) => ids.length === record.ids.length && coverageOf(ids, record) === 1;
/** Every id is in the record. The record may hold more: the overview is filtered, the layout input is not. */
export const coversAll = (ids: readonly string[], record: CachedLayout) => ids.length === 0 || coverageOf(ids, record) === 1;

/** A manifest with the value last read means nothing was published: no download (design 6.2). */
export const findBySha = (records: readonly CachedLayout[], sha: string | null | undefined) => (sha ? newest(usable(records).filter((r) => r.sha === sha)) : null);

export function decideLayout(hash: string, ids: readonly string[], records: readonly CachedLayout[]): Decision {
  const list = usable(records);
  const same = newest(list.filter((r) => r.hash === hash));
  if (same && sameIds(ids, same)) return { kind: 'hit', record: same };
  const recent = newest(list);
  if (recent) {
    const coverage = coverageOf(ids, recent);
    if (coverage >= SOFT_MISS_COVERAGE) return { kind: 'soft', record: recent, coverage };
  }
  return { kind: 'cold' };
}
