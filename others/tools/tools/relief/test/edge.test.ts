// Design 7.1 and 12: the hand-written edge file, drift between two values, and the public address.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startMock } from '../dev/mcp-mock/mock.ts';
import { startWanMock } from '../dev/mcp-mock/wan.ts';
import { check } from '../server/check.ts';
import type { LocalRead } from '../server/collect/local.ts';
import { MAX_FILE_BYTES, parseEdge, readEdge, reviewByOf, type EdgeFile } from '../server/collect/edge.ts';
import { isPublicV4, readPublicIp } from '../server/collect/wanip.ts';
import { loadConfig, publicIpUrl, resolvePaths } from '../server/config.ts';
import { overlayEdge, type External } from '../server/model/edgemap.ts';
import { reviewPassed, staleIds, validateSnapshot, type Entity, type Relation, type Snapshot } from '../server/model/fact.ts';
import { checkNoFake, inRange } from '../server/model/rules.ts';
import { holes, tierCards } from '../src/model.ts';
import { startLive } from '../server/serve.ts';
import { closeRigs, rig, TOKEN, type Rig } from './support/rig.ts';

afterEach(closeRigs);

const example = (): EdgeFile & Record<string, unknown> => JSON.parse(readFileSync(new URL('../fixtures/edge.example.json', import.meta.url), 'utf8')) as never;
const ok = (o: unknown) => { const r = parseEdge(JSON.stringify(o)); if (r.kind !== 'ok') throw new Error(r.kind === 'bad' ? r.why : 'none'); return r.file; };
const refused = (o: unknown) => { const r = parseEdge(JSON.stringify(o)); expect(r.kind).toBe('bad'); return r.kind === 'bad' ? r.why : ''; };
const base = () => ({ schema: 1, declaredAt: '2026-11-01' });
const NOW = Date.parse('2026-11-02T00:00:00.000Z');

function map(f: EdgeFile | null, o: Partial<External> = {}, nodes: Entity[] = []) {
  const out = { nodes: [{ id: 'decl:wan:none', kind: 'wan', title: 'WAN 미확인', basis: 'unknown', state: 'unknown', facts: {} } as Entity, ...nodes], edges: [] as Relation[] };
  overlayEdge(out, { edge: f, wan: null, wanOff: true, local: null, ...o }, NOW);
  return { ...out, get: (id: string) => out.nodes.find((n) => n.id === id) };
}
const node = (name: string, address: string): Entity => ({ id: `pve:node:${name}`, kind: 'node', title: name, basis: 'observed', state: 'ok', facts: { address: { value: address, basis: 'observed', source: 'pve:/cluster/status', at: new Date(NOW).toISOString(), ttlS: 45 } } });
const fresh = (address: string, ageS = 10) => ({ address, at: new Date(NOW - ageS * 1000).toISOString(), ttlS: 1800 });

describe('the schema', () => {
  it('takes the example file', () => { expect(ok(example()).lines).toHaveLength(1); });
  it.each(['password', 'psk', 'secret', 'token', 'apiKey'])('refuses a %s key, at the top and deep down', (k) => {
    expect(refused({ ...example(), [k]: 'x' })).toBe('최상위: 모르는 칸 1개');
    const e = example(); (e.wifi as unknown as Record<string, unknown>[])[0]![k] = 'x';
    expect(refused(e)).toBe('wifi.0: 모르는 칸 1개');
  });
  it('the message names the place and never the value', () => {
    const e = example(); (e.router as unknown as Record<string, unknown>).address = '999.SECRET.0.1';
    const why = refused(e);
    expect(why).toContain('router.address');
    expect(why).not.toContain('SECRET');
  });
  it.each([
    ['a modem on a line that is not there', (e: EdgeFile) => { e.modem!.line = 'nope'; }, 'modem.line'],
    ['a router uplink that is not there', (e: EdgeFile) => { e.router!.uplink = 'nope'; }, 'router.uplink'],
    ['allPortsTo that is not the router', (e: EdgeFile) => { e.modem!.allPortsTo = 'nope'; }, 'modem.allPortsTo'],
    ['a plan that is not there', (e: EdgeFile) => { e.hosts![0]!.plan = 'nope'; }, 'hosts.0.plan'],
    ['a client on a Wi-Fi that is not there', (e: EdgeFile) => { e.clients![0]!.via = 'nope'; }, 'clients.0.via'],
    ['a switch naming no host', (e: EdgeFile) => { e.switches![0]!.hosts = ['nope']; }, 'switches.0.hosts.0'],
    ['a forward to no host', (e: EdgeFile) => { e.portForwards = [{ key: 'p', title: 'p', protocol: 'tcp', externalPort: 80, internalPort: 80, host: 'nope', enabled: true }]; }, 'portForwards.0.host'],
    ['a duplicate key', (e: EdgeFile) => { e.hosts![1]!.key = e.hosts![0]!.key; }, 'duplicate'],
    ['a lease outside lanCidr', (e: EdgeFile) => { e.hosts![0]!.lease!.address = '198.51.100.5'; }, 'outside lanCidr'],
    ['a BMC lease outside lanCidr', (e: EdgeFile) => { (e.hosts![0]!.bmc as { lease: { address: string } }).lease.address = '198.51.100.5'; }, 'outside lanCidr'],
    ['a DHCP range outside lanCidr', (e: EdgeFile) => { e.router!.dhcpRange = ['198.51.100.1', '198.51.100.9']; }, 'outside lanCidr'],
    ['a plan outside lanCidr', (e: EdgeFile) => { e.addressPlan![0]!.to = '198.51.100.9'; }, 'outside lanCidr'],
    ['a plan running backwards', (e: EdgeFile) => { const p = e.addressPlan![0]!; [p.from, p.to] = [p.to, p.from]; }, 'backwards'],
  ])('refuses %s', (_n, mutate, want) => {
    const e = example(); mutate(e);
    expect(refused(e)).toContain(want);
  });
  it.each([
    ['a zone in an address', { value: '203.0.113.1%evil' }],
    ['a bad A record value', { value: 'home' }],
    ['a record type other than A', { type: 'TXT' }],
    ['a hostname with a space', { hostname: 'a b.example.com' }],
  ])('refuses %s', (_n, patch) => {
    const e = example(); Object.assign(e.dnsRecords![0]!, patch);
    refused(e);
  });
  it('refuses a wrong schema, broken JSON and an oversize file', () => {
    refused({ ...base(), schema: 2 });
    expect(parseEdge('{ not json')).toEqual({ kind: 'bad', why: 'JSON이 아니다' });
    const dir = mkdtempSync(join(tmpdir(), 'relief-edge-')); const f = join(dir, 'edge.json');
    // Valid JSON past the cap, so only the cap can refuse it.
    writeFileSync(f, JSON.stringify(base()) + ' '.repeat(MAX_FILE_BYTES));
    expect(readEdge(f)).toEqual({ kind: 'bad', why: '파일이 256 KiB를 넘는다' });
    writeFileSync(f, JSON.stringify(base()) + ' '.repeat(MAX_FILE_BYTES - JSON.stringify(base()).length));
    expect(readEdge(f).kind).toBe('ok');
    expect(readEdge(join(dir, 'missing.json'))).toEqual({ kind: 'none' });
    rmSync(dir, { recursive: true, force: true });
  });
  it('takes a regular file only: no symlink, no FIFO, no directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relief-edge-'));
    const real = join(dir, 'real.json'); writeFileSync(real, JSON.stringify(base()));
    const link = join(dir, 'link.json'); symlinkSync(real, link);
    expect(readEdge(link)).toEqual({ kind: 'bad', why: '심볼릭 링크는 받지 않는다' });
    expect(readEdge(dir)).toEqual({ kind: 'bad', why: '일반 파일이 아니다' });
    const fifo = join(dir, 'fifo.json');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const t0 = Date.now();
    expect(readEdge(fifo)).toEqual({ kind: 'bad', why: '일반 파일이 아니다' }); // On the old read this line never returns.
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(readEdge(real).kind).toBe('ok');
    rmSync(dir, { recursive: true, force: true });
  });
  it('cleans and bounds free text', () => {
    const e = example(); e.lines![0]!.title = `a\u0000b​${'x'.repeat(500)}`; e.lines![0]!.isp = '‮evil';
    const f = ok(e);
    expect(f.lines![0]!.title).toHaveLength(64);
    expect(f.lines![0]!.title.startsWith('a b ')).toBe(true);
    expect(f.lines![0]!.isp).toBe(' evil');
  });
  it('a key name that may be a pasted secret never reaches the reason', () => {
    expect(refused({ ...example(), 'MARKERPASTEDKEY': 1, another: 2 })).toBe('최상위: 모르는 칸 2개');
  });
  it.each([['a b'], [''], ['a/b'], ['a\nb'], ['x'.repeat(65)], ['가']])('refuses the key %j', (k) => { const e = example(); e.lines![0]!.key = k; e.modem!.line = k; refused(e); });
  it('takes a key of 64 plain characters', () => { const e = example(); const k = `a.b-c_${'x'.repeat(58)}`; e.lines![0]!.key = k; e.modem!.line = k; expect(ok(e).lines![0]!.key).toBe(k); });
  it('the review date defaults to 90 days after the declaration', () => { expect(reviewByOf(ok(base()))).toBe('2027-01-30'); expect(reviewByOf(ok({ ...base(), reviewBy: '2027-02-01' }))).toBe('2027-02-01'); });
});

describe('blank means different things', () => {
  it('portForwards: no field is unknown, [] is zero declared', () => {
    const gw = (over: object) => map(ok({ ...base(), lines: [{ key: 'l', title: 'L' }], router: { key: 'r', title: 'R', uplink: 'l', address: '192.0.2.1' }, ...over })).get('decl:gateway:r')!;
    expect(gw({}).facts.portForwards).toMatchObject({ basis: 'unknown', why: '포트 포워드 미확인' });
    expect(gw({ portForwards: [] }).facts.portForwards).toMatchObject({ basis: 'declared', value: '0개 선언' });
  });
  it('lines: no field keeps the blank box, [] removes it, a line replaces it', () => {
    expect(map(ok(base())).get('decl:wan:none')).toBeDefined();
    expect(map(ok({ ...base(), lines: [] })).nodes.filter((n) => n.kind === 'wan')).toEqual([]);
    expect(map(ok({ ...base(), lines: [{ key: 'l', title: 'L' }] })).get('decl:wan:l')?.basis).toBe('declared');
  });
  const host = (bmc: unknown) => {
    const h: Record<string, unknown> = { key: 'n1', title: 'N1', kind: 'pve-node', pveNode: 'node-1' };
    if (bmc !== undefined) h.bmc = bmc;
    return map(ok({ ...base(), hosts: [h] }), {}, [node('node-1', '192.0.2.10')]);
  };
  it('"bmc": "none" is declared absent: no object, no blank', () => {
    const m = host('none');
    expect(m.get('decl:bmc:n1')).toBeUndefined();
    expect(m.get('pve:node:node-1')!.facts.bmc).toMatchObject({ basis: 'declared', value: '없음' });
  });
  it('"bmc": {} is a BMC with no known address', () => {
    const m = host({});
    expect(m.get('decl:bmc:n1')).toMatchObject({ kind: 'bmc', basis: 'declared', parent: 'pve:node:node-1' });
    expect(m.get('decl:bmc:n1')!.facts.address).toMatchObject({ basis: 'unknown', why: '주소 미확인' });
    expect(m.get('pve:node:node-1')!.facts.bmc).toBeUndefined();
  });
  it('no bmc field says nothing either way', () => {
    const m = host(undefined);
    expect(m.get('decl:bmc:n1')).toBeUndefined();
    expect(m.get('pve:node:node-1')!.facts.bmc).toMatchObject({ basis: 'unknown', why: 'BMC 유무를 적지 않았다' });
  });
  it('natLayers: null and no field are unknown, a number is declared', () => {
    const gw = (n: object) => map(ok({ ...base(), hosts: [], router: undefined, ...n }), {}, [{ id: 'net:gw:192.0.2.1', kind: 'gateway', title: 'g', basis: 'derived', state: 'unknown', facts: {} }]).get('net:gw:192.0.2.1')!;
    expect(gw({ natLayers: null }).facts.natLayers).toMatchObject({ basis: 'unknown' });
    expect(gw({}).facts.natLayers).toMatchObject({ basis: 'unknown' });
    expect(gw({ natLayers: 1 }).facts.natLayers).toMatchObject({ basis: 'declared', value: 1 });
  });
  it('a dnsRecord with no value is a domain that cannot be compared', () => {
    const e = example(); delete (e.dnsRecords![0] as { value?: string }).value;
    const d = map(ok(e), { wan: fresh('203.0.113.10') }).nodes.find((n) => n.kind === 'domain')!;
    expect(d.facts.record!.basis).toBe('unknown');
    expect(d.facts.aRecord).toMatchObject({ basis: 'unknown', why: '비교 불가 · 선언값이 없다' });
    expect(d.warnings).toBeUndefined();
  });
});

describe('the map', () => {
  const gwGuess = (): Entity => ({ id: 'net:gw:192.0.2.1', kind: 'gateway', title: '게이트웨이', basis: 'derived', state: 'unknown', facts: { address: { value: '192.0.2.1', basis: 'derived', source: 'rule:same-default-gateway', at: null, ttlS: null } } });
  it('every section lands on its kind', () => {
    const e = example(); e.vpn = [{ key: 'v', title: 'V', protocol: 'wireguard', role: 'server', enabled: true }]; e.proxies = [{ key: 'p', title: 'P' }];
    const m = map(ok(e), {}, [gwGuess(), node('node-1', '192.0.2.11')]);
    const kinds = new Set(m.nodes.map((n) => n.kind));
    for (const k of ['wan', 'modem', 'domain', 'gateway', 'tunnel', 'proxy', 'switch', 'wifi', 'clients', 'workstation', 'bmc'] as const) expect(kinds.has(k), k).toBe(true);
    expect(new Set(m.edges.map((r) => r.kind))).toEqual(new Set(['wan', 'dns', 'tunnel', 'lan', 'wireless']));
  });
  it('wan -> modem -> gateway, or wan -> gateway with no modem', () => {
    const m = map(ok(example()), {}, [gwGuess()]);
    expect(m.edges.filter((r) => r.kind === 'wan').map((r) => [r.source, r.target])).toEqual([['decl:wan:line-a', 'decl:modem:modem'], ['decl:modem:modem', 'net:gw:192.0.2.1']]);
    const e = example(); delete e.modem; e.router!.uplink = 'line-a';
    expect(map(ok(e), {}, [gwGuess()]).edges.filter((r) => r.kind === 'wan').map((r) => r.source)).toEqual(['decl:wan:line-a']);
  });
  it('a router with the guessed address names that object', () => {
    const g = map(ok(example()), {}, [gwGuess()]).get('net:gw:192.0.2.1')!;
    expect(g).toMatchObject({ title: '거실 공유기', basis: 'declared', state: 'ok' });
    expect(g.facts.address!.basis).toBe('derived');
  });
  it('a router with another address keeps the observation and shows both', () => {
    const e = example(); e.router!.address = '192.0.2.2';
    const m = map(ok(e), {}, [gwGuess()]);
    expect(m.nodes.filter((n) => n.kind === 'gateway')).toHaveLength(1);
    expect(m.get('net:gw:192.0.2.1')!.facts).toMatchObject({ address: { value: '192.0.2.1' }, declaredAddress: { value: '192.0.2.2', basis: 'declared' } });
  });
  it('a router with no address joins a lone guess, not one of two', () => {
    const e = example(); delete e.router!.address; delete e.router!.lanCidr; delete e.router!.dhcpRange;
    e.hosts = []; e.addressPlan = []; e.switches = [];
    expect(map(ok(e), {}, [gwGuess()]).nodes.filter((n) => n.kind === 'gateway')).toHaveLength(1);
    const two = map(ok(e), {}, [gwGuess(), { ...gwGuess(), id: 'net:gw:192.0.2.9' }]);
    expect(two.nodes.filter((n) => n.kind === 'gateway')).toHaveLength(3);
  });
  it('a host named for a node that is not there connects to nothing, and says so', () => {
    const m = map(ok(example()), {}, [gwGuess()]);
    expect(m.get('net:gw:192.0.2.1')!.facts.unmatchedHosts!.value).toEqual(['노드 1', '노드 2', '노드 3']);
    expect(m.edges.filter((r) => r.target.startsWith('pve:node:'))).toEqual([]);
  });
  it('a forward needs its host and an enabled flag; the rest stay in the panel', () => {
    const e = example();
    e.portForwards = [
      { key: 'a', title: 'A', protocol: 'tcp', externalPort: 80, internalPort: 8080, host: 'workstation', enabled: true },
      { key: 'b', title: 'B', protocol: 'tcp', externalPort: 81, internalPort: 81, host: 'workstation', enabled: false },
      { key: 'c', title: 'C', protocol: 'udp', externalPort: [1000, 1010], internalPort: [1000, 1010], host: 'node-1', enabled: true },
    ];
    const m = map(ok(e), {}, [gwGuess()]);
    expect(m.edges.filter((r) => r.kind === 'forward').map((r) => r.id)).toEqual(['e-forward-a']);
    const g = m.get('net:gw:192.0.2.1')!;
    expect(g.facts.forwardsOff!.value).toEqual(['B']);
    expect(g.facts.forwardsLost!.value).toEqual(['C']);
    expect(m.nodes.find((n) => n.kind === 'domain')!.facts.path!.value).toBe('도메인 → 라우터 · 포트 포워드 2개 선언');
  });
  const here = (o: Partial<LocalRead> = {}): LocalRead => ({ hostname: 'pc-1', address: '192.0.2.150', cores: 8, memTotal: 16 * 2 ** 30, memFree: 4 * 2 ** 30, at: '2026-11-02T00:00:00.000Z', ...o });
  it('the workstation takes its observed facts from this machine, at the adapter\'s own time', () => {
    const m = map(ok(example()), { local: here() });
    const w = m.get('host:workstation')!;
    expect(w.facts.address).toMatchObject({ basis: 'observed', value: '192.0.2.150', source: 'local:os', at: '2026-11-02T00:00:00.000Z' });
    expect(w.facts.hostname).toMatchObject({ basis: 'observed', value: 'pc-1' });
    expect(w.facts.cores).toMatchObject({ basis: 'observed', value: 8 });
    expect(w.facts.mem).toMatchObject({ basis: 'observed', value: 0.75 });
    expect(w.facts.memTotal!.value).toBe('16.0 GiB');
    expect(w.facts.lease).toMatchObject({ basis: 'declared', at: '2026-11-01' });
    expect(w.basis).toBe('declared');
  });
  it('no safe interface leaves the address unknown, and no adapter leaves it out', () => {
    expect(map(ok(example()), { local: here({ address: null }) }).get('host:workstation')!.facts.address).toMatchObject({ basis: 'unknown' });
    expect(map(ok(example()), { local: null }).get('host:workstation')!.facts.address).toBeUndefined();
  });
  it('the adapter alone invents no PC: no edge file, or no workstation host, gives none', () => {
    expect(map(null, { local: here() }).nodes.some((n) => n.kind === 'workstation')).toBe(false);
    const e = example(); e.hosts = e.hosts!.filter((h) => h.kind !== 'workstation'); e.switches = [];
    expect(map(ok(e), { local: here() }).nodes.some((n) => n.kind === 'workstation')).toBe(false);
  });
  it('a declared os lands on the PC as a declared fact', () => {
    const e = example(); (e.hosts as unknown as Record<string, unknown>[])[3]!.os = 'Windows';
    expect(map(ok(e), { local: here() }).get('host:workstation')!.facts.os).toMatchObject({ basis: 'declared', value: 'Windows' });
  });
  it('a workstation on no switch hangs off the router, as a declared link', () => {
    const e = example(); e.switches = [];
    const m = map(ok(e), {}, [gwGuess()]);
    const link = m.edges.filter((r) => r.target === 'host:workstation');
    expect(link).toMatchObject([{ source: 'net:gw:192.0.2.1', kind: 'lan', basis: 'declared' }]);
    expect(m.get('host:workstation')!.facts.link).toMatchObject({ basis: 'declared', value: '유선 · 라우터' });
  });
  it('a workstation on a switch takes that link and no second one', () => {
    const m = map(ok(example()), {}, [gwGuess()]);
    expect(m.edges.filter((r) => r.target === 'host:workstation').map((r) => r.source)).toEqual(['decl:switch:rack']);
    expect(m.get('host:workstation')!.facts.link!.value).toBe('유선 · 스위치');
  });
  it('with no router or guess the workstation connects to nothing', () => {
    const e = example(); delete e.router; delete e.modem!.allPortsTo; e.switches = []; delete e.dnsRecords![0]!.target;
    expect(map(ok(e)).edges.filter((r) => r.target === 'host:workstation')).toEqual([]);
  });
  it('a node gets no second link: its uplink is observed', () => {
    const e = example(); e.switches = [];
    expect(map(ok(e), {}, [gwGuess(), node('node-1', '192.0.2.11')]).edges.filter((r) => r.target === 'pve:node:node-1')).toEqual([]);
  });
  it('a client group joins its Wi-Fi, and the Wi-Fi the router, as declared links', () => {
    const m = map(ok(example()), {}, [gwGuess()]);
    expect(m.edges.find((r) => r.target === 'decl:clients:mobile')).toMatchObject({ source: 'decl:wifi:main', kind: 'wireless', basis: 'declared' });
    expect(m.edges.find((r) => r.target === 'decl:wifi:main')).toMatchObject({ source: 'net:gw:192.0.2.1', kind: 'lan', basis: 'declared' });
  });
  it('a lease carries its own date, and an example fact the file date', () => {
    const m = map(ok(example()), {}, [node('node-1', '192.0.2.11')]);
    const n = m.get('pve:node:node-1')!;
    expect(n.facts.lease).toMatchObject({ value: '192.0.2.11', at: '2026-11-01', source: 'edge.json#/hosts/0/lease' });
    expect(m.get('decl:bmc:node-1')!.facts.address).toMatchObject({ value: '192.0.2.31', basis: 'declared' });
  });
  it('a past review date reads as past, and a declared fact has no ttl to go stale on', () => {
    const e = ok({ ...base(), reviewBy: '2026-11-01', lines: [{ key: 'l', title: 'L' }] });
    const f = map(e).get('decl:wan:l')!.facts.state!;
    expect(reviewPassed(f, NOW)).toBe(true);
    expect(f.ttlS).toBeNull();
  });
});

describe('drift is a warning', () => {
  it('a-record: same address says nothing, another warns', () => {
    const same = map(ok(example()), { wan: fresh('203.0.113.10') }).nodes.find((n) => n.kind === 'domain')!;
    expect(same.warnings).toBeUndefined();
    expect(same.facts.aRecord).toMatchObject({ basis: 'derived', value: '일치', source: 'rule:a-record' });
    expect(same.facts.publicIp).toMatchObject({ basis: 'observed', value: '203.0.113.10' });
    const other = map(ok(example()), { wan: fresh('203.0.113.99') }).nodes.find((n) => n.kind === 'domain')!;
    expect(other.warnings).toEqual(['A 레코드 낡음 가능']);
    expect(other.facts).toMatchObject({ aRecord: { basis: 'derived', source: 'rule:a-record' }, record: { value: '203.0.113.10', basis: 'declared' }, publicIp: { value: '203.0.113.99', basis: 'observed' } });
  });
  it.each([
    ['wan-ip off', { wan: null, wanOff: true }, '비교 불가 · 공인 IP 출처가 없다'],
    ['wan-ip on with no read yet', { wan: null, wanOff: false }, '비교 불가 · 공인 IP를 읽지 못했다'],
    ['a stale public address', { wan: fresh('203.0.113.99', 1801) }, '비교 불가 · 공인 IP가 낡았다'],
    ['a stale address that happens to match', { wan: fresh('203.0.113.10', 1801) }, '비교 불가 · 공인 IP가 낡았다'],
  ])('a-record with %s cannot compare, and that is no match', (_n, o, why) => {
    const d = map(ok(example()), o).nodes.find((n) => n.kind === 'domain')!;
    expect(d.facts.aRecord).toMatchObject({ basis: 'unknown', why });
    expect(d.warnings).toBeUndefined();
  });
  it('address-plan: observed wins over the lease', () => {
    const inPlan = map(ok(example()), {}, [node('node-1', '192.0.2.12')]).get('pve:node:node-1')!;
    expect(inPlan.warnings).toBeUndefined();
    const out = map(ok(example()), {}, [node('node-1', '192.0.2.200')]).get('pve:node:node-1')!;
    expect(out.warnings).toEqual(['계획 밖 주소']);
    expect(out.facts.plan!.source).toBe('rule:address-plan');
  });
  it('address-plan: a stale observation gives way to a newer lease, and a newer observation to nothing', () => {
    const quiet = (addr: string, at: string): Entity => { const n = node('node-1', addr); n.facts.address!.at = at; return n; };
    const e = example(); e.hosts![0]!.lease = { address: '192.0.2.11', seenAt: '2026-11-01' };
    // Observed in the plan long ago, seen outside it since.
    const f = example(); f.hosts![0]!.lease = { address: '192.0.2.200', seenAt: '2026-11-01' };
    expect(map(ok(f), {}, [quiet('192.0.2.12', '2026-10-01T00:00:00.000Z')]).get('pve:node:node-1')!.warnings).toEqual(['계획 밖 주소']);
    // Observed outside it long ago, seen inside it since.
    expect(map(ok(e), {}, [quiet('192.0.2.200', '2026-10-01T00:00:00.000Z')]).get('pve:node:node-1')!.warnings).toBeUndefined();
    // A newer observation still wins.
    expect(map(ok(e), {}, [quiet('192.0.2.200', '2026-11-01T12:00:00.000Z')]).get('pve:node:node-1')!.warnings).toEqual(['계획 밖 주소']);
  });
  it('address-plan: with no observation the lease decides, as for node-3 in the example', () => {
    const e = example(); (e.hosts as unknown as Record<string, unknown>[])[2]!.kind = 'workstation';
    expect(map(ok(e)).get('host:node-3')!.warnings).toEqual(['계획 밖 주소']);
  });
  it('address-plan: no plan means no check, no address means no comparison', () => {
    const e = example(); delete e.hosts![0]!.plan;
    expect(map(ok(e), {}, [node('node-1', '192.0.2.200')]).get('pve:node:node-1')!.facts.plan).toBeUndefined();
    const f = example(); delete f.hosts![3]!.lease; f.hosts![3]!.plan = 'servers';
    expect(map(ok(f)).get('host:workstation')!.facts.plan).toMatchObject({ basis: 'unknown', why: '비교 불가 · 주소가 없다' });
  });
  it('a BMC outside its plan warns on the BMC', () => {
    const e = example(); (e.hosts![0]!.bmc as { lease: { address: string } }).lease.address = '192.0.2.99';
    expect(map(ok(e), {}, [node('node-1', '192.0.2.11')]).get('decl:bmc:node-1')!.warnings).toEqual(['계획 밖 주소']);
  });
  it.each([['bridge', 2, true], ['bridge', 1, false], ['router', 1, true], ['router', 0, true], ['router', 2, false], ['unknown', 3, false]] as const)('nat-layers: %s modem with %i layers warns: %s', (mode, nat, warns) => {
    const e = example(); e.modem!.mode = mode; e.natLayers = nat;
    const g = map(ok(e)).nodes.find((n) => n.kind === 'gateway')!;
    expect(g.warnings ?? []).toEqual(warns ? ['NAT 선언 모순'] : []);
  });
  it('a contradiction shows on the modem when there is no gateway to hold it', () => {
    const e = example(); delete e.router; delete e.modem!.allPortsTo; e.hosts = []; e.addressPlan = []; e.switches = []; e.wifi = []; e.clients = []; e.dnsRecords = []; e.natLayers = 2;
    const m = map(ok(e));
    expect(m.nodes.filter((n) => n.kind === 'gateway')).toEqual([]);
    expect(m.get('decl:modem:modem')).toMatchObject({ warnings: ['NAT 선언 모순'], facts: { natLayers: { value: 2 }, natCheck: { source: 'rule:nat-layers' } } });
  });
  it('a record that points at a proxy cannot be compared with this line', () => {
    const e = example(); e.proxies = [{ key: 'cdn', title: 'CDN' }]; e.dnsRecords![0]!.target = 'cdn';
    const d = map(ok(e), { wan: fresh('203.0.113.99') }).nodes.find((n) => n.kind === 'domain')!;
    expect(d.warnings).toBeUndefined();
    expect(d.facts.aRecord).toMatchObject({ basis: 'unknown', why: '비교 불가 · 프록시를 가리키는 레코드다' });
  });
  it('a record that points at a host behind the router still compares', () => {
    const e = example(); e.dnsRecords![0]!.target = 'workstation';
    expect(map(ok(e), { wan: fresh('203.0.113.99') }).nodes.find((n) => n.kind === 'domain')!.warnings).toEqual(['A 레코드 낡음 가능']);
  });
  it('natLayers: null never warns', () => {
    const e = example(); e.natLayers = null; e.modem!.mode = 'router';
    expect(map(ok(e)).nodes.find((n) => n.kind === 'gateway')!.warnings).toBeUndefined();
  });
  it('inRange takes both ends and refuses what is no address', () => {
    expect(inRange('192.0.2.10', '192.0.2.10', '192.0.2.19')).toBe(true);
    expect(inRange('192.0.2.20', '192.0.2.10', '192.0.2.19')).toBe(false);
    expect(inRange('fe80::1', '192.0.2.10', '192.0.2.19')).toBe(false);
  });
});

async function wired(o: { edge?: unknown; wanUrl?: string } = {}, now?: () => number) {
  const r = await rig(now ? { now } : {});
  const edgePath = join(r.dir, 'edge.json');
  if (o.edge !== undefined) writeFileSync(edgePath, typeof o.edge === 'string' ? o.edge : JSON.stringify(o.edge));
  r.reopen({ edgePath, ...(o.wanUrl ? { wanUrl: o.wanUrl } : {}), local: () => null });
  return { r, edgePath };
}
const src = (r: Rig, id: string) => r.snap().sources.find((s) => s.id === id)!;
const nodeOf = (r: Rig, kind: string) => r.snap().nodes.find((n) => n.kind === kind);

describe('the file through a live map', () => {
  it('no file: source none, the WAN a blank box, nothing declared', async () => {
    const { r } = await wired();
    await r.live.collectOnce();
    expect(src(r, 'edge')).toMatchObject({ state: 'none' });
    expect(nodeOf(r, 'wan')!.basis).toBe('unknown');
    expect(r.snap().nodes.some((n) => n.basis === 'declared')).toBe(false);
    expect(checkNoFake(r.snap())).toEqual([]);
  });
  it('adding the file turns blanks into declarations, deleting it brings them back, even with tower down', async () => {
    const { r, edgePath } = await wired();
    await r.live.collectOnce();
    expect(holes(r.snap()).some((h) => h.key === 'state' && h.label.startsWith('회선'))).toBe(true);
    const unknowns = r.snap().nodes.filter((n) => n.basis === 'unknown').map((n) => n.id);
    writeFileSync(edgePath, JSON.stringify(example()));
    await r.live.collectOnce();
    expect(src(r, 'edge')).toMatchObject({ state: 'ok' });
    expect(nodeOf(r, 'wan')).toMatchObject({ id: 'decl:wan:line-a', basis: 'declared' });
    expect(nodeOf(r, 'gateway')).toMatchObject({ basis: 'declared', title: '거실 공유기' });
    expect(tierCards(r.snap(), Date.now())[0]!.text).toContain('선언');
    expect(validateSnapshot(r.snap())).toEqual([]);
    expect(checkNoFake(r.snap())).toEqual([]);
    for (const n of r.snap().nodes) expect(r.snap().layout[n.id], n.id).toBeDefined();
    await r.mock.close();
    rmSync(edgePath);
    await r.live.collectOnce();
    expect(src(r, 'edge').state).toBe('none');
    expect(r.snap().nodes.filter((n) => n.basis === 'declared')).toEqual([]);
    expect(r.snap().nodes.filter((n) => n.gone && n.basis === 'declared')).toEqual([]);
    expect(r.snap().nodes.filter((n) => n.basis === 'unknown').map((n) => n.id).sort()).toEqual([...unknowns].sort());
  });
  it('a bad file keeps the last good value and says so, and a good one clears it', async () => {
    const { r, edgePath } = await wired({ edge: example() });
    await r.live.collectOnce();
    const declared = r.snap().nodes.filter((n) => n.basis === 'declared').map((n) => n.id);
    expect(declared.length).toBeGreaterThan(5);
    writeFileSync(edgePath, JSON.stringify({ ...example(), password: 'MARKERPW' }));
    await r.live.collectOnce();
    expect(src(r, 'edge')).toMatchObject({ state: 'failing' });
    expect(src(r, 'edge').why).toBe('edge.json 오류 · 최상위: 모르는 칸 1개');
    expect(r.snap().nodes.filter((n) => n.basis === 'declared').map((n) => n.id)).toEqual(declared);
    expect(JSON.stringify(r.snap())).not.toContain('MARKERPW');
    expect(checkNoFake(r.snap())).toEqual([]);
    expect(tierCards(r.snap(), Date.now())[0]!.text).toContain('마지막 선언');
    writeFileSync(edgePath, JSON.stringify(example()));
    await r.live.collectOnce();
    expect(src(r, 'edge').state).toBe('ok');
  });
  it('a bad file at the first read has nothing to keep: failing, not none, and the blanks stay', async () => {
    const { r } = await wired({ edge: '{ broken' });
    await r.live.collectOnce();
    expect(src(r, 'edge')).toMatchObject({ state: 'failing', why: 'edge.json 오류 · JSON이 아니다' });
    expect(nodeOf(r, 'wan')!.basis).toBe('unknown');
  });
  it('a change to the file moves seq, an unchanged file does not', async () => {
    const { r, edgePath } = await wired({ edge: example() });
    await r.live.collectOnce();
    const a = r.snap().seq;
    await r.live.collectOnce();
    expect(r.snap().seq).toBe(a);
    const e = example(); e.lines![0]!.title = '다른 회선';
    writeFileSync(edgePath, JSON.stringify(e));
    await r.live.collectOnce();
    expect(r.snap().seq).toBeGreaterThan(a);
  });
  it('the file stays out of the state file and the change log', async () => {
    const { r } = await wired({ edge: example() });
    await r.live.collectOnce();
    await r.live.stop();
    expect(r.file('state.json') + r.file('changes.jsonl')).not.toMatch(/203\.0\.113|예시 통신|home\.example\.com/);
  });
  it('no declared value reaches the state file or the change log, through an id or otherwise', async () => {
    const e = example();
    // Addresses nothing observed knows, on a map where no guess can match them.
    e.router!.address = '192.0.2.251'; e.router!.lanCidr = '192.0.2.0/24'; e.router!.firmware = 'MARKERFW';
    e.proxies = [{ key: 'p', title: 'MARKERPROXY', address: '192.0.2.252' }];
    const { r } = await wired({ edge: e });
    await r.mock.close();
    await r.live.collectOnce();
    await r.live.stop();
    expect(r.snap().nodes.find((n) => n.kind === 'gateway')!.id).toBe('decl:gateway:edge');
    const kept = r.file('state.json') + r.file('changes.jsonl');
    expect(kept).toContain('decl:gateway:edge'); // ids are there, so the check below reads a real log
    const values: string[] = [];
    const walk = (v: unknown, key = ''): void => {
      if (typeof v === 'string' && !['key', 'line', 'uplink', 'host', 'plan', 'via', 'target', 'allPortsTo', 'type', 'kind', 'mode', 'presence', 'role', 'protocol', 'managedBy', 'interface', 'addressing', 'medium', 'declaredAt', 'reviewBy', 'seenAt', 'bands', 'hosts'].includes(key)) values.push(v);
      else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk(e);
    expect(values.length).toBeGreaterThan(20);
    for (const v of values) expect(kept, v).not.toContain(v);
  });
  it('a real shape from the mock joins the file: gateway named, node leased, its BMC on the slab', async () => {
    const { r } = await wired({ edge: example() });
    await r.live.collectOnce();
    expect(r.entity('pve:node:node-1')!.facts.lease).toMatchObject({ value: '192.0.2.11' });
    expect(r.entity('decl:bmc:node-1')).toMatchObject({ kind: 'bmc', parent: 'pve:node:node-1' });
    expect(r.snap().layout['decl:bmc:node-1']).toBeDefined();
  });
  it('the map draws with no Proxmox at all', async () => {
    const { r } = await wired({ edge: example() });
    await r.mock.close();
    await r.live.collectOnce();
    expect(src(r, 'pve').state).toBe('failing');
    expect(src(r, 'edge').state).toBe('ok');
    expect(nodeOf(r, 'wan')!.basis).toBe('declared');
    expect(checkNoFake(r.snap())).toEqual([]);
  });
  it('a declared client group never goes stale, however long it is away', async () => {
    let now = Date.now();
    const { r } = await wired({ edge: example() }, () => now);
    await r.live.collectOnce();
    now += 365 * 86_400_000;
    expect(staleIds(r.snap(), now).has('decl:clients:mobile')).toBe(false);
  });
  it('drift leaves every source ok', async () => {
    const w = await startWanMock('203.0.113.99');
    const { r } = await wired({ edge: example(), wanUrl: w.url });
    await r.live.collectOnce();
    expect(nodeOf(r, 'domain')!.warnings).toEqual(['A 레코드 낡음 가능']);
    for (const id of ['pve', 'edge', 'wan-ip']) expect(src(r, id).state, id).toBe('ok');
    expect(tierCards(r.snap(), Date.now())[0]!.text).toContain('어긋남 ');
    await w.close();
  });
  it('fixing the A record clears the warning', async () => {
    const w = await startWanMock('203.0.113.10');
    const { r, edgePath } = await wired({ edge: example(), wanUrl: w.url });
    await r.live.collectOnce();
    expect(nodeOf(r, 'domain')!.warnings).toBeUndefined();
    const e = example(); e.dnsRecords![0]!.value = '203.0.113.11';
    writeFileSync(edgePath, JSON.stringify(e));
    await r.live.collectOnce();
    expect(nodeOf(r, 'domain')!.warnings).toEqual(['A 레코드 낡음 가능']);
    await w.close();
  });
  it('a stale public address stops comparing on the edge tick, with tower down', async () => {
    let now = Date.now();
    const w = await startWanMock('203.0.113.99');
    const { r, edgePath } = await wired({ edge: example(), wanUrl: w.url }, () => now);
    await r.live.collectOnce();
    expect(nodeOf(r, 'domain')!.warnings).toBeDefined();
    await r.mock.close();
    now += 31 * 60_000;
    const l = r.live as unknown as { edgeAdapter(p: string): { read(s: AbortSignal): Promise<unknown> }; applyEdge(x: unknown): Promise<void> };
    await l.applyEdge(await l.edgeAdapter(edgePath).read(new AbortController().signal));
    expect(nodeOf(r, 'domain')!.warnings).toBeUndefined();
    expect(nodeOf(r, 'domain')!.facts.aRecord).toMatchObject({ basis: 'unknown', why: '비교 불가 · 공인 IP가 낡았다' });
    await w.close();
  });
  it('a failed public-address read keeps the last value, with its old time', async () => {
    const w = await startWanMock('203.0.113.99');
    const { r } = await wired({ edge: example(), wanUrl: w.url });
    await r.live.collectOnce();
    const at = nodeOf(r, 'wan')!.facts.publicIp!.at;
    w.state.status = 500;
    await new Promise((res) => setTimeout(res, 5));
    await r.live.collectOnce();
    expect(src(r, 'wan-ip')).toMatchObject({ state: 'failing', why: '공인 IP 응답 없음' });
    expect(nodeOf(r, 'wan')!.facts.publicIp).toMatchObject({ value: '203.0.113.99', at });
    await w.close();
  });
});

describe('wan-ip', () => {
  it('off: source none, and relief makes no outside call at all', async () => {
    const seen: string[] = [];
    const real = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((u, i) => { seen.push(String(u)); return real(u, i); });
    const { r } = await wired({ edge: example() });
    await r.live.collectOnce();
    spy.mockRestore();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((u) => !u.startsWith(r.mock.url))).toEqual([]);
    expect(src(r, 'wan-ip')).toMatchObject({ state: 'none' });
    const d = nodeOf(r, 'domain')!;
    expect(d.facts.aRecord).toMatchObject({ why: '비교 불가 · 공인 IP 출처가 없다' });
    expect(nodeOf(r, 'wan')!.facts.publicIp).toMatchObject({ basis: 'unknown' });
    expect(holes(r.snap()).some((h) => h.key === 'publicIp' && h.action.includes('publicIpUrl'))).toBe(true);
  });
  it('on: one GET per collection to the configured URL, nothing else, and no credential', async () => {
    const w = await startWanMock('203.0.113.7');
    const seen: { url: string; init?: RequestInit }[] = [];
    const real = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((u, i) => { if (String(u) === w.url) seen.push({ url: String(u), ...(i ? { init: i } : {}) }); return real(u, i); });
    const { r } = await wired({ wanUrl: w.url });
    await r.live.collectOnce();
    spy.mockRestore();
    expect(w.hits.value).toBe(1);
    expect(seen[0]!.init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(JSON.stringify(seen[0]!.init?.headers)).not.toMatch(/authorization|bearer/i);
    expect(nodeOf(r, 'wan')!.facts.publicIp).toMatchObject({ basis: 'observed', value: '203.0.113.7', source: 'wan-ip:', ttlS: 1800 });
    await w.close();
  });
  it.each([['HTML', '<html>hi</html>'], ['IPv6', '2001:db8::1'], ['a long body', '1'.repeat(1000)], ['a valid address padded past the limit', `${' '.repeat(1000)}203.0.113.7`], ['two addresses', '203.0.113.1 203.0.113.2'], ['nothing', '']])('refuses %s', async (_n, body) => {
    const w = await startWanMock('203.0.113.7');
    w.state.body = body;
    await expect(readPublicIp(w.url)).rejects.toMatchObject({ why: '공인 IP 형식이 아니다' });
    await w.close();
  });
  it.each(['10.x.x.x', '172.x.x.x', '192.168.x.x', '127.0.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.1', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.0.1'])('refuses %s, which is no public address', async (a) => {
    const w = await startWanMock(a);
    await expect(readPublicIp(w.url)).rejects.toMatchObject({ why: '공인 주소가 아니다' });
    await w.close();
  });
  it('the source says why, and the last good value stays', async () => {
    const w = await startWanMock('203.0.113.7');
    const { r } = await wired({ wanUrl: w.url });
    await r.live.collectOnce();
    w.state.body = '192.168.x.x\n';
    await r.live.collectOnce();
    expect(src(r, 'wan-ip')).toMatchObject({ state: 'failing', why: '공인 주소가 아니다' });
    expect(nodeOf(r, 'wan')!.facts.publicIp!.value).toBe('203.0.113.7');
    await w.close();
  });
  it('documentation ranges pass only for a local mock', () => {
    expect(isPublicV4('203.0.113.7', true)).toBe(true);
    expect(isPublicV4('203.0.113.7')).toBe(false);
    expect(isPublicV4('198.51.100.7')).toBe(false);
    expect(isPublicV4('192.0.2.7')).toBe(false);
    expect(isPublicV4('8.8.8.8')).toBe(true);
    expect(isPublicV4('172.32.0.1')).toBe(true);
    expect(isPublicV4('fe80::1')).toBe(false);
  });
  it('a service that never answers, or stalls mid-body, is bounded by the timeout', async () => {
    const silent = http.createServer(() => {});
    const stall = http.createServer((_q, res) => { res.writeHead(200); res.write('203.'); });
    for (const s of [silent, stall]) {
      await new Promise<void>((x) => s.listen(0, '127.0.0.1', () => x()));
      const t0 = Date.now();
      await expect(readPublicIp(`http://127.0.0.1:${(s.address() as { port: number }).port}/`, undefined, 150)).rejects.toMatchObject({ why: '공인 IP 응답 없음' });
      expect(Date.now() - t0).toBeLessThan(2000);
      s.closeAllConnections(); s.close();
    }
  });
  it('takes a trailing newline, follows no redirect', async () => {
    const w = await startWanMock('203.0.113.7');
    await expect(readPublicIp(w.url)).resolves.toBe('203.0.113.7');
    const t = await startWanMock('203.0.113.8');
    w.state.status = 302; w.state.location = t.url; w.state.body = '';
    await expect(readPublicIp(w.url)).rejects.toMatchObject({ why: '공인 IP 응답 없음' });
    expect(t.hits.value).toBe(0);
    await w.close(); await t.close();
  });
  it('the URL must be https, or http on loopback', () => {
    expect(publicIpUrl('https://example.com/ip')).toBe('https://example.com/ip');
    expect(publicIpUrl('http://127.0.0.1:9/')).toBe('http://127.0.0.1:9/');
    for (const u of ['http://example.com/', 'ftp://example.com/', 'https://u:p@example.com/', 'nonsense']) expect(() => publicIpUrl(u), u).toThrow();
  });
  it('a bad URL fails wan-ip alone: Proxmox and the edge file read on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relief-badurl-'));
    const mock = await startMock({ port: 0, token: TOKEN });
    mkdirSync(join(dir, 'tower'));
    writeFileSync(join(dir, 'tower/token'), TOKEN, { mode: 0o600 });
    writeFileSync(join(dir, 'relief.json'), JSON.stringify({ towerUrl: mock.url, publicIpUrl: 'http://example.com/ip' }));
    writeFileSync(join(dir, 'edge.json'), JSON.stringify(example()));
    const s = await startLive({ port: 0, dist: dir, env: { TOWER_CONFIG: join(dir, 'tower/tower.json'), RELIEF_CONFIG: dir, RELIEF_STATE: join(dir, 'state') } });
    await s.live.collectOnce();
    const st = s.live.view().snapshot.sources;
    expect(st.find((x) => x.id === 'wan-ip')).toMatchObject({ state: 'failing', why: 'publicIpUrl 설정 오류' });
    expect(st.find((x) => x.id === 'pve')!.state).toBe('ok');
    expect(st.find((x) => x.id === 'edge')!.state).toBe('ok');
    expect(mock.calls.length).toBeGreaterThan(0);
    const lines: string[] = [];
    expect(await check({ env: { TOWER_CONFIG: join(dir, 'tower/tower.json'), RELIEF_CONFIG: dir }, print: (l) => lines.push(l) })).toBe(1);
    expect(lines).toContain('publicIpUrl: publicIpUrl 설정 오류');
    await s.close(); await mock.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it.each([['a number', 5], ['a list', ['https://example.com/']]])('%s for a URL fails the same way', (_n, v) => {
    const dir = mkdtempSync(join(tmpdir(), 'relief-cfg-'));
    const paths = resolvePaths({ RELIEF_CONFIG: dir, TOWER_CONFIG: join(dir, 'tower.json') });
    writeFileSync(paths.reliefJson, JSON.stringify({ publicIpUrl: v }));
    expect(loadConfig(paths)).toMatchObject({ publicIpError: 'publicIpUrl 설정 오류' });
    expect(loadConfig(paths).error).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
  it('relief.json carries it, and no default exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relief-cfg-'));
    const paths = resolvePaths({ RELIEF_CONFIG: dir, TOWER_CONFIG: join(dir, 'tower.json') });
    expect(loadConfig(paths).publicIpUrl).toBeUndefined();
    writeFileSync(paths.reliefJson, '{}');
    expect(loadConfig(paths).publicIpUrl).toBeUndefined();
    writeFileSync(paths.reliefJson, JSON.stringify({ publicIpUrl: 'https://example.com/ip' }));
    expect(loadConfig(paths).publicIpUrl).toBe('https://example.com/ip');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('relief check', () => {
  const cfg = () => {
    const dir = mkdtempSync(join(tmpdir(), 'relief-chk-'));
    mkdirSync(join(dir, 'tower'));
    return { dir, env: { RELIEF_CONFIG: dir, TOWER_CONFIG: join(dir, 'tower/tower.json'), RELIEF_STATE: join(dir, 'state') } as NodeJS.ProcessEnv };
  };
  it('passes a good file, fails a bad one, and prints no value from it', async () => {
    const { dir, env } = cfg();
    const lines: string[] = [];
    writeFileSync(join(dir, 'edge.json'), JSON.stringify(example()));
    expect(await check({ env, print: (l) => lines.push(l) })).toBe(0);
    expect(lines).toContain('edge.json: ok');
    writeFileSync(join(dir, 'edge.json'), JSON.stringify({ ...example(), password: 'MARKERPW' }));
    lines.length = 0;
    expect(await check({ env, print: (l) => lines.push(l) })).toBe(1);
    expect(lines).toContain('edge.json: 최상위: 모르는 칸 1개');
    expect(lines.join('\n')).not.toMatch(/MARKERPW|password|203\.0\.113/);
    rmSync(dir, { recursive: true, force: true });
  });
  it('no file and no URL are both fine, and said', async () => {
    const { dir, env } = cfg();
    const lines: string[] = [];
    expect(await check({ env, print: (l) => lines.push(l) })).toBe(0);
    expect(lines).toEqual(expect.arrayContaining(['edge.json: none', 'publicIpUrl: none, wan-ip off']));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('what backs a rule', () => {
  it.each(['a-record', 'address-plan', 'nat-layers'])('rule %s stands on the edge file', (rule) => {
    const s = { schema: 1, seq: 1, takenAt: 'x', nodes: [{ id: 'a', kind: 'domain', title: 'a', basis: 'derived', state: 'ok', facts: { x: { value: 'v', basis: 'derived', source: `rule:${rule}`, at: null, ttlS: null } } }], edges: [], layout: {}, routes: {}, sources: [{ id: 'edge', state: 'none', count: null, at: null }] } as unknown as Snapshot;
    expect(checkNoFake(s).join()).toContain('source edge is none');
    s.sources[0]!.state = 'ok';
    expect(checkNoFake(s)).toEqual([]);
  });
  it('a declared fact needs the edge source, and an observed public address the wan source', () => {
    const fact = (source: string) => ({ value: 'v', basis: 'observed', source, at: null, ttlS: 1 });
    const s = { nodes: [{ id: 'a', kind: 'wan', title: 'a', basis: 'unknown', state: 'ok', facts: { p: fact('wan-ip:') } }], edges: [], sources: [{ id: 'wan-ip', state: 'none', count: null, at: null }] } as unknown as Snapshot;
    expect(checkNoFake(s).join()).toContain('source wan-ip is none');
  });
});

describe('a restart', () => {
  const cycle = async (r: Rig, o: object) => {
    const l = r.reopen(o);
    await l.start();
    await new Promise((res) => setTimeout(res, 400));
    await l.stop();
  };
  it('with the same file logs no change and leaves seq alone', async () => {
    const r = await rig();
    const edgePath = join(r.dir, 'edge.json');
    writeFileSync(edgePath, JSON.stringify(example()));
    const o = { edgePath, local: () => null };
    await cycle(r, o);
    const log = r.file('changes.jsonl'); const seq = r.snap().seq;
    expect(seq).toBeGreaterThan(0);
    await cycle(r, o);
    await cycle(r, o);
    expect(r.file('changes.jsonl')).toBe(log);
    expect(r.snap().seq).toBe(seq);
  });
  it('and with a public address too, drift included', async () => {
    const w = await startWanMock('203.0.113.99');
    const r = await rig();
    const edgePath = join(r.dir, 'edge.json');
    writeFileSync(edgePath, JSON.stringify(example()));
    const o = { edgePath, wanUrl: w.url, local: () => null };
    await cycle(r, o);
    const log = r.file('changes.jsonl'); const seq = r.snap().seq;
    expect(nodeOf(r, 'domain')!.warnings).toBeDefined();
    await cycle(r, o);
    expect(r.file('changes.jsonl')).toBe(log);
    expect(r.snap().seq).toBe(seq);
    await w.close();
  });
  it('with tower down the declared map is there from the first build', async () => {
    const r = await rig();
    const edgePath = join(r.dir, 'edge.json');
    writeFileSync(edgePath, JSON.stringify(example()));
    await r.mock.close();
    const l = r.reopen({ edgePath, local: () => null });
    await l.start();
    expect(nodeOf(r, 'wan')!.basis).toBe('declared');
  });
});

describe('relief serve wires the sources in', () => {
  it('reads edge.json from the config directory and gives the workstation this machine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relief-wire-'));
    const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    const e = example(); e.router!.lanCidr = lan ? `${lan}/32` : '192.0.2.0/24'; delete e.router!.dhcpRange; e.addressPlan = []; e.hosts = e.hosts!.filter((h) => h.kind === 'workstation').map(({ lease: _l, plan: _p, ...h }) => h); e.switches = []; delete e.router!.address;
    writeFileSync(join(dir, 'edge.json'), JSON.stringify(e));
    const s = await startLive({ port: 0, dist: dir, env: { TOWER_CONFIG: join(dir, 'tower/tower.json'), RELIEF_CONFIG: dir, RELIEF_STATE: join(dir, 'state') } });
    const snap = s.live.view().snapshot;
    expect(snap.sources.find((x) => x.id === 'edge')!.state).toBe('ok');
    expect(snap.nodes.find((n) => n.kind === 'wan')!.basis).toBe('declared');
    await s.close();
    const a = snap.nodes.find((n) => n.kind === 'workstation')!.facts.address;
    expect(a?.basis === 'observed' ? a.source : 'local:os').toBe('local:os');
    expect(snap.nodes.find((n) => n.kind === 'workstation')!.facts.hostname?.basis ?? 'observed').toBe('observed');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('what the code must not do', () => {
  const root = fileURLToPath(new URL('../server/', import.meta.url));
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const sources = () => walk(root).map((f) => [f.slice(root.length), readFileSync(f, 'utf8')] as const);
  it('no code writes DNS: no write verb, no resolver, no registrar', () => {
    for (const [f, t] of sources()) {
      expect(t, f).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)/i);
      expect(t, f).not.toMatch(/node:dns|registrar\b/i);
    }
  });
  it('only these files reach the network, and only wanip.ts leaves loopback', () => {
    const net = sources().filter(([, t]) => /\bfetch\(/.test(t)).map(([f]) => f).sort();
    expect(net).toEqual(['check.ts', 'collect/mcp.ts', 'collect/wanip.ts']);
  });
  it('no default public-address URL anywhere in the code', () => {
    for (const [f, t] of sources()) expect(t, f).not.toMatch(/ipify|icanhazip|checkip|ifconfig\.me/i);
  });
  it('the edge reader only reads', () => {
    const t = readFileSync(join(root, 'collect/edge.ts'), 'utf8');
    expect(t).not.toMatch(/\b(writeFile|appendFile|rename|unlink|rm|mkdir|chmod|copyFile)(Sync)?\(/);
  });
});
