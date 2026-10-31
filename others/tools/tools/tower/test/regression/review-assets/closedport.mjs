// How does a connect to a closed port behave on this host, by address and by time since close?
import { P as TT_P } from '../harness/env.mjs';
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
for (const [host, port] of [['127.0.0.1',TT_P.never],['127.0.0.2',TT_P.never],['::1',TT_P.never],['localhost',TT_P.never]]) {
  console.log('never-opened', host, port, await attempt(host, port));
}
// open, close, then probe at increasing delays on a fresh port per delay
// Ephemeral ports (listen(0)) keep this probe out of the reserved TOWER_TEST_PORT_BASE range.
let port = 0;
for (const delay of [0, 20, 100, 300, 600, 1000, 2000, 5000]) {
  const srv = net.createServer(); await new Promise(r => srv.listen(0,'127.0.0.1',r)); port = srv.address().port;
  // one real connection so the port has recent state
  await new Promise(r => { const c = net.connect(port,'127.0.0.1',()=>{c.end(); r();}); });
  await sleep(30);
  await new Promise(r => srv.close(r));
  await sleep(delay);
  console.log('closed+'+delay+'ms', port, await attempt('127.0.0.1', port));
}
