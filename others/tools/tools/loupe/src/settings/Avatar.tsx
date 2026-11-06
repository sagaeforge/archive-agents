// The avatar at the top right (design v2 2.2, 2.8): one dot for the KB connection and a menu with the account, the session clock, the
// KB state, settings and lock. It replaces the lock button M0c kept on the workspace.
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Lock, Settings, User } from 'lucide-react';
import { authStore } from '../auth/session.ts';
import { connection } from '../data/connection.ts';
import { envelopeStore } from '../data/envelopeStore.ts';
import { lock } from './lock.ts';
import { idleText, maxText, useSettingsStatus } from './statusApi.ts';
import './settings.css';

/** Green when the KB answers, red when the app counts it cut off (design 7.4), grey before the first answer. */
export function useKbDot(): 'ok' | 'down' | 'wait' {
  const env = useSyncExternalStore(envelopeStore.subscribe, envelopeStore.get);
  const conn = useSyncExternalStore(connection.subscribe, connection.get);
  return conn.down ? 'down' : env.meta ? 'ok' : 'wait';
}

export function Avatar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [open, setOpen] = useState(false);
  const dot = useKbDot();
  const auth = useSyncExternalStore(authStore.subscribe, authStore.get);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = (refocus: boolean) => { setOpen(false); if (refocus) button.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  const word = dot === 'ok' ? '연결됨' : dot === 'down' ? '끊김' : '연결 중';
  return (
    <div className="avatar-root" ref={root}>
      <button ref={button} type="button" className="avatar" data-testid="avatar" aria-label={`계정 메뉴, KB ${word}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <User className="size-4" aria-hidden />
        <span className="dot avatar-dot" data-state={dot} data-testid="avatar-dot" aria-hidden />
      </button>
      {open && <AvatarMenu signedIn={auth.kind !== 'none'} dot={dot} close={close} onSettings={() => { close(false); onOpenSettings(); }} />}
    </div>
  );
}

function AvatarMenu({ signedIn, dot, close, onSettings }: { signedIn: boolean; dot: 'ok' | 'down' | 'wait'; close: (refocus: boolean) => void; onSettings: () => void }) {
  // Opening the menu is input, so this one read may restart the idle clock; nothing here polls.
  const result = useSettingsStatus();
  const status = result?.ok ? result.status : null;
  const at = result?.ok ? result.at : 0;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus(); }, []);
  const left = (ms: number) => ms - (Date.now() - at);
  const kbDown = dot === 'down' || status?.kb.connected === false;
  const onKey = (e: KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
    else if (e.key === 'Tab') close(false);
  };
  return (
    <div ref={ref} role="menu" aria-label="계정 메뉴" className="avatar-menu" onKeyDown={onKey}>
      {signedIn && (
        <>
          <p role="presentation" className="avatar-row" data-testid="menu-account">
            {!result ? '계정 읽는 중' : status ? (status.account.via === 'google' ? '허용 계정 · Google' : '허용 계정 · 비상 경로') : '계정을 읽지 못했다'}
          </p>
          <p role="presentation" className="avatar-row" data-testid="menu-session">
            {status ? `${idleText(left(status.session.idle_left_ms))} · ${maxText(left(status.session.max_left_ms))}` : '세션 읽는 중'}
          </p>
        </>
      )}
      <p role="presentation" className="avatar-row" data-testid="menu-kb"><span className="dot" data-state={kbDown ? 'down' : dot} aria-hidden /> KB {kbDown ? '끊김' : dot === 'ok' ? '연결됨' : '연결 중'}</p>
      <button type="button" role="menuitem" className="avatar-item" data-testid="menu-settings" onClick={onSettings}>
        <Settings className="size-3.5" aria-hidden /><span>설정</span><kbd>Ctrl+,</kbd>
      </button>
      {signedIn && (
        <button type="button" role="menuitem" className="avatar-item" data-testid="menu-lock" onClick={() => { close(false); void lock(); }}>
          <Lock className="size-3.5" aria-hidden /><span>잠그기</span><kbd>Ctrl+Alt+L</kbd>
        </button>
      )}
    </div>
  );
}
