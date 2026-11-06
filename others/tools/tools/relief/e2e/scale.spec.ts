// 500-object measurement, headless (design 14, Phase 1). Software raster: a floor to compare against, not a GPU number.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { audit } from './support/audit.ts';
import { BUILT, shotDir } from './support/ports.ts';

test('547 objects: element count, clean labels, and a pan frame time', async ({ page }) => {
  const t0 = Date.now();
  await page.goto(`${BUILT}/#/?fx=scale`);
  await page.waitForSelector('svg.scene g[data-id]');
  await page.evaluate(() => document.fonts.ready);
  const loadMs = Date.now() - t0;
  const a = await page.evaluate(audit);
  await page.screenshot({ path: path.join(shotDir, 'scale-547.png') });
  expect(a.noBasis).toBe(0); expect(a.overlaps).toEqual([]); expect(a.clipped).toEqual([]);
  expect(a.elements).toBeLessThan(3000);

  // Pan by dragging in 60 steps and record each frame's time by requestAnimationFrame, in the page.
  for (let i = 0; i < 4; i++) await page.keyboard.press('+');
  const box = (await page.getByTestId('map').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  const sampler = page.evaluate(() => new Promise<number[]>((resolve) => {
    const out: number[] = []; let last = performance.now(); let n = 0;
    const tick = (now: number) => { out.push(now - last); last = now; if (++n < 90) requestAnimationFrame(tick); else resolve(out); };
    requestAnimationFrame(tick);
  }));
  // The moves run while the sampler counts frames, so the frames include the pointer-driven re-render of the whole scene.
  for (let i = 0; i < 60; i++) { await page.mouse.move(box.x + box.width / 2 - i * 3, box.y + box.height / 2 - i * 2); await page.waitForTimeout(8); }
  await page.mouse.up();
  const frames = (await sampler).slice(5);
  const sorted = [...frames].sort((x, y) => x - y);
  const p = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! * 10) / 10;
  const flowing = await page.evaluate(() => document.getAnimations().filter((x) => (x as CSSAnimation).animationName === 'packet' && x.playState === 'running').length);
  expect(flowing).toBeGreaterThan(100); // The number below is with the packets on.
  expect(flowing).toBeLessThanOrEqual(200);
  const result = { objects: a.objects, svgElements: a.elements, labels: a.labels, loadMs, packets: flowing, panFrameMs: { p50: p(0.5), p95: p(0.95) }, note: 'headless Chromium, software raster, N=1' };
  console.log(JSON.stringify(result));
  writeFileSync(path.join(shotDir, 'measure-547.json'), JSON.stringify(result, null, 1) + '\n');
  expect(result.panFrameMs.p95).toBeLessThanOrEqual(17); // Design 13: one frame at 60 Hz. The interval between frames cannot read lower than that.
});
