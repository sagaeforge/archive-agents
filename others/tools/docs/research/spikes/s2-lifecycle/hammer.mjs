// usage: node hammer.mjs <port> <fresh|keepalive> <idleMs> <jitterMs> <concurrency> <seconds> <label>
// Bursts of C POST /mcp calls, spaced idleMs +- jitter after the previous burst finished, so bursts land on the idle deadline.
import http from 'node:http';
const [port, mode, idle, jit, C, secs, label] = process.argv.slice(2);
const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping', arguments: {} } });
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' };
const url = `http://127.0.0.1:${port}/mcp`;
const raw = () => new Promise((res, rej) => { const r = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', agent: false, headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, (x) => { let d = ''; x.on('data', (c) => d += c); x.on('end', () => res({ status: x.statusCode, d })); x.on('error', rej); }); r.on('error', rej); r.setTimeout(15000, () => r.destroy(Object.assign(new Error('timeout'), { code: 'CLIENT_TIMEOUT' }))); r.end(body); });
const viaFetch = async () => { const x = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) }); return { status: x.status, d: await x.text() }; };
const nodeAgent = new http.Agent({ keepAlive: true });
const viaNodeKA = () => new Promise((res, rej) => { const r = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', agent: nodeAgent, headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, (x) => { let d = ''; x.on('data', (c) => d += c); x.on('end', () => res({ status: x.statusCode, d, reused: r.reusedSocket })); x.on('error', rej); }); r.on('error', (e) => { e.reused = r.reusedSocket; rej(e); }); r.setTimeout(15000, () => r.destroy(Object.assign(new Error('timeout'), { code: 'CLIENT_TIMEOUT' }))); r.end(body); });
const send = mode === 'fresh' ? raw : mode === 'nodeka' ? viaNodeKA : viaFetch; const msgs = {};
const counts = {}; const pids = new Set(); const lat = []; let n = 0; const errs = {};
const one = async () => { const t = performance.now(); n++;
  try { const r = await send(); const k = `http_${r.status}`; counts[k] = (counts[k] ?? 0) + 1; const m = r.d.match(/pid\\*":(\d+)/); if (m) pids.add(m[1]); lat.push(performance.now() - t); }
  catch (e) { const c = e.cause?.code ?? e.code ?? e.name; const tag = e.reused === undefined ? '' : (e.reused ? '_reused' : '_newconn'); counts[`ERR_${c}${tag}`] = (counts[`ERR_${c}${tag}`] ?? 0) + 1; const m = String(e.cause?.message ?? e.message); msgs[m] = (msgs[m] ?? 0) + 1; } };
const end = Date.now() + Number(secs) * 1000; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); let rounds = 0;
while (Date.now() < end) { rounds++; await Promise.all(Array.from({ length: Number(C) }, one)); await sleep(Number(idle) + (Math.random() * 2 - 1) * Number(jit)); }
lat.sort((a, b) => a - b); const failed = Object.entries(counts).filter(([k]) => !k.startsWith('http_200')).reduce((a, [, v]) => a + v, 0);
console.log(JSON.stringify({ label, mode, idle: +idle, jitter: +jit, C: +C, secs: +secs, rounds, requests: n, activations: pids.size, failed, failRate: +(failed / n).toFixed(5), counts, msgs, p50: +lat[lat.length >> 1]?.toFixed(1), p99: +lat[Math.floor(lat.length * 0.99)]?.toFixed(1), max: +lat.at(-1)?.toFixed(1) }));
