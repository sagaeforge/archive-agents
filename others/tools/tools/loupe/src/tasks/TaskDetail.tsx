// The task detail window (design v2 2.2, 7.2): what the KB reports for one research run, the collection graph, the edges, the claims that
// arrived with the viewer's quote check, and the record. Everything is read; the re-request button is a stub until the write step.
import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Evidence } from '../client/model/index.ts';
import { useVerdict } from '../data/hooks.ts';
import { VERDICT_LABEL } from '../quote/verify.ts';
import { useTimeBasis } from '../time/useTimeBasis.ts';
import { axesOf, ReadFailure, readKb, seg, withAxes } from './api.ts';
import { lockOf, type ResearchStatus } from './model.ts';
import { TASKS_POLL_MS, useTasks } from './useTasks.ts';
import './tasks.css';

const WARNING = '원문 일치는 인용이 원문에 있다는 뜻일 뿐 사실 여부나 원문에 심은 지시를 판정하지 않는다.';
const PRIVATE_REASON = 'private_topic_registered_sources_only';
const SEEN_KEY = 'loupe.tasks.seen.v1';
type Edge = { id: string; rtype: string; src: string; dst: string; status: string; peer?: { id: string; label: string } };
type Claim = { id: string; statement: string; evidence?: Evidence[] };

const readSeen = (topic: string): Set<string> | null => {
  try { const v = JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, unknown>; const x = v[topic]; return Array.isArray(x) ? new Set(x.filter((i): i is string => typeof i === 'string')) : null; } catch { return null; }
};
const writeSeen = (topic: string, ids: string[]) => {
  try {
    const v = JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, unknown>;
    const keep = Object.fromEntries(Object.entries(v).slice(-19));
    sessionStorage.setItem(SEEN_KEY, JSON.stringify({ ...keep, [topic]: ids.slice(0, 200) }));
  } catch { /* storage denied: the next visit shows every edge as new */ }
};
const poll = { refetchInterval: TASKS_POLL_MS, staleTime: 0 } as const;

export default function TaskDetail({ spec }: { spec: string }) {
  const tasks = useTasks(false);
  const row = tasks.data?.research.find((r) => r.spec === spec);
  if (!row) return <div className="task-detail"><p role="status" data-testid="task-detail-wait">{tasks.isError ? '작업을 읽지 못했다.' : tasks.data ? '이 조사는 더 이상 목록에 없다.' : '작업을 읽는 중'}</p></div>;
  return <Detail label={row.label} status={row.status} existing={row.existing} />;
}

function Detail({ label, status: s, existing }: { label: string; status: ResearchStatus; existing: boolean }) {
  const axes = axesOf(useTimeBasis());
  const edgesQ = useQuery({ queryKey: ['loupe', 'task-edges', s.topic, axes], queryFn: ({ signal }) => readKb<{ items: Edge[] }>(withAxes(`/v1/nodes/${seg(s.topic)}/edges?direction=in&rtypes=IN_TOPIC&limit=100`, axes), signal), ...poll });
  const claimsQ = useQuery({ queryKey: ['loupe', 'task-claims', s.topic, axes], queryFn: ({ signal }) => readKb<{ items: Claim[] }>(withAxes(`/v1/nodes/${seg(s.topic)}/claims?limit=50`, axes), signal), ...poll });
  const edges = useMemo(() => (Array.isArray(edgesQ.data?.data.items) ? edgesQ.data.data.items : []), [edgesQ.data]);
  const claims = useMemo(() => (Array.isArray(claimsQ.data?.data.items) ? claimsQ.data.data.items : []), [claimsQ.data]);
  // "Edges that came since the last visit": the ids this tab saw when the window was last closed (new = dashed).
  const before = useRef(readSeen(s.topic));
  const latest = useRef<string[]>([]);
  latest.current = edges.map((e) => e.id);
  useEffect(() => () => { if (latest.current.length > 0) writeSeen(s.topic, latest.current); }, [s.topic]);
  const isNew = (id: string) => !before.current?.has(id);
  const locked = lockOf(s.state);
  const priv = s.discovery === 'narrowed' && s.discovery_reason === PRIVATE_REASON;
  const failed = edgesQ.isError && !edgesQ.data;

  return <div className="task-detail" data-testid="task-detail" data-state={s.state}>
    <header>
      <h2 dir="auto">{label}</h2>
      <p><code className="task-state" data-testid="task-state">{s.state}</code>{s.run && <> · 실행 <code>{s.run.id}</code></>}{existing && <> · 열린 조사에 합류</>}</p>
    </header>
    {locked && <p className="task-lock" data-testid="task-lock">{locked}</p>}
    <section aria-label="범위">
      <p data-testid="task-scope">{s.discovery === 'narrowed' ? `찾는 범위: 좁힘${priv ? ' · 등록된 소스와 로컬만' : ''}` : '찾는 범위: 표준'}</p>
      {priv && <p data-testid="task-egress">밖으로 나간 것: 없음</p>}
    </section>
    <section aria-label="엔진과 비용">
      <h3>KB가 고른 엔진</h3>
      {s.engines.length === 0 ? <p>아직 없음</p> : <ul>{s.engines.map((e, i) => <li key={i} data-testid="task-engine">{e.kind === 'deterministic' ? `결정적 수집기 ${e.collectors ?? 0}` : `LLM 과제 ${e.task ?? '-'} · 팔 ${e.arm ?? '-'} · 호출 ${e.calls ?? 0}`}</li>)}</ul>}
      <p data-testid="task-cost">{s.cost && s.cost.reported ? `비용: $${s.cost.month_usd} / $${s.cost.budget_usd_month} (월)` : '비용: 보고 없음'}</p>
      <p data-testid="task-pending-hosts">승인 대기 출처 {s.pending_hosts}</p>
    </section>
    <section aria-label="결과">
      <h3>결과</h3>
      <p data-testid="task-results">주장 {s.results.accepted_claims} · 엣지 {s.results.edges} · 확인 필요 {s.results.needs_review}{s.results.since ? ` · 기준 ${new Date(s.results.since).toLocaleString('ko-KR')}` : ''}</p>
    </section>
    <section aria-label="수집 그래프">
      <h3>수집 그래프</h3>
      {failed ? <p role="status">엣지를 읽지 못했다.</p> : <Graph topic={label} edges={edges} isNew={isNew} />}
    </section>
    <section aria-label="엣지 목록">
      <h3>엣지 목록</h3>
      {edges.length === 0 ? <p>아직 들어온 엣지가 없다.</p> : <table className="task-edges"><tbody>{edges.map((e) => <tr key={e.id} data-testid="task-edge-row" data-new={isNew(e.id)}><td>{e.rtype}</td><td dir="auto">{e.peer?.label ?? e.src}</td><td>{e.status}{isNew(e.id) ? ' · 새로 옴' : ''}</td></tr>)}</tbody></table>}
    </section>
    <section aria-label="도착한 주장">
      <h3>도착한 주장</h3>
      <p className="task-warning" data-testid="task-warning">{WARNING}</p>
      {claims.length === 0 ? <p>아직 도착한 주장이 없다.</p> : <ul>{claims.slice(0, 10).map((c) => <ClaimRow key={c.id} claim={c} />)}</ul>}
    </section>
    <section aria-label="기록">
      <h3>기록</h3>
      <ul data-testid="task-log">
        {s.run && <li>{new Date(s.run.opened_at).toLocaleString('ko-KR')} · 조사 시작 · {s.run.id}</li>}
        {s.cost && <li>{new Date(s.cost.as_of).toLocaleString('ko-KR')} · 비용 보고 · ${s.cost.month_usd}</li>}
        {s.failures.slice(0, 20).map((f, i) => <li key={i} data-testid="task-failure">{new Date(f.at).toLocaleString('ko-KR')} · 실패 · {f.stage} · {f.source} · {f.code}</li>)}
        {!s.run && s.failures.length === 0 && <li>기록 없음</li>}
      </ul>
    </section>
    <p><button type="button" className="task-rerun" data-testid="task-rerun" disabled title="읽기 전용 단계입니다. 요청은 쓰기 단계에서 연결합니다.">조사 다시 요청</button></p>
  </div>;
}

function Graph({ topic, edges, isNew }: { topic: string; edges: Edge[]; isNew: (id: string) => boolean }) {
  const cx = 180, cy = 110, r = 78;
  return <svg className="task-graph" data-testid="task-graph" viewBox="0 0 360 220" role="img" aria-label={`수집 그래프, 엣지 ${edges.length}개`}>
    {edges.map((e, i) => {
      const a = (2 * Math.PI * i) / Math.max(1, edges.length) - Math.PI / 2, x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
      return <g key={e.id}>
        <line x1={cx} y1={cy} x2={x} y2={y} data-testid="task-graph-edge" data-new={isNew(e.id)} />
        <circle cx={x} cy={y} r={6} />
        <text x={x} y={y + (y > cy ? 18 : -10)} textAnchor="middle">{(e.peer?.label ?? e.src).slice(0, 14)}</text>
      </g>;
    })}
    <circle cx={cx} cy={cy} r={14} /><text x={cx} y={cy + 3} textAnchor="middle">{topic.slice(0, 8)}</text>
  </svg>;
}

function ClaimRow({ claim }: { claim: Claim }) {
  const ev = claim.evidence?.[0];
  const verdict = useVerdict(ev, !!ev).data;
  const reviews = useQuery({ queryKey: ['loupe', 'task-reviews', claim.id], queryFn: ({ signal }) => readKb<{ items: unknown[] }>(`/v1/nodes/${seg(claim.id)}/reviews`, signal), ...poll, retry: (n, e) => !(e instanceof ReadFailure) && n < 1 });
  const reported = Array.isArray(reviews.data?.data.items) && reviews.data.data.items.length > 0;
  return <li className="task-claim" data-testid="task-claim" data-id={claim.id}>
    <span dir="auto">{claim.statement}</span>
    {verdict && <span className="task-verdict" data-testid="task-claim-verdict" data-kind={verdict.kind}>{VERDICT_LABEL[verdict.kind]}</span>}
    {' '}<a href={`#/node/${encodeURIComponent(claim.id)}`} data-testid="task-claim-open">원문 열기</a>
    {reported && <p data-testid="task-review-note">제보함 · KB가 다시 확인 중</p>}
  </li>;
}
