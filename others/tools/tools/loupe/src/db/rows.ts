// The rows of a database view and what is done with them (design v2 4.3): read a list item, show a cell as text, read a typed cell back, filter and sort.
// Pure: the table (DbView.tsx) and the save machine (rowSaver.ts) both stand on it.
import type { ColumnKey } from './view.ts';

export type Props = Record<string, unknown>;
export type Row = { id: string; type: string; label: string; status: string; version: number; recorded_at: string; sensitivity: string; props: Props };

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
/** A list item of `/v1/nodes`. Anything that is not the expected shape gets an empty value: the KB's answer is input like any other. */
export function rowFrom(n: Record<string, unknown>): Row {
  const props = n.props && typeof n.props === 'object' && !Array.isArray(n.props) ? n.props as Props : {};
  return { id: str(n.id), type: str(n.type), label: str(n.label), status: str(n.status, 'active'), version: typeof n.version === 'number' ? n.version : 0, recorded_at: str(n.recorded_at), sensitivity: str(n.sensitivity), props };
}

export const STATUS_LABEL: Record<string, string> = { active: '활성', dead: '보관됨' };

/** The value of a column of a row, the way it is sorted and shown. */
export function columnValue(row: Row, col: ColumnKey): unknown {
  switch (col) {
    case 'title': return row.label;
    case 'type': return row.type;
    case 'status': return row.status;
    case 'version': return row.version;
    case 'recorded_at': return row.recorded_at;
    default: return row.props[col];
  }
}

/** The text a cell shows and the text an input of the cell starts with. A value of the wrong shape shows as empty. */
export function cellText(col: ColumnKey, value: unknown): string {
  switch (col) {
    case 'tags': return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string').join(', ') : '';
    case 'order': return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    case 'pinned': return value === true ? '예' : '';
    case 'status': return STATUS_LABEL[String(value)] ?? String(value ?? '');
    case 'version': return typeof value === 'number' ? String(value) : '';
    default: return typeof value === 'string' ? value : '';
  }
}

export type Parsed = { ok: true; value: unknown } | { ok: false; reason: string };
/** What the person typed into the cell of a property column, as the value `props` holds. */
export function parseCell(col: ColumnKey, text: string): Parsed {
  switch (col) {
    case 'tags': return { ok: true, value: text.split(',').map((t) => t.trim()).filter(Boolean) };
    case 'order': {
      const t = text.trim();
      const n = Number(t);
      return t !== '' && Number.isFinite(n) ? { ok: true, value: n } : { ok: false, reason: '숫자가 아니다' };
    }
    case 'pinned': return { ok: true, value: text === 'true' };
    case 'icon': return { ok: true, value: text.trim() };
    default: return { ok: false, reason: '고칠 수 없는 열이다' };
  }
}

/** The whole `props` after some cells changed: every key the record has stays, the named ones take their new value. A new object; the old one is not touched. */
export const nextProps = (props: Props, cells: Props): Props => ({ ...props, ...cells });

const fold = (s: string) => s.normalize('NFC').toLowerCase();
export type RowFilter = { text: string; tag: string };
/** Both parts narrow: the text is in the title, and a tag contains the tag text. An empty part lets everything through. */
export function filterRows(rows: readonly Row[], f: RowFilter): Row[] {
  const text = fold(f.text.trim()), tag = fold(f.tag.trim());
  return rows.filter((r) => {
    if (text && !fold(r.label).includes(text)) return false;
    if (!tag) return true;
    const tags = Array.isArray(r.props.tags) ? r.props.tags.filter((x): x is string => typeof x === 'string') : [];
    return tags.some((t) => fold(t).includes(tag));
  });
}

/** Rows without a value for the sort column go last in either direction; the rest by the value, Korean collation for text. */
export function sortRows(rows: readonly Row[], sort: { key: ColumnKey; desc: boolean }): Row[] {
  const collator = new Intl.Collator('ko');
  const present = (v: unknown) => v !== undefined && v !== null && v !== '';
  return [...rows].sort((a, b) => {
    const x = columnValue(a, sort.key), y = columnValue(b, sort.key);
    if (!present(x) || !present(y)) return present(x) === present(y) ? a.id.localeCompare(b.id) : present(x) ? -1 : 1;
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(cellText(sort.key, x) || String(x), cellText(sort.key, y) || String(y));
    return (sort.desc ? -c : c) || a.id.localeCompare(b.id);
  });
}
