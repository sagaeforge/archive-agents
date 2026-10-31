import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useScreenTitle } from '../app/useScreenTitle.ts';
import { Empty, ErrorCard, Instant, Loading, TimeMark } from '../components/bits.tsx';
import { useLabels, useRecentlyRecorded } from '../data/hooks.ts';
import { readRecent } from '../palette/recent.ts';
import { setPaletteOpen } from '../palette/store.ts';

export function HomeScreen() {
  useScreenTitle(null);
  const recentIds = useMemo(readRecent, []);
  const recent = useLabels(recentIds, true);
  const q = useRecentlyRecorded(24);
  const items = q.data?.data.items ?? [];
  return (
    <main className="page-narrow" data-testid="home">
      <h1 className="sr-only">loupe</h1>
      <button type="button" className="home-search" onClick={() => setPaletteOpen(true)} data-testid="home-search">
        <Search className="size-4" aria-hidden /><span>엔티티와 기록을 찾는다</span><kbd className="ml-auto">Ctrl K</kbd>
      </button>
      <TimeMark className="mt-3" />

      {recent.length > 0 && (
        <section className="mt-9" data-testid="home-recent">
          <h2 className="section-label">최근 본 항목</h2>
          <ul className="mt-2">
            {recent.map((r) => (
              <li key={r.id}>
                <Link to="/node/$id" params={{ id: r.id }} className="row-link">
                  <bdi className={r.label ? 'truncate' : 'id truncate'}>{r.label ?? r.id}</bdi>
                  <span className="ml-auto shrink-0 text-xs text-faint">{r.type}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-9" data-testid="home-latest">
        <h2 className="section-label">{q.sorted ? '최근 기록된 엔티티' : '엔티티'}</h2>
        {q.isPending && <Loading className="mt-2" />}
        {q.error && <div className="mt-2"><ErrorCard error={q.error} compact onRetry={() => void q.refetch()} /></div>}
        {!q.isPending && !q.error && items.length === 0 && <Empty className="mt-2">이 기준으로 보이는 엔티티가 없다.</Empty>}
        <ul className="mt-2">
          {items.map((n) => (
            <li key={n.id}>
              <Link to="/node/$id" params={{ id: n.id }} className="row-link" data-testid="home-entity">
                <bdi className="truncate">{n.label}</bdi>
                <span className="ml-auto shrink-0 text-xs text-faint">{n.type}</span>
                <span className="hidden w-40 shrink-0 text-right text-xs tabular-nums text-faint sm:inline"><Instant iso={n.recorded_at} /></span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
