// Service checks (design 7.3): a TCP connect to a declared LAN host, with a timeout. Nothing is written to the socket and nothing is read from it.
// No DNS: the target is an IPv4 literal. This is no port scan: the only ports are the ones a person wrote into edge.json.
import { connect, isIP } from 'node:net';
import type { EdgeFile } from './edge.ts';
import { currentOf } from '../model/edgemap.ts';
import type { Alert, Entity, Fact, ServiceCheck } from '../model/fact.ts';
import { inNetwork, networkOf, v4 } from '../model/rules.ts';

export const TIMEOUT_MS = 2000;
const CONCURRENCY = 4;
const SOURCE = 'health:tcp';

export type ProbeResult = { up: boolean; latencyMs: number | null; why?: string };
export type Probe = (address: string, port: number, timeoutMs: number, signal?: AbortSignal) => Promise<ProbeResult>;

const WHY: Record<string, string> = { ECONNREFUSED: '연결 거부', EHOSTUNREACH: '호스트에 닿지 않음', ENETUNREACH: '네트워크에 닿지 않음', ECONNRESET: '연결 끊김' };

/** Connect, note the time, close. No `data` handler: a banner the service sends stays unread in the kernel and goes when the socket does. */
export const tcpProbe: Probe = (address, port, timeoutMs, signal) => new Promise((resolve) => {
  if (isIP(address) !== 4) { resolve({ up: false, latencyMs: null, why: '주소가 IPv4가 아니다' }); return; }
  const t0 = performance.now();
  const socket = connect({ host: address, port, family: 4 });
  const done = (r: ProbeResult) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); socket.destroy(); resolve(r); };
  const onAbort = () => done({ up: false, latencyMs: null, why: '검사 중단' });
  const timer = setTimeout(() => done({ up: false, latencyMs: null, why: '응답 없음' }), timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  socket.once('connect', () => done({ up: true, latencyMs: Math.round(performance.now() - t0) }));
  socket.once('error', (e: NodeJS.ErrnoException) => done({ up: false, latencyMs: null, why: WHY[e.code ?? ''] ?? '연결 실패' }));
});

const NETS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.x.x/16', '192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24'];
/** RFC 1918 and RFC 5737 only. Loopback, link-local, CGNAT and every public address are out. */
export const isLanAddress = (a: string) => isIP(a) === 4 && v4(a) !== null && NETS.some((n) => inNetwork(a, n));

export type Target = { id: string; title: string; port: number; entity: string | null; address: string | null; refused?: string };

const plain = (a: string) => a.split('/')[0]!;

/** Each declared service with where it would go, or why it goes nowhere. This is the only way to a probe. */
export function targetsOf(f: EdgeFile, nodes: readonly Entity[]): Target[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const gateway = nodes.find((n) => n.kind === 'gateway');
  const lan = f.router?.lanCidr ? networkOf(f.router.lanCidr) : null;
  return (f.services ?? []).map((s) => {
    const id = `${s.host}:${s.port}`;
    const base = { id, title: s.title, port: s.port };
    const h = f.hosts?.find((x) => x.key === s.host);
    if (!h) return { ...base, entity: null, address: null, refused: '선언되지 않은 호스트' };
    const own = byId.get(h.kind === 'pve-node' ? `pve:node:${h.pveNode ?? h.key}` : `host:${h.key}`);
    const entity = (own ?? gateway)?.id ?? null; // A host the map has no object for reports on the router, as its other facts do.
    const current = currentOf(own, h.lease);
    if (current === undefined) return { ...base, entity, address: null, refused: '주소 미확인' };
    const address = plain(current);
    if (!isLanAddress(address)) return { ...base, entity, address: null, refused: 'LAN 주소가 아니다' };
    if (lan && !inNetwork(address, lan)) return { ...base, entity, address: null, refused: 'LAN 대역 밖이다' };
    return { ...base, entity, address };
  });
}

export type Reading = { at: string; result: ProbeResult };

/** At most four at a time: 32 services with every one timing out finish in 16 s. */
export async function runChecks(targets: Target[], probe: Probe, at: () => string, signal?: AbortSignal, timeoutMs = TIMEOUT_MS): Promise<Map<string, Reading>> {
  const todo = targets.filter((t) => t.address !== null && !t.refused);
  const out = new Map<string, Reading>();
  const work = async () => { for (let t = todo.shift(); t; t = todo.shift()) { const result = await probe(t.address!, t.port, timeoutMs, signal); out.set(t.id, { at: at(), result }); } };
  await Promise.all(Array.from({ length: CONCURRENCY }, work));
  return out;
}

const blank = (why: string): Fact<never> => ({ value: null, basis: 'unknown', source: SOURCE, at: null, ttlS: null, why });

/** Puts each result on its host. Down is a finding on the object, never a failure of the source. */
function checkOf(t: Target, readings: ReadonlyMap<string, Reading>, ttlS: number): ServiceCheck {
    const r = t.refused ? undefined : readings.get(t.id);
    const status: Fact<'up' | 'down'> = t.refused ? blank(t.refused) : !r ? blank('첫 검사 대기') : r.result.why === '검사 중단' ? blank('검사 중단') : { value: r.result.up ? 'up' : 'down', basis: 'observed', source: SOURCE, at: r.at, ttlS, ...(r.result.why ? { why: r.result.why } : {}) };
    return { title: t.title, port: t.port, latencyMs: status.value === 'up' ? (r?.result.latencyMs ?? null) : null, status };
}

/** The checks with no object to stand on. They still count: a declared service that is down is a problem wherever the map could put it. */
export const unplacedServices = (targets: Target[], readings: ReadonlyMap<string, Reading>, ttlS: number): ServiceCheck[] => targets.filter((t) => !t.entity).map((t) => checkOf(t, readings, ttlS));

export function applyServices(nodes: readonly Entity[], targets: Target[], readings: ReadonlyMap<string, Reading>, ttlS: number): Entity[] {
  if (!targets.length) return [...nodes];
  const found = new Map<string, { services: ServiceCheck[]; alerts: Alert[] }>();
  for (const t of targets) {
    if (!t.entity) continue;
    const slot = found.get(t.entity) ?? found.set(t.entity, { services: [], alerts: [] }).get(t.entity)!;
    const check = checkOf(t, readings, ttlS);
    slot.services.push(check);
    if (check.status.value === 'down') slot.alerts.push({ level: 'problem', text: `서비스 응답 없음 · ${t.title}` });
  }
  return nodes.map((e) => { const s = found.get(e.id); return s ? { ...e, services: s.services, alerts: [...(e.alerts ?? []), ...s.alerts] } : e; });
}
