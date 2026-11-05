// loupe v2 M0b (design v2 6, 11.1): the Google login against a test OpenID provider, the 6.3 checks, lock, expiry, break-glass and
// the terminal-only commands. Each test gets its own loupe serve on PORT.auth and its own config directory, so no state leaks.
// Every value that must stay secret is collected and the server log is checked for it after each test.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import https from 'node:https';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { test as base, chromium, expect, type Page } from '@playwright/test';
import { watchPage, expectClean } from './support/test.ts';
import { base as originOf, crossSiteUrl, PORT, root, sock } from './support/ports.ts';
import { tcpOpen, waitFor } from './support/procs.ts';
import { AUTH_HEADERS, beginLogin, CLIENT, finishLogin, login, proofOf, rawGet, startIdp, writeAuthConfig, type Idp } from './support/oidc.ts';
import { hashPassword } from '../server/auth/breakglass.ts';

const O = originOf(PORT.auth);
const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site' };
const PASSWORD = 'correct horse battery';
const cacheDir = path.join(root, '.cache/auth');
mkdirSync(cacheDir, { recursive: true });

let idp: Idp;
base.beforeAll(async () => { idp = await startIdp(); });
base.afterAll(async () => { await idp.stop(); });

type Serve = { proc: ChildProcess; log: () => string; dir: string };
let serve: Serve | undefined;
let secrets: string[] = [];
const keep = (...v: (string | null | undefined)[]) => { for (const s of v) if (s) secrets.push(s); return v[0]; };

async function startServe(o: { dir?: string; env?: Record<string, string>; config?: Parameters<typeof writeAuthConfig>[1]; origins?: string[] } = {}): Promise<Serve> {
  const dir = o.dir ?? mkdtempSync(path.join(cacheDir, 'v2-'));
  if (!o.dir) writeAuthConfig(dir, o.config ?? {});
  if (o.origins) { const f = path.join(dir, 'loupe.json'); writeFileSync(f, JSON.stringify({ origins: o.origins })); chmodSync(f, 0o600); }
  let log = '';
  const proc = spawn(process.execPath, ['bin/loupe.mjs', 'serve'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, KB_URL: `unix:${sock('r')}`, LOUPE_PORT: String(PORT.auth), LOUPE_CONFIG_DIR: dir, LOUPE_OIDC_ISSUER: idp.url, ...o.env },
  });
  proc.stdout!.on('data', (d) => { log += d; });
  proc.stderr!.on('data', (d) => { log += d; });
  await waitFor(() => tcpOpen(PORT.auth), 8000, 'loupe serve for v2-auth');
  serve = { proc, log: () => log, dir };
  return serve;
}

const test = base.extend<object>({});
test.describe.configure({ mode: 'serial' });
test.beforeEach(() => { idp.sub = 'owner-sub-0001'; secrets = [keep(CLIENT.client_secret)!]; });
test.afterEach(async () => {
  if (!serve) return;
  const { proc, log } = serve;
  await new Promise<void>((r) => { if (proc.exitCode !== null) { r(); return; } proc.once('exit', () => r()); proc.kill('SIGTERM'); setTimeout(() => { proc.kill('SIGKILL'); r(); }, 1500).unref(); });
  await waitFor(async () => !(await tcpOpen(PORT.auth)), 3000, 'port free');
  // Criterion 3: no token, code, state, nonce, login secret, client secret or password in any log line.
  for (const n of idp.nonces) secrets.push(n);
  const text = log();
  for (const s of secrets) expect(text.includes(s), 'a secret value reached the server log').toBe(false);
  rmSync(serve.dir, { recursive: true, force: true });
  serve = undefined;
});

/** One request with full control of the headers. */
const req = (method: string, p: string, headers: Record<string, string> = {}, body?: string, port: number = PORT.auth) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `localhost:${port}`, ...headers } }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b })); });
  r.on('error', reject);
  if (body !== undefined) r.write(body);
  r.end();
});
const code = (r: { body: string }) => { try { return (JSON.parse(r.body) as { code?: string }).code; } catch { return undefined; } };
const kb = (token?: string | null, extra: Record<string, string> = {}) => req('GET', '/kb/v1/meta', { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra });
const goodLogin = async () => keep(await login(O))!;
const failedLogin = async () => {
  const s = await beginLogin(O);
  keep(s.start.login_secret, s.proof, new URL(s.callbackUrl).searchParams.get('code'), new URL(s.callbackUrl).searchParams.get('state'));
  return finishLogin(O, { login_id: s.start.login_id, login_secret: s.start.login_secret, proof: s.proof });
};

/** A terminal for the CLI: util-linux `script` gives the command a pty, and the test types into it. */
function tty(args: string[], env: Record<string, string>) {
  const cmd = ['node', JSON.stringify(path.join(root, 'bin/loupe.mjs')), ...args].join(' ');
  const c = spawn('script', ['-qec', cmd, '/dev/null'], { cwd: root, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  c.stdout!.on('data', (d) => { out += d; });
  c.stderr!.on('data', (d) => { out += d; });
  const exited = new Promise<number>((r) => c.once('exit', (n) => r(n ?? -1)));
  return {
    out: () => out,
    wait: (re: RegExp, ms = 10_000) => waitFor(() => re.test(out), ms, `terminal output ${re}`),
    type: (s: string) => { c.stdin!.write(s); },
    exit: async () => { const n = await exited; c.stdin!.end(); return n; },
  };
}

const noCookies = async (page: Page) => {
  expect(await page.context().cookies(O)).toEqual([]);
  expect(await page.evaluate(() => document.cookie)).toBe('');
};

test.describe('Google login against the test provider', () => {
  test('the allowed sub signs in from the button; no cookie, and no code, state or session in the URL the tab keeps', async ({ page }) => {
    await startServe();
    const w = await watchPage(page);
    const setCookies: string[] = [];
    const urls: string[] = [];
    page.on('response', (r) => { if (r.url().startsWith(O) && r.headers()['set-cookie']) setCookies.push(r.url()); });
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) urls.push(f.url()); });
    await page.goto(`${O}/#/status`);
    await expect(page.getByTestId('login-screen')).toBeVisible();
    await expect(page.getByTestId('breakglass-form')).toHaveCount(0);
    await expect(page.locator('[data-testid=app-root]')).toHaveCount(0);
    await page.getByTestId('google-login').click();
    await expect(page.getByTestId('lock-button')).toBeVisible();
    await expect(page.getByTestId('kb-status')).toHaveText('연결됨');
    // Back where the tab was, with nothing of the login in the address.
    expect(page.url()).toBe(`${O}/#/status`);
    const callback = urls.find((u) => u.includes('/auth/google/callback'));
    if (callback) keep(new URL(callback).searchParams.get('code'), new URL(callback).searchParams.get('state'));
    for (const u of urls.filter((x) => x.startsWith(O) && !x.includes('/auth/google/callback'))) expect(u).not.toMatch(/code=|state=|session|login_secret/);
    const stored = await page.evaluate(() => ({ s: sessionStorage.getItem('loupe.session'), l: sessionStorage.getItem('loupe.login') }));
    keep(stored.s);
    expect(stored.s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored.l, 'the login secret is gone once used').toBeNull();
    await noCookies(page);
    expect(setCookies).toEqual([]);
    expect(serve!.log()).toMatch(/google login$/m);
    await expectClean(page, w);
  });

  test('another Google account is refused', async ({ page }) => {
    await startServe();
    idp.sub = 'someone-else';
    const f = await failedLogin();
    expect([f.status, f.body?.code, f.body?.reason]).toEqual([401, 'login_failed', 'account_not_allowed']);
    expect(f.body).not.toHaveProperty('session');
    await page.goto(`${O}/`);
    await page.getByTestId('google-login').click();
    await expect(page.getByTestId('login-error')).toContainText('허용된 Google 계정이 아니다');
    expect(await page.evaluate(() => sessionStorage.getItem('loupe.session'))).toBeNull();
  });

  test('a wrong state, a replayed callback and a callback nobody started make no session', async () => {
    await startServe();
    const s = await beginLogin(O).catch(() => null);
    expect(s).not.toBeNull();
    // beginLogin delivered the real callback; a second delivery of the same URL is ignored.
    const u = new URL(s!.callbackUrl);
    keep(u.searchParams.get('code'), u.searchParams.get('state'), s!.start.login_secret, s!.proof);
    const again = await rawGet(s!.callbackUrl, NAV);
    expect([again.status, again.location]).toEqual([303, `${O}/#/auth/finish`]);
    // A login whose callback carries another state stays unfinished.
    const st = await (await fetch(`${O}/auth/google/start`, { method: 'POST', headers: AUTH_HEADERS(O), body: '{}' })).json() as { authorization_url: string; login_id: string; login_secret: string };
    keep(st.login_secret);
    const loc = (await fetch(st.authorization_url, { redirect: 'manual' })).headers.get('location')!;
    const forged = new URL(loc);
    keep(forged.searchParams.get('code'), forged.searchParams.get('state'));
    forged.searchParams.set('state', 'A'.repeat(43));
    expect((await rawGet(forged.href, NAV)).status).toBe(303);
    expect((await finishLogin(O, { login_id: st.login_id, login_secret: st.login_secret })).body?.code).toBe('login_pending');
    // A callback with no state at all, as a page elsewhere could send.
    expect((await rawGet(`${O}/auth/google/callback?code=x`, NAV)).status).toBe(303);
    expect((await finishLogin(O, { login_id: st.login_id, login_secret: st.login_secret })).body?.code).toBe('login_pending');
    // The first login still finishes once, and only once.
    const f = await finishLogin(O, { login_id: s!.start.login_id, login_secret: s!.start.login_secret, proof: s!.proof });
    expect(f.status).toBe(200);
    keep(f.body!.session as string);
    expect((await finishLogin(O, { login_id: s!.start.login_id, login_secret: s!.start.login_secret, proof: s!.proof })).body?.code).toBe('login_unknown');
  });

  test('an ID token with an earlier login\'s nonce is refused', async () => {
    await startServe();
    await goodLogin();
    const first = idp.nonces.at(-1)!;
    idp.once((p) => { p.nonce = first; });
    const f = await failedLogin();
    expect([f.status, f.body?.reason]).toEqual([401, 'id_token_invalid']);
  });

  for (const [name, edit] of [
    ['another audience', (p: Record<string, unknown>) => { p.aud = 'some-other-client.apps.example'; }],
    ['another issuer', (p: Record<string, unknown>) => { p.iss = 'https://evil.example'; }],
    ['an expired token', (p: Record<string, unknown>) => { const t = Math.floor(Date.now() / 1000); p.exp = t - 600; p.iat = t - 4200; p.nbf = t - 4200; }],
    ['no nonce', (p: Record<string, unknown>) => { delete p.nonce; }],
  ] as const) {
    test(`an ID token with ${name} is refused`, async () => {
      await startServe();
      idp.once(edit);
      const f = await failedLogin();
      expect([f.status, f.body?.code, f.body?.reason]).toEqual([401, 'login_failed', 'id_token_invalid']);
    });
  }

  test('the callback forwards only a one-time proof, in the fragment: a 303 to /#/auth/finish?cb=…, no cookie, no code', async () => {
    await startServe();
    const s = await beginLogin(O);
    keep(s.start.login_secret, s.proof, new URL(s.callbackUrl).searchParams.get('code'), new URL(s.callbackUrl).searchParams.get('state'));
    expect(s.callbackStatus).toBe(303);
    // Everything after # stays in the browser; the proof is not the code, the state or a session.
    expect(s.callbackLocation).toMatch(new RegExp(`^${O}/#/auth/finish\\?cb=[A-Za-z0-9_-]{43}$`));
    expect(s.proof).not.toBe(new URL(s.callbackUrl).searchParams.get('code'));
    const r = await rawGet(`${O}/auth/google/callback?state=nope&code=nope`, NAV);
    expect(r.location, 'no live state, no proof').toBe(`${O}/#/auth/finish`);
    // The callback must be a top-level navigation.
    expect((await req('GET', '/auth/google/callback?state=x&code=y', { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).status).toBe(403);
    expect((await req('GET', '/auth/google/callback?state=x&code=y')).status).toBe(403);
    const f = await finishLogin(O, { login_id: s.start.login_id, login_secret: s.start.login_secret, proof: s.proof });
    expect(f.headers.get('set-cookie')).toBeNull();
    expect(f.headers.get('cache-control')).toBe('no-store');
    keep(f.body!.session as string);
    expect((await finishLogin(O, { login_id: s.start.login_id, login_secret: s.start.login_secret, proof: s.proof })).body?.code, 'single use').toBe('login_unknown');
  });

  test('finish needs the login_secret of the tab that started it', async () => {
    await startServe();
    const s = await beginLogin(O);
    keep(s.start.login_secret, s.proof, new URL(s.callbackUrl).searchParams.get('code'), new URL(s.callbackUrl).searchParams.get('state'));
    const none = await finishLogin(O, { login_id: s.start.login_id, proof: s.proof });
    expect([none.status, none.body?.code]).toEqual([400, 'login_secret_required']);
    const wrong = await finishLogin(O, { login_id: s.start.login_id, login_secret: 'B'.repeat(43), proof: s.proof });
    expect([wrong.status, wrong.body?.code]).toEqual([403, 'login_secret_mismatch']);
    // A wrong secret ends that login, so guessing cannot continue.
    const right = await finishLogin(O, { login_id: s.start.login_id, login_secret: s.start.login_secret, proof: s.proof });
    expect([right.status, right.body?.code]).toEqual([400, 'login_unknown']);
  });

  test('a relayed login: one party starts it, the owner\'s browser completes Google, and neither can finish it', async ({ page }) => {
    await startServe();
    // A: another local user forges the localhost headers and starts a login; it holds login_id and login_secret.
    const a = JSON.parse((await req('POST', '/auth/google/start', AUTH_HEADERS(O), '{}')).body) as { authorization_url: string; login_id: string; login_secret: string };
    keep(a.login_secret);
    // B: the owner's browser is sent A's genuine Google URL and completes it.
    let proof: string | null = null;
    page.on('response', (r) => { if (r.url().includes('/auth/google/callback')) { const u = new URL(r.url()); keep(u.searchParams.get('code'), u.searchParams.get('state')); proof = proofOf(r.headers().location ?? null); } });
    await page.goto(a.authorization_url);
    await expect(page.getByTestId('login-screen')).toBeVisible();
    keep(proof);
    expect(proof, 'the proof went to the browser that completed Google').toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(page.url(), 'and left its address at once').toBe(`${O}/#/`);
    expect(await page.evaluate(() => sessionStorage.getItem('loupe.session'))).toBeNull();
    // A finishing: it has the login_secret but not the proof.
    const fa = await finishLogin(O, { login_id: a.login_id, login_secret: a.login_secret });
    expect([fa.status, fa.body?.code]).toEqual([403, 'proof_mismatch']);
    const fa2 = await finishLogin(O, { login_id: a.login_id, login_secret: a.login_secret, proof: 'C'.repeat(43) });
    expect([fa2.status, fa2.body?.code]).toEqual([403, 'proof_mismatch']);
    // B finishing: it has the proof but not A's login_secret.
    const fb = await page.evaluate(async ([id, cb]) => {
      const r = await fetch('/auth/google/finish', { method: 'POST', headers: { 'content-type': 'application/json', 'x-loupe-auth': '1' }, body: JSON.stringify({ login_id: id, login_secret: 'D'.repeat(43), proof: cb }) });
      return { status: r.status, code: ((await r.json()) as { code: string }).code };
    }, [a.login_id, proof] as const);
    expect(fb).toEqual({ status: 403, code: 'login_secret_mismatch' });
    // And the login is gone for both.
    expect((await finishLogin(O, { login_id: a.login_id, login_secret: a.login_secret, proof })).body?.code).toBe('login_unknown');
  });

  test('an account change after the callback leaves that login unfinishable', async () => {
    const { dir } = await startServe();
    const s = await beginLogin(O);
    keep(s.start.login_secret, s.proof, new URL(s.callbackUrl).searchParams.get('code'), new URL(s.callbackUrl).searchParams.get('state'));
    writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ sub: 'new-owner' })); chmodSync(path.join(dir, 'auth.json'), 0o600);
    const f = await finishLogin(O, { login_id: s.start.login_id, login_secret: s.start.login_secret, proof: s.proof });
    expect(f.status, 'no session for the old account').not.toBe(200);
    expect(f.body).not.toHaveProperty('session');
    expect(['login_unknown', 'login_failed']).toContain(f.body?.code);
  });

  test('changing the allowed account closes every session', async () => {
    const { dir } = await startServe();
    const t = await goodLogin();
    expect((await kb(t)).status).toBe(200);
    writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ sub: 'new-owner' })); chmodSync(path.join(dir, 'auth.json'), 0o600);
    const r = await kb(t);
    expect([r.status, code(r)]).toEqual([401, 'session_required']);
  });

  test('login start is limited to 10 a minute', async () => {
    await startServe();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await req('POST', '/auth/google/start', AUTH_HEADERS(O), '{}');
      if (r.status === 200) keep((JSON.parse(r.body) as { login_secret: string }).login_secret);
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  test('without the client or the allowed account, only the setup screen shows', async ({ page }) => {
    const dir = mkdtempSync(path.join(cacheDir, 'v2-'));
    writeAuthConfig(dir, { sub: null });
    await startServe({ dir });
    await page.goto(`${O}/`);
    await expect(page.getByTestId('setup-needed')).toBeVisible();
    await expect(page.getByTestId('google-login')).toHaveCount(0);
    const r = await req('POST', '/auth/google/start', AUTH_HEADERS(O), '{}');
    expect([r.status, code(r)]).toEqual([503, 'setup_needed']);
    // A group-readable client file is refused, not read.
    writeAuthConfig(dir, {});
    chmodSync(path.join(dir, 'google-oauth.json'), 0o640);
    const st = JSON.parse((await req('GET', '/auth/status')).body) as { ready: boolean; setup: { problems: string[] } };
    expect(st.ready).toBe(false);
    expect(st.setup.problems).toEqual(['google-oauth.json: mode']);
  });
});

test.describe('the checks of 6.3', () => {
  test('/kb/* without a live session is 401; /kb-write/* has the same checks', async () => {
    await startServe();
    for (const r of [await kb(), await kb('A'.repeat(43)), await kb('not-a-token')]) expect([r.status, code(r)]).toEqual([401, 'session_required']);
    const t = await goodLogin();
    expect((await kb(t)).status).toBe(200);
    expect((await req('GET', '/kb-write/v1/notes', { authorization: `Bearer ${t}` })).status).toBe(403); // GET has no Origin and no marker
    const post = (h: Record<string, string>) => req('POST', '/kb-write/v1/notes', { origin: O, 'content-type': 'application/json', 'x-loupe-write': '1', ...h }, '{}');
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: `Bearer ${t}` })).status).toBe(404); // the checks pass; the route arrives with M1
    expect((await post({ authorization: `Bearer ${t}`, origin: 'http://127.0.0.1:4899' })).status).toBe(403);
    expect((await post({ authorization: `Bearer ${t}`, 'x-loupe-write': '' })).status).toBe(403);
  });

  test('another Origin, 127.0.0.1 and a forged Host are 403', async () => {
    await startServe();
    const t = await goodLogin();
    const bearer = { authorization: `Bearer ${t}` };
    for (const origin of ['http://127.0.0.1:4899', `http://127.0.0.1:${PORT.auth}`, 'http://localhost:4810', 'null', 'https://evil.example']) {
      expect((await kb(t, { origin })).status, `kb ${origin}`).toBe(403);
      expect((await req('POST', '/auth/google/start', { ...AUTH_HEADERS(O), origin }, '{}')).status, `start ${origin}`).toBe(403);
    }
    for (const host of [`127.0.0.1:${PORT.auth}`, `evil.example:${PORT.auth}`, 'localhost:4810', 'localhost', `[::1]:${PORT.auth}`]) {
      expect((await kb(t, { host })).status, `kb Host ${host}`).toBe(403);
      expect((await req('POST', '/auth/google/start', { ...AUTH_HEADERS(O), host }, '{}')).status, `start Host ${host}`).toBe(403);
      expect((await req('GET', '/auth/google/callback?state=x', { ...NAV, host })).status, `callback Host ${host}`).toBe(403);
    }
    // The app's own files: 127.0.0.1 and [::1] are sent to localhost (ADR-0005 반영 2026-11-04), any other name is refused.
    for (const host of [`127.0.0.1:${PORT.auth}`, `[::1]:${PORT.auth}`]) {
      const local = await req('GET', '/index.html?x=1', { host });
      expect([local.status, local.headers.location]).toEqual([308, `${O}/index.html?x=1`]);
    }
    // 127.0.0.1 never gets data, with a valid session or not.
    expect((await req('GET', '/auth/status', { host: `127.0.0.1:${PORT.auth}` })).status).toBe(403);
    expect((await kb(t, { host: `127.0.0.1:${PORT.auth}`, origin: `http://127.0.0.1:${PORT.auth}` })).status).toBe(403);
    expect((await req('GET', '/', { host: `evil.example:${PORT.auth}` })).status).toBe(403);
    // Fetch Metadata: only same-origin on the data paths, with or without a session.
    expect((await kb(t, { 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await kb(t, { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })).status).toBe(403);
    expect((await kb(t, { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    // /auth POST: Origin required, JSON only, the marker header required.
    const start = (h: Record<string, string>) => req('POST', '/auth/google/start', h, '{}');
    expect((await start({ 'content-type': 'application/json', 'x-loupe-auth': '1' })).status).toBe(403);
    expect((await start({ origin: O, 'content-type': 'text/plain', 'x-loupe-auth': '1' })).status).toBe(415);
    expect((await start({ origin: O, 'content-type': 'application/x-www-form-urlencoded', 'x-loupe-auth': '1' })).status).toBe(415);
    expect((await start({ origin: O, 'content-type': 'application/json' })).status).toBe(403);
    void bearer;
  });

  test('the browser on 127.0.0.1 lands on localhost, path and hash kept, and that page never read /kb from 127.0.0.1', async ({ page }) => {
    await startServe();
    const ip: { url: string; status: number }[] = [];
    page.on('response', (r) => { if (r.url().startsWith(`http://127.0.0.1:${PORT.auth}/`)) ip.push({ url: new URL(r.url()).pathname, status: r.status() }); });
    await page.goto(`http://127.0.0.1:${PORT.auth}/index.html#/status`);
    expect(page.url()).toBe(`${O}/index.html#/status`);
    await expect(page.getByTestId('login-screen')).toBeVisible();
    expect(ip).toEqual([{ url: '/index.html', status: 308 }]);
    // WebAuthn (ADR-0005 user verification) needs a name as RP ID; this origin can have it.
    expect(await page.evaluate(() => location.hostname)).toBe('localhost');
  });

  test('a page on another origin can neither start nor finish a login, and no response carries CORS headers', async ({ page }) => {
    await startServe();
    const seen: { url: string; status: number; acao?: string | undefined }[] = [];
    page.on('response', (r) => { if (r.url().startsWith(O)) seen.push({ url: r.url(), status: r.status(), acao: r.headers()['access-control-allow-origin'] }); });
    await page.goto(crossSiteUrl());
    const results = await page.evaluate(async (o) => {
      const out: string[] = [];
      const tryFetch = async (label: string, init: RequestInit, path = '/auth/google/start') => {
        try { const r = await fetch(o + path, init); out.push(`${label}:${r.type}:${r.status}`); } catch { out.push(`${label}:blocked`); }
      };
      await tryFetch('no-cors-text', { method: 'POST', mode: 'no-cors', body: '{}', headers: { 'content-type': 'text/plain' } });
      await tryFetch('cors-json', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-loupe-auth': '1' } });
      await tryFetch('finish', { method: 'POST', mode: 'no-cors', body: JSON.stringify({ login_id: 'x', login_secret: 'y' }) }, '/auth/google/finish');
      const f = document.createElement('form'); f.method = 'POST'; f.action = `${o}/auth/google/start`; f.target = 'sink';
      const i = document.createElement('iframe'); i.name = 'sink'; document.body.append(i, f); f.submit();
      return out;
    }, O);
    expect(results).toContain('no-cors-text:opaque:0');
    expect(results).toContain('cors-json:blocked');
    // The no-cors POST and the form POST arrive and are refused; the JSON one dies at its preflight.
    await expect.poll(() => seen.filter((s) => s.url.endsWith('/auth/google/start')).length).toBeGreaterThanOrEqual(2);
    expect(seen.every((s) => s.status === 403 && s.acao === undefined)).toBe(true);
    // Nothing started: the server log has no start or login line.
    expect(serve!.log()).not.toMatch(/login/);
  });
});

test.describe('lock, expiry and the tab memory', () => {
  test('polls do not renew a session; requests after a person\'s input do', async () => {
    await startServe({ env: { LOUPE_SESSION_IDLE_MS: '1500' } });
    const poll = await goodLogin(), used = await goodLogin();
    let polled = 200;
    for (let i = 0; i < 7 && polled === 200; i++) {
      await new Promise((r) => setTimeout(r, 400));
      polled = (await kb(poll)).status;
      expect((await kb(used, { 'x-loupe-activity': '1' })).status, `active at ${i}`).toBe(200);
    }
    expect(polled, 'the polled session ended at the idle limit').toBe(401);
  });

  test('only the browser\'s own input events mark activity, not a script\'s dispatchEvent', async ({ page }) => {
    await startServe();
    const marks: { path: string; marked: boolean }[] = [];
    page.on('request', (r) => { if (r.url().includes('/kb/')) marks.push({ path: new URL(r.url()).pathname, marked: r.headers()['x-loupe-activity'] === '1' }); });
    await page.goto(`${O}/#/status`);
    await page.getByTestId('google-login').click();
    await expect(page.getByTestId('kb-status')).toHaveText('연결됨');
    keep(await page.evaluate(() => sessionStorage.getItem('loupe.session')));
    await page.waitForLoadState('networkidle');
    marks.length = 0;
    await page.evaluate(() => {
      for (const t of ['keydown', 'pointerdown']) window.dispatchEvent(t === 'keydown' ? new KeyboardEvent(t, { key: 'a' }) : new PointerEvent(t));
      location.hash = '#/';
    });
    await page.waitForLoadState('networkidle');
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.some((m) => m.marked), 'synthetic events are not input').toBe(false);
    marks.length = 0;
    await page.keyboard.press('Shift');
    await page.evaluate(() => { location.hash = '#/status'; });
    await page.waitForLoadState('networkidle');
    expect(marks.some((m) => m.marked), 'a real key press is').toBe(true);
  });

  test('an unattended tab that keeps polling ends at the idle limit', async ({ page }) => {
    await startServe({ env: { LOUPE_SESSION_IDLE_MS: '2000' } });
    const marked: boolean[] = [];
    page.on('request', (r) => { if (r.url().includes('/kb/')) marked.push(r.headers()['x-loupe-activity'] === '1'); });
    await page.goto(`${O}/#/status`);
    await page.getByTestId('google-login').click();
    await expect(page.getByTestId('kb-status')).toHaveText('연결됨');
    keep(await page.evaluate(() => sessionStorage.getItem('loupe.session')));
    expect(marked.filter(Boolean).length, 'the click right before counts once').toBeLessThanOrEqual(1);
    marked.length = 0;
    // Reads without input, as the 45 s meta poll makes them, every 0.5 s for 3 s.
    for (let i = 0; i < 6; i++) { await page.waitForTimeout(500); await page.evaluate((n) => { location.hash = n % 2 ? '#/' : '#/status'; }, i); }
    await expect(page.getByTestId('session-cover')).toHaveAttribute('data-why', 'expired');
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.some(Boolean), 'no read without input carried the activity mark').toBe(false);
  });

  test('lock and Ctrl+Alt+L end the session on the server and keep the tab', async ({ page }) => {
    await startServe();
    await page.goto(`${O}/#/status`);
    await page.getByTestId('google-login').click();
    await expect(page.getByTestId('kb-status')).toHaveText('연결됨');
    const t1 = keep(await page.evaluate(() => sessionStorage.getItem('loupe.session')))!;
    await page.evaluate(() => { (window as unknown as { __mem: string }).__mem = 'unsaved draft'; });
    await page.getByTestId('lock-button').click();
    await expect(page.getByTestId('session-cover')).toHaveAttribute('data-why', 'locked');
    expect((await kb(t1)).status).toBe(401);
    expect(await page.evaluate(() => sessionStorage.getItem('loupe.session'))).toBeNull();
    // The app underneath is still there, inert, with its memory.
    await expect(page.getByTestId('app-root')).toHaveAttribute('inert', '');
    expect(await page.evaluate(() => (window as unknown as { __mem: string }).__mem)).toBe('unsaved draft');
    // Back in with a new window; then the keyboard locks again.
    const [popup] = await Promise.all([page.context().waitForEvent('page'), page.getByTestId('relogin').click()]);
    await expect(page.getByTestId('session-cover')).toHaveCount(0, { timeout: 10_000 });
    await popup.close().catch(() => undefined);
    const t2 = keep(await page.evaluate(() => sessionStorage.getItem('loupe.session')))!;
    expect(t2).not.toBe(t1);
    await page.locator('main').click();
    await page.keyboard.press('Control+Alt+KeyL');
    await expect(page.getByTestId('session-cover')).toBeVisible();
    expect((await kb(t2)).status).toBe(401);
    expect(await page.evaluate(() => (window as unknown as { __mem: string }).__mem)).toBe('unsaved draft');
    await noCookies(page);
  });

  test('an idle session ends; the cover keeps the tab memory and a login in a new window resumes it', async ({ page }) => {
    await startServe({ env: { LOUPE_SESSION_IDLE_MS: '1500' } });
    await page.goto(`${O}/#/status`);
    await page.getByTestId('google-login').click();
    await expect(page.getByTestId('kb-status')).toHaveText('연결됨');
    keep(await page.evaluate(() => sessionStorage.getItem('loupe.session')));
    const navs = await page.evaluate(() => performance.getEntriesByType('navigation').length);
    await page.evaluate(() => { (window as unknown as { __mem: string }).__mem = 'unsaved draft'; });
    await page.waitForTimeout(1800);
    // Any read now: the hash route changes without a reload.
    await page.evaluate(() => { location.hash = '#/'; });
    await expect(page.getByTestId('session-cover')).toHaveAttribute('data-why', 'expired');
    const [popup] = await Promise.all([page.context().waitForEvent('page'), page.getByTestId('relogin').click()]);
    await expect(page.getByTestId('session-cover')).toHaveCount(0, { timeout: 10_000 });
    keep(await page.evaluate(() => sessionStorage.getItem('loupe.session')));
    expect(await page.evaluate(() => (window as unknown as { __mem: string }).__mem)).toBe('unsaved draft');
    expect(await page.evaluate(() => performance.getEntriesByType('navigation').length), 'no reload').toBe(navs);
    expect(popup.url()).not.toMatch(/code=|state=/);
    await popup.close().catch(() => undefined);
  });
});

test.describe('the port (KB ADR-0005 rev 9)', () => {
  const run = (cmd: string, args: string[], env: Record<string, string>) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const c = spawn(cmd, args, { cwd: root, env: { ...process.env, KB_URL: `unix:${sock('r')}`, LOUPE_PORT: String(PORT.authB), LOUPE_CONFIG_DIR: path.join(cacheDir, 'none'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout!.on('data', (d) => { out += d; }); c.stderr!.on('data', (d) => { out += d; });
    const t = setTimeout(() => c.kill('SIGTERM'), 8000);
    c.on('exit', (n) => { clearTimeout(t); resolve({ code: n, out }); });
  });

  test('a port held by another process stops loupe serve with a message, and no other port is tried', async () => {
    const holder = net.createServer();
    await new Promise<void>((r) => holder.listen(PORT.authB, '127.0.0.1', r));
    try {
      const r = await run(process.execPath, ['bin/loupe.mjs', 'serve'], {});
      expect(r.code).not.toBe(0);
      expect(r.code).not.toBeNull();
      expect(r.out).toContain(`127.0.0.1:${PORT.authB} is already held by another process. Refusing to start; no other port is tried.`);
      expect(r.out).not.toMatch(/loupe serve on /);
    } finally { await new Promise((r) => holder.close(r)); }
  });

  test('under socket activation the inherited socket is used, not refused', async () => {
    // systemd-socket-activate holds the port and hands it over as fd 3 with LISTEN_FDS and LISTEN_PID, as loupe.socket does.
    const c = spawn('systemd-socket-activate', ['-l', `127.0.0.1:${PORT.authB}`, '-E', `KB_URL=unix:${sock('r')}`, '-E', `LOUPE_PORT=${PORT.authB}`, '-E', `LOUPE_CONFIG_DIR=${path.join(cacheDir, 'none')}`, '-E', `PATH=${process.env.PATH}`, process.execPath, path.join(root, 'bin/loupe.mjs'), 'serve'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout!.on('data', (d) => { out += d; }); c.stderr!.on('data', (d) => { out += d; });
    try {
      await waitFor(() => tcpOpen(PORT.authB), 5000, 'activation socket');
      const r = await req('GET', '/healthz', { host: `localhost:${PORT.authB}` }, undefined, PORT.authB);
      expect(r.status).toBe(200);
      await waitFor(() => /loupe serve on fd:3/.test(out), 5000, 'serve on fd:3');
      expect(out).not.toContain('already held');
    } finally {
      c.kill('SIGTERM');
      await waitFor(async () => !(await tcpOpen(PORT.authB)), 5000, 'port free');
    }
  });
});

test.describe('break-glass and the terminal commands', () => {
  test('a stalled body times out and frees the path; an oversized body is refused at once', async () => {
    const dir = mkdtempSync(path.join(cacheDir, 'v2-'));
    writeAuthConfig(dir, { breakglass: await hashPassword(PASSWORD) });
    writeFileSync(path.join(dir, 'breakglass-open.json'), JSON.stringify({ until: Date.now() + 30 * 60_000 })); chmodSync(path.join(dir, 'breakglass-open.json'), 0o600);
    keep(PASSWORD);
    await startServe({ dir });
    const headers = { host: `localhost:${PORT.auth}`, ...AUTH_HEADERS(O) };
    // Headers and a promise of 64 bytes that never come.
    const t0 = Date.now();
    const stalled = new Promise<{ status: number; code?: string | undefined }>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: PORT.auth, method: 'POST', path: '/auth/breakglass', headers: { ...headers, 'content-length': '64' } }, (res) => {
        let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { resolve({ status: res.statusCode!, code: code({ body: b }) }); r.destroy(); });
      });
      r.on('error', reject);
      r.flushHeaders();
    });
    await new Promise((r) => setTimeout(r, 300));
    const blocked = await req('POST', '/auth/breakglass', AUTH_HEADERS(O), JSON.stringify({ password: PASSWORD }));
    expect(blocked.status, 'held while the body is pending').toBe(429);
    const s = await stalled;
    expect([s.status, s.code]).toEqual([408, 'body_timeout']);
    expect(Date.now() - t0).toBeLessThan(8000);
    const ok = await req('POST', '/auth/breakglass', AUTH_HEADERS(O), JSON.stringify({ password: PASSWORD }));
    expect(ok.status, 'the next attempt goes through').toBe(200);
    keep((JSON.parse(ok.body) as { session: string }).session);
    const big = await req('POST', '/auth/breakglass', AUTH_HEADERS(O), JSON.stringify({ password: 'x'.repeat(5000) }));
    expect([big.status, code(big)]).toEqual([413, 'body_too_large']);
  });

  test('every POST under /auth/* refuses a body over 4 KiB', async () => {
    await startServe();
    const t = await goodLogin();
    const big = JSON.stringify({ pad: 'x'.repeat(5000) });
    for (const [p, h] of [['/auth/google/start', {}], ['/auth/lock', { authorization: `Bearer ${t}` }], ['/auth/google/finish', {}], ['/auth/nope', {}]] as const) {
      const r = await req('POST', p, { ...AUTH_HEADERS(O), ...h }, big);
      expect([r.status, code(r)], p).toEqual([413, 'body_too_large']);
    }
    // Streamed without a length, too.
    const chunked = await new Promise<number>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: PORT.auth, method: 'POST', path: '/auth/lock', headers: { host: `localhost:${PORT.auth}`, ...AUTH_HEADERS(O), authorization: `Bearer ${t}` } }, (res) => { res.resume(); resolve(res.statusCode!); });
      r.on('error', reject);
      r.write('x'.repeat(3000)); r.end('x'.repeat(3000));
    });
    expect(chunked).toBe(413);
    expect((await kb(t)).status, 'the refused lock did not lock').toBe(200);
  });

  test('eight concurrent attempts with slow bodies reach the password check once', async () => {
    const dir = mkdtempSync(path.join(cacheDir, 'v2-'));
    writeAuthConfig(dir, { breakglass: await hashPassword(PASSWORD) });
    writeFileSync(path.join(dir, 'breakglass-open.json'), JSON.stringify({ until: Date.now() + 30 * 60_000 })); chmodSync(path.join(dir, 'breakglass-open.json'), 0o600);
    keep(PASSWORD);
    await startServe({ dir });
    // Each request sends its headers now and its body later, so all eight are in the server before any body arrives.
    const slow = () => new Promise<{ status: number; code?: string | undefined }>((resolve, reject) => {
      const body = JSON.stringify({ password: 'wrong password, slowly' });
      const r = http.request({ host: '127.0.0.1', port: PORT.auth, method: 'POST', path: '/auth/breakglass', headers: { host: `localhost:${PORT.auth}`, ...AUTH_HEADERS(O), 'content-length': String(Buffer.byteLength(body)) } }, (res) => {
        let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode!, code: code({ body: b }) }));
      });
      r.on('error', reject);
      r.flushHeaders();
      setTimeout(() => r.end(body), 400);
    });
    const results = await Promise.all(Array.from({ length: 8 }, slow));
    expect(results.filter((r) => r.code === 'password_wrong'), 'one verification').toHaveLength(1);
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
    expect(serve!.log().match(/break-glass attempt failed/g)).toHaveLength(1);
  });

  test('google-setup, google-enroll and breakglass refuse to run without a terminal', async () => {
    const dir = mkdtempSync(path.join(cacheDir, 'cli-'));
    try {
      for (const args of [['google-setup'], ['google-enroll'], ['breakglass', 'set'], ['breakglass', 'open']]) {
        const r = await new Promise<{ code: number | null; err: string }>((resolve) => {
          const c = spawn(process.execPath, ['bin/loupe.mjs', ...args], { cwd: root, env: { ...process.env, LOUPE_CONFIG_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
          let err = '';
          c.stderr!.on('data', (d) => { err += d; });
          c.stdin!.end('client-id\nclient-secret\npassword-long-enough\npassword-long-enough\ny\n');
          c.on('exit', (n) => resolve({ code: n, err }));
        });
        expect(r.code, args.join(' ')).toBe(2);
        expect(r.err).toContain('needs a terminal');
      }
      expect(readdirSync(dir), 'nothing written').toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('google-setup and google-enroll in a terminal: secrets not echoed, only the sub written, mode 600', async () => {
    const dir = mkdtempSync(path.join(cacheDir, 'cli-'));
    try {
      const setup = tty(['google-setup'], { LOUPE_CONFIG_DIR: dir });
      await setup.wait(/client ID \(no echo\): /); setup.type(`${CLIENT.client_id}\r`);
      await setup.wait(/client secret \(no echo\): /); setup.type(`${CLIENT.client_secret}\r`);
      expect(await setup.exit()).toBe(0);
      expect(setup.out()).not.toContain(CLIENT.client_secret);
      expect(statSync(path.join(dir, 'google-oauth.json')).mode & 0o777).toBe(0o600);

      const enroll = tty(['google-enroll'], { LOUPE_CONFIG_DIR: dir, LOUPE_PORT: String(PORT.authB), LOUPE_OIDC_ISSUER: idp.url });
      await enroll.wait(/^http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+/m);
      const authUrl = /^(http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+)/m.exec(enroll.out())![1]!;
      const cb = (await fetch(authUrl, { redirect: 'manual' })).headers.get('location')!;
      expect((await rawGet(cb, NAV)).status).toBe(200);
      await enroll.wait(/Allow this account/);
      expect(enroll.out()).toContain('sub:   owner-sub-0001');
      expect(enroll.out()).toContain('email: owner@example.test');
      enroll.type('y\r');
      expect(await enroll.exit()).toBe(0);
      expect(JSON.parse(readFileSync(path.join(dir, 'auth.json'), 'utf8'))).toEqual({ sub: 'owner-sub-0001' });
      expect(statSync(path.join(dir, 'auth.json')).mode & 0o777).toBe(0o600);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('break-glass is closed until `breakglass open`; then slowed after five misses; a Google login closes it', async ({ page }) => {
    const { dir } = await startServe();
    keep(PASSWORD);
    const set = tty(['breakglass', 'set'], { LOUPE_CONFIG_DIR: dir });
    await set.wait(/characters \(no echo\): /); set.type(`${PASSWORD}\r`);
    await set.wait(/again \(no echo\): /); set.type(`${PASSWORD}\r`);
    expect(await set.exit()).toBe(0);
    expect(set.out()).not.toContain(PASSWORD);

    const bg = (password: string) => req('POST', '/auth/breakglass', AUTH_HEADERS(O), JSON.stringify({ password }));
    // Closed: the path does not exist, the right password included, and the login screen has no field.
    expect((await bg(PASSWORD)).status).toBe(404);
    await page.goto(`${O}/`);
    await expect(page.getByTestId('login-screen')).toBeVisible();
    await expect(page.getByTestId('breakglass-form')).toHaveCount(0);

    const open = tty(['breakglass', 'open'], { LOUPE_CONFIG_DIR: dir });
    expect(await open.exit()).toBe(0);
    expect(existsSync(path.join(dir, 'breakglass-open.json'))).toBe(true);
    await page.reload();
    await expect(page.getByTestId('breakglass-form')).toBeVisible();
    // The checks still apply to it.
    expect((await req('POST', '/auth/breakglass', { ...AUTH_HEADERS(O), origin: 'http://127.0.0.1:4899' }, JSON.stringify({ password: PASSWORD }))).status).toBe(403);
    // From the browser: the right password signs in.
    await page.getByTestId('breakglass-input').fill(PASSWORD);
    await page.getByTestId('breakglass-submit').click();
    await expect(page.getByTestId('avatar')).toBeVisible();
    keep(await page.evaluate(() => sessionStorage.getItem('loupe.session')));
    expect(serve!.log()).toMatch(/break-glass login$/m);
    // Four misses are free; the fifth sets 30 s; within it even the right password waits.
    for (let i = 1; i <= 4; i++) { const r = await bg(`wrong password ${i}`); expect([r.status, r.headers['retry-after']]).toEqual([401, undefined]); }
    const fifth = await bg('wrong password 5');
    expect([fifth.status, fifth.headers['retry-after']]).toEqual([401, '30']);
    const waiting = await bg(PASSWORD);
    expect([waiting.status, code(waiting)]).toEqual([429, 'slow_down']);
    // A Google login closes the path.
    keep(await goodLogin());
    expect(existsSync(path.join(dir, 'breakglass-open.json'))).toBe(false);
    expect((await bg(PASSWORD)).status).toBe(404);
    expect(serve!.log()).toMatch(/break-glass closed by a Google login/);
  });
});

// Owner-corrected 2026-11-04: a Google "Web application" client and an origin allowlist, so a later https origin (the private
// overlay) works without redoing the login. loupe still binds 127.0.0.1 only; here a local TLS proxy stands in for the overlay.
test.describe('origin allowlist', () => {
  const B_HOST = `loupe.internal.test:${PORT.tls}`;
  const B = `https://${B_HOST}`;
  const ORIGINS = [O, B, 'http://loupe.internal.test:4899', 'https://*.internal.test', `http://127.0.0.1:${PORT.auth}`];
  /** A request that arrives as origin B would through the proxy. */
  const asB = (method: string, p: string, headers: Record<string, string> = {}, body?: string) => req(method, p, { host: B_HOST, ...headers }, body);
  const authB = { origin: B, 'content-type': 'application/json', 'x-loupe-auth': '1' };

  function tlsProxy() {
    const dir = mkdtempSync(path.join(cacheDir, 'tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=loupe.internal.test', '-addext', 'subjectAltName=DNS:loupe.internal.test', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
    const server = https.createServer({ key: readFileSync(path.join(dir, 'k.pem')), cert: readFileSync(path.join(dir, 'c.pem')) }, (inc, out) => {
      // Like an overlay's TLS front: the Host and every header pass through unchanged.
      const up = http.request({ host: '127.0.0.1', port: PORT.auth, method: inc.method, path: inc.url, headers: inc.headers }, (r) => { out.writeHead(r.statusCode!, r.headers); r.pipe(out); });
      up.on('error', () => out.destroy());
      inc.pipe(up);
    });
    return new Promise<{ close: () => void }>((r) => server.listen(PORT.tls, '127.0.0.1', () => r({ close: () => { server.close(); server.closeAllConnections(); rmSync(dir, { recursive: true, force: true }); } })));
  }

  test('a second allowlisted https origin signs in end to end with its own redirect URI', async () => {
    await startServe({ origins: ORIGINS });
    const proxy = await tlsProxy();
    const launch = test.info().project.use.launchOptions ?? {};
    const browser = await chromium.launch({ ...launch, args: [...(launch.args ?? []), '--host-resolver-rules=MAP loupe.internal.test 127.0.0.1'] });
    try {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      const authorize: string[] = [];
      page.on('request', (r) => { if (r.url().startsWith(idp.url)) authorize.push(r.url()); });
      await page.goto(`${B}/#/status`);
      await page.getByTestId('google-login').click();
      await expect(page.getByTestId('kb-status')).toHaveText('연결됨');
      expect(page.url()).toBe(`${B}/#/status`);
      const a = new URL(authorize.find((u) => u.includes('/authorize'))!);
      keep(a.searchParams.get('state'), a.searchParams.get('nonce'));
      expect(a.searchParams.get('redirect_uri')).toBe(`${B}/auth/google/callback`);
      const t = keep(await page.evaluate(() => sessionStorage.getItem('loupe.session')))!;
      expect(await page.context().cookies()).toEqual([]);
      // The session is a bearer value: it works on this origin's requests; Origin must still match the Host.
      expect((await asB('GET', '/kb/v1/meta', { authorization: `Bearer ${t}`, origin: B })).status).toBe(200);
      expect((await asB('GET', '/kb/v1/meta', { authorization: `Bearer ${t}`, origin: O })).status).toBe(403);
    } finally { await browser.close(); proxy.close(); }
  });

  test('origins off the list, and invalid entries in it, are 403', async () => {
    await startServe({ origins: ORIGINS });
    const t = await goodLogin();
    for (const host of [`other.internal.test:${PORT.tls}`, 'loupe.internal.test:4899', 'loupe.internal.test', `x.internal.test:${PORT.tls}`]) {
      expect((await req('GET', '/', { host })).status, `static ${host}`).toBe(403);
      expect((await req('GET', '/kb/v1/meta', { host, authorization: `Bearer ${t}` })).status, `kb ${host}`).toBe(403);
      expect((await req('POST', '/auth/google/start', { host, origin: `https://${host}`, 'content-type': 'application/json', 'x-loupe-auth': '1' }, '{}')).status, `start ${host}`).toBe(403);
    }
    expect((await asB('GET', '/kb/v1/meta', { authorization: `Bearer ${t}`, origin: 'https://other.internal.test' })).status).toBe(403);
    const st = JSON.parse((await req('GET', '/auth/status')).body) as { setup: { problems: string[] } };
    expect(st.setup.problems).toEqual(['loupe.json: 3 invalid origin(s) ignored']);
    // http on 127.0.0.1 is not an origin even when listed: its pages are sent to localhost and its data paths refused.
    expect((await req('GET', '/kb/v1/meta', { host: `127.0.0.1:${PORT.auth}`, authorization: `Bearer ${t}` })).status).toBe(403);
    expect((await req('GET', '/', { host: `127.0.0.1:${PORT.auth}` })).headers.location).toBe(`${O}/`);
    // Without loupe.json only the localhost origin is allowed.
    rmSync(path.join(serve!.dir, 'loupe.json'));
    expect((await asB('GET', '/')).status).toBe(403);
    expect((await req('GET', '/')).status).toBe(200);
  });

  test('a login started on one origin cannot be finished on another', async () => {
    await startServe({ origins: ORIGINS });
    const start = async (onB: boolean) => {
      const r = onB ? await asB('POST', '/auth/google/start', authB, '{}') : await req('POST', '/auth/google/start', AUTH_HEADERS(O), '{}');
      const s = JSON.parse(r.body) as { authorization_url: string; login_id: string; login_secret: string };
      keep(s.login_secret);
      const cb = new URL((await fetch(s.authorization_url, { redirect: 'manual' })).headers.get('location')!);
      keep(cb.searchParams.get('code'), cb.searchParams.get('state'));
      return { ...s, cb };
    };
    const finishOn = (onB: boolean, s: { login_id: string; login_secret: string }, proof: string | null) => {
      const body = JSON.stringify({ login_id: s.login_id, login_secret: s.login_secret, proof });
      return onB ? asB('POST', '/auth/google/finish', authB, body) : req('POST', '/auth/google/finish', AUTH_HEADERS(O), body);
    };
    // A's redirect_uri is A's callback, B's is B's.
    const a1 = await start(false);
    expect(new URL(a1.authorization_url).searchParams.get('redirect_uri')).toBe(`${O}/auth/google/callback`);
    expect(a1.cb.origin).toBe(O);
    // A's code and state delivered to B's callback: the login fails and gives no session on either origin.
    const onB = await asB('GET', `${a1.cb.pathname}${a1.cb.search}`, NAV);
    expect(onB.status).toBe(303);
    expect(onB.headers.location!.startsWith(`${B}/#/auth/finish`)).toBe(true);
    const p1 = keep(proofOf(onB.headers.location ?? null));
    const f1 = await finishOn(false, a1, p1 ?? null);
    expect([f1.status, (JSON.parse(f1.body) as { reason?: string }).reason]).toEqual([401, 'origin_mismatch']);
    // A finished callback on A cannot be redeemed on B, and the attempt ends that login.
    const a2 = await start(false);
    const c2 = await rawGet(a2.cb.href, NAV);
    expect(c2.status).toBe(303);
    const p2 = keep(proofOf(c2.location))!;
    const f2 = await finishOn(true, a2, p2);
    expect([f2.status, code(f2)]).toEqual([403, 'origin_mismatch']);
    expect(code(await finishOn(false, a2, p2))).toBe('login_unknown');
    // B's own login finishes on B.
    const b1 = await start(true);
    expect(new URL(b1.authorization_url).searchParams.get('redirect_uri')).toBe(`${B}/auth/google/callback`);
    const c3 = await asB('GET', `${b1.cb.pathname}${b1.cb.search}`, NAV);
    expect(c3.status).toBe(303);
    const f3 = await finishOn(true, b1, keep(proofOf(c3.headers.location ?? null))!);
    expect(f3.status).toBe(200);
    keep((JSON.parse(f3.body) as { session: string }).session);
  });

  test('the login screen is usable at 390 px', async ({ page }) => {
    const { dir } = await startServe();
    writeFileSync(path.join(dir, 'breakglass-open.json'), JSON.stringify({ until: Date.now() + 30 * 60_000 })); chmodSync(path.join(dir, 'breakglass-open.json'), 0o600);
    const auth = JSON.parse(readFileSync(path.join(dir, 'auth.json'), 'utf8')) as Record<string, string>;
    writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ ...auth, breakglass: '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${O}/`);
    await expect(page.getByTestId('login-screen')).toBeVisible();
    await expect(page.getByTestId('breakglass-form')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no horizontal scroll').toBe(true);
    for (const id of ['google-login', 'breakglass-input', 'breakglass-submit']) {
      const b = (await page.getByTestId(id).boundingBox())!;
      expect(b.x >= 0 && b.x + b.width <= 390, `${id} inside the width`).toBe(true);
      expect(b.height, `${id} tall enough to tap`).toBeGreaterThanOrEqual(28);
    }
    await page.getByTestId('google-login').click();
    await expect(page.getByTestId('avatar')).toBeVisible();
    keep(await page.evaluate(() => sessionStorage.getItem('loupe.session')));
  });
});
