// Quote checks and highlights (design 5, section 11 "인용 강조").
import { test, expect } from './support/test.ts';
import { HOSTILE, RESEARCH } from './support/ports.ts';
import { claimRow, fixture, highlights, rewriteKb, settled } from './support/app.ts';

const fx = fixture('kb-research.json');
const hostile = fixture('kb-hostile.json');
const open = (snapshot: string, claim: string, ev?: string) => `/#/source/${snapshot}?claim=${claim}${ev ? `&ev=${ev}` : ''}`;

test('the Range string of the highlight is exactly the recorded quote', async ({ page, watch }) => {
  for (const id of ['c-1e442c5458f5', 'c-ecfb958d5519', 'c-a500a5e2d76c'].slice(0, 2)) {
    const c = claimRow(fx, id), e = c.evidence[0]!;
    await page.goto(`${RESEARCH}${open(e.snapshot_id, id, e.id)}`);
    await page.reload();
    await expect(page.getByTestId('quote-verdict')).toHaveText('원문 일치');
    await expect.poll(() => highlights(page)).toEqual([e.exact]);
    await expect(page.getByTestId('quote-marker')).toBeVisible();
  }
  void watch;
});

test('a Korean quote from a Korean report', async ({ page, watch }) => {
  const c = fx.claims.find((x: { evidence: { snapshot_id: string; exact: string | null; start: number | null }[]; verification: string }) => x.verification === 'quote_found' && x.evidence[0]?.snapshot_id === fx.cases.korean_body_snapshot && x.evidence[0]?.exact && /[가-힣]/.test(x.evidence[0].exact));
  await page.goto(`${RESEARCH}${open(fx.cases.korean_body_snapshot, c.id, c.evidence[0].id)}`);
  await expect.poll(() => highlights(page)).toEqual([c.evidence[0].exact]);
  void watch;
});

test('offsets past astral characters land on the quote', async ({ page, watch }) => {
  const c = claimRow(hostile, 'c-d8f242df84e3'), e = c.evidence[0]!;
  await page.goto(`${HOSTILE}${open(e.snapshot_id, c.id, e.id)}`);
  await expect(page.getByTestId('quote-verdict')).toHaveText('원문 일치');
  await expect.poll(() => highlights(page)).toEqual(['**HOSTILE-QUOTE-ONE**']);
  void watch;
});

test('a quote across the default /text window boundary', async ({ page, watch }) => {
  const c = claimRow(fx, 'c-9c513f2de839'), e = c.evidence[0]!;
  expect(e.start!).toBeLessThan(20_000); expect(e.end!).toBeGreaterThan(20_000);
  await page.goto(`${RESEARCH}${open(e.snapshot_id, c.id, e.id)}`);
  await expect.poll(() => highlights(page)).toEqual([e.exact]);
  await expect(page.getByTestId('read-before')).toBeVisible();
  // Reading the part above keeps the quote where it was
  await page.getByTestId('read-before').click();
  await expect(page.getByTestId('read-before')).toHaveCount(0);
  await expect.poll(() => highlights(page)).toEqual([e.exact]);
  void watch;
});

test('the check opens the window around the quote, not the whole document', async ({ page, watch }) => {
  const c = claimRow(fx, 'c-9c513f2de839'), e = c.evidence[0]!;
  await page.goto(`${RESEARCH}${open(e.snapshot_id, c.id, e.id)}`);
  await expect.poll(() => highlights(page)).toEqual([e.exact]);
  const text = watch.kbPaths().filter((p) => p.includes('/text'));
  expect(text.length).toBe(2);
  for (const p of text) expect(Number(new URL(p, 'http://x').searchParams.get('start'))).toBeGreaterThan(15_000);
});

test('a quote that cannot be located: nothing is highlighted, the recorded quote is shown apart', async ({ page, watch }) => {
  const c = claimRow(fx, 'c-32aeb9f6c200'), e = c.evidence[0]!;
  await page.goto(`${RESEARCH}${open(e.snapshot_id, c.id)}`);
  await expect(page.getByTestId('quote-verdict')).toHaveText('인용 찾지 못함');
  await expect(page.getByTestId('recorded-quote')).toContainText(e.exact!);
  await expect(page.getByTestId('source-text')).toBeVisible();
  expect(await highlights(page)).toEqual([]);
  await expect(page.getByTestId('quote-marker')).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY), 'opens with no jump').toBe(0);
  void watch;
});

test('shifted offsets: step 2 corrects the position and says so', async ({ page, watch }) => {
  const c = claimRow(fx, 'c-1e442c5458f5'), e = c.evidence[0]!;
  await rewriteKb(page, /^\/kb\/v1\/claims\//, (b) => { b.data.evidence[0].start += 7; b.data.evidence[0].end += 7; });
  await page.goto(`${RESEARCH}${open(e.snapshot_id, c.id, e.id)}`);
  await expect(page.getByTestId('quote-verdict')).toHaveText('위치 보정');
  await expect.poll(() => highlights(page)).toEqual([e.exact]);
  await expect(page.getByTestId('recorded-quote')).toBeVisible();
  void watch;
});

test('a quote stored in NFD is found by NFC comparison', async ({ page, watch }) => {
  const c = fx.claims.find((x: { evidence: { snapshot_id: string; exact: string | null }[]; verification: string }) => x.verification === 'quote_found' && x.evidence[0]?.exact && /[가-힣]/.test(x.evidence[0].exact));
  const e = c.evidence[0];
  await rewriteKb(page, /^\/kb\/v1\/claims\//, (b) => { b.data.evidence[0].exact = e.exact.normalize('NFD'); });
  await page.goto(`${RESEARCH}${open(e.snapshot_id, c.id, e.id)}`);
  await expect(page.getByTestId('quote-verdict')).toHaveText('위치 보정');
  await expect.poll(() => highlights(page)).toEqual([e.exact]);
  void watch;
});

test('a wrong quote with plausible offsets is not highlighted at those offsets', async ({ page, watch }) => {
  const c = claimRow(fx, 'c-1e442c5458f5'), e = c.evidence[0]!;
  await rewriteKb(page, /^\/kb\/v1\/claims\//, (b) => { b.data.evidence[0].exact = '이 글자는 문서 어디에도 없다'; });
  await page.goto(`${RESEARCH}${open(e.snapshot_id, c.id, e.id)}`);
  await expect(page.getByTestId('quote-verdict')).toHaveText('인용 찾지 못함');
  await expect(page.getByTestId('source-text')).toBeVisible();
  expect(await highlights(page)).toEqual([]);
  void watch;
});

test('a JSON pointer shows its path and checks nothing', async ({ page, watch }) => {
  const c = fx.claims.find((x: { id: string }) => x.id === 'c-b34742117968');
  await page.goto(`${RESEARCH}${open(c.evidence[0].snapshot_id, c.id)}`);
  await expect(page.getByTestId('quote-verdict')).toHaveText('경로 인용');
  await expect(page.getByTestId('quote-pointer')).toHaveText('/payload-1k/distinctSyllables');
  await expect(page.getByTestId('source-text')).toBeVisible();
  expect(await highlights(page)).toEqual([]);
  await expect(page.getByTestId('tab-rendered')).toHaveCount(0);
  void watch;
});

test('the rendered tab highlights nothing and sends the reader back to the body tab', async ({ page, watch }) => {
  const c = claimRow(fx, 'c-1e442c5458f5'), e = c.evidence[0]!;
  await page.goto(`${RESEARCH}${open(e.snapshot_id, c.id, e.id)}`);
  await expect.poll(() => highlights(page)).toEqual([e.exact]);
  await page.getByTestId('tab-rendered').click();
  await expect(page.getByTestId('rendered')).toBeVisible();
  await expect(page).toHaveURL(/view=rendered/);
  expect(await highlights(page)).toEqual([]);
  await expect(page.locator('main')).toContainText('인용 위치는 본문 탭에서 본다');
  // The tab is part of the URL
  await page.reload();
  await expect(page.getByTestId('rendered')).toBeVisible();
  await page.getByTestId('tab-text').click();
  await expect.poll(() => highlights(page)).toEqual([e.exact]);
  await expect(page).not.toHaveURL(/view=/);
  void watch;
});

test('a claim that is not there at this time leaves the body readable', async ({ page, watch }) => {
  const c = claimRow(fx, 'c-ecfb958d5519'), e = c.evidence[0]!;
  await page.goto(`${RESEARCH}/#/source/${e.snapshot_id}?claim=${c.id}&as_of_observed=2026-10-31T12:00:00Z`);
  await expect(page.getByTestId('quote-absent')).toBeVisible();
  await expect(page.getByTestId('source-text')).toBeVisible();
  void watch;
});

test('the entity page reads no text until a pill opens, and then only around that quote', async ({ page, watch }) => {
  await page.goto(`${RESEARCH}/#/node/e%3Alibrary%3Asigma-js`);
  await page.getByTestId('claim-card').first().waitFor();
  await settled(page);
  expect(watch.kbPaths().filter((p) => p.includes('/text'))).toEqual([]);
  const c = claimRow(fx, 'c-1e442c5458f5');
  await page.locator('[data-claim=c-1e442c5458f5] [data-testid=evidence-pill]').hover();
  await expect(page.getByTestId('pill-tip')).toContainText(c.evidence[0]!.exact!);
  await expect(page.getByTestId('pill-verdict')).toHaveText('원문 일치');
  await expect(page.locator('[data-claim=c-1e442c5458f5] [data-testid=verdict]')).toHaveText('원문 일치');
  const text = watch.kbPaths().filter((p) => p.includes('/text'));
  expect(text).toHaveLength(1);
  expect(Number(new URL(text[0]!, 'http://x').searchParams.get('max_chars'))).toBeLessThan(1000);
});

test('the pill also opens from the keyboard', async ({ page, watch }) => {
  await page.goto(`${RESEARCH}/#/node/e%3Alibrary%3Asigma-js`);
  await page.locator('[data-claim=c-1e442c5458f5] [data-testid=evidence-pill]').focus();
  await expect(page.getByTestId('pill-tip')).toBeVisible();
  void watch;
});

test('check all runs at most four reads at a time and marks every pill', async ({ page, watch }) => {
  let inFlight = 0, peak = 0;
  await page.route(/\/kb\/v1\/snapshots\/[^/]+\/text/, async (route) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 40));
    const res = await route.fetch();
    inFlight--;
    await route.fulfill({ response: res });
  });
  await page.goto(`${RESEARCH}/#/node/e%3Aproject%3Asagae-gateway`);
  await page.getByTestId('claim-card').first().waitFor();
  await expect(page.locator('[data-testid=verdict]')).toHaveCount(0);
  await page.getByTestId('check-all').click();
  await expect(page.getByTestId('check-all')).toContainText('확인했다');
  const pills = await page.getByTestId('evidence-pill').count();
  expect(pills).toBeGreaterThan(4);
  await expect(page.getByTestId('verdict')).toHaveCount(pills);
  expect(peak).toBeLessThanOrEqual(4);
  expect(peak).toBeGreaterThan(1);
  void watch;
});

test('a snapshot that cannot be read says so on the card', async ({ page, watch }) => {
  await rewriteKb(page, /^\/kb\/v1\/nodes\/e%3Alibrary%3Asigma-js\?/, (b) => { for (const c of b.data.claims) for (const e of c.evidence) e.snapshot_id = 'n-doesnotexist0000'; });
  await page.goto(`${RESEARCH}/#/node/e%3Alibrary%3Asigma-js`);
  const pill = page.getByTestId('evidence-pill').first();
  await pill.hover();
  await expect(page.getByTestId('pill-verdict')).toHaveText('원문 접근 불가');
  void watch;
});

test('a long document loads window by window as the reader goes', async ({ page, watch }) => {
  await page.goto(`${RESEARCH}/#/source/n-b0b5bb5257562d33`);
  await expect(page.getByTestId('source-text')).toBeVisible();
  await settled(page);
  const chars = async () => [...(await page.getByTestId('source-text').textContent()) ?? ''].length;
  expect(await chars()).toBe(20_000);
  await page.getByTestId('read-after').scrollIntoViewIfNeeded();
  await expect.poll(chars).toBeGreaterThan(20_000);
  void watch;
});
