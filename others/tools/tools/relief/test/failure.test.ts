// Design 6.6, the whole table, plus "a failed cycle leaves `at` alone" and "nothing turns into gone".
import net from 'node:net';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { staleIds, type Fact } from '../server/model/fact.ts';
import { classify, createReader } from '../server/collect/mcp.ts';
import { closeRigs, rig, type Rig } from './support/rig.ts';
import { tierCards } from '../src/model.ts';
import { readToken } from '../server/config.ts';
import { Live } from '../server/live.ts';
import { checkNoFake } from '../server/model/rules.ts';

afterEach(closeRigs);

const pve = (r: Rig) => r.snap().sources.find((s) => s.id === 'pve')!;
const ats = (r: Rig) => r.snap().nodes.flatMap((n) => Object.values(n.facts).map((f: Fact<unknown>) => `${n.id}:${f.at}`)).sort();

/** The checks every failing row shares: the map stays, `at` stays, nobody is gone. */
async function failsWith(setup: (r: Rig) => void | Promise<void>, why: string | RegExp, o: { deadlineMs?: number } = {}) {
  const r = await rig({ deadlineMs: o.deadlineMs ?? 2000 });
  await r.live.collectOnce();
  expect(pve(r).state).toBe('ok');
  const nodes = r.snap().nodes.map((n) => n.id).sort(); const before = ats(r); const seq = r.snap().seq; const at = pve(r).at;
  await new Promise((res) => setTimeout(res, 5));
  await setup(r);
  await r.live.collectOnce();
  expect(pve(r).state).toBe('failing');
  expect(pve(r).why).toMatch(why);
  expect(pve(r).at).toBe(at);
  expect(r.snap().nodes.map((n) => n.id).sort()).toEqual(nodes);
  expect(ats(r)).toEqual(before);
  expect(r.snap().seq).toBe(seq);
  expect(r.snap().nodes.some((n) => n.gone)).toBe(false);
  expect(checkNoFake(r.snap())).toEqual([]);
  return r;
}

describe('the source fails, facts wait', () => {
  it('tower is not up: connection refused', async () => {
    const r = await failsWith(async (x) => { await x.mock.close(); }, 'tower 응답 없음');
    expect(r.snap().nodes.length).toBeGreaterThan(5);
  });
  it('tower hangs: a port that accepts and never answers', async () => {
    const r = await failsWith((x) => { x.mock.state.hang = true; }, 'tower 응답 없음', { deadlineMs: 400 });
    expect(r.mock.calls.length).toBeGreaterThan(0);
  });
  it('a hang port from the first connect, bounded by the deadline', async () => {
    const srv = net.createServer(() => {}); await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
    const { port } = srv.address() as net.AddressInfo;
    const reader = createReader({ url: `http://127.0.0.1:${port}/mcp`, token: () => 'x'.repeat(40), deadlineMs: 300 });
    const t0 = Date.now();
    await expect(reader.read({ tool: 'proxmox_list_resources' })).rejects.toMatchObject({ scope: 'source', why: 'tower 응답 없음' });
    expect(Date.now() - t0).toBeLessThan(1500);
    await reader.close(); srv.close();
  });
  it('401: wrong token', async () => { await failsWith((x) => { x.mock.tokens.clear(); }, 'tower 인증 실패'); });
  it('503: tower has no token', async () => { await failsWith((x) => { x.mock.state.http = 503; }, 'tower 인증 실패'); });
  it('relief cannot read the token file: failing, not none', async () => {
    await failsWith((x) => { rmSync(x.tokenFile); x.mock.tokens.clear(); }, 'tower 토큰 없음');
  });
  it('proxmox upstream down', async () => { await failsWith((x) => { x.mock.state.all = { isError: 'upstream proxmox is down: spawn failed' }; }, 'proxmox 업스트림 다운'); });
  it('proxmox gone from tower.json: unknown name', async () => { await failsWith((x) => { x.mock.state.all = { protocol: 'unknown name: proxmox_list_resources' }; }, 'tower에 proxmox 없음'); });
  it('tools/list is empty after a tower restart', async () => {
    await failsWith((x) => { x.mock.state.tools = []; x.mock.state.all = { isError: 'upstream proxmox is down' }; }, '읽기 도구 확인 안 됨');
  });
  it.each([
    ['TIMEOUT: No PVE host answered in time (a; b).', 'PVE TIMEOUT'],
    ['REFUSED: Every PVE host refused the connection', 'PVE REFUSED'],
    ['TLS_VERIFY: No PVE host passed certificate verification', 'PVE TLS_VERIFY'],
    ['BAD_RESPONSE: No PVE host sent a PVE API response', 'PVE BAD_RESPONSE'],
    ['UNREACHABLE: All PVE hosts unreachable', 'PVE UNREACHABLE'],
    ['PVE API 401: The token was rejected', 'PVE API 401'],
  ])('PVE as a whole: %s', async (text, why) => { await failsWith((x) => { x.mock.state.all = { isError: text }; }, why); });
  it('an unknown text fails the source and is shown cut', async () => {
    const r = await failsWith((x) => { x.mock.state.all = { isError: `surprise ${'y'.repeat(500)}` }; }, /^surprise/);
    expect(pve(r).why!.length).toBeLessThanOrEqual(200);
  });
  it('recovers on the next good read, by itself', async () => {
    const r = await failsWith((x) => { x.mock.state.http = 503; }, 'tower 인증 실패');
    r.mock.state.http = null;
    const at = pve(r).at;
    await new Promise((res) => setTimeout(res, 5));
    await r.live.collectOnce();
    expect(pve(r)).toMatchObject({ state: 'ok' });
    expect(pve(r).why).toBeUndefined();
    expect(pve(r).at! > at!).toBe(true);
    expect(r.file('changes.jsonl')).toContain('"state":"failing"');
  });
});

describe('tools/list on a first connect', () => {
  it('empty: failing, and it looks again next cycle', async () => {
    const r = await rig();
    const tools = r.mock.state.tools;
    r.mock.state.tools = [];
    await r.live.collectOnce();
    expect(pve(r)).toMatchObject({ state: 'failing', why: '읽기 도구 확인 안 됨' });
    expect(r.mock.calls).toEqual([]);
    r.mock.state.tools = tools;
    await r.live.collectOnce();
    expect(pve(r).state).toBe('ok');
  });
});

describe('one path fails, the source stays ok', () => {
  it.each([['PVE API 403: Permission check failed', 'PVE API 403'], ['PVE API 500: internal', 'PVE API 500']])('%s: that value is unknown, with the reason', async (text, why) => {
    const r = await rig();
    r.mock.state.over.set('/nodes/node-1/dns', { isError: text });
    await r.live.collectOnce();
    expect(pve(r).state).toBe('ok');
    expect(r.entity('pve:node:node-1')?.facts.dns).toMatchObject({ basis: 'unknown', value: null, why });
    expect(r.entity('pve:node:node-2')?.facts.dns?.basis).toBe('observed');
  });
  it('a path that worked and then fails keeps its value and its age', async () => {
    const r = await rig();
    await r.live.collectOnce();
    const f = r.entity('pve:node:node-1')!.facts.dns!;
    r.mock.state.over.set('/nodes/node-1/dns', { isError: 'PVE API 500: x' });
    await new Promise((res) => setTimeout(res, 5));
    await r.live.collectOnce();
    expect(r.entity('pve:node:node-1')!.facts.dns).toEqual(f);
    expect(pve(r).state).toBe('ok');
  });
  it('/cluster/status alone: nodes stay, the address says why', async () => {
    const r = await rig();
    r.mock.state.over.set('/cluster/status', { isError: 'PVE API 403: nope' });
    await r.live.collectOnce();
    expect(pve(r).state).toBe('ok');
    expect(r.entity('pve:node:node-1')?.facts.address).toMatchObject({ basis: 'unknown', why: 'PVE API 403' });
  });
  it('tasks alone: guests fall back on their status', async () => {
    const r = await rig();
    r.mock.state.over.set('proxmox_recent_tasks', { isError: 'PVE API 500: x' });
    await r.live.collectOnce();
    expect(pve(r).state).toBe('ok');
    expect(r.entity('pve:qemu:100')?.state).toBe('running');
  });
  it('the guest agent answers 500: IP and OS are unknown, and the guest stays', async () => {
    const r = await rig();
    r.mock.state.guests[0]!.agent = false;
    await r.live.collectOnce();
    expect(pve(r).state).toBe('ok');
    const g = r.entity('pve:qemu:100')!;
    expect(g.state).toBe('running');
    expect(g.facts.ip).toMatchObject({ basis: 'unknown', why: 'guest agent 응답 없음' });
    expect(g.facts.os).toMatchObject({ basis: 'unknown', why: 'guest agent 응답 없음' });
  });
  it('an agent that answers gives observed values', async () => {
    const r = await rig();
    await r.live.collectOnce();
    const g = r.entity('pve:qemu:100')!;
    expect(g.facts.ip).toMatchObject({ basis: 'observed', value: ['192.0.2.50'] });
    expect(g.facts.os).toMatchObject({ basis: 'observed', value: 'Example OS 1.0' });
  });
  it('a stopped guest is not asked', async () => {
    const r = await rig();
    r.mock.state.guests[0]!.status = 'stopped';
    await r.live.collectOnce();
    expect(r.mock.calls.filter((c) => String(c.args.path).includes('/agent/'))).toEqual([]);
    expect(r.entity('pve:qemu:100')?.facts.ip).toMatchObject({ basis: 'unknown', why: '게스트가 실행 중이 아니다' });
  });
  it('an offline node gets no node reads', async () => {
    const r = await rig();
    r.mock.state.over.set('/cluster/status', { json: [{ type: 'node', name: 'node-2', ip: '192.0.2.11', online: 0 }] });
    await r.live.collectOnce();
    expect(r.mock.calls.filter((c) => String(c.args.path).startsWith('/nodes/node-2/'))).toEqual([]);
  });
});

describe('gone needs a good read', () => {
  it('an absent guest stays one cycle as an outline, is logged, then leaves', async () => {
    const r = await rig();
    await r.live.collectOnce();
    r.mock.state.guests = [];
    await r.live.collectOnce();
    expect(r.entity('pve:qemu:100')?.gone).toBe(true);
    expect(tierCards(r.snap(), Date.now()).find((c) => c.tier === '게스트')!.text).toContain('0개 관측');
    expect(r.file('changes.jsonl')).toContain('"removed":["pve:qemu:100"');
    await r.live.collectOnce();
    await r.live.collectOnce();
    expect(r.entity('pve:qemu:100')).toBeUndefined();
  });
  it('an empty list from a good read is 0 observed, not a failure', async () => {
    const r = await rig();
    r.mock.state.guests = [];
    await r.live.collectOnce();
    expect(pve(r).state).toBe('ok');
    expect(tierCards(r.snap(), Date.now()).find((c) => c.tier === '게스트')!.text).toBe('QEMU 0 · LXC 0 · 0개 관측');
  });
});

describe('restart', () => {
  it('with tower down the last state comes back, all of it stale, and `at` as it was', async () => {
    let now = Date.now();
    const r = await rig({ now: () => now });
    await r.live.collectOnce();
    await r.live.stop();
    const nodes = r.snap().nodes.map((n) => n.id).sort(); const before = ats(r);
    const seq = r.snap().seq;
    const logged = r.file('changes.jsonl');
    await r.mock.close();
    now += 10 * 60_000;
    const live = r.reopen();
    await live.collectOnce();
    expect(r.snap().nodes.map((n) => n.id).sort()).toEqual(nodes);
    expect(ats(r)).toEqual(before);
    expect(r.snap().seq).toBe(seq);
    expect(pve(r)).toMatchObject({ state: 'failing', why: 'tower 응답 없음' });
    const stale = staleIds(r.snap(), now);
    for (const id of ['pve:node:node-1', 'pve:node:node-2', 'pve:qemu:100', 'pve:br:node-1:vmbr0']) expect(stale.has(id), id).toBe(true);
    expect(r.file('changes.jsonl').split('\n').filter((l) => l.includes('"added":["'))).toEqual(logged.split('\n').filter((l) => l.includes('"added":["')));
  });
  it('an unreadable state file is a first start', async () => {
    const r = await rig();
    (await import('node:fs')).writeFileSync(`${r.stateDir}/state.json`, '{ broken');
    const live = r.reopen();
    await live.collectOnce();
    expect(pve(r).state).toBe('ok');
  });
});

describe('first start, tower down, no snapshot', () => {
  it('0 PVE objects, "collection failed, no value", and the WAN box stays', async () => {
    const r = await rig();
    await r.mock.close();
    await r.live.collectOnce();
    const s = r.snap();
    expect(s.nodes.map((n) => n.id)).toEqual(['decl:wan:none']);
    expect(pve(r).state).toBe('failing');
    expect(tierCards(s, Date.now()).find((c) => c.tier === '노드')!.text).toBe('수집 실패 · tower 응답 없음 · 값 없음');
    expect(s.sources.find((x) => x.id === 'edge')!.state).toBe('none');
    expect(checkNoFake(s)).toEqual([]);
  });
  it('Live starts with no tower and no token, and does not throw', async () => {
    const r = await rig();
    rmSync(r.tokenFile);
    await r.mock.close();
    await r.live.start();
    await new Promise((res) => setTimeout(res, 100));
    expect(pve(r)).toMatchObject({ state: 'failing', why: 'tower 토큰 없음' });
  });
  it('a configuration fault shows on the source and nothing is read', async () => {
    const r = await rig();
    const live = new Live({ reader: r.reader, stateDir: r.stateDir, fault: 'relief.json has an unknown or malformed field' });
    await live.start();
    expect(live.view().snapshot.sources[0]).toMatchObject({ state: 'failing', why: 'relief.json has an unknown or malformed field' });
    expect(r.mock.requests.value).toBe(0);
    await live.stop();
  });
});

describe('classify', () => {
  it.each([
    ['upstream proxmox timeout', 'source'], ['TIMEOUT: x', 'source'], ['PVE API 401: x', 'source'], ['NO_TOKEN: x', 'source'], ['anything', 'source'],
    ['PVE API 403: x', 'path'], ['PVE API 500: x', 'path'], ['NODE_NOT_FOUND: x', 'path'], ['BAD_REQUEST: x', 'path'],
  ])('%s -> %s', (t, scope) => { expect(classify(t).scope).toBe(scope); });
  it('scrubs before it shows', () => { expect(classify('oops SECRET', (s) => s.replace('SECRET', '[redacted]')).why).toBe('oops [redacted]'); });
});

describe('token read', () => { it('is the helper the reader uses', () => { expect(readToken('/nonexistent/token')).toBeNull(); }); });
