// Raw reads -> entities and relations (design 3, 4, 8). Pure: a failed read changes nothing in `Raw`, so its facts keep their `at` and go stale on their own.
import type { Bridge, GuestConfig, Resource, StatusRow, Task } from '../collect/pve.ts';
import { validId, validNode } from '../collect/allowlist.ts';
import type { Basis, Entity, Fact, Relation, State } from './fact.ts';
import { overlayEdge, type External } from './edgemap.ts';
import { clean, guestText, parseIps, type AgentIps } from './guest.ts';
import { inNetwork, sameDefaultGateway, sameSubnet, type Wire } from './rules.ts';

/** One slow value: what was last read and when, or why nothing ever was. */
export type Part<T> = { value: T | null; at: string | null; ttlS: number; why?: string };

export type NodeParts = { network?: Part<Bridge[]>; dns?: Part<string[]>; fw?: Part<number> };
export type GuestParts = { config?: Part<GuestConfig>; ip?: Part<AgentIps>; os?: Part<string | null> };

export type Raw = {
  fast: { at: string; ttlS: number; resources: Resource[] } | null;
  status: { at: string; ttlS: number; rows: StatusRow[] } | null;
  /** Why /cluster/status failed last, for values never read. */
  statusWhy?: string;
  tasks: { at: string; ttlS: number; items: Task[] } | null;
  nodes: Record<string, NodeParts>;
  guests: Record<string, GuestParts>;
  cluster: { zones?: Part<number>; vnets?: Part<number>; fw?: Part<number> };
};
export const emptyRaw = (): Raw => ({ fast: null, status: null, tasks: null, nodes: {}, guests: {}, cluster: {} });

const S = {
  res: 'pve:/cluster/resources', status: 'pve:/cluster/status', tasks: 'pve:/cluster/tasks', net: 'pve:/nodes/network', dns: 'pve:/nodes/dns', fw: 'pve:/nodes/firewall/rules',
  cfg: 'pve:/nodes/qemu/config', ip: 'pve:/nodes/qemu/agent/network-get-interfaces', os: 'pve:/nodes/qemu/agent/get-osinfo',
};

const obs = <T>(value: T, source: string, at: string | null, ttlS: number | null): Fact<T> => ({ value, basis: 'observed', source, at, ttlS });
const unk = (source: string, why: string): Fact<never> => ({ value: null, basis: 'unknown', source, at: null, ttlS: null, why });
const drv = <T>(value: T, rule: string, at: string | null): Fact<T> => ({ value, basis: 'derived', source: `rule:${rule}`, at, ttlS: null });

/** A value that was read keeps its age, even if the last try failed. Never read means unknown, with the reason. */
const fromPart = <T>(p: Part<T> | undefined, source: string, why: string, map: (v: T) => unknown = (v) => v): Fact<unknown> =>
  (p && p.value !== null ? obs(map(p.value), source, p.at, p.ttlS) : unk(source, p?.why ?? why));

export { clean };
const frac = (a: number | undefined, b: number | undefined) => (a !== undefined && b ? Math.round((a / b) * 1e4) / 1e4 : null);

const BAD_NAME = '이름이 경로 규칙에 맞지 않아 읽지 않았다';

// --- guest state (design 8)

/** Tasks that say what a guest is doing. `startall` is a node task, handled apart. */
const LIFECYCLE: Record<string, State> = {
  qmcreate: 'creating', vzcreate: 'creating', qmclone: 'creating',
  qmstart: 'starting', vzstart: 'starting',
  qmstop: 'stopping', qmshutdown: 'stopping', vzstop: 'stopping', vzshutdown: 'stopping',
  qmigrate: 'migrating', vzmigrate: 'migrating',
};
/** A task whose node lost it never ends: one vncshell has shown as running for days [measured 2026-11-01]. Past this age it says nothing. */
export const STUCK_S = 3600;
/** A start can finish between two reads with no running task ever seen. A young guest still counts as coming up: the 15 s loop plus PVE's own ~10 s tick. */
export const YOUNG_S = 40;

const live = (t: Task, nowMs: number) => t.ok === null && nowMs / 1000 - t.start < STUCK_S;

/** A lifecycle or startall task in progress: what makes the fast loop go to 5 s. Any other running task must not, or a stuck console session pins it there. */
export const activeTask = (tasks: Task[], nowMs: number) => tasks.some((t) => live(t, nowMs) && (t.type in LIFECYCLE || t.type === 'startall'));

export function guestState(r: Resource, tasks: Task[], nowMs: number): { state: State; task: string | null } {
  const id = String(r.vmid);
  const mine = tasks.filter((t) => t.id === id);
  const running = mine.filter((t) => live(t, nowMs));
  const named = running.find((t) => t.type in LIFECYCLE);
  if (named) return { state: LIFECYCLE[named.type]!, task: named.type };
  const task = running[0]?.type ?? null;
  if (r.status !== 'running' && tasks.some((t) => t.type === 'startall' && t.node === r.node && live(t, nowMs))) return { state: 'starting', task: 'startall' };
  if (r.status === 'running' && r.uptime !== undefined && r.uptime < YOUNG_S) return { state: 'starting', task };
  const last = mine.filter((t) => t.ok !== null && t.type in LIFECYCLE).sort((a, b) => b.start - a.start)[0];
  if (last?.ok === false) return { state: 'error', task };
  return { state: r.status === 'running' ? 'running' : r.status === 'stopped' ? 'stopped' : 'unknown', task };
}

// --- entities

const guestKind = (r: Resource): 'qemu' | 'lxc' => (r.type === 'lxc' ? 'lxc' : 'qemu');
export const guestKey = (r: Resource) => `${guestKind(r)}:${String(r.vmid)}`;
export const isGuest = (r: Resource) => r.type === 'qemu' || r.type === 'lxc';

const tagsOf = (s: string | undefined) => (s ? s.split(/[;, ]+/).filter(Boolean).slice(0, 20).map((t) => clean(t, 32)) : []);

const nicText = (n: GuestConfig['nics'][number]) => `${n.key} → ${n.bridge ? clean(n.bridge, 32) : '브리지 없음'}, ${n.tag === null ? 'VLAN 없음' : `VLAN ${n.tag}`}`;

const NO_EXTERNAL: External = { edge: null, wan: null, wanOff: true, localIps: [] };

export function normalize(raw: Raw, nowMs: number, ext: External = NO_EXTERNAL): { nodes: Entity[]; edges: Relation[] } {
  const out = fromPve(raw, nowMs);
  overlayEdge(out, ext, nowMs);
  return out;
}

function fromPve(raw: Raw, nowMs: number): { nodes: Entity[]; edges: Relation[] } {
  const nodes: Entity[] = [];
  const edges: Relation[] = [];
  const seen = new Set<string>();
  const ent = (e: Entity) => { if (!seen.has(e.id)) { seen.add(e.id); nodes.push(e); } };
  const rel = (id: string, source: string, target: string, kind: Relation['kind'], basis: Basis, facts: Relation['facts'] = {}) => { if (seen.has(source) && seen.has(target)) edges.push({ id, source, target, kind, basis, facts }); };

  // The blank box. `overlayEdge` replaces it when the edge file names lines.
  ent({ id: 'decl:wan:none', kind: 'wan', title: 'WAN 미확인', basis: 'unknown', state: 'unknown', facts: { state: unk('edge.json', 'WAN을 읽을 출처가 없다') } });

  const f = raw.fast;
  if (!f) return { nodes, edges };
  const res = (o: { at: string; ttlS: number }) => (v: unknown, source: string) => obs(v, source, o.at, o.ttlS);
  const fact = res(f);
  const tasks = raw.tasks?.items ?? [];
  const rows = (type: string) => f.resources.filter((r) => r.type === type);

  const wires: Wire[] = [];
  const nodeRows = rows('node').filter((r) => typeof r.node === 'string').sort((a, b) => (a.node! < b.node! ? -1 : 1));
  for (const r of nodeRows) {
    for (const b of raw.nodes[r.node!]?.network?.value ?? []) wires.push({ node: r.node!, iface: b.iface, cidr: b.cidr, gateway: b.gateway });
  }
  const at = Object.values(raw.nodes).map((p) => p.network?.at).filter((x): x is string => !!x).sort().at(-1) ?? null;

  // Derived tier: rules read observed wires and make nothing without them.
  const subnets = sameSubnet(wires);
  const gateways = sameDefaultGateway(wires);
  for (const addr of gateways.keys()) {
    ent({ id: `net:gw:${addr}`, kind: 'gateway', title: `게이트웨이 ${clean(addr, 40)}`, basis: 'derived', state: 'unknown', facts: { state: unk('rule:same-default-gateway', '장비 종류를 모른다'), address: drv(addr, 'same-default-gateway', at) } });
  }
  for (const net of subnets.keys()) {
    ent({ id: `net:seg:${net}`, kind: 'segment', title: net, basis: 'derived', state: 'ok', facts: { cidr: drv(net, 'same-subnet', at) } });
  }
  for (const addr of gateways.keys()) {
    rel(`e-wan-gw-${addr}`, 'decl:wan:none', `net:gw:${addr}`, 'wan', 'unknown');
    for (const net of subnets.keys()) if (inNetwork(addr, net)) rel(`e-gw-seg-${addr}-${net}`, `net:gw:${addr}`, `net:seg:${net}`, 'route', 'derived');
  }

  // Node tier.
  const statusOf = new Map((raw.status?.rows ?? []).filter((s) => s.type === 'node').map((s) => [s.name, s]));
  for (const r of nodeRows) {
    const name = r.node!;
    const id = `pve:node:${name}`;
    const st = statusOf.get(name);
    const online = st?.online !== undefined ? st.online === 1 : r.status === 'online';
    const parts = raw.nodes[name] ?? {};
    const facts: Entity['facts'] = {
      state: st && raw.status ? obs(online ? 'online' : 'offline', S.status, raw.status.at, raw.status.ttlS) : fact(online ? 'online' : 'offline', S.res),
      address: st?.ip && raw.status ? obs(st.ip, S.status, raw.status.at, raw.status.ttlS) : unk(S.status, raw.statusWhy ?? '아직 읽지 않았다'),
      cpu: fact(r.cpu ?? null, S.res), mem: fact(frac(r.mem, r.maxmem), S.res), disk: fact(frac(r.disk, r.maxdisk), S.res),
    };
    if (!validNode(name)) facts.network = unk(S.net, BAD_NAME);
    else {
      facts.dns = fromPart(parts.dns, S.dns, '아직 읽지 않았다');
      facts.fw = fromPart(parts.fw, S.fw, '아직 읽지 않았다');
      if (parts.network?.value == null) facts.network = fromPart(parts.network, S.net, '아직 읽지 않았다');
    }
    ent({ id, kind: 'node', title: clean(name), basis: 'observed', state: online ? 'ok' : 'error', facts });
  }
  for (const r of nodeRows) {
    const name = r.node!; const net = raw.nodes[name]?.network;
    for (const b of net?.value ?? []) {
      const id = `pve:br:${name}:${b.iface}`;
      const facts: Entity['facts'] = { state: obs(b.active ? 'up' : 'down', S.net, net!.at, net!.ttlS), method: obs(b.method, S.net, net!.at, net!.ttlS) };
      if (b.cidr) facts.address = obs(b.cidr, S.net, net!.at, net!.ttlS);
      if (b.gateway) facts.gateway = obs(b.gateway, S.net, net!.at, net!.ttlS);
      ent({ id, kind: 'bridge', title: clean(b.iface), parent: `pve:node:${name}`, basis: 'observed', state: b.active ? 'ok' : 'stopped', facts });
    }
  }
  for (const [net, ws] of subnets) for (const w of ws) {
    rel(`e-up-${w.node}-${w.iface}`, `net:seg:${net}`, `pve:node:${w.node}`, 'uplink', 'observed', { via: obs(`pve:br:${w.node}:${w.iface}`, S.net, at, null) });
  }
  for (const r of rows('storage').filter((x) => x.node && x.storage).sort((a, b) => a.id.localeCompare(b.id))) {
    const parent = `pve:node:${r.node}`;
    if (!seen.has(parent)) continue;
    ent({ id: `pve:st:${r.node}:${r.storage}`, kind: 'storage', title: clean(r.storage!), parent, basis: 'observed', state: r.status === 'available' ? 'ok' : 'error',
      facts: { state: fact(r.status ?? null, S.res), disk: fact(frac(r.disk, r.maxdisk), S.res) } });
  }

  // Guests.
  const byId = (a: Resource, b: Resource) => Number(a.vmid) - Number(b.vmid);
  for (const r of f.resources.filter(isGuest).sort(byId)) {
    const parent = `pve:node:${r.node}`;
    if (!seen.has(parent)) continue;
    const kind = guestKind(r);
    const key = guestKey(r);
    const id = `pve:${kind}:${clean(String(r.vmid), 40)}`;
    const safe = validId(r.vmid) && validNode(r.node);
    const parts = raw.guests[key] ?? {};
    const { state, task } = guestState(r, tasks, nowMs);
    const cfg = parts.config;
    const running = r.status === 'running';
    const agentWhy = running ? '아직 읽지 않았다' : '게스트가 실행 중이 아니다';
    const facts: Entity['facts'] = {
      state: fact(r.status ?? null, S.res),
      cpu: fact(r.cpu ?? null, S.res), mem: fact(frac(r.mem, r.maxmem), S.res),
      // QEMU reports 0 here whatever the disk holds [measured 2026-11-01]: a 0 would be a made-up value.
      disk: kind === 'qemu' && !r.disk ? unk(S.res, 'QEMU 게스트의 사용량은 PVE가 주지 않는다') : fact(frac(r.disk, r.maxdisk), S.res),
      tags: fact(tagsOf(r.tags), S.res),
    };
    if (!safe) {
      facts.nic = unk(S.cfg, BAD_NAME);
    } else {
      facts.nic = fromPart(cfg, S.cfg, '아직 읽지 않았다', (c) => (c as GuestConfig).nics.map(nicText));
      if (cfg?.value) {
        facts.cores = obs(cfg.value.cores, S.cfg, cfg.at, cfg.ttlS);
        facts.ostype = obs(cfg.value.ostype, S.cfg, cfg.at, cfg.ttlS);
      }
      if (kind === 'qemu') {
        // The last step before a fact: whatever `Raw` holds, a restored file included, passes the gate again.
        const ips = parts.ip?.value != null ? parseIps(parts.ip.value) : null;
        facts.ip = fromPart(parts.ip, S.ip, agentWhy, () => ips!.ips);
        if (ips?.dropped) facts.ipDropped = obs(ips.dropped, S.ip, parts.ip!.at, parts.ip!.ttlS);
        facts.os = fromPart(parts.os, S.os, agentWhy, guestText);
      } else {
        const ips = cfg?.value?.nics.flatMap((n) => (n.ip ? [n.ip] : [])) ?? [];
        facts.ip = ips.length ? obs(ips, S.cfg, cfg!.at, cfg!.ttlS) : unk(S.cfg, 'LXC 설정에 고정 주소가 없다');
      }
    }
    if (task) facts.task = obs(clean(task, 32), S.tasks, raw.tasks?.at ?? null, raw.tasks?.ttlS ?? null);
    facts.docker = unk('docker:', '출처 없음');
    const title = clean(r.name ?? `${kind === 'qemu' ? 'VM' : 'CT'} ${String(r.vmid)}`);
    ent({ id, kind: kind === 'qemu' ? 'vm' : 'lxc', title, parent, basis: 'observed', state, facts });
    for (const n of cfg?.value?.nics ?? []) {
      if (n.bridge) rel(`e-attach-${key}-${n.key}`, `pve:br:${r.node}:${n.bridge}`, id, 'attached', 'observed', { firewall: obs(n.firewall, S.cfg, cfg!.at, cfg!.ttlS) });
    }
    for (const d of cfg?.value?.disks ?? []) rel(`e-mount-${key}-${d}`, id, `pve:st:${r.node}:${d}`, 'mounts', 'observed');
  }
  return { nodes, edges };
}
