// The last envelope seen by kbFetch (design 7.3). A tiny external store for useSyncExternalStore.
export type EnvelopeMeta = {
  schema_version: string; epoch: number; build_id: string; data_as_of: string; applied_seq: number;
  as_of: { valid?: string | null; observed?: string | null }; degraded: string[];
};
export type EnvelopeState = { meta: EnvelopeMeta | null; lastOkAt: number | null };
export type EnvelopeChange = { epochChanged: boolean; appliedSeqIncreased: boolean; buildIdChanged: boolean };

let state: EnvelopeState = { meta: null, lastOkAt: null };
const listeners = new Set<() => void>();
const changeListeners = new Set<(prev: EnvelopeMeta | null, next: EnvelopeMeta, c: EnvelopeChange) => void>();

export const envelopeStore = {
  get: () => state,
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  /** Called on epoch change and applied_seq increase. build_id changes are reported but must be ignored (C 2.6). */
  onChange: (l: (prev: EnvelopeMeta | null, next: EnvelopeMeta, c: EnvelopeChange) => void) => { changeListeners.add(l); return () => { changeListeners.delete(l); }; },
  /**
   * `fromMeta`: the envelope came from /v1/meta. `degraded` is taken from /v1/meta only, so the header does not depend on which
   * response arrived last (before, any envelope could overwrite it). Until the first /v1/meta it is whatever envelope came first.
   */
  update(e: EnvelopeMeta, now = Date.now(), fromMeta = true) {
    const prev = state.meta;
    const degraded = fromMeta || !prev ? (e.degraded ?? []) : prev.degraded;
    const meta: EnvelopeMeta = { schema_version: e.schema_version, epoch: e.epoch, build_id: e.build_id, data_as_of: e.data_as_of, applied_seq: e.applied_seq, as_of: e.as_of ?? {}, degraded };
    state = { meta, lastOkAt: now };
    const change: EnvelopeChange = {
      epochChanged: !!prev && prev.epoch !== meta.epoch,
      appliedSeqIncreased: !!prev && meta.applied_seq > prev.applied_seq,
      buildIdChanged: !!prev && prev.build_id !== meta.build_id,
    };
    changeListeners.forEach((l) => l(prev, meta, change));
    listeners.forEach((l) => l());
  },
  reset() { state = { meta: null, lastOkAt: null }; listeners.forEach((l) => l()); },
};
