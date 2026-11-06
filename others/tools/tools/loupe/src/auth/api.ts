// Calls to loupe serve's /auth/*. POSTs carry application/json and X-Loupe-Auth: 1, so a page on another origin cannot send them
// without a preflight that loupe never answers (design v2 6.3).
import { getSession } from './session.ts';
import { activityHeader } from './activity.ts';

const url = (p: string) => new URL(p, document.baseURI).pathname;
const init = (body?: unknown, bearer = false): RequestInit => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: {
    ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-loupe-auth': '1' }),
    ...(bearer && getSession() ? { authorization: `Bearer ${getSession()}`, ...activityHeader() } : {}),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
});

export type Status = { ready: boolean; setup: { client: boolean; account: boolean; problems: string[] }; breakglass_open: boolean; socket_activated: boolean };
export type Failure = { ok: false; status: number; code: string; reason?: string | undefined; retryAfter?: number | undefined };
type Ok<T> = { ok: true } & T;

async function call<T>(path: string, i: RequestInit): Promise<Ok<T> | Failure> {
  let res: Response;
  try { res = await fetch(url(path), i); } catch { return { ok: false, status: 0, code: 'network' }; }
  if (res.status === 204) return { ok: true } as Ok<T>;
  let b: Record<string, unknown> | null = null;
  try { b = await res.json() as Record<string, unknown>; } catch { /* not JSON */ }
  // A 200 that is not JSON is not loupe serve (Vite's dev server answers unknown paths with index.html).
  if (res.ok) return b ? { ok: true, ...(b as T) } : { ok: false, status: res.status, code: 'not_loupe' };
  b ??= {};
  const ra = Number(res.headers.get('retry-after'));
  return { ok: false, status: res.status, code: typeof b.code === 'string' ? b.code : `http_${res.status}`, reason: typeof b.reason === 'string' ? b.reason : undefined, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : undefined };
}

export const authStatus = () => call<Status>('auth/status', init());
export const checkSession = () => call<{ ok: true }>('auth/session', init(undefined, true));
export const startLogin = () => call<{ authorization_url: string; login_id: string; login_secret: string }>('auth/google/start', init({}));
export const finishLogin = (p: { login_id: string; login_secret: string; proof: string | null }) => call<{ session: string }>('auth/google/finish', init(p));
export const breakglassLogin = (password: string) => call<{ session: string }>('auth/breakglass', init({ password }));
export const lockSession = () => call<object>('auth/lock', init({}, true));

/** Words for a failed login. The server's codes are fixed words; nothing from the provider is shown. */
export function failureText(f: Failure): string {
  if (f.code === 'login_failed') {
    switch (f.reason) {
      case 'account_not_allowed': return '허용된 Google 계정이 아니다. 등록한 계정으로 다시 로그인한다.';
      case 'provider_unreachable': return 'Google에 닿지 못했다. 인터넷 연결을 확인한다.';
      case 'provider_error': return 'Google이 로그인을 끝내지 않았다.';
      default: return 'Google 로그인 응답을 확인하지 못했다. 다시 로그인한다.';
    }
  }
  switch (f.code) {
    case 'network': return 'loupe 서버에 닿지 못했다.';
    case 'provider_unreachable': return 'Google에 닿지 못했다. 인터넷 연결을 확인한다.';
    case 'too_many_logins': return `로그인 시작이 너무 잦다. ${f.retryAfter ?? 60}초 뒤에 다시 한다.`;
    case 'login_unknown': return '이 로그인은 끝났거나 5분이 지났다. 다시 로그인한다.';
    case 'login_secret_mismatch': return '다른 탭이나 브라우저에서 시작한 로그인이다. 이 탭에서 다시 로그인한다.';
    case 'proof_mismatch': return '이 로그인은 다른 브라우저에서 끝났다. 이 탭에서 다시 로그인한다.';
    case 'password_wrong': return f.retryAfter ? `비상 암호가 틀렸다. ${f.retryAfter}초 뒤에 다시 한다.` : '비상 암호가 틀렸다.';
    case 'slow_down': return `${f.retryAfter ?? 30}초 뒤에 다시 한다.`;
    case 'not_found': return '비상 경로가 닫혔다.';
    default: return `로그인하지 못했다 (${f.code}).`;
  }
}
