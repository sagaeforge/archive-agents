// Metric history for the selected object (design 9.8): `rrddata`, read on demand and never in a loop. Named fields only; the rest of each row stops here.
import { z } from 'zod';
import type { Timeframe } from './allowlist.ts';
import { ReadError, type Reader } from './mcp.ts';

export type TrendRef = { kind: 'node'; node: string } | { kind: 'qemu' | 'lxc'; node: string; vmid: number };
export type TrendPoint = { t: number; cpu: number | null; mem: number | null; disk: number | null; netIn: number | null; netOut: number | null };
export type Trend = { id: string; tf: Timeframe; at: string | null; points: TrendPoint[]; why?: string };

/** A day comes back as 1,440 rows, 690 KB [measured 2026-11-01]. The panel has about 320 pixels. */
export const MAX_POINTS = 120;

const n = z.number().nullable().optional();
const Row = z.object({ time: z.number(), cpu: n, memused: n, memtotal: n, rootused: n, roottotal: n, mem: n, maxmem: n, disk: n, maxdisk: n, netin: n, netout: n });
type Row = z.infer<typeof Row>;

const frac = (a: number | null | undefined, b: number | null | undefined) => (typeof a === 'number' && typeof b === 'number' && b > 0 ? Math.min(1, Math.max(0, a / b)) : null);
const rate = (v: number | null | undefined) => (typeof v === 'number' && v >= 0 ? v : null);

function point(r: Row, kind: TrendRef['kind']): TrendPoint {
  const node = kind === 'node';
  // QEMU reports 0 here whatever the disk holds [measured]: a 0 would be a made-up value.
  const disk = node ? frac(r.rootused, r.roottotal) : kind === 'qemu' && !r.disk ? null : frac(r.disk, r.maxdisk);
  return { t: r.time, cpu: typeof r.cpu === 'number' ? Math.min(1, Math.max(0, r.cpu)) : null, mem: node ? frac(r.memused, r.memtotal) : frac(r.mem, r.maxmem), disk, netIn: rate(r.netin), netOut: rate(r.netout) };
}

const FIELDS = ['cpu', 'mem', 'disk', 'netIn', 'netOut'] as const;

/** Means over equal buckets, each stamped with its last time. A bucket with no value stays empty: a gap is shown as a gap. */
export function bucket(points: TrendPoint[], max = MAX_POINTS): TrendPoint[] {
  if (points.length <= max) return points;
  const size = Math.ceil(points.length / max);
  const out: TrendPoint[] = [];
  for (let i = 0; i < points.length; i += size) {
    const part = points.slice(i, i + size);
    const p: TrendPoint = { t: part.at(-1)!.t, cpu: null, mem: null, disk: null, netIn: null, netOut: null };
    for (const f of FIELDS) { const v = part.flatMap((x) => (x[f] === null ? [] : [x[f]!])); p[f] = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }
    out.push(p);
  }
  return out;
}

export async function readTrend(r: Reader, ref: TrendRef, tf: Timeframe, signal?: AbortSignal): Promise<TrendPoint[]> {
  const path = ref.kind === 'node' ? `/nodes/${ref.node}/rrddata` : `/nodes/${ref.node}/${ref.kind}/${ref.vmid}/rrddata`;
  const parsed = z.array(Row).safeParse(await r.read({ tool: 'proxmox_api_get', path, params: { timeframe: tf } }, signal));
  if (!parsed.success) throw new ReadError('path', '응답 모양이 다르다');
  return bucket(parsed.data.map((x) => point(x, ref.kind)).sort((a, b) => a.t - b.t));
}
