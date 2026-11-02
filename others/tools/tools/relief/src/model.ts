// What the panel, the tree and the keyboard read from a snapshot. Pure functions; the components only draw them.
import { ageS, ageText, freshness, type Entity, type Fact, type Kind, type Snapshot, type SourceStatus } from '../server/model/fact.ts';
import { healthOf, notApplicable } from '../server/model/health.ts';
import { rateText } from './ui/chart.ts';
import { project, type Mode } from './scene/project.ts';

export const KIND_LABEL: Record<Kind, string> = {
  wan: '회선', modem: '모뎀', domain: '도메인', gateway: '게이트웨이', tunnel: '터널', proxy: '프록시', switch: '스위치', wifi: 'Wi-Fi', clients: '무선 클라이언트', segment: '세그먼트',
  node: '노드', workstation: 'PC', bmc: 'BMC', bridge: '브리지', storage: '저장소', vm: 'QEMU VM', lxc: 'LXC', container: '컨테이너',
};
export const FACT_LABEL: Record<string, string> = {
  state: '상태', address: '주소', cidr: '대역', cpu: 'CPU', mem: '메모리', disk: '디스크', nic: 'NIC', ip: 'IP 주소', os: 'OS', docker: 'Docker',
  fw: '방화벽 규칙', tags: '태그', vlan: 'VLAN', image: '이미지', isp: '통신사', protocol: '프로토콜',
  dns: 'DNS', method: '주소 방식', gateway: '게이트웨이', network: '네트워크', publicIp: '공인 IP', record: 'A 레코드 값', aRecord: 'A 레코드 비교', path: '경로', natLayers: 'NAT 겹', natCheck: 'NAT 검사', lease: '본 주소', plan: '주소 계획', bmc: 'BMC',
  portForwards: '포트 포워드', forwardsOff: '꺼진 포워드', forwardsLost: '대상 미확인 포워드', lanCidr: 'LAN 대역', dhcpRange: 'DHCP 범위', addressPlan: '주소 계획표', declaredAddress: '선언 주소',
  unmatchedHosts: '관측과 안 맞는 호스트', vendor: '제조사', model: '모델', firmware: '펌웨어', mode: '모드', provider: '등록 기관', presence: '접속', devices: '기기', bands: '대역폭', ddns: 'DDNS', interface: '인터페이스',
  expected: '기대 상태', checkCpu: 'CPU 임계', checkMem: '메모리 임계', checkDisk: '디스크 임계', netIn: '수신', netOut: '송신', link: '연결', ipDropped: '버린 주소', task: '진행 중 태스크', cores: '코어', ostype: 'OS 종류', sshUser: 'SSH 사용자', hostname: '호스트 이름', memTotal: '메모리 총량',
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
  if ((key === 'netIn' || key === 'netOut') && typeof v === 'number') return rateText(v);
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
const srcText = (x: SourceStatus | undefined, ok: string, nowMs: number): string => (!x || x.state === 'none' ? (x?.why ?? '출처 없음') : x.state === 'pending' ? '첫 수집 대기' : x.state === 'failing' ? failText(x, nowMs) : ok);

/** Design 4: "none" says no source, "ok" with an empty list says 0 observed, "failing" says the last value is old. Never one for the other. */
export function tierCards(s: Snapshot, nowMs: number): TierCard[] {
  const src = (id: string) => s.sources.find((x) => x.id === id);
  const n = (k: Kind) => s.nodes.filter((e) => e.kind === k && !e.gone).length;
  const pve = src('pve'); const edge = src('edge'); const docker = src('docker');
  const health = healthOf(s, nowMs).objects;
  const staleNodes = s.nodes.filter((e) => e.kind === 'node' && health.get(e.id)?.stale).length;
  const gw = n('gateway');
  const declared = s.nodes.filter((e) => e.basis === 'declared').length;
  const warned = s.nodes.filter((e) => health.get(e.id)?.drift.length).length;
  const wan = src('wan-ip');
  const outside = [
    edge?.state === 'ok' ? `선언 ${declared}` : srcText(edge, '', nowMs), edge?.state === 'failing' && declared ? `마지막 선언 ${declared}` : '',
    gw ? `GW ${gw}${s.nodes.some((e) => e.kind === 'gateway' && e.basis === 'derived') ? ' 추정' : ''}` : '',
    wan && wan.state !== 'ok' ? `공인 IP ${srcText(wan, '', nowMs)}` : '', warned ? `어긋남 ${warned}` : '',
  ].filter(Boolean).join(' · ');
  const nodes = pve?.state === 'ok' ? `${n('node')}대${staleNodes ? ` · 낡음 ${staleNodes}` : ''}` : srcText(pve, '', nowMs);
  const pcs = n('workstation');
  const guests = pve?.state === 'ok' ? (n('vm') + n('lxc') === 0 ? `QEMU ${n('vm')} · LXC ${n('lxc')} · 0개 관측` : `QEMU ${n('vm')} · LXC ${n('lxc')}`) : srcText(pve, '', nowMs);
  const hosts = new Set(s.nodes.filter((e) => e.kind === 'container').map((e) => e.parent)).size;
  const dock = docker?.state === 'ok' ? (n('container') === 0 ? '0개 관측' : `호스트 ${hosts} · 컨테이너 ${n('container')}`) : srcText(docker, '', nowMs);
  return [{ tier: '외부', text: outside }, { tier: '노드', text: pcs ? `${nodes} · PC ${pcs}` : nodes }, { tier: '게스트', text: guests }, { tier: 'Docker', text: dock }];
}

const isCheck = (key: string) => key === 'checkCpu' || key === 'checkMem' || key === 'checkDisk';
const isRate = (key: string) => key === 'netIn' || key === 'netOut';

const SHORT_KIND: Partial<Record<Kind, string>> = { vm: 'VM', lxc: 'LXC', clients: '기기' };

export type Hole = { key: string; label: string; why: string; action: string; ids: string[]; count: number };

/** Every blank value, grouped by what is missing and why. The "map of holes" of design 2. */
export function holes(s: Snapshot): Hole[] {
  const m = new Map<string, Hole>();
  for (const e of s.nodes) {
    for (const [k, f] of Object.entries(e.facts)) {
      if (f.basis !== 'unknown' || isCheck(k) || isRate(k) || notApplicable(e, k)) continue;
      const why = f.why ?? '이유 없음';
      const id = `${k}|${why}`;
      const h = m.get(id) ?? { key: k, label: `${SHORT_KIND[e.kind] ?? KIND_LABEL[e.kind]} ${FACT_LABEL[k] ?? k}`, why, action: HOLE_ACTION[k] ?? '', ids: [], count: 0 };
      h.ids.push(e.id); h.count++; m.set(id, h);
    }
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

/**
 * Text as a search compares it. Decomposed, so a syllable still being typed matches: "결ㅈ" is on its way to "결제", and in NFD it is a prefix of it.
 * Keyboards give a lone consonant as a compatibility jamo, which NFD leaves alone, so those are mapped to the leading consonant by hand.
 */
const LEADING = 'ᄀᄁ\0ᄂ\0\0ᄃᄄᄅ\0\0\0\0\0\0\0ᄆᄇᄈ\0ᄉᄊᄋᄌᄍᄎᄏᄐᄑᄒ';
export const fold = (t: string) => [...t.normalize('NFD').toLowerCase()].map((c) => { const i = (c.codePointAt(0) ?? 0) - 0x3131; const m = i >= 0 && i < LEADING.length ? LEADING[i] : undefined; return m && m !== '\0' ? m : c; }).join('');

const addressOf = (e: Entity): string => Object.entries(e.facts).filter(([k]) => k === 'address' || k === 'cidr' || k === 'ip' || k === 'lease').map(([, f]) => (Array.isArray(f.value) ? f.value.join(' ') : String(f.value ?? ''))).filter(Boolean).join(' ');

/** Search (design 9.4, 9.11): names, kinds, addresses and tags. */
export function searchMatches(s: Snapshot, q: string): Set<string> | null {
  const needle = fold(q.trim());
  if (!needle) return null;
  const out = new Set<string>();
  for (const e of s.nodes) {
    const tags = Array.isArray(e.facts.tags?.value) ? e.facts.tags.value.join(' ') : '';
    if ([e.title, e.id, e.kind, KIND_LABEL[e.kind], addressOf(e), tags].some((h) => fold(h).includes(needle))) out.add(e.id);
  }
  return out;
}

export type Hit = { id: string; title: string; kind: string; where: string; address: string; state: string };
const PALETTE_MAX = 30;

/** What the palette lists: names first, the start of a name before its middle, then kinds and addresses. */
export function paletteHits(s: Snapshot, q: string): Hit[] {
  const needle = fold(q.trim());
  const rank = (e: Entity) => { if (!needle) return 3; const t = fold(e.title); return t.startsWith(needle) ? 0 : t.includes(needle) ? 1 : 2; };
  const found = searchMatches(s, q);
  const byId = new Map(s.nodes.map((e) => [e.id, e]));
  return s.nodes.filter((e) => !e.gone && s.layout[e.id] && (!found || found.has(e.id))).sort((a, b) => rank(a) - rank(b)).slice(0, PALETTE_MAX)
    .map((e) => ({ id: e.id, title: e.title, kind: KIND_LABEL[e.kind], where: e.parent ? (byId.get(e.parent)?.title ?? '') : '', address: addressOf(e).split(' ')[0] ?? '', state: e.state }));
}

const VALUE_KEYS: Partial<Record<Kind, string[]>> = {
  node: ['cpu', 'mem'], vm: ['cpu', 'mem'], lxc: ['cpu', 'mem'], storage: ['disk'], workstation: ['mem', 'address'], gateway: ['address', 'portForwards'],
  wan: ['publicIp', 'medium'], domain: ['record', 'aRecord'], segment: ['cidr'], bridge: ['address'], bmc: ['address'], modem: ['mode'], wifi: ['bands'], clients: ['presence'], switch: ['model', 'ports'], proxy: ['address'], tunnel: ['protocol', 'port'],
};

/** The current rate in one line: received, sent. A blank says why, a stale value says that. */
export function trafficText(e: Entity, nowMs: number): string | null {
  const i = e.facts.netIn; const o = e.facts.netOut;
  if (!i || !o) return null;
  if (i.basis !== 'observed' || o.basis !== 'observed') return i.why ?? '측정 없음';
  if (freshness(i, nowMs) === 'stale') return '낡음';
  return `↓${factText('netIn', i)} ↑${factText('netOut', o)}`;
}

/** At most three values of an object, for the menu on the map. A blank stays a blank. */
export function keyValues(e: Entity, nowMs = Date.now()): { label: string; text: string }[] {
  const out = (VALUE_KEYS[e.kind] ?? []).flatMap((k) => { const f = e.facts[k]; return f ? [{ label: FACT_LABEL[k] ?? k, text: factText(k, f) }] : []; });
  const t = trafficText(e, nowMs);
  return (t ? [...out, { label: '트래픽', text: t }] : out).slice(0, 3);
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
