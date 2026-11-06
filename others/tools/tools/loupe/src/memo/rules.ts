// The secret rule set the memo window checks against before it sends anything (design v2 5.7, 11.2 M1). Until FW1 publishes
// `first-party-secret-rules-v1.json` the only KB there is kb-mock, and this is the rule fixture kb-mock publishes (dev/kb-mock/write.ts `mockRules`,
// the same contents, vectors included, because the hash covers the whole file). Whether it is still the KB's set is decided at run time: the memo
// window compares version and hash with `/v1/meta.write.secret_rules`, and when they differ it turns the check off and says so (compareRules).
// e2e/v2-memo.spec.ts holds this copy to kb-mock's hash, so a change on one side only fails there.
// With the real KB the build reads the KB repository's contract file instead; that step comes with FW1.
import { compareRules, compileRules, rulesSha, type Precheck, type RuleCheck, type RuleFile } from '../../server/precheck.ts';

const PEM = ['-----BEGIN ', 'RSA ', 'PRIVATE KEY-----'].join('');
const HEX = ['3f9a1c7e', '5b2d8046', 'a1c3e5f7', '092b4d68'].join('');
export const MEMO_RULES = {
  version: 'fp-secret-rules-v1',
  rules: [
    { id: 'aws-access-token', pattern: String.raw`\b((?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b`, flags: 32, keywords: ['akia', 'asia', 'abia', 'acca'], entropy: 3, secret_group: null, path: null },
    { id: 'github-pat', pattern: String.raw`ghp_[0-9a-zA-Z]{36}`, flags: 32, keywords: ['ghp_'], entropy: 3, secret_group: null, path: null },
    { id: 'generic-api-key', pattern: String.raw`(?i)[\w.-]{0,50}?(?:key|token|secret|password)[ \t\w.-]{0,20}[\s'"]{0,3}(?:=|:)[\x60'"\s=]{0,5}([a-z0-9]{16,64})(?:[\x60'"\s;]|$)`, flags: 34, keywords: ['key', 'token', 'secret', 'password'], entropy: 3.5, secret_group: null, path: null },
  ],
  extra_rules: [
    { id: 'kb-private-key-header', pattern: String.raw`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----`, flags: 32 },
    { id: 'kb-env-high-entropy', pattern: String.raw`(?m)^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]{2,63})[ \t]*=[ \t]*[\"']?([^\s\"'#]{20,})[\"']?`, flags: 40, entropy: 3.5 },
  ],
  digest_exception: {
    pattern: String.raw`(?:^|(?<=:))[0-9a-f]{16,128}(?=$|:)`,
    credential_word: String.raw`(?:api)?keys?|api|tokens?|secrets?|passw(?:or)?ds?|pass|pwd|auth|credentials?|creds?|pat|access|bearer`,
    word_split: String.raw`[-_.\s]+|(?<=[a-z0-9])(?=[A-Z])`,
  },
  vectors: [
    { id: 'identifier', field: 'idempotency_key', text: PEM, on_secret: 'quarantine', action: 'reject' },
    { id: 'content-reject', field: 'record.body', text: PEM, on_secret: 'reject', action: 'reject' },
    { id: 'content-quarantine', field: 'record.body', text: PEM, on_secret: 'quarantine', action: 'quarantine' },
    { id: 'attribute-name', field: 'record.props[0].name', text: PEM, on_secret: 'quarantine', action: 'reject' },
    { id: 'digest', field: 'idempotency_key', text: `save:${HEX}`, on_secret: 'reject', action: 'allow' },
    { id: 'credential-digest', field: 'idempotency_key', text: `api_key:${HEX}`, on_secret: 'reject', action: 'reject' },
    { id: 'hangul-astral', field: 'record.body', text: `한😀${PEM}`, on_secret: 'reject', action: 'reject', hit: { rule: 'kb-private-key-header', start: 2, end: 2 + PEM.length, start_u16: 3, end_u16: 3 + PEM.length } },
  ],
} satisfies RuleFile;

export type PrecheckState = { check: Precheck | null; status: RuleCheck | 'unknown' };
let compiled: Precheck | undefined;
let localSha: Promise<string> | undefined;
export const memoPrecheck = (): Precheck => (compiled ??= compileRules(MEMO_RULES));
const sha = () => (localSha ??= rulesSha(MEMO_RULES));

/**
 * `remote` is `/v1/meta` `data.write.secret_rules`, or `undefined` while the meta has not been read. Unread, the check stays on: it is advice
 * and the KB's own scan is the authority. A set the KB does not publish turns it off.
 */
export async function precheckFor(remote: unknown): Promise<PrecheckState> {
  if (remote === undefined) return { check: memoPrecheck(), status: 'unknown' };
  const status = compareRules({ version: MEMO_RULES.version, sha: await sha() }, remote);
  return { check: status.on ? memoPrecheck() : null, status };
}
