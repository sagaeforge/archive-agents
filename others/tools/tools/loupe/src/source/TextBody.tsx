// The display body in one text node. Offsets are exact only here, so this is where a quote is shown (design 5).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ErrorCard, Loading } from '../components/bits.tsx';
import { useTextWindows } from '../data/hooks.ts';
import { clearPaint, domRange, paint, rangeIsLoaded, type QuoteRange } from './highlight.ts';

const LEAD = 1_500; // characters kept above a quote when opening at it
const TRAIL = 3_000;
const anchorFor = (quote: QuoteRange | null) => {
  if (!quote) return { from: 0, min: 0 };
  const from = Math.max(0, quote.start - LEAD);
  return { from, min: quote.end - from + TRAIL };
};

export function TextBody({ snapshotId, quote, onView }: {
  snapshotId: string;
  quote: QuoteRange | null;
  onView?: (v: { text: string; start: number; end: number }) => void;
}) {
  const [anchor, setAnchor] = useState(() => anchorFor(quote));
  const q = useTextWindows(snapshotId, anchor.from, anchor.min, true);
  const view = q.view;
  // Moving between quotes keeps what is loaded; a quote outside it opens a window there.
  useEffect(() => { if (quote && view && !rangeIsLoaded(view, quote)) setAnchor(anchorFor(quote)); }, [quote, view]);
  const pre = useRef<HTMLPreElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [marker, setMarker] = useState<number | null>(null);
  const markerEl = useRef<HTMLSpanElement>(null);
  const focusedFor = useRef<string | null>(null);
  const scrolledFor = useRef<string | null>(null);

  useEffect(() => { if (view) onView?.(view); }, [view, onView]);

  useLayoutEffect(() => {
    const node = pre.current?.firstChild;
    if (!quote || !view || !(node instanceof Text) || !rangeIsLoaded(view, quote)) { clearPaint(); setMarker(null); return; }
    const r = domRange(node, view, quote);
    paint(r);
    const place = () => { const box = r.getClientRects()[0]; const base = wrap.current?.getBoundingClientRect(); if (box && base) setMarker(box.top - base.top); };
    place();
    const key = `${snapshotId}:${quote.start}:${quote.end}`;
    if (scrolledFor.current !== key) {
      scrolledFor.current = key;
      const box = r.getClientRects()[0];
      if (box) window.scrollTo({ top: Math.max(0, box.top + window.scrollY - window.innerHeight * 0.32) });
    }
    const ro = new ResizeObserver(place);
    if (wrap.current) ro.observe(wrap.current);
    return () => { ro.disconnect(); clearPaint(); };
  }, [quote, view, snapshotId]);

  // Opening at a quote puts keyboard focus on it, so the first Tab continues from the quote and not from the top of the page.
  const quoteKey = quote ? `${snapshotId}:${quote.start}:${quote.end}` : null;
  useEffect(() => {
    if (marker === null || quoteKey === null || focusedFor.current === quoteKey) return;
    focusedFor.current = quoteKey;
    markerEl.current?.focus({ preventScroll: true });
  }, [marker, quoteKey]);

  // Reading on: the next window arrives as the end comes into view.
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isError } = q;
  useEffect(() => {
    const el = sentinel.current;
    // After a failed window the reader asks again: observing here would ask again at once, for as long as the sentinel is in view.
    if (!el || !hasNextPage || isError) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage(); }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, isError, view?.end]);

  if (q.isPending) return <Loading />;
  // Text already read stays when a later window fails (design 7.4). Only a read that has produced nothing is an error screen.
  if (q.isError && !view) return <ErrorCard error={q.error} onRetry={() => void q.refetch()} />;
  if (!view) return null;
  return (
    <div data-testid="text-body">
      {q.isError && <div className="mb-3" data-testid="stale-error"><ErrorCard error={q.error} compact onRetry={() => void (q.hasNextPage ? q.fetchNextPage() : q.refetch())} /></div>}
      {q.hasPreviousPage && (
        <button type="button" className="text-action mb-3" onClick={() => void q.fetchPreviousPage()} disabled={q.isFetchingPreviousPage} data-testid="read-before">
          {q.isFetchingPreviousPage ? '읽는 중' : `앞부분 읽기 (${view.start.toLocaleString('ko-KR')}자)`}
        </button>
      )}
      <div ref={wrap} className="relative">
        <pre ref={pre} className="source-text" data-format={view.format} data-testid="source-text" dir="auto">{view.text}</pre>
        {marker !== null && <span ref={markerEl} className="quote-marker" style={{ top: marker }} data-testid="quote-marker" role="note" aria-label="인용 위치" tabIndex={0} />}
      </div>
      {q.hasNextPage && (
        <div ref={sentinel} className="mt-3" data-testid="read-after">
          <button type="button" className="text-action" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            {q.isFetchingNextPage ? '읽는 중' : `이어 읽기 (${(view.total - view.end).toLocaleString('ko-KR')}자 남음)`}
          </button>
        </div>
      )}
      {!q.hasNextPage && <p className="mt-3 text-xs text-faint" data-testid="text-end">문서 끝, {view.total.toLocaleString('ko-KR')}자</p>}
    </div>
  );
}
