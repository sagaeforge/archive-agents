// Opt-in M4 fixtures for the database view (design v2 11.3 "M4 데이터베이스 표", 4.3): `KB_MOCK_DB=1` together with `KB_MOCK_WRITE=1`.
// It seeds the record store the write imitation keeps (dev/kb-mock/write.ts) with a document that holds two ```loupe-view blocks and the memos and
// documents those blocks list, and it answers the list read the view makes (`GET /v1/nodes?types=Note&origin=first_party&status=active`).
// Nothing here changes the write contract: a seeded record is an ordinary record of the store, so PUT, 409 and 422 treat it as any other.
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../server/precheck.ts';
import type { RecordStore, Rec, Version } from './write.ts';

type Json = Record<string, unknown>;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Same hash the write routes keep (write.ts `shaOf`), so a PUT of unchanged content is answered `unchanged`. */
const shaOf = (r: Json) => sha256(canonicalJson({ type: r.type, title: r.title, body: r.body, body_format: r.body_format ?? 'markdown', sensitivity: r.sensitivity ?? null, props: r.props ?? {}, links: r.links ?? [] }));

export const DB_DOC = 'f-m4-doc';
const NOTE_VIEW = JSON.stringify({ type: 'Note', columns: ['title', 'tags', 'pinned', 'status', 'version'], sort: 'title' });
const PAGE_VIEW = JSON.stringify({ type: 'Page', columns: ['title', 'tags', 'order', 'icon'], sort: 'order' });
export const DB_DOC_BODY = `# M4 데이터베이스 문서\n\n메모 표\n\n\`\`\`loupe-view\n${NOTE_VIEW}\n\`\`\`\n\n문서 표\n\n\`\`\`loupe-view\n${PAGE_VIEW}\n\`\`\``;

type Seed = { id: string; type: 'Note' | 'Page'; title: string; body: string; props: Json; dead?: boolean };
const SEEDS: Seed[] = [
  { id: DB_DOC, type: 'Page', title: 'M4 데이터베이스 문서', body: DB_DOC_BODY, props: { tags: ['m4'], order: 0, icon: '🗂' } },
  { id: 'f-m4-n1', type: 'Note', title: '알파 메모', body: '알파 메모', props: { tags: ['m4', 'alpha'], pinned: true } },
  { id: 'f-m4-n2', type: 'Note', title: '베타 메모', body: '베타 메모', props: { tags: ['m4'], pinned: false } },
  // A property the view does not show: a whole-`props` replacement has to carry it along.
  { id: 'f-m4-n3', type: 'Note', title: '감마 노트', body: '감마 노트', props: { tags: ['other'], pinned: false, color: 'red' } },
  { id: 'f-m4-n4', type: 'Note', title: '<img src=x onerror=alert(1)> 위험한 제목', body: '위험한 제목', props: { tags: ['x'], pinned: false } },
  { id: 'f-m4-n5', type: 'Note', title: '보관된 메모', body: '보관된 메모', props: { tags: ['m4'], pinned: false }, dead: true },
  { id: 'f-m4-p1', type: 'Page', title: '소개 문서', body: '소개 문서', props: { tags: [], order: 1, icon: '📘' } },
  { id: 'f-m4-p2', type: 'Page', title: '부록 문서', body: '부록 문서', props: { tags: ['m4'], order: 2, icon: '📎' } },
];

/** Puts the fixtures into the record store the write routes use. Versions are stamped a minute apart, newest last in the list. */
export function seedDatabase(store: RecordStore): void {
  let minute = 0;
  const at = () => new Date(Date.UTC(2026, 10, 1, 0, minute++, 0)).toISOString();
  for (const s of SEEDS) {
    const record = { type: s.type, title: s.title, body: s.body, body_format: 'markdown', sensitivity: 'private', props: s.props, links: [] };
    const payloadSha = shaOf(record);
    const versions: Version[] = [{ version: 1, status: 'active', payloadSha, record, generatedBy: 'app:loupe:save', recordedAt: at() }];
    if (s.dead) versions.push({ version: 2, status: 'dead', payloadSha, record, generatedBy: 'app:loupe:save', recordedAt: at() });
    const rec: Rec = { type: s.type, sensitivity: 'private', hidden: false, versions };
    store.set(s.id, rec);
  }
}

type Written = { list: (status: 'active' | 'dead', types: Set<string> | null) => Json[] };
/**
 * The list a database block reads: first-party `Note` and `Page` records with this status (default `active`). Anything else is not this file's:
 * null sends the request on to the reads that were there before.
 */
export function databaseRows(written: Written, q: URLSearchParams): Json[] | null {
  if (q.get('origin') !== 'first_party') return null;
  const status = q.get('status') ?? 'active';
  if (status !== 'active' && status !== 'dead') return null;
  const types = new Set((q.get('types') ?? q.get('type') ?? '').split(',').filter(Boolean));
  if (types.size === 0 || ![...types].every((t) => t === 'Note' || t === 'Page')) return null;
  return written.list(status, types);
}
