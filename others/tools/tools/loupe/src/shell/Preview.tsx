import { useNodeDetail } from '../data/hooks.ts';
export function Preview({id}:{id:string}) {
  const q=useNodeDetail(id,{}); const n=q.data?.data;
  if(!n)return <div className="node-preview" data-testid="node-preview" role="status">미리보기를 읽는 중</div>;
  return <div className="node-preview" data-testid="node-preview" aria-label="미리보기">
    <small>{n.type}</small><strong dir="auto">{n.label}</strong>
    <p>주장 {n.claims?.length??0} · 출처 {new Set(n.claims?.flatMap(c=>c.evidence?.map(e=>e.snapshot_id)??[])).size}</p>
    <p>{Array.isArray(n.props?.tags)?n.props.tags.join(', '):''}</p>
    <p>{[...(n.edges?.in??[]),...(n.edges?.out??[])].slice(0,3).map(e=>e.peer?.label??e.rtype).join(' · ')}</p>
    <p className="preview-body">{n.body?.split('\n').slice(0,2).join('\n')}</p>
  </div>;
}
