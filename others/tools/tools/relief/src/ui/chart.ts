// The arithmetic of the trend charts, apart from React so it can be tested.
/** Runs of consecutive values. A missing sample breaks the line: nothing is drawn across a hole. */
export function runs(values: readonly (number | null)[]): [number, number][][] {
  const out: [number, number][][] = []; let cur: [number, number][] = [];
  values.forEach((v, i) => { if (v === null) { if (cur.length) out.push(cur); cur = []; } else cur.push([i, v]); });
  if (cur.length) out.push(cur);
  return out;
}

/** A round top for a rate axis. Zero data still gives an axis. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1000;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((m) => m * p).find((c) => c >= v)!;
}

export const percent = (v: number) => `${Math.round(v * 100)}%`;

export function rateText(v: number): string {
  if (v < 1000) return `${Math.round(v)} B/s`;
  if (v < 1e6) return `${(v / 1e3).toFixed(v < 1e4 ? 1 : 0)} KB/s`;
  return `${(v / 1e6).toFixed(v < 1e7 ? 1 : 0)} MB/s`;
}

export const clock = (t: number, day: boolean) => new Date(t * 1000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, ...(day ? { day: 'numeric' } : {}) });

export const nearest = (x: number, n: number, x0: number, x1: number) => (n < 2 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((x - x0) / (x1 - x0)) * (n - 1)))));
