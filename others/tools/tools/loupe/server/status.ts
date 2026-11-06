// The KB part of the settings status (design v2 2.8): one read of /v1/meta, boiled down to words and numbers. The answer never
// carries a token, a socket path, an address or an error text: a person reading the settings window needs "connected or not" and
// the write state the KB reports (ADR-0005 8.1), nothing the KB or the host would not want on a screen.
import { kbRequest, type Target } from './upstream.ts';

type TrustStore = 'ready' | 'missing' | 'unreadable' | 'unsafe' | 'unknown';
export type KbStatus = {
  connected: boolean;
  data_as_of: string | null;
  write: {
    fp_gate: boolean; editor_routes: number; private_open: boolean;
    hitl: { available: boolean; trust_store: TrustStore; registered: boolean };
    secret_rules: { version: string | null };
  } | null;
};

const DOWN: KbStatus = { connected: false, data_as_of: null, write: null };
const MAX_BYTES = 256 * 1024;
const TRUST = new Set(['ready', 'missing', 'unreadable', 'unsafe']);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

async function readJson(res: AsyncIterable<Buffer | string>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of res) {
    const b = typeof c === 'string' ? Buffer.from(c) : c;
    size += b.length;
    if (size > MAX_BYTES) throw new Error('too large');
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** What the KB's `data.write` says, reduced. `origin` picks the RP entry that belongs to this page's origin. */
export function summarizeWrite(w: unknown, origin: string): KbStatus['write'] {
  const write = obj(w);
  if (!write) return null;
  const hitl = obj(write.hitl) ?? {};
  const rp = Array.isArray(hitl.rp_ids) ? hitl.rp_ids : [];
  const version = obj(write.secret_rules)?.version;
  return {
    fp_gate: write.fp_gate === true,
    editor_routes: Array.isArray(write.editor_routes) ? write.editor_routes.length : 0,
    private_open: write.private_open === true,
    hitl: {
      available: hitl.available === true,
      trust_store: typeof hitl.trust_store === 'string' && TRUST.has(hitl.trust_store) ? hitl.trust_store as TrustStore : 'unknown',
      registered: rp.some((r) => { const e = obj(r); return e?.registered === true && Array.isArray(e.allowed_origins) && e.allowed_origins.includes(origin); }),
    },
    secret_rules: { version: typeof version === 'string' && /^[A-Za-z0-9._-]{1,48}$/.test(version) ? version : null },
  };
}

export async function kbStatus(cfg: { kb: Target; token?: string | undefined; firstByteMs: number; connectMs: number }, origin: string): Promise<KbStatus> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (cfg.token && cfg.kb.kind === 'tcp') headers.authorization = `Bearer ${cfg.token}`;
  try {
    const res = await kbRequest(cfg.kb, { method: 'GET', path: '/v1/meta', headers, firstByteMs: cfg.firstByteMs, connectMs: cfg.connectMs });
    if (res.statusCode !== 200) { res.resume(); return DOWN; }
    const env = obj(await readJson(res));
    const asOf = env?.data_as_of;
    return {
      connected: true,
      data_as_of: typeof asOf === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z?$/.test(asOf) ? asOf : null,
      write: summarizeWrite(obj(env?.data)?.write, origin),
    };
  } catch { return DOWN; }
}
