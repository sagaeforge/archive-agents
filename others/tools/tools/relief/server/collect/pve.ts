// Reads of the Proxmox source (design 6.4, 8). Each read keeps the chosen fields and drops the rest here, so nothing else reaches the snapshot.
import { z } from 'zod';
import { guestText, parseIps, type AgentIps } from '../model/guest.ts';
import { validId, validNode, type Target } from './allowlist.ts';
import { ReadError, type Reader } from './mcp.ts';

const num = z.number().optional();
const str = z.string().optional();

const Resource = z.object({
  type: z.string(), id: z.string(), node: str, status: str, name: str, storage: str, tags: str,
  vmid: z.union([z.number(), z.string()]).optional(),
  cpu: num, mem: num, maxmem: num, disk: num, maxdisk: num, uptime: num, template: num, shared: num,
});
export type Resource = z.infer<typeof Resource>;

const StatusRow = z.object({ type: z.string(), name: str, ip: str, online: num, quorate: num });
export type StatusRow = z.infer<typeof StatusRow>;

const TaskRow = z.object({ node: z.string(), type: z.string(), id: str, starttime: z.number(), endtime: num, status: str });
/** `ok` is null while the task runs. The status text stays out: a failed one can quote a whole command line. */
export type Task = { node: string; type: string; id: string; start: number; end: number | null; ok: boolean | null };
const finished = (s: string) => s === 'OK' || /^WARNINGS: \d+$/.test(s);
// PVE gives a running task no `endtime` and no `status` [measured 2026-11-01].
const toTask = (t: z.infer<typeof TaskRow>): Task => ({ node: t.node, type: t.type, id: t.id ?? '', start: t.starttime, end: t.endtime ?? null, ok: t.status === undefined ? null : finished(t.status) });

const Iface = z.object({ iface: z.string(), type: z.string(), active: num, method: str, cidr: str, address: str, netmask: str, gateway: str, bridge_ports: str, bridge_vlan_aware: num });
export type Bridge = { iface: string; active: boolean; method: string | null; cidr: string | null; gateway: string | null };
const toBridges = (rows: z.infer<typeof Iface>[]): Bridge[] => rows.filter((r) => r.type === 'bridge' || r.type === 'OVSBridge').map((r) => ({
  iface: r.iface, active: r.active === 1, method: r.method ?? null,
  cidr: r.cidr ?? (r.address && r.netmask ? `${r.address}/${r.netmask}` : null), gateway: r.gateway ?? null,
}));

const Dns = z.object({ dns1: str, dns2: str, dns3: str, search: str });
const Rows = z.array(z.unknown());

const Metric = z.object({ data: z.array(z.object({ id: z.string(), metric: z.string(), value: z.number() })) });

const AgentIfaces = z.object({ result: z.array(z.object({ name: z.string(), 'ip-addresses': z.array(z.object({ 'ip-address': z.unknown().optional() })).optional() })) });
const AgentOs = z.object({ result: z.object({ 'pretty-name': z.unknown().optional(), name: z.unknown().optional() }) });

export type Nic = { key: string; bridge: string | null; tag: number | null; firewall: boolean; ip: string | null };
export type GuestConfig = { nics: Nic[]; disks: string[]; ostype: string | null; cores: number | null; memoryMb: number | null };

const toInt = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };

const pair = (spec: string, key: string): string | null => {
  for (const part of spec.split(',')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i) === key) return part.slice(i + 1); }
  return null;
};

/** Named keys only. `cipassword`, `sshkeys`, `description` and `hookscript` never get past this, and of a NIC only its wiring does: no MAC. */
export function toConfig(raw: unknown): GuestConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ReadError('path', '응답 모양이 다르다');
  const nics: Nic[] = []; const disks = new Set<string>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    if (/^net\d+$/.test(k)) {
      const ip = pair(v, 'ip');
      nics.push({ key: k, bridge: pair(v, 'bridge'), tag: toInt(pair(v, 'tag')), firewall: pair(v, 'firewall') === '1', ip: ip && /^[0-9a-f:.]+\/\d+$/i.test(ip) ? ip : null });
    } else if (/^((scsi|sata|ide|virtio|mp)\d+|rootfs)$/.test(k) && !v.includes('media=cdrom')) {
      const store = /^([\w.-]+):/.exec(v)?.[1];
      if (store) disks.add(store);
    }
  }
  const c = raw as Record<string, unknown>;
  return { nics, disks: [...disks], ostype: typeof c.ostype === 'string' ? c.ostype : null, cores: toInt(c.cores), memoryMb: toInt(c.memory) };
}

const parse = <T>(schema: z.ZodType<T>, v: unknown): T => {
  const r = schema.safeParse(v);
  if (!r.success) throw new ReadError('path', '응답 모양이 다르다');
  return r.data;
};

export const isSource = (e: unknown): e is ReadError => e instanceof ReadError && e.scope === 'source';
/** Anything thrown by a read, as its reason. An unexpected throw counts as this path failing. */
export const whyOf = (e: unknown) => (e instanceof ReadError ? e.why : '읽기 실패');

export type Tried<T> = { ok: true; value: T } | { ok: false; error: unknown };
const tried = <T>(p: Promise<T>): Promise<Tried<T>> => p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

export type FastRead = { resources: Tried<Resource[]>; status: Tried<StatusRow[]>; tasks: Tried<Task[]> };

/** Sent together: the worst case is 24 s, not 72 s (design 6.5). */
export async function readFast(r: Reader, signal: AbortSignal): Promise<FastRead> {
  const [resources, status, tasks] = await Promise.all([
    tried(r.read({ tool: 'proxmox_list_resources' }, signal).then((v) => parse(z.array(Resource), v))),
    tried(r.read({ tool: 'proxmox_api_get', path: '/cluster/status' }, signal).then((v) => parse(z.array(StatusRow), v))),
    tried(r.read({ tool: 'proxmox_recent_tasks' }, signal).then((v) => parse(z.array(TaskRow), v).map(toTask))),
  ]);
  return { resources, status, tasks };
}

export type NodeRead = { network: Tried<Bridge[]>; dns: Tried<string[]>; fw: Tried<number> };
export type SlowRead = { nodes: Record<string, NodeRead>; zones: Tried<number>; vnets: Tried<number>; fw: Tried<number> };

const count = (r: Reader, path: string, signal: AbortSignal) => tried(r.read({ tool: 'proxmox_api_get', path }, signal).then((v) => parse(Rows, v).length));

export async function readSlow(r: Reader, nodes: string[], signal: AbortSignal): Promise<SlowRead> {
  const out: SlowRead['nodes'] = {};
  for (const n of nodes) {
    if (!validNode(n)) continue;
    const [network, dns, fw] = await Promise.all([
      tried(r.read({ tool: 'proxmox_api_get', path: `/nodes/${n}/network` }, signal).then((v) => toBridges(parse(z.array(Iface), v)))),
      tried(r.read({ tool: 'proxmox_api_get', path: `/nodes/${n}/dns` }, signal).then((v) => { const d = parse(Dns, v); return [d.dns1, d.dns2, d.dns3].filter((x): x is string => !!x); })),
      count(r, `/nodes/${n}/firewall/rules`, signal),
    ]);
    out[n] = { network, dns, fw };
  }
  const [zones, vnets, fw] = await Promise.all([count(r, '/cluster/sdn/zones', signal), count(r, '/cluster/sdn/vnets', signal), count(r, '/cluster/firewall/rules', signal)]);
  return { nodes: out, zones, vnets, fw };
}

export type GuestRef = { kind: 'qemu' | 'lxc'; vmid: number; node: string; running: boolean };
export type GuestRead = { config: Tried<GuestConfig>; ip: Tried<AgentIps> | null; os: Tried<string | null> | null };

const ROUTABLE = (a: string) => !/^(127\.|::1$|fe80:)/i.test(a);

export async function readGuest(r: Reader, g: GuestRef, signal: AbortSignal): Promise<GuestRead> {
  const agent = (leaf: string): Target => ({ tool: 'proxmox_api_get', path: `/nodes/${g.node}/qemu/${g.vmid}/agent/${leaf}` });
  const config = await tried(r.read({ tool: 'proxmox_guest_config', node: g.node, vmid: g.vmid, kind: g.kind }, signal).then(toConfig));
  if (g.kind !== 'qemu' || !g.running) return { config, ip: null, os: null };
  const [ip, os] = await Promise.all([
    // Interface names steer this filter and go no further: they are never stored.
    tried(r.read(agent('network-get-interfaces'), signal).then((v) => parseIps(parse(AgentIfaces, v).result.filter((i) => i.name !== 'lo').flatMap((i) => (i['ip-addresses'] ?? []).map((a) => a['ip-address'])).filter((a) => typeof a !== 'string' || ROUTABLE(a))))),
    tried(r.read(agent('get-osinfo'), signal).then((v) => { const o = parse(AgentOs, v).result; const os = guestText(o['pretty-name']) ?? guestText(o.name); if (os === null) throw new ReadError('path', '응답 모양이 다르다'); return os; })),
  ]);
  return { config, ip, os };
}

export type MetricValues = Record<string, { cpu?: number; mem?: number; disk?: number }>;

/** PVE's own ids to ours. An id we do not map is dropped. */
const entityOf = (id: string): string | null => {
  let m;
  if ((m = /^node\/(.+)$/.exec(id))) return `pve:node:${m[1]}`;
  if ((m = /^(qemu|lxc)\/(\d+)$/.exec(id))) return `pve:${m[1]}:${m[2]}`;
  if ((m = /^storage\/([^/]+)\/(.+)$/.exec(id))) return `pve:st:${m[1]}:${m[2]}`;
  return null;
};

export async function readMetrics(r: Reader, signal: AbortSignal): Promise<MetricValues> {
  const rows = parse(Metric, await r.read({ tool: 'proxmox_api_get', path: '/cluster/metrics/export' }, signal)).data;
  const raw = new Map<string, Record<string, number>>();
  for (const x of rows) { const id = entityOf(x.id); if (id) (raw.get(id) ?? raw.set(id, {}).get(id)!)[x.metric] = x.value; }
  const frac = (a?: number, b?: number) => (a !== undefined && b ? Math.round((a / b) * 1e4) / 1e4 : undefined);
  const out: MetricValues = {};
  for (const [id, m] of raw) {
    // A QEMU guest's 0 means PVE does not know, as on /cluster/resources: it must not replace an honest blank.
    const blank = id.startsWith('pve:qemu:') && !m.disk_used;
    const v = { cpu: m.cpu_current, mem: frac(m.mem_used, m.mem_total), disk: blank ? undefined : frac(m.disk_used, m.disk_total) };
    out[id] = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined));
  }
  return out;
}

export { validId, validNode };
