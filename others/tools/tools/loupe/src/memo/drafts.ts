// The drafts of the open memo windows, kept outside React so a window that is hidden, re-rendered or loaded again finds its text and its save
// state where it left them (design v2 5.2: "초안은 탭 메모리"). A draft lives until its window is closed (store.drop) or the tab goes.
import type { Precheck } from '../../server/precheck.ts';
import { discardWrite, postWrite, readWriteRef } from './api.ts';
import { memoPrecheck } from './rules.ts';
import { Saver } from './saver.ts';
import { memoStore } from './store.ts';
import { trackRejected, trackWrite, untrackRejected, untrackWrite } from '../tasks/registry.ts';

/** What the KB's `/v1/meta` said: the precheck is on only while its rule set is the KB's, `private` is open unless the KB says it is not. */
export const memoEnv: { precheck: Precheck | null; privateOpen: boolean } = { precheck: memoPrecheck(), privateOpen: true };
/** The task list re-reads when a save changes the registry. Set by the window, which has the query client. */
export const hooks: { registryChanged: () => void } = { registryChanged: () => undefined };

const drafts = new Map<string, Saver>();
const ping = <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => { f(...a); hooks.registryChanged(); };

export function draftFor(windowId: string, kind: 'Note' | 'Page' = 'Note'): Saver {
  let saver = drafts.get(windowId);
  if (!saver) {
    const s = new Saver({
      kind,
      post: postWrite, readRef: readWriteRef, discard: discardWrite,
      precheck: () => memoEnv.precheck, privateOpen: () => memoEnv.privateOpen,
      now: () => new Date(), uuid: () => globalThis.crypto.randomUUID(),
      setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      track: { changed: ping(() => undefined), write: ping(trackWrite), unwrite: ping(untrackWrite), rejected: ping(trackRejected), unrejected: ping(untrackRejected) },
    });
    drafts.set(windowId, s);
    memoStore.attach(windowId, () => { s.dispose(); drafts.delete(windowId); });
    saver = s;
  }
  return saver;
}
