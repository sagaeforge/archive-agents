// One polled read of everything the task center shows (design v2 7.2: 45 s, in the background). The mark X-Loupe-Activity is never sent
// (api.ts), so a tab left open on this list cannot keep the session alive.
import { useQuery } from '@tanstack/react-query';
import { parseKbId } from '../ids.ts';
import { useTimeBasis } from '../time/useTimeBasis.ts';
import { axesOf, ReadFailure, readKb, readOrNull, seg, withAxes } from './api.ts';
import { readRegistry } from './registry.ts';
import { emptyTasks, type ActionStatus, type HitlItem, type ResearchStatus, type TasksData, type WriteRef } from './model.ts';

export const TASKS_POLL_MS = 45_000;
export const TASKS_KEY = ['loupe', 'tasks'] as const;

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const numOr = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const okId = (v: unknown): v is string => typeof v === 'string' && parseKbId(v).ok;

function research(raw: unknown): ResearchStatus | null {
  const r = rec(raw), res = rec(r.results), run = r.run === null ? null : rec(r.run), cost = r.cost === null ? null : rec(r.cost);
  if (!okId(r.spec) || !okId(r.topic) || typeof r.state !== 'string') return null;
  return {
    spec: r.spec, topic: r.topic, state: r.state,
    run: run && typeof run.id === 'string' ? { id: run.id, status: str(run.status), opened_at: str(run.opened_at) } : null,
    engines: list(r.engines).map((e) => { const x = rec(e); return { kind: str(x.kind), ...(typeof x.collectors === 'number' ? { collectors: x.collectors } : {}), ...(typeof x.task === 'string' ? { task: x.task } : {}), ...(typeof x.arm === 'string' ? { arm: x.arm } : {}), ...(typeof x.calls === 'number' ? { calls: x.calls } : {}) }; }),
    cost: cost && typeof cost.month_usd === 'string' ? { month_usd: cost.month_usd, budget_usd_month: str(cost.budget_usd_month), reported: cost.reported === true, as_of: str(cost.as_of) } : null,
    results: { accepted_claims: numOr(res.accepted_claims), edges: numOr(res.edges), needs_review: numOr(res.needs_review), since: str(res.since) },
    discovery: str(r.discovery, 'standard'), discovery_reason: typeof r.discovery_reason === 'string' ? r.discovery_reason : null, pending_hosts: numOr(r.pending_hosts),
    failures: list(r.failures).slice(0, 20).map((f) => { const x = rec(f); return { stage: str(x.stage), source: str(x.source), code: str(x.code), at: str(x.at) }; }),
  };
}
function write(raw: unknown): WriteRef | null {
  const w = rec(raw);
  return okId(w.ref) && typeof w.state === 'string' ? { ref: w.ref, state: w.state, id: str(w.id), version: typeof w.version === 'number' ? w.version : null, code: typeof w.code === 'string' ? w.code : null } : null;
}
function action(raw: unknown): ActionStatus | null {
  const a = rec(raw), engine = a.engine === null ? null : rec(a.engine);
  return okId(a.action_id) && typeof a.state === 'string' ? {
    action_id: a.action_id, state: a.state, target: str(a.target), created_at: str(a.created_at), code: typeof a.code === 'string' ? a.code : null, refinement_mode: str(a.refinement_mode, 'local_only'),
    engine: engine && typeof engine.kind === 'string' ? { kind: engine.kind, ...(typeof engine.backend === 'string' ? { backend: engine.backend } : {}), ...(typeof engine.model === 'string' ? { model: engine.model } : {}) } : null,
    cost_usd: typeof a.cost_usd === 'string' ? a.cost_usd : null, duration_ms: typeof a.duration_ms === 'number' ? a.duration_ms : null,
    external_refine: { status: str(rec(a.external_refine).status, 'not_needed') },
  } : null;
}
function hitl(raw: unknown): HitlItem | null {
  const h = rec(raw);
  return okId(h.id) && typeof h.signal === 'string' ? { id: h.id, signal: h.signal, target: str(h.target), reason: str(h.reason) } : null;
}

// A record's name is read once per tab: it does not change under a task, and a poll should not re-ask for it.
const names = new Map<string, string | null>();
async function nameOf(id: string, axes: string, signal?: AbortSignal): Promise<string | null> {
  const key = `${id}|${axes}`;
  if (names.has(key)) return names.get(key)!;
  const r = await readOrNull<{ label?: unknown }>(withAxes(`/v1/nodes/${seg(id)}?include=claims&claim_limit=1`, axes), signal).catch(() => null);
  const label = r && typeof r.data.label === 'string' ? r.data.label : null;
  names.set(key, label);
  return label;
}
const all = async <T extends object>(xs: readonly string[], one: (x: string) => Promise<T | null>): Promise<T[]> => (await Promise.all(xs.map(one))).filter((x): x is Awaited<T> => x !== null);

/** `axes` is the page's time basis as a query string (axesOf): only the node reads take it. The research, write, action and review reads are about now. */
export async function loadTasks(axes: string, signal?: AbortSignal): Promise<TasksData> {
  const reg = readRegistry();
  const listed = await readKb<{ items?: unknown }>(withAxes('/v1/nodes?types=TopicSpec&limit=50', axes), signal);
  const labels = new Map<string, string>();
  for (const n of list(listed.data.items)) { const x = rec(n); if (okId(x.id)) labels.set(x.id, str(x.label, x.id)); }
  const existing = new Set(reg.research.filter((r) => r.existing).map((r) => r.spec));
  const specs = [...new Set([...labels.keys(), ...reg.research.map((r) => r.spec)])];
  // Nothing to follow (no spec the KB lists, no write or action this tab started): the HITL list is not read either, so a KB that does not
  // serve the first-party reads yet (approved, not deployed) sees no request for them. Research, write and action reads follow their lists anyway.
  const follows = specs.length > 0 || reg.writes.length > 0 || reg.actions.length > 0;
  const [rows, writes, actions, hitlRes] = await Promise.all([
    all(specs, async (spec) => {
      const r = await readOrNull<unknown>(`/v1/topics/${seg(spec)}/research`, signal);
      const status = r ? research(r.data) : null;
      return status ? { spec, status } : null;
    }),
    all(reg.writes, async (ref) => { const r = await readOrNull<unknown>(`/v1/writes/${seg(ref)}`, signal); return r ? write(r.data) : null; }),
    all(reg.actions, async (id) => { const r = await readOrNull<unknown>(`/v1/actions/${seg(id)}`, signal); return r ? action(r.data) : null; }),
    // A reviewer scope the token may not have: the list is then empty, not an error.
    !follows ? Promise.resolve(null) : readOrNull<{ items?: unknown }>('/v1/hitl', signal).catch((e: unknown) => { if (e instanceof ReadFailure && e.status === 501) return null; throw e; }),
  ]);
  const research_ = await Promise.all(rows.map(async ({ spec, status }) => ({ spec, label: labels.get(spec) ?? (await nameOf(spec, axes, signal)) ?? spec, existing: existing.has(spec), status })));
  const handoff = await Promise.all(reg.handoff.map(async (h) => ({ id: h.id, at: h.at, label: await nameOf(h.id, axes, signal) })));
  return {
    ...emptyTasks(), research: research_, writes, actions,
    hitl: list(hitlRes?.data.items).map(hitl).filter((h): h is HitlItem => h !== null),
    rejected: reg.rejected, handoff,
  };
}

/** `poll` is for the one observer that owns the timer; the detail window reads the same cache and adds no second timer. */
export function useTasks(poll = false) {
  const axes = axesOf(useTimeBasis());
  return useQuery({
    queryKey: [...TASKS_KEY, axes], queryFn: ({ signal }) => loadTasks(axes, signal), staleTime: poll ? 0 : TASKS_POLL_MS,
    refetchInterval: poll ? TASKS_POLL_MS : false, refetchOnMount: poll ? true : false,
  });
}
