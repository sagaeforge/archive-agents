// Synthetic snapshots. Every name and address is invented; addresses come from the RFC 5737 documentation ranges only.
// `fixtures/*.json` are written from here by scripts/build-fixtures.ts. Tests call the generator directly to vary the shape.
import type { Basis, Entity, Fact, Kind, Relation, Snapshot, SourceStatus, State } from '../../server/model/fact.ts';

/** The fixture clock. The dev server shifts every timestamp so the data looks 12 seconds old whenever it is served. */
export const T0 = '2026-11-01T09:00:00.000Z';
const at = (ageSec: number) => new Date(Date.parse(T0) - ageSec * 1000).toISOString();

const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ttlS is three polling periods: 45 s for the fast loop, 900 s for the slow loop (design 8).
const obs = <T>(value: T, source: string, ageSec = 12, ttlS = 45): Fact<T> => ({ value, basis: 'observed', source, at: at(ageSec), ttlS });
const derived = <T>(value: T, rule: string): Fact<T> => ({ value, basis: 'derived', source: `rule:${rule}`, at: at(12), ttlS: null });
const declared = <T>(value: T, ptr: string, reviewBy = '2027-02-01'): Fact<T> => ({ value, basis: 'declared', source: `edge.json#${ptr}`, at: '2026-11-01', ttlS: null, reviewBy });
const unknown = (source: string, why: string): Fact<never> => ({ value: null, basis: 'unknown', source, at: null, ttlS: null, why });

export type GenOptions = {
  name: 'today' | 'large';
  pve?: boolean; edge?: boolean; docker?: boolean;
  nodeCount?: number; guestsPerNode?: number; containerHosts?: number;
  /** parent entity id -> number of extra guests, appended last so every existing id and slot stays the same. */
  addGuests?: Record<string, number>;
};

const SVC = ['결제', '로그', '빌드', '검색', '메일', '사내위키', '모니터', '백업', '배포', '인증', '데이터베이스', '캐시'];
const APP = ['api', 'web', 'worker', 'redis', 'pg', 'nginx', 'queue', 'cron', '수집기', '색인기', '내보내기'];

export function generate(o: GenOptions): Snapshot {
  const pve = o.pve ?? true;
  const edge = o.edge ?? o.name === 'large';
  const docker = o.docker ?? o.name === 'large';
  const nodes: Entity[] = [];
  const edges: Relation[] = [];
  const ent = (id: string, kind: Kind, title: string, basis: Basis, state: State, facts: Record<string, Fact<unknown>>, parent?: string) => {
    nodes.push({ id, kind, title, basis, state, facts, ...(parent ? { parent } : {}) });
  };
  const rel = (id: string, source: string, target: string, kind: Relation['kind'], basis: Basis, facts: Record<string, Fact<unknown>> = {}) => {
    edges.push({ id, source, target, kind, basis, facts });
  };
  const m = seeded(7);
  const metric = (lo: number, hi: number) => +(lo + m() * (hi - lo)).toFixed(2);
  const metrics = (age: number, lo = 0.05, hi = 0.8) => ({ cpu: obs(metric(lo, hi), 'pve:/cluster/metrics/export', age), mem: obs(metric(lo + 0.1, hi), 'pve:/cluster/metrics/export', age), disk: obs(metric(lo, hi - 0.2), 'pve:/cluster/metrics/export', age) });

  const large = o.name === 'large';
  const nodeCount = pve ? (o.nodeCount ?? (large ? 5 : 3)) : 0;
  const guestsPerNode = large ? (o.guestsPerNode ?? 16) : 0;
  const containerHosts = docker && large ? (o.containerHosts ?? 14) : 0;
  const seg1 = large ? '192.0.2.0/24' : '192.0.2.0/24';
  const segs: { id: string; title: string; basis: Basis; cidr: string }[] = large
    ? [{ id: 'net:seg:192.0.2.0/24', title: '관리 192.0.2.0/24', basis: 'derived', cidr: seg1 }, { id: 'net:seg:198.51.100.0/24:20', title: 'VLAN 20 198.51.100.0/24', basis: 'observed', cidr: '198.51.100.0/24' }]
    : [{ id: 'net:seg:192.0.2.0/24', title: '192.0.2.0/24', basis: 'derived', cidr: seg1 }];

  // --- outside tier
  if (edge) {
    ent('decl:wan:line-a', 'wan', '회선 A (선언)', 'declared', 'ok', { state: declared('선언됨', '/lines/0', '2026-10-15'), isp: declared('예시 통신', '/lines/0', '2026-10-15') });
    ent('decl:tunnel:vpn-a', 'tunnel', 'VPN 터널 (선언)', 'declared', 'ok', { state: declared('선언됨', '/vpn/0'), protocol: declared('wireguard', '/vpn/0') });
  } else {
    ent('decl:wan:none', 'wan', 'WAN 미확인', 'unknown', 'unknown', { state: unknown('edge.json', 'WAN을 읽을 출처가 없다') });
  }
  if (nodeCount > 0) {
    ent('net:gw:192.0.2.1', 'gateway', '게이트웨이 192.0.2.1', 'derived', 'unknown', {
      state: unknown('rule:same-default-gateway', '장비 종류를 모른다'), address: derived('192.0.2.1', 'same-default-gateway'),
    });
  }
  if (edge && nodeCount > 0) ent('decl:proxy:rp', 'proxy', '리버스 프록시 (선언)', 'declared', 'ok', { state: declared('선언됨', '/proxies/0') });
  if (nodeCount > 0) {
    for (const s of segs) {
      ent(s.id, 'segment', s.title, s.basis, 'ok', s.basis === 'derived'
        ? { cidr: derived(s.cidr, 'same-subnet') }
        : { cidr: obs(s.cidr, 'pve:/cluster/sdn/vnets', 12), state: obs('ok', 'pve:/cluster/sdn/vnets', 12) });
    }
    const wanId = edge ? 'decl:wan:line-a' : 'decl:wan:none';
    rel('e-wan-gw', wanId, 'net:gw:192.0.2.1', 'wan', edge ? 'declared' : 'unknown');
    if (edge) {
      rel('e-tun-gw', 'decl:tunnel:vpn-a', 'net:gw:192.0.2.1', 'tunnel', 'declared');
      rel('e-gw-rp', 'net:gw:192.0.2.1', 'decl:proxy:rp', 'lan', 'declared');
      rel('e-gw-seg1', 'net:gw:192.0.2.1', segs[0]!.id, 'route', 'derived');
      rel('e-rp-seg2', 'decl:proxy:rp', segs[segs.length - 1]!.id, 'lan', 'declared');
    } else {
      rel('e-gw-seg1', 'net:gw:192.0.2.1', segs[0]!.id, 'route', 'derived');
    }
  } else if (!edge) {
    // WAN is a blank box with nothing to connect to: nothing else exists.
  }

  // --- node tier and guests
  const r = seeded(20261101);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
  let vmid = 100; let hosts = 0; let containers = 0; let guests = 0;
  const nodeNames: string[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const n = `node-${i + 1}`; nodeNames.push(n);
    const id = `pve:node:${n}`;
    const age = large && i === 3 ? 180 : 12; // collection failed for node 4: its facts are 3 minutes old, so it and everything on it read as stale
    ent(id, 'node', `노드 ${i + 1}`, 'observed', 'ok', { state: obs('online', 'pve:/cluster/status', age), address: obs(`192.0.2.${11 + i}`, 'pve:/nodes/network', age), ...metrics(age, 0.1, 0.7) });
    const brs = large ? [0, 1] : [0];
    for (const b of brs) {
      const bid = `pve:br:${n}:vmbr${b}`;
      ent(bid, 'bridge', `vmbr${b}`, 'observed', 'ok', { state: obs('up', 'pve:/nodes/network', age), vlan: obs(b === 1 ? 20 : null, 'pve:/nodes/network', age) }, id);
      rel(`e-up-${n}-${b}`, segs[Math.min(b, segs.length - 1)]!.id, id, 'uplink', 'observed', { via: obs(bid, 'pve:/nodes/network', age) });
      if (large) ent(`pve:st:${n}:${b === 0 ? 'local' : 'local-lvm'}`, 'storage', b === 0 ? 'local' : 'local-lvm', 'observed', 'ok', { state: obs('active', 'pve:/cluster/resources', age), disk: obs(metric(0.1, 0.9), 'pve:/cluster/resources', age) }, id);
    }
    if (!large) for (const st of ['local', 'local-lvm']) ent(`pve:st:${n}:${st}`, 'storage', st, 'observed', 'ok', { state: obs('active', 'pve:/cluster/resources', age), disk: obs(metric(0.1, 0.9), 'pve:/cluster/resources', age) }, id);
    if (!large && i === 0) {
      ent('pve:qemu:100', 'vm', 'VM 100', 'observed', 'running', {
        state: obs('running', 'pve:/cluster/resources', 12), ...metrics(12, 0.1, 0.3),
        nic: obs('net0 → vmbr0, VLAN 없음', 'pve:/nodes/qemu/config', 240, 900),
        ip: unknown('pve:/nodes/qemu/agent/network-get-interfaces', 'guest agent 응답 없음'),
        os: unknown('pve:/nodes/qemu/agent/get-osinfo', 'guest agent 응답 없음'),
        docker: unknown('docker:', '출처 없음'),
        fw: obs(0, 'pve:/nodes/firewall/rules', 240, 900), tags: obs([], 'pve:/cluster/resources', 12),
      }, id);
      rel('e-attach-100', 'pve:br:node-1:vmbr0', 'pve:qemu:100', 'attached', 'observed');
      guests++;
    }
    for (let g = 0; g < guestsPerNode; g++) {
      const isDocker = hosts < containerHosts && g % 3 === 0;
      const kind: Kind = isDocker || r() < 0.45 ? 'vm' : 'lxc';
      const roll = r();
      const state: State = roll < 0.05 ? 'stopped' : roll < 0.08 ? 'starting' : roll < 0.095 ? 'error' : 'running';
      const gid = `pve:${kind === 'vm' ? 'qemu' : 'lxc'}:${vmid}`;
      const title = `${pick(SVC)}-${vmid}`;
      ent(gid, kind, title, 'observed', state, {
        state: obs(state, 'pve:/cluster/resources', age), ...metrics(age),
        ip: unknown('pve:/nodes/qemu/agent/network-get-interfaces', 'guest agent 응답 없음'), tags: obs([], 'pve:/cluster/resources', age),
      }, id);
      guests++; vmid++;
      if (isDocker) {
        hosts++;
        const count = 9 + Math.floor(r() * 8);
        for (let c = 0; c < count; c++) {
          const cr = r();
          const cs: State = state !== 'running' ? 'unknown' : cr < 0.06 ? 'stopped' : 'running';
          ent(`docker:${gid}:c${c}`, 'container', pick(APP), 'observed', cs === 'unknown' ? 'running' : cs, { state: obs(cs === 'unknown' ? 'running' : cs, `docker:${gid}`, age), image: obs(`example/app-${c}`, `docker:${gid}`, age) }, gid);
          containers++;
        }
      }
    }
  }
  // Appended last so the seeded sequence, and with it every other id, stays the same. The stability test relies on that.
  let added = 0;
  for (const [parent, count] of Object.entries(o.addGuests ?? {})) {
    for (let g = 0; g < count; g++) {
      ent(`pve:qemu:${900 + added++}`, 'vm', `신규-${g}`, 'observed', 'starting', { state: obs('starting', 'pve:/cluster/resources', 4), ...metrics(4) }, parent);
      guests++;
    }
  }

  const count = (k: Kind) => nodes.filter((n) => n.kind === k).length;
  const sources: SourceStatus[] = [
    pve ? { id: 'pve', state: 'ok', count: count('node') + count('vm') + count('lxc'), at: at(12) } : { id: 'pve', state: 'none', count: null, at: null, why: '출처 없음' },
    edge ? { id: 'edge', state: 'ok', count: nodes.filter((n) => n.basis === 'declared').length, at: '2026-11-01' } : { id: 'edge', state: 'none', count: null, at: null, why: '출처 없음' },
    docker ? { id: 'docker', state: 'ok', count: containers, at: at(12) } : { id: 'docker', state: 'none', count: null, at: null, why: '출처 없음' },
  ];
  return { schema: 1, seq: 1, takenAt: T0, nodes, edges, sources, layout: {}, routes: {} };
}

export const today = (over: Partial<GenOptions> = {}) => generate({ name: 'today', ...over });
export const large = (over: Partial<GenOptions> = {}) => generate({ name: 'large', ...over });
