// Right panel (design 9.4): one object, value by value with its basis and age; with nothing open, the layers and the holes.
import { BASIS_LABEL, basisNote, freshness, staleIds, type Entity, type Snapshot } from '../../server/model/fact.ts';
import { FACT_LABEL, factText, HOLE_ACTION, holes, KIND_LABEL, tierCards } from '../model.ts';
import { STATE_LABEL } from '../scene/style.ts';

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function Panel({ snap, nowMs, entity, onSelect }: { snap: Snapshot; nowMs: number; entity: Entity | null; onSelect: (id: string) => void }) {
  if (entity) return <ObjectPanel snap={snap} nowMs={nowMs} e={entity} />;
  const cards = tierCards(snap, nowMs);
  const hs = holes(snap);
  return (
    <div data-testid="overview">
      <h3>계층</h3>
      <div className="tiers" data-testid="tiers">
        {cards.map((c) => <div key={c.tier}><span>{c.tier}</span><i>{c.text || '—'}</i></div>)}
      </div>
      <h3 className="sp">구멍 목록</h3>
      <p className="sub">모르는 것과, 채우는 가장 작은 조치</p>
      {hs.length === 0 ? <p className="sub">미확인 값이 없다</p> : (
        <ul className="holes" data-testid="holes">
          {hs.slice(0, 12).map((h) => (
            <li key={`${h.key}|${h.why}`}>
              <button type="button" onClick={() => onSelect(h.ids[0]!)}>
                <b>{h.label} 미확인{h.count > 1 ? ` · ${h.count}개` : ''}</b>
                <span>{clip(h.why)}{h.action ? ` → ${h.action}` : ''}</span>
              </button>
            </li>
          ))}
          {hs.length > 12 ? <li className="sub">외 {hs.length - 12}종</li> : null}
        </ul>
      )}
    </div>
  );
}

function ObjectPanel({ snap, nowMs, e }: { snap: Snapshot; nowMs: number; e: Entity }) {
  const parent = e.parent ? snap.nodes.find((n) => n.id === e.parent) : undefined;
  const stale = staleIds(snap, nowMs).has(e.id);
  const st = STATE_LABEL[e.state];
  return (
    <div data-testid="object" data-obj={e.id} data-basis={e.basis}>
      <h3>{e.title}</h3>
      <p className="sub">{KIND_LABEL[e.kind]}{parent ? ` · ${parent.title}` : ''} · 존재 근거 {BASIS_LABEL[e.basis]}</p>
      {stale ? <p className="warn">낡음 · 값이 마지막으로 읽힌 뒤 오래됐다{st ? ` (마지막 표시 ${st})` : ''}</p> : null}
      {e.warnings?.length ? <p className="warn" data-testid="warnings">어긋남 · {e.warnings.join(', ')}</p> : null}
      {Object.entries(e.facts).map(([k, f]) => (
        <div className="row" key={k} data-fact={k} data-basis={f.basis}>
          <div className="k">{FACT_LABEL[k] ?? k}</div>
          <div className={`v ${f.basis}`}>{clip(factText(k, f))}</div>
          <div className="m">{clip(basisNote(f, nowMs))}{freshness(f, nowMs) === 'stale' ? '' : ''}</div>
          {f.basis === 'unknown' && HOLE_ACTION[k] ? <div className="m act">조치: {HOLE_ACTION[k]}</div> : null}
        </div>
      ))}
      {snap.edges.filter((r) => r.source === e.id || r.target === e.id).length ? (
        <div className="row"><div className="k">연결</div>
          {snap.edges.filter((r) => r.source === e.id || r.target === e.id).slice(0, 6).map((r) => {
            const other = snap.nodes.find((n) => n.id === (r.source === e.id ? r.target : r.source));
            return <div className="v" key={r.id}>{other?.title ?? '?'} <span className="m">{r.kind} · {BASIS_LABEL[r.basis]}</span></div>;
          })}
        </div>
      ) : null}
    </div>
  );
}
