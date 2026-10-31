// Outgoing and incoming links (design 2). Since contract 0.3.0 an EdgeRef names the far end in `peer` (id, type, label), already
// resolved through merges. The neighbors table is read only for an edge that comes without a peer; the slug is the last fallback.
import { useMemo, useState } from 'react';
import type { Backlink, EdgeRef, NodeDetail } from '../client/model/index.ts';
import { Chip, Empty, ErrorCard, TimeMark } from '../components/bits.tsx';
import { fallbackLabel, NodeLink } from '../components/NodeLink.tsx';
import { useEdgesRest, useNeighborLabels, type NeighborInfo, type NodeFilters } from '../data/hooks.ts';
import { dedupeById } from './claimState.ts';

export const RELATIONS_ID = 'relations-panel';

type EdgeView = { edge: EdgeRef; far: string; type: string | undefined; label: string };

/** The far end of an edge: `peer` when the KB gave it (a merged end is already the survivor), otherwise the stored end and the neighbors table. */
export function farEnd(e: EdgeRef, stored: string, map: Map<string, NeighborInfo>): { id: string; label: string; type: string | undefined } {
  if (e.peer) return { id: e.peer.id, label: e.peer.label, type: e.peer.type };
  const info = map.get(stored);
  return { id: stored, label: info?.label ?? fallbackLabel(stored), type: info?.type || undefined };
}

/** A note link is both an incoming edge and a backlink. It is listed once, under 노트 백링크, which is where a reader looks for it.
 *  An incoming edge with no matching backlink (the backlink list was cut short, or the edge is not from a note) stays under 들어오는 링크. */
export function withoutBacklinked(incoming: readonly EdgeRef[], backlinks: readonly Backlink[]): EdgeRef[] {
  const have = new Set(backlinks.map((b) => `${b.rtype}|${b.id}`));
  return incoming.filter((e) => !have.has(`${e.rtype}|${e.peer?.id ?? e.src}`));
}

function group(list: readonly EdgeRef[], stored: (e: EdgeRef) => string, map: Map<string, NeighborInfo>) {
  const by = new Map<string, EdgeView[]>();
  for (const e of list) {
    const f = farEnd(e, stored(e), map);
    (by.get(e.rtype) ?? by.set(e.rtype, []).get(e.rtype)!).push({ edge: e, far: f.id, type: f.type, label: f.label });
  }
  return [...by].sort(([a], [b]) => (a < b ? -1 : 1)).map(([rtype, items]) => ({ rtype, items: items.sort((a, b) => a.label.localeCompare(b.label, 'ko')) }));
}

function EdgeList({ title, testid, groups, empty }: { title: string; testid: string; groups: ReturnType<typeof group>; empty: string }) {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <section data-testid={testid}>
      <h3 className="panel-title">{title}{total > 0 && <span className="tabular-nums"> {total}</span>}</h3>
      {total === 0 && <Empty className="mt-1">{empty}</Empty>}
      {groups.map((g) => (
        <div key={g.rtype} className="mt-2.5" data-testid="edge-group" data-rtype={g.rtype}>
          <h4 className="rtype">{g.rtype}</h4>
          <ul>
            {g.items.map(({ edge, far, type, label }) => (
              <li key={edge.id} className="edge-row" data-testid="edge-row" data-far={far} data-status={edge.status}>
                <NodeLink id={far} className="edge-link" testid="edge-link"><bdi className="truncate">{label}</bdi></NodeLink>
                {type && <span className="edge-type">{type}</span>}
                {edge.status !== 'active' && <Chip>{edge.status}</Chip>}
                {edge.claim_id && <NodeLink id={edge.claim_id} className="edge-claim" title="이 관계의 근거 주장" testid="edge-claim">근거</NodeLink>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function Backlinks({ items, truncated }: { items: readonly Backlink[]; truncated: boolean }) {
  if (items.length === 0) return null;
  return (
    <section data-testid="backlinks">
      <h3 className="panel-title">노트 백링크<span className="tabular-nums"> {items.length}</span></h3>
      <ul className="mt-1.5">
        {items.map((b) => (
          <li key={`${b.id}-${b.rtype}`} className="edge-row" data-testid="backlink">
            <NodeLink id={b.id} className="edge-link"><bdi className="truncate">{b.label}</bdi></NodeLink>
            <span className="edge-type">{b.type}</span>
          </li>
        ))}
      </ul>
      {truncated && <p className="mt-1 text-xs text-faint">일부만 보인다. 이어 받는 경로가 아직 없다.</p>}
    </section>
  );
}

export function RelationsPanel({ node, id, filters }: { node: NodeDetail; id: string; filters: NodeFilters }) {
  const [more, setMore] = useState(false);
  const truncated = !!node.edges?.truncated;
  const rest = useEdgesRest(id, filters, more);
  const outAll = useMemo(() => dedupeById(node.edges?.out ?? [], rest.items.out), [node.edges?.out, rest.items.out]);
  const inAll = useMemo(() => dedupeById(node.edges?.in ?? [], rest.items.in), [node.edges?.in, rest.items.in]);
  // The neighbors table is a fallback for edges without a peer. Nothing is read when every edge has one.
  const needNames = useMemo(() => [...outAll, ...inAll].some((e) => !e.peer), [outAll, inAll]);
  const names = useNeighborLabels(id, filters, needNames);
  const out = useMemo(() => group(outAll, (e) => e.dst, names.map), [outAll, names.map]);
  const inc = useMemo(() => group(withoutBacklinked(inAll, node.backlinks ?? []), (e) => e.src, names.map), [inAll, node.backlinks, names.map]);
  const backlinks = node.backlinks ?? [];
  return (
    <aside className="relations" aria-label="관계" id={RELATIONS_ID} tabIndex={-1} data-testid="relations">
      <TimeMark />
      <EdgeList title="나가는 링크" testid="edges-out" groups={out} empty="나가는 링크가 없다." />
      <EdgeList title="들어오는 링크" testid="edges-in" groups={inc} empty="들어오는 링크가 없다." />
      <Backlinks items={backlinks} truncated={!!node.backlinks_truncated} />
      {rest.error && <ErrorCard error={rest.error} compact onRetry={() => void rest.refetch()} />}
      {truncated && (!more || rest.hasNext) && (
        <button type="button" className="text-action" disabled={rest.isFetching} onClick={() => { if (more) void rest.fetchNext(); else setMore(true); }} data-testid="edges-more">
          {rest.isFetching ? '읽는 중' : '관계 이어 읽기'}
        </button>
      )}
    </aside>
  );
}
