// What the panel, the tree and the keyboard read from a snapshot. Pure functions; the components only draw them.
import { ageS, ageText, staleIds, type Entity, type Fact, type Kind, type Snapshot, type SourceStatus } from '../server/model/fact.ts';
import { project, type Mode } from './scene/project.ts';

export const KIND_LABEL: Record<Kind, string> = {
  wan: '회선', modem: '모뎀', domain: '도메인', gateway: '게이트웨이', tunnel: '터널', proxy: '프록시', switch: '스위치', wifi: 'Wi-Fi', clients: '무선 클라이언트', segment: '세그먼트',
  node: '노드', workstation: '작업 머신', bmc: 'BMC', bridge: '브리지', storage: '저장소', vm: 'QEMU VM', lxc: 'LXC', container: '컨테이너',
};
export const FACT_LABEL: Record<string, string> = {
  state: '상태', address: '주소', cidr: '대역', cpu: 'CPU', mem: '메모리', disk: '디스크', nic: 'NIC', ip: 'IP 주소', os: 'OS', docker: 'Docker',
  fw: '방화벽 규칙', tags: '태그', vlan: 'VLAN', image: '이미지', isp: '통신사', protocol: '프로토콜',
  dns: 'DNS', method: '주소 방식', gateway: '게이트웨이', network: '네트워크', publicIp: '공인 IP', record: 'A 레코드 값', aRecord: 'A 레코드 비교', path: '경로', natLayers: 'NAT 겹', natCheck: 'NAT 검사', lease: '본 주소', plan: '주소 계획', bmc: 'BMC',
  portForwards: '포트 포워드', forwardsOff: '꺼진 포워드', forwardsLost: '대상 미확인 포워드', lanCidr: 'LAN 대역', dhcpRange: 'DHCP 범위', addressPlan: '주소 계획표', declaredAddress: '선언 주소',
  unmatchedHosts: '관측과 안 맞는 호스트', vendor: '제조사', model: '모델', firmware: '펌웨어', mode: '모드', provider: '등록 기관', presence: '접속', devices: '기기', bands: '대역폭', ddns: 'DDNS', interface: '인터페이스',
  link: '연결', ipDropped: '버린 주소', task: '진행 중 태스크', cores: '코어', ostype: 'OS 종류',
};
/** The smallest step that fills a blank (design 9.4). Keyed by fact name; an unknown name gets no suggestion. */
export const HOLE_ACTION: Record<string, string> = {
  ip: 'VM 안에 qemu-guest-agent를 설치한다', os: 'VM 안에 qemu-guest-agent를 설치한다',
  docker: 'Docker 호스트를 지정하고 출처를 연결한다', publicIp: 'relief.json에 publicIpUrl을 정한다', aRecord: '공인 IP 출처와 A 레코드 값을 채운다',
  record: 'edge.json에 A 레코드 값을 적는다', natLayers: 'edge.json에 natLayers를 적는다', portForwards: 'edge.json에 portForwards를 적는다', bmc: 'edge.json에 bmc를 적는다', state: '출처를 연결하거나 edge.json에 선언한다',
};

export function factText(key: string, f: Fact<unknown>): string {
  const v = f.value;
  if (f.basis === 'unknown' || v === null) return f.basis === 'unknown' ? '미확인' : '없음';
  if (key === 'cpu' || key === 'mem' || key === 'disk') return typeof v === 'number' ? `${Math.round(v * 100)}%` : String(v);
  if (Array.isArray(v)) return v.length ? v.join(', ') : '없음';
  if (key === 'fw') return `${String(v)}건`;
  return String(v);
}

export type Metrics = { at: string | null; values: Record<string, { cpu?: number; mem?: number; disk?: number }> };

/** The load overlay's values, read apart from the snapshot (design 8): the snapshot stays the same object until something really changes. */
export function applyMetrics(s: Snapshot, m: Metrics | null): Snapshot {
  if (!m?.at) return s;
  const source = 'pve:/cluster/metrics/export';
  return {
    ...s,
    nodes: s.nodes.map((e) => {
      const v = m.values[e.id];
      if (!v) return e;
      const facts = { ...e.facts };
      for (const k of ['cpu', 'mem', 'disk'] as const) { const x = v[k]; if (x !== undefined) facts[k] = { value: x, basis: 'observed', source, at: m.at, ttlS: 45 }; }
      return { ...e, facts };
    }),
  };
}

export type TierCard = { tier: string; text: string };

const failText = (x: SourceStatus, nowMs: number): string => {
  const a = ageS(x.at, nowMs);
  return `수집 실패${x.why ? ` · ${x.why}` : ''}${a == null ? ' · 값 없음' : ` · ${ageText(a)}`}`;
};
const srcText = (x: SourceStatus | undefined, ok: string, nowMs: number): string => (!x || x.state === 'none' ? '출처 없음' : x.state === 'failing' ? failText(x, nowMs) : ok);

/** Design 4: "none" says no source, "ok" with an empty list says 0 observed, "failing" says the last value is old. Never one for the other. */
export function tierCards(s: Snapshot, nowMs: number): TierCard[] {
  const src = (id: string) => s.sources.find((x) => x.id === id);
  const n = (k: Kind) => s.nodes.filter((e) => e.kind === k && !e.gone).length;
  const pve = src('pve'); const edge = src('edge'); const docker = src('docker');
  const stale = staleIds(s, nowMs);
  const staleNodes = s.nodes.filter((e) => e.kind === 'node' && stale.has(e.id)).length;
  const gw = n('gateway');
  const declared = s.nodes.filter((e) => e.basis === 'declared').length;
  const warned = s.nodes.filter((e) => e.warnings?.length).length;
  const wan = src('wan-ip');
  const outside = [
    edge?.state === 'ok' ? `선언 ${declared}` : srcText(edge, '', nowMs), edge?.state === 'failing' && declared ? `마지막 선언 ${declared}` : '',
    gw ? `GW ${gw}${s.nodes.some((e) => e.kind === 'gateway' && e.basis === 'derived') ? ' 추정' : ''}` : '',
    wan ? `공인 IP ${srcText(wan, '관측', nowMs)}` : '', warned ? `어긋남 ${warned}` : '',
  ].filter(Boolean).join(' · ');
  const counted = Object.entries(pve?.counts ?? {}).map(([k, v]) => ` · ${k} ${v}`).join('');
  const nodes = pve?.state === 'ok' ? `${n('node')} 관측${staleNodes ? ` · 낡음 ${staleNodes}` : ''}${n('node') ? ` · 브리지 ${n('bridge')} · 저장소 ${n('storage')}` : ''}${counted}` : srcText(pve, '', nowMs);
  const guests = pve?.state === 'ok' ? (n('vm') + n('lxc') === 0 ? `QEMU ${n('vm')} · LXC ${n('lxc')} · 0개 관측` : `QEMU ${n('vm')} · LXC ${n('lxc')}`) : srcText(pve, '', nowMs);
  const hosts = new Set(s.nodes.filter((e) => e.kind === 'container').map((e) => e.parent)).size;
  const dock = docker?.state === 'ok' ? (n('container') === 0 ? '0개 관측' : `호스트 ${hosts} · 컨테이너 ${n('container')}`) : srcText(docker, '', nowMs);
  return [{ tier: '외부', text: outside }, { tier: '노드', text: nodes }, { tier: '게스트', text: guests }, { tier: 'Docker', text: dock }];
}

export type Hole = { key: string; label: string; why: string; action: string; ids: string[]; count: number };

/** Every blank value, grouped by what is missing and why. The "map of holes" of design 2. */
export function holes(s: Snapshot): Hole[] {
  const m = new Map<string, Hole>();
  for (const e of s.nodes) {
    for (const [k, f] of Object.entries(e.facts)) {
      if (f.basis !== 'unknown') continue;
      const why = f.why ?? '이유 없음';
      const id = `${k}|${why}`;
      const h = m.get(id) ?? { key: k, label: `${KIND_LABEL[e.kind]} ${FACT_LABEL[k] ?? k}`, why, action: HOLE_ACTION[k] ?? '', ids: [], count: 0 };
      h.ids.push(e.id); h.count++; m.set(id, h);
    }
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

/** Search (design 9.4): names, addresses and tags, NFC-normalised. */
export function searchMatches(s: Snapshot, q: string): Set<string> | null {
  const needle = q.normalize('NFC').trim().toLowerCase();
  if (!needle) return null;
  const out = new Set<string>();
  for (const e of s.nodes) {
    const hay = [e.title, e.id, ...Object.entries(e.facts).filter(([k]) => k === 'address' || k === 'cidr' || k === 'ip' || k === 'tags').map(([, f]) => (Array.isArray(f.value) ? f.value.join(' ') : String(f.value ?? '')))];
    if (hay.some((h) => h.normalize('NFC').toLowerCase().includes(needle))) out.add(e.id);
  }
  return out;
}

export type TreeRow = { id: string; level: number; entity: Entity };

/** Roots first as the tier reads (outside, then slabs), children under their parent in snapshot order. */
export function treeRows(s: Snapshot, only: ReadonlySet<string> | null): TreeRow[] {
  const kids = new Map<string | undefined, Entity[]>();
  for (const e of s.nodes) (kids.get(e.parent) ?? kids.set(e.parent, []).get(e.parent)!).push(e);
  const keep = new Set<string>();
  if (only) {
    const byId = new Map(s.nodes.map((e) => [e.id, e]));
    for (const id of only) for (let e = byId.get(id); e; e = e.parent ? byId.get(e.parent) : undefined) keep.add(e.id);
  }
  const rows: TreeRow[] = [];
  const walk = (parent: string | undefined, level: number) => {
    for (const e of kids.get(parent) ?? []) {
      if (only && !keep.has(e.id)) continue;
      rows.push({ id: e.id, level, entity: e });
      walk(e.id, level + 1);
    }
  };
  walk(undefined, 1);
  return rows;
}

export type Dir = 'left' | 'right' | 'up' | 'down';

/** Arrow keys move among siblings in the screen direction they point (design 9.6). `[` is the parent, `]` the first child. */
export function neighbour(s: Snapshot, id: string | null, dir: Dir | '[' | ']', mode: Mode): string | null {
  const byId = new Map(s.nodes.map((e) => [e.id, e]));
  const sibs = (parent: string | undefined) => s.nodes.filter((e) => e.parent === parent && s.layout[e.id]);
  if (id === null) return (sibs(undefined).find((e) => e.kind === 'node') ?? sibs(undefined)[0])?.id ?? null;
  const cur = byId.get(id); if (!cur) return null;
  if (dir === '[') return cur.parent ?? null;
  if (dir === ']') return s.nodes.find((e) => e.parent === id && s.layout[e.id])?.id ?? null;
  const P = project(mode, 1);
  const centre = (e: Entity): [number, number] => { const b = s.layout[e.id]!; return P(b.x + b.w / 2, b.y + b.h / 2, b.z + b.zh); };
  const [cx, cy] = centre(cur);
  let best: [number, string] | null = null;
  for (const e of sibs(cur.parent)) {
    if (e.id === id) continue;
    const [x, y] = centre(e); const dx = x - cx; const dy = y - cy;
    const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0.5) continue;
    const score = along + 2 * across;
    if (!best || score < best[0]) best = [score, e.id];
  }
  return best ? best[1] : id;
}
