// Display rules for time (design 4). Stored as UTC, shown in KST, with the UTC original in `title`.
// Dates stay dates: a date value never moves across a time zone.
import type { ValidTime } from '../client/model/index.ts';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const parts = (ms: number) => Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));

export function formatKst(iso: string, opts: { seconds?: boolean } = {}): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}${opts.seconds ? `:${p.second}` : ''} KST`;
}

/** An axis value on the valid axis: midnight UTC is a calendar date, anything else is an instant. */
export function formatValidAxis(iso: string): string {
  return /T00:00:00(\.000)?Z$/.test(iso) ? iso.slice(0, 10) : formatKst(iso);
}

const periodOf = (s: string, precision: ValidTime['precision']): string => {
  if (s.includes('T')) return formatKst(s);
  switch (precision) {
    case 'year': return s.slice(0, 4);
    case 'month': return s.slice(0, 7);
    case 'quarter': return `${s.slice(0, 4)}-Q${Math.ceil(Number(s.slice(5, 7)) / 3)}`;
    default: return s;
  }
};

/** `label` first, otherwise the bounds at their own precision. Returns '' when no bound is known. */
export function formatValid(v: ValidTime | null | undefined): string {
  if (!v) return '';
  if (v.label) return v.label;
  const from = v.from ? periodOf(v.from, v.precision) : null;
  const to = v.to ? periodOf(v.to, v.precision) : null;
  if (from && to) return from === to ? from : `${from} ~ ${to}`;
  if (from) return `${from}부터`;
  if (to) return `${to}까지`;
  return '';
}

/** Value for <input type="datetime-local"> in KST. */
export function kstInputFromIso(iso: string): string {
  const p = parts(Date.parse(iso));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

const dateOk = (d: string) => { const t = Date.parse(`${d}T00:00:00Z`); return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d; };

export function isoFromKstInput(v: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(v.trim());
  if (!m || !m[1] || !dateOk(m[1])) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3] ?? '00'}+09:00`);
  return Number.isNaN(t) ? null : new Date(t).toISOString().replace('.000Z', 'Z');
}

/** A valid date is a calendar date: T00:00:00Z, with no zone shift (design 4). */
export function isoFromDateInput(v: string): string | null {
  const d = v.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && dateOk(d) ? `${d}T00:00:00Z` : null;
}

export type DateQuery = { display: string; valid: string | null; observed: string };
/** What the palette understands as a date: YYYY-MM-DD, or YYYY-MM-DD HH:mm in KST. */
export function parseDateQuery(q: string): DateQuery | null {
  const s = q.trim();
  const valid = isoFromDateInput(s);
  if (valid) return { display: s, valid, observed: isoFromKstInput(`${s}T00:00`)! };
  const observed = isoFromKstInput(s);
  return observed ? { display: `${s.replace('T', ' ')} KST`, valid: null, observed } : null;
}
