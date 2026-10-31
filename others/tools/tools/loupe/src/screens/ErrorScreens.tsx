import type { ErrorComponentProps } from '@tanstack/react-router';
import { useScreenTitle } from '../app/useScreenTitle.ts';
import { ErrorCard } from '../components/bits.tsx';
import { IdParamError } from '../ids.ts';
import { TimeParamError } from '../time/parse.ts';
import { SearchParamError } from '../routes/search.ts';

/** A bad URL is the reader's input, not a fault of the app: it gets a screen and no stack trace in the console. */
// The router wraps what a parser throws, so the cause is the error.
const unwrap = (e: unknown) => (e instanceof Error && e.cause instanceof Error ? e.cause : e);
export const isUrlError = (e: unknown) => { const c = unwrap(e); return c instanceof TimeParamError || c instanceof SearchParamError || c instanceof IdParamError; };

/** A plain anchor on purpose: a router Link would carry a broken parameter along. */
const home = <a href="#/" className="link mt-4 inline-block" data-testid="go-home">처음으로</a>;

export function RouteError({ error: raw }: ErrorComponentProps) {
  const error = unwrap(raw);
  // A bad time value must end here and never fall back to "now" (design 4).
  const bad = isUrlError(error);
  const isId = error instanceof IdParamError;
  return (
    <main className="page-narrow" role="alert" data-testid="route-error">
      <h1 className="page-title">{isId ? '이 주소의 ID를 읽을 수 없다' : bad ? '이 주소의 값을 읽을 수 없다' : '화면을 그리지 못했다'}</h1>
      <p className="mt-2 text-soft">{isId ? 'ID에 쓸 수 없는 문자가 들어 있다. 이 값으로는 KB에 묻지 않았다.' : bad ? '현재 데이터로 대신 보여 주지 않는다. 링크를 고치거나 처음으로 돌아간다.' : '다시 열어도 같으면 주소를 확인한다.'}</p>
      <p className="id mt-3 break-all">{error instanceof Error ? error.message : String(error)}</p>
      {home}
    </main>
  );
}

export function NotFoundScreen() {
  useScreenTitle('없는 경로');
  return (
    <main className="page-narrow" data-testid="not-found-route">
      <h1 className="page-title">없는 경로</h1>
      <p className="mt-2 text-soft">이 주소에 해당하는 화면이 없다.</p>
      {home}
    </main>
  );
}

export function ErrorPage({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return <main className="page-narrow"><ErrorCard error={error} {...(onRetry ? { onRetry } : {})} /></main>;
}
