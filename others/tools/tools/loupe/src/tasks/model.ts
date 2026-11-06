// What the task center shows, as plain data (design v2 2.2, 3, 7.2, 7.3). No React here: the list and the colors follow from these rules.
import { taskWindowId } from './id.ts';

export type Tone = 'neutral' | 'attention' | 'error';
export type Kind = 'research' | 'refine' | 'confirm' | 'write-wait' | 'write-reject' | 'phone' | 'collected';
export const KIND_LABEL: Record<Kind, string> = { research: '조사', refine: '반영', confirm: '확인 필요', 'write-wait': '저장 대기', 'write-reject': '저장 거절', phone: '폰에서 보냄', collected: '수집 완료' };
const KIND_ORDER = Object.keys(KIND_LABEL) as Kind[];

export const RESEARCH_STATES = ['queued', 'in_progress', 'paused', 'cancelled', 'done', 'unanswerable', 'blocked_policy', 'budget_unavailable'] as const;
export type ResearchState = (typeof RESEARCH_STATES)[number];

export type ResearchStatus = {
  spec: string; topic: string; state: string;
  run: { id: string; status: string; opened_at: string } | null;
  engines: { kind: string; collectors?: number; task?: string; arm?: string; calls?: number }[];
  cost: { month_usd: string; budget_usd_month: string; reported: boolean; as_of: string } | null;
  results: { accepted_claims: number; edges: number; needs_review: number; since: string };
  discovery: string; discovery_reason: string | null; pending_hosts: number;
  failures: { stage: string; source: string; code: string; at: string }[];
};
export type WriteRef = { ref: string; state: string; id: string; version: number | null; code: string | null };
export type ActionStatus = {
  action_id: string; state: string; target: string; created_at: string; code: string | null; refinement_mode: string;
  engine: { kind: string; backend?: string; model?: string } | null; cost_usd: string | null; duration_ms: number | null;
  external_refine: { status: string };
};
export type HitlItem = { id: string; signal: string; target: string; reason: string };

export type TasksData = {
  research: { spec: string; label: string; existing: boolean; status: ResearchStatus }[];
  writes: WriteRef[];
  actions: ActionStatus[];
  hitl: HitlItem[];
  rejected: { record: string; rule: string; at: string }[];
  handoff: { id: string; label: string | null; at: string }[];
};
export const emptyTasks = (): TasksData => ({ research: [], writes: [], actions: [], hitl: [], rejected: [], handoff: [] });

export type TaskItem = {
  key: string; kind: Kind; tone: Tone; title: string; state: string | null;
  /** Only a confirmation-needed or an error item has one (U4). */
  badge: string | null;
  /** A state the user cannot ask again (design v2 7.1): the words, not a button. */
  lock: string | null;
  summary: string[];
  open: { window: string } | { record: string } | null;
};

/** Failure states of a run. The two locked ones also give up the re-request (design v2 7.1). */
const RUN_ERROR: Record<string, { badge: string; lock?: string }> = {
  unanswerable: { badge: '조사 실패' },
  blocked_policy: { badge: '잠김', lock: '정책으로 막혀 다시 요청할 수 없다' },
  budget_unavailable: { badge: '잠김', lock: 'KB가 아직 조사를 받을 수 없다' },
};
export const lockOf = (state: string): string | null => RUN_ERROR[state]?.lock ?? null;

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}시간 ${m % 60}분` : `${Math.floor(h / 24)}일`;
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}초`;
const usd = (v: string | null) => (v === null ? '비용 보고 없음' : `$${v}`);

function researchItem(r: TasksData['research'][number]): TaskItem {
  const s = r.status, err = RUN_ERROR[s.state];
  const summary: string[] = [];
  if (r.existing) summary.push('열린 조사에 합류');
  if (s.state === 'done' || s.results.accepted_claims > 0 || s.results.edges > 0) summary.push(`주장 ${s.results.accepted_claims} · 엣지 ${s.results.edges}`);
  if (s.pending_hosts > 0) summary.push(`승인 대기 출처 ${s.pending_hosts}`);
  return {
    key: `research:${r.spec}`, kind: s.state === 'done' ? 'collected' : 'research', tone: err ? 'error' : 'neutral', title: r.label, state: s.state,
    badge: err?.badge ?? null, lock: err?.lock ?? null, summary, open: { window: taskWindowId(r.spec) },
  };
}
function actionItem(a: ActionStatus, now: number): TaskItem {
  const refine = a.external_refine.status, external = a.refinement_mode === 'external_consented';
  const item: TaskItem = { key: `action:${a.action_id}`, kind: 'refine', tone: 'neutral', title: `반영 · ${a.target}`, state: a.state, badge: null, lock: null, summary: [], open: null };
  const age = duration(now - Date.parse(a.created_at));
  if (a.state === 'preparing') item.summary.push(external ? `외부 정제 동의함 · 정제 중 · 지난 시간 ${age}` : `로컬 정제 중 · 지난 시간 ${age}`);
  else if (a.state === 'ready') {
    const engine = a.engine ? `${a.engine.kind === 'local' ? '로컬' : '외부'}${a.engine.model ? ` ${a.engine.model}` : ''}` : '엔진 알 수 없음';
    item.summary.push(['확인 기다림', engine, usd(a.cost_usd), a.duration_ms === null ? '걸린 시간 알 수 없음' : seconds(a.duration_ms)].join(' · '));
    if (refine === 'consent_required') { item.tone = 'attention'; item.badge = '외부 정제 동의 필요'; }
    if (refine === 'consented') item.summary.push('외부 정제 동의함');
    if (refine === 'unavailable') item.summary.push('외부 정제를 쓸 수 없음 · 로컬 결과로 진행');
  } else if (a.state === 'failed') { item.tone = 'error'; item.badge = '반영 실패'; item.summary.push(a.code ?? '이유 알 수 없음'); }
  else if (a.state === 'expired') item.summary.push('만료');
  if (a.state !== 'ready' && refine === 'consented' && !external) item.summary.push('외부 정제 동의함');
  return item;
}
const plain = (key: string, kind: Kind, title: string, state: string | null, summary: string[], open: TaskItem['open'] = null): TaskItem => ({ key, kind, tone: 'neutral', title, state, badge: null, lock: null, summary, open });

export function buildItems(d: TasksData, now: number): TaskItem[] {
  const items: TaskItem[] = [
    ...d.research.map(researchItem),
    ...d.actions.map((a) => actionItem(a, now)),
    ...d.hitl.map((h): TaskItem => ({ ...plain(`hitl:${h.id}`, 'confirm', h.signal, null, [h.reason]), tone: 'attention', badge: '확인 필요' })),
    // A write the KB has committed (or discarded) leaves the list: the draft is released (design v2 5.9).
    ...d.writes.filter((w) => w.state === 'pending' || w.state === 'failed').map((w): TaskItem =>
      w.state === 'failed'
        ? { ...plain(`write:${w.ref}`, 'write-wait', `저장 · ${w.id}`, w.state, [`저장 실패 · ${w.code ?? '이유 알 수 없음'}`]), tone: 'error', badge: '저장 실패' }
        : plain(`write:${w.ref}`, 'write-wait', `저장 · ${w.id}`, w.state, ['저장 대기 · 보내는 중'])),
    // Record, rule and time only: a refused value or title never comes back to the screen (design v2 3, 7.3).
    ...d.rejected.map((r): TaskItem => ({ ...plain(`rejected:${r.record}`, 'write-reject', r.record, null, [`규칙 ${r.rule}`, new Date(r.at).toLocaleString('ko-KR')]), tone: 'error', badge: '저장 거절' })),
    ...d.handoff.map((h) => plain(`phone:${h.id}`, 'phone', h.label ?? h.id, null, ['폰에서 보냄 · 이어 보기'], { record: h.id })),
  ];
  const rank = (t: Tone) => (t === 'attention' ? 0 : t === 'error' ? 1 : 2);
  return items.sort((a, b) => rank(a.tone) - rank(b.tone) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.key < b.key ? -1 : 1));
}
export const countTones = (items: readonly TaskItem[]) => ({ attention: items.filter((i) => i.tone === 'attention').length, error: items.filter((i) => i.tone === 'error').length });
