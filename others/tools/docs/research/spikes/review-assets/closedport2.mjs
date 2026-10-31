// Timeline: one fresh port per delay, one probe only, so probing cannot hold state.
import net from 'node:net';
const attempt = (host, port, cap=4000) => new Promise((resolve) => {
  const t0 = performance.now();
  const s = net.connect({host, port});
  const done = (r) => { clearTimeout(t); s.destroy(); resolve(`${r}@${(performance.now()-t0).toFixed(1)}ms`); };
  const t = setTimeout(() => done('HANG>cap'), cap);
  s.once('connect', () => done('CONNECT'));
  s.once('error', (e) => done(e.code));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const delays = [10000, 20000, 30000, 45000, 60000, 90000, 120000, 180000];
let port = 18950;
await Promise.all(delays.map(async (delay) => {
  const p = ++port;
  const srv = net.createServer(); await new Promise(r => srv.listen(p,'127.0.0.1',r));
  await new Promise(r => { const c = net.connect(p,'127.0.0.1',()=>{c.end(); r();}); });
  await sleep(30);
  await new Promise(r => srv.close(r));
  await sleep(delay);
  console.log('closed+'+delay+'ms', p, await attempt('127.0.0.1', p));
}));
