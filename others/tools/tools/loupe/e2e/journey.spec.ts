// Phase 1 completion conditions 1 and 2 (design 12): the whole walk, then every URL of it in a new tab.
import { test, expect, watchPage, expectClean } from './support/test.ts';
import { RESEARCH } from './support/ports.ts';
import { claimRow, fingerprint, fixture, highlights, setTime, settled } from './support/app.ts';

const fx = fixture('kb-research.json');
const NEW = 'c-ecfb958d5519', OLD = 'c-4c2e31e4ac9b';

test('palette, entity, relation, incoming link, claim, quote, past view and back, each URL reproducing its screen', async ({ page, context, watch }) => {
  const steps: { name: string; url: string; print: Awaited<ReturnType<typeof fingerprint>> }[] = [];
  const noFailure = async () => { await expect(page.getByTestId('error-card')).toHaveCount(0); await expect(page.getByTestId('route-error')).toHaveCount(0); };
  const mark = async (name: string) => { await settled(page); await noFailure(); steps.push({ name, url: page.url(), print: await fingerprint(page) }); };

  // 1. Palette to an entity, by keyboard only
  await page.goto(`${RESEARCH}/`);
  await expect(page.getByTestId('home-entity').first()).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await page.keyboard.type('sigma', { delay: 20 });
  await expect(page.getByTestId('palette-hit').first()).toHaveAttribute('data-id', 'e:library:sigma-js');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('node-title')).toHaveText('sigma.js');
  await expect(page).toHaveURL(/#\/node\/e%3Alibrary%3Asigma-js$/);
  await mark('entity');

  // 2. A relation to another entity
  await page.locator('[data-testid=edges-out] [data-rtype=DEPENDS_ON] [data-far="e:library:graphology"] [data-testid=edge-link]').click();
  await expect(page.getByTestId('node-title')).toHaveText('graphology');
  await mark('related entity');

  // 3. Back through its incoming link
  await page.locator('[data-testid=edges-in] [data-far="e:library:sigma-js"] [data-testid=edge-link]').first().click();
  await expect(page.getByTestId('node-title')).toHaveText('sigma.js');
  await mark('entity through the incoming link');

  // 4. A claim to its quote: one click
  const claim = claimRow(fx, NEW);
  await page.locator(`[data-claim=${NEW}] [data-testid=evidence-pill]`).click();
  await expect(page.getByTestId('source-page')).toBeVisible();
  await expect(page.getByTestId('quote-verdict')).toHaveText('원문 일치');
  await expect.poll(() => highlights(page)).toEqual([claim.evidence[0]!.exact]);
  await mark('quote in the source');

  // 5. To the past: the same entity as it was believed at 21:00 KST
  await page.getByTestId('quote-subject').click();
  await expect(page.getByTestId('node-title')).toHaveText('sigma.js');
  await setTime(page, { valid: '2026-10-28', observed: '2026-10-31T21:00' });
  await expect(page.getByTestId('time-band')).toBeVisible();
  await expect(page.locator(`[data-claim=${OLD}] [data-testid=claim-value]`)).toHaveText('576');
  await expect(page.locator(`[data-claim=${NEW}]`)).toHaveCount(0);
  await mark('entity in the past');

  const old = claimRow(fx, OLD);
  await page.locator(`[data-claim=${OLD}] [data-testid=evidence-pill]`).click();
  await expect(page.getByTestId('source-page')).toBeVisible();
  await expect.poll(() => highlights(page)).toEqual([old.evidence[0]!.exact]);
  await expect(page.getByTestId('time-band')).toBeVisible();
  await mark('quote in the past');

  // 6. And back to the present
  await page.getByTestId('band-present').click();
  await expect(page.getByTestId('time-band')).toHaveCount(0);
  await expect(page).not.toHaveURL(/as_of_/);
  await page.getByTestId('quote-subject').click();
  await expect(page.locator(`[data-claim=${NEW}] [data-testid=claim-value]`)).toHaveText('289');
  await expect(page.locator(`[data-claim=${OLD}]`)).toHaveCount(0);
  await mark('entity in the present');

  expect(steps.map((s) => s.name)).toHaveLength(7);

  // Condition 2: every URL of that walk, in a new tab, with an empty query cache.
  for (const s of steps) {
    const tab = await context.newPage();
    const w = await watchPage(tab);
    await tab.goto(s.url);
    await settled(tab);
    expect(await fingerprint(tab), `${s.name}: ${s.url}`).toEqual(s.print);
    await expectClean(tab, w);
    await tab.close();
  }
  void watch;
});

test('a browser Back from the source returns to the entity', async ({ page, watch }) => {
  await page.goto(`${RESEARCH}/#/node/e%3Alibrary%3Asigma-js`);
  await page.locator(`[data-claim=${NEW}] [data-testid=evidence-pill]`).click();
  await expect(page.getByTestId('source-page')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('node-title')).toHaveText('sigma.js');
  void watch;
});

test('the claim page goes to the source in one click and names the subject', async ({ page, watch }) => {
  await page.goto(`${RESEARCH}/#/node/${NEW}`);
  await expect(page.getByTestId('claim-page')).toBeVisible();
  await expect(page.getByTestId('claim-subject')).toHaveText('sigma.js');
  await page.getByTestId('evidence-link').click();
  await expect.poll(() => highlights(page)).toEqual([claimRow(fx, NEW).evidence[0]!.exact]);
  void watch;
});
