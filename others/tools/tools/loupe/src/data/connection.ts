// Connection state (design 7.4). KbUnavailable twice in a row means the KB is cut off; any answer from the KB ends that.
export type FailureInfo = { reason: 'network' | 'timeout' | 'proxy'; status: number | undefined; code: string | undefined };
export type ConnectionState = { failures: number; down: boolean; last: FailureInfo | null };

const INITIAL: ConnectionState = { failures: 0, down: false, last: null };
let state = INITIAL;
const listeners = new Set<() => void>();
const recoverListeners = new Set<() => void>();
const set = (s: ConnectionState) => { state = s; listeners.forEach((l) => l()); };

export const connection = {
  get: () => state,
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  onRecover: (l: () => void) => { recoverListeners.add(l); return () => { recoverListeners.delete(l); }; },
  /** True while a retry could help: false for a configuration error such as a denied socket (design 7.4). */
  canRetry: () => state.last?.code !== 'kb_socket_denied',
  succeed() {
    if (state.failures === 0) return;
    const wasDown = state.down;
    set(INITIAL);
    if (wasDown) recoverListeners.forEach((l) => l());
  },
  fail(last: FailureInfo) {
    const failures = state.failures + 1;
    // A denied socket is a configuration error and nothing will retry it, so waiting for a second failure would hide it.
    set({ failures, down: failures >= 2 || last.code === 'kb_socket_denied', last });
  },
  reset() { set(INITIAL); },
};
