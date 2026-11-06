// The trash window (design v2 5.3 "휴지통 창", Q11, M2): first-party records the KB holds as `dead`, `GET /v1/nodes?origin=first_party&status=dead&types=…`.
// The KB lists only what the app itself made (ADR-0005 L1011). A restore is `PUT expected_version=<tombstone version>` with the last live content.
// "완전 삭제" is not done here: it explains the terminal command and does nothing (design 5.3).
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Node, NodeDetail } from '../client/model/index.ts';
import kbFetch from '../data/kbFetch.ts';
import { restore } from './records.ts';
import './doc.css';

const KIND: Record<string, string> = { Page: '문서', Note: '메모', TopicSpec: '주제', Review: '검토' };
const LIST = '/v1/nodes?origin=first_party&status=dead&types=Page,Note,TopicSpec,Review&limit=100';
const enc = encodeURIComponent;

export default function TrashWindow() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['loupe', 'trash'], queryFn: () => kbFetch<{ data: { items: Node[] } }>(LIST), staleTime: 0, refetchOnMount: 'always' });
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ id: string; text: string } | null>(null);
  const [explain, setExplain] = useState<string | null>(null);
  const items = list.data?.data.items ?? [];

  const restoreOne = async (n: Node) => {
    setBusy(n.id); setProblem(null);
    try {
      const d = (await kbFetch<{ data: NodeDetail }>(`/v1/nodes/${enc(n.id)}?include=body`)).data;
      const body = d.body ?? '';
      if ((d.body_chars ?? body.length) > body.length) { setProblem({ id: n.id, text: '본문이 길어 여기서는 복원하지 않는다' }); return; }
      const r = await restore({ id: n.id, type: d.type, title: d.label, body, props: d.props as Record<string, unknown>, sensitivity: d.sensitivity === 'internal' ? 'internal' : 'private', version: d.version });
      if (!r.ok) { setProblem({ id: n.id, text: r.code === 'version_conflict' ? '다른 곳에서 바뀌었다. 목록을 다시 읽는다' : `복원하지 못했다 · ${r.code}` }); }
      // The list and every cache that holds this record are read again: the record is `active` now.
      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'loupe' && q.queryKey[1] === 'trash' || JSON.stringify(q.queryKey).includes(n.id) });
    } catch {
      setProblem({ id: n.id, text: '복원하지 못했다 · KB에 닿지 않는다' });
    } finally { setBusy(null); }
  };

  return <div className="trash" data-testid="trash-window">
    <p className="trash-note">loupe가 만든 기록 가운데 보관한 것이다. 복원하면 새 판이 생긴다.</p>
    {list.isError && <p role="alert" data-testid="trash-error">휴지통을 읽지 못했다</p>}
    {list.isSuccess && items.length === 0 && <p className="trash-empty" data-testid="trash-empty" role="status">휴지통이 비었다</p>}
    <ul className="trash-list">
      {items.map((n) => <li key={n.id} className="trash-row" data-testid="trash-row" data-id={n.id} data-type={n.type}>
        <span className="trash-kind">{KIND[n.type] ?? n.type}</span>
        <bdi className="trash-title">{n.label}</bdi>
        <span className="trash-status" data-testid="trash-status">{n.status}</span>
        <button type="button" data-testid="trash-restore" disabled={busy !== null} onClick={() => void restoreOne(n)}>복원</button>
        <button type="button" data-testid="trash-purge" onClick={() => setExplain(explain === n.id ? null : n.id)}>완전 삭제…</button>
        {explain === n.id && <p className="trash-explain" role="note">KB는 TTY의 <code>kb redact {n.id}</code>로만 지운다. 되돌릴 수 없다.</p>}
        {problem?.id === n.id && <p role="alert" className="trash-problem">{problem.text}</p>}
      </li>)}
    </ul>
  </div>;
}
