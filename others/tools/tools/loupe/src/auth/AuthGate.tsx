// The door in front of the app (design v2 6.1): setup screen, login screen with one Google button, the /#/auth/finish step, and the
// cover shown when a session ends. The cover keeps the app mounted underneath, so what the tab holds in memory survives; signing in
// again from the cover happens in a new window, and that window hands the tab the news over a same-origin BroadcastChannel.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { authStatus, breakglassLogin, checkSession, failureText, finishLogin, startLogin, type Failure } from './api.ts';
import { activityPending, trackActivity } from './activity.ts';
import { authStore, getPendingLogin, getSession, setPendingLogin, setReturn, setSession, takeReturn, type PendingLogin } from './session.ts';

const CHANNEL = 'loupe-auth';
const isFinish = () => location.hash.startsWith('#/auth/finish');
/** The one-time proof the callback put in the fragment. Read once and removed from the address at once. */
function takeProof(): string | null {
  const q = location.hash.indexOf('?');
  const cb = q < 0 ? null : new URLSearchParams(location.hash.slice(q + 1)).get('cb');
  history.replaceState(null, '', '#/');
  return cb && /^[A-Za-z0-9_-]{43}$/.test(cb) ? cb : null;
}

async function boot() {
  const s = await authStatus();
  if (!s.ok) {
    // Vite in development proxies /kb straight to kb-mock and has no /auth. A built app never takes this branch.
    if (import.meta.env.DEV && (s.status === 404 || s.code === 'not_loupe')) { authStore.set({ kind: 'none' }); return; }
    authStore.set({ kind: 'signed-out', error: failureText(s) });
    return;
  }
  authStore.setStatus(s);
  if (!s.ready) { authStore.set({ kind: 'setup', client: s.setup.client, account: s.setup.account, problems: s.setup.problems }); return; }
  if (isFinish()) { await finishHere(); return; }
  if (getSession() && (await checkSession()).ok) { authStore.set({ kind: 'signed-in' }); return; }
  setSession(null);
  authStore.set({ kind: 'signed-out' });
}

/** /#/auth/finish in the tab that started the login. Without a login of its own, this is the window a cover opened. */
async function finishHere() {
  const proof = takeProof();
  const pending = getPendingLogin();
  if (!pending) {
    // The tab waiting under a cover holds the login_secret; this window holds the proof. Same origin only.
    try { const bc = new BroadcastChannel(CHANNEL); bc.postMessage({ type: 'callback-done', cb: proof }); bc.close(); } catch { /* no channel: nothing waits */ }
    authStore.set({ kind: 'signed-out', error: '다른 창에서 시작한 로그인이 끝났다. 그 창으로 돌아간다.' });
    window.close();
    return;
  }
  const r = await finishLogin({ ...pending, proof });
  setPendingLogin(null);
  if (r.ok) {
    setSession(r.session);
    history.replaceState(null, '', takeReturn());
    authStore.set({ kind: 'signed-in' });
  } else {
    history.replaceState(null, '', '#/');
    authStore.set({ kind: 'signed-out', error: failureText(r) });
  }
}

export function AuthGate({ children }: { children: ReactNode }) {
  const s = useSyncExternalStore(authStore.subscribe, authStore.get);
  useEffect(() => { void boot(); return trackActivity(); }, []);
  // Input without requests (reading, typing) still counts: once a minute it is reported, and only if there was some.
  useEffect(() => {
    if (s.kind !== 'signed-in') return;
    const t = setInterval(() => { if (activityPending()) void checkSession(); }, 60_000);
    return () => clearInterval(t);
  }, [s.kind]);
  switch (s.kind) {
    case 'checking': return <main className="page-narrow" data-testid="auth-checking" aria-busy="true" />;
    case 'setup': return <SetupScreen client={s.client} account={s.account} problems={s.problems} />;
    case 'signed-out': return <LoginScreen error={s.error} />;
    case 'none': return <>{children}</>;
    case 'signed-in': case 'expired': {
      const covered = s.kind === 'expired';
      return (
        <>
          <div inert={covered || undefined} aria-hidden={covered || undefined} className="contents" data-testid="app-root">{children}</div>
          {covered && <SessionCover why={s.why} />}
        </>
      );
    }
  }
}

function SetupScreen({ client, account, problems }: { client: boolean; account: boolean; problems: string[] }) {
  useEffect(() => { document.title = '설정 필요 · loupe'; }, []);
  return (
    <main className="page-narrow" data-testid="setup-needed">
      <h1 className="page-title">설정 필요</h1>
      <p className="mt-2 text-soft">loupe 로그인이 아직 설정되지 않았다. 터미널에서 아래를 마친 뒤 이 화면을 다시 연다.</p>
      <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm">
        <li data-done={client || undefined}><code>loupe google-setup</code> — Google OAuth 클라이언트 {client ? '(됨)' : ''}</li>
        <li data-done={account || undefined}><code>loupe google-enroll</code> — 허용 계정 {account ? '(됨)' : ''}</li>
      </ol>
      {problems.length > 0 && <p className="id mt-3 text-danger" data-testid="setup-problems">{problems.join(', ')}</p>}
    </main>
  );
}

function BreakglassForm({ onSession }: { onSession: (token: string) => void }) {
  const open = useSyncExternalStore(authStore.subscribe, authStore.breakglass);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  if (!open) return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const pw = ref.current?.value ?? '';
    if (!pw) return;
    setBusy(true);
    const r = await breakglassLogin(pw);
    setBusy(false);
    if (ref.current) ref.current.value = '';
    if (r.ok) onSession(r.session); else setError(failureText(r));
  };
  return (
    <form className="mt-6 border-t border-line pt-4" onSubmit={(e) => void submit(e)} data-testid="breakglass-form">
      <label className="text-sm font-medium" htmlFor="breakglass">비상 암호</label>
      <p className="text-xs text-soft">터미널에서 <code>loupe breakglass open</code>으로 1시간만 열린다. Google에 닿지 못할 때만 쓴다.</p>
      <div className="mt-2 flex gap-2">
        <input ref={ref} id="breakglass" type="password" autoComplete="off" className="h-8 min-w-0 flex-1 rounded-md border border-line bg-paper px-2 text-sm" data-testid="breakglass-input" />
        <Button type="submit" size="sm" variant="outline" disabled={busy} data-testid="breakglass-submit">열기</Button>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-danger" data-testid="breakglass-error">{error}</p>}
    </form>
  );
}

function LoginScreen({ error }: { error?: string | undefined }) {
  const [msg, setMsg] = useState(error ?? null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { document.title = '로그인 · loupe'; }, []);
  useEffect(() => { setMsg(error ?? null); }, [error]);
  const go = async () => {
    setBusy(true);
    const r = await startLogin();
    if (!r.ok) { setBusy(false); setMsg(failureText(r)); return; }
    setPendingLogin({ login_id: r.login_id, login_secret: r.login_secret });
    setReturn(location.hash && !isFinish() ? location.hash : '#/');
    location.assign(r.authorization_url);
  };
  return (
    <main className="page-narrow" data-testid="login-screen">
      <h1 className="page-title">loupe</h1>
      <p className="mt-2 text-soft">등록한 Google 계정으로 로그인한다. loupe는 암호를 묻지 않는다. 이 주소에서 Google 암호 칸이 보이면 가짜다.</p>
      <Button className="mt-5" onClick={() => void go()} disabled={busy} data-testid="google-login">Google로 로그인</Button>
      {msg && <p role="alert" className="mt-3 text-sm text-danger" data-testid="login-error">{msg}</p>}
      <BreakglassForm onSession={(t) => { setSession(t); history.replaceState(null, '', location.hash || '#/'); authStore.set({ kind: 'signed-in' }); }} />
    </main>
  );
}

function SessionCover({ why }: { why: 'expired' | 'locked' }) {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const pending = useRef<PendingLogin | null>(null);
  const resumed = useCallback((token: string) => {
    setSession(token);
    authStore.set({ kind: 'signed-in' });
    // Reads that failed while the session was gone are asked again; what the tab holds in memory is untouched.
    void qc.invalidateQueries();
  }, [qc]);

  useEffect(() => {
    let bc: BroadcastChannel | null = null;
    try { bc = new BroadcastChannel(CHANNEL); } catch { return; }
    bc.onmessage = async (e: MessageEvent<{ type?: string; cb?: string | null }>) => {
      const p = pending.current;
      if (e.data?.type !== 'callback-done' || !p) return;
      const r = await finishLogin({ ...p, proof: e.data.cb ?? null });
      if (r.ok) { pending.current = null; resumed(r.session); return; }
      // Another window's login, or a proof that is not ours: ours is still out.
      if ((r as Failure).code === 'login_pending' || (r as Failure).code === 'proof_mismatch') return;
      pending.current = null; setWaiting(false); setMsg(failureText(r));
    };
    return () => bc?.close();
  }, [resumed]);

  const again = async () => {
    setMsg(null);
    const r = await startLogin();
    if (!r.ok) { setMsg(failureText(r)); return; }
    pending.current = { login_id: r.login_id, login_secret: r.login_secret };
    setWaiting(true);
    // noopener: the provider's page gets no handle on this tab. The new window reports back over the channel.
    window.open(r.authorization_url, '_blank', 'popup,noopener,noreferrer,width=520,height=680');
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-paper/95 p-4" role="dialog" aria-modal="true" aria-labelledby="cover-title" data-testid="session-cover" data-why={why}>
      <div className="w-full max-w-md rounded-lg border border-line bg-paper p-5 shadow-sm">
        <h2 id="cover-title" className="text-lg font-semibold">{why === 'locked' ? '잠겼다' : '세션이 끝났다'}</h2>
        <p className="mt-2 text-sm text-soft">{why === 'locked' ? '다시 로그인하면 이 탭을 그대로 이어서 쓴다.' : '1시간 동안 쓰지 않았거나 loupe가 다시 시작했다. 다시 로그인하면 이 탭에 남은 것을 그대로 이어서 쓴다.'}</p>
        <Button className="mt-4" onClick={() => void again()} data-testid="relogin">Google로 다시 로그인</Button>
        {waiting && <p className="mt-2 text-xs text-soft" data-testid="relogin-waiting">새 창에서 로그인을 마친다. 창이 열리지 않으면 팝업을 허용한다.</p>}
        {msg && <p role="alert" className="mt-2 text-sm text-danger" data-testid="relogin-error">{msg}</p>}
        <BreakglassForm onSession={resumed} />
      </div>
    </div>
  );
}
