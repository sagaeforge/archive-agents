// The frame around every screen: header, time band, connection band, palette. Screens render into <Outlet/>.
// There is no left rail yet: most rail destinations (table, search, changes, schema) are later phases, and dead links are worse than none.
import { useSyncExternalStore } from 'react';
import { Link, Outlet, useLocation } from '@tanstack/react-router';
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
import { WorkspaceShell } from '../shell/WorkspaceShell.tsx';
import { authStore } from '../auth/session.ts';
import { lock, useLockKey } from '../settings/lock.ts';

export function AppShell() {
  useKbLifecycle();
  useLockKey();
  const path = useLocation({ select: l => l.pathname });
  const workspace = path === '/' || path.startsWith('/w/');
  const past = useIsPastView();
  const env = useSyncExternalStore(envelopeStore.subscribe, envelopeStore.get);
  const version = env.meta?.schema_version;
  const verdict = version ? compareSchemaVersion(version, CONTRACT_STAMP.schemaVersion) : null;
  const blocked = verdict === 'major-differs' || verdict === 'unparsable';
  const auth = useSyncExternalStore(authStore.subscribe, authStore.get);

  // The workspace has no header (design 2.2): its lock is in the avatar menu (2.8). The v1 screens below keep their header button.
  if (workspace && !blocked) {
    return (
      <TooltipProvider delay={120}>
        <WorkspaceShell />
        {past && <div aria-hidden data-testid="time-frame" className="time-frame" />}
      </TooltipProvider>
    );
  }

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
