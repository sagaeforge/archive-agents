// The definition of a database view (design v2 4.3): the body of a ```loupe-view block. It is loupe's own format and a plain JSON object,
// `{"type":"Note","columns":["title","tags"],"sort":"-recorded_at","filter":{"tag":"m4"}}`, so a document that is never opened in loupe keeps
// reading as what it is and the format needs no parser of its own. No module of the DOM, the network or React is imported here.

/** A column is a field of the record or one of the properties the design names for the type (2.1: a memo has `tags`, `pinned`; a document `tags`, `order`, `icon`). */
export const COLUMN_KEYS = ['title', 'type', 'status', 'version', 'recorded_at', 'tags', 'pinned', 'order', 'icon'] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];
export type ViewType = 'Note' | 'Page';
export const VIEW_TYPES: readonly ViewType[] = ['Note', 'Page'];

export const COLUMN_LABEL: Record<ColumnKey, string> = {
  title: '제목', type: '종류', status: '상태', version: '판', recorded_at: '기록 시각', tags: '태그', pinned: '고정', order: '순서', icon: '아이콘',
};
/** The columns that are properties of the record, with the types that have them. They are the cells that can be edited (the record's `props`). */
export const PROP_COLUMNS: Readonly<Record<ViewType, readonly ColumnKey[]>> = { Note: ['tags', 'pinned'], Page: ['tags', 'order', 'icon'] };
export const isPropColumn = (type: ViewType, col: ColumnKey) => PROP_COLUMNS[type].includes(col);

export type ViewDef = {
  type: ViewType;
  columns: ColumnKey[];
  sort: { key: ColumnKey; desc: boolean };
  /** The filter the view starts with. The person's own filter is kept apart from it (store.ts). */
  filter: { text: string; tag: string };
};
export type ParsedView = { ok: true; def: ViewDef } | { ok: false; reason: string };

export const defaultColumns = (type: ViewType): ColumnKey[] => ['title', ...PROP_COLUMNS[type], 'status', 'version'];

const isColumn = (v: unknown): v is ColumnKey => typeof v === 'string' && (COLUMN_KEYS as readonly string[]).includes(v);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const KEYS = new Set(['type', 'columns', 'sort', 'filter']);

export function parseView(source: string): ParsedView {
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { return { ok: false, reason: 'JSON이 아니다' }; }
  if (!isRecord(raw)) return { ok: false, reason: 'JSON 객체가 아니다' };
  for (const k of Object.keys(raw)) if (!KEYS.has(k)) return { ok: false, reason: `모르는 칸: ${k.slice(0, 30)}` };
  const type = raw.type;
  if (type !== 'Note' && type !== 'Page') return { ok: false, reason: 'type은 Note 또는 Page다' };
  let columns: ColumnKey[];
  if (raw.columns === undefined) columns = defaultColumns(type);
  else {
    if (!Array.isArray(raw.columns) || raw.columns.length === 0) return { ok: false, reason: 'columns는 비어 있지 않은 목록이다' };
    if (!raw.columns.every(isColumn)) return { ok: false, reason: '모르는 열이 있다' };
    columns = [...new Set(raw.columns as ColumnKey[])];
    // A property the type does not have would be an empty column that looks editable.
    const own = new Set<ColumnKey>([...PROP_COLUMNS[type], 'title', 'type', 'status', 'version', 'recorded_at']);
    if (!columns.every((c) => own.has(c))) return { ok: false, reason: `${type}에 없는 속성 열이 있다` };
  }
  let sort: ViewDef['sort'] = { key: 'title', desc: false };
  if (raw.sort !== undefined) {
    if (typeof raw.sort !== 'string') return { ok: false, reason: 'sort는 열 이름이다' };
    const desc = raw.sort.startsWith('-'), key = desc ? raw.sort.slice(1) : raw.sort;
    if (!isColumn(key)) return { ok: false, reason: '모르는 정렬 열이다' };
    sort = { key, desc };
  }
  let filter = { text: '', tag: '' };
  if (raw.filter !== undefined) {
    if (!isRecord(raw.filter) || Object.keys(raw.filter).some((k) => k !== 'text' && k !== 'tag')) return { ok: false, reason: 'filter는 text, tag만 둘 수 있다' };
    const { text = '', tag = '' } = raw.filter;
    if (typeof text !== 'string' || typeof tag !== 'string') return { ok: false, reason: 'filter 값은 글이다' };
    filter = { text, tag };
  }
  return { ok: true, def: { type, columns, sort, filter } };
}

/** The text of a new block of this type: the default columns, sorted by title. */
export function viewSource(type: ViewType): string {
  return JSON.stringify({ type, columns: defaultColumns(type), sort: 'title' });
}
