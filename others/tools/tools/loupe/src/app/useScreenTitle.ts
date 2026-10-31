import { useEffect } from 'react';
import { TITLE_PREFIX } from '../time/parse.ts';
import { useViewKind } from '../time/useTimeBasis.ts';

/** `[과거]` leads the tab title in a past view: that is what an Orca tab shows (design 4). A held present reads `[시점 고정]`. */
export function useScreenTitle(title: string | null | undefined) {
  const kind = useViewKind();
  useEffect(() => {
    document.title = `${TITLE_PREFIX[kind]}${title ? `${title} · ` : ''}loupe`;
  }, [title, kind]);
}
