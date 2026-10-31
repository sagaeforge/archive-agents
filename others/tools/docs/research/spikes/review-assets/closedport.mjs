// How does a connect to a closed port behave on this host, by address and by time since close?
import net from 'node:net';
const attempt = (host, port, cap=3000) => new Promise((resolve) => {
  const t0 = performance.now();
  const s = net.connect({host, port});
  const done = (r) => { clearTimeout(t); s.destroy(); resolve(`${r}@${(performance.now()-t0).toFixed(1)}ms`); };
  const t = setTimeout(() => done('HANG>cap'), cap);
  s.once('connect', () => done('CONNECT'));
  s.once('error', (e) => done(e.code));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// never-opened port, each address
for (const [host, port] of [['127.0.0.1',18977],['127.0.0.2',18977],['::1',18977],['localhost',18977]]) {
  console.log('never-opened', host, port, await attempt(host, port));
}
// open, close, then probe at increasing delays on a fresh port per delay
let port = 18940;
for (const delay of [0, 20, 100, 300, 600, 1000, 2000, 5000]) {
  port += 1;
  const srv = net.createServer(); await new Promise(r => srv.listen(port,'127.0.0.1',r));
  // one real connection so the port has recent state
  await new Promise(r => { const c = net.connect(port,'127.0.0.1',()=>{c.end(); r();}); });
  await sleep(30);
  await new Promise(r => srv.close(r));
  await sleep(delay);
  console.log('closed+'+delay+'ms', port, await attempt('127.0.0.1', port));
}
