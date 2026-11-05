// /node/<id>. Everything is a node in the KB (KB ADR 7.3): the screen is chosen by what the id turns out to be (design 7.1).
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { getRouteApi, Link, Navigate, useNavigate, useSearch } from '@tanstack/react-router';
import type { Claim, Evidence, NodeDetail } from '../client/model/index.ts';
import { validateNodeSearch } from '../routes/search.ts';
import { useScreenTitle } from '../app/useScreenTitle.ts';
import { CopyLink } from '../app/CopyLink.tsx';
import { Chip, Empty, ErrorCard, Instant, Loading } from '../components/bits.tsx';
import { PageRoot } from '../components/PageRoot.tsx';
import { useBodyRest, useCheckAll, useClaimsRest, useNodeBrief, useNodeDetail, useSchemaCatalog, type CheckTally, type NodeFilters } from '../data/hooks.ts';
import { KbProblem } from '../data/kbFetch.ts';
import { classifyId } from '../ids.ts';
import { describeError } from '../lib/errors.ts';
import { pushRecent } from '../palette/recent.ts';
import { ErrorPage } from '../screens/ErrorScreens.tsx';
import { formatValid } from '../time/format.ts';
import { useIsPastView } from '../time/useTimeBasis.ts';
import { ClaimGroups } from './ClaimGroups.tsx';
import { ClaimScreen } from './ClaimScreen.tsx';
import { dedupeById } from './claimState.ts';
import { checkSummary, domainText, relationCount, valueLabel } from './labels.ts';
import { RelationsPanel, RELATIONS_ID } from './RelationsPanel.tsx';
import { useMergeRedirect } from './useMergeRedirect.ts';

const MarkdownView = lazy(() => import('../render/MarkdownView.tsx'));
const route = getRouteApi('/node/$id');

export function NodeScreen() {
  const { id } = route.useParams();
  const kind = classifyId(id);
  // The contract does not promise /v1/nodes answers for every prefix (appendix B 2), so the prefix decides first.
  if (kind === 'snapshot') return <Navigate to="/source/$id" params={{ id }} replace />;
  if (kind === 'claim') return <ClaimScreen id={id} />;
  return <EntityScreen key={id} id={id} />;
}

function NotVisible({ id }: { id: string }) {
  const past = useIsPastView();
  return (
    <PageRoot className="page-narrow" data-testid="not-visible-page">
      <h1 className="page-title">없거나 볼 수 없음</h1>
      <p className="mt-2 text-soft">{past ? '이 시점에는 없었거나, 지금 범위에서 볼 수 없다.' : '이 ID는 없거나 지금 범위에서 볼 수 없다.'}</p>
      <p className="id mt-3 break-all" data-testid="node-id">{id}</p>
    </PageRoot>
  );
}

function Tombstone({ id, path }: { id: string; path: string[] }) {
  return (
    <PageRoot className="page-narrow" data-testid="tombstone">
      <h1 className="page-title">병합됨, 대상 접근 불가</h1>
      <p className="mt-2 text-soft">이 항목은 다른 항목으로 병합됐다. 병합 대상이 없거나 볼 수 없다.</p>
      <p className="id mt-3 break-all">{path.join(' → ')}</p>
      <p className="id mt-1 break-all" data-testid="node-id">{id}</p>
    </PageRoot>
  );
}

function MergeError({ path }: { path: string[] }) {
  return (
    <PageRoot className="page-narrow" role="alert" data-testid="merge-error">
      <h1 className="page-title">병합 경로를 따라갈 수 없다</h1>
      <p className="mt-2 text-soft">병합 연결이 순환하거나 너무 길다. KB 쪽 데이터를 확인해야 한다.</p>
      <p className="id mt-3 break-all">{path.join(' → ')}</p>
    </PageRoot>
  );
}

export function EntityScreen({ id, windowed = false }: { id: string; windowed?: boolean }) {
  const search = validateNodeSearch(useSearch({ strict: false }));
  const filters: NodeFilters = useMemo(() => ({ status: search.status, include_unverified: search.include_unverified }), [search.status, search.include_unverified]);
  const q = useNodeDetail(id, filters);
  const node = q.data?.data;
  const merge = useMergeRedirect(id, node);
  useScreenTitle(node?.label ?? id, !windowed);
  const settled = !!node && !merge.active;
  useEffect(() => { if (settled) pushRecent(id); }, [settled, id]);

  if (q.isPending) return <PageRoot className="page"><Loading /></PageRoot>;
  // An error with data in hand is a failed background read: the screen stays and says so (design 7.4). Only a read with nothing to show is an error screen.
  if (q.isError && !node) {
    const info = describeError(q.error);
    if (q.error instanceof KbProblem && info.hidden) return <NotVisible id={id} />;
    return <ErrorPage error={q.error} onRetry={() => void q.refetch()} />;
  }
  if (merge.active) {
    if (merge.error) return <ErrorPage error={merge.error} onRetry={merge.retry} />;
    if (merge.result?.kind === 'gone') return <Tombstone id={id} path={merge.result.path} />;
    if (merge.result) return <MergeError path={merge.result.path} />;
    return <PageRoot className="page"><Loading label="병합 대상을 찾는 중" /></PageRoot>;
  }
  if (node!.type === 'Snapshot') return <Navigate to="/source/$id" params={{ id }} replace />;
  return <EntityPage windowed={windowed} node={node!} id={id} filters={filters} truncated={!!node!.claims_truncated} mergedFrom={search.merged_from} staleError={q.isError ? q.error : null} onRetry={() => void q.refetch()} />;
}

function MergeNotice({ from, to, label }: { from: string; to: string; label: string }) {
  const brief = useNodeBrief(from);
  // `merged_from` comes from the URL: the notice stands only if the KB agrees.
  const confirmed = brief.data && (brief.data.merged_into_final === to || brief.data.merged_into === to);
  if (!confirmed) return null;
  return <p className="notice" role="status" data-testid="merge-notice"><bdi>{brief.data.label}</bdi>은(는) <bdi>{label}</bdi>(으)로 병합됐다.</p>;
}

function Toggle({ on, onClick, children, testid }: { on: boolean; onClick: () => void; children: string; testid: string }) {
  return <button type="button" className="toggle" aria-pressed={on} onClick={onClick} data-testid={testid}>{children}</button>;
}

function useFilterNav() {
  const navigate = useNavigate();
  return (patch: { status?: 'all' | undefined; include_unverified?: true | undefined }) =>
    void navigate({ to: '.', search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }), replace: true, resetScroll: false } as never);
}

function CheckAll({ evidence, unread }: { evidence: readonly Evidence[]; unread: boolean }) {
  const check = useCheckAll();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<CheckTally | null>(null);
  if (evidence.length === 0) return null;
  const start = async () => {
    setResult(null);
    setProgress({ done: 0, total: evidence.length });
    const t = await check(evidence, (s) => setProgress({ done: s.ok + s.failed, total: s.total }));
    setProgress(null);
    setResult(t);
  };
  const running = progress !== null;
  const failed = result !== null && result.failed > 0;
  return (
    <span className="check-all" data-testid="check-all-wrap">
      <button type="button" className="text-action" disabled={running} onClick={() => void start()} data-testid="check-all" data-failed={failed || undefined}>
        {running ? `확인 중 ${progress.done}/${progress.total}` : result ? (failed ? '다시 확인' : checkSummary(result, unread)) : '인용 전체 확인'}
      </button>
      {result && failed && <span role="status" className="text-xs text-danger" data-testid="check-all-result">{checkSummary(result, unread)}</span>}
    </span>
  );
}

function RecordBody({ node, id }: { node: NodeDetail; id: string }) {
  const rest = useBodyRest(id, node.body, node.body_chars);
  if (!node.body) return null;
  const text = node.body + rest.text;
  const more = rest.more && !(rest.data && !rest.hasNextPage);
  return (
    <section className="mt-6" data-testid="record-body">
      <Suspense fallback={<Loading />}><MarkdownView text={text} wikilinks /></Suspense>
      {rest.error && !rest.data && <div className="mt-3"><ErrorCard error={rest.error} compact onRetry={() => void rest.refetch()} /></div>}
      {more && <button type="button" className="text-action mt-2" onClick={() => { if (rest.data) void rest.fetchNextPage(); else if (rest.asked) void rest.refetch(); else rest.request(); }} disabled={rest.isFetching} data-testid="body-more">본문 이어 읽기</button>}
    </section>
  );
}

/** The links are the second job of this page and sit after every claim in the page order, so the header offers the way to them. */
function jumpToRelations() {
  const el = document.getElementById(RELATIONS_ID);
  if (!el) return;
  el.scrollIntoView({ block: 'start' });
  el.focus({ preventScroll: true });
}

function EntityHeader({ node, id }: { node: NodeDetail; id: string }) {
  const valid = formatValid(node.valid);
  const props = Object.entries(node.props ?? {});
  return (
    <header>
      <p className="eyebrow"><span data-testid="node-type">{node.type}</span>{domainText(node.domain) && <span data-testid="node-domain">{domainText(node.domain)}</span>}</p>
      <h1 className="entity-title" dir="auto" data-testid="node-title">{node.label}</h1>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <code className="id" data-testid="node-id">{id}</code>
        <CopyLink />
        <Link to="/graph" search={{ focus: id }} className="link text-sm" data-testid="node-graph-link">그래프에서 보기</Link>
        <button type="button" className="text-action" onClick={jumpToRelations} data-testid="to-relations">관계 {relationCount(node.edges)}</button>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5" data-testid="node-chips">
        {node.status !== 'active' && <Chip data-testid="node-status">{node.status === 'dead' ? '죽은 데이터' : node.status}</Chip>}
        {node.liveness && node.liveness !== 'active' && <Chip>{node.liveness}</Chip>}
        {node.link_status && <Chip>{node.link_status}</Chip>}
        <Chip>{valueLabel(node.origin)}</Chip>
        <Chip>{valueLabel(node.sensitivity)}</Chip>
      </div>
      <dl className="kv mt-3">
        {valid && <><dt>유효</dt><dd>{valid}</dd></>}
        <dt>관측</dt><dd><Instant iso={node.recorded_at} /></dd>
        {node.author && <><dt>작성자</dt><dd className="id break-all" data-testid="author">{node.author}</dd></>}
        {node.on_behalf_of && <><dt>대리</dt><dd className="id break-all">{node.on_behalf_of}</dd></>}
        {node.generated_by && <><dt>생성</dt><dd className="id break-all">{node.generated_by}</dd></>}
        {props.map(([k, v]) => <div key={k} className="contents"><dt>{k}</dt><dd className="break-words" dir="auto">{typeof v === 'string' ? v : JSON.stringify(v)}</dd></div>)}
      </dl>
    </header>
  );
}

function ClaimsSection({ node, id, filters, truncated }: { node: NodeDetail; id: string; filters: NodeFilters; truncated: boolean }) {
  const schema = useSchemaCatalog();
  const setFilter = useFilterNav();
  const [more, setMore] = useState(false);
  const rest = useClaimsRest(id, filters, more);
  const claims: Claim[] = useMemo(() => dedupeById(node.claims ?? [], rest.items), [node.claims, rest.items]);
  const evidence = useMemo(() => claims.flatMap((c) => c.evidence ?? []).filter((e) => e.selector_kind === 'text_quote'), [claims]);
  const allStatus = filters.status === 'all';
  const unverified = !!filters.include_unverified;
  const partial = truncated && (!more || rest.hasNextPage || rest.isPending);
  const toggles = (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="claim-toggles">
      <Toggle on={allStatus} onClick={() => setFilter({ status: allStatus ? undefined : 'all' })} testid="toggle-status">대체·죽은 데이터 포함</Toggle>
      <Toggle on={unverified} onClick={() => setFilter({ include_unverified: unverified ? undefined : true })} testid="toggle-unverified">미검증 포함</Toggle>
    </div>
  );
  return (
    <section className="mt-8" aria-label="주장" data-testid="claims">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="section-label">주장 <span className="tabular-nums" data-testid="claim-count">{claims.length}{partial ? '+' : ''}</span></h2>
        {toggles}
        <span className="ml-auto"><CheckAll evidence={evidence} unread={partial} /></span>
      </div>
      {claims.length === 0 && (
        <Empty className="mt-3">
          {node.status === 'dead' || node.status === 'superseded'
            ? '이 항목의 상태 때문에 기본 보기에서 주장이 빠졌다. 위의 대체·죽은 데이터 포함을 켜면 보인다.'
            : '이 기준으로 보이는 주장이 없다.'}
        </Empty>
      )}
      <ClaimGroups claims={claims} pageId={id} schema={schema.data} />
      {rest.error && <div className="mt-3"><ErrorCard error={rest.error} compact onRetry={() => void rest.refetch()} /></div>}
      {partial && (
        <div className="mt-4 flex items-center gap-3 text-sm" data-testid="claims-truncated">
          <span className="text-soft">앞의 {claims.length}개만 읽었다{rest.total != null ? `. 전체 ${rest.total}개` : ''}.</span>
          <button type="button" className="text-action" disabled={rest.isFetching} onClick={() => { if (more) void rest.fetchNextPage(); else setMore(true); }} data-testid="claims-more">
            {rest.isFetching ? '읽는 중' : '이어 읽기'}
          </button>
        </div>
      )}
    </section>
  );
}

function EntityPage({ node, id, filters, truncated, mergedFrom, staleError, onRetry, windowed = false }: {
  windowed?: boolean;
  node: NodeDetail; id: string; filters: NodeFilters; truncated: boolean; mergedFrom: string | undefined; staleError: unknown; onRetry: () => void;
}) {
  return (
    <PageRoot className={windowed ? "page window-entity" : "page entity-page"} data-testid="entity-page" data-id={id}>
      <div className="min-w-0">
        {staleError != null && <div className="mb-4" data-testid="stale-error"><ErrorCard error={staleError} compact onRetry={onRetry} /></div>}
        {mergedFrom && <MergeNotice from={mergedFrom} to={id} label={node.label} />}
        <EntityHeader node={node} id={id} />
        <RecordBody node={node} id={id} />
        <ClaimsSection node={node} id={id} filters={filters} truncated={truncated} />
      </div>
      {windowed ? <details className="window-relations"><summary>백링크 · 정보</summary><RelationsPanel node={node} id={id} filters={filters} embedded /></details> : <RelationsPanel node={node} id={id} filters={filters} />}
    </PageRoot>
  );
}

