// The break-glass password (design v2 6.5): argon2id from node:crypto, no new dependency. Closed unless `loupe breakglass open`
// opened it from a terminal within the hour. Failed attempts that passed the request checks slow the next ones: from the fifth,
// 30 s, doubling, at most 5 min. There is no permanent lock.
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

export const MIN_LENGTH = 12;
export const OPEN_MS = 60 * 60_000;
export const DELAY = { freeFailures: 4, firstS: 30, maxS: 300 } as const;

// RFC 9106 second recommended option: 64 MiB, 3 passes, 4 lanes.
const PARAMS = { m: 65536, t: 3, p: 4 } as const;

const run = (password: string, salt: Buffer, p: { m: number; t: number; p: number }, len: number) => new Promise<Buffer>((resolve, reject) => {
  argon2('argon2id', { message: Buffer.from(password, 'utf8'), nonce: salt, parallelism: p.p, tagLength: len, memory: p.m, passes: p.t }, (e, out) => (e ? reject(e) : resolve(out)));
});

/** A PHC string: `$argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>` (base64 without padding). */
export async function hashPassword(password: string): Promise<string> {
  if ([...password].length < MIN_LENGTH) throw new Error(`the break-glass password needs at least ${MIN_LENGTH} characters`);
  const salt = randomBytes(16);
  const tag = await run(password, salt, PARAMS, 32);
  const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');
  return `$argon2id$v=19$m=${PARAMS.m},t=${PARAMS.t},p=${PARAMS.p}$${b64(salt)}$${b64(tag)}`;
}

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(phc);
  if (!m) return false;
  const want = Buffer.from(m[5]!, 'base64');
  const got = await run(password, Buffer.from(m[4]!, 'base64'), { m: Number(m[1]), t: Number(m[2]), p: Number(m[3]) }, want.length);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Counts failures and says how long to wait. Only attempts that reached the password check are counted. */
export class FailureDelay {
  private failures = 0;
  private until = 0;
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  /** Seconds to wait before another attempt is looked at, or 0. */
  waitS() { return Math.max(0, Math.ceil((this.until - this.now()) / 1000)); }
  fail() {
    this.failures++;
    if (this.failures > DELAY.freeFailures) {
      const s = Math.min(DELAY.maxS, DELAY.firstS * 2 ** (this.failures - DELAY.freeFailures - 1));
      this.until = this.now() + s * 1000;
    }
  }
  succeed() { this.failures = 0; this.until = 0; }
  get count() { return this.failures; }
}
