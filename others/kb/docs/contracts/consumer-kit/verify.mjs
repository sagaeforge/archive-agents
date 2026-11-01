// 사용: node verify.mjs [--contract <docs/contracts 폴더>]   (기본: 이 폴더의 부모)
// Node 26. 의존성은 ajv, yaml 둘이다(package-lock.json으로 고정). 스키마 검증을 손수 만들지 않는다.
//
// 확인하는 것
//  1. openapi.yaml을 ajv(2020-12, discriminator: true)로 컴파일한다.
//  2. fixture의 모든 응답이 해당 경로와 상태 코드의 응답 스키마를 통과한다.
//  3. 인용 위치: 코드포인트 오프셋을 UTF-16 오프셋으로 바꿔 자르면 exact와 정확히 일치한다.
//  4. export(zstd)를 풀고 매니페스트의 해시, 노드 수와 맞춘다.
//  5. fixture를 Unix 소켓 위의 가짜 서버로 내보내고 examples/unix-socket.mjs의 클라이언트로 다시 받아 같은지 본다.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import YAML from 'yaml';
import { sliceByCodepoints, cpToUtf16, codepointLength } from './lib/offsets.mjs';
import { kbGet } from './examples/unix-socket.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argi = process.argv.indexOf('--contract');
const contract = path.resolve(argi > 0 ? process.argv[argi + 1] : path.join(here, '..'));
const fixDir = path.join(contract, 'fixtures');

const failures = [];
const notes = [];
let checks = 0;
function check(name, fn) {
  checks += 1;
  try {
    fn();
  } catch (e) {
    failures.push(`${name}: ${String(e.message ?? e).split('\n')[0].slice(0, 300)}`);
  }
}
async function checkAsync(name, fn) {
  checks += 1;
  try {
    await fn();
  } catch (e) {
    failures.push(`${name}: ${String(e.message ?? e).split('\n')[0].slice(0, 300)}`);
  }
}

// ------------------------------------------------------------------ 읽기
const doc = YAML.parse(fs.readFileSync(path.join(contract, 'openapi.yaml'), 'utf8'));
const req = YAML.parse(fs.readFileSync(path.join(fixDir, 'requests.yaml'), 'utf8'));
const stored = new Map();
for (const c of req.cases) stored.set(c.id, JSON.parse(fs.readFileSync(path.join(fixDir, 'responses', `${c.id}.json`), 'utf8')));
console.log(`계약 ${doc.info.version}, fixture 사례 ${req.cases.length}개, 경로 ${Object.keys(doc.paths).length}개`);
assert.equal(req.meta.contract_version, doc.info.version, 'fixture가 만든 계약 판과 openapi.yaml 판이 다르다');
assert.equal(req.meta.synthetic, true);

// ------------------------------------------------------------------ 1. ajv 컴파일
// OpenAPI 3.1 스키마 객체는 JSON Schema 2020-12다. 문서 전체를 한 스키마 자원으로 올리고 JSON 포인터로 부분 스키마를 컴파일한다.
// strict: false는 x-* 확장과 example 같은 OpenAPI 전용 키워드를 허용하기 위해서다. validateFormats: false는 ajv-formats를 쓰지 않기 때문이다(date-time 등 형식 검사는 하지 않는다).
const ajv = new Ajv2020({ discriminator: true, strict: false, allErrors: true, validateFormats: false });
ajv.addSchema({ ...doc, $id: 'kb-contract' });
const ptr = (...segs) => 'kb-contract#/' + segs.map((s) => encodeURIComponent(String(s).replace(/~/g, '~0').replace(/\//g, '~1'))).join('/');

const discriminated = Object.entries(doc.components.schemas).filter(([, s]) => JSON.stringify(s).includes('"discriminator"')).map(([n]) => n);
check('discriminator 스키마가 있다', () => assert.ok(discriminated.length >= 1, 'discriminator를 쓰는 컴포넌트가 없다'));
for (const name of discriminated) {
  check(`discriminator 컴파일: ${name}`, () => assert.ok(ajv.getSchema(ptr('components', 'schemas', name)), '컴파일 실패'));
}
console.log(`discriminator 컴파일 성공: ${discriminated.join(', ')}`);

function responseDef(template, status) {
  let r = doc.paths[template].get.responses[String(status)];
  if (!r) return null;
  let base = ['paths', template, 'get', 'responses', String(status)];
  if (r.$ref) {
    const name = r.$ref.split('/').pop();
    r = doc.components.responses[name];
    base = ['components', 'responses', name];
  }
  return { r, base };
}
const templates = Object.keys(doc.paths).map((t) => ({ t, rx: new RegExp('^' + t.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+') + '$') }));
const templateOf = (p) => templates.find((x) => x.rx.test(p.split('?')[0]))?.t ?? assert.fail(`계약에 없는 경로: ${p}`);

// ------------------------------------------------------------------ 2. 응답 검증
let validated = 0;
for (const c of req.cases) {
  if ((c.method ?? 'GET') !== 'GET' || c.status === 403 || c.status === 405) continue; // 경로 밖 계층의 응답
  const s = stored.get(c.id);
  check(`응답 스키마: ${c.id}`, () => {
    const t = templateOf(c.path);
    const def = responseDef(t, s.status);
    assert.ok(def, `${t}에 ${s.status} 응답 선언이 없다`);
    if (s.status === 304) return assert.equal(s.body ?? null, null);
    const ct = s.headers['content-type'].split(';')[0];
    let media = def.r.content?.[ct];
    if (!media && t.endsWith('/raw') && [200, 206].includes(s.status)) {
      media = def.r.content['application/octet-stream'];
      if (!notes.includes('raw: 선언은 application/octet-stream뿐인데 응답은 원 Content-Type을 그대로 준다')) notes.push('raw: 선언은 application/octet-stream뿐인데 응답은 원 Content-Type을 그대로 준다');
    }
    assert.ok(media, `Content-Type ${ct}가 선언에 없다`);
    if (s.body_base64 !== undefined) return;
    const v = ajv.getSchema(ptr(...def.base, 'content', ct in def.r.content ? ct : 'application/octet-stream', 'schema'));
    assert.ok(v, '스키마 컴파일 실패');
    if (!v(s.body)) throw new Error(`${JSON.stringify(v.errors[0])}`);
    validated += 1;
  });
}
console.log(`스키마 통과한 JSON 응답: ${validated}개`);

// 음성 확인: discriminator가 실제로 걸려 있다(kind를 망가뜨리면 실패해야 한다)
check('discriminator가 걸려 있다', () => {
  const ok = stored.get('search-ok').body;
  const v = ajv.getSchema(ptr('paths', '/v1/search', 'get', 'responses', '200', 'content', 'application/json', 'schema'));
  assert.ok(v(ok), '원본이 통과해야 한다');
  const bad = structuredClone(ok);
  bad.data.items[0].kind = 'nonesuch';
  assert.ok(!v(bad), 'kind가 틀린 항목이 통과했다');
});

// ------------------------------------------------------------------ 3. 인용 위치
const snapshotText = new Map();
for (const c of req.cases) {
  const m = c.path.match(/^\/v1\/snapshots\/([^/?]+)\/text$/);
  if (m && c.status === 200) {
    const d = stored.get(c.id).body.data;
    if (d.start === 0 && d.end === d.total_chars) snapshotText.set(m[1], d.text);
  }
}
let offsetChecks = 0;
let mismatchDemo = 0;
for (const c of req.cases) {
  const body = stored.get(c.id).body;
  const evs = body?.data?.evidence;
  if (!Array.isArray(evs)) continue;
  for (const ev of evs) {
    const text = snapshotText.get(ev.snapshot_id);
    if (text === undefined || ev.start == null) continue;
    check(`인용 위치: ${c.id}`, () => {
      assert.equal(sliceByCodepoints(text, ev.start, ev.end), ev.exact);
      assert.equal(ev.end - ev.start, codepointLength(ev.exact));
      const naive = text.slice(ev.start, ev.end) !== ev.exact; // 코드포인트 오프셋을 그대로 쓰면 어긋나는 사례
      if (naive) mismatchDemo += 1;
      offsetChecks += 1;
    });
  }
}
check('인용 위치 사례가 충분하다', () => assert.ok(offsetChecks >= 2, `인용 사례 ${offsetChecks}개`));
check('이모지 뒤 인용은 코드포인트와 UTF-16 오프셋이 다르다', () => assert.ok(mismatchDemo >= 1, '순진한 slice가 어긋나는 사례가 없다'));
check('NFD 입력은 NFC와 다르다', () => {
  const ev = stored.get('node-claim-evidence-nfd').body.data.evidence[0];
  assert.notEqual(ev.exact, ev.exact.normalize('NFC'));
  assert.equal(ev.exact, ev.exact.normalize('NFD'));
  assert.equal(cpToUtf16(snapshotText.get(ev.snapshot_id), ev.start), ev.start); // BMP만이라 같다
});
console.log(`인용 위치 일치: ${offsetChecks}개, 순진한 slice가 어긋나는 사례: ${mismatchDemo}개`);

// ------------------------------------------------------------------ 4. export
const manifest = stored.get('export-manifest-ok').body.data;
for (const prof of ['core', 'full']) {
  check(`export 해제: ${prof}`, () => {
    const s = stored.get(`export-${prof}`);
    assert.equal(s.headers['content-type'], 'application/zstd');
    const raw = Buffer.from(s.body_base64, 'base64');
    assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), manifest.profiles[prof].sha256);
    assert.equal(raw.length, manifest.profiles[prof].bytes);
    const g = JSON.parse(zlib.zstdDecompressSync(raw).toString('utf8'));
    assert.equal(g.nodes.rows.length, manifest.profiles[prof].nodes);
    assert.equal(g.edges.rows.length, manifest.profiles[prof].edges);
    assert.equal(g.applied_seq, manifest.applied_seq);
  });
}

// ------------------------------------------------------------------ 5. Unix 소켓 위에서 다시 받기
const sockDir = fs.mkdtempSync(path.join(process.env.KB_TMP ?? os.tmpdir(), 'kbkit-'));
const sock = path.join(sockDir, 'read.sock');
const key = (url, inm, range) => `${url}\n${inm ?? ''}\n${range ?? ''}`;
const table = new Map();
for (const c of req.cases) {
  if ((c.method ?? 'GET') !== 'GET' || c.headers?.Host) continue;
  table.set(key(c.path, c.headers?.['If-None-Match'], c.headers?.Range), stored.get(c.id));
}
const server = http.createServer((rq, rs) => {
  const hit = table.get(key(rq.url, rq.headers['if-none-match'], rq.headers.range));
  if (!hit) {
    rs.writeHead(599).end(`fixture에 없는 요청: ${rq.url}`);
    return;
  }
  const body = hit.body_base64 !== undefined ? Buffer.from(hit.body_base64, 'base64') : hit.body == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(hit.body));
  rs.writeHead(hit.status, hit.headers).end(body);
});
await new Promise((res) => server.listen(sock, res));
let replayed = 0;
try {
  for (const c of req.cases) {
    if ((c.method ?? 'GET') !== 'GET' || c.headers?.Host) continue;
    await checkAsync(`소켓 재생: ${c.id}`, async () => {
      const hdr = {};
      if (c.headers?.['If-None-Match']) hdr['If-None-Match'] = c.headers['If-None-Match'];
      if (c.headers?.Range) hdr.Range = c.headers.Range;
      const r = await kbGet(sock, c.path, hdr);
      const want = stored.get(c.id);
      assert.equal(r.status, want.status);
      for (const h of ['etag', 'cache-control', 'content-type']) if (want.headers[h]) assert.equal(r.headers[h], want.headers[h]);
      if (want.body_base64 !== undefined) assert.equal(r.body.toString('base64'), want.body_base64);
      else if (want.body != null) assert.deepEqual(JSON.parse(r.body.toString('utf8')), want.body);
      else assert.equal(r.body.length, 0);
      replayed += 1;
    });
  }
} finally {
  await new Promise((res) => server.close(res));
  fs.rmSync(sockDir, { recursive: true, force: true });
}
console.log(`소켓 재생 일치: ${replayed}개`);

// ------------------------------------------------------------------ 결과
for (const n of notes) console.log(`참고: ${n}`);
if (failures.length) {
  console.error(`\n실패 ${failures.length}건 / 검사 ${checks}건`);
  for (const f of failures.slice(0, 30)) console.error(' - ' + f);
  process.exit(1);
}
console.log(`\nverify OK: 검사 ${checks}건, 실패 0건 (Node ${process.versions.node}, ajv ${ajv.constructor.name})`);
