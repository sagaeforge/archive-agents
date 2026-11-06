import { describe, expect, it } from 'vitest';
import { claimState, dedupeById, foldRows, groupClaims, isUnverified, predicateLabel, type ClaimRow } from '../src/entity/claimState.ts';
import { quietChips } from '../src/entity/ClaimCard.tsx';
import type { Claim, Predicate } from '../src/client/model/index.ts';

const AT = Date.parse('2026-10-31T00:00:00Z');
let n = 0;
const claim = (o: Partial<Claim>): Claim => ({
  id: `c-${++n}`, type: 'Claim', label: 'l', statement: 's', origin: 'external', status: 'active', sensitivity: 'public', version: 1, recorded_at: `2026-10-${String(10 + n % 20).padStart(2, '0')}T00:00:00Z`,
  subject: 'e:x:y', kind: 'state', stance: 'stated', method: 'llm', ...o,
} as Claim);

describe('claim states (design 5)', () => {
  it.each([
    [{ status: 'active', valid: { from: '2026-01-01', to: null } }, 'current'],
    [{ status: 'active', valid: { from: null, to: null } }, 'current'],
    [{ status: 'active' }, 'current'],
    [{ status: 'active', valid: { from: '2026-01-01', to: '2026-10-01' } }, 'ended'],
    [{ status: 'active', valid: { from: '2027-02-01', to: null } }, 'scheduled'],
    [{ status: 'superseded', valid: { from: '2026-01-01', to: null } }, 'superseded'],
    [{ status: 'dead' }, 'dead'],
  ] as [Pick<Claim, 'status' | 'valid'>, string][])('%j is %s', (c, want) => { expect(claimState(c, AT)).toBe(want); });
  it('a valid end at exactly the reference moment has passed', () => { expect(claimState({ status: 'active', valid: { from: null, to: '2026-10-31' } }, AT)).toBe('ended'); });
  it('unverified is a separate question from status', () => {
    expect(isUnverified({ verification: 'needs_review' })).toBe(true); expect(isUnverified({ verification: 'unverified' })).toBe(true);
    expect(isUnverified({ verification: 'quote_found' })).toBe(false); expect(isUnverified({ verification: null })).toBe(false);
  });
});

const P: Predicate[] = [
  { id: 'port', functional: false, value_kind: 'number', labels: { ko: '포트', en: 'port' } },
  { id: 'alpha', functional: false, value_kind: 'text', labels: { ko: '가나다', en: 'alpha' } },
] as Predicate[];

describe('grouping (design 5)', () => {
  it('groups by predicate with catalog labels and puts null last as 분류 전', () => {
    const g = groupClaims([claim({ predicate: null }), claim({ predicate: 'port' }), claim({ predicate: 'alpha' }), claim({ predicate: 'unknown_one' })], P);
    expect(g.map((x) => x.label)).toEqual(['가나다', '포트', 'unknown_one', '분류 전']);
    expect(g[1]!.valueKind).toBe('number');
    expect(g[3]!.predicate).toBeNull();
  });
  it('active claims read newest first, others follow', () => {
    const a = claim({ id: 'c-old', predicate: 'port', recorded_at: '2026-10-01T00:00:00Z' });
    const b = claim({ id: 'c-new', predicate: 'port', recorded_at: '2026-10-20T00:00:00Z' });
    const s = claim({ id: 'c-sup', predicate: 'port', recorded_at: '2026-10-30T00:00:00Z', status: 'superseded' });
    const ids = groupClaims([a, s, b], P)[0]!.rows.map((r) => (r.kind === 'single' ? r.claim.id : ''));
    expect(ids).toEqual(['c-new', 'c-old', 'c-sup']);
  });
  it('the same conflict_group stands side by side with no winner', () => {
    const a = claim({ id: 'c-a', predicate: 'port', conflict_group: 'cg-1', recorded_at: '2026-10-01T00:00:00Z' });
    const b = claim({ id: 'c-b', predicate: 'port', conflict_group: 'cg-1', recorded_at: '2026-10-05T00:00:00Z' });
    const c = claim({ id: 'c-c', predicate: 'port', recorded_at: '2026-10-03T00:00:00Z' });
    const rows = groupClaims([a, b, c], P)[0]!.rows;
    expect(rows.map((r) => r.kind)).toEqual(['conflict', 'single']);
    expect(rows[0]).toMatchObject({ group: 'cg-1' });
    expect((rows[0] as Extract<ClaimRow, { kind: 'conflict' }>).claims.map((x) => x.id)).toEqual(['c-b', 'c-a']);
  });
  it('a lone member of a conflict_group is an ordinary row', () => {
    expect(groupClaims([claim({ predicate: 'port', conflict_group: 'cg-2' })], P)[0]!.rows[0]!.kind).toBe('single');
  });
  it('labels fall back from ko to en to the id', () => {
    expect(predicateLabel({ labels: { en: 'only en' } } as unknown as Predicate, 'x')).toBe('only en');
    expect(predicateLabel(undefined, 'raw_id')).toBe('raw_id');
  });
});

describe('folding', () => {
  const rows: ClaimRow[] = [...Array(7).keys()].map((i) => ({ kind: 'single', claim: claim({ id: `c-${i}` }) }));
  it('folds past five and counts claims', () => {
    expect(foldRows(rows).shown).toHaveLength(5); expect(foldRows(rows).hiddenClaims).toBe(2);
  });
  it('five or fewer never fold', () => { expect(foldRows(rows.slice(0, 5)).hidden).toHaveLength(0); });
  it('counts every claim of a folded conflict row', () => {
    const c: ClaimRow = { kind: 'conflict', group: 'g', claims: [claim({}), claim({}), claim({})] };
    expect(foldRows([...rows.slice(0, 5), c]).hiddenClaims).toBe(3);
  });
});

describe('merging pages', () => {
  it('keeps the first copy of each id (C 2.4)', () => {
    expect(dedupeById([{ id: 'a', v: 1 }, { id: 'b', v: 1 }], [{ id: 'b', v: 2 }, { id: 'c', v: 2 }]).map((x) => `${x.id}${x.v}`)).toEqual(['a1', 'b1', 'c2']);
  });
});

describe('chips', () => {
  const enums = { origin: ['external', 'first_party'], sensitivity: ['public', 'internal', 'private', 'secret'], status: ['active', 'superseded', 'dead'] };
  it('stay out of the way at the first catalog value and show anything else, including a value the catalog does not know', () => {
    expect(quietChips({ origin: 'external', sensitivity: 'public', liveness: 'active' }, enums)).toEqual([]);
    expect(quietChips({ origin: 'first_party', sensitivity: 'internal', liveness: 'deprecated' }, enums)).toEqual(['first_party', 'internal', 'deprecated']);
    expect(quietChips({ origin: 'external', sensitivity: 'public', liveness: 'brand_new_value' }, enums)).toEqual(['brand_new_value']);
  });
});
