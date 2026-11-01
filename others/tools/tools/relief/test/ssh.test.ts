// Design 1, 7.1, 19: the SSH copy button builds one allowlisted line, adds no route that acts, and spawns nothing.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEdge } from '../server/collect/edge.ts';
import { createApi } from '../server/app.ts';
import type { Entity, Fact } from '../server/model/fact.ts';
import { overlayEdge } from '../server/model/edgemap.ts';
import { isDottedV4, sshLine, sshOffer } from '../server/model/ssh.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const obs = <T>(value: T): Fact<T> => ({ value, basis: 'observed', source: 'x', at: '2026-11-01T09:00:00.000Z', ttlS: 45 });
const guest = (ips: unknown, user?: unknown, extra: Partial<Entity> = {}): Entity => ({ id: 'pve:qemu:100', kind: 'vm', title: 'g', basis: 'observed', state: 'running',
  facts: { ip: obs(ips), ...(user === undefined ? {} : { sshUser: { value: user, basis: 'declared', source: 'edge.json#/guests/0', at: '2026-11-01', ttlS: null } as Fact<unknown> }) }, ...extra });
const node = (title: string, extra: Partial<Entity> = {}): Entity => ({ id: `pve:node:${title}`, kind: 'node', title: `노드 ${title}`, basis: 'observed', state: 'ok', facts: {}, ...extra });

const HOSTILE = ['-oProxyCommand=x', '-v', 'a;b', 'a&&b', 'a|b', '$(x)', '`x`', 'a b', 'a\nb', 'a\tb', 'a\rb', 'ok\n', "a'b", 'a"b', 'a\\b', 'a>b', 'a<b', 'a*b', 'a#b', 'a!b', 'a{b}', 'a~b', 'a=b', 'a:b', 'a@b', 'a/b',
  'ｘ', 'ехаmple', 'ａdmin', 'a​b', 'a‮b', '日本', '', '.a', '_a', '-', 'a'.repeat(64),
  '192.0.2.1%eth0', '192.0.2.1%25', '192.0.2.1:22', '192.0.2.1/24', '192.0.2.256', '010.0.0.1', '192.0.2.1 ', '[::1]', '::1', 'fe80::1%eth0', '１９２.０.２.１'];

// What the button would do with no rule at all: the line is just the text. It must differ from the real one for every hostile value.
const naive = (t: string, u?: string) => `ssh ${u ? `${u}@` : ''}${t}`;

describe('the allowlist', () => {
  it.each(HOSTILE)('gives no command for target %j, and the naive line would have been one', (t) => {
    expect(naive(t)).toMatch(/^ssh /);
    expect(sshLine(t)).toBeNull();
    expect(sshOffer(node(t))).toMatchObject({ why: expect.any(String) });
    expect(sshOffer(guest([t]))).toMatchObject({ why: expect.any(String) });
  });
  it.each(['-oProxyCommand=x', 'a;b', '$(x)', '`x`', 'a b', 'a\nb', "a'b", 'a"b', 'Root', 'root ', '1root', '-r', 'r'.repeat(33), 'ｒoot', 'root\n', 'a@b', ''])('gives no command for user %j', (u) => {
    expect(naive('192.0.2.5', u)).toMatch(/^ssh /);
    expect(sshLine('192.0.2.5', u)).toBeNull();
    expect(sshOffer(guest(['192.0.2.5'], u))).toMatchObject({ why: expect.any(String) });
  });
  it('builds the three lines and only those', () => {
    expect(sshLine('node-1')).toBe('ssh node-1');
    expect(sshLine('192.0.2.5')).toBe('ssh 192.0.2.5');
    expect(sshLine('192.0.2.5', 'ops')).toBe('ssh ops@192.0.2.5');
    expect(sshLine('a'.repeat(63))).toBe(`ssh ${'a'.repeat(63)}`);
    expect(sshLine('9node.lab_1-x')).toBe('ssh 9node.lab_1-x');
  });
  it('every line is exactly one line with no shell metacharacter and no leading dash in its parts', () => {
    for (const t of [...HOSTILE, 'node-1', '192.0.2.5']) for (const u of [undefined, 'ops', 'x;y']) {
      const c = sshLine(t, u);
      if (c === null) continue;
      expect(c).toMatch(/^ssh (?:[a-z_][a-z0-9_-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/);
    }
  });
  it('a guest takes its first usable observed IPv4; a hostile entry before it is skipped, not trusted', () => {
    expect(sshOffer(guest(['fe80::1', '-oProxyCommand=x', '127.0.0.1', '169.254.1.1', '192.0.2.9', '192.0.2.10']))).toEqual({ command: 'ssh 192.0.2.9' });
    expect(sshOffer(guest(['192.0.2.9'], 'ops'))).toEqual({ command: 'ssh ops@192.0.2.9' });
  });
  it('says why when there is nothing to connect to', () => {
    const unk: Fact<never> = { value: null, basis: 'unknown', source: 'x', at: null, ttlS: null, why: 'guest agent 응답 없음' };
    expect(sshOffer({ ...guest([]), facts: { ip: unk } })).toEqual({ why: 'guest agent 응답 없음' });
    expect(sshOffer(guest(['fe80::1']))).toEqual({ why: '쓸 수 있는 IPv4가 없다' });
    expect(sshOffer(guest(['192.0.2.9'], undefined, { gone: true }))).toMatchObject({ why: expect.any(String) });
    expect(sshOffer(node('node-1', { basis: 'declared' }))).toMatchObject({ why: expect.any(String) });
    expect(sshOffer({ ...node('x'), kind: 'bridge' })).toBeNull();
  });
  it('isDottedV4 refuses what ssh would read differently', () => {
    for (const a of ['010.0.0.1', '1.2.3', '0x7f.0.0.1', '1.2.3.4.5', ' 1.2.3.4', '1.2.3.4\n', '1.2.3.4%a', 1, null]) expect(isDottedV4(a)).toBe(false);
    expect(isDottedV4('203.0.113.7')).toBe(true);
  });
});

describe('guests in edge.json', () => {
  const file = (guests: unknown) => ({ schema: 1, declaredAt: '2026-11-01', guests });
  it('takes a vmid and a user and nothing else', () => {
    expect(parseEdge(JSON.stringify(file([{ key: 'g100', vmid: 100, sshUser: 'ops' }]))).kind).toBe('ok');
    for (const g of [{ key: 'g', vmid: 100, sshUser: 'ops', sshKey: 'x' }, { key: 'g', vmid: 100, sshUser: 'ops', port: 22 }, { key: 'g', vmid: 100, sshUser: '-oProxyCommand=x' }, { key: 'g', vmid: 100, sshUser: 'a b' }, { key: 'g', vmid: 100, sshUser: 'Root' }, { key: 'g', vmid: 0, sshUser: 'ops' }, { key: 'g', vmid: 1.5, sshUser: 'ops' }, { key: 'g', sshUser: 'ops' }]) {
      expect(parseEdge(JSON.stringify(file([g]))).kind).toBe('bad');
    }
    expect(parseEdge(JSON.stringify(file([{ key: 'g', vmid: 1, sshUser: 'a' }, { key: 'g', vmid: 2, sshUser: 'b' }]))).kind).toBe('bad');
  });
  it('the declared user lands on the observed guest only, and becomes part of the line', () => {
    const r = parseEdge(JSON.stringify(file([{ key: 'g100', vmid: 100, sshUser: 'ops' }, { key: 'g999', vmid: 999, sshUser: 'ops' }])));
    if (r.kind !== 'ok') throw new Error('bad');
    const g = guest(['192.0.2.9']);
    const out = { nodes: [g], edges: [] };
    overlayEdge(out, { edge: r.file, wan: null, wanOff: true, local: null }, Date.parse('2026-11-02T00:00:00Z'));
    expect(g.facts.sshUser).toMatchObject({ value: 'ops', basis: 'declared' });
    expect(sshOffer(g)).toEqual({ command: 'ssh ops@192.0.2.9' });
    expect(out.nodes).toHaveLength(1);
  });
});

describe('copy only', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
  const server = files(join(root, 'server'));
  it('registers no route that is not GET, and the catch-all answers 404', async () => {
    for (const f of server) expect(readFileSync(f, 'utf8'), f).not.toMatch(/\b(app|api|router|hono|server)\.(post|put|patch|delete|options|on)\s*\(/);
    const gets = [...readFileSync(join(root, 'server/app.ts'), 'utf8').matchAll(/app\.get\('([^']+)'/g)].map((m) => m[1]);
    expect(gets).toEqual(['/api/snapshot', '/api/metrics', '/api/status']);
    const app = createApi();
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect((await app.request('/api/ssh', { method: m, headers: { host: '127.0.0.1:4815' } })).status).not.toBe(200);
  });
  it('the server source does not spawn ssh; the one process it starts is the Chrome window opener', () => {
    for (const f of server) {
      const src = readFileSync(f, 'utf8');
      if (f.endsWith('server/open.ts')) expect(src).not.toMatch(/\bssh\b/);
      else expect(src, f).not.toMatch(/child_process|node:child/);
      if (!f.endsWith('model/ssh.ts')) expect(src, f).not.toMatch(/['"`]ssh['"`]/);
    }
  });
  it('the browser side builds a line and copies it; it opens no connection', () => {
    const ui = readFileSync(join(root, 'src/ui/ssh.tsx'), 'utf8');
    expect(ui).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|window\.open|location\.href|ssh:\/\//);
  });
});
