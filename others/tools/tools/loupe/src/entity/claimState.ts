// Pure rules for the claim card (design 5). The viewer never picks a winner: conflict_group has none.
import type { Claim, Predicate } from '../client/model/index.ts';

export type ClaimStateKind = 'current' | 'ended' | 'scheduled' | 'superseded' | 'dead';

/** `at` is the moment the valid axis is read at: as_of_valid when given, otherwise now. */
export function claimState(c: Pick<Claim, 'status' | 'valid'>, at: number): ClaimStateKind {
  if (c.status === 'dead') return 'dead';
  if (c.status === 'superseded') return 'superseded';
  const to = c.valid?.to ? Date.parse(c.valid.to) : null;
  const from = c.valid?.from ? Date.parse(c.valid.from) : null;
  if (to !== null && to <= at) return 'ended';
  if (from !== null && from > at) return 'scheduled';
  return 'current';
}
export const isUnverified = (c: Pick<Claim, 'verification'>) => c.verification === 'needs_review' || c.verification === 'unverified';

export type ClaimRow = { kind: 'single'; claim: Claim } | { kind: 'conflict'; group: string; claims: Claim[] };
export type ClaimGroup = { key: string; predicate: string | null; label: string; valueKind: string | null; rows: ClaimRow[]; claimCount: number };

/** Unknown keys show the id; the catalog only names what it knows (C 2.10). */
export const predicateLabel = (p: Predicate | undefined, id: string, lang: 'ko' | 'en' = 'ko') => p?.labels?.[lang] ?? p?.labels?.en ?? p?.labels?.ko ?? id;

const byRecordedDesc = (a: Claim, b: Claim) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at) || (a.id < b.id ? -1 : 1);
const newest = (r: ClaimRow) => (r.kind === 'single' ? r.claim : r.claims[0]!);
const isActive = (r: ClaimRow) => newest(r).status === 'active';

export function groupClaims(claims: readonly Claim[], predicates: readonly Predicate[]): ClaimGroup[] {
  const catalog = new Map(predicates.map((p) => [p.id, p]));
  const byPredicate = new Map<string | null, Claim[]>();
  for (const c of claims) { const k = c.predicate ?? null; (byPredicate.get(k) ?? byPredicate.set(k, []).get(k)!).push(c); }

  const groups = [...byPredicate].map(([predicate, list]): ClaimGroup => {
    const rows: ClaimRow[] = [];
    const seen = new Set<string>();
    for (const c of [...list].sort(byRecordedDesc)) {
      const g = c.conflict_group;
      if (!g) { rows.push({ kind: 'single', claim: c }); continue; }
      if (seen.has(g)) continue;
      seen.add(g);
      const members = list.filter((x) => x.conflict_group === g).sort(byRecordedDesc);
      rows.push(members.length > 1 ? { kind: 'conflict', group: g, claims: members } : { kind: 'single', claim: c });
    }
    // Same predicate: active claims by recorded_at descending. The order is a reading order, not a ranking.
    rows.sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || byRecordedDesc(newest(a), newest(b)));
    const p = predicate === null ? undefined : catalog.get(predicate);
    return { key: predicate ?? '\u0000null', predicate, label: predicate === null ? '분류 전' : predicateLabel(p, predicate), valueKind: p?.value_kind ?? null, rows, claimCount: list.length };
  });
  return groups.sort((a, b) => (a.predicate === null ? 1 : b.predicate === null ? -1 : a.label.localeCompare(b.label, 'ko')));
}

export const FOLD_AFTER = 5;
/** Rows beyond the fifth fold under "n개 더". Whole conflict rows only: a side-by-side set is never split. */
export function foldRows(rows: readonly ClaimRow[], limit = FOLD_AFTER): { shown: readonly ClaimRow[]; hidden: readonly ClaimRow[]; hiddenClaims: number } {
  if (rows.length <= limit) return { shown: rows, hidden: [], hiddenClaims: 0 };
  const hidden = rows.slice(limit);
  return { shown: rows.slice(0, limit), hidden, hiddenClaims: hidden.reduce((n, r) => n + (r.kind === 'single' ? 1 : r.claims.length), 0) };
}

/** Pages can repeat rows (C 2.4): merges keep the first copy of each id. */
export function dedupeById<T extends { id: string }>(...lists: readonly (readonly T[])[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const l of lists) for (const x of l) if (!seen.has(x.id)) { seen.add(x.id); out.push(x); }
  return out;
}

/** What a card whose status is `superseded` can truthfully say, once its history has been read (design 5).
 *  `status` of a claim is the effective status since 0.3.0: a claim under a superseded or dead subject reads `superseded` though nothing
 *  replaced or withdrew it. A claim is withdrawn only when it has no successor, no merge and an active subject. */
export type SupersedeOutcome = 'replaced' | 'withdrawn' | 'merged' | 'by-subject' | 'unknown';
export function supersedeOutcome(i: { successor: string | null | undefined; mergedInto: string | null | undefined; subjectStatus: string | undefined; statusBasis?: string | undefined }): SupersedeOutcome {
  if (i.successor) return 'replaced';
  if (i.mergedInto) return 'merged';
  // Since contract 0.3.1 the claim says where its status comes from; the subject is read only for a KB that does not say.
  if (i.statusBasis === 'subject') return 'by-subject';
  if (i.statusBasis === 'own') return 'withdrawn';
  if (i.subjectStatus === undefined) return 'unknown';
  return i.subjectStatus === 'active' ? 'withdrawn' : 'by-subject';
}
export const SUPERSEDE_LABEL: Record<SupersedeOutcome, string> = {
  replaced: '대체됨', withdrawn: '철회', merged: '병합됨', 'by-subject': '주어 상태 때문에 가려짐', unknown: '대체 여부 확인하지 못함',
};
/** Before the history is read the card knows only that the claim is no longer current. */
export const SUPERSEDE_NEUTRAL = '현재 값 아님';

/** The first time a claim was observed: the earliest version. A superseded row's own `recorded_at` is when it was replaced (C 2.9). */
export const firstObservedAt = (versions: readonly { recorded_at: string }[] | undefined): string | undefined =>
  versions?.length ? versions.reduce((a, v) => (Date.parse(v.recorded_at) < Date.parse(a) ? v.recorded_at : a), versions[0]!.recorded_at) : undefined;

/** In a past view, a version recorded after the observed axis is not part of what was known then. */
export const recordedAfter = (recordedAt: string, observed: string | undefined) => observed !== undefined && Date.parse(recordedAt) > Date.parse(observed);

// Verdict names from the KB, in the words of design 5. An unknown value is shown as it is (C 2.10).
const VERIFICATION: Record<string, string> = { quote_found: '인용 위치 확인됨', parser_derived: '파서 추출', first_party: '직접 기록' };
export const verificationLabel = (v: string | null | undefined) => (v ? (Object.hasOwn(VERIFICATION, v) ? VERIFICATION[v] : isUnverified({ verification: v }) ? null : v) : null);

