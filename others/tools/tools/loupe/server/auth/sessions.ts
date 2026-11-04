// loupe sessions (design v2 6.1 step 5): 256-bit random values, only their SHA-256 in memory, idle 1 h, at most 12 h, no renewal.
// A restart of `loupe serve` signs everyone out.
import { createHash, randomBytes } from 'node:crypto';

export const IDLE_MS = 60 * 60_000;
export const MAX_MS = 12 * 60 * 60_000;

const digest = (token: string) => createHash('sha256').update(token).digest('base64url');
/** 32 random bytes in base64url are 43 characters. Anything else is not a session. */
const SHAPE = /^[A-Za-z0-9_-]{43}$/;

type Entry = { created: number; seen: number; via: 'google' | 'breakglass' };

export class Sessions {
  private readonly map = new Map<string, Entry>();
  private readonly now: () => number;
  readonly idleMs: number;
  readonly maxMs: number;
  constructor(now: () => number = Date.now, idleMs = IDLE_MS, maxMs = MAX_MS) { this.now = now; this.idleMs = idleMs; this.maxMs = maxMs; }

  issue(via: Entry['via']): string {
    this.prune();
    const token = randomBytes(32).toString('base64url');
    const t = this.now();
    this.map.set(digest(token), { created: t, seen: t, via });
    return token;
  }

  /** True when the token names a live session. With `renew`, its idle clock restarts; a dead one is forgotten. */
  touch(token: string | null | undefined, renew = true): boolean {
    if (!token || !SHAPE.test(token)) return false;
    const k = digest(token);
    const e = this.map.get(k);
    if (!e) return false;
    const t = this.now();
    if (t - e.seen > this.idleMs || t - e.created > this.maxMs) { this.map.delete(k); return false; }
    if (renew) e.seen = t;
    return true;
  }

  revoke(token: string | null | undefined) { if (token && SHAPE.test(token)) this.map.delete(digest(token)); }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }

  private prune() {
    const t = this.now();
    for (const [k, e] of this.map) if (t - e.seen > this.idleMs || t - e.created > this.maxMs) this.map.delete(k);
  }
}

/** `Authorization: Bearer <token>` → token. */
export const bearer = (header: string | undefined | null) => {
  const m = /^Bearer ([^\s]+)$/.exec(header ?? '');
  return m ? m[1]! : null;
};
