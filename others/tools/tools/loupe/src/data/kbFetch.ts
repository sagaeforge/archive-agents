// The Orval mutator and the adapter seam (design 7.2). The browser always calls the same-origin relative path `kb/`.
import { envelopeStore } from './envelopeStore.ts';
import { connection } from './connection.ts';
import { authStore, getSession } from '../auth/session.ts';
import { activityHeader } from '../auth/activity.ts';

/** The loupe session as a header (design v2 6.1 step 5). Every /kb request carries it; there is no cookie. */
export const authHeaders = (): Record<string, string> => { const s = getSession(); return s ? { authorization: `Bearer ${s}`, ...activityHeader() } : {}; };

export type Problem = { type: string; title: string; status: number; detail?: string; code?: string; instance?: string; [k: string]: unknown };

/** The KB answered with an error (RFC 9457). The KB is up. */
export class KbProblem extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly problem: Problem;
  readonly retryAfterSec: number | undefined;
  constructor(problem: Problem, retryAfterSec?: number) {
    super(problem.title);
    this.name = 'KbProblem';
    this.problem = problem;
    this.status = problem.status;
    this.code = problem.code;
    this.retryAfterSec = retryAfterSec;
  }
}

/** Network failure, timeout, or 502/504 from loupe serve. Two in a row mean "KB unavailable" (design 7.4). */
export class KbUnavailable extends Error {
  readonly reason: 'network' | 'timeout' | 'proxy';
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(reason: 'network' | 'timeout' | 'proxy', message: string, status?: number, code?: string) {
    super(message);
    this.name = 'KbUnavailable';
    this.reason = reason;
    this.status = status;
    this.code = code;
  }
}

export type ErrorType<E> = KbProblem & { problem: E };

type KbConfig = {
  /** Prefix for generated paths. Default: `new URL('kb', document.baseURI).pathname`. Tests pass an absolute URL. */
  base: () => string;
  fetch: typeof fetch;
  timeoutMs: number;
  longTimeoutMs: number;
};

const defaultBase = () => {
  if (typeof document === 'undefined') throw new Error('kbFetch needs configureKb({ base }) outside a browser');
  return new URL('kb', document.baseURI).pathname.replace(/\/$/, '');
};
export const kbConfig: KbConfig = { base: defaultBase, fetch: (...a) => globalThis.fetch(...a), timeoutMs: 8_000, longTimeoutMs: 30_000 };
export const configureKb = (c: Partial<KbConfig>) => { Object.assign(kbConfig, c); };

const LONG = /^\/v1\/(overview|export\/)/;
// Overview, change feed, schema and meta revalidate by ETag through the HTTP cache: C 2.5 now gives all four one (design 7.2).
// Everything else may carry sensitivity-labelled text and must not reach the disk cache.
export const cacheFor = (path: string): RequestCache => (/^\/v1\/(overview|changes|schema|meta)(\?|$)/.test(path) ? 'no-cache' : 'no-store');

// The KB confirms the time basis in the envelope. Parsed instants are compared, not strings: `as_of_valid` may come back normalized (design 4).
const sameInstant = (a: string | null | undefined, b: string | null) => (a == null ? b === null : b !== null && Date.parse(a) === Date.parse(b));
export function asOfConfirmed(url: string, asOf: { valid?: string | null; observed?: string | null } | undefined): boolean {
  const q = new URLSearchParams(url.split('?')[1] ?? '');
  return sameInstant(asOf?.valid, q.get('as_of_valid')) && sameInstant(asOf?.observed, q.get('as_of_observed'));
}

const isProblemJson = (res: Response) => /\bproblem\+json\b/i.test(res.headers.get('content-type') ?? '');
// Anything that says it is an envelope is checked as one. A body without `as_of` is a KB breaking a required field,
// and it must not slip past the time check and be shown under a past label (design 1, criterion 3).
const looksLikeEnvelope = (b: unknown): b is Parameters<typeof envelopeStore.update>[0] =>
  !!b && typeof b === 'object' && 'schema_version' in b && 'data' in b;

/** `url` is a generated path such as `/v1/nodes/e%3Afoo?as_of_valid=…`. It is joined to the base as a string. */
export const kbFetch = async <T>(url: string, init?: RequestInit): Promise<T> => {
  try {
    const out = await request<T>(url, init);
    connection.succeed();
    return out;
  } catch (e) {
    if (e instanceof KbUnavailable) connection.fail({ reason: e.reason, status: e.status, code: e.code });
    else if (e instanceof KbProblem) connection.succeed(); // the KB answered
    throw e;
  }
};

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const timeoutMs = LONG.test(url) ? kbConfig.longTimeoutMs : kbConfig.timeoutMs;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let res: Response;
  try {
    // String concatenation on purpose: new URL(url, base) drops the mount prefix for paths starting with /v1.
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(authHeaders())) headers.set(k, v);
    res = await kbConfig.fetch(kbConfig.base() + url, { cache: cacheFor(url), ...init, headers, signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch (e) {
    if (init?.signal?.aborted) throw e;
    if (timeout.aborted) throw new KbUnavailable('timeout', `KB did not answer within ${timeoutMs} ms`);
    throw new KbUnavailable('network', e instanceof Error ? e.message : String(e));
  }
  try {
    if (res.ok) {
      const ct = res.headers.get('content-type') ?? '';
      if (/\bjson\b/i.test(ct)) {
        const body: unknown = await res.json();
        if (looksLikeEnvelope(body)) {
          if ('applied_seq' in body) envelopeStore.update(body, Date.now(), /^\/v1\/meta(\?|$)/.test(url));
          // A KB that ignored an axis would show the present under a past label. That screen must not exist (design 1, criterion 3).
          if (!asOfConfirmed(url, body.as_of)) throw new KbProblem({ type: 'about:blank', title: 'as_of_mismatch', status: 500, code: 'as_of_mismatch' });
        }
        return body as T;
      }
      return (/^text\//i.test(ct) ? await res.text() : await res.blob()) as T;
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    let problem: Problem = { type: 'about:blank', title: res.statusText || `HTTP ${res.status}`, status: res.status };
    // A body that is not problem+json (for example Starlette's text/plain) must not break the client.
    if (isProblemJson(res)) {
      try { problem = { ...problem, ...(await res.json()) }; } catch { /* keep the synthesized problem */ }
    }
    // loupe serve's own 401: the session is gone. The KB's 401 (token_required) is a configuration fault and stays an error.
    if (res.status === 401 && problem.code === 'session_required') authStore.expire();
    if (res.status === 502 || res.status === 504) throw new KbUnavailable('proxy', problem.title, res.status, problem.code);
    throw new KbProblem(problem, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
  } catch (e) {
    if (e instanceof KbProblem || e instanceof KbUnavailable) throw e;
    if (init?.signal?.aborted) throw e;
    if (timeout.aborted) throw new KbUnavailable('timeout', `KB did not finish the body within ${timeoutMs} ms`);
    throw new KbUnavailable('network', e instanceof Error ? e.message : String(e));
  }
};
export default kbFetch;
