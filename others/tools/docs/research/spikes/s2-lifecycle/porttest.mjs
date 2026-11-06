// After closing a loopback listener, how does a connect to that port fail over time?
import net from 'node:net';
const port = Number(process.argv[2]); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = () => new Promise((res) => { const t = performance.now(); const s = net.connect({ host: '127.0.0.1', port }); const done = (w) => { s.destroy(); res([w, +(performance.now() - t).toFixed(1)]); }; s.on('connect', () => done('connect')); s.on('error', (e) => done(e.code)); setTimeout(() => done('hang>700ms'), 700); });
for (const lived of [200, 3000]) { const srv = net.createServer().listen(port, '127.0.0.1'); await sleep(lived); await probe(); srv.close(); await sleep(0); const t0 = performance.now(); const trace = []; let last = '';
  while (performance.now() - t0 < 12000) { const [w, ms] = await probe(); if (w !== last) { trace.push({ at_ms: Math.round(performance.now() - t0 - ms), w, ms }); last = w; } await sleep(50); }
  console.log(JSON.stringify({ lived, trace })); }
