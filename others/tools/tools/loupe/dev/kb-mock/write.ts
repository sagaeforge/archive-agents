// Opt-in M1 imitation of the KB's first-party write path (design v2 11.2 M1; ADR-0005 rev 9, 42980bf): POST /v1/records, PUT, tombstone,
// 422 `hits`, 409 `current`, 202 `write_ref` with GET/DELETE /v1/writes/{ref}, `private_open`, and `/v1/meta.write` with a rule set
// version and hash. Nothing is persisted: a restart forgets every record. The KB (FW1~FW4) has not built this yet, so this is the only
// thing the write path is tested against until then.
//
// What it imitates and what it does not:
//  - It follows the ADR's order: token and scope, form, secret scan (before any replay lookup), replay, target visibility, expected_version,
//    content hash. Error `detail` is a fixed sentence per code and no answer repeats a request value (ADR 7.2).
//  - 202 is triggered by a title marker, so a test needs no side channel: `[mock:spool]` (gate timeout), `[mock:held]` (offsite path missing)
//    or `[mock:fail]` (a spool that ends `failed` with `version_conflict`). The write is applied on the second poll of its `write_ref`.
//  - The reviewer routes (/v1/actions*, /v1/hitl/*, /v1/reviewer/enroll) check the scope and answer 201 with nothing in it. They exist so a
//    test can count which token reached them; the WebAuthn part is M5.
//  - The secret rules are this file's own small set in the contract's shape (`first-party-secret-rules-v1.json`: rules, extra_rules,
//    vectors). The real file (221 rules) belongs to the KB; it is not copied here (design v2 5.7).
// Assumptions the ADR leaves open: the 403 for a `private` write while `private_open` is false uses `sensitivity_not_allowed`; the hash of
// the rule file is SHA-256 over key-sorted compact UTF-8 JSON (server/precheck.ts canonicalJson).
import type { Context, Hono } from 'hono';
import { createHash } from 'node:crypto';
import { canonicalJson, compileRules, decide, recordFields, type Hit, type RuleFile } from '../../server/precheck.ts';

export type WriteOptions = {
  /** The `editor` token (`kbt_e_…` in the real KB). */
  editorToken: string;
  /** The `reviewer` token. Without one every reviewer path answers 401. */
  reviewerToken?: string | undefined;
  /** `/v1/meta.write.private_open`. False refuses a new `private` (or defaulted) record. Default true. */
  privateOpen?: boolean | undefined;
};

// ---- the rule file fixture. Built from pieces so no line of source holds a live-looking secret.
const PEM = ['-----BEGIN ', 'RSA ', 'PRIVATE KEY-----'].join('');
const HEX = ['3f9a1c7e', '5b2d8046', 'a1c3e5f7', '092b4d68'].join('');
export type Vector = { id: string; field: string; text: string; on_secret: 'reject' | 'quarantine'; action: 'allow' | 'reject' | 'quarantine'; hit?: Partial<Omit<Hit, 'field'>> };
export const mockVectors: Vector[] = [
  { id: 'identifier', field: 'idempotency_key', text: PEM, on_secret: 'quarantine', action: 'reject' },
  { id: 'content-reject', field: 'record.body', text: PEM, on_secret: 'reject', action: 'reject' },
  { id: 'content-quarantine', field: 'record.body', text: PEM, on_secret: 'quarantine', action: 'quarantine' },
  { id: 'attribute-name', field: 'record.props[0].name', text: PEM, on_secret: 'quarantine', action: 'reject' },
  { id: 'digest', field: 'idempotency_key', text: `save:${HEX}`, on_secret: 'reject', action: 'allow' },
  { id: 'credential-digest', field: 'idempotency_key', text: `api_key:${HEX}`, on_secret: 'reject', action: 'reject' },
  { id: 'hangul-astral', field: 'record.body', text: `한😀${PEM}`, on_secret: 'reject', action: 'reject', hit: { rule: 'kb-private-key-header', start: 2, end: 2 + PEM.length, start_u16: 3, end_u16: 3 + PEM.length } },
];
export const mockRules: RuleFile & { vectors: Vector[] } = {
  // The OpenAPI file pins `meta.write.secret_rules.version` to this one value, so the mock's smaller rule set carries it too; only the hash tells them apart.
  version: 'fp-secret-rules-v1',
  rules: [
    { id: 'aws-access-token', pattern: String.raw`\b((?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b`, flags: 32, keywords: ['akia', 'asia', 'abia', 'acca'], entropy: 3, secret_group: null, path: null },
    { id: 'github-pat', pattern: String.raw`ghp_[0-9a-zA-Z]{36}`, flags: 32, keywords: ['ghp_'], entropy: 3, secret_group: null, path: null },
    { id: 'generic-api-key', pattern: String.raw`(?i)[\w.-]{0,50}?(?:key|token|secret|password)[ \t\w.-]{0,20}[\s'"]{0,3}(?:=|:)[\x60'"\s=]{0,5}([a-z0-9]{16,64})(?:[\x60'"\s;]|$)`, flags: 34, keywords: ['key', 'token', 'secret', 'password'], entropy: 3.5, secret_group: null, path: null },
  ],
  extra_rules: [
    { id: 'kb-private-key-header', pattern: String.raw`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----`, flags: 32 },
    { id: 'kb-env-high-entropy', pattern: String.raw`(?m)^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]{2,63})[ \t]*=[ \t]*[\"']?([^\s\"'#]{20,})[\"']?`, flags: 40, entropy: 3.5 },
  ],
  digest_exception: {
    pattern: String.raw`(?:^|(?<=:))[0-9a-f]{16,128}(?=$|:)`,
    credential_word: String.raw`(?:api)?keys?|api|tokens?|secrets?|passw(?:or)?ds?|pass|pwd|auth|credentials?|creds?|pat|access|bearer`,
    word_split: String.raw`[-_.\s]+|(?<=[a-z0-9])(?=[A-Z])`,
  },
  vectors: mockVectors,
};
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const mockRulesSha = sha256(canonicalJson(mockRules));
const scanner = compileRules(mockRules);

/** `/v1/meta` `data.write` (ADR-0005 8.1) while the write path is on. */
export const writeMeta = (w: WriteOptions) => ({
  fp_gate: true,
  editor_routes: ['POST /v1/records', 'PUT /v1/records/{id}', 'POST /v1/records/{id}/tombstone', 'GET /v1/writes/{ref}', 'DELETE /v1/writes/{ref}'],
  private_open: w.privateOpen !== false,
  hitl: { available: true, trust_store: 'ready', rp_ids: [{ rp_id: 'localhost', allowed_origins: ['http://localhost:4812', 'http://localhost:4830', 'http://localhost:4836', 'http://localhost:4837'], registered: true }] },
  secret_rules: { version: mockRules.version, sha: mockRulesSha },
});

// ---- fixed sentences: no answer repeats a request value
const DETAIL: Record<string, string> = {
  token_required: '토큰이 필요하다', token_invalid: '토큰이 맞지 않다', scope_denied: '이 토큰의 범위 밖이다', unsupported_media_type: 'application/json만 받는다',
  bad_json: 'JSON이 아니다', schema_invalid: '저장할 수 없는 값이 있다', bad_param: '허용하지 않는 쿼리다', type_not_allowed: '이 종류는 만들 수 없다',
  sensitivity_not_allowed: '이 공개 범위는 쓸 수 없다', declassify_requires_review: '공개 범위를 낮추려면 검토 확인이 필요하다', not_found: '찾을 수 없다',
  version_conflict: 'expected_version이 현재 판과 다르다', idem_conflict: '같은 키에 다른 내용이다', expected_version_required: 'expected_version이 필요하다',
  secret_detected: '비밀로 보이는 값이 있어 저장하지 않았다', body_too_large: '내용이 너무 크다', content_removed: '보관한 초안 본문이 삭제됐다',
  write_in_flight: '아직 처리 중이다', not_implemented: '이 모의 KB는 아직 이 경로를 흉내 내지 않는다', host_rejected: 'host rejected',
};
const problemOf = (c: Context, status: number, code: string, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({
  type: `https://kb.local/problems/${code.replace(/_/g, '-')}`, title: code.replace(/_/g, ' '), status, detail: DETAIL[code] ?? code, code, instance: new URL(c.req.url).pathname, ...extra,
}), { status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } });
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// ---- state
export type Version = { version: number; status: 'active' | 'dead'; payloadSha: string; record: Record<string, any>; generatedBy: string; recordedAt: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Rec = { type: string; sensitivity: string; hidden: boolean; versions: Version[] };
/** What the write routes keep. The read side (dev/kb-mock/docs.ts) looks at the same map, so a written record can be read, listed and followed through its versions. */
export type RecordStore = Map<string, Rec>;
export const createRecordStore = (): RecordStore => new Map();
type Idem = { kind: 'create' | 'edit' | 'tombstone'; id: string; payloadSha: string; expected: number | null; generatedBy: string; status: number; response: Record<string, unknown> };
type Spool = { ref: string; id: string; polls: number; end: 'committed' | 'failed'; apply: () => number; version: number | null; state: 'pending' | 'committed' | 'failed' | 'purged'; copy: Record<string, unknown>; payloadSha: string };
const SENS = ['public', 'internal', 'private'];
const TYPES = new Set(['Page', 'Note', 'TopicSpec', 'Review']);
const FORBIDDEN = ['author', 'actor', 'origin', 'generated_by', 'on_behalf_of', 'source_url', 'quote'];
const RECORD_KEYS = new Set(['id', 'type', 'title', 'body', 'body_format', 'sensitivity', 'props', 'links', 'expected_version']);
const b32 = (buf: Buffer) => { const A = 'abcdefghijklmnopqrstuvwxyz234567'; let bits = 0, v = 0, out = ''; for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += A[(v >>> (bits - 5)) & 31]; bits -= 5; } } return bits > 0 ? out + A[(v << (5 - bits)) & 31] : out; };
/** ADR-0005 5.1: `f-` + base32 of the first 16 bytes of SHA-256(prefix, actor, key). 128 bits are 26 base32 characters with the last one padded. */
const deriveId = (actor: string, key: string) => `f-${b32(createHash('sha256').update(`kb-record-id-editor-v1\0${actor}\0${key}`).digest().subarray(0, 16)).slice(0, 26)}`;
const ACTOR = 'app:loupe', AUTHOR = 'user:sagae';

export function registerWriteRoutes(app: Hono, env: { hostOk: (c: Context) => boolean; options: WriteOptions; records?: RecordStore }): void {
  const w = env.options;
  const records: RecordStore = env.records ?? createRecordStore();
  const idem = new Map<string, Idem>();
  const spools = new Map<string, Spool>();
  let seq = 190_000;

  /** The token's scope, or the refusal. Sets `scope` on the context so the access line can name it. */
  const gate = (c: Context, need: 'editor' | 'reviewer' | 'any'): Response | { scope: 'editor' | 'reviewer' } => {
    if (!env.hostOk(c)) return problemOf(c, 403, 'host_rejected');
    const h = c.req.header('authorization');
    if (!h) return problemOf(c, 401, 'token_required');
    const t = /^Bearer (.+)$/.exec(h)?.[1];
    const scope = t === w.editorToken ? 'editor' : t !== undefined && t === w.reviewerToken ? 'reviewer' : null;
    if (!scope) return problemOf(c, 401, 'token_invalid');
    (c as unknown as { set(k: string, v: unknown): void }).set('scope', scope);
    if (need !== 'any' && scope !== need) return problemOf(c, 403, 'scope_denied');
    return { scope };
  };

  type Req = { body: Record<string, any>; dry: boolean }; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Content type, query, JSON and the form of the envelope. Records and tombstones share it. */
  async function readRequest(c: Context, allowDry: boolean): Promise<Response | Req> {
    if (!/^application\/json(\s*;.*)?$/i.test(c.req.header('content-type') ?? '')) return problemOf(c, 415, 'unsupported_media_type');
    const q = new URL(c.req.url).searchParams;
    let dry = false;
    for (const [k, v] of q) { if (k === 'dry_run' && allowDry && v === '1') dry = true; else return problemOf(c, 400, 'bad_param'); }
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) return problemOf(c, 413, 'body_too_large');
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return problemOf(c, 400, 'bad_json'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return problemOf(c, 400, 'schema_invalid');
    const b = body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const key = b.idempotency_key;
    if (typeof key !== 'string' || key.length < 1 || key.length > 256 || key.includes('\0')) return problemOf(c, 400, 'schema_invalid');
    if (!['save', 'autosave', 'auto'].includes(b.change)) return problemOf(c, 400, 'schema_invalid');
    if (b.on_secret !== undefined && !['reject', 'quarantine'].includes(b.on_secret)) return problemOf(c, 400, 'schema_invalid');
    return { body: b, dry };
  }

  const shaOf = (r: Record<string, any>) => sha256(canonicalJson({ type: r.type, title: r.title, body: r.body, body_format: r.body_format ?? 'markdown', sensitivity: r.sensitivity ?? null, props: r.props ?? {}, links: r.links ?? [] })); // eslint-disable-line @typescript-eslint/no-explicit-any
  const visible = (r: Rec | undefined): r is Rec => !!r && !r.hidden;
  const head = (r: Rec) => r.versions[r.versions.length - 1]!;
  const current = (r: Rec) => {
    const v = head(r);
    if (v.status === 'dead') return { version: v.version, status: 'dead' };
    const body = String(v.record.body ?? '');
    return {
      version: v.version, status: 'active', payload_sha: v.payloadSha, actor: ACTOR, claimed_author: AUTHOR, generated_by: v.generatedBy, recorded_at: v.recordedAt,
      title: v.record.title, body: body.slice(0, 200_000), body_truncated: body.length > 200_000, props: v.record.props ?? {}, links: v.record.links ?? [],
    };
  };
  const result = (over: Record<string, unknown>) => ({
    id: null, version: null, seq: null, replayed: false, unchanged: false, projected: true, spooled: false, held: false, write_ref: null, payload_sha: null,
    quarantined: false, warnings: [] as string[], reason: null, actor: ACTOR, claimed_author: AUTHOR, generated_by: null, ...over,
  });

  /** ADR-0005 7.2: scan every field, identifiers included. Returns the answer to send, `quarantine` or null (clean). */
  function secrets(c: Context, b: Record<string, any>, dry: boolean): Response | 'quarantine' | null { // eslint-disable-line @typescript-eslint/no-explicit-any
    const hits = scanner.scan(recordFields(b));
    if (hits.length === 0) return dry ? reply(200, { would_reject: false, hits: [], secret_rules: { version: mockRules.version, sha: mockRulesSha } }) : null;
    const onSecret = b.on_secret === 'quarantine' && b.change === 'save' ? 'quarantine' : 'reject';
    const action = decide(hits, onSecret).action;
    if (dry) return reply(200, { would_reject: action === 'reject', hits, secret_rules: { version: mockRules.version, sha: mockRulesSha } });
    if (action === 'quarantine') return 'quarantine';
    return problemOf(c, 422, 'secret_detected', { hits, stored: false });
  }

  const marker = (title: unknown) => (/^\[mock:(spool|held|fail)\]/.exec(String(title ?? '')) ?? [])[1] as 'spool' | 'held' | 'fail' | undefined;
  const refOf = (effKey: string) => `w-${sha256(effKey).slice(0, 24)}`;

  /** Applies a write now, or queues it behind a `write_ref` when the title says so. */
  function commit(effKey: string, entry: Omit<Idem, 'status' | 'response'>, mark: ReturnType<typeof marker>, apply: () => number, copy: Record<string, unknown>): Response {
    const base = { id: entry.id, payload_sha: entry.payloadSha, generated_by: entry.generatedBy };
    if (mark) {
      const ref = refOf(effKey);
      spools.set(ref, { ref, id: entry.id, polls: 0, end: mark === 'fail' ? 'failed' : 'committed', apply, version: null, state: 'pending', copy, payloadSha: entry.payloadSha });
      const response = result({ ...base, projected: false, spooled: mark !== 'held', held: mark === 'held', write_ref: ref, reason: mark === 'held' ? 'offsite_path_missing' : 'gate_timeout' });
      idem.set(effKey, { ...entry, status: 202, response });
      return reply(202, response);
    }
    const version = apply();
    const response = result({ ...base, version, seq: ++seq });
    const status = entry.kind === 'create' ? 201 : 200;
    idem.set(effKey, { ...entry, status, response });
    return reply(status, response);
  }

  // ---- POST /v1/records
  app.post('/v1/records', async (c) => {
    const g = gate(c, 'editor'); if (g instanceof Response) return g;
    const rq = await readRequest(c, true); if (rq instanceof Response) return rq;
    const { body: b, dry } = rq;
    const r = b.record;
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some((k) => FORBIDDEN.includes(k) || !RECORD_KEYS.has(k))) return problemOf(c, 400, 'schema_invalid');
    if (typeof r.title !== 'string' || r.title.length < 1 || r.title.length > 300 || typeof r.body !== 'string') return problemOf(c, 400, 'schema_invalid');
    if (Buffer.byteLength(r.body) > 1024 * 1024) return problemOf(c, 413, 'body_too_large');
    if (!TYPES.has(r.type)) return problemOf(c, 403, 'type_not_allowed');
    if (r.sensitivity === 'secret') return problemOf(c, 403, 'sensitivity_not_allowed');
    if (r.sensitivity !== undefined && !SENS.includes(r.sensitivity)) return problemOf(c, 400, 'schema_invalid');
    const sensitivity: string = r.sensitivity ?? 'private';
    if (sensitivity === 'private' && w.privateOpen === false) return problemOf(c, 403, 'sensitivity_not_allowed');
    const s = secrets(c, b, dry); if (s instanceof Response) return s;
    if (dry) return reply(200, { would_reject: false, hits: [], secret_rules: { version: mockRules.version, sha: mockRulesSha } });

    const effKey = `h\0${ACTOR}\0${b.idempotency_key}`;
    const id = deriveId(ACTOR, b.idempotency_key);
    const generatedBy = `${ACTOR}:${b.change}`;
    const payloadSha = shaOf({ ...r, sensitivity: s === 'quarantine' ? 'secret' : sensitivity });
    const known = idem.get(effKey);
    if (known) {
      // The first answer stands, but the target is looked at again: a quarantined or hidden record is a plain 404 (5.1).
      const rec = records.get(known.id);
      const pending = spools.get(known.response.write_ref as string);
      if (!pending && !visible(rec)) return problemOf(c, 404, 'not_found');
      if (known.payloadSha === payloadSha && known.generatedBy === generatedBy) return reply(known.status, { ...known.response, replayed: true });
      return rec ? problemOf(c, 409, 'version_conflict', { current: current(rec) }) : problemOf(c, 409, 'idem_conflict');
    }
    const quarantined = s === 'quarantine';
    const apply = () => {
      const rec: Rec = { type: r.type, sensitivity: quarantined ? 'secret' : sensitivity, hidden: quarantined, versions: [] };
      rec.versions.push({ version: 1, status: 'active', payloadSha, record: { ...r, sensitivity: rec.sensitivity }, generatedBy, recordedAt: new Date().toISOString() });
      records.set(id, rec);
      return 1;
    };
    const entry = { kind: 'create' as const, id, payloadSha, expected: null, generatedBy };
    if (!quarantined) return commit(effKey, entry, marker(r.title), apply, { id, record: r });
    // Quarantine is a plain 201 that says so. The stored answer is the one that carries it; the record is hidden from now on.
    apply();
    const rules = [...new Set(scanner.scan(recordFields(b)).map((h) => h.rule))].join(',');
    const response = result({ id, version: 1, seq: ++seq, payload_sha: payloadSha, generated_by: generatedBy, quarantined: true, sensitivity: 'secret', warnings: [`secret_detected:${rules}`] });
    idem.set(effKey, { ...entry, status: 201, response });
    return reply(201, response);
  });

  // ---- PUT /v1/records/:id
  app.put('/v1/records/:id', async (c) => {
    const g = gate(c, 'editor'); if (g instanceof Response) return g;
    const rq = await readRequest(c, true); if (rq instanceof Response) return rq;
    const { body: b, dry } = rq;
    const r = b.record;
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some((k) => FORBIDDEN.includes(k) || !RECORD_KEYS.has(k))) return problemOf(c, 400, 'schema_invalid');
    if (typeof r.title !== 'string' || r.title.length < 1 || r.title.length > 300 || typeof r.body !== 'string') return problemOf(c, 400, 'schema_invalid');
    if (r.id !== undefined && r.id !== c.req.param('id')) return problemOf(c, 400, 'schema_invalid');
    if (Buffer.byteLength(r.body) > 1024 * 1024) return problemOf(c, 413, 'body_too_large');
    if (r.sensitivity === 'secret') return problemOf(c, 403, 'sensitivity_not_allowed');
    if (r.sensitivity !== undefined && !SENS.includes(r.sensitivity)) return problemOf(c, 400, 'schema_invalid');
    const s = secrets(c, b, dry); if (s instanceof Response) return s;
    // A PUT never quarantines: the quarantine choice is a create (7.4 shows it on POST /v1/records).
    if (s === 'quarantine') return problemOf(c, 422, 'secret_detected', { hits: scanner.scan(recordFields(b)), stored: false });
    const id = c.req.param('id');
    const rec = records.get(id);
    const effKey = `h\0${ACTOR}\0${b.idempotency_key}`;
    const expected = b.expected_version ?? r.expected_version;
    const generatedBy = `${ACTOR}:${b.change}`;
    const known = idem.get(effKey);
    if (known && !dry) {
      if (known.id !== id || !visible(rec) && !spools.has(known.response.write_ref as string)) return problemOf(c, 404, 'not_found');
      const sha = shaOf({ ...r, sensitivity: r.sensitivity ?? rec?.sensitivity });
      if (known.payloadSha === sha && known.expected === expected && known.generatedBy === generatedBy) return reply(known.status, { ...known.response, replayed: true });
      return problemOf(c, 409, 'idem_conflict');
    }
    if (!visible(rec)) return problemOf(c, 404, 'not_found');
    if (expected === undefined) return problemOf(c, 428, 'expected_version_required');
    if (!Number.isInteger(expected)) return problemOf(c, 400, 'schema_invalid');
    const sens = r.sensitivity ?? rec.sensitivity;
    if (SENS.indexOf(sens) < SENS.indexOf(rec.sensitivity)) return problemOf(c, 403, 'declassify_requires_review');
    const h = head(rec);
    if (expected !== h.version) return problemOf(c, 409, 'version_conflict', { current: current(rec) });
    const payloadSha = shaOf({ ...r, sensitivity: sens });
    if (dry) return reply(200, { would_reject: false, hits: [], secret_rules: { version: mockRules.version, sha: mockRulesSha } });
    if (h.status === 'active' && h.payloadSha === payloadSha) {
      const response = result({ id, version: h.version, unchanged: true, payload_sha: payloadSha, generated_by: generatedBy });
      idem.set(effKey, { kind: 'edit', id, payloadSha, expected, generatedBy, status: 200, response });
      return reply(200, response);
    }
    const apply = () => {
      const version = head(rec).version + 1;
      rec.sensitivity = sens;
      rec.versions.push({ version, status: 'active', payloadSha, record: { ...r, sensitivity: sens }, generatedBy, recordedAt: new Date().toISOString() });
      return version;
    };
    return commit(effKey, { kind: 'edit', id, payloadSha, expected, generatedBy }, marker(r.title), apply, { id, record: r });
  });

  // ---- POST /v1/records/:id/tombstone
  app.post('/v1/records/:id/tombstone', async (c) => {
    const g = gate(c, 'editor'); if (g instanceof Response) return g;
    const rq = await readRequest(c, false); if (rq instanceof Response) return rq;
    const { body: b } = rq;
    if (b.change !== 'save' || (b.reason !== undefined && (typeof b.reason !== 'string' || b.reason.length > 500))) return problemOf(c, 400, 'schema_invalid');
    const s = secrets(c, b, false);
    if (s instanceof Response) return s;
    if (s === 'quarantine') return problemOf(c, 422, 'secret_detected', { hits: scanner.scan(recordFields(b)), stored: false });
    const id = c.req.param('id');
    const rec = records.get(id);
    const effKey = `h\0${ACTOR}\0${b.idempotency_key}`;
    const generatedBy = `${ACTOR}:${b.change}`;
    const known = idem.get(effKey);
    if (known) {
      if (known.id !== id || !visible(rec)) return problemOf(c, 404, 'not_found');
      if (known.expected === b.expected_version) return reply(known.status, { ...known.response, replayed: true });
      return problemOf(c, 409, 'idem_conflict');
    }
    if (!visible(rec)) return problemOf(c, 404, 'not_found');
    if (b.expected_version === undefined) return problemOf(c, 428, 'expected_version_required');
    const h = head(rec);
    if (b.expected_version !== h.version || h.status === 'dead') return problemOf(c, 409, 'version_conflict', { current: current(rec) });
    const version = h.version + 1;
    rec.versions.push({ version, status: 'dead', payloadSha: h.payloadSha, record: h.record, generatedBy, recordedAt: new Date().toISOString() });
    const response = result({ id, version, seq: ++seq, payload_sha: h.payloadSha, generated_by: generatedBy });
    idem.set(effKey, { kind: 'tombstone', id, payloadSha: h.payloadSha, expected: b.expected_version, generatedBy, status: 200, response });
    return reply(200, response);
  });

  // ---- /v1/writes/:ref. A ref this file did not issue falls through, so the M0f fixtures keep answering their own refs.
  app.get('/v1/writes/:ref', async (c, next) => {
    const sp = spools.get(c.req.param('ref'));
    if (!sp) return next();
    const g = gate(c, 'any'); if (g instanceof Response) return g;
    // Only the token that issued the write reads it (ADR-0005 5.9): any other token gets the answer for a ref that does not exist.
    if (g.scope !== 'editor') return problemOf(c, 404, 'not_found');
    const q = new URL(c.req.url).searchParams;
    for (const k of q.keys()) if (k !== 'include') return problemOf(c, 400, 'bad_param');
    const include = q.get('include');
    if (include !== null && include !== 'body') return problemOf(c, 400, 'bad_param');
    if (sp.state === 'pending') {
      sp.polls += 1;
      if (sp.polls >= 2) { if (sp.end === 'committed') { sp.version = sp.apply(); sp.state = 'committed'; } else sp.state = 'failed'; }
    }
    if (include === 'body') {
      if (sp.state === 'purged') return problemOf(c, 410, 'content_removed');
      if (sp.state !== 'failed') return problemOf(c, 400, 'bad_param');
    }
    const data: Record<string, unknown> = { ref: sp.ref, state: sp.state, id: sp.id, version: sp.version, code: sp.state === 'failed' || sp.state === 'purged' && sp.end === 'failed' ? 'version_conflict' : null };
    if (include === 'body') { data.record = (sp.copy as { record: unknown }).record; data.payload_sha = sp.payloadSha; }
    return reply(200, { data });
  });
  app.delete('/v1/writes/:ref', (c) => {
    const g = gate(c, 'any'); if (g instanceof Response) return g;
    const sp = spools.get(c.req.param('ref'));
    if (!sp || g.scope !== 'editor') return problemOf(c, 404, 'not_found');
    if (sp.state === 'pending') return problemOf(c, 409, 'write_in_flight');
    if (sp.state === 'failed') sp.state = 'purged';
    return reply(200, { ref: sp.ref, state: sp.state });
  });

  // ---- paths of the table that M1 does not exercise. They check the scope, which is what the token tests need.
  const todo = (method: 'post', path: string, need: 'editor' | 'reviewer') => app[method](path, async (c) => {
    const g = gate(c, need); if (g instanceof Response) return g;
    return need === 'reviewer' ? reply(201, { mock: 'reviewer path; nothing is checked or stored' }) : problemOf(c, 501, 'not_implemented');
  });
  todo('post', '/v1/records/:id/promote', 'editor');
  todo('post', '/v1/topics/:spec/research', 'editor');
  todo('post', '/v1/topics/:spec/research/:run/stop', 'editor');
  for (const p of ['/v1/actions', '/v1/actions/challenge', '/v1/actions/:id/external-refine', '/v1/actions/:id/execute', '/v1/hitl/challenge', '/v1/hitl/:item/resolve', '/v1/reviewer/enroll']) todo('post', p, 'reviewer');
}
