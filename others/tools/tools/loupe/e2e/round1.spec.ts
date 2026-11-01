// Round 1 of the review fixes: the behaviors that need a browser. Reads that must fail or be slow are made so with page.route,
// because the fixture KB never does. Each test names the defect it pins.
import { test, expect } from './support/test.ts';
import { RESEARCH, PORT } from './support/ports.ts';
import { fixture, rewriteKb, settled } from './support/app.ts';

const node = (id: string, q = '') => `${RESEARCH}/#/node/${encodeURIComponent(id)}${q}`;
const SIGMA = 'e:library:sigma-js';
const LONG = 'n-b0b5bb5257562d33';
const DEEP = `${RESEARCH}/#/source/${LONG}?claim=c-7f1f71224a5a&ev=ev-9a53c815`;
const prob = (status: number, code: string, retryAfter?: string) => ({
  status, contentType: 'application/problem+json', headers: (retryAfter ? { 'retry-after': retryAfter } : {}) as Record<string, string>,
  body: JSON.stringify({ type: 'about:blank', title: code, status, code }),
});

test.describe('a failed background read keeps the screen (defect: error card replaced a cached screen)', () => {
  test('entity page: going back to a cached entity while reads fail keeps its title and cards, and says so beside them', async ({ page, watch }) => {
    await page.goto(node(SIGMA));
    await expect(page.getByTestId('claim-card').first()).toBeVisible();
    await page.locator('[data-testid=edges-out] [data-testid=edge-link]').first().click();
    await expect(page.getByTestId('node-title')).not.toHaveText('sigma.js');
    await page.route((u) => u.pathname.startsWith('/kb/v1/nodes/'), (r) => r.fulfill(prob(503, 'read_timeout')));
    await page.goBack();
    await expect(page.getByTestId('node-title')).toHaveText('sigma.js');
    await expect(page.getByTestId('stale-error')).toBeVisible();
    await expect(page.getByTestId('stale-error')).toContainText('KB 읽기 시간 초과');
    await expect(page.getByTestId('claim-card').first()).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('node-title')).toHaveText('sigma.js');
    void watch;
  });

  test('claim page: the same', async ({ page, watch }) => {
    await page.goto(node('c-1e442c5458f5'));
    await expect(page.getByTestId('claim-page')).toBeVisible();
    await page.getByTestId('claim-subject').click();
    await expect(page.getByTestId('entity-page')).toBeVisible();
    await page.route((u) => u.pathname.startsWith('/kb/v1/claims/'), (r) => r.fulfill(prob(503, 'read_timeout')));
    await page.goBack();
    await expect(page.getByTestId('claim-page')).toBeVisible();
    await expect(page.getByTestId('claim-card')).toBeVisible();
    await expect(page.getByTestId('stale-error')).toBeVisible();
    void watch;
  });

  test('source page: a window that fails to load leaves the text and the highlight, and offers a retry', async ({ page, watch }) => {
    let texts = 0;
    await page.route((u) => /\/kb\/v1\/snapshots\/[^/]+\/text$/.test(u.pathname), async (r) => {
      // the first two reads are the quote check and the opening window; the next one (reading on) fails
      if (++texts <= 2) return r.fallback();
      return r.fulfill(prob(503, 'read_timeout'));
    });
    await page.goto(`${RESEARCH}/#/source/n-198da44f5f7ce10d?claim=c-1e442c5458f5&ev=ev-4c34c6cf`);
    await expect(page.getByTestId('source-text')).toBeVisible();
    const before = (await page.getByTestId('source-text').textContent())!.length;
    await page.getByTestId('read-after').getByRole('button').click();
    await expect(page.getByTestId('stale-error')).toBeVisible();
    expect((await page.getByTestId('source-text').textContent())!.length).toBe(before);
    expect(await page.evaluate(() => CSS.highlights?.get('loupe-quote')?.size ?? 0)).toBeGreaterThan(0);
    await expect(page.getByTestId('quote-panel')).toBeVisible();
    void watch;
  });
});

test('503 not_ready on the claim and the text is waited out, not shown as an error (defect: retry:false)', async ({ page, watch }) => {
  const seen = { claim: 0, text: 0 };
  await page.route((u) => /^\/kb\/v1\/claims\//.test(u.pathname), (r) => (++seen.claim === 1 ? r.fulfill(prob(503, 'not_ready', '1')) : r.fallback()));
  await page.route((u) => /\/text$/.test(u.pathname), (r) => (++seen.text === 1 ? r.fulfill(prob(503, 'not_ready', '1')) : r.fallback()));
  await page.goto(`${RESEARCH}/#/source/n-198da44f5f7ce10d?claim=c-1e442c5458f5&ev=ev-4c34c6cf`);
  await expect(page.getByTestId('quote-panel')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('source-text')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('quote-verdict')).toHaveText('원문 일치');
  expect(seen.claim).toBeGreaterThan(1); expect(seen.text).toBeGreaterThan(1);
  void watch;
});

test('"인용 전체 확인" with every read failing says so (defect: 3건 확인했다 with no verdict)', async ({ page, watch }) => {
  test.setTimeout(90_000);
  let failing = true;
  await page.route((u) => /\/text$/.test(u.pathname), (r) => (failing ? r.fulfill(prob(429, 'rate_limited', '1')) : r.fallback()));
  await page.goto(node(SIGMA));
  await expect(page.getByTestId('claim-card').first()).toBeVisible();
  await page.getByTestId('check-all').click();
  await expect(page.getByTestId('check-all-result')).toContainText('읽지 못해 확인하지 못했다', { timeout: 60_000 });
  await expect(page.getByTestId('check-all')).toHaveText('다시 확인');
  await expect(page.getByTestId('verdict')).toHaveCount(0);
  // the re-run works once the reads do
  failing = false;
  await page.getByTestId('check-all').click();
  await expect(page.getByTestId('check-all')).toContainText('확인했다', { timeout: 30_000 });
  expect(await page.getByTestId('verdict').count()).toBeGreaterThan(0);
  void watch;
});

test.describe('cards that are no longer current', () => {
  test('a superseded card does not offer the observed-at button; the claim page offers it at the first version', async ({ page, watch }) => {
    const rows = fixture('kb-research.json').claims.filter((c: { id: string }) => c.id === 'c-4c2e31e4ac9b') as { version: number; recorded_at: string }[];
    const first = rows.sort((a, b) => a.version - b.version)[0]!.recorded_at;
    await page.goto(node(SIGMA, '?status=all'));
    const card = page.locator('[data-claim=c-4c2e31e4ac9b]');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('to-observed')).toHaveCount(0);
    await expect(card.getByTestId('claim-replaced-at')).toContainText('대체 기록');
    await page.goto(node('c-4c2e31e4ac9b'));
    const own = page.locator('[data-testid=claim-page] [data-testid=claim-card]');
    await own.hover();
    await expect(own.getByTestId('claim-observed')).toContainText('관측');
    await own.getByTestId('to-observed').click();
    await expect(page).toHaveURL(new RegExp(`as_of_observed=${first.replaceAll(':', '(:|%3A)')}`));
    void watch;
  });

  test('a status inherited from a superseded subject is not called 철회', async ({ page, watch }) => {
    await rewriteKb(page, /\/history/, (b) => { for (const c of b.data.chains) for (const i of c.items) i.superseded_by = null; });
    await rewriteKb(page, /^\/kb\/v1\/nodes\/e%3Alibrary%3Asigma-js\?[^]*claim_limit=1(&|$)/, (b) => { b.data.status = 'superseded'; });
    await page.goto(node(SIGMA, '?status=all'));
    const card = page.locator('[data-claim=c-4c2e31e4ac9b]');
    await card.getByTestId('find-successor').click();
    await expect(card.getByTestId('state-chip')).toHaveText('주어 상태 때문에 가려짐');
    await expect(card.getByTestId('state-chip')).not.toHaveText('철회');
    void watch;
  });
});

test('the claim page marks its versions in a past view and names states in Korean (defects: no 현재 기준, active/superseded)', async ({ page, watch }) => {
  await page.goto(node('c-4c2e31e4ac9b', '?as_of_observed=2026-10-31T12:00:00Z'));
  await expect(page.getByTestId('claim-versions')).toBeVisible();
  await expect(page.getByTestId('versions-now')).toHaveText('현재 기준');
  await expect(page.locator('[data-testid=claim-versions] tr[data-after-basis]')).toHaveCount(1);
  await expect(page.getByTestId('claim-versions')).toContainText('대체됨');
  await expect(page.getByTestId('claim-versions')).not.toContainText('superseded');
  await expect(page.getByTestId('claim-versions').locator('th')).toContainText(['관측']);
  void watch;
});

test.describe('the time basis', () => {
  const band = (page: import('@playwright/test').Page) => page.getByTestId('time-band');
  test('the band does not call a future date or the held present "past", and a valid-only basis says what it is', async ({ page, watch }) => {
    await page.goto(node(SIGMA, '?as_of_valid=2030-01-01T00:00:00Z'));
    await expect(band(page)).toContainText('시점 고정');
    await expect(page).toHaveTitle(/^\[시점 고정\] /);
    await page.goto(node(SIGMA, '?as_of_observed=2026-10-31T23:00:00Z'));
    await expect(band(page)).toContainText('시점 고정');
    await page.goto(node(SIGMA, '?as_of_valid=2026-10-28T00:00:00Z'));
    await expect(band(page)).toContainText('지금 아는 내용으로 본 시점');
    await expect(band(page)).toContainText('유효 2026-10-28');
    await expect(band(page)).not.toContainText('과거 보기');
    await page.goto(node(SIGMA, '?as_of_observed=2026-10-31T12:00:00Z'));
    await expect(band(page)).toContainText('과거 보기');
    await expect(page).toHaveTitle(/^\[과거\] /);
    void watch;
  });

  test('the palette puts 관측 first, explains both rows, and a date typed then Enter sets the observed axis', async ({ page, watch }) => {
    await page.goto(node(SIGMA));
    await page.getByTestId('claim-card').first().waitFor();
    await page.keyboard.press('Control+k');
    await page.keyboard.type('2026-10-28');
    await expect(page.getByTestId('cmd-observed')).toContainText('그때까지 무엇을 알고 있었나');
    await expect(page.getByTestId('cmd-valid')).toContainText('그날 어떤 사실이었나');
    const rows = await page.locator('[data-testid=cmd-observed], [data-testid=cmd-valid]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(rows).toEqual(['cmd-observed', 'cmd-valid']);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/as_of_observed=/);
    await expect(page).not.toHaveURL(/as_of_valid=/);
    void watch;
  });

  test('in a past view the palette keeps 현재로 under any typed text and says what it searched', async ({ page, watch }) => {
    await page.goto(`${RESEARCH}/#/?as_of_observed=2026-10-31T00:00:00Z`);
    await page.getByTestId('brand').waitFor();
    await page.keyboard.press('Control+k');
    await page.keyboard.type('없는말없는말', { delay: 5 });
    await expect(page.getByTestId('palette-empty')).toContainText('관측 2026-10-31 09:00 KST');
    await expect(page.getByTestId('cmd-present')).toBeVisible();
    void watch;
  });

  test('applying the chip without an edit leaves the URL as it was', async ({ page, watch }) => {
    const url = node(SIGMA, '?as_of_valid=2026-10-28T12:30:00Z&as_of_observed=2026-10-31T12:30:00.123Z');
    await page.goto(url);
    await page.getByTestId('claim-card').first().waitFor();
    const before = page.url();
    await page.getByTestId('time-chip').click();
    await page.getByTestId('time-apply').click();
    await expect(page.getByTestId('time-form')).toHaveCount(0);
    expect(page.url()).toBe(before);
    // an edit to one input changes that axis only
    await page.getByTestId('time-chip').click();
    await page.getByTestId('time-valid').fill('2026-02-01');
    await page.getByTestId('time-apply').click();
    await expect(page).toHaveURL(/as_of_valid=2026-02-01T00(:|%3A)00(:|%3A)00Z/);
    await expect(page).toHaveURL(/as_of_observed=2026-10-31T12(:|%3A)30(:|%3A)00\.123Z/);
    void watch;
  });

  test('changing the basis keeps the reader where they are (defect: scroll reset to 0)', async ({ page, watch }) => {
    await page.goto(`${DEEP}&as_of_observed=2026-10-31T22:55:00Z`);
    await expect(page.getByTestId('quote-marker')).toBeVisible();
    await settled(page);
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(100);
    await page.getByTestId('band-present').click();
    await expect(page).not.toHaveURL(/as_of_observed/);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(before - 150);
    await expect(page.getByTestId('quote-marker')).toBeInViewport();
    void watch;
  });
});

test.describe('the source page', () => {
  test('opening at a quote puts focus on the quote, so Tab continues from it (defect: focus stayed on body)', async ({ page, watch }) => {
    await page.goto(DEEP);
    await expect(page.getByTestId('quote-marker')).toBeVisible();
    await expect(page.getByTestId('quote-marker')).toBeFocused();
    const y = await page.evaluate(() => window.scrollY);
    expect(y).toBeGreaterThan(100);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(y - 150);
    void watch;
  });

  test('the quote panel names the document and the KB verdict, and an unsupported claim is not shown as plain 원문 일치', async ({ page, watch }) => {
    await rewriteKb(page, /^\/kb\/v1\/claims\/c-7f1f71224a5a/, (b) => { b.data.verification = 'needs_review'; for (const e of b.data.evidence) e.support_check = 'unsupported'; });
    await page.goto(DEEP);
    await expect(page.getByTestId('quote-verdict')).toHaveText('원문 일치');
    await expect(page.getByTestId('quote-source')).toContainText('수집');
    await expect(page.getByTestId('quote-source')).toContainText((await page.getByTestId('source-label').textContent())!);
    await expect(page.getByTestId('quote-unsupported')).toHaveText('원문이 뒷받침하지 않음');
    await expect(page.getByTestId('quote-unverified')).toBeVisible();
    await expect(page.getByTestId('quote-kb')).toContainText('KB 판정');
    void watch;
  });

  test('below 62rem the claim and the verdict stay in view next to the highlight', async ({ page, watch }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(DEEP);
    await expect(page.getByTestId('quote-marker')).toBeVisible();
    await settled(page);
    await expect(page.getByTestId('quote-panel')).toBeInViewport();
    await expect(page.getByTestId('quote-verdict')).toBeInViewport();
    await expect(page.getByTestId('quote-marker')).toBeInViewport();
    void watch;
  });

  test('citing rows say what they do, and the list is named for what it holds', async ({ page, watch }) => {
    await page.goto(`${RESEARCH}/#/source/n-198da44f5f7ce10d?claim=c-1e442c5458f5&ev=ev-4c34c6cf`);
    await expect(page.getByTestId('citing')).toContainText('이 문서의 인용');
    await expect(page.getByTestId('citing')).not.toContainText('이 문서를 인용한 주장');
    const rows = await page.getByTestId('citing-row').allTextContents();
    expect(rows.some((t) => t.includes('인용 보기') && t.includes('자 위치'))).toBe(true);
    // a row opens its own position: the link carries the evidence id or the position
    const hrefs = await page.getByTestId('citing-row').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    const withPosition = await page.getByTestId('citing-row').filter({ hasText: '자 위치' }).evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    expect(withPosition.length).toBeGreaterThan(0);
    expect(withPosition.every((h) => /(ev|pos)=/.test(h ?? ''))).toBe(true);
    void hrefs;
    void watch;
  });
});

test.describe('the entity page', () => {
  test('a pill never moves under the pointer, and the verdict goes to the meta line', async ({ page, watch }) => {
    await page.goto(node(SIGMA));
    const pills = page.getByTestId('evidence-pill');
    await expect(pills.first()).toBeVisible();
    const n = await pills.count();
    for (let i = 0; i < n; i++) {
      const p = pills.nth(i);
      // Position in the document: hovering may scroll the page, and that is not the pill moving.
      const at = () => p.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY }; });
      const a = await at();
      await p.hover();
      await expect(page.getByTestId('pill-tip').last()).toBeVisible();
      await page.waitForTimeout(250);
      expect(await at(), `pill ${i} moved`).toEqual(a);
      await page.mouse.move(0, 0);
    }
    await expect(page.locator('.pill-wrap [data-testid=verdict]')).toHaveCount(0);
    expect(await page.locator('.claim-meta [data-testid=verdict]').count()).toBeGreaterThan(0);
    void watch;
  });

  test('keyboard focus on a pill does not move it either', async ({ page, watch }) => {
    await page.goto(node(SIGMA));
    const pills = page.getByTestId('evidence-pill');
    await expect(pills.first()).toBeVisible();
    const at = () => pills.first().evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY }; });
    const a = await at();
    await pills.first().focus();
    await page.waitForTimeout(400);
    expect(await at()).toEqual(a);
    void watch;
  });

  test('the header has a way to the relations, which takes focus (defect: links after every claim)', async ({ page, watch }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(node(SIGMA));
    await expect(page.getByTestId('to-relations')).toContainText('관계');
    await page.getByTestId('to-relations').click();
    await expect(page.getByTestId('relations')).toBeFocused();
    await expect(page.getByTestId('relations')).toBeInViewport();
    void watch;
  });

  test('hovering a card does not cover its meta line', async ({ page, watch }) => {
    await page.goto(node(SIGMA));
    const card = page.getByTestId('claim-card').first();
    await card.hover();
    const meta = await card.locator('.claim-meta').boundingBox();
    const actions = await card.locator('.claim-actions').boundingBox();
    expect(actions!.y).toBeGreaterThanOrEqual(meta!.y + meta!.height - 1);
    void watch;
  });

  test('at 320 px with both axes the group heading is readable and the brand is one line', async ({ page, watch }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(node(SIGMA, '?as_of_valid=2026-10-28T00:00:00Z&as_of_observed=2026-10-31T12:00:00Z'));
    const head = page.locator('.claim-group-head h3').first();
    await expect(head).toBeVisible();
    expect((await head.boundingBox())!.width).toBeGreaterThan(50);
    expect((await page.getByTestId('brand').boundingBox())!.height).toBeLessThan(26);
    void watch;
  });

  test('notes that link here are listed once (defect: the same note three times in one panel)', async ({ page, watch }) => {
    await page.goto(node(SIGMA));
    await page.locator('[data-testid=backlink] a').first().waitFor();
    const ids = await page.locator('[data-testid=backlink] a').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    expect(ids.length).toBeGreaterThan(0);
    for (const href of ids) await expect(page.locator(`[data-testid=edges-in] a[href="${href}"]`)).toHaveCount(0);
    void watch;
  });
});

test.describe('lists and merges', () => {
  test('400 cursor_mismatch reads the list again from the first page and says so (defect: only a card)', async ({ page, watch }) => {
    const calls: string[] = [];
    let failed = false;
    await page.route((u) => /^\/kb\/v1\/nodes\/e%3Aspike%3As1-aggregation\/claims$/.test(u.pathname), (r) => {
      const url = new URL(r.request().url());
      calls.push(url.search);
      if (url.searchParams.has('cursor') && !failed) { failed = true; return r.fulfill(prob(400, 'cursor_mismatch')); }
      // the fixture holds a node's claims in one page, so the page is made to say that there is another
      return r.fetch().then(async (res) => { const body = await res.json(); body.page.next_cursor = 'next-page'; return r.fulfill({ response: res, json: body }); });
    });
    await page.goto(node('e:spike:s1-aggregation'));
    await page.getByTestId('claims-more').click();
    await expect(page.getByTestId('claims-more')).toHaveText('이어 읽기');
    await page.getByTestId('claims-more').click();
    await expect(page.getByTestId('notice')).toContainText('처음부터 다시 읽었다');
    await expect.poll(() => calls.length).toBeGreaterThanOrEqual(3);
    expect(calls[2]).not.toContain('cursor=');
    await expect(page.locator('[data-testid=error-card][data-code=cursor_mismatch]')).toHaveCount(0);
    void watch;
  });

  test('a merge walk that fails offers a retry and then lands on the survivor, keeping the filters', async ({ page, watch }) => {
    let n = 0;
    await page.route((u) => /^\/kb\/v1\/nodes\/e%3Atool%3A1mcp$/.test(u.pathname) && u.searchParams.get('claim_limit') === '1', (r) => (++n <= 4 ? r.fulfill(prob(429, 'rate_limited', '1')) : r.fallback()));
    await page.goto(node('e:tool:1mcp-app', '?status=all&include_unverified=true'));
    const card = page.getByTestId('error-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByRole('button', { name: '다시 시도' })).toBeVisible();
    await card.getByRole('button', { name: '다시 시도' }).click();
    await expect(page.getByTestId('node-title')).toHaveText('1MCP');
    await expect(page).toHaveURL(/status=all/);
    await expect(page).toHaveURL(/include_unverified=true/);
    await expect(page).toHaveURL(/merged_from=/);
    void watch;
  });

  test('a far end that was merged shows the survivor from peer (defect: old slug)', async ({ page, watch }) => {
    await rewriteKb(page, new RegExp(`^/kb/v1/nodes/${encodeURIComponent(SIGMA).replaceAll('%', '%')}\\?[^]*include=`), (b) => {
      const out = b.data.edges?.out ?? [];
      if (out[0]) out[0].peer = { id: 'e:product:new', type: 'Product', label: '새 제품 이름' };
    });
    await page.goto(node(SIGMA));
    const row = page.locator('[data-testid=edges-out] [data-testid=edge-row]').filter({ hasText: '새 제품 이름' });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-far', 'e:product:new');
    void watch;
  });

  test('domain values are separated (defect: GH)', async ({ page, watch }) => {
    await rewriteKb(page, new RegExp(`^/kb/v1/nodes/e%3Alibrary%3Asigma-js\\?[^]*include=`), (b) => { b.data.domain = ['G', 'H']; });
    await page.goto(node(SIGMA));
    await expect(page.getByTestId('node-domain')).toHaveText('G · H');
    void watch;
  });

  test('the record body remainder is read for the time basis it is shown under (defect: current rest under a past head)', async ({ page, watch }) => {
    const NOTE = 'f-01JD2K7Q9T4M8A';
    const bodyCalls: string[] = [];
    await rewriteKb(page, new RegExp(`^/kb/v1/nodes/${NOTE}\\?[^]*include=`), (b) => { b.data.body = 'HEAD-'; b.data.body_chars = 500; });
    await page.route((u) => u.pathname === `/kb/v1/nodes/${NOTE}/body`, (r) => {
      const q = new URL(r.request().url()).searchParams;
      bodyCalls.push(q.toString());
      const asOf = { valid: q.get('as_of_valid'), observed: q.get('as_of_observed') };
      const text = asOf.observed ? 'PAST-REST' : 'CURRENT-REST';
      return r.fulfill({ json: { schema_version: '0.3.0-sample', epoch: 1, build_id: 'g-1', data_as_of: '2026-10-31T23:00:00Z', applied_seq: 1, as_of: asOf, degraded: [], data: { text, start: 5, end: 500, total_chars: 500, text_format: 'markdown' } } });
    });
    await page.goto(node(NOTE, '?as_of_observed=2026-10-31T15:00:00Z'));
    await page.getByTestId('body-more').click();
    await expect(page.getByTestId('record-body')).toContainText('PAST-REST');
    expect(bodyCalls[0]).toContain('as_of_observed=2026-10-31T15%3A00%3A00Z');
    await page.getByTestId('band-present').click();
    await expect(page.getByTestId('record-body')).not.toContainText('PAST-REST');
    await expect(page.getByTestId('record-body')).not.toContainText('CURRENT-REST');
    await page.getByTestId('body-more').click();
    await expect(page.getByTestId('record-body')).toContainText('CURRENT-REST');
    expect(bodyCalls).toHaveLength(2);
    expect(bodyCalls[1]).not.toContain('as_of');
    void watch;
  });
});

test.describe('a denied socket', () => {
  test('is shown as a configuration error: no retry sentence and no further polling (defect: both sentences)', async ({ page, watch }) => {
    let metas = 0;
    await page.route((u) => u.pathname.startsWith('/kb/'), (r) => {
      if (new URL(r.request().url()).pathname === '/kb/v1/meta') metas++;
      return r.fulfill({ status: 502, contentType: 'application/problem+json', body: JSON.stringify({ type: 'x', title: 'kb_socket_denied', status: 502, code: 'kb_socket_denied' }) });
    });
    await page.goto(`${RESEARCH}/#/status`);
    const band = page.getByTestId('offline-band');
    await expect(band).toBeVisible();
    await expect(band).toContainText('다시 시도해도 같다');
    await expect(band).not.toContainText('30초마다 다시 시도한다');
    const seen = metas;
    await page.waitForTimeout(3000);
    expect(metas).toBe(seen);
    void watch;
  });
});

test('the Markdown worker is under the same policy as the page (defect: no connect-src in the worker)', async ({ page, watch }) => {
  await page.goto(`${RESEARCH}/#/source/n-198da44f5f7ce10d?view=rendered`);
  await expect(page.locator('main')).toBeVisible();
  await expect.poll(() => page.workers().length, { timeout: 15_000 }).toBeGreaterThan(0);
  const worker = page.workers()[0]!;
  const result = await worker.evaluate(async (target) => {
    try { await fetch(target, { mode: 'no-cors' }); return 'sent'; } catch { return 'blocked'; }
  }, `http://localhost:${PORT.crossSite}/x`);
  expect(result).toBe('blocked');
  void watch;
});
