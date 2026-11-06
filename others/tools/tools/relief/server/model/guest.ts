// The one gate for what a guest says through its agent (design 6.4). Nothing here looks at a value to decide whether it was already handled: every pass applies every limit.
import { isIP } from 'node:net';

export const MAX_IPS = 16;
export const MAX_IP_CHARS = 45; // The longest textual IPv6 address.
export const MAX_OS_BYTES = 128;

const MARK = Buffer.byteLength(' …');
// By class, not by list: controls, format characters (zero-width, BOM, tags, LRM, RLM, ALM, bidi), lone surrogates, line and paragraph separators.
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

/** Human strings are data: invisible characters go, and the length is cut first, so a cut pair goes with them. */
export const clean = (s: string, n = 64) => s.slice(0, n).replace(CONTROL, ' ');

/** At most `max` UTF-8 bytes, never half a character. */
const cutBytes = (s: string, max: number) => Buffer.from(s).subarray(0, max).toString('utf8').replace(/�+$/, '');

/** Applied at the read and again before the fact. A second pass gives the same text. */
export function guestText(v: unknown, max = MAX_OS_BYTES): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(CONTROL, ' ');
  return Buffer.byteLength(s) > max ? `${cutBytes(s, max - MARK)} …` : s;
}

/** `dropped` is counted here, in a field no guest can write. */
export type AgentIps = { ips: string[]; dropped: number };

/** Keeps what parses as an IP, up to the limit, and counts the rest. `isIP` takes a zone (`%...`), which is free text a guest writes, so a zone is refused. Takes the stored shape or a bare list: it trusts neither. */
export function parseIps(v: unknown): AgentIps {
  const stored = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as { ips?: unknown; dropped?: unknown }) : null;
  const list: unknown[] = Array.isArray(v) ? v : Array.isArray(stored?.ips) ? stored.ips : [];
  const prior = Number.isSafeInteger(stored?.dropped) && (stored!.dropped as number) > 0 ? (stored!.dropped as number) : 0;
  const good = list.filter((a): a is string => typeof a === 'string' && a.length <= MAX_IP_CHARS && !a.includes('%') && isIP(a) !== 0);
  const ips = good.slice(0, MAX_IPS);
  return { ips, dropped: prior + list.length - ips.length };
}
