// Right panel (design 9.4): the overall state only. What to look at, the layers, the blanks. An object's details live in the modal.
import type { Snapshot } from '../../server/model/fact.ts';
import type { SystemHealth } from '../../server/model/health.ts';
import { holes, tierCards } from '../model.ts';

const SHOWN = { finds: 8, holes: 6 };

export function Panel({ snap, nowMs, system: sum, onSelect }: { snap: Snapshot; nowMs: number; system: SystemHealth; onSelect: (id: string) => void }) {
  const cards = tierCards(snap, nowMs);
  const hs = holes(snap);
  return (
    <div data-testid="overview">
      <section className="card">
        <h3>지금 볼 것</h3>
        {sum.findings.length === 0 ? <p className="sub" data-testid="findings-none">{sum.text}{sum.state === 'healthy' ? ` · ${sum.met}/${sum.required}` : ''}</p> : (
          <ul className="finds" data-testid="findings">
            {sum.findings.slice(0, SHOWN.finds).map((f, i) => (
              <li key={i}>
                <button type="button" disabled={!f.id} onClick={() => { if (f.id) onSelect(f.id); }}><i className={`mark l-${f.level}`} /><b>{f.title}</b> <span>{f.why}</span></button>
              </li>
            ))}
            {sum.findings.length > SHOWN.finds ? <li className="sub">외 {sum.findings.length - SHOWN.finds}</li> : null}
          </ul>
        )}
      </section>
      <section className="card">
        <h3>계층</h3>
        <div className="tiers" data-testid="tiers">
          {cards.map((c) => <div key={c.tier}><span>{c.tier}</span><i>{c.text || '—'}</i></div>)}
        </div>
      </section>
      <section className="card">
        <h3>모름 {hs.length ? hs.reduce((n, h) => n + h.count, 0) : ''}</h3>
        {hs.length === 0 ? <p className="sub">없음</p> : (
          <ul className="holes" data-testid="holes">
            {hs.slice(0, SHOWN.holes).map((h) => (
              <li key={`${h.key}|${h.why}`}>
                <button type="button" title={`${h.why}${h.action ? ` → ${h.action}` : ''}`} onClick={() => onSelect(h.ids[0]!)}>
                  <span>{h.label}</span>{h.count > 1 ? <b>{h.count}</b> : null}
                </button>
              </li>
            ))}
            {hs.length > SHOWN.holes ? <li className="sub">외 {hs.length - SHOWN.holes}종</li> : null}
          </ul>
        )}
      </section>
    </div>
  );
}
