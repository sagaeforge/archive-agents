// usage: node pw.mjs <url-suffix> <wait-title> [shot.png] [dpr] [evalJS]
import { chromium } from 'playwright';
const [suffix, title, shot, dpr = '1', js] = process.argv.slice(2);
const b = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const c = await b.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: +dpr });
const p = await c.newPage(); const logs = []; p.on('console', (m) => logs.push(m.type() + ': ' + m.text().slice(0, 300))); p.on('pageerror', (e) => logs.push('pageerror: ' + String(e).slice(0, 400)));
await p.goto('http://127.0.0.1:18311/' + suffix);
await p.waitForFunction((t) => document.title === t, title, { timeout: +(process.env.PW_TIMEOUT || 120000) });
if (js) console.log('eval:', JSON.stringify(await p.evaluate(js)));
if (shot) await p.screenshot({ path: shot });
console.log(logs.slice(0, 12).join('\n'));
await b.close();
