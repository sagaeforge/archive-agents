// The command palette (design 9.11): one search for the whole map. Typing dims the map through the same query, Enter flies to the object.
// A key pressed during IME composition belongs to the IME: Enter there confirms a syllable, and the arrows move inside it.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot } from '../../server/model/fact.ts';
import { paletteHits } from '../model.ts';

const composing = (ev: React.KeyboardEvent) => ev.nativeEvent.isComposing || ev.keyCode === 229;

export function Palette({ snap, query, onQuery, onPick, onClose }: { snap: Snapshot; query: string; onQuery: (q: string) => void; onPick: (id: string) => void; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [at, setAt] = useState(0);
  const hits = useMemo(() => paletteHits(snap, query), [snap, query]);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useEffect(() => setAt(0), [query]);
  useEffect(() => { document.getElementById(`hit-${at}`)?.scrollIntoView({ block: 'nearest' }); }, [at]);
  const onKey = (ev: React.KeyboardEvent) => {
    if (composing(ev)) return;
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); onClose(); return; }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); ev.stopPropagation(); setAt((i) => (hits.length ? (i + 1) % hits.length : 0)); return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); ev.stopPropagation(); setAt((i) => (hits.length ? (i - 1 + hits.length) % hits.length : 0)); return; }
    if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); const h = hits[at]; if (h) onPick(h.id); }
  };
  return (
    <div className="backdrop top" data-testid="palette-backdrop" onPointerDown={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-label="객체 찾기" data-testid="palette" onKeyDown={onKey}>
        <input ref={input} type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={hits[at] ? `hit-${at}` : undefined} aria-label="객체 찾기" placeholder="이름, 종류, 주소" value={query} onChange={(ev) => onQuery(ev.target.value)} data-testid="palette-input" />
        <ul id="palette-list" role="listbox" aria-label="찾은 객체" data-testid="palette-list">
          {hits.map((h, i) => (
            <li key={h.id} id={`hit-${i}`} role="option" aria-selected={i === at} className={i === at ? 'on' : ''} data-hit={h.id} onPointerMove={() => setAt(i)} onPointerDown={(ev) => { ev.preventDefault(); onPick(h.id); }}>
              <span className="t">{h.title}</span><span className="m">{h.where ? `${h.where} · ` : ''}{h.kind}</span><span className="a">{h.address}</span>
            </li>
          ))}
          {hits.length === 0 ? <li className="sub" role="presentation" data-testid="palette-empty">없음</li> : null}
        </ul>
      </div>
    </div>
  );
}
