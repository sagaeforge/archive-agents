// Recent items keep ids only (design 2). Storage can be missing or throw; the palette then simply has no recent group.
import { parseKbId } from '../ids.ts';

const KEY = 'loupe.recent.v1';
export const RECENT_MAX = 8;

export function readRecent(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && parseKbId(x).ok).slice(0, RECENT_MAX) : [];
  } catch { return []; }
}
export function pushRecent(id: string) {
  try { localStorage.setItem(KEY, JSON.stringify([id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX))); } catch { /* no storage, no recents */ }
}
