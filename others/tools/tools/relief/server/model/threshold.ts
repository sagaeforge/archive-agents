// Threshold warnings (design 9.8): computed from the fast loop's own samples, shown as derived, and only after a value has held for a stated time, so one spike does not alarm.
// Missing data is "비교 불가", never "under the limit": a check with nothing to compare has no verdict.
import { ageS, type Alert, type Entity, type Fact, type Kind, type Limits } from './fact.ts';

export const DEFAULT_LIMITS: Limits = { cpu: 0.9, mem: 0.9, disk: 0.85, sustainS: 45 };

export type Metric = 'cpu' | 'mem' | 'disk';
const LABEL: Record<Metric, string> = { cpu: 'CPU', mem: '메모리', disk: '디스크' };
export const CHECK_KEY: Record<Metric, 'checkCpu' | 'checkMem' | 'checkDisk'> = { cpu: 'checkCpu', mem: 'checkMem', disk: 'checkDisk' };
const SOURCE = 'rule:threshold';
export const ABOVE = '임계 초과';
export const BELOW = '임계 미만';
const KEEP = 400; // 900 s, the longest `sustainS`, at the 4 s pace, and some.

/** What each kind can be compared on. A storage has only its fill. */
const METRICS: Partial<Record<Kind, readonly Metric[]>> = { node: ['cpu', 'mem', 'disk'], vm: ['cpu', 'mem', 'disk'], lxc: ['cpu', 'mem', 'disk'], storage: ['disk'] };

type Sample = Record<Metric, number | null> & { t: number };
const numeric = (f: Fact<unknown> | undefined): number | null => (f?.basis === 'observed' && typeof f.value === 'number' && Number.isFinite(f.value) ? f.value : null);

/** The last samples of each object. Memory only: after a restart the run starts over, and until it fills the check says so. */
export class Samples {
  private runs = new Map<string, Sample[]>();
  private last: { at: string; ttlS: number } | null = null;

  /** One sample per good inventory read. */
  push(nodes: readonly Entity[], at: string, ttlS: number) {
    const seen = new Set<string>();
    for (const e of nodes) {
      if (!METRICS[e.kind] || e.gone) continue;
      seen.add(e.id);
      const run = this.runs.get(e.id) ?? [];
      run.push({ t: Date.parse(at), cpu: numeric(e.facts.cpu), mem: numeric(e.facts.mem), disk: numeric(e.facts.disk) });
      this.runs.set(e.id, run.slice(-KEEP));
    }
    for (const id of this.runs.keys()) if (!seen.has(id)) this.runs.delete(id);
    this.last = { at, ttlS };
  }

  /** A failed read breaks every run: samples either side of a hole are not "in a row". */
  gap() { this.runs.clear(); this.last = null; }

  run(id: string) { return this.runs.get(id) ?? []; }
  get at() { return this.last; }
}

const unknown = (why: string): Fact<never> => ({ value: null, basis: 'unknown', source: SOURCE, at: null, ttlS: null, why: `비교 불가 · ${why}` });

function check(e: Entity, m: Metric, samples: Samples, limits: Limits, nowMs: number): { fact: Fact<unknown>; over: boolean | null } {
  const running = e.kind === 'node' || e.kind === 'storage' || e.state === 'running' || e.state === 'starting' || e.state === 'stopping' || e.state === 'migrating';
  if (!running) return { fact: unknown(e.state === 'stopped' ? '실행 중이 아니다' : '상태를 모른다'), over: null };
  const own = e.facts[m];
  if (own?.basis === 'unknown') return { fact: unknown(own.why ?? '값이 없다'), over: null };
  const last = samples.at;
  if (!last) return { fact: unknown('표본이 없다'), over: null };
  const age = ageS(last.at, nowMs);
  if (age === null || age > last.ttlS) return { fact: unknown('값이 낡았다'), over: null };
  // The rule is a length of time, not a count: at the 4 s pace four samples would be a 12 s blip. The window reaches back to the sample at or before its start.
  const all = samples.run(e.id);
  const end = all.at(-1)?.t ?? 0;
  const held = all.length ? (end - all[0]!.t) / 1000 : 0;
  if (held < limits.sustainS) return { fact: unknown(`표본 ${Math.floor(held)}/${limits.sustainS} s`), over: null };
  const start = end - limits.sustainS * 1000;
  const run = all.slice(all.findLastIndex((x) => x.t <= start));
  const values = run.map((x) => x[m]);
  if (values.some((v) => v === null)) return { fact: unknown('값이 없다'), over: null };
  const limit = limits[m];
  const over = (values as number[]).every((v) => v >= limit);
  const pct = Math.round(limit * 100);
  return { fact: { value: over ? `${ABOVE} · ${pct}% · ${limits.sustainS}초 지속` : `${BELOW} · ${pct}%`, basis: 'derived', source: SOURCE, at: last.at, ttlS: null }, over };
}

export type Verdicts = Map<string, boolean>;

/**
 * The check facts and alerts of every object that has metrics.
 * @param verdicts filled with `id|metric` -> over, for each check that has a verdict. Blank checks stay out, so a hole in the data is no "recovery".
 */
export function applyChecks(nodes: readonly Entity[], samples: Samples, limits: Limits, nowMs: number, verdicts?: Verdicts): Entity[] {
  return nodes.map((e) => {
    const metrics = METRICS[e.kind];
    if (!metrics || e.gone || e.basis !== 'observed') return e;
    const facts = { ...e.facts }; const alerts: Alert[] = [...(e.alerts ?? [])];
    for (const m of metrics) {
      const { fact, over } = check(e, m, samples, limits, nowMs);
      facts[CHECK_KEY[m]] = fact;
      if (over) alerts.push({ level: 'warn', text: `${LABEL[m]} ${ABOVE}` });
      if (over !== null) verdicts?.set(`${e.id}|${m}`, over);
    }
    return { ...e, facts, ...(alerts.length ? { alerts } : {}) };
  });
}
