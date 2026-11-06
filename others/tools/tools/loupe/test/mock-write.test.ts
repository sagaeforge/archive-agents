// kb-mock's imitation of the ADR-0005 rev 9 write path (design v2 11.2 M1): records, edits, tombstone, 422 `hits`, 409 `current`, 202
// `write_ref`, `private_open` and `/v1/meta.write`. Opt-in (`write`), like the task fixtures: without it every other test is untouched.
import { describe, expect, it } from 'vitest';
import { createKbMock } from '../dev/kb-mock/app.ts';
import { mockRules, mockVectors } from '../dev/kb-mock/write.ts';
import { compileRules, decide, rulesSha } from '../server/precheck.ts';

const E = 'kbt_e_mock-editor', R = 'kbt_r_mock-reviewer';
const AWS = ['AK', 'IA', 'IOSFODNN7', 'EXAMPLE'].join('');
const make = (write: Record<string, unknown> = {}) => {
  const log: string[] = [];
  const app = createKbMock({ write: { editorToken: E, reviewerToken: R, ...write }, onAccess: (l) => log.push(l) });
  const call = async (method: string, path: string, body?: unknown, token: string | null = E, headers: Record<string, string> = {}) => {
    const res = await app.fetch(new Request(`http://localhost${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    }));
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: (text ? JSON.parse(text) : null) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { app, log, call };
};
const rec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'Note', title: '메모', body: '본문', body_format: 'markdown', props: {}, links: [], ...over });
const create = (key: string, record = rec(), extra: Record<string, unknown> = {}) => ({ idempotency_key: key, change: 'save', record, ...extra });

describe('/v1/meta.write is the rev 9 shape', () => {
  it('carries fp_gate, editor_routes, private_open, hitl and the rule set version with its real hash', async () => {
    const { call } = make();
    const w = (await call('GET', '/v1/meta', undefined, null)).json.data.write;
    expect(w).toMatchObject({ fp_gate: true, private_open: true, hitl: { available: true, trust_store: 'ready' } });
    expect(w.editor_routes).toEqual(expect.arrayContaining(['POST /v1/records', 'PUT /v1/records/{id}', 'POST /v1/records/{id}/tombstone']));
    expect(w.secret_rules).toEqual({ version: mockRules.version, sha: await rulesSha(mockRules) });
    expect(w.secret_rules.sha).toMatch(/^[0-9a-f]{64}$/);
  });
  it('private_open false is reported, and without the option the old summary stays', async () => {
    expect((await make({ privateOpen: false }).call('GET', '/v1/meta', undefined, null)).json.data.write.private_open).toBe(false);
    const plain = createKbMock({});
    const m = await (await plain.fetch(new Request('http://localhost/v1/meta'))).json() as { data: { write: { secret_rules: { sha: string } } } };
    expect(m.data.write.secret_rules.sha).toBe('0'.repeat(64));
  });
});

describe('tokens and scopes', () => {
  it('no token is 401 token_required, a wrong one 401 token_invalid, and nothing is written', async () => {
    const { call, log } = make();
    expect((await call('POST', '/v1/records', create('loupe:c:a'), null)).json).toMatchObject({ status: 401, code: 'token_required' });
    expect((await call('POST', '/v1/records', create('loupe:c:a'), 'kbt_e_other')).json).toMatchObject({ status: 401, code: 'token_invalid' });
    expect(log.every((l) => /\b401$/.test(l)), 'a refused token names no scope').toBe(true);
  });
  it('the reviewer token cannot write records, and the editor token cannot reach a reviewer path', async () => {
    const { call, log } = make();
    expect((await call('POST', '/v1/records', create('loupe:c:a'), R)).json).toMatchObject({ status: 403, code: 'scope_denied' });
    expect((await call('POST', '/v1/actions', { action: 'publish' }, E)).json).toMatchObject({ status: 403, code: 'scope_denied' });
    expect((await call('POST', '/v1/actions', { action: 'publish' }, R)).status).toBe(201);
    // The access line names the scope the token had, so a test can count editor tokens that reached a reviewer path.
    expect(log).toEqual(['POST /v1/records 403 scope=reviewer', 'POST /v1/actions 403 scope=editor', 'POST /v1/actions 201 scope=reviewer']);
  });
  it('the request is checked: JSON only, a change, a known type, no secret sensitivity, no unknown query', async () => {
    const { call } = make();
    expect((await call('POST', '/v1/records', 'x=1', E, { 'content-type': 'text/plain' })).json).toMatchObject({ status: 415, code: 'unsupported_media_type' });
    expect((await call('POST', '/v1/records', '{nope')).json).toMatchObject({ status: 400, code: 'bad_json' });
    expect((await call('POST', '/v1/records', { idempotency_key: 'loupe:c:a', record: rec() })).json).toMatchObject({ status: 400, code: 'schema_invalid' });
    expect((await call('POST', '/v1/records', create('loupe:c:a', rec({ type: 'Claim' })))).json).toMatchObject({ status: 403, code: 'type_not_allowed' });
    expect((await call('POST', '/v1/records', create('loupe:c:a', rec({ sensitivity: 'secret' })))).json).toMatchObject({ status: 403, code: 'sensitivity_not_allowed' });
    expect((await call('POST', '/v1/records?x=1', create('loupe:c:a'))).json).toMatchObject({ status: 400, code: 'bad_param' });
    const r = await call('POST', '/v1/records', create('loupe:c:a', rec({ author: 'user:evil' })));
    expect(r.json).toMatchObject({ status: 400, code: 'schema_invalid' });
    expect(r.text).not.toContain('user:evil');
  });
});

describe('create, edit, tombstone, restore', () => {
  it('creates a private note by default, as app:loupe, with a stable id and the response shape of 2.4', async () => {
    const { call } = make();
    const r = await call('POST', '/v1/records', create('loupe:c:11111111-1111-4111-8111-111111111111'));
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.json).toMatchObject({ version: 1, replayed: false, unchanged: false, projected: true, spooled: false, held: false, write_ref: null, quarantined: false, warnings: [], reason: null, actor: 'app:loupe', claimed_author: 'user:sagae', generated_by: 'app:loupe:save' });
    expect(r.json.id).toMatch(/^f-[a-z2-7]{26}$/);
    expect(r.json.payload_sha).toMatch(/^[0-9a-f]{64}$/);
    expect(r.json.sensitivity ?? 'private').toBe('private');
    const again = await call('POST', '/v1/records', create('loupe:c:11111111-1111-4111-8111-111111111111'));
    expect(again.json.id).toBe(r.json.id);
  });

  it('a same-key resend replays the first answer and makes no second record or version', async () => {
    const { call, app } = make();
    const first = await call('POST', '/v1/records', create('loupe:c:r1'));
    const again = await call('POST', '/v1/records', create('loupe:c:r1'));
    expect(again.status).toBe(201);
    expect(again.json).toMatchObject({ id: first.json.id, version: 1, replayed: true, payload_sha: first.json.payload_sha });
    const edit = (key: string, v: number, body: string) => call('PUT', `/v1/records/${first.json.id}`, { idempotency_key: key, change: 'save', record: rec({ body, expected_version: v }) });
    const e1 = await edit('loupe:e:x:v1:save:r1', 1, 'B');
    const e2 = await edit('loupe:e:x:v1:save:r1', 1, 'B');
    expect(e1.json).toMatchObject({ version: 2, replayed: false });
    expect(e2.json).toMatchObject({ version: 2, replayed: true });
    expect(app).toBeDefined();
  });

  it('a create key resent with other content is 409 version_conflict with the current version, not a second record', async () => {
    const { call } = make();
    const first = await call('POST', '/v1/records', create('loupe:c:r2', rec({ body: '첫 본문' })));
    const other = await call('POST', '/v1/records', create('loupe:c:r2', rec({ body: '고친 본문' })));
    expect(other.status).toBe(409);
    expect(other.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    expect(other.json).toMatchObject({ code: 'version_conflict', current: { version: 1, status: 'active', payload_sha: first.json.payload_sha, body: '첫 본문', body_truncated: false } });
  });

  it('PUT needs expected_version (428), a stale one is 409 with current (even when the content is equal), the right one saves', async () => {
    const { call } = make();
    const c = await call('POST', '/v1/records', create('loupe:c:p1', rec({ body: 'A' })));
    const id = c.json.id as string;
    const put = (key: string, record: Record<string, unknown>) => call('PUT', `/v1/records/${id}`, { idempotency_key: key, change: 'save', record });
    expect((await put('loupe:e:1', rec())).json).toMatchObject({ status: 428, code: 'expected_version_required' });
    const ok = await put('loupe:e:2', rec({ body: 'B', expected_version: 1 }));
    expect(ok).toMatchObject({ status: 200 });
    expect(ok.json).toMatchObject({ id, version: 2, unchanged: false, actor: 'app:loupe' });
    const stale = await put('loupe:e:3', rec({ body: 'B', expected_version: 1 }));
    expect(stale.status).toBe(409);
    expect(stale.json.current).toMatchObject({ version: 2, body: 'B', actor: 'app:loupe', payload_sha: ok.json.payload_sha });
    const same = await put('loupe:e:4', rec({ body: 'B', expected_version: 2 }));
    expect(same.status).toBe(200);
    expect(same.json).toMatchObject({ version: 2, unchanged: true });
    expect((await call('PUT', '/v1/records/f-nonexistent0000000000000', { idempotency_key: 'k', change: 'save', record: rec({ expected_version: 1 }) })).json).toMatchObject({ status: 404, code: 'not_found' });
    expect((await call('PUT', `/v1/records/${id}?dry_run=2`, { idempotency_key: 'k', change: 'save', record: rec({ expected_version: 2 }) })).json.code).toBe('bad_param');
  });

  it('tombstone needs expected_version; afterwards a stale write sees only {version, status}, and a PUT on the tombstone version restores', async () => {
    const { call } = make();
    const c = await call('POST', '/v1/records', create('loupe:c:t1'));
    const id = c.json.id as string;
    expect((await call('POST', `/v1/records/${id}/tombstone`, { idempotency_key: 'loupe:t:1', change: 'save', reason: 'x' })).json.code).toBe('expected_version_required');
    const t = await call('POST', `/v1/records/${id}/tombstone`, { idempotency_key: 'loupe:t:2', change: 'save', expected_version: 1, reason: '합침' });
    expect(t.status).toBe(200);
    expect(t.json).toMatchObject({ version: 2 });
    const stale = await call('PUT', `/v1/records/${id}`, { idempotency_key: 'loupe:e:9', change: 'save', record: rec({ body: 'late', expected_version: 1 }) });
    expect(stale.status).toBe(409);
    expect(stale.json.current).toEqual({ version: 2, status: 'dead' });
    const back = await call('PUT', `/v1/records/${id}`, { idempotency_key: 'loupe:e:10', change: 'save', record: rec({ body: '복원', expected_version: 2 }) });
    expect(back.status).toBe(200);
    expect(back.json).toMatchObject({ version: 3 });
    expect((await call('PUT', `/v1/records/${id}`, { idempotency_key: 'loupe:e:11', change: 'save', record: rec({ body: '복원', expected_version: 3 }) })).json.unchanged).toBe(true);
  });
});

describe('secrets (ADR-0005 7.1 to 7.4)', () => {
  const secretBody = `내일 배포\n${AWS} 끝`;

  it('422 secret_detected with hits by rule id and range, stored:false, and the value is not in the answer', async () => {
    const { call } = make();
    const r = await call('POST', '/v1/records', create('loupe:c:s1', rec({ body: secretBody })));
    expect(r.status).toBe(422);
    expect(r.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    expect(r.json).toMatchObject({ code: 'secret_detected', stored: false, hits: [{ field: 'record.body', rule: 'aws-access-token', start: 6, end: 26, start_u16: 6, end_u16: 26 }] });
    expect(r.text).not.toContain(AWS);
    // Nothing was stored: the same key now creates.
    const ok = await call('POST', '/v1/records', create('loupe:c:s1', rec({ body: 'clean' })));
    expect(ok).toMatchObject({ status: 201 });
    expect(ok.json.replayed).toBe(false);
  });

  it('quarantine stores the content as secret with a warning, hides it afterwards, and never covers an identifier field', async () => {
    const { call } = make();
    const q = await call('POST', '/v1/records', create('loupe:c:s2', rec({ body: secretBody }), { on_secret: 'quarantine' }));
    expect(q.status).toBe(201);
    expect(q.json).toMatchObject({ quarantined: true, sensitivity: 'secret', warnings: ['secret_detected:aws-access-token'] });
    expect(q.text).not.toContain(AWS);
    // The id is a 404 for the editor from here on, a resend too (5.1: replays look at visibility again).
    expect((await call('POST', '/v1/records', create('loupe:c:s2', rec({ body: secretBody }), { on_secret: 'quarantine' }))).json).toMatchObject({ status: 404, code: 'not_found' });
    expect((await call('PUT', `/v1/records/${q.json.id}`, { idempotency_key: 'k', change: 'save', record: rec({ expected_version: 1 }) })).status).toBe(404);
    const id = await call('POST', '/v1/records', create(`loupe:c:${AWS}`, rec(), { on_secret: 'quarantine' }));
    expect(id.json).toMatchObject({ status: 422, code: 'secret_detected', hits: [{ field: 'idempotency_key' }] });
    const name = await call('POST', '/v1/records', create('loupe:c:s3', rec({ props: { [AWS]: 'v' } }), { on_secret: 'quarantine' }));
    expect(name.json).toMatchObject({ status: 422, hits: [{ field: 'record.props[0].name' }] });
    expect(name.text).not.toContain(AWS);
  });

  it('dry_run reports would_reject and the rule version and writes nothing', async () => {
    const { call, log } = make();
    const r = await call('POST', '/v1/records?dry_run=1', create('loupe:c:s4', rec({ body: secretBody })));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ would_reject: true, hits: [{ rule: 'aws-access-token' }], secret_rules: { version: mockRules.version } });
    expect(r.text).not.toContain(AWS);
    expect((await call('POST', '/v1/records?dry_run=1', create('loupe:c:s4', rec()))).json).toMatchObject({ would_reject: false, hits: [] });
    expect((await call('POST', '/v1/records', create('loupe:c:s4', rec()))).json.replayed).toBe(false);
    expect(log.filter((l) => / 201( |$)/.test(l))).toHaveLength(1);
  });

  it('the published synthetic vectors give the stated action through the KB route and through the precheck alike', async () => {
    const { call } = make();
    const pre = compileRules(mockRules);
    expect(mockVectors.length).toBeGreaterThanOrEqual(6);
    let n = 0;
    for (const v of mockVectors) {
      const record = v.field === 'record.body' ? rec({ body: v.text }) : v.field === 'record.props[0].name' ? rec({ props: { [v.text]: 'x' } }) : rec();
      const key = v.field === 'idempotency_key' ? v.text : `loupe:c:vec${n++}`;
      const r = await call('POST', '/v1/records', create(key, record, { on_secret: v.on_secret }));
      const got = r.status === 422 ? 'reject' : r.json.quarantined ? 'quarantine' : 'allow';
      expect(got, `${v.id} at the KB`).toBe(v.action);
      expect(r.text, v.id).not.toContain(v.text);
      const fields = v.field === 'idempotency_key' ? [{ field: 'idempotency_key', text: v.text }]
        : v.field === 'record.body' ? [{ field: 'record.body', text: v.text }] : [{ field: 'record.props[0].name', text: v.text }];
      expect(decide(pre.scan(fields), v.on_secret).action, `${v.id} at the precheck`).toBe(v.action);
    }
  });
});

describe('202 write_ref and private_open', () => {
  it('a spooled save answers 202 with a write_ref that stays pending, then committed with the version; a resend does not make another write', async () => {
    const { call } = make();
    const r = await call('POST', '/v1/records', create('loupe:c:w1', rec({ title: '[mock:spool] 느린 저장' })));
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ spooled: true, held: false, version: null, seq: null, projected: false, reason: 'gate_timeout' });
    expect(r.json.write_ref).toMatch(/^w-[0-9a-f]{12,}$/);
    const ref = r.json.write_ref as string;
    expect((await call('GET', `/v1/writes/${ref}`)).json.data).toMatchObject({ ref, state: 'pending', id: r.json.id, version: null, code: null });
    const done = (await call('GET', `/v1/writes/${ref}`)).json.data;
    expect(done).toMatchObject({ state: 'committed', version: 1 });
    const again = await call('POST', '/v1/records', create('loupe:c:w1', rec({ title: '[mock:spool] 느린 저장' })));
    expect(again.status).toBe(202);
    expect(again.json).toMatchObject({ write_ref: ref, replayed: true });
    expect((await call('GET', `/v1/writes/${ref}`)).json.data.state).toBe('committed');
  });

  it('a held save fails with version_conflict; the owner reads the sent copy until it is discarded, then 410', async () => {
    const { call } = make();
    const r = await call('POST', '/v1/records', create('loupe:c:w2', rec({ title: '[mock:fail] 실패할 저장', body: 'my copy' })));
    expect(r.status).toBe(202);
    const ref = r.json.write_ref as string;
    expect(r.json.reason).toBe('gate_timeout');
    await call('GET', `/v1/writes/${ref}`);
    expect((await call('GET', `/v1/writes/${ref}`)).json.data).toMatchObject({ state: 'failed', code: 'version_conflict', version: null });
    const copy = await call('GET', `/v1/writes/${ref}?include=body`);
    expect(copy.json.data).toMatchObject({ state: 'failed', record: { body: 'my copy' }, payload_sha: r.json.payload_sha });
    expect((await call('GET', `/v1/writes/${ref}?include=nope`)).status).toBe(400);
    expect((await call('GET', `/v1/writes/${ref}`, undefined, R)).status, 'only the issuing token reads it').toBe(404);
    expect((await call('DELETE', `/v1/writes/${ref}`)).json).toMatchObject({ ref, state: 'purged' });
    expect((await call('GET', `/v1/writes/${ref}?include=body`)).json).toMatchObject({ status: 410, code: 'content_removed' });
    expect((await call('GET', `/v1/writes/${ref}`)).json.data.state).toBe('purged');
  });

  it('a held (offsite path missing) save says so', async () => {
    const r = await make().call('POST', '/v1/records', create('loupe:c:w3', rec({ title: '[mock:held] 보류' })));
    expect(r.json).toMatchObject({ held: true, spooled: false, reason: 'offsite_path_missing' });
    expect(r.status).toBe(202);
  });

  it('with private_open false a new private (or default) record is refused by the KB, and internal is still accepted', async () => {
    const { call } = make({ privateOpen: false });
    expect((await call('POST', '/v1/records', create('loupe:c:o1'))).json).toMatchObject({ status: 403, code: 'sensitivity_not_allowed' });
    expect((await call('POST', '/v1/records', create('loupe:c:o2', rec({ sensitivity: 'private' })))).status).toBe(403);
    expect((await call('POST', '/v1/records', create('loupe:c:o3', rec({ sensitivity: 'internal' })))).status).toBe(201);
  });

  it('the write routes answer 405 to other methods and leave the read routes alone', async () => {
    const { call } = make();
    const r = await call('GET', '/v1/records');
    expect([404, 405]).toContain(r.status);
    expect((await call('GET', '/v1/meta', undefined, null)).status).toBe(200);
  });
});
