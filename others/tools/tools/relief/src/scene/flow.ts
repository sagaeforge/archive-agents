// Links (design 9.12): colour and line style say the state of a link, and the number of moving packets says how much traffic was measured on it.
// A packet is never drawn without a measured rate: a link with no measurement keeps its colour and stays still.
import { freshness, type Entity, type Fact, type Snapshot } from '../../server/model/fact.ts';
import type { Pt } from './project.ts';

/** Floor units per second. One speed everywhere: the count carries the rate, and two meanings on one mark would read as neither. */
export const PACKET_SPEED = 90;
/** Per direction of one link, and on the whole map: the budget counts elements and frames (design 13). */
export const PACKETS_PER_LANE = 6;
export const PACKETS_TOTAL = 200;

/**
 * Packets for a rate in bytes a second: a decade per step, so 1 KB/s and 100 MB/s both read.
 * Under 1 B/s is none: nothing moved. Up to 10 KB/s is 1, then one more for each tenfold, up to 6 at 100 MB/s.
 */
export function packetsFor(rate: number): number {
  if (!(rate >= 1)) return 0;
  return Math.min(PACKETS_PER_LANE, Math.max(1, 1 + Math.floor(Math.log10(rate / 1000))));
}

/**
 * Shares the total out, lanes listed busiest first. Every link with anything measured gets one packet first, in its busier lane, so no measured link stands still.
 * That guarantee outranks the total: more measured links than the total means one packet each and no more. Only then do the rest go round, one a lane, a level at a time.
 */
export function allot(lanes: readonly { link: string; want: number }[], cap = PACKETS_TOTAL): number[] {
  const out = lanes.map(() => 0); const served = new Set<string>(); let left = cap;
  lanes.forEach((l, i) => { if (l.want > 0 && !served.has(l.link)) { served.add(l.link); out[i] = 1; left--; } });
  for (let level = 1; level <= PACKETS_PER_LANE && left > 0; level++) lanes.forEach((l, i) => { if (l.want >= level && out[i]! < level && left > 0) { out[i]!++; left--; } });
  return out;
}

export type Measured = { in: number; out: number };
const rateOf = (f: Fact<unknown> | undefined, nowMs: number) => (f?.basis === 'observed' && typeof f.value === 'number' && freshness(f, nowMs) === 'fresh' ? f.value : null);

/** What is measured on which link: a guest's own counters on the link to its bridge, a node's on its uplink, a PC's on its LAN link if it has any. Two links of one object cannot be told apart, so the first takes it. */
export function measuredLinks(s: Pick<Snapshot, 'nodes' | 'edges'>, nowMs: number): Map<string, Measured> {
  const out = new Map<string, Measured>(); const seen = new Set<string>();
  const byId = new Map(s.nodes.map((n) => [n.id, n]));
  for (const e of s.edges) {
    const t = byId.get(e.target);
    if ((e.kind !== 'attached' && e.kind !== 'uplink' && !(e.kind === 'lan' && t?.kind === 'workstation')) || seen.has(e.target)) continue;
    const i = rateOf(t?.facts.netIn, nowMs); const o = rateOf(t?.facts.netOut, nowMs);
    if (i !== null && o !== null) { out.set(e.id, { in: i, out: o }); seen.add(e.target); }
  }
  return out;
}

const lengthOf = (floor: readonly (readonly [number, number])[]) => floor.reduce((sum, p, i) => (i ? sum + Math.hypot(p[0] - floor[i - 1]![0], p[1] - floor[i - 1]![1]) : 0), 0);

/** Same speed everywhere, so a long cable takes longer. The start is spread by the id, or every packet would set out together. */
export function packetTiming(id: string, floor: readonly Pt[] | readonly (readonly [number, number])[]): { dur: number; delay: number } {
  const dur = Math.max(0.4, lengthOf(floor) / PACKET_SPEED);
  let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 9973;
  return { dur: Math.round(dur * 100) / 100, delay: -Math.round(((h % 100) / 100) * dur * 100) / 100 };
}
