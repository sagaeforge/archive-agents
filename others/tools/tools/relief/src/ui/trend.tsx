// Metric history of the selected object (design 9.8). Read when the panel opens or the window changes, never on a timer. Plain SVG: dataviz specs, no chart library.
import { useEffect, useMemo, useState } from 'react';
import type { Timeframe } from '../../server/collect/allowlist.ts';
import type { Trend, TrendPoint } from '../../server/collect/trend.ts';
import type { Entity, Limits } from '../../server/model/fact.ts';
import { clock, nearest, niceMax, percent, rateText, runs } from './chart.ts';

export const TREND_DEBOUNCE_MS = 250;
const W = 332; const H = 86; const L = 52; const R = 8; const T = 6; const B = 16;
type Series = { key: string; label: string; color: string; values: (number | null)[] };

function Chart({ id, title, series, times, max, limit, format, day, na }: { id: string; na?: boolean; title: string; series: Series[]; times: number[]; max: number; limit?: number; format: (v: number) => string; day: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = times.length;
  const x = (i: number) => L + (n < 2 ? 0 : (i * (W - L - R)) / (n - 1));
  const y = (v: number) => T + (1 - Math.min(1, v / max)) * (H - T - B);
  const last = (s: Series) => s.values.findLast((v) => v !== null) ?? null;
  const present = series.filter((s) => s.values.some((v) => v !== null));
  const peak = Math.max(...series.flatMap((s) => s.values.flatMap((v) => (v === null ? [] : [v]))), 0);
  const summary = series.map((s) => `${s.label} ${last(s) === null ? '값 없음' : format(last(s)!)}`).join(', ');
  if (!present.length) return <div className="chart" data-testid={`chart-${id}`} data-empty="1"><div className="line"><span>{title}</span><span>{na ? '해당 없음' : '값 없음 · 비교 불가'}</span></div></div>;
  return (
    <div className="chart" data-testid={`chart-${id}`}>
      <div className="line">
        <span>{title}</span>
        {series.length === 1 ? <span><b>{format(last(series[0]!) ?? 0)}</b> · 최대 {format(peak)}</span>
          : <span className="keys">{series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label} {last(s) === null ? '—' : format(last(s)!)}</span>)}</span>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. 최근 ${summary}`}
        onPointerMove={(ev) => { const r = ev.currentTarget.getBoundingClientRect(); setHover(nearest(((ev.clientX - r.left) / r.width) * W, n, L, W - R)); }} onPointerLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => <g key={f}><line className={f === 0 ? 'c-axis' : 'c-grid'} x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} /><text x={L - 5} y={y(max * f) + 3.5} textAnchor="end">{format(max * f)}</text></g>)}
        <text x={L} y={H - 3}>{clock(times[0]!, day)}</text><text x={W - R} y={H - 3} textAnchor="end">{clock(times[n - 1]!, day)}</text>
        {limit !== undefined ? <><line className="c-limit" data-testid={`limit-${id}`} x1={L} x2={W - R} y1={y(limit)} y2={y(limit)} /><text x={W - R} y={y(limit) + 11} textAnchor="end">임계 {format(limit)}</text></> : null}
        {present.map((s) => runs(s.values).map((run, i) => {
          const pts = run.map(([j, v]) => `${x(j).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
          return (
            <g key={`${s.key}${i}`}>
              {series.length === 1 && run.length > 1 ? <polygon className="c-area" fill={s.color} points={`${x(run[0]![0]).toFixed(1)},${y(0)} ${pts} ${x(run.at(-1)![0]).toFixed(1)},${y(0)}`} /> : null}
              <polyline className="c-line" stroke={s.color} points={pts} />
            </g>
          );
        }))}
        {present.map((s) => { const j = s.values.findLastIndex((v) => v !== null); return <circle key={s.key} className="c-dot" fill={s.color} cx={x(j)} cy={y(s.values[j]!)} r={4} />; })}
        {hover !== null ? <line className="c-cross" x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} /> : null}
      </svg>
      {hover !== null ? (
        <div className="c-tip" style={{ [hover > n / 2 ? 'left' : 'right']: 44 }}>
          {clock(times[hover]!, day)}
          {series.map((s) => <span key={s.key}><i style={{ background: s.color }} /><b>{s.values[hover] === null ? '—' : format(s.values[hover]!)}</b> {s.label}</span>)}
        </div>
      ) : null}
    </div>
  );
}

const cell = (v: number | null, f: (x: number) => string) => (v === null ? '—' : f(v));
const COLOR = { a: 'var(--series-1)', b: 'var(--series-2)' };

export function TrendCard({ e, limits, fx, notApplicable }: { e: Entity; limits: Limits | undefined; fx: string; notApplicable: string[] }) {
  const [tf, setTf] = useState<Timeframe>('hour');
  const [t, setT] = useState<Trend | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setT(null); setFailed(null);
    const q = new URLSearchParams({ id: e.id, tf }); if (fx !== 'today') q.set('fixture', fx);
    // Held back a moment: walking through objects or flicking the window must not send a read for each one.
    const wait = setTimeout(() => {
      fetch(new URL(`api/trend?${q}`, document.baseURI), { cache: 'no-store' })
        .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return (await r.json()) as Trend; })
        .then((v) => { if (alive) setT(v); }, (x: unknown) => { if (alive) setFailed(String(x instanceof Error ? x.message : x).slice(0, 120)); });
    }, TREND_DEBOUNCE_MS);
    return () => { alive = false; clearTimeout(wait); };
  }, [e.id, tf, fx]);
  const p: TrendPoint[] = useMemo(() => t?.points ?? [], [t]);
  const times = p.map((x) => x.t); const day = tf === 'day';
  const peakNet = Math.max(0, ...p.flatMap((x) => [x.netIn ?? 0, x.netOut ?? 0]));
  const none = failed ?? t?.why ?? (t && !p.length ? '값 없음' : null);
  return (
    <section className="card" data-testid="trends" data-tf={tf}>
      <div className="range">
        <h3 style={{ margin: 0 }}>추세</h3>
        <div className="seg" role="group" aria-label="기간">
          {(['hour', 'day'] as const).map((w) => <button key={w} type="button" className={tf === w ? 'on' : ''} aria-pressed={tf === w} data-testid={`tf-${w}`} onClick={() => setTf(w)}>{w === 'hour' ? '1시간' : '1일'}</button>)}
        </div>
      </div>
      {none ? <p className="warn" data-testid="trend-none">추세 없음 · {none}</p> : !t ? <p className="sub">불러오는 중</p> : (
        <>
          <Chart id="cpu" title="CPU" times={times} max={1} day={day} format={percent} {...(limits ? { limit: limits.cpu } : {})} series={[{ key: 'cpu', label: 'CPU', color: COLOR.a, values: p.map((x) => x.cpu) }]} />
          <Chart id="mem" title="메모리" times={times} max={1} day={day} format={percent} {...(limits ? { limit: limits.mem } : {})} series={[{ key: 'mem', label: '메모리', color: COLOR.a, values: p.map((x) => x.mem) }]} />
          <Chart id="disk" title="디스크" na={notApplicable.includes('디스크')} times={times} max={1} day={day} format={percent} {...(limits ? { limit: limits.disk } : {})} series={[{ key: 'disk', label: '디스크', color: COLOR.a, values: p.map((x) => x.disk) }]} />
          <Chart id="net" title="네트워크" times={times} max={niceMax(peakNet)} day={day} format={rateText} series={[{ key: 'in', label: '수신', color: COLOR.a, values: p.map((x) => x.netIn) }, { key: 'out', label: '송신', color: COLOR.b, values: p.map((x) => x.netOut) }]} />
          <details className="table">
            <summary>표로 보기</summary>
            <div className="wrap">
              <table data-testid="trend-table">
                <thead><tr><th>시각</th><th>CPU</th><th>메모리</th><th>디스크</th><th>수신</th><th>송신</th></tr></thead>
                <tbody>{[...p].reverse().map((x) => <tr key={x.t}><td>{clock(x.t, day)}</td><td>{cell(x.cpu, percent)}</td><td>{cell(x.mem, percent)}</td><td>{cell(x.disk, percent)}</td><td>{cell(x.netIn, rateText)}</td><td>{cell(x.netOut, rateText)}</td></tr>)}</tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
