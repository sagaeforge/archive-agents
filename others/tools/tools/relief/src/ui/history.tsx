// The history page (design 9.9): changes.jsonl, newest first, one bounded page at a time, filtered on the server by kind and object. An object still on the map is a link to it.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CHANGE_TYPES, type ChangeEntry, type ChangePage, type ChangeRow, type ChangeType } from '../../server/changes.ts';
import { ageS, ageText, type Snapshot } from '../../server/model/fact.ts';

const TYPE: Record<ChangeRow['type'], string> = { added: '추가', removed: '제거', changed: '변경', state: '상태', source: '출처', alert: '임계', service: '서비스' };
const PAGE = 30;

export function History({ snap, nowMs, onSelect }: { snap: Snapshot; nowMs: number; onSelect: (id: string) => void }) {
  const [items, setItems] = useState<ChangeEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [type, setType] = useState<ChangeType | ''>('');
  const [object, setObject] = useState('');
  const load = useCallback(async (before: number | null) => {
    try {
      const q = new URLSearchParams({ limit: String(PAGE) });
      if (before !== null) q.set('before', String(before));
      if (type) q.set('type', type);
      if (object) q.set('id', object);
      const r = await fetch(new URL(`api/changes?${q}`, document.baseURI), { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const p = (await r.json()) as ChangePage;
      setItems((cur) => (before === null ? p.items : [...cur, ...p.items])); setNext(p.next); setFailed(null);
    } catch (e) { setFailed(String(e instanceof Error ? e.message : e).slice(0, 120)); } finally { setReady(true); }
  }, [type, object]);
  useEffect(() => { void load(null); }, [load, snap.seq]);
  const title = (id: string) => snap.nodes.find((n) => n.id === id && !n.gone)?.title;
  const objects = useMemo(() => [...snap.nodes].filter((n) => !n.gone).sort((a, b) => a.title.localeCompare(b.title, 'ko')), [snap.nodes]);
  return (
    <section className="history" data-testid="history">
      <div className="filters" role="group" aria-label="변경 기록 거르기">
        <h2>변경 기록</h2>
        <label>종류 <select value={type} onChange={(ev) => setType(ev.target.value as ChangeType | '')} data-testid="history-type"><option value="">전체</option>{CHANGE_TYPES.map((t) => <option key={t} value={t}>{TYPE[t]}</option>)}</select></label>
        <label>객체 <select value={object} onChange={(ev) => setObject(ev.target.value)} data-testid="history-object"><option value="">전체</option>{objects.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}</select></label>
      </div>
      {failed ? <p className="warn">읽지 못함 · {failed}</p> : null}
      {ready && !items.length && !failed ? <p className="sub" data-testid="changes-empty">기록 없음</p> : null}
      <ol className="hist">
        {items.map((e) => {
          const age = ageS(e.at, nowMs);
          return (
            <li key={e.n} data-testid="change">
              <time dateTime={e.at} title={e.at}>{age === null ? e.at : ageText(age)}</time>
              <ul>
                {e.rows.map((r, i) => {
                  const name = r.id ? title(r.id) : undefined;
                  return <li key={i} data-type={r.type}><em>{TYPE[r.type]}</em>{name ? <button type="button" data-testid="change-link" onClick={() => onSelect(r.id!)}>{name}</button> : r.id ? <span>{r.id}</span> : null}{r.text ? <span>{r.text}</span> : null}</li>;
                })}
                {e.more ? <li className="m">외 {e.more}</li> : null}
              </ul>
            </li>
          );
        })}
      </ol>
      {next !== null ? <button type="button" className="more" data-testid="changes-more" onClick={() => void load(next)}>더 보기</button> : null}
    </section>
  );
}
