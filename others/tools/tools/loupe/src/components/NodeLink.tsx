import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';

/** Every link to a node. The time axes travel on their own through retainSearchParams. */
export function NodeLink({ id, children, className, testid, title }: { id: string; children: ReactNode; className?: string; testid?: string; title?: string }) {
  return <Link to="/node/$id" params={{ id }} className={className ?? 'link'} data-testid={testid} data-id={id} title={title}>{children}</Link>;
}

/** When no label is at hand: the slug of `e:<type>:<slug>`, the id itself for anything else. */
export const fallbackLabel = (id: string) => (id.startsWith('e:') ? id.split(':').slice(2).join(':') || id : id);
