import { useContext, type ComponentProps } from 'react';
import { WindowTitleScope } from '../app/useScreenTitle.ts';

/** The page root of a read screen. On its own route it is the `<main>` landmark; inside a window the workspace is already the `<main>`
 *  and a window is a region (design 2.7), so a second landmark per open window would be wrong for a screen reader. */
export function PageRoot(props: ComponentProps<'div'>) {
  return useContext(WindowTitleScope) ? <div {...props} /> : <main {...(props as ComponentProps<'main'>)} />;
}
