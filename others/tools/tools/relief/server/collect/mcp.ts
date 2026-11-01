// The one place that talks to tower (design 6.2, 6.3). A reader reads allowlisted targets and nothing else: there is no call by name.
import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Agent } from 'undici';
import { loopbackUrl } from '../config.ts';
import { callOf, NotAllowed, TOOLS, type Target } from './allowlist.ts';

export const DEADLINE_MS = 30_000; // 24 s for three PVE hosts + 4 s of tower wait + slack (design 6.5).
export const CONNECT_MS = 1_000;
export const MAX_BYTES = 2 * 1024 * 1024;
const WHY_MAX = 200;

/** source: the whole Proxmox source is failing. path: only this value is unreadable (design 6.6). */
export type Scope = 'source' | 'path';
export class ReadError extends Error {
  scope: Scope; why: string;
  constructor(scope: Scope, why: string) { super(why); this.name = 'ReadError'; this.scope = scope; this.why = why; }
}

const PVE_CODES = /^(TIMEOUT|REFUSED|TLS_VERIFY|BAD_RESPONSE|UNREACHABLE|CA_FILE|NO_TOKEN)\b/;
const PATH_CODES = /^(NODE_NOT_FOUND|BAD_REQUEST)\b/;

/** Wording is a convention of the plugin, not a contract, so an unknown text stays `source` and is shown cut (design 6.6). */
export function classify(text: string, scrub: (s: string) => string = (s) => s): ReadError {
  const line = scrub(text.split('\n', 1)[0] ?? '').slice(0, WHY_MAX);
  if (/^upstream proxmox\b/.test(text)) return new ReadError('source', 'proxmox 업스트림 다운');
  const pve = PVE_CODES.exec(text);
  if (pve) return new ReadError('source', `PVE ${pve[1]}`);
  const api = /^PVE API (\d{3})/.exec(text);
  if (api) return new ReadError(api[1] === '401' ? 'source' : 'path', `PVE API ${api[1]}`);
  if (PATH_CODES.test(text)) return new ReadError('path', line);
  return new ReadError('source', line || '알 수 없는 오류');
}

export type CallRecord = { total: number; refused: number; byLabel: Record<string, number> };
export type Reader = { read(target: Target, signal?: AbortSignal): Promise<unknown>; close(): Promise<void>; record: CallRecord };

export type ReaderOptions = { url: string; token: () => string | null; deadlineMs?: number; connectMs?: number };

const httpStatus = (e: unknown) => (e as { status?: unknown }).status;

export function createReader(o: ReaderOptions): Reader {
  const url = loopbackUrl(o.url); // Before any token is read.
  const deadlineMs = o.deadlineMs ?? DEADLINE_MS;
  const dispatcher = new Agent({ connect: { timeout: o.connectMs ?? CONNECT_MS }, headersTimeout: 0, bodyTimeout: 0 });
  const limited: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error', dispatcher } as RequestInit);
  const record: CallRecord = { total: 0, refused: 0, byLabel: {} };
  let client: Client | null = null;
  let connecting: Promise<Client> | null = null;
  let used: string | null = null;
  let inFlight = 0;
  const retired: Client[] = [];

  const scrub = (s: string) => (used ? s.split(used).join('[redacted]') : s).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  // The fast loop sends three reads at once. Closing under the other two would turn one real error into two meaningless ones, so a dropped client waits for them.
  const settle = () => { if (inFlight === 0) for (const c of retired.splice(0)) void c.close().catch(() => {}); };
  const drop = () => { if (client) retired.push(client); client = null; settle(); };
  // Three reads on an empty slot share one connection.
  const current = (signal?: AbortSignal) => (client ? Promise.resolve(client) : (connecting ??= connect(signal).then((c) => (client = c)).finally(() => { connecting = null; })));

  const thrown = (e: unknown): ReadError => {
    if (e instanceof ReadError) return e;
    const status = httpStatus(e);
    if (status === 401 || status === 503) return new ReadError('source', 'tower 인증 실패');
    if (e instanceof ProtocolError && /unknown name/.test(e.message)) return new ReadError('source', 'tower에 proxmox 없음');
    return new ReadError('source', 'tower 응답 없음');
  };

  async function connect(signal?: AbortSignal): Promise<Client> {
    const token = o.token();
    if (!token) throw new ReadError('source', 'tower 토큰 없음');
    used = token;
    const c = new Client({ name: 'relief', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: limited });
    const limit = AbortSignal.any([AbortSignal.timeout(deadlineMs), ...(signal ? [signal] : [])]);
    const aborted = new Promise<never>((_, reject) => limit.addEventListener('abort', () => reject(new ReadError('source', 'tower 응답 없음')), { once: true }));
    try {
      await Promise.race([c.connect(transport, { timeout: deadlineMs }), aborted]);
      const { tools } = await c.listTools(undefined, { timeout: deadlineMs, signal: limit, cacheMode: 'refresh' });
      const byName = new Map(tools.map((t) => [t.name, t]));
      // A self-report of the server: an extra check, not the boundary (design 6.3).
      if (!TOOLS.every((n) => byName.get(n)?.annotations?.readOnlyHint === true)) throw new ReadError('source', '읽기 도구 확인 안 됨');
      return c;
    } catch (e) {
      void c.close().catch(() => {});
      throw e;
    }
  }

  async function once(call: ReturnType<typeof callOf>, sent: { token: string | null }, signal?: AbortSignal) {
    const c = await current(signal);
    sent.token = used;
    const limit = AbortSignal.any([AbortSignal.timeout(deadlineMs), ...(signal ? [signal] : [])]);
    record.total += 1;
    record.byLabel[call.label] = (record.byLabel[call.label] ?? 0) + 1;
    return c.callTool({ name: call.name, arguments: call.args }, { signal: limit, timeout: deadlineMs });
  }

  return {
    record,
    async read(target, signal) {
      let call;
      try { call = callOf(target); } catch (e) { if (e instanceof NotAllowed) record.refused += 1; throw e; }
      let result;
      inFlight += 1;
      try {
        const sent = { token: null as string | null };
        try {
          result = await once(call, sent, signal);
        } catch (e) {
          // A rotated token: read the file again and connect once more. An unchanged token would only fail the same way.
          if (httpStatus(e) !== 401 || o.token() === sent.token) throw e;
          if (used === sent.token) drop();
          result = await once(call, sent, signal);
        }
      } catch (e) {
        drop(); // Whatever broke, the next read starts from a fresh connection and a fresh tools/list.
        throw thrown(e);
      } finally {
        inFlight -= 1;
        settle();
      }
      const text = (result.content as { type?: string; text?: unknown }[] | undefined)?.[0];
      const body = text?.type === 'text' && typeof text.text === 'string' ? text.text : null;
      if (result.isError) {
        const err = classify(body ?? '', scrub);
        if (err.scope === 'source') drop();
        throw err;
      }
      if (body === null) throw new ReadError('path', '응답 모양이 다르다');
      if (Buffer.byteLength(body) > MAX_BYTES) throw new ReadError('path', '응답이 2 MiB를 넘는다');
      try { return JSON.parse(body); } catch { throw new ReadError('path', '응답이 JSON이 아니다'); }
    },
    async close() {
      drop();
      await dispatcher.close().catch(() => {});
    },
  };
}
