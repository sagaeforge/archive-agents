// Honest states: merges, filters, empty, loading, errors, contract signals, and the palette as a keyboard tool.
import { test, expect } from './support/test.ts';
import { RESEARCH, SAMPLE } from './support/ports.ts';
import { highlights, rewriteKb, settled } from './support/app.ts';
import { CONTRACT_STAMP } from '../src/client/stamp.ts';

const node = (id: string, q = '') => `${RESEARCH}/#/node/${encodeURIComponent(id)}${q}`;

test.describe('merge (design 5)', () => {
  test('a merged id lands on the survivor, with a reason, keeping the time basis', async ({ page, watch }) => {
    await page.goto(node('e:tool:1mcp-app', '?as_of_observed=2026-10-31T23:30:00Z'));
    await expect(page).toHaveURL(/#\/node\/e%3Atool%3A1mcp\?/);
    await expect(page).toHaveURL(/as_of_observed=2026-10-31T23/);
    await expect(page.getByTestId('node-title')).toHaveText('1MCP');
    await expect(page.getByTestId('merge-notice')).toContainText('1mcp-app');
    await expect(page.getByTestId('merge-notice')).toContainText('병합');
    await expect(page.getByTestId('time-band')).toBeVisible();
    void watch;
  });
  test('the redirect replaces history: Back does not bounce', async ({ page, watch }) => {
    await page.goto(node('e:library:sigma-js'));
    await page.getByTestId('claim-card').first().waitFor();
    await page.evaluate((id) => { location.hash = `#/node/${encodeURIComponent(id)}`; }, 'e:tool:1mcp-app');
    await expect(page.getByTestId('node-title')).toHaveText('1MCP');
    await page.goBack();
    await expect(page.getByTestId('node-title')).toHaveText('sigma.js');
    void watch;
  });
  test('the notice is part of the URL', async ({ page, watch }) => {
    await page.goto(node('e:tool:1mcp-app'));
    await expect(page.getByTestId('merge-notice')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('merge-notice')).toBeVisible();
    void watch;
  });
  test('claims about the merged ids show on the survivor, naming their subject', async ({ page, watch }) => {
    await page.goto(node('e:tool:1mcp'));
    await expect(page.getByTestId('claim-card').first()).toBeVisible();
    await expect(page.locator('[data-testid=claims]')).toContainText('주어');
    void watch;
  });
  test('a merge cycle is an error screen', async ({ page, watch }) => {
    await rewriteKb(page, /^\/kb\/v1\/nodes\/e%3Atool%3A1mcp(\?|$)/, (b) => { b.data.merged_into = 'e:tool:1mcp-app'; b.data.merged_into_final = 'e:tool:1mcp-app'; });
    await page.goto(node('e:tool:1mcp-app'));
    await expect(page.getByTestId('merge-error')).toBeVisible();
    void watch;
  });
  test('a survivor that is gone is a tombstone', async ({ page, watch }) => {
    await page.route(/\/kb\/v1\/nodes\/e%3Atool%3A1mcp\?/, (r) => r.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ type: 'x', title: 'not found', status: 404, code: 'not_found' }) }));
    await page.goto(node('e:tool:1mcp-app'));
    await expect(page.getByTestId('tombstone')).toContainText('병합됨, 대상 접근 불가');
    void watch;
  });
});

test.describe('filters live in the URL and only the KB filters', () => {
  test('a dead entity shows its toggle first, and its event claim stays', async ({ page, watch }) => {
    await page.goto(node('e:feature:mcp-session-id'));
    await expect(page.getByTestId('node-status')).toHaveText('죽은 데이터');
    await expect(page.locator('[data-claim=c-6ca13d783f7a]')).toBeVisible();
    await expect(page.locator('[data-claim=c-b50f96f66318]')).toHaveCount(0);
    await page.getByTestId('toggle-status').click();
    await expect(page).toHaveURL(/status=all/);
    await expect(page.locator('[data-claim=c-b50f96f66318] [data-testid=state-chip]')).toHaveText('죽은 데이터');
    expect(watch.kbPaths().some((p) => p.includes('status=all'))).toBe(true);
  });
  test('toggling superseded and unverified changes the KB call, and a reload keeps them', async ({ page, watch }) => {
    await page.goto(node('e:library:sigma-js'));
    await page.getByTestId('claim-card').first().waitFor();
    await expect(page.locator('[data-claim=c-4c2e31e4ac9b]')).toHaveCount(0);
    await expect(page.locator('[data-claim=c-32aeb9f6c200]')).toHaveCount(0);
    await page.getByTestId('toggle-status').click();
    await expect(page.locator('[data-claim=c-4c2e31e4ac9b]')).toBeVisible();
    await page.getByTestId('toggle-unverified').click();
    const unverified = page.locator('[data-claim=c-32aeb9f6c200]');
    await expect(unverified.getByTestId('unverified-chip')).toHaveText('미검증');
    await expect(page).toHaveURL(/include_unverified=true/);
    await page.reload();
    await expect(page.getByTestId('toggle-status')).toHaveAttribute('aria-pressed', 'true');
    await expect(unverified).toBeVisible();
    void watch;
  });
  test('a superseded card finds its successor; one with no successor reads as retracted', async ({ page, watch }) => {
    await page.goto(node('e:library:sigma-js', '?status=all'));
    const card = page.locator('[data-claim=c-4c2e31e4ac9b]');
    // Before the history is read the card does not claim to know whether it was replaced or withdrawn.
    await expect(card.getByTestId('state-chip')).toHaveText('현재 값 아님');
    await card.getByTestId('find-successor').click();
    await expect(card.getByTestId('state-chip')).toHaveText('대체됨');
    await card.getByTestId('successor').click();
    await expect(page.getByTestId('claim-page')).toHaveAttribute('data-id', 'c-ecfb958d5519');
    await rewriteKb(page, /\/history/, (b) => { for (const c of b.data.chains) for (const i of c.items) i.superseded_by = null; });
    await page.goto(node('e:library:sigma-js', '?status=all'));
    await page.reload();
    await card.getByTestId('find-successor').click();
    // Exactly one outcome: no successor and an active subject is a withdrawal, and the card no longer says 대체됨 as well.
    await expect(card.getByTestId('state-chip')).toHaveText('철회');
    await expect(card.getByTestId('successor')).toHaveCount(0);
    void watch;
  });
  test('a bad filter value is an error, not a default', async ({ page, watch }) => {
    await page.goto(node('e:library:sigma-js', '?status=everything'));
    await expect(page.getByTestId('route-error')).toBeVisible();
    void watch;
  });
});

test.describe('claim cards', () => {
  test('same predicate, conflicting sources: side by side, no winner', async ({ page, watch }) => {
    await page.goto(node('e:project:sagae-gateway'));
    const g = page.locator('[data-group=cg-gateway-port]');
    await expect(g.getByTestId('claim-card')).toHaveCount(3);
    await expect(g).toContainText('어느 쪽이 맞는지 정하지 않는다');
    void watch;
  });
  test('claims with no predicate go last under 분류 전', async ({ page, watch }) => {
    await page.goto(node('e:library:sigma-js'));
    await page.getByTestId('claim-card').first().waitFor();
    const group = await page.locator('[data-testid=claim-group]').evaluateAll((g) => g.map((x) => x.querySelector('h3')!.textContent));
    if (group.includes('분류 전')) expect(group.at(-1)).toBe('분류 전');
    void watch;
  });
  test('an ended claim keeps its colour and stresses its span; a future one says it is coming', async ({ page, watch }) => {
    await rewriteKb(page, /^\/kb\/v1\/nodes\/e%3Alibrary%3Asigma-js\?/, (b) => {
      b.data.claims[0].valid = { from: '2026-01-01', to: '2026-06-01', precision: 'day', label: null };
      b.data.claims[1].valid = { from: '2099-01-01', to: null, precision: 'day', label: null };
    });
    await page.goto(node('e:library:sigma-js'));
    await expect(page.locator('[data-testid=claim-card][data-state=ended] [data-testid=state-chip]')).toHaveText('유효 종료');
    await expect(page.locator('[data-testid=claim-card][data-state=ended] [data-testid=claim-valid]')).toHaveAttribute('data-emphasis', 'true');
    await expect(page.locator('[data-testid=claim-card][data-state=scheduled] [data-testid=state-chip]')).toHaveText('발효 예정');
    void watch;
  });
  test('an attributed claim puts the speaker first', async ({ page, watch }) => {
    await page.goto(`${RESEARCH}/#/node/c-ee642febf2b5`);
    await expect(page.getByTestId('speaker')).toBeVisible();
    void watch;
  });
  test('evidence that lives only in an old snapshot, or does not support the claim, says so', async ({ page, watch }) => {
    await rewriteKb(page, /^\/kb\/v1\/nodes\/e%3Alibrary%3Asigma-js\?/, (b) => { b.data.claims[0].evidence[0].evidence_state = 'archived_only'; b.data.claims[1].evidence[0].support_check = 'unsupported'; });
    await page.goto(node('e:library:sigma-js'));
    await expect(page.getByTestId('archived-only')).toBeVisible();
    await expect(page.getByTestId('unsupported')).toBeVisible();
    void watch;
  });
  test('a truncated claim list says so and reads on, without duplicates', async ({ page, watch }) => {
    await page.goto(node('e:spike:s1-aggregation'));
    await expect(page.getByTestId('claims-truncated')).toContainText('앞의 50개만 읽었다');
    await expect(page.getByTestId('claim-count')).toHaveText('50+');
    await page.getByTestId('claims-more').click();
    await expect(page.getByTestId('claim-count')).toHaveText('55');
    await expect(page.getByTestId('claims-truncated')).toHaveCount(0);
    const ids = await page.getByTestId('claim-card').evaluateAll((c) => c.map((x) => x.getAttribute('data-claim')));
    expect(ids.length).toBeLessThanOrEqual(55);
    expect(new Set(ids).size).toBe(ids.length);
    void watch;
  });
  test('more than five rows fold behind n개 더', async ({ page, watch }) => {
    await page.goto(node('e:spike:s1-aggregation'));
    await page.getByTestId('claim-card').first().waitFor();
    const more = page.getByTestId('fold-more').first();
    await expect(more).toBeVisible();
    const predicate = await page.locator('[data-testid=claim-group]', { has: more }).first().getAttribute('data-predicate');
    const group = page.locator(`[data-testid=claim-group][data-predicate="${predicate}"]`);
    const before = await group.getByTestId('claim-card').count();
    await more.click();
    expect(await group.getByTestId('claim-card').count()).toBeGreaterThan(before);
    void watch;
  });
  test('a first-party page: body, author, [[id]] links, backlinks', async ({ page, watch }) => {
    await page.goto(node('f-01JD2K7Q9T4M8A'));
    await expect(page.getByTestId('rendered')).toBeVisible();
    await expect(page.getByTestId('author')).toHaveText('user:sagae');
    await expect(page.getByTestId('wikilink').first()).toBeVisible();
    await page.getByTestId('wikilink').first().click();
    await expect(page.getByTestId('entity-page')).toBeVisible();
    await expect(page).not.toHaveURL(/f-01JD2K7Q9T4M8A/);
    void watch;
  });
  test('a body longer than the first read continues through /body', async ({ page, watch }) => {
    await rewriteKb(page, /^\/kb\/v1\/nodes\/f-01JD2K7Q9T4M8A\?/, (b) => { b.data.body = [...b.data.body].slice(0, 40).join(''); });
    await page.goto(node('f-01JD2K7Q9T4M8A'));
    await expect(page.getByTestId('rendered')).toBeVisible();
    await expect(page.getByTestId('rendered')).not.toContainText('지금 걸리는 것');
    await page.getByTestId('body-more').click();
    await expect(page.getByTestId('rendered')).toContainText('지금 걸리는 것');
    await expect(page.getByTestId('body-more')).toHaveCount(0);
    expect(watch.kbPaths().some((p) => p.includes('/body?start=40'))).toBe(true);
  });
  test('backlinks on an entity', async ({ page, watch }) => {
    await page.goto(node('e:library:sigma-js'));
    await expect(page.getByTestId('backlink').first()).toContainText('뷰어 IA 메모');
    void watch;
  });
  test('a truncated relation list reads on through /edges, each direction on its own', async ({ page, watch }) => {
    await rewriteKb(page, /^\/kb\/v1\/nodes\/e%3Alibrary%3Asigma-js\?/, (b) => { b.data.edges.truncated = true; b.data.edges.out = b.data.edges.out.slice(0, 1); b.data.edges.in = []; });
    await page.goto(node('e:library:sigma-js'));
    await expect(page.locator('[data-testid=edges-out] [data-testid=edge-row]')).toHaveCount(1);
    await expect(page.locator('[data-testid=edges-in] [data-testid=edge-row]')).toHaveCount(0);
    await page.getByTestId('edges-more').click();
    await expect(page.locator('[data-testid=edges-out] [data-testid=edge-row]')).toHaveCount(5);
    // Five incoming links in all. A link from a note is listed once, under 노트 백링크, so the two lists together hold the five.
    await expect.poll(async () => (await page.locator('[data-testid=edges-in] [data-testid=edge-row]').count()) + (await page.getByTestId('backlink').count())).toBe(5);
    await expect(page.getByTestId('edges-more')).toHaveCount(0);
    const paths = watch.kbPaths().filter((p) => /\/edges\?/.test(p));
    expect(paths.some((p) => p.includes('direction=out')) && paths.some((p) => p.includes('direction=in'))).toBe(true);
  });
  test('a parallel pair of edges shows as two rows', async ({ page, watch }) => {
    await page.goto(node('e:tool:orval'));
    await expect(page.locator('[data-testid=edges-out] [data-far="e:library:openapi-typescript"]')).toHaveCount(2);
    void watch;
  });
  test('a repo:// url stays text', async ({ page, watch }) => {
    await page.goto(`${RESEARCH}/#/source/n-198da44f5f7ce10d`);
    await expect(page.getByTestId('plain-url')).toContainText('repo://sagae-tools');
    await expect(page.getByTestId('source-url').locator('a')).toHaveCount(0);
    void watch;
  });
});

test.describe('ids that look like routes', () => {
  for (const [id, label] of [['e:feature:history', 'history'], ['e:feature:neighbors', 'neighbors']]) {
    test(`${id} is an entity, not a sub-path`, async ({ page, watch }) => {
      await page.goto(`${SAMPLE}/#/node/${encodeURIComponent(id!)}`);
      await expect(page.getByTestId('entity-page')).toHaveAttribute('data-id', id!);
      await expect(page.getByTestId('node-title')).toContainText(new RegExp(label!, 'i'));
      expect(watch.kbPaths().filter((p) => p.startsWith('/v1/nodes/') && !p.includes('/neighbors?')).every((p) => p.split('?')[0]!.split('/').length === 4)).toBe(true);
    });
  }
});

test('with first_party_open false there is no body, and the page reads the same otherwise', async ({ page, watch }) => {
  await rewriteKb(page, /^\/kb\/v1\/meta/, (b) => { b.data.first_party_open = false; });
  await rewriteKb(page, /^\/kb\/v1\/nodes\/e%3Alibrary%3Asigma-js\?/, (b) => { b.data.body = null; b.data.body_chars = null; b.data.backlinks = []; });
  await page.goto(node('e:library:sigma-js'));
  await expect(page.getByTestId('claim-card').first()).toBeVisible();
  await expect(page.getByTestId('record-body')).toHaveCount(0);
  await expect(page.getByTestId('backlinks')).toHaveCount(0);
  void watch;
});

test.describe('source states', () => {
  test('removed content: metadata stays and the card says what happened', async ({ page, watch }) => {
    await page.goto(`${SAMPLE}/#/source/n-removed00000001`);
    await expect(page.getByTestId('error-card')).toContainText('본문이 삭제됐다');
    await expect(page.getByTestId('source-meta')).toBeVisible();
    void watch;
  });
  test('an image-only PDF has no display body and offers the original', async ({ page, watch }) => {
    await page.goto(`${SAMPLE}/#/source/n-pdfimage00000001`);
    await expect(page.getByText('표시 본문이 없다')).toBeVisible();
    await expect(page.getByTestId('raw-download')).toBeVisible();
    void watch;
  });
  test('a failed claim read is not mistaken for a claim out of view', async ({ page, watch }) => {
    await page.route(/\/kb\/v1\/claims\//, (r) => r.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ type: 'x', title: 'x', status: 503, code: 'read_timeout' }) }));
    await page.goto(`${RESEARCH}/#/source/n-198da44f5f7ce10d?claim=c-1e442c5458f5`);
    await expect(page.getByTestId('error-card')).toContainText('KB 읽기 시간 초과');
    await expect(page.getByTestId('quote-absent')).toHaveCount(0);
    await expect(page.getByTestId('source-text')).toBeVisible();
    void watch;
  });
  test('an unknown text_format reads as plain text', async ({ page, watch }) => {
    await rewriteKb(page, /^\/kb\/v1\/snapshots\/[^/]+(\?|$)/, (b) => { b.data.text_format = 'asciidoc'; });
    await page.goto(`${RESEARCH}/#/source/n-198da44f5f7ce10d`);
    await expect(page.getByTestId('source-text')).toBeVisible();
    await expect(page.getByTestId('tab-rendered')).toHaveCount(0);
    void watch;
  });
  test('a snapshot id under /node goes to the source screen', async ({ page, watch }) => {
    await page.goto(`${RESEARCH}/#/node/n-198da44f5f7ce10d`);
    await expect(page.getByTestId('source-page')).toBeVisible();
    await expect(page).toHaveURL(/#\/source\/n-198da44f5f7ce10d/);
    void watch;
  });
  test('moving between quotes in one document keeps the body and moves the highlight', async ({ page, watch }) => {
    await page.goto(`${RESEARCH}/#/source/n-198da44f5f7ce10d?claim=c-1e442c5458f5`);
    await expect(page.getByTestId('quote-marker')).toBeVisible();
    const row = page.getByTestId('citing-row').nth(1);
    const id = await row.getAttribute('data-id');
    const expected = await row.textContent();
    await settled(page);
    const before = watch.kbPaths().filter((p) => p.includes('/text?start=')).length;
    await row.click();
    await expect(page).toHaveURL(new RegExp(`claim=${id}`));
    await expect.poll(() => highlights(page)).toEqual([expected]);
    await expect(page.locator('[data-testid=citing-row][data-current]')).toHaveAttribute('data-id', id!);
    await settled(page);
    expect(watch.kbPaths().filter((p) => p.includes('/text?start=')).length - before, 'only the check reads').toBeLessThanOrEqual(1);
  });
  test('an unknown snapshot', async ({ page, watch }) => {
    await page.goto(`${RESEARCH}/#/source/n-doesnotexist0000`);
    await expect(page.getByTestId('not-visible-page')).toBeVisible();
    void watch;
  });
});

test.describe('contract signals (design 7.3)', () => {
  test('a major mismatch blocks the whole screen and names both versions', async ({ page, watch }) => {
    await rewriteKb(page, /^\/kb\/v1\//, (b) => { b.schema_version = '1.0.0'; });
    await page.goto(node('e:library:sigma-js'));
    await expect(page.getByTestId('contract-block')).toBeVisible();
    await expect(page.getByTestId('contract-received')).toHaveText('1.0.0');
    await expect(page.getByTestId('contract-supported')).toHaveText(CONTRACT_STAMP.schemaVersion);
    await expect(page.getByTestId('claim-card')).toHaveCount(0);
    void watch;
  });
  test('a minor difference is a chip, not a block', async ({ page, watch }) => {
    // The next minor of the version the client was generated from.
    const [major, minor] = CONTRACT_STAMP.schemaVersion.split('.');
    await rewriteKb(page, /^\/kb\/v1\//, (b) => { b.schema_version = `${major}.${Number(minor) + 1}.0`; });
    await page.goto(node('e:library:sigma-js'));
    await expect(page.getByTestId('minor-warning')).toBeVisible();
    await expect(page.getByTestId('claim-card').first()).toBeVisible();
    void watch;
  });
  test('known degraded values are chips and unknown ones are ignored', async ({ page, watch }) => {
    await rewriteKb(page, /^\/kb\/v1\/meta/, (b) => { b.degraded = ['boot_path_unverified', 'something_new']; });
    await page.goto(node('e:library:sigma-js'));
    await expect(page.getByTestId('degraded')).toHaveCount(1);
    await expect(page.getByTestId('degraded')).toHaveText('기동 경로 미확인');
    void watch;
  });
  test('a sample badge stays on sample data', async ({ page, watch }) => {
    await page.goto(`${RESEARCH}/#/status`);
    await expect(page.getByTestId('sample-badge')).toHaveText('표본 데이터');
    await expect(page.getByTestId('kb-version-verdict')).toHaveText('ok');
    void watch;
  });
  test('a new epoch discards the cache and reads again', async ({ page, watch }) => {
    await page.clock.install();
    let epoch = 1;
    await rewriteKb(page, /^\/kb\/v1\/meta/, (b) => { b.epoch = epoch; });
    await page.goto(node('e:library:sigma-js'));
    await page.getByTestId('claim-card').first().waitFor();
    await settled(page);
    const reads = () => watch.kbPaths().filter((p) => p.startsWith('/v1/nodes/')).length;
    const n = reads();
    epoch = 2;
    await page.clock.fastForward(46_000);
    await expect.poll(reads).toBeGreaterThan(n);
    await expect(page.getByTestId('claim-card').first()).toBeVisible();
  });
  test('a KB that does not confirm the asked time gets a card, not a past label on present data', async ({ page, watch }) => {
    await rewriteKb(page, /^\/kb\/v1\/nodes\//, (b) => { b.as_of = { valid: null, observed: null }; });
    await page.goto(node('e:library:sigma-js', '?as_of_observed=2026-10-31T12:00:00Z'));
    await expect(page.getByTestId('error-card')).toContainText('시점을 확인할 수 없다');
    await expect(page.getByTestId('claim-card')).toHaveCount(0);
    void watch;
  });
  test('410 epoch_changed discards what was cached', async ({ page, watch }) => {
    let n = 0;
    await page.route(/\/kb\/v1\/nodes\/e%3Aspike%3As1-aggregation\/claims/, (r) => (n++ === 0 ? r.fulfill({ status: 410, contentType: 'application/problem+json', body: JSON.stringify({ type: 'x', title: 'epoch changed', status: 410, code: 'epoch_changed' }) }) : r.continue()));
    await page.goto(node('e:spike:s1-aggregation'));
    await page.getByTestId('claims-more').click();
    // Everything starts over from the first page, then reading on works again.
    await expect.poll(() => n).toBeGreaterThan(0);
    await expect(page.getByTestId('claims-more')).toBeVisible();
    await expect(page.getByTestId('error-card')).toHaveCount(0);
    await page.getByTestId('claims-more').click();
    await expect(page.getByTestId('claim-count')).toHaveText('55', { timeout: 6_000 });
    void watch;
  });
  test('a rebuild (build_id alone) does nothing', async ({ page, watch }) => {
    await page.clock.install();
    let build = 'g-000183722-r1ch';
    await rewriteKb(page, /^\/kb\/v1\/meta/, (b) => { b.build_id = build; });
    await page.goto(node('e:library:sigma-js'));
    await page.getByTestId('claim-card').first().waitFor();
    await settled(page);
    const reads = () => watch.kbPaths().filter((p) => p.startsWith('/v1/nodes/')).length;
    const n = reads();
    build = 'g-000183722-new';
    await page.clock.fastForward(46_000);
    await page.waitForTimeout(300);
    expect(reads()).toBe(n);
  });
});

test.describe('KB answers (design 7.4)', () => {
  const problem = (status: number, code: string, headers: Record<string, string> = {}) => ({ status, contentType: 'application/problem+json', headers, body: JSON.stringify({ type: `https://kb.local/problems/${code}`, title: code, status, code }) });
  test('503 not_ready waits Retry-After and shows no band', async ({ page, watch }) => {
    let n = 0;
    await page.route(/\/kb\/v1\/nodes\/e%3Alibrary%3Asigma-js\?/, (r) => (n++ === 0 ? r.fulfill(problem(503, 'not_ready', { 'Retry-After': '1' })) : r.continue()));
    await page.goto(node('e:library:sigma-js'));
    await expect(page.getByTestId('claim-card').first()).toBeVisible({ timeout: 6_000 });
    await expect(page.getByTestId('offline-band')).toHaveCount(0);
    void watch;
  });
  for (const [status, code, title] of [[503, 'read_timeout', 'KB 읽기 시간 초과'], [403, 'host_rejected', '설정 오류'], [401, 'token_required', '설정 오류'], [500, 'internal', 'KB 오류']] as const) {
    test(`${status} ${code} is a card, not an outage`, async ({ page, watch }) => {
      await page.route(/\/kb\/v1\/nodes\/e%3Alibrary%3Asigma-js\?/, (r) => r.fulfill(problem(status, code)));
      await page.goto(node('e:library:sigma-js'));
      await expect(page.getByTestId('error-card')).toContainText(title);
      await expect(page.getByTestId('error-card')).toHaveAttribute('data-code', code);
      await expect(page.getByTestId('offline-band')).toHaveCount(0);
      void watch;
    });
  }
  test('a retry button reads again', async ({ page, watch }) => {
    let n = 0;
    await page.route(/\/kb\/v1\/nodes\/e%3Alibrary%3Asigma-js\?/, (r) => (n++ === 0 ? r.fulfill(problem(503, 'read_timeout')) : r.continue()));
    await page.goto(node('e:library:sigma-js'));
    await page.getByTestId('error-card').getByRole('button').click();
    await expect(page.getByTestId('claim-card').first()).toBeVisible();
    void watch;
  });
  test('a slow answer shows a quiet loading line, then the page', async ({ page, watch }) => {
    await page.route(/\/kb\/v1\/nodes\/e%3Alibrary%3Asigma-js\?/, async (r) => { await new Promise((x) => setTimeout(x, 500)); await r.continue(); });
    await page.goto(node('e:library:sigma-js'));
    await expect(page.getByTestId('loading')).toBeVisible();
    await expect(page.getByTestId('claim-card').first()).toBeVisible();
    void watch;
  });
});

test.describe('palette', () => {
  test('Ctrl+K toggles, / opens but not while typing, Esc closes and focus returns', async ({ page, watch }) => {
    await page.goto(`${RESEARCH}/`);
    await page.getByTestId('home-entity').first().waitFor();
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('palette-input')).toBeFocused();
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('palette-input')).toHaveCount(0);
    await page.keyboard.press('/');
    await expect(page.getByTestId('palette-input')).toBeFocused();
    await page.keyboard.type('a/b');
    await expect(page.getByTestId('palette-input')).toHaveValue('a/b');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('palette-input')).toHaveCount(0);
    void watch;
  });
  test('typing right after the shortcut loses no key, even on the second open', async ({ page, watch }) => {
    await page.goto(`${RESEARCH}/`);
    await page.getByTestId('home-entity').first().waitFor();
    for (const q of ['sigma', 'orval', 'graph']) {
      await page.keyboard.press('Control+k');
      await page.keyboard.type(q);
      await expect(page.getByTestId('palette-input')).toHaveValue(q);
      await page.keyboard.press('Escape');
    }
    void watch;
  });
  test('typing sends one debounced search per pause, not one per key', async ({ page, watch }) => {
    await page.goto(`${RESEARCH}/`);
    await page.getByTestId('home-entity').first().waitFor();
    await page.keyboard.press('Control+k');
    await page.keyboard.type('graphology', { delay: 10 });
    await expect(page.getByTestId('palette-hit').first()).toBeVisible();
    const searches = watch.kbPaths().filter((p) => p.startsWith('/v1/search'));
    expect(searches.length).toBeLessThanOrEqual(2);
    expect(searches.at(-1)).toContain('kinds=entity%2Crecord');
  });
  test('arrow keys move, Enter opens the selected row', async ({ page, watch }) => {
    await page.goto(`${RESEARCH}/`);
    await page.getByTestId('home-entity').first().waitFor();
    await page.keyboard.press('Control+k');
    await page.keyboard.type('mcp', { delay: 10 });
    await expect(page.getByTestId('palette-hit').nth(1)).toBeVisible();
    await expect(page.getByTestId('palette-hit').first()).toHaveAttribute('data-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('palette-hit').nth(1)).toHaveAttribute('data-selected', 'true');
    const id = await page.getByTestId('palette-hit').nth(1).getAttribute('data-id');
    await page.keyboard.press('Enter');
    await expect(page.locator(`[data-testid=entity-page][data-id="${id}"]`)).toBeVisible();
    void watch;
  });
  test('Enter before the answer lands opens the answer, not a stale row', async ({ page, watch }) => {
    await page.route(/\/kb\/v1\/search/, async (r) => { await new Promise((x) => setTimeout(x, 250)); await r.continue(); });
    await page.goto(`${RESEARCH}/`);
    await page.getByTestId('home-entity').first().waitFor();
    await page.keyboard.press('Control+k');
    await page.keyboard.type('graphology', { delay: 5 });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('node-title')).toHaveText('graphology');
    void watch;
  });
  test('recent items hold ids and read their labels only when opened', async ({ page, watch }) => {
    await page.goto(node('e:library:sigma-js'));
    await page.getByTestId('claim-card').first().waitFor();
    const stored = await page.evaluate(() => localStorage.getItem('loupe.recent.v1'));
    expect(stored).toBe('["e:library:sigma-js"]');
    await page.goto(`${RESEARCH}/#/`);
    await page.getByTestId('home-entity').first().waitFor();
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('palette-recent').first()).toContainText('sigma.js');
    void watch;
  });
  test('it works when localStorage throws', async ({ page, watch }) => {
    await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); });
    await page.goto(node('e:library:sigma-js'));
    await page.getByTestId('claim-card').first().waitFor();
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('palette-input')).toBeFocused();
    void watch;
  });
  test('nothing found is said plainly', async ({ page, watch }) => {
    await page.goto(`${RESEARCH}/`);
    await page.getByTestId('home-entity').first().waitFor();
    await page.keyboard.press('Control+k');
    await page.keyboard.type('없는말없는말', { delay: 5 });
    await expect(page.getByTestId('palette-empty')).toContainText('이름이 일치하는 엔티티가 없다');
    void watch;
  });
  test('a failing search says so in the palette', async ({ page, watch }) => {
    await page.route(/\/kb\/v1\/search/, (r) => r.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ type: 'x', title: 'x', status: 503, code: 'read_timeout' }) }));
    await page.goto(`${RESEARCH}/`);
    await page.getByTestId('home-entity').first().waitFor();
    await page.keyboard.press('Control+k');
    await page.keyboard.type('sigma', { delay: 5 });
    await expect(page.getByTestId('palette-error')).toContainText('KB 읽기 시간 초과');
    void watch;
  });
});

test.describe('navigation', () => {
  test('later phases are not in the navigation, and their paths are honest', async ({ page, watch }) => {
    await page.goto(`${RESEARCH}/`);
    await page.getByTestId('home-entity').first().waitFor();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    for (const word of ['스키마', '변경']) await expect(page.locator('header').getByText(word)).toHaveCount(0);
    for (const path of ['schema', 'table/Tool', 'changes', 'search']) {
      await page.goto(`${RESEARCH}/#/${path}`);
      await expect(page.getByTestId('not-found-route')).toBeVisible();
    }
    void watch;
  });
  test('scroll comes back on Back', async ({ page, watch }) => {
    await page.goto(node('e:spike:s1-aggregation'));
    await page.getByTestId('claim-card').first().waitFor();
    await settled(page);
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.waitForTimeout(150);
    const y = await page.evaluate(() => window.scrollY);
    expect(y).toBeGreaterThan(500);
    await page.locator('[data-testid=edge-link]').first().click();
    await expect(page).not.toHaveURL(/s1-aggregation/);
    await page.goBack();
    await page.getByTestId('claim-card').first().waitFor();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(y - 200);
    void watch;
  });
  test('the page is keyboard reachable from the top', async ({ page, watch }) => {
    await page.goto(node('e:library:sigma-js'));
    await page.getByTestId('claim-card').first().waitFor();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('brand')).toBeFocused();
    void watch;
  });
  test('phone width has no sideways scroll', async ({ page, watch }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(node('e:library:sigma-js'));
    await page.getByTestId('claim-card').first().waitFor();
    await settled(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.goto(`${RESEARCH}/#/source/n-198da44f5f7ce10d?claim=c-1e442c5458f5`);
    await expect(page.getByTestId('quote-marker')).toBeVisible();
    await settled(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    void watch;
  });
});
