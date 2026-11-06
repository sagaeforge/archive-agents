// loupe v2 M1, "첫 쓰기 전 시험" (design v2 11.2): the write path is not switched on in the UI until every row here passes.
// Real browser (headless Chromium), real loupe serve processes, kb-mock with the write imitation (KB_MOCK_WRITE=1) on a Unix socket.
// The UI has no write surface in this step: the browser tests call /kb-write/* from a page of the app's own origin, and the
// precheck rows run server/precheck.ts in the browser engine against the rule fixture's synthetic vectors.
//
// Servers (stopped in afterAll): A = kb-mock 'w' + loupe serve on PORT.authB; B = kb-mock 'wc' (private_open false) + loupe serve on PORT.auth
// with a 1.5 s idle limit. Both read their KB tokens from a config directory of their own, never the harness's.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import ts from 'typescript';
import type { ChildProcess } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect } from './support/test.ts';
import { login, writeAuthConfig } from './support/oidc.ts';
import { accessLog, base, PORT, root, sock } from './support/ports.ts';
import { startMock, startServe, stop } from './support/procs.ts';
import { mockRules, mockVectors } from '../dev/kb-mock/write.ts';
import { compareRules, rulesSha } from '../server/precheck.ts';

const run = promisify(execFile);
const EDITOR = 'kbt_e_e2e-editor-token', REVIEWER = 'kbt_r_e2e-reviewer-token';
const FIXTURE = 'contract-sample/fixtures/kb.json';
const A = { mock: 'w', port: PORT.authB, origin: base(PORT.authB) };
const B = { mock: 'wc', port: PORT.auth, origin: base(PORT.auth) };
const cfgDir = path.join(root, '.cache/auth/security');
// Built from pieces so no source line holds a string that looks like a live key.
const AWS = ['AK', 'IA', 'IOSFODNN7', 'EXAMPLE'].join('');

const procs: (ChildProcess | undefined)[] = [];
let sessionA = '';
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  rmSync(cfgDir, { recursive: true, force: true });
  writeAuthConfig(cfgDir);
  for (const [name, token] of [['kb-editor.token', EDITOR], ['kb-reviewer.token', REVIEWER]] as const) { const f = path.join(cfgDir, name); writeFileSync(f, `${token}\n`); chmodSync(f, 0o600); }
  mkdirSync(path.dirname(accessLog(A.mock)), { recursive: true });
  for (const n of [A.mock, B.mock]) rmSync(accessLog(n), { force: true });
  const env = { KB_MOCK_WRITE: '1', KB_MOCK_EDITOR_TOKEN: EDITOR, KB_MOCK_REVIEWER_TOKEN: REVIEWER };
  procs.push(await startMock(A.mock, FIXTURE, env), await startMock(B.mock, FIXTURE, { ...env, KB_MOCK_PRIVATE_OPEN: '0' }));
  procs.push(await startServe(A.mock, A.port, { LOUPE_CONFIG_DIR: cfgDir }), await startServe(B.mock, B.port, { LOUPE_CONFIG_DIR: cfgDir, LOUPE_SESSION_IDLE_MS: '1500' }));
  sessionA = await login(A.origin);
});
test.afterAll(async () => {
  await Promise.all(procs.map(stop));
  for (const n of [A.mock, B.mock]) rmSync(sock(n), { force: true });
  rmSync(cfgDir, { recursive: true, force: true });
});

/** What the KB saw, one line per request: `METHOD route status[ scope=…]`. */
const lines = (mock: string) => (existsSync(accessLog(mock)) ? readFileSync(accessLog(mock), 'utf8').split('\n').filter(Boolean) : []);
const writes = (mock: string) => lines(mock).filter((l) => /^(POST|PUT|PATCH|DELETE) /.test(l));

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string; json: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
/** One request with every header under control (fetch and a page would set Origin and Sec-Fetch-* themselves). */
const raw = (port: number, method: string, p: string, headers: Record<string, string> = {}, body?: string) => new Promise<Res>((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
    let b = ''; res.on('data', (d) => { b += d; });
    res.on('end', () => { let json = {}; try { json = b ? JSON.parse(b) : {}; } catch { /* not JSON */ } resolve({ status: res.statusCode!, headers: res.headers, body: b, json }); });
  });
  r.on('error', reject);
  if (body !== undefined) r.write(body);
  r.end();
});
const WRITE_HEADERS = (origin: string, session?: string): Record<string, string> => ({ origin, 'content-type': 'application/json', 'x-loupe-write': '1', 'sec-fetch-site': 'same-origin', ...(session ? { authorization: `Bearer ${session}` } : {}) });
const rec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'Note', title: '메모', body: '본문', body_format: 'markdown', props: {}, links: [], ...over });
const create = (key: string, record = rec(), extra: Record<string, unknown> = {}) => JSON.stringify({ idempotency_key: key, change: 'save', record, ...extra });

/** A blank page of the app's own origin (fulfilled by the test), so fetch() runs same-origin with the Origin header a browser sends. */
async function appPage(page: Page, origin: string) {
  await page.route(`${origin}/__e2e/blank`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>blank</title>' }));
  await page.goto(`${origin}/__e2e/blank`);
}
/** fetch from inside the page, with the session as Authorization (the app keeps it in sessionStorage and sends it so). */
const inPage = (page: Page, origin: string, session: string, method: string, p: string, body?: string, extra: Record<string, string> = {}) => page.evaluate(async ([m, u, s, b, x]) => {
  const r = await fetch(u!, { method: m!, headers: { authorization: `Bearer ${s}`, ...(b ? { 'content-type': 'application/json', 'x-loupe-write': '1' } : {}), ...JSON.parse(x!) }, ...(b ? { body: b } : {}) });
  const text = await r.text();
  let json: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  return { status: r.status, text, json, cache: r.headers.get('cache-control') };
}, [method, `${origin}${p}`, session, body ?? '', JSON.stringify(extra)] as const);

// ---------------------------------------------------------------------------------------------------------------------------------
test.describe('CSRF, other local ports, DNS rebinding, another user (rows 1 to 4)', () => {
  test('1. a cross-origin form POST, a no-cors fetch and a text/plain POST are 403 and the KB sees no write', async ({ page }) => {
    const before = writes(A.mock).length;
    const statuses: { url: string; method: string; status: number }[] = [];
    page.context().on('response', (r) => { if (r.url().includes('/kb-write/')) statuses.push({ url: r.url(), method: r.request().method(), status: r.status() }); });
    await page.context().route('http://127.0.0.1:4899/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>other site</title>' }));
    const target = `${A.origin}/kb-write/records`;
    const payload = JSON.stringify({ idempotency_key: 'loupe:c:csrf', change: 'save', record: rec() });

    // (a) a form: urlencoded, then text/plain (the JSON-in-a-form trick). A form submit navigates the tab to the answer.
    for (const enctype of ['application/x-www-form-urlencoded', 'text/plain']) {
      await page.goto('http://127.0.0.1:4899/');
      const answer = page.waitForResponse((r) => r.url() === target);
      await page.evaluate(([t, e, p]) => {
        const f = document.createElement('form'); f.method = 'post'; f.action = t!; f.enctype = e!;
        const i = document.createElement('input'); i.name = 'idempotency_key'; i.value = p!; f.append(i); document.body.append(f); f.submit();
      }, [target, enctype, payload] as const);
      const r = await answer;
      expect(r.status(), `form ${enctype}`).toBe(403);
      expect(r.request().headers()['content-type'] ?? '', enctype).toContain(enctype);
      await page.waitForURL(target);
      await page.waitForLoadState('load');
    }
    // (b) fetch with mode no-cors (the body becomes text/plain), (c) fetch with an explicit text/plain header.
    await page.goto('http://127.0.0.1:4899/');
    const sent = await page.evaluate(async ([t, p]) => {
      const out: string[] = [];
      for (const [label, init] of [
        ['no-cors', { method: 'POST', mode: 'no-cors', body: p }],
        ['text-plain', { method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body: p }],
        ['text-plain-cors', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: p }],
        ['json-with-marker', { method: 'POST', headers: { 'content-type': 'application/json', 'x-loupe-write': '1' }, body: p }],
        ['put', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: p }],
      ] as const) {
        try { const r = await fetch(t!, init as RequestInit); out.push(`${label}:${r.type}`); } catch { out.push(`${label}:blocked`); }
      }
      return out;
    }, [target, payload] as const);
    // The simple requests go out and the server refuses them (the browser may also hide that answer from the page, as ORB does a JSON one);
    // the ones that need a preflight never leave the browser.
    expect(sent.slice(0, 2).every((x) => /:(opaque|blocked)$/.test(x))).toBe(true);
    expect(sent.slice(2)).toEqual(['text-plain-cors:blocked', 'json-with-marker:blocked', 'put:blocked']);
    // The two forms are seen by the browser as navigations and answered 403. The page may not read the other two answers at all.
    for (const s of statuses) expect(s.status, `${s.method} ${s.url}`).toBe(403);
    expect(statuses.filter((s) => s.method === 'POST')).toHaveLength(2);
    // The same requests as the browser puts them on the wire, with a live session added to give them every chance: all 403, none readable.
    const wire = { origin: 'http://127.0.0.1:4899', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', authorization: `Bearer ${sessionA}` };
    for (const [label, headers] of [
      ['no-cors fetch (text/plain)', { ...wire, 'content-type': 'text/plain;charset=UTF-8' }],
      ['text/plain', { ...wire, 'content-type': 'text/plain' }],
      ['urlencoded form', { ...wire, 'content-type': 'application/x-www-form-urlencoded' }],
      ['json without a marker', { ...wire, 'content-type': 'application/json' }],
      ['json with a marker', { ...wire, 'content-type': 'application/json', 'x-loupe-write': '1' }],
    ] as const) {
      const r = await raw(A.port, 'POST', '/kb-write/records', headers, payload);
      expect(r.status, label).toBe(403);
      expect(r.headers['access-control-allow-origin'], label).toBeUndefined();
    }
    const preflight = await raw(A.port, 'OPTIONS', '/kb-write/records', { origin: 'http://127.0.0.1:4899', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-loupe-write' });
    expect([preflight.status, preflight.headers['access-control-allow-origin']]).toEqual([403, undefined]);
    expect(writes(A.mock).length, 'kb-mock saw no write').toBe(before);
  });

  test('2. Origin http://127.0.0.1:4812 and http://localhost:4810 are 403 [ADR-0005 반영 2026-11-04], from a page and from a raw request with a live session', async ({ page }) => {
    const before = writes(A.mock).length;
    const seen: { method: string; status: number }[] = [];
    page.on('response', (r) => { if (r.url().includes('/kb-write/')) seen.push({ method: r.request().method(), status: r.status() }); });
    for (const other of ['http://127.0.0.1:4812', 'http://localhost:4810']) {
      await page.route(`${other}/**`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>other port</title>' }));
      await page.goto(`${other}/`);
      const outcome = await page.evaluate(async ([t, s]) => {
        try { await fetch(t!, { method: 'POST', headers: { 'content-type': 'application/json', 'x-loupe-write': '1', authorization: `Bearer ${s}` }, body: '{}' }); return 'sent'; } catch { return 'blocked'; }
      }, [`${A.origin}/kb-write/records`, sessionA] as const);
      expect(outcome, `${other} cannot call the write path`).toBe('blocked');
      // If the other page's script could set the header itself (it cannot), the server still refuses the Origin.
      const r = await raw(A.port, 'POST', '/kb-write/records', WRITE_HEADERS(other, sessionA), create('loupe:c:port'));
      expect([r.status, r.json.code], other).toEqual([403, 'origin_rejected']);
      const read = await raw(A.port, 'GET', '/kb/v1/meta', { origin: other, authorization: `Bearer ${sessionA}` });
      expect(read.status, `${other} read`).toBe(403);
    }
    expect(seen.every((s) => s.status === 403)).toBe(true);
    expect(writes(A.mock).length).toBe(before);
  });

  test('3. Host evil.example:4812 is 403 for reads and for writes, with a live session and the right Origin', async () => {
    const before = lines(A.mock).length;
    for (const host of ['evil.example:4812', `evil.example:${A.port}`, `127.0.0.1:${A.port}`]) {
      const read = await raw(A.port, 'GET', '/kb/v1/meta', { host, origin: A.origin, authorization: `Bearer ${sessionA}` });
      const write = await raw(A.port, 'POST', '/kb-write/records', { ...WRITE_HEADERS(A.origin, sessionA), host }, create('loupe:c:rebind'));
      expect([read.status, write.status], host).toEqual([403, 403]);
      expect(write.json.code, host).toBe('host_rejected');
    }
    expect(lines(A.mock).length, 'the KB saw nothing').toBe(before);
  });

  test('4. curl without a session, with or without a forged Origin: reads 401, writes 401 (403 when the Origin is missing); the KB sees nothing', async () => {
    const before = lines(A.mock).length;
    const curl = async (...args: string[]) => (await run('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', ...args])).stdout;
    const url = `http://127.0.0.1:${A.port}`;
    const host = ['-H', `Host: localhost:${A.port}`];
    const forged = ['-H', `Origin: ${A.origin}`, '-H', 'Sec-Fetch-Site: same-origin'];
    const post = ['-X', 'POST', '-H', 'Content-Type: application/json', '-H', 'X-Loupe-Write: 1', '--data', create('loupe:c:uid')];
    expect(await curl(...host, ...forged, `${url}/kb/v1/meta`), 'forged Origin, read').toBe('401');
    expect(await curl(...host, ...forged, ...post, `${url}/kb-write/records`), 'forged Origin, write').toBe('401');
    expect(await curl(...host, ...forged, '-H', `Authorization: Bearer ${'A'.repeat(43)}`, ...post, `${url}/kb-write/records`), 'made-up session').toBe('401');
    expect(await curl(...host, `${url}/kb/v1/meta`), 'no Origin, read').toBe('401');
    expect(await curl(...host, ...post, `${url}/kb-write/records`), 'no Origin, write').toBe('403');
    expect(lines(A.mock).length).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
test.describe('route table, tokens, session (rows 5 and 6)', () => {
  test('5. a path outside the table is 404; PUT and DELETE from a browser are 405; no editor token reaches a reviewer path', async ({ page }) => {
    await appPage(page, A.origin);
    const before = lines(A.mock).length;
    for (const p of ['/kb-write', '/kb-write/', '/kb-write/v1/records', '/kb-write/auth', '/kb-write/token', '/kb-write/settings', '/kb-write/records/f-a/delete', '/kb-write/actions/a-1', '/kb-write/hitl', '/kb-write/records/%2e%2e/promote', '/kb-write/records/a%2Fb']) {
      const r = await inPage(page, A.origin, sessionA, 'POST', p, '{}');
      expect(r.status, p).toBe(404);
    }
    for (const p of ['/kb-write/records', '/kb-write/records/f-a', '/kb-write/writes/w-1/discard', '/kb-write/actions']) {
      for (const m of ['PUT', 'DELETE']) expect((await inPage(page, A.origin, sessionA, m, p)).status, `${m} ${p}`).toBe(405);
    }
    expect(lines(A.mock).length, 'neither reached the KB').toBe(before);

    // Every reviewer path, once, from the browser. The KB names the scope of the token each one carried.
    const reviewer = ['/kb-write/actions', '/kb-write/actions/challenge', '/kb-write/actions/a-1/external-refine', '/kb-write/actions/a-1/execute', '/kb-write/hitl/challenge', '/kb-write/hitl/h-1/resolve', '/kb-write/reviewer/enroll'];
    const editor = ['/kb-write/records', '/kb-write/records/f-a', '/kb-write/records/f-a/tombstone', '/kb-write/records/f-a/promote', '/kb-write/topics/f-s/research', '/kb-write/topics/f-s/research/t-r/stop', '/kb-write/writes/w-1/discard'];
    for (const p of [...reviewer, ...editor]) await inPage(page, A.origin, sessionA, 'POST', p, JSON.stringify({ idempotency_key: `loupe:c:${p}`, change: 'save', expected_version: 1, record: rec({ expected_version: 1 }) }));
    const got = lines(A.mock).slice(before);
    expect(got).toHaveLength(14);
    const onReviewerPath = got.filter((l) => /^(POST|GET|PUT|DELETE) \/v1\/(actions|hitl|reviewer)/.test(l));
    expect(onReviewerPath).toHaveLength(7);
    expect(onReviewerPath.filter((l) => l.endsWith('scope=editor')), 'the editor token on a reviewer path').toHaveLength(0);
    expect(onReviewerPath.every((l) => l.endsWith('scope=reviewer'))).toBe(true);
    expect(got.filter((l) => !onReviewerPath.includes(l)).every((l) => l.endsWith('scope=editor'))).toBe(true);
  });

  test('6. past the idle limit the session is 401 for reads and writes; after lock the earlier session is 401', async () => {
    const o = B.origin;
    const post = (s: string, key: string) => raw(B.port, 'POST', '/kb-write/records', WRITE_HEADERS(o, s), create(key, rec({ sensitivity: 'internal' })));
    const get = (s: string) => raw(B.port, 'GET', '/kb/v1/meta', { origin: o, authorization: `Bearer ${s}` });
    const s1 = await login(o);
    expect((await post(s1, 'loupe:c:idle-1')).status).toBe(201);
    expect((await get(s1)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1900));
    const before = writes(B.mock).length;
    expect((await post(s1, 'loupe:c:idle-2')).status, 'write after the idle limit').toBe(401);
    expect((await get(s1)).status, 'read after the idle limit').toBe(401);
    expect(writes(B.mock).length).toBe(before);

    const s2 = await login(o);
    expect((await post(s2, 'loupe:c:lock-1')).status).toBe(201);
    expect((await raw(B.port, 'POST', '/auth/lock', { ...WRITE_HEADERS(o, s2), 'x-loupe-auth': '1' }, '{}')).status).toBe(204);
    expect((await post(s2, 'loupe:c:lock-2')).status, 'write with the locked session').toBe(401);
    expect((await get(s2)).status, 'read with the locked session').toBe(401);
    expect(writes(B.mock).length).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
test.describe('save check and secret rejection (rows 7 and 8)', () => {
  test('7. the rule fixture\'s synthetic vectors are caught in the browser engine, and while blocked no kb-write/ and no /kb/v1/search request is made', async ({ page }) => {
    await appPage(page, A.origin);
    // server/precheck.ts has no Node imports; it runs in the page as it will in the memo window.
    const js = ts.transpileModule(readFileSync(path.join(root, 'server/precheck.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^export /gm, '');
    await page.evaluate(`(() => { ${js}\n window.__pre = { compileRules, recordFields, decide, sendIfClean, rulesSha, compareRules }; })()`);
    const urls: string[] = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/kb-write/') || u.pathname === '/kb/v1/search') urls.push(`${r.method()} ${u.pathname}`); });
    const logBefore = lines(A.mock).length;

    const out = await page.evaluate(async ([rules, vectors, session]) => {
      const w = window as unknown as { __pre: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
      const P = w.__pre;
      const pre = P.compileRules(rules);
      const sha = await P.rulesSha(rules);
      const res: { id: string; action: string; sent: boolean; searchSent: boolean }[] = [];
      for (const v of vectors as { id: string; field: string; text: string; on_secret: string; action: string }[]) {
        const body = { idempotency_key: v.field === 'idempotency_key' ? v.text : `loupe:c:vec-${v.id}`, change: 'save', on_secret: v.on_secret, record: { type: 'Note', title: 't', body: v.field === 'record.body' ? v.text : 'b', body_format: 'markdown', props: v.field === 'record.props[0].name' ? { [v.text]: 'x' } : {}, links: [] } };
        const fields = P.recordFields(body);
        const hits = pre.scan(fields);
        const wrote = await P.sendIfClean(pre, fields, () => fetch('/kb-write/records', { method: 'POST', headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json', 'x-loupe-write': '1' }, body: JSON.stringify(body) }));
        // The search box: the same text typed into the palette.
        const searched = await P.sendIfClean(pre, [{ field: 'search.q', text: v.text }], () => fetch(`/kb/v1/search?q=${encodeURIComponent(v.text)}`, { headers: { authorization: `Bearer ${session}` } }));
        res.push({ id: v.id, action: P.decide(hits, v.on_secret).action, sent: wrote.sent, searchSent: searched.sent });
      }
      return { res, sha, skipped: pre.skipped };
    }, [mockRules, mockVectors, sessionA] as const);

    expect(out.skipped).toEqual([]);
    expect(out.sha, 'the hash is the same in the browser engine').toBe(await rulesSha(mockRules));
    for (const v of mockVectors) {
      const got = out.res.find((x) => x.id === v.id)!;
      expect(got.action, `${v.id} in the browser`).toBe(v.action);
      // A blocked vector sends nothing, in the write path and in the search path. The one allowed vector (a digest) is sent, which proves the page does send.
      expect(got.sent, `${v.id} write sent`).toBe(v.action === 'allow');
      expect(got.searchSent, `${v.id} search sent`).toBe(v.action === 'allow');
    }
    const blocked = mockVectors.filter((v) => v.action !== 'allow').length;
    expect(blocked).toBeGreaterThanOrEqual(6);
    expect(urls, 'only the allowed vector\'s two requests left the page').toEqual(['POST /kb-write/records', 'GET /kb/v1/search']);
    expect(lines(A.mock).slice(logBefore).filter((l) => /\/v1\/search|POST \/v1\/records/.test(l))).toHaveLength(2);
  });

  test('7b. a changed rule version or hash turns the precheck off, and then the KB is the only guard', async () => {
    const meta = await raw(A.port, 'GET', '/kb/v1/meta', { origin: A.origin, authorization: `Bearer ${sessionA}` });
    const remote = meta.json.data.write.secret_rules;
    const local = { version: mockRules.version, sha: await rulesSha(mockRules) };
    expect(compareRules(local, remote)).toEqual({ on: true });
    expect(compareRules({ ...local, sha: 'f'.repeat(64) }, remote)).toEqual({ on: false, reason: 'sha_differs' });
    expect(compareRules({ ...local, version: 'fp-secret-rules-v2' }, remote)).toEqual({ on: false, reason: 'version_differs' });
  });

  test('8. a KB 422 with hits saves nothing, shows ranges and rule ids only, and the value is in no response; quarantine hides the record', async ({ page }) => {
    await appPage(page, A.origin);
    const before = lines(A.mock).length;
    const key = 'loupe:c:reject-1';
    const r = await inPage(page, A.origin, sessionA, 'POST', '/kb-write/records', create(key, rec({ body: `메모\n${AWS} 끝` })));
    expect(r.status).toBe(422);
    expect(r.cache).toBe('no-store');
    expect(r.json).toMatchObject({ code: 'secret_detected', stored: false, hits: [{ field: 'record.body', rule: 'aws-access-token', start: 3, end: 23, start_u16: 3, end_u16: 23 }] });
    expect(Object.keys(r.json.hits[0]).sort()).toEqual(['end', 'end_u16', 'field', 'rule', 'start', 'start_u16']);
    expect(r.text).not.toContain(AWS);
    expect(lines(A.mock).slice(before)).toEqual(['POST /v1/records 422 scope=editor']);
    // Zero saves: the same key with clean content is a first write, not a replay.
    const again = await inPage(page, A.origin, sessionA, 'POST', '/kb-write/records', create(key, rec({ body: '고친 메모' })));
    expect([again.status, again.json.replayed, again.json.version]).toEqual([201, false, 1]);

    // "Not a secret" (5.5): the same create key, on_secret=quarantine. The record is stored as secret, answered without the value, then hidden.
    const q = await inPage(page, A.origin, sessionA, 'POST', '/kb-write/records', create('loupe:c:reject-2', rec({ body: `메모\n${AWS}` })));
    expect(q.status).toBe(422);
    const sent = create('loupe:c:reject-2', rec({ body: `메모\n${AWS}` }), { on_secret: 'quarantine' });
    const kept = await inPage(page, A.origin, sessionA, 'POST', '/kb-write/records', sent);
    expect(kept.status).toBe(201);
    expect(kept.json).toMatchObject({ quarantined: true, sensitivity: 'secret', warnings: ['secret_detected:aws-access-token'] });
    expect(kept.text).not.toContain(AWS);
    expect((await inPage(page, A.origin, sessionA, 'POST', '/kb-write/records', sent)).status, 'a resend of the quarantined create is a plain 404').toBe(404);
    expect((await inPage(page, A.origin, sessionA, 'POST', `/kb-write/records/${kept.json.id}`, JSON.stringify({ idempotency_key: 'loupe:e:q', change: 'save', record: rec({ expected_version: 1 }) }))).status).toBe(404);
    // An identifier is never quarantined.
    const ident = await inPage(page, A.origin, sessionA, 'POST', '/kb-write/records', create(`loupe:c:${AWS}`, rec(), { on_secret: 'quarantine' }));
    expect(ident.status).toBe(422);
    expect(ident.text).not.toContain(AWS);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
test.describe('accepted writes (row 9)', () => {
  test('9a. 202 write_ref then committed, a failed one with its copy until discarded, and a same-key resend makes no second write', async ({ page }) => {
    await appPage(page, A.origin);
    const post = (key: string, record: Record<string, unknown>) => inPage(page, A.origin, sessionA, 'POST', '/kb-write/records', create(key, record));
    const poll = (ref: string, q = '') => inPage(page, A.origin, sessionA, 'GET', `/kb/v1/writes/${ref}${q}`);

    const slow = await post('loupe:c:accepted-1', rec({ title: '[mock:spool] 느린 저장' }));
    expect(slow.status).toBe(202);
    expect(slow.json).toMatchObject({ spooled: true, version: null, reason: 'gate_timeout' });
    const ref = slow.json.write_ref as string;
    expect((await poll(ref)).json.data.state).toBe('pending');
    expect((await poll(ref)).json.data).toMatchObject({ state: 'committed', version: 1, id: slow.json.id });
    const resend = await post('loupe:c:accepted-1', rec({ title: '[mock:spool] 느린 저장' }));
    expect([resend.status, resend.json.write_ref, resend.json.replayed]).toEqual([202, ref, true]);

    const bad = await post('loupe:c:accepted-2', rec({ title: '[mock:fail] 실패할 저장', body: '내 사본' }));
    const ref2 = bad.json.write_ref as string;
    await poll(ref2);
    expect((await poll(ref2)).json.data).toMatchObject({ state: 'failed', code: 'version_conflict' });
    expect((await poll(ref2, '?include=body')).json.data).toMatchObject({ state: 'failed', record: { body: '내 사본' }, payload_sha: bad.json.payload_sha });
    expect((await inPage(page, A.origin, sessionA, 'POST', `/kb-write/writes/${ref2}/discard`, '{}')).json).toMatchObject({ state: 'purged' });
    expect((await poll(ref2, '?include=body')).json).toMatchObject({ status: 410, code: 'content_removed' });
    expect((await poll(ref2)).json.data.state).toBe('purged');

    // A same-key resend of a direct write: the first answer comes back, and the next edit at v1 is still v1 to the KB (no hidden v2).
    const direct = await post('loupe:c:accepted-3', rec({ body: 'A' }));
    expect(direct.status).toBe(201);
    const second = await post('loupe:c:accepted-3', rec({ body: 'A' }));
    expect(second.json).toMatchObject({ id: direct.json.id, version: 1, replayed: true });
    const edit = await inPage(page, A.origin, sessionA, 'POST', `/kb-write/records/${direct.json.id}`, JSON.stringify({ idempotency_key: 'loupe:e:accepted-3:v1:save:r1', change: 'save', record: rec({ body: 'B', expected_version: 1 }) }));
    expect(edit.json).toMatchObject({ version: 2 });
    // A stale edit is a 409 with the other side's version, which the conflict band will read.
    const stale = await inPage(page, A.origin, sessionA, 'POST', `/kb-write/records/${direct.json.id}`, JSON.stringify({ idempotency_key: 'loupe:e:accepted-3:v1:save:r2', change: 'save', record: rec({ body: 'C', expected_version: 1 }) }));
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: 'version_conflict', current: { version: 2, body: 'B', payload_sha: edit.json.payload_sha } });
  });

  test('9b. with private_open false the KB says so in /v1/meta and refuses a private note; internal is still accepted', async () => {
    const o = B.origin;
    const s = await login(o);
    const meta = await raw(B.port, 'GET', '/kb/v1/meta', { origin: o, authorization: `Bearer ${s}` });
    expect(meta.json.data.write).toMatchObject({ private_open: false, fp_gate: true });
    const p = await raw(B.port, 'POST', '/kb-write/records', WRITE_HEADERS(o, s), create('loupe:c:closed-1'));
    expect([p.status, p.json.code]).toEqual([403, 'sensitivity_not_allowed']);
    expect((await raw(B.port, 'POST', '/kb-write/records', WRITE_HEADERS(o, s), create('loupe:c:closed-2', rec({ sensitivity: 'internal' })))).status).toBe(201);
  });

  test('9c. a note without sensitivity is stored as private under a loupe:c: key, and the write meta is the rev 9 shape', async () => {
    const meta = await raw(A.port, 'GET', '/kb/v1/meta', { origin: A.origin, authorization: `Bearer ${sessionA}` });
    const w = meta.json.data.write;
    expect(w).toMatchObject({ fp_gate: true, private_open: true, hitl: { available: true } });
    expect(w.editor_routes).toEqual(expect.arrayContaining(['POST /v1/records', 'PUT /v1/records/{id}']));
    expect(w.secret_rules.sha).toMatch(/^[0-9a-f]{64}$/);
    const ok = await raw(A.port, 'POST', '/kb-write/records', WRITE_HEADERS(A.origin, sessionA), create('loupe:c:3f1c0f6a-2b9c-4d77-9a3e-0e5a5e5b7c11'));
    expect(ok.status).toBe(201);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.json).toMatchObject({ actor: 'app:loupe', claimed_author: 'user:sagae', generated_by: 'app:loupe:save' });
  });
});
