// The hand-written edge file (design 7.1). Strict on purpose: an unknown key is an error, so `password` cannot get in. This file only reads.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isIP } from 'node:net';
import { z } from 'zod';
import { clean } from '../model/guest.ts';
import { inNetwork, networkOf, v4 } from '../model/rules.ts';

export const MAX_FILE_BYTES = 256 * 1024;
const REVIEW_DAYS = 90;

/** Free text is the writer's own, and still data: cut and stripped like anything else on the screen. */
const text = (n = 64) => z.string().min(1).max(4096).transform((s) => clean(s, n));
const key = z.string().regex(/^[\w.-]{1,64}$/);
const title = text(64);
const ipv4 = z.string().max(15).refine((a) => isIP(a) === 4 && !a.includes('%'));
const cidr = z.string().max(18).refine((c) => networkOf(c) !== null);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(d)));
const hostname = z.string().max(253).regex(/^(?=.*[a-z])[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i);
const port = z.number().int().min(1).max(65535);
const range = z.union([port, z.tuple([port, port]).refine(([a, b]) => a <= b)]);
const lease = z.strictObject({ address: ipv4, seenAt: date });
const bmc = z.strictObject({ interface: z.enum(['dedicated', 'shared', 'unknown']).optional(), lease: lease.optional(), plan: key.optional() });

const Shape = z.strictObject({
  schema: z.literal(1),
  declaredAt: date,
  reviewBy: date.optional(),
  natLayers: z.number().int().min(0).max(8).nullable().optional(),
  lines: z.array(z.strictObject({ key, title, isp: text().optional(), medium: text().optional(), downMbps: z.number().nonnegative().optional(), upMbps: z.number().nonnegative().optional(), addressing: z.enum(['dynamic', 'static', 'cgnat', 'unknown']).optional() })).max(16).optional(),
  modem: z.strictObject({ key, title, line: key, mode: z.enum(['bridge', 'router', 'unknown']), allPortsTo: key.optional(), vendor: text().optional(), model: text().optional() }).optional(),
  router: z.strictObject({ key, title, vendor: text().optional(), model: text().optional(), firmware: text().optional(), uplink: key, address: ipv4.optional(), lanCidr: cidr.optional(), dhcpRange: z.tuple([ipv4, ipv4]).optional() }).optional(),
  dnsRecords: z.array(z.strictObject({ key, provider: text(), hostname, type: z.literal('A'), value: ipv4.optional(), managedBy: z.enum(['hand', 'ddns']).optional(), target: key.optional() })).max(64).optional(),
  ddns: z.array(z.strictObject({ key, provider: text(), hostname, line: key })).max(16).optional(),
  portForwards: z.array(z.strictObject({ key, title, protocol: z.enum(['tcp', 'udp', 'tcp+udp']), externalPort: range, internalPort: range, host: key, enabled: z.boolean() })).max(128).optional(),
  addressPlan: z.array(z.strictObject({ key, title, from: ipv4, to: ipv4 })).max(32).optional(),
  hosts: z.array(z.strictObject({ key, title, kind: z.enum(['pve-node', 'workstation', 'other']), pveNode: key.optional(), lease: lease.optional(), plan: key.optional(), bmc: z.union([z.literal('none'), bmc]).optional() })).max(128).optional(),
  vpn: z.array(z.strictObject({ key, title, protocol: z.enum(['wireguard', 'openvpn', 'l2tp', 'pptp', 'ipsec', 'other']), role: z.enum(['server', 'client']), port: port.optional(), subnet: cidr.optional(), enabled: z.boolean() })).max(16).optional(),
  wifi: z.array(z.strictObject({ key, title, bands: z.array(z.enum(['2.4', '5', '6'])).max(3), guest: z.boolean().optional(), enabled: z.boolean() })).max(16).optional(),
  clients: z.array(z.strictObject({ key, title, via: key.optional(), presence: z.enum(['intermittent', 'steady']), devices: z.array(z.strictObject({ key, title, kind: z.enum(['phone', 'tablet', 'other']) })).max(64).optional() })).max(16).optional(),
  switches: z.array(z.strictObject({ key, title, model: text().optional(), ports: z.number().int().min(1).max(256).optional(), uplink: key, hosts: z.array(key).max(128).optional() })).max(32).optional(),
  proxies: z.array(z.strictObject({ key, title, address: ipv4.optional() })).max(16).optional(),
});
export type EdgeFile = z.infer<typeof Shape>;

/** The checks one field cannot make: every `key` a value points at exists, and every address sits inside `lanCidr`. */
function references(f: EdgeFile, ctx: z.RefinementCtx) {
  const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const keys = (l?: { key: string }[]) => new Set((l ?? []).map((x) => x.key));
  const lists = { lines: f.lines, dnsRecords: f.dnsRecords, ddns: f.ddns, portForwards: f.portForwards, addressPlan: f.addressPlan, hosts: f.hosts, vpn: f.vpn, wifi: f.wifi, clients: f.clients, switches: f.switches, proxies: f.proxies };
  for (const [name, l] of Object.entries(lists)) {
    const seen = new Set<string>();
    (l ?? []).forEach((x, i) => { if (seen.has(x.key)) bad([name, i, 'key'], 'duplicate key'); seen.add(x.key); });
  }
  const lines = keys(f.lines); const hosts = keys(f.hosts); const plans = keys(f.addressPlan); const wifi = keys(f.wifi); const switches = keys(f.switches); const proxies = keys(f.proxies);
  const need = (ok: boolean, path: (string | number)[]) => { if (!ok) bad(path, 'points at a key that does not exist'); };
  if (f.modem) {
    need(lines.has(f.modem.line), ['modem', 'line']);
    if (f.modem.allPortsTo !== undefined) need(f.modem.allPortsTo === f.router?.key, ['modem', 'allPortsTo']);
  }
  if (f.router) need(f.router.uplink === f.modem?.key || lines.has(f.router.uplink), ['router', 'uplink']);
  f.dnsRecords?.forEach((d, i) => { if (d.target !== undefined) need(d.target === f.router?.key || proxies.has(d.target) || hosts.has(d.target), ['dnsRecords', i, 'target']); });
  f.ddns?.forEach((d, i) => need(lines.has(d.line), ['ddns', i, 'line']));
  f.portForwards?.forEach((p, i) => need(hosts.has(p.host), ['portForwards', i, 'host']));
  f.hosts?.forEach((h, i) => {
    if (h.plan !== undefined) need(plans.has(h.plan), ['hosts', i, 'plan']);
    if (typeof h.bmc === 'object' && h.bmc.plan !== undefined) need(plans.has(h.bmc.plan), ['hosts', i, 'bmc', 'plan']);
  });
  f.clients?.forEach((c, i) => { if (c.via !== undefined) need(wifi.has(c.via), ['clients', i, 'via']); });
  f.switches?.forEach((s, i) => {
    need(s.uplink === f.router?.key || switches.has(s.uplink), ['switches', i, 'uplink']);
    s.hosts?.forEach((h, j) => need(hosts.has(h), ['switches', i, 'hosts', j]));
  });
  f.addressPlan?.forEach((p, i) => { if (v4(p.from)! > v4(p.to)!) bad(['addressPlan', i], 'range runs backwards'); });
  const lan = f.router?.lanCidr ? networkOf(f.router.lanCidr) : null;
  if (!lan) return;
  const inside = (a: string | undefined, path: (string | number)[]) => { if (a !== undefined && !inNetwork(a, lan)) bad(path, 'outside lanCidr'); };
  f.router?.dhcpRange?.forEach((a, i) => inside(a, ['router', 'dhcpRange', i]));
  f.addressPlan?.forEach((p, i) => { inside(p.from, ['addressPlan', i, 'from']); inside(p.to, ['addressPlan', i, 'to']); });
  f.hosts?.forEach((h, i) => {
    inside(h.lease?.address, ['hosts', i, 'lease', 'address']);
    if (typeof h.bmc === 'object') inside(h.bmc.lease?.address, ['hosts', i, 'bmc', 'lease', 'address']);
  });
}

const Edge = Shape.superRefine(references);

export const reviewByOf = (f: EdgeFile) => f.reviewBy ?? new Date(Date.parse(f.declaredAt) + REVIEW_DAYS * 86_400_000).toISOString().slice(0, 10);

export type EdgeRead = { kind: 'none' } | { kind: 'bad'; why: string } | { kind: 'ok'; file: EdgeFile };

/** Names the place, never the value: the file holds addresses, and this text reaches the screen and the terminal. */
const describe = (e: z.ZodError) => {
  const first = e.issues[0];
  // A count: a mistyped key can itself be a secret someone pasted in the wrong place.
  const what = first?.code === 'custom' ? first.message : first?.code === 'unrecognized_keys' ? `모르는 칸 ${first.keys.length}개` : first?.code;
  return `${first?.path.join('.') || '최상위'}: ${what}`.slice(0, 200);
};

export function parseEdge(raw: string): EdgeRead {
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return { kind: 'bad', why: 'JSON이 아니다' }; }
  const r = Edge.safeParse(json);
  return r.success ? { kind: 'ok', file: r.data } : { kind: 'bad', why: describe(r.error) };
}

/** A regular file and nothing else. O_NOFOLLOW refuses a symlink, O_NONBLOCK keeps a FIFO from stopping the event loop, and the read stops at the cap whatever `size` said. */
export function readEdge(path: string): EdgeRead {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'none' };
    return { kind: 'bad', why: code === 'ELOOP' ? '심볼릭 링크는 받지 않는다' : '파일을 읽지 못했다' };
  }
  try {
    if (!fstatSync(fd).isFile()) return { kind: 'bad', why: '일반 파일이 아니다' };
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    let got = 0;
    for (let n = readSync(fd, buf, got, buf.length - got, null); n > 0; n = got < buf.length ? readSync(fd, buf, got, buf.length - got, null) : 0) got += n;
    if (got > MAX_FILE_BYTES) return { kind: 'bad', why: '파일이 256 KiB를 넘는다' };
    return parseEdge(buf.subarray(0, got).toString('utf8'));
  } catch { return { kind: 'bad', why: '파일을 읽지 못했다' }; } finally { closeSync(fd); }
}
