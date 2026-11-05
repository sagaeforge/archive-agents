// /node/c-…: one claim, its evidence and its versions.
import { Link } from '@tanstack/react-router';
import { useScreenTitle } from '../app/useScreenTitle.ts';
import { CopyLink } from '../app/CopyLink.tsx';
import { Chip, ErrorCard, Instant, Loading, TimeMark } from '../components/bits.tsx';
import { PageRoot } from '../components/PageRoot.tsx';
import { NodeLink, fallbackLabel } from '../components/NodeLink.tsx';
import { useClaim, useNodeBrief, useSchemaCatalog } from '../data/hooks.ts';
import { KbProblem } from '../data/kbFetch.ts';
import { ErrorPage } from '../screens/ErrorScreens.tsx';
import { formatValid } from '../time/format.ts';
import { useIsPastView, useTimeBasis } from '../time/useTimeBasis.ts';
import { ClaimCard } from './ClaimCard.tsx';
import { firstObservedAt, recordedAfter } from './claimState.ts';

const STATUS_LABEL: Record<string, string> = { active: '유효', superseded: '대체됨', dead: '죽은 데이터' };


export function ClaimScreen({ id }: { id: string }) {
  const q = useClaim(id);
  const claim = q.data?.data;
  const schema = useSchemaCatalog();
  const subject = useNodeBrief(claim?.subject);
  const past = useIsPastView();
  const basis = useTimeBasis();
  useScreenTitle(claim ? '주장' : id);
  if (q.isPending) return <PageRoot className="page"><Loading /></PageRoot>;
  // A failed refetch keeps the claim on screen; only a read with nothing to show is an error page.
  if (q.isError && !claim) {
    if (q.error instanceof KbProblem && q.error.status === 404) {
      return (
        <PageRoot className="page-narrow" data-testid="not-visible-page">
          <h1 className="page-title">없거나 볼 수 없음</h1>
          <p className="mt-2 text-soft">{past ? '이 시점에는 없었거나, 지금 범위에서 볼 수 없다.' : '이 주장은 없거나 지금 범위에서 볼 수 없다.'}</p>
          <p className="id mt-3 break-all" data-testid="node-id">{id}</p>
        </PageRoot>
      );
    }
    return <ErrorPage error={q.error} onRetry={() => void q.refetch()} />;
  }
  const c = claim!;
  const predicate = schema.data?.predicates.find((p) => p.id === c.predicate);
  const versions = (c.versions ?? []) as { version: number; status?: string; value?: string | null; valid?: Parameters<typeof formatValid>[0]; recorded_at: string; expired_at?: string | null }[];
  return (
    <PageRoot className="page-narrow" data-testid="claim-page" data-id={id}>
      <p className="eyebrow">
        <span>주장</span>
        <NodeLink id={c.subject} testid="claim-subject" className="link"><bdi>{subject.data?.label ?? fallbackLabel(c.subject)}</bdi></NodeLink>
        {predicate && <span>{predicate.labels?.ko ?? predicate.id}</span>}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1"><code className="id" data-testid="node-id">{id}</code><CopyLink /><TimeMark /></div>
      {q.isError && <div className="mt-3" data-testid="stale-error"><ErrorCard error={q.error} compact onRetry={() => void q.refetch()} /></div>}
      <div className="mt-4"><ClaimCard claim={c} predicate={predicate} enums={schema.data?.enums} firstObserved={firstObservedAt(versions)} /></div>
      {(c.evidence?.length ?? 0) > 0 && (
        <section className="mt-7" data-testid="claim-evidence">
          <h2 className="section-label">근거</h2>
          {c.evidence!.map((e, i) => (
            <div key={e.id} className="evidence-row">
              <span className="pill" aria-hidden>{i + 1}</span>
              <div className="min-w-0">
                {e.selector_kind === 'jsonpointer'
                  ? <code className="id">{e.json_pointer}</code>
                  : <blockquote className="evidence-quote" dir="auto">{e.exact ?? '인용 없음'}</blockquote>}
                <Link to="/source/$id" params={{ id: e.snapshot_id }} search={{ claim: c.id, ev: e.id }} className="text-action" data-testid="evidence-link">원문에서 보기</Link>
              </div>
            </div>
          ))}
        </section>
      )}
      {versions.length > 0 && (
        <section className="mt-8" data-testid="claim-versions">
          <h2 className="section-label">버전 {past && <Chip tone="time" data-testid="versions-now">현재 기준</Chip>}</h2>
          <table className="plain mt-2 w-full">
            <thead><tr><th>판</th><th>상태</th><th>값</th><th>유효</th><th>관측</th><th>만료</th></tr></thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.version} data-after-basis={recordedAfter(v.recorded_at, basis.observed) || undefined} title={recordedAfter(v.recorded_at, basis.observed) ? '이 시점 뒤에 기록된 판' : undefined}>
                  <td className="tabular-nums">{v.version}</td><td>{(v.status && STATUS_LABEL[v.status]) ?? v.status}</td><td className="break-words">{v.value}</td><td>{formatValid(v.valid)}</td>
                  <td><Instant iso={v.recorded_at} /></td><td>{v.expired_at ? <Instant iso={v.expired_at} /> : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </PageRoot>
  );
}
