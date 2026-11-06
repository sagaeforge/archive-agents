// M1 write path, loupe serve side (design v2 5.1, 5.5, 5.7, 11.2 "첫 쓰기 전 시험"): the browser-side secret precheck, the /kb-write/* route table
// and the editor token scoping, against a real kb-mock on a Unix socket and a real login. Sections are added as the pieces land.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdaptorServer } from '@hono/node-server';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createKbMock } from '../dev/kb-mock/app.ts';
import { mockRules, mockVectors } from '../dev/kb-mock/write.ts';
import { createLoupeApp, KB_WRITE_ROUTES, type ServeConfig } from '../server/serve.ts';
import { login, startIdp, writeAuthConfig, type Idp } from '../e2e/support/oidc.ts';
import { canonicalJson, compareRules, compileRules, decide, recordFields, rulesSha, sendIfClean, type RuleFile } from '../server/precheck.ts';

// Built from pieces so no source line holds a string that looks like a live key.
const AWS = ['AK', 'IA', 'IOSFODNN7', 'EXAMPLE'].join('');
const PEM = ['-----BEGIN ', 'RSA ', 'PRIVATE KEY-----'].join('');
const small: RuleFile = {
  version: 'fp-secret-rules-test',
  rules: [{ id: 'aws-access-token', pattern: String.raw`\b((?:AKIA|ASIA)[A-Z2-7]{16})\b`, flags: 32, keywords: ['akia', 'asia'], entropy: 3, secret_group: null, path: null }],
  extra_rules: [{ id: 'kb-private-key-header', pattern: String.raw`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----`, flags: 32 }],
};

describe('secret precheck (design v2 5.7): the same rule file the KB publishes, as advice', () => {
  const pre = compileRules(small);

  it('finds a content secret and gives the rule id with code point and UTF-16 ranges, never the value', () => {
    const hits = pre.scan([{ field: 'record.body', text: `내일 배포 ${AWS} 끝` }]);
    expect(hits).toEqual([{ field: 'record.body', rule: 'aws-access-token', start: 6, end: 26, start_u16: 6, end_u16: 26 }]);
    expect(JSON.stringify(hits)).not.toContain(AWS);
  });

  it('counts an astral character as one code point and two UTF-16 units', () => {
    const hits = pre.scan([{ field: 'record.body', text: `한😀${PEM}` }]);
    expect(hits[0]).toMatchObject({ rule: 'kb-private-key-header', start: 2, start_u16: 3 });
    expect(hits[0]!.end - hits[0]!.start).toBe(PEM.length);
    expect(hits[0]!.end_u16 - hits[0]!.start_u16).toBe(PEM.length);
  });

  it('skips a rule whose keywords are absent and one whose entropy is too low', () => {
    expect(pre.scan([{ field: 'record.body', text: 'AAAAAAAAAAAAAAAAAAAA no key here' }])).toEqual([]);
    expect(pre.scan([{ field: 'record.body', text: 'AKIAAAAAAAAAAAAAAAAA' }])).toEqual([]); // entropy 3 not reached
  });

  it('a rule that does not compile is listed, not silently dropped', () => {
    const p = compileRules({ version: 'x', rules: [{ id: 'broken', pattern: '(', flags: 0 }, ...small.rules] });
    expect(p.skipped).toEqual(['broken']);
    expect(p.scan([{ field: 'record.title', text: AWS }])).toHaveLength(1);
  });

  it('reads the fields of a record request by ordinal, so a property name is scanned as an identifier and never printed', () => {
    const f = recordFields({ idempotency_key: 'loupe:c:1', record: { type: 'Note', title: 't', body: 'b', props: { [AWS]: 'x', k: [AWS] } } });
    expect(f.map((x) => x.field)).toEqual(['idempotency_key', 'record.type', 'record.title', 'record.body', 'record.props[0].name', 'record.props[0].value', 'record.props[1].name', 'record.props[1].value[0]']);
    const hits = pre.scan(f);
    expect(hits.map((h) => h.field)).toEqual(['record.props[0].name', 'record.props[1].value[0]']);
    expect(decide(hits, 'quarantine').action, 'a name is an identifier: never quarantined').toBe('reject');
    expect(decide(hits.slice(1), 'quarantine').action).toBe('quarantine');
    expect(decide(hits.slice(1), 'reject').action).toBe('reject');
    expect(decide([], 'reject').action).toBe('allow');
  });

  it('sends nothing while a hit blocks, and sends once when it is clean', async () => {
    let sent = 0;
    const send = async () => { sent++; return 'ok'; };
    const blocked = await sendIfClean(pre, [{ field: 'record.body', text: AWS }], send);
    expect(blocked).toMatchObject({ sent: false, hits: [{ rule: 'aws-access-token' }] });
    expect(sent).toBe(0);
    const clean = await sendIfClean(pre, [{ field: 'record.body', text: '안녕' }], send);
    expect(clean).toEqual({ sent: true, result: 'ok' });
    expect(sent).toBe(1);
    // With the precheck off (rules differ) nothing is checked here: the KB's 422 is the only guard.
    expect(await sendIfClean(null, [{ field: 'record.body', text: AWS }], send)).toEqual({ sent: true, result: 'ok' });
  });
});

describe('rule version and hash (design v2 5.7, ADR-0005 7.7, 8.1)', () => {
  it('the hash is the SHA-256 of key-sorted compact UTF-8 JSON, whatever the key order', async () => {
    expect(canonicalJson({ b: [1, { z: '한', a: null }], a: true })).toBe('{"a":true,"b":[1,{"a":null,"z":"한"}]}');
    const a = await rulesSha({ version: 'v', rules: [] });
    const b = await rulesSha({ rules: [], version: 'v' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(await rulesSha({ version: 'v2', rules: [] })).not.toBe(a);
  });

  it('compares the published {version, sha} with the loaded file: on only when both match', async () => {
    const sha = await rulesSha(small);
    expect(compareRules({ version: small.version, sha }, { version: small.version, sha })).toEqual({ on: true });
    expect(compareRules({ version: small.version, sha }, { version: 'fp-secret-rules-v2', sha })).toEqual({ on: false, reason: 'version_differs' });
    expect(compareRules({ version: small.version, sha }, { version: small.version, sha: 'f'.repeat(64) })).toEqual({ on: false, reason: 'sha_differs' });
    expect(compareRules({ version: small.version, sha }, { version: null, sha: null })).toEqual({ on: false, reason: 'remote_missing' });
    expect(compareRules({ version: small.version, sha }, undefined)).toEqual({ on: false, reason: 'remote_missing' });
  });
});

// The KB's own published file, when this machine has the KB repository (design v2 5.7: it is read, never copied).
const CONTRACT = '/home/user/sagae-knowloge-base/docs/contracts/first-party-secret-rules-v1.json';
describe.skipIf(!existsSync(CONTRACT))('the KB contract file (read in place)', () => {
  const file = existsSync(CONTRACT) ? JSON.parse(readFileSync(CONTRACT, 'utf8')) as RuleFile & { vectors: { id: string; field: string; text: string; on_secret: 'reject' | 'quarantine'; action: string; digest_tail?: boolean; hit?: Record<string, unknown> }[] } : undefined!;
  it('every rule compiles in this engine', () => { expect(compileRules(file).skipped).toEqual([]); });
  it('the contract synthetic vectors give the stated action; a hit also gives the stated ranges', () => {
    const pre = compileRules(file);
    for (const v of file.vectors) {
      const fields = [{ field: v.field, text: v.text, ...(v.digest_tail ? { digestTail: true } : {}) }];
      const hits = pre.scan(fields);
      expect(decide(hits, v.on_secret).action, v.id).toBe(v.action);
      if (v.hit) expect(hits[0], v.id).toMatchObject(v.hit);
    }
  });
});

// ---- loupe serve in front of kb-mock (write on) and in front of a stub that records what it is sent
const EDITOR = 'kbt_e_serve-test-editor', REVIEWER = 'kbt_r_serve-test-reviewer';
const cache = new URL('../.cache/', import.meta.url).pathname;
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(path.join(cache, 'write-test-'));
const sockDir = process.env.LOUPE_SOCKET_DIR ?? os.tmpdir();
const sockPath = (n: string) => path.join(sockDir, `${process.pid % 10000}w${n}`);
const servers: net.Server[] = [];
const listen = (s: net.Server, ...a: unknown[]) => new Promise<void>((res, rej) => { s.once('error', rej); (s.listen as (...x: unknown[]) => void)(...a, res); servers.push(s); });

let idp: Idp, skew = 0;
const mockLog: string[] = [];
type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
const stubSeen: Seen[] = [];
let stubReply: (req: Seen) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } });
type Stack = { port: number; origin: string; session: string };
const stacks: Record<string, Stack> = {};

async function stack(name: string, kbSock: string, extra: Partial<ServeConfig> = {}): Promise<Stack> {
  let app: ReturnType<typeof createLoupeApp> | undefined;
  const s = createAdaptorServer({ fetch: (r: Request) => app!.fetch(r) }) as net.Server;
  await listen(s, 0, '127.0.0.1');
  const port = (s.address() as net.AddressInfo).port;
  const authDir = path.join(dir, `auth-${name}`);
  writeAuthConfig(authDir);
  app = createLoupeApp({ kb: { kind: 'unix', path: kbSock }, dist: path.join(dir, 'dist'), port, auth: { dir: authDir, issuer: idp.url, log: () => undefined, now: () => Date.now() + skew }, ...extra });
  const origin = `http://localhost:${port}`;
  const out = { port, origin, session: await login(origin) };
  stacks[name] = out;
  return out;
}

/** One request with every header under the test's control (fetch would set Origin and Sec-Fetch-* itself). */
function send(st: Stack, method: string, p: string, body?: string | Buffer, headers: Record<string, string> = {}, o: { session?: boolean | string; browser?: boolean } = {}) {
  const base: Record<string, string> = o.browser === false ? {} : { origin: st.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-loupe-write': '1' };
  const session = o.session === false ? undefined : typeof o.session === 'string' ? o.session : st.session;
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; json: Record<string, any> }>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = http.request({ host: '127.0.0.1', port: st.port, path: p, method, headers: { host: `localhost:${st.port}`, ...base, ...(session ? { authorization: `Bearer ${session}` } : {}), ...headers } }, (res) => {
      const c: Buffer[] = []; res.on('data', (d) => c.push(d));
      res.on('end', () => { const text = Buffer.concat(c).toString('utf8'); let json = {}; try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ } resolve({ status: res.statusCode!, headers: res.headers, text, json }); });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const rec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'Note', title: '메모', body: '본문', body_format: 'markdown', props: {}, links: [], ...over });
const sample = (key = 'loupe:c:t') => JSON.stringify({ idempotency_key: key, change: 'save', expected_version: 1, reason: 'x', record: rec({ expected_version: 1 }) });
const since = (n: number) => mockLog.slice(n);

beforeAll(async () => {
  idp = await startIdp();
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  writeFileSync(path.join(dir, 'dist', 'index.html'), '<!doctype html><title>t</title>');
  const mock = sockPath('m');
  await listen(createAdaptorServer({ fetch: createKbMock({ write: { editorToken: EDITOR, reviewerToken: REVIEWER }, onAccess: (l) => mockLog.push(l) }).fetch }) as net.Server, mock);
  const closed = sockPath('c');
  await listen(createAdaptorServer({ fetch: createKbMock({ write: { editorToken: EDITOR, reviewerToken: REVIEWER, privateOpen: false } }).fetch }) as net.Server, closed);
  const stub = sockPath('s');
  await listen(http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const seen = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      stubSeen.push(seen);
      const r = stubReply(seen);
      res.writeHead(r.status, { 'content-type': r.status >= 400 ? 'application/problem+json' : 'application/json' });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    });
  }) as net.Server, stub);
  await stack('mock', mock, { editorToken: EDITOR, reviewerToken: REVIEWER });
  await stack('closed', closed, { editorToken: EDITOR, reviewerToken: REVIEWER });
  await stack('stub', stub, { editorToken: EDITOR, reviewerToken: REVIEWER });
  await stack('noreviewer', mock, { editorToken: EDITOR });
  await stack('stubnr', stub, { editorToken: EDITOR });
  await stack('notokens', mock);
});
afterAll(async () => { await idp.stop(); for (const s of servers) s.close(); rmSync(dir, { recursive: true, force: true }); for (const n of ['m', 'c', 's']) rmSync(sockPath(n), { force: true }); });

// design v2 5.1: the browser says POST /kb-write/<action>; loupe serve maps it to the KB's method with the right token.
const TABLE: { browser: string; kb: string; scope: 'editor' | 'reviewer' }[] = [
  { browser: '/kb-write/records', kb: 'POST /v1/records', scope: 'editor' },
  { browser: '/kb-write/records/f-abc', kb: 'PUT /v1/records/:id', scope: 'editor' },
  { browser: '/kb-write/records/f-abc/tombstone', kb: 'POST /v1/records/:id/tombstone', scope: 'editor' },
  { browser: '/kb-write/records/f-abc/promote', kb: 'POST /v1/records/:id/promote', scope: 'editor' },
  { browser: '/kb-write/topics/f-spec/research', kb: 'POST /v1/topics/:spec/research', scope: 'editor' },
  { browser: '/kb-write/topics/f-spec/research/t-run/stop', kb: 'POST /v1/topics/:spec/research/:run/stop', scope: 'editor' },
  { browser: '/kb-write/writes/w-ref/discard', kb: 'DELETE /v1/writes/:ref', scope: 'editor' },
  { browser: '/kb-write/actions', kb: 'POST /v1/actions', scope: 'reviewer' },
  { browser: '/kb-write/actions/challenge', kb: 'POST /v1/actions/challenge', scope: 'reviewer' },
  { browser: '/kb-write/actions/a-1/external-refine', kb: 'POST /v1/actions/:id/external-refine', scope: 'reviewer' },
  { browser: '/kb-write/actions/a-1/execute', kb: 'POST /v1/actions/:id/execute', scope: 'reviewer' },
  { browser: '/kb-write/hitl/challenge', kb: 'POST /v1/hitl/challenge', scope: 'reviewer' },
  { browser: '/kb-write/hitl/h-1/resolve', kb: 'POST /v1/hitl/:item/resolve', scope: 'reviewer' },
  { browser: '/kb-write/reviewer/enroll', kb: 'POST /v1/reviewer/enroll', scope: 'reviewer' },
];

describe('/kb-write/* route table (design v2 5.1)', () => {
  it('KB_WRITE_ROUTES is the table, all POST', () => {
    expect(KB_WRITE_ROUTES.length).toBe(TABLE.length);
    for (const r of KB_WRITE_ROUTES) expect(r.method).toBe('POST');
  });

  it('every entry reaches the KB route it names, with the token of its scope and no other', async () => {
    const st = stacks.mock!;
    for (const t of TABLE) {
      const n = mockLog.length;
      const r = await send(st, 'POST', t.browser, sample(`loupe:c:${t.kb}`));
      expect(r.status, t.browser).toBeLessThan(600);
      const line = since(n);
      expect(line, t.browser).toHaveLength(1);
      expect(line[0], t.browser).toMatch(new RegExp(`^${t.kb.replace(/[/:]/g, (m) => `\\${m}`)} \\d{3} scope=${t.scope}$`));
    }
  });

  it('a path outside the table is 404 and the KB is not called', async () => {
    const st = stacks.mock!;
    const n = mockLog.length;
    const outside = [
      '/kb-write', '/kb-write/', '/kb-write/records/', '/kb-write/records/f-a/b/c', '/kb-write/records/f-a/delete', '/kb-write/v1/records', '/kb-write/auth', '/kb-write/token',
      '/kb-write/settings', '/kb-write/topics/f-s', '/kb-write/topics/f-s/research/run', '/kb-write/topics//research', '/kb-write/writes/w-1', '/kb-write/writes/w-1/discard/x',
      '/kb-write/actions/a-1', '/kb-write/actions/a-1/execute/now', '/kb-write/hitl', '/kb-write/hitl/h-1', '/kb-write/reviewer', '/kb-write/Records',
      '/kb-write/records/%2e%2e/tombstone', '/kb-write/records/a%2Fb', '/kb-write/records/..%2F..%2Fv1%2Fmeta', '/kb-write/records/%00/promote', '/kb-write//records',
    ];
    for (const p of outside) {
      const r = await send(st, 'POST', p, sample());
      expect(r.status, p).toBe(404);
    }
    expect(since(n), 'no request reached the KB').toEqual([]);
  });

  it('PUT, DELETE, PATCH and GET to any listed path are 405 and the KB is not called', async () => {
    const st = stacks.mock!;
    const n = mockLog.length;
    for (const t of TABLE) for (const m of ['PUT', 'DELETE', 'PATCH', 'GET', 'HEAD']) {
      // A browser's fetch(…, { method: 'DELETE' }) has no body; node-server answers a GET/DELETE that has one with its own 400 before loupe's code runs.
      const r = await send(st, m, t.browser, m === 'PUT' || m === 'PATCH' ? sample() : undefined);
      expect(r.status, `${m} ${t.browser}`).toBe(405);
    }
    expect(since(n)).toEqual([]);
  });

  it('only dry_run=1 is a query loupe lets through, and only on a record create or edit', async () => {
    const st = stacks.mock!;
    const n = mockLog.length;
    for (const p of ['/kb-write/records?x=1', '/kb-write/records?dry_run=2', '/kb-write/records/f-a/tombstone?dry_run=1', '/kb-write/actions?dry_run=1', '/kb-write/records?dry_run=1&x=1']) {
      expect((await send(st, 'POST', p, sample())).json, p).toMatchObject({ status: 400, code: 'bad_param' });
    }
    expect(since(n)).toEqual([]);
    const r = await send(st, 'POST', '/kb-write/records?dry_run=1', sample('loupe:c:dry'));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ would_reject: false });
  });

  it('a body that is not a JSON object is refused here (400), and one over 2 MiB is 413, before the KB sees anything', async () => {
    const st = stacks.mock!;
    const n = mockLog.length;
    expect((await send(st, 'POST', '/kb-write/records', '{nope')).json).toMatchObject({ status: 400, code: 'bad_json' });
    expect((await send(st, 'POST', '/kb-write/records', '[1]')).json).toMatchObject({ status: 400, code: 'bad_json' });
    expect((await send(st, 'POST', '/kb-write/records', '')).json).toMatchObject({ status: 400, code: 'bad_json' });
    const big = await send(st, 'POST', '/kb-write/records', JSON.stringify({ idempotency_key: 'k', change: 'save', record: rec({ body: 'x'.repeat(2 * 1024 * 1024) }) }));
    expect(big.json).toMatchObject({ status: 413, code: 'body_too_large' });
    expect(since(n)).toEqual([]);
  });
});

describe('who may write: the guard and the session come first', () => {
  it('without a session a forged Origin gets 401 on reads and on writes, and the KB sees nothing', async () => {
    const st = stacks.mock!;
    const n = mockLog.length;
    expect((await send(st, 'POST', '/kb-write/records', sample(), {}, { session: false })).status).toBe(401);
    expect((await send(st, 'GET', '/kb/v1/meta', undefined, { origin: st.origin }, { session: false, browser: false })).status).toBe(401);
    expect((await send(st, 'POST', '/kb-write/records', sample(), {}, { session: 'A'.repeat(43) })).status, 'a made-up session').toBe(401);
    expect(since(n)).toEqual([]);
  });

  it('a made-up Origin, another port, another Host or a text/plain body is 403/415 and the KB sees nothing', async () => {
    const st = stacks.mock!;
    const n = mockLog.length;
    for (const origin of ['http://127.0.0.1:4812', 'http://localhost:4810', 'http://127.0.0.1:4899', 'null']) {
      expect((await send(st, 'POST', '/kb-write/records', sample(), { origin })).status, origin).toBe(403);
    }
    expect((await send(st, 'POST', '/kb-write/records', sample(), { host: 'evil.example:4812' })).status).toBe(403);
    expect((await send(st, 'GET', '/kb/v1/meta', undefined, { host: 'evil.example:4812' }, { browser: false })).status).toBe(403);
    expect((await send(st, 'POST', '/kb-write/records', sample(), { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await send(st, 'POST', '/kb-write/records', sample(), { 'x-loupe-write': '' })).status).toBe(403);
    expect((await send(st, 'POST', '/kb-write/records', sample(), { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect(since(n)).toEqual([]);
  });

  it('a session past the idle limit is 401 on the next write, and after lock the old session is 401', async () => {
    const st = await stack('clock', sockPath('m'), { editorToken: EDITOR, reviewerToken: REVIEWER });
    const n = mockLog.length;
    expect((await send(st, 'POST', '/kb-write/records', sample('loupe:c:clock1'))).status).toBe(201);
    skew = 61 * 60_000;
    try {
      expect((await send(st, 'POST', '/kb-write/records', sample('loupe:c:clock2'))).status, 'idle for an hour').toBe(401);
      expect((await send(st, 'GET', '/kb/v1/meta', undefined, { origin: st.origin }, { browser: false })).status).toBe(401);
    } finally { skew = 0; }
    expect(since(n), 'the expired write never reached the KB').toHaveLength(1);
    const st2 = await stack('lock', sockPath('m'), { editorToken: EDITOR, reviewerToken: REVIEWER });
    expect((await send(st2, 'POST', '/kb-write/records', sample('loupe:c:lock1'))).status).toBe(201);
    expect((await send(st2, 'POST', '/auth/lock', '{}', { 'x-loupe-auth': '1' })).status).toBe(204);
    expect((await send(st2, 'POST', '/kb-write/records', sample('loupe:c:lock2'))).status, 'the locked session').toBe(401);
  });
});

describe('what the KB is sent (design v2 5.1: the editor token, never both, never the browser\'s headers)', () => {
  const seenFor = async (st: Stack, p: string, body = sample()) => { const n = stubSeen.length; const r = await send(st, 'POST', p, body, { cookie: 'a=b', 'x-forwarded-for': '9.9.9.9' }); return { r, got: stubSeen.slice(n) }; };

  it('an editor path carries the editor token only, on a request with none of the browser\'s own headers and not the loupe session', async () => {
    const st = stacks.stub!;
    const { r, got } = await seenFor(st, '/kb-write/records/f-abc');
    expect(r.status).toBe(200);
    expect(got).toHaveLength(1);
    const g = got[0]!;
    expect([g.method, g.url]).toEqual(['PUT', '/v1/records/f-abc']);
    expect(g.headers.authorization).toBe(`Bearer ${EDITOR}`);
    expect(g.headers['content-type']).toBe('application/json');
    for (const h of ['origin', 'cookie', 'x-loupe-write', 'x-loupe-activity', 'x-forwarded-for', 'sec-fetch-site', 'referer']) expect(g.headers[h], h).toBeUndefined();
    expect(JSON.stringify(g.headers)).not.toContain(st.session);
    expect(g.body).toBe(sample());
  });

  it('a reviewer path carries the reviewer token, and the editor token reaches a reviewer path 0 times', async () => {
    const st = stacks.stub!;
    const n = stubSeen.length;
    for (const t of TABLE.filter((x) => x.scope === 'reviewer')) await send(st, 'POST', t.browser, sample());
    for (const t of TABLE.filter((x) => x.scope === 'editor')) await send(st, 'POST', t.browser, sample());
    const got = stubSeen.slice(n);
    expect(got).toHaveLength(TABLE.length);
    const reviewerPaths = got.filter((g) => /^\/v1\/(actions|hitl|reviewer)/.test(g.url));
    expect(reviewerPaths).toHaveLength(7);
    expect(reviewerPaths.filter((g) => g.headers.authorization === `Bearer ${EDITOR}`)).toHaveLength(0);
    expect(reviewerPaths.every((g) => g.headers.authorization === `Bearer ${REVIEWER}`)).toBe(true);
    expect(got.filter((g) => !reviewerPaths.includes(g)).every((g) => g.headers.authorization === `Bearer ${EDITOR}`)).toBe(true);
  });

  it('without the reviewer token a reviewer path is 503 and goes nowhere, and the editor token is not used instead; without the editor token the editor paths are 503', async () => {
    const n = mockLog.length;
    for (const t of TABLE.filter((x) => x.scope === 'reviewer')) expect((await send(stacks.noreviewer!, 'POST', t.browser, sample())).json, t.browser).toMatchObject({ status: 503, code: 'token_not_configured' });
    expect(since(n)).toEqual([]);
    expect((await send(stacks.noreviewer!, 'POST', '/kb-write/records', sample('loupe:c:nr1'))).status).toBe(201);
    for (const t of TABLE) expect((await send(stacks.notokens!, 'POST', t.browser, sample())).json, t.browser).toMatchObject({ status: 503, code: 'token_not_configured' });
    expect(since(n)).toHaveLength(1);
  });

  it('reads carry the editor token (the KB shows private to it), the reviewer-only reads the reviewer token, and never both', async () => {
    const st = stacks.stub!;
    const get = async (p: string) => { const n = stubSeen.length; await send(st, 'GET', p, undefined, { origin: st.origin }, { browser: false }); return stubSeen.slice(n); };
    const nodes = await get('/kb/v1/nodes?types=Note');
    expect(nodes.map((g) => g.headers.authorization)).toEqual([`Bearer ${EDITOR}`]);
    for (const p of ['/kb/v1/hitl', '/kb/v1/actions/a-1']) expect((await get(p)).map((g) => g.headers.authorization), p).toEqual([`Bearer ${REVIEWER}`]);
    expect((await get('/kb/v1/writes/w-1')).map((g) => g.headers.authorization)).toEqual([`Bearer ${EDITOR}`]);
    // The loupe session never goes upstream.
    expect(JSON.stringify(stubSeen.slice(-4).map((g) => g.headers))).not.toContain(st.session);
  });

  it('a reviewer-only read without a reviewer token goes out with no token, not with the editor token', async () => {
    const nr = stacks.stubnr!;
    const n = stubSeen.length;
    await send(nr, 'GET', '/kb/v1/hitl', undefined, { origin: nr.origin }, { browser: false });
    const got = stubSeen.slice(n);
    expect(got).toHaveLength(1);
    expect(got[0]!.headers.authorization).toBeUndefined();
  });
});

describe('what comes back', () => {
  it('relays status and body with no-store, and a same-key resend is a replay, not a second record', async () => {
    const st = stacks.mock!;
    const body = sample('loupe:c:relay1');
    const a = await send(st, 'POST', '/kb-write/records', body);
    expect(a.status).toBe(201);
    expect(a.headers['cache-control']).toBe('no-store');
    expect(a.json).toMatchObject({ version: 1, replayed: false, actor: 'app:loupe', claimed_author: 'user:sagae' });
    const b = await send(st, 'POST', '/kb-write/records', body);
    expect(b.json).toMatchObject({ id: a.json.id, version: 1, replayed: true });
    const edit = (k: string, v: number, text: string) => send(st, 'POST', `/kb-write/records/${a.json.id}`, JSON.stringify({ idempotency_key: k, change: 'save', record: rec({ body: text, expected_version: v }) }));
    expect((await edit('loupe:e:r:v1:save:r1', 1, 'B')).json).toMatchObject({ version: 2 });
    const stale = await edit('loupe:e:r:v1:save:r2', 1, 'C');
    expect(stale.status).toBe(409);
    expect(stale.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(stale.json).toMatchObject({ code: 'version_conflict', current: { version: 2, body: 'B' } });
  });

  it('a 202 write_ref is followed through /kb/v1/writes/{ref} to committed, and a failed one hands the sent copy back until it is discarded', async () => {
    const st = stacks.mock!;
    const ok = await send(st, 'POST', '/kb-write/records', JSON.stringify({ idempotency_key: 'loupe:c:spool1', change: 'save', record: rec({ title: '[mock:spool] 느림' }) }));
    expect(ok.status).toBe(202);
    const ref = ok.json.write_ref as string;
    const poll = (r: string) => send(st, 'GET', `/kb/v1/writes/${r}`, undefined, { origin: st.origin }, { browser: false });
    expect((await poll(ref)).json.data).toMatchObject({ state: 'pending' });
    expect((await poll(ref)).json.data).toMatchObject({ state: 'committed', version: 1 });
    const bad = await send(st, 'POST', '/kb-write/records', JSON.stringify({ idempotency_key: 'loupe:c:spool2', change: 'save', record: rec({ title: '[mock:fail] 실패', body: 'my copy' }) }));
    const ref2 = bad.json.write_ref as string;
    await poll(ref2);
    expect((await poll(ref2)).json.data).toMatchObject({ state: 'failed', code: 'version_conflict' });
    expect((await send(st, 'GET', `/kb/v1/writes/${ref2}?include=body`, undefined, { origin: st.origin }, { browser: false })).json.data).toMatchObject({ record: { body: 'my copy' } });
    expect((await send(st, 'POST', `/kb-write/writes/${ref2}/discard`, '{}')).json).toMatchObject({ state: 'purged' });
    expect((await poll(ref2)).json.data.state).toBe('purged');
  });

  it('private_open false: the KB refuses a private note and loupe hands that refusal on unchanged', async () => {
    const r = await send(stacks.closed!, 'POST', '/kb-write/records', sample('loupe:c:closed1'));
    expect(r.json).toMatchObject({ status: 403, code: 'sensitivity_not_allowed' });
    const meta = await send(stacks.closed!, 'GET', '/kb/v1/meta', undefined, { origin: stacks.closed!.origin }, { browser: false });
    expect(meta.json.data.write.private_open).toBe(false);
  });

  it('a 422 keeps rule ids and ranges and drops everything else: the value is not echoed even by a KB that does so', async () => {
    const st = stacks.stub!;
    const hit = { field: 'record.body', rule: 'aws-access-token', start: 6, end: 26, start_u16: 6, end_u16: 26 };
    stubReply = () => ({ status: 422, body: { type: 'https://kb.local/problems/secret-detected', title: 'secret detected', status: 422, detail: `found ${AWS}`, code: 'secret_detected', instance: '/v1/records', hits: [{ ...hit, value: AWS, match: AWS }], stored: false, echo: AWS, record: { body: AWS } } });
    try {
      const r = await send(st, 'POST', '/kb-write/records', JSON.stringify({ idempotency_key: 'loupe:c:e', change: 'save', record: rec({ body: AWS }) }));
      expect(r.status).toBe(422);
      expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(r.json).toMatchObject({ code: 'secret_detected', status: 422, hits: [hit], stored: false });
      expect(r.text).not.toContain(AWS);
      expect(Object.keys(r.json.hits[0]).sort()).toEqual(Object.keys(hit).sort());
      // The same holds for a dry run's 200 and for a body that is not JSON at all.
      stubReply = () => ({ status: 200, body: { would_reject: true, hits: [{ ...hit, value: AWS }], secret_rules: { version: 'v', sha: 'a'.repeat(64) }, echo: AWS } });
      const d = await send(st, 'POST', '/kb-write/records?dry_run=1', sample('loupe:c:e2'));
      expect(d.json).toMatchObject({ would_reject: true, hits: [hit], secret_rules: { version: 'v' } });
      expect(d.text).not.toContain(AWS);
      stubReply = () => ({ status: 422, body: `<html>${AWS}</html>` });
      const h = await send(st, 'POST', '/kb-write/records', sample('loupe:c:e3'));
      expect(h.status).toBe(502);
      expect(h.text).not.toContain(AWS);
    } finally { stubReply = () => ({ status: 200, body: { ok: true } }); }
  });

  it('the kb-mock 422 reaches the browser with hits and no value, and nothing was saved', async () => {
    const st = stacks.mock!;
    const n = mockLog.length;
    const r = await send(st, 'POST', '/kb-write/records', JSON.stringify({ idempotency_key: 'loupe:c:sec1', change: 'save', record: rec({ body: `x\n${AWS}` }) }));
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ code: 'secret_detected', stored: false, hits: [{ field: 'record.body', rule: 'aws-access-token' }] });
    expect(r.text).not.toContain(AWS);
    expect(since(n)).toEqual(['POST /v1/records 422 scope=editor']);
    // "Not a secret" resends the same key with on_secret=quarantine (5.5); the KB stores it as secret and the answer says so.
    const q = await send(st, 'POST', '/kb-write/records', JSON.stringify({ idempotency_key: 'loupe:c:sec1', change: 'save', on_secret: 'quarantine', record: rec({ body: `x\n${AWS}` }) }));
    expect(q.json).toMatchObject({ quarantined: true, sensitivity: 'secret', warnings: ['secret_detected:aws-access-token'] });
    expect(q.text).not.toContain(AWS);
  });

  it('a KB that is down is 502, one that never answers is 504, and the browser is told to resend with the same key', async () => {
    const dead = await stack('dead', sockPath('nope'), { editorToken: EDITOR, reviewerToken: REVIEWER });
    const r = await send(dead, 'POST', '/kb-write/records', sample('loupe:c:down'));
    expect(r.status).toBe(502);
    expect(r.json.code).toBe('kb_socket_missing');
    expect(r.headers['cache-control']).toBe('no-store');
    const slowSock = sockPath('slow');
    await listen(http.createServer(() => { /* never answers */ }) as net.Server, slowSock);
    const slow = await stack('slow', slowSock, { editorToken: EDITOR, reviewerToken: REVIEWER, writeFirstByteMs: 300 });
    const t0 = Date.now();
    expect((await send(slow, 'POST', '/kb-write/records', sample('loupe:c:slow'))).status).toBe(504);
    expect(Date.now() - t0).toBeLessThan(3000);
    rmSync(slowSock, { force: true });
  });

  it('the secret vectors of the rule fixture never reach the KB when loupe runs the precheck first, and the KB rejects them when it does not', async () => {
    const pre = compileRules(mockRules);
    const st = stacks.mock!;
    const n = mockLog.length;
    let sentByLoupe = 0;
    for (const v of mockVectors.filter((x) => x.action !== 'allow')) {
      const body = { idempotency_key: v.field === 'idempotency_key' ? v.text : `loupe:c:pv-${v.id}`, change: 'save' as const, on_secret: v.on_secret, record: rec(v.field === 'record.body' ? { body: v.text } : v.field === 'record.props[0].name' ? { props: { [v.text]: 'x' } } : {}) };
      const out = await sendIfClean(pre, recordFields(body), async () => { sentByLoupe++; return send(st, 'POST', '/kb-write/records', JSON.stringify(body)); });
      expect(out.sent, v.id).toBe(false);
    }
    expect(sentByLoupe).toBe(0);
    expect(since(n), 'while blocked: no write and no search').toEqual([]);
    // Precheck off (rule version differs): the KB's 422 is the guard, and it holds for the same vectors.
    for (const v of mockVectors.filter((x) => x.action === 'reject')) {
      const body = { idempotency_key: v.field === 'idempotency_key' ? v.text : `loupe:c:kv-${v.id}`, change: 'save' as const, on_secret: v.on_secret, record: rec(v.field === 'record.body' ? { body: v.text } : v.field === 'record.props[0].name' ? { props: { [v.text]: 'x' } } : {}) };
      const out = await sendIfClean(null, recordFields(body), () => send(st, 'POST', '/kb-write/records', JSON.stringify(body)));
      expect(out.sent && out.result.status, v.id).toBe(422);
      expect(out.sent && out.result.text, v.id).not.toContain(v.text);
    }
  });
});
