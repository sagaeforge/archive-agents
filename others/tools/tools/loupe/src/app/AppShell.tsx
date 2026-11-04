// The frame around every screen: header, time band, connection band, palette. Screens render into <Outlet/>.
// There is no left rail yet: most rail destinations (table, search, changes, schema) are later phases, and dead links are worse than none.
import { useEffect, useSyncExternalStore } from 'react';
import { Link, Outlet } from '@tanstack/react-router';
import { Lock, Search } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { compareSchemaVersion, isSampleVersion } from '../data/contractVersion.ts';
import { envelopeStore } from '../data/envelopeStore.ts';
import { useKbLifecycle } from '../data/lifecycle.ts';
import { CONTRACT_STAMP } from '../client/stamp.ts';
import { useIsPastView } from '../time/useTimeBasis.ts';
import { Palette } from '../palette/Palette.tsx';
import { setPaletteOpen, togglePalette } from '../palette/store.ts';
import { ContractBlock, HeaderStatus, Notices, OfflineBand } from './Status.tsx';
import { TimeBand, TimeChip } from './TimeControls.tsx';
import { lockSession } from '../auth/api.ts';
import { authStore, setSession } from '../auth/session.ts';

/** Lock (design v2 6.1 step 6): the server forgets the session; the Google session in the browser is the person's and stays. */
async function lock() {
  if (authStore.get().kind !== 'signed-in') return;
  await lockSession();
  setSession(null);
  authStore.set({ kind: 'expired', why: 'locked' });
}

const isEditable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

function usePaletteKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); togglePalette(); return; }
      if (e.ctrlKey && e.altKey && !e.metaKey && e.code === 'KeyL') { e.preventDefault(); void lock(); return; }
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditable(e.target)) { e.preventDefault(); setPaletteOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function AppShell() {
  useKbLifecycle();
  usePaletteKeys();
  const past = useIsPastView();
  const env = useSyncExternalStore(envelopeStore.subscribe, envelopeStore.get);
  const version = env.meta?.schema_version;
  const verdict = version ? compareSchemaVersion(version, CONTRACT_STAMP.schemaVersion) : null;
  const blocked = verdict === 'major-differs' || verdict === 'unparsable';
  const auth = useSyncExternalStore(authStore.subscribe, authStore.get);

  return (
    <TooltipProvider delay={120}>
      <div className="flex min-h-dvh flex-col" data-past={past || undefined}>
        <header className="sticky top-0 z-30 bg-paper">
          <div className="flex h-12 items-center gap-3 border-b border-line px-4">
            <Link to="/" className="brand" data-testid="brand">loupe</Link>
            {version && isSampleVersion(version) && <span data-testid="sample-badge" className="sample-badge">표본 데이터</span>}
            <button type="button" className="palette-trigger" onClick={() => setPaletteOpen(true)} data-testid="palette-button">
              <Search className="size-3.5" aria-hidden />
              <span>찾기, 이동, 시간</span>
              <kbd className="ml-auto">Ctrl K</kbd>
            </button>
            <Link to="/graph" className="link text-sm" data-testid="graph-link">그래프</Link>
            <div className="ml-auto flex min-w-0 items-center gap-3">
              <HeaderStatus />
              <TimeChip />
              {auth.kind !== 'none' && (
                <button type="button" className="text-action" onClick={() => void lock()} title="잠그기 (Ctrl+Alt+L)" aria-label="잠그기" aria-keyshortcuts="Control+Alt+L" data-testid="lock-button">
                  <Lock className="size-3.5" aria-hidden />
                </button>
              )}
            </div>
          </div>
          {past && <TimeBand />}
          <OfflineBand />
          <Notices />
        </header>
        {blocked ? <ContractBlock received={version ?? ''} /> : <Outlet />}
        {past && <div aria-hidden data-testid="time-frame" className="time-frame" />}
        <Palette />
      </div>
    </TooltipProvider>
  );
}
