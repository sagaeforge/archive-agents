// Traffic rates (design 8, 9.12): deltas of the byte counters PVE already reports, over PVE's own timestamps. Measured or nothing: a first sample, a reset and a gap all give no rate.
import type { Entity, Fact } from './fact.ts';

export type Counter = { in: number; out: number; t: number };
export type Rate = { in: number; out: number; at: string } | { why: string };

/** Past this the two samples say little about now: a viewer came back, or reads stopped. Seconds of PVE time. */
export const MAX_GAP_S = 120;
export const WAITING = '측정 대기';
export const RESET = '카운터 재설정';
const SOURCE = 'pve:/cluster/metrics/export';

export class Rates {
  private last = new Map<string, { c: Counter; rate: Rate }>();

  /** One reading of one object. A repeat of the same PVE tick changes nothing: the rate it gave still stands. */
  push(id: string, c: Counter, at: string) {
    const prev = this.last.get(id);
    if (!prev) { this.last.set(id, { c, rate: { why: WAITING } }); return; }
    const dt = c.t - prev.c.t;
    if (dt === 0) return;
    const reset = dt < 0 || c.in < prev.c.in || c.out < prev.c.out;
    const rate: Rate = reset ? { why: RESET } : dt > MAX_GAP_S ? { why: WAITING } : { in: (c.in - prev.c.in) / dt, out: (c.out - prev.c.out) / dt, at };
    this.last.set(id, { c, rate });
  }

  /** A failed read is a hole: what comes after it starts over. */
  gap() { this.last.clear(); }
  /** What PVE no longer lists has no baseline. */
  keep(ids: ReadonlySet<string>) { for (const id of this.last.keys()) if (!ids.has(id)) this.last.delete(id); }
  of(id: string): Rate | null { return this.last.get(id)?.rate ?? null; }
}

const blank = (why: string): Fact<never> => ({ value: null, basis: 'unknown', source: SOURCE, at: null, ttlS: null, why });

/** Guests and nodes carry their own rate. Computed at publish time: a rate is no change of the object. */
export function applyRates(nodes: readonly Entity[], rates: Rates, ttlS: number, nowMs: number): Entity[] {
  return nodes.map((e) => {
    if ((e.kind !== 'node' && e.kind !== 'vm' && e.kind !== 'lxc') || e.gone || e.basis !== 'observed') return e;
    const held = rates.of(e.id) ?? { why: WAITING };
    // A rate past its time is waiting for the next read: it never reaches the map as a stale value.
    const r: Rate = 'at' in held && (nowMs - Date.parse(held.at)) / 1000 > ttlS ? { why: WAITING } : held;
    const fact = (lane: 'in' | 'out'): Fact<number> => ('why' in r ? blank(r.why) : { value: Math.round(r[lane]), basis: 'observed', source: SOURCE, at: r.at, ttlS });
    return { ...e, facts: { ...e.facts, netIn: fact('in'), netOut: fact('out') } };
  });
}
