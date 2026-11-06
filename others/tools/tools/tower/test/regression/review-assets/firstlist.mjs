// What does the very first tools/list return once the gateway port opens? The S1 harness polled until 4 tools.
import { ROOT as TT_ROOT } from '../harness/env.mjs';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { open } from './lib.mjs';
const [cfg, port, nArg, want] = process.argv.slice(2);
const N = Number(nArg ?? 20), WANT = Number(want ?? 4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attempt = (p) => new Promise((res) => { const s = connect(p, '127.0.0.1'); const t = setTimeout(() => { s.destroy(); res(false); }, 40); s.once('connect', () => { clearTimeout(t); s.destroy(); res(true); }); s.once('error', () => { clearTimeout(t); res(false); }); });
const rows = [];
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  const p = spawn('node', ['gateway.mjs'], { cwd: `${TT_ROOT}/c5-baseline`, detached: true, stdio: 'ignore', env: { ...process.env, GW_CONFIG: cfg, GW_PORT: port } });
  while (!(await attempt(port))) await sleep(1);
  const tPort = performance.now() - t0;
  // What a real client does: discover, then lists, without pausing.
  const s = await open(`http://127.0.0.1:${port}/mcp`, 'modern');
  const l = await s.call('tools/list');
  const tools = l.json?.result?.tools?.map((x) => x.name) ?? [];
  const tFirst = performance.now() - t0;
  let tFull = null;
  for (let j = 0; j < 4000; j++) { const m = await s.call('tools/list'); if ((m.json?.result?.tools?.length ?? 0) >= WANT) { tFull = performance.now() - t0; break; } await sleep(5); }
  rows.push({ tPort: +tPort.toFixed(0), tFirst: +tFirst.toFixed(0), first: tools.length, tFull: tFull && +tFull.toFixed(0) });
  const gone = new Promise((r) => p.once('exit', r));
  process.kill(-p.pid, 'SIGTERM'); const k = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, 2000);
  await gone; clearTimeout(k); await sleep(100);
}
const hist = {}; for (const r of rows) hist[r.first] = (hist[r.first] ?? 0) + 1;
const sorted = (k) => rows.map((r) => r[k]).sort((a, b) => a - b);
console.log('first tools/list size histogram', JSON.stringify(hist), 'N', N);
console.log('port p50', sorted('tPort')[N >> 1], 'firstList p50', sorted('tFirst')[N >> 1], 'fullList p50', sorted('tFull')[N >> 1], 'max', sorted('tFull').at(-1));
process.exit(0);
