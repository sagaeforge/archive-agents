// Units of the v2 login (design v2 6): session lifetimes, the break-glass delay schedule and hash, and the 6.3 check table.
import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPrivateJson, watchedJson, writePrivateJson } from '../server/auth/files.ts';
import { envelopeStore } from '../src/data/envelopeStore.ts';
import { FailureDelay, hashPassword, OPEN_MS, verifyPassword } from '../server/auth/breakglass.ts';
import { check, kindOf, loopbackAlias, originForHost } from '../server/auth/guard.ts';
import { createAuth, validOrigin } from '../server/auth/index.ts';
import { bearer, IDLE_MS, MAX_MS, Sessions } from '../server/auth/sessions.ts';

describe('sessions', () => {
  it('end after 1 h idle and after 12 h whatever the use, with no renewal', () => {
    let t = 0;
    const s = new Sessions(() => t);
    const a = s.issue('google');
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    t += IDLE_MS - 1; expect(s.touch(a)).toBe(true);
    t += IDLE_MS - 1; expect(s.touch(a)).toBe(true);
    t += IDLE_MS + 1; expect(s.touch(a)).toBe(false);
    expect(s.touch(a), 'a dead session stays dead').toBe(false);
    const b = s.issue('google');
    for (let i = 0; i < 13; i++) { t += IDLE_MS - 1; if (i < 12) expect(s.touch(b), `hour ${i}`).toBe(i * (IDLE_MS - 1) + IDLE_MS - 1 <= MAX_MS); }
    expect(s.touch(b)).toBe(false);
  });
  it('keep no token, only its digest, and refuse anything not shaped like one', () => {
    const s = new Sessions();
    const a = s.issue('google');
    expect(JSON.stringify([...(s as unknown as { map: Map<string, unknown> }).map.keys()])).not.toContain(a);
    expect(s.touch('x')).toBe(false); expect(s.touch(null)).toBe(false); expect(s.touch(`${a}x`)).toBe(false);
    s.revoke(a); expect(s.touch(a)).toBe(false);
    expect(bearer(`Bearer ${a}`)).toBe(a); expect(bearer(`bearer ${a}`)).toBeNull(); expect(bearer(undefined)).toBeNull();
  });
});

describe('break-glass', () => {
  it('four misses are free, then 30 s doubling to at most 5 min, never a permanent lock', () => {
    let t = 0;
    const d = new FailureDelay(() => t);
    const waits: number[] = [];
    for (let i = 0; i < 9; i++) { d.fail(); waits.push(d.waitS()); t += d.waitS() * 1000; }
    expect(waits).toEqual([0, 0, 0, 0, 30, 60, 120, 240, 300]);
    expect(d.waitS()).toBe(0);
    d.succeed(); d.fail(); expect(d.waitS()).toBe(0);
  });
  it('argon2id hash: verifies the password, refuses another, needs 12 characters', async () => {
    const h = await hashPassword('twelve chars!');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    expect(h).not.toContain('twelve');
    expect(await verifyPassword('twelve chars!', h)).toBe(true);
    expect(await verifyPassword('twelve chars?', h)).toBe(false);
    expect(await verifyPassword('twelve chars!', 'not a hash')).toBe(false);
    await expect(hashPassword('short')).rejects.toThrow(/12/);
  });
});

describe('the 6.3 checks', () => {
  const O = 'http://127.0.0.1:4812';
  const H = (h: Record<string, string>) => (n: string) => h[n];
  const base = { host: '127.0.0.1:4812' };
  it('classifies paths', () => {
    expect(kindOf('/kb/v1/meta', 'GET')).toBe('read');
    expect(kindOf('/kb-write/v1/x', 'POST')).toBe('post');
    expect(kindOf('/auth/google/start', 'POST')).toBe('post');
    expect(kindOf('/auth/status', 'GET')).toBe('read');
    expect(kindOf('/auth/google/callback', 'GET')).toBe('callback');
    expect(kindOf('/', 'GET')).toBe('static');
  });
  it('read: exact Host, Origin only if present and exact, same-origin Fetch Metadata only', () => {
    expect(check('read', 'GET', H(base), O)).toBeNull();
    expect(check('read', 'GET', H({ host: 'localhost:4812' }), O)?.code).toBe('host_rejected');
    expect(check('read', 'GET', H({ ...base, origin: 'http://localhost:4812' }), O)?.code).toBe('origin_rejected');
    expect(check('read', 'GET', H({ ...base, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }), O)?.code).toBe('cross_site_rejected');
    expect(check('read', 'GET', H({ ...base, 'sec-fetch-site': 'same-origin', origin: O }), O)).toBeNull();
  });
  it('post: Origin required, JSON, the marker of its path', () => {
    const ok = { ...base, origin: O, 'content-type': 'application/json; charset=utf-8', 'x-loupe-auth': '1' };
    expect(check('post', 'POST', H(ok), O, '/auth/google/start')).toBeNull();
    expect(check('post', 'POST', H({ ...ok, origin: '' }), O, '/auth/google/start')?.status).toBe(403);
    expect(check('post', 'POST', H({ ...ok, 'content-type': 'text/plain' }), O, '/auth/google/start')?.status).toBe(415);
    expect(check('post', 'POST', H(ok), O, '/kb-write/v1/x')?.code).toBe('marker_missing');
    expect(check('post', 'POST', H({ ...ok, 'x-loupe-write': '1' }), O, '/kb-write/v1/x')).toBeNull();
    expect(check('post', 'GET', H(ok), O, '/auth/lock')?.status).toBe(405);
  });
  it('callback: a top-level navigation only', () => {
    expect(check('callback', 'GET', H({ ...base, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', origin: 'https://accounts.google.com' }), O)).toBeNull();
    expect(check('callback', 'GET', H({ ...base, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }), O)?.code).toBe('not_navigation');
    expect(check('callback', 'GET', H(base), O)?.code).toBe('not_navigation');
  });
  it('127.0.0.1 and [::1] go to the allowlisted localhost origin of their port', () => {
    const L = 'http://localhost:4812';
    const list = [L, 'https://loupe.example.ts.net'];
    expect(loopbackAlias(H({ host: '127.0.0.1:4812' }), list)).toBe(L);
    expect(loopbackAlias(H({ host: '[::1]:4812' }), list)).toBe(L);
    expect(loopbackAlias(H({ host: 'localhost:4812' }), list), 'already the origin').toBeNull();
    expect(loopbackAlias(H({ host: '127.0.0.1:4810' }), list)).toBeNull();
    expect(loopbackAlias(H({ host: 'evil.example:4812' }), list)).toBeNull();
    expect(loopbackAlias(H({ host: '127.0.0.1:4812' }), ['https://loupe.example.ts.net'])).toBeNull();
  });
  it('the Host picks an allowlisted origin exactly, and only that origin passes the Origin check', () => {
    const list = [O, 'https://loupe.example.ts.net'];
    expect(originForHost('loupe.example.ts.net', list)).toBe('https://loupe.example.ts.net');
    expect(originForHost('127.0.0.1:4812', list)).toBe(O);
    expect(originForHost('loupe.example.ts.net:8443', list)).toBeNull();
    expect(originForHost('evil.example', list)).toBeNull();
    expect(originForHost(undefined, list)).toBeNull();
    const ts = 'https://loupe.example.ts.net';
    expect(check('read', 'GET', H({ host: 'loupe.example.ts.net', origin: ts }), ts)).toBeNull();
    expect(check('read', 'GET', H({ host: 'loupe.example.ts.net', origin: O }), ts)?.code).toBe('origin_rejected');
    expect(check('read', 'GET', H({ host: 'evil.example' }), null)?.code).toBe('host_rejected');
  });
});

describe('origin allowlist entries (owner-corrected 2026-11-04: Google web client rules)', () => {
  it('accepts http only on localhost and https on a host name; refuses the rest', () => {
    for (const ok of ['http://localhost:4812', 'https://loupe.example.ts.net', 'https://loupe.internal.example:8443']) expect(validOrigin(ok), ok).toBe(ok);
    for (const bad of ['http://127.0.0.1:4812', 'http://[::1]:4812', 'http://loupe.example.ts.net', 'https://100.64.0.1', 'https://[fd7a::1]', 'https://*.example.ts.net', 'https://loupe.example.ts.net/x', 'https://loupe.example.ts.net/#a', 'https://intranet', 'ftp://a.example', 42, 'https://u:p@a.example'])
      expect(validOrigin(bad), String(bad)).toBeNull();
  });
});

describe('session renewal (Codex review 4)', () => {
  it('a touch without renew checks the session but does not restart its idle clock', () => {
    let t = 0;
    const s = new Sessions(() => t, 1000);
    const a = s.issue('google');
    t = 600; expect(s.touch(a, false)).toBe(true);
    t = 1001; expect(s.touch(a, false)).toBe(false);
    const b = s.issue('google');
    t = 1600; expect(s.touch(b, true)).toBe(true);
    t = 2500; expect(s.touch(b, false)).toBe(true);
  });
});

describe('config files (Codex review 5)', () => {
  const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'loupe-files-'));
  it('writes mode 600 through an exclusive temporary file and leaves no temporary behind', () => {
    const d = tmp();
    try {
      writePrivateJson(path.join(d, 'a.json'), { x: 1 });
      expect(statSync(path.join(d, 'a.json')).mode & 0o777).toBe(0o600);
      expect(readdirSync(d)).toEqual(['a.json']);
      expect(readPrivateJson(path.join(d, 'a.json'))).toEqual({ x: 1 });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it('refuses a directory others can write to, for reading and for writing', () => {
    const d = tmp();
    try {
      writePrivateJson(path.join(d, 'a.json'), { x: 1 });
      chmodSync(d, 0o770);
      expect(() => readPrivateJson(path.join(d, 'a.json'))).toThrow(/mode/);
      expect(() => writePrivateJson(path.join(d, 'b.json'), { x: 2 })).toThrow(/mode/);
      expect(readdirSync(d)).toEqual(['a.json']);
      const w = watchedJson(path.join(d, 'a.json'));
      expect(w().problem?.reason).toBe('mode');
      chmodSync(d, 0o700);
      expect(w().value, 'the directory is part of the cache key').toEqual({ x: 1 });
    } finally { chmodSync(d, 0o700); rmSync(d, { recursive: true, force: true }); }
  });
  it('does not follow a symlink, even to a private file of the same user', () => {
    const d = tmp();
    try {
      mkdirSync(path.join(d, 'real'), { mode: 0o700 });
      writePrivateJson(path.join(d, 'real', 'secret.json'), { s: 1 });
      symlinkSync(path.join(d, 'real', 'secret.json'), path.join(d, 'auth.json'));
      expect(() => readPrivateJson(path.join(d, 'auth.json'))).toThrow(/invalid/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it('refuses a group-readable file without reading it', () => {
    const d = tmp();
    try {
      writeFileSync(path.join(d, 'a.json'), '{}'); chmodSync(path.join(d, 'a.json'), 0o640);
      expect(() => readPrivateJson(path.join(d, 'a.json'))).toThrow(/mode/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('degraded in the header (states.spec finding)', () => {
  const env = (degraded: string[]) => ({ schema_version: '0.3.0', epoch: 1, build_id: 'g', data_as_of: 'x', applied_seq: 1, as_of: {}, degraded });
  it('comes from /v1/meta only, whatever envelope arrives after it', () => {
    envelopeStore.reset();
    envelopeStore.update(env([]), 1, false);
    envelopeStore.update(env(['boot_path_unverified']), 2, true);
    envelopeStore.update(env([]), 3, false);
    expect(envelopeStore.get().meta?.degraded).toEqual(['boot_path_unverified']);
    envelopeStore.update(env([]), 4, true);
    expect(envelopeStore.get().meta?.degraded).toEqual([]);
    envelopeStore.reset();
  });
});

describe('temporary file of a write (Codex re-review D)', () => {
  it('refuses a file or a link already at the temporary path, and changes neither', () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'loupe-excl-'));
    try {
      writeFileSync(path.join(d, 'planted.tmp'), 'planted'); chmodSync(path.join(d, 'planted.tmp'), 0o600);
      expect(() => writePrivateJson(path.join(d, 'auth.json'), { sub: 'x' }, 'planted.tmp')).toThrow(/EEXIST/);
      expect(readFileSync(path.join(d, 'planted.tmp'), 'utf8')).toBe('planted');
      writeFileSync(path.join(d, 'elsewhere'), 'untouched');
      symlinkSync(path.join(d, 'elsewhere'), path.join(d, 'link.tmp'));
      expect(() => writePrivateJson(path.join(d, 'auth.json'), { sub: 'x' }, 'link.tmp')).toThrow(/EEXIST|ELOOP/);
      expect(readFileSync(path.join(d, 'elsewhere'), 'utf8')).toBe('untouched');
      expect(readlinkSync(path.join(d, 'link.tmp'))).toBe(path.join(d, 'elsewhere'));
      expect(readdirSync(d).includes('auth.json')).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('break-glass state is checked again after Argon2 (Codex re-review A)', () => {
  const ORIGIN = 'http://localhost:4812';
  const PW = 'correct horse battery';
  async function setupAuth(during: (dir: string, clock: { t: number }) => void) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'loupe-bg-'));
    const clock = { t: 1_000_000 };
    writePrivateJson(path.join(dir, 'google-oauth.json'), { client_id: 'c.apps.example', client_secret: 'placeholder' });
    writePrivateJson(path.join(dir, 'auth.json'), { sub: 'owner', breakglass: await hashPassword(PW) });
    writePrivateJson(path.join(dir, 'breakglass-open.json'), { until: clock.t + OPEN_MS });
    const auth = createAuth({
      dir, port: 4812, now: () => clock.t, log: () => undefined,
      verify: async (pw, phc) => { const ok = await verifyPassword(pw, phc); during(dir, clock); return ok; },
    });
    const attempt = () => auth.handle(new Request(`${ORIGIN}/auth/breakglass`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) }), '/auth/breakglass', ORIGIN);
    return { dir, attempt };
  }
  it('a right password with nothing changed signs in (control)', async () => {
    const { dir, attempt } = await setupAuth(() => undefined);
    try { expect((await attempt()).status).toBe(200); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('an opening that expires during the check gives no session', async () => {
    const { dir, attempt } = await setupAuth((_d, clock) => { clock.t += OPEN_MS + 1; });
    try { const r = await attempt(); expect(r.status).toBe(404); expect(await r.text()).not.toContain('session'); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('a new break-glass hash or a new account during the check gives no session', async () => {
    for (const change of [{ breakglass: '$argon2id$v=19$m=65536,t=3,p=4$BBBBBBBBBBBBBBBBBBBBBB$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }, { sub: 'someone-else' }]) {
      const { dir, attempt } = await setupAuth((d) => {
        const cur = JSON.parse(readFileSync(path.join(d, 'auth.json'), 'utf8')) as Record<string, string>;
        writePrivateJson(path.join(d, 'auth.json'), { ...cur, ...change, pad: 'x'.repeat(10) });
      });
      try { expect((await attempt()).status, JSON.stringify(Object.keys(change))).toBe(404); } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
});
