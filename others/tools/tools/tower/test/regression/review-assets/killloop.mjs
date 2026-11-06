// Call a stdio-backed tool in a tight loop across a SIGKILL of the gateway. usage: killloop.mjs <url> <tool> <unit>
import { execFileSync } from 'node:child_process';
import { open, outcome } from './lib.mjs';
const [url, tool, unit] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mainPid = () => execFileSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', unit]).toString().trim();
const s = await open(url, 'modern');
for (let i = 0; i < 5; i++) { const r = await s.call('tools/call', { name: tool, arguments: { text: 'x' } }); if (i === 4) console.log('before', outcome(r)); await sleep(40); }
const pid = mainPid(); const t0 = performance.now();
process.kill(Number(pid), 'SIGKILL'); console.log('SIGKILL', pid);
const seq = []; let lastKey = '';
while (performance.now() - t0 < 6000) {
  const r = await s.call('tools/call', { name: tool, arguments: { text: 'x' } });
  const o = outcome(r).replace(/pid=\d+/, 'pid=N').slice(0, 90);
  if (o !== lastKey) { seq.push({ at: Math.round(performance.now() - t0), lat: r.ms, o }); lastKey = o; }
  await sleep(40);
}
for (const x of seq) console.log(JSON.stringify(x));
const l = await s.call('tools/list'); console.log('tools/list after', outcome(l).slice(0, 120));
process.exit(0);
