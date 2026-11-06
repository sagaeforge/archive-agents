// The save machine of one record in one window, wired to the app's write path (memo/api.ts), the task registry and the secret rules the memo window loaded.
// One per record and window, so a record has one save in flight (design v2 5.2). It lives until the window closes (store.ts `retain`).
import { postWrite, readWriteRef } from '../memo/api.ts';
import { hooks, memoEnv } from '../memo/drafts.ts';
import { trackRejected, trackWrite, untrackRejected, untrackWrite } from '../tasks/registry.ts';
import { loadRecord } from './api.ts';
import { RowSaver } from './rowSaver.ts';
import { holdFor } from './store.ts';

const ping = <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => { f(...a); hooks.registryChanged(); };

export const rowSaverFor = (scope: string, id: string): RowSaver => holdFor(scope, id, () => new RowSaver(id, {
  post: postWrite, readRef: readWriteRef, load: loadRecord,
  precheck: () => memoEnv.precheck, now: () => new Date(),
  setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  track: { write: ping(trackWrite), unwrite: ping(untrackWrite), rejected: ping(trackRejected), unrejected: ping(untrackRejected) },
}));
