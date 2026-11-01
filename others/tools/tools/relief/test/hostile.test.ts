// A guest controls everything its agent says. Whatever it answers, the snapshot stays small, clean and typed (design 6.4).
import { isIP } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { validateSnapshot } from '../server/model/fact.ts';
import { clean as cleanText, guestText, parseIps } from '../server/model/guest.ts';
import { closeRigs, rig, type Rig } from './support/rig.ts';

afterEach(closeRigs);

/** Bytes of the JSON a viewer receives for the mock's 16-object map, under any agent answer. */
const SNAPSHOT_BOUND = 32 * 1024;
const NET = '/nodes/node-1/qemu/100/agent/network-get-interfaces';
const OS = '/nodes/node-1/qemu/100/agent/get-osinfo';
const MB = 1024 * 1024;

const iface = (name: string, ips: unknown[]) => ({ name, 'ip-addresses': ips.map((a) => ({ 'ip-address': a })) });
const valid = (n: number) => Array.from({ length: n }, (_, i) => `192.0.2.${i % 250}`);

async function run(net: unknown, os: unknown): Promise<Rig> {
  const r = await rig();
  r.mock.state.over.set(NET, { json: { result: net } });
  r.mock.state.over.set(OS, { json: { result: os } });
  await r.live.collectOnce();
  await r.live.stop();
  return r;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

function clean(r: Rig) {
  const body = JSON.stringify(r.snap());
  expect(validateSnapshot(r.snap())).toEqual([]);
  expect(Buffer.byteLength(body)).toBeLessThan(SNAPSHOT_BOUND);
  expect(Buffer.byteLength(r.file('state.json'))).toBeLessThan(SNAPSHOT_BOUND);
  const g = r.entity('pve:qemu:100')!;
  const ips = g.facts.ip!.value;
  if (ips !== null) for (const a of ips as unknown[]) expect(isIP(a as string), String(a).slice(0, 60)).not.toBe(0);
  const os = g.facts.os!.value;
  expect(g.facts.os!.why).toBeUndefined(); // A hostile answer is cut, not mistaken for a failed read.
  if (os !== null) { expect(typeof os).toBe('string'); expect(os as string).not.toMatch(CONTROL); expect(Buffer.byteLength(os as string)).toBeLessThanOrEqual(128); }
}

const OK_OS = { 'pretty-name': 'Example OS 1.0' };

describe('hostile agent answers', () => {
  it.each([
    ['the suffix attack: 17 entries ending in the cut marker', [iface('eth0', [...valid(16), '외 1개'])], OK_OS],
    ['the suffix attack with a 1.4 MB entry and a control character', [iface('eth0', [`${'x'.repeat(1.4 * MB)}\u0000`, ...valid(15), '외 1개'])], OK_OS],
    ['a 1 MB single IP entry', [iface('eth0', ['1'.repeat(MB)])], OK_OS],
    ['control characters in an IP', [iface('eth0', ['192.0.2.1\u0000', '192.0.2.2\n', '\u001b[31m192.0.2.3'])], OK_OS],
    ['not addresses at all', [iface('eth0', ['<script>alert(1)</script>', 'localhost', '192.0.2.1/24', '999.1.1.1', ''])], OK_OS],
    ['5000 valid addresses', [iface('eth0', valid(5000))], OK_OS],
    ['1000 interfaces', Array.from({ length: 1000 }, (_, i) => iface(`e${i}`, valid(2))), OK_OS],
    ['a 1 MB interface name', [iface('n'.repeat(MB), ['192.0.2.1'])], OK_OS],
    ['control characters in an interface name', [iface('eth\u0000\u001b[0', ['192.0.2.1'])], OK_OS],
    ['an oversize OS name', [iface('eth0', ['192.0.2.1'])], { 'pretty-name': 'o'.repeat(1.5 * MB) }],
    ['an oversize OS name in multi-byte text', [iface('eth0', ['192.0.2.1'])], { 'pretty-name': '가'.repeat(300_000) }],
    ['an oversize fallback OS name', [iface('eth0', ['192.0.2.1'])], { name: 'o'.repeat(MB) }],
    ['control and bidi characters in an OS name', [iface('eth0', ['192.0.2.1'])], { 'pretty-name': 'Ex\u0000am\u001bple\u202e\u2066 \u0085OS' }],
    ['a list where text belongs', [iface('eth0', [['192.0.2.1']])], OK_OS],
  ])('%s', async (_name, net, os) => { clean(await run(net, os)); });
});

describe('what survives', () => {
  it('an OS name that is no text is a blank with its reason', async () => {
    const r = await run([iface('eth0', ['192.0.2.1'])], { 'pretty-name': { a: 1 } });
    expect(r.entity('pve:qemu:100')!.facts.os).toMatchObject({ basis: 'unknown', why: '응답 모양이 다르다' });
  });
  it('the marker text is dropped as what it is, not taken for a cut', async () => {
    const r = await run([iface('eth0', [...valid(16), '외 1개'])], OK_OS);
    const g = r.entity('pve:qemu:100')!;
    expect(g.facts.ip!.value).toEqual(valid(16));
    expect(g.facts.ipDropped!.value).toBe(1);
  });
  it('valid addresses beyond the limit are counted', async () => {
    const r = await run([iface('eth0', valid(5000))], OK_OS);
    const g = r.entity('pve:qemu:100')!;
    expect(g.facts.ip!.value).toHaveLength(16);
    expect(g.facts.ipDropped!.value).toBe(4984);
  });
  it('good addresses stand next to bad ones, and IPv6 parses', async () => {
    const r = await run([iface('eth0', ['192.0.2.7', 'junk', '2001:db8::1'])], OK_OS);
    const g = r.entity('pve:qemu:100')!;
    expect(g.facts.ip!.value).toEqual(['192.0.2.7', '2001:db8::1']);
    expect(g.facts.ipDropped!.value).toBe(1);
  });
  it('a clean answer carries no drop count', async () => {
    const r = await run([iface('eth0', ['192.0.2.7'])], OK_OS);
    expect(r.entity('pve:qemu:100')!.facts.ipDropped).toBeUndefined();
    expect(r.entity('pve:qemu:100')!.facts.os!.value).toBe('Example OS 1.0');
  });
  it('an interface name reaches nothing', async () => {
    const r = await run([iface('MARKERIFACE', ['192.0.2.1'])], OK_OS);
    expect(JSON.stringify(r.snap()) + r.file('state.json')).not.toContain('MARKERIFACE');
  });
  it('an OS name is cut on a character boundary, and says so', async () => {
    const r = await run([iface('eth0', ['192.0.2.1'])], { 'pretty-name': '가'.repeat(1000) });
    const os = r.entity('pve:qemu:100')!.facts.os!.value as string;
    expect(os).toMatch(/^가+ …$/);
    expect(os).not.toContain('�');
  });
});

describe('spoofing', () => {
  const hidden: [string, string][] = [
    ['zero-width space', String.fromCodePoint(0x200b)], ['zero-width joiner', String.fromCodePoint(0x200d)], ['word joiner', String.fromCodePoint(0x2060)],
    ['BOM', String.fromCodePoint(0xfeff)], ['soft hyphen', String.fromCodePoint(0xad)],
    ['tag character', String.fromCodePoint(0xe0041)], ['cancel tag', String.fromCodePoint(0xe007f)],
    ['LRM', String.fromCodePoint(0x200e)], ['RLM', String.fromCodePoint(0x200f)], ['ALM', String.fromCodePoint(0x61c)],
    ['right-to-left override', String.fromCodePoint(0x202e)], ['isolate', String.fromCodePoint(0x2066)],
    ['lone high surrogate', String.fromCharCode(0xd83d)], ['lone low surrogate', String.fromCharCode(0xde00)],
  ];
  it.each(hidden)('%s leaves a guest string', (_n, ch) => {
    expect(guestText(`Ex${ch}ample`)).toBe('Ex ample');
    expect(cleanText(`Ex${ch}ample`)).toBe('Ex ample');
  });
  it('a real pair and Hangul stay, and a cut never leaves half a pair', () => {
    const smile = String.fromCodePoint(0x1f600);
    expect(guestText(`가${smile}`)).toBe(`가${smile}`);
    expect(cleanText(`a${smile}`, 2).isWellFormed()).toBe(true);
    expect(guestText(smile.repeat(100))!.isWellFormed()).toBe(true);
  });
  it.each(['2001:db8::1%call-admin.evil.example', '2001:db8::1%eth0', '2001:db8::1%25eth0'])('a zone is no address: %s', async (zone) => {
    expect(parseIps([zone])).toEqual({ ips: [], dropped: 1 });
    const r = await run([iface('eth0', ['192.0.2.1', zone])], OK_OS);
    expect(r.entity('pve:qemu:100')!.facts.ip!.value).toEqual(['192.0.2.1']);
    expect(r.entity('pve:qemu:100')!.facts.ipDropped!.value).toBe(1);
    expect(JSON.stringify(r.snap()) + r.file('state.json')).not.toContain('evil.example');
  });
});

describe('the gate', () => {
  it('gives the same result on a second pass, so stored values are not cut twice', () => {
    const once = parseIps([...valid(30), 'junk']);
    expect(parseIps(once)).toEqual(once);
    const os = guestText('가'.repeat(1000));
    expect(guestText(os)).toBe(os);
  });
  it('turns anything but text into nothing', () => {
    expect(guestText(5)).toBeNull(); expect(guestText({})).toBeNull();
    expect(parseIps('192.0.2.1')).toEqual({ ips: [], dropped: 0 });
    expect(parseIps({ ips: ['192.0.2.1'], dropped: -9 })).toEqual({ ips: ['192.0.2.1'], dropped: 0 });
  });
});

describe('the last step holds whatever is already stored', () => {
  it('a state file with raw lists, marker text or long values is cleaned on the way out', async () => {
    const r = await rig();
    await r.live.collectOnce();
    const l = r.live as unknown as { raw: { guests: Record<string, { ip?: { value: unknown }; os?: { value: unknown } }> }; build(i: boolean): Promise<void> };
    l.raw.guests['qemu:100']!.ip!.value = [...valid(16), '외 1개', 'y'.repeat(MB)];
    l.raw.guests['qemu:100']!.os!.value = `\u0000${'z'.repeat(MB)}`;
    await l.build(false);
    clean(r);
    expect(r.entity('pve:qemu:100')!.facts.ipDropped!.value).toBe(2);
    l.raw.guests['qemu:100']!.ip!.value = { ips: ['bad', ...valid(40)], dropped: 3 };
    await l.build(false);
    clean(r);
    expect(r.entity('pve:qemu:100')!.facts.ipDropped!.value).toBe(3 + 1 + 24);
  });
});
