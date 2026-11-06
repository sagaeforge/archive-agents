// Design 9.14: a damaged memory costs the memory and nothing else, and an object taken away on purpose can be cleared without touching the service's file.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { forgetCli } from '../server/check.ts';
import { consumeRequests, isForgettable, takeReply, writeRequest } from '../server/forget.ts';
import type { Entity } from '../server/model/fact.ts';
import { healthOf } from '../server/model/health.ts';
import { advance, emptyWatch, forget, MAX_WATCHED, parseWatch, type Watch } from '../server/model/watch.ts';
import { startLive } from '../server/serve.ts';
import { startMock } from '../dev/mcp-mock/mock.ts';
import { closeRigs, rig, TOKEN, type Rig } from './support/rig.ts';

afterEach(closeRigs);

const AT = '2026-11-01T09:00:00.000Z';
const vm = (id: string): Entity => ({ id, kind: 'vm', title: id, state: 'running', basis: 'observed', facts: {} });
const known = (k: 'node' | 'vm' = 'vm') => ({ kind: k, title: 't', running: true, at: AT });
const good = (): Watch => ({ known: { 'pve:qemu:1': known() }, missing: { 'pve:qemu:1': { id: 'pve:qemu:1', kind: 'vm', title: 't', since: AT } }, crashed: {} });
const damage = (r: Rig, watch: unknown) => {
  const f = join(r.stateDir, 'state.json');
  const s = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
  writeFileSync(f, JSON.stringify({ ...s, watch }));
};
const src = (r: Rig, id: string) => r.snap().sources.find((s) => s.id === id);

describe('parseWatch', () => {
  it('takes a good one', () => { expect(parseWatch(good())).toEqual(good()); });
  it.each([[5], ['x'], [null], [[]], [{}], [{ known: {}, missing: {} }], [{ known: 1, missing: {}, crashed: {} }], [{ known: { a: { kind: 'disk', title: 't', running: true, at: AT } }, missing: {}, crashed: {} }], [{ known: { a: { kind: 'vm', title: 5, running: true, at: AT } }, missing: {}, crashed: {} }], [{ known: {}, missing: {}, crashed: { a: 1 } }], [{ known: {}, missing: {}, crashed: {}, extra: 1 }]])('refuses %j', (v) => { expect(parseWatch(v)).toBeNull(); });
  const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`pve:qemu:${i + 1}`, known()]));
  it('takes the cap and refuses one more, in each list', () => {
    expect(parseWatch({ known: many(MAX_WATCHED), missing: {}, crashed: {} })).not.toBeNull();
    expect(parseWatch({ known: many(MAX_WATCHED + 1), missing: {}, crashed: {} })).toBeNull();
    expect(parseWatch({ known: {}, missing: {}, crashed: Object.fromEntries(Array.from({ length: MAX_WATCHED + 1 }, (_, i) => [`a${i}`, AT])) })).toBeNull();
    expect(parseWatch({ known: {}, missing: Object.fromEntries(Array.from({ length: MAX_WATCHED + 1 }, (_, i) => [`a${i}`, { id: 'a', kind: 'vm', title: 't', since: AT }])), crashed: {} })).toBeNull();
  });
  it('a churn of ids cannot grow it past the cap: the oldest go, and what they cost', () => {
    const w: Watch = { known: Object.fromEntries(Array.from({ length: MAX_WATCHED + 1 }, (_, i) => [`pve:qemu:${i + 1}`, { ...known(), at: new Date(Date.parse(AT) + i * 1000).toISOString() }])), missing: { 'pve:qemu:1': { id: 'pve:qemu:1', kind: 'vm', title: 't', since: AT } }, crashed: { 'pve:qemu:1': AT } };
    const n = advance(w, [], [], AT);
    expect(Object.keys(n.known)).toHaveLength(MAX_WATCHED);
    expect(n.known['pve:qemu:1']).toBeUndefined(); expect(n.crashed['pve:qemu:1']).toBeUndefined(); expect(n.missing['pve:qemu:1']).toBeUndefined();
    expect(n.known['pve:qemu:2']).toBeDefined();
  });
});

describe('a damaged memory', () => {
  it.each([[5], [{ known: 'x' }], [[1, 2]], [{ known: { a: 1 }, missing: {}, crashed: {} }]])('%j costs the memory alone: relief starts, reads and says so', async (bad) => {
    let now = Date.now();
    const r = await rig({ now: () => now });
    await r.live.collectOnce(); await r.live.stop();
    const seq = r.snap().seq;
    damage(r, bad);
    r.reopen();
    await r.live.collectOnce();
    expect(r.snap().sources.find((s) => s.id === 'pve')).toMatchObject({ state: 'ok' });
    expect(r.snap().nodes.some((n) => n.kind === 'node')).toBe(true);
    expect(r.snap().seq).toBeGreaterThanOrEqual(seq);
    expect(src(r, 'watch')).toMatchObject({ state: 'failing' });
    expect(healthOf(r.snap(), now).system.state).not.toBe('healthy');
    expect(r.file('changes.jsonl')).toContain('"source":"watch"');
    now += 601_000;
    r.mock.state.net.t += 0;
    await r.live.collectOnce();
    expect(src(r, 'watch')).toBeUndefined();
  });
  it('a file from before the memory is no damage', async () => {
    const r = await rig();
    await r.live.collectOnce(); await r.live.stop();
    const f = join(r.stateDir, 'state.json');
    const s = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>; delete s.watch; writeFileSync(f, JSON.stringify(s));
    r.reopen();
    await r.live.collectOnce();
    expect(src(r, 'watch')).toBeUndefined();
  });
  it('a good memory comes back', async () => {
    const r = await rig();
    await r.live.collectOnce(); await r.live.stop();
    damage(r, { ...emptyWatch(), known: { 'pve:qemu:7': known() } });
    r.reopen();
    await r.live.collectOnce();
    expect(r.snap().missing?.map((m) => m.id)).toEqual(['pve:qemu:7']);
    expect(src(r, 'watch')).toBeUndefined();
  });
});

describe('forget', () => {
  it('takes an object out of every list', () => {
    const w = { ...good(), crashed: { 'pve:qemu:1': AT } };
    const { watch, reply } = forget(w, 'pve:qemu:1', new Set());
    expect(reply).toEqual({ result: 'removed', kind: 'vm', title: 't' });
    expect(watch).toEqual(emptyWatch());
  });
  it('leaves the rest and the original alone', () => {
    const w: Watch = { ...good(), known: { ...good().known, 'pve:qemu:2': known() } };
    expect(Object.keys(forget(w, 'pve:qemu:1', new Set()).watch.known)).toEqual(['pve:qemu:2']);
    expect(Object.keys(w.known)).toHaveLength(2);
  });
  it('what it does not know it says so', () => { expect(forget(good(), 'pve:qemu:9', new Set()).reply).toEqual({ result: 'unknown' }); });
  it('what is still on the map stays', () => {
    const r = forget(good(), 'pve:qemu:1', new Set(['pve:qemu:1']));
    expect(r.reply).toEqual({ result: 'present' }); expect(r.watch).toEqual(good());
  });
  it.each(['pve:node:n-1', 'pve:node:a.b_c', 'pve:qemu:100', 'pve:lxc:1'])('%s can be named', (id) => { expect(isForgettable(id)).toBe(true); });
  it.each(['', 'x', 'pve:st:n:local', 'pve:qemu:0', 'pve:qemu:abc', 'pve:node:../x', 'pve:node:a/b', 'decl:wan:a', 'pve:node:', ' pve:qemu:1', 'pve:qemu:1 ', 'host:pc'])('%j cannot', (id) => { expect(isForgettable(id)).toBe(false); });
});

describe('the request directory', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'relief-forget-'));
  const removed = () => ({ result: 'removed' as const, kind: 'vm', title: 't' });
  it('carries a request and its answer, and leaves nothing behind', () => {
    const d = dir(); const key = writeRequest(d, 'pve:qemu:1');
    const seen: string[] = [];
    expect(consumeRequests(d, (id) => { seen.push(id); return removed(); }, Date.now())).toBe(1);
    expect(seen).toEqual(['pve:qemu:1']);
    expect(takeReply(d, key)).toEqual(removed());
    expect(takeReply(d, key)).toBeNull();
    expect(readdirSync(join(d, 'forget'))).toEqual([]);
  });
  it('no directory is nothing to do', () => { expect(consumeRequests(join(dir(), 'none'), removed, 0)).toBe(0); });
  const plant = (d: string, name: string, body: string) => { mkdirSync(join(d, 'forget'), { recursive: true }); writeFileSync(join(d, 'forget', name), body); };
  const NAME = '00000000-0000-0000-0000-000000000000.req';
  it.each([['not json', '{'], ['an id outside the rule', '{"id":"decl:wan:a"}'], ['an extra field', '{"id":"pve:qemu:1","x":1}'], ['a huge file', `{"id":"${'x'.repeat(2000)}"}`], ['no id', '{}']])('%s is removed with no action', (_n, body) => {
    const d = dir(); plant(d, NAME, body);
    let called = 0;
    expect(consumeRequests(d, () => { called++; return removed(); }, 0)).toBe(0);
    expect(called).toBe(0); expect(readdirSync(join(d, 'forget'))).toEqual([]);
  });
  it('a half-written temporary file is left alone', () => {
    const d = dir(); plant(d, 'x.tmp', '{');
    expect(consumeRequests(d, removed, 0)).toBe(0);
    expect(readdirSync(join(d, 'forget'))).toEqual(['x.tmp']);
  });
  it('a link is not followed', () => {
    const d = dir(); const target = join(d, 'elsewhere'); writeFileSync(target, '{"id":"pve:qemu:1"}');
    mkdirSync(join(d, 'forget')); symlinkSync(target, join(d, 'forget', NAME));
    let called = 0;
    consumeRequests(d, () => { called++; return removed(); }, 0);
    expect(called).toBe(0); expect(existsSync(target)).toBe(true);
  });
  it('takes a bounded number a tick, and the rest on the next', () => {
    const d = dir(); for (let i = 0; i < 20; i++) writeRequest(d, 'pve:qemu:1');
    expect(consumeRequests(d, removed, Date.now())).toBe(16);
    expect(consumeRequests(d, removed, Date.now())).toBe(4);
  });
  it('an answer nobody came for goes after an hour', () => {
    const d = dir(); const key = writeRequest(d, 'pve:qemu:1'); consumeRequests(d, removed, Date.now());
    consumeRequests(d, removed, Date.now() + 3599_000);
    expect(existsSync(join(d, 'forget', `${key}.done`))).toBe(true);
    consumeRequests(d, removed, Date.now() + 3601_000);
    expect(existsSync(join(d, 'forget', `${key}.done`))).toBe(false);
  });
});

describe('with the service', () => {
  const vanish = async (r: Rig) => {
    await r.live.collectOnce();
    const all = (await r.reader.read({ tool: 'proxmox_list_resources' })) as { node?: string }[];
    r.mock.state.over.set('proxmox_list_resources', { json: all.filter((x) => x.node !== 'node-3') });
    await r.live.collectOnce();
    expect(healthOf(r.snap(), Date.now()).system.problems).toBe(1);
  };
  it('clears the problem, keeps it cleared on the next read and over a restart, and logs it', async () => {
    const r = await rig();
    await vanish(r);
    const key = writeRequest(r.stateDir, 'pve:node:node-3');
    expect(r.live.takeForgets()).toBe(1);
    expect(takeReply(r.stateDir, key)).toEqual({ result: 'removed', kind: 'node', title: 'node-3' });
    expect(r.snap().missing).toBeUndefined();
    await r.live.collectOnce();
    expect(r.snap().missing).toBeUndefined();
    expect(healthOf(r.snap(), Date.now()).system.problems).toBe(0);
    expect(JSON.parse(readFileSync(join(r.stateDir, 'state.json'), 'utf8')).watch.known['pve:node:node-3']).toBeUndefined();
    expect(r.file('changes.jsonl')).toContain('"removed":["pve:node:node-3"]');
    await r.live.stop(); r.reopen(); await r.live.collectOnce();
    expect(r.snap().missing).toBeUndefined();
  });
  it('an object still on the map stays, and no line is logged', async () => {
    const r = await rig();
    await r.live.collectOnce();
    const key = writeRequest(r.stateDir, 'pve:node:node-1');
    r.live.takeForgets();
    expect(takeReply(r.stateDir, key)).toEqual({ result: 'present' });
    expect(r.file('changes.jsonl')).not.toContain('"removed":["pve:node:node-1"]');
  });
  it('status names what is missing', async () => {
    const r = await rig();
    await vanish(r);
    expect(r.live.status().missing).toMatchObject([{ id: 'pve:node:node-3', title: 'node-3' }]);
  });
  it('the CLI refuses a bad id before anything is written', async () => {
    const out: string[] = []; const d = mkdtempSync(join(tmpdir(), 'relief-forget-'));
    expect(await forgetCli('decl:wan:a', { env: { RELIEF_STATE: d }, print: (l) => out.push(l) })).toBe(2);
    expect(await forgetCli(undefined, { env: { RELIEF_STATE: d }, print: (l) => out.push(l) })).toBe(2);
    expect(existsSync(join(d, 'forget'))).toBe(false);
    expect(out[0]).toContain('usage');
  });
  it.each([[{ result: 'present' as const }, 'still on the map'], [{ result: 'unknown' as const }, 'does not remember']])('the CLI prints %j in words, exit 1', async (reply, text) => {
    const d = mkdtempSync(join(tmpdir(), 'relief-forget-')); const out: string[] = [];
    const t = setInterval(() => consumeRequests(d, () => reply, Date.now()), 20);
    const code = await forgetCli('pve:qemu:1', { env: { RELIEF_STATE: d, RELIEF_PORT: '9' }, print: (l) => out.push(l), waitMs: 2000 });
    clearInterval(t);
    expect(code).toBe(1); expect(out[0]).toContain(text);
  });
  it('with no service the request waits and says so, and the next start applies it', async () => {
    const r = await rig();
    await vanish(r); await r.live.stop();
    const out: string[] = [];
    expect(await forgetCli('pve:node:node-3', { env: { RELIEF_STATE: r.stateDir, RELIEF_PORT: '9' }, print: (l) => out.push(l), waitMs: 150 })).toBe(3);
    expect(out[0]).toContain('next start');
    r.reopen();
    expect(r.live.takeForgets()).toBe(1);
    await r.live.collectOnce();
    expect(r.snap().missing).toBeUndefined();
  });
  it('the real CLI against a real service: removed, printed, exit 0, and the file was never written by it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relief-cli-'));
    mkdirSync(join(dir, 'tower')); writeFileSync(join(dir, 'tower/token'), TOKEN, { mode: 0o600 });
    const mock = await startMock({ port: 0, token: TOKEN });
    writeFileSync(join(dir, 'relief.json'), JSON.stringify({ towerUrl: mock.url }));
    const env = { ...process.env, TOWER_CONFIG: join(dir, 'tower/tower.json'), RELIEF_CONFIG: dir, RELIEF_STATE: join(dir, 'state') } as NodeJS.ProcessEnv;
    const s = await startLive({ port: 0, env, dist: dir, period: { fastS: 1, activeS: 1, idleS: 1, minTtlS: 3, guestTickS: 1, forgetS: 1 } });
    try {
      await new Promise((res) => setTimeout(res, 1500));
      mock.state.guests = [];
      await new Promise((res) => setTimeout(res, 2500));
      expect(s.live.status().missing.map((m) => m.id)).toEqual(['pve:qemu:100']);
      const bin = fileURLToPath(new URL('../bin/relief.mjs', import.meta.url));
      const child = spawn(process.execPath, [bin, 'forget', 'pve:qemu:100'], { env: { ...env, RELIEF_PORT: String(s.port) } });
      let text = ''; child.stdout.on('data', (d) => (text += d));
      const code = await new Promise((res) => child.on('close', res));
      expect(code).toBe(0); expect(text).toContain('removed: pve:qemu:100 · vm · guest-a');
      expect(s.live.status().missing).toEqual([]);
    } finally { await s.close(); await mock.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);
});

describe('the surface stays read-only', () => {
  it('no route was added for it', () => {
    const t = readFileSync(fileURLToPath(new URL('../server/app.ts', import.meta.url)), 'utf8');
    expect(t).not.toMatch(/forget|app\.(post|put|patch|delete)\(/);
  });
  it('the CLI side does not touch state.json', () => {
    const t = readFileSync(fileURLToPath(new URL('../server/forget.ts', import.meta.url)), 'utf8').replace(/\/\/.*$/gm, '');
    expect(t).not.toMatch(/['"`]state\.json/);
    expect(vm('x').id).toBe('x');
  });
});
