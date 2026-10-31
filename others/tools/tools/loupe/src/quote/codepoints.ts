// KB offsets are Unicode code points (C 2.11). JS strings are UTF-16.
// The table is built only when the text has astral characters; otherwise the two units coincide (design 5).
const SURROGATE = /[\ud800-\udfff]/;
export const hasAstral = (s: string) => SURROGATE.test(s);

export type CpIndex = { length: number; toUtf16: (cp: number) => number; toCp: (utf16: number) => number };

export function cpIndex(text: string): CpIndex {
  if (!hasAstral(text)) {
    const clamp = (n: number) => Math.max(0, Math.min(n, text.length));
    return { length: text.length, toUtf16: clamp, toCp: clamp };
  }
  const offsets: number[] = [];
  let u = 0;
  for (const ch of text) { offsets.push(u); u += ch.length; }
  offsets.push(u);
  const table = Uint32Array.from(offsets);
  const n = table.length - 1;
  return {
    length: n,
    toUtf16: (cp) => table[Math.max(0, Math.min(cp, n))]!,
    toCp: (utf16) => {
      let lo = 0, hi = n;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (table[mid]! < utf16) lo = mid + 1; else hi = mid; }
      return lo;
    },
  };
}

export const cpLength = (s: string) => cpIndex(s).length;
export const cpSlice = (text: string, start: number, end: number) => { const ix = cpIndex(text); return text.slice(ix.toUtf16(start), ix.toUtf16(end)); };

/** Splits a snippet at code point highlights. Offsets are relative to the snippet (C 4.8). Bad ranges are dropped. */
export function splitHighlights(text: string, ranges: readonly { start: number; end: number }[]): { text: string; hit: boolean }[] {
  const ix = cpIndex(text);
  const sorted = [...ranges].filter((r) => r.start < r.end && r.end <= ix.length && r.start >= 0).sort((a, b) => a.start - b.start);
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const r of sorted) {
    if (r.start < at) continue;
    if (r.start > at) out.push({ text: text.slice(ix.toUtf16(at), ix.toUtf16(r.start)), hit: false });
    out.push({ text: text.slice(ix.toUtf16(r.start), ix.toUtf16(r.end)), hit: true });
    at = r.end;
  }
  if (at < ix.length) out.push({ text: text.slice(ix.toUtf16(at)), hit: false });
  return out;
}
