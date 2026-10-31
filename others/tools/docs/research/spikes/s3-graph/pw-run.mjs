// Headless software run. Fresh browser per cell for clean heap with gc exposed.
import { chromium } from 'playwright';
import fs from 'node:fs';
const cells = JSON.parse(fs.readFileSync(process.argv[2])); const port = 18311;
for (const q of cells) {
  const b = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
  const c = await b.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 }); const p = await c.newPage();
  const u = `http://127.0.0.1:${port}/?${q}&font=noto&embedded=1`; const t0 = Date.now();
  const done = p.evaluateHandle ? null : null;
  await p.addInitScript(() => { window.parent.postMessage = window.parent.postMessage; addEventListener('message', (e) => { if (e.data === 'cell-done') document.title = 'CELL DONE'; }); });
  await p.goto(u);
  try { await p.waitForFunction(() => document.title === 'CELL DONE', null, { timeout: 150000 }); } catch { console.log('TIMEOUT', q); }
  console.log(q, Date.now() - t0); await b.close();
}
console.log('PW_DONE');
