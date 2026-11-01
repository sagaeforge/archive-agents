// The right panel: a summary without leaving the graph (design 2, 3). Edge labels are not on the canvas, so the relations are listed here (design 6.1).
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { Chip, ErrorCard, Loading } from '../components/bits.tsx';
import { NodeLink } from '../components/NodeLink.tsx';
import { useNodeSummary } from '../data/graph.ts';
import { relationsOf, type GraphData } from './model.ts';

const SHOWN_RELATIONS = 60;

export function SelectionPanel({ id, data, onClose }: { id: string; data: GraphData; onClose: () => void }) {
  const q = useNodeSummary(id);
  const relations = useMemo(() => relationsOf(data, id), [data, id]);
  const node = q.data;
  const fallback = data.nodes.find((n) => n.id === id);
  return (
    <aside className="graph-panel" data-testid="graph-panel" data-id={id} aria-label="선택한 노드">
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-base font-semibold break-words" dir="auto" data-testid="graph-panel-title">{node?.label ?? fallback?.label ?? id}</h2>
        <button type="button" className="text-action" onClick={onClose} data-testid="graph-panel-close">닫기</button>
      </div>
      <p className="id mt-1 break-all">{id}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {(node?.type ?? fallback?.type) && <Chip>{node?.type ?? fallback?.type}</Chip>}
        <NodeLink id={id} testid="graph-panel-open">엔티티 페이지로</NodeLink>
        <Link to="/graph" search={(p: Record<string, unknown>) => ({ ...p, focus: id, sel: id, merged_from: undefined })} className="link" data-testid="graph-panel-expand">이웃 펼치기</Link>
      </div>
      {q.isPending && <Loading className="mt-3" />}
      {q.error && <div className="mt-3"><ErrorCard compact error={q.error} onRetry={() => void q.refetch()} /></div>}
      {node?.claims && node.claims.length > 0 && (
        <section className="mt-4" aria-label="주장">
          <h3 className="eyebrow">주장</h3>
          <ul className="mt-1 space-y-1.5 text-sm" data-testid="graph-panel-claims">
            {node.claims.map((c) => <li key={c.id} dir="auto"><NodeLink id={c.id}>{c.statement}</NodeLink></li>)}
          </ul>
        </section>
      )}
      <section className="mt-4" aria-label="관계">
        <h3 className="eyebrow">관계 {relations.length}</h3>
        <ul className="mt-1 space-y-1 text-sm" data-testid="graph-panel-relations">
          {relations.slice(0, SHOWN_RELATIONS).map((r) => (
            <li key={r.id} data-testid="graph-relation" data-rtype={r.rtype} data-status={r.status}>
              <span className="text-faint">{r.direction === 'out' ? '→' : '←'} {r.rtype}</span>{' '}
              <Link to="/graph" search={(p: Record<string, unknown>) => ({ ...p, sel: r.peer })} className="link" dir="auto">{r.peerLabel}</Link>
              {r.status === 'superseded' && <Chip className="ml-1">대체됨</Chip>}
            </li>
          ))}
        </ul>
        {relations.length > SHOWN_RELATIONS && <p className="mt-1 text-sm text-faint">{relations.length - SHOWN_RELATIONS}개 더 있다. 엔티티 페이지에서 본다.</p>}
      </section>
    </aside>
  );
}
