// The same snapshot as a role="tree" list: for screen readers, and instead of a table to scan 500 objects (design 9.6).
import { BASIS_LABEL, type Snapshot } from '../../server/model/fact.ts';
import type { ObjectHealth } from '../../server/model/health.ts';
import { KIND_LABEL, treeRows } from '../model.ts';

export function Tree({ snap, sel, only, health, onSelect }: { snap: Snapshot; sel: string | null; only: ReadonlySet<string> | null; health: ReadonlyMap<string, ObjectHealth>; onSelect: (id: string) => void }) {
  const rows = treeRows(snap, only);
  return (
    <ul role="tree" aria-label="객체 목록" className="tree" data-testid="tree">
      {rows.map(({ id, level, entity: e }) => (
        <li
          key={id} role="treeitem" aria-level={level} aria-selected={sel === id} tabIndex={sel === id || (sel === null && id === rows[0]?.id) ? 0 : -1} data-tree={id}
          aria-label={`${e.title}, ${health.get(id)?.word ?? '미확인'}, 근거 ${BASIS_LABEL[e.basis]}`} data-health={health.get(id)?.state}
          className={sel === id ? 'on' : ''} style={{ paddingLeft: 8 + (level - 1) * 14 }}
          onClick={() => onSelect(id)} onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); onSelect(id); } }}
        >
          <span className="t">{e.title}</span><span className="m">{KIND_LABEL[e.kind]} · {health.get(id)?.word ?? '미확인'}</span>
        </li>
      ))}
      {rows.length === 0 ? <li className="m" role="none">맞는 객체 없음</li> : null}
    </ul>
  );
}
