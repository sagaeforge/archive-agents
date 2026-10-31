// usage: node blocktest.mjs <port> <secsPerPhase> ; plain process, IDLE_MS=0. Ping clients + SSE consumer, with a blocking MCP call injected per phase.
const [port, secs] = process.argv.slice(2); const base = `http://127.0.0.1:${port}`;
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' };
const call = (name, args) => fetch(`${base}/mcp`, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }).then((r) => r.text());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)].toFixed(1); };
const stats = (a) => ({ n: a.length, p50: pct(a, 50), p95: pct(a, 95), p99: pct(a, 99), max: pct(a, 100) });
async function phase(label, mode, hz, burst = 1, burstEvery = 0) {
  let stop = false; const ping = [], gaps = [], blk = [];
  await fetch(`${base}/lagreset`);
  const ac = new AbortController();
  const sse = fetch(`${base}/sse?every=50`, { signal: ac.signal }).then(async (r) => { let last = 0; const rd = r.body.getReader(); const dec = new TextDecoder();
    for (;;) { const { value, done } = await rd.read(); if (done) break; const n = (dec.decode(value).match(/^data:/gm) ?? []).length; const t = performance.now(); if (last && n) gaps.push(t - last); if (n) last = t; } }).catch(() => {});
  const pinger = async () => { while (!stop) { const t = performance.now(); await call('ping', {}); ping.push(performance.now() - t); await sleep(20); } };
  const blocker = async () => { if (!mode) return; while (!stop) { const t0 = performance.now(); await Promise.all(Array.from({ length: burst }, async () => { const t = performance.now(); await call('block', { ms: 200, mode }); blk.push(performance.now() - t); })); const wait = (burstEvery || 1000 / hz) - (performance.now() - t0); if (wait > 0) await sleep(wait); } };
  const ps = [pinger(), pinger(), pinger(), pinger(), blocker()];
  await sleep(Number(secs) * 1000); stop = true; await Promise.all(ps);
  const st = await (await fetch(`${base}/stats`)).json(); ac.abort(); await sse;
  return { label, ping_ms: stats(ping), sse_gap_ms: stats(gaps), block_call_ms: stats(blk), loop_lag_ms: { p50: +st.lag_p50.toFixed(1), p99: +st.lag_p99.toFixed(1), max: +st.lag_max.toFixed(1) } };
}
for (const p of [['baseline', null, 0], ['spin200_1hz', 'spin', 1], ['sqlite200_1hz', 'sqlite', 1], ['spin200_4hz', 'spin', 4], ['spin200_burst8_every3s', 'spin', 0, 8, 3000], ['worker200_4hz', 'worker', 4], ['worker200_burst8_every3s', 'worker', 0, 8, 3000]]) console.log(JSON.stringify(await phase(...p)));
process.exit(0);
