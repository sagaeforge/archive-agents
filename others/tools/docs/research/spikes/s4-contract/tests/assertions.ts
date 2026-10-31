// Shared type-level test suite. One assertion per line so a tsc diagnostic maps to a check name.
// Generated types are reached only through ./adapter, which every candidate provides.
import type * as A from './adapter';

type Same<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsUnknown<T> = IsAny<T> extends true ? false : unknown extends T ? true : false;
type Req<T, K extends keyof T> = {} extends Pick<T, K> ? false : true;
type Opt<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;
type Is<X, Y> = IsAny<X> extends true ? false : IsUnknown<X> extends true ? false : Same<X, Y>;
const ok = <T extends true>(_: T) => {};
type Variant<K extends string> = Extract<A.ClaimValue, { value_type: K }>;

/*T01 envelope fields are required      */ ok<Req<A.EntityPage, 'schema_version'>>(true); ok<Req<A.EntityPage, 'data_as_of'>>(true); ok<Req<A.EntityPage, 'build_id'>>(true); ok<Req<A.EntityPage, 'data'>>(true); ok<Req<A.EntityPage, 'page'>>(true);
/*T02 timestamps stay string, not Date  */ ok<Is<A.EntityPage['data_as_of'], string>>(true); ok<Is<A.Claim['valid_from'], string>>(true);
/*T03 page data is Entity[]             */ ok<Is<A.EntityPage['data'][number], A.Entity>>(true);
/*T04 next_cursor required string|null  */ ok<Req<A.PageInfo, 'next_cursor'>>(true); ok<Is<A.PageInfo['next_cursor'], string | null>>(true);
/*T05 has_more required boolean         */ ok<Req<A.PageInfo, 'has_more'>>(true); ok<Is<A.PageInfo['has_more'], boolean>>(true);
/*T06 total optional integer|null       */ ok<Opt<A.PageInfo, 'total'>>(true); ok<Is<NonNullable<A.PageInfo['total']> | null, number | null>>(true);
/*T07 required nullable type array      */ ok<Req<A.Entity, 'merged_into'>>(true); ok<Is<A.Entity['merged_into'], string | null>>(true);
/*T08 optional nullable type array      */ ok<Opt<A.Entity, 'description'>>(true); ok<Is<Exclude<A.Entity['description'], undefined>, string | null>>(true);
/*T09 nullable with format date-time    */ ok<Req<A.Claim, 'valid_to'>>(true); ok<Is<A.Claim['valid_to'], string | null>>(true);
/*T10 optional nullable number          */ ok<Opt<A.Claim, 'confidence'>>(true); ok<Is<Exclude<A.Claim['confidence'], undefined>, number | null>>(true);
/*T11 enum containing null              */ ok<Is<Exclude<A.Claim['supersede_reason'], undefined>, 'correction' | 'update' | 'merge' | null>>(true);
/*T12 oneOf ref or null is required     */ ok<Req<A.Claim, 'source'>>(true); ok<Is<A.Claim['source'], A.SourceRef | null>>(true);
/*T13 const text variant                */ ok<Is<Variant<'text'>['value'], string>>(true);
/*T14 const number variant              */ ok<Is<Variant<'number'>['value'], number>>(true);
/*T15 enum-style boolean variant        */ ok<Is<Variant<'boolean'>['value'], boolean>>(true);
/*T16 date variant is string            */ ok<Is<Variant<'date'>['value'], string>>(true);
/*T17 entity_ref variant shape          */ ok<Is<Variant<'entity_ref'>['entity_id'], string>>(true);
/*T18 recursive list variant            */ ok<Is<Variant<'list'>['items'][number], A.ClaimValue>>(true);
/*T19 discriminator is a closed union   */ ok<Is<A.ClaimValue['value_type'], 'text' | 'number' | 'boolean' | 'date' | 'entity_ref' | 'list'>>(true);
/*T20 exhaustive switch reaches never   */ export function t20(v: A.ClaimValue): string { switch (v.value_type) { case 'text': return v.value.toUpperCase(); case 'number': return v.value.toFixed(1); case 'boolean': return String(v.value === true); case 'date': return v.value.slice(0, 4); case 'entity_ref': return v.entity_id; case 'list': return v.items.map(t20).join(','); default: { const n: never = v; return n; } } }
/*T21 narrowing drops other variants    */ export function t21(v: A.ClaimValue) { if (v.value_type === 'entity_ref') {
  // @ts-expect-error value does not exist on entity_ref
  return v.value;
} }
/*T22 unknown discriminator rejected    */ // @ts-expect-error bogus discriminator
export const t22: A.ClaimValue = { value_type: 'bogus', value: 1 };
/*T23 mismatched variant value rejected */ // @ts-expect-error string in a number variant
export const t23: A.ClaimValue = { value_type: 'number', value: 'x' };
/*T24 const literal on non-union field  */ ok<Is<A.QuoteLocation['unit'], 'codepoint'>>(true);
/*T25 Problem required members          */ ok<Req<A.Problem, 'type'>>(true); ok<Req<A.Problem, 'title'>>(true); ok<Req<A.Problem, 'status'>>(true); ok<Is<A.Problem['status'], number>>(true);
/*T26 Problem allows extension members  */ export const t26: A.Problem = { type: 'about:blank', title: 't', status: 400, retry_after: 3 };
/*T27 404 is typed as Problem           */ ok<Is<A.GetEntity404, A.Problem>>(true);
/*T28 as_of params optional strings     */ ok<Opt<A.ListQuery, 'as_of_valid'>>(true); ok<Opt<A.ListQuery, 'as_of_observed'>>(true); ok<Is<NonNullable<A.ListQuery['as_of_valid']>, string>>(true); ok<Is<NonNullable<A.ListQuery['as_of_observed']>, string>>(true);
/*T29 cursor and limit params           */ ok<Is<NonNullable<A.ListQuery['cursor']>, string>>(true); ok<Is<NonNullable<A.ListQuery['limit']>, number>>(true);
/*T30 required query param stays so     */ ok<Req<A.OverviewQuery, 'type'>>(true);
/*T31 unknown query param rejected      */ // @ts-expect-error misspelled axis
export const t31: A.ListQuery = { as_of_vaild: 'x' };
/*T32 closed enum                       */ ok<Is<A.Entity['status'], 'active' | 'superseded' | 'dead' | 'merged'>>(true);
/*T33 open-set type stays string        */ ok<Is<A.Entity['type'], string>>(true);
/*T34 allOf merges parent and own       */ ok<Req<A.EntityDetail, 'id'>>(true); ok<Req<A.EntityDetail, 'claims'>>(true); ok<Is<A.EntityDetail['claims'][number], A.Claim>>(true);
/*T35 operation 200 maps to envelope    */ ok<Is<A.ListEntities200, A.EntityPage>>(true);
/*T36 missing required field rejected   */ // @ts-expect-error merged_into is required
export const t36: A.Entity = { id: 'ent_a', type: 'x', label: 'l', status: 'active', origin: 'external', sensitivity: 'public' };
/*T37 null rejected on non-null field   */ // @ts-expect-error label is not nullable
export const t37: A.Entity = { id: 'ent_a', type: 'x', label: null, status: 'active', origin: 'external', sensitivity: 'public', merged_into: null };
