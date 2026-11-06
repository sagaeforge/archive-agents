// The change history (design 8, 9.9): `changes.jsonl`, newest first, one bounded page at a time. Every line is parsed down to named fields: a hand-edited file is data.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { z } from 'zod';

export const PAGE_DEFAULT = 30;
export const PAGE_MAX = 100;
/** Rows of one entry. A first collection can add hundreds of objects at once. */
export const ROWS_MAX = 24;
/** The file is cut at about 5,500 lines. This holds even if it was not. */
export const READ_MAX = 4 * 1024 * 1024;
const TEXT = 200;

export const CHANGE_TYPES = ['added', 'removed', 'changed', 'state', 'source', 'alert', 'service'] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];
export const isChangeType = (v: unknown): v is ChangeType => (CHANGE_TYPES as readonly unknown[]).includes(v);
export type ChangeRow = { type: ChangeType; id?: string; text?: string };
export type ChangeEntry = { n: number; at: string; seq: number | null; rows: ChangeRow[]; more: number };
export type ChangePage = { items: ChangeEntry[]; next: number | null; total: number };

/** The number each line carries. Rotation removes lines and moves nothing; two lines of one millisecond stay two. */
export const isCursor = (v: string) => /^-?\d{1,12}$/.test(v);

const short = z.string().max(4096).transform((s) => s.slice(0, TEXT));
const Line = z.object({
  n: z.number().int().optional(), at: short, seq: z.number().optional(),
  added: z.array(short).optional(), removed: z.array(short).optional(), changed: z.array(short).optional(),
  state: z.union([z.array(z.object({ id: short, from: short, to: short })), short]).optional(),
  source: short.optional(), why: short.optional(),
  alerts: z.array(z.object({ id: short, text: short, on: z.boolean() })).optional(),
  services: z.array(z.object({ id: short, to: short })).optional(),
});

function rowsOf(l: z.infer<typeof Line>): ChangeRow[] {
  const ids = (type: ChangeRow['type'], list?: string[]) => (list ?? []).map((id): ChangeRow => (id.startsWith('edge:') ? { type, text: '연결' } : { type, id }));
  const out: ChangeRow[] = [];
  if (l.source !== undefined) out.push({ type: 'source', text: `${l.source} ${typeof l.state === 'string' ? l.state : ''}${l.why ? ` · ${l.why}` : ''}` });
  if (Array.isArray(l.state)) for (const s of l.state) out.push({ type: 'state', id: s.id, text: `${s.from} → ${s.to}` });
  for (const a of l.alerts ?? []) out.push({ type: 'alert', id: a.id, text: `${a.text} ${a.on ? '시작' : '해제'}` });
  for (const s of l.services ?? []) out.push({ type: 'service', id: s.id, text: s.to });
  const moved = new Set(Array.isArray(l.state) ? l.state.map((s) => s.id) : []);
  return [...out, ...ids('added', l.added), ...ids('removed', l.removed), ...ids('changed', l.changed?.filter((id) => !moved.has(id)))];
}

/** The tail of the file, from the first whole line. */
function tail(file: string): string[] {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return []; }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, READ_MAX);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    const lines = (size > len ? text.slice(text.indexOf('\n') + 1) : text).split('\n');
    return lines.filter(Boolean);
  } catch { return []; } finally { closeSync(fd); }
}

export type ChangeQuery = { limit: number; before?: number | undefined; type?: ChangeType | undefined; id?: string | undefined };

/** @param before the cursor from the last page's `next`. Absent: the newest page. Lines older than the cursor follow, whether or not its own line is still in the file. `type` and `id` keep the rows that match, and an entry with none left is skipped. */
export function readChanges(file: string, q: ChangeQuery): ChangePage {
  const lines = tail(file);
  // Lines from before numbering keep their order below the first number.
  const parsed: { n: number; line: z.infer<typeof Line> | null }[] = [];
  const firstNumber = lines.findIndex((t) => /^\{"n":/.test(t));
  const base = firstNumber < 0 ? lines.length : firstNumber;
  lines.forEach((text, i) => {
    let raw: unknown = null;
    try { raw = JSON.parse(text); } catch { /* not a record: it keeps a place and shows nothing */ }
    const l = Line.safeParse(raw);
    const good = l.success && !Number.isNaN(Date.parse(l.data.at));
    parsed.push({ n: good && l.data.n !== undefined ? l.data.n : i - base, line: good ? l.data : null });
  });
  const items: ChangeEntry[] = [];
  let i = parsed.length - 1;
  if (q.before !== undefined) while (i >= 0 && parsed[i]!.n >= q.before) i--;
  for (; i >= 0 && items.length < q.limit; i--) {
    const { n, line } = parsed[i]!;
    if (!line) continue;
    const rows = rowsOf(line).filter((r) => (q.type === undefined || r.type === q.type) && (q.id === undefined || r.id === q.id));
    if (!rows.length && (q.type !== undefined || q.id !== undefined)) continue;
    items.push({ n, at: line.at, seq: line.seq ?? null, rows: rows.slice(0, ROWS_MAX), more: Math.max(0, rows.length - ROWS_MAX) });
  }
  return { items, next: i >= 0 && items.length ? items.at(-1)!.n : null, total: lines.length };
}
