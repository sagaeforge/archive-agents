// Opt-in M0f data (design v2 11.2): what the task center reads. Research status, write references and the review list follow the KB's
// approved first-party contract (openapi.yaml, x-first-party-paths: ResearchStatus, WriteReference, ClaimReview); the mock checks its own
// answers against those schemas. `GET /v1/actions/{id}` follows ADR-0005 5.10 (L637~646) and `GET /v1/hitl` ADR-0005 6.8 (L842), which
// the contract file does not carry yet: their field names are the ADR's, the nesting of `candidates` is a guess.
// Every route here is a GET. The step is read-only, so a write verb answers 405 like any other read-only path.
import type { Context, Hono } from 'hono';
import type { NodeDetail } from '../../src/client/model/index.ts';

export const RESEARCH_STATES = ['queued', 'in_progress', 'paused', 'cancelled', 'done', 'unanswerable', 'blocked_policy', 'budget_unavailable'] as const;
type State = (typeof RESEARCH_STATES)[number] | 'join';
const AT = '2026-11-05T00:00:00Z';
const common = { origin: 'first_party', sensitivity: 'internal', status: 'active', version: 1, recorded_at: AT, valid: { from: null, to: null }, domain: [], props: {}, claims: [], edges: { in: [], out: [], truncated: false }, backlinks: [] } satisfies Partial<NodeDetail>;

export const specId = (s: State) => `f-m0f-${s}`;
export const topicId = (s: State) => `e:topic:m0f-${s}`;
const url = (s: State) => `/v1/nodes/${topicId(s)}/edges?direction=in&rtypes=IN_TOPIC`;

function research(state: State, over: Record<string, unknown> = {}, runStatus: string = state) {
  return {
    spec: specId(state), topic: topicId(state), state: state === 'join' ? 'in_progress' : state,
    run: { id: `t-m0f-${state}`, status: state === 'join' ? 'in_progress' : runStatus, opened_at: AT },
    engines: [], cost: null, reported: false,
    results: { accepted_claims: 0, edges: 0, needs_review: 0, since: AT, list_url: url(state), review_url: `${url(state)}&include_unverified=true` },
    // A private topic is always narrowed (ADR-0005 L728, L799).
    discovery: 'narrowed', discovery_reason: 'private_topic_registered_sources_only', pending_hosts: 0, failures: [],
    ...over,
  };
}
const spent = (month: string) => ({ month_usd: month, budget_usd_month: '50.00', reported: true, as_of: AT });

export const researchFixtures: Record<string, ReturnType<typeof research>> = {
  [specId('queued')]: research('queued'),
  [specId('in_progress')]: research('in_progress', {
    discovery: 'standard', discovery_reason: null, reported: true, cost: spent('1.20'), pending_hosts: 2,
    engines: [{ kind: 'deterministic', collectors: 3 }, { kind: 'llm', task: 'extract', arm: 'local', calls: 12 }],
    results: { accepted_claims: 2, edges: 3, needs_review: 1, since: AT, list_url: url('in_progress'), review_url: `${url('in_progress')}&include_unverified=true` },
    failures: [{ stage: 'fetch', source: 'src:example-docs', code: 'timeout', at: '2026-11-05T00:10:00Z' }],
  }),
  [specId('paused')]: research('paused', { results: { accepted_claims: 1, edges: 1, needs_review: 0, since: AT, list_url: url('paused'), review_url: `${url('paused')}&include_unverified=true` } }),
  [specId('cancelled')]: research('cancelled'),
  [specId('done')]: research('done', {
    reported: true, cost: spent('0.40'), engines: [{ kind: 'deterministic', collectors: 2 }],
    results: { accepted_claims: 2, edges: 3, needs_review: 0, since: AT, list_url: url('done'), review_url: `${url('done')}&include_unverified=true` },
  }),
  [specId('unanswerable')]: research('unanswerable', { failures: [{ stage: 'extract', source: 'src:example-docs', code: 'no_answer', at: '2026-11-05T00:20:00Z' }, { stage: 'fetch', source: 'src:example-blog', code: 'robots_denied', at: '2026-11-05T00:21:00Z' }] }),
  [specId('blocked_policy')]: research('blocked_policy', { pending_hosts: 1 }),
  // No budget gate yet (FW6): the run was never opened.
  [specId('budget_unavailable')]: research('budget_unavailable', { run: null }),
  // A request that joined an open run (`existing:true` on the POST answer) reads as that run; the joined flag lives in the browser's registry.
  [specId('join')]: research('join', { results: { accepted_claims: 2, edges: 3, needs_review: 0, since: AT, list_url: url('join'), review_url: `${url('join')}&include_unverified=true` } }),
};

const recordOf = (ref: string, state: string, over: Record<string, unknown> = {}) => ({ ref, state, id: 'f-m0f-note1', version: null, code: null, ...over });
export const writeFixtures: Record<string, ReturnType<typeof recordOf>> = {
  'w-m0f-pending': recordOf('w-m0f-pending', 'pending'),
  'w-m0f-committed': recordOf('w-m0f-committed', 'committed', { version: 3 }),
  'w-m0f-failed': recordOf('w-m0f-failed', 'failed', { code: 'version_conflict' }),
  'w-m0f-purged': recordOf('w-m0f-purged', 'purged'),
};

const action = (id: string, state: string, over: Record<string, unknown> = {}, refine: Record<string, unknown> = { status: 'not_needed' }) => ({
  action_id: id, action: 'publish', target: 'f-m0f-note1', expected_version: 2, state,
  created_at: AT, expires_at: null, candidates: [], engine: null, cost_usd: null, duration_ms: null, code: null,
  refinement_mode: 'local_only', external_refine: { external_payload_sha: null, engine: null, request_preview: null, ...refine }, ...over,
});
const local = { kind: 'local', backend: 'ollama', model: 'sllm-8b' };
// The preview is private text. The UI must not print it (it belongs in the consent window, a later step).
const PREVIEW = 'PRIVATE-PREVIEW-MARKER: 이 메모의 정제 요청';
export const actionFixtures: Record<string, ReturnType<typeof action>> = {
  'a-m0f-preparing': action('a-m0f-preparing', 'preparing'),
  'a-m0f-ready-local': action('a-m0f-ready-local', 'ready', { engine: local, cost_usd: '0', duration_ms: 4200, expires_at: '2026-11-05T00:15:00Z' }),
  'a-m0f-consent': action('a-m0f-consent', 'ready', { engine: local, cost_usd: '0', duration_ms: 3100, expires_at: '2026-11-05T00:15:00Z' }, { status: 'consent_required', external_payload_sha: 'f'.repeat(64), engine: { kind: 'external', backend: 'api', model: 'big-1' }, request_preview: PREVIEW }),
  'a-m0f-consented': action('a-m0f-consented', 'preparing', { refinement_mode: 'external_consented' }, { status: 'consented', external_payload_sha: 'f'.repeat(64), engine: { kind: 'external', backend: 'api', model: 'big-1' } }),
  'a-m0f-unavailable': action('a-m0f-unavailable', 'ready', { engine: local, cost_usd: '0', duration_ms: 2500, expires_at: '2026-11-05T00:15:00Z' }, { status: 'unavailable' }),
  'a-m0f-failed': action('a-m0f-failed', 'failed', { code: 'prepare_timeout', duration_ms: 120000 }),
  'a-m0f-expired': action('a-m0f-expired', 'expired', { engine: local, cost_usd: '0', duration_ms: 3000 }),
};

export const hitlItems = [
  { id: 'h-m0f-topic', signal: 'topic_ambiguity', target: topicId('queued'), reason: '주제 범위가 두 갈래로 읽힌다', candidates: [{ id: 'e:topic:m0f-a', label: 'M0f 후보 A', evidence_count: 4 }, { id: 'e:topic:m0f-b', label: 'M0f 후보 B', evidence_count: 2 }], proposed_state: null, created_at: AT },
  { id: 'h-m0f-policy', signal: 'source_policy', target: topicId('in_progress'), reason: '새 출처의 약관 판정이 필요하다', candidates: [], proposed_state: 'approve', created_at: AT },
  { id: 'h-m0f-gate', signal: 'gate_unresolved', target: 'c-1e442c5458f5', reason: '함의 판정이 풀지 못한 주장', candidates: [], proposed_state: null, created_at: AT },
];

export const reviewFixtures: Record<string, { id: string; version: number; verdict: 'reject'; note: string; source_url: string | null }[]> = {
  'c-1e442c5458f5': [{ id: 'f-m0f-review-1', version: 1, verdict: 'reject', note: '출처가 다른 판을 가리킨다', source_url: null }],
};

// Nodes the task center reads by id. They are not listed by the generic typed reads, so the graph and the palette stay as they were.
const label = (s: State) => `M0f 조사 ${s}`;
const states: State[] = [...RESEARCH_STATES, 'join'];
export const taskSpecs: NodeDetail[] = states.map((s) => ({ ...common, id: specId(s), type: 'TopicSpec', label: label(s), body: '작업 센터 시험용 범위.', props: { slug: `m0f-${s}`, aliases: [], export_llm: false, export_query: false } }) as NodeDetail);
export const taskTopics: NodeDetail[] = states.map((s) => ({ ...common, id: topicId(s), type: 'Topic', label: label(s), props: { state: 'active' } }) as NodeDetail);
export const taskRecords: NodeDetail[] = [
  { ...common, id: 'f-m0f-phone-note', type: 'Note', label: 'M0f 폰에서 보낸 메모', body: '폰에서 이어 본다.' } as NodeDetail,
];
export const taskNodes: NodeDetail[] = [...taskSpecs, ...taskTopics, ...taskRecords];

/** The peers a topic's collection graph shows: as many edges as the run reports. */
export const edgesOf = (topic: string) => {
  const run = Object.values(researchFixtures).find((r) => r.topic === topic);
  const n = run?.results.edges ?? 0;
  return Array.from({ length: n }, (_, i) => ({
    id: `r-m0f-${topic.slice('e:topic:m0f-'.length)}-${i + 1}`, rtype: 'IN_TOPIC', src: `e:tool:m0f-peer-${i + 1}`, dst: topic, status: 'active', claim_id: null,
    peer: { id: `e:tool:m0f-peer-${i + 1}`, type: 'Tool', label: `M0f 수집 ${i + 1}` },
  }));
};
/** Claims that arrived. They are real claims of the research fixture, so the viewer's quote check has text to find them in. */
export const CLAIM_IDS = ['c-1e442c5458f5', 'c-ecfb958d5519'];
export const claimCountOf = (topic: string) => Object.values(researchFixtures).find((r) => r.topic === topic)?.results.accepted_claims ?? 0;
export const isTaskTopic = (id: string) => taskTopics.some((n) => n.id === id);

type Env = { json: (c: Context, data: unknown, page?: unknown) => Response; gate: (c: Context) => Response | null; problem: (c: Context, status: number, code: string, title: string, detail?: string) => Response };
/** Adds the five read routes. `gate` is the mock's common check (host, token, not-ready). */
export function registerTaskRoutes(app: Hono, env: Env): void {
  const route = (path: string, params: string[], find: (c: Context) => unknown | undefined, page?: (data: unknown) => unknown) => {
    app.get(path, (c) => {
      const refused = env.gate(c);
      if (refused) return refused;
      for (const name of new URL(c.req.url).searchParams.keys()) if (!params.includes(name)) return env.problem(c, 400, 'bad_param', 'unknown parameter', name);
      const data = find(c);
      return data === undefined ? env.problem(c, 404, 'not_found', 'not found') : env.json(c, data, page?.(data));
    });
    app.all(path, (c) => env.problem(c, 405, 'method_not_allowed', 'method not allowed'));
  };
  const count = (d: unknown) => ({ next_cursor: null, total: (d as { items: unknown[] }).items.length, truncated: false });
  route('/v1/topics/:id/research', [], (c) => researchFixtures[c.req.param('id')!]);
  route('/v1/writes/:ref', [], (c) => writeFixtures[c.req.param('ref')!]);
  // The elapsed time is the point of "preparing": a fixed timestamp would read as days.
  route('/v1/actions/:id', [], (c) => {
    const a = actionFixtures[c.req.param('id')!];
    return a && a.state === 'preparing' ? { ...a, created_at: new Date(Date.now() - 95_000).toISOString().replace(/\.\d+Z$/, 'Z') } : a;
  });
  route('/v1/hitl', ['kind', 'cursor'], () => ({ items: hitlItems }), count);
  route('/v1/nodes/:id/reviews', ['cursor'], (c) => ({ items: reviewFixtures[c.req.param('id')!] ?? [] }), count);
}
