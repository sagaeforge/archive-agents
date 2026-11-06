// The browser's half of the write path (design v2 5.1, 5.9): one same-origin POST to `kb-write/<action>`, the answer sorted into what the
// window has to react to, and the two follow-ups of a 202 (the ref's state, the discard). This is the only file of the memo window that
// talks to the network. A write carries the session as Authorization and the marker header the server demands of every write; the KB's
// editor token is added by loupe serve and never reaches the browser.
import { authStore, getSession } from '../auth/session.ts';
import { activityHeader } from '../auth/activity.ts';
import { connection } from '../data/connection.ts';
import { kbConfig } from '../data/kbFetch.ts';
import { ReadFailure, readKb, seg } from '../tasks/api.ts';

export type Json = Record<string, unknown>;
export type WriteResult =
  | { t: 'ok'; status: number; body: Json }
  | { t: 'problem'; status: number; code: string | undefined; body: Json; retryAfterSec: number | undefined }
  | { t: 'network'; why: 'network' | 'timeout' | 'proxy' };

/** `/kb` and `/kb-write` are siblings under the mount path. */
const writeBase = () => kbConfig.base().replace(/\/kb$/, '') + '/kb-write';
const asJson = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});

export async function postWrite(path: string, body: unknown): Promise<WriteResult> {
  const token = getSession();
  const timeout = AbortSignal.timeout(kbConfig.longTimeoutMs);
  let res: Response;
  try {
    res = await kbConfig.fetch(writeBase() + path, {
      method: 'POST', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: timeout, body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-loupe-write': '1', ...(token ? { authorization: `Bearer ${token}` } : {}), ...activityHeader() },
    });
  } catch {
    const why = timeout.aborted ? 'timeout' : 'network';
    connection.fail({ reason: why, status: undefined, code: undefined });
    return { t: 'network', why };
  }
  let json: Json = {};
  try { json = asJson(await res.json()); } catch { /* no JSON body */ }
  const code = typeof json.code === 'string' ? json.code : undefined;
  if (res.status === 502 || res.status === 504 || (res.status === 503 && code !== 'token_not_configured' && code !== 'gate_busy' && code !== 'spool_full')) {
    connection.fail({ reason: 'proxy', status: res.status, code });
    return { t: 'network', why: 'proxy' };
  }
  connection.succeed();
  if (res.status === 401 && code === 'session_required') authStore.expire();
  if (res.ok) return { t: 'ok', status: res.status, body: json };
  const retry = Number(res.headers.get('retry-after'));
  return { t: 'problem', status: res.status, code, body: json, retryAfterSec: Number.isFinite(retry) && retry > 0 ? retry : undefined };
}

export type RefState = { state: 'pending' | 'committed' | 'failed' | 'purged' | 'unknown'; id: string | null; version: number | null; code: string | null } | 'gone' | 'network';
/** A background read: it carries no activity mark, so waiting for the KB does not keep a tab signed in (design v2 5.2, 6.1 step 5). */
export async function readWriteRef(ref: string): Promise<RefState> {
  try {
    const r = await readKb<Json>(`/v1/writes/${seg(ref)}`);
    const d = asJson(r.data);
    const state = d.state === 'pending' || d.state === 'committed' || d.state === 'failed' || d.state === 'purged' ? d.state : 'unknown';
    return { state, id: typeof d.id === 'string' ? d.id : null, version: typeof d.version === 'number' ? d.version : null, code: typeof d.code === 'string' ? d.code : null };
  } catch (e) {
    if (e instanceof ReadFailure && (e.status === 404 || e.status === 410)) return 'gone';
    return 'network';
  }
}

/** The person throws a failed write away: the KB drops its copy of the body too. */
export async function discardWrite(ref: string): Promise<boolean> {
  const r = await postWrite(`/writes/${seg(ref)}/discard`, {});
  return r.t === 'ok' || (r.t === 'problem' && r.status === 404);
}
