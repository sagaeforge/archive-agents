// What the modal shows for one object: the state, what is wrong, SSH, services, limits, trends, then the values with a basis mark each.
import { useState } from 'react';
import { BASIS_LABEL, basisNote, type Entity, type Fact, type Snapshot } from '../../server/model/fact.ts';
import { notApplicable, type ObjectHealth } from '../../server/model/health.ts';
import { CHECK_KEY, type Metric } from '../../server/model/threshold.ts';
import { FACT_LABEL, factText, HOLE_ACTION, KIND_LABEL, trafficText } from '../model.ts';
import { NO_TRAFFIC } from '../scene/paint.ts';
import { BasisMark } from './basis.tsx';
import { SshCopy } from './ssh.tsx';
import { TrendCard } from './trend.tsx';

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s);
const CHECKS = new Set<string>(Object.values(CHECK_KEY));
const METERS: { m: Metric; label: string }[] = [{ m: 'cpu', label: 'CPU' }, { m: 'mem', label: '메모리' }, { m: 'disk', label: '디스크' }];

/** A value, a bar from zero, the limit as a tick, and one word. No verdict is a hatched track, never a low bar. */
function LoadCard({ e, snap, nowMs, health }: { e: Entity; snap: Snapshot; nowMs: number; health: ObjectHealth }) {
  const rows = METERS.filter(({ m }) => e.facts[CHECK_KEY[m]]);
  if (!rows.length) return null;
  return (
    <section className="card" data-testid="load-card">
      <h3>부하 · 임계</h3>
      {rows.map(({ m, label }) => {
        const check = e.facts[CHECK_KEY[m]]!; const raw = e.facts[m]; const limit = snap.limits?.[m];
        const v = raw?.basis === 'observed' && typeof raw.value === 'number' ? raw.value : null;
        const blank = check.basis === 'unknown';
        const over = !blank && String(check.value).startsWith('임계 초과');
        const na = health.notApplicable.includes(label);
        return (
          <div className="meter" key={m} data-check={m} data-verdict={na ? 'na' : blank ? 'blank' : over ? 'over' : 'under'}>
            <div className="line"><span>{label}</span><span><b>{v === null ? '—' : `${Math.round(v * 100)}%`}</b> <em title={blank ? (check.why ?? '') : basisNote(check, nowMs)}>{na ? '해당 없음' : blank ? '비교 불가' : over ? '초과' : '미만'}{limit !== undefined && !na ? ` ${Math.round(limit * 100)}%` : ''}</em></span></div>
            <div className={na ? 'track na' : blank ? 'track blank' : 'track'} data-over={over ? '1' : undefined}>
              {!blank && v !== null ? <i style={{ width: `${Math.min(100, v * 100)}%` }} /> : null}
              {limit !== undefined && !na ? <s style={{ left: `${limit * 100}%` }} /> : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}

const SERVICE_LABEL = { up: '응답', down: '응답 없음' } as const;

function ServiceCard({ e, nowMs }: { e: Entity; nowMs: number }) {
  if (!e.services?.length) return null;
  return (
    <section className="card">
      <h3>서비스 · TCP</h3>
      <ul className="svc" data-testid="services">
        {e.services.map((s) => {
          const st = s.status.value;
          return (
            <li key={`${s.title}${s.port}`} data-status={st ?? 'unknown'}>
              <span>{clip(s.title, 40)} <span className="m">:{s.port}</span></span>
              <span title={s.status.why ?? ''}><i className={`mark l-${st === 'up' ? 'good' : st === 'down' ? 'problem' : 'stale'}`} />{st ? SERVICE_LABEL[st] : '미확인'}{s.latencyMs !== null ? ` · ${s.latencyMs} ms` : ''} <BasisMark f={s.status} nowMs={nowMs} /></span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** An empty value says nothing the row's absence does not say. A blank stays: it is the point of the map. */
const worthShowing = (f: Fact<unknown>) => f.basis === 'unknown' || !(f.value === null || f.value === '' || (Array.isArray(f.value) && f.value.length === 0));

export function ObjectDetail({ snap, nowMs, e, fx, health }: { snap: Snapshot; nowMs: number; e: Entity; fx: string; health: ObjectHealth }) {
  const parent = e.parent ? snap.nodes.find((n) => n.id === e.parent) : undefined;
  const links = snap.edges.filter((r) => r.source === e.id || r.target === e.id);
  const trends = e.kind === 'node' || e.kind === 'vm' || e.kind === 'lxc';
  const metered = new Set(METERS.filter(({ m }) => e.facts[CHECK_KEY[m]]).map(({ m }) => m as string));
  const rows = Object.entries(e.facts).filter(([k, f]) => !CHECKS.has(k) && !metered.has(k) && worthShowing(f));
  const traffic = trafficText(e, nowMs);
  const measurable = e.kind === 'node' || e.kind === 'vm' || e.kind === 'lxc';
  // A hover does not exist on a touch screen: this shows the same words in the open.
  const [notes, setNotes] = useState(false);
  return (
    <div className="detail-grid" data-testid="object" data-obj={e.id} data-basis={e.basis}>
      <div className="col">
        <section className="card head">
          <h3 id="modal-title">{e.title}</h3>
          <p className="sub">{KIND_LABEL[e.kind]}{parent ? ` · ${parent.title}` : ''} · <b data-testid="modal-health" data-health={health.state}>{health.word}</b> · {BASIS_LABEL[e.basis]}</p>
          {health.drift.length ? <p className="warn" data-testid="warnings">어긋남 · {health.drift.join(', ')}</p> : null}
          {health.alerts.length || health.pending.length ? <p className={health.state === 'problem' ? 'warn bad' : 'warn'} data-testid="alerts" title="추정">{[...health.alerts.map((a) => a.text), ...health.pending].join(', ')}</p> : null}
          {health.missing.length ? <p className="sub" data-testid="missing">미확인 {health.missing.join(', ')}</p> : null}
        </section>
        <p className="traffic" data-testid="traffic"><span>트래픽</span><b>{traffic ?? (measurable ? '측정 대기' : NO_TRAFFIC)}</b></p>
        <SshCopy e={e} />
        <ServiceCard e={e} nowMs={nowMs} />
        <LoadCard e={e} snap={snap} nowMs={nowMs} health={health} />
        <section className="card">
          <div className="head-row"><h3>값</h3><button type="button" className="plain" aria-pressed={notes} data-testid="facts-notes" onClick={() => setNotes((v) => !v)}>근거</button></div>
          <dl className="facts">
            {rows.map(([k, f]) => (
              <div className="row" key={k} data-fact={k} data-basis={f.basis}>
                <dt className="k">{FACT_LABEL[k] ?? k}</dt>
                <dd className={`v ${f.basis}`} title={f.basis === 'unknown' && HOLE_ACTION[k] ? `조치: ${HOLE_ACTION[k]}` : undefined}>{notApplicable(e, k) ? '해당 없음' : clip(factText(k, f))} <BasisMark f={f} nowMs={nowMs} />{notes ? <span className="note" data-testid="fact-note">{clip(basisNote(f, nowMs))}{f.basis === 'unknown' && HOLE_ACTION[k] ? ` · ${HOLE_ACTION[k]}` : ''}</span> : null}</dd>
              </div>
            ))}
          </dl>
        </section>
        {links.length ? (
          <section className="card">
            <h3>연결</h3>
            <div className="links">
              {links.slice(0, 6).map((r) => {
                const other = snap.nodes.find((n) => n.id === (r.source === e.id ? r.target : r.source));
                return <span key={r.id} title={`${r.kind} · ${BASIS_LABEL[r.basis]}`}>{other?.title ?? '?'}</span>;
              })}
            </div>
          </section>
        ) : null}
      </div>
      {trends && !e.gone ? <div className="col"><TrendCard key={e.id} e={e} limits={snap.limits} fx={fx} notApplicable={health.notApplicable} /></div> : null}
    </div>
  );
}
