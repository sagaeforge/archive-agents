// The login of design v2 6: Google OIDC for the one allowed `sub`, sessions behind `Authorization: Bearer`, lock, and the
// break-glass password a terminal opens for an hour. Plain Request → Response functions; serve.ts routes to them after the 6.3 checks.
// Logs carry times and fixed words only: no token, code, state, password, sub or e-mail.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { FailureDelay, OPEN_MS, verifyPassword } from './breakglass.ts';
import { FILES, removeFile, watchedJson, type AuthFile, type ClientFile, type LoupeFile, type OpenFile } from './files.ts';
import { GOOGLE_ISSUER, LoginFailure, Oidc } from './oidc.ts';
import { bearer, IDLE_MS, MAX_MS, Sessions } from './sessions.ts';

export type AuthOptions = {
  /** Directory holding google-oauth.json, auth.json and breakglass-open.json. */
  dir: string;
  /** The local port. Without loupe.json the only allowed origin is http://localhost:<port>. */
  port: number;
  issuer?: string | undefined;
  issuerAliases?: string[] | undefined;
  now?: (() => number) | undefined;
  /** Test seam: the password check (default argon2id verifyPassword). */
  verify?: ((password: string, phc: string) => Promise<boolean>) | undefined;
  /** May only shorten the 5 s body deadline (tests). */
  bodyDeadlineMs?: number | undefined;
  /** May only shorten the 1 h idle limit (tests). */
  idleMs?: number | undefined;
  socketActivated?: boolean | undefined;
  /** True when systemd passed the `secret` socket (design v2 8.1). */
  secretFd?: boolean | undefined;
  /** The KB part of the status (design v2 2.8). Given by serve.ts, which owns the KB connection. */
  kb?: ((origin: string) => Promise<Record<string, unknown>>) | undefined;
  log?: ((line: string) => void) | undefined;
};

/**
 * Every route /auth/* answers, and the only list it dispatches from. `effect` names what a request may change in loupe serve:
 * nothing (`read`), or only a session or a login in flight (`session`). The allowed account, the break-glass hash and its opening,
 * the KB tokens and the idle limit are files and flags a terminal owns (design v2 2.8, 6.2, 6.5): no entry here writes them.
 */
export type RouteEntry = { readonly method: 'GET' | 'POST'; readonly path: string; readonly effect: 'read' | 'session' };
export const AUTH_ROUTES: readonly RouteEntry[] = [
  { method: 'GET', path: '/auth/status', effect: 'read' },
  { method: 'GET', path: '/auth/status/detail', effect: 'read' },
  { method: 'GET', path: '/auth/session', effect: 'read' },
  { method: 'GET', path: '/auth/google/callback', effect: 'session' },
  { method: 'POST', path: '/auth/google/start', effect: 'session' },
  { method: 'POST', path: '/auth/google/finish', effect: 'session' },
  { method: 'POST', path: '/auth/breakglass', effect: 'session' },
  { method: 'POST', path: '/auth/lock', effect: 'session' },
];

/** The secret window's fixed numbers (design v2 8.1, 8.2). The settings window shows them; nothing on the web sets them. */
const SECRET_WINDOW = { port: 4814, lock_idle_ms: 180_000, clipboard_clear_ms: 20_000 } as const;

export const LOGIN_TTL_MS = 5 * 60_000;
export const STARTS_PER_MINUTE = 10;
const ID_SHAPE = /^[A-Za-z0-9_-]{43}$/;

type Login = {
  secret: string; state: string; nonce: string; verifier: string; origin: string; redirectUri: string; created: number;
  status: 'waiting' | 'done' | 'failed'; reason?: string;
  /** Digest of the one-time proof the callback put in the fragment of the browser that came back from Google. */
  proof?: string;
  /** The account the callback accepted; checked again against the allowed account at finish. */
  sub?: string;
};

/**
 * An origin Google accepts for a web client's redirect URI and loupe accepts as its own (owner-corrected 2026-11-04):
 * http only on localhost (WebAuthn cannot use an IP as RP ID; ADR-0005 반영 2026-11-04), otherwise https on a host name
 * (no raw IP), no path, no wildcard.
 */
export function validOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.includes('*')) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.origin !== raw.replace(/\/$/, '') || u.username || u.password) return null;
  if (u.protocol === 'http:') return u.hostname === 'localhost' ? u.origin : null;
  if (u.protocol !== 'https:') return null;
  if (/^[\d.]+$/.test(u.hostname) || u.hostname.startsWith('[') || !u.hostname.includes('.')) return null;
  return u.origin;
}

const sha = (s: string) => createHash('sha256').update(s).digest();
const NO_STORE = { 'cache-control': 'no-store' };
export const problem = (status: number, code: string, title: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: `https://loupe.local/problems/${code.replace(/_/g, '-')}`, title, status, code, ...extra }), { status, headers: { 'content-type': 'application/problem+json', ...NO_STORE, ...headers } });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...NO_STORE } });

export const BODY_MAX_BYTES = 4096;
export const BODY_DEADLINE_MS = 5_000;
class BodyRefused extends Error {
  readonly status: 408 | 413;
  constructor(status: 408 | 413) { super(String(status)); this.status = status; }
}

/** An /auth/* JSON body: at most 4 KiB, within 5 s. A stalled or oversized body is refused, never waited on (Codex re-review B). */
async function body(req: Request, deadlineMs = BODY_DEADLINE_MS): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get('content-length') ?? 0) > BODY_MAX_BYTES) throw new BodyRefused(413);
  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BodyRefused(408)), deadlineMs); });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), late]);
      if (done) break;
      size += value.byteLength;
      if (size > BODY_MAX_BYTES) throw new BodyRefused(413);
      chunks.push(value);
    }
  } catch (e) {
    void reader.cancel().catch(() => undefined);
    throw e;
  } finally { clearTimeout(timer); }
  try {
    const b: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : null;
  } catch { return null; }
}

export function createAuth(o: AuthOptions) {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((l: string) => console.log(l));
  // localhost, not 127.0.0.1: WebAuthn refuses an IP as RP ID, and ADR-0005 needs user verification here (ADR-0005 반영 2026-11-04).
  const defaultOrigin = `http://localhost:${o.port}`;
  const issuer = o.issuer ?? GOOGLE_ISSUER;
  const readClient = watchedJson<ClientFile>(path.join(o.dir, FILES.client));
  const readAuth = watchedJson<AuthFile>(path.join(o.dir, FILES.auth));
  const openFile = path.join(o.dir, FILES.breakglassOpen);
  const readOpen = watchedJson<OpenFile>(openFile);
  const readLoupe = watchedJson<LoupeFile>(path.join(o.dir, FILES.loupe));
  /** The origin allowlist: loupe.json `origins`, or only http://localhost:<port> when the file is absent. Invalid entries are dropped. */
  const originList = () => {
    const f = readLoupe();
    if (f.problem) return { origins: [] as string[], problems: [`${f.problem.file}: ${f.problem.reason}`] };
    if (!f.value) return { origins: [defaultOrigin], problems: [] as string[] };
    const raw = Array.isArray(f.value.origins) ? f.value.origins : [];
    const origins = raw.map(validOrigin).filter((x): x is string => x !== null);
    const problems = raw.length !== origins.length ? [`${FILES.loupe}: ${raw.length - origins.length} invalid origin(s) ignored`] : [];
    return { origins: [...new Set(origins)], problems };
  };
  const origins = () => originList().origins;
  const sessions = new Sessions(now, Math.min(IDLE_MS, o.idleMs ?? IDLE_MS), MAX_MS);
  const logins = new Map<string, Login>();
  const byState = new Map<string, string>();
  let starts: number[] = [];
  const delay = new FailureDelay(now);
  let checking = false;
  let knownSub: string | undefined;

  /** What the files say now. A change of the allowed account closes every session (6.2 step 6). */
  const setup = () => {
    const c = readClient(), a = readAuth();
    const sub = typeof a.value?.sub === 'string' && a.value.sub ? a.value.sub : undefined;
    if (knownSub !== undefined && sub !== knownSub) {
      // Sessions and every login in flight, waiting or already called back, belong to the old account.
      const had = sessions.size + logins.size;
      sessions.clear(); logins.clear(); byState.clear();
      if (had) log(`auth ${new Date(now()).toISOString()}: allowed account changed, all sessions and logins closed`);
    }
    knownSub = sub;
    const client = c.value && typeof c.value.client_id === 'string' && c.value.client_id && typeof c.value.client_secret === 'string' && c.value.client_secret ? c.value : null;
    return {
      client, sub, breakglass: typeof a.value?.breakglass === 'string' ? a.value.breakglass : undefined,
      problems: [...[c.problem, a.problem].filter((p) => p !== null).map((p) => `${p.file}: ${p.reason}`), ...originList().problems],
    };
  };
  const ready = (s: ReturnType<typeof setup>) => !!s.client && !!s.sub;
  let seenOpen = 0;
  // Remembered while the server runs, for the settings card; a restart forgets them.
  let lastOpened: number | null = null, lastUsed: number | null = null;
  const breakglassOpen = () => {
    const v = readOpen().value;
    const t = now();
    const open = !!v && typeof v.until === 'number' && v.until > t && v.until - t <= OPEN_MS;
    if (open) lastOpened = v.until - OPEN_MS;
    // Opening is logged (time only) the first time the server sees it (6.5).
    if (open && v.until !== seenOpen) { seenOpen = v.until; log(`auth ${new Date(t).toISOString()}: break-glass path open until ${new Date(v.until).toISOString()}`); }
    return open;
  };
  const oidc = new Oidc(() => ({ issuer, client: setup().client!, issuerAliases: o.issuerAliases }));

  const prune = () => {
    const t = now();
    for (const [id, l] of logins) if (t - l.created > LOGIN_TTL_MS) { logins.delete(id); byState.delete(l.state); }
    starts = starts.filter((s) => t - s < 60_000);
  };
  const stamp = () => new Date(now()).toISOString();

  /**
   * The session on a request, if live. Used by /kb/* and /kb-write/* after the checks. Only a request the client marks as following
   * a person's input (X-Loupe-Activity: 1) restarts the idle clock; polls do not, so an unattended tab ends after the idle limit.
   */
  const sessionOf = (req: Request) => { setup(); return sessions.touch(bearer(req.headers.get('authorization')), req.headers.get('x-loupe-activity') === '1'); };

  /** `origin` is the allowlisted origin the request came to; its callback becomes this login's redirect_uri. */
  async function start(origin: string): Promise<Response> {
    const s = setup();
    if (!ready(s)) return problem(503, 'setup_needed', 'Login is not set up');
    prune();
    if (starts.length >= STARTS_PER_MINUTE) return problem(429, 'too_many_logins', 'Too many logins started', {}, { 'retry-after': String(Math.max(1, Math.ceil((starts[0]! + 60_000 - now()) / 1000))) });
    starts.push(now());
    let b;
    // The allowed account's sub is a valid login_hint for Google; its e-mail is not stored anywhere.
    const redirectUri = `${origin}/auth/google/callback`;
    try { b = await oidc.begin({ scope: 'openid', redirectUri, loginHint: s.sub }); } catch (e) {
      log(`auth ${stamp()}: login start failed (${e instanceof LoginFailure ? e.code : 'error'})`);
      return problem(502, 'provider_unreachable', 'The identity provider could not be reached');
    }
    const id = randomBytes(32).toString('base64url'), secret = randomBytes(32).toString('base64url');
    logins.set(id, { secret: sha(secret).toString('base64url'), state: b.state, nonce: b.nonce, verifier: b.verifier, origin, redirectUri, created: now(), status: 'waiting' });
    byState.set(b.state, id);
    return json(200, { authorization_url: b.url, login_id: id, login_secret: secret });
  }

  async function callback(req: Request, origin: string): Promise<Response> {
    const plain = new Response(null, { status: 303, headers: { location: `${origin}/#/auth/finish`, ...NO_STORE } });
    let done = plain;
    prune();
    // Only `state`, `code`, `iss` and an error flag are read; everything else is ignored (6.3).
    const q = new URL(req.url).searchParams;
    const state = q.get('state'), code = q.get('code');
    const id = state ? byState.get(state) : undefined;
    const login = id ? logins.get(id) : undefined;
    // A callback with no live state changes nothing and is not counted.
    if (!state || !id || !login || login.status !== 'waiting') return done;
    byState.delete(state);
    // The proof goes only to the browser that came back from Google, in the fragment, which never reaches a server. finish needs it
    // and the starting tab's login_secret together, so a login started by someone else and completed by the owner (a relay) cannot
    // be redeemed by either side alone.
    const proof = randomBytes(32).toString('base64url');
    login.proof = sha(proof).toString('base64url');
    done = new Response(null, { status: 303, headers: { location: `${origin}/#/auth/finish?cb=${proof}`, ...NO_STORE } });
    const fail = (reason: string) => { login.status = 'failed'; login.reason = reason; log(`auth ${stamp()}: google login refused (${reason})`); return done; };
    if (q.has('error') || !code) return fail('provider_error');
    // The redirect_uri of a login started on origin A is A's callback; arriving on B means something rerouted it.
    if (origin !== login.origin) return fail('origin_mismatch');
    let claims;
    try { claims = await oidc.finish({ code, state, iss: q.get('iss') ?? undefined }, login); } catch (e) {
      return fail(e instanceof LoginFailure ? e.code : 'exchange_failed');
    }
    // The nonce was compared with this login's own by oauth4webapi; a login is used once, so an old nonce cannot match.
    const s = setup();
    if (!s.sub || claims.sub !== s.sub) return fail('account_not_allowed');
    login.sub = claims.sub;
    login.status = 'done';
    return done;
  }

  async function finish(req: Request, origin: string): Promise<Response> {
    let b;
    try { b = await body(req); } catch (e) { if (e instanceof BodyRefused) return problem(e.status, e.status === 408 ? 'body_timeout' : 'body_too_large', 'Request body refused'); throw e; }
    const id = b?.login_id, secret = b?.login_secret, proof = b?.proof;
    if (typeof id !== 'string' || !ID_SHAPE.test(id)) return problem(400, 'login_unknown', 'No such login');
    if (typeof secret !== 'string' || !ID_SHAPE.test(secret)) return problem(400, 'login_secret_required', 'login_secret is required');
    setup(); // an account change since the callback drops every login before it is looked up
    prune();
    const login = logins.get(id);
    if (!login) return problem(400, 'login_unknown', 'No such login');
    if (!timingSafeEqual(sha(secret), Buffer.from(login.secret, 'base64url'))) {
      logins.delete(id); byState.delete(login.state);
      log(`auth ${stamp()}: login finish refused (secret)`);
      return problem(403, 'login_secret_mismatch', 'This login was started elsewhere');
    }
    // A login finishes only on the origin it started on (its sessionStorage and redirect_uri belong there).
    if (origin !== login.origin) {
      logins.delete(id); byState.delete(login.state);
      log(`auth ${stamp()}: login finish refused (origin)`);
      return problem(403, 'origin_mismatch', 'This login was started on another origin');
    }
    if (login.status === 'waiting') return problem(409, 'login_pending', 'The provider has not answered yet');
    // Without the proof from the callback's fragment this tab only started the login; someone else's browser finished it.
    if (typeof proof !== 'string' || !ID_SHAPE.test(proof) || !login.proof || !timingSafeEqual(sha(proof), Buffer.from(login.proof, 'base64url'))) {
      log(`auth ${stamp()}: login finish refused (proof)`);
      return problem(403, 'proof_mismatch', 'This browser did not complete the login');
    }
    logins.delete(id);
    if (login.status === 'failed') return problem(401, 'login_failed', 'Login failed', { reason: login.reason });
    // The allowed account may have changed since the callback.
    if (!login.sub || login.sub !== setup().sub) { log(`auth ${stamp()}: login finish refused (account)`); return problem(401, 'login_failed', 'Login failed', { reason: 'account_not_allowed' }); }
    const session = sessions.issue('google');
    if (breakglassOpen() || readOpen().value) { removeFile(openFile); log(`auth ${stamp()}: break-glass closed by a Google login`); }
    log(`auth ${stamp()}: google login`);
    return json(200, { session, idle_ms: sessions.idleMs, max_ms: sessions.maxMs });
  }

  async function breakglass(req: Request): Promise<Response> {
    const s = setup();
    // Closed means absent: the path answers like any unknown one.
    if (!ready(s) || !s.breakglass || !breakglassOpen()) return problem(404, 'not_found', 'Not found');
    const slow = (w: number) => problem(429, 'slow_down', 'Wait before trying again', { retry_after: Math.max(1, w) }, { 'retry-after': String(Math.max(1, w)) });
    // One attempt at a time, taken before the body is awaited: a slow body cannot hold a place in the queue past the delay.
    if (delay.waitS() > 0 || checking) return slow(delay.waitS());
    checking = true;
    let ok = false;
    try {
      const b = await body(req, Math.min(BODY_DEADLINE_MS, o.bodyDeadlineMs ?? BODY_DEADLINE_MS));
      const pw = b?.password;
      if (typeof pw !== 'string' || pw.length === 0 || pw.length > 1024) return problem(400, 'password_required', 'password is required');
      // The body may have taken its time: look again at the open state and the delay right before verifying.
      const now2 = setup();
      if (!ready(now2) || !now2.breakglass || !breakglassOpen()) return problem(404, 'not_found', 'Not found');
      if (delay.waitS() > 0) return slow(delay.waitS());
      ok = await (o.verify ?? verifyPassword)(pw, now2.breakglass);
      // Argon2 takes time: the opening may have closed, the account or the hash may have changed meanwhile (Codex re-review A).
      // A password that was right for a state that no longer holds gives nothing.
      if (ok) {
        const after = setup();
        if (!ready(after) || after.sub !== now2.sub || after.breakglass !== now2.breakglass || !breakglassOpen()) {
          log(`auth ${stamp()}: break-glass login refused (state changed during the check)`);
          return problem(404, 'not_found', 'Not found');
        }
      }
    } catch (e) {
      if (e instanceof BodyRefused) return problem(e.status, e.status === 408 ? 'body_timeout' : 'body_too_large', e.status === 408 ? 'Request body too slow' : 'Request body too large');
      throw e;
    } finally { checking = false; }
    if (!ok) {
      delay.fail();
      log(`auth ${stamp()}: break-glass attempt failed`);
      const w = delay.waitS();
      return problem(401, 'password_wrong', 'Wrong password', w ? { retry_after: w } : {}, w ? { 'retry-after': String(w) } : {});
    }
    delay.succeed();
    lastUsed = now();
    log(`auth ${stamp()}: break-glass login`);
    return json(200, { session: sessions.issue('breakglass'), idle_ms: sessions.idleMs, max_ms: sessions.maxMs });
  }

  /** The settings window's read-only status (design v2 2.8): fixed words and numbers, never a token, path, host name or address. */
  async function detail(req: Request, origin: string): Promise<Response> {
    const s = setup();
    // sessionOf restarts the idle clock only for a request marked as following input; the settings window's poll is not one.
    const live = sessionOf(req) ? sessions.info(bearer(req.headers.get('authorization'))) : null;
    if (!live) return problem(401, 'session_required', 'Sign in first');
    const t = now();
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    const open = ready(s) && !!s.breakglass && breakglassOpen();
    return json(200, {
      account: { allowed: s.sub ? 1 : 0, via: live.via },
      session: { idle_ms: sessions.idleMs, max_ms: sessions.maxMs, idle_left_ms: live.idleLeftMs, max_left_ms: live.maxLeftMs },
      kb: o.kb ? await o.kb(origin) : { connected: false, data_as_of: null, write: null },
      // Days left of the editor and reviewer tokens come with their token files (M1); until then there is nothing to count.
      tokens: { editor: { days_left: null }, reviewer: { days_left: null } },
      breakglass: { open, last_opened: iso(lastOpened), last_used: iso(lastUsed) },
      secret_window: { socket_fd: !!o.secretFd, ...SECRET_WINDOW },
      socket_activated: !!o.socketActivated,
      at: new Date(t).toISOString(),
    });
  }

  const refused = (e: unknown) => {
    if (e instanceof BodyRefused) return problem(e.status, e.status === 408 ? 'body_timeout' : 'body_too_large', 'Request body refused');
    throw e;
  };
  /** Every other POST reads its body too, under the same 4 KiB / 5 s limits, though it has no use for it. */
  const afterBody = (run: (req: Request, origin: string) => Response | Promise<Response>) => async (req: Request, origin: string) => {
    try { await body(req); } catch (e) { return refused(e); }
    return run(req, origin);
  };
  const runners: Record<string, (req: Request, origin: string) => Response | Promise<Response>> = {
    'GET /auth/status': () => {
      const s = setup();
      return json(200, { ready: ready(s), setup: { client: !!s.client, account: !!s.sub, problems: s.problems }, breakglass_open: ready(s) && !!s.breakglass && breakglassOpen(), socket_activated: !!o.socketActivated });
    },
    'GET /auth/status/detail': detail,
    'GET /auth/session': (req) => (sessionOf(req) ? json(200, { ok: true }) : problem(401, 'session_required', 'Sign in first')),
    'GET /auth/google/callback': callback,
    'POST /auth/google/start': afterBody((_req, origin) => start(origin)),
    'POST /auth/google/finish': finish,
    // breakglass takes its guard first and then reads the body under the same limits.
    'POST /auth/breakglass': breakglass,
    'POST /auth/lock': afterBody((req) => { sessions.revoke(bearer(req.headers.get('authorization'))); log(`auth ${stamp()}: locked`); return new Response(null, { status: 204, headers: NO_STORE }); }),
  };
  for (const r of AUTH_ROUTES) if (!runners[`${r.method} ${r.path}`]) throw new Error(`no handler for ${r.method} ${r.path}`);

  /** Every /auth/* request, after check(). Dispatches from AUTH_ROUTES and nothing else. */
  async function handle(req: Request, pathname: string, origin: string): Promise<Response> {
    const m = req.method;
    const route = AUTH_ROUTES.find((r) => r.path === pathname && (r.method === m || (m === 'HEAD' && r.method === 'GET' && pathname !== '/auth/google/callback')));
    if (route) return runners[`${route.method} ${route.path}`]!(req, origin);
    // An unknown POST is refused after its body was read under the same limits, as every POST is.
    return m === 'POST' ? afterBody(() => problem(404, 'not_found', 'Not found'))(req, origin) : problem(404, 'not_found', 'Not found');
  }

  return { origins, handle, sessionOf, sessions, breakglassOpen, setup };
}
export type Auth = ReturnType<typeof createAuth>;
