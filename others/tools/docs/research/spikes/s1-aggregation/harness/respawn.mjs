// Time from SIGKILL of the stdio child to the first successful call. usage: respawn.mjs <url> <toolRegex> [runs]
import { open } from './lib.mjs';
const [url, re, runs = '5'] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const s = await open(url, 'modern');
const list = await s.call('tools/list');
const name = list.json.result.tools.find((t) => new RegExp(re).test(t.name)).name;
const ec = (r) => r.json?.result?.content?.find((c) => c.type === 'text')?.text ?? '';
const out = [];
for (let i = 0; i < Number(runs); i++) {
  const r0 = await s.call('tools/call', { name, arguments: { text: 'x' } });
  const pid = Number(/pid=(\d+)/.exec(ec(r0))?.[1]);
  process.kill(pid, 'SIGKILL');
  const t0 = performance.now();
  for (;;) {
    const r = await s.call('tools/call', { name, arguments: { text: 'x' } });
    const p2 = Number(/pid=(\d+)/.exec(ec(r))?.[1]);
    if (p2 && p2 !== pid && !r.json?.result?.isError) break;
    if (performance.now() - t0 > 20000) { out.push('none in 20 s'); break; }
    await sleep(20);
  }
  out.push(Math.round(performance.now() - t0));
  await sleep(600);
}
console.log(`${name}: first good call after SIGKILL (ms): ${out.join(', ')}`);
process.exit(0);
