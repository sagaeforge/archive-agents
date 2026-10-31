// Typed client proof. Runs every contract feature through generated query options against kb-mock.
import { QueryClient } from '@tanstack/react-query';
import { getGetEntityQueryKey, getGetEntityQueryOptions, getGetOverviewQueryOptions, getGetSchemaCatalogQueryOptions, getGetSnapshotQueryOptions, getListEntitiesInfiniteQueryOptions, getListEntitiesQueryOptions } from './client/kb';
import type { ClaimValue, EntityPage, GetEntityParams } from './client/model';
import { KbProblem } from './lib/kbFetch';

const render = (v: ClaimValue): string => {
  switch (v.value_type) {
    case 'text': return v.value;
    case 'number': return `${v.value}${v.unit ?? ''}`;
    case 'boolean': return v.value ? 'yes' : 'no';
    case 'date': return v.value;
    case 'entity_ref': return `->${v.entity_id}`;
    case 'list': return `[${v.items.map(render).join(', ')}]`;
    default: { const never: never = v; return never; }
  }
};
const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const results: [string, boolean, unknown][] = [];
const check = (name: string, ok: boolean, info?: unknown) => { results.push([name, ok, info]); };

// satisfies keeps the excess-property check on a stored object. A renamed axis then fails tsc.
const earlyAxes = { as_of_valid: '2025-06-01T00:00:00Z', as_of_observed: '2025-06-01T00:00:00Z' } satisfies GetEntityParams;
const lateAxes = { as_of_valid: '2025-06-01T00:00:00Z', as_of_observed: '2026-06-01T00:00:00Z' } satisfies GetEntityParams;

const list = await qc().fetchQuery(getListEntitiesQueryOptions({ limit: 50 }));
check('envelope present', !!list.schema_version && !!list.data_as_of && !!list.build_id);
check('active visible rows, restricted hidden', list.data.map((e) => e.id).join() === 'ent_acme,ent_kim', list.data.map((e) => e.id));
check('Hangul label survives', list.data[0]?.label === '아크메 코리아');

const inf = await qc().fetchInfiniteQuery({ ...getListEntitiesInfiniteQueryOptions({ limit: 1 }), initialPageParam: undefined, getNextPageParam: (p: EntityPage) => p.page.next_cursor ?? undefined, pages: 5 });
check('cursor pagination walks to null', inf.pages.length === 2 && inf.pages[1]!.page.next_cursor === null, inf.pages.map((p) => p.page));

const early = await qc().fetchQuery(getGetEntityQueryOptions('ent_acme', earlyAxes));
const late = await qc().fetchQuery(getGetEntityQueryOptions('ent_acme', lateAxes));
const headcount = (e: typeof early) => e.data.claims.filter((c) => c.predicate === 'headcount').map((c) => render(c.value));
check('retroactive correction, observed before', headcount(early).join() === '120명', headcount(early));
check('retroactive correction, observed after', headcount(late).join() === '150명', headcount(late));
check('query key separates as_of axes', JSON.stringify(getGetEntityQueryKey('ent_acme', earlyAxes)) !== JSON.stringify(getGetEntityQueryKey('ent_acme', lateAxes)));

const all = await qc().fetchQuery(getGetEntityQueryOptions('ent_acme'));
const rendered = all.data.claims.map((c) => render(c.value));
check('all six value types render, recursion included', rendered.some((r) => r.includes('[채널, [1]]')) && rendered.includes('->ent_kim') && rendered.includes('no'), rendered);
check('nullable source and valid_to', all.data.claims.some((c) => c.source === null && c.valid_to === null));

const merged = await qc().fetchQuery(getGetEntityQueryOptions('ent_acme2'));
check('merged_into follows immutable id', merged.data.merged_into === 'ent_acme');

const snap = await qc().fetchQuery(getGetSnapshotQueryOptions('snp_a1'));
const quote = late.data.claims.find((c) => c.source?.quote)?.source?.quote;
check('code point quote slice matches exact', quote !== undefined && [...snap.data.body].slice(quote.start, quote.end).join('') === quote.exact);

const ov = await qc().fetchQuery(getGetOverviewQueryOptions({ type: 'organization' }));
check('overview total and truncated', ov.data.total.nodes === 1 && ov.data.truncated === false);
const cat = await qc().fetchQuery(getGetSchemaCatalogQueryOptions());
check('catalog drives types', cat.data.entity_types.includes('organization'));

const reject = async (o: Parameters<QueryClient['fetchQuery']>[0]) => { try { await qc().fetchQuery(o); return null; } catch (e) { return e; } };
const nf = await reject(getGetEntityQueryOptions('ent_nope') as never);
check('404 rejects with RFC 9457 body', nf instanceof KbProblem && nf.problem.status === 404 && nf.problem.code === 'entity_not_found', nf instanceof KbProblem ? nf.problem : nf);
const bad = await reject(getListEntitiesQueryOptions({ limit: 0 }) as never);
check('400 rejects with RFC 9457 body', bad instanceof KbProblem && bad.problem.status === 400);
const hidden = await reject(getGetEntityQueryOptions('ent_note') as never);
check('restricted entity reads as 404', hidden instanceof KbProblem && hidden.problem.status === 404);

const failed = results.filter(([, ok]) => !ok);
for (const [n, ok, info] of results) console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : JSON.stringify(info));
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
