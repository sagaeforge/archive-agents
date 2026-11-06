// The settings window's read-only status (design v2 2.8): GET /auth/status/detail with the session. Words and numbers only.
import { activityHeader } from '../auth/activity.ts';
import { authStore, getSession } from '../auth/session.ts';
import { useCallback, useEffect, useRef, useState } from 'react';

export type SettingsStatus = {
  account: { allowed: number; via: 'google' | 'breakglass' };
  session: { idle_ms: number; max_ms: number; idle_left_ms: number; max_left_ms: number };
  kb: {
    connected: boolean; data_as_of: string | null;
    write: {
      fp_gate: boolean; editor_routes: number; private_open: boolean;
      hitl: { available: boolean; trust_store: string; registered: boolean }; secret_rules: { version: string | null };
    } | null;
  };
  tokens: { editor: { days_left: number | null }; reviewer: { days_left: number | null } };
  breakglass: { open: boolean; last_opened: string | null; last_used: string | null };
  secret_window: { socket_fd: boolean; port: number; lock_idle_ms: number; clipboard_clear_ms: number };
  socket_activated: boolean;
};

export type StatusResult = { ok: true; status: SettingsStatus; at: number } | { ok: false };

/** `fromInput`: the read follows a person's input (opening the window), so it may restart the idle clock. A refresh must not. */
export async function fetchStatus(fromInput: boolean): Promise<StatusResult> {
  const token = getSession();
  if (!token) return { ok: false };
  try {
    const res = await fetch('/auth/status/detail', {
      headers: { authorization: `Bearer ${token}`, ...(fromInput ? activityHeader() : {}) },
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    if (res.status === 401) { authStore.expire(); return { ok: false }; }
    if (!res.ok) return { ok: false };
    return { ok: true, status: await res.json() as SettingsStatus, at: Date.now() };
  } catch { return { ok: false }; }
}

/** The status, read once now and, with `pollMs`, again while mounted. Polls carry no activity mark. */
export function useSettingsStatus(pollMs?: number) {
  const [result, setResult] = useState<StatusResult | null>(null);
  const alive = useRef(true);
  const load = useCallback(async (fromInput: boolean) => { const r = await fetchStatus(fromInput); if (alive.current) setResult(r); }, []);
  useEffect(() => {
    alive.current = true;
    void load(true);
    const t = pollMs ? setInterval(() => { void load(false); }, pollMs) : undefined;
    return () => { alive.current = false; if (t) clearInterval(t); };
  }, [load, pollMs]);
  return result;
}

export const minutes = (ms: number) => Math.max(0, Math.floor(ms / 60_000));
/** "유휴 59분 남음" and "최대 11시간 59분 남음". */
export function idleText(ms: number) { const m = minutes(ms); return m < 1 ? '유휴 1분 미만 남음' : `유휴 ${m}분 남음`; }
export function maxText(ms: number) {
  const m = minutes(ms), h = Math.floor(m / 60);
  return h > 0 ? `최대 ${h}시간 ${m % 60}분 남음` : `최대 ${m}분 남음`;
}
