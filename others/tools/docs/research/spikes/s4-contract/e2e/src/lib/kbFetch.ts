// Thin mutator: unwraps the body on 2xx, throws the RFC 9457 problem otherwise.
export class KbProblem extends Error {
  constructor(readonly problem: { type: string; title: string; status: number; [k: string]: unknown }) { super(problem.title); }
}
export const kbBase = { url: (globalThis as { KB_URL?: string }).KB_URL ?? 'http://127.0.0.1:18401' };
export const kbFetch = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(new URL(url, kbBase.url), init);
  if (res.ok) return res.json() as Promise<T>;
  const isProblem = res.headers.get('content-type')?.includes('problem+json');
  throw new KbProblem(isProblem ? await res.json() : { type: 'about:blank', title: res.statusText, status: res.status });
};
export type ErrorType<E> = KbProblem & { problem: E };
export default kbFetch;
