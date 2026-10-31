// Small shared pieces. Text from the KB is untrusted: it only ever reaches React as a text child.
import type { ComponentProps, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { describeError } from '../lib/errors.ts';
import { Button } from '@/components/ui/button';
import { formatKst } from '../time/format.ts';
import { useTimeBasis } from '../time/useTimeBasis.ts';
import { formatValidAxis } from '../time/format.ts';

export type Tone = 'quiet' | 'info' | 'warn' | 'danger' | 'time';
export function Chip({ tone = 'quiet', className, ...p }: ComponentProps<'span'> & { tone?: Tone }) {
  return <span data-tone={tone} className={cn('chip', className)} {...p} />;
}

export function Instant({ iso, seconds }: { iso: string; seconds?: boolean }) {
  return <time dateTime={iso} title={iso}>{formatKst(iso, seconds ? { seconds } : {})}</time>;
}

/** Waits a moment before saying anything, so a fast answer does not flash a loading line. */
export function Loading({ label = '읽는 중', className }: { label?: string; className?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setShow(true), 160); return () => clearTimeout(t); }, []);
  return <p role="status" data-testid="loading" className={cn('text-sm text-faint', !show && 'invisible', className)}>{label}</p>;
}

export function ErrorCard({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const info = describeError(error);
  return (
    <div role="alert" data-testid={info.hidden ? 'not-visible' : 'error-card'} data-code={info.code ?? undefined} className={cn('error-card', compact && 'text-sm')}>
      <p className="font-medium">{info.title}</p>
      <p className="mt-0.5 text-soft">{info.detail}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {info.code && <code className="id">{info.code}</code>}
        {info.retry && onRetry && <Button variant="outline" size="xs" onClick={onRetry}>다시 시도</Button>}
      </div>
    </div>
  );
}

export const Empty = ({ children, className }: { children: ReactNode; className?: string }) => <p data-testid="empty" className={cn('text-sm text-faint', className)}>{children}</p>;

/** http and https open in a new tab with no referrer and no preview. Everything else stays text (design 9). */
export function safeHttpUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  try { const u = new URL(raw); return u.protocol === 'http:' || u.protocol === 'https:' ? u : null; } catch { return null; }
}
export function ExternalUrl({ url }: { url: string | null | undefined }) {
  if (!url) return <span className="text-faint">없음</span>;
  const u = safeHttpUrl(url);
  if (!u) return <span className="id break-all" data-testid="plain-url">{url}</span>;
  return (
    <a className="link break-all" href={u.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
      <span className="font-medium">{u.host}</span>{u.pathname === '/' ? '' : u.pathname}{u.search}
    </a>
  );
}

/** A time marker that stays in the DOM, so a screenshot of a past view can never pass for the present (design 4). */
export function TimeMark({ className }: { className?: string }) {
  const t = useTimeBasis();
  if (!t.valid && !t.observed) return null;
  return (
    <span data-testid="time-mark" className={cn('time-mark', className)}>
      {t.valid ? `유효 ${formatValidAxis(t.valid)}` : null}{t.valid && t.observed ? ' · ' : null}{t.observed ? `관측 ${formatKst(t.observed)}` : null}
    </span>
  );
}
