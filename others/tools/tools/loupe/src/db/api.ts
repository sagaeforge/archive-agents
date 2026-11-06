// The two reads of the database view (design v2 4.3): the list of records of a type, and one record whole, for the save of a cell (a PUT carries the whole record).
// Both go through the adapter every read of the app uses (data/kbFetch.ts), so the session, the time-basis check and the connection state are the app's own.
import kbFetch, { KbProblem } from '../data/kbFetch.ts';
import { rowFrom, type Row } from './rows.ts';
import type { LoadResult } from './rowSaver.ts';
import type { ViewType } from './view.ts';

export const LIST_LIMIT = 100;
export type ListStatus = 'active' | 'dead';
export type Listed = { rows: Row[]; more: boolean };

/** First-party records of one type with this status (the KB's default is `active` only; `dead` is asked for by name). */
export async function listRows(type: ViewType, status: ListStatus): Promise<Listed> {
  const r = await kbFetch<{ data?: { items?: unknown[] }; page?: { next_cursor?: string | null } }>(`/v1/nodes?types=${type}&origin=first_party&status=${status}&limit=${LIST_LIMIT}`);
  const items = Array.isArray(r.data?.items) ? r.data.items : [];
  return { rows: items.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object').map(rowFrom).filter((x) => x.id !== ''), more: !!r.page?.next_cursor };
}

/**
 * The record as the KB has it, for a PUT. A body read in parts is refused (`partial`): sending it back would cut the rest off. A record that is not an active memo or document
 * is `gone` for this purpose (a tombstone has no text to send back).
 */
export async function loadRecord(id: string): Promise<LoadResult> {
  try {
    const r = await kbFetch<{ data: { type?: string; label?: string; status?: string; version?: number; body?: string | null; body_chars?: number | null; sensitivity?: string; props?: unknown } }>(`/v1/nodes/${encodeURIComponent(id)}?include=body`);
    const n = r.data;
    if (n.status !== 'active' || (n.type !== 'Note' && n.type !== 'Page') || typeof n.version !== 'number' || typeof n.label !== 'string') return 'gone';
    const body = n.body ?? '';
    if ((n.body_chars ?? body.length) > body.length) return 'partial';
    const props = n.props && typeof n.props === 'object' && !Array.isArray(n.props) ? n.props as Record<string, unknown> : {};
    return { type: n.type, title: n.label, body, sensitivity: n.sensitivity === 'internal' ? 'internal' : 'private', props, version: n.version };
  } catch (e) {
    if (e instanceof KbProblem && (e.status === 404 || e.status === 410)) return 'gone';
    return 'network';
  }
}
