// The KB side of loupe serve: where KB_URL points and how to make one request to it. No Hono here.
import http from 'node:http';
import https from 'node:https';
import { readFileSync, statSync } from 'node:fs';

export type Target =
  | { kind: 'unix'; path: string }
  | { kind: 'tcp'; https: boolean; host: string; port: number };

export const DEFAULT_KB_URL = 'unix:/home/user/sagae-kb-data/run/read.sock';

// `unix:` strings are not URLs. new URL() would parse the path as an opaque string (design 10).
export function parseKbUrl(raw: string): Target {
  if (raw.startsWith('unix:')) {
    const path = raw.slice('unix:'.length);
    if (!path.startsWith('/')) throw new Error('KB_URL unix: needs an absolute socket path');
    return { kind: 'unix', path };
  }
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`KB_URL protocol not supported: ${u.protocol}`);
  if (u.pathname !== '/' && u.pathname !== '') throw new Error('KB_URL must not carry a path');
  return { kind: 'tcp', https: u.protocol === 'https:', host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) };
}

/** Reads the viewer token from a file that only the owner can read. Never from the environment or the unit file. */
export function readTokenFile(path: string): string {
  const st = statSync(path);
  if (st.mode & 0o077) throw new Error(`KB_TOKEN_FILE ${path} must not be readable by group or others (mode ${(st.mode & 0o777).toString(8)})`);
  return readFileSync(path, 'utf8').trim();
}

export type KbRequestOptions = {
  method: string; path: string; headers: Record<string, string>; signal?: AbortSignal | undefined;
  firstByteMs: number; connectMs: number;
};
const code = (c: string, m: string) => Object.assign(new Error(m), { code: c });

function once(t: Target, o: KbRequestOptions): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = t.kind === 'tcp' && t.https ? https : http;
    const req = mod.request({
      method: o.method, path: o.path, headers: o.headers,
      // A pooled connection that the server closed shows up as ECONNRESET. A fresh one per request avoids the pool.
      agent: false,
      ...(t.kind === 'unix' ? { socketPath: t.path } : { host: t.host, port: t.port }),
    });
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const fail = (e: Error) => { if (settled) return; settled = true; timers.forEach(clearTimeout); req.destroy(); reject(e); };
    timers.push(setTimeout(() => fail(code('KB_FIRST_BYTE_TIMEOUT', 'no response header from the KB in time')), o.firstByteMs));
    req.on('socket', (s) => {
      // A closed loopback port can hang instead of refusing on this host (design 11), so TCP gets a short connect limit.
      if (t.kind === 'tcp' && s.connecting) timers.push(setTimeout(() => fail(code('KB_CONNECT_TIMEOUT', 'KB connect timed out')), o.connectMs));
    });
    req.on('response', (res) => { if (settled) return; settled = true; timers.forEach(clearTimeout); resolve(res); });
    req.on('error', fail);
    if (o.signal) { if (o.signal.aborted) fail(code('ABORT_ERR', 'aborted')); else o.signal.addEventListener('abort', () => fail(code('ABORT_ERR', 'aborted')), { once: true }); }
    req.end();
  });
}

/** GET and HEAD are retried once when the connection resets before any header (idle exit race, design 7.4). */
export async function kbRequest(t: Target, o: KbRequestOptions): Promise<http.IncomingMessage> {
  try { return await once(t, o); } catch (e) {
    // EPIPE is the same race seen from the write side: the peer closed before the request line went out.
    if ((o.method === 'GET' || o.method === 'HEAD') && ['ECONNRESET', 'EPIPE'].includes((e as NodeJS.ErrnoException).code ?? '') && !o.signal?.aborted) return once(t, o);
    throw e;
  }
}

export type MappedFailure = { status: number; code: string; title: string };
export function mapFailure(e: unknown): MappedFailure {
  const c = (e as NodeJS.ErrnoException | undefined)?.code;
  switch (c) {
    case 'ENOENT': return { status: 502, code: 'kb_socket_missing', title: 'KB socket does not exist' };
    case 'ECONNREFUSED': return { status: 502, code: 'kb_socket_refused', title: 'KB socket refused the connection' };
    case 'EACCES': case 'EPERM': return { status: 502, code: 'kb_socket_denied', title: 'KB socket permission denied' };
    case 'KB_FIRST_BYTE_TIMEOUT': case 'KB_CONNECT_TIMEOUT': return { status: 504, code: 'kb_timeout', title: 'KB did not answer in time' };
    default: return { status: 502, code: 'kb_upstream_error', title: 'KB connection failed' };
  }
}
