import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const [v, shot] of [['A', 'shots/pw-hover-real-mouse-A.png'], ['B', 'shots/pw-hover-real-mouse-B.png']]) {
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await p.goto(`http://127.0.0.1:18311/?mode=view&v=${v}&tech=fill&dash=1&ec=solid&size=5k&font=noto&cam=0.5,0.5,0.5`);
  await p.waitForFunction(() => document.title === 'VIEW READY', null, { timeout: 60000 }); await p.waitForTimeout(1500);
  const pos = await p.evaluate(() => { const k = window.__top(); return { k, ...window.__vp(k) }; });
  await p.mouse.move(pos.x + 30, pos.y + 30); await p.waitForTimeout(300); await p.mouse.move(pos.x, pos.y, { steps: 4 }); await p.waitForTimeout(2500);
  const r = await p.evaluate(() => ({ entered: window.__ctx.entered, last: window.__ctx.lastEntered, hover: window.__ctx.hover, nbrs: window.__ctx.nbr.size }));
  console.log(v, JSON.stringify(pos), JSON.stringify(r)); await p.screenshot({ path: shot });
}
await b.close();
