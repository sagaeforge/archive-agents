// The loupe session in the browser (design v2 6.1 step 5): one value in this tab's sessionStorage, sent as `Authorization: Bearer`.
// No cookie. The login in flight keeps its `login_id` and `login_secret` in the same storage until /auth/google/finish answers.
const SESSION = 'loupe.session';
const LOGIN = 'loupe.login';
const RETURN = 'loupe.return';

const store = () => { try { return globalThis.sessionStorage ?? null; } catch { return null; } };
const get = (k: string) => { try { return store()?.getItem(k) ?? null; } catch { return null; } };
const set = (k: string, v: string | null) => { try { const s = store(); if (!s) return; if (v === null) s.removeItem(k); else s.setItem(k, v); } catch { /* storage refused: the session lives as long as the page */ } };

let memory: string | null = null;
export const getSession = () => get(SESSION) ?? memory;
export const setSession = (token: string | null) => { memory = token; set(SESSION, token); };

export type PendingLogin = { login_id: string; login_secret: string };
export const getPendingLogin = (): PendingLogin | null => { try { const v = JSON.parse(get(LOGIN) ?? 'null') as PendingLogin | null; return v && typeof v.login_id === 'string' && typeof v.login_secret === 'string' ? v : null; } catch { return null; } };
export const setPendingLogin = (p: PendingLogin | null) => set(LOGIN, p ? JSON.stringify(p) : null);
/** Where to go after the login: the hash route the tab was on. */
export const takeReturn = () => { const v = get(RETURN); set(RETURN, null); return v && v.startsWith('#/') && !v.startsWith('#/auth/') ? v : '#/'; };
export const setReturn = (hash: string) => set(RETURN, hash);

export type AuthState =
  /** Asking /auth/status. */
  | { kind: 'checking' }
  /** The files of 6.2 are missing: only the setup screen. */
  | { kind: 'setup'; client: boolean; account: boolean; problems: string[] }
  /** No session in this tab: the login screen, nothing of the app. */
  | { kind: 'signed-out'; error?: string | undefined }
  | { kind: 'signed-in' }
  /** The session ended while the app was open (idle limit, lock, restart). The app stays mounted underneath, unsaved memory intact. */
  | { kind: 'expired'; why: 'expired' | 'locked'; error?: string | undefined }
  /** Development without loupe serve (Vite proxies /kb to kb-mock): there is no login to do. */
  | { kind: 'none' };

let state: AuthState = { kind: 'checking' };
let breakglassOpen = false;
let socketActivated = true;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const authStore = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
  set: (s: AuthState) => { state = s; emit(); },
  breakglass: () => breakglassOpen,
  socketActivated: () => socketActivated,
  setStatus: (s: { breakglass_open: boolean; socket_activated: boolean }) => { breakglassOpen = s.breakglass_open; socketActivated = s.socket_activated; emit(); },
  /** loupe serve answered 401 session_required to a request that carried a session. */
  expire: () => {
    setSession(null);
    if (state.kind === 'signed-in') { state = { kind: 'expired', why: 'expired' }; emit(); }
  },
};
