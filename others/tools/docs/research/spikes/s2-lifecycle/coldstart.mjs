// usage: node coldstart.mjs <unit> <port> <healthz|mcp> <N>  -> JSONL samples on stdout, summary on stderr
import http from 'node:http'; import { execFileSync } from 'node:child_process';
const [unit, port, kind, Ns] = process.argv.slice(2); const N = Number(Ns);
const state = () => execFileSync('systemctl', ['--user', 'show', '-p', 'SubState', '--value', `s2lc-${unit}.service`]).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function once() { return new Promise((res, rej) => { const t0 = performance.now(); let ttfb;
  const body = kind === 'mcp' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping', arguments: {} } }) : null;
  const r = http.request({ host: '127.0.0.1', port, path: kind === 'mcp' ? '/mcp' : '/healthz', method: body ? 'POST' : 'GET', agent: false,
    headers: body ? { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', 'content-length': Buffer.byteLength(body) } : {} }, (x) => {
    ttfb = performance.now() - t0; let d = ''; x.on('data', (c) => d += c); x.on('end', () => res({ ms: performance.now() - t0, ttfb, status: x.statusCode, d })); });
  r.on('error', rej); r.setTimeout(20000, () => r.destroy(new Error('timeout'))); if (body) r.write(body); r.end(); }); }
const out = [];
for (let i = 0; i < N; i++) {
  for (let w = 0; state() !== 'dead' && w < 500; w++) await sleep(20);
  await sleep(150);
  if (state() !== 'dead') throw new Error('not dead');
  const r = await once(); let extra = {};
  try { extra = JSON.parse(r.d); } catch {}
  out.push({ i, ms: r.ms, status: r.status, listen_ms: extra.listen_ms, import_ms: extra.import_ms, boot_ms: extra.boot_ms }); console.log(JSON.stringify(out.at(-1)));
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };
const v = out.map((o) => o.ms); const f = (x) => x?.toFixed(1);
const L = out.map((o) => o.listen_ms).filter(Boolean);
console.error(JSON.stringify({ unit, kind, N, min: f(Math.min(...v)), p50: f(pct(v, 50)), p95: f(pct(v, 95)), max: f(Math.max(...v)), listen_p50: L.length ? f(pct(L, 50)) : null, bad: out.filter((o) => o.status !== 200).length }));
