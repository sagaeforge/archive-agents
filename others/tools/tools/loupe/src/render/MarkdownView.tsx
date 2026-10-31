// Sanitized tree to React. Loaded lazily with the worker, so the reading path of an entity page carries none of it.
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { Root } from 'hast';
import { safeHttpUrl } from '../components/bits.tsx';
import { NodeLink } from '../components/NodeLink.tsx';
import { NODE_HREF } from './nodeHref.ts';

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { resolve: (t: Root) => void; reject: (e: Error) => void }>();
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module', name: 'markdown' });
    worker.onmessage = (e: MessageEvent<{ id: number; tree?: Root; error?: string }>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.tree) w.resolve(e.data.tree); else w.reject(new Error(e.data.error ?? 'render failed'));
    };
    worker.onerror = (e) => { waiting.forEach((w) => w.reject(new Error(e.message))); waiting.clear(); };
  }
  return worker;
}
const renderInWorker = (text: string, wikilinks: boolean) => new Promise<Root>((resolve, reject) => {
  const id = ++seq;
  waiting.set(id, { resolve, reject });
  getWorker().postMessage({ id, text, wikilinks });
});

/** The URL hash belongs to the router, so in-page anchors are handled by hand (design 10). Ids carry the sanitize prefix. */
function jumpTo(e: MouseEvent, target: string) {
  e.preventDefault();
  const name = decodeURIComponent(target);
  (document.getElementById(`user-content-${name}`) ?? document.getElementById(name))?.scrollIntoView({ block: 'center' });
}

function SafeLink({ href, children }: { href?: string; children?: ReactNode }) {
  // Only the post-sanitize step can produce this scheme: sanitize drops it from anything in the source text.
  if (href?.startsWith(NODE_HREF)) return <NodeLink id={href.slice(NODE_HREF.length)} testid="wikilink">{children}</NodeLink>;
  if (href?.startsWith('#') && href.length > 1) return <a href={href} className="link" onClick={(e) => jumpTo(e, href.slice(1))}>{children}</a>;
  const u = safeHttpUrl(href);
  // Relative targets would resolve against this origin, so they stay text.
  if (!u) return <span data-testid="link-as-text">{children}</span>;
  return (
    <a className="link" href={u.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
      {children}<span className="link-host"> ({u.host})</span>
    </a>
  );
}

export function MarkdownView({ text, className, wikilinks = false }: { text: string; className?: string; wikilinks?: boolean }) {
  const [state, setState] = useState<{ tree: Root } | { failed: string } | null>(null);
  useEffect(() => {
    let alive = true;
    setState(null);
    renderInWorker(text, wikilinks).then((tree) => { if (alive) setState({ tree }); }, (e: Error) => { if (alive) setState({ failed: e.message }); });
    return () => { alive = false; };
  }, [text, wikilinks]);
  const element = useMemo(() => (state && 'tree' in state ? toJsxRuntime(state.tree, { Fragment, jsx, jsxs, components: { a: SafeLink }, ignoreInvalidStyle: true }) : null), [state]);
  if (state && 'failed' in state) return <pre className="source-text" data-testid="rendered-fallback">{text}</pre>;
  if (!element) return <p role="status" className="text-sm text-faint">그리는 중</p>;
  return <div className={`prose-kb ${className ?? ''}`} data-testid="rendered">{element}</div>;
}
export default MarkdownView;
