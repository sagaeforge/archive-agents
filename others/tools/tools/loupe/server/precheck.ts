// The secret precheck of design v2 5.7, as a module with no Node imports so the browser adapter (M1, next step) can load it too.
// It runs the rule file the KB publishes (ADR-0005 7.7: `first-party-secret-rules-v1.json`) and says which field and which range
// matched, by rule id. It never returns the matched text. The KB's own scan is the authority; this one is advice that stops a send early
// and, while it blocks, nothing goes to /kb-write/* or /kb/v1/search.
//
// The KB's rules are Python `re` patterns (Gitleaks, RE2 syntax). They are run here as JavaScript regular expressions after three
// translations: Python flag integers (IGNORECASE=2, MULTILINE=8, DOTALL=16) and a leading `(?i)`-style group become JS flags, `(?P<n>`
// becomes `(?<n>`, `\z` becomes end-of-input. Measured on 2026-11-06 against the contract file: all 223 rules compile this way.

export type Rule = {
  id: string; pattern: string; flags: number;
  keywords?: readonly string[] | undefined; entropy?: number | null | undefined; secret_group?: number | null | undefined; path?: string | null | undefined;
};
export type RuleFile = {
  version: string;
  rules: readonly Rule[];
  extra_rules?: readonly Rule[] | undefined;
  digest_exception?: { pattern?: string; credential_word: string; word_split: string } | undefined;
  vectors?: readonly unknown[] | undefined;
};
/** One piece of text to scan. `field` is the name a hit reports (an ordinal, never a property name). */
export type Field = { field: string; text: string; digestTail?: boolean | undefined };
export type Hit = { field: string; rule: string; start: number; end: number; start_u16: number; end_u16: number };

const DEFAULT_CREDENTIAL = String.raw`(?:api)?keys?|api|tokens?|secrets?|passw(?:or)?ds?|pass|pwd|auth|credentials?|creds?|pat|access|bearer`;
const DEFAULT_SPLIT = String.raw`[-_.\s]+|(?<=[a-z0-9])(?=[A-Z])`;
const ENV_RULE = 'kb-env-high-entropy';

const shannon = (s: string) => {
  const n = new Map<string, number>();
  for (const ch of s) n.set(ch, (n.get(ch) ?? 0) + 1);
  let total = 0;
  for (const c of n.values()) total += c;
  let h = 0;
  for (const c of n.values()) h -= (c / total) * Math.log2(c / total);
  return h;
};

/** An identifier field is never quarantined, whatever the caller asks (ADR-0005 7.2). */
export const isIdentifierField = (field: string) => field === 'idempotency_key' || field === 'reason' || /^record\.(id|type)$/.test(field) || /^record\.props\[\d+\]\.name$/.test(field);

type Compiled = { rule: Rule; re: RegExp; keywords: string[] };
function toRegExp(rule: Rule): RegExp {
  let p = rule.pattern.replace(/\(\?P</g, '(?<').replace(/\\z/g, '$(?![\\s\\S])').replace(/\\Z/g, '$(?![\\s\\S])');
  const f = new Set(['g', 'd']);
  if (rule.flags & 2) f.add('i');
  if (rule.flags & 8) f.add('m');
  if (rule.flags & 16) f.add('s');
  const lead = /^\(\?([aiLmsux]+)\)/.exec(p);
  if (lead) { p = p.slice(lead[0].length); for (const c of lead[1]!) if (c === 'i' || c === 'm' || c === 's') f.add(c); }
  return new RegExp(p, [...f].join(''));
}

export type Precheck = { version: string; skipped: string[]; scan: (fields: readonly Field[]) => Hit[] };

export function compileRules(file: RuleFile): Precheck {
  const compiled: Compiled[] = [];
  const skipped: string[] = [];
  for (const rule of [...file.rules, ...(file.extra_rules ?? [])]) {
    // A rule bound to a file path cannot run on text with no trusted path (the KB's own rule for record scanning).
    if (rule.path) continue;
    try { compiled.push({ rule, re: toRegExp(rule), keywords: (rule.keywords ?? []).map((k) => k.toLowerCase()) }); } catch { skipped.push(rule.id); }
  }
  const credential = new RegExp(`^(?:${file.digest_exception?.credential_word ?? DEFAULT_CREDENTIAL})$`);
  const split = new RegExp(file.digest_exception?.word_split ?? DEFAULT_SPLIT);

  /** Colon-delimited lowercase hex of 16..128 is a digest and is not scanned, unless the label before it names a credential. */
  const maskDigests = (f: Field) => {
    const cells = f.text.split(':');
    return cells.map((cell, i) => {
      if (!/^[0-9a-f]{16,128}$/.test(cell)) return cell;
      if (f.digestTail && i === cells.length - 1) return '_'.repeat(cell.length);
      const label = i > 0 ? cells[i - 1]!.split(split).filter(Boolean).pop()?.toLowerCase() ?? '' : '';
      return credential.test(label) ? cell : '_'.repeat(cell.length);
    }).join(':');
  };

  const scan = (fields: readonly Field[]): Hit[] => {
    const hits: Hit[] = [];
    for (const f of fields) {
      const text = isIdentifierField(f.field) ? maskDigests(f) : f.text;
      if (!text) continue;
      const lower = text.toLowerCase();
      for (const { rule, re, keywords } of compiled) {
        if (keywords.length > 0 && !keywords.some((k) => lower.includes(k))) continue;
        for (const m of text.matchAll(re)) {
          const idx = (m as RegExpMatchArray & { indices?: ([number, number] | undefined)[] }).indices ?? [];
          let g = 0;
          if (typeof rule.secret_group === 'number') g = rule.secret_group;
          else if (rule.id === ENV_RULE) g = idx.length - 1;
          else { const first = idx.findIndex((r, i) => i > 0 && r && r[1] > r[0]); g = first > 0 ? first : 0; }
          const span = idx[g] ?? idx[0] ?? [m.index!, m.index! + m[0].length];
          const secret = text.slice(span[0], span[1]);
          if (rule.id === ENV_RULE && (/^[a-z][a-z0-9+.-]*:\/\//i.test(secret) && !secret.includes('@') || !/[A-Za-z]/.test(secret) || !/\d/.test(secret))) continue;
          if (typeof rule.entropy === 'number' && shannon(secret) < rule.entropy) continue;
          hits.push({
            field: f.field, rule: rule.id,
            start: [...text.slice(0, span[0])].length, end: [...text.slice(0, span[1])].length,
            start_u16: span[0], end_u16: span[1],
          });
        }
      }
    }
    return hits;
  };
  return { version: file.version, skipped, scan };
}

/** What the KB would do with these hits (ADR-0005 7.1): an identifier hit always rejects; a content hit rejects unless the user chose to quarantine. */
export function decide(hits: readonly Hit[], onSecret: 'reject' | 'quarantine'): { action: 'allow' | 'reject' | 'quarantine' } {
  if (hits.length === 0) return { action: 'allow' };
  if (hits.some((h) => isIdentifierField(h.field))) return { action: 'reject' };
  return { action: onSecret === 'quarantine' ? 'quarantine' : 'reject' };
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const sortKeys = (v: Json): Json => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k]!)])) : v;
/** Key-sorted, no whitespace, UTF-8 JSON: the bytes the rule set's hash is taken over (ADR-0005 7.7 does not fix the form further; kb-mock and loupe agree on this one). */
export const canonicalJson = (v: unknown) => JSON.stringify(sortKeys(v as Json));
export async function rulesSha(file: unknown): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(file)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type RuleCheck = { on: true } | { on: false; reason: 'remote_missing' | 'version_differs' | 'sha_differs' };
/** `remote` is `/v1/meta` `data.write.secret_rules`. The precheck is on only when the KB's version and hash are the loaded file's. */
export function compareRules(local: { version: string; sha: string }, remote: unknown): RuleCheck {
  const r = remote && typeof remote === 'object' ? remote as { version?: unknown; sha?: unknown } : null;
  if (!r || typeof r.version !== 'string' || typeof r.sha !== 'string') return { on: false, reason: 'remote_missing' };
  if (r.version !== local.version) return { on: false, reason: 'version_differs' };
  if (r.sha !== local.sha) return { on: false, reason: 'sha_differs' };
  return { on: true };
}

type Rec = { idempotency_key?: unknown; reason?: unknown; record?: { id?: unknown; type?: unknown; title?: unknown; body?: unknown; props?: unknown; links?: unknown } | undefined };
/** The fields of a write request, named as the KB's `hits` name them. Property names are identifiers; they are numbered, never quoted. */
export function recordFields(req: Rec): Field[] {
  const out: Field[] = [];
  const add = (field: string, v: unknown) => { if (typeof v === 'string' && v) out.push({ field, text: v }); };
  add('idempotency_key', req.idempotency_key);
  add('reason', req.reason);
  const r = req.record;
  if (!r) return out;
  add('record.id', r.id); add('record.type', r.type); add('record.title', r.title); add('record.body', r.body);
  let n = 0;
  const walk = (o: unknown) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const [name, value] of Object.entries(o)) {
      const i = n++;
      add(`record.props[${i}].name`, name);
      if (typeof value === 'string') add(`record.props[${i}].value`, value);
      else if (Array.isArray(value)) value.forEach((x, j) => add(`record.props[${i}].value[${j}]`, x));
      else walk(value);
    }
  };
  walk(r.props);
  if (Array.isArray(r.links)) r.links.forEach((l, i) => add(`record.links[${i}].dst`, (l as { dst?: unknown } | null)?.dst));
  return out;
}

/** Calls `send` only when nothing matched. With no precheck (rules differ or none loaded) it sends: the KB's 422 is then the guard. */
export async function sendIfClean<T>(pre: Precheck | null, fields: readonly Field[], send: () => Promise<T>): Promise<{ sent: true; result: T } | { sent: false; hits: Hit[] }> {
  const hits = pre ? pre.scan(fields) : [];
  if (hits.length > 0) return { sent: false, hits };
  return { sent: true, result: await send() };
}
