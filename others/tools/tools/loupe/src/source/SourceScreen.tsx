// /source/<snapshot>?claim=&ev=: the original text with the quote located (design 5). The snapshot paths take no time axes (C 2.9).
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { getRouteApi, Link } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ClaimDetail, Evidence, Snapshot } from '../client/model/index.ts';
import { parsePos } from '../routes/search.ts';
import { useScreenTitle } from '../app/useScreenTitle.ts';
import { CopyLink } from '../app/CopyLink.tsx';
import { Chip, Empty, ErrorCard, ExternalUrl, Instant, Loading, TimeMark } from '../components/bits.tsx';
import { fallbackLabel, NodeLink } from '../components/NodeLink.tsx';
import { isUnverified, verificationLabel } from '../entity/claimState.ts';
import { valueLabel } from '../entity/labels.ts';
import { useClaim, useFullText, useNodeBrief, useSnapshot, useVerdict } from '../data/hooks.ts';
import { KbProblem } from '../data/kbFetch.ts';
import { describeError } from '../lib/errors.ts';
import { cpSlice } from '../quote/codepoints.ts';
import { VERDICT_LABEL, type Verdict } from '../quote/verify.ts';
import { ErrorPage } from '../screens/ErrorScreens.tsx';
import { useIsPastView } from '../time/useTimeBasis.ts';
import { TextBody } from './TextBody.tsx';

const MarkdownView = lazy(() => import('../render/MarkdownView.tsx'));
const route = getRouteApi('/source/$id');

const short = (hash: string | null | undefined) => (hash ? `${hash.slice(0, 12)}…` : '');
/** The evidence a link means. `ev` names it; without `ev`, `pos` picks the one recorded at that position; otherwise the first one in this snapshot. */
export const pickEvidence = (claim: ClaimDetail | undefined, snapshotId: string, evId: string | undefined, pos?: string | undefined): Evidence | undefined => {
  const here = claim?.evidence?.filter((e) => e.snapshot_id === snapshotId) ?? [];
  if (evId) return here.find((e) => e.id === evId);
  const at = parsePos(pos);
  return (at ? here.find((e) => e.start === at.start && e.end === at.end) : undefined) ?? here[0];
};
/** The link of a row in the citing list: the evidence id when the row's claim is the loaded one, otherwise the position. */
export function citingSearch(row: { id: string; start?: number | null; end?: number | null }, loaded: ClaimDetail | undefined, snapshotId: string): { claim: string; ev?: string; pos?: string } {
  const ev = row.id === loaded?.id ? loaded.evidence?.find((e) => e.snapshot_id === snapshotId && e.start === row.start && e.end === row.end) : undefined;
  if (ev) return { claim: row.id, ev: ev.id };
  return row.start != null && row.end != null ? { claim: row.id, pos: `${row.start}-${row.end}` } : { claim: row.id };
}
const quoteOf = (v: Verdict | undefined) => (v && (v.kind === 'match' || v.kind === 'corrected') ? { start: v.start, end: v.end } : null);

function SourceHead({ snap }: { snap: Snapshot }) {
  const raw = useMemo(() => new URL(`kb/v1/snapshots/${encodeURIComponent(snap.id)}/raw`, document.baseURI).href, [snap.id]);
  return (
    <header>
      <p className="eyebrow">
        <span>원문</span><span data-testid="source-label">{snap.source?.label}</span>{snap.source?.trust && <span>{valueLabel(snap.source.trust)}</span>}
      </p>
      <p className="mt-1 text-[0.95rem]" data-testid="source-url"><ExternalUrl url={snap.url} /></p>
      <dl className="kv kv-2 mt-3" data-testid="source-meta">
        <dt>수집</dt><dd><Instant iso={snap.fetched_at} /></dd>
        <dt>형식</dt><dd><span className="id">{snap.content_type}</span></dd>
        {snap.final_url && snap.final_url !== snap.url && <><dt>최종 URL</dt><dd><ExternalUrl url={snap.final_url} /></dd></>}
        <dt>원본 해시</dt><dd className="id" title={snap.raw_sha256}>{short(snap.raw_sha256)}</dd>
        <dt>본문 해시</dt><dd className="id" title={snap.text_sha256 ?? undefined}>{short(snap.text_sha256)}</dd>
        <dt>추출기</dt><dd className="id">{snap.extractor}</dd>
        <dt>본문</dt><dd>{snap.text_format} · {(snap.text_chars ?? 0).toLocaleString('ko-KR')}자</dd>
      </dl>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <code className="id" data-testid="node-id">{snap.id}</code>
        <CopyLink />
        {/* The raw bytes are never rendered: download only (design 9). */}
        <a className="text-action" href={raw} download rel="noopener" data-testid="raw-download"><Download className="size-3.5" aria-hidden />원본 내려받기</a>
      </div>
    </header>
  );
}

function QuotePanel({ snap, claim, evidence, verdict, pending, failed, wanted }: { snap: Snapshot; claim: ClaimDetail | undefined; evidence: Evidence | undefined; verdict: Verdict | undefined; pending: boolean; failed: boolean; wanted: boolean }) {
  const subject = useNodeBrief(claim?.subject);
  if (!wanted) return null;
  if (!claim) return <p className="notice" data-testid="quote-absent">이 기준에서는 이 주장을 볼 수 없다. 본문만 보인다.</p>;
  const label = verdict ? VERDICT_LABEL[verdict.kind] : pending ? '확인하는 중' : failed ? '확인하지 못했다' : '근거 없음';
  const showRecorded = verdict?.kind === 'not-found' || verdict?.kind === 'corrected';
  const kbVerification = verificationLabel(claim.verification);
  const unverified = isUnverified(claim);
  const unsupported = !!evidence && evidence.support_check === 'unsupported';
  const archived = !!evidence && evidence.evidence_state === 'archived_only';
  return (
    <section className="quote-panel" aria-label="인용" data-testid="quote-panel" data-verdict={verdict?.kind}>
      {/* The head scrolls away when the page opens at the quote, so the panel names the document it is quoting. */}
      <p className="quote-source" data-testid="quote-source"><span>원문</span> <bdi>{snap.source?.label ?? snap.id}</bdi> · 수집 <Instant iso={snap.fetched_at} /></p>
      <p className="eyebrow">
        <NodeLink id={claim.subject} testid="quote-subject" className="link"><bdi>{subject.data?.label ?? fallbackLabel(claim.subject)}</bdi></NodeLink>
        <NodeLink id={claim.id} className="link" testid="quote-claim">주장</NodeLink>
      </p>
      <p className="mt-1" dir="auto" data-testid="quote-statement">{claim.statement}</p>
      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm" role="status" data-testid="quote-status">
        <Chip tone={verdict?.kind === 'not-found' || verdict?.kind === 'unavailable' ? 'danger' : 'quiet'} data-testid="quote-verdict">{label}</Chip>
        {verdict && (verdict.kind === 'match' || verdict.kind === 'corrected') && <span className="text-soft">{verdict.start.toLocaleString('ko-KR')}~{verdict.end.toLocaleString('ko-KR')}자</span>}
        {verdict?.kind === 'match' && <span className="sr-only">본문에서 인용 위치를 강조했다</span>}
      </p>
      {/* The check above only located the quoted words. What the KB says about the claim is shown beside it, and a disagreement is shown, not settled (design 5). */}
      <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-faint" data-testid="quote-kb">
        <span>KB 판정</span>
        {kbVerification ? <span data-testid="quote-kb-verification">{kbVerification}</span> : <span>없음</span>}
        {unverified && <Chip tone="warn" data-testid="quote-unverified">미검증</Chip>}
        {unsupported && <Chip tone="warn" data-testid="quote-unsupported">원문이 뒷받침하지 않음</Chip>}
        {archived && <Chip data-testid="quote-archived">옛 스냅샷에만 있음</Chip>}
      </p>
      {(verdict?.kind === 'match' || verdict?.kind === 'corrected') && <p className="mt-1 text-xs text-faint">인용한 글자를 찾았다는 뜻이다. 주장이 맞다는 뜻은 아니다.</p>}
      {verdict?.kind === 'pointer' && <p className="mt-2 text-sm text-soft">경로 <code className="id break-all" data-testid="quote-pointer">{verdict.pointer}</code>는 JSON 본문을 파싱한 값 기준이다. v1은 이 경로를 확인하지 않는다.</p>}
      {showRecorded && evidence?.exact && (
        <blockquote className="recorded-quote" data-testid="recorded-quote">
          <span className="section-label block">{verdict?.kind === 'corrected' ? '기록된 인용. 기록된 위치와 달라 찾은 위치를 강조했다' : '기록된 인용. 본문에서 찾지 못해 강조하지 않았다'}</span>
          <span dir="auto">{evidence.exact}</span>
        </blockquote>
      )}
    </section>
  );
}

function BodyArea({ snap, quote, view, onView, setView }: {
  snap: Snapshot; quote: { start: number; end: number } | null; view: 'text' | 'rendered';
  onView: (v: { text: string; start: number; end: number }) => void; setView: (v: 'text' | 'rendered') => void;
}) {
  const isMarkdown = snap.text_format === 'markdown';
  const rendered = isMarkdown && view === 'rendered';
  const full = useFullText(snap.id, rendered);
  if (!snap.text_chars) return <Empty>표시 본문이 없다. 이미지 위주 문서일 수 있다. 원본을 내려받아 본다.</Empty>;
  return (
    <section aria-label="본문">
      {isMarkdown && (
        <Tabs value={view} onValueChange={(v) => setView(v as 'text' | 'rendered')} className="mb-3">
          <TabsList variant="line">
            <TabsTrigger value="text" data-testid="tab-text">본문</TabsTrigger>
            <TabsTrigger value="rendered" data-testid="tab-rendered">렌더</TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      {rendered
        ? (
          <>
            <p className="mb-3 text-xs text-faint">렌더는 원문과 글자가 달라 인용을 강조하지 않는다. 인용 위치는 본문 탭에서 본다.</p>
            {full.isPending && <Loading />}
            {full.isError && <ErrorCard error={full.error} onRetry={() => void full.refetch()} />}
            {full.data !== undefined && <Suspense fallback={<Loading />}><MarkdownView text={full.data} /></Suspense>}
          </>
        )
        : <TextBody snapshotId={snap.id} quote={quote} onView={onView} />}
    </section>
  );
}

function CitingList({ snap, claimId, claim, evidence, loaded }: { snap: Snapshot; claimId: string | undefined; claim: ClaimDetail | undefined; evidence: Evidence | undefined; loaded: { text: string; start: number; end: number } | null }) {
  const past = useIsPastView();
  const citing = snap.citing_claims ?? [];
  const [more, setMore] = useState(false);
  const shown = more ? citing : citing.slice(0, 40);
  if (citing.length === 0) return <section aria-label="이 문서의 인용" data-testid="citing"><h3 className="panel-title">이 문서의 인용</h3><Empty className="mt-1">없다.</Empty></section>;
  const excerpt = (s: number | null | undefined, e: number | null | undefined) => {
    if (s == null || e == null || !loaded || s < loaded.start || e > loaded.end) return null;
    return cpSlice(loaded.text, s - loaded.start, e - loaded.start);
  };
  const list = (
    <ul className="mt-1.5">
      {shown.map((c) => (
        <li key={`${c.id}-${c.start}`}>
          <Link to="/source/$id" params={{ id: snap.id }} search={citingSearch(c, claim, snap.id)} className="citing-row"
            data-current={(c.id === claimId && (!evidence || evidence.start == null || (evidence.start === c.start && evidence.end === c.end))) || undefined} data-testid="citing-row" data-id={c.id}>
            {excerpt(c.start, c.end) !== null
              ? <bdi className="line-clamp-2">{excerpt(c.start, c.end)}</bdi>
              // Outside the loaded text there is no quote to show, so the row says what it does and keeps the position as a detail.
              : <><span>인용 보기</span>{' '}<span className="text-faint">{c.start != null ? `${c.start.toLocaleString('ko-KR')}자 위치` : '위치 없음'}</span></>}
          </Link>
        </li>
      ))}
    </ul>
  );
  const moreBtn = !more && citing.length > shown.length && <button type="button" className="text-action mt-1" onClick={() => setMore(true)}>{citing.length - shown.length}개 더</button>;
  // A past view folds this list: it is the current state, not the state at that time (design 4).
  if (past) {
    return (
      <section aria-label="이 문서의 인용" data-testid="citing">
        <details data-testid="citing-past">
          <summary className="panel-title cursor-pointer">이 문서의 인용 <span className="tabular-nums">{citing.length}</span> <Chip tone="time" data-testid="citing-now">현재 기준</Chip></summary>
          {list}{moreBtn}
        </details>
      </section>
    );
  }
  return (
    <section aria-label="이 문서의 인용" data-testid="citing">
      <h3 className="panel-title">이 문서의 인용 <span className="tabular-nums">{citing.length}</span></h3>
      {list}{moreBtn}
    </section>
  );
}

export function SourceScreen() {
  const { id } = route.useParams();
  // One document, one instance: what was loaded of it must not carry over to the next.
  return <SourceView key={id} id={id} />;
}

function SourceView({ id }: { id: string }) {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const snapQ = useSnapshot(id);
  const claimQ = useClaim(search.claim);
  const claim = claimQ.data?.data;
  const evidence = pickEvidence(claim, id, search.ev, search.pos);
  const verdictQ = useVerdict(evidence, !!evidence);
  const verdict = verdictQ.data;
  const quote = useMemo(() => quoteOf(verdict), [verdict]);
  const [loaded, setLoaded] = useState<{ text: string; start: number; end: number } | null>(null);
  const onView = useCallback((v: { text: string; start: number; end: number }) => setLoaded(v), []);
  const setView = useCallback((v: 'text' | 'rendered') => { void navigate({ search: (p) => ({ ...p, view: v === 'rendered' ? 'rendered' : undefined }), replace: true, resetScroll: false }); }, [navigate]);
  const snap = snapQ.data?.data;
  useScreenTitle(snap ? (snap.source?.label ?? id) : id);

  if (snapQ.isPending) return <main className="page"><Loading /></main>;
  // A failed refetch keeps the document on screen (design 7.4). Only a read with nothing to show is an error page.
  if (snapQ.isError && !snap) {
    if (snapQ.error instanceof KbProblem && describeError(snapQ.error).hidden) {
      return (
        <main className="page-narrow" data-testid="not-visible-page">
          <h1 className="page-title">없거나 볼 수 없음</h1>
          <p className="mt-2 text-soft">이 문서는 없거나 지금 범위에서 볼 수 없다.</p>
          <p className="id mt-3 break-all" data-testid="node-id">{id}</p>
        </main>
      );
    }
    return <ErrorPage error={snapQ.error} onRetry={() => void snapQ.refetch()} />;
  }
  // The first paint opens at the quote, so it waits for the claim and the check. After that the body stays and only the highlight moves.
  const waitingForQuote = !loaded && !!search.claim && (claimQ.isPending || (!!evidence && verdictQ.isPending));
  return (
    <main className="page source-page" data-testid="source-page" data-id={id}>
      <div className="source-head min-w-0">
        <SourceHead snap={snap!} />
        <TimeMark className="mt-2" />
      </div>
      <aside className="source-side" aria-label="인용과 주장">
        {snapQ.isError && <div data-testid="stale-error"><ErrorCard error={snapQ.error} compact onRetry={() => void snapQ.refetch()} /></div>}
        {/* A 404 means this claim is out of view at this time. Anything else is a failed read and must not pass for that. */}
        {claimQ.error && !claim && !(claimQ.error instanceof KbProblem && claimQ.error.status === 404) && <ErrorCard error={claimQ.error} compact onRetry={() => void claimQ.refetch()} />}
        {claimQ.error && claim && <div data-testid="stale-error"><ErrorCard error={claimQ.error} compact onRetry={() => void claimQ.refetch()} /></div>}
        {!(claimQ.error && !claim && !(claimQ.error instanceof KbProblem && claimQ.error.status === 404)) &&
          <QuotePanel snap={snap!} claim={claim} evidence={evidence} verdict={verdict} pending={claimQ.isPending || verdictQ.isPending} failed={verdictQ.isError} wanted={!!search.claim} />}
        <CitingList snap={snap!} claimId={search.claim} claim={claim} evidence={evidence} loaded={loaded} />
      </aside>
      <div className="source-body min-w-0">
        {waitingForQuote ? <Loading label="인용을 찾는 중" />
          : <BodyArea snap={snap!} quote={quote} view={search.view ?? 'text'} onView={onView} setView={setView} />}
      </div>
    </main>
  );
}
