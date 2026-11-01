// The public address, read from the one URL the owner configured (design 7.1). There is no default: without `publicIpUrl` this file sends nothing.
import { isIP } from 'node:net';
import { v4 } from '../model/rules.ts';
import { ReadError } from './mcp.ts';

const TIMEOUT_MS = 5_000;
const MAX_BODY = 64;

/** Not routable on the internet: an answer in here came from something local, or from nothing that knows this line. */
const SPECIAL: [string, number][] = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.x.x', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]];
const DOCUMENTATION: [string, number][] = [['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24]];
const within = (n: number, [base, bits]: [string, number]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4(base)! / 2 ** (32 - bits));

/** @param documentation the RFC 5737 ranges count: only for a loopback URL, which is a test's mock. */
export function isPublicV4(a: string, documentation = false): boolean {
  const n = v4(a);
  if (n === null || SPECIAL.some((r) => within(n, r))) return false;
  return documentation || !DOCUMENTATION.some((r) => within(n, r));
}

/** Only this GET: no credentials, no redirects, no headers that say who is asking. */
export async function readPublicIp(url: string, signal?: AbortSignal, timeoutMs = TIMEOUT_MS): Promise<string> {
  const limit = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  let res: Response;
  try { res = await fetch(url, { method: 'GET', redirect: 'error', credentials: 'omit', headers: { accept: 'text/plain' }, signal: limit }); } catch { throw new ReadError('source', '공인 IP 응답 없음'); }
  if (!res.ok || !res.body) { await res.body?.cancel().catch(() => {}); throw new ReadError('source', '공인 IP 응답 없음'); }
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = res.body.getReader();
  try {
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      size += r.value.length;
      if (size > MAX_BODY) throw new ReadError('source', '공인 IP 형식이 아니다');
      chunks.push(r.value);
    }
  } catch (e) { if (e instanceof ReadError) throw e; throw new ReadError('source', '공인 IP 응답 없음'); } finally { void reader.cancel().catch(() => {}); }
  const body = Buffer.concat(chunks).toString('utf8').trim();
  if (isIP(body) !== 4) throw new ReadError('source', '공인 IP 형식이 아니다');
  if (!isPublicV4(body, /^(127\.0\.0\.1|localhost|\[::1\])$/.test(new URL(url).hostname))) throw new ReadError('source', '공인 주소가 아니다');
  return body;
}
