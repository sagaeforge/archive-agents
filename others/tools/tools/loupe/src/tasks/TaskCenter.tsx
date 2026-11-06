// The task center pill at the lower right and its list (design v2 2.2, 3, 7.2). It never opens by itself: a new confirmation or error
// only colors the pill (U4). Alt+J opens and closes it. Read-only in this step: there is no button that changes anything.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { isComposing } from '../wm/model.ts';
import { buildItems, countTones, KIND_LABEL, type TaskItem } from './model.ts';
import { useTasks } from './useTasks.ts';
import './tasks.css';

export function TaskCenter({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useTasks(true);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  const items = useMemo(() => (q.data ? buildItems(q.data, Date.now()) : []), [q.data]);
  const { attention, error } = countTones(items);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (isComposing(e)) return;
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyJ') { e.preventDefault(); setOpen((v) => !v); return; }
      if (e.key === 'Escape' && open && root.current?.contains(document.activeElement)) { setOpen(false); button.current?.focus(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open]);
  const loaded = q.data ? 'true' : q.isError ? 'error' : 'false';
  return <div className="task-center" ref={root}>
    {open && <section id={listId} className="task-list" data-testid="task-list" role="region" aria-label="작업 센터">
      {q.isError && <p className="task-note" role="status" data-testid="task-stale">{q.data ? '갱신하지 못했다. 마지막으로 읽은 것을 보인다.' : '작업을 읽지 못했다.'}</p>}
      {!q.data && !q.isError && <p className="task-note" role="status">작업을 읽는 중</p>}
      {q.data && items.length === 0 && <p className="task-note">진행 중인 작업이 없다.</p>}
      <ul>{items.map((i) => <Row key={i.key} item={i} onOpen={(o) => { onOpen('window' in o ? o.window : o.record); setOpen(false); }} />)}</ul>
    </section>}
    <button ref={button} type="button" className="task-pill" data-testid="task-pill" data-loaded={loaded} data-count={items.length} data-attention={attention} data-error={error}
      aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => setOpen(!open)} title="작업 센터 (Alt+J)">
      작업 {items.length}
      {attention > 0 && <span className="task-badge" data-tone="attention" data-testid="task-pill-attention">확인 필요 {attention}</span>}
      {error > 0 && <span className="task-badge" data-tone="error" data-testid="task-pill-error">오류 {error}</span>}
    </button>
  </div>;
}

function Row({ item, onOpen }: { item: TaskItem; onOpen: (o: NonNullable<TaskItem['open']>) => void }) {
  return <li className="task-item" data-testid="task-item" data-key={item.key} data-kind={item.kind} data-state={item.state ?? undefined} data-tone={item.tone}>
    <div className="task-head">
      <span className="task-kind">{KIND_LABEL[item.kind]}</span>
      <span className="task-title" dir="auto">{item.title}</span>
      {item.state && <code className="task-state" data-testid="task-state">{item.state}</code>}
      {item.badge && <span className="task-badge" data-tone={item.tone} data-testid="task-badge">{item.badge}</span>}
    </div>
    {item.lock && <p className="task-lock" data-testid="task-lock">{item.lock}</p>}
    {item.summary.map((s) => <p key={s} className="task-summary">{s}</p>)}
    {item.open && <button type="button" className="task-open" data-testid="task-open" onClick={() => onOpen(item.open!)}>{'window' in item.open ? '상세 보기' : '이어 보기'}</button>}
  </li>;
}
