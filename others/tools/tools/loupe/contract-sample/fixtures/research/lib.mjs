// Shared helpers for the fixture builders. Everything here is plain data shaping: no network, no clock.
import { createHash } from 'node:crypto';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const sha1 = (s, n = 12) => createHash('sha1').update(s).digest('hex').slice(0, n);
export const cps = (s) => [...s];
export const nfc = (s) => s.normalize('NFC');

/** ValidTime. A missing precision with a date defaults to day. */
export const V = (from = null, to = null, precision = 'day') => ({ from, to, precision: from || to ? precision : null, label: null });

/** Locate `exact` in `body` and return a W3C TextQuoteSelector with code point offsets (contract 2.11). Throws when absent. */
export function quoteAt(body, exact, { ctx = 16, nth = 0 } = {}) {
  const all = cps(body);
  const ex = cps(exact);
  let seen = -1;
  for (let i = 0; i + ex.length <= all.length; i++) {
    if (all[i] !== ex[0]) continue;
    let ok = true;
    for (let j = 1; j < ex.length; j++) if (all[i + j] !== ex[j]) { ok = false; break; }
    if (!ok) continue;
    if (++seen < nth) continue;
    return {
      exact,
      prefix: all.slice(Math.max(0, i - ctx), i).join(''),
      suffix: all.slice(i + ex.length, i + ex.length + ctx).join(''),
      start: i,
      end: i + ex.length,
    };
  }
  throw new Error(`quote not found (nth=${nth}): ${exact.slice(0, 90)}`);
}

/** Count occurrences, so a builder can warn about ambiguous quotes. */
export function occurrences(body, exact) {
  let n = 0, i = -1;
  while ((i = body.indexOf(exact, i + 1)) >= 0) n++;
  return n;
}

/** Resolve an RFC 6901 pointer. */
export function jsonPointer(doc, ptr) {
  if (ptr === '') return doc;
  return ptr.slice(1).split('/').reduce((n, raw) => n?.[raw.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
}

export const ts = (s) => Date.parse(s);
export const addSeconds = (iso, n) => new Date(ts(iso) + n * 1000).toISOString().replace('.000Z', 'Z');
