// Design 9.8 and 12: a trend is read for the selected object only, on demand, through the allowlist, and only named fields survive.
import { afterEach, describe, expect, it } from 'vitest';
import { createApi } from '../server/app.ts';
import { callOf, NotAllowed, type Target } from '../server/collect/allowlist.ts';
import { bucket, MAX_POINTS, readTrend, type TrendPoint } from '../server/collect/trend.ts';
import { TREND_CACHE_S, TREND_LIMIT } from '../server/live.ts';
import { closeRigs, rig, type Rig } from './support/rig.ts';

afterEach(closeRigs);

const rrd = (r: Rig) => r.mock.calls.filter((c) => String(c.args.path).endsWith('/rrddata'));
const NODE = 'pve:node:node-1'; const VM = 'pve:qemu:100';
const api = (path: string, params?: Record<string, string>) => ({ tool: 'proxmox_api_get', path, ...(params ? { params } : {}) }) as Target;

describe('the allowlist', () => {
  it.each(['/nodes/node-1/rrddata', '/nodes/node-1/qemu/100/rrddata', '/nodes/node-1/lxc/101/rrddata'])('%s takes timeframe=day as well as hour, and nothing longer', (path) => {
    expect(callOf(api(path, { timeframe: 'day' })).args).toEqual({ path, params: { timeframe: 'day' } });
    for (const tf of ['week', 'month', 'year', 'DAY', '']) expect(() => callOf(api(path, { timeframe: tf }))).toThrow(NotAllowed);
    expect(() => callOf(api(path, { timeframe: 'day', cf: 'MAX' }))).toThrow(NotAllowed);
  });
  it.each(['/nodes/../rrddata', '/nodes/a/b/rrddata', '/nodes/x/qemu/0/rrddata', '/nodes/x/qemu/1.5/rrddata', '/nodes/x/ceph/1/rrddata', '/nodes/x/storage/local/rrddata', '/nodes/x/qemu/100/rrd'])('refuses %j whatever the window', (path) => {
    expect(() => callOf(api(path, { timeframe: 'day' }))).toThrow(NotAllowed);
  });
});

describe('reading', () => {
  it('no collection reads rrddata: only a panel does', async () => {
    const r = await rig();
    await r.live.collectOnce();
    expect(rrd(r)).toEqual([]);
  });
  it('asks for the selected object alone, with the window it was given', async () => {
    const r = await rig();
    await r.live.collectOnce();
    const t = await r.live.trend(VM, 'day');
    expect(t?.points.length).toBeGreaterThan(0);
    expect(rrd(r)).toEqual([{ name: 'proxmox_api_get', args: { path: '/nodes/node-1/qemu/100/rrddata', params: { timeframe: 'day' } } }]);
  });
  it('a node reads its own path, and the fractions come from the node fields', async () => {
    const r = await rig();
    await r.live.collectOnce();
    const p = (await r.live.trend(NODE, 'hour'))!.points[0]!;
    expect(rrd(r)[0]!.args.path).toBe('/nodes/node-1/rrddata');
    expect(p).toEqual({ t: 1790000000, cpu: 0.01, mem: 0.25, disk: 0.0625, netIn: 1000, netOut: 500 });
  });
  it('a QEMU disk of 0 is no value, and the chart gets a gap', async () => {
    const r = await rig();
    await r.live.collectOnce();
    const p = (await r.live.trend(VM, 'hour'))!.points;
    expect(p.every((x) => x.disk === null)).toBe(true);
    expect(p.every((x) => x.mem === 0.5)).toBe(true);
  });
  it('only named fields reach the answer', async () => {
    const r = await rig();
    await r.live.collectOnce();
    const text = JSON.stringify(await r.live.trend(NODE, 'hour'));
    for (const s of ['pressurecpusome', 'loadavg', 'diskread', 'maxcpu']) expect(text).not.toContain(s);
  });
  it('holds the answer for its window, then reads again', async () => {
    let now = Date.now();
    const r = await rig({ now: () => now });
    await r.live.collectOnce();
    await r.live.trend(VM, 'hour'); await r.live.trend(VM, 'hour');
    expect(rrd(r)).toHaveLength(1);
    await r.live.trend(VM, 'day');
    expect(rrd(r)).toHaveLength(2);
    now += TREND_CACHE_S.hour * 1000 + 1;
    await r.live.trend(VM, 'hour');
    expect(rrd(r)).toHaveLength(3);
  });
  it('two panels at once share one read', async () => {
    const r = await rig();
    await r.live.collectOnce();
    await Promise.all([r.live.trend(VM, 'hour'), r.live.trend(VM, 'hour')]);
    expect(rrd(r)).toHaveLength(1);
  });
  it('a failure says why, shows no point, and that object rests, longer each time', async () => {
    let now = Date.now();
    const r = await rig({ now: () => now });
    await r.live.collectOnce();
    r.mock.state.over.set('/nodes/node-1/qemu/100/rrddata', { isError: 'PVE API 403: no' });
    expect(await r.live.trend(VM, 'hour')).toMatchObject({ points: [], why: 'PVE API 403', at: null });
    await r.live.trend(VM, 'hour'); await r.live.trend(VM, 'hour');
    expect(rrd(r)).toHaveLength(1);                                  // resting: nothing is sent
    now += TREND_LIMIT.backoffS * 1000 + 1;
    await r.live.trend(VM, 'hour');
    expect(rrd(r)).toHaveLength(2);
    now += TREND_LIMIT.backoffS * 1000 + 1;
    await r.live.trend(VM, 'hour');
    expect(rrd(r)).toHaveLength(2);                                  // twice as long now
    now += TREND_LIMIT.backoffS * 1000;
    r.mock.state.over.delete('/nodes/node-1/qemu/100/rrddata');
    expect((await r.live.trend(VM, 'hour'))!.points.length).toBeGreaterThan(0);
  });
  it('a good read clears the rest: the next failure waits the short time again', async () => {
    let now = Date.now();
    const r = await rig({ now: () => now });
    await r.live.collectOnce();
    const path = '/nodes/node-1/qemu/100/rrddata';
    r.mock.state.over.set(path, { isError: 'PVE API 403: no' });
    await r.live.trend(VM, 'hour');
    now += TREND_LIMIT.backoffS * 1000 + 1; r.mock.state.over.delete(path);
    await r.live.trend(VM, 'hour');
    r.mock.state.over.set(path, { isError: 'PVE API 403: no' });
    now += TREND_CACHE_S.hour * 1000 + 1;
    await r.live.trend(VM, 'hour');
    const n = rrd(r).length;
    now += TREND_LIMIT.backoffS * 1000 + 1;
    await r.live.trend(VM, 'hour');
    expect(rrd(r).length).toBe(n + 1);
  });
  it('a global cap: many objects, no more reads a minute than the limit, and the next minute goes on', async () => {
    let now = Date.now();
    const r = await rig({ now: () => now });
    r.mock.state.guests = Array.from({ length: 40 }, (_, i) => ({ vmid: 200 + i, node: 'node-1', name: `g${i}`, status: 'running', type: 'qemu' as const, uptime: 9000 }));
    await r.live.collectOnce();
    for (let i = 0; i < 40; i++) await r.live.trend(`pve:qemu:${200 + i}`, 'hour');
    expect(rrd(r)).toHaveLength(TREND_LIMIT.perMin);
    expect(await r.live.trend('pve:qemu:239', 'hour')).toMatchObject({ points: [], why: '요청이 많다 · 잠시 뒤 다시' });
    now += 60_000;                                                   // a minute to the millisecond is over
    expect((await r.live.trend('pve:qemu:239', 'hour'))!.points.length).toBeGreaterThan(0);
  });
  it('an in-flight cap: no more than two at once', async () => {
    const r = await rig();
    r.mock.state.guests = Array.from({ length: 6 }, (_, i) => ({ vmid: 200 + i, node: 'node-1', name: `g${i}`, status: 'running', type: 'qemu' as const, uptime: 9000 }));
    await r.live.collectOnce();
    const got = await Promise.all(Array.from({ length: 6 }, (_, i) => r.live.trend(`pve:qemu:${200 + i}`, 'hour')));
    expect(rrd(r)).toHaveLength(TREND_LIMIT.inFlight);
    expect(got.filter((t) => t?.why).length).toBe(4);
  });
  it.each([['a non-number', { json: [{ time: 1, cpu: 'x' }] }], ['no list', { json: { a: 1 } }], ['no time', { json: [{ cpu: 0.5 }] }]])('%s is a failure, not a flat line', async (_n, answer) => {
    const r = await rig();
    await r.live.collectOnce();
    r.mock.state.over.set('/nodes/node-1/rrddata', answer);
    expect(await r.live.trend(NODE, 'hour')).toMatchObject({ points: [], why: '응답 모양이 다르다' });
  });
});

describe('nothing from a request steers a call', () => {
  it.each(['pve:node:../evil', 'pve:qemu:999', 'pve:st:node-1:local', 'decl:wan:none', '/nodes/x/report', ''])('%j is no object with a history: no call', async (id) => {
    const r = await rig();
    await r.live.collectOnce();
    expect(r.live.trend(id, 'hour')).toBeNull();
    expect(rrd(r)).toEqual([]);
  });
  it('a node with a bad name is on the map and gets no call', async () => {
    const r = await rig();
    r.mock.state.over.set('proxmox_list_resources', { json: [{ id: 'node/a b', type: 'node', node: 'a b', status: 'online' }] });
    await r.live.collectOnce();
    expect(await r.live.trend('pve:node:a b', 'hour')).toMatchObject({ points: [], why: '이름이 경로 규칙에 맞지 않아 읽지 않았다' });
    expect(rrd(r)).toEqual([]);
  });
  it('the route takes an id and a window and nothing else', async () => {
    const r = await rig();
    await r.live.collectOnce();
    const app = createApi({ live: r.live });
    const get = (q: string) => app.request(`http://127.0.0.1:4815/api/trend${q}`, { headers: { host: '127.0.0.1:4815' } });
    expect((await get(`?id=${VM}&tf=hour`)).status).toBe(200);
    expect((await get(`?id=${VM}&tf=year`)).status).toBe(400);
    expect((await get('?tf=hour')).status).toBe(400);
    expect((await get('?id=nope')).status).toBe(404);
    expect((await get(`?id=${VM}&fixture=today`)).status).toBe(404); // Synthetic data is never served next to the real map.
    expect((await app.request(`http://127.0.0.1:4815/api/trend?id=${VM}`, { headers: { host: 'evil.example.com' } })).status).toBe(403);
    expect((await app.request(`http://127.0.0.1:4815/api/trend?id=${VM}`, { method: 'POST', headers: { host: '127.0.0.1:4815' } })).status).toBe(404);
  });
});

describe('a day of rows', () => {
  const pts = (n: number): TrendPoint[] => Array.from({ length: n }, (_, i) => ({ t: i, cpu: i % 2 ? 0.2 : 0.4, mem: null, disk: 0.5, netIn: i, netOut: 0 }));
  it('comes down to the limit as means, and a window with no value stays empty', () => {
    const b = bucket(pts(1440));
    expect(b.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(b[0]!.cpu).toBeCloseTo(0.3); expect(b[0]!.mem).toBeNull(); expect(b.at(-1)!.t).toBe(1439);
  });
  it('a short list is left alone', () => { const p = pts(70); expect(bucket(p)).toBe(p); });
  it('reaches the panel at the limit', async () => {
    const r = await rig();
    r.mock.state.over.set('/nodes/node-1/rrddata', { json: Array.from({ length: 1440 }, (_, i) => ({ time: i, cpu: 0.5 })) });
    expect((await readTrend(r.reader, { kind: 'node', node: 'node-1' }, 'day')).length).toBeLessThanOrEqual(MAX_POINTS);
  });
});
