import { createContext, useContext, useEffect } from 'react';
import { TITLE_PREFIX } from '../time/parse.ts';
import { useViewKind } from '../time/useTimeBasis.ts';

export const WindowTitleScope = createContext(false);

/** `[과거]` leads the tab title in a past view: that is what an Orca tab shows (design 4). A held present reads `[시점 고정]`. */
export function useScreenTitle(title: string | null | undefined, enabled = true) {
  const kind = useViewKind();
  const windowed = useContext(WindowTitleScope);
  useEffect(() => {
    if (!enabled || windowed) return;
    document.title = `${TITLE_PREFIX[kind]}${title ? `${title} · ` : ''}loupe`;
  }, [title, kind, enabled, windowed]);
}
