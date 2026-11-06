import { QueryCache, QueryClient } from '@tanstack/react-query';
import { KbProblem, KbUnavailable } from './kbFetch.ts';
import { noticeStore } from './notices.ts';

// Design 7.3 table. KbProblem never retries, except 503 not_ready (waits Retry-After) and 429.
export const retryPolicy = (failureCount: number, error: unknown): boolean => {
  // A permission error on the socket is a configuration error: trying again cannot help (design 7.4).
  if (error instanceof KbUnavailable) return error.code !== 'kb_socket_denied' && failureCount < 1;
  if (error instanceof KbProblem) {
    if (error.status === 503 && error.code === 'not_ready') return failureCount < 1;
    if (error.status === 429) return failureCount < 3;
  }
  return false;
};
export const retryDelay = (attempt: number, error: unknown): number => {
  if (error instanceof KbProblem && error.retryAfterSec) return Math.min(error.retryAfterSec, 30) * 1000;
  return Math.min(1000 * 2 ** attempt, 15_000);
};

export const CURSOR_RESTART_NOTICE = '이어 읽던 목록이 바뀌어 처음부터 다시 읽었다.';

export const makeQueryClient = (): QueryClient => {
  const client: QueryClient = new QueryClient({
  // 410 epoch_changed is the same news as a new epoch in the envelope: every cached page and cursor is void (design 7.3).
  queryCache: new QueryCache({
    onError: (e, query) => {
      if (e instanceof KbProblem && e.code === 'epoch_changed') void client.resetQueries();
      // 400 cursor_mismatch: the cursor no longer fits the conditions. Read again from page 1 and say so (design 7.3).
      if (e instanceof KbProblem && e.code === 'cursor_mismatch') { void client.resetQueries({ queryKey: query.queryKey, exact: true }); noticeStore.push(CURSOR_RESTART_NOTICE); }
    },
  }),
  defaultOptions: {
    queries: {
      // 127.0.0.1 is reachable even when navigator.onLine is false.
      networkMode: 'always',
      retry: retryPolicy,
      retryDelay,
      refetchOnWindowFocus: false,
    },
  },
  });
  return client;
};
