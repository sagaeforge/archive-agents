// The /kb-write/* half of loupe serve (design v2 5.1, 5.5, 11.2 M1): a fixed table from `POST /kb-write/<action>` to the KB's own method
// and path, the token of the scope each path needs, and nothing else. Anything outside the table is a 404; the checks of 6.3 (Host, Origin,
// content type, marker header) and the session run before this file is reached (server/serve.ts, server/auth/guard.ts).
//
// What this file promises:
//  - The browser's own headers never go upstream. The KB gets Content-Type, Accept, Content-Length and one Authorization: the `editor`
//    token on editor paths, the `reviewer` token on reviewer paths, never both and never the other one in its place. A token that is not
//    configured is a 503 here, before any KB call (the browser's Authorization is the loupe session and is not forwarded).
//  - It does not log a path, a query or a body, and it keeps nothing. A write answer is `Cache-Control: no-store`.
//  - A 422 `secret_detected` (and any answer that carries `hits`) is rebuilt from rule id and range alone, so a KB that echoes the value
//    cannot make loupe do it (ADR-0005 7.2: the KB does not; this is the second wall).
import http from 'node:http';
import https from 'node:https';
import type { Target } from './upstream.ts';
import { mapFailure } from './upstream.ts';

export type Scope = 'editor' | 'reviewer';
export type WriteRoute = {
  readonly method: 'POST';
  /** The browser's path, with `{x}` for a segment. */
  readonly path: string;
  readonly kb: { readonly method: 'POST' | 'PUT' | 'DELETE'; readonly path: string };
  readonly scope: Scope;
  /** Takes `?dry_run=1` (ADR-0005 2.2 and 7.7). */
  readonly dryRun?: boolean;
};

/** Design v2 5.1, row by row. Nothing here changes the allowed account, the break-glass path, a token or the idle limit. */
export const WRITE_ROUTES: readonly WriteRoute[] = [
  { method: 'POST', path: '/kb-write/records', kb: { method: 'POST', path: '/v1/records' }, scope: 'editor', dryRun: true },
  { method: 'POST', path: '/kb-write/records/{id}', kb: { method: 'PUT', path: '/v1/records/{id}' }, scope: 'editor', dryRun: true },
  { method: 'POST', path: '/kb-write/records/{id}/tombstone', kb: { method: 'POST', path: '/v1/records/{id}/tombstone' }, scope: 'editor' },
  { method: 'POST', path: '/kb-write/records/{id}/promote', kb: { method: 'POST', path: '/v1/records/{id}/promote' }, scope: 'editor' },
  { method: 'POST', path: '/kb-write/topics/{spec}/research', kb: { method: 'POST', path: '/v1/topics/{spec}/research' }, scope: 'editor' },
  { method: 'POST', path: '/kb-write/topics/{spec}/research/{run}/stop', kb: { method: 'POST', path: '/v1/topics/{spec}/research/{run}/stop' }, scope: 'editor' },
  { method: 'POST', path: '/kb-write/writes/{ref}/discard', kb: { method: 'DELETE', path: '/v1/writes/{ref}' }, scope: 'editor' },
  { method: 'POST', path: '/kb-write/actions', kb: { method: 'POST', path: '/v1/actions' }, scope: 'reviewer' },
  { method: 'POST', path: '/kb-write/actions/challenge', kb: { method: 'POST', path: '/v1/actions/challenge' }, scope: 'reviewer' },
  { method: 'POST', path: '/kb-write/actions/{id}/external-refine', kb: { method: 'POST', path: '/v1/actions/{id}/external-refine' }, scope: 'reviewer' },
  { method: 'POST', path: '/kb-write/actions/{id}/execute', kb: { method: 'POST', path: '/v1/actions/{id}/execute' }, scope: 'reviewer' },
  { method: 'POST', path: '/kb-write/hitl/challenge', kb: { method: 'POST', path: '/v1/hitl/challenge' }, scope: 'reviewer' },
  { method: 'POST', path: '/kb-write/hitl/{item}/resolve', kb: { method: 'POST', path: '/v1/hitl/{item}/resolve' }, scope: 'reviewer' },
  { method: 'POST', path: '/kb-write/reviewer/enroll', kb: { method: 'POST', path: '/v1/reviewer/enroll' }, scope: 'reviewer' },
];

const SEGMENT = '([^/?#]+)';
const compiled = WRITE_ROUTES.map((r) => ({ r, re: new RegExp(`^${r.path.replace(/\{\w+\}/g, SEGMENT)}$`) }));

/** ADR-0005 4.5: the request body is at most 2 MiB. */
export const WRITE_BODY_MAX = 2 * 1024 * 1024;
/** The largest KB answer loupe buffers: a 409 `current` carries a body of up to 200,000 characters. */
const ANSWER_MAX = 2 * 1024 * 1024;
const BODY_DEADLINE_MS = 10_000;

export type WriteContext = {
  kb: Target;
  editorToken?: string | undefined;
  reviewerToken?: string | undefined;
  firstByteMs: number;
  connectMs: number;
  unsafeSegment: (pathname: string) => boolean;
};

const problem = (status: number, code: string, title: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: `https://loupe.local/problems/${code.replace(/_/g, '-')}`, title, status, code, ...extra }), {
    status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store', ...headers },
  });

/** The route a browser path names, with the segments as they were sent (still percent-encoded), or null. */
export function matchWrite(pathname: string): { route: WriteRoute; kbPath: string } | null {
  for (const { r, re } of compiled) {
    const m = re.exec(pathname);
    if (!m) continue;
    let i = 0;
    return { route: r, kbPath: r.kb.path.replace(/\{\w+\}/g, () => m[++i]!) };
  }
  return null;
}

class TooLarge extends Error {}
class TooSlow extends Error {}
/** The request body, at most WRITE_BODY_MAX bytes within BODY_DEADLINE_MS. A body that is larger or stalls is refused, never waited on. */
async function readBody(req: Request): Promise<Buffer> {
  if (Number(req.headers.get('content-length') ?? 0) > WRITE_BODY_MAX) throw new TooLarge();
  const reader = req.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TooSlow()), BODY_DEADLINE_MS); });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), late]);
      if (done) break;
      size += value.byteLength;
      if (size > WRITE_BODY_MAX) throw new TooLarge();
      chunks.push(value);
    }
  } catch (e) { void reader.cancel().catch(() => undefined); throw e; } finally { clearTimeout(timer); }
  return Buffer.concat(chunks);
}

type Upstream = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
/** One request with a body to the KB. No retry: a write that may have gone out is resent by the browser with the same idempotency key. */
export function kbSend(t: Target, o: { method: string; path: string; headers: Record<string, string>; body?: Buffer | undefined; firstByteMs: number; connectMs: number }): Promise<Upstream> {
  return new Promise((resolve, reject) => {
    const mod = t.kind === 'tcp' && t.https ? https : http;
    const req = mod.request({ method: o.method, path: o.path, headers: o.headers, agent: false, ...(t.kind === 'unix' ? { socketPath: t.path } : { host: t.host, port: t.port }) });
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const code = (c: string, m: string) => Object.assign(new Error(m), { code: c });
    const fail = (e: Error) => { if (settled) return; settled = true; timers.forEach(clearTimeout); req.destroy(); reject(e); };
    timers.push(setTimeout(() => fail(code('KB_FIRST_BYTE_TIMEOUT', 'no response header from the KB in time')), o.firstByteMs));
    req.on('socket', (s) => { if (t.kind === 'tcp' && s.connecting) timers.push(setTimeout(() => fail(code('KB_CONNECT_TIMEOUT', 'KB connect timed out')), o.connectMs)); });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (d: Buffer) => { size += d.length; if (size > ANSWER_MAX) { fail(code('KB_ANSWER_TOO_LARGE', 'answer too large')); res.destroy(); return; } chunks.push(d); });
      res.on('end', () => { if (settled) return; settled = true; timers.forEach(clearTimeout); resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }); });
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end(o.body);
  });
}

const HIT_KEYS = ['field', 'rule', 'start', 'end', 'start_u16', 'end_u16'] as const;
/** A hit is a field name, a rule id and four numbers. Anything else the KB put on it is dropped. */
function cleanHits(v: unknown): Record<string, string | number>[] | null {
  if (!Array.isArray(v) || v.length > 1000) return null;
  const out: Record<string, string | number>[] = [];
  for (const h of v) {
    if (!h || typeof h !== 'object') return null;
    const o = h as Record<string, unknown>;
    if (typeof o.field !== 'string' || o.field.length > 120 || typeof o.rule !== 'string' || o.rule.length > 120) return null;
    const c: Record<string, string | number> = {};
    for (const k of HIT_KEYS) { const x = o[k]; if (k === 'field' || k === 'rule') c[k] = x as string; else if (typeof x === 'number' && Number.isInteger(x) && x >= 0) c[k] = x; else return null; }
    out.push(c);
  }
  return out;
}

const PASS_HEADERS = ['retry-after'];
/** The KB's answer as the browser gets it. Hits are rebuilt (see the top of the file); every other body passes as it came. */
function relay(up: Upstream): Response {
  const headers = new Headers({ 'cache-control': 'no-store' });
  for (const k of PASS_HEADERS) { const v = up.headers[k]; if (typeof v === 'string') headers.set(k, v); }
  const ct = String(up.headers['content-type'] ?? '').toLowerCase();
  const isJson = /^application\/(problem\+)?json/.test(ct);
  if (up.status === 204 || up.body.length === 0) return new Response(null, { status: up.status, headers });
  let parsed: unknown;
  if (isJson) { try { parsed = JSON.parse(up.body.toString('utf8')); } catch { parsed = undefined; } }
  const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  if (up.status === 422 || (obj && 'hits' in obj)) {
    // A 422 that is not a well-formed secret answer is not passed on: whatever it holds could be the value.
    const hits = obj ? cleanHits(obj.hits) : null;
    if (up.status === 422 && (!obj || obj.code !== 'secret_detected' || !hits)) return problem(502, 'kb_answer_invalid', 'KB answered in a form loupe does not pass on');
    if (!obj || !hits) return problem(502, 'kb_answer_invalid', 'KB answered in a form loupe does not pass on');
    headers.set('content-type', up.status === 422 ? 'application/problem+json' : 'application/json');
    if (up.status === 422) {
      return new Response(JSON.stringify({ type: 'https://kb.local/problems/secret-detected', title: 'secret detected', status: 422, detail: '비밀로 보이는 값이 있어 저장하지 않았다', code: 'secret_detected', hits, stored: obj.stored === true }), { status: 422, headers });
    }
    const rules = obj.secret_rules && typeof obj.secret_rules === 'object' ? obj.secret_rules as Record<string, unknown> : {};
    const clean = { would_reject: obj.would_reject === true, hits, secret_rules: { version: typeof rules.version === 'string' ? rules.version : null, sha: typeof rules.sha === 'string' ? rules.sha : null } };
    return new Response(JSON.stringify(clean), { status: up.status, headers });
  }
  headers.set('content-type', isJson ? ct.split(';')[0]! : 'application/json');
  if (!isJson) return problem(502, 'kb_answer_invalid', 'KB answered in a form loupe does not pass on');
  return new Response(new Uint8Array(up.body), { status: up.status, headers });
}

/** Which token a `/kb/*` read carries (design v2 5.1): the reviewer's on the reviewer-only reads, the editor's on every other read. Never both. */
export const readScope = (pathname: string): Scope => (/^\/v1\/(hitl|actions)(\/|$)/.test(pathname) ? 'reviewer' : 'editor');

/** Every /kb-write/* request that passed the checks and has a live session. */
export async function handleWrite(req: Request, pathname: string, ctx: WriteContext): Promise<Response> {
  const hit = matchWrite(pathname);
  if (!hit || ctx.unsafeSegment(pathname)) return problem(404, 'path_not_allowed', 'Path is not served');
  if (req.method !== 'POST') return problem(405, 'method_not_allowed', 'POST only', {}, { Allow: 'POST' });
  const { route, kbPath } = hit;

  // The query: only `dry_run=1`, only where the KB takes it.
  const qi = req.url.indexOf('?');
  let query = '';
  if (qi >= 0) {
    const q = new URLSearchParams(req.url.slice(qi + 1).split('#')[0]);
    const keys = [...q.keys()];
    if (!route.dryRun || keys.length !== 1 || keys[0] !== 'dry_run' || q.getAll('dry_run').length !== 1 || q.get('dry_run') !== '1') return problem(400, 'bad_param', 'Query parameter is not allowed');
    query = '?dry_run=1';
  }

  const token = route.scope === 'editor' ? ctx.editorToken : ctx.reviewerToken;
  if (!token) return problem(503, 'token_not_configured', 'The KB token for this action is not set up');

  let body: Buffer;
  try { body = await readBody(req); } catch (e) {
    if (e instanceof TooLarge) return problem(413, 'body_too_large', 'Request body is too large');
    if (e instanceof TooSlow) return problem(408, 'body_timeout', 'Request body did not arrive in time');
    throw e;
  }
  // Only a JSON object goes upstream. The KB would refuse anything else, but not with the bytes left out of loupe's own answer.
  try { const v: unknown = JSON.parse(body.toString('utf8')); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object'); } catch { return problem(400, 'bad_json', 'Request body is not a JSON object'); }

  try {
    const up = await kbSend(ctx.kb, {
      method: route.kb.method, path: kbPath + query, body, firstByteMs: ctx.firstByteMs, connectMs: ctx.connectMs,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': String(body.length), authorization: `Bearer ${token}` },
    });
    return relay(up);
  } catch (e) {
    const m = mapFailure(e);
    if ((e as NodeJS.ErrnoException).code === 'KB_ANSWER_TOO_LARGE') return problem(502, 'kb_answer_invalid', 'KB answered in a form loupe does not pass on');
    return problem(m.status, m.code, m.title, {}, { 'retry-after': '1' });
  }
}
