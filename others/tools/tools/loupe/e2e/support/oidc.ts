// A test OpenID provider (oauth2-mock-server, maintained by AXA) and the login a browser would do, over plain HTTP.
// Used by the Playwright harness, the v2 login spec and the Vitest serve tests. Nothing here is real: the client secret is a placeholder.
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { OAuth2Server } from 'oauth2-mock-server';

export const OWNER_SUB = 'owner-sub-0001';
export const CLIENT = { client_id: 'loupe-test-client.apps.example', client_secret: 'placeholder-not-a-secret' };

type Payload = Record<string, unknown>;
export type Idp = {
  url: string;
  /** The `sub` the next ID tokens carry. */
  sub: string;
  /** Edits the next ID token only. */
  once: (edit: (p: Payload) => void) => void;
  /** Nonces of the ID tokens issued so far. */
  nonces: string[];
  stop: () => Promise<void>;
};

export async function startIdp(port = 0): Promise<Idp> {
  const server = new OAuth2Server();
  await server.issuer.keys.generate('RS256');
  await server.start(port, '127.0.0.1');
  // The provider is its own origin on 127.0.0.1, apart from the app's localhost origin.
  server.issuer.url = `http://127.0.0.1:${server.address().port}`;
  const idp: Idp = {
    url: server.issuer.url!, sub: OWNER_SUB, nonces: [],
    once: (edit) => { edits.push(edit); },
    stop: () => server.stop(),
  };
  const edits: ((p: Payload) => void)[] = [];
  server.service.on('beforeTokenSigning', (token: { payload: Payload }) => {
    if ('scope' in token.payload) return; // the access token
    token.payload.sub = idp.sub;
    token.payload.email = 'owner@example.test';
    const edit = edits.shift();
    if (edit) edit(token.payload);
    if (typeof token.payload.nonce === 'string') idp.nonces.push(token.payload.nonce);
  });
  return idp;
}

/** google-oauth.json and auth.json in `dir`, mode 600, as `loupe google-setup` and `loupe google-enroll` leave them. */
export function writeAuthConfig(dir: string, o: { sub?: string | null; breakglass?: string; client?: typeof CLIENT | null } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const put = (name: string, v: unknown) => { const f = path.join(dir, name); writeFileSync(f, JSON.stringify(v)); chmodSync(f, 0o600); };
  if (o.client !== null) put('google-oauth.json', o.client ?? CLIENT);
  if (o.sub !== null) put('auth.json', { sub: o.sub ?? OWNER_SUB, ...(o.breakglass ? { breakglass: o.breakglass } : {}) });
}

export const AUTH_HEADERS = (origin: string) => ({ origin, 'content-type': 'application/json', 'x-loupe-auth': '1', 'sec-fetch-site': 'same-origin' });
const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site' };

/** node:http, because fetch sets Sec-Fetch-Mode itself. */
export const rawGet = (url: string, headers: Record<string, string>) => new Promise<{ status: number; location: string | null; body: string }>((resolve, reject) => {
  const req = http.get(url, { headers }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode!, location: res.headers.location ?? null, body: b })); });
  req.on('error', reject);
});

export type LoginSteps = { start: { authorization_url: string; login_id: string; login_secret: string }; callbackUrl: string; callbackStatus: number; callbackLocation: string | null; proof: string | null };

/** The one-time proof the callback puts in the fragment: `/#/auth/finish?cb=<proof>`. */
export const proofOf = (location: string | null) => { const m = /#\/auth\/finish\?cb=([A-Za-z0-9_-]{43})$/.exec(location ?? ''); return m ? m[1]! : null; };

/** start → provider → callback, as the browser tab would. Returns what each step gave. */
export async function beginLogin(origin: string): Promise<LoginSteps> {
  const s = await fetch(`${origin}/auth/google/start`, { method: 'POST', headers: AUTH_HEADERS(origin), body: '{}' });
  if (s.status !== 200) throw new Error(`start answered ${s.status}`);
  const start = await s.json() as LoginSteps['start'];
  const a = await fetch(start.authorization_url, { redirect: 'manual' });
  const callbackUrl = a.headers.get('location')!;
  const c = await rawGet(callbackUrl, NAV);
  return { start, callbackUrl, callbackStatus: c.status, callbackLocation: c.location, proof: proofOf(c.location) };
}

export async function finishLogin(origin: string, body: Record<string, unknown>) {
  const r = await fetch(`${origin}/auth/google/finish`, { method: 'POST', headers: AUTH_HEADERS(origin), body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> | null, headers: r.headers };
}

/** The whole login. Returns the loupe session. */
export async function login(origin: string): Promise<string> {
  const steps = await beginLogin(origin);
  const f = await finishLogin(origin, { login_id: steps.start.login_id, login_secret: steps.start.login_secret, proof: steps.proof });
  if (f.status !== 200) throw new Error(`login to ${origin} failed: ${f.status} ${String(f.body?.code)} ${String(f.body?.reason ?? '')}`);
  return f.body!.session as string;
}
