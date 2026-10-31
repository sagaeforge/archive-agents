// Type-level checks, ported from the S4 assertions. tsc reports a failed check as an error on its line.
// A line with @ts-expect-error must fail to compile; if it starts compiling, tsc says the directive is unused.
import type {
  Claim, ClaimDetail, Edge, EdgeRef, Envelope, GetNodeParams, GetOverviewParams, ListNodesParams, MetaEnvelope, Node,
  NodeDetailEnvelope, NodeListEnvelope, Page, SearchParams, ValidTime,
} from '../src/client/model/index.ts';
import { asOf } from '../src/time/asOf.ts';
import { asOfFor, type TimeAwareOperation } from '../src/time/timeAxes.ts';
import { getGetNodeQueryOptions, getListNodesInfiniteQueryOptions, getMeta, listNodes, type ListNodesQueryError } from '../src/client/kb.ts';

type Same<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type IsAny<T> = 0 extends 1 & T ? true : false;
type Req<T, K extends keyof T> = {} extends Pick<T, K> ? false : true;
type Opt<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;
type Is<X, Y> = IsAny<X> extends true ? false : Same<X, Y>;
const ok = <T extends true>(_?: T) => {};

/*T01 envelope fields are required*/ ok<Req<Envelope, 'schema_version'>>(); ok<Req<Envelope, 'applied_seq'>>(); ok<Req<Envelope, 'degraded'>>(); ok<Req<NodeDetailEnvelope, 'data'>>();
/*T02 timestamps stay strings; data_as_of is null on an empty ledger*/ ok<Is<Envelope['data_as_of'], string | null>>(); ok<Is<Node['recorded_at'], string>>();
/*T03 0.3.0: the base envelope declares no data and no page; each path's envelope adds them*/ ok<Same<'data' | 'page' extends keyof Envelope ? true : false, false>>(); ok<Req<NodeListEnvelope, 'page'>>(); ok<Req<NodeListEnvelope, 'data'>>();
/*T04 next_cursor is string or null*/ ok<Req<Page, 'next_cursor'>>(); ok<Is<Page['next_cursor'], string | null>>();
/*T05 total is required and may be null*/ ok<Req<Page, 'total'>>(); ok<Is<Page['total'], number | null>>();
/*T06 required nullable and optional nullable*/ ok<Opt<Node, 'merged_into'>>(); ok<Is<Exclude<Node['merged_into'], undefined>, string | null>>(); ok<Req<Node, 'label'>>();
/*T07 closed enums*/ ok<Is<Node['status'], 'active' | 'superseded' | 'dead'>>(); ok<Is<Node['origin'], 'external' | 'first_party'>>(); ok<Is<Node['sensitivity'], 'public' | 'internal' | 'private' | 'secret'>>();
/*T08 open set stays string*/ ok<Is<Node['type'], string>>(); ok<Is<Exclude<Node['liveness'], undefined>, string | null>>();
/*T09 edge sensitivity is required in 0.2.0*/ ok<Req<Edge, 'sensitivity'>>(); ok<Req<EdgeRef, 'status'>>();
/*T10 claim extends node*/ ok<Req<Claim, 'statement'>>(); ok<Req<Claim, 'id'>>(); ok<Is<Claim['kind'], 'event' | 'state' | 'howto'>>();
/*T11 claim detail adds versions (required since 0.3.0)*/ ok<Req<ClaimDetail, 'versions'>>();
/*T12 detail 200 maps to the envelope*/ ok<Is<Awaited<ReturnType<typeof getMeta>>, MetaEnvelope>>(); ok<Is<Awaited<ReturnType<typeof listNodes>>, NodeListEnvelope>>();
/*T13 detail claims are Claim[]*/ ok<Is<NonNullable<NodeDetailEnvelope['data']['claims']>[number], Claim>>();
/*T14 valid time has precision enum*/ ok<Is<NonNullable<Exclude<ValidTime['precision'], undefined>>, 'instant' | 'day' | 'month' | 'quarter' | 'year'>>();
/*T15 cursor is a string param*/ ok<Is<NonNullable<ListNodesParams['cursor']>, string>>(); ok<Is<NonNullable<ListNodesParams['limit']>, number>>();
/*T16 the declared error type is a union of problems*/ ok<Req<Extract<ListNodesQueryError, { code?: string }>, 'status'>>();
/*T17 search needs q*/ ok<Req<SearchParams, 'q'>>();

// as_of axes: names come from one place and survive only if the spec still has them.
export const ax = asOf({ valid: '2026-01-01T00:00:00Z' });
/*T20 axis names exist on every time-aware param type*/ ok<Opt<GetNodeParams, 'as_of_valid'>>(); ok<Opt<GetNodeParams, 'as_of_observed'>>(); ok<Opt<GetOverviewParams, 'as_of_valid'>>();
export const p1: ListNodesParams = { ...ax };
// @ts-expect-error a misspelled axis is an excess property
export const p2: ListNodesParams = { as_of_vaild: 'x' };
// @ts-expect-error an operation without axes is not accepted by the wrapper
export const p3 = asOfFor('listChanges', {});
export const p4 = asOfFor('getNode', {});
/*T21 TimeAwareOperation excludes the C 2.9 set*/ ok<Is<Extract<TimeAwareOperation, 'getMeta' | 'listChanges' | 'getSnapshot' | 'getNodeHistory' | 'getExportGraph'>, never>>();
// @ts-expect-error id must be a string
getGetNodeQueryOptions(42);
// @ts-expect-error cursor is a string
export const nope = getListNodesInfiniteQueryOptions({ cursor: 1 });
