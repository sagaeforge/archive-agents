// Reads for the task center. They go around `kbFetch` on purpose: that one marks the request with X-Loupe-Activity when a person's input is
// waiting, and a poll must never carry or use up that mark (design v2 6.1 step 5). Here the only credential is the session.
import { authStore, getSession } from '../auth/session.ts';
import { kbConfig } from '../data/kbFetch.ts';

export class ReadFailure extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code?: string) { super(code ?? `HTTP ${status}`); this.name = 'ReadFailure'; this.status = status; this.code = code; }
}
export type Envelope<T> = { data: T; page?: { next_cursor: string | null; total: number | null; truncated: boolean } };

export async function readKb<T>(path: string, signal?: AbortSignal): Promise<Envelope<T>> {
  const token = getSession();
  const timeout = AbortSignal.timeout(kbConfig.timeoutMs);
  let res: Response;
  try {
    res = await kbConfig.fetch(kbConfig.base() + path, {
      method: 'GET', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: token ? { authorization: `Bearer ${token}` } : {}, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch { throw new ReadFailure(0, 'network'); }
  if (res.ok) {
    try { return await res.json() as Envelope<T>; } catch { throw new ReadFailure(res.status, 'not_json'); }
  }
  let code: string | undefined;
  try { const p = await res.json() as { code?: unknown }; if (typeof p.code === 'string') code = p.code; } catch { /* no problem body */ }
  // loupe serve's own 401: the session is gone (same rule as kbFetch).
  if (res.status === 401 && code === 'session_required') authStore.expire();
  throw new ReadFailure(res.status, code);
}
/** `null` for the answers that mean "nothing there for you": 404 and, for a path the token may not read, 403. */
export async function readOrNull<T>(path: string, signal?: AbortSignal): Promise<Envelope<T> | null> {
  try { return await readKb<T>(path, signal); } catch (e) { if (e instanceof ReadFailure && (e.status === 404 || e.status === 403)) return null; throw e; }
}
export const seg = encodeURIComponent;
/** The time basis of the page for a time-aware read (design 4): `listNodes`, `getNode`, `listNodeClaims` and `listNodeEdges` take the axes, the first-party reads do not. */
export function axesOf(t: { valid?: string; observed?: string }): string {
  const q = new URLSearchParams();
  if (t.valid) q.set('as_of_valid', t.valid);
  if (t.observed) q.set('as_of_observed', t.observed);
  return q.toString();
}
export const withAxes = (path: string, axes: string) => (axes ? `${path}${path.includes('?') ? '&' : '?'}${axes}` : path);
