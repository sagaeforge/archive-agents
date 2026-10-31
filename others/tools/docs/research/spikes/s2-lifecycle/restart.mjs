// usage: node restart.mjs <port> <fresh|fetch> <service-unit> <restarts> <gapMs> <label>
import http from 'node:http'; import { spawn } from 'node:child_process';
const [port, mode, unit, R, gap, label] = process.argv.slice(2);
const raw = () => new Promise((res, rej) => { const r = http.request({ host: '127.0.0.1', port, path: '/healthz', agent: false }, (x) => { x.resume(); x.on('end', () => res(x.statusCode)); x.on('error', rej); }); r.on('error', rej); r.setTimeout(20000, () => r.destroy(Object.assign(new Error('t'), { code: 'CLIENT_TIMEOUT' }))); r.end(); });
const viaFetch = async () => { const x = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(20000) }); await x.text(); return x.status; };
const send = mode === 'fresh' ? raw : viaFetch; const counts = {}; const lat = []; let stop = false;
const worker = async () => { while (!stop) { const t = performance.now(); try { const s = await send(); counts[`http_${s}`] = (counts[`http_${s}`] ?? 0) + 1; lat.push(performance.now() - t); } catch (e) { const c = `ERR_${e.cause?.code ?? e.code ?? e.name}`; counts[c] = (counts[c] ?? 0) + 1; } await new Promise((r) => setTimeout(r, 5)); } };
const ws = Array.from({ length: 4 }, worker); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1000); const durs = [];
for (let i = 0; i < Number(R); i++) { const t = performance.now(); await new Promise((r) => spawn('systemctl', ['--user', 'restart', unit]).on('exit', r)); durs.push(+(performance.now() - t).toFixed(0)); await sleep(Number(gap)); }
stop = true; await Promise.all(ws); lat.sort((a, b) => a - b);
const failed = Object.entries(counts).filter(([k]) => k !== 'http_200').reduce((a, [, v]) => a + v, 0); const over100 = lat.filter((x) => x > 100).length;
console.log(JSON.stringify({ label, mode, restarts: +R, counts, failed, latency_over_100ms: over100, p50: +lat[lat.length >> 1]?.toFixed(1), p99: +lat[Math.floor(lat.length * 0.99)]?.toFixed(1), p999: +lat[Math.floor(lat.length * 0.999)]?.toFixed(1), max: +lat.at(-1)?.toFixed(1), restart_cmd_ms: durs }));
