// Design 9.9 and 12: the history is newest first, paged, bounded, and read through the same guard as everything else.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApi } from '../server/app.ts';
import { PAGE_MAX, READ_MAX, readChanges, ROWS_MAX } from '../server/changes.ts';
import { closeRigs, rig } from './support/rig.ts';

afterEach(closeRigs);

const log = (lines: (object | string)[]) => { const f = join(mkdtempSync(join(tmpdir(), 'relief-log-')), 'changes.jsonl'); writeFileSync(f, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'); return f; };
const at = (i: number) => new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString();
const entry = (i: number) => ({ at: at(i), seq: i, added: [`pve:qemu:${i}`], removed: [], changed: [], state: [] });

describe('reading', () => {
  it('is newest first', () => {
    const p = readChanges(log([entry(1), entry(2), entry(3)]), { limit: 10 });
    expect(p.items.map((x) => x.seq)).toEqual([3, 2, 1]); expect(p.next).toBeNull(); expect(p.total).toBe(3);
  });
  it('pages through everything with no line twice', () => {
    const f = log(Array.from({ length: 25 }, (_, i) => entry(i)));
    const seen: (number | null)[] = []; let before: number | undefined;
    for (let n = 0; n < 5; n++) { const p = readChanges(f, { limit: 10, before }); seen.push(...p.items.map((x) => x.seq)); if (p.next === null) break; before = p.next; }
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => 24 - i));
  });
  const numbered = (i: number, ms = i) => ({ n: i + 1, at: at(ms), seq: i, added: [`pve:qemu:${i}`] });
  it('a page keeps its place when a new line arrives', () => {
    const lines = Array.from({ length: 5 }, (_, i) => numbered(i));
    const first = readChanges(log(lines), { limit: 2 });
    const later = readChanges(log([...lines, numbered(99)]), { limit: 2, before: first.next! });
    expect(later.items.map((x) => x.seq)).toEqual([2, 1]);
  });
  it('and when rotation takes lines off the top', () => {
    const lines = Array.from({ length: 10 }, (_, i) => numbered(i));
    const first = readChanges(log(lines), { limit: 3 });
    const later = readChanges(log(lines.slice(4)), { limit: 3, before: first.next! });
    expect(later.items.map((x) => x.seq)).toEqual([6, 5, 4]);
  });
  it('a rotation through one millisecond does not end the list', () => {
    const lines = Array.from({ length: 6 }, (_, i) => numbered(i, 1));   // all in one millisecond
    const first = readChanges(log(lines), { limit: 2 });
    const later = readChanges(log(lines.slice(1)), { limit: 9, before: first.next! });
    expect(later.items.map((x) => x.seq)).toEqual([3, 2, 1]);
  });
  it('a cursor rotated out of the file ends the list', () => {
    expect(readChanges(log([numbered(5)]), { limit: 5, before: 1 })).toMatchObject({ items: [], next: null });
  });
  it('a file from before numbering still pages, and sits below the numbered lines', () => {
    const f = log([entry(1), entry(2), numbered(3), numbered(4)]);
    const a = readChanges(f, { limit: 3 });
    expect(a.items.map((x) => x.seq)).toEqual([4, 3, 2]);
    expect(readChanges(f, { limit: 3, before: a.next! }).items.map((x) => x.seq)).toEqual([1]);
  });
  it('a file that is not there is an empty list', () => { expect(readChanges('/nonexistent/changes.jsonl', { limit: 5 })).toEqual({ items: [], next: null, total: 0 }); });
  it('skips what is not a record, and takes named fields only', () => {
    const p = readChanges(log(['{ broken', '{"at":"not a date"}', '[1]', { ...entry(1), token: 'MARKER', extra: { a: 1 } }]), { limit: 10 });
    expect(p.items).toHaveLength(1);
    expect(JSON.stringify(p)).not.toContain('MARKER');
  });
  it('turns each kind of line into rows', () => {
    const p = readChanges(log([
      { at: at(1), seq: 1, added: ['a', 'edge:e-1'], removed: ['b'], changed: ['c', 'd'], state: [{ id: 'c', from: 'running', to: 'error' }] },
      { at: at(2), seq: 1, source: 'pve', state: 'failing', why: 'tower 응답 없음' },
      { at: at(3), seq: 1, alerts: [{ id: 'n', text: 'cpu 임계 초과', on: true }] },
      { at: at(4), seq: 1, services: [{ id: 'n', to: '응답 없음' }] },
    ]), { limit: 10 });
    expect(p.items[3]!.rows).toEqual([{ type: 'state', id: 'c', text: 'running → error' }, { type: 'added', id: 'a' }, { type: 'added', text: '연결' }, { type: 'removed', id: 'b' }, { type: 'changed', id: 'd' }]);
    expect(p.items[2]!.rows).toEqual([{ type: 'source', text: 'pve failing · tower 응답 없음' }]);
    expect(p.items[1]!.rows).toEqual([{ type: 'alert', id: 'n', text: 'cpu 임계 초과 시작' }]);
    expect(p.items[0]!.rows).toEqual([{ type: 'service', id: 'n', text: '응답 없음' }]);
  });
});

describe('bounds', () => {
  it('one entry shows so many rows and counts the rest', () => {
    const p = readChanges(log([{ at: at(1), added: Array.from({ length: 300 }, (_, i) => `x${i}`) }]), { limit: 1 });
    expect(p.items[0]!.rows).toHaveLength(ROWS_MAX); expect(p.items[0]!.more).toBe(300 - ROWS_MAX);
  });
  it('a long text is cut', () => {
    const p = readChanges(log([{ at: at(1), source: 'pve', state: 'failing', why: 'x'.repeat(4000) }]), { limit: 1 });
    expect(JSON.stringify(p).length).toBeLessThan(500);
  });
  it('reads the tail of an oversized file and starts on a whole line', () => {
    const big = JSON.stringify(entry(1));
    const f = log(Array.from({ length: Math.ceil((READ_MAX * 1.2) / (big.length + 1)) }, () => big));
    const p = readChanges(f, { limit: 3 });
    expect(p.items).toHaveLength(3); expect(p.total).toBeLessThan(READ_MAX / big.length + 2);
  });
});

describe('the route', () => {
  const setup = async () => { const r = await rig(); await r.live.collectOnce(); return { r, app: createApi({ live: r.live }) }; };
  const local = { host: '127.0.0.1:4815' };
  it('serves what the live map wrote, newest first', async () => {
    const { app, r } = await setup();
    r.mock.state.guests.push({ vmid: 101, node: 'node-2', name: 'guest-b', status: 'running', type: 'qemu' });
    await r.live.collectOnce();
    const b = (await (await app.request('http://127.0.0.1:4815/api/changes', { headers: local })).json()) as { items: { rows: { id?: string }[] }[] };
    expect(b.items[0]!.rows.some((x) => x.id === 'pve:qemu:101')).toBe(true);
  });
  it.each(['?limit=0', `?limit=${PAGE_MAX + 1}`, '?limit=x', '?limit=-1', '?before=x', '?before=1e3', '?limit=1;drop', '?before=../x', '?before=1.5'])('%s is a bad request', async (q) => {
    const { app } = await setup();
    expect((await app.request(`http://127.0.0.1:4815/api/changes${q}`, { headers: local })).status).toBe(400);
  });
  it('has the same guard as every route, and answers GET only', async () => {
    const { app } = await setup();
    expect((await app.request('http://127.0.0.1:4815/api/changes', { headers: { host: 'evil.example.com' } })).status).toBe(403);
    expect((await app.request('http://127.0.0.1:4815/api/changes', { headers: { ...local, origin: 'http://evil.example.com' } })).status).toBe(403);
    expect((await app.request('http://127.0.0.1:4815/api/changes', { headers: { ...local, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' } })).status).toBe(403);
    for (const method of ['POST', 'PUT', 'DELETE']) expect((await app.request('http://127.0.0.1:4815/api/changes', { method, headers: local })).status, method).toBe(404);
  });
  it('every line the live map writes carries the next number, across a restart', async () => {
    const { r } = await setup();
    r.mock.state.guests.push({ vmid: 101, node: 'node-2', name: 'b', status: 'running', type: 'qemu' });
    await r.live.collectOnce();
    r.reopen();
    r.mock.state.guests.push({ vmid: 102, node: 'node-2', name: 'c', status: 'running', type: 'qemu' });
    await r.live.collectOnce();
    const ns = r.file('changes.jsonl').trim().split('\n').map((l) => (JSON.parse(l) as { n: number }).n);
    expect(ns).toEqual(ns.map((_, i) => i + 1));
  });
  it('the fixture server has no history and says so', async () => {
    const r = await createApi().request('http://127.0.0.1:4815/api/changes', { headers: local });
    expect(await r.json()).toEqual({ items: [], next: null, total: 0 });
  });
});
