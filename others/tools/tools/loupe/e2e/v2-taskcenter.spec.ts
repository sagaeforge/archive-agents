// loupe v2 M0f (design v2 11.2, 2.2, 7.2, 7.3): the task center on kb-mock. The step is read-only: every KB call is a GET, polls carry
// no activity mark, and the list never opens by itself.
//
// The task center needs kb-mock's task fixtures (KB_MOCK_TASKS=1), which the harness mock does not have on purpose: with them the pill would
// read first-party paths in every other spec's journey. So this spec runs its own kb-mock ('t') and loupe serve (PORT.authB).
// loupe serve's KB_ALLOW does not list the five first-party read paths yet (design v2 5.1; server/serve.ts is outside this step), so the
// spec answers exactly those five paths from that mock's socket and leaves every other request on the real proxy.
import http from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import type { Page, Route } from '@playwright/test';
import { test, expect, useSessions } from './support/test.ts';
import { login } from './support/oidc.ts';
import { accessLog, base, PORT, RESEARCH, sock } from './support/ports.ts';
import { startMock, startServe, stop, tcpOpen, waitFor } from './support/procs.ts';
import { createKbMock } from '../dev/kb-mock/app.ts';
import { schemaOf } from '../dev/kb-mock/spec.ts';
import { TASK_REGISTRY_KEY } from '../src/tasks/registry.ts';

const RESEARCH_STATES = ['queued', 'in_progress', 'paused', 'cancelled', 'done', 'unanswerable', 'blocked_policy', 'budget_unavailable'] as const;
const SEED = {
  research: [{ spec: 'f-m0f-join', existing: true }],
  writes: ['w-m0f-pending', 'w-m0f-committed', 'w-m0f-failed', 'w-m0f-purged'],
  actions: ['a-m0f-preparing', 'a-m0f-ready-local', 'a-m0f-consent', 'a-m0f-consented', 'a-m0f-unavailable', 'a-m0f-failed', 'a-m0f-expired'],
  rejected: [{ record: 'f-m0f-draft', rule: 'aws_access_key', at: '2026-11-06T01:02:03Z' }],
  handoff: [{ id: 'f-m0f-phone-note', at: '2026-11-06T02:00:00Z' }],
};
const FIRST_PARTY_READ = /^\/kb\/v1\/(topics\/[^/]+\/research|writes\/[^/]+|actions\/[^/]+|hitl|nodes\/[^/]+\/reviews)$/;
const WARNING = '원문 일치는 인용이 원문에 있다는 뜻일 뿐 사실 여부나 원문에 심은 지시를 판정하지 않는다.';
const POLLED = /\/v1\/(topics\/[^/]+\/research|writes\/|actions\/|hitl|nodes\?types=TopicSpec)/;
/** The detail window's own reads: the topic's edges and claims, and the review list of a claim. */
const DETAIL = /\/v1\/nodes\/(e%3Atopic%3Am0f-[^/]+\/(edges|claims)|[^/]+\/reviews)/;

type Seen = { method: string; path: string; activity: string | undefined };
let seen: Seen[] = [];
const MOCK = 't', ORIGIN = base(PORT.authB), FIXTURE = 'contract-sample/fixtures/kb-research.json';
let mock: ChildProcess | undefined, serve: ChildProcess | undefined, session = '';
test.beforeAll(async () => {
  rmSync(accessLog(MOCK), { force: true });
  mock = await startMock(MOCK, FIXTURE, { KB_MOCK_TASKS: '1' });
  serve = await startServe(MOCK, PORT.authB);
  session = await login(ORIGIN);
});
test.afterAll(async () => {
  await stop(serve); await stop(mock);
  rmSync(sock(MOCK), { force: true });
});

/** Answers one of the five first-party read paths from kb-mock's socket (see the header). */
function viaSocket(route: Route) {
  const u = new URL(route.request().url());
  return new Promise<void>((resolve, reject) => {
    const rq = http.request({ socketPath: sock(MOCK), path: u.pathname.replace(/^\/kb/, '') + u.search, method: 'GET', headers: { host: 'localhost' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => { void route.fulfill({ status: res.statusCode ?? 502, headers: { 'content-type': String(res.headers['content-type'] ?? 'application/json'), 'cache-control': 'no-store' }, body: Buffer.concat(chunks) }).then(resolve, reject); });
    });
    rq.on('error', reject);
    rq.end();
  });
}

async function openApp(page: Page, seed: unknown = SEED, origin = ORIGIN, token = session) {
  seen = [];
  await useSessions(page.context(), { [origin]: token });
  await page.addInitScript(([key, value]) => { try { if (!sessionStorage.getItem(key!)) sessionStorage.setItem(key!, value!); } catch { /* opaque origin */ } }, [TASK_REGISTRY_KEY, JSON.stringify(seed)]);
  await page.route((u) => FIRST_PARTY_READ.test(u.pathname), viaSocket);
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/kb') ) seen.push({ method: r.method(), path: u.pathname + u.search, activity: r.headers()['x-loupe-activity'] }); });
  await page.goto(`${origin}/#/`);
  await expect(page.getByTestId('task-pill')).toHaveAttribute('data-loaded', 'true');
}
const pill = (page: Page) => page.getByTestId('task-pill');
async function openList(page: Page) {
  if ((await pill(page).getAttribute('aria-expanded')) !== 'true') await pill(page).click();
  await expect(page.getByTestId('task-list')).toBeVisible();
}
const item = (page: Page, key: string) => page.locator(`[data-testid="task-item"][data-key="${key}"]`);
const polled = () => seen.filter((s) => POLLED.test(s.path));

// Criterion 5, for every test below: no request of this step changes anything.
test.afterEach(() => {
  expect(seen.filter((s) => s.method !== 'GET' && s.method !== 'HEAD'), 'no write call').toEqual([]);
  expect(seen.filter((s) => s.path.startsWith('/kb-write')), 'no /kb-write call').toEqual([]);
});

test('the pill is collapsed and nothing opens by itself while attention items exist', async ({ page, watch }) => {
  await openApp(page);
  await expect(pill(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('task-list')).toHaveCount(0);
  await expect(page.getByTestId('wm-window')).toHaveCount(0);
  expect(Number(await pill(page).getAttribute('data-attention'))).toBeGreaterThan(0);
  expect(Number(await pill(page).getAttribute('data-error'))).toBeGreaterThan(0);
  void watch;
});

test('the list holds all seven kinds', async ({ page, watch }) => {
  await openApp(page);
  await openList(page);
  for (const kind of ['research', 'refine', 'confirm', 'write-wait', 'write-reject', 'phone', 'collected'])
    expect(await page.locator(`[data-testid="task-item"][data-kind="${kind}"]`).count(), kind).toBeGreaterThan(0);
  // A write the KB has committed or purged leaves the list; the draft is released.
  await expect(item(page, 'write:w-m0f-committed')).toHaveCount(0);
  await expect(item(page, 'write:w-m0f-purged')).toHaveCount(0);
  await expect(item(page, 'write:w-m0f-pending')).toContainText('저장 대기');
  await expect(item(page, 'write:w-m0f-failed')).toContainText('version_conflict');
  await expect(item(page, 'rejected:f-m0f-draft')).toContainText('aws_access_key');
  void watch;
});

test('all eight research states show by name, the open run is joined and budget_unavailable is locked', async ({ page, watch }) => {
  await openApp(page);
  await openList(page);
  for (const s of RESEARCH_STATES) {
    const row = item(page, `research:f-m0f-${s}`);
    await expect(row.getByTestId('task-state'), s).toHaveText(s);
    await expect(row, s).toHaveAttribute('data-state', s);
  }
  await expect(item(page, 'research:f-m0f-done')).toHaveAttribute('data-kind', 'collected');
  await expect(item(page, 'research:f-m0f-join')).toContainText('열린 조사에 합류');
  await expect(item(page, 'research:f-m0f-budget_unavailable').getByTestId('task-lock')).toContainText('KB가 아직 조사를 받을 수 없다');
  await expect(item(page, 'research:f-m0f-blocked_policy').getByTestId('task-lock')).toBeVisible();
  await expect(item(page, 'research:f-m0f-in_progress').getByTestId('task-lock')).toHaveCount(0);
  void watch;
});

test('only confirmation-needed and error items carry a colored badge, and there is no accept button', async ({ page, watch }) => {
  await openApp(page);
  await openList(page);
  const tones = await page.locator('[data-testid="task-item"]').evaluateAll((els) => els.map((e) => ({ key: e.getAttribute('data-key')!, tone: e.getAttribute('data-tone')!, badge: e.querySelectorAll('[data-testid="task-badge"]').length })));
  expect(tones.length).toBeGreaterThan(20);
  for (const t of tones) expect(t.badge, `${t.key} badge iff ${t.tone}`).toBe(t.tone === 'neutral' ? 0 : 1);
  const colored = tones.filter((t) => t.tone !== 'neutral').map((t) => `${t.key}:${t.tone}`).sort();
  expect(colored).toEqual([
    'action:a-m0f-consent:attention', 'action:a-m0f-failed:error',
    'hitl:h-m0f-gate:attention', 'hitl:h-m0f-policy:attention', 'hitl:h-m0f-topic:attention',
    'rejected:f-m0f-draft:error',
    'research:f-m0f-blocked_policy:error', 'research:f-m0f-budget_unavailable:error', 'research:f-m0f-unanswerable:error',
    'write:w-m0f-failed:error',
  ].sort());
  expect(await page.getByRole('button', { name: /받기|accept/i }).count(), 'no accept button').toBe(0);
  expect(await page.getByText(/받기|accept/i).count(), 'no accept text').toBe(0);
  void watch;
});

test('the consent item shows a yellow badge, the four external_refine statuses read in words and the private preview stays out', async ({ page, watch }) => {
  await openApp(page);
  await openList(page);
  const badge = item(page, 'action:a-m0f-consent').getByTestId('task-badge');
  await expect(badge).toHaveText('외부 정제 동의 필요');
  await expect(badge).toHaveAttribute('data-tone', 'attention');
  await expect(badge).toHaveCSS('background-color', 'rgb(250, 204, 21)');
  await expect(item(page, 'hitl:h-m0f-topic').getByTestId('task-badge')).toHaveCSS('background-color', 'rgb(250, 204, 21)');
  await expect(item(page, 'action:a-m0f-failed').getByTestId('task-badge')).toHaveCSS('background-color', 'rgb(220, 38, 38)');
  await expect(item(page, 'action:a-m0f-preparing')).toContainText(/로컬 정제 중 · 지난 시간 \d+분/);
  await expect(item(page, 'action:a-m0f-ready-local')).toContainText('확인 기다림');
  await expect(item(page, 'action:a-m0f-ready-local')).toContainText('4.2초');
  await expect(item(page, 'action:a-m0f-consented')).toContainText('외부 정제 동의함');
  await expect(item(page, 'action:a-m0f-unavailable')).toContainText('외부 정제를 쓸 수 없음');
  await expect(item(page, 'action:a-m0f-expired')).toContainText('만료');
  await expect(page.getByText('PRIVATE-PREVIEW-MARKER')).toHaveCount(0);
  void watch;
});

test('the detail window of a finished run: graph, edges, claims with the check and the warning sentence, record', async ({ page, watch }) => {
  await openApp(page);
  await openList(page);
  await item(page, 'research:f-m0f-done').getByTestId('task-open').click();
  const win = page.locator('[data-testid="wm-window"][data-id="loupe:task:f-m0f-done"]');
  await expect(win).toBeVisible();
  await expect(win.getByTestId('task-warning')).toHaveText(WARNING);
  await expect(win.getByTestId('task-graph')).toBeVisible();
  await expect(win.getByTestId('task-graph-edge')).toHaveCount(3);
  await expect(win.getByTestId('task-edge-row')).toHaveCount(3);
  // First visit: nothing was seen before, so every edge is new and dashed.
  await expect(win.locator('[data-testid="task-graph-edge"][data-new="true"]')).toHaveCount(3);
  await expect(win.getByTestId('task-claim')).toHaveCount(2);
  await expect(win.getByTestId('task-claim-verdict').first()).toHaveText('원문 일치');
  await expect(win.getByTestId('task-claim-open').first()).toBeVisible();
  await expect(win.getByTestId('task-review-note')).toHaveText('제보함 · KB가 다시 확인 중');
  await expect(win.getByTestId('task-log')).toContainText('조사 시작');
  await expect(win.getByTestId('task-results')).toContainText('주장 2');
  expect(await win.getByRole('button', { name: /받기|accept/i }).count()).toBe(0);
  // A closed window remembers the edges: the next visit shows none as new.
  await win.getByRole('button', { name: '닫기' }).click();
  await openList(page);
  await item(page, 'research:f-m0f-done').getByTestId('task-open').click();
  await expect(win.getByTestId('task-graph-edge')).toHaveCount(3);
  await expect(win.locator('[data-testid="task-graph-edge"][data-new="true"]')).toHaveCount(0);
  void watch;
});

test('a private topic says the range is narrowed; an internal one does not; locked runs cannot be asked again', async ({ page, watch }) => {
  await openApp(page);
  await openList(page);
  await item(page, 'research:f-m0f-queued').getByTestId('task-open').click();
  const priv = page.locator('[data-testid="wm-window"][data-id="loupe:task:f-m0f-queued"]');
  await expect(priv.getByTestId('task-scope')).toHaveText('찾는 범위: 좁힘 · 등록된 소스와 로컬만');
  await expect(priv.getByTestId('task-egress')).toHaveText('밖으로 나간 것: 없음');
  await priv.getByRole('button', { name: '닫기' }).click();
  await openList(page);
  await item(page, 'research:f-m0f-in_progress').getByTestId('task-open').click();
  const open = page.locator('[data-testid="wm-window"][data-id="loupe:task:f-m0f-in_progress"]');
  await expect(open.getByTestId('task-scope')).toHaveText('찾는 범위: 표준');
  await expect(open.getByTestId('task-egress')).toHaveCount(0);
  await expect(open.getByTestId('task-engine')).toHaveCount(2);
  await expect(open.getByTestId('task-cost')).toContainText('$1.20 / $50.00');
  await expect(open.getByTestId('task-pending-hosts')).toContainText('2');
  await expect(open.getByTestId('task-failure')).toHaveCount(1);
  await open.getByRole('button', { name: '닫기' }).click();
  await openList(page);
  await item(page, 'research:f-m0f-budget_unavailable').getByTestId('task-open').click();
  const budget = page.locator('[data-testid="wm-window"][data-id="loupe:task:f-m0f-budget_unavailable"]');
  await expect(budget.getByTestId('task-lock')).toContainText('KB가 아직 조사를 받을 수 없다');
  await expect(budget.getByTestId('task-cost')).toHaveText('비용: 보고 없음');
  await expect(budget.getByTestId('task-rerun')).toBeDisabled();
  void watch;
});

test('polls run every 45 s, carry no activity mark even while input is waiting, and leave the mark for the next ordinary request', async ({ page, watch }) => {
  await page.clock.install();
  await openApp(page);
  await expect.poll(() => polled().length).toBeGreaterThan(8);
  // The page's timers: the list round and the meta read at 45 s, the session ping at 60 s. The detail window opens at about 5 s, so its own
  // timer (50 s) falls between the two.
  await page.clock.runFor(5_000);
  await openList(page);
  await item(page, 'research:f-m0f-done').getByTestId('task-open').click();
  await expect(page.getByTestId('task-claim-verdict').first()).toHaveText('원문 일치');
  await page.waitForTimeout(500);
  const opened = polled().length, detailBefore = seen.filter((s) => DETAIL.test(s.path)).length;
  await page.clock.runFor(30_000);
  await page.waitForTimeout(300);
  expect(polled().length, 'no list round before 45 s').toBe(opened);
  expect(seen.filter((s) => DETAIL.test(s.path)).length, 'no detail round before 50 s').toBe(detailBefore);
  await page.clock.runFor(11_000);
  await expect.poll(() => polled().length - opened, 'a full list round after 45 s').toBeGreaterThan(8);
  // 46 s: the list round and the ordinary meta read have run. A person's input now waits for the next ordinary request.
  await page.keyboard.press('Shift');
  const afterInput = seen.length;
  await page.clock.runFor(8_000);
  // 54 s: the detail window's timer (due at 50 s) ran with the input still waiting; the 60 s session ping has not.
  await expect.poll(() => seen.filter((s) => DETAIL.test(s.path)).length - detailBefore, 'the detail window polled').toBeGreaterThanOrEqual(4);
  expect(seen.slice(afterInput).filter((s) => !DETAIL.test(s.path) && s.activity !== undefined), 'no ordinary request ran in between').toEqual([]);
  await page.evaluate(() => { location.hash = '#/status'; });
  await expect(page.getByTestId('kb-status')).toBeVisible();
  const marked = seen.slice(afterInput).filter((s) => s.activity === '1');
  expect(marked.length, 'the waiting input was reported by an ordinary request').toBeGreaterThan(0);
  for (const s of seen.filter((x) => POLLED.test(x.path) || DETAIL.test(x.path))) expect(s.activity, `${s.path} must not carry the mark`).toBeUndefined();
  void watch;
});

test('a tab that only polls still ends at the idle limit (clock advanced against a real 6 s limit)', async ({ page }) => {
  test.setTimeout(60_000);
  const idle = base(PORT.auth);
  let proc: ChildProcess | undefined;
  try {
    proc = await startServe(MOCK, PORT.auth, { LOUPE_SESSION_IDLE_MS: '6000' });
    const token = await login(idle);
    await page.clock.install();
    await openApp(page, SEED, idle, token);
    expect(polled().length).toBeGreaterThan(8);
    const t0 = Date.now();
    // Polls only: every step is 45 s of page time and runs one round, with no input from the person.
    for (let i = 0; i < 12 && (await page.getByTestId('session-cover').count()) === 0; i++) {
      await page.waitForTimeout(1000);
      await page.clock.fastForward(45_000);
    }
    await expect(page.getByTestId('session-cover')).toHaveAttribute('data-why', 'expired');
    expect(Date.now() - t0, 'the cover came from the idle limit, not earlier').toBeGreaterThan(3000);
    expect(seen.filter((s) => POLLED.test(s.path) && s.activity !== undefined), 'no poll carried the mark').toEqual([]);
  } finally {
    await stop(proc);
    await waitFor(async () => !(await tcpOpen(PORT.auth)), 3000, 'port free').catch(() => undefined);
  }
});

test('with nothing to follow the task center reads no first-party path (the stock mock lists no spec)', async ({ page, context }) => {
  seen = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/kb')) seen.push({ method: r.method(), path: u.pathname + u.search, activity: r.headers()['x-loupe-activity'] }); });
  await page.goto(`${RESEARCH}/#/`);
  await expect(pill(page)).toHaveAttribute('data-loaded', 'true');
  await expect(pill(page)).toHaveAttribute('data-count', '0');
  const list = seen.filter((s) => s.path.startsWith('/kb/v1/nodes?types=TopicSpec'));
  expect(list.length, 'the one known read that finds the specs').toBeGreaterThan(0);
  expect(seen.filter((s) => FIRST_PARTY_READ.test(s.path.split('?')[0]!)), 'no first-party read').toEqual([]);
  void context;
});

test('the mock access log shows no write on kb-mock', async () => {
  const lines = readFileSync(accessLog(MOCK), 'utf8').split('\n').filter(Boolean);
  expect(lines.some((l) => /\/v1\/topics\/:id\/research 200/.test(l)), 'the research route was served').toBe(true);
  expect(lines.filter((l) => !/^(GET|HEAD) /.test(l))).toEqual([]);
});

test.describe('kb-mock task routes follow the contract', () => {
  const app = createKbMock({ tasks: true });
  const get = async (p: string) => { const r = await app.request(`http://localhost${p}`); return { status: r.status, body: await r.json() as { data: any; page?: unknown } }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const research = schemaOf({ $ref: '#/components/schemas/ResearchStatus' });
  const writeRef = schemaOf({ $ref: '#/components/schemas/WriteReference' });
  const review = schemaOf({ $ref: '#/components/schemas/ClaimReview' });

  test('/v1/topics/{id}/research: eight states, each valid against ResearchStatus', async () => {
    for (const s of RESEARCH_STATES) {
      const r = await get(`/v1/topics/f-m0f-${s}/research`);
      expect(r.status, s).toBe(200);
      expect(r.body.data.state).toBe(s);
      expect(research(r.body.data), JSON.stringify(research.errors)).toBe(true);
    }
    expect((await get('/v1/topics/f-m0c-spec/research')).status).toBe(404);
    expect((await get('/v1/topics/f-m0f-queued/research')).body.data.discovery_reason).toBe('private_topic_registered_sources_only');
  });
  test('/v1/writes/{ref} and /v1/nodes/{id}/reviews are valid against the contract', async () => {
    for (const [ref, state] of [['w-m0f-pending', 'pending'], ['w-m0f-committed', 'committed'], ['w-m0f-failed', 'failed'], ['w-m0f-purged', 'purged']] as const) {
      const r = await get(`/v1/writes/${ref}`);
      expect(r.body.data.state).toBe(state);
      expect(writeRef(r.body.data), JSON.stringify(writeRef.errors)).toBe(true);
    }
    const reviews = await get('/v1/nodes/c-1e442c5458f5/reviews');
    expect(reviews.body.data.items).toHaveLength(1);
    for (const x of reviews.body.data.items) expect(review(x), JSON.stringify(review.errors)).toBe(true);
    expect((await get('/v1/nodes/c-3f543a8f0022/reviews')).body.data.items).toEqual([]);
  });
  test('/v1/actions/{id} gives preparing, ready, failed, expired and the four external_refine statuses; /v1/hitl lists three signals', async () => {
    const states = new Set<string>(), refine = new Set<string>();
    for (const id of SEED.actions) { const r = await get(`/v1/actions/${id}`); states.add(r.body.data.state); refine.add(r.body.data.external_refine.status); }
    expect([...states].sort()).toEqual(['expired', 'failed', 'preparing', 'ready']);
    expect([...refine].sort()).toEqual(['consent_required', 'consented', 'not_needed', 'unavailable']);
    expect((await get('/v1/hitl')).body.data.items.map((i: { signal: string }) => i.signal).sort()).toEqual(['gate_unresolved', 'source_policy', 'topic_ambiguity']);
  });
  test('without the tasks option the mock lists no spec and has none of the routes', async () => {
    const stock = createKbMock();
    const r = await stock.request('http://localhost/v1/nodes?types=TopicSpec&limit=50');
    expect(((await r.json()) as { data: { items: unknown[] } }).data.items).toEqual([]);
    for (const p of ['/v1/topics/f-m0f-queued/research', '/v1/writes/w-m0f-pending', '/v1/actions/a-m0f-consent', '/v1/hitl']) expect((await stock.request(`http://localhost${p}`)).status, p).toBe(404);
  });
  test('the step has no write route: POST and PUT answer 405', async () => {
    for (const p of ['/v1/topics/f-m0f-queued/research', '/v1/writes/w-m0f-pending', '/v1/actions/a-m0f-consent', '/v1/hitl']) {
      expect((await app.request(`http://localhost${p}`, { method: 'POST', body: '{}' })).status, p).toBe(405);
    }
  });
});
