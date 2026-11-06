// The two writes a document window does besides saving its text (design v2 5.3): "보관" (a tombstone) and the trash window's restore (a PUT on top of the
// tombstone's version). Both go through the same-origin `kb-write/` path of the memo window (memo/api.ts) and need the version they saw.
import { postWrite, type Json } from '../memo/api.ts';

export type Outcome = { ok: true; version: number | null } | { ok: false; code: string };
const outcome = (r: Awaited<ReturnType<typeof postWrite>>): Outcome => {
  if (r.t === 'ok') return { ok: true, version: typeof r.body.version === 'number' ? r.body.version : null };
  if (r.t === 'network') return { ok: false, code: r.why };
  return { ok: false, code: r.status === 409 ? 'version_conflict' : r.code ?? `HTTP ${r.status}` };
};

/** "보관": a tombstone on the version the window saw, with a reason of at most 500 characters. The key is one per record and version, so a resend is a replay. */
export async function archive(id: string, version: number, reason = ''): Promise<Outcome> {
  const body: Json = { idempotency_key: `loupe:t:${id}:v${version}`, change: 'save', expected_version: version, ...(reason ? { reason: reason.slice(0, 500) } : {}) };
  return outcome(await postWrite(`/records/${encodeURIComponent(id)}/tombstone`, body));
}

export type Dead = { id: string; type: string; title: string; body: string; props: Record<string, unknown>; sensitivity: 'private' | 'internal'; version: number };
/** The restore: `PUT expected_version=<tombstone version>` with the last live content. Key shape of design 5.2 (`loupe:e:<id>:v<expected>:save:r<n>`). */
export async function restore(d: Dead): Promise<Outcome> {
  const record = { type: d.type, title: d.title, body: d.body, body_format: 'markdown', sensitivity: d.sensitivity, props: d.props, links: [] };
  return outcome(await postWrite(`/records/${encodeURIComponent(d.id)}`, { idempotency_key: `loupe:e:${d.id}:v${d.version}:save:r1`, change: 'save', expected_version: d.version, record }));
}
