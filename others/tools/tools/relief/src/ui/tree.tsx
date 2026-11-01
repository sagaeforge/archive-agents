// The same snapshot as a role="tree" list: for screen readers, and instead of a table to scan 500 objects (design 9.6).
import { BASIS_LABEL, type Snapshot } from '../../server/model/fact.ts';
import { KIND_LABEL, treeRows } from '../model.ts';
import { STATE_LABEL } from '../scene/style.ts';

export function Tree({ snap, sel, only, onSelect }: { snap: Snapshot; sel: string | null; only: ReadonlySet<string> | null; onSelect: (id: string) => void }) {
  const rows = treeRows(snap, only);
  return (
    <ul role="tree" aria-label="객체 목록" className="tree" data-testid="tree">
      {rows.map(({ id, level, entity: e }) => (
        <li
          key={id} role="treeitem" aria-level={level} aria-selected={sel === id} tabIndex={sel === id || (sel === null && id === rows[0]?.id) ? 0 : -1} data-tree={id}
          aria-label={`${e.title}, ${STATE_LABEL[e.state] || '상태 없음'}, 근거 ${BASIS_LABEL[e.basis]}`}
          className={sel === id ? 'on' : ''} style={{ paddingLeft: 8 + (level - 1) * 14 }}
          onClick={() => onSelect(id)} onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); onSelect(id); } }}
        >
          <span className="t">{e.title}</span><span className="m">{KIND_LABEL[e.kind]}</span>
        </li>
      ))}
      {rows.length === 0 ? <li className="m" role="none">맞는 객체 없음</li> : null}
    </ul>
  );
}
