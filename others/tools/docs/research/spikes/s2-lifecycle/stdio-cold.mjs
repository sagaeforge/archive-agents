// usage: node stdio-cold.mjs <N> <children>  spawn N rounds of <children> concurrent stdio upstreams: time to tools/list completed on all.
import { spawn } from 'node:child_process'; import { createInterface } from 'node:readline'; import { readFileSync } from 'node:fs';
const [N, K] = process.argv.slice(2).map(Number); const cwd = new URL('./app/', import.meta.url).pathname;
const one = (keep) => new Promise((res, rej) => { const t = performance.now(); const c = spawn(process.execPath, ['standin.mjs'], { cwd, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, NODE_COMPILE_CACHE: process.env.CC } });
  const send = (o) => c.stdin.write(JSON.stringify(o) + '\n'); const rl = createInterface({ input: c.stdout });
  rl.on('line', (l) => { const m = JSON.parse(l); if (m.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); }
    if (m.id === 2) { const ms = performance.now() - t; if (keep) res({ ms, c, tools: m.result.tools.length }); else { c.kill(); res({ ms, tools: m.result.tools.length }); } } });
  c.on('error', rej); send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } }); });
const v = []; for (let i = 0; i < N; i++) { const t = performance.now(); await Promise.all(Array.from({ length: K }, () => one(false))); v.push(performance.now() - t); await new Promise((r) => setTimeout(r, 100)); }
v.sort((a, b) => a - b); const p = (q) => +v[Math.min(v.length - 1, Math.ceil(q / 100 * v.length) - 1)].toFixed(1);
const k = await one(true); await new Promise((r) => setTimeout(r, 3000));
const st = readFileSync(`/proc/${k.c.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]; const pss = readFileSync(`/proc/${k.c.pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m)[1]; k.c.kill();
console.log(JSON.stringify({ N, children: K, tools: k.tools, p50: p(50), p95: p(95), min: +v[0].toFixed(1), max: p(100), child_rss_kB: +st, child_pss_kB: +pss })); process.exit(0);
