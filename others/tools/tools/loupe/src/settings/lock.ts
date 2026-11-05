// Lock (design v2 6.1 step 6): the server forgets the session; the Google session in the browser is the person's and stays.
// The avatar menu, the lock card of the settings window, the v1 header button and Ctrl+Alt+L all end up here.
import { useEffect } from 'react';
import { lockSession } from '../auth/api.ts';
import { authStore, setSession } from '../auth/session.ts';

export async function lock() {
  if (authStore.get().kind !== 'signed-in') return;
  await lockSession();
  setSession(null);
  authStore.set({ kind: 'expired', why: 'locked' });
}

export function useLockKey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && !e.metaKey && e.code === 'KeyL') { e.preventDefault(); void lock(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
