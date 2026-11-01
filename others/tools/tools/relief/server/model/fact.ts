// Snapshot and Fact types (design 3, 4) plus the read-time rules: freshness is computed, never stored.

export type Basis = 'observed' | 'derived' | 'declared' | 'unknown';
export type State = 'running' | 'stopped' | 'creating' | 'starting' | 'stopping' | 'migrating' | 'error' | 'ok' | 'unknown';
export type Kind =
  | 'wan' | 'modem' | 'domain' | 'gateway' | 'tunnel' | 'proxy' | 'switch' | 'wifi' | 'clients' | 'segment'
  | 'node' | 'workstation' | 'bmc' | 'bridge' | 'storage' | 'vm' | 'lxc' | 'container';
export type RelKind = 'hosts' | 'runs' | 'attached' | 'uplink' | 'route' | 'wan' | 'dns' | 'wireless' | 'tunnel' | 'lan' | 'forward' | 'mounts';

export type Fact<T> = {
  value: T | null;
  basis: Basis;
  /** Where the value comes from, not the way it travelled: 'pve:/cluster/resources', 'rule:same-subnet', 'edge.json#/lines/0'. */
  source: string;
  /** Observation time, or the declaration date of a declared fact. */
  at: string | null;
  /** Observed facts only: three polling periods. */
  ttlS: number | null;
  /** Declared facts only. */
  reviewBy?: string;
  /** Why the value is empty: 'guest agent 응답 없음', '출처 없음'. */
  why?: string;
};

export type Entity = {
  id: string;
  kind: Kind;
  title: string;
  parent?: string;
  state: State;
  basis: Basis;
  facts: Record<string, Fact<unknown>>;
  /** Read as absent by a healthy source: kept one cycle as an outline, then removed (design 4). */
  gone?: boolean;
  /** Drift between two values (design 7.1). A warning on the object: its source stays `ok`. */
  warnings?: string[];
};

export type Relation = {
  id: string;
  source: string;
  target: string;
  kind: RelKind;
  basis: Basis;
  facts: Record<string, Fact<unknown>>;
};

/** none: no configuration. ok: read (an empty list is "0 observed"). failing: configured and failing. */
export type SourceState = 'none' | 'ok' | 'failing';
export type SourceStatus = { id: string; state: SourceState; count: number | null; at: string | null; why?: string; counts?: Record<string, number> };

export type Box = { x: number; y: number; w: number; h: number; z: number; zh: number };

export type Snapshot = {
  schema: 1;
  seq: number;
  takenAt: string;
  /** Absent on stored fixtures. The screen labels synthetic data as such. */
  origin?: 'live' | 'fixture';
  nodes: Entity[];
  edges: Relation[];
  sources: SourceStatus[];
  /** Absolute floor coordinates. A child sits on its parent: z is the parent's z + zh. */
  layout: Record<string, Box>;
  /** Floor routes of edges, from the layout step. Not in the design's type: ELK returns them and the browser has no ELK. */
  routes: Record<string, [number, number][]>;
};

export const BASES: readonly Basis[] = ['observed', 'derived', 'declared', 'unknown'];

export const BASIS_LABEL: Record<Basis, string> = { observed: '관측', derived: '추정', declared: '선언', unknown: '미확인' };

// --- freshness (design 4)

export const ageS = (at: string | null, nowMs: number): number | null => {
  if (!at) return null;
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : Math.max(0, (nowMs - t) / 1000);
};

export type Freshness = 'fresh' | 'stale' | 'n/a';

/** Only observed facts with a ttl go stale. The age comes from the fact's own `at`, not the snapshot's `takenAt`. */
export const freshness = (f: Fact<unknown>, nowMs: number): Freshness => {
  if (f.basis !== 'observed' || f.ttlS == null) return 'n/a';
  const a = ageS(f.at, nowMs);
  if (a == null) return 'stale';
  return a <= f.ttlS ? 'fresh' : 'stale';
};

/** A declared fact whose review date has passed keeps its stripes and gains a note. */
export const reviewPassed = (f: Fact<unknown>, nowMs: number): boolean =>
  f.basis === 'declared' && f.reviewBy != null && Date.parse(f.reviewBy) < nowMs;

/** An entity is stale when any of its observed facts is, or when an ancestor is: a failed node dims everything on it. */
export function staleIds(s: Pick<Snapshot, 'nodes'>, nowMs: number): Set<string> {
  const byId = new Map(s.nodes.map((n) => [n.id, n]));
  const own = (n: Entity) => Object.values(n.facts).some((f) => freshness(f, nowMs) === 'stale');
  const memo = new Map<string, boolean>();
  const walk = (n: Entity): boolean => {
    const hit = memo.get(n.id);
    if (hit !== undefined) return hit;
    memo.set(n.id, false); // guards a parent cycle
    const p = n.parent ? byId.get(n.parent) : undefined;
    const v = own(n) || (p ? walk(p) : false);
    memo.set(n.id, v);
    return v;
  };
  const out = new Set<string>();
  for (const n of s.nodes) if (walk(n)) out.add(n.id);
  return out;
}

/** "12초 전", "4분 전", "2시간 전", "3일 전". */
export const ageText = (sec: number): string =>
  sec < 60 ? `${Math.round(sec)}초 전` : sec < 3600 ? `${Math.floor(sec / 60)}분 전` : sec < 86400 ? `${Math.floor(sec / 3600)}시간 전` : `${Math.floor(sec / 86400)}일 전`;

/** The panel wording of design 4. */
export function basisNote(f: Fact<unknown>, nowMs: number): string {
  switch (f.basis) {
    case 'observed': {
      const a = ageS(f.at, nowMs);
      const base = a == null ? '관측' : `관측 · ${ageText(a)}`;
      return freshness(f, nowMs) === 'stale' ? `${base} · 낡음` : base;
    }
    case 'derived': return `추정 · ${f.source.replace(/^rule:/, '')}`;
    case 'declared': return `선언 · ${f.at ?? '날짜 없음'}${reviewPassed(f, nowMs) ? ' · 검토일 지남' : ''}`;
    case 'unknown': return `미확인 · ${f.why ?? '이유 없음'}`;
  }
}

// --- shape check. The server refuses a snapshot that fails it, and the tests run every fixture through it.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isBasis = (v: unknown): v is Basis => typeof v === 'string' && (BASES as readonly string[]).includes(v);

export function validateSnapshot(x: unknown): string[] {
  const bad: string[] = [];
  if (!isObj(x)) return ['not an object'];
  if (x.schema !== 1) bad.push('schema must be 1');
  if (typeof x.seq !== 'number') bad.push('seq must be a number');
  if (typeof x.takenAt !== 'string') bad.push('takenAt must be a string');
  if (!Array.isArray(x.nodes) || !Array.isArray(x.edges) || !Array.isArray(x.sources)) return [...bad, 'nodes, edges, sources must be arrays'];
  const ids = new Set<string>();
  for (const n of x.nodes as unknown[]) {
    if (!isObj(n) || typeof n.id !== 'string') { bad.push('entity without id'); continue; }
    if (ids.has(n.id)) bad.push(`duplicate id ${n.id}`);
    ids.add(n.id);
    if (!isBasis(n.basis)) bad.push(`${n.id}: basis missing`);
    if (typeof n.title !== 'string') bad.push(`${n.id}: title missing`);
    if (!isObj(n.facts)) { bad.push(`${n.id}: facts missing`); continue; }
    for (const [k, f] of Object.entries(n.facts)) {
      if (!isObj(f) || !isBasis(f.basis) || typeof f.source !== 'string' || !('value' in f) || !('at' in f)) bad.push(`${n.id}.${k}: not a fact`);
      else if (f.basis === 'unknown' && f.value !== null) bad.push(`${n.id}.${k}: unknown fact carries a value`);
    }
  }
  for (const n of x.nodes as { id: string; parent?: string }[]) if (n.parent && !ids.has(n.parent)) bad.push(`${n.id}: parent ${n.parent} missing`);
  for (const e of x.edges as unknown[]) {
    if (!isObj(e) || typeof e.id !== 'string') { bad.push('edge without id'); continue; }
    if (!ids.has(String(e.source)) || !ids.has(String(e.target))) bad.push(`${e.id}: endpoint missing`);
    if (!isBasis(e.basis)) bad.push(`${e.id}: basis missing`);
  }
  return bad;
}
